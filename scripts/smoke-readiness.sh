#!/usr/bin/env bash
#
# Smoke readiness/liveness (A2). Mỗi service phải:
#   - /livez  → 200 (tiến trình sống, KHÔNG phụ thuộc)
#   - /readyz → 200 khi mọi phụ thuộc (DB/Redis) gọi được
#   - /healthz → 200 (giữ tương thích healthcheck compose/Caddy)
#
# Đường /readyz → 503 khi DB sập được kiểm ở verify-readiness.sh (dừng postgres ảnh
# hưởng cả stack nên không đưa vào smoke luôn-chạy).
#
#   bash scripts/smoke-readiness.sh

set -uo pipefail
export MSYS_NO_PATHCONV=1
COMPOSE="docker compose -f infra/compose.dev.yml"
pass=0; fail=0
RED=$'\033[31m'; GREEN=$'\033[32m'; RST=$'\033[0m'
ok()  { pass=$((pass+1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad() { fail=$((fail+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; }

# service:port (cổng NỘI BỘ của service)
SVCS="auth:3020 platform:3030 seller:3040 checkout:3060 payment:3070 worker:3080 storefront:3050 tls-authorize:3010 seller-admin:3001"

# Gọi trong chính container service (127.0.0.1) — không phụ thuộc mạng ngoài.
code() {
  $COMPOSE exec -T "$1" node -e "
    const t=setTimeout(()=>{console.log('TIMEOUT');process.exit(0)},5000);
    fetch('http://127.0.0.1:$2$3').then(r=>{clearTimeout(t);console.log(r.status);process.exit(0)}).catch(()=>{clearTimeout(t);console.log('ERR');process.exit(0)})" 2>/dev/null | tr -d '\r'
}

printf '\033[1mSmoke readiness/liveness (9 service)\033[0m\n'
for sp in $SVCS; do
  svc="${sp%%:*}"; port="${sp##*:}"
  for p in /livez /readyz /healthz; do
    c=$(code "$svc" "$port" "$p")
    [ "$c" = "200" ] && ok "$svc $p → 200" || bad "$svc $p → $c (mong 200)"
  done
done

printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
