/**
 * E2E kết nối KiotViet: step-up BFF, đăng ký/gỡ webhook thật qua stub, inbox chữ ký +
 * chống trùng, và worker hoàn tất initial sync. Stub chạy trong dbtest ở cổng 9103;
 * seller/worker dev trỏ đúng hostname này qua compose.dev.yml.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';
import { open } from '../../seller/src/secretbox.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const ENC_KEY = process.env.INTEGRATION_ENC_KEY ?? '';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d = '') => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${String(d).slice(0, 400)}${X}`); };
const sect = (m) => console.log(`\n${B}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cookieOf = (headers) => { for (const c of headers ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };
const inviteTokenOf = async (email) => {
  const { rows } = await owner.query(
    `SELECT payload->>'accept_url' AS url FROM outbox
      WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email],
  );
  return rows[0]?.url ? new URL(rows[0].url).searchParams.get('token') : null;
};

async function json(base, method, path, { body, cookie, origin } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = `__Host-session=${cookie}`;
  if (origin) headers.origin = origin;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await res.text(); let parsed = null; try { parsed = raw ? JSON.parse(raw) : null; } catch {}
  return { status: res.status, json: parsed, raw, cookies: res.headers.getSetCookie() };
}

async function admin(method, path, { form, cookie } = {}) {
  const headers = { origin: OADM };
  if (cookie) headers.cookie = `__Host-session=${cookie}`;
  if (form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(ADMIN + path, {
    method, headers, redirect: 'manual',
    body: form === undefined ? undefined : new URLSearchParams(form).toString(),
  });
  return { status: res.status, body: await res.text(), cookies: res.headers.getSetCookie(), location: res.headers.get('location') };
}

const login = async (email, password) => cookieOf((await json(AUTH, 'POST', '/auth/login', {
  body: { email, password }, origin: OA,
})).cookies);
const adminLogin = async (email, password) => cookieOf((await admin('POST', '/login', {
  form: { email, password },
})).cookies);
const userId = async (email) => (await owner.query(`SELECT id FROM users WHERE email=$1`, [email])).rows[0]?.id;

async function makeStaff() {
  const email = `staff-${uniq()}@nentang.vn`, password = 'staff strong passphrase';
  await json(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let cookie = await login(email, password);
  const enroll = await json(AUTH, 'POST', '/auth/mfa/enroll', { cookie, origin: OA });
  const key = base32Decode(enroll.json.secret);
  await json(AUTH, 'POST', '/auth/mfa/activate', { cookie, body: { code: totp(key, {}) }, origin: OA });
  const counter = counterFor(Date.now());
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,'admin')`, [await userId(email)]);
  while (counterFor(Date.now()) <= counter) await sleep(1000);
  cookie = await login(email, password);
  return cookieOf((await json(AUTH, 'POST', '/auth/mfa/verify', {
    cookie, body: { code: totp(key, {}) }, origin: OA,
  })).cookies) ?? cookie;
}

async function makeShopOwner(staff) {
  const slug = `kv-${uniq()}`;
  const created = await json(PLATFORM, 'POST', '/ops/shops', {
    cookie: staff, origin: OO, body: { name: slug, slug, plan_code: 'platform' },
  });
  const shopId = created.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  await json(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, {
    cookie: staff, origin: OO, body: { email, role: 'owner' },
  });
  await json(AUTH, 'POST', '/auth/invitations/accept', {
    origin: OA, body: { token: await inviteTokenOf(email), password },
  });
  return { shopId, email, password };
}

function startKiotVietStub() {
  const registered = new Map();
  const deleted = [];
  const products = [];
  const createdOrders = [];
  let nextId = 100;
  let nextOrderId = 10000;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/connect/token' && req.method === 'POST') return res.end(JSON.stringify({ access_token: 'token-stub', expires_in: 3600 }));
    if (req.url?.startsWith('/branches') && req.method === 'GET') return res.end(JSON.stringify({ data: [{ id: 7, branchName: 'Chi nhánh thử' }] }));
    if (req.url?.startsWith('/products?') && req.method === 'GET') return res.end(JSON.stringify({ data: products, removeId: [], total: products.length }));
    if (req.url?.startsWith('/orders?') && req.method === 'GET') return res.end(JSON.stringify({ data: [...createdOrders].reverse(), total: createdOrders.length }));
    if (req.url === '/orders' && req.method === 'POST') {
      const body = JSON.parse(raw || '{}');
      const row = { ...body, id: nextOrderId++, code: `DH-${nextOrderId}` };
      createdOrders.push(row);
      return res.end(JSON.stringify(row));
    }
    if (req.url?.startsWith('/invoices?') && req.method === 'GET') return res.end(JSON.stringify({ data: [], total: 0 }));
    if (req.url?.startsWith('/webhooks') && req.method === 'GET') return res.end(JSON.stringify({ data: [...registered.values()] }));
    if (req.url === '/webhooks' && req.method === 'POST') {
      const body = JSON.parse(raw || '{}').Webhook ?? {};
      const id = nextId++;
      const row = { id, type: body.Type, url: body.Url, isActive: body.IsActive };
      registered.set(String(id), row);
      return res.end(JSON.stringify(row));
    }
    const del = /^\/webhooks\/(\d+)$/.exec(req.url ?? '');
    if (del && req.method === 'DELETE') {
      deleted.push(del[1]); registered.delete(del[1]);
      return res.end(JSON.stringify({ ok: true }));
    }
    res.statusCode = 404;
    return res.end(JSON.stringify({ message: 'stub không có đường này' }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(9103, '0.0.0.0', () => resolve({
      registered, deleted, products, createdOrders,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

async function webhook(path, payload, secret, signature = null) {
  const raw = Buffer.from(JSON.stringify(payload));
  const sig = signature ?? crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const started = Date.now();
  const res = await fetch(SELLER + path, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature': sig }, body: raw,
  });
  const body = await res.text(); let parsed = null; try { parsed = JSON.parse(body); } catch {}
  return { status: res.status, json: parsed, raw: body, elapsed: Date.now() - started };
}

async function waitFor(fn, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= end) return null;
    await sleep(200);
  }
}

const inboxStatus = async (shopId, eventId) => waitFor(async () => {
  const row = (await owner.query(
    `SELECT status,last_error FROM integration_webhook_inbox
      WHERE shop_id=$1 AND provider_event_id=$2`, [shopId, eventId],
  )).rows[0];
  return row && ['completed', 'failed'].includes(row.status) ? row : null;
});

async function main() {
  if (!/^[0-9a-f]{64}$/i.test(ENC_KEY)) throw new Error('dbtest thiếu INTEGRATION_ENC_KEY');
  const stub = await startKiotVietStub();
  try {
    const staff = await makeStaff();
    const shop = await makeShopOwner(staff);
    const base = `/shops/${shop.shopId}/integrations`;
    let cookie = await adminLogin(shop.email, shop.password);

    sect('1. Probe credential qua BFF bắt step-up và giữ đủ dữ liệu');
    let r = await admin('GET', base, { cookie });
    r.status === 200 && /Kết nối KiotViet/.test(r.body) ? ok('mở được trang Kết nối POS') : bad('không mở được trang', r.body);
    const credentials = { retailer: 'retailer-test', client_id: 'client-test', client_secret: 'secret-test' };
    r = await admin('POST', `${base}/kiotviet/probe`, { cookie, form: credentials });
    r.status === 200 && /Xác nhận kết nối KiotViet/.test(r.body)
      && /name="client_secret" value="secret-test"/.test(r.body)
      ? ok('chưa step-up → interstitial giữ nguyên credential') : bad('probe không qua step-up hoặc làm mất dữ liệu', r.body);
    r = await admin('POST', `${base}/kiotviet/probe/step-up`, {
      cookie, form: { ...credentials, password: shop.password },
    });
    r.status === 200 && /Chi nhánh thử/.test(r.body)
      ? ok('mật khẩu đúng → gọi OAuth + đọc chi nhánh thật qua stub') : bad('probe sau step-up lỗi', r.body);

    sect('2. Kích hoạt đăng ký đủ webhook và worker hoàn tất initial sync');
    r = await admin('POST', `${base}/kiotviet/activate`, { cookie, form: { branch_id: '7' } });
    r.status === 200 && /đang chạy đồng bộ thử/i.test(r.body)
      ? ok('kích hoạt trả trang vận hành, không để người dùng ở ngõ cụt') : bad('kích hoạt BFF lỗi', r.body);
    stub.registered.size === 5 ? ok('đăng ký đúng 5 webhook KiotViet') : bad(`đăng ký ${stub.registered.size}/5 webhook`, JSON.stringify([...stub.registered.values()]));
    const active = await waitFor(async () => (await owner.query(
      `SELECT id,status,inventory_authority,webhook_refs,credential_ciphertext,webhook_public_id
         FROM shop_integrations WHERE shop_id=$1 AND provider='kiotviet'`, [shop.shopId],
    )).rows[0]?.status === 'active' ? (await owner.query(
      `SELECT id,status,inventory_authority,webhook_refs,credential_ciphertext,webhook_public_id
         FROM shop_integrations WHERE shop_id=$1 AND provider='kiotviet'`, [shop.shopId],
    )).rows[0] : null);
    active?.inventory_authority === 'external_master' && Object.keys(active.webhook_refs ?? {}).length === 5
      ? ok('initial sync xong → active + KiotViet làm chủ tồn') : bad('worker không hoàn tất initial sync', JSON.stringify(active));

    stub.products.push({
      Id: 888, Code: 'CHI-BAN-TAI-QUAY', Name: 'Sản phẩm chỉ bán tại quầy',
      ModifiedDate: new Date().toISOString(), Inventories: [{ BranchId: 7, OnHand: 5 }],
    });
    await owner.query(
      `INSERT INTO outbox (shop_id,topic,payload)
       VALUES ($1,'integration.reconcile_requested',$2)`,
      [shop.shopId, { integration_id: active.id, reason: 'test_ignore' }],
    );
    const unmapped = await waitFor(async () => (await owner.query(
      `SELECT r.id,r.mapping_status,i.status
         FROM integration_entity_refs r JOIN shop_integrations i ON i.id=r.integration_id
        WHERE r.shop_id=$1 AND r.integration_id=$2 AND r.entity_type='variant' AND r.external_id='888'`,
      [shop.shopId, active.id],
    )).rows[0]?.status === 'degraded' ? (await owner.query(
      `SELECT r.id,r.mapping_status,i.status
         FROM integration_entity_refs r JOIN shop_integrations i ON i.id=r.integration_id
        WHERE r.shop_id=$1 AND r.integration_id=$2 AND r.entity_type='variant' AND r.external_id='888'`,
      [shop.shopId, active.id],
    )).rows[0] : null);
    r = unmapped?.id ? await admin('POST', `${base}/mappings/${unmapped.id}/ignore`, { cookie, form: {} }) : { status: 0, body: '' };
    const ignored = await waitFor(async () => {
      const row = (await owner.query(
        `SELECT r.mapping_status,i.status
           FROM integration_entity_refs r JOIN shop_integrations i ON i.id=r.integration_id
          WHERE r.shop_id=$1 AND r.integration_id=$2 AND r.entity_type='variant' AND r.external_id='888'`,
        [shop.shopId, active.id],
      )).rows[0];
      return row?.mapping_status === 'ignored' && row.status === 'active' ? row : null;
    });
    r.status === 200 && ignored
      ? ok('sản phẩm chỉ bán tại quầy được bỏ qua bền vững và không chặn external_master')
      : bad('mapping ignored không bền hoặc connector không hoạt động lại', JSON.stringify({ response: r.status, unmapped, ignored }));

    sect('3. Webhook kiểm chữ ký, phản hồi nhanh và chống trùng bền vững');
    const secret = JSON.parse(open(active.credential_ciphertext, ENC_KEY, 'INTEGRATION_ENC_KEYS')).webhook_secret;
    const payload = { Id: `evt-${uniq()}`, Notifications: [{ Action: 'update', Data: [{
      Id: 991, Description: 'Đơn POS không có marker Nền Tảng', ModifiedDate: new Date().toISOString(),
    }] }] };
    const path = `/integrations/kiotviet/webhooks/${active.webhook_public_id}/order.update`;
    const first = await webhook(path, payload, secret);
    const duplicate = await webhook(path, payload, secret);
    first.status === 202 && first.json?.duplicate === false && first.elapsed < 5000
      ? ok(`webhook hợp lệ → 202 trong ${first.elapsed}ms`) : bad('webhook hợp lệ không được nhận đúng', first.raw);
    duplicate.status === 202 && duplicate.json?.duplicate === true
      ? ok('gửi lại cùng event → 202 duplicate, không tạo việc thứ hai') : bad('webhook trùng không idempotent', duplicate.raw);
    const inboxCount = Number((await owner.query(
      `SELECT count(*)::int n FROM integration_webhook_inbox
        WHERE shop_id=$1 AND provider_event_id=$2`, [shop.shopId, payload.Id],
    )).rows[0].n);
    inboxCount === 1 ? ok('DB chỉ có đúng một inbox row cho event trùng') : bad(`inbox có ${inboxCount} dòng`, '');
    const badSigPayload = { Id: `evt-${uniq()}`, Notifications: [] };
    const rejected = await webhook(path, badSigPayload, secret, '00'.repeat(32));
    rejected.status === 401 ? ok('sai một chữ ký → 401, không nhận payload') : bad(`chữ ký sai trả ${rejected.status}`, rejected.raw);

    sect('4. Hóa đơn POS chỉ nhập khi hoàn tất + đủ tiền, và không nhân đôi đơn website');
    const sellerCookie = await login(shop.email, shop.password);
    const createdProduct = await json(SELLER, 'POST', `/shops/${shop.shopId}/products`, {
      cookie: sellerCookie, origin: OS, body: {
        title: 'Áo POS', slug: `ao-pos-${uniq()}`, price_vnd: 45000, status: 'active',
        variants: [{ sku: `POS-${uniq()}`, price_vnd: 45000 }],
      },
    });
    const productDetail = await json(SELLER, 'GET', `/shops/${shop.shopId}/products/${createdProduct.json.id}`, { cookie: sellerCookie });
    const variantId = productDetail.json?.variants?.[0]?.id;
    await owner.query(
      `INSERT INTO integration_entity_refs
         (shop_id,integration_id,entity_type,external_id,local_id,mapping_status,raw_meta)
       VALUES ($1,$2,'variant','501',$3,'mapped',$4)`,
      [shop.shopId, active.id, variantId, { sku: 'POS-501' }],
    );
    await owner.query(
      `INSERT INTO product_source_refs (shop_id,source,kind,external_id,product_id,variant_id,raw_row)
       VALUES ($1,'kiotviet','variant','501',$2,$3,$4)`,
      [shop.shopId, createdProduct.json.id, variantId, { sku: 'POS-501' }],
    );

    const outboundNumber = (await owner.query(
      `INSERT INTO shop_counters (shop_id,name,value) VALUES ($1,'order_number',1)
       ON CONFLICT (shop_id,name) DO UPDATE SET value=shop_counters.value+1 RETURNING value`, [shop.shopId],
    )).rows[0].value;
    const outbound = (await owner.query(
      `INSERT INTO orders
         (shop_id,order_number,status,payment_status,payment_method,customer_name,customer_phone,customer_email,
          shipping_address,subtotal_vnd,shipping_vnd,total_vnd,source,integration_id,external_branch_ref,sync_status,sync_updated_at)
       VALUES ($1,$2,'pending','unpaid','cod','Nguyễn Khách','0900000000','khach@example.test',$3,
               90000,30000,120000,'web',$4,'7','pending',now()) RETURNING id`,
      [shop.shopId, outboundNumber, { line: '1 Đường A', ward: 'Phường B', district: 'Quận C', province: 'TP.HCM' }, active.id],
    )).rows[0];
    await owner.query(
      `INSERT INTO order_lines
         (shop_id,order_id,variant_id,title_snapshot,sku_snapshot,unit_price_vnd,qty)
       VALUES ($1,$2,$3,'Áo POS','POS-501',45000,2)`,
      [shop.shopId, outbound.id, variantId],
    );
    await owner.query(
      `INSERT INTO outbox (shop_id,topic,payload)
       SELECT $1,'integration.order_created',$2 FROM generate_series(1,2)`,
      [shop.shopId, { integration_id: active.id, order_id: outbound.id }],
    );
    const syncedOutbound = await waitFor(async () => {
      const row = (await owner.query(`SELECT sync_status,external_ref FROM orders WHERE id=$1`, [outbound.id])).rows[0];
      return row?.sync_status === 'synced' ? row : null;
    });
    await sleep(1000);
    const sentOrder = stub.createdOrders[0];
    syncedOutbound && stub.createdOrders.length === 1
      && sentOrder?.orderDelivery?.receiver === 'Nguyễn Khách'
      && sentOrder?.orderDelivery?.contactNumber === '0900000000'
      && sentOrder?.orderDelivery?.address === '1 Đường A, Phường B, Quận C, TP.HCM'
      && Number(sentOrder?.orderDelivery?.price) === 30000
      ? ok('hai job đồng thời chỉ tạo một đơn KiotViet và mang đủ dữ liệu giao hàng')
      : bad('gửi đơn website bị trùng hoặc thiếu orderDelivery', JSON.stringify({ syncedOutbound, count: stub.createdOrders.length, sentOrder }));

    const invoicePayload = (eventId, invoiceId, status, extra = {}) => ({
      Id: eventId, Notifications: [{ Action: 'update', Data: [{
        Id: invoiceId, Code: `HD-${invoiceId}`, BranchId: 7, Status: status,
        ModifiedDate: new Date().toISOString(), PurchaseDate: new Date().toISOString(),
        Total: 90000, TotalPayment: 90000,
        InvoiceDetails: [{ ProductId: 501, Quantity: 2, Price: 45000 }],
        Payments: [{ Method: 'Cash' }], ...extra,
      }] }],
    });
    const invoicePath = `/integrations/kiotviet/webhooks/${active.webhook_public_id}/invoice.update`;
    const posEvent = `evt-pos-${uniq()}`;
    let received = await webhook(invoicePath, invoicePayload(posEvent, 7001, 1), secret);
    const posInbox = await inboxStatus(shop.shopId, posEvent);
    const posOrder = (await owner.query(
      `SELECT id,source,status,payment_status,payment_method,total_vnd,customer_name
         FROM orders WHERE shop_id=$1 AND integration_id=$2 AND external_ref='7001'`,
      [shop.shopId, active.id],
    )).rows[0];
    const posPay = posOrder ? (await owner.query(
      `SELECT amount_vnd,status,entry_type FROM payment_transactions WHERE order_id=$1`, [posOrder.id],
    )).rows[0] : null;
    received.status === 202 && posInbox?.status === 'completed' && posOrder?.source === 'kiotviet_pos'
      && posOrder.status === 'delivered' && posOrder.payment_status === 'paid'
      && Number(posOrder.total_vnd) === 90000 && posPay?.status === 'received' && Number(posPay.amount_vnd) === 90000
      ? ok('invoice hoàn tất + đủ tiền → đúng một đơn POS paid và một bút toán 90.000đ')
      : bad('không nhập được hóa đơn POS thật', JSON.stringify({ received, posInbox, posOrder, posPay }));

    const beforeNonFinal = Number((await owner.query(
      `SELECT count(*)::int n FROM orders WHERE shop_id=$1 AND source='kiotviet_pos'`, [shop.shopId],
    )).rows[0].n);
    for (const [status, invoiceId] of [[2, 7002], [3, 7003]]) {
      const eventId = `evt-status-${status}-${uniq()}`;
      await webhook(invoicePath, invoicePayload(eventId, invoiceId, status), secret);
      const done = await inboxStatus(shop.shopId, eventId);
      done?.status === 'completed' ? ok(`invoice status ${status} được quan sát nhưng không lỗi worker`) : bad(`invoice status ${status} xử lý lỗi`, JSON.stringify(done));
    }
    const afterNonFinal = Number((await owner.query(
      `SELECT count(*)::int n FROM orders WHERE shop_id=$1 AND source='kiotviet_pos'`, [shop.shopId],
    )).rows[0].n);
    afterNonFinal === beforeNonFinal ? ok('invoice status 2/3 không biến thành doanh thu POS') : bad(`status 2/3 đẻ thêm ${afterNonFinal - beforeNonFinal} đơn`, '');

    const websiteNumber = (await owner.query(
      `INSERT INTO shop_counters (shop_id,name,value) VALUES ($1,'order_number',1)
       ON CONFLICT (shop_id,name) DO UPDATE SET value=shop_counters.value+1 RETURNING value`, [shop.shopId],
    )).rows[0].value;
    const websiteOrder = (await owner.query(
      `INSERT INTO orders
         (shop_id,order_number,status,payment_status,payment_method,customer_name,subtotal_vnd,total_vnd,
          source,integration_id,external_branch_ref,sync_status,sync_updated_at)
       VALUES ($1,$2,'pending','unpaid','cod','Khách website',90000,90000,'web',$3,'7','pending',now())
       RETURNING id`, [shop.shopId, websiteNumber, active.id],
    )).rows[0];
    const short = shop.shopId.replace(/-/g, '').slice(0, 8).toUpperCase();
    const echoEvent = `evt-echo-${uniq()}`;
    await webhook(invoicePath, invoicePayload(echoEvent, 7004, 1, {
      Description: `[NTG:${short}:${websiteNumber}] hóa đơn của đơn website`,
    }), secret);
    const echoInbox = await inboxStatus(shop.shopId, echoEvent);
    const linked = (await owner.query(
      `SELECT local_id FROM integration_entity_refs
        WHERE shop_id=$1 AND integration_id=$2 AND entity_type='invoice' AND external_id='7004'`,
      [shop.shopId, active.id],
    )).rows[0];
    const afterEcho = Number((await owner.query(
      `SELECT count(*)::int n FROM orders WHERE shop_id=$1 AND source='kiotviet_pos'`, [shop.shopId],
    )).rows[0].n);
    echoInbox?.status === 'completed' && linked?.local_id === websiteOrder.id && afterEcho === afterNonFinal
      ? ok('invoice echo của đơn website chỉ liên kết quan sát, không tạo đơn POS thứ hai')
      : bad('echo bị đếm đôi hoặc không liên kết', JSON.stringify({ echoInbox, linked, websiteOrder, afterEcho, afterNonFinal }));

    sect('5. Ngắt kết nối bắt step-up, gỡ webhook provider và giữ mapping');
    cookie = await adminLogin(shop.email, shop.password);
    r = await admin('POST', `${base}/${active.id}/disable`, { cookie, form: {} });
    r.status === 200 && /Xác nhận ngắt kết nối POS/.test(r.body)
      ? ok('session mới chưa step-up → interstitial ngắt kết nối') : bad('disable không bắt step-up', r.body);
    r = await admin('POST', `${base}/${active.id}/disable/step-up`, { cookie, form: { password: 'sai mật khẩu' } });
    const stillActive = (await owner.query(`SELECT status FROM shop_integrations WHERE id=$1`, [active.id])).rows[0]?.status;
    r.status === 401 && stillActive !== 'disabled'
      ? ok('mật khẩu sai → 401 và connector chưa bị ngắt') : bad('disable lọt qua mật khẩu sai', `${r.status} ${stillActive}`);
    r = await admin('POST', `${base}/${active.id}/disable/step-up`, { cookie, form: { password: shop.password } });
    const disabled = (await owner.query(`SELECT status,inventory_authority FROM shop_integrations WHERE id=$1`, [active.id])).rows[0];
    r.status === 200 && disabled?.status === 'disabled' && disabled.inventory_authority === 'external_master'
      ? ok('mật khẩu đúng → disabled nhưng không tự đổi quyền sở hữu tồn') : bad('disable sai trạng thái', JSON.stringify(disabled));
    stub.deleted.length === 5 && stub.registered.size === 0
      ? ok('gỡ đủ 5 webhook ở KiotViet') : bad(`đã gỡ ${stub.deleted.length}/5 webhook`, JSON.stringify(stub.deleted));

    console.log(`\n${pass} pass, ${fail} fail`);
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    await stub.close();
    await owner.end();
  }
}

main().catch(async (error) => {
  console.error(error);
  await owner.end().catch(() => {});
  process.exit(1);
});
