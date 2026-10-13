#!/usr/bin/env bash
# rewards-ctl <command>   (use: docker compose exec rewards rewards-ctl status)
set -Euo pipefail

LOG_TAG="rewards-ctl"
# shellcheck source=docker/lib.sh
. "${REWARDS_LIB:-/usr/local/lib/rewards/lib.sh}"

# `docker exec` defaults to root: re-exec as the app user so state files keep the right owner.
if [ "$(id -u)" = 0 ] && [ -z "${REWARDS_CTL_ALLOW_ROOT:-}" ]; then
    exec setpriv --reuid="${PUID:-1000}" --regid="${PGID:-1000}" --clear-groups \
        env HOME=/tmp "$0" "$@"
fi

usage() {
    cat <<'EOF'
Usage: rewards-ctl <command>

  status        Show last run result, pause state and whether a run is active
  run           Start a run now in the foreground (no random delay; skipped if one is active)
  stop          Stop the active run (bot + Chromium) gracefully
  pause [why]   Pause scheduled runs (creates state/STOP)
  resume [--reviewed]  Clear pause; risk stops require explicit manual-review acknowledgement
  logs [-f]     Print (or follow) the most recent run log
  selftest      Check the image: node, build, patch, scheduler, Chromium launch
EOF
}

active_pid() {
    local pid
    pid="$(cat "$RUN_PID_FILE" 2>/dev/null || true)"
    pid_matches "$pid" rewards-run && echo "$pid"
}

latest_log() {
    find "$LOG_DIR" -maxdepth 1 -type f -name 'run-*.log' 2>/dev/null | sort | tail -n 1
}

cmd="${1:-help}"
shift || true

case "$cmd" in
    status)
        ensure_dirs
        if pid="$(active_pid)"; then echo "active run : yes (pid $pid)"; else echo "active run : no"; fi
        if [ -f "$STOP_FILE" ]; then echo "paused     : yes - $(head -c 300 "$STOP_FILE")"; else echo "paused     : no"; fi
        echo "failed runs: $(read_failcount) consecutive"
        if [ -f "$STATUS_FILE" ]; then
            echo "last run   :"
            redact_stream <"$STATUS_FILE"
        else
            echo "last run   : none recorded"
        fi
        ;;
    run)
        SKIP_RANDOM_SLEEP=true exec /usr/local/bin/rewards-run manual
        ;;
    stop)
        if pid="$(active_pid)"; then
            kill -TERM "$pid" && echo "SIGTERM sent to run $pid"
        else
            echo "No active run."
        fi
        ;;
    pause)
        ensure_dirs
        # Never overwrite a risk/verification STOP with an ordinary maintenance reason.
        if (set -C; echo "paused manually${1:+: $*} ($(date -Iseconds))" >"$STOP_FILE") 2>/dev/null; then
            :
        elif [ -f "$STOP_FILE" ]; then
            echo "Already paused; existing reason preserved."
        else
            die "Unable to create pause marker."
        fi
        echo "Paused. Scheduled runs will be skipped."
        ;;
    resume)
        ensure_dirs
        if is_true "${CONTROL_API_ENABLED:-false}"; then
            if [ "${1:-}" = --reviewed ]; then
                node /opt/mrs-admin/src/ledger.cjs acknowledge || exit 78
            else
                node /opt/mrs-admin/src/ledger.cjs check || exit 78
            fi
        fi
        if [ -f "$STOP_FILE" ] && grep -Eqi 'bot-score|Microsoft risk|manual review' "$STOP_FILE" && [ "${1:-}" != --reviewed ]; then
            echo 'Risk/verification stop requires manual review. After completing it, use: rewards-ctl resume --reviewed' >&2
            exit 78
        fi
        rm -f "$STOP_FILE"
        echo 0 >"$FAILCOUNT_FILE"
        echo "Resumed; failure counter reset."
        ;;
    logs)
        f="$(latest_log)"
        [ -n "$f" ] || {
            echo "No run logs yet."
            exit 0
        }
        if [ "${1:-}" = "-f" ]; then exec tail -n 200 -F "$f"; else cat "$f"; fi
        ;;
    selftest)
        exec /usr/local/bin/rewards-selftest
        ;;
    help | -h | --help) usage ;;
    *)
        usage
        exit 2
        ;;
esac
