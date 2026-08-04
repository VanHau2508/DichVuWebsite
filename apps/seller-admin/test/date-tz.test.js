// UNIT: mọi chỗ ĐỊNH DẠNG NGÀY GIỜ trong seller-admin phải nêu rõ múi giờ Việt Nam.
//
// VÌ SAO CÓ BỘ NÀY. Thiếu `timeZone` thì Intl/toLocaleString lấy múi giờ TIẾN TRÌNH — container
// chạy UTC — nên màn hình in sớm hơn 7 tiếng. Trên một shop thật 60 ngày, 54/395 đơn (13,7%)
// hiện SAI NGÀY: đơn khách đặt 05:17 sáng 01/08 hiện thành "22:17 31/07". Phiếu in giao cho
// người đóng gói cũng sai theo.
//
// Nặng hơn cả con số sai: nó CÃI NHAU VỚI CHÍNH TRANG ĐÓ. Bộ lọc khoảng ngày đã tính theo giờ
// VN (docs/60), nên lọc "từ 01/08 đến 01/08" trả về đúng đơn đó nhưng cột Thời gian lại in
// 31/07 — người bán kết luận bộ lọc hỏng và mất niềm tin vào cả trang.
//
// E2E KHÔNG bắt được lớp này: container test cũng chạy UTC, nên "giờ máy chủ" và "giờ hiển thị"
// trùng nhau và mọi khẳng định đều xanh. Chỉ có bất biến mức MÃ NGUỒN mới thấy.
//
// KHI ĐỎ: đừng xoá dòng bị bắt. Thêm `timeZone: 'Asia/Ho_Chi_Minh'` vào chỗ định dạng đó.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', 'src');
const TZ = "timeZone: 'Asia/Ho_Chi_Minh'";

/** Mọi lời gọi định dạng ngày giờ, kèm số dòng để báo lỗi chỉ thẳng chỗ phải sửa. */
function goiDinhDang(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // CHỈ định dạng NGÀY. `Number(x).toLocaleString('vi-VN')` là định dạng TIỀN — nó không có
    // khái niệm múi giờ, bắt nó vào đây là báo động giả và bộ test sẽ bị người ta gỡ.
    // Dấu hiệu "đây là ngày": Intl.DateTimeFormat, hoặc toLocale*String gọi trên một Date.
    const laNgay = /new Intl\.DateTimeFormat\(/.test(l)
      || /new Date\([^)]*\)\.toLocale(String|DateString|TimeString)\(/.test(l)
      || /\.toLocaleDateString\(|\.toLocaleTimeString\(/.test(l);
    if (laNgay) out.push({ dong: i + 1, text: l.trim() });
  }
  return out;
}

test('mọi chỗ định dạng ngày giờ trong seller-admin đều nêu múi giờ Việt Nam', () => {
  const thieu = [];
  let tong = 0;
  for (const f of readdirSync(SRC).filter((x) => x.endsWith('.js'))) {
    const src = readFileSync(join(SRC, f), 'utf8');
    for (const g of goiDinhDang(src)) {
      tong++;
      if (!g.text.includes(TZ)) thieu.push(`${f}:${g.dong}  ${g.text.slice(0, 110)}`);
    }
  }
  // Chốt chặn cho chính bộ test: quét ra 0 chỗ thì khẳng định dưới đây xanh mà không đo gì.
  assert.ok(tong >= 3, `chỉ thấy ${tong} chỗ định dạng ngày — regex hỏng hay file bị đổi tên?`);
  assert.deepEqual(thieu, [],
    'các chỗ này in ngày theo múi giờ MÁY CHỦ (UTC trong container) chứ không phải giờ Việt Nam');
});

// CỐ Ý KHÔNG canh `+ 7*3600e3`. Đã thử và nó báo động giả: repo dùng đúng phép cộng đó ở vài
// chỗ CÓ CHỦ Ý để tính MỐC NGÀY theo giờ VN từ epoch (khoá Redis của đo-luồng-dùng, mốc ngày của
// dashboard) — nơi đó không có gì để định dạng, chỉ cần một chuỗi 'YYYY-MM-DD'. Việt Nam không
// dùng giờ mùa hè từ 1975 nên phép cộng cố định là đúng ở đó. Một bộ test bắt lỗi mã ĐANG ĐÚNG
// thì sớm muộn cũng bị gỡ, và gỡ xong thì mất luôn phần nó canh đúng.
