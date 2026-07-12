#!/usr/bin/env bash
#
# Mutation testing cho xuất dữ liệu (A4). Gỡ từng bất biến gate → e2e phải ĐỎ.
#
#   bash scripts/verify-export.sh [tên...]
#
# Bất biến: tạo bản xuất = owner (perm 'export') + step-up; tải = owner + đúng token.
# Hết hạn token do RLS cưỡng chế (export_read USING expires_at > now()) — kiểm ở e2e §6.

set -uo pipefail
export MSYS_NO_PATHCONV=1

COMPOSE="docker compose -f infra/compose.dev.yml"
SRV=apps/seller/src/export.js
BAK="$(mktemp -d)"
pass=0; fail=0
RED=$'\033[31m'; GREEN=$'\033[32m'; RST=$'\033[0m'
ok()   { pass=$((pass+1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad()  { fail=$((fail+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; return 0; }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cp "$SRV" "$BAK/export.js"
restore() { cp "$BAK/export.js" "$SRV"; }
trap 'restore; rm -rf "$BAK"' EXIT INT TERM

wait_seller() {
  for _ in $(seq 30); do
    if $COMPOSE exec -T seller node -e "fetch('http://127.0.0.1:3040/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
restart() { $COMPOSE restart seller >/dev/null 2>&1; wait_seller; }
run_e2e() {
  $COMPOSE exec -T redis redis-cli flushall >/dev/null 2>&1
  $COMPOSE exec -T dbtest node apps/seller/test/export.e2e.mjs >/dev/null 2>&1
}

FILTER="${*:-}"
mutate() {
  local name="$1" desc="$2" patch="$3"
  if [ -n "$FILTER" ] && ! grep -qw "$name" <<<"$FILTER"; then return 0; fi
  restore; eval "$patch"
  if diff -q "$BAK/export.js" "$SRV" >/dev/null; then bad "$desc — patch không đổi gì (anchor sai)"; return; fi
  if ! restart; then bad "$desc — seller không khởi động lại"; restore; restart; return; fi
  if run_e2e; then bad "$desc → e2e VẪN XANH. Không được bảo vệ."; else ok "$desc → e2e chuyển sang đỏ"; fi
  restore; restart
}

sect "0. Trạng thái ban đầu"
restart
run_e2e && ok "export e2e xanh khi mọi bất biến còn nguyên" || { bad "e2e đã đỏ từ đầu"; exit 1; }

sect "1. Gỡ từng gate"

# Bỏ owner-only ở TẠO → non-owner tạo được bản xuất.
mutate owneronly "bỏ owner-only khi TẠO bản xuất" \
  "sed -i \"s@perm: 'export', stepUp: true@perm: null, stepUp: true@\" $SRV"

# Bỏ step-up ở TẠO → tạo được khi chưa xác thực lại.
mutate stepup "bỏ step-up khi TẠO bản xuất" \
  "sed -i \"s@perm: 'export', stepUp: true@perm: 'export', stepUp: false@\" $SRV"

# Bỏ owner-only ở TẢI → non-owner tải được ZIP.
mutate downloadowner "bỏ owner-only khi TẢI" \
  "sed -i \"s@perm: 'export', fn: (res, ctx, b, p, q)@perm: null, fn: (res, ctx, b, p, q)@\" $SRV"

# Bỏ kiểm token khi TẢI → token bất kỳ trả bản xuất của shop.
mutate tokencheck "bỏ kiểm token khi TẢI (token sai vẫn tải)" \
  "sed -i \"s@WHERE token_hash = \\\$1@WHERE \\\$1 IS NOT NULL@\" $SRV"

sect "2. Trạng thái sau khi hoàn nguyên"
restore; restart
run_e2e && ok "export e2e xanh trở lại" || bad "e2e còn đỏ — chưa hoàn nguyên đúng!"

printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
