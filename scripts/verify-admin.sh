#!/usr/bin/env bash
#
# Mutation testing cho admin web / BFF (login + MFA + quản đơn). Gỡ lớp phòng thủ
# → e2e phải ĐỎ.
#
#   bash scripts/verify-admin.sh [tên...]
#
# LƯU Ý phạm vi: BFF chỉ FORWARD tới auth/seller (chúng mới là ranh giới quyền
# thật — đã có verify-auth.sh / verify-seller.sh chứng minh). Thứ DUY NHẤT mà BFF
# tự gác là CSRF: nó tự chèn Origin admin vào MỌI request nội bộ, nên nếu bỏ kiểm
# sameOrigin thì một POST cross-site sẽ xuyên thẳng tới backend. Đó là mutation
# quan trọng nhất và là thứ harness này canh.

set -uo pipefail
export MSYS_NO_PATHCONV=1

COMPOSE="docker compose -f infra/compose.dev.yml"
HTTP=apps/seller-admin/src/http.js
BAK="$(mktemp -d)"
pass=0; fail=0
RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'
ok()   { pass=$((pass+1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad()  { fail=$((fail+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; return 0; }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cp "$HTTP" "$BAK/http.js"
restore() { cp "$BAK/http.js" "$HTTP"; }
trap 'restore; rm -rf "$BAK"' EXIT INT TERM

wait_svc() { for _ in $(seq 30); do $COMPOSE exec -T seller-admin node -e "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
run_e2e() { $COMPOSE exec -T redis redis-cli flushall >/dev/null 2>&1; $COMPOSE exec -T dbtest node apps/seller-admin/test/admin-flow.e2e.mjs >/dev/null 2>&1; }

FILTER="${*:-}"
mutate() {
  local name="$1" desc="$2" patch="$3"
  if [ -n "$FILTER" ] && ! grep -qw "$name" <<<"$FILTER"; then return 0; fi
  restore; eval "$patch"
  if diff -q "$BAK/http.js" "$HTTP" >/dev/null; then bad "$desc — patch không đổi (anchor sai)"; return; fi
  $COMPOSE restart seller-admin >/dev/null 2>&1; wait_svc || { bad "$desc — seller-admin không khởi động lại"; restore; $COMPOSE restart seller-admin >/dev/null 2>&1; wait_svc; return; }
  if run_e2e; then bad "$desc → e2e VẪN XANH. Không được bảo vệ."; else ok "$desc → e2e chuyển sang đỏ"; fi
  restore; $COMPOSE restart seller-admin >/dev/null 2>&1; wait_svc
}

sect "0. Trạng thái ban đầu"
$COMPOSE restart seller-admin >/dev/null 2>&1; wait_svc
run_e2e && ok "e2e xanh khi mọi lớp còn nguyên" || { bad "e2e đã đỏ từ đầu"; exit 1; }

sect "1. Gỡ lớp CSRF"
# sameOrigin luôn true → POST cross-site (không Origin) xuyên qua BFF tới backend.
mutate csrf "bỏ kiểm Origin (sameOrigin luôn true)" \
  "sed -i 's@  return !!o && allowed.includes(o);@  return true;@' $HTTP"

sect "2. Trạng thái sau khi hoàn nguyên"
restore; $COMPOSE restart seller-admin >/dev/null 2>&1; wait_svc
run_e2e && ok "e2e xanh trở lại" || bad "e2e còn đỏ — chưa hoàn nguyên đúng!"

printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
