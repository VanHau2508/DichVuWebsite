/**
 * Readiness/go-live end-to-end: onboarding không bán công khai, preview có TTL/cô lập
 * tenant, và chỉ dữ liệu server-side đầy đủ mới mở được checkout.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const STORE = new URL(process.env.STOREFRONT_URL ?? 'http://storefront:3050');
const CHECKOUT = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
const rw = new pg.Pool({ connectionString: process.env.DATABASE_URL_RW, max: 2 });

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', X = '\x1b[0m';
const ok = (msg) => { pass++; console.log(`  ${G}PASS${X} ${msg}`); };
const bad = (msg, detail = '') => { fail++; console.log(`  ${R}FAIL${X} ${msg}${detail ? ` — ${detail}` : ''}`); };
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sessionOf = (cookies) => (cookies ?? []).map((c) => /^__Host-session=([^;]+)/.exec(c)?.[1]).find(Boolean) ?? null;
const inviteTokenOf = async (email) => {
  const row = (await owner.query(
    `SELECT payload->>'accept_url' AS url FROM outbox
      WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email],
  )).rows[0];
  return row?.url ? new URL(row.url).searchParams.get('token') : null;
};

async function rq(base, method, path, { body, cookie, origin } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = `__Host-session=${cookie}`;
  if (origin) headers.origin = origin;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await res.text();
  let json = null; try { json = raw ? JSON.parse(raw) : null; } catch {}
  return { status: res.status, json, raw, cookies: res.headers.getSetCookie() };
}

function publicReq(base, host, method, path, { body, cookie, idem } = {}) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? null : JSON.stringify(body);
    const headers = { host, origin: `https://${host}` };
    if (raw != null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(raw); }
    if (cookie) headers.cookie = cookie;
    if (idem) headers['idempotency-key'] = idem;
    const req = http.request({ hostname: base.hostname, port: base.port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: text, json });
      });
    });
    req.on('error', reject);
    if (raw != null) req.write(raw);
    req.end();
  });
}

async function makeStaff() {
  const email = `staff-ready-${uniq()}@nentang.vn`, password = 'staff readiness passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let cookie = sessionOf((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).cookies);
  const enroll = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie, origin: OA });
  const key = base32Decode(enroll.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie, body: { code: totp(key, {}) }, origin: OA });
  const userId = (await owner.query(`SELECT id FROM users WHERE email=$1`, [email])).rows[0].id;
  await owner.query(`INSERT INTO platform_staff (user_id, role) VALUES ($1, 'admin')`, [userId]);
  const counter = counterFor(Date.now());
  while (counterFor(Date.now()) <= counter) await sleep(1000);
  cookie = sessionOf((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).cookies);
  return sessionOf((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).cookies) ?? cookie;
}

async function makeShop(staff, label) {
  const slug = `ready-${label}-${uniq()}`;
  let res = await rq(PLATFORM, 'POST', '/ops/shops', {
    body: { name: `Shop ${label}`, slug, plan_code: 'platform' }, cookie: staff, origin: OO,
  });
  const shopId = res.json.id;
  const email = `owner-${slug}@shop.vn`, password = 'owner readiness passphrase';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, {
    body: { email, role: 'owner' }, cookie: staff, origin: OO,
  });
  await rq(AUTH, 'POST', '/auth/invitations/accept', {
    body: { token: await inviteTokenOf(email), password }, origin: OA,
  });
  const cookie = sessionOf((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).cookies);
  return { shopId, slug, host: `${slug}.nentang.vn`, cookie };
}

async function publishPolicy(shop, slug, title) {
  const made = await rq(SELLER, 'POST', `/shops/${shop.shopId}/pages`, {
    cookie: shop.cookie, origin: OS,
    body: { slug, title, blocks: [{ type: 'paragraph', text: `${title} của cửa hàng.` }] },
  });
  if (made.status !== 201) return made;
  return rq(SELLER, 'POST', `/shops/${shop.shopId}/pages/${made.json.id}/publish`, {
    cookie: shop.cookie, origin: OS, body: {},
  });
}

async function dryRunFootprint(shopId) {
  const row = (await owner.query(
    `SELECT
       (SELECT count(*)::int FROM orders WHERE shop_id=$1) AS orders,
       (SELECT count(*)::int FROM carts WHERE shop_id=$1) AS carts,
       (SELECT count(*)::int FROM outbox WHERE shop_id=$1) AS outbox,
       (SELECT coalesce(sum(reserved), 0)::int FROM inventory_levels WHERE shop_id=$1) AS reserved`,
    [shopId],
  )).rows[0];
  return JSON.stringify(row);
}

async function tenantSqlstate(shopId, text) {
  const c = await rw.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);
    await c.query(text);
    await c.query('COMMIT');
    return null;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    return err.code ?? 'UNKNOWN';
  } finally {
    c.release();
  }
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShop(staff, 'a');
  const B = await makeShop(staff, 'b');

  let res = await publicReq(STORE, A.host, 'GET', '/');
  res.status === 200 && /đang chuẩn bị mở bán/i.test(res.body) && /no-store/.test(String(res.headers['cache-control']))
    ? ok('shop onboarding chỉ hiện trang chuẩn bị mở bán') : bad('storefront onboarding vẫn công khai', `${res.status}`);
  res = await publicReq(CHECKOUT, A.host, 'GET', '/cart');
  res.status === 409 && res.json?.error === 'shop_not_live'
    ? ok('checkout onboarding trả 409 shop_not_live') : bad('checkout onboarding chưa bị khoá', `${res.status} ${res.body}`);

  let ready = await rq(SELLER, 'GET', `/shops/${A.shopId}/readiness`, { cookie: A.cookie, origin: OS });
  ready.status === 200 && ready.json.ready === false && ready.json.checks.some((c) => c.code === 'catalog' && c.status === 'missing')
    ? ok('readiness chỉ ra đúng mục còn thiếu') : bad('readiness ban đầu sai', ready.raw);
  res = await rq(SELLER, 'POST', `/shops/${A.shopId}/activate`, { cookie: A.cookie, origin: OS, body: {} });
  res.status === 409 && res.json?.error === 'shop_not_ready'
    ? ok('endpoint activate cũ không bỏ qua readiness') : bad('activate cũ mở bán sớm', `${res.status} ${res.raw}`);

  const directStatus = await tenantSqlstate(A.shopId,
    `UPDATE shops SET status = 'active' WHERE id = current_shop_id()`);
  const directLiveAt = await tenantSqlstate(A.shopId,
    `UPDATE shops SET went_live_at = now() WHERE id = current_shop_id()`);
  const guarded = (await owner.query(
    `SELECT status, went_live_at FROM shops WHERE id=$1`, [A.shopId],
  )).rows[0];
  directStatus === '42501' && directLiveAt === '42501'
    && guarded.status === 'onboarding' && guarded.went_live_at == null
    ? ok('app_rw không thể tự UPDATE status/went_live_at để bỏ qua checklist')
    : bad('quyền DB vẫn cho seller bypass go-live', `${directStatus}/${directLiveAt}/${JSON.stringify(guarded)}`);

  const productTitle = `Sản phẩm readiness ${uniq()}`;
  const product = await rq(SELLER, 'POST', `/shops/${A.shopId}/products`, {
    cookie: A.cookie, origin: OS,
    body: { title: productTitle, slug: `san-pham-${uniq()}`, price_vnd: 120000, status: 'active', variants: [{ sku: `RD-${uniq()}`, price_vnd: 120000 }] },
  });
  const detail = await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${product.json.id}`, { cookie: A.cookie, origin: OS });
  const variantId = detail.json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${A.shopId}/variants/${variantId}/inventory/adjust`, {
    cookie: A.cookie, origin: OS, body: { delta: 20, reason: 'dữ liệu nghiệm thu readiness' },
  });
  await rq(SELLER, 'PATCH', `/shops/${A.shopId}`, {
    cookie: A.cookie, origin: OS,
    body: { name: 'Shop readiness A', contact_phone: '0901234567', ship_fee_vnd: 30000, ship_mode: 'region' },
  });
  const p1 = await publishPolicy(A, 'chinh-sach-mua-hang', 'Chính sách mua hàng');
  const p2 = await publishPolicy(A, 'chinh-sach-bao-mat', 'Chính sách bảo mật');
  p1.status === 200 && p2.status === 200 ? ok('xuất bản đủ hai chính sách chặn go-live') : bad('không dựng được chính sách');

  const footprintBefore = await dryRunFootprint(A.shopId);
  ready = await rq(SELLER, 'GET', `/shops/${A.shopId}/readiness`, { cookie: A.cookie, origin: OS });
  const mfa = ready.json?.checks?.find((c) => c.code === 'mfa');
  ready.status === 200 && ready.json.ready === true && mfa?.status === 'warning' && mfa.blocking === false
    ? ok('readiness đạt; MFA là cảnh báo không chặn') : bad('readiness đủ dữ liệu vẫn đỏ', ready.raw);
  const footprintAfter = await dryRunFootprint(A.shopId);
  footprintAfter === footprintBefore
    ? ok('checkout dry-run không tạo order/cart/outbox hoặc reserve tồn')
    : bad('checkout dry-run đã ghi dữ liệu nghiệp vụ', `${footprintBefore} -> ${footprintAfter}`);

  const preview = await rq(SELLER, 'POST', `/shops/${A.shopId}/preview`, { cookie: A.cookie, origin: OS, body: {} });
  const previewToken = preview.json?.token;
  res = await publicReq(STORE, A.host, 'GET', `/?shop_preview=${encodeURIComponent(previewToken ?? '')}`);
  const previewCookie = (res.headers['set-cookie'] ?? []).map((c) => /^(__Host-shop-preview=[^;]+)/.exec(c)?.[1]).find(Boolean);
  res.status === 302 && previewCookie && res.headers.location === '/'
    ? ok('preview đổi token URL sang cookie host-only') : bad('preview không đổi sang cookie', `${res.status}`);
  res = await publicReq(STORE, A.host, 'GET', '/', { cookie: previewCookie });
  res.status === 200 && res.body.includes(productTitle) && /XEM TRƯỚC CỬA HÀNG/.test(res.body)
    && /no-store/.test(String(res.headers['cache-control']))
    ? ok('token preview đúng shop thấy storefront thật nhưng không cache') : bad('preview đúng token không hoạt động', `${res.status}`);
  const cross = await publicReq(STORE, B.host, 'GET', `/?shop_preview=${encodeURIComponent(previewToken ?? '')}`);
  cross.status === 200 && /đang chuẩn bị mở bán/i.test(cross.body) && !cross.body.includes(productTitle)
    ? ok('token preview shop A không dùng được ở shop B') : bad('preview token dùng chéo shop', `${cross.status}`);
  await owner.query(
    `UPDATE shop_previews
        SET created_at = now() - interval '1 hour', expires_at = now() - interval '1 second'
      WHERE shop_id=$1`,
    [A.shopId],
  );
  res = await publicReq(STORE, A.host, 'GET', '/', { cookie: previewCookie });
  res.status === 200 && /đang chuẩn bị mở bán/i.test(res.body)
    ? ok('preview hết TTL bị từ chối ở RLS') : bad('preview hết hạn vẫn xem được', `${res.status}`);

  await rq(SELLER, 'POST', `/shops/${A.shopId}/products/${product.json.id}/archive`, {
    cookie: A.cookie, origin: OS, body: {},
  });
  res = await rq(SELLER, 'POST', `/shops/${A.shopId}/go-live`, { cookie: A.cookie, origin: OS, body: {} });
  res.status === 409 && res.json?.error === 'shop_not_ready'
    && res.json?.checks?.some((c) => c.code === 'catalog' && c.status === 'missing')
    ? ok('go-live kiểm tra lại dữ liệu server-side tại thời điểm bấm')
    : bad('go-live tin checklist readiness cũ', `${res.status} ${res.raw}`);
  await rq(SELLER, 'POST', `/shops/${A.shopId}/products/${product.json.id}/publish`, {
    cookie: A.cookie, origin: OS, body: {},
  });

  res = await rq(SELLER, 'POST', `/shops/${A.shopId}/go-live`, { cookie: A.cookie, origin: OS, body: {} });
  res.status === 200 && res.json?.status === 'active' ? ok('go-live đổi shop sang active') : bad('go-live thất bại', `${res.status} ${res.raw}`);
  res = await publicReq(STORE, A.host, 'GET', '/');
  res.status === 200 && res.body.includes(productTitle) && !/XEM TRƯỚC CỬA HÀNG/.test(res.body)
    ? ok('sau go-live storefront công khai sản phẩm') : bad('storefront sau go-live sai', `${res.status}`);

  let cart = await publicReq(CHECKOUT, A.host, 'POST', '/cart/items', { body: { variant_id: variantId, qty: 1 } });
  const cartCookie = (cart.headers['set-cookie'] ?? []).map((c) => /^(__Host-cart=[^;]+)/.exec(c)?.[1]).find(Boolean);
  cart.status === 200 && cartCookie ? ok('sau go-live checkout nhận giỏ') : bad('checkout vẫn bị khoá sau go-live', `${cart.status}`);
  const placed = await publicReq(CHECKOUT, A.host, 'POST', '/checkout', {
    cookie: cartCookie,
    idem: crypto.randomUUID(),
    body: { customer: { name: 'Khách readiness', phone: '0909999999' }, address: { line: '1 Test' }, payment_method: 'cod' },
  });
  const order = placed.status === 201
    ? (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2`, [A.shopId, placed.json.order_number])).rows[0]
    : null;
  const eventCount = order ? Number((await owner.query(
    `SELECT count(*)::int n FROM order_events WHERE shop_id=$1 AND order_id=$2 AND event_type='order.created' AND source='website'`,
    [A.shopId, order.id],
  )).rows[0].n) : 0;
  const outboxOrder = order ? (await owner.query(
    `SELECT payload->>'order_id' AS order_id FROM outbox WHERE shop_id=$1 AND topic='order.created' AND payload->>'order_id'=$2 ORDER BY id DESC LIMIT 1`,
    [A.shopId, order.id],
  )).rows[0]?.order_id : null;
  placed.status === 201 && eventCount === 1 && outboxOrder === order.id
    ? ok('tạo đơn ghi đúng một timeline event + order_id trong outbox cùng transaction')
    : bad('chứng từ order.created thiếu/sai', `${placed.status} event=${eventCount} outbox=${outboxOrder}`);

  console.log(`\n${pass} pass, ${fail} fail`);
  await Promise.all([owner.end(), rw.end()]);
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await Promise.all([owner.end().catch(() => {}), rw.end().catch(() => {})]);
  process.exit(1);
});
