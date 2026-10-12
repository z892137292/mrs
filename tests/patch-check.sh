#!/usr/bin/env bash
# Clean-room check of the custom patches: fetch the pinned upstream commit,
# apply patches/*.patch, then typecheck, lint, format-check, build and unit-test.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=upstream.env
. "$ROOT/upstream.env"
WORK="${WORK_DIR:-$(mktemp -d)}"

echo "==> fetching $UPSTREAM_REPO @ $UPSTREAM_REF"
git -C "$WORK" init -q
git -C "$WORK" fetch -q --depth 1 "$UPSTREAM_REPO" "$UPSTREAM_REF"
git -C "$WORK" checkout -q FETCH_HEAD
[ "$(git -C "$WORK" rev-parse HEAD)" = "$UPSTREAM_REF" ] || { echo "ref mismatch"; exit 1; }

echo "==> applying patches"
for p in "$ROOT"/patches/*.patch; do
    git -C "$WORK" apply --check "$p"
    git -C "$WORK" apply "$p"
    echo "    ok $(basename "$p")"
done

cd "$WORK"
echo "==> npm ci";            npm ci --ignore-scripts --no-audit --no-fund --loglevel=error
echo "==> build (tsc)";       npm run --silent build
echo "==> eslint";            npx eslint src
echo "==> prettier";          npx prettier --check src >/dev/null
echo "==> unit tests";        DIST_DIR="$WORK/dist" node --test "$ROOT/tests/patch.test.mjs"
echo "patch-check: OK"
