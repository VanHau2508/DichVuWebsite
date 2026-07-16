/**
 * End-to-end VẬN CHUYỂN HÃNG (GHN/GHTK). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/shipping.e2e.mjs
 *
 * Test mở STUB hãng NGAY TRONG dbtest (seller/worker trỏ GHN_API_BASE=http://dbtest:9101,
 * GHTK_API_BASE=http://dbtest:9102 qua compose.dev) — không gọi hãng thật.
 *
 * Kiểm: kết nối per-shop (step-up, token mã hoá, không lộ), tạo vận đơn (claim chống trùng,
 * consume tồn, COD thu hộ đúng), hãng lỗi → nhả claim + đơn còn nguyên, worker poll →
 * delivered + email, cô lập chéo shop, checkout province.
 */

import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const WORKER = process.env.WORKER_URL ?? 'http://worker:3080';
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${d}${X}`); };
const sect = (m) => console.log(`\n${B}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const phone = () => '09' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };

async function rq(base, method, path, { body, cookie, origin } = {}) {
  const h = {};
  if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;

function co(host, method, path, { body, cartToken, idemKey } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = { host, origin: `https://${host}` };
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (cartToken) headers['cookie'] = `__Host-cart=${cartToken}`;
    if (idemKey) headers['idempotency-key'] = idemKey;
    const req = http.request({ hostname: CO.hostname, port: CO.port, path, method, headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => {
        let j = null; try { j = b ? JSON.parse(b) : null; } catch {}
        let token = cartToken;
        for (const c of res.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) token = m[1]; }
        resolve({ status: res.statusCode, json: j, raw: b, cartToken: token });
      });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

async function makeStaff() {
  const email = `staff-${uniq()}@nentang.vn`, password = 'staff strong passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let cookie = await login(email, password);
  let r = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie, origin: OA });
  const key = base32Decode(r.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie, body: { code: totp(key, {}) }, origin: OA });
  const c = counterFor(Date.now());
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,'admin')`, [await uidOf(email)]);
  while (counterFor(Date.now()) <= c) await sleep(1000);
  cookie = await login(email, password);
  cookie = ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).sc) ?? cookie;
  return cookie;
}
async function makeShopOwner(staffCookie, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: r.json.token, password }, origin: OA });
  return { shopId, slug, host: `${slug}.nentang.vn`, email, password, cookie: await login(email, password) };
}
async function setupProduct(shop, price, stock) {
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/products`, {
    body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `S-${uniq()}`, price_vnd: price }] }, cookie: shop.cookie, origin: OS });
  const detail = await rq(SELLER, 'GET', `/shops/${shop.shopId}/products/${r.json.id}`, { cookie: shop.cookie });
  const vid = detail.json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${shop.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: shop.cookie, origin: OS });
  return vid;
}
// Đặt đơn COD kèm email + province, trả {id, num}.
async function placeCod(shop, vid, email) {
  const cart = (await co(shop.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 2 } })).cartToken;
  const r = await co(shop.host, 'POST', '/checkout', {
    body: { customer: { name: 'Khách Vận Đơn', phone: phone(), email }, address: { line: '12 Nguyễn Huệ, P. Bến Nghé', province: 'TP. Hồ Chí Minh' }, payment_method: 'cod' },
    cartToken: cart, idemKey: `k-${uniq()}` });
  if (r.status !== 201) throw new Error(`checkout lỗi: ${r.raw}`);
  const id = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2`, [shop.shopId, r.json.order_number])).rows[0].id;
  return { id, num: r.json.order_number, total: Number(r.json.total_vnd) };
}

// ── STUB hãng VC: server giả trong dbtest, hành vi điều khiển bằng biến `mode` ──
const stub = { ghtkMode: 'ok', ghtkStatus: 4, lastCreateBody: null, ghnMode: 'ok' };
function startStubs() {
  const ghtk = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/services/shipment/order' && req.method === 'POST') {
        try { stub.lastCreateBody = JSON.parse(b); } catch { stub.lastCreateBody = null; }
        if (req.headers.token !== 'ghtk-token-cua-shop-a-123') { res.statusCode = 401; return res.end(JSON.stringify({ success: false, message: 'sai token' })); }
        if (stub.ghtkMode !== 'ok') { res.statusCode = 422; return res.end(JSON.stringify({ success: false, message: 'hãng từ chối (stub)' })); }
        return res.end(JSON.stringify({ success: true, order: { label: `S1.A2.${Math.floor(Math.random() * 1e7)}`, fee: 22000 } }));
      }
      if (req.url.startsWith('/services/shipment/v2/') && req.method === 'GET') {
        return res.end(JSON.stringify({ success: true, order: { status: stub.ghtkStatus } }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  const ghn = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v2/shipping-order/create' && req.method === 'POST') {
        if (req.headers.token !== 'ghn-token-abc' || req.headers.shopid !== '190001') { res.statusCode = 401; return res.end(JSON.stringify({ code: 401, message: 'sai token/shopid' })); }
        return res.end(JSON.stringify({ code: 200, data: { order_code: `GHN${Math.floor(Math.random() * 1e7)}`, total_fee: 31000 } }));
      }
      if (req.url === '/v2/shipping-order/detail') return res.end(JSON.stringify({ code: 200, data: { status: 'delivering' } }));
      res.statusCode = 404; res.end('{}');
    });
  });
  return Promise.all([
    new Promise((r) => ghn.listen(9101, '0.0.0.0', r)),
    new Promise((r) => ghtk.listen(9102, '0.0.0.0', r)),
  ]).then(() => ({ ghn, ghtk }));
}

async function main() {
  const servers = await startStubs();
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `shipa-${uniq()}`);
  const Bs = await makeShopOwner(staff, `shipb-${uniq()}`);
  const vid = await setupProduct(A, 250000, 40);
  ok('dựng 2 shop + sản phẩm + stub GHN/GHTK (9101/9102)');

  const S = (shop) => ({
    get: (p) => rq(SELLER, 'GET', `/shops/${shop.shopId}${p}`, { cookie: shop.cookie }),
    put: (p, body) => rq(SELLER, 'PUT', `/shops/${shop.shopId}${p}`, { body, cookie: shop.cookie, origin: OS }),
    post: (p, body) => rq(SELLER, 'POST', `/shops/${shop.shopId}${p}`, { body, cookie: shop.cookie, origin: OS }),
    del: (p) => rq(SELLER, 'DELETE', `/shops/${shop.shopId}${p}`, { cookie: shop.cookie, origin: OS }),
  });
  const a = S(A);
  const PICKUP = { name: 'Kho Nhà Xinh', phone: '0901234567', address: '5 Lê Lợi', province: 'TP. Hồ Chí Minh', district: 'Quận 1' };

  // ── 1. Kết nối hãng (step-up + token mã hoá) ────────────────────────────────
  sect('1. Kết nối GHTK per-shop');
  let r = await a.get('/shipping');
  r.json?.available === true && !r.json.connected ? ok('GET /shipping → available, chưa kết nối') : bad('GET shipping sai', r.raw);
  r = await a.put('/shipping', { provider: 'ghtk', token: 'ghtk-token-cua-shop-a-123', pickup: PICKUP });
  r.status === 403 && r.json?.error === 'step_up_required' ? ok('kết nối khi chưa step-up → 403') : bad('không đòi step-up', r.raw);
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: A.password }, cookie: A.cookie, origin: OA });
  r = await a.put('/shipping', { provider: 'ghtk', token: 'ghtk-token-cua-shop-a-123', pickup: PICKUP });
  r.status === 200 && r.json.token_prefix === 'ghtk-t' ? ok('sau step-up: kết nối GHTK → 200 + prefix') : bad('kết nối lỗi', r.raw);
  r = await a.get('/shipping');
  r.json.connected && r.json.provider === 'ghtk' && !JSON.stringify(r.json).includes('ghtk-token-cua-shop-a-123')
    ? ok('GET /shipping: connected, token KHÔNG lộ trong response') : bad('token lộ hoặc chưa connected', r.raw);
  const enc = (await owner.query(`SELECT token_enc FROM shop_shipping_config WHERE shop_id=$1`, [A.shopId])).rows[0].token_enc;
  !enc.includes('ghtk-token') && enc.split('.').length === 3 ? ok('token trong DB đã MÃ HOÁ (iv.tag.ct)') : bad('token DB plaintext!', enc.slice(0, 40));

  // ── 2. Tạo vận đơn qua hãng ─────────────────────────────────────────────────
  sect('2. Tạo vận đơn GHTK (COD thu hộ + consume tồn)');
  const o1 = await placeCod(A, vid, `khach-${uniq()}@mail.vn`);
  await a.post(`/orders/${o1.id}/confirm`, {});
  const TO = { to_name: 'Khách Vận Đơn', to_phone: '0912345678', to_address: '12 Nguyễn Huệ', to_province: 'TP. Hồ Chí Minh', to_district: 'Quận 1', weight_gram: 800 };
  const onHandBefore = Number((await owner.query(`SELECT on_hand FROM inventory_levels WHERE variant_id=$1`, [vid])).rows[0].on_hand);
  r = await a.post(`/orders/${o1.id}/carrier-shipment`, TO);
  r.status === 200 && r.json.tracking_number && r.json.carrier_fee_vnd === 22000
    ? ok(`tạo vận đơn → tracking ${r.json.tracking_number} + phí hãng 22.000`) : bad('tạo vận đơn lỗi', r.raw);
  Number(stub.lastCreateBody?.order?.pick_money) === o1.total
    ? ok(`COD thu hộ ĐÚNG tổng đơn (${o1.total})`) : bad(`pick_money sai: ${stub.lastCreateBody?.order?.pick_money} ≠ ${o1.total}`);
  stub.lastCreateBody?.order?.province === 'TP. Hồ Chí Minh' ? ok('địa chỉ nhận đẩy đúng sang hãng') : bad('địa chỉ sai', JSON.stringify(stub.lastCreateBody?.order));
  let od = (await a.get(`/orders/${o1.id}`)).json;
  od.status === 'shipped' && od.shipments?.[0]?.provider === 'ghtk' && od.shipments[0].status === 'in_transit'
    ? ok('đơn → shipped, vận đơn in_transit qua ghtk') : bad('trạng thái sai', JSON.stringify(od.shipments));
  const onHandAfter = Number((await owner.query(`SELECT on_hand FROM inventory_levels WHERE variant_id=$1`, [vid])).rows[0].on_hand);
  onHandAfter === onHandBefore - 2 ? ok('tồn kho CONSUME đúng (−2)') : bad(`tồn sai: ${onHandBefore}→${onHandAfter}`);
  r = await a.post(`/orders/${o1.id}/carrier-shipment`, TO);
  r.status === 409 ? ok('tạo lần 2 → 409 (không double-create)') : bad('double-create lọt!', r.raw);
  // Sau rà soát: is_freeship=1 (khách KHÔNG bị thu phí ship 2 lần) + ref ổn định theo đơn.
  stub.lastCreateBody?.order?.is_freeship === 1 ? ok('GHTK is_freeship=1 (shipper CHỈ thu pick_money)') : bad(`is_freeship sai: ${stub.lastCreateBody?.order?.is_freeship}`);
  stub.lastCreateBody?.order?.id === `NTG${o1.num}` ? ok('ref idempotent theo đơn (NTG<số đơn>)') : bad(`ref sai: ${stub.lastCreateBody?.order?.id}`);
  // Giao TAY khi vận đơn hãng đang chạy → 409 (một vận đơn sống mỗi đơn).
  r = await a.post(`/orders/${o1.id}/ship`, { tracking_number: 'TAY-1' });
  r.status === 409 ? ok('giao tay khi có vận đơn hãng → 409') : bad('giao tay lọt song song vận đơn hãng', r.raw);

  // ── 3. Worker poll → delivered + email ──────────────────────────────────────
  sect('3. Worker poll tracking → delivered');
  stub.ghtkStatus = 5; // hãng báo ĐÃ GIAO
  const wr = await fetch(`${WORKER}/internal/tracking-sweep`, { method: 'POST' });
  const wj = await wr.json();
  wj.delivered >= 1 ? ok(`sweep → delivered ${wj.delivered} vận đơn (checked ${wj.checked})`) : bad('sweep không giao được', JSON.stringify(wj));
  od = (await a.get(`/orders/${o1.id}`)).json;
  od.status === 'delivered' && od.shipments[0].status === 'delivered'
    ? ok('đơn → delivered + vận đơn delivered') : bad('delivered sai', `${od.status} ${od.shipments?.[0]?.status}`);
  const ob = await owner.query(
    `SELECT payload FROM outbox WHERE shop_id=$1 AND topic='order.status_changed' AND payload->>'status'='delivered' AND (payload->>'order_number')::int=$2`,
    [A.shopId, o1.num]);
  ob.rows.length === 1 && ob.rows[0].payload.tracking_number ? ok('outbox email "đã giao" kèm tracking cho khách') : bad('thiếu outbox delivered', String(ob.rows.length));

  // ── 4. Hãng lỗi → nhả claim, đơn còn nguyên, retry được ────────────────────
  sect('4. Hãng từ chối → không kẹt');
  const o2 = await placeCod(A, vid, null);
  await a.post(`/orders/${o2.id}/confirm`, {});
  stub.ghtkMode = 'fail';
  r = await a.post(`/orders/${o2.id}/carrier-shipment`, TO);
  r.status === 502 && /từ chối/.test(r.json?.error ?? '') ? ok('hãng lỗi → 502 kèm thông báo') : bad('lỗi hãng xử lý sai', r.raw);
  od = (await a.get(`/orders/${o2.id}`)).json;
  od.status === 'confirmed' && (od.shipments ?? []).length === 0
    ? ok('đơn CÒN NGUYÊN confirmed, claim đã nhả (không kẹt vận đơn ma)') : bad('claim kẹt', JSON.stringify(od.shipments));
  stub.ghtkMode = 'ok';
  r = await a.post(`/orders/${o2.id}/carrier-shipment`, TO);
  r.status === 200 ? ok('retry sau khi hãng ok → 200') : bad('retry lỗi', r.raw);

  // ── 5. Cô lập chéo shop + validation ────────────────────────────────────────
  sect('5. Cô lập + validation');
  const b = S(Bs);
  r = await b.post(`/orders/${o1.id}/carrier-shipment`, TO);
  r.status === 404 ? ok('shop B tạo vận đơn cho đơn shop A → 404') : bad('rò chéo shop', r.raw);
  const vidB = await setupProduct(Bs, 100000, 5);
  const oB = await placeCod(Bs, vidB, null);
  await S(Bs).post(`/orders/${oB.id}/confirm`, {});
  r = await b.post(`/orders/${oB.id}/carrier-shipment`, TO);
  r.status === 400 && /chưa kết nối/.test(r.json?.error ?? '') ? ok('shop B chưa kết nối → 400') : bad('thiếu guard kết nối', r.raw);
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: A.password }, cookie: A.cookie, origin: OA });
  r = await a.put('/shipping', { provider: 'ghn', token: 'ghn-token-abc', pickup: PICKUP });
  r.status === 400 && /ShopId/.test(r.json?.error ?? '') ? ok('GHN thiếu ShopId → 400') : bad('thiếu validate ghn_shop_id', r.raw);

  // ── 6. GHN adapter (đường thứ hai) ─────────────────────────────────────────
  sect('6. GHN adapter');
  r = await a.put('/shipping', { provider: 'ghn', token: 'ghn-token-abc', ghn_shop_id: '190001', pickup: PICKUP });
  r.status === 200 ? ok('đổi kết nối sang GHN → 200') : bad('đổi GHN lỗi', r.raw);
  const o3 = await placeCod(A, vid, null);
  await a.post(`/orders/${o3.id}/confirm`, {});
  r = await a.post(`/orders/${o3.id}/carrier-shipment`, TO);
  r.status === 200 && /^GHN/.test(r.json.tracking_number) && r.json.carrier_fee_vnd === 31000
    ? ok(`GHN tạo vận đơn → ${r.json.tracking_number} + phí 31.000`) : bad('GHN create lỗi', r.raw);

  // ── 7. Checkout: province ────────────────────────────────────────────────────
  sect('7. Checkout province');
  const addr = (await owner.query(`SELECT shipping_address FROM orders WHERE id=$1`, [o1.id])).rows[0].shipping_address;
  addr?.province === 'TP. Hồ Chí Minh' ? ok('đơn lưu shipping_address.province') : bad('thiếu province', JSON.stringify(addr));
  const cart = (await co(A.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 1 } })).cartToken;
  r = await co(A.host, 'POST', '/checkout', {
    body: { customer: { name: 'K', phone: phone() }, address: { line: 'x', province: 'Tỉnh Không Tồn Tại' }, payment_method: 'cod' },
    cartToken: cart, idemKey: `k-${uniq()}` });
  r.status === 400 ? ok('province lạ → 400') : bad('không validate province', r.raw);

  servers.ghn.close(); servers.ghtk.close();
  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
