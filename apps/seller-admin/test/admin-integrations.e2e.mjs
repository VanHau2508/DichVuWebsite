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
const integrationDb = new pg.Pool({ connectionString: process.env.DATABASE_URL_INTEGRATION, max: 2 });

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

async function withIntegration(shopId, integrationId, generation, fn) {
  const c = await integrationDb.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);
    await c.query(`SELECT set_config('app.integration_id', $1, true)`, [integrationId]);
    await c.query(`SELECT set_config('app.integration_generation', $1, true)`, [String(generation)]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    c.release();
  }
}

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
  const removedProducts = [];
  const createdOrders = [];
  const orderFailures = [];
  const orderAttempts = [];
  let nextId = 100;
  let nextOrderId = 10000;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/connect/token' && req.method === 'POST') return res.end(JSON.stringify({ access_token: 'token-stub', expires_in: 3600 }));
    if (req.url?.startsWith('/branches') && req.method === 'GET') return res.end(JSON.stringify({ data: [{ id: 7, branchName: 'Chi nhánh thử' }] }));
    if (req.url?.startsWith('/products?') && req.method === 'GET') return res.end(JSON.stringify({ data: products, removeId: removedProducts, total: products.length }));
    const productGet = /^\/products\/([^/?]+)$/.exec(req.url ?? '');
    if (productGet && req.method === 'GET') {
      const row = products.find((product) => String(product.Id ?? product.id) === decodeURIComponent(productGet[1]));
      if (row) return res.end(JSON.stringify(row));
      res.statusCode = 404;
      return res.end(JSON.stringify({ message: 'không tìm thấy sản phẩm' }));
    }
    const orderByCode = /^\/orders\/code\/([^/?]+)$/.exec(req.url ?? '');
    if (orderByCode && req.method === 'GET') {
      const code = decodeURIComponent(orderByCode[1]);
      const row = createdOrders.find((order) => String(order.Code ?? order.code ?? '') === code);
      if (row) return res.end(JSON.stringify(row));
      res.statusCode = 404;
      return res.end(JSON.stringify({ message: 'không tìm thấy đơn' }));
    }
    if (req.url?.startsWith('/orders?') && req.method === 'GET') {
      const query = new URL(req.url, 'http://kiotviet.stub').searchParams;
      const after = Date.parse(query.get('lastModifiedFrom') ?? '');
      const rows = createdOrders.filter((order) => {
        if (!Number.isFinite(after)) return true;
        const modified = Date.parse(order.ModifiedDate ?? order.modifiedDate ?? '');
        return Number.isFinite(modified) && modified >= after;
      });
      return res.end(JSON.stringify({ data: [...rows].reverse(), total: rows.length }));
    }
    if (req.url === '/orders' && req.method === 'POST') {
      const body = JSON.parse(raw || '{}');
      orderAttempts.push(body);
      const failStatus = orderFailures.shift();
      if (failStatus) {
        res.statusCode = failStatus;
        if (failStatus === 429) res.setHeader('retry-after', '0');
        return res.end(JSON.stringify({ message: `lỗi thử lại ${failStatus}` }));
      }
      const row = { ...body, id: nextOrderId++, code: `DH-${nextOrderId}`, ModifiedDate: new Date().toISOString() };
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
      registered, deleted, products, removedProducts, createdOrders, orderFailures, orderAttempts,
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

const inboxStatus = async (shopId, eventId, eventType = null) => waitFor(async () => {
  const row = (await owner.query(
    `SELECT status,last_error FROM integration_webhook_inbox
      WHERE shop_id=$1 AND provider_event_id=$2
        AND ($3::text IS NULL OR event_type=$3)`, [shopId, eventId, eventType],
  )).rows[0];
  return row && ['completed', 'failed', 'dead_letter', 'superseded'].includes(row.status) ? row : null;
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
    const pendingToken = /name="pending_token" value="([0-9a-f-]+)"/i.exec(r.body)?.[1] ?? '';
    r.status === 200 && /Chi nhánh thử/.test(r.body)
      && pendingToken
      ? ok('mật khẩu đúng → gọi OAuth + đọc chi nhánh thật qua stub') : bad('probe sau step-up lỗi', r.body);

    sect('2. Kích hoạt đăng ký đủ webhook và worker hoàn tất initial sync');
    r = await admin('POST', `${base}/kiotviet/activate`, {
      cookie, form: { branch_id: '7', pending_token: pendingToken },
    });
    r.status === 200 && /đang chạy đồng bộ thử/i.test(r.body)
      ? ok('kích hoạt trả trang vận hành, không để người dùng ở ngõ cụt') : bad('kích hoạt BFF lỗi', r.body);
    stub.registered.size === 5 ? ok('đăng ký đúng 5 webhook KiotViet') : bad(`đăng ký ${stub.registered.size}/5 webhook`, JSON.stringify([...stub.registered.values()]));
    const active = await waitFor(async () => (await owner.query(
      `SELECT id,status,inventory_authority,webhook_refs,credential_ciphertext,webhook_public_id,generation
         FROM shop_integrations WHERE shop_id=$1 AND provider='kiotviet'`, [shop.shopId],
    )).rows[0]?.status === 'active' ? (await owner.query(
      `SELECT id,status,inventory_authority,webhook_refs,credential_ciphertext,webhook_public_id,generation
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
      [shop.shopId, { integration_id: active.id, generation: Number(active.generation), reason: 'test_ignore' }],
    );
    const unmapped = await waitFor(async () => {
      const row = (await owner.query(
      `SELECT r.id,r.mapping_status,i.status
         FROM integration_entity_refs r JOIN shop_integrations i ON i.id=r.integration_id
        WHERE r.shop_id=$1 AND r.integration_id=$2 AND r.entity_type='variant' AND r.external_id='888'`,
      [shop.shopId, active.id],
      )).rows[0];
      return row?.id && row.mapping_status === 'unmapped' ? row : null;
    });
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

    const collisionPayload = { ...payload, Notifications: [{ Action: 'update', Data: [{
      Id: 992, Description: 'cùng event ID nhưng nội dung khác', ModifiedDate: new Date().toISOString(),
    }] }] };
    const collision = await webhook(path, collisionPayload, secret);
    const collisionCase = (await owner.query(
      `SELECT kind,severity,details FROM integration_sync_discrepancies
        WHERE shop_id=$1 AND integration_id=$2 AND dedupe_key=$3 AND status='open'`,
      [shop.shopId, active.id, `webhook-collision:${active.generation}:order.update:${payload.Id}`],
    )).rows[0];
    collision.status === 409 && collision.json?.collision === true
      && collisionCase?.kind === 'webhook_failed' && collisionCase.severity === 'critical'
      ? ok('cùng event/type nhưng hash khác → 409 và mở ca đối soát, không ghi đè inbox')
      : bad('webhook collision không fail-closed', JSON.stringify({ collision, collisionCase }));

    const crossTypePayload = { Id: payload.Id, Notifications: [{ Action: 'update', Data: [{
      Id: 7999, BranchId: 7, Status: 3, ModifiedDate: new Date().toISOString(),
    }] }] };
    const crossType = await webhook(
      `/integrations/kiotviet/webhooks/${active.webhook_public_id}/invoice.update`,
      crossTypePayload, secret,
    );
    const crossTypeDone = await inboxStatus(shop.shopId, payload.Id, 'invoice.update');
    const eventTypes = (await owner.query(
      `SELECT event_type FROM integration_webhook_inbox
        WHERE shop_id=$1 AND integration_id=$2 AND generation=$3 AND provider_event_id=$4
        ORDER BY event_type`, [shop.shopId, active.id, active.generation, payload.Id],
    )).rows.map((row) => row.event_type);
    crossType.status === 202 && crossType.json?.duplicate === false
      && crossTypeDone?.status === 'completed'
      && JSON.stringify(eventTypes) === JSON.stringify(['invoice.update', 'order.update'])
      ? ok('hai loại event dùng cùng ID vẫn là hai inbox độc lập')
      : bad('dedupe đã nuốt event type khác', JSON.stringify({ crossType, crossTypeDone, eventTypes }));

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
    const variantSku = productDetail.json?.variants?.[0]?.sku;
    stub.products.push({
      Id: 501, Code: variantSku, Name: 'Áo POS', ModifiedDate: new Date().toISOString(),
      Inventories: [{ BranchId: 7, OnHand: 50 }],
    });
    await withIntegration(shop.shopId, active.id, active.generation, (c) => c.query(
      `INSERT INTO integration_entity_refs
         (shop_id,integration_id,entity_type,external_id,local_id,mapping_status,raw_meta,
          inventory_synced_at,inventory_generation)
       VALUES (current_shop_id(),$1,'variant','501',$2,'mapped',$3,now(),$4)`,
      [active.id, variantId, { sku: 'POS-501' }, active.generation],
    ));
    await owner.query(
      `INSERT INTO product_source_refs (shop_id,source,kind,external_id,product_id,variant_id,raw_row)
       VALUES ($1,'kiotviet','variant','501',$2,$3,$4)`,
      [shop.shopId, createdProduct.json.id, variantId, { sku: 'POS-501' }],
    );

    const createdDeleteProduct = await json(SELLER, 'POST', `/shops/${shop.shopId}/products`, {
      cookie: sellerCookie, origin: OS, body: {
        title: 'Áo sẽ xóa ở POS', slug: `ao-xoa-pos-${uniq()}`, price_vnd: 30000, status: 'active',
        variants: [{ sku: `DEL-${uniq()}`, price_vnd: 30000 }],
      },
    });
    const deleteProductDetail = await json(
      SELLER, 'GET', `/shops/${shop.shopId}/products/${createdDeleteProduct.json.id}`, { cookie: sellerCookie },
    );
    const deleteVariantId = deleteProductDetail.json?.variants?.[0]?.id;
    const deleteVariantSku = deleteProductDetail.json?.variants?.[0]?.sku;
    stub.products.push({
      Id: 502, Code: deleteVariantSku, Name: 'Áo sẽ xóa ở POS', ModifiedDate: new Date().toISOString(),
      Inventories: [{ BranchId: 7, OnHand: 3 }],
    });
    await withIntegration(shop.shopId, active.id, active.generation, (c) => c.query(
      `INSERT INTO integration_entity_refs
         (shop_id,integration_id,entity_type,external_id,local_id,mapping_status,raw_meta,
          inventory_synced_at,inventory_generation)
       VALUES (current_shop_id(),$1,'variant','502',$2,'mapped',$3,now(),$4)`,
      [active.id, deleteVariantId, { sku: deleteVariantSku }, active.generation],
    ));
    await owner.query(
      `INSERT INTO product_source_refs (shop_id,source,kind,external_id,product_id,variant_id,raw_row)
       VALUES ($1,'kiotviet','variant','502',$2,$3,$4)`,
      [shop.shopId, createdDeleteProduct.json.id, deleteVariantId, { sku: deleteVariantSku }],
    );

    await withIntegration(shop.shopId, active.id, active.generation, async (c) => {
      await c.query(
        `INSERT INTO inventory_levels (shop_id,variant_id,on_hand,reserved)
         VALUES (current_shop_id(),$1,0,0) ON CONFLICT (shop_id,variant_id) DO NOTHING`, [variantId],
      );
      const before = (await c.query(
        `SELECT on_hand FROM inventory_levels WHERE variant_id=$1 FOR UPDATE`, [variantId],
      )).rows[0];
      const delta = 8 - Number(before.on_hand);
      await c.query(
        `UPDATE inventory_levels SET on_hand=8,reserved=5,updated_at=now() WHERE variant_id=$1`, [variantId],
      );
      if (delta) await c.query(
        `INSERT INTO inventory_ledger (shop_id,variant_id,delta,kind,reason)
         VALUES (current_shop_id(),$1,$2,'adjust','fixture reservation connector')`, [variantId, delta],
      );
    });
    const stockBefore = (await owner.query(
      `SELECT on_hand,reserved FROM inventory_levels WHERE shop_id=$1 AND variant_id=$2`, [shop.shopId, variantId],
    )).rows[0];
    const provider501 = stub.products.find((product) => String(product.Id) === '501');
    provider501.Inventories = [{ BranchId: 7, OnHand: 2 }];
    provider501.ModifiedDate = new Date().toISOString();
    const stockEvent = `evt-stock-low-${uniq()}`;
    const stockPath = `/integrations/kiotviet/webhooks/${active.webhook_public_id}/stock.update`;
    await webhook(stockPath, { Id: stockEvent, Notifications: [{ Action: 'update', Data: [{ ProductId: 501, BranchId: 7 }] }] }, secret);
    const stockDone = await inboxStatus(shop.shopId, stockEvent, 'stock.update');
    const stockAfter = (await owner.query(
      `SELECT on_hand,reserved FROM inventory_levels WHERE shop_id=$1 AND variant_id=$2`, [shop.shopId, variantId],
    )).rows[0];
    const stockCase = (await owner.query(
      `SELECT kind,severity,details FROM integration_sync_discrepancies
        WHERE shop_id=$1 AND integration_id=$2 AND dedupe_key='stock:501' AND status='open'`,
      [shop.shopId, active.id],
    )).rows[0];
    stockDone?.status === 'completed' && Number(stockAfter.on_hand) === Number(stockBefore.on_hand)
      && Number(stockAfter.reserved) === 5 && stockCase?.kind === 'stock_below_reserved'
      && stockCase.severity === 'critical' && Number(stockCase.details?.provider_on_hand) === 2
      && Number(stockCase.details?.local_reserved) === 5
      ? ok('provider tồn 2 < reserved 5 → không bịa on_hand, giữ snapshot cũ và mở ca critical')
      : bad('stock thấp hơn reservation đã tạo on_hand ảo hoặc thiếu ca xử lý', JSON.stringify({ stockDone, stockBefore, stockAfter, stockCase }));
    provider501.Inventories = [{ BranchId: 7, OnHand: 50 }];
    provider501.ModifiedDate = new Date().toISOString();

    const removedIndex = stub.products.findIndex((product) => String(product.Id) === '502');
    if (removedIndex >= 0) stub.products.splice(removedIndex, 1);
    stub.removedProducts.push('502');
    const deleteEvent = `evt-product-delete-${uniq()}`;
    const deletePayload = { Id: deleteEvent, Notifications: [{ Action: 'delete', Data: [{ Id: 502 }] }] };
    await webhook(
      `/integrations/kiotviet/webhooks/${active.webhook_public_id}/product.delete`, deletePayload, secret,
    );
    const deleteDone = await inboxStatus(shop.shopId, deleteEvent, 'product.delete');
    const deletedRef = (await owner.query(
      `SELECT local_id,mapping_status,inventory_synced_at,inventory_generation
         FROM integration_entity_refs
        WHERE shop_id=$1 AND integration_id=$2 AND entity_type='variant' AND external_id='502'`,
      [shop.shopId, active.id],
    )).rows[0];
    const deletedSource = (await owner.query(
      `SELECT id FROM product_source_refs
        WHERE shop_id=$1 AND source='kiotviet' AND kind='variant' AND external_id='502'`, [shop.shopId],
    )).rows[0];
    const deletedCase = (await owner.query(
      `SELECT kind,severity,local_id FROM integration_sync_discrepancies
        WHERE shop_id=$1 AND integration_id=$2 AND dedupe_key='provider-deleted:502' AND status='open'`,
      [shop.shopId, active.id],
    )).rows[0];
    deleteDone?.status === 'completed' && !Object.hasOwn(deletePayload, 'removeId')
      && deletedRef?.mapping_status === 'ignored' && deletedRef.local_id == null
      && deletedRef.inventory_synced_at == null && deletedRef.inventory_generation == null
      && !deletedSource && deletedCase?.kind === 'unmapped_sku'
      && deletedCase.severity === 'critical' && deletedCase.local_id === deleteVariantId
      ? ok('product.delete không mang removeId vẫn áp removeId từ reconciliation và khóa mapping')
      : bad('xóa provider chỉ được xử lý khi payload tự mang removeId', JSON.stringify({ deleteDone, deletePayload, deletedRef, deletedSource, deletedCase }));

    const outbound = await withIntegration(shop.shopId, active.id, active.generation, async (c) => {
      const outboundNumber = (await c.query(
        `INSERT INTO shop_counters (shop_id,name,value) VALUES (current_shop_id(),'order_number',1)
         ON CONFLICT (shop_id,name) DO UPDATE SET value=shop_counters.value+1 RETURNING value`,
      )).rows[0].value;
      const order = (await c.query(
        `INSERT INTO orders
           (shop_id,order_number,status,payment_status,payment_method,customer_name,customer_phone,customer_email,
            shipping_address,subtotal_vnd,shipping_vnd,total_vnd,source,integration_id,integration_generation,
            external_branch_ref,sync_status,sync_updated_at)
         VALUES (current_shop_id(),$1,'pending','unpaid','cod','Nguyễn Khách','0900000000','khach@example.test',$2,
                 90000,30000,120000,'web',$3,$4,'7','pending',now()) RETURNING id,order_number`,
        [outboundNumber, { line: '1 Đường A', ward: 'Phường B', district: 'Quận C', province: 'TP.HCM' },
          active.id, Number(active.generation)],
      )).rows[0];
      await c.query(
        `INSERT INTO order_lines
           (shop_id,order_id,variant_id,title_snapshot,sku_snapshot,unit_price_vnd,qty)
         VALUES (current_shop_id(),$1,$2,'Áo POS','POS-501',45000,2)`,
        [order.id, variantId],
      );
      return order;
    });
    stub.orderFailures.push(429, 503);
    await owner.query(
      `INSERT INTO outbox (shop_id,topic,payload)
       VALUES ($1,'integration.order_created',$2)`,
      [shop.shopId, { integration_id: active.id, generation: Number(active.generation), order_id: outbound.id }],
    );
    const attentionOutbound = await waitFor(async () => {
      const row = (await owner.query(`SELECT sync_status,external_ref FROM orders WHERE id=$1`, [outbound.id])).rows[0];
      return row?.sync_status === 'needs_attention' ? row : null;
    }, 30000);
    const attentionIntent = (await owner.query(
      `SELECT state,lookup_state FROM integration_order_send_intents WHERE order_id=$1`, [outbound.id],
    )).rows[0];
    await sleep(1000);
    attentionOutbound && attentionIntent?.state === 'needs_attention'
      && attentionIntent.lookup_state === 'inconclusive' && stub.createdOrders.length === 0
      && stub.orderAttempts.length === 1
      ? ok('provider trả lỗi sau send-intent → không retry mù, mở ca cần xử lý thay vì đoán absence')
      : bad('retry mơ hồ đã tạo đơn trùng hoặc không mở ca', JSON.stringify({ attentionOutbound, attentionIntent, attempts: stub.orderAttempts.length, count: stub.createdOrders.length }));

    await withIntegration(shop.shopId, active.id, active.generation, (c) => c.query(
      `UPDATE integration_order_send_intents
          SET state='prepared', attempt_started_at=NULL, lookup_state='unknown', last_error=NULL, updated_at=now()
        WHERE order_id=$1 AND state='needs_attention'`, [outbound.id],
    ));
    const crashGapReset = await withIntegration(shop.shopId, active.id, active.generation, async (c) => (await c.query(
      `UPDATE orders SET external_ref=NULL,sync_status='pending',sync_error=NULL,sync_updated_at=now()
        WHERE id=$1 AND integration_generation=$2
        RETURNING external_ref,sync_status`, [outbound.id, Number(active.generation)],
    )).rows[0]);
    stub.orderFailures.length = 0;
    await owner.query(
      `INSERT INTO outbox (shop_id,topic,payload)
       VALUES ($1,'integration.order_created',$2)`,
      [shop.shopId, { integration_id: active.id, generation: Number(active.generation), order_id: outbound.id }],
    );
    const syncedOutbound = await waitFor(async () => {
      const row = (await owner.query(`SELECT sync_status,external_ref FROM orders WHERE id=$1`, [outbound.id])).rows[0];
      return row?.sync_status === 'synced' && row.external_ref ? row : null;
    }, 20000);
    const firstExternalRef = syncedOutbound?.external_ref;
    await withIntegration(shop.shopId, active.id, active.generation, (c) => c.query(
      `UPDATE orders SET external_ref=NULL,sync_status='pending',sync_error=NULL,sync_updated_at=now()
        WHERE id=$1 AND integration_generation=$2`, [outbound.id, Number(active.generation)],
    ));
    await owner.query(
      `INSERT INTO outbox (shop_id,topic,payload)
       SELECT $1,'integration.order_created',$2 FROM generate_series(1,2)`,
      [shop.shopId, { integration_id: active.id, generation: Number(active.generation), order_id: outbound.id }],
    );
    const recoveredOutbound = await waitFor(async () => {
      const row = (await owner.query(`SELECT sync_status,external_ref FROM orders WHERE id=$1`, [outbound.id])).rows[0];
      return row?.sync_status === 'synced' && row.external_ref ? row : null;
    }, 20000);
    const sentOrder = stub.createdOrders[0];
    crashGapReset?.external_ref == null && crashGapReset?.sync_status === 'pending'
      && firstExternalRef && recoveredOutbound?.external_ref === firstExternalRef && stub.createdOrders.length === 1
      && sentOrder?.orderDelivery?.receiver === 'Nguyễn Khách'
      && sentOrder?.orderDelivery?.contactNumber === '0900000000'
      && sentOrder?.orderDelivery?.address === '1 Đường A, Phường B, Quận C, TP.HCM'
      && Number(sentOrder?.orderDelivery?.price) === 30000
       ? ok('mất mapping sau khi provider đã tạo → lookup chính xác phục hồi, không POST đơn thứ hai')
      : bad('cửa sổ provider-success/DB-missing đã nhân đôi đơn', JSON.stringify({ crashGapReset, recoveredOutbound, syncedOutbound, count: stub.createdOrders.length }));

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
    const makeWebsiteOrder = async (customerName) => withIntegration(
      shop.shopId, active.id, active.generation, async (c) => {
        const number = (await c.query(
          `INSERT INTO shop_counters (shop_id,name,value) VALUES (current_shop_id(),'order_number',1)
           ON CONFLICT (shop_id,name) DO UPDATE SET value=shop_counters.value+1 RETURNING value`,
        )).rows[0].value;
        return (await c.query(
          `INSERT INTO orders
             (shop_id,order_number,status,payment_status,payment_method,customer_name,subtotal_vnd,total_vnd,
              source,integration_id,integration_generation,external_branch_ref,sync_status,sync_updated_at)
           VALUES (current_shop_id(),$1,'pending','unpaid','cod',$2,90000,90000,
                   'web',$3,$4,'7','pending',now()) RETURNING id,order_number`,
          [number, customerName, active.id, Number(active.generation)],
        )).rows[0];
      },
    );
    const requestReconcile = async (reason) => {
      const before = (await owner.query(
        `SELECT reconciled_at FROM shop_integrations WHERE id=$1`, [active.id],
      )).rows[0]?.reconciled_at ?? null;
      const row = (await owner.query(
        `INSERT INTO outbox (shop_id,topic,payload)
         VALUES ($1,'integration.reconcile_requested',$2) RETURNING id`,
        [shop.shopId, { integration_id: active.id, generation: Number(active.generation), reason }],
      )).rows[0];
      await waitFor(async () => (await owner.query(
        `SELECT processed_at FROM outbox WHERE id=$1`, [row.id],
      )).rows[0]?.processed_at, 15000);
      return waitFor(async () => {
        const done = (await owner.query(
          `SELECT reconciled_at FROM shop_integrations WHERE id=$1`, [active.id],
        )).rows[0]?.reconciled_at;
        return done && (!before || new Date(done).getTime() > new Date(before).getTime()) ? done : null;
      }, 30000);
    };
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

    const cancelledAt = new Date(Date.now() + 60_000).toISOString();
    const olderPaidAt = new Date(Date.now() - 60_000).toISOString();
    const cancelledEvent = `evt-cancelled-new-${uniq()}`;
    const olderPaidEvent = `evt-paid-old-${uniq()}`;
    await webhook(invoicePath, invoicePayload(cancelledEvent, 7401, 2, { ModifiedDate: cancelledAt }), secret);
    const cancelledDone = await inboxStatus(shop.shopId, cancelledEvent, 'invoice.update');
    await webhook(invoicePath, invoicePayload(olderPaidEvent, 7401, 1, { ModifiedDate: olderPaidAt }), secret);
    const olderPaidDone = await inboxStatus(shop.shopId, olderPaidEvent, 'invoice.update');
    const beforeCancelledRetry = (await owner.query(
      `SELECT local_id,external_updated_at,raw_meta FROM integration_entity_refs
        WHERE shop_id=$1 AND integration_id=$2 AND entity_type='invoice' AND external_id='7401'`,
      [shop.shopId, active.id],
    )).rows[0];
    const retryCancelled = (await owner.query(
      `INSERT INTO outbox (shop_id,topic,payload)
       VALUES ($1,'integration.invoice_retry_requested',$2) RETURNING id`,
      [shop.shopId, { integration_id: active.id, generation: Number(active.generation), external_id: '7401' }],
    )).rows[0];
    await waitFor(async () => (await owner.query(
      `SELECT processed_at FROM outbox WHERE id=$1`, [retryCancelled.id],
    )).rows[0]?.processed_at, 10000);
    await sleep(1500);
    const afterCancelledRetry = (await owner.query(
      `SELECT local_id,external_updated_at,raw_meta FROM integration_entity_refs
        WHERE shop_id=$1 AND integration_id=$2 AND entity_type='invoice' AND external_id='7401'`,
      [shop.shopId, active.id],
    )).rows[0];
    const cancelledRevenue = (await owner.query(
      `SELECT id FROM orders WHERE shop_id=$1 AND integration_id=$2 AND external_ref='7401'`,
      [shop.shopId, active.id],
    )).rows[0];
    cancelledDone?.status === 'completed' && olderPaidDone?.status === 'completed'
      && !cancelledRevenue && !beforeCancelledRetry?.local_id && !afterCancelledRetry?.local_id
      && Number(beforeCancelledRetry?.raw_meta?.Status) === 2
      && Number(afterCancelledRetry?.raw_meta?.Status) === 2
      && new Date(afterCancelledRetry.external_updated_at).getTime() === new Date(cancelledAt).getTime()
      ? ok('cancelled mới thắng paid cũ; retry snapshot cancelled vẫn không tạo doanh thu')
      : bad('invoice paid cũ hoặc retry đã hồi sinh doanh thu bị hủy', JSON.stringify({ cancelledDone, olderPaidDone, beforeCancelledRetry, afterCancelledRetry, cancelledRevenue }));

    const websiteOrder = await makeWebsiteOrder('Khách website');
    const echoEvent = `evt-echo-${uniq()}`;
    await webhook(invoicePath, invoicePayload(echoEvent, 7004, 1, {
      Description: `[NTG:${shop.shopId}:${websiteOrder.id}:${websiteOrder.order_number}] hóa đơn của đơn website`,
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

    // Hai invoice ID khác nhau có thể cùng là bằng chứng cho một đơn website (retry/đối soát
    // provider đôi khi tạo bản ghi mới). Khóa idempotency ở order, không ở invoice ID, nên
    // lần thứ hai chỉ được quan sát và tuyệt đối không cộng thêm một khoản credit.
    const secondEchoEvent = `evt-echo-second-${uniq()}`;
    await webhook(invoicePath, invoicePayload(secondEchoEvent, 7005, 1, {
      Description: `[NTG:${shop.shopId}:${websiteOrder.id}:${websiteOrder.order_number}] hóa đơn đối soát thứ hai`,
    }), secret);
    const secondEchoInbox = await inboxStatus(shop.shopId, secondEchoEvent);
    const secondLinked = (await owner.query(
      `SELECT local_id FROM integration_entity_refs
         WHERE shop_id=$1 AND integration_id=$2 AND entity_type='invoice' AND external_id='7005'`,
      [shop.shopId, active.id],
    )).rows[0];
    const websitePayment = (await owner.query(
      `SELECT o.paid_at,o.payment_status,o.amount_paid_vnd,
              (SELECT count(*)::int FROM payment_transactions p WHERE p.shop_id=o.shop_id AND p.order_id=o.id) AS payment_count,
              (SELECT coalesce(sum(CASE WHEN p.entry_type='credit' THEN p.amount_vnd ELSE -p.amount_vnd END),0)::bigint
                 FROM payment_transactions p WHERE p.shop_id=o.shop_id AND p.order_id=o.id) AS ledger_vnd,
              (SELECT count(*)::int FROM integration_entity_refs r
                WHERE r.shop_id=o.shop_id AND r.integration_id=$2 AND r.entity_type='invoice' AND r.local_id=o.id) AS invoice_count
         FROM orders o WHERE o.shop_id=$1 AND o.id=$3`,
      [shop.shopId, active.id, websiteOrder.id],
    )).rows[0];
    const afterSecondEcho = Number((await owner.query(
      `SELECT count(*)::int n FROM orders WHERE shop_id=$1 AND source='kiotviet_pos'`, [shop.shopId],
    )).rows[0].n);
    secondEchoInbox?.status === 'completed' && secondLinked?.local_id === websiteOrder.id
      && afterSecondEcho === afterEcho && websitePayment?.payment_status === 'paid'
      && Number(websitePayment.amount_paid_vnd) === 90000 && Number(websitePayment.payment_count) === 1
      && Number(websitePayment.ledger_vnd) === 90000 && Number(websitePayment.invoice_count) === 2
      ? ok('hai invoice ID khác nhau của cùng đơn website chỉ tạo một credit 90.000đ')
      : bad('invoice thứ hai đã cộng trùng tiền hoặc tạo POS order', JSON.stringify({
        secondEchoInbox, secondLinked, websitePayment, afterEcho, afterSecondEcho,
      }));

    const crashGapOrder = await makeWebsiteOrder('Đơn đang chờ ghi external ref');
    const weakProviderOrder = {
      Id: 8201, Code: 'KV-CRASH-GAP-8201', BranchId: 7, Status: 1,
      Description: 'Đơn không có marker trong cửa sổ provider-success/DB-missing',
      ModifiedDate: new Date().toISOString(),
    };
    stub.createdOrders.push(weakProviderOrder);

    const unresolvedEvent = `evt-unresolved-${uniq()}`;
    const piiName = `Tên không được lưu ${uniq()}`;
    const piiPhone = `098${Math.floor(1000000 + Math.random() * 8999999)}`;
    const piiDescription = `Gọi ${piiName} qua ${piiPhone}, giao tại Địa chỉ PII không được lưu`;
    await webhook(invoicePath, invoicePayload(unresolvedEvent, 7201, 1, {
      OrderId: 8201, Description: piiDescription,
      CustomerName: piiName, CustomerContactNumber: piiPhone,
      InvoiceDelivery: { Address: 'Địa chỉ PII không được lưu' },
    }), secret);
    const unresolvedDone = await inboxStatus(shop.shopId, unresolvedEvent, 'invoice.update');
    const cursorBeforeBlocked = (await owner.query(
      `SELECT order_reconcile_cursor_at FROM shop_integrations WHERE id=$1`, [active.id],
    )).rows[0]?.order_reconcile_cursor_at ?? null;
    const firstReconcile = await requestReconcile('e2e-crash-gap-pending');
    const cursorAfterBlocked = (await owner.query(
      `SELECT order_reconcile_cursor_at FROM shop_integrations WHERE id=$1`, [active.id],
    )).rows[0]?.order_reconcile_cursor_at ?? null;
    const unresolved = (await owner.query(
      `SELECT r.local_id,r.mapping_status,r.raw_meta,d.kind,d.severity
         FROM integration_entity_refs r
         LEFT JOIN integration_sync_discrepancies d
           ON d.shop_id=r.shop_id AND d.integration_id=r.integration_id
          AND d.dedupe_key='invoice-order-pending:7201' AND d.status='open'
        WHERE r.shop_id=$1 AND r.integration_id=$2 AND r.entity_type='invoice' AND r.external_id='7201'`,
      [shop.shopId, active.id],
    )).rows[0];
    const weakProofWhilePending = (await owner.query(
      `SELECT local_id,mapping_status,raw_meta FROM integration_entity_refs
        WHERE shop_id=$1 AND integration_id=$2 AND entity_type='order' AND external_id='8201'`,
      [shop.shopId, active.id],
    )).rows[0];
    const unresolvedOrder = (await owner.query(
      `SELECT id FROM orders WHERE shop_id=$1 AND integration_id=$2 AND external_ref='7201'`,
      [shop.shopId, active.id],
    )).rows[0];
    const unresolvedRaw = JSON.stringify(unresolved?.raw_meta ?? {});
    const cursorHeld = (cursorBeforeBlocked == null && cursorAfterBlocked == null)
      || (cursorBeforeBlocked != null && cursorAfterBlocked != null
        && new Date(cursorBeforeBlocked).getTime() === new Date(cursorAfterBlocked).getTime());
    unresolvedDone?.status === 'completed' && !unresolvedOrder && !unresolved?.local_id
      && unresolved?.kind === 'order_identity_pending' && unresolved.severity === 'critical'
      && !unresolvedRaw.includes(piiName) && !unresolvedRaw.includes(piiPhone)
      && !unresolvedRaw.includes('Địa chỉ PII không được lưu')
      && !unresolvedRaw.includes(piiDescription)
      && firstReconcile && !weakProofWhilePending && cursorHeld
      ? ok('còn đơn website crash-gap → full order không marker chưa được coi là POS; invoice giữ chờ và scrub PII')
      : bad('absence marker đã bị dùng làm POS proof khi còn đơn website pending', JSON.stringify({ unresolvedDone, unresolvedOrder, unresolved, weakProofWhilePending, firstReconcile }));

    const weakAt = new Date(Date.now() + 60_000).toISOString();
    await withIntegration(shop.shopId, active.id, active.generation, (c) => c.query(
      `INSERT INTO integration_entity_refs
         (shop_id,integration_id,entity_type,external_id,local_id,mapping_status,external_updated_at,raw_meta)
       VALUES (current_shop_id(),$1,'order','8201',NULL,'ignored',$2,$3)`,
      [active.id, weakAt, { provider_code: weakProviderOrder.Code, platform_marker: false }],
    ));
    const markerAt = new Date(Date.now() - 60_000).toISOString();
    const markerEvent = `evt-marker-upgrade-${uniq()}`;
    await webhook(path, {
      Id: markerEvent, Notifications: [{ Action: 'update', Data: [{
        ...weakProviderOrder,
        Description: `[NTG:${shop.shopId}:${crashGapOrder.id}:${crashGapOrder.order_number}]`,
        ModifiedDate: markerAt,
      }] }],
    }, secret);
    const markerDone = await inboxStatus(shop.shopId, markerEvent, 'order.update');
    const upgraded = await waitFor(async () => {
      const row = (await owner.query(
        `SELECT local_id,mapping_status,external_updated_at,raw_meta FROM integration_entity_refs
          WHERE shop_id=$1 AND integration_id=$2 AND entity_type='order' AND external_id='8201'`,
        [shop.shopId, active.id],
      )).rows[0];
      return row?.local_id === crashGapOrder.id ? row : null;
    }, 10000);
    const retryUnresolved = (await owner.query(
      `INSERT INTO outbox (shop_id,topic,payload)
       VALUES ($1,'integration.invoice_retry_requested',$2) RETURNING id`,
      [shop.shopId, { integration_id: active.id, generation: Number(active.generation), external_id: '7201' }],
    )).rows[0];
    await waitFor(async () => (await owner.query(
      `SELECT processed_at FROM outbox WHERE id=$1`, [retryUnresolved.id],
    )).rows[0]?.processed_at, 10000);
    const resolvedInvoice = await waitFor(async () => {
      const row = (await owner.query(
        `SELECT local_id,mapping_status FROM integration_entity_refs
          WHERE shop_id=$1 AND integration_id=$2 AND entity_type='invoice' AND external_id='7201'`,
        [shop.shopId, active.id],
      )).rows[0];
      return row?.local_id === crashGapOrder.id ? row : null;
    }, 10000);
    const pendingCase = (await owner.query(
      `SELECT status FROM integration_sync_discrepancies
        WHERE shop_id=$1 AND integration_id=$2 AND dedupe_key='invoice-order-pending:7201'`,
      [shop.shopId, active.id],
    )).rows[0];
    const falsePosRevenue = Number((await owner.query(
      `SELECT count(*)::int n FROM orders
        WHERE shop_id=$1 AND integration_id=$2 AND source='kiotviet_pos' AND external_ref='7201'`,
      [shop.shopId, active.id],
    )).rows[0].n);
    markerDone?.status === 'completed' && upgraded?.mapping_status === 'mapped'
      && new Date(upgraded.external_updated_at).getTime() === new Date(weakAt).getTime()
      && resolvedInvoice?.mapping_status === 'mapped' && pendingCase?.status === 'resolved'
      && falsePosRevenue === 0
      ? ok('marker mạnh dù timestamp cũ vẫn nâng weak evidence, retry nối invoice vào đơn website và không đếm POS')
      : bad('marker mạnh không phục hồi được crash-gap hoặc đã tạo doanh thu POS giả', JSON.stringify({ markerDone, upgraded, resolvedInvoice, pendingCase, falsePosRevenue }));

    const previousConflictOrder = await makeWebsiteOrder('Đơn đang giữ mapping cũ');
    const markerConflictOrder = await makeWebsiteOrder('Đơn bị marker mới trỏ tới');
    await withIntegration(shop.shopId, active.id, active.generation, (c) => c.query(
      `INSERT INTO integration_entity_refs
         (shop_id,integration_id,entity_type,external_id,local_id,mapping_status,external_updated_at,raw_meta)
       VALUES (current_shop_id(),$1,'order','8203',$2,'mapped',now(),$3)`,
      [active.id, previousConflictOrder.id, { marker: 'mapping cũ', provider_code: 'KV-CONFLICT-8203' }],
    ));
    const conflictEvent = `evt-marker-conflict-${uniq()}`;
    await webhook(path, {
      Id: conflictEvent, Notifications: [{ Action: 'update', Data: [{
        Id: 8203, Code: 'KV-CONFLICT-8203', Status: 1, ModifiedDate: new Date().toISOString(),
        Description: `[NTG:${shop.shopId}:${markerConflictOrder.id}:${markerConflictOrder.order_number}]`,
      }] }],
    }, secret);
    const conflictDone = await inboxStatus(shop.shopId, conflictEvent, 'order.update');
    const conflictRef = (await owner.query(
      `SELECT local_id FROM integration_entity_refs
        WHERE shop_id=$1 AND integration_id=$2 AND entity_type='order' AND external_id='8203'`,
      [shop.shopId, active.id],
    )).rows[0];
    const conflictCase = (await owner.query(
      `SELECT kind,severity,local_id,details FROM integration_sync_discrepancies
        WHERE shop_id=$1 AND integration_id=$2 AND dedupe_key='order-marker-conflict:8203' AND status='open'`,
      [shop.shopId, active.id],
    )).rows[0];
    conflictDone?.status === 'completed' && conflictRef?.local_id === previousConflictOrder.id
      && conflictCase?.kind === 'order_identity_pending' && conflictCase.severity === 'critical'
      && conflictCase.local_id === markerConflictOrder.id
      && conflictCase.details?.previous_local_id === previousConflictOrder.id
      ? ok('marker mới không remap external order đang thuộc đơn khác; mở ca conflict đúng hai ID')
      : bad('marker conflict đã âm thầm đổi đơn hoặc không mở ca', JSON.stringify({ conflictDone, conflictRef, conflictCase }));

    await withIntegration(shop.shopId, active.id, active.generation, (c) => c.query(
      `UPDATE orders SET status='cancelled',sync_status='not_required',sync_error=NULL,sync_updated_at=now()
        WHERE id=ANY($1::uuid[])`, [[previousConflictOrder.id, markerConflictOrder.id]],
    ));

    const posPendingEvent = `evt-pos-proof-pending-${uniq()}`;
    const posCustomerName = `Khách POS lưu theo projection ${uniq()}`;
    const posCustomerPhone = `096${Math.floor(1000000 + Math.random() * 8999999)}`;
    await webhook(invoicePath, invoicePayload(posPendingEvent, 7202, 1, {
      OrderCode: 'KV-POS-8204', Description: 'Hóa đơn POS chỉ có mã đơn ngoài, không có marker',
      CustomerId: 9202, CustomerName: posCustomerName, CustomerContactNumber: posCustomerPhone,
    }), secret);
    const posPendingDone = await inboxStatus(shop.shopId, posPendingEvent, 'invoice.update');
    const pendingPosInvoiceSnapshot = (await owner.query(
      `SELECT raw_meta FROM integration_entity_refs
        WHERE shop_id=$1 AND integration_id=$2 AND entity_type='invoice' AND external_id='7202'`,
      [shop.shopId, active.id],
    )).rows[0]?.raw_meta ?? {};
    stub.createdOrders.push({
      Id: 8204, Code: 'KV-POS-8204', BranchId: 7, Status: 1,
      Description: 'Đơn bán tại quầy không có marker', ModifiedDate: new Date().toISOString(),
    });
    const posProofReconcile = await requestReconcile('e2e-pos-proof-order-code');
    const importedPos = await waitFor(async () => {
      const row = (await owner.query(
        `SELECT id,source,customer_id FROM orders
          WHERE shop_id=$1 AND integration_id=$2 AND external_ref='7202'`,
        [shop.shopId, active.id],
      )).rows[0];
      return row?.source === 'kiotviet_pos' ? row : null;
    }, 15000);
    const posProofRef = (await owner.query(
      `SELECT local_id,mapping_status,raw_meta FROM integration_entity_refs
        WHERE shop_id=$1 AND integration_id=$2 AND entity_type='order' AND external_id='8204'`,
      [shop.shopId, active.id],
    )).rows[0];
    const posPendingCase = (await owner.query(
      `SELECT status FROM integration_sync_discrepancies
        WHERE shop_id=$1 AND integration_id=$2 AND dedupe_key='invoice-order-pending:7202'`,
      [shop.shopId, active.id],
    )).rows[0];
    const posCustomerProjection = (await owner.query(
      `SELECT r.local_id,c.full_name,c.phone
         FROM integration_entity_refs r JOIN customers c ON c.id=r.local_id AND c.shop_id=r.shop_id
        WHERE r.shop_id=$1 AND r.integration_id=$2 AND r.entity_type='customer' AND r.external_id='9202'`,
      [shop.shopId, active.id],
    )).rows[0];
    await requestReconcile('e2e-pos-proof-idempotent');
    const posProofCounts = (await owner.query(
      `SELECT count(DISTINCT o.id)::int AS orders, count(p.id)::int AS payments
         FROM orders o LEFT JOIN payment_transactions p ON p.order_id=o.id
        WHERE o.shop_id=$1 AND o.integration_id=$2 AND o.external_ref='7202'`,
      [shop.shopId, active.id],
    )).rows[0];
    const pendingSnapshotText = JSON.stringify(pendingPosInvoiceSnapshot);
    posPendingDone?.status === 'completed' && posProofReconcile && importedPos
      && !posProofRef?.local_id && posProofRef?.mapping_status === 'ignored'
      && posProofRef.raw_meta?.platform_marker === false && posPendingCase?.status === 'resolved'
      && pendingPosInvoiceSnapshot.CustomerId === '9202'
      && !pendingSnapshotText.includes(posCustomerName) && !pendingSnapshotText.includes(posCustomerPhone)
      && importedPos.customer_id === posCustomerProjection?.local_id
      && posCustomerProjection?.full_name === posCustomerName
      && posCustomerProjection?.phone === posCustomerPhone
      && Number(posProofCounts.orders) === 1 && Number(posProofCounts.payments) === 1
      ? ok('hết đơn website pending + full no-marker → POS proof; retry OrderCode đúng một lần, PII nằm ở customer projection')
      : bad('POS proof không phục hồi invoice hoặc đã nhập doanh thu hai lần', JSON.stringify({ posPendingDone, posProofReconcile, importedPos, posProofRef, posPendingCase, posCustomerProjection, pendingPosInvoiceSnapshot, posProofCounts }));

    const customerInvoice = async (invoiceId, customerId, name, phone) => {
      const eventId = `evt-customer-${invoiceId}-${uniq()}`;
      await webhook(invoicePath, invoicePayload(eventId, invoiceId, 1, {
        CustomerId: customerId, CustomerName: name, CustomerContactNumber: phone,
      }), secret);
      return inboxStatus(shop.shopId, eventId, 'invoice.update');
    };
    const sharedPhone = `097${Math.floor(1000000 + Math.random() * 8999999)}`;
    const customerDone = await Promise.all([
      customerInvoice(7301, 9001, 'Khách POS lần đầu', sharedPhone),
      customerInvoice(7302, 9001, 'Khách POS cập nhật', sharedPhone),
    ]);
    const otherCustomerDone = await customerInvoice(7303, 9002, 'Khách POS cập nhật', sharedPhone);
    const customerOrders = (await owner.query(
      `SELECT external_ref,customer_id FROM orders
        WHERE shop_id=$1 AND integration_id=$2 AND external_ref IN ('7301','7302','7303')
        ORDER BY external_ref`, [shop.shopId, active.id],
    )).rows;
    const customerByInvoice = new Map(customerOrders.map((row) => [row.external_ref, row.customer_id]));
    const customerRefs = (await owner.query(
      `SELECT external_id,local_id FROM integration_entity_refs
        WHERE shop_id=$1 AND integration_id=$2 AND entity_type='customer'
          AND external_id IN ('9001','9002') ORDER BY external_id`, [shop.shopId, active.id],
    )).rows;
    customerDone.every((row) => row?.status === 'completed') && otherCustomerDone?.status === 'completed'
      && customerByInvoice.get('7301') === customerByInvoice.get('7302')
      && customerByInvoice.get('7301') !== customerByInvoice.get('7303')
      && customerRefs.length === 2 && customerRefs[0].local_id !== customerRefs[1].local_id
      ? ok('POS customer chỉ nối theo CustomerId: cùng ID dùng lại, khác ID không gộp dù trùng tên/SĐT')
      : bad('customer mapping đã gộp theo dữ liệu mô tả', JSON.stringify({ customerDone, otherCustomerDone, customerOrders, customerRefs }));

    const detail = await admin('GET', `/shops/${shop.shopId}/orders/${outbound.id}`, { cookie });
    const orderActionRe = new RegExp(`/shops/${shop.shopId}/orders/${outbound.id}/(?:edit(?:-paid)?|confirm|ship|cancel|deliver|mark-returned|reopen|ship-cost|payments/|refund|return|carrier-)`);
    const mutation = await json(SELLER, 'POST', `/shops/${shop.shopId}/orders/${outbound.id}/cancel`, {
      cookie: sellerCookie, origin: OS, body: { reason: 'không được sửa local' },
    });
    const outboundAfterMutation = (await owner.query(
      `SELECT status,external_ref FROM orders WHERE id=$1`, [outbound.id],
    )).rows[0];
    const orderDetailChecks = {
      status: detail.status,
      notice: /do hệ thống POS ngoài thực hiện/i.test(detail.body),
      actionMatch: detail.body.match(orderActionRe)?.[0] ?? null,
      mutationStatus: mutation.status,
      mutationError: mutation.json?.error ?? null,
      after: outboundAfterMutation,
    };
    detail.status === 200 && /do hệ thống POS ngoài thực hiện/i.test(detail.body)
      && !orderActionRe.test(detail.body)
      && mutation.status === 409 && /POS ngoài/i.test(mutation.json?.error ?? '')
      && outboundAfterMutation.status === 'confirmed' && outboundAfterMutation.external_ref
      ? ok('đơn provider đã nhận chỉ-đọc ở UI và route sửa bị DB chặn 409')
      : bad('đơn ngoài vẫn mời hoặc cho phép thao tác local', JSON.stringify({ ...orderDetailChecks, detail: detail.body.slice(0, 500), mutation }));

    sect('5. Rotate credential đổi generation, vô hiệu secret/job cũ');
    const staleFixture = await withIntegration(shop.shopId, active.id, active.generation, async (c) => {
      const number = (await c.query(
        `INSERT INTO shop_counters (shop_id,name,value) VALUES (current_shop_id(),'order_number',1)
         ON CONFLICT (shop_id,name) DO UPDATE SET value=shop_counters.value+1 RETURNING value`,
      )).rows[0].value;
      const order = (await c.query(
        `INSERT INTO orders
           (shop_id,order_number,status,payment_status,payment_method,customer_name,subtotal_vnd,total_vnd,
            source,integration_id,integration_generation,external_branch_ref,sync_status,sync_updated_at)
         VALUES (current_shop_id(),$1,'pending','unpaid','cod','Đơn generation cũ',45000,45000,
                 'web',$2,$3,'7','pending',now()) RETURNING id`,
        [number, active.id, Number(active.generation)],
      )).rows[0];
      await c.query(
        `INSERT INTO order_lines
           (shop_id,order_id,variant_id,title_snapshot,sku_snapshot,unit_price_vnd,qty)
         VALUES (current_shop_id(),$1,$2,'Áo POS','POS-501',45000,1)`, [order.id, variantId],
      );
      const inbox = (await c.query(
        `INSERT INTO integration_webhook_inbox
           (shop_id,integration_id,generation,provider_event_id,event_type,payload_hash,payload,status)
         VALUES (current_shop_id(),$1,$2,$3,'order.update',$4,$5,'pending') RETURNING id`,
        [active.id, Number(active.generation), `evt-stale-${uniq()}`, 'a'.repeat(64), { customer_phone: '0900000000' }],
      )).rows[0];
      return { orderId: order.id, inboxId: inbox.id };
    });
    const rotateCredentials = { retailer: credentials.retailer, client_id: 'client-rotated', client_secret: 'secret-rotated' };
    r = await admin('POST', `${base}/kiotviet/probe`, { cookie, form: rotateCredentials });
    if (!/name="pending_token"/i.test(r.body)) {
      r = await admin('POST', `${base}/kiotviet/probe/step-up`, {
        cookie, form: { ...rotateCredentials, password: shop.password },
      });
    }
    const rotateToken = /name="pending_token" value="([0-9a-f-]+)"/i.exec(r.body)?.[1] ?? '';
    const staleActivation = await admin('POST', `${base}/kiotviet/activate/step-up`, {
      cookie, form: { branch_id: '7', pending_token: pendingToken, password: shop.password },
    });
    staleActivation.status === 400 && /kiểm tra lại|phiên khác|không còn hiệu lực/i.test(staleActivation.body)
      ? ok('pending_token cũ không thể kích hoạt credential vừa bị probe thay thế')
      : bad('activation CAS nhận nhầm pending_token cũ', `${staleActivation.status} ${staleActivation.body.slice(0, 300)}`);
    r = await admin('POST', `${base}/kiotviet/activate/step-up`, {
      cookie, form: { branch_id: '7', pending_token: rotateToken, password: shop.password },
    });
    const rotated = await waitFor(async () => {
      const row = (await owner.query(
        `SELECT id,status,inventory_authority,credential_ciphertext,webhook_public_id,generation
           FROM shop_integrations WHERE id=$1`, [active.id],
      )).rows[0];
      return row?.status === 'active' && Number(row.generation) === Number(active.generation) + 1 ? row : null;
    }, 30000);
    const superseded = (await owner.query(
      `SELECT status,payload FROM integration_webhook_inbox WHERE id=$1`, [staleFixture.inboxId],
    )).rows[0];
    const staleOrder = (await owner.query(
      `SELECT sync_status,sync_error,external_ref FROM orders WHERE id=$1`, [staleFixture.orderId],
    )).rows[0];
    r.status === 200 && rotated && superseded?.status === 'superseded'
      && JSON.stringify(superseded.payload) === '{}' && staleOrder?.sync_status === 'needs_attention'
      ? ok('rotate tăng đúng một generation, scrub inbox cũ và đưa đơn cũ sang cần xử lý')
      : bad('rotate không supersede đủ trạng thái generation cũ', JSON.stringify({ response: r.status, rotated, superseded, staleOrder }));

    const providerCountBeforeStaleJob = stub.createdOrders.length;
    const staleOutbox = (await owner.query(
      `INSERT INTO outbox (shop_id,topic,payload)
       VALUES ($1,'integration.order_created',$2) RETURNING id`,
      [shop.shopId, { integration_id: active.id, generation: Number(active.generation), order_id: staleFixture.orderId }],
    )).rows[0];
    await waitFor(async () => (await owner.query(`SELECT processed_at FROM outbox WHERE id=$1`, [staleOutbox.id])).rows[0]?.processed_at, 10000);
    await sleep(1500);
    const staleAfterJob = (await owner.query(
      `SELECT sync_status,external_ref FROM orders WHERE id=$1`, [staleFixture.orderId],
    )).rows[0];
    stub.createdOrders.length === providerCountBeforeStaleJob
      && staleAfterJob.sync_status === 'needs_attention' && !staleAfterJob.external_ref
      ? ok('job generation cũ được nuốt an toàn, không dùng credential/branch mới để gửi đơn')
      : bad('job cũ đã sống lại trên connector mới', JSON.stringify({ providerCountBeforeStaleJob, after: stub.createdOrders.length, staleAfterJob }));

    const newSecret = JSON.parse(open(rotated.credential_ciphertext, ENC_KEY, 'INTEGRATION_ENC_KEYS')).webhook_secret;
    const oldUrlResult = await webhook(path, { Id: `evt-old-url-${uniq()}`, Notifications: [] }, secret);
    const newPath = `/integrations/kiotviet/webhooks/${rotated.webhook_public_id}/order.update`;
    const oldSecretResult = await webhook(newPath, { Id: `evt-old-secret-${uniq()}`, Notifications: [] }, secret);
    const newEvent = `evt-new-secret-${uniq()}`;
    const newSecretResult = await webhook(newPath, { Id: newEvent, Notifications: [] }, newSecret);
    const newSecretDone = await inboxStatus(shop.shopId, newEvent, 'order.update');
    oldUrlResult.status === 404 && oldSecretResult.status === 401
      && newSecretResult.status === 202 && newSecretDone?.status === 'completed'
      ? ok('URL/secret generation cũ đều vô hiệu; chỉ cặp credential mới nhận webhook')
      : bad('secret rotation còn nhận webhook cũ hoặc chặn nhầm secret mới', JSON.stringify({ oldUrlResult, oldSecretResult, newSecretResult, newSecretDone }));

    sect('6. Ngắt kết nối bắt step-up, gỡ webhook provider và giữ mapping');
    const deletedBeforeDisable = stub.deleted.length;
    cookie = await adminLogin(shop.email, shop.password);
    r = await admin('POST', `${base}/${active.id}/disable`, { cookie, form: {} });
    r.status === 200 && /Xác nhận ngắt kết nối POS/.test(r.body)
      ? ok('session mới chưa step-up → interstitial ngắt kết nối') : bad('disable không bắt step-up', r.body);
    r = await admin('POST', `${base}/${active.id}/disable/step-up`, { cookie, form: { password: 'sai mật khẩu' } });
    const stillActive = (await owner.query(`SELECT status FROM shop_integrations WHERE id=$1`, [active.id])).rows[0]?.status;
    r.status === 401 && stillActive !== 'disabled'
      ? ok('mật khẩu sai → 401 và connector chưa bị ngắt') : bad('disable lọt qua mật khẩu sai', `${r.status} ${stillActive}`);
    r = await admin('POST', `${base}/${active.id}/disable/step-up`, { cookie, form: { password: shop.password } });
    const disabled = (await owner.query(
      `SELECT status,inventory_authority,generation,credential_ciphertext,webhook_public_id
         FROM shop_integrations WHERE id=$1`, [active.id],
    )).rows[0];
    r.status === 200 && disabled?.status === 'disabled' && disabled.inventory_authority === 'external_master'
      && Number(disabled.generation) === Number(rotated.generation) + 1
      && disabled.credential_ciphertext == null && disabled.webhook_public_id == null
      ? ok('mật khẩu đúng → disabled, tăng generation, xoá secret/URL nhưng giữ external_master') : bad('disable sai trạng thái', JSON.stringify(disabled));
    stub.deleted.length - deletedBeforeDisable === 5 && stub.registered.size === 0
      ? ok('gỡ đủ 5 webhook hiện hành ở KiotViet') : bad(`lượt disable đã gỡ ${stub.deleted.length - deletedBeforeDisable}/5 webhook`, JSON.stringify(stub.deleted));

    console.log(`\n${pass} pass, ${fail} fail`);
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    await stub.close();
    await owner.end();
    await integrationDb.end();
  }
}

main().catch(async (error) => {
  console.error(error);
  await owner.end().catch(() => {});
  await integrationDb.end().catch(() => {});
  process.exit(1);
});
