#!/usr/bin/env bash
#
# Mutation testing cho bộ e2e auth.
#
#   bash scripts/verify-auth.sh            # chạy tất cả mutation
#   bash scripts/verify-auth.sh csrf reset # chỉ chạy mutation được nêu tên
#
# Gỡ từng lớp phòng thủ của dịch vụ auth, một lần một lớp, và khẳng định bộ e2e
# CHUYỂN SANG ĐỎ. Lớp nào gỡ đi mà e2e vẫn xanh thì lớp đó không được test nào
# canh gác — ta sẽ không biết khi nó bị phá vỡ thật.
#
# Mọi mutation đều được hoàn nguyên, kể cả khi script bị ngắt giữa chừng.
#
# e2e mất ~40s (TOTP buộc phải chờ sang bước thời gian mới), nên toàn bộ script
# chạy vài phút. Đó là cái giá của việc kiểm chứng thật thay vì tin tưởng.

set -uo pipefail
export MSYS_NO_PATHCONV=1

COMPOSE="docker compose -f infra/compose.dev.yml"
SRC=apps/auth/src
BAK="$(mktemp -d)"
pass=0; fail=0
RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'

ok()   { pass=$((pass+1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad()  { fail=$((fail+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; return 0; }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cp "$SRC/server.js" "$BAK/server.js"
cp "$SRC/http.js"   "$BAK/http.js"

restore() {
  cp "$BAK/server.js" "$SRC/server.js"
  cp "$BAK/http.js"   "$SRC/http.js"
}
cleanup() { restore; rm -rf "$BAK"; }
trap 'cleanup' EXIT INT TERM

restart_auth() {
  $COMPOSE restart auth >/dev/null 2>&1
  for _ in $(seq 30); do
    if $COMPOSE exec -T auth node -e "fetch('http://127.0.0.1:3020/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

run_e2e() { $COMPOSE exec -T auth node apps/auth/test/e2e.mjs >/dev/null 2>&1; }

# mutate <tên> <mô tả> <lệnh sed>
mutate() {
  local name="$1" desc="$2" patch="$3"

  if [ -n "$FILTER" ] && ! grep -qw "$name" <<<"$FILTER"; then return 0; fi

  restore
  if ! eval "$patch"; then bad "$desc — không áp dụng được mutation"; return; fi

  # Nếu patch không đổi gì (anchor sai), mutation là giả → phải phát hiện.
  if diff -q "$BAK/server.js" "$SRC/server.js" >/dev/null 2>&1 \
     && diff -q "$BAK/http.js" "$SRC/http.js" >/dev/null 2>&1; then
    bad "$desc — patch KHÔNG đổi gì (anchor sai), mutation vô nghĩa"
    return
  fi

  if ! restart_auth; then bad "$desc — auth không khởi động lại được"; restore; restart_auth; return; fi

  if run_e2e; then
    bad "$desc → e2e VẪN XANH. Lớp phòng thủ này không được test nào bảo vệ."
  else
    ok "$desc → e2e chuyển sang đỏ"
  fi

  restore
  restart_auth
}

FILTER="${*:-}"

# ─────────────────────────────────────────────────────────────────────────────
sect "0. Trạng thái ban đầu"
restart_auth || { bad "auth không khởi động"; exit 1; }
run_e2e && ok "e2e xanh khi mọi lớp phòng thủ còn nguyên" \
        || { bad "e2e đã đỏ từ đầu — sửa trước khi chạy mutation"; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
sect "1. Gỡ từng lớp phòng thủ của dịch vụ auth"

mutate csrf "tắt kiểm tra Origin (CSRF)" \
  "sed -i 's|if (!originAllowed(req, ALLOWED_ORIGINS)) {|if (false) {|' $SRC/server.js"

mutate cookie "bỏ Secure + HttpOnly khỏi cookie phiên" \
  "sed -i 's|; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=\${maxAgeSec}|; Path=/; SameSite=Lax; Max-Age=\${maxAgeSec}|' $SRC/http.js"

mutate ratelimit "tắt rate limit đăng nhập theo tài khoản" \
  "sed -i 's|if (!acctRl.allowed) {|if (false) {|' $SRC/server.js"

mutate registerdos "tắt rate limit đăng ký (vector DoS Argon2)" \
  "sed -i 's|const rl = await hit(redis, \`rl:register:ip:\${ctx.ip}\`, { limit: 10, windowSec: 3600 });|const rl = { allowed: true, retryAfterSec: 0 };|' $SRC/server.js"

mutate enumeration "tiết lộ email đã tồn tại khi đăng ký (body khác)" \
  "sed -i \"/err.code === '23505'/,/}/ s|return send(res, 201, REGISTER_OK);|return send(res, 201, { leaked: true });|\" $SRC/server.js"

mutate replay "tắt chống replay TOTP (bỏ điều kiện last_counter atomic)" \
  "sed -i 's|WHERE user_id = \$2 AND (last_counter IS NULL OR last_counter < \$1)|WHERE user_id = \$2|' $SRC/server.js"

mutate recovery "mã khôi phục dùng được nhiều lần" \
  "sed -i 's|UPDATE mfa_recovery_codes SET used_at = now() WHERE id = \$1 AND used_at IS NULL|UPDATE mfa_recovery_codes SET used_at = NULL WHERE id = \$1|' $SRC/server.js"

mutate revoke "đổi mật khẩu KHÔNG thu hồi phiên đang sống" \
  "sed -i 's|await client.query(\`UPDATE sessions SET revoked_at = now() WHERE user_id = \$1 AND revoked_at IS NULL\`, \[userId\]);|void 0;|' $SRC/server.js"

mutate halfsession "phiên nửa vời (chưa qua MFA) được coi là đầy đủ" \
  "sed -i 's|return ctx \&\& (!ctx.user.mfaEnabled \|\| ctx.session.mfaSatisfied);|return !!ctx;|' $SRC/server.js"

mutate pwchange "đổi mật khẩu KHÔNG kiểm mật khẩu hiện tại" \
  "sed -i \"s|return send(res, 401, { error: 'mật khẩu hiện tại không đúng' });|return send(res, 200, { ok: true });|\" $SRC/server.js"

mutate pwchangerevoke "đổi mật khẩu tại chỗ KHÔNG thu hồi phiên KHÁC" \
  "sed -i 's|AND id != \$2 AND revoked_at IS NULL|AND id != \$2 AND false|' $SRC/server.js"

mutate mfadisable "tắt MFA KHÔNG xác minh mã (yếu tố hiện tại)" \
  "sed -i 's|let ok = verifyTotp(secret, code, {}) !== null;|let ok = true;|' $SRC/server.js"

mutate rotate "KHÔNG rotate token sau MFA (nâng tại chỗ → session fixation)" \
  "sed -i \"s|SET revoked_at = now() WHERE id = \\\$1', \\[session.id\\]).catch|SET mfa_satisfied = true WHERE id = \\\$1', [session.id]).catch|\" $SRC/server.js"

mutate sessscope "thu hồi phiên KHÔNG giới hạn theo user (thu hồi được phiên người khác)" \
  "sed -i 's|WHERE id = \$1 AND user_id = \$2 AND revoked_at IS NULL|WHERE id = \$1 AND revoked_at IS NULL|' $SRC/server.js"

# ─────────────────────────────────────────────────────────────────────────────
sect "2. Trạng thái sau khi hoàn nguyên"
restore
restart_auth
run_e2e && ok "e2e xanh trở lại — mọi mutation đã gỡ sạch" \
        || bad "e2e còn đỏ — source chưa được hoàn nguyên đúng!"

printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
