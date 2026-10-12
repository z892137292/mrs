#!/usr/bin/env bash
# Behavioural tests for docker/rewards-run.sh and docker/rewards-ctl.sh.
# shellcheck disable=SC2034,SC2086  # variables are referenced inside eval'd expectations
# Runs without Docker, Node or network: the bot is replaced by tests/fake-bot.sh.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0
SKIP=0

setup() {
    T="$(mktemp -d)"
    export APP_DIR="$T/app" STATE_DIR="$T/app/state" LOG_DIR="$T/app/logs"
    export REWARDS_LIB="$ROOT/docker/lib.sh" SUMMARY_MERGE_JQ="$ROOT/docker/merge-summary.jq"
    export REWARDS_RUN_CMD="bash $ROOT/tests/fake-bot.sh"
    export FAKE_CALLS="$T/calls" FAKE_GRANDCHILD="$T/grandchild"
    export RETRY_DELAY_MINUTES=0 WATCH_INTERVAL_SECONDS=1 STOP_GRACE_SECONDS=2
    export MIN_SLEEP_MINUTES=0 MAX_SLEEP_MINUTES=0
    export MAX_RETRIES=2 MAX_CONSECUTIVE_FAILED_RUNS=3 REWARDS_CTL_ALLOW_ROOT=1
    unset RUN_TIMEOUT_SECONDS STOP_ON_BOT_WARNING RUN_ACCOUNT_FILTER
    mkdir -p "$APP_DIR"
    : >"$FAKE_CALLS"
}
run() { bash "$ROOT/docker/rewards-run.sh" "$@" >"$T/out" 2>&1; }
ctl() { bash "$ROOT/docker/rewards-ctl.sh" "$@"; }
calls() { wc -l <"$FAKE_CALLS" | tr -d ' '; }
status() { jq -r ".$1" "$STATE_DIR/status.json"; }
ok() { echo "PASS  $1"; PASS=$((PASS + 1)); }
ko() { echo "FAIL  $1"; sed 's/^/      /' "$T/out" 2>/dev/null | tail -n 25; FAIL=$((FAIL + 1)); }
expect() { if eval "$2"; then ok "$1"; else ko "$1 [$2]"; fi; }

# 1 success path
setup; export FAKE_MODE=ok; run startup; rc=$?
expect "success: exit 0" '[ $rc -eq 0 ]'
expect "success: one attempt" '[ "$(calls)" = 1 ]'
expect "success: status.json result" '[ "$(status result)" = success ]'
expect "success: failure counter 0" '[ "$(cat $STATE_DIR/consecutive-failures)" = 0 ]'
expect "logs: per-run log file written" 'ls $LOG_DIR/run-*.log >/dev/null 2>&1'
expect "logs: e-mail redacted in log file" 'grep -q "a\*\*\*@example.com" $LOG_DIR/run-*.log && ! grep -q alice@ $LOG_DIR/run-*.log'
expect "lock: pid file removed after run" '[ ! -f $STATE_DIR/run.pid ]'

# 2 partial failure -> retry only failed account
setup; export FAKE_MODE=partial; run startup; rc=$?
expect "partial: exit 0 after retry" '[ $rc -eq 0 ]'
expect "partial: 2 attempts" '[ "$(calls)" = 2 ]'
expect "partial: first attempt unfiltered" '[ "$(sed -n 1p $FAKE_CALLS)" = "filter=" ]'
expect "partial: retry limited to failed account" '[ "$(sed -n 2p $FAKE_CALLS)" = "filter=bob@example.com" ]'
expect "partial: all accounts retained" '[ "$(jq -r ".accounts | length" "$STATE_DIR/last-summary.json")" = 2 ]'
expect "partial: points from both attempts summed" '[ "$(jq -r .totalCollectedPoints "$STATE_DIR/last-summary.json")" = 15 ]'
expect "partial: failed list cleared after retry" '[ "$(jq -r ".failedEmails | length" "$STATE_DIR/last-summary.json")" = 0 ]'
expect "partial: cumulative attempts recorded" '[ "$(jq -r .attempts "$STATE_DIR/last-summary.json")" = 2 ]'

# 3 persistent failure -> bounded retries
setup; export FAKE_MODE=fail; run startup; rc=$?
expect "fail: exit 1" '[ $rc -eq 1 ]'
expect "fail: fatal error without summary is not retried" '[ "$(calls)" = 1 ]'
expect "fail: counter incremented" '[ "$(cat $STATE_DIR/consecutive-failures)" = 1 ]'
MAX_RETRIES=0 run startup
expect "fail: MAX_RETRIES=0 means single attempt" '[ "$(calls)" = 2 ]'

# 4 circuit breaker
setup; export FAKE_MODE=fail MAX_RETRIES=0 MAX_CONSECUTIVE_FAILED_RUNS=2
run startup; run startup
expect "breaker: STOP file after 2 failed runs" '[ -f $STATE_DIR/STOP ]'
run schedule; rc=$?
expect "breaker: paused run does not start bot" '[ $rc -eq 0 ] && [ "$(calls)" = 2 ] && [ "$(status result)" = paused ]'
ctl resume >/dev/null
expect "ctl resume: clears STOP and counter" '[ ! -f $STATE_DIR/STOP ] && [ "$(cat $STATE_DIR/consecutive-failures)" = 0 ]'
export FAKE_MODE=ok; run schedule
expect "breaker: runs again after resume" '[ "$(calls)" = 3 ] && [ "$(status result)" = success ]'

# 5 mutual exclusion
setup; export FAKE_MODE=slow
bash "$ROOT/docker/rewards-run.sh" startup >/dev/null 2>&1 &
first=$!
sleep 1
run schedule; rc_sched=$?
run manual; rc_man=$?
wait $first
expect "lock: concurrent scheduled run skipped (exit 0)" '[ $rc_sched -eq 0 ] && grep -q "Another run is in progress" $T/out'
expect "lock: concurrent manual run reports busy (75)" '[ $rc_man -eq 75 ]'
expect "lock: bot executed only once" '[ "$(calls)" = 1 ]'

# 6 hard timeout kills the whole process group
setup; export FAKE_MODE=hang MAX_RETRIES=0 RUN_TIMEOUT_SECONDS=3
run startup; rc=$?
gc="$(cat $FAKE_GRANDCHILD)"
expect "timeout: run fails" '[ $rc -eq 1 ] && [ "$(status exitCode)" = 124 ]'
expect "timeout: SIGKILL escalation logged" 'grep -q "sending SIGKILL" $T/out'
expect "timeout: grandchild (chromium stand-in) killed" '! kill -0 $gc 2>/dev/null'

# PID-sensitive tests need /proc in the current PID namespace.
if [ -r /proc/$$/cmdline ] && tr '\0' ' ' </proc/$$/cmdline | grep -q 'run-wrapper.test.sh'; then
# 7 SIGTERM to wrapper (docker stop / rewards-ctl stop)
setup; export FAKE_MODE=hang MAX_RETRIES=2
unset RUN_TIMEOUT_SECONDS
bash "$ROOT/docker/rewards-run.sh" startup >"$T/out" 2>&1 &
w=$!
sleep 3
gc="$(cat $FAKE_GRANDCHILD)"
ctl stop >/dev/null
t0=$SECONDS; wait $w; rc=$?
expect "stop: wrapper exits 143" '[ $rc -eq 143 ]'
expect "stop: finished within grace period" '[ $((SECONDS - t0)) -le 6 ]'
expect "stop: no retry after stop" '[ "$(calls)" = 1 ]'
expect "stop: process group killed" '! kill -0 $gc 2>/dev/null'
expect "stop: not counted as failure" '[ ! -f $STATE_DIR/consecutive-failures ] || [ "$(cat $STATE_DIR/consecutive-failures)" = 0 ]'
export FAKE_MODE=ok; run startup
expect "stop: lock free afterwards" '[ "$(status result)" = success ]'

# 8 wrapper SIGKILLed -> orphan sweep on next run
setup; export FAKE_MODE=hang MAX_RETRIES=0
bash "$ROOT/docker/rewards-run.sh" startup >/dev/null 2>&1 &
w=$!
sleep 3
gc="$(cat $FAKE_GRANDCHILD)"
kill -KILL $w; wait $w 2>/dev/null
expect "kill -9: orphan still alive before sweep" 'kill -0 $gc 2>/dev/null'
export FAKE_MODE=ok; run startup; rc=$?
expect "kill -9: next run acquires lock immediately" '[ $rc -eq 0 ] && [ "$(calls)" = 2 ] && [ "$(status result)" = success ]'
expect "kill -9: orphaned group swept" '! kill -0 $gc 2>/dev/null && grep -q "orphaned bot process group" $T/out'

else
    echo 'SKIP  ctl stop and orphan sweep: /proc PID namespace mismatch'
    SKIP=$((SKIP + 2))
fi

# 9 bot-score warning: default fail-closed before retries
setup; export FAKE_MODE=bot
run startup; rc=$?
expect "bot warning: defaults to paused" '[ $rc -eq 78 ] && [ -f $STATE_DIR/STOP ] && [ "$(status result)" = risk_paused ]'
expect "bot warning: no extra attempts" '[ "$(calls)" = 1 ]'
setup; export FAKE_MODE=partialwarn
run startup; rc=$?
expect "bot warning: stops partial failure before retry" '[ $rc -eq 78 ] && [ "$(calls)" = 1 ]'
setup; export FAKE_MODE=bot
STOP_ON_BOT_WARNING=false run startup; rc=$?
expect "bot warning: override cannot disable safety" '[ $rc -eq 78 ] && [ -f $STATE_DIR/STOP ]'

ctl resume >"$T/resume-out" 2>&1; resume_rc=$?
expect "risk resume: rejects missing manual acknowledgement" '[ $resume_rc -eq 78 ] && [ -f "$STATE_DIR/STOP" ]'
ctl resume --reviewed >"$T/resume-out" 2>&1; resume_rc=$?
expect "risk resume: explicit review acknowledgement clears pause" '[ $resume_rc -eq 0 ] && [ ! -f "$STATE_DIR/STOP" ]'

# 10 secrecy of logs, mode of private status files
setup; export FAKE_MODE=sensitive
run startup; rc=$?
expect "logs: common credential formats scrubbed" '[ $rc -eq 0 ] && ! grep -E "TOKENVALUE123|PASSVALUE123|COOKIEVALUE123|ACCESSVALUE123|SECONDCOOKIE123|PROXYPASS123|TELEGRAMTOKEN123" $LOG_DIR/run-*.log $T/out'
expect "private state/log mode: owner only" '[ "$(stat -c %a "$STATE_DIR/last-summary.json")" = 600 ] && [ "$(stat -c %a "$STATE_DIR/status.json")" = 600 ] && [ "$(stat -c %a "$LOG_DIR/"run-*.log)" = 600 ]'

# Safety: bot success without a trusted result, or partial result without accounts
setup; export FAKE_MODE=invalid
run startup; rc=$?
expect "summary: missing summary rejects success" '[ $rc -eq 1 ] && [ "$(status result)" = failed ]'
expect "summary: missing summary not retried" '[ "$(calls)" = 1 ]'
setup; export FAKE_MODE=partialnolist
run startup; rc=$?
expect "summary: failed-list missing stops retries" '[ $rc -eq 1 ] && [ "$(calls)" = 1 ]'
expect "summary: failed-list error recorded" 'grep -q "without a valid failed-account list" $T/out'

setup; export FAKE_MODE=riskmarker
run startup; rc=$?
expect "risk marker: stops running process before summary" '[ $rc -eq 78 ] && [ -f $STATE_DIR/STOP ] && [ "$(calls)" = 1 ]'
setup; export FAKE_MODE=inconsistent
run startup; rc=$?
expect "summary: exit 0 with failed accounts is rejected" '[ $rc -eq 1 ] && [ "$(calls)" = 1 ]'

# 11 ctl pause + input validation
setup; export FAKE_MODE=ok
ctl pause maintenance >/dev/null
mkdir -p "$LOG_DIR"
touch -d '30 days ago' "$LOG_DIR/run-old.log"
run schedule
expect "ctl pause: scheduled run skipped" '[ "$(calls)" = 0 ] && grep -q maintenance $STATE_DIR/STOP'
expect "paused schedule: retention still prunes old logs" '[ ! -f "$LOG_DIR/run-old.log" ]'
MAX_RETRIES=abc run startup; rc=$?
expect "validation: bad MAX_RETRIES rejected" '[ $rc -ne 0 ] && grep -q "MAX_RETRIES must be" $T/out'

WATCH_INTERVAL_SECONDS=0 run startup; rc=$?
expect "validation: zero watch interval rejected" '[ $rc -ne 0 ] && grep -q "WATCH_INTERVAL_SECONDS must be > 0" $T/out'
RUN_TIMEOUT_SECONDS=0 run startup; rc=$?
expect "validation: zero seconds timeout rejected" '[ $rc -ne 0 ] && grep -q "RUN_TIMEOUT_SECONDS must be > 0" $T/out'

echo
echo "run-wrapper tests: $PASS passed, $FAIL failed, $SKIP scenario groups skipped"
if [ "${CI:-false}" = true ] && [ "$SKIP" -gt 0 ]; then
    echo 'FAIL: PID-sensitive test skips are not permitted in CI'
    exit 1
fi
[ "$FAIL" -eq 0 ]
