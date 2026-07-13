#!/usr/bin/env bash
#
# Mutation testing cho storefront công khai (Ngày 10). Gỡ từng lớp phòng thủ,
# khẳng định storefront e2e chuyển đỏ. Hoàn nguyên.
#
#   bash scripts/verify-storefront.sh [tên...]

set -uo pipefail
export MSYS_NO_PATHCONV=1

COMPOSE="docker compose -f infra/compose.dev.yml"
SRV=apps/storefront/src/server.js
THM=apps/storefront/src/theme.js
BAK="$(mktemp -d)"
pass=0; fail=0
RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'
ok()   { pass=$((pass+1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad()  { fail=$((fail+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; return 0; }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cp "$SRV" "$BAK/server.js"; cp "$THM" "$BAK/theme.js"
restore() { cp "$BAK/server.js" "$SRV"; cp "$BAK/theme.js" "$THM"; }
trap 'restore; rm -rf "$BAK"' EXIT INT TERM

wait_sf() {
  for _ in $(seq 30); do
    if $COMPOSE exec -T storefront node -e "fetch('http://127.0.0.1:3050/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
restart() { $COMPOSE restart storefront >/dev/null 2>&1; wait_sf; }
run_e2e() {
  $COMPOSE exec -T redis redis-cli flushall >/dev/null 2>&1
  $COMPOSE exec -T dbtest node apps/storefront/test/e2e.mjs >/dev/null 2>&1
}

FILTER="${*:-}"
mutate() {
  local name="$1" desc="$2" patch="$3"
  if [ -n "$FILTER" ] && ! grep -qw "$name" <<<"$FILTER"; then return 0; fi
  restore; eval "$patch"
  if diff -q "$BAK/server.js" "$SRV" >/dev/null && diff -q "$BAK/theme.js" "$THM" >/dev/null; then
    bad "$desc — patch không đổi gì (anchor sai)"; return
  fi
  if ! restart; then bad "$desc — storefront không khởi động lại"; restore; restart; return; fi
  if run_e2e; then bad "$desc → e2e VẪN XANH. Không được bảo vệ."; else ok "$desc → e2e chuyển sang đỏ"; fi
  restore; restart
}

sect "0. Trạng thái ban đầu"
restart
run_e2e && ok "storefront e2e xanh khi mọi lớp còn nguyên" || { bad "e2e đã đỏ từ đầu"; exit 1; }

sect "1. Gỡ từng lớp phòng thủ storefront"

mutate escape "bỏ escape < > (XSS)" \
  "sed -i \"s@.replace(LT, '&lt;').replace(GT, '&gt;')@.replace(LT, '<').replace(GT, '>')@\" $THM"

mutate token "bỏ sanitize token (CSS injection)" \
  "sed -i 's@if (okColor || okFont || okSize) out\[k\] = v;@out[k] = v;@' $THM"

# resolveShop (A5) có 2 chỗ verified_at: subquery primary_host + WHERE chính (d.verified_at).
# Phải gỡ WHERE CHÍNH (d.verified_at) mới cho domain chưa-verify route → e2e §domain đỏ.
mutate verified "bỏ lọc domain đã verified (chống chiếm domain)" \
  "sed -i 's|AND d.verified_at IS NOT NULL||' $SRV"

mutate tenant "bỏ set tenant context (RLS mất cô lập app_store)" \
  "sed -i \"s|set_config('app.shop_id'|set_config('app.nothing'|\" $SRV"

mutate suspended "bỏ chặn shop suspended (vẫn render sản phẩm)" \
  "sed -i \"s|if (shop.status === 'suspended')|if (false)|\" $SRV"

sect "2. Trạng thái sau khi hoàn nguyên"
restore; restart
run_e2e && ok "storefront e2e xanh trở lại" || bad "e2e còn đỏ — chưa hoàn nguyên đúng!"

printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
