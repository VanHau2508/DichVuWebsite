import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const pages = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'pages.js'), 'utf8');
const operationsCenter = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'operations-center.js'), 'utf8');
const server = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'server.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'seller', 'src', 'dashboard.js'), 'utf8');
const { withOptionalDashboardGroup } = await import('../../seller/src/dashboard-contract.js');
const { shipmentAttentionPresentation } = await import('../src/operations-center.js');

test('notification queue has SSR render, failed-email retry form, and escaped output helpers', () => {
  assert.match(pages, /export function renderNotificationDeliveries\(/);
  assert.match(pages, /const retry = d\.retryable/);
  assert.match(pages, /topic_not_retryable:/);
  assert.match(pages, /\$\{base\}\/\$\{esc\(d\.id\)\}\/retry/);
  assert.match(pages, /esc\(d\.last_error\)/);
  assert.match(pages, /\['retrying', 'Đang thử lại'\]/);
  assert.match(pages, /\['skipped', 'Đã bỏ qua'\]/);
});

test('resolution queue links cases to order detail and exposes active status guidance', () => {
  assert.match(pages, /export function renderResolutionCases\(/);
  assert.match(pages, /orders\/\$\{esc\(c\.order_id\)\}\?timeline=shipment/);
  assert.match(pages, /Không tự hoàn tiền hoặc nhập lại kho/);
  assert.match(pages, /waiting_return/);
});

test('order request queue exposes approve and reject forms with escaped request id', () => {
  assert.match(pages, /export function renderOrderRequests\(/);
  assert.match(pages, /\$\{base\}\/\$\{esc\(r\.id\)\}\/approve/);
  assert.match(pages, /\$\{base\}\/\$\{esc\(r\.id\)\}\/reject/);
  assert.match(pages, /name="order_id" value="\$\{esc\(r\.order_id\)\}"/);
  assert.match(pages, /name="note"/);
  assert.match(pages, /r\.status === 'approved' && r\.request_type === 'return'/);
  assert.match(pages, /return\?request_id=\$\{encodeURIComponent\(r\.id\)\}/);
});

test('approved return request is carried through receive form and step-up', () => {
  assert.match(server, /r\.json\?\.next_action === 'receive_return' \|\| r\.json\?\.status === 'approved'/);
  assert.match(server, /orders\/\$\{orderId\}\/return\?request_id=\$\{encodeURIComponent\(requestId\)\}/);
  assert.match(server, /request_id: String\(f\.get\('request_id'\)/);
  assert.match(server, /linked\.request_type !== 'return' \|\| linked\.status !== 'approved'/);
  assert.match(server, /url\.searchParams\.get\('request_id'\)/);
  assert.match(pages, /name="request_id" value="\$\{esc\(requestId\)\}"/);
  assert.match(pages, /body\.request_id \? hid\('request_id', body\.request_id\)/);
  assert.match(server, /const r = await sellerApi\('POST', `\/shops\/\$\{shopId\}\/orders\/\$\{oid\}\/return`, \{ cookie, body \}\)/);
  assert.match(server, /if \(r\.status === 200\) return redirect\(res, `\/shops\/\$\{shopId\}\/orders\/\$\{oid\}\?returned=1/);
});

test('seller-admin routes guard all three queues and retry/decision POSTs', () => {
  assert.match(server, /notification-deliveries\$.*req\.method === 'GET'/s);
  assert.match(server, /notification-deliveries\/\$\{UUID\}\/retry\$.*req\.method === 'POST'/s);
  assert.match(server, /resolution-cases\$.*req\.method === 'GET'/s);
  assert.match(server, /order-requests\$.*req\.method === 'GET'/s);
  assert.match(server, /order-requests\/\$\{UUID\}\/\(approve\|reject\)\$.*req\.method === 'POST'/s);
});

test('dashboard không nuốt lỗi tải readiness', () => {
  assert.match(server, /const readinessLoadError = readinessR\.status === 200/);
  assert.match(server, /Chưa tải được kiểm tra điều kiện mở bán/);
  assert.match(server, /readinessErr \?\? readinessLoadError/);
});

test('dashboard đưa vận đơn chưa chốt vào hàng đợi có hành động thật', () => {
  assert.match(dashboard, /s\.status = 'created'/);
  assert.match(dashboard, /s\.provider_status IN \('ambiguous','finalize_failed'\)/);
  assert.match(dashboard, /AND NOT o\.is_migrated/);
  assert.match(dashboard, /AS shipment_attention/);
  assert.match(dashboard, /shipment_attention: out\.shipmentAttention\.map/);
  assert.match(dashboard, /shipment_attention: out\.todo \? n\(out\.todo\.shipment_attention\) : null/);
  assert.match(pages, /label: \(\) => 'Vận đơn cần xử lý'.*overview#shipment-attention/s);
  assert.match(pages, /id="shipment-attention"/);
  assert.match(pages, /orders\/\$\{esc\(item\.order_id\)\}\?timeline=shipment/);
  assert.match(pages, /Chưa rõ hãng đã tạo hay chưa/);
  assert.match(pages, /Hãng đã tạo nhưng hệ thống chưa chốt đơn/);
});

test('stats mở rộng theo hợp đồng trung tâm vận hành và không biến lỗi tùy chọn thành số 0', () => {
  assert.match(dashboard, /const generatedAt = \(await c\.query\('SELECT now\(\) AS generated_at'\)\)/);
  assert.match(dashboard, /generated_at: out\.generatedAt/);
  assert.match(dashboard, /partial: \{ failed: out\.partial \}/);
  assert.match(dashboard, /sync: out\.sync/);
  assert.match(dashboard, /todo_items: todoItems/);
  assert.match(dashboard, /const available = CORE_TODO_FIELDS\.has\(d\.field\) \|\| !!out\.todo/);
  assert.match(dashboard, /optional\('top_products'/);
  assert.match(dashboard, /optional\('series'/);
  assert.match(dashboard, /optional\('low_stock'/);
  assert.match(dashboard, /optional\('todo'/);
  assert.match(dashboard, /optional\('sync'/);
  // Seller API không được trở thành nơi dựng đường dẫn hoặc quyền của seller-admin.
  const responseStart = dashboard.indexOf('return send(res, 200, {');
  const responseEnd = dashboard.indexOf('\n}\n\nexport const DASHBOARD_ROUTES', responseStart);
  const responseTail = dashboard.slice(responseStart, responseEnd > responseStart ? responseEnd : undefined);
  assert.doesNotMatch(responseTail, /href:/);
  assert.doesNotMatch(responseTail, /perm:/);
});

test('tên nhóm partial khớp hai service và helper nhận đúng mảng partial của response', () => {
  const produced = [...dashboard.matchAll(/\boptional\('([^']+)'/g)].map((m) => m[1]);
  const consumed = [
    ...pages.matchAll(/\b(?:partialFailed|failedGroups)\.has\('([^']+)'\)/g),
    ...operationsCenter.matchAll(/\bfailedGroups\.has\('([^']+)'\)/g),
  ].map((m) => m[1]);
  assert.deepEqual([...new Set(produced)].sort(), [...new Set(consumed)].sort());
  assert.match(dashboard, /withOptionalDashboardGroup\(c, partial, name, fn, fallback\)/);
});

test('renderOverview giữ chỗ cho dữ liệu chưa lấy được thay vì render số 0 giả', () => {
  assert.match(pages, /const todoByCode = new Map/);
  assert.match(pages, /item\.available !== false/);
  assert.match(pages, /Chưa lấy được dữ liệu/);
  assert.match(pages, /todoUnavailable/);
  assert.match(pages, /topUnavailable/);
  assert.match(pages, /seriesUnavailable/);
  assert.match(pages, /lowUnavailable/);
  assert.match(pages, /failedGroups\.has\('sync'\)/);
});

test('trạng thái đồng bộ chưa từng chạy không hiển thị độ trễ 0 giây giả', () => {
  assert.match(pages, /sync\?\.lag_seconds != null && Number\.isFinite\(Number\(sync\.lag_seconds\)\)/);
  assert.match(pages, /\? `\$\{Math\.max\(0, Number\(sync\.lag_seconds\)\)\} giây` : '—'/);
});

test('nhóm stats tùy chọn ghi nhận lỗi thật qua savepoint, không chỉ ghim response', async () => {
  const calls = [];
  const client = { query: async (sql) => { calls.push(sql); } };
  const partial = [];
  const value = await withOptionalDashboardGroup(client, partial, 'low_stock', async () => {
    throw new Error('fixture intentionally fails');
  }, []);
  assert.deepEqual(value, []);
  assert.deepEqual(partial, ['low_stock']);
  assert.deepEqual(calls, [
    'SAVEPOINT dashboard_low_stock',
    'ROLLBACK TO SAVEPOINT dashboard_low_stock',
    'RELEASE SAVEPOINT dashboard_low_stock',
  ]);
});

test('nhóm stats tùy chọn thành công trả kết quả và giải phóng savepoint', async () => {
  const calls = [];
  const client = { query: async (sql) => { calls.push(sql); } };
  const partial = [];
  const expected = [{ id: 'row-1' }];
  const value = await withOptionalDashboardGroup(client, partial, 'series', async () => expected, []);
  assert.equal(value, expected);
  assert.deepEqual(partial, []);
  assert.deepEqual(calls, [
    'SAVEPOINT dashboard_series',
    'RELEASE SAVEPOINT dashboard_series',
  ]);
});

test('danh sách vận đơn không bị che khi riêng truy vấn todo bị lỗi', () => {
  const state = shipmentAttentionPresentation(
    new Set(['todo']),
    { available: false, n: null },
    [{ order_id: 'T1' }, { order_id: 'T2' }],
  );
  assert.deepEqual(state, { unavailable: false, count: null, shouldRender: true });
  assert.deepEqual(
    shipmentAttentionPresentation(new Set(['shipment_attention']), { available: true, n: 7 }, []),
    { unavailable: true, count: 7, shouldRender: true },
  );
  assert.match(pages, /shipmentAttentionPresentation\(failedGroups, shipmentTodo, shipmentAttention\)/);
  assert.match(pages, /const shipmentAttentionCard = shipmentState\.shouldRender/);
  assert.match(pages, /Có \$\{esc\(shipmentCount\)\} ca đang mở nhưng chưa đọc được danh sách/);
});

test('sync đếm mọi discrepancy đang mở của shop, không chỉ integration được chọn hiển thị', () => {
  assert.match(dashboard, /WHERE d\.shop_id = current_shop_id\(\) AND d\.status = 'open'/);
  assert.doesNotMatch(dashboard, /d\.integration_id = i\.id AND d\.status = 'open'/);
});

test('thao tác đơn giữ cả lời giải thích và hành động tiếp theo từ seller', () => {
  const start = server.indexOf('async function orderAction(');
  const end = server.indexOf('async function orderResolutionAction(', start);
  assert.ok(start >= 0 && end > start, 'phải tìm thấy thân orderAction');
  const body = server.slice(start, end);
  assert.match(body, /r\.json\?\.message \?\? r\.json\?\.error/);
  assert.match(body, /r\.json\?\.action \? ` \$\{r\.json\.action\}`/);
  assert.doesNotMatch(body, /orderDetail\([^;]+r\.json\?\.error \?\? 'Thao tác không thực hiện được\.'/s);
});
