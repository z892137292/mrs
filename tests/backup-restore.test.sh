#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/project/scripts" "$TEST_ROOT/project/config" "$TEST_ROOT/project/sessions" "$TEST_ROOT/project/state" "$TEST_ROOT/archive"
cp "$ROOT/scripts/backup-data.sh" "$ROOT/scripts/restore-data.sh" "$TEST_ROOT/project/scripts/"
printf 'config-secret\n' > "$TEST_ROOT/project/config/config.json"
printf 'session-secret\n' > "$TEST_ROOT/project/sessions/session.txt"
printf 'account-state\n' > "$TEST_ROOT/project/state/last-summary.json"
printf 'ACCOUNT_1_PASSWORD=very-secret\n' > "$TEST_ROOT/project/.env"
BACKUP_CONFIRMED_OFFLINE=1 "$TEST_ROOT/project/scripts/backup-data.sh" "$TEST_ROOT/archive" >/dev/null
archive="$(find "$TEST_ROOT/archive" -name '*.tar.gz' -print -quit)"
[ -f "$archive" ]
[ "$(stat -c %a "$archive")" = 600 ]
listing="$(tar -tzf "$archive")"
if grep -q '\.env' <<<"$listing"; then echo 'FAIL: .env included'; exit 1; fi
"$TEST_ROOT/project/scripts/restore-data.sh" "$archive" "$TEST_ROOT/restore" >/dev/null
cmp "$TEST_ROOT/project/config/config.json" "$TEST_ROOT/restore/config/config.json"
cmp "$TEST_ROOT/project/sessions/session.txt" "$TEST_ROOT/restore/sessions/session.txt"
cmp "$TEST_ROOT/project/state/last-summary.json" "$TEST_ROOT/restore/state/last-summary.json"
if "$TEST_ROOT/project/scripts/restore-data.sh" "$archive" "$TEST_ROOT/restore" >/dev/null 2>&1; then
    echo 'FAIL: restore overwrote existing destination'; exit 1
fi
# Check corruption is refused before creating target directory.
printf x >> "$archive"
if "$TEST_ROOT/project/scripts/restore-data.sh" "$archive" "$TEST_ROOT/corrupt-restore" >/dev/null 2>&1; then
    echo 'FAIL: corrupted backup was accepted'; exit 1
fi
[ ! -e "$TEST_ROOT/corrupt-restore" ]
mkdir -p "$TEST_ROOT/unsafe/config" "$TEST_ROOT/unsafe/sessions" "$TEST_ROOT/unsafe/state"
mkfifo "$TEST_ROOT/unsafe/config/pipe"
tar -czf "$TEST_ROOT/fifo.tar.gz" -C "$TEST_ROOT/unsafe" config sessions state
if "$TEST_ROOT/project/scripts/restore-data.sh" "$TEST_ROOT/fifo.tar.gz" "$TEST_ROOT/fifo-restore" >/dev/null 2>&1; then
    echo 'FAIL: FIFO accepted'; exit 1
fi
[ ! -e "$TEST_ROOT/fifo-restore" ]
printf 'invalid archive' >"$TEST_ROOT/invalid.tar.gz"
if "$TEST_ROOT/project/scripts/restore-data.sh" "$TEST_ROOT/invalid.tar.gz" "$TEST_ROOT/invalid-restore" >/dev/null 2>&1; then
    echo 'FAIL: invalid archive accepted'; exit 1
fi
[ ! -e "$TEST_ROOT/invalid-restore" ]
echo 'PASS: backup/restore, secrets exclusion, permissions, overwrite protection, checksum'
