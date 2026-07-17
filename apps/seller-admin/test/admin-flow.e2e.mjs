/**
 * End-to-end admin web (BFF). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-flow.e2e.mjs
 *
 * Kiểm: đăng nhập (có/không MFA), guard phiên, cô lập chéo shop, CSRF (POST cần
 * Origin), và luồng quản đơn qua form PRG (confirm → ship → deliver, cancel,
 * chuyển trạng thái sai). BFF chỉ forward — nhưng nó phải forward ĐÚNG cookie +
 * Origin và tự chặn cross-shop / CSRF trước khi chạm backend.
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
// Token lời mời KHÔNG còn trong API response (email hoá, 0073) — lấy từ outbox qua owner SQL (ADR-006: cùng tx với INSERT invitations nên đọc được ngay).
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic = 'user.invited' AND payload->>'to' = $1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${d}${X}`); };
const sect = (m) => console.log(`\n${B}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };

// JSON client cho auth/platform/seller.
async function rq(base, method, path, { body, cookie, origin } = {}) {
  const h = {};
  if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}

// Client cho ADMIN: POST là form (urlencoded), KHÔNG tự theo redirect (soi 303 + Set-Cookie).
async function adm(method, path, { cookie, origin, form } = {}) {
  const h = {};
  if (form !== undefined) h['content-type'] = 'application/x-www-form-urlencoded';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(ADMIN + path, { method, headers: h, redirect: 'manual', body: form !== undefined ? new URLSearchParams(form).toString() : undefined });
  const t = await r.text();
  return { status: r.status, location: r.headers.get('location'), sc: r.headers.getSetCookie(), body: t };
}

// Checkout: quản cookie __Host-cart tay, Host = domain shop (như checkout e2e).
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
  // A6: mfa/verify ROTATE token → lấy cookie mới
  cookie = ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).sc) ?? cookie;
  return cookie;
}

async function makeShopOwner(staffCookie, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, slug, name: slug, host: `${slug}.nentang.vn`, email, password, cookie: await login(email, password) };
}

// Bật MFA cho một owner đã có; trả về khoá TOTP để tính mã lúc đăng nhập.
async function enrollMfa(o) {
  const cookie = await login(o.email, o.password);
  const r = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie, origin: OA });
  const key = base32Decode(r.json.secret);
  const c = counterFor(Date.now());
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie, body: { code: totp(key, {}) }, origin: OA });
  // Chờ sang bước thời gian mới: lần verify sau KHÔNG được dùng lại counter của activate
  // (anti-replay của auth sẽ từ chối) — giống makeStaff.
  while (counterFor(Date.now()) <= c) await sleep(1000);
  return key;
}

async function setupProduct(shop, price, stock) {
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/products`, {
    body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `S-${uniq()}`, price_vnd: price }] },
    cookie: shop.cookie, origin: OS,
  });
  const detail = await rq(SELLER, 'GET', `/shops/${shop.shopId}/products/${r.json.id}`, { cookie: shop.cookie });
  const vid = detail.json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${shop.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: shop.cookie, origin: OS });
  return vid;
}

// Đặt 1 đơn COD (→ pending). Trả {orderNumber, orderId}.
async function placeOrder(shop, vid) {
  const cart = (await co(shop.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 1 } })).cartToken;
  const r = await co(shop.host, 'POST', '/checkout', { body: { customer: { name: `Khách ${uniq()}`, phone: '0901234567' }, address: { line: 'HN' }, payment_method: 'cod' }, cartToken: cart, idemKey: `k-${uniq()}` });
  const orderNumber = r.json.order_number;
  const orderId = (await owner.query('SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2', [shop.shopId, orderNumber])).rows[0].id;
  return { orderNumber, orderId };
}
const statusOf = async (shopId, orderId) => (await owner.query('SELECT status FROM orders WHERE shop_id=$1 AND id=$2', [shopId, orderId])).rows[0]?.status;
const payOf = async (shopId, orderId) => (await owner.query('SELECT payment_status FROM orders WHERE shop_id=$1 AND id=$2', [shopId, orderId])).rows[0]?.payment_status;

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `adm-${uniq()}`);
  const Bo = await makeShopOwner(staff, `oth-${uniq()}`);
  const vid = await setupProduct(A, 250000, 10);
  const o1 = await placeOrder(A, vid); // confirm → ship → deliver
  const o2 = await placeOrder(A, vid); // cancel
  const o3 = await placeOrder(A, vid); // chuyển sai + CSRF
  ok('dựng 2 shop + sản phẩm + 3 đơn pending');

  // ── 1. Đăng nhập KHÔNG MFA ─────────────────────────────────────────────────
  sect('1. Đăng nhập (không MFA)');
  let r = await adm('GET', '/', {});
  r.status === 303 && r.location === '/login' ? ok('ẩn danh GET / → 303 /login') : bad('không chặn ẩn danh', `${r.status} ${r.location}`);

  r = await adm('POST', '/login', { origin: OADM, form: { email: A.email, password: 'sai mật khẩu' } });
  r.status === 401 && /không đúng/.test(r.body) ? ok('sai mật khẩu → 401 kèm thông báo') : bad('sai mật khẩu không báo lỗi', String(r.status));

  r = await adm('POST', '/login', { origin: OADM, form: { email: A.email, password: A.password } });
  const cookieA = ck(r.sc);
  r.status === 303 && r.location === '/' && cookieA ? ok('đăng nhập đúng → 303 / + set cookie phiên') : bad('đăng nhập lỗi', `${r.status} ${r.location} ${!!cookieA}`);

  r = await adm('GET', '/', { cookie: cookieA });
  r.status === 200 && r.body.includes(A.name) ? ok('dashboard hiện cửa hàng của owner') : bad('dashboard thiếu shop', r.body.slice(0, 200));

  r = await adm('POST', '/login', { form: { email: A.email, password: A.password } }); // KHÔNG Origin
  r.status === 403 ? ok('POST /login không Origin → 403 (CSRF)') : bad('login thiếu Origin không bị chặn', String(r.status));

  // ── 2. Danh sách + chi tiết đơn ────────────────────────────────────────────
  sect('2. Xem đơn');
  r = await adm('GET', `/shops/${A.shopId}/orders`, { cookie: cookieA });
  r.status === 200 && r.body.includes(`#${o1.orderNumber}`) ? ok('danh sách đơn hiện đơn vừa tạo') : bad('danh sách thiếu đơn', r.body.slice(0, 200));

  r = await adm('GET', `/shops/${A.shopId}/orders/${o1.orderId}`, { cookie: cookieA });
  r.status === 200 && r.body.includes('Xác nhận đơn') && r.body.includes('250.000') ? ok('chi tiết đơn: nút xác nhận + tổng tiền') : bad('chi tiết đơn sai', r.body.slice(0, 200));

  r = await adm('GET', `/shops/${Bo.shopId}/orders`, { cookie: cookieA });
  r.status === 403 ? ok('owner A xem đơn shop B → 403 (cô lập chéo shop)') : bad('rò đơn chéo shop', String(r.status));

  // ── 3. Quản đơn: confirm → ship → deliver (PRG) ────────────────────────────
  sect('3. Vòng đời đơn (form PRG)');
  r = await adm('POST', `/shops/${A.shopId}/orders/${o1.orderId}/confirm`, { cookie: cookieA, origin: OADM });
  (r.status === 303 && await statusOf(A.shopId, o1.orderId) === 'confirmed') ? ok('confirm → 303 + DB confirmed') : bad('confirm lỗi', `${r.status} ${await statusOf(A.shopId, o1.orderId)}`);

  r = await adm('POST', `/shops/${A.shopId}/orders/${o1.orderId}/ship`, { cookie: cookieA, origin: OADM, form: { tracking_number: `VN${uniq()}`, carrier: 'GHN' } });
  (r.status === 303 && await statusOf(A.shopId, o1.orderId) === 'shipped') ? ok('ship (kèm mã VĐ) → 303 + DB shipped') : bad('ship lỗi', `${r.status} ${await statusOf(A.shopId, o1.orderId)}`);

  r = await adm('POST', `/shops/${A.shopId}/orders/${o1.orderId}/deliver`, { cookie: cookieA, origin: OADM });
  (r.status === 303 && await statusOf(A.shopId, o1.orderId) === 'delivered') ? ok('deliver → 303 + DB delivered') : bad('deliver lỗi', `${r.status} ${await statusOf(A.shopId, o1.orderId)}`);

  // COD thu tiền: đơn o1 đã giao nhưng chưa trả (COD) → nút "Đã nhận tiền" + mark-paid qua BFF.
  r = await adm('GET', `/shops/${A.shopId}/orders/${o1.orderId}`, { cookie: cookieA });
  r.body.includes('Đã nhận tiền') ? ok('đơn COD chưa trả: hiện nút "Đã nhận tiền"') : bad('thiếu nút mark-paid COD', r.body.slice(0, 200));
  r = await adm('POST', `/shops/${A.shopId}/orders/${o1.orderId}/mark-paid`, { cookie: cookieA, origin: OADM });
  (r.status === 303 && await payOf(A.shopId, o1.orderId) === 'paid') ? ok('mark-paid → 303 + DB paid') : bad('mark-paid BFF lỗi', `${r.status} ${await payOf(A.shopId, o1.orderId)}`);
  r = await adm('GET', `/shops/${A.shopId}/orders/${o1.orderId}`, { cookie: cookieA });
  !r.body.includes('Đã nhận tiền') ? ok('đơn đã trả: ẩn nút "Đã nhận tiền"') : bad('nút mark-paid vẫn hiện sau khi trả');

  r = await adm('POST', `/shops/${A.shopId}/orders/${o2.orderId}/cancel`, { cookie: cookieA, origin: OADM });
  (r.status === 303 && await statusOf(A.shopId, o2.orderId) === 'cancelled') ? ok('cancel → 303 + DB cancelled') : bad('cancel lỗi', `${r.status} ${await statusOf(A.shopId, o2.orderId)}`);

  // Chuyển trạng thái SAI: deliver một đơn còn pending → backend 409 → BFF render lại kèm lỗi.
  r = await adm('POST', `/shops/${A.shopId}/orders/${o3.orderId}/deliver`, { cookie: cookieA, origin: OADM });
  (r.status === 409 && /không thể/.test(r.body) && await statusOf(A.shopId, o3.orderId) === 'pending') ? ok('deliver đơn pending → 409 + báo lỗi, không đổi trạng thái') : bad('chuyển sai không bị chặn', `${r.status} ${await statusOf(A.shopId, o3.orderId)}`);

  // ── 4. CSRF trên thao tác đổi trạng thái ───────────────────────────────────
  sect('4. CSRF');
  r = await adm('POST', `/shops/${A.shopId}/orders/${o3.orderId}/confirm`, { cookie: cookieA }); // KHÔNG Origin
  (r.status === 403 && await statusOf(A.shopId, o3.orderId) === 'pending') ? ok('confirm không Origin → 403, đơn giữ nguyên') : bad('confirm thiếu Origin không bị chặn', String(r.status));

  // ── 5. Đăng xuất ───────────────────────────────────────────────────────────
  sect('5. Đăng xuất');
  r = await adm('POST', '/logout', { cookie: cookieA, origin: OADM });
  const cleared = (r.sc ?? []).some((c) => /__Host-session=;/.test(c) && /Max-Age=0/i.test(c));
  r.status === 303 && r.location === '/login' && cleared ? ok('logout → 303 /login + xoá cookie') : bad('logout lỗi', `${r.status} ${r.location} cleared=${cleared}`);
  r = await adm('GET', '/', { cookie: cookieA }); // token đã bị thu hồi phía server
  r.status === 303 && r.location === '/login' ? ok('phiên đã thu hồi → GET / lại về /login') : bad('phiên vẫn sống sau logout', `${r.status} ${r.location}`);

  // ── 6. Đăng nhập CÓ MFA ────────────────────────────────────────────────────
  sect('6. Đăng nhập có MFA (step-up)');
  const key = await enrollMfa(A);
  r = await adm('POST', '/login', { origin: OADM, form: { email: A.email, password: A.password } });
  const half = ck(r.sc);
  r.status === 303 && r.location === '/mfa' && half ? ok('mật khẩu đúng + MFA bật → 303 /mfa (phiên nửa vời)') : bad('không chuyển sang MFA', `${r.status} ${r.location}`);

  r = await adm('GET', '/', { cookie: half });
  r.status === 303 && r.location === '/mfa' ? ok('phiên nửa vời GET / → ép về /mfa') : bad('phiên nửa vời lọt vào dashboard', `${r.status} ${r.location}`);

  r = await adm('POST', '/mfa', { cookie: half, origin: OADM, form: { code: '000000' } });
  r.status === 401 && /không đúng/.test(r.body) ? ok('mã MFA sai → 401 kèm thông báo') : bad('mã sai không báo lỗi', String(r.status));

  r = await adm('POST', '/mfa', { cookie: half, origin: OADM, form: { code: totp(key, {}) } });
  const stepped = ck(r.sc) ?? half;
  r.status === 303 && r.location === '/' ? ok('mã MFA đúng → 303 / (phiên đầy đủ)') : bad('verify MFA lỗi', `${r.status} ${r.location}`);

  r = await adm('GET', '/', { cookie: stepped });
  r.status === 200 && r.body.includes(A.name) ? ok('sau MFA: vào được dashboard') : bad('sau MFA vẫn không vào được', String(r.status));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('admin e2e lỗi:', err); process.exit(2); });
