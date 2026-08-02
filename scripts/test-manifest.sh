#!/usr/bin/env bash
#
# DANH SÁCH TEST — NGUỒN DUY NHẤT cho cả hai cổng:
#   .github/workflows/ci.yml  (đám mây, máy trắng)
#   scripts/ci-local.sh       (máy này, DB có sẵn dữ liệu)
#
# VÌ SAO CÓ FILE NÀY. Hai cổng vốn giữ danh sách RIÊNG, chép tay. Chúng đã lệch, và lệch
# đúng theo hướng nguy hiểm nhất — cổng CHẶT hơn nằm ở đám mây, cổng LỎNG hơn nằm ở máy:
#
#   ci.yml     : 5 file unit liệt kê rõ · sàn unit 10 · sàn e2e 84
#   ci-local.sh: 2 file unit liệt kê rõ · sàn unit  7 · sàn e2e 80
#
# Nghĩa là chạy ở máy thì 3 bộ unit KHÔNG hề chạy — trong đó có fetch-image.test.js, tức
# hàng rào SSRF của đường tải ảnh theo URL. Và sàn e2e 80 (thực tế 84) dung thứ cho việc
# mất TRẮNG 4 bộ mà không ai biết.
#
# Điều đó tệ nhất đúng lúc này: quota GitHub Actions cháy tới 01/08/2026 nên cổng ở máy là
# cổng DUY NHẤT. Dự án đã bị đúng lớp lỗi này một lần (CI chỉ chạy 30/80 bộ, shipping.e2e
# hỏng 9 ca nhiều ngày mà vẫn xanh) — lần đó vá bằng glob. Lần này vá bằng nguồn chung: hai
# danh sách chép tay thì SẼ lệch lại, chỉ là chuyện lúc nào.
#
# CÁCH DÙNG:  source scripts/test-manifest.sh   (bash cả hai nơi)

# Thư mục unit: mỗi thư mục PHẢI còn ≥1 file. Đổi tên/di chuyển cả thư mục → glob về 0 → đỏ.
MANIFEST_UNIT_DIRS=(packages/auth/test apps/tls-authorize/test)

# File unit lẻ: liệt kê RÕ vì nullglob không rút chuỗi không có ký tự glob — thiếu file thật
# thì phải đỏ chứ không im lặng bỏ qua.
MANIFEST_UNIT_FILES=(
  apps/checkout/test/vietqr.test.js
  apps/seller/test/rbac.test.js
  packages/net-guard/test/fetch-image.test.js
  apps/seller/test/import-amount.test.js
  apps/seller/test/paging.test.js
  apps/signup/test/denylist.test.js
  packages/banner-art/test/unit.test.js
  # Có từ lâu nhưng CHƯA TỪNG nằm trong danh sách nào — phát hiện khi thêm preset
  # thứ 5 (0115): bộ này khẳng định "đúng 4 preset" mà không cổng nào chạy nó.
  # Đúng lớp lỗi file này sinh ra để chặn, chỉ là ở dạng "chưa bao giờ được thêm".
  packages/presets/test/presets.test.js
  # Bất biến mức MÃ NGUỒN: form="X" phải có id="X" cùng hàm. E2E không bắt được
  # lớp lỗi này vì chúng POST thẳng body, bỏ qua ngữ nghĩa gom-ô của trình duyệt.
  apps/seller-admin/test/form-attr.test.js
  # Quy tắc XOÁ ảnh trưng bày. Phần rủi ro nhất của đường dọn rác (xoá nhầm ảnh đang
  # hiển thị) — e2e không dựng nổi ca biên "ảnh vừa tải 5 phút trước", unit dựng được.
  apps/seller/test/media-gc.test.js
  # isApex: chọn hiện hướng dẫn CNAME (tên miền con) hay A+TXT (tên miền gốc). Bẫy là
  # đuôi nhiều nhãn kiểu `com.vn` — e2e không dựng nổi đủ biến thể, unit thì dựng được.
  apps/seller/test/hostname-apex.test.js
)

# Số ĐÚNG hôm nay, không phải "sàn". Xem manifest_check bên dưới.
MANIFEST_UNIT_COUNT=16
MANIFEST_E2E_COUNT=92

manifest_unit_files() {
  shopt -s nullglob
  local d out=()
  for d in "${MANIFEST_UNIT_DIRS[@]}"; do out+=("$d"/*.test.js); done
  out+=("${MANIFEST_UNIT_FILES[@]}")
  printf '%s\n' "${out[@]}"
}

manifest_e2e_files() {
  shopt -s nullglob
  printf '%s\n' apps/*/test/*.e2e.mjs apps/*/test/e2e.mjs
}

# Kiểm ĐÚNG BẰNG, không phải ≥.
#
# Sàn "≥" nghe an toàn nhưng nới ra là hỏng: sàn 80 với 84 bộ thật cho phép mất 4 bộ trong
# im lặng — đúng thứ nó sinh ra để chặn. Ép bằng nhau khiến CẢ HAI chiều đều phải cố ý:
# thêm test thì sửa số, xoá test cũng sửa số, và người review thấy con số đổi trong diff.
manifest_check() {
  local d g nu ne rc=0
  shopt -s nullglob
  for d in "${MANIFEST_UNIT_DIRS[@]}"; do
    g=("$d"/*.test.js)
    [ "${#g[@]}" -ge 1 ] || { echo "MANIFEST: thiếu unit test trong $d/ (đổi tên/di chuyển?)"; rc=1; }
  done
  for d in "${MANIFEST_UNIT_FILES[@]}"; do
    [ -f "$d" ] || { echo "MANIFEST: thiếu unit test $d"; rc=1; }
  done
  nu=$(manifest_unit_files | wc -l | tr -d ' ')
  ne=$(manifest_e2e_files | wc -l | tr -d ' ')
  if [ "$nu" != "$MANIFEST_UNIT_COUNT" ]; then
    echo "MANIFEST: thấy $nu bộ unit, khai báo $MANIFEST_UNIT_COUNT."
    echo "          → sửa MANIFEST_UNIT_COUNT=$nu trong scripts/test-manifest.sh (cùng commit)."
    rc=1
  fi
  if [ "$ne" != "$MANIFEST_E2E_COUNT" ]; then
    echo "MANIFEST: thấy $ne bộ e2e, khai báo $MANIFEST_E2E_COUNT."
    echo "          → sửa MANIFEST_E2E_COUNT=$ne trong scripts/test-manifest.sh (cùng commit)."
    rc=1
  fi
  return $rc
}
