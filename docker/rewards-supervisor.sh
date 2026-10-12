#!/usr/bin/env bash
# Long-running supervisor: schedules rewards-run with supercronic and makes sure
# `docker stop` terminates an in-flight run (and its Chromium) cleanly.
set -Euo pipefail

LOG_TAG="supervisor"
# shellcheck source=docker/lib.sh
. "${REWARDS_LIB:-/usr/local/lib/rewards/lib.sh}"

[ -n "${CRON_SCHEDULE:-}" ] || die "CRON_SCHEDULE is not set (e.g. '0 7 * * *')."
ensure_dirs

CRONTAB="${TMPDIR:-/tmp}/rewards.crontab"
printf '%s /usr/local/bin/rewards-run schedule\n' "$CRON_SCHEDULE" >"$CRONTAB"
supercronic -test "$CRONTAB" >/dev/null 2>&1 || die "Invalid CRON_SCHEDULE '$CRON_SCHEDULE'"

supercronic -passthrough-logs "$CRONTAB" &
SC_PID=$!
log "Scheduler started (schedule: '$CRON_SCHEDULE', TZ: ${TZ:-UTC})"

STARTUP_PID=""
if is_true "${RUN_ON_START:-false}"; then
    log "RUN_ON_START=true -> starting an immediate run"
    /usr/local/bin/rewards-run startup &
    STARTUP_PID=$!
fi

stop_active_run() {
    local pid deadline
    pid="$(cat "$RUN_PID_FILE" 2>/dev/null || true)"
    pid_matches "$pid" rewards-run || return 0
    log "Stopping active run (pid $pid)"
    kill -TERM "$pid" 2>/dev/null || true
    deadline=$((SECONDS + ${STOP_GRACE_SECONDS:-20} + 10))
    while kill -0 "$pid" 2>/dev/null && ((SECONDS < deadline)); do sleep 1; done
}

shutdown() {
    trap '' TERM INT
    log "Shutdown requested"
    # Stop scheduling before stopping the active job: avoid a shutdown/start race.
    kill -TERM "$SC_PID" 2>/dev/null || true
    stop_active_run
    wait "$SC_PID" 2>/dev/null || true
    [ -n "$STARTUP_PID" ] && wait "$STARTUP_PID" 2>/dev/null
    log "Bye"
    exit 0
}
trap shutdown TERM INT

wait "$SC_PID"
rc=$?
log "ERROR: scheduler exited unexpectedly (code $rc)"
stop_active_run
exit 1
