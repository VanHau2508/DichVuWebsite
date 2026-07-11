#!/usr/bin/env bash
#
# Mutation testing cho thao tác SECTION / kéo–thả (mở rộng Ngày 11). Gỡ từng lớp
# phòng thủ, khẳng định blocks e2e chuyển đỏ. Hoàn nguyên.
#
#   bash scripts/verify-blocks.sh [tên...]

set -uo pipefail
export MSYS_NO_PATHCONV=1

COMPOSE="docker compose -f infra/compose.dev.yml"
CNT=apps/seller/src/content.js
THM=apps/storefront/src/theme.js
BAK="$(mktemp -d)"
pass=0; fail=0
RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'
ok()   { pass=$((pass+1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad()  { fail=$((fail+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; return 0; }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cp "$CNT" "$BAK/content.js"; cp "$THM" "$BAK/theme.js"
restore() { cp "$BAK/content.js" "$CNT"; cp "$BAK/theme.js" "$THM"; }
trap 'restore; rm -rf "$BAK"' EXIT INT TERM

wait_svc() {
  local svc="$1" port="$2"
  for _ in $(seq 30); do
    if $COMPOSE exec -T "$svc" node -e "fetch('http://127.0.0.1:$port/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
restart() { $COMPOSE restart seller storefront >/dev/null 2>&1; wait_svc seller 3040 && wait_svc storefront 3050; }
run_e2e() {
  $COMPOSE exec -T redis redis-cli flushall >/dev/null 2>&1
  $COMPOSE exec -T dbtest node apps/seller/test/blocks.e2e.mjs >/dev/null 2>&1
}

FILTER="${*:-}"
mutate() {
  local name="$1" desc="$2" patch="$3"
  if [ -n "$FILTER" ] && ! grep -qw "$name" <<<"$FILTER"; then return 0; fi
  restore; eval "$patch"
  if diff -q "$BAK/content.js" "$CNT" >/dev/null && diff -q "$BAK/theme.js" "$THM" >/dev/null; then
    bad "$desc — patch không đổi gì (anchor sai)"; return
  fi
  if ! restart; then bad "$desc — dịch vụ không khởi động lại"; restore; restart; return; fi
  if run_e2e; then bad "$desc → e2e VẪN XANH. Không được bảo vệ."; else ok "$desc → e2e chuyển sang đỏ"; fi
  restore; restart
}

sect "0. Trạng thái ban đầu"
restart
run_e2e && ok "blocks e2e xanh khi mọi lớp còn nguyên" || { bad "e2e đã đỏ từ đầu"; exit 1; }

sect "1. Gỡ từng lớp phòng thủ"

# reorder phải là HOÁN VỊ đúng: bỏ kiểm "id thuộc trang" → chèn id lạ lọt qua.
mutate reorder "bỏ kiểm id-thuộc-trang trong reorder" \
  "sed -i 's@order.some((id) => !byId.has(id))@false@' $CNT"

# Section mới (list) phải escape item → chống XSS.
mutate escape "bỏ escape item của list" \
  "sed -i 's@<li>\${esc(i)}</li>@<li>\${i}</li>@' $THM"

sect "2. Trạng thái sau khi hoàn nguyên"
restore; restart
run_e2e && ok "blocks e2e xanh trở lại" || bad "e2e còn đỏ — chưa hoàn nguyên đúng!"

printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
