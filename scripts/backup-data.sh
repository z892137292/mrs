#!/usr/bin/env bash
# Offline backup of local persisted data. DOES NOT upload anything or stop containers.
# Run only after stopping the custom container, otherwise database/session files can be inconsistent.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
OUT_DIR="${1:-$ROOT/backups}"
for tool in tar sha256sum mktemp; do command -v "$tool" >/dev/null || { echo "Missing command: $tool" >&2; exit 1; }; done
for d in config sessions state; do
    [ -d "$ROOT/$d" ] || { echo "Missing $ROOT/$d; backup aborted" >&2; exit 1; }
done
# No symlink entries are copied; avoid saving references to content outside these directories.
if [ -n "$(find "$ROOT/config" "$ROOT/sessions" "$ROOT/state" -type l -print -quit)" ]; then
    echo 'Backup aborted: data folders contain symbolic links; inspect them first.' >&2
    exit 1
fi
if [ -f "$ROOT/compose.yaml" ] && command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    running="$(cd "$ROOT" && docker compose ps --status running -q rewards)" || {
        echo 'Backup aborted: cannot determine Docker container status.' >&2; exit 1;
    }
    [ -z "$running" ] || { echo 'Backup aborted: rewards container is running.' >&2; exit 1; }
elif [ "${BACKUP_CONFIRMED_OFFLINE:-}" != 1 ]; then
    echo 'Backup aborted: Docker status unavailable. Confirm offline data with BACKUP_CONFIRMED_OFFLINE=1.' >&2
    exit 1
fi
mkdir -p -- "$OUT_DIR"
chmod 700 -- "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd -P)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$OUT_DIR/mrs-data-$STAMP-$$.tar.gz"
TMP="$(mktemp "$OUT_DIR/.mrs-data-XXXXXX")"
trap 'rm -f -- "$TMP"' EXIT
(cd "$ROOT" && tar -czf "$TMP" config sessions state)
mv -f -- "$TMP" "$ARCHIVE"
chmod 600 "$ARCHIVE"
sha256sum "$ARCHIVE" | awk '{print $1}' > "$ARCHIVE.sha256"
chmod 600 "$ARCHIVE.sha256"
echo "Backup complete: $ARCHIVE"
echo "Checksum: $ARCHIVE.sha256"
echo 'WARNING: this archive contains account session credentials. Keep it PRIVATE; .env is NOT included.'
