// UNIT: mọi vòng lặp KHOÁ TỒN phải khoá theo THỨ TỰ CỐ ĐỊNH (variant_id tăng dần).
//
// Vì sao có bộ này. Deadlock cần đúng một điều kiện: hai giao dịch khoá CÙNG hai dòng theo
// THỨ TỰ NGƯỢC NHAU. Dự án đã vá lớp này một lần ở checkout (`[...new Set()].sort()`), nhưng
// luật đó không được viết ra ở đâu, nên ba chỗ sinh sau vẫn khoá theo thứ tự VẬT LÝ của
// `order_lines` — mà thứ tự vật lý của đơn từ KHÁCH chính là thứ tự bỏ vào giỏ
// (checkout/server.js `ORDER BY ci.created_at`). Đo thật ở a15-thu-tu-khoa-ton:
//     khách bỏ X trước → dòng đơn "X → Y"
//     khách bỏ Y trước → dòng đơn "Y → X"
// Hai lệnh huỷ/hoàn/quét-hết-hạn chạy song song trên hai đơn đó là khoá chéo được.
//
// VÌ SAO KHÔNG PHẢI E2E: deadlock phụ thuộc điểm xen kẽ giữa hai giao dịch — dựng lại được
// một lần thì lần sau chưa chắc, tức test sẽ CHẬP CHỜN. Thứ kiểm được ổn định là BẤT BIẾN
// SINH RA NÓ: truy vấn nạp danh sách dòng hàng cho vòng khoá phải có ORDER BY variant_id.
//
// KHI ĐỎ: thêm `ORDER BY variant_id` vào truy vấn bị nêu tên, ĐỪNG nới danh sách miễn trừ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');

// Truy vấn ĐỌC order_lines nhưng KHÔNG dùng để khoá tồn → không cần thứ tự. Liệt kê RÕ kèm
// lý do: danh sách ngắn và có lý do thì người sau đọc được; regex "đoán" thì không.
const MIEN_TRU = [
  { khop: 'unit_price_vnd, unit_cost_vnd, qty, title_snapshot', vi: 'reconcileEditLines: dựng Map tra cứu, vòng khoá dùng allVids ĐÃ sort riêng' },
  { khop: 'unit_price_vnd, unit_cost_vnd, qty FROM order_lines', vi: 'createReturn: tra cứu + .every(), vòng restock sort riêng bằng .sort(localeCompare)' },
  { khop: 'ol.title_snapshot, ol.sku_snapshot, ol.unit_price_vnd, ol.qty, ol.shipped_qty', vi: 'getOrder: hiển thị chi tiết đơn + ảnh, KHÔNG khoá gì' },
  { khop: "WHERE sl.order_line_id = ol.id AND s.status = 'created'", vi: 'shipOrder: dựng danh sách kiện; vòng khoá nằm ở consumeAndShip và nó đọc shipment_lines ORDER BY variant_id' },
  { khop: "r.source = 'kiotviet' AND r.kind = 'variant'", vi: 'worker connector chỉ dựng payload gửi provider, không đọc hay khoá inventory_levels' },
];

test('resolution return inventory lock is ordered in SQL', () => {
  const src = readFileSync(join(ROOT, 'apps/seller/src/order-resolutions.js'), 'utf8');
  assert.match(src, /FROM unnest\(\$1::uuid\[\]\)[^`]*ORDER BY variants\.variant_id[^`]*ON CONFLICT/s);
  assert.match(src, /FROM inventory_levels[^`]*variant_id = ANY\(\$1::uuid\[\]\)[^`]*ORDER BY variant_id[^`]*FOR UPDATE/s);
  assert.doesNotMatch(src, /receiptLines[^\n]*localeCompare/);
});

const FILE = [
  'apps/seller/src/orders.js',
  'apps/worker/src/index.js',
  'apps/checkout/src/server.js',
];

test('mọi truy vấn order_lines nạp variant_id cho vòng khoá đều ORDER BY variant_id', () => {
  const viPham = [];
  for (const f of FILE) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    // Bắt mọi `SELECT ... variant_id ... FROM order_lines ...` cho tới hết chuỗi template.
    for (const m of src.matchAll(/SELECT[^`]*?\bvariant_id\b[^`]*?FROM order_lines[^`]*/g)) {
      const q = m[0];
      if (/ORDER BY variant_id/.test(q)) continue;
      if (MIEN_TRU.some((x) => q.includes(x.khop))) continue;
      const dong = src.slice(0, m.index).split('\n').length;
      viPham.push(`${f}:${dong} — ${q.replace(/\s+/g, ' ').slice(0, 110)}`);
    }
  }
  assert.deepEqual(viPham, [], 'thiếu ORDER BY variant_id → thứ tự khoá tồn không xác định → deadlock');
});

test('danh sách miễn trừ không được mục nào chết (đổi mã mà quên dọn)', () => {
  // Miễn trừ trỏ vào một truy vấn KHÔNG CÒN TỒN TẠI là lời nói dối nằm lại trong test:
  // người sau đọc tưởng còn chỗ hở đã được cân nhắc, thực ra chỗ đó biến mất từ lâu.
  const all = FILE.map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
  for (const x of MIEN_TRU) {
    assert.ok(all.includes(x.khop), `miễn trừ CHẾT: không còn truy vấn nào khớp "${x.khop}" (${x.vi})`);
  }
});
