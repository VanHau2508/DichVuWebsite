import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { can, permsFor, needsStepUp, ROLES } from '../src/rbac.js';

const resolutionSource = readFileSync(new URL('../src/order-resolutions.js', import.meta.url), 'utf8');
const integrationSource = readFileSync(new URL('../src/integrations.js', import.meta.url), 'utf8');
const adminSource = readFileSync(new URL('../../seller-admin/src/server.js', import.meta.url), 'utf8');

test('owner có mọi quyền', () => {
  for (const p of ['catalog.write', 'orders.write', 'refund', 'members.write', 'domain.write', 'export']) {
    assert.equal(can('owner', p), true, p);
  }
});

test('admin: sản phẩm + đơn + hoàn tiền + theme + XEM nhân sự, KHÔNG đổi quyền/domain/export', () => {
  assert.equal(can('admin', 'catalog.write'), true);
  assert.equal(can('admin', 'orders.write'), true);
  assert.equal(can('admin', 'refund'), true);
  assert.equal(can('admin', 'theme.write'), true);
  assert.equal(can('admin', 'members.read'), true);
  assert.equal(can('admin', 'members.write'), false); // chỉ owner đổi quyền
  assert.equal(can('admin', 'domain.write'), false);
  assert.equal(can('admin', 'export'), false);
});

test('catalog_manager: chỉ sản phẩm', () => {
  assert.equal(can('catalog_manager', 'catalog.read'), true);
  assert.equal(can('catalog_manager', 'catalog.write'), true);
  assert.equal(can('catalog_manager', 'orders.read'), false);
  assert.equal(can('catalog_manager', 'members.read'), false);
});

test('order_manager: chỉ đơn hàng', () => {
  assert.equal(can('order_manager', 'orders.read'), true);
  assert.equal(can('order_manager', 'orders.write'), true);
  assert.equal(can('order_manager', 'catalog.read'), false);
  assert.equal(can('order_manager', 'refund'), false); // hoàn tiền không thuộc order manager
});

test('chốt COD và chốt bằng refund là hai route quyền khác nhau', () => {
  const routeLines = resolutionSource.split('\n').filter((line) => line.includes("{ m: 'POST'") && line.includes('accept-partial'));
  const plain = routeLines.filter((line) => line.includes('accept-partial$'));
  const withRefund = routeLines.filter((line) => line.includes('accept-partial-with-refund'));
  assert.equal(plain.length, 2, 'hai alias accept-partial phải còn cho client cũ');
  assert.ok(plain.every((line) => line.includes("perm: 'orders.write'") && !line.includes('stepUp: true')));
  assert.equal(withRefund.length, 2, 'hai alias refund phải cùng được bảo vệ');
  assert.ok(withRefund.every((line) => line.includes("perm: 'refund'") && line.includes('stepUp: true')));
});

test('audit.read: owner + admin xem nhật ký; catalog/order manager thì không', () => {
  assert.equal(can('owner', 'audit.read'), true);
  assert.equal(can('admin', 'audit.read'), true);
  assert.equal(can('catalog_manager', 'audit.read'), false);
  assert.equal(can('order_manager', 'audit.read'), false);
  assert.equal(needsStepUp('audit.read'), false); // chỉ đọc, không cần step-up
});

test('vai trò lạ không có quyền nào', () => {
  assert.equal(can('nobody', 'catalog.read'), false);
  assert.equal(can(undefined, 'catalog.read'), false);
});

test('thao tác nhạy cảm cần step-up', () => {
  assert.equal(needsStepUp('members.write'), true);
  assert.equal(needsStepUp('domain.write'), true);
  assert.equal(needsStepUp('export'), true);
  assert.equal(needsStepUp('refund'), true);
  assert.equal(needsStepUp('catalog.read'), false);
  assert.equal(needsStepUp('orders.read'), false);
});

test('permsFor liệt kê đúng, owner nhiều nhất', () => {
  assert.ok(permsFor('owner').length > permsFor('admin').length);
  assert.ok(permsFor('admin').length > permsFor('catalog_manager').length);
  assert.deepEqual(permsFor('order_manager').sort(), ['orders.read', 'orders.write']);
});

test('bốn vai trò khớp CHECK của DB', () => {
  assert.deepEqual(ROLES.sort(), ['admin', 'catalog_manager', 'order_manager', 'owner']);
});

test('reports.read: owner + admin xem báo cáo lãi; manager thì không (giá vốn = bí mật kinh doanh)', () => {
  assert.equal(can('owner', 'reports.read'), true);
  assert.equal(can('admin', 'reports.read'), true);
  assert.equal(can('catalog_manager', 'reports.read'), false); // NHẬP được cost (catalog.write) nhưng không XEM lãi
  assert.equal(can('order_manager', 'reports.read'), false);
  assert.equal(needsStepUp('reports.read'), false); // xem hằng ngày, không step-up
});

test('privacy.erase: CHỈ owner + bắt buộc step-up (ẩn danh là thao tác huỷ dữ liệu)', () => {
  assert.equal(can('owner', 'privacy.erase'), true);
  assert.equal(can('admin', 'privacy.erase'), false);
  assert.equal(can('catalog_manager', 'privacy.erase'), false);
  assert.equal(can('order_manager', 'privacy.erase'), false);
  assert.equal(needsStepUp('privacy.erase'), true);
});

test('connector POS giữ đúng quyền theo vai và mọi route tài chính cấu hình đều step-up', () => {
  const routeLines = integrationSource.split('\n').filter((line) => line.includes("{ m: '") && line.includes('/integrations'));
  const by = (needle) => routeLines.filter((line) => line.includes(needle));
  assert.equal(by('/kiotviet/probe$').length, 1);
  assert.ok(by('/kiotviet/probe$')[0].includes("perm: 'shop.write'") && by('/kiotviet/probe$')[0].includes('stepUp: true'));
  assert.equal(by('/kiotviet/activate$').length, 1);
  assert.ok(by('/kiotviet/activate$')[0].includes("perm: 'shop.write'") && by('/kiotviet/activate$')[0].includes('stepUp: true'));
  assert.equal(by('/disable$').length, 1);
  assert.ok(by('/disable$')[0].includes("perm: 'shop.write'") && by('/disable$')[0].includes('stepUp: true'));
  assert.equal(by('/mappings/').length, 2);
  assert.ok(by('/mappings/').every((line) => line.includes("perm: 'catalog.write'")));
  assert.ok(by('/discrepancies/')[0].includes("perm: 'orders.write'"));

  assert.match(integrationSource, /const UUID = '\(\[0-9a-f\]\{8\}-/, 'UUID route phải là nhóm bắt strict để params[1] là id đích');
});

test('BFF không hỏi mật khẩu vai không được quản lý credential POS', () => {
  for (const name of ['integrationProbe', 'integrationProbeStepUp', 'integrationActivate', 'integrationActivateStepUp']) {
    const start = adminSource.indexOf(`async function ${name}(`);
    const end = adminSource.indexOf('\n}', start);
    assert.ok(start > 0 && end > start, `không tìm thấy ${name}`);
    assert.match(adminSource.slice(start, end), /INTEGRATION_MANAGE_ROLES\.has\(roleFor\(me, shopId\)\)/,
      `${name} phải chặn vai ngoài owner/admin trước interstitial`);
  }
});

function functionSource(source, name, nextName) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf(`async function ${nextName}(`, start + 1);
  assert.ok(start >= 0 && end > start, `không cắt được hàm ${name}`);
  return source.slice(start, end);
}

test('phiên probe KiotViet dùng token bất biến qua activate để tab cũ không nhận bundle mới', () => {
  const probe = functionSource(integrationSource, 'probeKiotViet', 'activateKiotViet');
  const activate = functionSource(integrationSource, 'activateKiotViet', 'disableIntegration');

  assert.match(probe, /RETURNING id, pending_generation, pending_webhook_public_id/);
  assert.match(probe, /pending_token:\s*row\.pending_webhook_public_id/,
    'probe phải trả token của chính pending bundle vừa ghi');
  assert.match(activate, /body\?\.pending_token/);
  assert.match(activate, /current\.pending_webhook_public_id[\s\S]*?!== pendingToken/,
    'activate phải từ chối token của tab probe cũ trước khi gọi provider');
  assert.ok(activate.indexOf("!== pendingToken") < activate.indexOf('listBranches()'),
    'token cũ phải bị chặn trước mọi side effect/provider call');
  assert.match(activate, /pending_webhook_public_id = \$6[\s\S]*?current\.pending_generation, pendingToken/,
    'CAS cuối phải dùng lại đúng token từ request, không chỉ tin snapshot vừa đọc');
  assert.match(activate,
    /catch \(error\) \{[\s\S]*?removeKiotVietWebhooks\(credentials, createdWebhookRefs\);[\s\S]*?throw error/,
    'transaction DB lỗi sau khi gọi provider phải gỡ webhook vừa tạo trước khi ném lỗi');
});

test('webhook cùng định danh nhưng khác payload fail-closed và mở ca đối soát', () => {
  const webhook = integrationSource.slice(integrationSource.indexOf('export async function handleKiotVietWebhook'));
  assert.match(webhook, /SELECT id, payload_hash FROM integration_webhook_inbox/);
  assert.match(webhook, /existing\.payload_hash !== payloadHash/,
    'duplicate chỉ hợp lệ khi hash nội dung cũng giống nhau');
  assert.match(webhook, /const dedupeKey = `webhook-collision:/);
  assert.match(webhook, /'webhook_failed', 'critical', 'webhook'/,
    'collision phải để lại discrepancy bền vững, không chỉ trả lỗi');
  assert.match(webhook, /if \(accepted\.collision\) return send\(res, 409/,
    'collision không được trả 202 như replay cùng nội dung');
  assert.doesNotMatch(webhook, /existing_payload_hash:[^\n]*payload\b|received_payload_hash:[^\n]*payload\b/,
    'discrepancy chỉ lưu hash, không nhân đôi raw payload có thể chứa PII');
});

test('webhook khóa độc quyền connector trước khi ghi inbox để không deadlock khi nâng khóa', () => {
  const webhook = integrationSource.slice(integrationSource.indexOf('export async function handleKiotVietWebhook'));
  const lockAt = webhook.indexOf('FOR UPDATE');
  const inboxAt = webhook.indexOf('INSERT INTO integration_webhook_inbox');
  const heartbeatAt = webhook.indexOf('UPDATE shop_integrations SET webhook_received_at');

  assert.ok(lockAt >= 0 && inboxAt > lockAt && heartbeatAt > inboxAt,
    'mọi webhook cùng connector phải xếp hàng bằng khóa độc quyền trước khi chạm inbox rồi heartbeat');
  assert.doesNotMatch(webhook.slice(0, inboxAt), /FOR SHARE/,
    'FOR SHARE rồi UPDATE cùng hàng tạo lock-upgrade deadlock khi hai webhook tới đồng thời');
});

test('retry đơn connector không tự nhận đơn của generation cũ', () => {
  const retry = functionSource(integrationSource, 'retryDiscrepancy', 'handleKiotVietWebhook');
  const guardAt = retry.indexOf('row.order_generation == null');
  const enqueueAt = retry.indexOf('INSERT INTO outbox');

  assert.match(retry, /o\.integration_generation AS order_generation/);
  assert.ok(guardAt >= 0 && enqueueAt > guardAt,
    'phải so generation của đơn trước khi đưa retry vào outbox');
  assert.match(retry, /Number\(row\.order_generation\) !== Number\(row\.generation\)/);
  assert.match(retry, /if \(out\.stale_order_generation\) return send\(res, 409/,
    'người vận hành phải thấy 409 rõ ràng thay vì thông báo đã retry giả');
});
