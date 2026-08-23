import { createServer } from 'node:http';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createKiotVietClient,
  extractKiotVietNotifications,
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
    if (req.url.startsWith('/orders?') && req.url.includes('lastModifiedFrom=full-scan')) {
      return res.end(JSON.stringify({
        data: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, description: `đơn khác ${i}` })),
        total: 6000,
      }));
    }
    if (req.url.startsWith('/orders?')) return res.end(JSON.stringify({ data: [{ id: 91, code: 'KV-12', description: '[NTG:ABC:12] đơn website' }] }));
    if (req.url === '/orders' && req.method === 'POST') return res.end(JSON.stringify({ id: 91, code: 'NTG-12' }));
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
  assert.equal((await client.findOrderByMarker('[NTG:ABC:12]', { lastModifiedFrom: '2026-01-01' })).id, 91);
  assert.equal((await client.createOrder({
    branchId: 7,
    orderDelivery: { receiver: 'Khách thử', contactNumber: '0900000000', address: '1 Đường A', price: 30000 },
  })).id, 91);
  assert.equal((await client.listInvoices({ branchId: 7, lastModifiedFrom: '2026-01-01' })).rows[0].id, 501);
  assert.equal(seen.filter((r) => r.url === '/connect/token').length, 1, 'token được dùng lại trong vòng đời client');
  assert.ok(seen.filter((r) => r.url !== '/connect/token').every((r) => r.headers.retailer === 'shop-a'));
  const created = seen.find((r) => r.url === '/orders' && r.method === 'POST');
  assert.deepEqual(JSON.parse(created.raw).orderDelivery, {
    receiver: 'Khách thử', contactNumber: '0900000000', address: '1 Đường A', price: 30000,
  });
});

test('không POST lại khi chưa quét hết tập đơn có thể chứa marker', async () => {
  const client = createKiotVietClient({ clientId: 'cid', clientSecret: 'secret', retailer: 'shop-a', identityBase: base, apiBase: base });
  await assert.rejects(
    client.findOrderByMarker('[NTG:KHONG-CO:99]', { lastModifiedFrom: 'full-scan', maxPages: 2 }),
    (error) => error?.code === 'order_lookup_incomplete' && error?.statusCode === 503,
  );
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
    Description: 'Nền Tảng POS connector', Secret: 'c2VjcmV0',
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
