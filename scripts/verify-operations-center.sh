#!/usr/bin/env bash
# Mutation checks for the operations-center contracts.
# Each mutation removes one newly introduced source guard; the focused unit contracts
# must turn red. The original files are restored on every exit path.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PAGES="apps/seller-admin/src/pages.js"
DASH="apps/seller/src/dashboard.js"
CONTRACT="apps/seller/src/dashboard-contract.js"
ADMIN_CONTRACT="apps/seller-admin/src/operations-center.js"
TESTS=(apps/seller-admin/test/action-queues.test.js apps/seller-admin/test/dashboard-viec.test.js)
BAK="$(mktemp -d)"
pass=0
fail=0

ok() { pass=$((pass + 1)); printf '  PASS %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }

restore() {
  cp "$BAK/pages.js" "$PAGES"
  cp "$BAK/dashboard.js" "$DASH"
  cp "$BAK/dashboard-contract.js" "$CONTRACT"
  cp "$BAK/operations-center.js" "$ADMIN_CONTRACT"
}
cleanup() {
  restore
  rm -rf "$BAK"
}
trap cleanup EXIT INT TERM

cp "$PAGES" "$BAK/pages.js"
cp "$DASH" "$BAK/dashboard.js"
cp "$CONTRACT" "$BAK/dashboard-contract.js"
cp "$ADMIN_CONTRACT" "$BAK/operations-center.js"

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

# Mutation 2: remove the actual failure recording from the savepoint helper.
restore
sed -i 's/    partial\.push(name);//' "$CONTRACT"
if run_contracts; then
  bad "bo ghi partial.failed van xanh"
else
  ok "bo ghi partial.failed -> contracts do"
fi

# Mutation 3: couple list availability back to the independent `todo` count query.
restore
sed -i "s/const unavailable = failedGroups\.has('shipment_attention')/const unavailable = failedGroups.has('shipment_attention') || todoItem?.available === false/" "$ADMIN_CONTRACT"
if run_contracts; then
  bad "noi lai danh sach voi todo van xanh"
else
  ok "noi lai danh sach voi todo -> contracts do"
fi

# Mutation 4: drift the producer-side name while the seller-admin consumer keeps the old one.
restore
sed -i "s/optional('shipment_attention'/optional('shipments'/" "$DASH"
if run_contracts; then
  bad "doi ten nhom partial mot phia van xanh"
else
  ok "doi ten nhom partial mot phia -> contracts do"
fi

# Mutation 5: disconnect the helper from the partial array returned in the response.
restore
sed -i 's/withOptionalDashboardGroup(c, partial, name, fn, fallback)/withOptionalDashboardGroup(c, [], name, fn, fallback)/' "$DASH"
if run_contracts; then
  bad "cat day noi partial van xanh"
else
  ok "cat day noi partial -> contracts do"
fi

# Mutation 6: keep a successful savepoint open instead of releasing it.
restore
sed -i '0,/    await client.query(`RELEASE SAVEPOINT ${savepoint}`);/s//    \/\/ mutation removed successful release/' "$CONTRACT"
if run_contracts; then
  bad "bo release savepoint thanh cong van xanh"
else
  ok "bo release savepoint thanh cong -> contracts do"
fi

restore
printf '\n%d pass, %d fail\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
