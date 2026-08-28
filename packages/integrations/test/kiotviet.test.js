import { createServer } from 'node:http';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canApplyKiotVietStock,
  createKiotVietClient,
  extractKiotVietNotifications,
  integrationRetryBackoffMs,
  isStaleKiotVietSnapshot,
  kiotVietBranchOnHand,
  verifyKiotVietSignature,
} from '../src/kiotviet.js';

let server;
let base;
const seen = [];

before(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    seen.push({ method: req.method, url: req.url, headers: req.headers, raw });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/connect/token') return res.end(JSON.stringify({ access_token: 'token-thu', expires_in: 3600 }));
    if (req.url.startsWith('/branches')) return res.end(JSON.stringify({ data: [{ id: 7, branchName: 'Chi nhánh chính' }] }));
    if (req.url === '/orders/code/KV-12') return res.end(JSON.stringify({ id: 91, code: 'KV-12' }));
    if (req.url === '/orders/code/KHONG-CO') { res.statusCode = 404; return res.end(JSON.stringify({ message: 'không thấy' })); }
    if (req.url.startsWith('/orders?') && req.url.includes('lastModifiedFrom=rate-limit')) {
      res.statusCode = 429;
      res.setHeader('retry-after', '7');
      return res.end(JSON.stringify({ message: 'thử lại sau' }));
    }
    if (req.url.startsWith('/orders?') && req.url.includes('currentItem=20')) {
      return res.end(JSON.stringify({ data: [{ id: 92, status: 2 }], total: 37 }));
    }
    if (req.url.startsWith('/orders?') && req.url.includes('lastModifiedFrom=full-scan')) {
      return res.end(JSON.stringify({
        data: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, description: `đơn khác ${i}` })),
        total: 6000,
      }));
    }
    if (req.url.startsWith('/orders?')) return res.end(JSON.stringify({ data: [{ id: 91, code: 'KV-12', description: '[NTG:ABC:12] đơn website' }] }));
    if (req.url === '/orders' && req.method === 'POST') return res.end(JSON.stringify({ id: 91, code: 'NTG-12' }));
    if (req.url.startsWith('/products?')) return res.end(JSON.stringify({ data: [{ id: 501 }], removeId: [502], total: 1 }));
    if (req.url.startsWith('/invoices?')) return res.end(JSON.stringify({ data: [{ id: 501, status: 1, total: 100000 }], total: 1 }));
    if (req.url.startsWith('/webhooks') && req.method === 'GET') return res.end(JSON.stringify({ data: [{ id: 3, type: 'stock.update', url: 'https://api.example/hook' }] }));
    if (req.url === '/webhooks' && req.method === 'POST') return res.end(JSON.stringify({ id: 4, type: 'invoice.update' }));
    if (req.url === '/webhooks/4' && req.method === 'DELETE') return res.end(JSON.stringify({ message: 'đã xoá' }));
    res.statusCode = 404; return res.end(JSON.stringify({ message: 'không thấy' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => new Promise((resolve) => server.close(resolve)));

test('client dùng OAuth, header retailer và tìm đơn theo code trước khi tạo lại', async () => {
  const client = createKiotVietClient({ clientId: 'cid', clientSecret: 'secret', retailer: 'shop-a', identityBase: base, apiBase: base });
  assert.deepEqual(await client.listBranches(), [{ id: '7', name: 'Chi nhánh chính', address: null }]);
  assert.equal((await client.findOrderByCode('KV-12')).id, 91);
  assert.equal(await client.findOrderByCode('KHONG-CO'), null);
  assert.equal((await client.findOrderByMarker('[NTG:ABC:12]', { lastModifiedFrom: '2026-01-01' })).state, 'found');
  assert.equal((await client.findOrderByMarker('[NTG:ABC:12]', { lastModifiedFrom: '2026-01-01' })).order.id, 91);
  assert.deepEqual(await client.listOrders({ currentItem: 20, pageSize: 25, lastModifiedFrom: '2026-01-02', branchId: 7 }), {
    rows: [{ id: 92, status: 2 }], total: 37,
  });
  assert.equal((await client.createOrder({
    branchId: 7,
    orderDelivery: { receiver: 'Khách thử', contactNumber: '0900000000', address: '1 Đường A', price: 30000 },
  })).id, 91);
  assert.deepEqual(await client.listProducts({ lastModifiedFrom: '2026-01-03' }), {
    rows: [{ id: 501 }], removed: ['502'], total: 1,
  });
  assert.equal((await client.listInvoices({ branchId: 7, lastModifiedFrom: '2026-01-01' })).rows[0].id, 501);
  assert.equal(seen.filter((r) => r.url === '/connect/token').length, 1, 'token được dùng lại trong vòng đời client');
  assert.ok(seen.filter((r) => r.url !== '/connect/token').every((r) => r.headers.retailer === 'shop-a'));
  const created = seen.find((r) => r.url === '/orders' && r.method === 'POST');
  assert.deepEqual(JSON.parse(created.raw).orderDelivery, {
    receiver: 'Khách thử', contactNumber: '0900000000', address: '1 Đường A', price: 30000,
  });
  const listed = seen.find((r) => r.url.startsWith('/orders?') && r.url.includes('currentItem=20'));
  const query = new URL(listed.url, base).searchParams;
  assert.deepEqual(Object.fromEntries(query), {
    currentItem: '20', pageSize: '25', lastModifiedFrom: '2026-01-02', branchIds: '7',
    orderBy: 'modifiedDate', orderDirection: 'Asc',
  });
  const products = seen.find((r) => r.url.startsWith('/products?'));
  assert.deepEqual(Object.fromEntries(new URL(products.url, base).searchParams), {
    currentItem: '0', pageSize: '100', includeInventory: 'true', includeRemoveIds: 'true',
    lastModifiedFrom: '2026-01-03',
  });
});

test('429 giữ Retry-After và backoff không gọi provider sớm hơn yêu cầu', async () => {
  const client = createKiotVietClient({ clientId: 'cid', clientSecret: 'secret', retailer: 'shop-a', identityBase: base, apiBase: base });
  await assert.rejects(
    client.listOrders({ lastModifiedFrom: 'rate-limit' }),
    (error) => error?.code === 'rate_limited'
      && error?.statusCode === 503
      && error?.retryAfterMs === 7000
      && integrationRetryBackoffMs(error, 1, { baseMs: 1000, maxMs: 30_000 }) === 7000,
  );
  assert.equal(integrationRetryBackoffMs({ retryAfterMs: 7000 }, 1, { baseMs: 1000, maxMs: 5000 }), 7000);
  assert.equal(integrationRetryBackoffMs(null, 1, { baseMs: 1000, maxMs: 5000 }), 1000);
  assert.equal(integrationRetryBackoffMs(null, 4, { baseMs: 1000, maxMs: 5000 }), 5000);
});

test('snapshot connector fail-closed khi tồn không phủ reservation hoặc event thiếu thứ tự', () => {
  assert.equal(canApplyKiotVietStock(5, 5), true);
  assert.equal(canApplyKiotVietStock(4, 5), false);
  assert.equal(canApplyKiotVietStock(NaN, 0), false);
  assert.equal(isStaleKiotVietSnapshot('2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z'), false);
  assert.equal(isStaleKiotVietSnapshot('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'), true);
  assert.equal(isStaleKiotVietSnapshot(null, '2026-01-02T00:00:00Z'), true);
});

test('marker scan không bao giờ tự kết luận absence từ offset pagination', async () => {
  const client = createKiotVietClient({ clientId: 'cid', clientSecret: 'secret', retailer: 'shop-a', identityBase: base, apiBase: base });
  const lookup = await client.findOrderByMarker('[NTG:KHONG-CO:99]', { lastModifiedFrom: 'full-scan', maxPages: 2 });
  assert.equal(lookup.state, 'inconclusive');
  assert.equal((await client.lookupOrderByCode('KHONG-CO')).state, 'proven_absent');
});

test('chữ ký webhook đúng thân byte; đổi một byte phải đỏ', () => {
  const body = Buffer.from('{"Id":"evt-1"}');
  const digest = crypto.createHmac('sha256', 'secret-webhook').update(body).digest();
  assert.equal(verifyKiotVietSignature(body, `sha256=${digest.toString('hex')}`, 'secret-webhook'), true);
  assert.equal(verifyKiotVietSignature(body, digest.toString('base64'), 'secret-webhook'), true);
  assert.equal(verifyKiotVietSignature(Buffer.from('{"Id":"evt-2"}'), digest.toString('hex'), 'secret-webhook'), false);
  assert.equal(verifyKiotVietSignature(body, 'khong-hop-le', 'secret'), false);
});

test('đăng ký webhook gửi đúng envelope chính thức và có thể gỡ theo id', async () => {
  const client = createKiotVietClient({ clientId: 'cid', clientSecret: 'secret', retailer: 'shop-a', identityBase: base, apiBase: base });
  assert.equal((await client.listWebhooks())[0].id, 3);
  assert.equal((await client.registerWebhook({ type: 'invoice.update', url: 'https://api.example/invoice', secret: 'c2VjcmV0' })).id, 4);
  await client.deleteWebhook(4);
  const sent = seen.find((r) => r.url === '/webhooks' && r.method === 'POST');
  assert.deepEqual(JSON.parse(sent.raw), { Webhook: {
    Type: 'invoice.update', Url: 'https://api.example/invoice', IsActive: true,
    Description: 'TikFlash POS connector', Secret: 'c2VjcmV0',
  } });
});

test('envelope nhiều notification và nhiều Data được tách đủ, không làm mất raw data', () => {
  const out = extractKiotVietNotifications({ Id: 'batch-1', Notifications: [
    { Action: 'update', Data: [{ Id: 1, OnHand: 3 }, { Id: 2, OnHand: 4 }] },
    { Action: 'delete', Data: [{ Id: 3 }] },
  ] }, 'stock.update');
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((x) => x.eventId), ['1', '2', '3']);
  assert.equal(out[0].data.OnHand, 3);
  assert.equal(out[2].action, 'delete');
});

test('tồn kho chỉ lấy đúng chi nhánh đã chọn, không rơi về tổng tồn retailer', () => {
  const row = { onHand: 99, inventories: [
    { branchId: 7, onHand: 4 },
    { branchId: 8, onHand: 12 },
  ] };
  assert.equal(kiotVietBranchOnHand(row, '7'), 4);
  assert.equal(kiotVietBranchOnHand(row, '9'), 0);
  assert.equal(kiotVietBranchOnHand({ onHand: 6 }, '7'), 6);
});
