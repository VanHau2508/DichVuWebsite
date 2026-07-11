#!/usr/bin/env bash
#
# Mutation testing cho bộ e2e onboarding (platform).
#
#   bash scripts/verify-platform.sh [tên...]
#
# Gỡ từng lớp phòng thủ của luồng onboarding (ở dịch vụ platform VÀ auth) và
# khẳng định bộ e2e chuyển sang đỏ. Mọi mutation đều hoàn nguyên.
#
# e2e chạy ~60s (MFA chờ bước thời gian). Toàn bộ vài phút.

set -uo pipefail
export MSYS_NO_PATHCONV=1

COMPOSE="docker compose -f infra/compose.dev.yml"
PSRC=apps/platform/src
ASRC=apps/auth/src
BAK="$(mktemp -d)"
pass=0; fail=0
RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'

ok()   { pass=$((pass+1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad()  { fail=$((fail+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; return 0; }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cp "$PSRC/server.js" "$BAK/platform.js"
cp "$ASRC/server.js" "$BAK/auth.js"
restore() { cp "$BAK/platform.js" "$PSRC/server.js"; cp "$BAK/auth.js" "$ASRC/server.js"; }
trap 'restore; rm -rf "$BAK"' EXIT INT TERM

wait_svc() {
  local svc="$1" port="$2"
  for _ in $(seq 30); do
    if $COMPOSE exec -T "$svc" node -e "fetch('http://127.0.0.1:$port/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}
restart() { $COMPOSE restart "$1" >/dev/null 2>&1; wait_svc "$1" "$2"; }
# Flush redis trước mỗi lần: rate-limit đăng nhập tích luỹ qua nhiều lần chạy từ
# cùng IP container sẽ làm e2e đỏ vì 429 — nhiễu, không phải do mutation.
run_e2e() {
  $COMPOSE exec -T redis redis-cli flushall >/dev/null 2>&1
  $COMPOSE exec -T dbtest node apps/platform/test/e2e.mjs >/dev/null 2>&1
}

FILTER="${*:-}"

# mutate <tên> <svc> <port> <mô tả> <sed>
mutate() {
  local name="$1" svc="$2" port="$3" desc="$4" patch="$5"
  if [ -n "$FILTER" ] && ! grep -qw "$name" <<<"$FILTER"; then return 0; fi

  restore
  eval "$patch"
  if diff -q "$BAK/platform.js" "$PSRC/server.js" >/dev/null && diff -q "$BAK/auth.js" "$ASRC/server.js" >/dev/null; then
    bad "$desc — patch không đổi gì (anchor sai)"; return
  fi
  if ! restart "$svc" "$port"; then bad "$desc — $svc không khởi động lại"; restore; restart "$svc" "$port"; return; fi

  if run_e2e; then
    bad "$desc → e2e VẪN XANH. Lớp phòng thủ này không được bảo vệ."
  else
    ok "$desc → e2e chuyển sang đỏ"
  fi
  restore
  restart "$svc" "$port"
}

sect "0. Trạng thái ban đầu"
restart platform 3030
run_e2e && ok "e2e xanh khi mọi lớp phòng thủ còn nguyên" \
        || { bad "e2e đã đỏ từ đầu"; exit 1; }

sect "1. Gỡ từng lớp phòng thủ onboarding"

mutate staffcheck platform 3030 "tắt kiểm tra platform_staff" \
  "sed -i 's|if (rows.length === 0) {|if (false) {|' $PSRC/server.js"

mutate mfacheck platform 3030 "tắt yêu cầu MFA cho nhân viên nền tảng" \
  "sed -i 's|if (!me.mfa_enabled) {|if (false) {|' $PSRC/server.js"

mutate csrf platform 3030 "tắt kiểm tra Origin (CSRF)" \
  "sed -i 's|if (!originAllowed(req, ALLOWED_ORIGINS)) return send(res, 403, { error: .origin không được phép. });|if (false) {}|' $PSRC/server.js"

mutate suspend platform 3030 "suspend cho phép ở mọi trạng thái (bỏ điều kiện)" \
  "sed -i \"s|AND status IN ('onboarding','active') AND deleted_at IS NULL|AND deleted_at IS NULL|\" $PSRC/server.js"

mutate invonce auth 3020 "lời mời dùng được nhiều lần (bỏ claim atomic)" \
  "sed -i 's|if (claimed.rowCount !== 1) {|if (false) {|' $ASRC/server.js"

sect "2. Trạng thái sau khi hoàn nguyên"
restore
restart platform 3030
restart auth 3020
run_e2e && ok "e2e xanh trở lại — mọi mutation đã gỡ" \
        || bad "e2e còn đỏ — chưa hoàn nguyên đúng!"

printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
