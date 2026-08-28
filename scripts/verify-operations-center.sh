#!/usr/bin/env bash
# Mutation checks for the operations-center contracts.
# Each mutation removes one newly introduced source guard; the focused unit contracts
# must turn red. The original files are restored on every exit path.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PAGES="apps/seller-admin/src/pages.js"
DASH="apps/seller/src/dashboard.js"
TESTS=(apps/seller-admin/test/action-queues.test.js apps/seller-admin/test/dashboard-viec.test.js)
BAK="$(mktemp -d)"
pass=0
fail=0

ok() { pass=$((pass + 1)); printf '  PASS %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }

restore() {
  cp "$BAK/pages.js" "$PAGES"
  cp "$BAK/dashboard.js" "$DASH"
}
cleanup() {
  restore
  rm -rf "$BAK"
}
trap cleanup EXIT INT TERM

cp "$PAGES" "$BAK/pages.js"
cp "$DASH" "$BAK/dashboard.js"

run_contracts() {
  node --test "${TESTS[@]}" >/dev/null 2>&1
}

restore
if run_contracts; then
  ok "operations-center contracts xanh khi chot con nguyen"
else
  bad "operations-center contracts da do tu dau"
  exit 1
fi

# Mutation 1: remove the action gate from the single TODO registry. Numbers must remain
# visible, but a role without the destination permission must not receive its link.
restore
sed -i "s/canOpen: x\.see\.has(ctx\.role)/canOpen: true/" "$PAGES"
if run_contracts; then
  bad "bo action gate van xanh"
else
  ok "bo action gate -> contracts do"
fi

# Mutation 2: remove the partial-data contract from the stats response.
restore
sed -i 's/partial: { failed: out\.partial },/partial: { failed: [] },/' "$DASH"
if run_contracts; then
  bad "bo partial.failed van xanh"
else
  ok "bo partial.failed -> contracts do"
fi

restore
printf '\n%d pass, %d fail\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
