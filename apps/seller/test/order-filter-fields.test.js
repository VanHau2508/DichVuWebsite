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

// Rút hợp đồng ngay từ nguồn seller. Không ghi lại danh sách trục ở bộ test: đổi tên
// một trục nhất quán ở filter, SQL và cột SELECT vẫn phải là thay đổi hợp lệ.
function attentionSourceContract(src) {
  const filtersMatch = /export const ORDER_ATTENTION_FILTERS\s*=\s*\[([\s\S]*?)\];/.exec(src);
  assert.ok(filtersMatch, 'không tìm thấy ORDER_ATTENTION_FILTERS — mốc chết');
  const filters = [...filtersMatch[1].matchAll(/['"]([a-z_]+)['"]/g)].map((m) => m[1]);
  const expected = filters.filter((key) => key !== 'open');

  const sqlStart = src.indexOf('const ORDER_ATTENTION_SQL = Object.freeze({');
  assert.ok(sqlStart >= 0, 'không tìm thấy ORDER_ATTENTION_SQL — mốc chết');
  const sqlEnd = src.indexOf('\n});', sqlStart);
  assert.ok(sqlEnd > sqlStart, 'không tìm thấy điểm kết thúc ORDER_ATTENTION_SQL — mốc chết');
  const sqlBody = src.slice(sqlStart, sqlEnd);
  const sqlKeys = [...sqlBody.matchAll(/^\s*([a-z_]+):\s*`/gm)].map((m) => m[1]);

  const listStart = src.indexOf('async function listOrders(');
  assert.ok(listStart >= 0, 'không tìm thấy listOrders — mốc chết');
  const selectStart = src.indexOf('SELECT o.id', listStart);
  const selectEnd = src.indexOf('FROM orders o ${whereSql}', selectStart);
  assert.ok(selectStart > listStart && selectEnd > selectStart,
    'không tìm thấy SELECT dòng của listOrders — mốc chết');
  const rowSelect = src.slice(selectStart, selectEnd);
  // Lấy alias ĐỘC LẬP với biểu thức bên trái. Nhờ vậy `false AS attention_shipment`
  // vẫn bị nhìn thấy, rồi chốt thứ hai mới khẳng định biểu thức đó là nguồn chung.
  const columns = [...rowSelect.matchAll(/^\s*(.*?)\s+AS\s+(attention_[a-z_]+)\s*,?\s*$/gm)]
    .map((m) => ({
      expressionKey: /^\$\{\s*ORDER_ATTENTION_SQL\.([a-z_]+)\s*\}$/.exec(m[1].trim())?.[1] ?? null,
      aliasKey: m[2].replace(/^attention_/, ''),
    }));

  return { expected, sqlKeys, columns };
}

function vocabularyArray(text, pattern, label) {
  const match = pattern.exec(text);
  assert.ok(match, `không tìm thấy ${label} — mốc chết`);
  const values = [...match[1].matchAll(/['"]([a-z_]+)['"]/g)].map((m) => m[1]);
  assert.ok(values.length, `${label} rỗng — mốc chết`);
  return values;
}

function vocabularyLabelKeys(text, name) {
  const match = new RegExp(`const ${name} = Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\);`).exec(text);
  assert.ok(match, `không tìm thấy ${name} — mốc chết`);
  const keys = [...match[1].matchAll(/(?:^|,)\s*([a-z_]+)\s*:/gm)].map((m) => m[1]);
  assert.ok(keys.length, `${name} rỗng — mốc chết`);
  return keys;
}

function sorted(values) {
  return [...values].sort();
}

function withoutOpen(values) {
  return values.filter((value) => value !== 'open');
}

// Trường lọc KHÔNG mang theo được, kèm lý do (danh sách ngắn + có lý do thì người sau đọc được).
const MIEN_TRU = {
  limit: 'BFF đóng cứng limit=20, không phải bộ lọc người dùng chọn',
  offset: 'chính là thứ mỗi link phân trang tự đặt lại',
};

test('buildOrderFilter đọc đúng bộ trường ta nghĩ (mốc nhận dạng còn sống)', () => {
  const src = rd('apps/seller/src/orders.js');
  const doc = [...src.matchAll(/query\.get\('([a-z_]+)'\)/g)].map((m) => m[1]);
  for (const f of ['q', 'from', 'to', 'source', 'payment', 'status', 'migrated', 'sync_status', 'attention']) {
    assert.ok(doc.includes(f), `buildOrderFilter không còn đọc "${f}" — mốc chết, sửa lại bộ test`);
  }
});

test('nguồn POS chỉ được lọc để quan sát, không lọt vào allowlist tạo đơn tay', () => {
  const src = rd('apps/seller/src/orders.js');
  const writeSet = /const ORDER_SOURCES = new Set\(\[([^\]]+)\]\)/.exec(src)?.[1] ?? '';
  const filterSet = /const ORDER_FILTER_SOURCES = new Set\(\[\.\.\.ORDER_SOURCES,([^\]]+)\]\)/.exec(src)?.[1] ?? '';
  assert.doesNotMatch(writeSet, /kiotviet_pos|sapo_pos/, 'client không được giả mạo nguồn doanh thu POS');
  assert.match(filterSet, /'kiotviet_pos'/);
  assert.match(filterSet, /'sapo_pos'/);
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
  const CAN = ['status', 'q', 'from', 'to', 'source', 'payment', 'migrated', 'sync_status', 'attention'];
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
  const thieu = ['status', 'q', 'from', 'to', 'source', 'payment', 'migrated', 'sync_status', 'attention']
    .filter((f) => !new RegExp(`^\\s*${f}:`, 'm').test(than));
  assert.deepEqual(thieu, [], 'BFF nuốt trường lọc → xuất ra cả đơn ngoài bộ lọc');
});

test('BFF danh sách chuyển tiếp đủ hai trục đồng bộ và việc cần xử lý', () => {
  const src = rd('apps/seller-admin/src/server.js');
  const start = src.indexOf('async function ordersList(');
  const end = src.indexOf('\nasync function ', start + 1);
  assert.ok(start >= 0 && end > start, 'không tìm thấy ordersList — mốc chết');
  const body = src.slice(start, end);
  assert.match(body, /q\.get\('sync_status'\)/,
    'BFF không đọc sync_status từ URL');
  assert.match(body, /q\.get\('attention'\)/,
    'BFF không đọc attention từ URL');
  assert.match(body, /qs\.set\('sync_status',\s*syncStatus\)/,
    'BFF đọc sync_status nhưng không chuyển tiếp xuống seller');
  assert.match(body, /qs\.set\('attention',\s*attention\)/,
    'BFF đọc attention nhưng không chuyển tiếp xuống seller');
});

test('form Lọc không khai trùng tên control', () => {
  const pages = rd('apps/seller-admin/src/pages.js');
  const start = pages.indexOf('export function renderOrders(');
  const end = pages.indexOf('\nexport function ', start + 10);
  assert.ok(start >= 0 && end > start, 'không tìm thấy renderOrders — mốc chết');
  const body = pages.slice(start, end);
  const form = /<form method="GET" class="filters">[\s\S]*?<\/form>/.exec(body)?.[0];
  assert.ok(form, 'không tìm thấy form Lọc — mốc chết');

  // Một tên xuất hiện hai lần (hidden + select) làm URLSearchParams.get() lấy giá trị
  // hidden trước, nên thao tác đổi bộ lọc trên giao diện bị nuốt mà không báo lỗi.
  const names = ['status', 'payment', 'migrated', 'q', 'from', 'to', 'source', 'sync_status', 'attention'];
  const duplicates = names
    .map((name) => [name, (form.match(new RegExp(`name="${name}"`, 'g')) ?? []).length])
    .filter(([, count]) => count !== 1);
  assert.deepEqual(duplicates, [], 'mỗi bộ lọc phải có đúng một control trong form Lọc');
});

test('BFF giữ đúng mọi nguồn chỉ-đọc của seller cho cả danh sách và CSV', () => {
  const seller = rd('apps/seller/src/orders.js');
  const admin = rd('apps/seller-admin/src/server.js');
  const literals = (text) => [...text.matchAll(/'([^']+)'/g)].map((m) => m[1]);

  const write = /const ORDER_SOURCES = new Set\(\[([^\]]+)\]\)/.exec(seller);
  const readOnly = /const ORDER_FILTER_SOURCES = new Set\(\[\.\.\.ORDER_SOURCES,([^\]]+)\]\)/.exec(seller);
  assert.ok(write && readOnly, 'không rút được hợp đồng nguồn đơn từ seller');
  const expected = [...literals(write[1]), ...literals(readOnly[1])].sort();

  const listStart = admin.indexOf('async function ordersList(');
  const listEnd = admin.indexOf('\nasync function ', listStart + 1);
  const listBody = admin.slice(listStart, listEnd);
  const listMatch = /const source = \[([^\]]+)\]\.includes\(q\.get\('source'\)\)/.exec(listBody);

  const exportStart = admin.indexOf('function ordersExportFields(');
  const exportEnd = admin.indexOf('\n}', exportStart) + 2;
  const exportBody = admin.slice(exportStart, exportEnd);
  const exportMatch = /source: \[([^\]]+)\]\.includes\(f\.source\)/.exec(exportBody);

  assert.ok(listMatch, 'không rút được allowlist nguồn ở danh sách đơn BFF');
  assert.ok(exportMatch, 'không rút được allowlist nguồn ở xuất CSV BFF');
  assert.deepEqual(literals(listMatch[1]).sort(), expected,
    'danh sách admin nuốt một nguồn chỉ-đọc của seller — chọn POS sẽ hiện lại mọi đơn');
  assert.deepEqual(literals(exportMatch[1]).sort(), expected,
    'xuất CSV nuốt một nguồn chỉ-đọc của seller — file sẽ rộng hơn tập người bán đang xem');
});

test('listOrders khai đủ và chỉ đủ cột attention theo ORDER_ATTENTION_FILTERS', () => {
  const { expected, sqlKeys, columns } = attentionSourceContract(rd('apps/seller/src/orders.js'));
  assert.deepEqual(sqlKeys.sort(), expected.slice().sort(),
    'ORDER_ATTENTION_SQL phải phủ đúng mọi trục attention (trừ open)');
  assert.deepEqual(columns.map((column) => column.aliasKey).sort(), expected.slice().sort(),
    'SELECT dòng phải có đúng một alias attention cho mỗi trục');
});

test('mỗi alias attention trong SELECT dùng đúng ORDER_ATTENTION_SQL tương ứng', () => {
  const { expected, columns } = attentionSourceContract(rd('apps/seller/src/orders.js'));
  for (const key of expected) {
    const matches = columns.filter((column) => column.expressionKey === key && column.aliasKey === key);
    assert.equal(matches.length, 1,
      `attention_${key} phải dùng chính ORDER_ATTENTION_SQL.${key}, không chép tay biểu thức`);
  }
});

test('seller, BFF và nhãn dùng cùng từ vựng attention/sync_status', () => {
  const seller = rd('apps/seller/src/orders.js');
  const admin = rd('apps/seller-admin/src/server.js');
  const pages = rd('apps/seller-admin/src/pages.js');
  const listStart = admin.indexOf('async function ordersList(');
  const listEnd = admin.indexOf('\nasync function ', listStart + 1);
  assert.ok(listStart >= 0 && listEnd > listStart, 'không tìm thấy ordersList — mốc chết');
  const listBody = admin.slice(listStart, listEnd);
  const exportStart = admin.indexOf('function ordersExportFields(');
  const exportEnd = admin.indexOf('\nasync function doOrdersExport', exportStart);
  assert.ok(exportStart >= 0 && exportEnd > exportStart, 'không tìm thấy ordersExportFields — mốc chết');
  const exportBody = admin.slice(exportStart, exportEnd);

  const sellerAttention = vocabularyArray(
    seller,
    /export const ORDER_ATTENTION_FILTERS\s*=\s*(\[[^\]]*\]);/,
    'ORDER_ATTENTION_FILTERS',
  );
  const sellerSync = vocabularyArray(
    seller,
    /export const ORDER_SYNC_STATUSES\s*=\s*(\[[^\]]*\]);/,
    'ORDER_SYNC_STATUSES',
  );
  const listAttention = vocabularyArray(
    listBody,
    /(\[[^\]]*\])\.includes\(rawAttention\)/,
    'allowlist attention của ordersList',
  );
  const listSync = vocabularyArray(
    listBody,
    /(\[[^\]]*\])\.includes\(q\.get\('sync_status'\)\)/,
    'allowlist sync_status của ordersList',
  );
  const exportAttention = vocabularyArray(
    exportBody,
    /(\[[^\]]*\])\.includes\(v\)\s*\?\s*v\s*:/,
    'allowlist attention của ordersExportFields',
  );
  const exportSync = vocabularyArray(
    exportBody,
    /(\[[^\]]*\])\.includes\(f\.sync_status\)/,
    'allowlist sync_status của ordersExportFields',
  );
  const labelAttention = vocabularyLabelKeys(pages, 'ORDER_ATTENTION_LABEL');
  const labelSync = vocabularyLabelKeys(pages, 'ORDER_SYNC_LABEL');

  for (const [name, values] of [
    ['ORDER_ATTENTION_FILTERS phía seller', sellerAttention],
    ['allowlist attention của ordersList', listAttention],
    ['allowlist attention của ordersExportFields', exportAttention],
  ]) {
    assert.ok(values.includes('open'), `${name} phải có trục hợp nhất "open"`);
  }
  assert.ok(!labelAttention.includes('open'), 'ORDER_ATTENTION_LABEL không được khai "open" — đây là phép hợp nhất');
  assert.deepEqual(sorted(withoutOpen(listAttention)), sorted(withoutOpen(sellerAttention)),
    'ordersList lệch từ vựng attention so với seller');
  assert.deepEqual(sorted(withoutOpen(exportAttention)), sorted(withoutOpen(sellerAttention)),
    'ordersExportFields lệch từ vựng attention so với seller');
  assert.deepEqual(sorted(labelAttention), sorted(withoutOpen(sellerAttention)),
    'ORDER_ATTENTION_LABEL lệch từ vựng attention so với seller');

  for (const [name, values] of [
    ['allowlist sync_status của ordersList', listSync],
    ['allowlist sync_status của ordersExportFields', exportSync],
    ['ORDER_SYNC_LABEL', labelSync],
  ]) {
    assert.deepEqual(sorted(values), sorted(sellerSync), `${name} lệch từ vựng sync_status so với seller`);
  }
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
