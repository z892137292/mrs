#!/usr/bin/env bash
# Restore a local backup into a NEW DIRECTORY for inspection, never over live data.
# Usage: scripts/restore-data.sh backups/mrs-data-....tar.gz /path/to/new-test-data
set -Eeuo pipefail
umask 077
[ "$#" -eq 2 ] || { echo "Usage: $0 BACKUP.tar.gz NEW_EMPTY_DIRECTORY" >&2; exit 2; }
ARCHIVE="$1"
DEST="$2"
[ -f "$ARCHIVE" ] || { echo "Archive not found: $ARCHIVE" >&2; exit 1; }
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
    echo 'Destination exists; never restore over existing/live data.' >&2
    exit 1
fi
for tool in tar sha256sum mktemp; do command -v "$tool" >/dev/null || { echo "Missing command: $tool" >&2; exit 1; }; done
if [ -f "$ARCHIVE.sha256" ]; then
    expected="$(head -n 1 "$ARCHIVE.sha256" | tr -d '[:space:]')"
    [[ "$expected" =~ ^[0-9a-fA-F]{64}$ ]] || { echo 'Invalid checksum file' >&2; exit 1; }
    actual="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
    [ "${actual,,}" = "${expected,,}" ] || { echo 'Checksum mismatch; restore aborted.' >&2; exit 1; }
else
    echo 'WARNING: .sha256 file absent; cannot verify archive integrity.' >&2
fi
LISTING="$(mktemp)"
DETAILS="$(mktemp)"
trap 'rm -f -- "$LISTING" "$DETAILS"' EXIT
tar -tzf "$ARCHIVE" >"$LISTING" || { echo 'Invalid archive; restore aborted.' >&2; exit 1; }
LC_ALL=C tar -tvzf "$ARCHIVE" >"$DETAILS" || { echo 'Invalid archive; restore aborted.' >&2; exit 1; }
# Whitelist only the three data roots, and reject tar symlinks/hardlinks to avoid
# path traversal via link entries. Only restore archives from our backup script.
while IFS= read -r entry; do
    case "$entry" in
        config | config/ | config/* | sessions | sessions/ | sessions/* | state | state/ | state/*) ;;
        *) echo "Unsafe archive path: $entry" >&2; exit 1 ;;
    esac
    case "/$entry/" in
        *'/../'* | *'/./'* ) echo "Unsafe archive path: $entry" >&2; exit 1 ;;
    esac
done <"$LISTING"
if grep -Eq '^[^-d]' "$DETAILS"; then
    echo 'Archive contains a link or special file; restore aborted.' >&2
    exit 1
fi
PARENT="$(dirname -- "$DEST")"
[ -d "$PARENT" ] || { echo "Destination parent does not exist: $PARENT" >&2; exit 1; }
mkdir -m 700 -- "$DEST"
# Existing files cannot be replaced: destination is newly created above.
if ! tar -xzf "$ARCHIVE" -C "$DEST" --no-same-owner --no-same-permissions; then
    echo "Extract failed; inspect and remove incomplete directory manually: $DEST" >&2
    exit 1
fi
chmod 700 "$DEST" "$DEST/config" "$DEST/sessions" "$DEST/state"
echo "Restore complete (OFFLINE staging only): $DEST"
echo 'Review files before choosing whether/how to migrate them. No live directory was modified.'
echo 'Account secrets stored in .env are not in the archive.'
