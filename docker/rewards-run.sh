#!/usr/bin/env bash
# rewards-run [schedule|startup|manual]
#
# Runs the upstream bot once, with:
#   - mutual exclusion (flock; released automatically if this process dies)
#   - a hard per-attempt timeout that kills the whole process group (node + Chromium)
#   - bounded retries; retries only re-run the accounts that failed
#   - a circuit breaker (STOP file) after N consecutive failed runs
#   - a persistent per-run log file plus container stdout, with e-mail redaction
#
# Exit codes: 0 success / skipped, 1 failed after retries, 75 busy (manual only), 143 stopped.
set -Euo pipefail

LOG_TAG="rewards-run"
# shellcheck source=docker/lib.sh
. "${REWARDS_LIB:-/usr/local/lib/rewards/lib.sh}"

TRIGGER="${1:-schedule}"
case "$TRIGGER" in schedule | startup | manual) ;; *) die "unknown trigger '$TRIGGER'" ;; esac

# ── Settings ────────────────────────────────────────────────────────────────
MAX_RETRIES="${MAX_RETRIES:-2}"
RETRY_DELAY_MINUTES="${RETRY_DELAY_MINUTES:-10}"
if [ -z "${RUN_TIMEOUT_MINUTES:-}" ] && [ -n "${STUCK_PROCESS_TIMEOUT_HOURS:-}" ]; then
    require_uint STUCK_PROCESS_TIMEOUT_HOURS "$STUCK_PROCESS_TIMEOUT_HOURS"
    RUN_TIMEOUT_MINUTES=$((STUCK_PROCESS_TIMEOUT_HOURS * 60)) # upstream compatibility
fi
RUN_TIMEOUT_MINUTES="${RUN_TIMEOUT_MINUTES:-360}"
STOP_GRACE_SECONDS="${STOP_GRACE_SECONDS:-20}"
MAX_CONSECUTIVE_FAILED_RUNS="${MAX_CONSECUTIVE_FAILED_RUNS:-3}"
LOG_RETENTION_DAYS="${LOG_RETENTION_DAYS:-14}"
MIN_SLEEP_MINUTES="${MIN_SLEEP_MINUTES:-5}"
MAX_SLEEP_MINUTES="${MAX_SLEEP_MINUTES:-50}"
WATCH_INTERVAL_SECONDS="${WATCH_INTERVAL_SECONDS:-5}"

for v in MAX_RETRIES RETRY_DELAY_MINUTES RUN_TIMEOUT_MINUTES STOP_GRACE_SECONDS \
    MAX_CONSECUTIVE_FAILED_RUNS LOG_RETENTION_DAYS MIN_SLEEP_MINUTES MAX_SLEEP_MINUTES WATCH_INTERVAL_SECONDS; do
    require_uint "$v" "${!v}"
done
[ "$RUN_TIMEOUT_MINUTES" -gt 0 ] || die "RUN_TIMEOUT_MINUTES must be > 0"
TIMEOUT_S="${RUN_TIMEOUT_SECONDS:-$((RUN_TIMEOUT_MINUTES * 60))}" # seconds override: tests only
require_uint RUN_TIMEOUT_SECONDS "$TIMEOUT_S"
[ "$TIMEOUT_S" -gt 0 ] || die "RUN_TIMEOUT_SECONDS must be > 0"
[ "$WATCH_INTERVAL_SECONDS" -gt 0 ] || die "WATCH_INTERVAL_SECONDS must be > 0"
[ "$MAX_SLEEP_MINUTES" -ge "$MIN_SLEEP_MINUTES" ] || die "MAX_SLEEP_MINUTES must be >= MIN_SLEEP_MINUTES"

if [ -n "${REWARDS_RUN_CMD:-}" ]; then
    RUN_CMD=(bash -c "$REWARDS_RUN_CMD") # test hook
else
    RUN_CMD=(node /opt/mrs-admin/src/account-launch.mjs)
fi

ensure_dirs

# ── Mutual exclusion ────────────────────────────────────────────────────────
exec 9>>"$LOCK_FILE"
if ! flock -n 9; then
    holder="$(cat "$RUN_PID_FILE" 2>/dev/null || echo '?')"
    log "Another run is in progress (pid $holder); skipping this '$TRIGGER' trigger."
    [ "$TRIGGER" = manual ] && exit 75
    exit 0
fi
echo "$$" >"$RUN_PID_FILE"

# ── Per-run log file (the logger must not inherit the lock fd) ──────────────
RUN_ID="$(date '+%Y%m%d-%H%M%S')-$$"
RUN_LOG="$LOG_DIR/run-$RUN_ID.log"
ATTEMPT_SUMMARY_FILE="$STATE_DIR/.attempt-summary-$RUN_ID.json"
RISK_FILE="$STATE_DIR/.risk-$RUN_ID"
SUMMARY_MERGE_JQ="${SUMMARY_MERGE_JQ:-/usr/local/lib/rewards/merge-summary.jq}"
exec > >(
    exec 9>&-
    redact_stream | tee -a "$RUN_LOG"
) 2>&1
LOGGER_PID=$!

STOPPING=0
CHILD_PID=""
RESULT="failed"
FINAL_RC=1
ATTEMPT=0
FAILED_EMAILS=""
BOT_EMAILS=""

terminate_group() {
    local pg="$1" i
    kill -0 -- "-$pg" 2>/dev/null || return 0
    log "Sending SIGTERM to process group $pg"
    kill -TERM -- "-$pg" 2>/dev/null || true
    for ((i = 0; i < STOP_GRACE_SECONDS; i++)); do
        kill -0 -- "-$pg" 2>/dev/null || return 0
        sleep 1
    done
    log "Process group $pg still alive after ${STOP_GRACE_SECONDS}s; sending SIGKILL"
    kill -KILL -- "-$pg" 2>/dev/null || true
}

# shellcheck disable=SC2317  # ShellCheck 0.9 does not recognize trap-only invocation
on_signal() {
    [ "$STOPPING" = 1 ] && return
    STOPPING=1
    log "Stop requested ($1)"
    if [ -n "$CHILD_PID" ]; then terminate_group "$CHILD_PID"; fi
}
trap 'on_signal TERM' TERM
trap 'on_signal INT' INT

# shellcheck disable=SC2317  # ShellCheck 0.9 does not recognize trap-only invocation
on_exit() {
    rm -f "$RUN_PID_FILE" "$ATTEMPT_SUMMARY_FILE" "$RISK_FILE"
    exec 1>&- 2>&-
    wait "$LOGGER_PID" 2>/dev/null || true
}
trap on_exit EXIT

json_list() { # "a,b" -> ["a","b"]
    jq -cn --arg s "$1" '$s | split(",") | map(select(length > 0))'
}

write_status() {
    local tmp="$STATUS_FILE.tmp"
    jq -n \
        --arg finishedAt "$(date -Iseconds)" \
        --arg trigger "$TRIGGER" \
        --arg result "$RESULT" \
        --argjson exitCode "$FINAL_RC" \
        --argjson attempts "$ATTEMPT" \
        --argjson failedEmails "$(json_list "$FAILED_EMAILS")" \
        --argjson botWarningEmails "$(json_list "$BOT_EMAILS")" \
        --argjson consecutiveFailures "$(read_failcount)" \
        --arg log "$RUN_LOG" \
        '$ARGS.named' >"$tmp" && mv -f "$tmp" "$STATUS_FILE"
}

# Optional durable event hook; bounded and independent of core task exit status.
emit_admin_event() {
    [ "${CONTROL_API_ENABLED:-false}" = true ] || return 0
    timeout 2 node /opt/mrs-admin/src/event.mjs "$1" "$RUN_ID" "${2:-}" 9>&- >/dev/null 2>&1 || true
}

run_attempt() {
    local filter="$1" timeout_s="$TIMEOUT_S" start=$SECONDS
    TIMED_OUT=0
    RISK_DETECTED=0
    rm -f "$ATTEMPT_SUMMARY_FILE" "$RISK_FILE"
    (
        cd "$APP_DIR" || exit 1
        export RUN_SUMMARY_FILE="$ATTEMPT_SUMMARY_FILE" RUN_RISK_FILE="$RISK_FILE" REWARDS_BOT=1
        # shellcheck disable=SC2030  # intentionally scoped to the bot subshell
        if [ -n "$filter" ]; then export RUN_ACCOUNT_FILTER="$filter"; else unset RUN_ACCOUNT_FILTER; fi
        # setsid: the bot and every Chromium it spawns share one new process group.
        exec setsid "${RUN_CMD[@]}" 9>&-
    ) &
    CHILD_PID=$!
    echo "$CHILD_PID" >"$BOT_PGID_FILE"
    log "Bot started (pid/pgid $CHILD_PID, timeout ${RUN_TIMEOUT_MINUTES}m)"

    while kill -0 "$CHILD_PID" 2>/dev/null; do
        if [ -f "$RISK_FILE" ]; then
            RISK_DETECTED=1
            terminate_group "$CHILD_PID"
            break
        fi
        if [ "$STOPPING" = 1 ]; then
            terminate_group "$CHILD_PID"
            break
        fi
        if ((SECONDS - start >= timeout_s)); then
            TIMED_OUT=1
            log "Attempt exceeded ${RUN_TIMEOUT_MINUTES}m; terminating."
            terminate_group "$CHILD_PID"
            break
        fi
        isleep "$WATCH_INTERVAL_SECONDS"
    done
    wait "$CHILD_PID" 2>/dev/null
    ATTEMPT_RC=$?
    [ -f "$RISK_FILE" ] && RISK_DETECTED=1
    # Sweep anything left in the group (orphaned Chromium helpers).
    kill -KILL -- "-$CHILD_PID" 2>/dev/null || true
    rm -f "$BOT_PGID_FILE"
    CHILD_PID=""
    log "Bot exited with code $ATTEMPT_RC after $((SECONDS - start))s"
}

# A previous wrapper killed with SIGKILL leaves its bot running without the lock.
# Only processes carrying our REWARDS_BOT=1 marker are touched (guards against PID reuse).
sweep_orphans() {
    local pg pid found=0
    pg="$(cat "$BOT_PGID_FILE" 2>/dev/null || true)"
    [[ "$pg" =~ ^[0-9]+$ ]] || return 0
    for pid in $(pgrep -g "$pg" 2>/dev/null); do
        if grep -qz '^REWARDS_BOT=1$' "/proc/$pid/environ" 2>/dev/null; then
            found=1
            break
        fi
    done
    if [ "$found" = 1 ]; then
        log "Found orphaned bot process group $pg from an interrupted run; terminating it."
        terminate_group "$pg"
    fi
    rm -f "$BOT_PGID_FILE"
}

# Aggregate all attempt summaries for this run. Otherwise, retrying account B
# would overwrite the points/status already collected from account A.
merge_attempt_summary() {
    [ -s "$ATTEMPT_SUMMARY_FILE" ] || return 1
    if ! jq -e '
        (.accounts | type) == "array" and
        (.accounts | length) > 0 and
        all(.accounts[]; (.email | type) == "string" and (.email | length) > 0 and
            (.status == "ok" or .status == "failed" or .status == "skipped_bot_warning") and
            (.collectedPoints | type) == "number") and
        ([.accounts[].email | ascii_downcase] | unique | length) == (.accounts | length) and
        (.failedEmails | type) == "array" and
        (.botWarningEmails | type) == "array" and
        ([.accounts[] | select(.status == "failed") | .email | ascii_downcase] | sort) ==
            ([.failedEmails[] | ascii_downcase] | sort) and
        ([.accounts[] | select(.status == "skipped_bot_warning") | .email | ascii_downcase] | sort) ==
            ([.botWarningEmails[] | ascii_downcase] | sort)
    ' "$ATTEMPT_SUMMARY_FILE" >/dev/null 2>&1; then
        log "WARNING: invalid attempt summary; cannot safely merge results"
        return 1
    fi
    local tmp="$SUMMARY_FILE.tmp.$$"
    if jq -s -f "$SUMMARY_MERGE_JQ" "$SUMMARY_FILE" "$ATTEMPT_SUMMARY_FILE" >"$tmp"; then
        mv -f "$tmp" "$SUMMARY_FILE"
        return 0
    fi
    rm -f "$tmp"
    log "WARNING: failed to merge attempt summary"
    return 1
}

# ── Pre-flight ──────────────────────────────────────────────────────────────
log "Run $RUN_ID started (trigger: $TRIGGER, log: $RUN_LOG)"
sweep_orphans

# Prune even when paused; paused schedules also create per-run logs.
find "$LOG_DIR" -maxdepth 1 -type f -name 'run-*.log' -mtime +"$LOG_RETENTION_DAYS" -delete 2>/dev/null || true

if [ -f "$STOP_FILE" ]; then
    log "Automation is paused: $(head -c 500 "$STOP_FILE"). Resume with: rewards-ctl resume"
    RESULT="paused"
    FINAL_RC=0
    write_status
    exit 0
fi

if [ "$TRIGGER" = schedule ] && ! is_true "${SKIP_RANDOM_SLEEP:-false}"; then
    span=$(((MAX_SLEEP_MINUTES - MIN_SLEEP_MINUTES) * 60))
    delay=$((MIN_SLEEP_MINUTES * 60 + (span > 0 ? RANDOM % (span + 1) : 0)))
    log "Random start delay: $((delay / 60))m $((delay % 60))s"
    isleep "$delay"
fi

# ── Attempts ────────────────────────────────────────────────────────────────
emit_admin_event task_started running
# Keep private, cumulative summary from this one run, not the last retry only.
printf '{"accounts":[],"attempts":0}\n' >"$SUMMARY_FILE"
MAX_ATTEMPTS=$((MAX_RETRIES + 1))
# shellcheck disable=SC2031  # the user-provided value, not the subshell one
FILTER="${RUN_ACCOUNT_FILTER:-}"

while [ "$STOPPING" = 0 ] && [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; do
    ATTEMPT=$((ATTEMPT + 1))
    log "Attempt $ATTEMPT/$MAX_ATTEMPTS${FILTER:+ (retrying failed accounts only)}"
    if [ -f "$STOP_FILE" ]; then
        RESULT="paused"
        FINAL_RC=0
        break
    fi
    run_attempt "$FILTER"

    SUMMARY_VALID=0
    if merge_attempt_summary; then
        SUMMARY_VALID=1
        BOT_EMAILS="$(jq -r '.botWarningEmails | join(",")' "$SUMMARY_FILE")"
        FAILED_EMAILS="$(jq -r '.failedEmails | join(",")' "$SUMMARY_FILE")"
    fi

    if [ "$STOPPING" = 1 ]; then
        RESULT="stopped"
        FINAL_RC=143
        break
    fi

    # Risk warnings have priority over success and retries. Do not continue
    # interacting with other accounts after one account is challenged.
    if [ -n "$BOT_EMAILS" ] || [ "$RISK_DETECTED" = 1 ] || [ "$ATTEMPT_RC" -eq 78 ]; then
        printf 'bot-score warning reported (%s)\n' "$(date -Iseconds)" >"$STOP_FILE"
        log "WARNING: bot-score warning detected; all further runs paused pending manual review."
        RESULT="risk_paused"
        FINAL_RC=78
        break
    fi

    if [ "$TIMED_OUT" = 0 ] && [ "$ATTEMPT_RC" -eq 0 ] && [ "$SUMMARY_VALID" = 1 ] && [ -z "$FAILED_EMAILS" ]; then
        RESULT="success"
        FINAL_RC=0
        FAILED_EMAILS=""
        break
    fi

    FINAL_RC="$ATTEMPT_RC"
    [ "$TIMED_OUT" = 1 ] && FINAL_RC=124
    # Retry only a validated partial-account failure. Unknown/fatal exits and
    # timeouts may already have performed work; broad retries are unsafe.
    if [ "$TIMED_OUT" = 1 ] || [ "$SUMMARY_VALID" != 1 ] || [ "$ATTEMPT_RC" -ne 2 ] || [ -z "$FAILED_EMAILS" ]; then
        log "ERROR: failure without a valid failed-account list or retryable exit; stopping retries."
        [ "$FINAL_RC" -eq 0 ] && FINAL_RC=1
        break
    fi
    FILTER="$FAILED_EMAILS"
    log "Failed accounts: $(tr ',' ' ' <<<"$FAILED_EMAILS")"

    if [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; then
        wait_s=$((RETRY_DELAY_MINUTES * 60 * ATTEMPT))
        log "Retrying in $((wait_s / 60))m"
        isleep "$wait_s"
    fi
done

[ "$STOPPING" = 1 ] && [ "$RESULT" != stopped ] && {
    RESULT="stopped"
    FINAL_RC=143
}

# ── Book-keeping ────────────────────────────────────────────────────────────
case "$RESULT" in
    success) echo 0 >"$FAILCOUNT_FILE" ;;
    failed)
        n=$(($(read_failcount) + 1))
        echo "$n" >"$FAILCOUNT_FILE"
        log "Run failed after $ATTEMPT attempt(s) (code $FINAL_RC); consecutive failed runs: $n"
        if [ "$MAX_CONSECUTIVE_FAILED_RUNS" -gt 0 ] && [ "$n" -ge "$MAX_CONSECUTIVE_FAILED_RUNS" ]; then
            echo "circuit breaker: $n consecutive failed runs (last $(date -Iseconds))" >"$STOP_FILE"
            log "Circuit breaker opened; scheduled runs are paused until 'rewards-ctl resume'."
        fi
        ;;
esac

if [ -n "$BOT_EMAILS" ]; then
    log "WARNING: Microsoft reported a bot-score warning for: $(tr ',' ' ' <<<"$BOT_EMAILS")"
fi

write_status
emit_admin_event task_finished "$RESULT"
if [ "$RESULT" = risk_paused ]; then
    emit_admin_event risk_paused "$RESULT"
    emit_admin_event account_paused "$RESULT"
    if grep -q 'Login verification or restriction requires manual review' "$RUN_LOG"; then
        emit_admin_event verification_required "$RESULT"
    fi
fi
if [ -f "$STOP_FILE" ] && grep -q 'circuit breaker:' "$STOP_FILE"; then
    emit_admin_event circuit_open "$RESULT"
fi
log "Run $RUN_ID finished: $RESULT"

case "$RESULT" in
    success | paused) exit 0 ;;
    stopped) exit 143 ;;
    risk_paused) exit 78 ;;
    *) exit 1 ;;
esac
