#!/usr/bin/env bash
#
# Mutation testing cho trang nội dung/chính sách (Ngày 11). Gỡ từng lớp phòng thủ,
# khẳng định content e2e chuyển đỏ. Hoàn nguyên. Cũng khẳng định page_revisions là
# append-only ở tầng quyền DB (app_rw không có UPDATE/DELETE).
#
#   bash scripts/verify-content.sh [tên...]

set -uo pipefail
export MSYS_NO_PATHCONV=1

COMPOSE="docker compose -f infra/compose.dev.yml"
CNT=apps/seller/src/content.js
RBAC=apps/seller/src/rbac.js
SRV=apps/storefront/src/server.js
THM=apps/storefront/src/theme.js
BAK="$(mktemp -d)"
pass=0; fail=0
RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'
ok()   { pass=$((pass+1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad()  { fail=$((fail+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; return 0; }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cp "$CNT" "$BAK/content.js"; cp "$RBAC" "$BAK/rbac.js"
cp "$SRV" "$BAK/server.js"; cp "$THM" "$BAK/theme.js"
restore() { cp "$BAK/content.js" "$CNT"; cp "$BAK/rbac.js" "$RBAC"; cp "$BAK/server.js" "$SRV"; cp "$BAK/theme.js" "$THM"; }
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
  $COMPOSE exec -T dbtest node apps/seller/test/content.e2e.mjs >/dev/null 2>&1
}

FILTER="${*:-}"
mutate() {
  local name="$1" desc="$2" patch="$3"
  if [ -n "$FILTER" ] && ! grep -qw "$name" <<<"$FILTER"; then return 0; fi
  restore; eval "$patch"
  if diff -q "$BAK/content.js" "$CNT" >/dev/null && diff -q "$BAK/rbac.js" "$RBAC" >/dev/null \
     && diff -q "$BAK/server.js" "$SRV" >/dev/null && diff -q "$BAK/theme.js" "$THM" >/dev/null; then
    bad "$desc — patch không đổi gì (anchor sai)"; return
  fi
  if ! restart; then bad "$desc — dịch vụ không khởi động lại"; restore; restart; return; fi
  if run_e2e; then bad "$desc → e2e VẪN XANH. Không được bảo vệ."; else ok "$desc → e2e chuyển sang đỏ"; fi
  restore; restart
}

sect "0. Trạng thái ban đầu"
restart
run_e2e && ok "content e2e xanh khi mọi lớp còn nguyên" || { bad "e2e đã đỏ từ đầu"; exit 1; }

sect "1. Gỡ từng lớp phòng thủ nội dung"

# Storefront đọc bản PUBLISHED (page_revisions), KHÔNG phải draft (pages.blocks).
mutate published "storefront đọc DRAFT thay vì bản published" \
  "sed -i 's@SELECT pr.title, pr.blocks@SELECT p.title, p.blocks@' $SRV"

# Block nội dung phải được escape (chống XSS).
mutate escape "bỏ escape text block (XSS)" \
  "sed -i 's@paragraph: (b) => \`<p>\${esc(b.text)}</p>\`@paragraph: (b) => \`<p>\${b.text}</p>\`@' $THM"

# Rollback CHỈ trỏ published, KHÔNG được ghi đè draft.
mutate rollback "rollback ghi đè luôn draft (mất bản đang sửa)" \
  "sed -i \"s@SET published_revision_id = \\\$1, status = 'published', updated_at = now() WHERE id = \\\$2@SET published_revision_id = \\\$1, status = 'published', blocks = (SELECT blocks FROM page_revisions WHERE id = \\\$1), updated_at = now() WHERE id = \\\$2@\" $CNT"

# RBAC: catalog_manager KHÔNG được đụng nội dung (thiếu content.read/write).
mutate rbac "cấp nhầm quyền nội dung cho catalog_manager" \
  "sed -i \"s@catalog_manager: new Set(\\['catalog.read', 'catalog.write'\\])@catalog_manager: new Set(['catalog.read', 'catalog.write', 'content.read', 'content.write'])@\" $RBAC"

sect "2. Trạng thái sau khi hoàn nguyên"
restore; restart
run_e2e && ok "content e2e xanh trở lại" || bad "e2e còn đỏ — chưa hoàn nguyên đúng!"

sect "3. Append-only ở tầng quyền DB (page_revisions)"
priv() { $COMPOSE exec -T postgres psql -U app_owner -d app -tAc "SELECT has_table_privilege('app_rw','page_revisions','$1')"; }
[ "$(priv UPDATE | tr -d '[:space:]')" = "f" ] && ok "app_rw KHÔNG có UPDATE trên page_revisions" || bad "app_rw vẫn UPDATE được page_revisions"
[ "$(priv DELETE | tr -d '[:space:]')" = "f" ] && ok "app_rw KHÔNG có DELETE trên page_revisions" || bad "app_rw vẫn DELETE được page_revisions"
[ "$(priv INSERT | tr -d '[:space:]')" = "t" ] && ok "app_rw có INSERT (ghi revision mới khi publish)" || bad "app_rw không INSERT được page_revisions"

printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
