#!/usr/bin/env bash
#
# Mutation testing cho media (Ngày 9). Gỡ từng lớp phòng thủ ảnh, khẳng định
# media e2e chuyển đỏ. Hoàn nguyên.
#
#   bash scripts/verify-media.sh [tên...]

set -uo pipefail
export MSYS_NO_PATHCONV=1

COMPOSE="docker compose -f infra/compose.dev.yml"
MED=apps/seller/src/media.js
HTP=apps/seller/src/http.js
BAK="$(mktemp -d)"
pass=0; fail=0
RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'
ok()   { pass=$((pass+1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad()  { fail=$((fail+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; return 0; }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cp "$MED" "$BAK/media.js"; cp "$HTP" "$BAK/http.js"
restore() { cp "$BAK/media.js" "$MED"; cp "$BAK/http.js" "$HTP"; }
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
  # Flush redis: rate-limit đăng nhập tích luỹ qua nhiều lần chạy từ cùng IP làm
  # e2e đỏ vì 429 — nhiễu, không phải do mutation.
  $COMPOSE exec -T redis redis-cli flushall >/dev/null 2>&1
  $COMPOSE exec -T dbtest node apps/seller/test/media.e2e.mjs >/dev/null 2>&1
}

FILTER="${*:-}"
mutate() {
  local name="$1" desc="$2" patch="$3"
  if [ -n "$FILTER" ] && ! grep -qw "$name" <<<"$FILTER"; then return 0; fi
  restore; eval "$patch"
  if diff -q "$BAK/media.js" "$MED" >/dev/null && diff -q "$BAK/http.js" "$HTP" >/dev/null; then
    bad "$desc — patch không đổi gì (anchor sai)"; return
  fi
  if ! restart; then bad "$desc — seller không khởi động lại"; restore; restart; return; fi
  if run_e2e; then bad "$desc → e2e VẪN XANH. Không được bảo vệ."; else ok "$desc → e2e chuyển sang đỏ"; fi
  restore; restart
}

sect "0. Trạng thái ban đầu"
restart
run_e2e && ok "media e2e xanh khi mọi lớp còn nguyên" || { bad "e2e đã đỏ từ đầu"; exit 1; }

sect "1. Gỡ từng lớp phòng thủ media"

mutate magicbyte "bỏ kiểm magic byte (tin Content-Type)" \
  "sed -i 's|if (!detected) return send(res, 400|if (false) return send(res, 400|' $MED"

mutate reencode "public phục vụ bản GỐC thay vì WebP đã re-encode" \
  "sed -i 's|putObject(BUCKET_PUBLIC, publicKey, data, data.length|putObject(BUCKET_PUBLIC, publicKey, buf, buf.length|' $MED"

mutate oversize "nới giới hạn kích thước upload" \
  "sed -i 's|> maxBytes|> maxBytes * 100000|g' $HTP"

sect "2. Trạng thái sau khi hoàn nguyên"
restore; restart
run_e2e && ok "media e2e xanh trở lại" || bad "e2e còn đỏ — chưa hoàn nguyên đúng!"

printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
