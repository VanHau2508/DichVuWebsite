// UNIT: service nào IMPORT công thức tồn an toàn thì compose PHẢI mount file đó vào.
//
// VÌ SAO CÓ BỘ NÀY. packages/inventory/src/safety-stock.js là MỘT bản duy nhất dùng chung cho
// checkout · storefront · seller. Image của mỗi service build từ context riêng nên KHÔNG chứa
// packages/ — file tới được /app/safety-stock.js bằng bind-mount khai trong compose (cùng cơ
// chế với packages/net-guard và packages/auth/src/ratelimit.js).
//
// Đánh đổi đã chọn: một bản dùng chung (không thể trôi lệch) đổi lấy một phụ thuộc VÔ HÌNH —
// Dockerfile không nhắc gì tới nó, nên thêm service mới hoặc dọn compose là mất mount như chơi.
// Mất mount thì service CHẾT LÚC KHỞI ĐỘNG (không giải được import). Hỏng to và hỏng sớm là cố
// ý, nhưng phát hiện lúc deploy vẫn muộn hơn phát hiện trong CI — nên có bộ này.
//
// KHI ĐỎ: đừng gỡ import. Thêm dòng mount vào ĐÚNG khối service ở CẢ HAI file compose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { paymentFilterSql, paymentSummary } from '../../../packages/orders/src/owed.js';
import { computeShipping } from '../../../packages/shipping/src/quote.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const doc = (p) => readFileSync(join(ROOT, p), 'utf8');

const MOUNT = '../packages/inventory/src/safety-stock.js:/app/safety-stock.js:ro';
const IMPORT = "from '../safety-stock.js'";
const XLSX_MOUNT = '../apps/seller/src/xlsx-read.js:/app/xlsx-read.js:ro';

// Tên thư mục service → tên service trong compose (trùng nhau ở repo này, giữ ánh xạ cho rõ).
function servicesDungCongThuc() {
  const out = new Set();
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const src = join(ROOT, 'apps', app, 'src');
    if (!existsSync(src)) continue;
    for (const f of readdirSync(src)) {
      if (!f.endsWith('.js')) continue;
      if (readFileSync(join(src, f), 'utf8').includes(IMPORT)) out.add(app);
    }
  }
  return [...out].sort();
}

// Cắt file compose thành từng khối service. Khối bắt đầu ở dòng `  <ten>:` (đúng 2 dấu cách)
// và kết thúc ngay trước khối kế tiếp cùng mức.
function khoiService(composePath) {
  const lines = doc(composePath).split('\n');
  const blocks = new Map();
  let cur = null, buf = [];
  for (const line of lines) {
    const m = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (m) { if (cur) blocks.set(cur, buf.join('\n')); cur = m[1]; buf = []; continue; }
    if (cur) buf.push(line);
  }
  if (cur) blocks.set(cur, buf.join('\n'));
  return blocks;
}

test('service nào import công thức tồn an toàn thì cả hai compose đều mount file đó', () => {
  const services = servicesDungCongThuc();
  // Chốt chặn cho chính bộ test: nếu đổi tên file/đường import mà quên sửa hằng IMPORT ở trên
  // thì danh sách rỗng → mọi khẳng định dưới đây thành vô nghĩa mà vẫn XANH.
  assert.ok(services.length >= 3, `chỉ thấy ${services.length} service import công thức — kỳ vọng ≥3 (checkout/storefront/seller). Đổi đường import mà chưa sửa bộ test?`);

  for (const compose of ['infra/compose.dev.yml', 'infra/compose.prod.yml']) {
    const blocks = khoiService(compose);
    for (const svc of services) {
      const block = blocks.get(svc);
      assert.ok(block, `${compose}: không thấy khối service "${svc}"`);
      assert.ok(block.includes(MOUNT),
        `${compose}: service "${svc}" import '../safety-stock.js' nhưng KHÔNG mount file đó.\n` +
        `  → thêm vào volumes của "${svc}":  - ${MOUNT}`);
    }
  }
});

test('seller-admin import XLSX thì cả hai compose đều mount bộ đọc dùng chung', () => {
  const server = doc('apps/seller-admin/src/server.js');
  assert.match(server, /from ['"]\.\.\/xlsx-read\.js['"]/, 'seller-admin không còn import bộ đọc XLSX');
  for (const compose of ['infra/compose.dev.yml', 'infra/compose.prod.yml']) {
    const block = khoiService(compose).get('seller-admin');
    assert.ok(block, `${compose}: không thấy khối service "seller-admin"`);
    assert.ok(block.includes(XLSX_MOUNT),
      `${compose}: seller-admin import xlsx-read.js nhưng KHÔNG mount bộ đọc dùng chung.\n` +
      `  → thêm vào volumes của seller-admin:  - ${XLSX_MOUNT}`);
  }
});

// CÔNG THỨC CÒN NỢ KHÁCH (packages/orders/src/owed.js) đi cùng cơ chế — nhưng có một cái bẫy
// riêng: `account` để mã ở /app/apps/account/src nên '../owed.js' trỏ /app/apps/account/owed.js,
// KHÔNG phải /app/owed.js như seller/checkout. Mount sai đích thì container chết ngay lúc khởi
// động với ERR_MODULE_NOT_FOUND — đã dính đúng một lần khi thêm service này (docs/67). Vì vậy
// đích mount tra theo TỪNG service, không dùng chung một chuỗi.
const OWED_IMPORT = "from '../owed.js'";
const OWED_DICH = { account: '/app/apps/account/owed.js' };   // mặc định: /app/owed.js
const owedMount = (svc) => `../packages/orders/src/owed.js:${OWED_DICH[svc] ?? '/app/owed.js'}:ro`;

function servicesDungOwed() {
  const out = new Set();
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const src = join(ROOT, 'apps', app, 'src');
    if (!existsSync(src)) continue;
    for (const f of readdirSync(src)) {
      if (!f.endsWith('.js')) continue;
      if (readFileSync(join(src, f), 'utf8').includes(OWED_IMPORT)) out.add(app);
    }
  }
  return [...out].sort();
}

test('service nào import công thức CÒN NỢ KHÁCH thì cả hai compose đều mount đúng ĐÍCH', () => {
  const services = servicesDungOwed();
  // Cùng chốt chặn tự-lừa như trên: đổi đường import mà quên sửa hằng → danh sách rỗng → xanh giả.
  assert.ok(services.length >= 3,
    `chỉ thấy ${services.length} service import '../owed.js' — kỳ vọng ≥3 (seller/checkout/account). Đổi đường import mà chưa sửa bộ test?`);
  for (const compose of ['infra/compose.dev.yml', 'infra/compose.prod.yml']) {
    const blocks = khoiService(compose);
    for (const svc of services) {
      const block = blocks.get(svc);
      assert.ok(block, `${compose}: không thấy khối service "${svc}"`);
      assert.ok(block.includes(owedMount(svc)),
        `${compose}: service "${svc}" import '../owed.js' nhưng KHÔNG mount đúng đích.\n` +
        `  → thêm vào volumes của "${svc}":  - ${owedMount(svc)}`);
    }
  }
});

const PHONE_IMPORT = "from '../phone.js'";
const PHONE_DICH = { account: '/app/apps/account/phone.js' };
const phoneMount = (svc) => `../packages/customer-input/src/phone.js:${PHONE_DICH[svc] ?? '/app/phone.js'}:ro`;

test('service nào chuẩn hoá SĐT khách thì cả hai compose đều mount đúng một file dùng chung', () => {
  const services = [];
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const src = join(ROOT, 'apps', app, 'src');
    if (!existsSync(src)) continue;
    if (readdirSync(src).some((f) => f.endsWith('.js') && readFileSync(join(src, f), 'utf8').includes(PHONE_IMPORT))) {
      services.push(app);
    }
  }
  assert.ok(services.length >= 3,
    `chỉ thấy ${services.length} service import '../phone.js' — kỳ vọng checkout/seller/account`);
  for (const compose of ['infra/compose.dev.yml', 'infra/compose.prod.yml']) {
    const blocks = khoiService(compose);
    for (const svc of services) {
      assert.ok(blocks.get(svc)?.includes(phoneMount(svc)),
        `${compose}: service ${svc} thiếu mount ${phoneMount(svc)}`);
    }
  }
});

test('chuẩn hoá SĐT chỉ có một implementation runtime', () => {
  assert.match(doc('packages/customer-input/src/phone.js'), /export function canonPhone\b/);
  for (const path of [
    'apps/checkout/src/server.js',
    'apps/seller/src/orders.js',
    'apps/seller/src/order-requests.js',
    'apps/account/src/server.js',
  ]) {
    const src = doc(path);
    assert.match(src, /import \{ canonPhone \} from '\.\.\/phone\.js'/, `${path}: chưa import module dùng chung`);
    assert.doesNotMatch(src, /function canonPhone\b/, `${path}: vẫn giữ bản canonPhone riêng`);
  }
});

test('checkout và seller dùng chung một công thức báo giá vận chuyển và đủ bind-mount', () => {
  const sharedImport = "from '../shipping-quote.js'";
  const sharedMount = '../packages/shipping/src/quote.js:/app/shipping-quote.js:ro';
  const services = ['checkout', 'seller'];
  for (const path of ['apps/checkout/src/server.js', 'apps/seller/src/order-requests.js']) {
    assert.match(doc(path), /import \{ computeShipping \} from '\.\.\/shipping-quote\.js'/,
      `${path}: chưa dùng công thức vận chuyển chung`);
  }
  assert.doesNotMatch(doc('apps/checkout/src/server.js'), /function computeShipping\b/,
    'checkout vẫn giữ bản computeShipping riêng');
  assert.ok(services.every((svc) => doc(`apps/${svc}/src/${svc === 'seller' ? 'order-requests.js' : 'server.js'}`).includes(sharedImport)));
  for (const compose of ['infra/compose.dev.yml', 'infra/compose.prod.yml']) {
    const blocks = khoiService(compose);
    for (const svc of services) {
      assert.ok(blocks.get(svc)?.includes(sharedMount), `${compose}: ${svc} thiếu mount ${sharedMount}`);
    }
  }
});

test('công thức vận chuyển chung giữ phí vùng, phụ phí cân và chốt ngoài bán kính', () => {
  const cfg = {
    fee: 30000, feeFar: 50000, fromRegion: 'nam', threshold: null,
    extraPer500g: 5000, defaultWeightGram: 500,
    mode: 'region', base: 10000, perKm: 3000, maxKm: 10, overMax: 'reject',
  };
  const items = [{ qty: 2, weight_gram: 600 }];
  assert.equal(computeShipping(cfg, 200000, items, 'nam', { assumeFarWhenUnknown: true }), 40000);
  assert.equal(computeShipping(cfg, 200000, items, 'bac', { assumeFarWhenUnknown: true }), 60000);
  assert.equal(computeShipping({ ...cfg, mode: 'distance' }, 200000, items, 'nam', {
    assumeFarWhenUnknown: true, coordsValid: true, distanceMeters: 11000,
  }), null);
});

test('công thức còn-nợ-khách là MỘT bản, xuất đủ các mảnh và không âm', () => {
  const src = doc('packages/orders/src/owed.js');
  for (const name of ['OWED_ENTITLED_SQL', 'OWED_REFUNDED_SQL', 'OWED_SQL', 'OWED_REASON_SQL']) {
    assert.ok(new RegExp(`export const ${name}\\b`).test(src), `thiếu export ${name}`);
  }
  // OWED_SQL phải DỰNG TRÊN hai mảnh kia — chép lại biểu thức lần hai đúng là lớp lỗi cần chặn.
  assert.match(src, /OWED_SQL = `[^`]*\$\{OWED_REFUNDED_SQL\}[^`]*\$\{OWED_ENTITLED_SQL\}/,
    'OWED_SQL không dùng lại hai mảnh con');
  // Chặn ở 0: số âm nghĩa là shop trả DƯ, không phải khách nợ shop. Bỏ chặn thì con số âm đó
  // sẽ bị cộng vào một tổng nào đó và ăn mất khoản nợ của đơn khác.
  assert.match(src, /greatest\(0,/, 'công thức không chặn ở 0');
  assert.match(src, /fulfillment_adjustment_vnd/,
    'công thức chưa trừ giá trị phần hàng không giao đã được chốt');
});

test('payment summary phân biệt trả thiếu, trả dư và tiền nằm trên đơn đã chết', () => {
  assert.equal(paymentSummary({
    total_vnd: 0, amount_paid_vnd: 0, refunded_vnd: 0, status: 'pending',
  }).display_state, 'paid', 'đơn 0đ thuộc paid, không được đồng thời xuất hiện trong unpaid');
  assert.deepEqual(paymentSummary({
    total_vnd: 500000, amount_paid_vnd: 200000, refunded_vnd: 0, status: 'pending',
  }), {
    total_vnd: 500000, received_vnd: 200000, refunded_vnd: 0, net_received_vnd: 200000,
    amount_due_vnd: 300000, customer_credit_vnd: 0, display_state: 'partial',
  });
  assert.equal(paymentSummary({
    total_vnd: 500000, amount_paid_vnd: 550000, refunded_vnd: 0, status: 'confirmed',
  }).display_state, 'overpaid');
  assert.deepEqual(paymentSummary({
    total_vnd: 1000000, fulfillment_adjustment_vnd: 400000,
    amount_paid_vnd: 0, refunded_vnd: 0, status: 'delivered',
  }), {
    total_vnd: 1000000, received_vnd: 0, refunded_vnd: 0, net_received_vnd: 0,
    amount_due_vnd: 600000, customer_credit_vnd: 0, display_state: 'unpaid',
  });
  assert.equal(paymentSummary({
    total_vnd: 1000000, fulfillment_adjustment_vnd: 400000,
    amount_paid_vnd: 1000000, refunded_vnd: 0, status: 'delivered',
  }).customer_credit_vnd, 400000, 'thu COD theo tổng cũ phải hiện khoản nợ khách của phần không giao');
  assert.deepEqual(paymentSummary({
    total_vnd: 500000, amount_paid_vnd: 200000, refunded_vnd: 0, status: 'cancelled',
  }), {
    total_vnd: 500000, received_vnd: 200000, refunded_vnd: 0, net_received_vnd: 200000,
    amount_due_vnd: 0, customer_credit_vnd: 200000, display_state: 'refund_due',
  });
});

test('dashboard và danh sách đơn dùng chung predicate số tiền thực nhận', () => {
  const dashboard = doc('apps/seller/src/dashboard.js');
  const orders = doc('apps/seller/src/orders.js');
  assert.match(dashboard, /PAYMENT_UNPAID_SQL/);
  assert.match(dashboard, /PAYMENT_PARTIAL_SQL/);
  assert.match(orders, /paymentFilterSql\(payment\)/);
  assert.match(paymentFilterSql('unpaid'), /OWED_PAID_SQL|amount_paid_vnd|paid_at/);
  assert.match(paymentFilterSql('unpaid'), /greatest\(0, o\.total_vnd - coalesce\(o\.fulfillment_adjustment_vnd, 0\)\)\) > 0/,
    'đơn 0đ không được đồng thời khớp unpaid và paid');
  assert.match(paymentFilterSql('unpaid'), /o\.status NOT IN \('cancelled', 'refunded', 'returned'\)/);
  assert.match(paymentFilterSql('unpaid'), /NOT o\.is_migrated/,
    'hàng đợi thu tiền không được chứa đơn lịch sử di cư');
  assert.match(paymentFilterSql('unpaid'), /o\.payment_status <> 'refunded'/,
    'bộ lọc refunded phải rời với unpaid');
  assert.match(paymentFilterSql('pending'), /> 0[\s\S]*< \(greatest\(0, o\.total_vnd - coalesce\(o\.fulfillment_adjustment_vnd, 0\)\)\)/);
  assert.match(paymentFilterSql('pending'), /o\.status NOT IN \('cancelled', 'refunded', 'returned'\)/);
  assert.match(paymentFilterSql('pending'), /NOT o\.is_migrated/);
  assert.match(paymentFilterSql('pending'), /o\.payment_status <> 'refunded'/,
    'bộ lọc refunded phải rời với partial');
  assert.doesNotMatch(dashboard, /PAYMENT_(?:UNPAID|PARTIAL)_SQL\}[\s\S]{0,80}status NOT IN/,
    'dashboard không được chép lại điều kiện đơn sống bên ngoài predicate dùng chung');
  assert.match(orders, /SELECT count\(\*\)::int n FROM orders o \$\{whereSql\}/);
  assert.match(orders, /FROM orders o \$\{whereNoStatusSql\}/);
  assert.match(orders, /SELECT count\(\*\)::int AS n FROM orders o \$\{F\.whereSql\}/);
  assert.match(orders, /FROM orders o \$\{F\.whereSql\} ORDER BY order_number DESC/);
  assert.equal(paymentFilterSql('unknown'), null);
});

test('hoàn tiền trên đơn còn sống không mở lại khoản phải thu từ khách', () => {
  const partialRefund = paymentSummary({
    total_vnd: 500000, amount_paid_vnd: 500000, refunded_vnd: 200000, status: 'shipped',
  });
  assert.equal(partialRefund.received_vnd, 500000, 'phiếu hoàn không được xoá số tiền đã thu');
  assert.equal(partialRefund.refunded_vnd, 200000);
  assert.equal(partialRefund.net_received_vnd, 300000);
  assert.equal(partialRefund.amount_due_vnd, 0,
    'đã thu đủ rồi hoàn một phần không có nghĩa là khách phải chuyển lại phần vừa được hoàn');

  const fullRefund = paymentSummary({
    total_vnd: 500000, amount_paid_vnd: 500000, refunded_vnd: 500000, status: 'shipped',
  });
  assert.equal(fullRefund.net_received_vnd, 0);
  assert.equal(fullRefund.amount_due_vnd, 0,
    'phiếu hoàn đủ trên đơn chưa đổi trạng thái cũng không được làm QR/số còn thiếu sống lại');
});

test('tracking khóa order trước khi đổi trạng thái shipment', () => {
  const src = doc('apps/worker/src/index.js');
  const sweepAt = src.indexOf('async function sweepTracking()');
  const txAt = src.indexOf("await c.query('BEGIN');", sweepAt);
  const lockAt = src.indexOf('await lockTrackingOrder(c, s.order_id)', txAt);
  const branchAt = src.indexOf("if (st.state === 'delivered')", txAt);

  assert.ok(sweepAt >= 0 && txAt > sweepAt && lockAt > txAt && branchAt > lockAt,
    'sweep phải khóa order ngay sau BEGIN và trước mọi nhánh đổi shipment');
  assert.match(src, /async function lockTrackingOrder[\s\S]*?SELECT id FROM orders WHERE id = \$1 FOR UPDATE/,
    'helper khóa order phải dùng row lock FOR UPDATE');
});

test('file công thức dùng chung tồn tại và xuất đủ ba thứ', () => {
  const src = doc('packages/inventory/src/safety-stock.js');
  for (const name of ['SAFETY_SQL', 'AVAIL_SQL', 'availOf']) {
    assert.ok(new RegExp(`export const ${name}\\b`).test(src), `thiếu export ${name}`);
  }
  // AVAIL_SQL phải DỰNG TRÊN SAFETY_SQL, không được chép lại biểu thức đệm lần thứ hai —
  // đó đúng là lớp lỗi mà cả file này sinh ra để chặn.
  assert.match(src, /AVAIL_SQL = `[^`]*\$\{SAFETY_SQL\}/, 'AVAIL_SQL không dùng lại SAFETY_SQL');
  // Làm tròn LÊN: đệm là vùng chống sai số nên chệch về phía giữ NHIỀU hơn mới đúng ý định.
  assert.match(src, /ceil\(/, 'công thức đệm không làm tròn lên (ceil)');
});

test('dashboard và catalog dùng ATS cho mọi tín hiệu còn bán được online', () => {
  const dashboard = doc('apps/seller/src/dashboard.js');
  const catalog = doc('apps/seller/src/catalog.js');

  assert.match(dashboard, /import \{ AVAIL_SQL \} from '\.\.\/safety-stock\.js'/);
  assert.match(dashboard, /AS available[\s\S]*?WHERE \$\{AVAIL_SQL\} <=/,
    'danh sách tồn thấp phải dùng ATS cho cả số hiển thị lẫn điều kiện');
  assert.match(dashboard, /AS low_stock_count/);
  assert.doesNotMatch(dashboard, /il\.on_hand\s*-\s*il\.reserved/,
    'dashboard không được tự tính tồn bán được mà bỏ qua safety stock');

  assert.match(catalog, /import \{ AVAIL_SQL \} from '\.\.\/safety-stock\.js'/);
  assert.match(catalog, /export const sellableCount[\s\S]*?\$\{AVAIL_SQL\} > 0/);
  assert.match(catalog, /query\.get\('stock'\) === 'low'[\s\S]*?\$\{AVAIL_SQL\} <=/);
  assert.match(catalog, /sum\(\$\{AVAIL_SQL\}\)/,
    'tổng tồn còn bán được online phải cộng ATS từng biến thể');
  assert.match(catalog, /coalesce\(\$\{AVAIL_SQL\}, 0\) <= 0/,
    'số biến thể hết hàng phải dựa trên ATS');
  assert.doesNotMatch(catalog, /il\.on_hand\s*-\s*il\.reserved/,
    'catalog không được giữ phép tính tồn bán được thứ hai');
});
