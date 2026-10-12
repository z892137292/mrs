#!/usr/bin/env bash
# Must run against a real built image. No fake Docker or production data.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
IMAGE="${1:-mrs-custom:ci}"
OUT="${2:-$ROOT/test-results}"
SOAK_SECONDS="${SOAK_SECONDS:-3600}"
[[ "$SOAK_SECONDS" =~ ^[0-9]+$ ]] && [ "$SOAK_SECONDS" -ge 60 ] || exit 2
command -v docker >/dev/null || { echo "BLOCKED: Docker CLI is unavailable; no container tests executed" >&2; exit 127; }
docker info >/dev/null
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd -P)"
NAME="mrs-verify-$(date +%s)-$$"
WORK="$(mktemp -d)"
cleanup() {
    docker logs "$NAME" >"$OUT/final-container.log" 2>&1 || true
    docker inspect --format '{{json .State}}' "$NAME" >"$OUT/final-container-state.json" 2>/dev/null || true
    cat "$OUT/final-container.log" >&2 || true
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    rm -rf -- "$WORK"
}
trap cleanup EXIT
test "$(docker image inspect --format '{{.Architecture}}' "$IMAGE")" = amd64
docker image inspect --format '{{.Id}}' "$IMAGE" >"$OUT/tested-image-id.txt"
mkdir -p "$WORK/compose"
cp "$ROOT/compose.yaml" "$WORK/compose/compose.yaml"
printf 'IMAGE=%s\nACCOUNT_1_EMAIL=ci@example.invalid\nRUN_ON_START=false\n' "$IMAGE" >"$WORK/compose/.env"
docker compose -f "$WORK/compose/compose.yaml" --project-directory "$WORK/compose" -p "$NAME" config >"$OUT/compose-config.txt"
docker run -d --name "$NAME" --network none --shm-size=1g \
    --security-opt no-new-privileges:true --cap-drop ALL \
    --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETUID --cap-add SETGID \
    -e RUN_ON_START=false -e CRON_SCHEDULE='0 0 1 1 *' \
    -e ACCOUNT_1_EMAIL=ci@example.invalid -e STOP_GRACE_SECONDS=2 \
    -v "$ROOT:/audit-project:ro" "$IMAGE" >"$OUT/container-id.txt"
for ((i=0;i<30;i++)); do
    if docker exec "$NAME" rewards-healthcheck; then break; fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$NAME")" != true ]; then
        echo 'Container exited before healthcheck; inspect final-container.log' >&2
        exit 1
    fi
    sleep 1
done
docker exec "$NAME" rewards-healthcheck
docker exec "$NAME" rewards-ctl selftest >"$OUT/selftest.log" 2>&1
# The assertion runner must not skip PID/proc tests in a real container.
docker exec -u 1000:1000 -e CI=true "$NAME" bash /audit-project/tests/run-wrapper.test.sh >"$OUT/wrapper.log" 2>&1
docker exec -u 1000:1000 "$NAME" bash /audit-project/tests/repeat-wrapper.test.sh >"$OUT/repeat.log" 2>&1
docker exec -u 1000:1000 "$NAME" bash /audit-project/tests/backup-restore.test.sh >"$OUT/backup.log" 2>&1

start_browser_run() {
    docker exec -u 1000:1000 "$NAME" rm -f /usr/src/microsoft-rewards-script/state/test-ready
    docker exec -e REWARDS_RUN_CMD='node /audit-project/tests/chromium-child.mjs' \
        -e TEST_READY_FILE=/usr/src/microsoft-rewards-script/state/test-ready \
        -e WATCH_INTERVAL_SECONDS=1 -e MAX_RETRIES=0 "$NAME" rewards-ctl run >"$OUT/active-run.log" 2>&1 &
    RUN_CLIENT=$!
    for ((i=0;i<30;i++)); do
        if docker exec "$NAME" test -f /usr/src/microsoft-rewards-script/state/test-ready; then return; fi
        sleep 1
    done
    echo 'Real Chromium did not become ready' >&2
    return 1
}
start_browser_run
set +e
docker exec "$NAME" rewards-ctl run >"$OUT/busy.log" 2>&1
busy=$?
set -e
[ "$busy" -eq 75 ]
docker exec "$NAME" rewards-ctl stop
set +e
wait "$RUN_CLIENT"; stopped=$?
set -e
[ "$stopped" -eq 143 ]
docker exec "$NAME" sh -c '! pgrep -f "[c]hrome-headless-shell|[c]hromium_headless_shell|[c]hromium-child.mjs"' >"$OUT/process-cleanup.log" 2>&1
start_browser_run
start=$SECONDS
docker stop -t 60 "$NAME" >"$OUT/docker-stop.log"
[ "$((SECONDS-start))" -lt 60 ]
[ "$(docker inspect --format '{{.State.ExitCode}}' "$NAME")" = 0 ]
docker logs "$NAME" >"$OUT/supervisor.log" 2>&1
grep -q Bye "$OUT/supervisor.log"
wait "$RUN_CLIENT" 2>/dev/null || true
# Verify restarting the same isolated container before the sustained browser loop.
docker start "$NAME" >"$OUT/restart.log"
for ((i=0;i<30;i++)); do
    if docker exec "$NAME" rewards-healthcheck; then break; fi
    sleep 1
done
docker exec "$NAME" rewards-healthcheck
docker exec -u 1000:1000 -e SOAK_SECONDS="$SOAK_SECONDS" "$NAME" \
    timeout "$((SOAK_SECONDS+300))" node /audit-project/tests/chromium-runtime.mjs >"$OUT/chromium-soak.json" 2>"$OUT/chromium-soak.stderr"
printf 'PASS: real amd64 image, non-root Chromium, wrapper/backup/repetition/soak, lock, stop and cleanup\n' >"$OUT/container-result.txt"
