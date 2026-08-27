#!/usr/bin/env bash
#
# CỔNG MIGRATION TỪ DB TRẮNG — bản DUY NHẤT, dùng chung cho ci-local.sh và GitHub CI.
#
# VÌ SAO CÓ FILE NÀY. `ci-local.sh` chưa bao giờ chạy `migrate`. Nó chỉ kiểm container còn
# sống rồi chạy test trên DB dev ĐÃ áp migration từ trước. Nghĩa là mọi kết luận "112/112
# xanh" không nói gì về việc một máy TRẮNG có dựng nổi schema hay không — và đó chính là
# thứ production làm mỗi lần deploy.
#
# Lớp lỗi đã đo được, cả hai đều VÔ HÌNH với cổng cũ:
#   · runner lặp theo FILE, nên một version nằm trong `schema_migrations` mà mất file thì
#     bị bỏ qua IM LẶNG. Dev có thay đổi đó, máy trắng thì không. Không lỗi nào hiện ra.
#   · `0173` phát hiện `app_rw` đã có UPDATE cấp BẢNG trên `orders` từ `0021`, nên column
#     GRANT không chặn được nó. Chuyện đó chỉ lộ ra khi chạy migration trên DB trắng.
#
# HỢP ĐỒNG. Gate này trả 0 KHI VÀ CHỈ KHI, trên một PostgreSQL hoàn toàn trắng:
#   1. `migrate.js up` đi từ 0001 tới file cuối cùng mà không lỗi;
#   2. số migration đã áp = số FILE = baseline khai trong scripts/test-manifest.sh;
#   3. 0 DRIFT, 0 pending;
#   4. đếm từ phía DB (`SELECT count(*) FROM schema_migrations`) khớp cùng con số đó.
#
# Điểm 4 KHÔNG thừa: `migrate.js status` chỉ duyệt file nên nó mù với dòng thừa trong
# schema_migrations. Đếm từ hai phía là cách duy nhất bịt cả hai chiều.
#
# BASELINE ĐẾM THEO FILE, KHÔNG THEO SỐ THỨ TỰ. Hôm nay là 179 file trong khi file mới
# nhất mang số 0181 — dãy có khoảng trống (0157 chẳng hạn). Suy số lượng từ số thứ tự là
# sai ngay từ hôm nay.
#
# CÁCH DÙNG
#   bash scripts/fresh-migration-gate.sh          # im lặng khi xanh
#   FRESH_GATE_VERBOSE=1 bash scripts/...         # in từng bước
#
# CÔ LẬP. Mỗi lượt tự dựng project Compose RIÊNG, tên có PID + thời gian + ngẫu nhiên, và
# volume riêng theo project. Nó KHÔNG chạm project dev, không chạm DB dev (~7.000 shop),
# không dùng tên cố định nên hai lượt CI song song không giẫm nhau. Dọn bằng trap ở mọi
# đường thoát: xanh, đỏ, hay Ctrl-C.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/test-manifest.sh
. scripts/test-manifest.sh

COMPOSE_FILE="infra/compose.dev.yml"
# Tên project phải DUY NHẤT mỗi lượt: PID + epoch + 4 ký tự ngẫu nhiên. Tên cố định kiểu
# `nentang-migcheck` là hẹn giờ cho hai lượt CI song song xoá volume của nhau.
PROJECT="nentang-fresh-$$-$(date +%s)-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-4)"
TIMEOUT_HEALTH=${FRESH_GATE_HEALTH_TIMEOUT:-120}   # giây chờ postgres healthy
TIMEOUT_MIGRATE=${FRESH_GATE_MIGRATE_TIMEOUT:-600} # giây chờ migrate chạy xong

GRN=$'\033[32m'; RED=$'\033[31m'; DIM=$'\033[2m'; RST=$'\033[0m'
# Dùng `if` chứ không `[ … ] && printf … || true`: dưới `set -e` dạng kia cần `|| true` để
# không tự huỷ script khi điều kiện sai, mà mọi `|| true` trong file này đều bị chốt
# release-gates soi. Bớt một ngoại lệ tốt hơn nới chốt.
say()  { if [ "${FRESH_GATE_VERBOSE:-0}" = "1" ]; then printf '  %s%s%s\n' "$DIM" "$*" "$RST"; fi; }
die()  { printf '  %sFRESH-MIGRATION GATE ĐỎ%s — %s\n' "$RED" "$RST" "$*" >&2; exit 1; }

dc() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }

# Dọn ở MỌI đường thoát. `down -v` chỉ xoá volume CỦA PROJECT NÀY — tên project là duy nhất
# nên không có đường nào chạm pgdata của dev. Giữ mã thoát gốc để không nuốt lỗi.
cleanup() {
  local rc=$?
  say "dọn project $PROJECT"
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT INT TERM

# Phân biệt "không có docker" với "có CLI nhưng daemon chết": hai nguyên nhân, hai cách sửa.
# Gộp thành một câu là bắt người đọc đoán — và câu đoán sai đầu tiên thường là "compose hỏng".
command -v docker >/dev/null 2>&1 \
  || die "không có docker — gate này BẮT BUỘC chạy thật, không được bỏ qua"
docker info >/dev/null 2>&1 \
  || die "docker CLI có nhưng KHÔNG kết nối được daemon — bật Docker rồi chạy lại; gate không được bỏ qua"

# ── 1. PostgreSQL trắng ──────────────────────────────────────────────────────
say "dựng postgres trắng (project $PROJECT)"
dc up -d postgres >/dev/null 2>&1 || die "không dựng được postgres"

# Health check THẬT thay vì `sleep 20`: máy chậm thì sleep ngắn quá hoá đỏ giả, máy nhanh
# thì sleep dài phí thời gian mỗi lượt.
waited=0
until dc exec -T postgres pg_isready -U app_owner -d app >/dev/null 2>&1; do
  waited=$((waited + 2)); sleep 2
  [ "$waited" -lt "$TIMEOUT_HEALTH" ] || die "postgres không healthy sau ${TIMEOUT_HEALTH}s"
done
say "postgres healthy sau ${waited}s"

# DB phải TRẮNG THẬT: nếu schema_migrations đã có dòng thì volume không sạch và mọi kết
# luận bên dưới vô nghĩa.
pre=$(dc exec -T postgres psql -U app_owner -d app -qtA \
      -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null | tr -d '\r ')
[ "$pre" = "0" ] || die "DB không trắng (đã có $pre bảng trong schema public) — volume bị tái dùng"

# ── 2. Đúng đường production ─────────────────────────────────────────────────
# Ghi đè command để BỎ `--seed`: compose.dev gắn sẵn 900_seed_dev.sql, mà gate này phải
# chứng minh riêng chuỗi migration dựng nổi schema. Cùng image, cùng runner, cùng biến môi
# trường như compose.prod — chỉ khác đúng chỗ bỏ seed.
say "chạy migrate.js up (không seed)"
if ! timeout "$TIMEOUT_MIGRATE" env COMPOSE_PROJECT_NAME="$PROJECT" \
     docker compose -p "$PROJECT" -f "$COMPOSE_FILE" run --rm --no-deps \
     migrate node migrate.js up > /tmp/fresh-migrate-$$.log 2>&1; then
  printf '  %sFRESH-MIGRATION GATE ĐỎ%s — migrate.js up thất bại:\n' "$RED" "$RST" >&2
  # In nguyên log: runner đã tự nêu tên migration lỗi (`migration <version> thất bại: …`).
  # KHÔNG in biến môi trường / DATABASE_URL_OWNER — chuỗi đó chứa mật khẩu.
  grep -vE 'DATABASE_URL|password|PASSWORD' /tmp/fresh-migrate-$$.log | tail -40 >&2
  rm -f /tmp/fresh-migrate-$$.log
  exit 1
fi
rm -f /tmp/fresh-migrate-$$.log

# ── 3. Xác minh ba chiều ─────────────────────────────────────────────────────
status_log=$(timeout "$TIMEOUT_MIGRATE" docker compose -p "$PROJECT" -f "$COMPOSE_FILE" \
             run --rm --no-deps migrate node migrate.js status 2>&1) \
  || die "migrate.js status không chạy được"

n_files=$(ls -1 packages/db/migrations/*.sql 2>/dev/null | wc -l | tr -d ' ')
n_applied=$(grep -c '"state":"applied"' <<<"$status_log" || true)
n_drift=$(grep -c '"state":"DRIFT"' <<<"$status_log" || true)
n_pending=$(grep -c '"state":"PENDING"' <<<"$status_log" || true)
n_db=$(dc exec -T postgres psql -U app_owner -d app -qtA \
       -c 'SELECT count(*) FROM schema_migrations' 2>/dev/null | tr -d '\r ')

[ "$n_drift"   = "0" ] || { grep '"state":"DRIFT"' <<<"$status_log" >&2; die "$n_drift migration DRIFT"; }
[ "$n_pending" = "0" ] || { grep '"state":"PENDING"' <<<"$status_log" >&2; die "$n_pending migration PENDING"; }

# So BẰNG với baseline khai trong test-manifest.sh — cùng kỷ luật với MANIFEST_*_COUNT:
# thêm migration thì phải sửa số trong CÙNG commit, và người review thấy con số đổi.
[ "$n_files" = "$MANIFEST_MIGRATION_COUNT" ] \
  || die "có $n_files file migration, khai báo $MANIFEST_MIGRATION_COUNT → sửa MANIFEST_MIGRATION_COUNT=$n_files trong scripts/test-manifest.sh (cùng commit)"
[ "$n_applied" = "$n_files" ] \
  || die "áp $n_applied / $n_files file"
# Đếm từ PHÍA DB. `status` chỉ duyệt file nên nó mù với dòng thừa trong schema_migrations;
# hai phía khớp nhau mới loại được cả hai chiều.
[ "$n_db" = "$n_files" ] \
  || die "schema_migrations có $n_db dòng nhưng chỉ có $n_files file — có dòng không còn file tương ứng"

printf '  %sPASS%s fresh-migration: %s migration áp từ DB trắng, 0 DRIFT, 0 pending\n' \
  "$GRN" "$RST" "$n_applied"
