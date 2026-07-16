#!/usr/bin/env bash
#
# Backup PRODUCTION. Chạy theo cron trên VPS (logical + WAL thường xuyên hơn base).
#   bash scripts/backup.sh            # full: logical + base + wal + media + caddy
#   bash scripts/backup.sh wal        # chỉ đẩy WAL archive (chạy dày → RPO nhỏ)
#
# Thành phần (mỗi cái phục vụ một kiểu khôi phục):
#   - logical.sql.gz : pg_dumpall — restore vào máy BẤT KỲ (roles+schema+data). DR đơn giản.
#   - base.tar.gz    : pg_basebackup — nền cho PITR.
#   - wal.tar.gz     : WAL archive — replay tới THỜI ĐIỂM (RPO nhỏ nếu đẩy dày).
#   - media.tar.gz   : ảnh MinIO (public+private).
#   - caddy_data     : CHỨNG CHỈ TLS — mất = cấp lại hàng trăm cert (rate-limit LE).
# OFFSITE_CMD (env) đẩy ra nơi khác VPS — BẮT BUỘC trước khách thật (offsite = DR thật).

set -uo pipefail
cd "$(dirname "$0")/.."
# Dump chứa hash mật khẩu role + PII + khoá TLS → CHỈ chủ đọc (0600/0700), không world-readable.
umask 077
set -a; [ -f .env ] && . ./.env; set +a

C="docker compose -f infra/compose.prod.yml --env-file .env"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/nentang}"
RET="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_ENC_KEY="${BACKUP_ENC_KEY:-}"
MODE="${1:-full}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_DIR/$TS"; mkdir -p "$DEST"
GRN=$'\033[32m'; RED=$'\033[31m'; RST=$'\033[0m'
ok() { printf '  %s✔%s %s\n' "$GRN" "$RST" "$1"; }
warn() { printf '  %s!%s %s\n' "$RED" "$RST" "$1"; }

# MÃ HOÁ tại chỗ TRƯỚC khi rời máy: dump chứa hash mật khẩu + PII khách + KHOÁ TLS. Nếu
# offsite (S3/B2/box khác) bị lộ mà backup không mã hoá = lộ sạch. Khoá BACKUP_ENC_KEY nằm
# NGOÀI backup (env/secret manager) → kẻ chiếm được file backup vẫn không đọc được.
# AES-256-CBC + PBKDF2 (200k vòng) + salt ngẫu nhiên mỗi file. Giải mã: scripts/restore.sh.
encrypt_file() {
  local f="$1"
  [ -s "$f" ] || return 0                       # bỏ qua file rỗng
  if [ -z "$BACKUP_ENC_KEY" ]; then
    if [ "${ALLOW_UNENCRYPTED_BACKUP:-}" = "1" ]; then warn "BACKUP_ENC_KEY trống — backup KHÔNG mã hoá (đã opt-in)"; return 0; fi
    printf '%s✖ BACKUP_ENC_KEY trống — TỪ CHỐI đẩy backup KHÔNG mã hoá (chứa PII + khoá TLS).%s\n' "$RED" "$RST" >&2
    printf '   Sinh khoá: openssl rand -base64 48 → đặt BACKUP_ENC_KEY trong .env (GIỮ RIÊNG, KHÔNG kèm backup).\n' >&2
    exit 1
  fi
  if openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_ENC_KEY -in "$f" -out "$f.enc"; then
    rm -f "$f"; ok "mã hoá: $(basename "$f").enc"
  else
    printf '%s✖ mã hoá THẤT BẠI: %s — DỪNG (không đẩy plaintext).%s\n' "$RED" "$f" "$RST" >&2; exit 1
  fi
}

offsite() { # đẩy một đường dẫn ra offsite; THIẾU offsite = fail (backup cục-bộ-only KHÔNG là DR)
  if [ -n "${OFFSITE_CMD:-}" ]; then
    # Đẩy THẤT BẠI phải FATAL: không "xanh giả" + KHÔNG prune local (giữ lịch sử để cứu).
    if $OFFSITE_CMD "$1" "${OFFSITE_DEST:-}"; then ok "offsite: $1"; return 0; fi
    printf '%s✖ offsite đẩy THẤT BẠI: %s — DỪNG (không prune local, exit≠0 cho monitor).%s\n' "$RED" "$1" "$RST" >&2
    exit 1
  fi
  if [ "${ALLOW_LOCAL_ONLY_BACKUP:-}" = "1" ]; then warn "OFFSITE_CMD trống — CHỈ cục bộ (đã opt-in ALLOW_LOCAL_ONLY_BACKUP)"; return; fi
  printf '%s✖ OFFSITE_CMD trống — backup CHỈ cục bộ, KHÔNG đủ DR.%s\n' "$RED" "$RST" >&2
  printf '   Cấu hình OFFSITE_CMD, hoặc đặt ALLOW_LOCAL_ONLY_BACKUP=1 nếu CỐ Ý chấp nhận rủi ro.\n' >&2
  exit 1   # cron/monitor thấy exit≠0 → không "xanh giả" khi thực ra chưa có DR
}

# WAL-only: đẩy nhanh, không dump nặng (chạy mỗi vài phút cho RPO nhỏ).
$C exec -T postgres tar -C /wal-archive -czf - . > "$DEST/wal.tar.gz" 2>/dev/null && ok "WAL archive ($(wc -c <"$DEST/wal.tar.gz") byte)" || warn "WAL archive rỗng/lỗi"
if [ "$MODE" = "wal" ]; then encrypt_file "$DEST/wal.tar.gz"; offsite "$DEST/wal.tar.gz.enc"; echo "backup WAL xong: $DEST"; exit 0; fi

# Logical dump.
if $C exec -T postgres pg_dumpall -U app_owner | gzip > "$DEST/logical.sql.gz" && [ -s "$DEST/logical.sql.gz" ]; then
  ok "logical dump ($(wc -c <"$DEST/logical.sql.gz") byte)"
else warn "pg_dumpall lỗi"; fi

# Physical base backup (cho PITR). Chạy trong container, socket local (trust) → không cần mật khẩu.
base_ok=0
if $C exec -T postgres pg_basebackup -U app_owner -D - -Ft -z -X fetch > "$DEST/base.tar.gz" 2>/dev/null && [ -s "$DEST/base.tar.gz" ]; then
  ok "base backup ($(wc -c <"$DEST/base.tar.gz") byte)"; base_ok=1
else warn "pg_basebackup lỗi (kiểm max_wal_senders / pg_hba replication)"; fi

# Media (MinIO buckets).
$C exec -T minio tar -C /data -czf - media-public media-private > "$DEST/media.tar.gz" 2>/dev/null && ok "media" || warn "media backup lỗi/không có bucket"

# Caddy certs.
docker run --rm -v nentang-prod_caddy_data:/d:ro -w /d alpine tar czf - . > "$DEST/caddy_data.tar.gz" 2>/dev/null && ok "caddy_data (chứng chỉ)" || warn "caddy_data backup lỗi"

# MÃ HOÁ mọi artifact TRƯỚC khi rời máy (chỉ còn *.enc trong $DEST khi đẩy offsite).
for f in "$DEST"/*; do [ -f "$f" ] && encrypt_file "$f"; done
offsite "$DEST"

# Retention: backup cục bộ + WAL archive (postgres KHÔNG tự dọn → đầy đĩa nếu bỏ mặc).
find "$BACKUP_DIR" -maxdepth 1 -type d -name '20*' -mtime +"$RET" -exec rm -rf {} + 2>/dev/null || true
# CHỈ prune WAL khi base backup lần này THÀNH CÔNG — nếu base lỗi mà vẫn xoá WAL cũ thì
# mất luôn khả năng PITR (không base mới + không WAL cũ). base lỗi → giữ WAL, để lần sau.
if [ "$base_ok" = 1 ]; then
  $C exec -T postgres sh -c "find /wal-archive -type f -mtime +$RET -delete" 2>/dev/null || true
else
  warn "base backup lỗi → GIỮ nguyên WAL archive (không prune) để không mất PITR"
fi
printf '%s✔ BACKUP xong%s: %s\n' "$GRN" "$RST" "$DEST"

# DEAD-MAN'S SWITCH: ping dịch vụ giám sát (healthchecks.io...) khi backup CHẠY XONG. Nếu
# cron backup NGỪNG chạy (VPS chết/crontab hỏng) → không có ping → dịch vụ ngoài báo động.
if [ -n "${HEALTHCHECK_PING_URL:-}" ]; then
  curl -fsS -m 10 --retry 3 "$HEALTHCHECK_PING_URL" >/dev/null 2>&1 && ok "đã ping giám sát backup" || warn "ping giám sát backup lỗi"
fi
