/**
 * E2E admin-web (BFF) — GIAO MỘT PHẦN / TÁCH VẬN ĐƠN qua form no-JS (0080). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-split-ship.e2e.mjs
 *
 * Kiểm QUA BFF (HTTP, form-encoded), KHÔNG gọi thẳng seller:
 *  1. Đơn confirmed: card "Giao hàng (nhập tay)" có ô ship_qty + order_line_id ẩn, mặc định = còn lại.
 *  2. Giao 2/3 (subset) → 303, DB fulfillment='partial', shipped_qty=2, status='shipped'.
 *  3. Chi tiết: pill "Giao một phần" + "đã gửi 2/3" + card giao còn hiện (còn 1) + KHÔNG nút "Đã giao xong".
 *  4. Deliver khi partial → BFF 409 "còn kiện chưa gửi", đơn giữ shipped.
 *  5. Giao nốt 1 → fulfilled; chi tiết: pill "Đã gửi đủ" + nút "Đã giao xong" + card giao ẩn +
 *     card "Kiện hàng" liệt kê 2 kiện.
 *  6. Deliver → 303, đơn delivered.
 *  7. Gửi QUÁ số còn lại → BFF 409 "quá số", DB không đổi (shipped_qty giữ nguyên).
 *  8. CSRF: POST /ship thiếu Origin → 403, đơn giữ nguyên.
 * Harness mirror admin-order-edit.
 */
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic = 'user.invited' AND payload->>'to' = $1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${d}${X}`); };
const sect = (m) => console.log(`\n${B}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
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
async function adm(method, path, { cookie, origin, form } = {}) {
  const h = {};
  if (form !== undefined) h['content-type'] = 'application/x-www-form-urlencoded';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(ADMIN + path, { method, headers: h, redirect: 'manual', body: form !== undefined ? new URLSearchParams(form).toString() : undefined });
  const t = await r.text();
  return { status: r.status, location: r.headers.get('location'), sc: r.headers.getSetCookie(), body: t };
}
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
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;
const admLogin = async (email, password) => ck((await adm('POST', '/login', { origin: OADM, form: { email, password } })).sc);

async function makeStaff() {
  const email = `staff-${uniq()}@nentang.vn`, password = 'staff strong passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let cookie = await login(email, password);
  const r = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie, origin: OA });
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
  await owner.query(`UPDATE shops SET status='active', went_live_at=now() WHERE id=$1`, [shopId]);
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, slug, name: slug, host: `${slug}.nentang.vn`, email, password, cookie: await login(email, password) };
}
async function setupProduct(shop, price, stock) {
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/products`, {
    body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `S-${uniq()}`, price_vnd: price }] },
    cookie: shop.cookie, origin: OS,
  });
  const detail = await rq(SELLER, 'GET', `/shops/${shop.shopId}/products/${r.json.id}`, { cookie: shop.cookie });
  const vid = detail.json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${shop.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: shop.cookie, origin: OS });
  return { vid, title: detail.json.title };
}
async function placeOrder(shop, vid, qty) {
  const cart = (await co(shop.host, 'POST', '/cart/items', { body: { variant_id: vid, qty } })).cartToken;
  const r = await co(shop.host, 'POST', '/checkout', { body: { customer: { name: `Khách ${uniq()}`, phone: '0901234567' }, address: { line: 'HN' }, payment_method: 'cod' }, cartToken: cart, idemKey: `k-${uniq()}` });
  const orderNumber = r.json.order_number;
  const orderId = (await owner.query('SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2', [shop.shopId, orderNumber])).rows[0].id;
  const olId = (await owner.query('SELECT id FROM order_lines WHERE order_id=$1', [orderId])).rows[0].id;
  return { orderNumber, orderId, olId };
}
const ordFF = async (id) => (await owner.query('SELECT status, fulfillment_status FROM orders WHERE id=$1', [id])).rows[0];
const olShipped = async (id) => Number((await owner.query('SELECT shipped_qty FROM order_lines WHERE order_id=$1', [id])).rows[0].shipped_qty);

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `spl-${uniq()}`);
  const { vid } = await setupProduct(A, 100000, 20);
  const o1 = await placeOrder(A, vid, 3);    // tách 2+1
  const oOver = await placeOrder(A, vid, 2);  // thử gửi quá
  const cookieA = await admLogin(A.email, A.password);
  cookieA ? ok('dựng shop + SP (tồn 20) + 2 đơn, đăng nhập BFF') : bad('không lấy được cookie BFF');
  const durl = `/shops/${A.shopId}/orders/${o1.orderId}`;
  // confirm o1 + oOver qua BFF
  await adm('POST', `${durl}/confirm`, { cookie: cookieA, origin: OADM });
  await adm('POST', `/shops/${A.shopId}/orders/${oOver.orderId}/confirm`, { cookie: cookieA, origin: OADM });

  // ── 1. Card giao tay per-dòng ──────────────────────────────────────────────
  sect('1. Đơn confirmed: card "Giao hàng (nhập tay)" per-dòng');
  let r = await adm('GET', durl, { cookie: cookieA });
  const hasCard = r.body.includes('Giao hàng (nhập tay)');
  const hasQty = /name="ship_qty"[^>]*value="3"/.test(r.body) || /value="3"[^>]*name="ship_qty"/.test(r.body);
  const hasOl = r.body.includes(`name="order_line_id" value="${o1.olId}"`);
  r.status === 200 && hasCard && hasQty && hasOl
    ? ok('card giao tay: ô ship_qty mặc định=3 (còn lại) + order_line_id ẩn') : bad('card giao tay sai', `card=${hasCard} qty=${hasQty} ol=${hasOl}`);

  // ── 2. Giao 2/3 (subset) ───────────────────────────────────────────────────
  sect('2. Giao 2/3 qua BFF → partial');
  r = await adm('POST', `${durl}/ship`, { cookie: cookieA, origin: OADM, form: [['order_line_id', o1.olId], ['ship_qty', '2'], ['tracking_number', 'TAY-A'], ['carrier', '']] });
  let ff = await ordFF(o1.orderId);
  r.status === 303 && ff.status === 'shipped' && ff.fulfillment_status === 'partial' && await olShipped(o1.orderId) === 2
    ? ok('giao 2/3 → 303, DB shipped/partial, shipped_qty=2') : bad('giao subset sai', `${r.status} ${ff.status}/${ff.fulfillment_status} sh=${await olShipped(o1.orderId)}`);

  // ── 3. Chi tiết partial: pill + đã gửi + card còn + KHÔNG deliver ───────────
  sect('3. Chi tiết đơn partial');
  r = await adm('GET', durl, { cookie: cookieA });
  const pillPartial = r.body.includes('Giao một phần');
  const shippedNote = /đã gửi 2\/3/.test(r.body);
  const cardStill = r.body.includes('Giao hàng (nhập tay)') && (/name="ship_qty"[^>]*value="1"/.test(r.body) || /value="1"[^>]*name="ship_qty"/.test(r.body));
  const noDeliver = !r.body.includes('Đã giao xong');
  r.status === 200 && pillPartial && shippedNote && cardStill && noDeliver
    ? ok('pill "Giao một phần" + "đã gửi 2/3" + card giao còn (mặc định 1) + ẩn "Đã giao xong"')
    : bad('chi tiết partial sai', `pill=${pillPartial} note=${shippedNote} card=${cardStill} noDel=${noDeliver}`);

  // ── 4. Deliver khi partial → 409 ───────────────────────────────────────────
  sect('4. Deliver đơn partial → chặn');
  r = await adm('POST', `${durl}/deliver`, { cookie: cookieA, origin: OADM });
  ff = await ordFF(o1.orderId);
  r.status === 409 && /còn kiện|chưa gửi/.test(r.body) && ff.status === 'shipped'
    ? ok('deliver partial → 409 "còn kiện chưa gửi", đơn giữ shipped') : bad('deliver partial lọt', `${r.status} ${ff.status}`);

  // ── 5. Giao nốt 1 → fulfilled ──────────────────────────────────────────────
  sect('5. Giao nốt 1 → fulfilled + card "Kiện hàng"');
  r = await adm('POST', `${durl}/ship`, { cookie: cookieA, origin: OADM, form: [['order_line_id', o1.olId], ['ship_qty', '1'], ['tracking_number', 'TAY-B'], ['carrier', '']] });
  ff = await ordFF(o1.orderId);
  const twoShip = Number((await owner.query('SELECT count(*)::int n FROM shipments WHERE order_id=$1', [o1.orderId])).rows[0].n) === 2;
  r.status === 303 && ff.fulfillment_status === 'fulfilled' && await olShipped(o1.orderId) === 3 && twoShip
    ? ok('giao nốt → 303, fulfilled, shipped_qty=3, 2 kiện') : bad('giao nốt sai', `${ff.fulfillment_status} sh=${await olShipped(o1.orderId)} 2ship=${twoShip}`);
  r = await adm('GET', durl, { cookie: cookieA });
  const pillDone = r.body.includes('Đã gửi đủ');
  const hasDeliver = r.body.includes('Đã giao xong');
  const noShipCard = !r.body.includes('Giao hàng (nhập tay)');
  const shipmentsCard = r.body.includes('Kiện hàng / vận đơn') && r.body.includes('TAY-A') && r.body.includes('TAY-B');
  r.status === 200 && pillDone && hasDeliver && noShipCard && shipmentsCard
    ? ok('pill "Đã gửi đủ" + nút "Đã giao xong" + card giao ẩn + "Kiện hàng" liệt kê 2 vận đơn')
    : bad('chi tiết fulfilled sai', `done=${pillDone} del=${hasDeliver} noCard=${noShipCard} ships=${shipmentsCard}`);

  // ── 6. Deliver → delivered ─────────────────────────────────────────────────
  sect('6. Deliver khi fulfilled → delivered');
  r = await adm('POST', `${durl}/deliver`, { cookie: cookieA, origin: OADM });
  ff = await ordFF(o1.orderId);
  r.status === 303 && ff.status === 'delivered' ? ok('deliver fulfilled → 303, đơn delivered') : bad('deliver fulfilled lỗi', `${r.status} ${ff.status}`);

  // ── 7. Gửi QUÁ số còn lại → 409 + rollback ─────────────────────────────────
  sect('7. Gửi quá số còn lại → chặn');
  const ov = `/shops/${A.shopId}/orders/${oOver.orderId}`;
  r = await adm('POST', `${ov}/ship`, { cookie: cookieA, origin: OADM, form: [['order_line_id', oOver.olId], ['ship_qty', '5'], ['tracking_number', 'TAY-X'], ['carrier', '']] });
  r.status === 409 && /quá số/.test(r.body) && await olShipped(oOver.orderId) === 0 && (await ordFF(oOver.orderId)).status === 'confirmed'
    ? ok('gửi 5 (còn 2) → 409 "quá số", DB shipped_qty=0, đơn giữ confirmed') : bad('gửi quá lọt', `${r.status} sh=${await olShipped(oOver.orderId)}`);

  // ── 8. CSRF ────────────────────────────────────────────────────────────────
  sect('8. CSRF POST /ship thiếu Origin');
  r = await adm('POST', `${ov}/ship`, { cookie: cookieA, form: [['order_line_id', oOver.olId], ['ship_qty', '1'], ['tracking_number', 'NOP']] });
  r.status === 403 && await olShipped(oOver.orderId) === 0 ? ok('POST /ship không Origin → 403, đơn giữ nguyên') : bad('ship thiếu Origin lọt', `${r.status} sh=${await olShipped(oOver.orderId)}`);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((err) => { console.error('admin split-ship e2e lỗi:', err); process.exit(2); });
