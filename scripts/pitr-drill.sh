#!/usr/bin/env bash
#
# Diễn tập PITR (Point-In-Time Recovery) — chứng minh khôi phục tới MỘT THỜI ĐIỂM (RPO),
# thứ mà pg_dumpall (logical) KHÔNG chứng minh được. Dùng postgres:16-alpine throwaway
# với đúng cấu hình archive_mode như infra/compose.prod.yml. Không đụng stack đang chạy.
#
#   bash scripts/pitr-drill.sh
#
# Kịch bản: base backup (DB trống) → ghi 'before' → mốc T1 → ghi 'after' → chuyển WAL.
# Khôi phục base + replay WAL TỚI T1 → phải thấy 'before', KHÔNG thấy 'after'.

set -uo pipefail
export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"
export MSYS_NO_PATHCONV=1

IMG=postgres:16-alpine
SRC=nentang-pitr-src
DST=nentang-pitr-dst
VWAL=nentang-pitr-wal
VBASE=nentang-pitr-base
pass=0; fail=0
GRN=$'\033[32m'; RED=$'\033[31m'; DIM=$'\033[2m'; RST=$'\033[0m'
ok()  { pass=$((pass+1)); printf '  %s✔%s %s\n' "$GRN" "$RST" "$1"; }
bad() { fail=$((fail+1)); printf '  %s✖%s %s\n' "$RED" "$RST" "$1"; [ $# -gt 1 ] && printf '     %s%s%s\n' "$DIM" "$2" "$RST"; }
sect(){ printf '\n\033[1m%s\033[0m\n' "$1"; }
cleanup(){ docker rm -f "$SRC" "$DST" >/dev/null 2>&1; docker volume rm -f "$VWAL" "$VBASE" >/dev/null 2>&1; }
trap cleanup EXIT INT TERM
cleanup
psrc(){ docker exec "$SRC" psql -U postgres -d postgres -tAc "$1" 2>/dev/null | tr -d '\r'; }
pdst(){ docker exec "$DST" psql -U postgres -d postgres -tAc "$1" 2>/dev/null | tr -d '\r'; }

sect "1. Postgres NGUỒN với archive_mode (giống prod)"
docker volume create "$VWAL" >/dev/null; docker volume create "$VBASE" >/dev/null
# Volume mới thuộc root; tiến trình postgres chạy uid 70 → phải chown để archive_command
# (uid 70) ghi được /wal-archive và để server đích dùng được /pgbase.
docker run --rm -v "$VWAL":/w -v "$VBASE":/b "$IMG" chown -R postgres:postgres /w /b >/dev/null 2>&1
docker run -d --name "$SRC" -e POSTGRES_PASSWORD=x -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$VWAL":/wal-archive -v "$VBASE":/pgbase "$IMG" \
  postgres -c wal_level=replica -c archive_mode=on \
    -c "archive_command=test ! -f /wal-archive/%f && cp %p /wal-archive/%f" -c max_wal_senders=3 >/dev/null
for _ in $(seq 30); do docker exec "$SRC" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
docker exec "$SRC" pg_isready -U postgres >/dev/null 2>&1 && ok "nguồn sẵn sàng, archive bật" || { bad "nguồn không lên"; exit 1; }

sect "2. Base backup (DB TRỐNG — nền để replay tới)"
docker exec -u postgres "$SRC" pg_basebackup -U postgres -D /pgbase -Fp -Xf >/dev/null 2>&1 \
  && [ -n "$(docker exec "$SRC" sh -c 'ls /pgbase/PG_VERSION 2>/dev/null')" ] \
  && ok "base backup xong" || { bad "pg_basebackup lỗi (kiểm replication/pg_hba)"; exit 1; }

sect "3. Ghi dữ liệu quanh mốc thời gian T1"
psrc "CREATE TABLE t(id serial primary key, tag text, at timestamptz default clock_timestamp())" >/dev/null
psrc "INSERT INTO t(tag) VALUES ('before')" >/dev/null
sleep 2
T1="$(psrc 'SELECT now()')"
sleep 2
psrc "INSERT INTO t(tag) VALUES ('after')" >/dev/null
psrc "SELECT pg_switch_wal()" >/dev/null   # ép segment chứa before+after vào archive
psrc "CHECKPOINT" >/dev/null
sleep 3                                     # chờ archive_command copy
echo "  T1 = $T1 ; nguồn hiện có: [$(psrc "SELECT string_agg(tag,',' ORDER BY id) FROM t")]"
[ "$(docker exec "$SRC" sh -c 'ls /wal-archive | wc -l')" -ge 1 ] && ok "WAL đã vào archive" || bad "archive rỗng"

sect "4. Khôi phục base + replay TỚI T1 (recovery_target_time)"
docker run --rm -v "$VBASE":/pgbase alpine sh -c "
  printf \"restore_command = 'cp /wal-archive/%%f %%p'\nrecovery_target_time = '$T1'\nrecovery_target_action = 'promote'\n\" >> /pgbase/postgresql.auto.conf
  touch /pgbase/recovery.signal
  rm -f /pgbase/postmaster.pid" >/dev/null 2>&1
docker run -d --name "$DST" -e POSTGRES_PASSWORD=x -e PGDATA=/pgbase \
  -v "$VBASE":/pgbase -v "$VWAL":/wal-archive "$IMG" >/dev/null
for _ in $(seq 40); do
  docker exec "$DST" pg_isready -U postgres >/dev/null 2>&1 && [ "$(pdst 'SELECT pg_is_in_recovery()')" = "f" ] && break
  sleep 1
done
[ "$(pdst 'SELECT 1')" = "1" ] && ok "đích khôi phục xong, đã promote (hết recovery)" || { bad "đích không lên/không thoát recovery" "$(docker logs "$DST" 2>&1 | tail -4)"; }

sect "5. Kiểm chứng RPO: đúng trạng thái TẠI T1"
GOT="$(pdst "SELECT string_agg(tag,',' ORDER BY id) FROM t")"
echo "  đích sau PITR: [$GOT]"
[ "$GOT" = "before" ] && ok "PITR tới T1 CHÍNH XÁC: có 'before', KHÔNG có 'after'" \
  || bad "PITR sai điểm" "mong [before], nhận [$GOT]"

printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] && printf '%sPITR DRILL: ĐẠT — khôi phục tới thời điểm hoạt động (RPO chứng minh được)%s\n' "$GRN" "$RST" || printf '%sPITR DRILL: KHÔNG ĐẠT%s\n' "$RED" "$RST"
[ "$fail" -eq 0 ]
