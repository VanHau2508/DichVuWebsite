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
GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; DIM=$'\033[2m'; RST=$'\033[0m'
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

# CHẠY CẢ Ở --fast, CỐ Ý. Bước này không dùng DB dev, không dùng stack đang chạy: nó tự dựng
# một PostgreSQL trắng trong project Compose riêng rồi tự dọn. Bỏ nó khỏi --fast là bỏ đúng
# lớp lỗi mà cổng cũ mù hoàn toàn — schema chỉ dựng được trên máy ĐÃ có sẵn migration.
step "1b. Migration từ DB TRẮNG (project riêng, tự dọn)"
if bash scripts/fresh-migration-gate.sh > /tmp/va-fresh.log 2>&1; then
  pass "$(tail -1 /tmp/va-fresh.log | sed 's/.*PASS[^ ]* //')"
else
  fail "fresh-migration ĐỎ:$(printf '\n      %s' "$(tail -6 /tmp/va-fresh.log)")"
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
  db_pass=$(grep -E '^# pass [0-9]+$' /tmp/va-db.log | tail -1 | awk '{print $3}')
  db_declared=$(sed -nE 's/^\| bất biến DB \| ([0-9]+) bộ,.*$/\1/p' CLAUDE.md | head -1)
  if [ -z "$db_pass" ] || [ -z "$db_declared" ]; then
    fail "bất biến DB — mốc chết: không rút được số TAP hoặc số khai trong CLAUDE.md"
  elif [ "$db_pass" != "$db_declared" ]; then
    fail "bất biến DB lệch số: TAP=$db_pass, CLAUDE.md §0=$db_declared — sửa trong cùng commit"
  else
    pass "bất biến DB pass $db_pass"
  fi
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
    # XOÁ log của LẦN CHẠY TRƯỚC. Bộ đỏ để lại log, bộ xanh thì không xoá đi — nên một bộ
    # từng đỏ rồi được vá xong vẫn để lại tệp log cũ nằm đó vô thời hạn. Lần sau người đọc
    # (hoặc chính tôi) mở đúng đường dẫn ấy ra và tưởng đang xem hiện trường của lần này.
    # Đã mất một vòng điều tra vì đúng chuyện đó. Sau thay đổi này, BẤT BIẾN là:
    #   còn tệp /tmp/va-e2e-*.log sau khi chạy xong ⇒ bộ đó đỏ TRONG CHÍNH LẦN NÀY.
    rm -f /tmp/va-e2e-*.log
    for f in "${suites[@]}"; do
      cont=dbtest
      case "$f" in apps/auth/test/e2e.mjs) cont=auth ;; esac
      log=/tmp/va-e2e-$(echo "$f" | tr '/.' '--').log
      clear_rl
      out=$($COMPOSE exec -T "$cont" node "$f" 2>&1 | tr -d '\r')
      sum=$(printf '%s' "$out" | grep -oE '[0-9]+ pass, [0-9]+ fail' | tail -1)
      # Bộ ĐỎ thì GIỮ LẠI output. Trước đây chỉ giữ con số "10 pass, 1 fail" rồi vứt dòng
      # FAIL — nên muốn biết hỏng gì phải dựng lại hiện trường, mà bộ chỉ đỏ TRONG lượt đầy
      # đủ (chạy riêng thì xanh) thì dựng lại chính là thứ khó nhất. Đã mất một vòng đoán mò
      # vì thiếu đúng ba dòng này.
      case "$sum" in
        *' 0 fail') rm -f "$log"; pass "$f — $sum" ;;
        '')         printf '%s' "$out" > "$log"
                    fail "$f — KHÔNG CHẠY ĐƯỢC: $(printf '%s' "$out" | tail -2 | head -1 | cut -c1-100) [$log]" ;;
        *)          printf '%s' "$out" > "$log"
                    fail "$f — $sum · $(printf '%s' "$out" | grep -E '^\s*(FAIL|.*\[31m)' | head -1 | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-90) [$log]" ;;
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

# ── Cảnh báo DB dev phình ────────────────────────────────────────────────────
# Mỗi lượt đầy đủ đẻ thêm ~400 shop và vài trăm đơn; không ai dọn. Nó KHÔNG chỉ làm
# chậm — nó đổi hành vi theo thời gian rồi sinh lỗi đỏ GIẢ: 2026-07-30, >1000 đơn ứ
# kéo dài vòng quét định kỳ của worker từ vài trăm ms lên hàng giây, đủ để ca
# "digest đơn ứ" đỏ ở đây trong khi chạy riêng bộ đó xanh. Mất một lượt 45 phút.
#
# In ở CUỐI, sau kết luận: đây là chỗ người ta thực sự đọc.
# IP LAN đổi theo DHCP → mọi link nip.io chết kiểu `000`, trông y hệt server hỏng.
# In ngay cạnh cảnh báo phình: hai thứ hay cắn nhất sau một lượt chạy dài.
bash scripts/dev-lan-host.sh --check 2>/dev/null | sed "s/^/${YLW}/;s/\$/${RST}/"

DEV_SHOP_WARN=${DEV_SHOP_WARN:-2000}
nshop=$($COMPOSE exec -T postgres psql -U app_owner -d app -qtA \
        -c 'SELECT count(*) FROM shops' 2>/dev/null | tr -d '\r ')
if [ -n "$nshop" ] && [ "$nshop" -gt "$DEV_SHOP_WARN" ] 2>/dev/null; then
  printf '\n%sDB dev đang có %s shop (ngưỡng %s).%s Dữ liệu tích luỹ đã từng sinh lỗi đỏ GIẢ\n' \
    "$YLW" "$nshop" "$DEV_SHOP_WARN" "$RST"
  printf 'vì làm chậm quét định kỳ. Dọn:  %sbash scripts/dev-db-reset.sh%s  (chạy không tham số = chỉ đo)\n' \
    "$BLD" "$RST"
fi
exit $(( fails > 0 ))
