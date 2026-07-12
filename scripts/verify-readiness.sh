#!/usr/bin/env bash
#
# Gate readiness/liveness (A2, kiểu mutation): DỪNG Postgres →
#   - /livez  vẫn 200 (liveness KHÔNG phụ thuộc DB → không bị restart oan khi DB chớp)
#   - /readyz → 503 với service có backing store (rút khỏi load balancer)
# rồi KHỞI ĐỘNG lại Postgres → /readyz 200 trở lại.
#
# seller-admin là BFF không sở hữu DB → /readyz luôn 200 (readiness = liveness). Đúng ý đồ.
#
#   bash scripts/verify-readiness.sh

set -uo pipefail
export MSYS_NO_PATHCONV=1
COMPOSE="docker compose -f infra/compose.dev.yml"
pass=0; fail=0
RED=$'\033[31m'; GREEN=$'\033[32m'; RST=$'\033[0m'
ok()  { pass=$((pass+1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad() { fail=$((fail+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; }
sect(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

# service:port — service có DB (readyz phải 503 khi DB sập)
DB_SVCS="auth:3020 platform:3030 seller:3040 checkout:3060 payment:3070 worker:3080 storefront:3050 tls-authorize:3010"

code() {
  $COMPOSE exec -T "$1" node -e "
    const t=setTimeout(()=>{console.log('TIMEOUT');process.exit(0)},6000);
    fetch('http://127.0.0.1:$2$3').then(r=>{clearTimeout(t);console.log(r.status);process.exit(0)}).catch(()=>{clearTimeout(t);console.log('ERR');process.exit(0)})" 2>/dev/null | tr -d '\r'
}

restore_pg() { $COMPOSE start postgres >/dev/null 2>&1; for _ in $(seq 30); do $COMPOSE exec -T postgres pg_isready -U app_owner -d app >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
trap 'restore_pg' EXIT INT TERM

sect "0. Khoẻ: /readyz = 200"
for sp in $DB_SVCS; do c=$(code "${sp%%:*}" "${sp##*:}" /readyz); [ "$c" = 200 ] && ok "${sp%%:*} /readyz 200" || bad "${sp%%:*} /readyz $c"; done

sect "1. DỪNG Postgres → /livez 200, /readyz 503"
$COMPOSE stop postgres >/dev/null 2>&1
sleep 2
for sp in $DB_SVCS; do
  svc="${sp%%:*}"; port="${sp##*:}"
  l=$(code "$svc" "$port" /livez); r=$(code "$svc" "$port" /readyz)
  [ "$l" = 200 ] && ok "$svc /livez 200 (sống dù DB sập)" || bad "$svc /livez $l (mong 200)"
  [ "$r" = 503 ] && ok "$svc /readyz 503 (rút khỏi LB)" || bad "$svc /readyz $r (mong 503)"
done
# BFF không có DB → readyz vẫn 200.
sa=$(code seller-admin 3001 /readyz); [ "$sa" = 200 ] && ok "seller-admin /readyz 200 (BFF không sở hữu DB)" || bad "seller-admin /readyz $sa"

sect "2. KHỞI ĐỘNG lại Postgres → /readyz 200"
restore_pg && ok "postgres sẵn sàng lại" || bad "postgres không lên lại"
sleep 2
for sp in $DB_SVCS; do c=$(code "${sp%%:*}" "${sp##*:}" /readyz); [ "$c" = 200 ] && ok "${sp%%:*} /readyz 200 trở lại" || bad "${sp%%:*} /readyz $c"; done

printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
