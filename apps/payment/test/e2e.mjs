/**
 * End-to-end thanh toán QR (đối soát webhook). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/payment/test/e2e.mjs
 *
 * Kiểm bất biến ADR-007:
 *   - Checkout QR sinh VietQR + payment_ref; đơn ban đầu UNPAID.
 *   - CHỈ webhook đúng API key + đủ tiền mới đặt PAID.
 *   - Sai key → 401, đơn không đổi. Thiếu tiền → underpaid, không paid.
 *   - Replay (trùng provider_event_id) → idempotent, không xử lý lại.
 *   - Không có đường nào cho trình duyệt tự đánh dấu paid.
 */

import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const PAYMENT = process.env.PAYMENT_URL ?? 'http://payment:3070';
const WORKER = process.env.WORKER_URL ?? 'http://worker:3080';
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const KEY = process.env.SEPAY_WEBHOOK_KEY ?? 'dev-sepay-secret-key-12345';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
// Token lời mời KHÔNG còn trong API response (email hoá, 0073) — lấy từ outbox qua owner SQL (ADR-006: cùng tx với INSERT invitations nên đọc được ngay).
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic = 'user.invited' AND payload->>'to' = $1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${d}${X}`); };
const sect = (m) => console.log(`\n${B}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const phone = () => '09' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'); // SĐT numeric duy nhất (tránh trần per-phone)
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
// POST form urlencoded tới checkout (cho endpoint không-JS như /cart/coupon).
function coForm(host, path, formObj, cartToken) {
  const data = new URLSearchParams(formObj).toString();
  return new Promise((resolve, reject) => {
    const headers = { host, origin: `https://${host}`, 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(data) };
    if (cartToken) headers['cookie'] = `__Host-cart=${cartToken}`;
    const req = http.request({ hostname: CO.hostname, port: CO.port, path, method: 'POST', headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, raw: b, location: res.headers.location }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

// Webhook SePay: kèm Authorization: Apikey <key>. Mặc định tài khoản nhận ĐÚNG của shop.
const ACC = '0011002345678';
async function webhook(body, { key = KEY } = {}) {
  const full = { accountNumber: ACC, ...body }; // body override được (test tài khoản sai)
  const r = await fetch(`${PAYMENT}/webhooks/sepay`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Apikey ${key}` }, body: JSON.stringify(full),
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, raw: t };
}

// Webhook PER-SHOP: token = API Key gửi qua header Authorization (URL cố định /webhooks/sepay).
async function webhookPerShop(token, body) {
  const full = { accountNumber: ACC, ...body };
  const r = await fetch(`${PAYMENT}/webhooks/sepay`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Apikey ${token}` }, body: JSON.stringify(full),
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, raw: t };
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
  // A6: mfa/verify ROTATE token → phải lấy cookie MỚI (token nửa-vời cũ đã bị thu hồi).
  cookie = ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).sc) ?? cookie;
  return cookie;
}
async function makeShopOwner(staffCookie, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
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
// Đặt đơn QR, trả {orderNum, ref, total, qr, lookupToken}.
async function placeQrOrder(shop, vid, qty = 1, email = null) {
  const cart = (await co(shop.host, 'POST', '/cart/items', { body: { variant_id: vid, qty } })).cartToken;
  const customer = { name: 'Khach', phone: phone(), ...(email ? { email } : {}) };
  const r = await co(shop.host, 'POST', '/checkout', { body: { customer, payment_method: 'qr' }, cartToken: cart, idemKey: `k-${uniq()}` });
  return { orderNum: r.json?.order_number, ref: r.json?.payment_ref, total: r.json?.total_vnd, qr: r.json?.qr_string, lookupToken: r.json?.lookup_token, status: r.status, raw: r.raw };
}
const orderStatus = (host, num, token) => co(host, 'GET', `/checkout/order?number=${num}&token=${encodeURIComponent(token)}`);

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `pay-${uniq()}`);
  const vid = await setupProduct(A, 250000, 40); // đủ tồn cho nhiều đơn (webhook + coupon)

  // ── 1. Cấu hình thanh toán (step-up) ───────────────────────────────────────
  sect('1. Cấu hình thanh toán QR (step-up)');
  let r = await rq(SELLER, 'PUT', `/shops/${A.shopId}/payment-config`, { body: { bank_bin: '970415', account_number: '0011002345678', account_name: 'SHOP A', qr_enabled: true }, cookie: A.cookie, origin: OS });
  r.status === 403 && r.json.step_up_required ? ok('đặt cấu hình khi chưa step-up → 403') : bad('cấu hình không cần step-up', r.raw);
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: A.password }, cookie: A.cookie, origin: OA });
  r = await rq(SELLER, 'PUT', `/shops/${A.shopId}/payment-config`, { body: { bank_bin: '970415', account_number: '0011002345678', account_name: 'SHOP A', qr_enabled: true }, cookie: A.cookie, origin: OS });
  r.status === 200 ? ok('sau step-up: đặt cấu hình QR → 200') : bad('cấu hình lỗi', r.raw);

  // ── 2. Checkout QR ─────────────────────────────────────────────────────────
  sect('2. Checkout QR');
  const o1 = await placeQrOrder(A, vid);
  o1.status === 201 && o1.ref?.startsWith('NTG') && o1.qr ? ok(`đơn QR #${o1.orderNum}, ref ${o1.ref}, có chuỗi VietQR`) : bad('checkout qr lỗi', o1.raw);
  o1.qr?.includes('970415') && o1.qr?.includes(o1.ref) && o1.qr?.includes(String(o1.total))
    ? ok('VietQR chứa BIN ngân hàng + mã đối soát + số tiền') : bad('VietQR thiếu thông tin', o1.qr);
  r = await orderStatus(A.host, o1.orderNum, o1.lookupToken);
  r.json?.payment_status === 'unpaid' ? ok('đơn QR ban đầu UNPAID (chờ chuyển khoản)') : bad('đơn qr không unpaid', r.raw);

  // ── 3. Webhook đúng → paid ─────────────────────────────────────────────────
  sect('3. Webhook đủ tiền → paid');
  r = await webhook({ id: `evt-${uniq()}`, transferType: 'in', transferAmount: o1.total, content: `chuyen khoan ${o1.ref}`, transactionDate: '2026-07-11 10:00:00' });
  const paidEvt = r; // giữ để test replay
  r.status === 200 && r.json.paid === true ? ok('webhook đúng key + đủ tiền → paid') : bad('webhook không đặt paid', r.raw);
  r = await orderStatus(A.host, o1.orderNum, o1.lookupToken);
  r.json?.payment_status === 'paid' && r.json?.status === 'confirmed' ? ok('đơn → paid + confirmed') : bad('đơn chưa paid', r.raw);

  // ── 4. Sai API key → 401, không đụng đơn ───────────────────────────────────
  sect('4. Sai API key');
  const o2 = await placeQrOrder(A, vid);
  r = await webhook({ id: `evt-${uniq()}`, transferType: 'in', transferAmount: o2.total, content: `ck ${o2.ref}` }, { key: 'sai-key' });
  r.status === 401 ? ok('webhook sai API key → 401') : bad('sai key vẫn xử lý', r.raw);
  r = await orderStatus(A.host, o2.orderNum, o2.lookupToken);
  r.json?.payment_status === 'unpaid' ? ok('đơn vẫn UNPAID sau webhook sai key') : bad('sai key vẫn đặt paid', r.raw);

  // ── 4b. Tiền vào TÀI KHOẢN KHÁC → không paid (chống "đánh dấu hộ") ──────────
  sect('4b. Sai tài khoản nhận');
  r = await webhook({ id: `evt-${uniq()}`, transferType: 'in', transferAmount: o2.total, content: `ck ${o2.ref}`, accountNumber: '9999999999' });
  r.status === 200 && r.json.matched === false && r.json.reason === 'account_mismatch'
    ? ok('đủ tiền + đúng ref nhưng SAI tài khoản nhận → không paid (account_mismatch)') : bad('tiền vào tài khoản khác vẫn paid — LỖ HỔNG', r.raw);
  r = await orderStatus(A.host, o2.orderNum, o2.lookupToken);
  r.json?.payment_status === 'unpaid' ? ok('đơn vẫn UNPAID khi tiền vào tài khoản khác') : bad('sai tài khoản vẫn đặt paid', r.raw);

  // ── 5. Thiếu tiền → underpaid, không paid ──────────────────────────────────
  sect('5. Thiếu tiền');
  r = await webhook({ id: `evt-${uniq()}`, transferType: 'in', transferAmount: o2.total - 1000, content: `ck ${o2.ref}`, transactionDate: '2026-07-11 10:05:00' });
  r.status === 200 && r.json.paid === false ? ok('chuyển THIẾU 1000đ → không paid (underpaid)') : bad('thiếu tiền vẫn paid', r.raw);
  r = await orderStatus(A.host, o2.orderNum, o2.lookupToken);
  r.json?.payment_status === 'unpaid' ? ok('đơn vẫn UNPAID khi thiếu tiền') : bad('thiếu tiền đặt paid', r.raw);
  // Đúng đủ tiền sau đó → paid.
  r = await webhook({ id: `evt-${uniq()}`, transferType: 'in', transferAmount: o2.total, content: `ck ${o2.ref}`, transactionDate: '2026-07-11 10:06:00' });
  r.json.paid === true ? ok('sau đó chuyển ĐỦ → paid') : bad('đủ tiền không paid', r.raw);

  // ── 5b. GỘP nhiều giao dịch → đủ tổng thì paid + phát order.paid ────────────
  sect('5b. Gộp nhiều giao dịch (partial payments)');
  const email5b = `buyer5b-${uniq()}@test.local`; // duy nhất mỗi lần chạy → đếm order.paid chính xác
  const o3 = await placeQrOrder(A, vid, 1, email5b);
  const half = Math.floor(o3.total / 2);
  r = await webhook({ id: `evt-${uniq()}`, transferType: 'in', transferAmount: half, content: `ck ${o3.ref}`, transactionDate: '2026-07-11 12:00:00' });
  r.json.paid === false ? ok('lần 1 (nửa tiền) → CHƯA paid') : bad('nửa tiền đã paid', r.raw);
  r = await webhook({ id: `evt-${uniq()}`, transferType: 'in', transferAmount: o3.total - half, content: `ck ${o3.ref}`, transactionDate: '2026-07-11 12:01:00' });
  r.json.paid === true && r.json.cumulative === o3.total ? ok(`lần 2 (phần còn lại) → GỘP đủ ${o3.total} → paid`) : bad('gộp không paid', r.raw);
  r = await orderStatus(A.host, o3.orderNum, o3.lookupToken);
  r.json?.payment_status === 'paid' ? ok('đơn → paid sau khi gộp đủ tổng') : bad('gộp không đặt paid', r.raw);
  // Đếm theo EMAIL (duy nhất mỗi lần chạy) — order_number chỉ duy nhất trong 1 shop,
  // outbox tích luỹ qua nhiều lần chạy nên đếm theo order_number sẽ đụng.
  const paidBox = await owner.query(`SELECT count(*)::int n FROM outbox WHERE topic='order.paid' AND payload->>'to' = $1`, [email5b]);
  paidBox.rows[0].n === 1 ? ok('phát MỘT sự kiện order.paid (email biên nhận)') : bad(`có ${paidBox.rows[0].n} order.paid`, '');

  // ── 6. Replay (trùng provider_event_id) ────────────────────────────────────
  sect('6. Chống replay');
  const dupId = 'dup-fixed-id-' + uniq();
  await webhook({ id: dupId, transferType: 'in', transferAmount: o1.total, content: `ck ${o1.ref}`, transactionDate: '2026-07-11 11:00:00' });
  r = await webhook({ id: dupId, transferType: 'in', transferAmount: o1.total, content: `ck ${o1.ref}`, transactionDate: '2026-07-11 11:00:00' });
  r.json?.duplicate === true ? ok('gửi lại cùng provider_event_id → duplicate (idempotent)') : bad('replay không bị chặn', r.raw);
  const txnCnt = await owner.query(`SELECT count(*)::int n FROM payment_transactions WHERE provider='sepay' AND provider_event_id=$1`, [dupId]);
  txnCnt.rows[0].n === 1 ? ok('chỉ MỘT giao dịch trong sổ cho event id đó') : bad(`có ${txnCnt.rows[0].n} giao dịch trùng`);

  // ── 7. Ref không tồn tại ───────────────────────────────────────────────────
  sect('7. Nội dung không khớp đơn');
  r = await webhook({ id: `evt-${uniq()}`, transferType: 'in', transferAmount: 100000, content: 'noi dung khong co ma' });
  r.status === 200 && r.json.matched === false ? ok('nội dung không có mã đối soát → matched:false') : bad('ref lạ xử lý sai', r.raw);

  // ── 8. QR khi shop chưa cấu hình ───────────────────────────────────────────
  sect('8. QR chưa bật');
  const Bs = await makeShopOwner(staff, `payb-${uniq()}`);
  const vidB = await setupProduct(Bs, 50000, 5);
  const ob = await placeQrOrder(Bs, vidB);
  ob.status === 400 ? ok('checkout QR khi shop chưa bật thanh toán → 400') : bad('cho checkout qr không cấu hình', ob.raw);

  // ── 9. SePay PER-SHOP (mỗi shop token riêng, tiền vào thẳng tài khoản shop) ─────
  sect('9. SePay PER-SHOP');
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: A.password }, cookie: A.cookie, origin: OA });
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/payment/sepay/enable`, { cookie: A.cookie, origin: OS });
  const tokenA = r.json?.token;
  r.status === 200 && tokenA && r.json.api_key === tokenA && r.json.webhook_url?.endsWith('/webhooks/sepay') ? ok('bật SePay → API key (token) + URL webhook cố định (hiện 1 lần)') : bad('bật sepay lỗi', r.raw);

  const o9 = await placeQrOrder(A, vid, 1, `b9-${uniq()}@t.local`);
  r = await webhookPerShop(tokenA, { id: `evt-${uniq()}`, transferType: 'in', transferAmount: o9.total, content: `ck ${o9.ref}`, transactionDate: '2026-07-12 09:00:00' });
  r.status === 200 && r.json.paid === true ? ok('webhook per-shop (token đúng, đủ tiền) → paid') : bad('per-shop không paid', r.raw);

  r = await webhookPerShop('deadbeef'.repeat(6), { id: `evt-${uniq()}`, transferType: 'in', transferAmount: o9.total, content: `ck ${o9.ref}` });
  r.status === 401 ? ok('token sai → 401 (không đụng đơn)') : bad('token sai vẫn xử lý', r.raw);

  const noRefId = `evt-noref-${uniq()}`;
  r = await webhookPerShop(tokenA, { id: noRefId, transferType: 'in', transferAmount: 123000, content: 'chuyen tien khong co ma dinh danh' });
  r.status === 200 && r.json.reason === 'no_ref' ? ok('không có mã ref → matched:false (no_ref)') : bad('no_ref sai', r.raw);
  let q = await owner.query(`SELECT reason FROM unmatched_transfers WHERE shop_id=$1 AND provider_event_id=$2`, [A.shopId, noRefId]);
  q.rows[0]?.reason === 'no_ref' ? ok('giao dịch chưa khớp được GHI vào hàng đợi (no_ref)') : bad('không ghi hàng đợi', JSON.stringify(q.rows));

  // CÔ LẬP CHÉO SHOP: ref của shop B post vào token shop A → order_not_found, đơn B không đổi.
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: Bs.password }, cookie: Bs.cookie, origin: OA });
  await rq(SELLER, 'PUT', `/shops/${Bs.shopId}/payment-config`, { body: { bank_bin: '970415', account_number: '0022003456789', account_name: 'SHOP B', qr_enabled: true }, cookie: Bs.cookie, origin: OS });
  const oB = await placeQrOrder(Bs, vidB);
  r = await webhookPerShop(tokenA, { id: `evt-${uniq()}`, transferType: 'in', transferAmount: oB.total, content: `ck ${oB.ref}`, accountNumber: '0022003456789' });
  r.status === 200 && r.json.matched === false && r.json.reason === 'order_not_found' ? ok('ref shop B gửi vào token shop A → order_not_found (cô lập chéo shop)') : bad('CẤN CHÉO SHOP — LỖ HỔNG', r.raw);
  r = await orderStatus(Bs.host, oB.orderNum, oB.lookupToken);
  r.json?.payment_status === 'unpaid' ? ok('đơn shop B vẫn UNPAID (token shop A không đụng tới)') : bad('đơn B bị đánh dấu hộ', r.raw);

  // Sai tài khoản nhận trên đường per-shop → account_mismatch + vào hàng đợi.
  const oam = await placeQrOrder(A, vid);
  const amId = `evt-am-${uniq()}`;
  r = await webhookPerShop(tokenA, { id: amId, transferType: 'in', transferAmount: oam.total, content: `ck ${oam.ref}`, accountNumber: '9999999999' });
  r.status === 200 && r.json.reason === 'account_mismatch' ? ok('sai tài khoản nhận (per-shop) → account_mismatch, không paid') : bad('account_mismatch per-shop sai', r.raw);
  q = await owner.query(`SELECT reason FROM unmatched_transfers WHERE shop_id=$1 AND provider_event_id=$2`, [A.shopId, amId]);
  q.rows[0]?.reason === 'account_mismatch' ? ok('giao dịch sai tài khoản GHI vào hàng đợi') : bad('account_mismatch không ghi hàng đợi');

  // #1: tiền vào đơn ĐÃ HUỶ/hết hạn → KHÔNG sống lại (chống oversell) → hàng đợi order_not_live.
  const oDead = await placeQrOrder(A, vid);
  await owner.query(`UPDATE orders SET status='cancelled' WHERE payment_ref=$1`, [oDead.ref]); // mô phỏng sweep hết hạn
  const deadId = `evt-dead-${uniq()}`;
  r = await webhookPerShop(tokenA, { id: deadId, transferType: 'in', transferAmount: oDead.total, content: `ck ${oDead.ref}`, transactionDate: '2026-07-12 10:00:00' });
  r.status === 200 && r.json.reason === 'order_not_live' && r.json.paid === false ? ok('tiền vào đơn đã huỷ → order_not_live, KHÔNG sống lại (chống oversell)') : bad('đơn huỷ bị sống lại — LỖ HỔNG', r.raw);
  r = await orderStatus(A.host, oDead.orderNum, oDead.lookupToken);
  r.json?.status === 'cancelled' && r.json?.payment_status !== 'paid' ? ok('đơn vẫn HUỶ, không bị confirm/paid') : bad('đơn huỷ bị confirm/paid', r.raw);
  q = await owner.query(`SELECT reason FROM unmatched_transfers WHERE shop_id=$1 AND provider_event_id=$2`, [A.shopId, deadId]);
  q.rows[0]?.reason === 'order_not_live' ? ok('giao dịch vào đơn huỷ GHI vào hàng đợi (order_not_live)') : bad('order_not_live không ghi hàng đợi');

  // #2: đơn ĐÃ XÁC NHẬN (chủ shop bấm "Xác nhận đơn" trước khi tiền về) VẪN nhận được tiền.
  // Đây là ca thật nhất của QR: shop duyệt đơn mới mỗi sáng, khách chuyển khoản buổi trưa.
  // Trước đây guard là `status !== 'pending'` nên confirmed bị coi như đơn chết → tiền rơi
  // vào hàng đợi, đơn kẹt unpaid vĩnh viễn. KHÁC ca huỷ ở trên: huỷ = tồn đã trả, phải chặn.
  const oConf = await placeQrOrder(A, vid);
  await owner.query(`UPDATE orders SET status='confirmed' WHERE payment_ref=$1`, [oConf.ref]);
  r = await webhookPerShop(tokenA, { id: `evt-conf-${uniq()}`, transferType: 'in', transferAmount: oConf.total, content: `ck ${oConf.ref}` });
  r.status === 200 && r.json.paid === true ? ok('tiền vào đơn ĐÃ XÁC NHẬN → vẫn ghi nhận paid (không nuốt tiền)') : bad('đơn confirmed bị từ chối tiền — MẤT TIỀN', r.raw);
  r = await orderStatus(A.host, oConf.orderNum, oConf.lookupToken);
  r.json?.payment_status === 'paid' && r.json?.status === 'confirmed' ? ok('đơn confirmed + paid, KHÔNG bị đẩy lùi trạng thái') : bad('trạng thái đơn sai sau khi trả', r.raw);

  // #3: đơn ĐANG GIAO cũng nhận được tiền, và status KHÔNG bị kéo lùi về confirmed.
  const oShip = await placeQrOrder(A, vid);
  await owner.query(`UPDATE orders SET status='shipped' WHERE payment_ref=$1`, [oShip.ref]);
  r = await webhookPerShop(tokenA, { id: `evt-ship-${uniq()}`, transferType: 'in', transferAmount: oShip.total, content: `ck ${oShip.ref}` });
  q = await owner.query(`SELECT status, payment_status, amount_paid_vnd FROM orders WHERE payment_ref=$1`, [oShip.ref]);
  q.rows[0]?.payment_status === 'paid' && q.rows[0]?.status === 'shipped'
    ? ok('đơn đang GIAO nhận tiền → paid, status GIỮ shipped (không đi lùi)') : bad('status bị kéo lùi hoặc không paid', JSON.stringify(q.rows[0]));

  // #4: amount_paid_vnd ghi SỐ THẬT đã nhận, không suy đoán từ total. Khách chuyển 2 lần,
  // lần cuối THỪA → cột phải là tổng thực nhận, vì mọi phép tính hoàn tiền đọc cột này.
  const oOver = await placeQrOrder(A, vid);
  const nua = Math.floor(oOver.total / 2);
  await webhookPerShop(tokenA, { id: `evt-ov1-${uniq()}`, transferType: 'in', transferAmount: nua, content: `ck ${oOver.ref}` });
  await webhookPerShop(tokenA, { id: `evt-ov2-${uniq()}`, transferType: 'in', transferAmount: oOver.total, content: `ck ${oOver.ref}` });
  q = await owner.query(`SELECT payment_status, amount_paid_vnd, total_vnd FROM orders WHERE payment_ref=$1`, [oOver.ref]);
  Number(q.rows[0]?.amount_paid_vnd) === nua + oOver.total && Number(q.rows[0]?.amount_paid_vnd) > Number(q.rows[0]?.total_vnd)
    ? ok(`amount_paid_vnd = tiền THỰC nhận ${nua + oOver.total}đ (thừa so với tổng ${oOver.total}đ), không phải total`)
    : bad('amount_paid_vnd không ghi số thực nhận', JSON.stringify(q.rows[0]));

  // Tắt SePay → token cũ bị thu hồi (401).
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: A.password }, cookie: A.cookie, origin: OA });
  await rq(SELLER, 'POST', `/shops/${A.shopId}/payment/sepay/disable`, { cookie: A.cookie, origin: OS });
  const od = await placeQrOrder(A, vid);
  r = await webhookPerShop(tokenA, { id: `evt-${uniq()}`, transferType: 'in', transferAmount: od.total, content: `ck ${od.ref}` });
  r.status === 401 ? ok('sau khi TẮT SePay: token cũ → 401 (thu hồi)') : bad('token vẫn dùng sau disable', r.raw);
  r = await orderStatus(A.host, od.orderNum, od.lookupToken);
  r.json?.payment_status === 'unpaid' ? ok('đơn vẫn UNPAID sau webhook với token đã thu hồi') : bad('token thu hồi vẫn paid', r.raw);

  // ── 10. Mã giảm giá (coupon) — đụng đường tiền: total giảm → QR khớp ───────────
  sect('10. Mã giảm giá (coupon)');
  let cr = await rq(SELLER, 'POST', `/shops/${A.shopId}/coupons`, { body: { code: 'GIAM10', kind: 'percent', value: 10 }, cookie: A.cookie, origin: OS });
  cr.status === 201 ? ok('tạo coupon GIAM10 (giảm 10%)') : bad('tạo coupon lỗi', cr.raw);
  cr = await rq(SELLER, 'POST', `/shops/${A.shopId}/coupons`, { body: { code: 'GIAM10', kind: 'fixed', value: 5000 }, cookie: A.cookie, origin: OS });
  cr.status === 409 ? ok('trùng mã → 409') : bad('mã trùng không chặn', cr.raw);

  // Giỏ 2×250k=500k, áp mã (nhập thường → server viết HOA), checkout QR.
  const cart10 = (await co(A.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 2 } })).cartToken;
  const cf = await coForm(A.host, '/cart/coupon', { code: 'giam10' }, cart10);
  cf.status === 303 ? ok('áp mã → 303 (PRG về giỏ)') : bad('áp mã lỗi', String(cf.status));
  let oco = await co(A.host, 'POST', '/checkout', { body: { customer: { name: 'K', phone: phone() }, payment_method: 'qr' }, cartToken: cart10, idemKey: `k-${uniq()}` });
  oco.json?.discount_vnd === 50000 && oco.json?.coupon_code === 'GIAM10' && oco.json?.total_vnd === 500000 - 50000 + oco.json.shipping_vnd
    ? ok(`đơn giảm 50.000đ, tổng=${oco.json.total_vnd} (đã trừ giảm + ship)`) : bad('đơn không giảm đúng', JSON.stringify(oco.json));
  oco.json?.qr_string?.includes(String(oco.json.total_vnd)) ? ok('VietQR mang SỐ TIỀN ĐÃ GIẢM (đường tiền khớp)') : bad('QR không khớp tổng đã giảm', oco.json?.qr_string);
  let uc = await owner.query(`SELECT used_count FROM coupons WHERE shop_id=$1 AND code='GIAM10'`, [A.shopId]);
  uc.rows[0]?.used_count === 1 ? ok('used_count tăng 1 sau khi đặt đơn') : bad(`used_count=${uc.rows[0]?.used_count}`);

  // Mã sai → không giảm.
  const cbad = (await co(A.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 1 } })).cartToken;
  await coForm(A.host, '/cart/coupon', { code: 'KHONGCOMA' }, cbad);
  oco = await co(A.host, 'POST', '/checkout', { body: { customer: { name: 'K', phone: phone() }, payment_method: 'cod' }, cartToken: cbad, idemKey: `k-${uniq()}` });
  oco.json?.discount_vnd === 0 ? ok('mã sai → không giảm (đơn vẫn tạo)') : bad('mã sai vẫn giảm', JSON.stringify(oco.json));

  // Đơn tối thiểu 1tr, giỏ 250k → không áp.
  await rq(SELLER, 'POST', `/shops/${A.shopId}/coupons`, { body: { code: 'MIN1TR', kind: 'fixed', value: 100000, min_subtotal_vnd: 1000000 }, cookie: A.cookie, origin: OS });
  const cmin = (await co(A.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 1 } })).cartToken;
  await coForm(A.host, '/cart/coupon', { code: 'MIN1TR' }, cmin);
  oco = await co(A.host, 'POST', '/checkout', { body: { customer: { name: 'K', phone: phone() }, payment_method: 'cod' }, cartToken: cmin, idemKey: `k-${uniq()}` });
  oco.json?.discount_vnd === 0 ? ok('chưa đủ đơn tối thiểu → không giảm') : bad('giảm dù chưa đủ đơn', JSON.stringify(oco.json));

  // max_uses=1: lần 2 hết lượt.
  await rq(SELLER, 'POST', `/shops/${A.shopId}/coupons`, { body: { code: 'CHI1LAN', kind: 'fixed', value: 20000, max_uses: 1 }, cookie: A.cookie, origin: OS });
  const cu1 = (await co(A.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 1 } })).cartToken;
  await coForm(A.host, '/cart/coupon', { code: 'CHI1LAN' }, cu1);
  let u = await co(A.host, 'POST', '/checkout', { body: { customer: { name: 'K', phone: phone() }, payment_method: 'cod' }, cartToken: cu1, idemKey: `k-${uniq()}` });
  u.json?.discount_vnd === 20000 ? ok('CHI1LAN lần 1 → giảm 20.000') : bad('lần 1 không giảm', JSON.stringify(u.json));
  const cu2 = (await co(A.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 1 } })).cartToken;
  await coForm(A.host, '/cart/coupon', { code: 'CHI1LAN' }, cu2);
  u = await co(A.host, 'POST', '/checkout', { body: { customer: { name: 'K', phone: phone() }, payment_method: 'cod' }, cartToken: cu2, idemKey: `k-${uniq()}` });
  u.json?.discount_vnd === 0 ? ok('CHI1LAN hết lượt lần 2 → không giảm (không vượt max_uses)') : bad('vượt max_uses', JSON.stringify(u.json));

  // Hoàn lượt coupon khi HUỶ đơn chưa trả (chống đốt lượt bằng đơn chưa thanh toán).
  await rq(SELLER, 'POST', `/shops/${A.shopId}/coupons`, { body: { code: 'HOAN1', kind: 'fixed', value: 10000, max_uses: 1 }, cookie: A.cookie, origin: OS });
  const ch = (await co(A.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 1 } })).cartToken;
  await coForm(A.host, '/cart/coupon', { code: 'HOAN1' }, ch);
  const oh = await co(A.host, 'POST', '/checkout', { body: { customer: { name: 'K', phone: phone() }, payment_method: 'cod' }, cartToken: ch, idemKey: `k-${uniq()}` });
  oh.json?.discount_vnd === 10000 ? ok('HOAN1 dùng lần 1 → giảm 10.000 (used_count=1)') : bad('HOAN1 không giảm', JSON.stringify(oh.json));
  const ohId = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2`, [A.shopId, oh.json.order_number])).rows[0].id;
  const cres = await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${ohId}/cancel`, { cookie: A.cookie, origin: OS });
  cres.status === 200 ? ok('huỷ đơn dùng coupon (chưa trả) → 200') : bad('huỷ đơn lỗi', cres.raw);
  const ucr = await owner.query(`SELECT used_count FROM coupons WHERE shop_id=$1 AND code='HOAN1'`, [A.shopId]);
  ucr.rows[0]?.used_count === 0 ? ok('huỷ đơn chưa trả → HOÀN lại lượt coupon (used_count=0)') : bad(`used_count=${ucr.rows[0]?.used_count} sau huỷ (chưa hoàn)`);

  // CÔ LẬP CHÉO SHOP: coupon của A không áp cho giỏ shop B.
  const cB = (await co(Bs.host, 'POST', '/cart/items', { body: { variant_id: vidB, qty: 1 } })).cartToken;
  await coForm(Bs.host, '/cart/coupon', { code: 'GIAM10' }, cB);
  u = await co(Bs.host, 'POST', '/checkout', { body: { customer: { name: 'K', phone: phone() }, payment_method: 'cod' }, cartToken: cB, idemKey: `k-${uniq()}` });
  u.json?.discount_vnd === 0 && !u.json?.coupon_code ? ok('coupon shop A KHÔNG áp cho đơn shop B (cô lập chéo shop)') : bad('CẤN CHÉO SHOP coupon', JSON.stringify(u.json));

  // ── 11. Chống ĐƠN ẢO (griefing) — 3 lớp ────────────────────────────────────
  sect('11. Chống đơn ảo');
  // Lớp 2: trần 8 đơn CHƯA xử lý / 1 SĐT → đơn thứ 9 bị chặn.
  const spamPhone = phone();
  let placed = 0, blocked = false;
  for (let i = 0; i < 9; i++) {
    const cart = (await co(A.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 1 } })).cartToken;
    const r = await co(A.host, 'POST', '/checkout', { body: { customer: { name: 'Spam', phone: spamPhone }, payment_method: 'cod' }, cartToken: cart, idemKey: `k-${uniq()}` });
    if (r.status === 201) placed++; else if (r.status === 429) { blocked = true; break; }
  }
  placed === 8 && blocked ? ok('trần 8 đơn/SĐT chưa xử lý → đơn thứ 9 bị chặn 429 (chống spam)') : bad(`per-phone limit sai: placed=${placed} blocked=${blocked}`);

  // Lớp 2 (biên): SĐT qua regex nhưng <8 CHỮ SỐ ("1.2.3.4.5.6") → PHẢI bị từ chối, không được
  // lọt để vô hiệu hoá trần theo-SĐT (canonPhone=null). Chống lách trần bằng SĐT rác.
  const cbadphone = (await co(A.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 1 } })).cartToken;
  const rbad = await co(A.host, 'POST', '/checkout', { body: { customer: { name: 'X', phone: '1.2.3.4.5.6' }, payment_method: 'cod' }, cartToken: cbadphone, idemKey: `k-${uniq()}` });
  rbad.status === 400 ? ok('SĐT <8 chữ số (rác) → 400, không lọt qua trần theo-SĐT') : bad(`SĐT rác lọt: status=${rbad.status}`, JSON.stringify(rbad.json));

  // Lớp 3: cờ "cùng nguồn" cho chủ shop — đếm SĐT KHÁC NHAU cùng 1 nguồn (đơn e2e cùng IP dbtest,
  // nhiều SĐT khác nhau → same_ip_phones cao). Đếm SĐT phân biệt (không phải số đơn thô).
  const ol = await rq(SELLER, 'GET', `/shops/${A.shopId}/orders`, { cookie: A.cookie });
  (ol.json?.orders ?? []).some((o) => Number(o.same_ip_phones) >= 3)
    ? ok('seller trả cờ same_ip_phones (cảnh báo nhiều SĐT cùng nguồn mạng)') : bad('thiếu cờ same_ip_phones', JSON.stringify(ol.json?.orders?.[0]));

  // Lớp 1: đơn COD 'pending' quá 7 ngày → worker TỰ HUỶ + trả tồn.
  const cexp = (await co(A.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 1 } })).cartToken;
  const oExp = await co(A.host, 'POST', '/checkout', { body: { customer: { name: 'K', phone: phone() }, payment_method: 'cod' }, cartToken: cexp, idemKey: `k-${uniq()}` });
  const expId = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2`, [A.shopId, oExp.json.order_number])).rows[0].id;
  const resvBefore = Number((await owner.query(`SELECT reserved FROM inventory_levels WHERE variant_id=$1`, [vid])).rows[0].reserved);
  await owner.query(`UPDATE orders SET created_at = now() - interval '8 days' WHERE id=$1`, [expId]); // giả lập đơn cũ
  await fetch(`${WORKER}/internal/expire-sweep`, { method: 'POST' });
  const oe = (await owner.query(`SELECT status FROM orders WHERE id=$1`, [expId])).rows[0];
  oe.status === 'cancelled' ? ok('đơn COD quá 7 ngày chưa xử lý → worker TỰ HUỶ') : bad(`COD expiry sai: status=${oe.status}`);
  const resvAfter = Number((await owner.query(`SELECT reserved FROM inventory_levels WHERE variant_id=$1`, [vid])).rows[0].reserved);
  resvAfter === resvBefore - 1 ? ok('huỷ tự động → TRẢ LẠI tồn kho (reserve −1)') : bad(`reserve: trước=${resvBefore} sau=${resvAfter}`);

  // ── 12. Thông báo khách (Bước 2): email tự-huỷ + link tra cứu ───────────────
  sect('12. Thông báo khách');
  // Đơn có EMAIL → outbox order.created phải kèm LINK tra cứu (number+token).
  const cnl = (await co(A.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 1 } })).cartToken;
  const onl = await co(A.host, 'POST', '/checkout', { body: { customer: { name: 'K', phone: phone(), email: `link-${uniq()}@mail.vn` }, payment_method: 'cod' }, cartToken: cnl, idemKey: `k-${uniq()}` });
  const obLink = (await owner.query(
    `SELECT payload FROM outbox WHERE shop_id=$1 AND topic='order.created' AND (payload->>'order_number')::int=$2`,
    [A.shopId, onl.json.order_number])).rows[0];
  obLink?.payload?.link?.includes(`/checkout/success?number=${onl.json.order_number}&token=`)
    ? ok('email xác nhận kèm LINK tra cứu đơn (trang HTML, không phải API JSON)') : bad('thiếu link tra cứu', JSON.stringify(obLink?.payload));

  // Đơn COD có email quá 7 ngày → tự huỷ PHẢI gửi email (reason='expired') — hết huỷ im lặng.
  const cexp2 = (await co(A.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 1 } })).cartToken;
  const oExp2 = await co(A.host, 'POST', '/checkout', { body: { customer: { name: 'K', phone: phone(), email: `exp-${uniq()}@mail.vn` }, payment_method: 'cod' }, cartToken: cexp2, idemKey: `k-${uniq()}` });
  await owner.query(`UPDATE orders SET created_at = now() - interval '8 days' WHERE shop_id=$1 AND order_number=$2`, [A.shopId, oExp2.json.order_number]);
  await fetch(`${WORKER}/internal/expire-sweep`, { method: 'POST' });
  const obExp = (await owner.query(
    `SELECT payload FROM outbox WHERE shop_id=$1 AND topic='order.status_changed' AND (payload->>'order_number')::int=$2 AND payload->>'reason'='expired'`,
    [A.shopId, oExp2.json.order_number])).rows[0];
  obExp && obExp.payload.status === 'cancelled'
    ? ok('đơn TỰ HUỶ → outbox email reason=expired (hết huỷ im lặng)') : bad('tự huỷ vẫn im lặng', JSON.stringify(obExp?.payload));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('payment e2e lỗi:', err); process.exit(2); });
