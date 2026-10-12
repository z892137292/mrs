#!/usr/bin/env bash
# Offline image self-test. Never contacts Microsoft; uses no account data.
set -Euo pipefail

LOG_TAG="selftest"
# shellcheck source=docker/lib.sh
. "${REWARDS_LIB:-/usr/local/lib/rewards/lib.sh}"

fails=0
check() {
    local name="$1"
    shift
    if out="$("$@" 2>&1)"; then
        echo "PASS  $name"
    else
        echo "FAIL  $name"
        printf '%s\n' "$out" | tail -n 15 | sed 's/^/      /'
        fails=$((fails + 1))
    fi
}

cd "$APP_DIR" || exit 1

check "non-root identity" bash -c 'test "$(id -u)" != 0'
check "node >= 24" node -e 'process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)'
check "upstream build present" test -f dist/index.js
check "custom patch compiled in" grep -q RUN_ACCOUNT_FILTER dist/util/Load.js
check "account filter logic" node -e '
    process.env.RUN_ACCOUNT_FILTER = "B@x.io"
    const { applyAccountFilter } = require("./dist/util/Load.js")
    const r = applyAccountFilter([{ email: "a@x.io" }, { email: "b@x.io" }])
    if (r.length !== 1 || r[0].email !== "b@x.io") throw new Error(JSON.stringify(r))'
check "supercronic parses schedule" bash -c 'f=$(mktemp); echo "0 7 * * * true" >"$f"; supercronic -test "$f"'
check "tools present" bash -c 'command -v jq flock setsid setpriv pgrep tini >/dev/null'
for d in config sessions state logs diagnostics; do
    check "$d writable" bash -c "mkdir -p '$APP_DIR/$d' && t=\$(mktemp -p '$APP_DIR/$d') && rm -f \"\$t\""
done
check "chromium headless launch" timeout 90 node -e '
    const { chromium } = require("patchright")
    ;(async () => {
        const b = await chromium.launch({ headless: true })
        const p = await b.newPage()
        await p.setContent("<title>ok</title>")
        const t = await p.title()
        await b.close()
        if (t !== "ok") throw new Error("unexpected title " + t)
    })().catch(e => { console.error(e); process.exit(1) })'

echo
if [ "$fails" -eq 0 ]; then
    echo "selftest: all checks passed"
else
    echo "selftest: $fails check(s) failed"
    exit 1
fi
