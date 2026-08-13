import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const pages = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'pages.js'), 'utf8');
const server = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'server.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'seller', 'src', 'dashboard.js'), 'utf8');

test('notification queue has SSR render, failed-email retry form, and escaped output helpers', () => {
  assert.match(pages, /export function renderNotificationDeliveries\(/);
  assert.match(pages, /d\.status === 'failed' && d\.channel === 'email'/);
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
  assert.match(dashboard, /shipment_attention: n\(out\.todo\.shipment_attention\)/);
  assert.match(pages, /label: 'Vận đơn cần xử lý'.*overview#shipment-attention/s);
  assert.match(pages, /id="shipment-attention"/);
  assert.match(pages, /orders\/\$\{esc\(item\.order_id\)\}\?timeline=shipment/);
  assert.match(pages, /Chưa rõ hãng đã tạo hay chưa/);
  assert.match(pages, /Hãng đã tạo nhưng hệ thống chưa chốt đơn/);
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
