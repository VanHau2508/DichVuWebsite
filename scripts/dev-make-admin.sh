#!/usr/bin/env bash
#
# Dựng lại tài khoản quản trị cho môi trường DEV sau khi xoá sạch DB.
#   bash scripts/dev-make-admin.sh <email> <mật-khẩu> [--staff] [slug-shop ...]
#
# Ví dụ:
#   bash scripts/dev-make-admin.sh chushop@nhaxinh.vn 'mat khau that dai' nha-xinh-1nh1va
#   bash scripts/dev-make-admin.sh admin@nentang.vn   'mat khau that dai' --staff
#
# VÌ SAO CẦN. `dev-db-reset.sh` xoá cả cụm Postgres, và `shop-snapshot.sh` CỐ Ý
# không giữ phần danh tính (users/memberships/platform_staff) — khôi phục tài
# khoản đăng nhập cùng mật khẩu băm là việc của hệ thống xác thực, không phải
# của một bản chụp dữ liệu shop. Hệ quả THẬT đã xảy ra: reset xong, shop còn
# nguyên nhưng KHÔNG ai đăng nhập được vào nó.
#
# Mật khẩu đi qua ĐÚNG endpoint /auth/register để chính `auth` băm — script này
# KHÔNG bao giờ ghi thẳng vào bảng users. Chỉ hai thứ cấp quyền (platform_staff,
# memberships) mới chèn bằng SQL, vì đường cấp quyền thật đòi MFA + lời mời qua
# email — quá nặng cho một lệnh dựng lại môi trường dev.

set -euo pipefail
export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

EMAIL="${1:-}"; PASSWORD="${2:-}"; shift 2 2>/dev/null || true
[ -n "$EMAIL" ] && [ -n "$PASSWORD" ] || {
  echo "dùng: bash scripts/dev-make-admin.sh <email> <mật-khẩu> [--staff] [slug-shop ...]" >&2; exit 1; }

STAFF=0; SLUGS=()
for a in "$@"; do
  if [ "$a" = "--staff" ]; then STAFF=1; else SLUGS+=("$a"); fi
done

DC=(docker compose -f infra/compose.dev.yml)
PSQL=("${DC[@]}" exec -T postgres psql -U app_owner -d app -v ON_ERROR_STOP=1 -qtA)

# 1) Tạo user qua auth. Phản hồi CỐ Ý giống nhau cho email mới lẫn đã tồn tại
#    (chống dò email), nên không đọc status để kết luận — kiểm bảng users sau.
"${DC[@]}" exec -T toolbox curl -s -o /dev/null -X POST http://auth:3020/auth/register \
  -H 'content-type: application/json' -H 'origin: https://auth.localtest' \
  -d "{\"email\":$(printf '%s' "$EMAIL" | sed 's/"/\\"/g; s/^/"/; s/$/"/'),\"password\":$(printf '%s' "$PASSWORD" | sed 's/"/\\"/g; s/^/"/; s/$/"/')}" || true

UID_=$("${PSQL[@]}" -c "SELECT id FROM users WHERE email = '$EMAIL'" | tr -d '\r')
[ -n "$UID_" ] || { echo "KHÔNG tạo được user $EMAIL — mật khẩu có thể quá ngắn/yếu (auth siết độ dài)." >&2; exit 1; }
echo "user: $EMAIL"

if [ "$STAFF" = 1 ]; then
  "${PSQL[@]}" -c "INSERT INTO platform_staff (user_id, role) VALUES ('$UID_','admin')
                   ON CONFLICT (user_id) DO UPDATE SET role='admin'" >/dev/null
  echo "  + quyền nhân viên nền tảng (admin)"
  echo "    LƯU Ý: trang /platform bắt buộc MFA — lần đầu vào phải bật xác thực 2 lớp."
fi

for s in "${SLUGS[@]}"; do
  [[ "$s" =~ ^[a-z0-9-]+$ ]] || { echo "slug không hợp lệ: $s" >&2; exit 1; }
  n=$("${PSQL[@]}" -c "INSERT INTO memberships (shop_id, user_id, role)
        SELECT id, '$UID_', 'owner' FROM shops WHERE slug='$s'
        ON CONFLICT DO NOTHING RETURNING 1" | tr -d '\r' | wc -l | tr -d ' ')
  if [ "$n" -gt 0 ]; then echo "  + chủ shop $s"; else echo "  · $s (đã là thành viên, hoặc không có shop này)"; fi
done

echo
echo "Đăng nhập: https://admin.localtest:8443  (thêm '127.0.0.1 admin.localtest' vào hosts nếu chưa có)"
