#!/usr/bin/env bash
#
# Mutation testing cho bộ e2e seller-admin (RBAC + step-up + tenant).
#
#   bash scripts/verify-seller.sh [tên...]
#
# Gỡ từng lớp phòng thủ (ở seller VÀ auth), khẳng định e2e chuyển đỏ. Hoàn nguyên.
# e2e ~60s (một lần chờ TOTP cho nhân viên nền tảng). Toàn bộ vài phút.

set -uo pipefail
export MSYS_NO_PATHCONV=1

COMPOSE="docker compose -f infra/compose.dev.yml"
SSRC=apps/seller/src
ASRC=apps/auth/src
BAK="$(mktemp -d)"
pass=0; fail=0
RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'

ok()   { pass=$((pass+1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad()  { fail=$((fail+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; return 0; }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cp "$SSRC/server.js" "$BAK/seller.js"
cp "$SSRC/db.js" "$BAK/seller-db.js"
cp "$ASRC/server.js" "$BAK/auth.js"
restore() { cp "$BAK/seller.js" "$SSRC/server.js"; cp "$BAK/seller-db.js" "$SSRC/db.js"; cp "$BAK/auth.js" "$ASRC/server.js"; }
trap 'restore; rm -rf "$BAK"' EXIT INT TERM

wait_svc() {
  local svc="$1" port="$2"
  for _ in $(seq 30); do
    if $COMPOSE exec -T "$svc" node -e "fetch('http://127.0.0.1:$port/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
restart() { $COMPOSE restart "$1" >/dev/null 2>&1; wait_svc "$1" "$2"; }
run_e2e() {
  $COMPOSE exec -T redis redis-cli flushall >/dev/null 2>&1
  $COMPOSE exec -T dbtest node apps/seller/test/e2e.mjs >/dev/null 2>&1
}

FILTER="${*:-}"

mutate() {
  local name="$1" svc="$2" port="$3" desc="$4" patch="$5"
  if [ -n "$FILTER" ] && ! grep -qw "$name" <<<"$FILTER"; then return 0; fi
  restore
  eval "$patch"
  if diff -q "$BAK/seller.js" "$SSRC/server.js" >/dev/null && diff -q "$BAK/seller-db.js" "$SSRC/db.js" >/dev/null && diff -q "$BAK/auth.js" "$ASRC/server.js" >/dev/null; then
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
restart seller 3040
run_e2e && ok "e2e xanh khi mọi lớp phòng thủ còn nguyên" || { bad "e2e đã đỏ từ đầu"; exit 1; }

sect "1. Gỡ từng lớp phòng thủ"

mutate rbac seller 3040 "tắt kiểm tra RBAC (mọi vai trò làm mọi thứ)" \
  "sed -i 's|if (route.perm \&\& !can(role, route.perm)) {|if (false) {|' $SSRC/server.js"

mutate stepup seller 3040 "tắt yêu cầu step-up" \
  "sed -i 's|if (route.stepUp \&\& !steppedUpRecently(user)) {|if (false) {|' $SSRC/server.js"

mutate member seller 3040 "tắt kiểm tra thành viên (cô lập tầng dịch vụ)" \
  "sed -i \"s|if (!membership) return send(res, 404, { error: 'không tìm thấy' });|if (false) return;|\" $SSRC/server.js"

# withTenant (set_config app.shop_id) sống trong db.js (tách từ Ngày 8), KHÔNG ở server.js.
mutate tenant seller 3040 "đặt sai tenant context (RLS mất cô lập app_rw)" \
  "sed -i \"s|set_config('app.shop_id'|set_config('app.nothing'|\" $SSRC/db.js"

mutate lastowner seller 3040 "bỏ chặn owner-cuối-cùng" \
  "sed -i 's|if (rows\[0\].n <= 1) return { code: 409 };|if (false) return { code: 409 };|' $SSRC/server.js"

mutate stepupauth auth 3020 "step-up chấp nhận mật khẩu sai" \
  "sed -i 's|const ok = await verifyPassword(rows\[0\]?.password_hash ?? DUMMY_HASH, password);|const ok = true;|' $ASRC/server.js"

sect "2. Trạng thái sau khi hoàn nguyên"
restore
restart seller 3040
restart auth 3020
run_e2e && ok "e2e xanh trở lại — mọi mutation đã gỡ" || bad "e2e còn đỏ — chưa hoàn nguyên đúng!"

printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
