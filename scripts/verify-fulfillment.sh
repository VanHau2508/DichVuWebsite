#!/usr/bin/env bash
#
# Mutation testing cho vận chuyển + email (Ngày 15). Gỡ từng lớp, e2e phải đỏ.
#
#   bash scripts/verify-fulfillment.sh [tên...]
#
# Mutation ở seller (orders.js) + checkout (outbox write). Restart dịch vụ tương ứng.

set -uo pipefail
export MSYS_NO_PATHCONV=1

COMPOSE="docker compose -f infra/compose.dev.yml"
ORD=apps/seller/src/orders.js
CHK=apps/checkout/src/server.js
BAK="$(mktemp -d)"
pass=0; fail=0
RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'
ok()   { pass=$((pass+1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad()  { fail=$((fail+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; return 0; }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cp "$ORD" "$BAK/orders.js"; cp "$CHK" "$BAK/checkout.js"
restore() { cp "$BAK/orders.js" "$ORD"; cp "$BAK/checkout.js" "$CHK"; }
trap 'restore; rm -rf "$BAK"' EXIT INT TERM

wait_svc() { local s="$1" p="$2"; for _ in $(seq 30); do $COMPOSE exec -T "$s" node -e "fetch('http://127.0.0.1:$p/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
run_e2e() { $COMPOSE exec -T redis redis-cli flushall >/dev/null 2>&1; $COMPOSE exec -T dbtest node apps/worker/test/e2e.mjs >/dev/null 2>&1; }

FILTER="${*:-}"
mutate() {
  local name="$1" svc="$2" port="$3" desc="$4" patch="$5"
  if [ -n "$FILTER" ] && ! grep -qw "$name" <<<"$FILTER"; then return 0; fi
  restore; eval "$patch"
  if diff -q "$BAK/orders.js" "$ORD" >/dev/null && diff -q "$BAK/checkout.js" "$CHK" >/dev/null; then bad "$desc — patch không đổi (anchor sai)"; return; fi
  $COMPOSE restart "$svc" >/dev/null 2>&1; wait_svc "$svc" "$port" || { bad "$desc — $svc không khởi động lại"; restore; $COMPOSE restart "$svc" >/dev/null 2>&1; wait_svc "$svc" "$port"; return; }
  if run_e2e; then bad "$desc → e2e VẪN XANH. Không được bảo vệ."; else ok "$desc → e2e chuyển sang đỏ"; fi
  restore; $COMPOSE restart "$svc" >/dev/null 2>&1; wait_svc "$svc" "$port"
}

sect "0. Trạng thái ban đầu"
$COMPOSE restart seller checkout >/dev/null 2>&1; wait_svc seller 3040; wait_svc checkout 3060
run_e2e && ok "e2e xanh khi mọi lớp còn nguyên" || { bad "e2e đã đỏ từ đầu"; exit 1; }

sect "1. Gỡ từng lớp phòng thủ"

# Không ghi outbox order.created → không có email xác nhận.
mutate outbox checkout 3060 "bỏ ghi outbox order.created (không email)" \
  "sed -i \"s@INSERT INTO outbox (shop_id, topic, payload) VALUES (current_shop_id(), 'order.created', \\\$1)@SELECT 1 WHERE \\\$1 IS NOT NULL@\" $CHK"

# Huỷ không release reserve.
mutate release seller 3040 "bỏ release reserve khi huỷ đơn" \
  "sed -i 's@SET reserved = GREATEST(0, reserved - \$2)@SET reserved = reserved@' $ORD"

# Bỏ kiểm state machine (ship đơn ở trạng thái bất kỳ).
mutate statemachine seller 3040 "bỏ kiểm state machine khi ship" \
  "sed -i \"s@if (o.status !== 'confirmed') return { code: 409, cur: o.status };@if (false) return { code: 409 };@\" $ORD"

# Ship KHÔNG consume on_hand (P0-5) — hàng rời kho mà tồn không giảm → oversell.
# (expire-release do worker lo — không mount src nên không mutate ở đây; e2e §6 tự canh.)
mutate consume seller 3040 "bỏ consume on_hand khi ship" \
  "sed -i 's@const nextOnHand = Math.max(0, lvl.on_hand - ln.qty);@const nextOnHand = lvl.on_hand;@' $ORD"

sect "2. Trạng thái sau khi hoàn nguyên"
restore; $COMPOSE restart seller checkout >/dev/null 2>&1; wait_svc seller 3040; wait_svc checkout 3060
run_e2e && ok "e2e xanh trở lại" || bad "e2e còn đỏ — chưa hoàn nguyên đúng!"

printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
