#!/usr/bin/env bash
#
# Đổ nội dung mẫu vào 4 shop demo (CHỈ DEV):
#   bash scripts/seed-demo.sh
#
# Chạy trong container `seller` vì chỉ ở đó mới có sẵn cả `minio` lẫn `sharp`
# (dbtest chỉ có `pg`). Ghi DB bằng app_owner: seed cắt ngang nhiều tenant nên
# vai app_rw có RLS sẽ không đi qua được.

set -euo pipefail
export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

DC=(docker compose -f infra/compose.dev.yml)

"${DC[@]}" cp scripts/seed-demo.mjs seller:/app/seed-demo.mjs
"${DC[@]}" exec -T \
  -e SEED_DATABASE_URL="postgres://app_owner:devpassword@postgres:5432/app" \
  seller node /app/seed-demo.mjs
