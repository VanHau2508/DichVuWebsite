/**
 * End-to-end vận chuyển + email (outbox → worker → SMTP). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/worker/test/e2e.mjs
 *
 * Kiểm:
 *   - Đơn tạo (có email) → email xác nhận vào Mailpit (qua outbox → worker).
 *   - Không email MA: checkout THẤT BẠI (hết hàng) → không tạo email.
 *   - Chuyển trạng thái (confirm/ship/deliver/cancel) → email + shipment + tracking.
 *   - Huỷ đơn → RELEASE reserve tồn kho.
 *   - Email bounce vĩnh viễn → retry → dead-letter (không kẹt queue).
 */

import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const MAILPIT = process.env.MAILPIT_URL ?? 'http://mailpit:8025';
const WORKER = process.env.WORKER_URL ?? 'http://worker:3080';
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

// Mailpit
const mpClear = () => fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });
async function mpList() { const r = await fetch(`${MAILPIT}/api/v1/messages`); return (await r.json()).messages ?? []; }
async function waitEmail(subjectIncludes, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const msgs = await mpList();
    const hit = msgs.find((m) => (m.Subject ?? '').includes(subjectIncludes));
    if (hit) return hit;
    await sleep(300);
  }
  return null;
}
const workerStats = async () => (await fetch(`${WORKER}/stats`)).json();

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
  return { shopId, slug, host: `${slug}.nentang.vn`, cookie: await login(email, password) };
}
async function setupProduct(shop, price, stock) {
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/products`, {
    body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `S-${uniq()}`, price_vnd: price }] }, cookie: shop.cookie, origin: OS });
  const detail = await rq(SELLER, 'GET', `/shops/${shop.shopId}/products/${r.json.id}`, { cookie: shop.cookie });
  const vid = detail.json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${shop.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: shop.cookie, origin: OS });
  return vid;
}
async function placeOrder(shop, vid, email, qty = 1, method = 'cod') {
  const cart = (await co(shop.host, 'POST', '/cart/items', { body: { variant_id: vid, qty } })).cartToken;
  const r = await co(shop.host, 'POST', '/checkout', { body: { customer: { name: 'Khach', phone: '0901234567', email }, payment_method: method }, cartToken: cart, idemKey: `k-${uniq()}` });
  return { orderNum: r.json?.order_number, status: r.status, raw: r.raw };
}
const reserved = async (vid) => (await owner.query('SELECT reserved FROM inventory_levels WHERE variant_id=$1', [vid])).rows[0]?.reserved;
const onHand = async (vid) => (await owner.query('SELECT on_hand FROM inventory_levels WHERE variant_id=$1', [vid])).rows[0]?.on_hand;
const shipLedger = async (vid) => (await owner.query(`SELECT coalesce(sum(delta),0)::int s, count(*)::int n FROM inventory_ledger WHERE variant_id=$1 AND kind='ship'`, [vid])).rows[0];
const orderStatus = async (id) => (await owner.query('SELECT status FROM orders WHERE id=$1', [id])).rows[0]?.status;
const payStatus = async (id) => (await owner.query('SELECT payment_status FROM orders WHERE id=$1', [id])).rows[0]?.payment_status;
const auditCount = async (action, oid) => (await owner.query(`SELECT count(*)::int n FROM audit_logs WHERE action=$1 AND metadata->>'orderId'=$2`, [action, oid])).rows[0].n;
const orderIdOf = async (shopId, num) => (await owner.query('SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2', [shopId, num])).rows[0]?.id;

async function main() {
  await mpClear();
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `wk-${uniq()}`);
  const vid = await setupProduct(A, 250000, 10);

  // ── 1. Đơn tạo → email xác nhận ────────────────────────────────────────────
  sect('1. Email xác nhận đơn (outbox → worker → SMTP)');
  const buyer = `buyer-${uniq()}@kh.vn`;
  const o1 = await placeOrder(A, vid, buyer);
  o1.status === 201 ? ok(`đặt đơn #${o1.orderNum} (COD, có email)`) : bad('đặt đơn lỗi', o1.raw);
  const mail1 = await waitEmail(`Xác nhận đơn hàng #${o1.orderNum}`);
  mail1 ? ok('email xác nhận tới Mailpit (outbox pattern hoạt động)') : bad('không nhận được email xác nhận');
  mail1 && mail1.To?.[0]?.Address === buyer ? ok('email gửi đúng địa chỉ người mua') : bad('email sai người nhận');

  // ── 2. Không email MA khi checkout thất bại ────────────────────────────────
  sect('2. Không email ma khi thất bại');
  await mpClear();
  const before = (await mpList()).length;
  // Checkout KHÔNG có cookie giỏ → giỏ trống → 400 (transaction rollback, không outbox).
  const r400 = await co(A.host, 'POST', '/checkout', { body: { customer: { name: 'x', phone: '0900000000', email: `ghost-${uniq()}@kh.vn` }, payment_method: 'cod' }, idemKey: `k-${uniq()}` });
  await sleep(1500);
  const after = (await mpList()).length;
  r400.status === 400 && after === before ? ok('checkout thất bại (giỏ trống) → KHÔNG email (không phantom)') : bad('có email ma sau checkout thất bại', `before=${before} after=${after}`);

  // ── 3. Vòng đời đơn + email trạng thái ─────────────────────────────────────
  sect('3. Vòng đời đơn (confirm → ship → deliver)');
  await mpClear();
  const oid = await orderIdOf(A.shopId, o1.orderNum);
  let r = await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${oid}/confirm`, { cookie: A.cookie, origin: OS });
  r.status === 200 && r.json.status === 'confirmed' ? ok('confirm đơn → confirmed') : bad('confirm lỗi', r.raw);
  (await waitEmail(`Đơn hàng #${o1.orderNum} — đã xác nhận`)) ? ok('email "đã xác nhận"') : bad('không có email confirmed');

  const ohBefore = await onHand(vid);          // = 10 (setup); o1 reserved 1, chưa đụng on_hand
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${oid}/ship`, { body: { tracking_number: 'VN123456789', carrier: 'GHN' }, cookie: A.cookie, origin: OS });
  r.status === 200 && r.json.tracking_number === 'VN123456789' ? ok('ship đơn → shipped + tracking') : bad('ship lỗi', r.raw);
  const shipMail = await waitEmail(`Đơn hàng #${o1.orderNum} — đang giao`);
  shipMail ? ok('email "đang giao" (có mã vận đơn)') : bad('không có email shipped');
  // P0-5: ship CONSUME tồn — on_hand -= qty, reserved -= qty, ghi ledger 'ship'.
  const ohAfter = await onHand(vid), resAfterShip = await reserved(vid), lg = await shipLedger(vid);
  ohAfter === ohBefore - 1 ? ok(`ship consume on_hand ${ohBefore}→${ohAfter} (hàng rời kho)`) : bad('ship KHÔNG giảm on_hand', `${ohBefore}→${ohAfter}`);
  resAfterShip === 0 ? ok('ship giải phóng reserved của đơn (đã thành xuất kho)') : bad('reserved không giảm khi ship', String(resAfterShip));
  lg.n >= 1 && lg.s === -1 ? ok(`ledger 'ship' ghi delta ${lg.s} (giữ bất biến tổng==on_hand)`) : bad('thiếu/ sai ledger ship', JSON.stringify(lg));

  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/orders/${oid}`, { cookie: A.cookie });
  r.json?.shipments?.[0]?.tracking_number === 'VN123456789' ? ok('shipment ghi đúng tracking') : bad('shipment sai', r.raw);

  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${oid}/deliver`, { cookie: A.cookie, origin: OS });
  r.status === 200 && r.json.status === 'delivered' ? ok('deliver → delivered') : bad('deliver lỗi', r.raw);

  // Chuyển trạng thái sai → 409.
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${oid}/ship`, { body: { tracking_number: 'X1' }, cookie: A.cookie, origin: OS });
  r.status === 409 ? ok('ship lại đơn đã giao → 409 (state machine)') : bad('state machine không chặn', r.raw);

  // ── 4. Huỷ đơn → release reserve ───────────────────────────────────────────
  sect('4. Huỷ đơn release reserve');
  const o2 = await placeOrder(A, vid, `b2-${uniq()}@kh.vn`, 3);
  const oid2 = await orderIdOf(A.shopId, o2.orderNum);
  const resBefore = await reserved(vid);
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${oid2}/cancel`, { cookie: A.cookie, origin: OS });
  const resAfter = await reserved(vid);
  r.status === 200 && resAfter === resBefore - 3 ? ok(`huỷ đơn → reserve giảm ${resBefore}→${resAfter} (trả chỗ đã giữ)`) : bad('huỷ không release reserve', `${resBefore}→${resAfter}`);

  // ── 4b. COD đánh dấu ĐÃ NHẬN TIỀN → order.paid + audit ─────────────────────
  sect('4b. COD đánh dấu đã nhận tiền (mark-paid)');
  await mpClear();
  const oc = await placeOrder(A, vid, `cod-${uniq()}@kh.vn`, 1); // COD mặc định, có email
  const oidc = await orderIdOf(A.shopId, oc.orderNum);
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${oidc}/mark-paid`, { cookie: A.cookie, origin: OS });
  r.status === 200 && r.json.payment_status === 'paid' ? ok('COD mark-paid → payment_status paid') : bad('mark-paid lỗi', r.raw);
  (await payStatus(oidc)) === 'paid' ? ok('đơn COD → paid trong DB') : bad('COD chưa paid trong DB');
  (await waitEmail(`Đã nhận thanh toán đơn #${oc.orderNum}`)) ? ok('email "đã nhận thanh toán" (order.paid)') : bad('không có email order.paid');
  (await auditCount('order.marked_paid', oidc)) >= 1 ? ok('ghi audit order.marked_paid') : bad('thiếu audit mark-paid');
  // Idempotent: đánh dấu lần 2 → 409 (không phát email trùng).
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${oidc}/mark-paid`, { cookie: A.cookie, origin: OS });
  r.status === 409 ? ok('mark-paid lần 2 → 409 (đã thanh toán)') : bad('mark-paid không idempotent', r.raw);
  // Đơn QR KHÔNG cho đánh dấu thủ công — chỉ webhook đối soát đặt paid (chống gian lận).
  const oqm = await placeOrder(A, vid, `qrm-${uniq()}@kh.vn`, 1);
  const oidqm = await orderIdOf(A.shopId, oqm.orderNum);
  await owner.query(`UPDATE orders SET payment_method='qr' WHERE id=$1`, [oidqm]);
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${oidqm}/mark-paid`, { cookie: A.cookie, origin: OS });
  r.status === 409 ? ok('mark-paid đơn QR → 409 (chỉ COD; QR do webhook)') : bad('QR cho đánh dấu thủ công — LỖ HỔNG', r.raw);

  // ── 5. Dead-letter cho email bounce ────────────────────────────────────────
  sect('5. Dead-letter (email bounce vĩnh viễn)');
  const s0 = await workerStats();
  // Ghi thẳng outbox một sự kiện bounce (worker throw → retry → failed).
  await owner.query(`INSERT INTO outbox (shop_id, topic, payload) VALUES ($1, 'order.created', $2)`,
    [A.shopId, { to: 'bounce@test.invalid', order_number: 999999, total_vnd: 1, customer_name: 'x', payment_method: 'cod' }]);
  await sleep(4000); // 3 attempts × 150ms backoff + xử lý
  const s1 = await workerStats();
  s1.failed > s0.failed ? ok(`email bounce → dead-letter (failed ${s0.failed}→${s1.failed}), không kẹt queue`) : bad('bounce không vào dead-letter', JSON.stringify(s1));

  // ── 6. Hết hạn đơn QR chưa trả tiền → release reserve (P0-5) ────────────────
  // Đặt đơn (reserve thật qua checkout), rồi ép thành đơn QR-chưa-trả-tiền bằng owner
  // pool để tập trung kiểm SWEEP (luồng QR checkout + cấu hình bank kiểm ở payment e2e).
  sect('6. Hết hạn đơn QR chưa trả tiền → release reserve');
  const oq = await placeOrder(A, vid, `qr-${uniq()}@kh.vn`, 2);
  const oidq = await orderIdOf(A.shopId, oq.orderNum);
  // qr + unpaid + pending + quá hạn (1 giờ trước > ORDER_EXPIRY_MINUTES=30').
  await owner.query(`UPDATE orders SET payment_method='qr', payment_status='unpaid', status='pending', created_at = now() - interval '1 hour' WHERE id=$1`, [oidq]);
  const resBeforeExp = await reserved(vid);
  const sweep = await (await fetch(`${WORKER}/internal/expire-sweep`, { method: 'POST' })).json();
  const resAfterExp = await reserved(vid);
  sweep.expired >= 1 && resAfterExp === resBeforeExp - 2 && (await orderStatus(oidq)) === 'cancelled'
    ? ok(`sweep: đơn QR quá hạn → huỷ + release reserve ${resBeforeExp}→${resAfterExp}`)
    : bad('sweep không release/huỷ đơn quá hạn', `expired=${sweep.expired} ${resBeforeExp}→${resAfterExp} status=${await orderStatus(oidq)}`);
  // Đơn QR còn MỚI (created_at giờ) KHÔNG bị đụng.
  const oq2 = await placeOrder(A, vid, `qr2-${uniq()}@kh.vn`, 1);
  const oidq2 = await orderIdOf(A.shopId, oq2.orderNum);
  await owner.query(`UPDATE orders SET payment_method='qr', payment_status='unpaid', status='pending' WHERE id=$1`, [oidq2]);
  const resBeforeFresh = await reserved(vid);
  await fetch(`${WORKER}/internal/expire-sweep`, { method: 'POST' });
  (await reserved(vid)) === resBeforeFresh && (await orderStatus(oidq2)) === 'pending'
    ? ok('đơn QR còn mới KHÔNG bị hết hạn (giữ reserve + pending)') : bad('sweep hết hạn nhầm đơn mới');

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('worker e2e lỗi:', err); process.exit(2); });
