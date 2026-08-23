#!/usr/bin/env bash
#
# Triển khai PRODUCTION. Chạy trên VPS, trong repo, có file .env (secret THẬT) ở gốc.
#   bash scripts/deploy.sh
#
# Thứ tự bắt buộc (vì sao không `up -d` một phát):
#   build → postgres → migrate → provision-db-roles (đặt mật khẩu role thật) → up service.
# App service kết nối bằng mật khẩu role THẬT, nên phải provision TRƯỚC khi up chúng.
#
# Rollback: migration forward-only + tương thích ngược 1 phiên bản (ADR/docs/03), nên
# rollback = `git checkout <commit_cũ> && bash scripts/deploy.sh`. Dữ liệu hỏng = restore
# backup (scripts/restore + PITR). Script KHÔNG tự rollback (tránh hành động mù lúc cháy).

set -euo pipefail
cd "$(dirname "$0")/.."

CF="infra/compose.prod.yml"
C="docker compose -f $CF --env-file .env"
GRN=$'\033[32m'; RED=$'\033[31m'; BLD=$'\033[1m'; RST=$'\033[0m'
step() { printf '\n%s▶ %s%s\n' "$BLD" "$1" "$RST"; }
die()  { printf '%s✖ %s%s\n' "$RED" "$1" "$RST" >&2; exit 1; }

step "0. Tiền kiểm"
[ -f .env ] || die "thiếu .env (sao chép .env.example rồi điền secret thật)"
grep -qE '^POSTGRES_PASSWORD=.+' .env || die ".env thiếu POSTGRES_PASSWORD"
grep -qiE 'change-me|devpassword|your-relay|your-domain' .env && die ".env còn giá trị mẫu — điền secret thật"
# MFA_ENC_KEY là khoá AES thật, KHÔNG nói 'change-me' nên guard trên bỏ sót: kiểm riêng.
grep -qE '^MFA_ENC_KEY=[0-9a-fA-F]{64}$' .env || die "MFA_ENC_KEY phải là 64 hex (openssl rand -hex 32)"
grep -qiE '^MFA_ENC_KEY=0{64}$' .env && die "MFA_ENC_KEY còn là khoá mẫu toàn 0 — sinh khoá thật"
# SHIPPING_ENC_KEY (token hãng VC per-shop) — cùng chuẩn khoá AES 64-hex.
grep -qE '^SHIPPING_ENC_KEY=[0-9a-fA-F]{64}$' .env || die "SHIPPING_ENC_KEY phải là 64 hex (openssl rand -hex 32)"
grep -qiE '^SHIPPING_ENC_KEY=0{64}$' .env && die "SHIPPING_ENC_KEY còn là khoá mẫu toàn 0 — sinh khoá thật"
# INTEGRATION_ENC_KEY mã hoá credential POS per-shop; thiếu hoặc dùng khoá mẫu làm seller/worker
# chết lúc khởi động, còn đổi nhầm khoá khiến mọi connector hiện hữu không giải mã được.
grep -qE '^INTEGRATION_ENC_KEY=[0-9a-fA-F]{64}$' .env || die "INTEGRATION_ENC_KEY phải là 64 hex (openssl rand -hex 32)"
grep -qiE '^INTEGRATION_ENC_KEY=0{64}$' .env && die "INTEGRATION_ENC_KEY còn là khoá mẫu toàn 0 — sinh khoá thật"
docker info >/dev/null 2>&1 || die "docker chưa chạy"
PREV="$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
echo "  commit đang deploy: $PREV"

step "1. Build image (npm ci, node pin digest — P0-7)"
$C build

step "2. Postgres lên trước + chờ healthy"
$C up -d postgres
for i in $(seq 1 30); do
  [ "$($C ps postgres --format '{{.Health}}' 2>/dev/null)" = "healthy" ] && break
  [ "$i" = 30 ] && die "postgres không healthy"; sleep 2
done
echo "  postgres healthy"

step "3. Migrate (forward-only)"
$C run --rm migrate

step "4. Provision mật khẩu role từ .env (P0-6)"
# Nạp .env vào môi trường để chuyển tiếp APP_*_PASSWORD + POSTGRES_PASSWORD vào script.
set -a; . ./.env; set +a
# Mật khẩu PHẢI đi qua ENV (docker đọc từ môi trường), KHÔNG nhúng vào -e VAR=value —
# giá trị nhúng nằm trong argv, lộ qua `ps`/proc cmdline. /proc/<pid>/environ chỉ owner/root.
export PGADMIN_URL="postgres://app_owner:${POSTGRES_PASSWORD}@localhost:5432/app"
$C exec -T \
  -e PGADMIN_URL \
  -e APP_RW_PASSWORD -e APP_TLS_PASSWORD -e APP_AUTH_PASSWORD -e APP_PLATFORM_PASSWORD \
  -e APP_STORE_PASSWORD -e APP_CHECKOUT_PASSWORD -e APP_PAYMENT_PASSWORD \
  -e APP_WORKER_PASSWORD -e APP_EXPIRY_PASSWORD -e APP_DOMAINVERIFY_PASSWORD -e APP_BILLING_PASSWORD \
  -e APP_CUSTOMER_PASSWORD -e APP_LOYALTY_PASSWORD -e APP_SIGNUP_PASSWORD -e APP_AFFILIATE_PASSWORD \
  -e APP_INTEGRATION_PASSWORD \
  postgres bash < scripts/provision-db-roles.sh

step "5. Up toàn bộ service + chờ healthy"
$C up -d --wait --wait-timeout 180

step "6. Kiểm tra sức khoẻ"
bad=""
for s in postgres redis minio tls-authorize auth platform seller checkout payment worker storefront account signup caddy; do
  h="$($C ps "$s" --format '{{.Health}}' 2>/dev/null)"
  [ "$h" = "healthy" ] || bad="$bad $s=$h"
done
if [ -n "$bad" ]; then
  $C ps
  die "service chưa healthy:$bad — rollback: git checkout <commit_cũ> && bash scripts/deploy.sh"
fi
# Caddy đã nạp cấu hình?
$C exec -T caddy wget -qO- http://127.0.0.1:2019/config/ >/dev/null 2>&1 || die "Caddy chưa nạp cấu hình"

step "7. Kiểm auth từng role (provision đúng + /healthz nông không che mật khẩu sai)"
# /healthz trả 200 mà không kiểm DB → service dùng mật khẩu SAI vẫn 'healthy'. Kiểm thẳng:
# mỗi role phải đăng nhập được bằng mật khẩu trong .env (chứng minh provision khớp).
for pair in app_rw:APP_RW_PASSWORD app_auth:APP_AUTH_PASSWORD app_store:APP_STORE_PASSWORD \
            app_checkout:APP_CHECKOUT_PASSWORD app_payment:APP_PAYMENT_PASSWORD \
            app_worker:APP_WORKER_PASSWORD app_expiry:APP_EXPIRY_PASSWORD \
            app_domainverify:APP_DOMAINVERIFY_PASSWORD app_billing:APP_BILLING_PASSWORD \
            app_platform:APP_PLATFORM_PASSWORD app_tls:APP_TLS_PASSWORD \
            app_customer:APP_CUSTOMER_PASSWORD app_loyalty:APP_LOYALTY_PASSWORD app_signup:APP_SIGNUP_PASSWORD \
            app_affiliate:APP_AFFILIATE_PASSWORD app_integration:APP_INTEGRATION_PASSWORD; do
  role="${pair%%:*}"; var="${pair#*:}"; export RPW="${!var}"
  $C exec -T -e RPW postgres sh -c 'PGPASSWORD="$RPW" psql -U '"$role"' -h 127.0.0.1 -d app -tAc "select 1"' >/dev/null 2>&1 \
    || { unset RPW; die "role $role KHÔNG đăng nhập được bằng mật khẩu .env — provision chưa đúng / service sẽ hỏng"; }
done
unset RPW
echo "  15 role đăng nhập OK (mật khẩu .env khớp thực tế)"

printf '\n%s✔ DEPLOY OK%s — commit %s, mọi service healthy, Caddy đã nạp cấu hình.\n' "$GRN" "$RST" "$PREV"
echo "  Nhắc: backup định kỳ (scripts/backup.sh) + kiểm tra chứng chỉ Caddy đã cấp."
