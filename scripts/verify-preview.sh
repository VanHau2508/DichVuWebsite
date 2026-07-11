#!/usr/bin/env bash
#
# Mutation testing cho XEM TRƯỚC bản draft (mở rộng Ngày 11). Gỡ từng lớp phòng thủ
# của preview, khẳng định preview e2e chuyển đỏ. Hoàn nguyên. Cộng kiểm cấu trúc RLS/
# quyền trên page_previews (cô lập tenant + hết hạn là do RLS lo, không chỉ do query).
#
#   bash scripts/verify-preview.sh [tên...]

set -uo pipefail
export MSYS_NO_PATHCONV=1

COMPOSE="docker compose -f infra/compose.dev.yml"
SRV=apps/storefront/src/server.js
RBAC=apps/seller/src/rbac.js
BAK="$(mktemp -d)"
pass=0; fail=0
RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'
ok()   { pass=$((pass+1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad()  { fail=$((fail+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; return 0; }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cp "$SRV" "$BAK/server.js"; cp "$RBAC" "$BAK/rbac.js"
restore() { cp "$BAK/server.js" "$SRV"; cp "$BAK/rbac.js" "$RBAC"; }
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
  $COMPOSE exec -T dbtest node apps/seller/test/preview.e2e.mjs >/dev/null 2>&1
}

FILTER="${*:-}"
mutate() {
  local name="$1" desc="$2" patch="$3"
  if [ -n "$FILTER" ] && ! grep -qw "$name" <<<"$FILTER"; then return 0; fi
  restore; eval "$patch"
  if diff -q "$BAK/server.js" "$SRV" >/dev/null && diff -q "$BAK/rbac.js" "$RBAC" >/dev/null; then
    bad "$desc — patch không đổi gì (anchor sai)"; return
  fi
  if ! restart; then bad "$desc — dịch vụ không khởi động lại"; restore; restart; return; fi
  if run_e2e; then bad "$desc → e2e VẪN XANH. Không được bảo vệ."; else ok "$desc → e2e chuyển sang đỏ"; fi
  restore; restart
}

sect "0. Trạng thái ban đầu"
restart
run_e2e && ok "preview e2e xanh khi mọi lớp còn nguyên" || { bad "e2e đã đỏ từ đầu"; exit 1; }

sect "1. Gỡ từng lớp phòng thủ preview"

# Token phải ràng với slug của trang — không dùng lại được ở URL khác.
mutate slug "bỏ ràng token với slug" \
  "sed -i 's@token_hash = \\\$1 AND slug = \\\$2 AND expires_at@token_hash = \\\$1 AND expires_at@' $SRV"

# Token lưu dạng HASH — storefront phải hash token trước khi tra.
mutate hash "tra token thô thay vì hash (token lộ ở DB dùng được)" \
  "sed -i 's@\[hashToken(previewToken), gm\[1\]\]@[previewToken, gm[1]]@' $SRV"

# Preview KHÔNG được CDN cache (token trong URL + nội dung chưa xuất bản).
mutate nostore "preview bị cache công khai thay vì no-store" \
  "sed -i \"s@headers\['cache-control'\] = 'no-store';@headers['cache-control'] = CACHE_PUBLIC;@\" $SRV"

# Preview KHÔNG được lập chỉ mục.
mutate noindex "bỏ header noindex trên preview" \
  "sed -i \"s@headers\['x-robots-tag'\] = 'noindex, nofollow';@@\" $SRV"

# RBAC: chỉ content.read mới cấp được link preview.
mutate rbac "cấp nhầm content.read cho catalog_manager" \
  "sed -i \"s@catalog_manager: new Set(\\['catalog.read', 'catalog.write'\\])@catalog_manager: new Set(['catalog.read', 'catalog.write', 'content.read'])@\" $RBAC"

sect "2. Trạng thái sau khi hoàn nguyên"
restore; restart
run_e2e && ok "preview e2e xanh trở lại" || bad "e2e còn đỏ — chưa hoàn nguyên đúng!"

sect "3. Cấu trúc RLS/quyền trên page_previews"
q() { $COMPOSE exec -T postgres psql -U app_owner -d app -tAc "$1" | tr -d '[:space:]'; }
[ "$(q "SELECT relforcerowsecurity FROM pg_class WHERE relname='page_previews'")" = "t" ] && ok "page_previews FORCE RLS" || bad "page_previews không FORCE RLS"
[ "$(q "SELECT has_table_privilege('app_store','page_previews','SELECT')")" = "t" ] && ok "app_store có SELECT" || bad "app_store thiếu SELECT"
[ "$(q "SELECT has_table_privilege('app_store','page_previews','INSERT')")" = "f" ] && ok "app_store KHÔNG INSERT (chỉ đọc)" || bad "app_store ghi được page_previews"
[ "$(q "SELECT has_table_privilege('app_store','page_previews','UPDATE')")" = "f" ] && ok "app_store KHÔNG UPDATE" || bad "app_store UPDATE được page_previews"
[ "$(q "SELECT has_table_privilege('app_store','page_previews','DELETE')")" = "f" ] && ok "app_store KHÔNG DELETE" || bad "app_store DELETE được page_previews"
[ "$(q "SELECT count(*) FROM pg_policies WHERE tablename='page_previews' AND policyname='store_preview'")" = "1" ] && ok "policy store_preview tồn tại" || bad "thiếu policy store_preview"
# Siết cột (0018): app_store KHÔNG đọc được cột draft của pages — nền tảng của cả preview.
[ "$(q "SELECT has_column_privilege('app_store','pages','blocks','SELECT')")" = "f" ] && ok "app_store KHÔNG đọc được pages.blocks (draft)" || bad "app_store đọc được pages.blocks (draft)"
[ "$(q "SELECT has_column_privilege('app_store','pages','title','SELECT')")" = "f" ] && ok "app_store KHÔNG đọc được pages.title (draft)" || bad "app_store đọc được pages.title (draft)"

printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
