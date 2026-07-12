#!/usr/bin/env bash
#
# Smoke test ROUTING QUA EDGE (Caddy) — không gọi service nội bộ.
#
#   docker compose -f infra/compose.dev.yml up -d --build
#   bash scripts/smoke-edge.sh
#
# Đóng lỗ P0-1: E2E trước đây gọi thẳng service (SELLER_URL...), KHÔNG chứng minh
# request thật đi qua Caddy tới đúng service. Ở đây MỌI request đi qua Caddy (SNI +
# CA nội bộ), khẳng định từng route tới ĐÚNG upstream — và webhook thanh toán (host
# hooks) tới payment, KHÔNG rò sang admin.
#
# Mọi curl chạy trong container `toolbox` (Linux, tôn trọng --cacert) — xem lý do ở
# scripts/smoke-tls.sh. Dùng host cố định cert nội bộ để không cần dựng shop/on-demand.

set -uo pipefail
export MSYS_NO_PATHCONV=1

COMPOSE="docker compose -f infra/compose.dev.yml"
CA=/caddy-data/caddy/pki/authorities/local/root.crt

pass=0; fail=0
RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'
ok()   { pass=$((pass+1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad()  { fail=$((fail+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; [ $# -gt 1 ] && printf '       %s%s%s\n' "$DIM" "$2" "$RST"; return 0; }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# curl qua Caddy: --connect-to giữ SNI = host nhưng nối TCP tới container caddy.
ci()   { $COMPOSE exec -T toolbox curl -sS --max-time 10 --connect-to "$1:443:caddy:443" --cacert "$CA" "${@:3}" "https://$1$2"; }
code() { ci "$1" "$2" "${@:3}" -o /dev/null -w '%{http_code}'; }

# Đảm bảo toolbox + caddy sẵn sàng.
$COMPOSE up -d toolbox >/dev/null 2>&1
for _ in $(seq 30); do $COMPOSE exec -T caddy wget -qO- http://127.0.0.1:2019/config/ >/dev/null 2>&1 && break; sleep 1; done

sect "1. Webhook thanh toán qua edge (hooks → payment)"
c=$(code hooks.localtest /webhooks/sepay -X POST -H 'authorization: Apikey sai-key' -H 'content-type: application/json' -d '{}')
[ "$c" = "401" ] && ok "hooks/webhooks/sepay (sai key) → 401 = TỚI payment (không phải 404 route thiếu)" \
                 || bad "webhook không tới payment qua edge" "http=$c (mong 401)"

# Cô lập: host admin KHÔNG được route /webhooks sang payment.
c=$(code admin.localtest /webhooks/sepay -X POST -H 'content-type: application/json' -d '{}')
[ "$c" = "403" ] && ok "admin/webhooks/sepay → 403 (seller-admin CSRF, KHÔNG rò sang payment 401)" \
                 || bad "webhook rò qua host admin?" "http=$c (mong 403 của seller-admin)"

sect "2. Admin qua edge (admin → seller-admin)"
c=$(code admin.localtest /login)
b=$(ci admin.localtest /login)
{ [ "$c" = "200" ] && grep -q 'Đăng nhập quản trị' <<<"$b"; } \
  && ok "admin/login → 200 + trang đăng nhập của seller-admin" \
  || bad "admin không tới seller-admin qua edge" "http=$c"

sect "3. Storefront + checkout qua edge (tách /cart)"
b=$(ci shop.localtest /healthz)
grep -q '"ok":true' <<<"$b" && ok 'shop.localtest/ (healthz) → storefront ({"ok":true})' \
                            || bad "không tới storefront qua edge" "$b"

b=$(ci shop.localtest /cart -H 'accept: application/json')
grep -q 'tên miền chưa kết nối' <<<"$b" && ok 'shop.localtest/cart → checkout (tách /cart đúng service)' \
                                        || bad "/cart không tới checkout qua edge" "$b"

sect "4. Auth qua edge"
c=$(code auth.localtest /healthz)
[ "$c" = "200" ] && ok "auth.localtest/healthz → 200 = tới auth" || bad "auth không tới qua edge" "http=$c"

printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
