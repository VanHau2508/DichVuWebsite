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
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const KEY = process.env.SEPAY_WEBHOOK_KEY ?? 'dev-sepay-secret-key-12345';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });

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
  await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA });
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
// Đặt đơn QR, trả {orderNum, ref, total, qr, lookupToken}.
async function placeQrOrder(shop, vid, qty = 1) {
  const cart = (await co(shop.host, 'POST', '/cart/items', { body: { variant_id: vid, qty } })).cartToken;
  const r = await co(shop.host, 'POST', '/checkout', { body: { customer: { name: 'Khach', phone: '0901234567' }, payment_method: 'qr' }, cartToken: cart, idemKey: `k-${uniq()}` });
  return { orderNum: r.json?.order_number, ref: r.json?.payment_ref, total: r.json?.total_vnd, qr: r.json?.qr_string, lookupToken: r.json?.lookup_token, status: r.status, raw: r.raw };
}
const orderStatus = (host, num, token) => co(host, 'GET', `/checkout/order?number=${num}&token=${encodeURIComponent(token)}`);

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `pay-${uniq()}`);
  const vid = await setupProduct(A, 250000, 10);

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

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('payment e2e lỗi:', err); process.exit(2); });
