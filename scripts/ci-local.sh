#!/usr/bin/env bash
#
# Chạy ĐÚNG những gì CI chạy, nhưng ở máy này.
#   bash scripts/ci-local.sh          # đầy đủ (~45 phút)
#   bash scripts/ci-local.sh --fast   # bỏ toàn bộ e2e (~3 phút) — dùng khi sửa vặt
#
# VÌ SAO CÓ FILE NÀY. Trước đây "đã test, xanh" có nghĩa là "vài bộ e2e tôi tự chọn đã
# qua ở máy tôi". Nó KHÔNG bao gồm quét bảo mật, không bao gồm 3 bước smoke, và bỏ sót
# 50/80 bộ e2e. Kết quả: một CVE trong sharp nằm trên đường nhận ảnh từ người lạ sống
# nhiều ngày trong khi vẫn được báo là "xanh". Từ nay chỉ được nói "xanh" khi file này
# exit 0 — và nó chạy đúng danh sách của .github/workflows/ci.yml, không phải danh sách
# do ai đó nhớ ra lúc đó.
#
# ĐIỀU FILE NÀY KHÔNG PHỦ (phải nói ra, vì im lặng là cách "xanh" mất nghĩa lần trước):
#   - Chạy trên DB dev ĐANG CÓ SẴN DỮ LIỆU, không phải máy trắng như CI. Có bug chỉ hiện
#     khi dữ liệu tích nhiều (đói quét), có bug chỉ hiện khi DB rỗng (migration từ số 0).
#     CI phủ vế sau, file này phủ vế trước. CẢ HAI đều cần.
#   - Không phủ cấu hình thật: .env production, DNS, secret SePay/GHN/GHTK. Xem docs/35.
set -uo pipefail   # CỐ Ý không -e: phải chạy HẾT rồi mới kết luận, không dừng ở lỗi đầu

cd "$(dirname "$0")/.."
# NGUỒN CHUNG danh sách test với .github/workflows/ci.yml — xem đầu file đó.
. scripts/test-manifest.sh
COMPOSE="docker compose -f infra/compose.dev.yml"
GRN=$'\033[32m'; RED=$'\033[31m'; BLD=$'\033[1m'; DIM=$'\033[2m'; RST=$'\033[0m'
FAST=0; [ "${1:-}" = "--fast" ] && FAST=1

fails=0; lines=()
step() { printf '\n%s▶ %s%s\n' "$BLD" "$1" "$RST"; }
pass() { lines+=("${GRN}PASS${RST}  $1"); printf '  %sPASS%s %s\n' "$GRN" "$RST" "$1"; }
fail() { lines+=("${RED}FAIL${RST}  $1"); fails=$((fails+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; }

# Xoá rate-limit giữa các bộ. KHÔNG phải dọn dẹp cho đẹp: dựng tài khoản staff ở đầu mỗi
# bộ e2e sẽ ăn 429 nếu bộ trước vừa chạy, và test chết vì lý do hoàn toàn không liên quan
# tới thứ nó đang kiểm (đã dính 2 lần trong một phiên).
clear_rl() { $COMPOSE exec -T redis sh -c "redis-cli --scan --pattern 'rl:*' | xargs -r -n 400 redis-cli del > /dev/null" 2>/dev/null; }

step "0. Tiền kiểm — stack có đang chạy không"
if [ -z "$($COMPOSE ps -q 2>/dev/null)" ]; then
  printf '  %sStack chưa chạy.%s Bật trước:\n    %s up -d\n' "$RED" "$RST" "$COMPOSE"; exit 2
fi
# PHẢI dùng `ps -a`: `docker compose ps` mặc định CHỈ liệt kê container ĐANG CHẠY, nên
# service đã tắt BIẾN MẤT khỏi danh sách thay vì hiện "exited" — guard sẽ không thấy gì và
# báo "stack đang chạy" trong khi dbtest đã chết. Đúng loại guard-không-guard.
# `migrate` là job một-lần, exited là ĐÚNG — không tính.
down=$($COMPOSE ps -a --format '{{.Service}} {{.State}}' 2>/dev/null | grep -v ' running$' | grep -v '^migrate ' || true)
if [ -n "$down" ]; then
  printf '  %sSERVICE KHÔNG CHẠY%s — kết quả bên dưới sẽ SAI. Bật lại rồi chạy lại:\n%s\n    %s up -d\n' \
    "$RED" "$RST" "$down" "$COMPOSE"
  exit 2
fi
printf '  toàn bộ service đang chạy\n'

step "1. Unit test (thuần, không cần stack)"
shopt -s nullglob
# Danh sách lấy từ NGUỒN CHUNG với ci.yml. Trước đây file này giữ danh sách riêng và đã
# lệch: chỉ 2 file lẻ thay vì 5, nên fetch-image.test.js (hàng rào SSRF) KHÔNG hề chạy ở máy.
mapfile -t ufiles < <(manifest_unit_files)
if ! manifest_check > /tmp/va-manifest.log 2>&1; then
  fail "DANH SÁCH TEST lệch khai báo:$(printf '\n      %s' "$(cat /tmp/va-manifest.log)")"
elif node --test "${ufiles[@]}" > /tmp/va-unit.log 2>&1; then
  pass "unit $(grep -E '^# pass' /tmp/va-unit.log | tr -d '#')"
else
  fail "unit ĐỎ — xem /tmp/va-unit.log"
fi

step "2. Quét bảo mật tĩnh (dependency/secret/PII/pattern)"
if bash scripts/security-scan.sh > /tmp/va-sec.log 2>&1; then
  pass "security-scan sạch"
else
  fail "security-scan có phát hiện: $(grep -c FLAG /tmp/va-sec.log) mục — xem /tmp/va-sec.log"
fi

step "3. Cô lập tenant + bất biến schema"
clear_rl
if $COMPOSE exec -T dbtest sh -c 'n=$(ls test/*.test.js 2>/dev/null | wc -l); [ "$n" -ge 3 ] || exit 9; node --test test/*.test.js' > /tmp/va-db.log 2>&1; then
  pass "bất biến DB $(grep -E '^# pass' /tmp/va-db.log | tr -d '#')"
else
  fail "bất biến DB ĐỎ — xem /tmp/va-db.log"
fi

if [ "$FAST" -eq 1 ]; then
  step "4. E2E — BỎ QUA (--fast)"
  printf '  %sChưa chạy %d bộ e2e. KHÔNG được gọi kết quả này là "xanh".%s\n' "$DIM" "$MANIFEST_E2E_COUNT" "$RST"
else
  step "4. E2E — lấy bằng GLOB, y hệt CI"
  mapfile -t suites < <(manifest_e2e_files)
  # Số đúng ĐÃ kiểm ở bước 1 (manifest_check, so BẰNG chứ không ≥). Sàn cũ ở đây là 80 trong
  # khi thực tế 84 — dung thứ cho việc mất trắng 4 bộ mà không ai biết.
  if [ "${#suites[@]}" -eq 0 ]; then
    fail "không thấy bộ e2e nào — glob hỏng?"
  else
    printf '  %s%d bộ, ước tính ~45 phút%s\n' "$DIM" "${#suites[@]}" "$RST"
    for f in "${suites[@]}"; do
      cont=dbtest
      case "$f" in apps/auth/test/e2e.mjs) cont=auth ;; esac
      clear_rl
      out=$($COMPOSE exec -T "$cont" node "$f" 2>&1 | tr -d '\r')
      sum=$(printf '%s' "$out" | grep -oE '[0-9]+ pass, [0-9]+ fail' | tail -1)
      case "$sum" in
        *' 0 fail') pass "$f — $sum" ;;
        '')         fail "$f — KHÔNG CHẠY ĐƯỢC: $(printf '%s' "$out" | tail -2 | head -1 | cut -c1-120)" ;;
        *)          fail "$f — $sum" ;;
      esac
    done
  fi
fi

step "5. Smoke (edge / readiness / TLS)"
for s in smoke-edge smoke-readiness smoke-tls; do
  if bash "scripts/$s.sh" > "/tmp/va-$s.log" 2>&1; then
    pass "$s"
  else
    fail "$s ĐỎ — $(grep -E 'FAIL' "/tmp/va-$s.log" | head -1 | cut -c1-140)"
  fi
done

printf '\n%s══════ TỔNG KẾT ══════%s\n' "$BLD" "$RST"
for l in "${lines[@]}"; do [ "${l#*FAIL}" != "$l" ] && printf '  %s\n' "$l"; done
if [ "$fails" -eq 0 ]; then
  if [ "$FAST" -eq 1 ]; then
    printf '%sMỌI THỨ ĐÃ CHẠY ĐỀU QUA — nhưng --fast BỎ QUA toàn bộ e2e.%s\n' "$GRN" "$RST"
  else
    printf '%sXANH: %d mục, 0 đỏ. Tương đương phạm vi của CI (trừ máy sạch + cấu hình thật).%s\n' "$GRN" "${#lines[@]}" "$RST"
  fi
else
  printf '%sĐỎ: %d mục hỏng (xem danh sách trên).%s\n' "$RED" "$fails" "$RST"
fi
exit $(( fails > 0 ))
