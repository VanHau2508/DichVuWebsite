#!/usr/bin/env bash
#
# Chụp / khôi phục một shop dev (CHỈ DEV):
#   bash scripts/shop-snapshot.sh dump nha-xinh-1nh1va
#   bash scripts/shop-snapshot.sh dry     nha-xinh-1nh1va   # tổng duyệt, rollback
#   bash scripts/shop-snapshot.sh restore nha-xinh-1nh1va
#
# Dùng để giữ BÀN THAM CHIẾU THIẾT KẾ qua các lần dev-db-reset.sh. Không có nó thì
# reset đồng nghĩa mất shop mẫu, nên reset sẽ không bao giờ được chạy và DB lại phình.
#
# Ảnh nằm trong dev-snapshots/ (đã .gitignore): 4 MB nhị phân không thuộc về repo,
# và nó là trạng thái MÁY NÀY chứ không phải mã nguồn.

set -euo pipefail
export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

MODE="${1:-}"; SLUG="${2:-}"
[ -n "$MODE" ] && [ -n "$SLUG" ] || { echo "dùng: bash scripts/shop-snapshot.sh dump|restore <slug>" >&2; exit 1; }
[[ "$SLUG" =~ ^[a-z0-9-]+$ ]] || { echo "slug không hợp lệ: $SLUG" >&2; exit 1; }

DC=(docker compose -f infra/compose.dev.yml)
OUT="dev-snapshots/$SLUG"
# Chạy trong container seller: chỉ ở đó mới có sẵn cả `pg` lẫn `minio`.
RUN=("${DC[@]}" exec -T -e SEED_DATABASE_URL="postgres://app_owner:devpassword@postgres:5432/app" seller)
# Dọn phải chạy bằng root: `docker compose cp` ghi tệp thuộc root, còn container
# seller chạy user thường nên rm của nó bị từ chối.
CLEAN=("${DC[@]}" exec -T -u root seller rm -rf /tmp/snap)

"${DC[@]}" cp scripts/shop-snapshot.mjs seller:/app/shop-snapshot.mjs

if [ "$MODE" = "dump" ]; then
  "${CLEAN[@]}"
  "${RUN[@]}" node /app/shop-snapshot.mjs dump "$SLUG"
  rm -rf "$OUT"; mkdir -p dev-snapshots
  "${DC[@]}" cp seller:/tmp/snap "$OUT"
  echo "→ $OUT ($(du -sh "$OUT" 2>/dev/null | cut -f1))"
elif [ "$MODE" = "restore" ] || [ "$MODE" = "dry" ]; then
  [ -d "$OUT" ] || { echo "chưa có bản chụp ở $OUT — chạy dump trước" >&2; exit 1; }
  "${CLEAN[@]}"
  "${DC[@]}" cp "$OUT" seller:/tmp/snap
  "${RUN[@]}" node /app/shop-snapshot.mjs "$MODE" "$SLUG"
else
  echo "chế độ lạ: $MODE (chỉ dump/restore/dry)" >&2; exit 1
fi
