// UNIT: mọi truy vấn CHỌN MỘT vận đơn để TRẢ RA NGOÀI đều phải loại vận đơn ĐÃ HUỶ.
//
// VÌ SAO CÓ BỘ NÀY. `shipments` có vòng đời created → in_transit → delivered/returned/cancelled,
// và 'cancelled' tới từ BỐN đường bình thường, không cần ai làm sai:
//   · hãng huỷ vận đơn (worker sweep đặt cancelled)
//   · claim chết sau 15' (provider_status='claim_expired')
//   · đơn đổi trạng thái giữa lúc gọi hãng (provider_status='orphan')
//   · shop ngắt/ĐỔI hãng vận chuyển (provider_status='orphan')
// Dòng huỷ nghĩa là hãng KHÔNG cầm hàng và KHÔNG thu hộ đồng nào. Bỏ quên điều kiện đó thì
// một dòng chết vẫn "đại diện" cho đơn ở khắp nơi: sổ Đối soát COD đẻ khoản phải thu MA, bot
// đưa khách mã tra cứu ra trang trống, phiếu in mang mã sai, digest "đơn ứ" bị reset đồng hồ.
// Đã vá 6 chỗ cùng lúc (đợt 4) — bộ này giữ cho chỗ thứ 7 không lặng lẽ sinh ra.
//
// VÌ SAO KHÔNG PHẢI E2E: sáu chỗ nằm ở SÁU service khác nhau (mỗi service một image), không
// màn nào nhìn thấy cả sáu; và vài chỗ là chuỗi HTML in ra giấy. Bất biến mức MÃ NGUỒN thì
// kiểm được cả sáu trong một lượt. Cùng khuôn với shared-sql.test.js và lock-order.test.js.
//
// KHI ĐỎ: thêm điều kiện loại 'cancelled' vào truy vấn bị nêu tên. ĐỪNG nới danh sách miễn trừ
// trừ khi truy vấn đó THẬT SỰ cần thấy cả vận đơn đã huỷ — và ghi rõ lý do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');

// Nơi CHỌN vận đơn đại diện cho đơn. Mỗi mục: file + đoạn nhận dạng + điều kiện phải có.
const DIEM = [
  { f: 'apps/seller/src/cod.js', ten: 'sổ Đối soát COD + ghi phiếu chuyển tiền (dùng chung reports.js)',
    khop: 'export const LATERAL_VAN_DON_HANG', can: "s.status <> 'cancelled'" },
  { f: 'apps/seller/src/ingest-catalog.js', ten: 'bot Messenger trả lời "đơn tôi tới đâu"',
    khop: '(SELECT s.tracking_number FROM shipments s', can: "s.status <> 'cancelled'" },
  { f: 'apps/checkout/src/server.js', ten: 'trang TRA CỨU ĐƠN của khách',
    khop: 'FROM shipments WHERE order_id = $1 AND tracking_number IS NOT NULL', can: "status <> 'cancelled'" },
  { f: 'apps/account/src/server.js', ten: 'tài khoản khách — chi tiết đơn',
    khop: 'FROM shipments WHERE order_id = $1 AND tracking_number IS NOT NULL', can: "status <> 'cancelled'" },
  { f: 'apps/worker/src/index.js', ten: 'digest "đơn ứ" — mốc đã-gửi-hãng',
    khop: 'SELECT max(s.created_at) FROM shipments s', can: "s.status <> 'cancelled'" },
];

test('mọi truy vấn chọn vận đơn ĐẠI DIỆN đều loại dòng đã huỷ', () => {
  const viPham = [];
  for (const d of DIEM) {
    const src = readFileSync(join(ROOT, d.f), 'utf8');
    const i = src.indexOf(d.khop);
    if (i < 0) { viPham.push(`${d.f} — KHÔNG CÒN đoạn "${d.khop}" (${d.ten}); mốc nhận dạng đã chết, sửa lại bộ test`); continue; }
    // Cửa sổ chỉ dò XUÔI từ mốc. Dò ngược cũng khớp phải CHÚ THÍCH phía trên (chú thích ở
    // cod.js có nhắc nguyên văn điều kiện) → test xanh cả khi câu lệnh đã bị gỡ điều kiện.
    // Đã bắt được bằng đột biến: gỡ điều kiện thật mà bộ này vẫn xanh.
    const cua = src.slice(i, i + 500);
    if (!cua.includes(d.can)) viPham.push(`${d.f} — ${d.ten}: thiếu "${d.can}"`);
  }
  assert.deepEqual(viPham, [], 'vận đơn ĐÃ HUỶ đang được dùng làm đại diện cho đơn');
});

// Phiếu in (seller-admin) không phải SQL mà là JS chọn phần tử — kiểm riêng.
test('phiếu in lấy KIỆN CÒN SỐNG, không phải phần tử đầu danh sách', () => {
  const src = readFileSync(join(ROOT, 'apps/seller-admin/src/pages.js'), 'utf8');
  // o.shipments sắp xếp ORDER BY created_at (CŨ NHẤT trước) — [0] là kiện đầu tiên từng tạo,
  // rất có thể là claim hỏng. Phiếu giao hàng và hoá đơn đều dùng chung khuôn này.
  assert.equal(src.includes('const ship = (o.shipments ?? [])[0];'), false,
    "phiếu in lấy (o.shipments)[0] — kiện CŨ NHẤT, có thể đã huỷ. Dùng .find(x => x.status !== 'cancelled')");
  const n = src.split("const ship = (o.shipments ?? []).find((x) => x.status !== 'cancelled');").length - 1;
  assert.equal(n, 2, `mong đợi 2 chỗ chọn kiện sống (phiếu giao hàng + hoá đơn), thấy ${n}`);
});

test('worker huỷ vận đơn chỉ chuyển kiện đang in_transit và ghi timeline', () => {
  const src = readFileSync(join(ROOT, 'apps/worker/src/index.js'), 'utf8');
  const start = src.indexOf("if (st.state === 'cancelled')");
  assert.ok(start >= 0, 'không tìm thấy nhánh carrier cancellation');
  const body = src.slice(start, start + 1800);
  assert.match(body, /WHERE id = \$1 AND status = 'in_transit' RETURNING id/,
    'cancellation muộn không được ghi đè kiện đã delivered/returned');
  assert.match(body, /'shipment\.cancelled'/,
    'cancellation phải xuất hiện trong timeline');
  assert.match(body, /requires_reconciliation:\s*true/,
    'timeline phải báo cần đối soát thay vì tự restock');
  assert.match(body, /openMixedShipmentResolution\(c, s\)/,
    'cancellation mới phải đi qua detector resolution hiện có');
});

test('worker ghi mã trạng thái thô của hãng vào namespace riêng', () => {
  const src = readFileSync(join(ROOT, 'apps/worker/src/index.js'), 'utf8');
  const start = src.indexOf('async function sweepTracking()');
  const end = src.indexOf('// ── sweep: TÍN HIỆU SÀN TMĐT', start);
  assert.ok(start >= 0 && end > start, 'mốc chết: không cắt được thân sweepTracking');
  const sweep = src.slice(start, end);

  for (const status of ['delivered', 'returned', 'cancelled']) {
    assert.match(sweep,
      new RegExp(`UPDATE\\s+shipments\\s+SET\\s+status\\s*=\\s*'${status}'\\s*,\\s*carrier_status_raw\\s*=\\s*\\$2\\s*,\\s*synced_at\\s*=\\s*now\\(\\)`),
      `worker phải ghi mã hãng của kiện ${status} vào carrier_status_raw`);
  }
  assert.match(sweep,
    /UPDATE\s+shipments\s+SET\s+carrier_status_raw\s*=\s*\$2\s*,\s*synced_at\s*=\s*now\(\)\s+WHERE\s+id\s*=\s*\$1/,
    'worker phải ghi mã hãng trung gian vào carrier_status_raw');
  assert.doesNotMatch(sweep,
    /provider_status\s*=\s*(?:\$2|st\.raw)/,
    'worker không được ghi mã hãng vào provider_status nội bộ');
});

test('seller order detail và admin dùng cùng planned_qty khi tính số còn phải giao', () => {
  const seller = readFileSync(join(ROOT, 'apps/seller/src/orders.js'), 'utf8');
  const admin = readFileSync(join(ROOT, 'apps/seller-admin/src/pages.js'), 'utf8');
  assert.match(seller, /AS planned_qty/,
    'API chi tiết đơn phải trả số lượng claim created');
  assert.match(admin, /Number\(l\.planned_qty \?\? 0\)/,
    'SSR không được hiển thị số còn lại chỉ từ shipped_qty');
  assert.match(admin, /Number\(l\.qty\) - Number\(l\.shipped_qty \?\? 0\) - Number\(l\.planned_qty \?\? 0\)/,
    'UI phải trừ cả claim đang tạo như backend');
});

// Đường dẫn CÔNG KHAI của trang nội dung là /pages/<slug>. Sitemap từng phát '/<slug>' trần —
// mọi URL nộp cho Google đều 404 — và màn "Trang nội dung" của seller-admin cũng in sai y hệt,
// tức người bán dán link đó lên Facebook là ra 404. Hai nơi, một sự thật.
test('mọi nơi công bố đường dẫn trang nội dung đều dùng /pages/<slug>', () => {
  const sf = readFileSync(join(ROOT, 'apps/storefront/src/server.js'), 'utf8');
  assert.ok(sf.includes('loc(`/pages/${pg.slug}`)'), 'sitemap không khai trang nội dung ở /pages/<slug>');
  assert.ok(sf.includes("const pm2 = /^\\/pages\\/([a-z0-9-]+)$/") || sf.includes('/pages/'),
    'không tìm thấy route /pages/:slug — mốc nhận dạng đã chết');
  const ad = readFileSync(join(ROOT, 'apps/seller-admin/src/pages.js'), 'utf8');
  assert.ok(ad.includes('/pages/${esc(p.slug)}'),
    'màn "Trang nội dung" in đường dẫn công khai thiếu tiền tố /pages/ → người bán dán link 404');
});
