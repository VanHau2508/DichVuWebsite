#!/usr/bin/env bash
#
# Diễn tập BACKUP → RESTORE vào môi trường MỚI (Ngày 19, tiêu chí go-live #6).
#   bash scripts/backup-restore-drill.sh
#
# "Backup chưa restore thử không phải là backup." Kịch bản thật:
#   1. Dump toàn cluster (roles + schema + data) từ postgres đang chạy.
#   2. Dựng một postgres MỚI, TRỐNG (mô phỏng máy khác sau thảm hoạ).
#   3. Restore dump vào đó.
#   4. KIỂM CHỨNG: dữ liệu còn nguyên, roles còn, RLS còn FORCE, cô lập tenant còn.
#
# Đây là bằng chứng khôi phục được, không chỉ "có file backup".

set -uo pipefail
export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

COMPOSE="docker compose -f infra/compose.dev.yml"
TMP="$(mktemp -d)"
FRESH="nentang-restore-drill"
pass=0; fail=0
RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'
ok()   { pass=$((pass+1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad()  { fail=$((fail+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; [ $# -gt 1 ] && printf '       %s%s%s\n' "$DIM" "$2" "$RST"; return 0; }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }
cleanup() { docker rm -f "$FRESH" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

# Query tiện ích
q_main()  { $COMPOSE exec -T postgres psql -U app_owner -d app -tAc "$1" 2>/dev/null | tr -d '\r'; }
q_fresh() { docker exec "$FRESH" psql -U postgres -d app -tAc "$1" 2>/dev/null | tr -d '\r'; }

sect "0. Điều kiện"
$COMPOSE ps --status running --quiet postgres | grep -q . || { echo "postgres chưa chạy: $COMPOSE up -d" >&2; exit 1; }
SHOPS0="$(q_main 'SELECT count(*) FROM shops')"
ORDERS0="$(q_main 'SELECT count(*) FROM orders')"
POLICIES0="$(q_main 'SELECT count(*) FROM pg_policies')"
ROLES0="$(q_main "SELECT string_agg(rolname,',' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'app\_%'")"
echo "  nguồn: $SHOPS0 shops, $ORDERS0 orders, $POLICIES0 policies, roles=[$ROLES0]"
[ "$SHOPS0" -ge 1 ] 2>/dev/null && ok "DB nguồn có dữ liệu để backup" || { bad "DB nguồn trống — chạy vài e2e trước"; exit 1; }

# ── 1. Backup ─────────────────────────────────────────────────────────────────
sect "1. Backup (pg_dumpall: roles + schema + data)"
if $COMPOSE exec -T postgres pg_dumpall -U app_owner > "$TMP/full.sql" 2>/dev/null && [ -s "$TMP/full.sql" ]; then
  ok "dump toàn cluster ($(wc -c < "$TMP/full.sql" | tr -d ' ') byte)"
else
  bad "pg_dumpall thất bại"; exit 1
fi

# ── 2. Môi trường MỚI, trống ─────────────────────────────────────────────────
sect "2. Dựng postgres MỚI (mô phỏng máy khác sau thảm hoạ)"
docker rm -f "$FRESH" >/dev/null 2>&1 || true
docker run -d --name "$FRESH" -e POSTGRES_PASSWORD=x -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine >/dev/null
for _ in $(seq 30); do docker exec "$FRESH" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
docker exec "$FRESH" pg_isready -U postgres >/dev/null 2>&1 && ok "postgres mới sẵn sàng (chưa có dữ liệu)" || { bad "postgres mới không lên"; exit 1; }

# ── 3. Restore ────────────────────────────────────────────────────────────────
sect "3. Restore vào postgres mới"
# Pipe dump qua stdin (tránh docker cp vì đường dẫn MSYS bị mangle).
# Bỏ qua lỗi "role postgres already exists" (role bootstrap); phần còn lại phải chạy.
docker exec -i "$FRESH" psql -U postgres -q >"$TMP/restore.log" 2>&1 < "$TMP/full.sql" || true
[ "$(q_fresh 'SELECT 1')" = "1" ] && ok "restore chạy xong (bỏ qua role-exists vô hại)" || bad "restore hỏng" "$(tail -3 "$TMP/restore.log")"

# ── 4. Kiểm chứng: dữ liệu + roles + RLS + cô lập ────────────────────────────
sect "4. Kiểm chứng sau khôi phục"
SHOPS1="$(q_fresh 'SELECT count(*) FROM shops')"
ORDERS1="$(q_fresh 'SELECT count(*) FROM orders')"
POLICIES1="$(q_fresh 'SELECT count(*) FROM pg_policies')"
ROLES1="$(q_fresh "SELECT string_agg(rolname,',' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'app\_%'")"

[ "$SHOPS1" = "$SHOPS0" ] && ok "shops khớp ($SHOPS1)" || bad "shops lệch: nguồn $SHOPS0 → khôi phục $SHOPS1"
[ "$ORDERS1" = "$ORDERS0" ] && ok "orders khớp ($ORDERS1)" || bad "orders lệch: $ORDERS0 → $ORDERS1"
[ "$POLICIES1" = "$POLICIES0" ] && ok "RLS policies khớp ($POLICIES1)" || bad "policies lệch: $POLICIES0 → $POLICIES1"
[ "$ROLES1" = "$ROLES0" ] && ok "vai trò DB khớp [$ROLES1]" || bad "roles lệch: [$ROLES0] → [$ROLES1]"

# FORCE RLS còn nguyên trên bảng nghiệp vụ?
FORCED="$(q_fresh "SELECT count(*) FROM pg_class WHERE relname IN ('products','orders','order_lines','memberships') AND relrowsecurity AND relforcerowsecurity")"
[ "$FORCED" = "4" ] && ok "FORCE RLS còn trên products/orders/order_lines/memberships" || bad "FORCE RLS mất sau restore ($FORCED/4)"

# app_rw KHÔNG có BYPASSRLS (cô lập tenant còn hiệu lực)?
BYPASS="$(q_fresh "SELECT rolbypassrls FROM pg_roles WHERE rolname='app_rw'")"
[ "$BYPASS" = "f" ] && ok "app_rw vẫn NOBYPASSRLS (cô lập tenant còn)" || bad "app_rw có BYPASSRLS sau restore"

# Cô lập tenant thực tế: đặt context shop A, không thấy sản phẩm shop khác.
ISO="$(docker exec "$FRESH" psql -U app_rw -d app -tAc "
  BEGIN;
  SELECT set_config('app.shop_id', (SELECT id::text FROM shops ORDER BY created_at LIMIT 1), true);
  SELECT count(DISTINCT shop_id) FROM products;
  ROLLBACK;" 2>/dev/null | tr -d '\r' | grep -E '^[0-9]+$' | tail -1)"
[ "${ISO:-9}" -le 1 ] 2>/dev/null && ok "cô lập tenant HOẠT ĐỘNG trên DB khôi phục (app_rw chỉ thấy 1 shop)" || bad "cô lập tenant hỏng sau restore (thấy $ISO shop)"

printf '\n\033[1m%d pass, %d fail%s\n' "$pass" "$fail" "$RST"
[ "$fail" -eq 0 ] && printf '%sBACKUP RESTORE DRILL: ĐẠT — khôi phục được vào môi trường mới%s\n' "$GREEN" "$RST" || printf '%sBACKUP RESTORE DRILL: KHÔNG ĐẠT%s\n' "$RED" "$RST"
[ "$fail" -eq 0 ]
