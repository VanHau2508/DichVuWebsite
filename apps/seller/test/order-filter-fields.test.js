// UNIT: mọi nơi MANG THEO bộ lọc đơn hàng phải mang ĐỦ trường mà buildOrderFilter đọc.
//
// VÌ SAO CÓ BỘ NÀY. Danh sách trường lọc bị chép tay ở NĂM nơi, và chúng đã trôi:
//   1. buildOrderFilter (apps/seller/src/orders.js)      — NGUỒN SỰ THẬT, đọc từ query
//   2. form "Lọc" trên trang Đơn hàng (hidden + input)   — người bán bấm Lọc
//   3. link TAB trạng thái (biến `keep`)                 — người bán đổi tab
//   4. link PHÂN TRANG (hàm `nav`)                       — người bán sang trang 2
//   5. hidden của nút "Xuất CSV" + ordersExportFields ở BFF — người bán xuất file
// `payment` có mặt ở (1) nhưng THIẾU ở cả bốn chỗ còn lại. Đường vào mặc định của nó là ô
// "Đơn chưa thu tiền" trên Tổng quan, nên chuyện này xảy ra với thao tác thường ngày.
//
// Hậu quả không chỉ khó chịu: bản CSV chứa TÊN, SĐT, ĐỊA CHỈ khách. Rơi bộ lọc là phát tán
// PII của MỌI đơn thay vì đúng tập người bán định lấy, và với shop lớn còn đâm vào trần
// EXPORT_ORDERS_MAX_ROWS → 413, tức không xuất được gì.
//
// VÌ SAO KHÔNG PHẢI E2E: link phân trang chỉ render khi có >20 đơn (limit đóng cứng 20 ở
// BFF) — dựng 21 đơn chỉ để kiểm một chuỗi query là quá đắt và chậm. Bất biến mức MÃ NGUỒN
// thấy cả năm nơi trong một lượt, và bắt được chỗ THỨ SÁU ngay khi ai đó thêm trường lọc mới.
//
// KHI ĐỎ: thêm trường bị nêu tên vào nơi bị nêu tên. ĐỪNG nới danh sách miễn trừ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');

// Trường lọc KHÔNG mang theo được, kèm lý do (danh sách ngắn + có lý do thì người sau đọc được).
const MIEN_TRU = {
  limit: 'BFF đóng cứng limit=20, không phải bộ lọc người dùng chọn',
  offset: 'chính là thứ mỗi link phân trang tự đặt lại',
};

test('buildOrderFilter đọc đúng bộ trường ta nghĩ (mốc nhận dạng còn sống)', () => {
  const src = rd('apps/seller/src/orders.js');
  const doc = [...src.matchAll(/query\.get\('([a-z_]+)'\)/g)].map((m) => m[1]);
  for (const f of ['q', 'from', 'to', 'source', 'payment', 'status']) {
    assert.ok(doc.includes(f), `buildOrderFilter không còn đọc "${f}" — mốc chết, sửa lại bộ test`);
  }
});

test('form Lọc / tab trạng thái / phân trang / nút Xuất CSV đều mang ĐỦ trường lọc', () => {
  const pages = rd('apps/seller-admin/src/pages.js');
  // Cắt đúng thân renderOrders: pages.js còn nhiều màn khác cũng có `nav`/`keep` riêng.
  const i = pages.indexOf('export function renderOrders(');
  assert.ok(i > 0, 'không tìm thấy renderOrders — mốc chết');
  const than = pages.slice(i, pages.indexOf('\nexport function ', i + 10));
  const NOI = [
    { ten: 'link PHÂN TRANG (nav)', doan: /const nav = \(o\) => `[^`]*`/.exec(than)?.[0] },
    // Lấy CẢ link tab chứ không chỉ mảnh `keep`: `status` do chính link tự đặt (`?status=${s}`),
    // còn `keep` mang phần chung. Soi mỗi `keep` sẽ báo thiếu "status" một cách sai — và một
    // cảnh báo giả trong bộ canh-trôi thì lần sau người ta bỏ qua cả bộ.
    { ten: 'link TAB trạng thái', doan: (/const keep = `[^`]*`/.exec(than)?.[0] ?? '') + (/href="\?status=[^"]*"/.exec(than)?.[0] ?? '') },
    { ten: 'hidden của nút Xuất CSV', doan: /const exportBtn = [\s\S]*?Xuất CSV<\/button><\/form>/.exec(than)?.[0] },
    { ten: 'form Lọc', doan: /<form method="GET"[\s\S]*?<\/form>/.exec(than)?.[0] },
  ];
  const CAN = ['status', 'q', 'from', 'to', 'source', 'payment'];
  const viPham = [];
  for (const n of NOI) {
    if (!n.doan) { viPham.push(`${n.ten} — KHÔNG tìm thấy trong renderOrders (mốc chết, sửa bộ test)`); continue; }
    for (const f of CAN) {
      if (MIEN_TRU[f]) continue;
      // Khớp cả hai dạng: `name="payment"` (form) và `payment=` (query string).
      if (!new RegExp(`name="${f}"|[?&]${f}=`).test(n.doan)) viPham.push(`${n.ten} — thiếu "${f}"`);
    }
  }
  assert.deepEqual(viPham, [], 'rời trang là mất bộ lọc → xuất/nhìn nhầm tập đơn (PII ngoài phạm vi)');
});

test('BFF ordersExportFields chuyển tiếp ĐỦ trường xuống seller', () => {
  const s = rd('apps/seller-admin/src/server.js');
  const i = s.indexOf('function ordersExportFields(');
  assert.ok(i > 0, 'không tìm thấy ordersExportFields — mốc chết');
  const than = s.slice(i, s.indexOf('\n}', i) + 2);
  const thieu = ['status', 'q', 'from', 'to', 'source', 'payment']
    .filter((f) => !new RegExp(`^\\s*${f}:`, 'm').test(than));
  assert.deepEqual(thieu, [], 'BFF nuốt trường lọc → xuất ra cả đơn ngoài bộ lọc');
});

// Biên ngày: MỘT quy tắc cho mọi bộ lọc "Từ ngày / Đến ngày". DB chạy UTC nên `::date` trần
// cắt tại 7 giờ sáng giờ VN — đơn đặt lúc 0h–7h rơi sai ngày, và trang Đơn hàng nói khác
// trang Báo cáo. Ba nơi phải dùng CHUNG date-range.js, không ai được tự chép lại.
test('mọi nơi lọc theo khoảng ngày đều dùng chung date-range.js', () => {
  for (const f of ['apps/seller/src/orders.js', 'apps/seller/src/reports.js', 'apps/seller/src/purchasing.js']) {
    const src = rd(f);
    assert.ok(/from '\.\/date-range\.js'/.test(src), `${f} không import date-range.js`);
    assert.ok(!/^const rangeSql = /m.test(src), `${f} tự định nghĩa lại rangeSql — bản chép tay SẼ trôi`);
  }
  // Và không còn ai so ngày bằng `::date` trần trên cột thời gian của bộ lọc đơn.
  const o = rd('apps/seller/src/orders.js');
  assert.ok(!/created_at >= \$\{args\.length\}::date/.test(o),
    'buildOrderFilter còn dùng `::date` trần = biên UTC, lệch 7 giờ với Báo cáo');
});
