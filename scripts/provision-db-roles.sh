#!/usr/bin/env bash
#
# Đặt / rotate mật khẩu các app role từ BIẾN MÔI TRƯỜNG (P0-6).
#
# Migration tạo role với mật khẩu bootstrap 'devpassword' (chỉ để dev chạy được +
# làm mặc định). Ở PRODUCTION, chạy script này MỘT LẦN sau `migrate` với secret thật
# → devpassword bị thay, không còn dùng được. ROTATE = chạy lại với mật khẩu mới,
# KHÔNG cần sửa migration (giữ migration bất biến). Idempotent.
#
# Cần một kết nối QUYỀN CAO (owner/superuser) để ALTER ROLE:
#   PGADMIN_URL='postgres://app_owner:...@db:5432/app' \
#   APP_RW_PASSWORD=... APP_AUTH_PASSWORD=... APP_PLATFORM_PASSWORD=... \
#   APP_STORE_PASSWORD=... APP_CHECKOUT_PASSWORD=... APP_PAYMENT_PASSWORD=... \
#   APP_WORKER_PASSWORD=... APP_EXPIRY_PASSWORD=... APP_TLS_PASSWORD=... \
#   bash scripts/provision-db-roles.sh
#
# Role nào không có biến tương ứng thì BỎ QUA (giữ nguyên) — cho phép rotate từng phần.

set -euo pipefail
: "${PGADMIN_URL:?cần PGADMIN_URL (kết nối owner/superuser để ALTER ROLE)}"

ROLES=(app_rw app_tls app_auth app_platform app_store app_checkout app_customer app_payment app_worker app_expiry app_domainverify app_billing app_loyalty app_signup)
set=0 skip=0
for r in "${ROLES[@]}"; do
  var="$(echo "$r" | tr '[:lower:]' '[:upper:]')_PASSWORD"   # app_rw → APP_RW_PASSWORD
  pw="${!var:-}"
  if [ -z "$pw" ]; then echo "  bỏ qua $r (thiếu $var)"; skip=$((skip+1)); continue; fi
  esc="${pw//\'/\'\'}"   # escape ' cho string literal SQL
  # Mật khẩu qua STDIN (không nằm trong argv → không lộ ở `ps`).
  psql "$PGADMIN_URL" -v ON_ERROR_STOP=1 >/dev/null <<SQL
ALTER ROLE $r WITH PASSWORD '$esc';
SQL
  echo "  đã đặt mật khẩu: $r"
  set=$((set+1))
done
echo "xong — đặt $set role, bỏ qua $skip. (Nếu prod: devpassword không còn dùng được cho role đã đặt.)"
