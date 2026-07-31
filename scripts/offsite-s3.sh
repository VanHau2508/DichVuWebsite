#!/usr/bin/env bash
#
# Đẩy MỘT tệp backup ra kho đối tượng tương thích S3. Dùng làm OFFSITE_CMD:
#   OFFSITE_CMD="bash scripts/offsite-s3.sh"  bash scripts/backup.sh
#
# backup.sh gọi:  $OFFSITE_CMD <đường-dẫn-tệp> <OFFSITE_DEST>
# Thoát ≠ 0 là backup.sh DỪNG và không prune bản cục bộ — đúng ý: đẩy hỏng mà báo
# xanh còn tệ hơn không đẩy.
#
# VÌ SAO CẦN. backup-restore-drill và verify-backup-encryption đã chứng minh hai
# mắt xích: khôi phục được vào máy mới, và mã hoá thật. Nhưng cả hai đều chạy
# TRÊN CÙNG MỘT MÁY. Ổ hỏng / VPS bị xoá / ransomware là mất hết — "sao lưu" nằm
# cạnh bản gốc không phải sao lưu. Đây là mắt xích còn thiếu.
#
# Chạy `mc` trong container (image chính chủ MinIO) thay vì đòi cài aws-cli/rclone
# lên VPS: máy nào chạy được stack này thì đã có Docker. Hoạt động với AWS S3,
# Backblaze B2, Cloudflare R2, Wasabi, hay chính MinIO.
#
# BIẾN MÔI TRƯỜNG (đặt trong .env của production):
#   BACKUP_S3_ENDPOINT    https://s3.ap-southeast-1.amazonaws.com  (hoặc B2/R2/…)
#   BACKUP_S3_BUCKET      tên bucket
#   BACKUP_S3_ACCESS_KEY  / BACKUP_S3_SECRET_KEY
#   BACKUP_S3_PREFIX      (tuỳ chọn) thư mục con, mặc định 'nentang'
#
# Tệp đẩy đi ĐÃ mã hoá sẵn bởi backup.sh (*.enc). Script này KHÔNG tự mã hoá —
# một chỗ mã hoá duy nhất, để không ai tưởng nhầm là có hai lớp.

set -uo pipefail
export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"
export MSYS_NO_PATHCONV=1

# backup.sh truyền MỘT ĐƯỜNG DẪN — có thể là TỆP (chế độ wal: wal.tar.gz.enc) hoặc cả
# THƯ MỤC mốc thời gian (chế độ full). Phải nhận cả hai: bản đầu của script này chỉ nhận
# tệp nên chế độ full đổ ngay, dù từng tệp lẻ đẩy được.
SRC="${1:-}"; DEST_HINT="${2:-}"
[ -n "$SRC" ] || { echo "offsite-s3: thiếu đường dẫn" >&2; exit 1; }
[ -e "$SRC" ] || { echo "offsite-s3: không thấy '$SRC'" >&2; exit 1; }
RECUR=""; [ -d "$SRC" ] && RECUR="--recursive"

: "${BACKUP_S3_ENDPOINT:?offsite-s3: thiếu BACKUP_S3_ENDPOINT}"
: "${BACKUP_S3_BUCKET:?offsite-s3: thiếu BACKUP_S3_BUCKET}"
: "${BACKUP_S3_ACCESS_KEY:?offsite-s3: thiếu BACKUP_S3_ACCESS_KEY}"
: "${BACKUP_S3_SECRET_KEY:?offsite-s3: thiếu BACKUP_S3_SECRET_KEY}"
PREFIX="${BACKUP_S3_PREFIX:-nentang}"
MC_IMAGE="${MC_IMAGE:-minio/mc:latest}"

# Giữ nguyên cấu trúc thư mục theo mốc thời gian mà backup.sh tạo (…/<TS>/<tên>),
# để trên kho đối tượng vẫn tra được "bản của lúc nào".
if [ -d "$SRC" ]; then
  # CỔNG CUỐI TRƯỚC KHI DỮ LIỆU RỜI MÁY: từ chối mọi tệp KHÔNG mã hoá còn nội dung.
  # Dump chứa hash mật khẩu, PII khách và KHOÁ TLS. Nếu một bước mã hoá lỗi mà vẫn đẩy
  # nguyên bản lên kho ngoài thì mọi lớp phòng thủ khác thành vô nghĩa. Bỏ qua tệp RỖNG
  # (backup.sh không mã hoá artifact rỗng — như wal.tar.gz khi chưa bật WAL archive).
  PLAIN="$(find "$SRC" -type f ! -name '*.enc' -size +0c -printf '%f ' 2>/dev/null \
           || find "$SRC" -type f ! -name '*.enc' -size +0c -exec basename {} \; | tr '\n' ' ')"
  if [ -n "${PLAIN// /}" ]; then
    echo "offsite-s3: TỪ CHỐI đẩy — có tệp chưa mã hoá: $PLAIN" >&2
    echo "  (dump chứa hash mật khẩu + PII + khoá TLS; kiểm BACKUP_ENC_KEY)" >&2
    exit 1
  fi
  KEY="$PREFIX/${DEST_HINT:+$DEST_HINT/}$(basename "$SRC")"      # thư mục mốc thời gian
  # '/data/' có dấu '/' cuối: mc chép NỘI DUNG thư mục. Thiếu dấu đó thì mc lồng thêm
  # một cấp 'data/' vào khoá — đã dính, và nó làm lệch cấu trúc so với bản cục bộ.
  MOUNT="$SRC"; INNER="/data/"
else
  KEY="$PREFIX/${DEST_HINT:+$DEST_HINT/}$(basename "$(dirname "$SRC")")/$(basename "$SRC")"
  MOUNT="$(dirname "$SRC")"; INNER="/data/$(basename "$SRC")"
fi

# Mạng: mặc định bridge (ra Internet được — đủ cho S3/B2/R2 thật). BACKUP_S3_NETWORK
# chỉ dùng khi endpoint nằm TRONG một mạng docker (kiểm thử với MinIO nội bộ).
# Khoá truyền qua BIẾN MÔI TRƯỜNG chứ không qua tham số dòng lệnh — tham số hiện
# trong `ps` của mọi tiến trình trên máy.
NET=""; [ -n "${BACKUP_S3_NETWORK:-}" ] && NET="--network ${BACKUP_S3_NETWORK}"

# Chèn khoá vào URL: tách scheme rồi ghép lại. Không dùng ${VAR/a/b} với chuỗi có
# dấu '/' — cách đó im lặng cho ra URL sai, và im lặng là kiểu hỏng tệ nhất ở đây.
SCHEME="${BACKUP_S3_ENDPOINT%%://*}"
HOSTPART="${BACKUP_S3_ENDPOINT#*://}"
MC_URL="$SCHEME://$BACKUP_S3_ACCESS_KEY:$BACKUP_S3_SECRET_KEY@$HOSTPART"

# Đường dẫn thư mục cho -v: Docker trên Windows cần dạng Windows (pwd -W).
SRC_DIR="$(cd "$MOUNT" && { pwd -W 2>/dev/null || pwd; })"

# KHÔNG nuốt stderr: đẩy hỏng mà không nói vì sao thì người trực đêm không sửa được.
ERR="$(docker run --rm $NET -e MC_HOST_off="$MC_URL" -v "$SRC_DIR:/data:ro" \
  "$MC_IMAGE" cp --quiet $RECUR "$INNER" "off/$BACKUP_S3_BUCKET/$KEY" 2>&1)" || {
  echo "offsite-s3: đẩy THẤT BẠI → $BACKUP_S3_BUCKET/$KEY" >&2
  printf '  %s\n' "$ERR" >&2
  exit 1
}

echo "offsite-s3: $KEY"
