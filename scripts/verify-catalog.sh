#!/usr/bin/env bash
#
# Mutation testing cho bộ e2e catalog.
#
#   bash scripts/verify-catalog.sh [tên...]
#
# Gỡ từng bất biến catalog, khẳng định catalog e2e chuyển đỏ. Hoàn nguyên.

set -uo pipefail
export MSYS_NO_PATHCONV=1

COMPOSE="docker compose -f infra/compose.dev.yml"
CAT=apps/seller/src/catalog.js
DBF=apps/seller/src/db.js
BAK="$(mktemp -d)"
pass=0; fail=0
RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'

ok()   { pass=$((pass+1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad()  { fail=$((fail+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; return 0; }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cp "$CAT" "$BAK/catalog.js"
cp "$DBF" "$BAK/db.js"
restore() { cp "$BAK/catalog.js" "$CAT"; cp "$BAK/db.js" "$DBF"; }
trap 'restore; rm -rf "$BAK"' EXIT INT TERM

wait_seller() {
  for _ in $(seq 30); do
    if $COMPOSE exec -T seller node -e "fetch('http://127.0.0.1:3040/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
restart() { $COMPOSE restart seller >/dev/null 2>&1; wait_seller; }
run_e2e() {
  $COMPOSE exec -T redis redis-cli flushall >/dev/null 2>&1
  $COMPOSE exec -T dbtest node apps/seller/test/catalog.e2e.mjs >/dev/null 2>&1
}

FILTER="${*:-}"
mutate() {
  local name="$1" desc="$2" patch="$3"
  if [ -n "$FILTER" ] && ! grep -qw "$name" <<<"$FILTER"; then return 0; fi
  restore
  eval "$patch"
  if diff -q "$BAK/catalog.js" "$CAT" >/dev/null && diff -q "$BAK/db.js" "$DBF" >/dev/null; then
    bad "$desc — patch không đổi gì (anchor sai)"; return
  fi
  if ! restart; then bad "$desc — seller không khởi động lại"; restore; restart; return; fi
  if run_e2e; then bad "$desc → e2e VẪN XANH. Không được bảo vệ."; else ok "$desc → e2e chuyển sang đỏ"; fi
  restore; restart
}

sect "0. Trạng thái ban đầu"
restart
run_e2e && ok "e2e xanh khi mọi bất biến còn nguyên" || { bad "e2e đã đỏ từ đầu"; exit 1; }

sect "1. Gỡ từng bất biến catalog"

mutate price "bỏ validate giá (nhận giá âm / không nguyên)" \
  "sed -i 's|const validPrice = (x) => isInt(x) \&\& x >= 0 \&\& x <= MAX_PRICE;|const validPrice = (x) => true;|' $CAT"

mutate payloaddup "bỏ chặn SKU trùng trong payload (đẩy về 409 thay vì 400)" \
  "sed -i 's|if (new Set(skus).size !== skus.length)|if (false)|' $CAT"

mutate lastvariant "bỏ chặn xoá biến thể cuối cùng" \
  "sed -i 's|if (cnt.rows\[0\].n <= 1) {|if (false) {|' $CAT"

mutate softdelete "xoá sản phẩm không thực sự đánh dấu deleted_at" \
  "sed -i 's|SET deleted_at = now() WHERE id = \$1 AND deleted_at IS NULL|SET title = title WHERE id = \$1 AND deleted_at IS NULL|' $CAT"

mutate tenant "đặt sai tenant context (RLS mất cô lập app_rw)" \
  "sed -i \"s|set_config('app.shop_id'|set_config('app.nothing'|\" $DBF"

sect "2. Trạng thái sau khi hoàn nguyên"
restore; restart
run_e2e && ok "e2e xanh trở lại — mọi mutation đã gỡ" || bad "e2e còn đỏ — chưa hoàn nguyên đúng!"

printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
