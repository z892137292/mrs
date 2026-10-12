#!/usr/bin/env bash
# Finite offline repetition/concurrency test. Not a Chromium soak test.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf -- "$T"' EXIT
export APP_DIR="$T/app" STATE_DIR="$T/app/state" LOG_DIR="$T/app/logs"
export REWARDS_LIB="$ROOT/docker/lib.sh" SUMMARY_MERGE_JQ="$ROOT/docker/merge-summary.jq"
export REWARDS_RUN_CMD="bash $ROOT/tests/fake-bot.sh" FAKE_CALLS="$T/calls" FAKE_GRANDCHILD="$T/grandchild"
export MAX_RETRIES=0 WATCH_INTERVAL_SECONDS=1 STOP_GRACE_SECONDS=2
export MIN_SLEEP_MINUTES=0 MAX_SLEEP_MINUTES=0 FAKE_MODE=ok
mkdir -p "$APP_DIR"
: >"$FAKE_CALLS"
start=$SECONDS
for ((i=0;i<20;i++)); do
    timeout 10 bash "$ROOT/docker/rewards-run.sh" manual >"$T/out" 2>&1
    [ "$(jq -r .result "$STATE_DIR/status.json")" = success ]
    [ ! -f "$STATE_DIR/run.pid" ] && [ ! -f "$STATE_DIR/bot.pgid" ]
    [ -z "$(find "$STATE_DIR" -name '.attempt-summary-*' -o -name '.risk-*')" ]
done
[ "$(wc -l <"$FAKE_CALLS")" -eq 20 ]
export FAKE_MODE=slow
pids=()
for ((i=0;i<10;i++)); do
    timeout 10 bash "$ROOT/docker/rewards-run.sh" schedule >"$T/storm-$i" 2>&1 &
    pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done
[ "$(wc -l <"$FAKE_CALLS")" -eq 21 ]
echo "PASS: 20 repeated offline runs + 10 concurrent triggers; one bot in storm; $((SECONDS-start))s"
echo 'NOT VERIFIED: real Chromium resource growth, long-term operation, detached processes outside the process group'
