#!/usr/bin/env bash
# Stand-in for `node dist/index.js` used by run-wrapper.test.sh.
# Behaviour is selected with FAKE_MODE; every call is appended to $FAKE_CALLS.
set -u
echo "filter=${RUN_ACCOUNT_FILTER:-}" >>"$FAKE_CALLS"
echo "[fake-bot] working for alice@example.com"

summary() { # exitCode failed[] bot[] accounts-json
    printf '{"exitCode":%s,"failedEmails":%s,"botWarningEmails":%s,"accounts":%s}\n' "$1" "$2" "$3" "$4" >"$RUN_SUMMARY_FILE"
}

alice='{"email":"alice@example.com","status":"ok","collectedPoints":10}'
bob_fail='{"email":"bob@example.com","status":"failed","collectedPoints":0}'
bob_ok='{"email":"bob@example.com","status":"ok","collectedPoints":5}'
carol_bot='{"email":"carol@example.com","status":"skipped_bot_warning","collectedPoints":0}'

case "$FAKE_MODE" in
    ok) summary 0 '[]' '[]' "[$alice]"; exit 0 ;;
    partial)
        if [ -z "${RUN_ACCOUNT_FILTER:-}" ]; then
            summary 2 '["bob@example.com"]' '[]' "[$alice,$bob_fail]"; exit 2
        fi
        summary 0 '[]' '[]' "[$bob_ok]"; exit 0 ;;
    partialwarn)
        summary 2 '["bob@example.com"]' '["carol@example.com"]' "[$bob_fail,$carol_bot]"; exit 2 ;;
    fail) exit 1 ;;
    invalid) exit 0 ;; # success without summary must not be accepted
    partialnolist) summary 2 '[]' '[]' "[$bob_fail]"; exit 2 ;;
    bot) summary 0 '[]' '["carol@example.com"]' "[$carol_bot]"; exit 0 ;;
    riskmarker)
        printf 'risk\n' >"$RUN_RISK_FILE"
        sleep 30
        exit 0 ;;
    inconsistent) summary 2 '["bob@example.com"]' '[]' "[$bob_fail]"; exit 0 ;;
    sensitive)
        echo 'Authorization: Bearer TOKENVALUE123'
        echo 'password=PASSVALUE123'
        echo 'Cookie: SID=COOKIEVALUE123; SECOND=SECONDCOOKIE123'
        echo 'http://PROXYUSER123:PROXYPASS123@proxy.invalid:1234'
        echo 'https://api.telegram.org/botTELEGRAMTOKEN123/sendMessage'
        echo '{"accessToken":"ACCESSVALUE123"}'
        summary 0 '[]' '[]' "[$alice]"; exit 0 ;;
    slow) sleep 4; summary 0 '[]' '[]' "[$alice]"; exit 0 ;;
    hang)
        sleep 1000 &                      # pretend Chromium (same process group)
        echo "$!" >"$FAKE_GRANDCHILD"
        trap '' TERM                      # ignore SIGTERM -> forces SIGKILL path
        while :; do sleep 1; done ;;
esac
