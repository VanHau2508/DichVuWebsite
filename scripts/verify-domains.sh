#!/usr/bin/env bash
#
# Mutation testing cho custom domain (A5). Gỡ từng bất biến → e2e phải ĐỎ.
#
#   bash scripts/verify-domains.sh [tên...]
#
# Bất biến: thêm domain = owner (domain.write) + step-up; đặt chính chỉ khi verified; không
# gỡ tên miền chính; worker CHỈ verify khi TXT khớp (chống mint cert cho domain không sở hữu).
# seller mount src → restart; worker build image → rebuild (chậm hơn).

set -uo pipefail
export MSYS_NO_PATHCONV=1

COMPOSE="docker compose -f infra/compose.dev.yml"
SEL=apps/seller/src/domains.js
WRK=apps/worker/src/index.js
BAK="$(mktemp -d)"
pass=0; fail=0
RED=$'\033[31m'; GREEN=$'\033[32m'; RST=$'\033[0m'
ok()   { pass=$((pass+1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad()  { fail=$((fail+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; return 0; }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cp "$SEL" "$BAK/domains.js"; cp "$WRK" "$BAK/index.js"
restore() { cp "$BAK/domains.js" "$SEL"; cp "$BAK/index.js" "$WRK"; }
trap 'restore; rm -rf "$BAK"' EXIT INT TERM

wait_seller() { for _ in $(seq 30); do $COMPOSE exec -T seller node -e "fetch('http://127.0.0.1:3040/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
wait_worker() { for _ in $(seq 40); do $COMPOSE exec -T worker node -e "fetch('http://127.0.0.1:3080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
reload_seller() { $COMPOSE restart seller >/dev/null 2>&1; wait_seller; }
reload_worker() { $COMPOSE up -d --build worker >/dev/null 2>&1; wait_worker; sleep 3; } # +3s: resolver stub set lúc khởi động
run_e2e() {
  $COMPOSE exec -T redis redis-cli flushall >/dev/null 2>&1
  $COMPOSE exec -T dbtest node apps/seller/test/domains.e2e.mjs >/dev/null 2>&1
}

FILTER="${*:-}"
# mutate <tên> <svc: seller|worker> <mô tả> <lệnh sed>
mutate() {
  local name="$1" svc="$2" desc="$3" patch="$4"
  if [ -n "$FILTER" ] && ! grep -qw "$name" <<<"$FILTER"; then return 0; fi
  restore; eval "$patch"
  if diff -q "$BAK/domains.js" "$SEL" >/dev/null && diff -q "$BAK/index.js" "$WRK" >/dev/null; then bad "$desc — patch không đổi (anchor sai)"; return; fi
  if [ "$svc" = worker ]; then reload_worker || { bad "$desc — worker không lên"; restore; reload_worker; return; }
  else reload_seller || { bad "$desc — seller không lên"; restore; reload_seller; return; }; fi
  if run_e2e; then bad "$desc → e2e VẪN XANH. Không được bảo vệ."; else ok "$desc → e2e chuyển sang đỏ"; fi
  restore
  if [ "$svc" = worker ]; then reload_worker; else reload_seller; fi
}

sect "0. Trạng thái ban đầu"
reload_seller
run_e2e && ok "domains e2e xanh khi mọi bất biến còn nguyên" || { bad "e2e đã đỏ từ đầu"; exit 1; }

sect "1. Gỡ từng bất biến"

mutate stepup seller "bỏ step-up khi THÊM domain" \
  "sed -i \"s@stepUp: true, fn: (res, ctx, b) => addDomain@stepUp: false, fn: (res, ctx, b) => addDomain@\" $SEL"

mutate owneronly seller "bỏ owner-only khi THÊM domain" \
  "sed -i \"s@perm: 'domain.write', stepUp: true, fn: (res, ctx, b) => addDomain@perm: null, stepUp: true, fn: (res, ctx, b) => addDomain@\" $SEL"

mutate primaryverified seller "cho đặt CHÍNH domain chưa verify" \
  "sed -i \"s@if (d.verified_at === null) return { code: 409, msg: 'tên miền chưa xác minh — không thể đặt làm chính' };@if (false) return { code: 409 };@\" $SEL"

mutate revokeprimary seller "cho GỠ tên miền chính" \
  "sed -i \"s@if (d.is_primary) return { code: 409, msg: 'không thể gỡ tên miền chính — đặt tên miền khác làm chính trước' };@if (false) return { code: 409 };@\" $SEL"

mutate txtcheck worker "worker verify KHÔNG kiểm TXT (mint cert bừa)" \
  "sed -i \"s@if (!txts.some((chunks) => chunks.join('') === d.verification_token)) continue;@if (false) continue;@\" $WRK"

sect "2. Trạng thái sau khi hoàn nguyên"
restore; reload_seller; reload_worker
run_e2e && ok "domains e2e xanh trở lại" || bad "e2e còn đỏ — chưa hoàn nguyên đúng!"

printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
