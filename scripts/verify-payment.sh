#!/usr/bin/env bash
#
# Mutation testing cho thanh toán QR (Ngày 14). Gỡ từng lớp phòng thủ webhook,
# khẳng định e2e chuyển đỏ. Hoàn nguyên.
#
#   bash scripts/verify-payment.sh [tên...]

set -uo pipefail
export MSYS_NO_PATHCONV=1

COMPOSE="docker compose -f infra/compose.dev.yml"
SRV=apps/payment/src/server.js
BAK="$(mktemp -d)"
pass=0; fail=0
RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'
ok()   { pass=$((pass+1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad()  { fail=$((fail+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; return 0; }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cp "$SRV" "$BAK/server.js"
restore() { cp "$BAK/server.js" "$SRV"; }
trap 'restore; rm -rf "$BAK"' EXIT INT TERM

wait_pay() {
  for _ in $(seq 30); do
    if $COMPOSE exec -T payment node -e "fetch('http://127.0.0.1:3070/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
restart() { $COMPOSE restart payment >/dev/null 2>&1; wait_pay; }
run_e2e() {
  $COMPOSE exec -T redis redis-cli flushall >/dev/null 2>&1
  $COMPOSE exec -T dbtest node apps/payment/test/e2e.mjs >/dev/null 2>&1
}

FILTER="${*:-}"
mutate() {
  local name="$1" desc="$2" patch="$3"
  if [ -n "$FILTER" ] && ! grep -qw "$name" <<<"$FILTER"; then return 0; fi
  restore; eval "$patch"
  if diff -q "$BAK/server.js" "$SRV" >/dev/null; then bad "$desc — patch không đổi gì (anchor sai)"; return; fi
  if ! restart; then bad "$desc — payment không khởi động lại"; restore; restart; return; fi
  if run_e2e; then bad "$desc → e2e VẪN XANH. Không được bảo vệ."; else ok "$desc → e2e chuyển sang đỏ"; fi
  restore; restart
}

sect "0. Trạng thái ban đầu"
restart
run_e2e && ok "payment e2e xanh khi mọi lớp còn nguyên" || { bad "e2e đã đỏ từ đầu"; exit 1; }

sect "1. Gỡ từng lớp phòng thủ webhook"

# Bỏ xác thực API key → webhook sai key vẫn xử lý (đơn được paid).
mutate apikey "bỏ xác thực API key webhook" \
  "sed -i 's|if (!timingSafeEq(req.headers\[.authorization.\] ?? .., \`Apikey \${SEPAY_KEY}\`)) {|if (false) {|' $SRV"

# Bỏ đối chiếu số tiền → thiếu tiền vẫn paid.
mutate amount "bỏ đối chiếu số tiền (thiếu tiền vẫn paid)" \
  "sed -i 's|const enough = amount >= Number(order.total_vnd);|const enough = true;|' $SRV"

# Bỏ chống replay → xử lý lại giao dịch trùng (nhiều dòng sổ).
mutate replay "bỏ chống replay (ON CONFLICT DO NOTHING → DO UPDATE)" \
  "sed -i 's|ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id|ON CONFLICT (provider, provider_event_id) DO UPDATE SET amount_vnd=EXCLUDED.amount_vnd RETURNING id|' $SRV"

# Bỏ ràng buộc tài khoản nhận → "đánh dấu hộ" đơn shop khác (lỗ hổng rà soát Ngày 14).
mutate account "bỏ đối chiếu tài khoản nhận" \
  "sed -i 's@if (!want || rcvAccount !== want) {@if (false) {@' $SRV"

sect "2. Trạng thái sau khi hoàn nguyên"
restore; restart
run_e2e && ok "payment e2e xanh trở lại" || bad "e2e còn đỏ — chưa hoàn nguyên đúng!"

printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
