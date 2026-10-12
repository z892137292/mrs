# shellcheck shell=bash
# shellcheck disable=SC2034  # variables are consumed by the scripts that source this file
# Shared helpers for the custom runtime layer. Sourced, never executed.

umask 077

APP_DIR="${APP_DIR:-/usr/src/microsoft-rewards-script}"
STATE_DIR="${STATE_DIR:-$APP_DIR/state}"
LOG_DIR="${LOG_DIR:-$APP_DIR/logs}"

LOCK_FILE="$STATE_DIR/run.lock"
RUN_PID_FILE="$STATE_DIR/run.pid"
STOP_FILE="$STATE_DIR/STOP"
STATUS_FILE="$STATE_DIR/status.json"
SUMMARY_FILE="$STATE_DIR/last-summary.json"
FAILCOUNT_FILE="$STATE_DIR/consecutive-failures"
BOT_PGID_FILE="$STATE_DIR/bot.pgid"

log() {
    printf '[%s] [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "${LOG_TAG:-rewards}" "$*"
}

die() {
    log "ERROR: $*" >&2
    exit 1
}

# require_uint NAME VALUE -> dies unless VALUE is a non-negative integer
require_uint() {
    [[ "$2" =~ ^[0-9]+$ ]] || die "$1 must be a non-negative integer (got '$2')"
}

is_true() {
    case "${1,,}" in 1 | true | yes | on) return 0 ;; *) return 1 ;; esac
}

# Best-effort log scrubbing. Credential redaction cannot cover arbitrary third-party
# error formats: NEVER share raw session/config/diagnostics files or logs blindly.
# Redact credential fields regardless of LOG_REDACT_EMAILS.
redact_stream() {
    local scrub=(
        -e 's#(https?://|socks[45]://)[^/@[:space:]]+:[^/@[:space:]]+@#\1[REDACTED]@#Ig'
        -e 's#(https://api\.telegram\.org/bot)[^/[:space:]]+#\1[REDACTED]#Ig'
        -e 's/([Aa]uthorization[[:space:]]*:[[:space:]]*[Bb]earer[[:space:]]+)[^[:space:]";]+/\1[REDACTED]/g'
        -e 's/([Cc]ookie|[Ss]et-[Cc]ookie)([[:space:]]*:)[[:space:]]*.*/\1\2 [REDACTED]/g'
        -e 's/((password|passwd|totp_secret|access_token|refresh_token|api_key|client_secret|proxy_password|cookie|sessionid)[[:space:]]*[:=][[:space:]]*)("[^"]*"|[^[:space:],;]+)/\1[REDACTED]/Ig'
        -e 's/("(password|passwd|totpSecret|accessToken|refreshToken|apiKey|clientSecret|proxyPassword|cookie|sessionid)"[[:space:]]*:[[:space:]]*)("[^"]*"|[^[:space:],}]+)/\1"[REDACTED]"/Ig'
        -e 's/((token|secret|code|password|api_key)=)[^&[:space:]";]+/\1[REDACTED]/Ig'
    )
    if is_true "${LOG_REDACT_EMAILS:-true}"; then
        scrub+=(-e 's/([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/\1***@\2/g')
    fi
    sed -u -E "${scrub[@]}"
}

# Interruptible sleep: a trapped signal ends `wait` immediately.
# fd 9 (the run lock) is closed so an orphaned sleep can never keep the lock.
isleep() {
    sleep "$1" 9>&- &
    wait $! 2>/dev/null || true
}

# True when PID is alive and its command line contains PATTERN.
pid_matches() {
    local pid="$1" pattern="$2"
    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    [ -r "/proc/$pid/cmdline" ] || return 1
    tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q -- "$pattern"
}

read_failcount() {
    local n
    n="$(cat "$FAILCOUNT_FILE" 2>/dev/null || echo 0)"
    [[ "$n" =~ ^[0-9]+$ ]] || n=0
    echo "$n"
}

ensure_dirs() {
    mkdir -p "$STATE_DIR" "$LOG_DIR"
}
