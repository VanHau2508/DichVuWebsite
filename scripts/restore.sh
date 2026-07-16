#!/usr/bin/env bash
#
# KHÔI PHỤC từ backup đã mã hoá (scripts/backup.sh). Backup không restore được = vô nghĩa,
# nên PHẢI diễn tập (drill) định kỳ vào máy staging.
#
#   bash scripts/restore.sh verify <thư-mục-backup>     # chỉ GIẢI MÃ + kiểm dump đọc được (an toàn, không ghi DB)
#   bash scripts/restore.sh logical <thư-mục-backup>    # NẠP logical.sql vào Postgres (GHI ĐÈ — chỉ máy khôi phục!)
#
# <thư-mục-backup> chứa *.enc lấy về từ offsite. Cần BACKUP_ENC_KEY (khoá đã mã hoá backup).

set -uo pipefail
cd "$(dirname "$0")/.."
umask 077
set -a; [ -f .env ] && . ./.env; set +a

C="docker compose -f infra/compose.prod.yml --env-file .env"
GRN=$'\033[32m'; RED=$'\033[31m'; RST=$'\033[0m'
ok() { printf '  %s✔%s %s\n' "$GRN" "$RST" "$1"; }
die() { printf '%s✖ %s%s\n' "$RED" "$1" "$RST" >&2; exit 1; }

MODE="${1:-}"; SRC="${2:-}"
[ -n "$MODE" ] && [ -n "$SRC" ] || die "dùng: restore.sh <verify|logical> <thư-mục-backup>"
[ -d "$SRC" ] || die "không thấy thư mục backup: $SRC"
[ -n "${BACKUP_ENC_KEY:-}" ] || die "thiếu BACKUP_ENC_KEY (khoá giải mã) trong .env"

ENC="$SRC/logical.sql.gz.enc"
[ -s "$ENC" ] || die "không thấy $ENC (backup logical đã mã hoá)"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# Giải mã → giải nén → kiểm là SQL dump hợp lệ.
if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_ENC_KEY -in "$ENC" -out "$TMP/logical.sql.gz"; then
  die "GIẢI MÃ THẤT BẠI — sai BACKUP_ENC_KEY hoặc file hỏng"
fi
gzip -t "$TMP/logical.sql.gz" || die "file giải mã KHÔNG phải gzip hợp lệ (backup hỏng?)"
gzip -dc "$TMP/logical.sql.gz" > "$TMP/logical.sql"
head -c 200 "$TMP/logical.sql" | grep -qiE 'PostgreSQL database (cluster )?dump|CREATE ROLE|SET ' || die "nội dung không giống pg_dumpall"
ok "giải mã + kiểm tra dump hợp lệ ($(wc -c <"$TMP/logical.sql") byte)"

if [ "$MODE" = "verify" ]; then
  printf '%s✔ VERIFY xong%s — dump giải mã được và đọc được. (Chưa ghi DB.)\n' "$GRN" "$RST"
  exit 0
fi
[ "$MODE" = "logical" ] || die "mode không hợp lệ: $MODE (verify|logical)"

printf '%s⚠ NẠP logical dump sẽ GHI ĐÈ database hiện tại.%s Chỉ chạy trên MÁY KHÔI PHỤC/STAGING.\n' "$RED" "$RST"
printf '   Gõ ĐÚNG "RESTORE" để tiếp tục: '
read -r ans; [ "$ans" = "RESTORE" ] || die "đã huỷ"

$C exec -T postgres psql -U app_owner -d postgres < "$TMP/logical.sql" || die "psql nạp dump lỗi"
ok "đã nạp logical dump"
printf '%s✔ RESTORE xong%s. Kiểm tra dữ liệu + khởi động lại service.\n' "$GRN" "$RST"
