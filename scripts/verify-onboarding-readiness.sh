#!/usr/bin/env bash
# Mutation checks for connector-aware onboarding readiness and onboarding email retry.
# Every mutation must turn the real E2E red; source files are restored on every exit path.
set -uo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
COMPOSE="docker compose -f infra/compose.dev.yml"
SELLER="apps/seller/src/readiness.js"
NOTIFY="apps/seller/src/notification-deliveries.js"
BAK="$(mktemp -d)"
pass=0
fail=0
GREEN=$'\033[32m'; RED=$'\033[31m'; RST=$'\033[0m'

ok() { pass=$((pass + 1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad() { fail=$((fail + 1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; }

cp "$SELLER" "$BAK/readiness.js"
cp "$NOTIFY" "$BAK/notification-deliveries.js"

restore() {
  cp "$BAK/readiness.js" "$SELLER"
  cp "$BAK/notification-deliveries.js" "$NOTIFY"
}
cleanup() {
  restore
  rm -rf "$BAK"
}
trap cleanup EXIT INT TERM

wait_svc() {
  local svc="$1" port="$2"
  for _ in $(seq 30); do
    if $COMPOSE exec -T "$svc" node -e "fetch('http://127.0.0.1:$port/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

restart_seller() {
  $COMPOSE restart seller >/dev/null 2>&1
  wait_svc seller 3040
}

clear_rl() {
  $COMPOSE exec -T redis sh -c "redis-cli --scan --pattern 'rl:*' | xargs -r -n 400 redis-cli del" >/dev/null 2>&1 || true
}

run_readiness() {
  clear_rl
  $COMPOSE exec -T dbtest node apps/seller/test/readiness.e2e.mjs >/dev/null 2>&1
}

run_notification() {
  clear_rl
  $COMPOSE exec -T dbtest node apps/seller-admin/test/admin-su-co.e2e.mjs >/dev/null 2>&1
}

mutate() {
  local name="$1" target="$2" description="$3" patch="$4" runner="$5"
  restore
  eval "$patch"
  if diff -q "$BAK/$target" "$([ "$target" = readiness.js ] && echo "$SELLER" || echo "$NOTIFY")" >/dev/null 2>&1; then
    bad "$description — patch không đổi gì (anchor sai)"
    return
  fi
  if ! restart_seller; then
    bad "$description — seller không khởi động lại"
    return
  fi
  if "$runner"; then
    bad "$description → E2E vẫn xanh; chốt không được bảo vệ"
  else
    ok "$description → E2E chuyển đỏ"
  fi
}

printf '\n\033[1m0. Trạng thái ban đầu\033[0m\n'
restore
restart_seller || { bad 'seller không khởi động được'; exit 1; }
run_readiness && ok 'readiness E2E xanh khi chốt còn nguyên' || { bad 'readiness E2E đã đỏ từ đầu'; exit 1; }
run_notification && ok 'notification E2E xanh khi chốt còn nguyên' || { bad 'notification E2E đã đỏ từ đầu'; exit 1; }

printf '\n\033[1m1. Gỡ từng chốt\033[0m\n'
mutate connector-ready readiness.js 'bỏ kiểm connector active/mapping/fresh trong readiness' \
  "sed -i 's/const connectorReady = !integration || (integration.status === '\''active'\'' && !!externalSample);/const connectorReady = true;/' $SELLER" \
  run_readiness

mutate freshness readiness.js 'nới freshness tồn connector từ 5 phút thành 5 ngày' \
  "sed -i \"s#AND r.inventory_synced_at > now() - (\\\$3 || ' minutes')::interval#AND r.inventory_synced_at > now() - interval '5 days'#\" $SELLER" \
  run_readiness

mutate onboarding-nudge notification-deliveries.js 'bỏ shop.onboarding_nudge khỏi allowlist retry' \
  "sed -i \"s/, 'shop.onboarding_nudge'//\" $NOTIFY" \
  run_notification

restore
restart_seller
run_readiness && run_notification && ok 'E2E xanh trở lại sau khi hoàn nguyên' || bad 'E2E còn đỏ sau khi hoàn nguyên'

printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
