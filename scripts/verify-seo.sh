#!/usr/bin/env bash
#
# Mutation testing cho SEO meta theo trang (mở rộng Ngày 11). Gỡ escape trong thẻ meta,
# khẳng định seo e2e chuyển đỏ (attribute injection). Cộng kiểm cấu trúc: app_store KHÔNG
# đọc được cột SEO của bản DRAFT (pages), CHỈ đọc SEO đã published (page_revisions/previews).
#
#   bash scripts/verify-seo.sh [tên...]

set -uo pipefail
export MSYS_NO_PATHCONV=1

COMPOSE="docker compose -f infra/compose.dev.yml"
THM=apps/storefront/src/theme.js
BAK="$(mktemp -d)"
pass=0; fail=0
RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'
ok()   { pass=$((pass+1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad()  { fail=$((fail+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; return 0; }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cp "$THM" "$BAK/theme.js"
restore() { cp "$BAK/theme.js" "$THM"; }
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
  $COMPOSE exec -T dbtest node apps/seller/test/seo.e2e.mjs >/dev/null 2>&1
}

FILTER="${*:-}"
mutate() {
  local name="$1" desc="$2" patch="$3"
  if [ -n "$FILTER" ] && ! grep -qw "$name" <<<"$FILTER"; then return 0; fi
  restore; eval "$patch"
  if diff -q "$BAK/theme.js" "$THM" >/dev/null; then bad "$desc — patch không đổi gì (anchor sai)"; return; fi
  if ! restart; then bad "$desc — storefront không khởi động lại"; restore; restart; return; fi
  if run_e2e; then bad "$desc → e2e VẪN XANH. Không được bảo vệ."; else ok "$desc → e2e chuyển sang đỏ"; fi
  restore; restart
}

sect "0. Trạng thái ban đầu"
restart
run_e2e && ok "seo e2e xanh khi mọi lớp còn nguyên" || { bad "e2e đã đỏ từ đầu"; exit 1; }

sect "1. Gỡ escape trong thẻ meta SEO"

# meta description phải escape (chống breakout thuộc tính content="...").
mutate desc "bỏ escape seo_description trong meta" \
  "sed -i 's@<meta name=\"description\" content=\"\${esc(description)}\">@<meta name=\"description\" content=\"\${description}\">@' $THM"

# <title> phải escape (chống breakout </title>).
mutate title "bỏ escape tiêu đề trong <title>" \
  "sed -i 's@<title>\${esc(title)}</title>@<title>\${title}</title>@' $THM"

sect "2. Trạng thái sau khi hoàn nguyên"
restore; restart
run_e2e && ok "seo e2e xanh trở lại" || bad "e2e còn đỏ — chưa hoàn nguyên đúng!"

sect "3. app_store chỉ đọc SEO đã published, KHÔNG đọc SEO draft"
q() { $COMPOSE exec -T postgres psql -U app_owner -d app -tAc "$1" | tr -d '[:space:]'; }
[ "$(q "SELECT has_column_privilege('app_store','pages','seo_title','SELECT')")" = "f" ] && ok "app_store KHÔNG đọc pages.seo_title (draft)" || bad "app_store đọc được seo_title draft"
[ "$(q "SELECT has_column_privilege('app_store','pages','seo_description','SELECT')")" = "f" ] && ok "app_store KHÔNG đọc pages.seo_description (draft)" || bad "app_store đọc được seo_description draft"
[ "$(q "SELECT has_column_privilege('app_store','page_revisions','seo_title','SELECT')")" = "t" ] && ok "app_store ĐỌC được page_revisions.seo_title (published)" || bad "app_store không đọc được seo published"
[ "$(q "SELECT has_column_privilege('app_store','page_previews','seo_title','SELECT')")" = "t" ] && ok "app_store ĐỌC được page_previews.seo_title (preview)" || bad "app_store không đọc được seo preview"

printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
