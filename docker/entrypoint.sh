#!/usr/bin/env bash
# Container entrypoint (runs under tini).
#   phase 1 (root):     validate TZ, create/own data dirs, drop to PUID:PGID
#   phase 2 (app user): prepare config.json, then start the supervisor or the given command
set -Eeuo pipefail

LOG_TAG="entrypoint"
# shellcheck source=docker/lib.sh
. "${REWARDS_LIB:-/usr/local/lib/rewards/lib.sh}"

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
require_uint PUID "$PUID"
require_uint PGID "$PGID"
[ $# -gt 0 ] || set -- supervisor

DATA_DIRS=(config sessions state logs diagnostics)
if is_true "${CONTROL_API_ENABLED:-false}"; then
    DATA_DIRS+=(control-data)
fi

if [ "$(id -u)" = 0 ]; then
    : "${TZ:=UTC}"
    [ -f "/usr/share/zoneinfo/$TZ" ] || die "Unknown TZ '$TZ'"
    [ "$PUID" != 0 ] || die "PUID=0 is not allowed; the bot runs unprivileged."

    for d in "${DATA_DIRS[@]}"; do
        mkdir -p "$APP_DIR/$d"
        chmod 700 "$APP_DIR/$d" 2>/dev/null || log "WARNING: cannot restrict mode of $APP_DIR/$d"
        # Only touch files with the wrong owner (cheap on large session dirs).
        find "$APP_DIR/$d" \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown -h "$PUID:$PGID" {} + 2>/dev/null ||
            log "WARNING: could not chown $APP_DIR/$d (read-only or rootless mount?)"
    done

    task_home=/tmp
    [ "$PUID" = 1000 ] && task_home=/home/node
    exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups --inh-caps=-all \
        env HOME="$task_home" "$0" "$@"
fi

# ── Unprivileged from here on ───────────────────────────────────────────────
for d in "${DATA_DIRS[@]}"; do
    mkdir -p "$APP_DIR/$d" 2>/dev/null || true
    [ -w "$APP_DIR/$d" ] || die "$APP_DIR/$d is not writable by uid $(id -u). Fix host permissions or set PUID/PGID."
done

if [ "$1" != supervisor ]; then
    exec "$@"
fi

if is_true "${API_MODE:-false}"; then
    die "API_MODE is not supported by this image yet (its process manager bypasses the run lock). Unset API_MODE."
fi

account_count=$(compgen -e | grep -cE '^ACCOUNT_[1-9][0-9]*_EMAIL$' || true)
if [ "$account_count" -eq 0 ]; then
    log "WARNING: no ACCOUNT_N_EMAIL variables found; runs will fail until .env is configured."
else
    log "Found $account_count account slot(s)"
fi

CONFIG_FILE="$APP_DIR/config/config.json"
[ -d "$CONFIG_FILE" ] && die "$CONFIG_FILE is a directory; remove it on the host."

sync_args=(--config "$CONFIG_FILE" --example "$APP_DIR/config.example.json")
is_true "${CONFIG_AUTO_SYNC:-false}" && sync_args+=(--patch)
node "$APP_DIR/dist/util/ConfigSync.js" sync "${sync_args[@]}" || die "config sync failed"
node "$APP_DIR/dist/util/ConfigEnvOverrides.js" apply --config "$CONFIG_FILE" || die "CONFIG_* overrides failed"
log "Config ready"

exec /usr/local/bin/rewards-supervisor
