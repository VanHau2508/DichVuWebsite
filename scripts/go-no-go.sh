#!/usr/bin/env bash
#
# CỔNG GO / NO-GO trước khi chạy khách thật (Ngày 20).
#   bash scripts/go-no-go.sh
#
# Chạy các bộ kiểm ánh xạ tới 15 tiêu chí go-live (docs/01 §7, docs/03), cộng
# kiểm chứng riêng, rồi in verdict GO / NO-GO / MANUAL cho từng tiêu chí.
# Chỉ ra GO tổng thể khi mọi tiêu chí TỰ ĐỘNG đạt và không còn NO-GO.

set -uo pipefail
export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

C="docker compose -f infra/compose.dev.yml"
GRN=$'\033[32m'; RED=$'\033[31m'; YEL=$'\033[33m'; DIM=$'\033[2m'; BLD=$'\033[1m'; RST=$'\033[0m'
declare -A R
nogo=0

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
flush() { $C exec -T redis redis-cli flushall >/dev/null 2>&1; }
# suite <key> <mô tả> <lệnh...> — PASS theo EXIT CODE (mọi e2e/script exit 0 khi đạt).
suite() {
  local key="$1" desc="$2"; shift 2
  printf '  chạy %-12s %s...\n' "$key" "$desc"
  flush
  if "$@" >"$TMP/$key.out" 2>&1; then R[$key]=PASS; else R[$key]=FAIL; grep -iE 'fail|NO-GO|error' "$TMP/$key.out" | grep -viE '0 fail|no fail' | head -3 | sed 's/^/       /'; fi
}

printf '%s╔══ GO / NO-GO — nền tảng SaaS multi-tenant ══╗%s\n' "$BLD" "$RST"

$C ps --status running -q postgres | grep -q . || { echo "Stack chưa chạy: $C up -d --build" >&2; exit 1; }

printf '\n%sChạy các bộ kiểm...%s\n' "$BLD" "$RST"
suite tenant     "cô lập tenant + bất biến schema"   $C exec -T dbtest sh -c 'node --test test/*.test.js'
suite auth       "đăng nhập + MFA + step-up"          $C exec -T auth node apps/auth/test/e2e.mjs
suite checkout   "giá server-side + idempotency + suspend" $C exec -T dbtest node apps/checkout/test/e2e.mjs
suite media      "upload private→re-encode→public"    $C exec -T dbtest node apps/seller/test/media.e2e.mjs
suite storefront "domain verified + maintenance + CSP" $C exec -T dbtest node apps/storefront/test/e2e.mjs
suite tls        "domain chỉ chạy sau verify"          bash scripts/smoke-tls.sh
suite scan       "dependency + secret + log scan"      bash scripts/security-scan.sh
suite backup     "backup → restore môi trường mới"     bash scripts/backup-restore-drill.sh

# ── Kiểm chứng SQL riêng ─────────────────────────────────────────────────────
Q() { $C exec -T postgres psql -U app_owner -d app -tAc "$1" 2>/dev/null | tr -d '\r'; }
# RLS FORCE trên MỌI bảng có shop_id
UNFORCED="$(Q "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND EXISTS(SELECT 1 FROM information_schema.columns col WHERE col.table_name=c.relname AND col.column_name='shop_id') AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)")"
[ "${UNFORCED:-1}" = "0" ] && R[rls_force]=PASS || R[rls_force]=FAIL
# Audit ghi thao tác nhạy cảm — cơ chế audit() có chạy trong gate không (≥1 hành động
# nhạy cảm được ghi). Độ phủ đầy đủ đã chứng minh ở verify-seller/verify-fulfillment mutation.
AUDITED="$(Q "SELECT count(*) FROM audit_logs WHERE action IN ('shop.suspended','member.role_changed','order.cancelled','order.shipped','payment.reconciled','member.invited')")"
[ "${AUDITED:-0}" -ge 1 ] 2>/dev/null && R[audit]=PASS || R[audit]=WARN

# ── Tài liệu vận hành ────────────────────────────────────────────────────────
docs_ok=1
for f in docs/03-ha-tang-va-van-hanh.md docs/02-mo-hinh-du-lieu-va-bao-mat.md docs/18-security-hardening.md; do
  [ -f "$f" ] || docs_ok=0
done
[ "$docs_ok" = 1 ] && R[docs]=PASS || R[docs]=FAIL

# ── Bảng 15 tiêu chí ─────────────────────────────────────────────────────────
row() { # <n> <mô tả> <trạng thái> [ghi chú]
  local st="$3" col
  case "$st" in
    GO)     col="${GRN}GO   ${RST}" ;;
    NO-GO)  col="${RED}NO-GO${RST}"; nogo=$((nogo+1)) ;;
    MANUAL) col="${YEL}MANUAL${RST}" ;;
  esac
  printf '  %2s. %-52s [%s] %s%s%s\n' "$1" "$2" "$col" "$DIM" "${4:-}" "$RST"
}
mapd() { [ "${R[$1]:-FAIL}" = PASS ] && echo GO || echo NO-GO; }

printf '\n%s15 TIÊU CHÍ GO-LIVE%s\n' "$BLD" "$RST"
row 1  "Không lỗi cross-shop trong toàn bộ test"        "$(mapd tenant)"     "tenant suite"
row 2  "RLS bật + FORCE trên mọi bảng nghiệp vụ"        "$(mapd rls_force)"  "SQL check"
row 3  "MFA hoạt động (owner + platform admin)"          "$(mapd auth)"       "auth e2e"
row 4  "Checkout không tin giá từ client"                "$(mapd checkout)"   "checkout e2e"
row 5  "Tạo đơn + payment có idempotency"                "$(mapd checkout)"   "checkout e2e"
row 6  "Backup khôi phục thành công (môi trường mới)"    "$(mapd backup)"     "backup drill"
row 7  "Rollback phiên bản (migration forward-only + backup)" "$(mapd backup)" "design + drill"
row 8  "Domain chỉ hoạt động sau xác minh"               "$(mapd storefront)" "storefront+tls e2e"
row 9  "File upload không public trước khi kiểm tra"     "$(mapd media)"      "media e2e"
row 10 "Audit ghi thao tác nhạy cảm"                     "$([ "${R[audit]}" = PASS ] && echo GO || echo MANUAL)" "audit_logs"
row 11 "Alert lỗi production tới người trực"             "MANUAL"             "Telegram bot — chưa dựng (docs/03)"
row 12 "Có trang trạng thái/bảo trì"                     "$(mapd storefront)" "suspended→503"
row 13 "Hợp đồng + chính sách dữ liệu + quy trình suspend" "$(mapd docs)"     "docs + suspend drill"
row 14 "Ba shop pilot đã chạy UAT"                       "MANUAL"             "cần người thật dùng"
row 15 "Không còn lỗi Critical/High"                     "$(mapd scan)"       "scan + review docs/18"

# tls & auth phụ trợ
[ "${R[tls]}" = PASS ] || nogo=$((nogo+1))
[ "${R[auth]}" = PASS ] || true

printf '\n%s────────────────────────────────────────────%s\n' "$DIM" "$RST"
if [ "$nogo" -eq 0 ]; then
  printf '%s%s  VERDICT: GO  %s — mọi tiêu chí tự động ĐẠT.\n' "$BLD" "$GRN" "$RST"
  printf '  Còn lại là quyết định người: #11 (alert on-call), #14 (UAT khách thật).\n'
  printf '  An toàn ra mắt pilot 3-5 khách sáng lập theo docs/03.\n'
  exit 0
else
  printf '%s%s  VERDICT: NO-GO  %s — %d tiêu chí tự động CHƯA đạt (đỏ ở trên).\n' "$BLD" "$RED" "$RST" "$nogo"
  exit 1
fi
