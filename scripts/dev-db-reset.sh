#!/usr/bin/env bash
#
# Dựng lại DB dev từ số 0 — CHỈ DEV, XOÁ SẠCH DỮ LIỆU.
#   bash scripts/dev-db-reset.sh          # chỉ ĐO và in ra sẽ mất gì (không đụng gì)
#   bash scripts/dev-db-reset.sh --yes    # làm thật
#
# VÌ SAO CẦN. DB dev không bao giờ được dọn, và nó không chỉ làm chậm — nó ĐỔI HÀNH VI
# THEO THỜI GIAN rồi sinh ra lỗi đỏ GIẢ:
#   - 2026-07-30: >1000 đơn ứ khiến vòng quét định kỳ của worker kéo dài hàng giây thay
#     vì vài trăm ms. Cửa sổ đua rộng ra đủ để ca "digest đơn ứ" đỏ trong lượt ci-local
#     đầy đủ, trong khi chạy riêng bộ đó xanh 3 lần liên tiếp. Mất một lượt CI 45 phút
#     và vài vòng chẩn đoán mới ghim được nguyên nhân.
#   - Cùng ngày: 5365 shop rác khiến dev-lan-host.sh không thể quét bảng, phải liệt kê
#     đích danh slug.
# Đây là lớp lỗi tệ nhất: code không sai, THỜI GIAN sai — đọc code bao lâu cũng không thấy.
#
# XOÁ: pgdata (Postgres), redisdata, miniodata (ảnh đã upload).
# GIỮ: caddy_data — chứa CA nội bộ và chứng chỉ đã cấp. Xoá là mọi máy/điện thoại đã
#      bấm-qua-cảnh-báo phải bấm lại từ đầu, đổi lấy đúng con số không lợi ích.

set -uo pipefail
export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

DC="docker compose -f infra/compose.dev.yml"
RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLD=$'\033[1m'; RST=$'\033[0m'
VOLS=(nentang-dev_pgdata nentang-dev_redisdata nentang-dev_miniodata)

echo "${BLD}Hiện trạng DB dev${RST}"
$DC exec -T postgres psql -U app_owner -d app -qtA -c "
  SELECT 'shop            ' || count(*) FROM shops
  UNION ALL SELECT 'đơn             ' || count(*) FROM orders
  UNION ALL SELECT 'đơn ứ (>24h)    ' || count(*) FROM orders WHERE status='pending' AND created_at < now() - interval '24 hours'
  UNION ALL SELECT 'sản phẩm        ' || count(*) FROM products
  UNION ALL SELECT 'outbox          ' || count(*) FROM outbox;" 2>/dev/null | sed 's/^/  /'
echo "  khoá redis      $($DC exec -T redis redis-cli DBSIZE 2>/dev/null | tr -d '\r')"

if [ "${1:-}" != "--yes" ]; then
  echo
  echo "${RED}${BLD}MẤT CẢ TÀI KHOẢN ĐĂNG NHẬP.${RST} users / memberships / platform_staff bị xoá theo,"
  echo "và bản chụp shop KHÔNG giữ chúng. Reset xong, shop còn nguyên nhưng không ai vào được."
  echo "Dựng lại:  ${BLD}bash scripts/dev-make-admin.sh <email> <mật-khẩu> [--staff] [slug-shop ...]${RST}"
  echo
  echo "${YLW}Mới chỉ ĐO. Chạy thật:${RST}  bash scripts/dev-db-reset.sh --yes"
  echo "Sẽ xoá volume: ${VOLS[*]}"
  echo "Giữ nguyên: nentang-dev_caddy_data (CA nội bộ — không phải bấm lại cảnh báo chứng chỉ)"
  exit 0
fi

echo
echo "${RED}${BLD}XOÁ SẠCH DB/Redis/MinIO dev…${RST}"
# Phải xoá cả CỤM Postgres chứ không chỉ DROP DATABASE: 14 lệnh CREATE ROLE nằm trong
# migration, mà role là cấp CỤM. Giữ cụm thì migration chạy lại sẽ đổ "role already exists".
$DC down || exit 1
for v in "${VOLS[@]}"; do
  docker volume rm "$v" >/dev/null 2>&1 && echo "  đã xoá $v" || echo "  ${YLW}bỏ qua $v (không có)${RST}"
done

echo
echo "${BLD}Dựng lại…${RST}"
# CHỜ ENGINE. Chu kỳ down → up là lúc dễ mất Docker Desktop nhất (đã dính một lần:
# engine chết ngay sau `down`, và lượt CI kế tiếp dừng ở tiền kiểm — may là nó từ
# chối thẳng chứ không chạy rỗng rồi báo xanh). Không chờ thì `up -d` đổ ngay ở đây,
# đúng lúc DB vừa bị xoá sạch — trạng thái tệ nhất để bỏ dở giữa chừng.
for i in $(seq 1 30); do
  docker info >/dev/null 2>&1 && break
  [ "$i" = 1 ] && printf '  chờ Docker engine'
  printf '.'; sleep 5
  [ "$i" = 30 ] && { echo; echo "${RED}Docker engine không lên sau 150s. Bật Docker Desktop rồi chạy:${RST}"; \
                     echo "  docker compose -f infra/compose.dev.yml up -d && docker compose -f infra/compose.dev.yml run --rm migrate"; exit 1; }
done
$DC up -d || exit 1
$DC run --rm migrate 2>&1 | tail -3

echo
echo "${GRN}${BLD}Xong.${RST} Lấy lại bàn thử giao diện:"
echo "  bash scripts/seed-demo.sh                              # 4 shop demo + nội dung + ảnh"
for d in dev-snapshots/*/; do
  [ -d "$d" ] || continue
  echo "  bash scripts/shop-snapshot.sh restore $(basename "$d")"
done
echo "  bash scripts/dev-lan-host.sh                           # gắn lại hostname LAN"
echo "${YLW}Shop KHÔNG có trong hai danh sách trên đã mất hẳn. Muốn giữ shop nào thì${RST}"
echo "${YLW}chụp TRƯỚC:  bash scripts/shop-snapshot.sh dump <slug>${RST}"
