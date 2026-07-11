#!/usr/bin/env bash
#
# Mutation testing cho checkout (Ngày 12-13) — bảo mật luồng tiền.
# Gỡ từng bất biến, khẳng định e2e chuyển đỏ. Hoàn nguyên.
#
#   bash scripts/verify-checkout.sh [tên...]

set -uo pipefail
export MSYS_NO_PATHCONV=1

COMPOSE="docker compose -f infra/compose.dev.yml"
SRV=apps/checkout/src/server.js
BAK="$(mktemp -d)"
pass=0; fail=0
RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'
ok()   { pass=$((pass+1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad()  { fail=$((fail+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; return 0; }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cp "$SRV" "$BAK/server.js"
restore() { cp "$BAK/server.js" "$SRV"; }
trap 'restore; rm -rf "$BAK"' EXIT INT TERM

wait_co() {
  for _ in $(seq 30); do
    if $COMPOSE exec -T checkout node -e "fetch('http://127.0.0.1:3060/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
restart() { $COMPOSE restart checkout >/dev/null 2>&1; wait_co; }
run_e2e() {
  $COMPOSE exec -T redis redis-cli flushall >/dev/null 2>&1
  $COMPOSE exec -T dbtest node apps/checkout/test/e2e.mjs >/dev/null 2>&1
}

FILTER="${*:-}"
mutate() {
  local name="$1" desc="$2" patch="$3"
  if [ -n "$FILTER" ] && ! grep -qw "$name" <<<"$FILTER"; then return 0; fi
  restore; eval "$patch"
  if diff -q "$BAK/server.js" "$SRV" >/dev/null; then bad "$desc — patch không đổi gì (anchor sai)"; return; fi
  if ! restart; then bad "$desc — checkout không khởi động lại"; restore; restart; return; fi
  if run_e2e; then bad "$desc → e2e VẪN XANH. Không được bảo vệ."; else ok "$desc → e2e chuyển sang đỏ"; fi
  restore; restart
}

sect "0. Trạng thái ban đầu"
restart
run_e2e && ok "checkout e2e xanh khi mọi bất biến còn nguyên" || { bad "e2e đã đỏ từ đầu"; exit 1; }

sect "1. Gỡ từng bất biến luồng tiền"

# Nếu dùng giá client thay vì variants.price_vnd → total sai (client gửi 1).
mutate serverprice "tính giá từ CLIENT thay vì server (variants)" \
  "sed -i 's|const unit = Number(it.price_vnd);|const unit = Number(body.price_vnd ?? it.price_vnd);|g' $SRV"

# Bỏ kiểm tồn khi reserve → oversell (đua đơn cuối → cả hai thắng).
mutate stockcheck "bỏ kiểm tồn khi reserve (oversell)" \
  "sed -i 's|if (it.qty > available) fail(422, \`hết hàng|if (false) fail(422, \`hết hàng|' $SRV"

# Bỏ giành idempotency key → checkout lặp tạo đơn thứ 2.
mutate idem "bỏ idempotency (cho tạo đơn trùng)" \
  "sed -i 's|ON CONFLICT (shop_id, key) DO NOTHING RETURNING key|ON CONFLICT (shop_id, key) DO UPDATE SET status=EXCLUDED.status RETURNING key|' $SRV"

# Không reserve tồn → reserved không tăng (test reserve=2 đỏ) + oversell.
mutate reserve "bỏ cập nhật reserved (không giữ chỗ)" \
  "sed -i 's|UPDATE inventory_levels SET reserved = reserved + \$2|UPDATE inventory_levels SET reserved = reserved + 0|' $SRV"

# order_number toàn cục (bỏ tăng theo shop) — dùng hằng số → shop B không = 1...
# thực ra khó; thay bằng: bỏ snapshot giá (lấy giá hiện tại lúc lookup? không).
# Snapshot: order_lines lưu ln.unit; nếu lưu 0 → snapshot sai.
mutate snapshot "ghi snapshot giá = 0 (mất snapshot)" \
  "sed -i 's|\[order.id, ln.variant_id, ln.title, ln.sku, ln.unit, ln.qty\]|[order.id, ln.variant_id, ln.title, ln.sku, 0, ln.qty]|' $SRV"

sect "2. Trạng thái sau khi hoàn nguyên"
restore; restart
run_e2e && ok "checkout e2e xanh trở lại" || bad "e2e còn đỏ — chưa hoàn nguyên đúng!"

printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
