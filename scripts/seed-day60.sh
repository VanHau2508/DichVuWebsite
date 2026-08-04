#!/usr/bin/env bash
#
# Dựng một shop "NGÀY THỨ 60" để tự đóng vai chủ shop đã bán hai tháng (CHỈ DEV):
#   bash scripts/seed-day60.sh
#
# Chạy trong `dbtest` vì ở đó có sẵn `pg` và packages/auth/src (cần totp để dựng phiên
# staff có MFA). CHÉP script sang chứ không mount vào compose — theo đúng lệ của
# seed-demo.sh: đây là script dev, không đáng để một service mang thêm file chỉ vì nó.
#
# Chạy nhiều lần thì mỗi lần ra một shop MỚI, không đụng shop cũ.
set -euo pipefail
export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

DC=(docker compose -f infra/compose.dev.yml)

# Đường đích PHẢI là /work/scripts/… : script import '../packages/auth/src/totp.js', mà
# dbtest mount packages/auth/src ở /work/packages/auth/src. Đặt sai chỗ là import gãy.
"${DC[@]}" exec -T dbtest mkdir -p /work/scripts
"${DC[@]}" cp scripts/seed-day60.mjs dbtest:/work/scripts/seed-day60.mjs
# Xả rate-limit trước: dựng tài khoản staff + 200 SP là hàng trăm request, dính 429 giữa
# chừng thì shop dựng dở dang và mọi quan sát sau đó đều sai.
"${DC[@]}" exec -T redis sh -c "redis-cli --scan --pattern 'rl:*' | xargs -r -n 400 redis-cli del > /dev/null" 2>/dev/null || true
"${DC[@]}" exec -T dbtest node /work/scripts/seed-day60.mjs
