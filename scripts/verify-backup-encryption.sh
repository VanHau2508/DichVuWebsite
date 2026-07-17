#!/usr/bin/env bash
#
# Kiểm chứng ĐƯỜNG MÃ HOÁ BACKUP THẬT (re-audit #17). Khác backup-restore-drill.sh (tự
# pg_dumpall, không đụng mã hoá): script này chạy CHÍNH scripts/backup.sh trên stack dev
# (BACKUP_COMPOSE_FILE=infra/compose.dev.yml) rồi chứng minh từng mắt xích:
#   1. Mọi artifact rời máy là *.enc — KHÔNG còn plaintext (khác rỗng) trong thư mục đích.
#   2. .enc THẬT SỰ mã hoá: header OpenSSL "Salted__", không phải gzip trá hình,
#      giải mã bằng KHOÁ SAI phải THẤT BẠI (không "mã hoá vờ").
#   3. Khoá đúng → giải mã được → gzip hợp lệ → đúng pg_dumpall.
#   4. Restore vào postgres MỚI (container drill) → dòng marker đã gieo SỐNG SÓT.
#   5. redis.rdb.enc có mặt + giải mã ra RDB thật (magic "REDIS").
# CI tự nhặt qua glob verify-*.sh (bước mutation) — exit ≠ 0 khi bất kỳ mắt xích gãy.
#
#   bash scripts/verify-backup-encryption.sh

set -uo pipefail
export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

COMPOSE="docker compose -f infra/compose.dev.yml"
# Thư mục làm việc TƯƠNG ĐỐI (không /tmp): trên Windows Git Bash, MSYS_NO_PATHCONV=1 (cần
# cho docker) làm openssl.exe KHÔNG mở được đường dẫn POSIX tuyệt đối (/tmp/...) — đường
# dẫn tương đối thì mọi nền (Linux CI + Windows dev) đều mở được.
TMP=".tmp-encdrill-$$"; mkdir -p "$TMP"
FRESH="nentang-encdrill"
pass=0; fail=0
RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'
ok()   { pass=$((pass+1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad()  { fail=$((fail+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; [ $# -gt 1 ] && printf '       %s%s%s\n' "$DIM" "$2" "$RST"; return 0; }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }
cleanup() {
  docker rm -f "$FRESH" >/dev/null 2>&1 || true
  $COMPOSE exec -T postgres psql -U app_owner -d app -c 'DROP TABLE IF EXISTS backup_enc_drill' >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

q_main()  { $COMPOSE exec -T postgres psql -U app_owner -d app -tAc "$1" 2>/dev/null | tr -d '\r'; }
q_fresh() { docker exec "$FRESH" psql -U postgres -d app -tAc "$1" 2>/dev/null | tr -d '\r'; }
# Giải mã đúng cách restore.sh làm (CÙNG tham số openssl với encrypt_file trong backup.sh).
dec() { BACKUP_ENC_KEY="$1" openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_ENC_KEY -in "$2" -out "$3" 2>/dev/null; }

sect "0. Điều kiện + gieo marker"
$COMPOSE ps --status running --quiet postgres | grep -q . || { echo "postgres chưa chạy: $COMPOSE up -d" >&2; exit 1; }
MARK="drill-$(date +%s)-$RANDOM"
$COMPOSE exec -T postgres psql -U app_owner -d app -q \
  -c "CREATE TABLE IF NOT EXISTS backup_enc_drill(token text)" \
  -c "INSERT INTO backup_enc_drill VALUES ('$MARK')" >/dev/null 2>&1
[ "$(q_main "SELECT count(*) FROM backup_enc_drill WHERE token='$MARK'")" = "1" ] \
  && ok "gieo marker vào DB nguồn ($MARK)" || { bad "không gieo được marker"; exit 1; }
POLICIES0="$(q_main 'SELECT count(*) FROM pg_policies')"

sect "1. Chạy CHÍNH scripts/backup.sh (khoá thật, local-only opt-in)"
KEY_GOOD="$(openssl rand -base64 32)"
KEY_BAD="$(openssl rand -base64 32)"
if BACKUP_COMPOSE_FILE=infra/compose.dev.yml BACKUP_DIR="$TMP/bk" \
   BACKUP_ENC_KEY="$KEY_GOOD" ALLOW_LOCAL_ONLY_BACKUP=1 \
   bash scripts/backup.sh > "$TMP/backup.log" 2>&1; then
  ok "backup.sh chạy xong (exit 0)"
else
  bad "backup.sh exit ≠ 0" "$(tail -5 "$TMP/backup.log" | tr '\n' ' ')"; exit 1
fi
DEST="$(find "$TMP/bk" -maxdepth 1 -type d -name '20*' | head -1)"
[ -n "$DEST" ] && ok "có thư mục backup: $(basename "$DEST")" || { bad "không thấy thư mục backup"; exit 1; }

sect "2. Artifact ĐÃ mã hoá thật (không plaintext, không gzip trá hình, khoá sai fail)"
LEFT="$(find "$DEST" -maxdepth 1 -type f ! -name '*.enc' -size +1c | tr -d '\r')"
[ -z "$LEFT" ] && ok "KHÔNG còn plaintext (khác rỗng) trong thư mục đích" || bad "còn file chưa mã hoá" "$LEFT"
ENC="$DEST/logical.sql.gz.enc"
[ -s "$ENC" ] && ok "có logical.sql.gz.enc" || { bad "thiếu logical.sql.gz.enc" "$(ls "$DEST")"; exit 1; }
[ "$(head -c 8 "$ENC")" = "Salted__" ] && ok 'header OpenSSL "Salted__" (salt ngẫu nhiên mỗi file)' || bad "thiếu header Salted__ — không phải định dạng openssl enc"
gzip -t "$ENC" 2>/dev/null && bad "file .enc vẫn là gzip đọc được — MÃ HOÁ VỜ" || ok "file .enc KHÔNG đọc được như gzip (nội dung đã biến đổi)"
dec "$KEY_BAD" "$ENC" "$TMP/wrong.gz" && bad "khoá SAI vẫn giải mã được — LỖ HỔNG" || ok "khoá SAI → giải mã THẤT BẠI (đúng kỳ vọng)"

sect "3. Khoá đúng → giải mã + kiểm dump"
dec "$KEY_GOOD" "$ENC" "$TMP/logical.sql.gz" && ok "giải mã bằng khoá đúng OK" || { bad "khoá đúng không giải mã được"; exit 1; }
gzip -t "$TMP/logical.sql.gz" && ok "gzip hợp lệ sau giải mã" || { bad "gzip hỏng sau giải mã"; exit 1; }
gzip -dc "$TMP/logical.sql.gz" > "$TMP/logical.sql"
head -c 300 "$TMP/logical.sql" | grep -qiE 'PostgreSQL database (cluster )?dump' \
  && ok "nội dung đúng pg_dumpall ($(wc -c <"$TMP/logical.sql" | tr -d ' ') byte)" || bad "nội dung không giống pg_dumpall"

sect "4. Restore vào postgres MỚI → marker sống sót"
docker rm -f "$FRESH" >/dev/null 2>&1 || true
docker run -d --name "$FRESH" -e POSTGRES_PASSWORD=x -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine >/dev/null
for _ in $(seq 30); do docker exec "$FRESH" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
docker exec "$FRESH" pg_isready -U postgres >/dev/null 2>&1 && ok "postgres drill sẵn sàng" || { bad "postgres drill không lên"; exit 1; }
docker exec -i "$FRESH" psql -U postgres -q >"$TMP/restore.log" 2>&1 < "$TMP/logical.sql" || true
[ "$(q_fresh "SELECT count(*) FROM backup_enc_drill WHERE token='$MARK'")" = "1" ] \
  && ok "dòng marker SỐNG SÓT qua mã hoá → giải mã → restore" || bad "marker mất sau restore" "$(tail -3 "$TMP/restore.log" | tr '\n' ' ')"
POLICIES1="$(q_fresh 'SELECT count(*) FROM pg_policies')"
[ "$POLICIES1" = "$POLICIES0" ] && ok "RLS policies khớp ($POLICIES1)" || bad "policies lệch: $POLICIES0 → $POLICIES1"

sect "5. Redis snapshot có mặt + giải mã ra RDB thật"
RENC="$DEST/redis.rdb.enc"
[ -s "$RENC" ] && ok "có redis.rdb.enc" || bad "thiếu redis.rdb.enc" "$(ls "$DEST")"
if [ -s "$RENC" ]; then
  dec "$KEY_GOOD" "$RENC" "$TMP/dump.rdb" && ok "giải mã redis.rdb OK" || bad "không giải mã được redis.rdb.enc"
  [ "$(head -c 5 "$TMP/dump.rdb" 2>/dev/null)" = "REDIS" ] && ok 'magic "REDIS" đúng (RDB thật)' || bad "file giải mã không phải RDB"
fi

printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] && printf '%sVERIFY BACKUP ENCRYPTION: ĐẠT — đường mã hoá backup end-to-end hoạt động%s\n' "$GREEN" "$RST" \
                  || printf '%sVERIFY BACKUP ENCRYPTION: KHÔNG ĐẠT%s\n' "$RED" "$RST"
[ "$fail" -eq 0 ]
