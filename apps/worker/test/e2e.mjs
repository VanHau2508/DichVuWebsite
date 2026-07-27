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
const mpDetail = async (id) => (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json(); // {Text, HTML, ...}
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
  // Đợt 5.4 #15: compose trả thêm HTML (multipart/alternative) — bản text GIỮ NGUYÊN.
  const det1 = mail1 ? await mpDetail(mail1.ID) : null;
  det1?.HTML && det1.HTML.includes('Tra cứu đơn hàng') && /checkout\/success/.test(det1.HTML)
    ? ok('email có bản HTML + nút CTA "Tra cứu đơn hàng" trỏ link tra cứu') : bad('email thiếu HTML/CTA', (det1?.HTML ?? '(rỗng)').slice(0, 200));
  det1?.HTML && det1.HTML.includes(`${A.slug}.nentang.vn`)
    ? ok('header thương hiệu = miền shop (payload self-contained, không đọc bảng shops)') : bad('HTML thiếu thương hiệu shop', (det1?.HTML ?? '').slice(0, 200));
  det1?.Text && det1.Text.includes(`Đơn hàng #${o1.orderNum} đã được ghi nhận`)
    ? ok('bản text giữ nguyên cấu trúc cũ (client text-only vẫn đọc trọn)') : bad('bản text đổi/mất', (det1?.Text ?? '').slice(0, 200));

  // ── 1b. Nhánh compose 'user.invited' (HỢP ĐỒNG với Đợt 5.5) ────────────────
  sect('1b. Email lời mời quản trị (user.invited)');
  await mpClear();
  const inviteeEmail = `moi-${uniq()}@kh.vn`;
  const acceptUrl = `https://admin.nentang.vn/invitations/accept?token=tk-${uniq()}`;
  // Ghi thẳng outbox đúng KHUÔN payload 5.5 sẽ dùng: {to, shop_name, role, accept_url, expires_days}.
  await owner.query(`INSERT INTO outbox (shop_id, topic, payload) VALUES ($1, 'user.invited', $2)`,
    [A.shopId, { to: inviteeEmail, shop_name: A.slug, role: 'staff', accept_url: acceptUrl, expires_days: 7 }]);
  const invMail = await waitEmail(`Lời mời quản trị cửa hàng ${A.slug}`);
  invMail ? ok(`email user.invited tới Mailpit (subject "Lời mời quản trị cửa hàng ${A.slug}")`) : bad('không có email user.invited');
  const invDet = invMail ? await mpDetail(invMail.ID) : null;
  invDet?.HTML?.includes(acceptUrl) && invDet.HTML.includes('Chấp nhận lời mời')
    ? ok('HTML có nút CTA "Chấp nhận lời mời" trỏ đúng accept_url') : bad('HTML thiếu accept_url/CTA', (invDet?.HTML ?? '(rỗng)').slice(0, 200));
  invDet?.Text?.includes(acceptUrl) && /hết hạn sau 7 ngày/.test(invDet.Text ?? '')
    ? ok('text có link chấp nhận + "Lời mời hết hạn sau 7 ngày"') : bad('text thiếu link/hạn', (invDet?.Text ?? '').slice(0, 200));

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
  (await waitEmail(`Đơn hàng #${o1.orderNum} — đã được xác nhận`)) ? ok('email "đã được xác nhận"') : bad('không có email confirmed');

  const ohBefore = await onHand(vid);          // = 10 (setup); o1 reserved 1, chưa đụng on_hand
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${oid}/ship`, { body: { tracking_number: 'VN123456789', carrier: 'GHN' }, cookie: A.cookie, origin: OS });
  r.status === 200 && r.json.tracking_number === 'VN123456789' ? ok('ship đơn → shipped + tracking') : bad('ship lỗi', r.raw);
  const shipMail = await waitEmail(`Đơn hàng #${o1.orderNum} — đang trên đường giao`);
  shipMail ? ok('email "đang trên đường giao" (có mã vận đơn)') : bad('không có email shipped');
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

  // ── Cảnh báo ĐƯỜNG TIỀN (ops): giao dịch chưa khớp tồn đọng → đẩy webhook ─────
  sect('Cảnh báo đường tiền');
  const alerts = [];
  const alertStub = http.createServer((rq, rs) => { let b = ''; rq.on('data', (d) => (b += d)); rq.on('end', () => { try { alerts.push(JSON.parse(b)); } catch {} rs.writeHead(200); rs.end('ok'); }); });
  await new Promise((r) => alertStub.listen(9103, '0.0.0.0', r)); // worker ALERT_WEBHOOK_URL=http://dbtest:9103
  // Seed 1 giao dịch tiền CHƯA KHỚP, tạo 2h trước (quá ngưỡng 1h) → phải cảnh báo.
  await owner.query(
    `INSERT INTO unmatched_transfers (shop_id, provider, provider_event_id, amount_vnd, reason, raw, created_at)
     VALUES ($1,'sepay',$2,500000,'no_ref','{}'::jsonb, now() - interval '2 hours')`, [A.shopId, `evt-${uniq()}`]);
  const asweep = await (await fetch(`${WORKER}/internal/alert-sweep`, { method: 'POST' })).json();
  asweep.metrics.unmatched_old >= 1 && asweep.breaches >= 1
    ? ok(`sweep phát hiện ${asweep.metrics.unmatched_old} giao dịch chưa khớp >1h → ${asweep.breaches} cảnh báo`)
    : bad('không phát hiện tiền chưa khớp', JSON.stringify(asweep));
  await sleep(400); // chờ worker POST webhook
  alerts.some((a) => /chưa khớp/i.test(a.text ?? ''))
    ? ok('đã ĐẨY cảnh báo tới webhook (nội dung "tiền chưa khớp")') : bad('webhook không nhận cảnh báo', JSON.stringify(alerts).slice(0, 200));
  alertStub.close();

  // ── Thông báo TELEGRAM per-shop (stub Telegram API dbtest:9104) ──────────────
  sect('Thông báo Telegram per-shop');
  const tg = { updates: [], sent: [] };
  const tgStub = http.createServer((rq2, rs2) => {
    let b = ''; rq2.on('data', (d) => (b += d)); rq2.on('end', () => {
      rs2.setHeader('content-type', 'application/json');
      if (/\/getUpdates/.test(rq2.url)) { const out = tg.updates.splice(0); return rs2.end(JSON.stringify({ ok: true, result: out })); }
      if (/\/sendMessage/.test(rq2.url)) { try { tg.sent.push(JSON.parse(b)); } catch {} return rs2.end(JSON.stringify({ ok: true, result: {} })); }
      rs2.statusCode = 404; rs2.end('{}');
    });
  });
  await new Promise((r) => tgStub.listen(9104, '0.0.0.0', r)); // worker TELEGRAM_API_BASE=http://dbtest:9104
  // 1) Shop tạo liên kết → lấy deep-link chứa mã.
  let tr = await rq(SELLER, 'POST', `/shops/${A.shopId}/telegram/link`, { cookie: A.cookie, origin: OS });
  const code = /start=([^&\s]+)/.exec(tr.json?.deep_link ?? '')?.[1];
  code ? ok('shop tạo liên kết Telegram (deep-link có mã)') : bad('không tạo được liên kết', tr.raw);
  // 2) Giả lập chủ shop bấm START → worker getUpdates thấy "/start <code>" → bind chat_id.
  const CHAT = '900100200';
  tg.updates.push({ update_id: 1, message: { chat: { id: Number(CHAT) }, text: `/start ${code}` } });
  await (await fetch(`${WORKER}/internal/telegram-link-sweep`, { method: 'POST' })).json();
  await sleep(300);
  const bound = (await owner.query(`SELECT chat_id FROM shop_telegram WHERE shop_id=$1`, [A.shopId])).rows[0];
  bound?.chat_id === CHAT ? ok('worker bind chat_id vào shop (đã kết nối)') : bad('không bind được chat_id', JSON.stringify(bound));
  tg.sent.some((mm) => String(mm.chat_id) === CHAT && /kết nối/i.test(mm.text ?? '')) ? ok('gửi tin xác nhận "đã kết nối" tới chủ shop') : bad('không gửi xác nhận kết nối', JSON.stringify(tg.sent).slice(0, 200));
  // 3) Đơn MỚI (không email) → chủ shop vẫn nhận Telegram "đơn mới".
  tg.sent.length = 0;
  const onew = await placeOrder(A, vid, null, 1);
  await sleep(800); // chờ outbox → worker → deliverTelegram
  tg.sent.some((mm) => String(mm.chat_id) === CHAT && /Đơn MỚI/i.test(mm.text ?? '') && (mm.text ?? '').includes(`#${onew.orderNum}`))
    ? ok(`đơn mới #${onew.orderNum} (không email) → Telegram chủ shop nhận "Đơn MỚI"`) : bad('không bắn Telegram đơn mới', JSON.stringify(tg.sent).slice(0, 200));
  // 4) Vá MEDIUM: email khách LỖI (bounce) → chủ shop VẪN nhận Telegram "đơn mới" (2 kênh độc lập).
  tg.sent.length = 0;
  const obounce = await placeOrder(A, vid, 'bounce@test.invalid', 1);
  await sleep(900);
  tg.sent.some((mm) => String(mm.chat_id) === CHAT && /Đơn MỚI/i.test(mm.text ?? '') && (mm.text ?? '').includes(`#${obounce.orderNum}`))
    ? ok('email khách lỗi → chủ shop VẪN nhận Telegram "đơn mới" (email không nuốt Telegram)') : bad('email lỗi nuốt mất Telegram', JSON.stringify(tg.sent).slice(0, 200));
  // 5) SLA ĐƠN Ứ (Đợt 5.4 #7): pending >24h + shipped >7 ngày → MỘT digest Telegram/shop/ngày.
  tg.sent.length = 0;
  const ostale = await placeOrder(A, vid, null, 1); // COD pending
  const oidStale = await orderIdOf(A.shopId, ostale.orderNum);
  await owner.query(`UPDATE orders SET created_at = now() - interval '25 hours' WHERE id = $1`, [oidStale]);
  const oship = await placeOrder(A, vid, null, 1);
  const oidShip = await orderIdOf(A.shopId, oship.orderNum);
  await owner.query(`UPDATE orders SET status = 'shipped' WHERE id = $1`, [oidShip]);
  // Mốc "đã gửi hãng" đo bằng shipments.created_at (app_expiry không đọc được shipped_at) → backdate 8 ngày.
  await owner.query(`INSERT INTO shipments (shop_id, order_id, carrier, tracking_number, status, created_at)
                     VALUES ($1, $2, 'GHN', 'STALE-${uniq()}', 'in_transit', now() - interval '8 days')`, [A.shopId, oidShip]);
  const st1 = await (await fetch(`${WORKER}/internal/stale-sweep`, { method: 'POST' })).json();
  await sleep(300);
  const dig = tg.sent.find((mm) => String(mm.chat_id) === CHAT && /Đơn ứ/.test(mm.text ?? '') && (mm.text ?? '').includes(`#${ostale.orderNum}`));
  st1.shops >= 1 && dig && dig.text.includes(`#${oship.orderNum}`) && /chờ xử lý >24h/.test(dig.text) && /gửi hãng >7 ngày chưa giao/.test(dig.text)
    ? ok(`digest đơn ứ: pending #${ostale.orderNum} + shipped-kẹt #${oship.orderNum} gộp MỘT tin`)
    : bad('digest đơn ứ sai/thiếu', JSON.stringify({ st1, sent: tg.sent.map((m) => m.text) }).slice(0, 400));
  // Chạy lại NGAY → dedup 1 tin/shop/NGÀY (Redis tgstale:<shop>:<ngày VN>) — không spam.
  tg.sent.length = 0;
  const st2 = await (await fetch(`${WORKER}/internal/stale-sweep`, { method: 'POST' })).json();
  await sleep(300);
  st2.shops === 0 && !tg.sent.some((mm) => /Đơn ứ/.test(mm.text ?? ''))
    ? ok('re-sweep → KHÔNG digest trùng (dedup theo shop/ngày)') : bad('digest gửi trùng', JSON.stringify({ st2, n: tg.sent.length }));
  tgStub.close();

  // ── Nhắc hạn thuê bao 7/3/1 + past_due (dunning — 0062) ─────────────────────
  // Shop A đã bind Telegram (CHAT) ở mục trên → mở lại stub 9104 để bắt tin nhắc.
  sect('Nhắc hạn thuê bao (dunning 7/3/1 + past_due)');
  const dunTg = { sent: [] };
  const dunStub = http.createServer((rq3, rs3) => {
    let b = ''; rq3.on('data', (d) => (b += d)); rq3.on('end', () => {
      rs3.setHeader('content-type', 'application/json');
      if (/\/getUpdates/.test(rq3.url)) return rs3.end(JSON.stringify({ ok: true, result: [] }));
      if (/\/sendMessage/.test(rq3.url)) { try { dunTg.sent.push(JSON.parse(b)); } catch {} return rs3.end(JSON.stringify({ ok: true, result: {} })); }
      rs3.statusCode = 404; rs3.end('{}');
    });
  });
  await new Promise((r) => dunStub.listen(9104, '0.0.0.0', r));
  await mpClear();
  const contactEmail = `chushop-${uniq()}@test.vn`;
  await owner.query(`UPDATE shops SET contact_email = $2 WHERE id = $1`, [A.shopId, contactEmail]);
  await owner.query(`UPDATE subscriptions SET status = 'trial', current_period_end = now() + interval '2 days' WHERE shop_id = $1`, [A.shopId]);
  const remRows = async () => (await owner.query(`SELECT id, payload FROM outbox WHERE shop_id = $1 AND topic = 'subscription.reminder' ORDER BY id`, [A.shopId])).rows;
  const remState = async () => (await owner.query(`SELECT status, reminded_milestone FROM subscriptions WHERE shop_id = $1`, [A.shopId])).rows[0];
  const sweepSub = async (qs = '') => (await fetch(`${WORKER}/internal/subscription-sweep${qs}`, { method: 'POST' })).json();

  // 1) Còn 2 ngày → mốc d3, email tới contact_email, claim ghi marker.
  let dsw = await sweepSub();
  let drows = await remRows();
  drows.length === 1 && drows[0].payload.milestone === 'd3' && drows[0].payload.to === contactEmail
    ? ok(`sweep → 1 outbox 'subscription.reminder' mốc d3 + payload.to=contact_email (reminded=${dsw.reminded})`)
    : bad('outbox nhắc d3 sai/thiếu', JSON.stringify({ dsw, p: drows.map((x) => x.payload) }).slice(0, 300));
  (await remState())?.reminded_milestone === 'd3' ? ok(`claim ghi subscriptions.reminded_milestone='d3'`) : bad('không ghi reminded_milestone', JSON.stringify(await remState()));
  const d3Mail = await waitEmail(`của cửa hàng ${A.slug} sắp hết hạn — còn 2 ngày`);
  d3Mail && d3Mail.To?.[0]?.Address === contactEmail && /dùng thử/i.test(d3Mail.Subject)
    ? ok('Mailpit: email nhắc TRIAL "Thời gian dùng thử ... còn 2 ngày" đúng người nhận')
    : bad('email nhắc d3 sai/thiếu', JSON.stringify(d3Mail?.Subject ?? d3Mail));

  // 2) Re-sweep ngay → KHÔNG dòng trùng (claim theo mốc idempotent — mirror 0052).
  await sweepSub();
  (await remRows()).length === 1 ? ok('re-sweep ngay → KHÔNG outbox trùng (idempotent theo mốc)') : bad('re-sweep tạo outbox trùng', String((await remRows()).length));

  // 3) THANG BẬC trong CÙNG kỳ: giữ reminded_period_end = current (không re-arm), chỉ
  // rank d1(3) > d3(2) mới cho qua → đúng đường claim khi kỳ không đổi.
  await mpClear();
  await owner.query(`UPDATE subscriptions SET current_period_end = now() + interval '12 hours', reminded_period_end = now() + interval '12 hours' WHERE shop_id = $1`, [A.shopId]);
  await sweepSub();
  drows = await remRows();
  drows.length === 2 && drows[1].payload.milestone === 'd1'
    ? ok('cùng kỳ, sát hạn hơn → NHẢY BẬC d3→d1 (chỉ 1 dòng mới, không burst)')
    : bad('thang bậc d1 sai', JSON.stringify(drows.map((x) => x.payload.milestone)));
  (await waitEmail(`của cửa hàng ${A.slug} sắp hết hạn — còn 1 ngày`)) ? ok('email "còn 1 ngày"') : bad('không có email d1');

  // 4) Hết hạn → CÙNG TICK: sweepSubscriptions lật past_due rồi reminder bắn mốc past_due
  // (rank 4 > 3, kỳ giữ nguyên — đúng chuỗi prod khi kỳ trôi qua tự nhiên).
  await mpClear();
  await owner.query(`UPDATE subscriptions SET current_period_end = now() - interval '1 hour', reminded_period_end = now() - interval '1 hour' WHERE shop_id = $1`, [A.shopId]);
  dsw = await sweepSub();
  drows = await remRows();
  const dst = await remState();
  dst?.status === 'past_due' && drows.length === 3 && drows[2].payload.milestone === 'past_due'
    ? ok(`hết hạn → cùng tick: status='past_due' + nhắc mốc past_due (past_due=${dsw.past_due})`)
    : bad('past_due cùng tick sai', JSON.stringify({ dst, m: drows.map((x) => x.payload.milestone) }));
  const pdMail = await waitEmail(`Thuê bao cửa hàng ${A.slug} ĐÃ QUÁ HẠN — còn 7 ngày`);
  pdMail ? ok('email ân hạn "ĐÃ QUÁ HẠN — còn 7 ngày trước khi website tạm ngưng"') : bad('không có email past_due');

  // 5) GIA HẠN qua platform → kỳ mới → RE-ARM tự động (IS DISTINCT FROM), không reset tay.
  await mpClear();
  // renew giờ là thao tác phá hoại đòi step-up 5' (đợt 4.4) — xác thực lại trước.
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: 'staff strong passphrase' }, cookie: staff, origin: OA });
  let dr = await rq(PLATFORM, 'POST', `/ops/shops/${A.shopId}/subscription/renew`, { body: { months: 1 }, cookie: staff, origin: OO });
  dr.status === 200 ? ok('platform ghi nhận THU tiền (renew 1 tháng) → sub active, kỳ mới') : bad('renew lỗi', dr.raw);
  await owner.query(`UPDATE subscriptions SET current_period_end = now() + interval '6 days' WHERE shop_id = $1`, [A.shopId]);
  await sweepSub();
  drows = await remRows();
  drows.length === 4 && drows[3].payload.milestone === 'd7' && drows[3].payload.sub_status === 'active'
    ? ok('kỳ MỚI vào cửa sổ 7 ngày → nhắc d7 LẠI từ đầu (re-arm theo reminded_period_end)')
    : bad('re-arm sau gia hạn sai', JSON.stringify(drows.map((x) => x.payload.milestone)));
  (await waitEmail(`Gói Platform của cửa hàng ${A.slug} sắp hết hạn — còn 6 ngày`)) ? ok('email gói TRẢ PHÍ "Gói Platform ... còn 6 ngày"') : bad('không có email d7 sau renew');

  // 6) KHÔNG contact_email → outbox KHÔNG 'to' → email bỏ qua (không dead-letter),
  // Telegram VẪN bắn tới chat chủ shop.
  await mpClear();
  dunTg.sent.length = 0;
  const dunStats0 = await workerStats();
  await owner.query(`UPDATE shops SET contact_email = NULL WHERE id = $1`, [A.shopId]);
  await owner.query(`UPDATE subscriptions SET current_period_end = now() + interval '2 days' WHERE shop_id = $1`, [A.shopId]);
  await sweepSub();
  drows = await remRows();
  drows.length === 5 && drows[4].payload.milestone === 'd3' && !('to' in drows[4].payload)
    ? ok('không contact_email → outbox mốc d3 KHÔNG có payload.to (Telegram-only)')
    : bad('payload Telegram-only sai', JSON.stringify(drows[drows.length - 1]?.payload));
  await sleep(1500); // chờ poller (500ms) + consumer xử lý
  dunTg.sent.some((mm) => String(mm.chat_id) === CHAT && /sắp hết hạn — còn 2 ngày/.test(mm.text ?? ''))
    ? ok('Telegram chủ shop nhận "⏰ ... sắp hết hạn — còn 2 ngày" dù không email')
    : bad('không có Telegram nhắc hạn', JSON.stringify(dunTg.sent).slice(0, 300));
  const dunStats1 = await workerStats();
  dunStats1.failed === dunStats0.failed ? ok('outbox không-to xử lý sạch (không dead-letter)') : bad('reminder không-to vào dead-letter', JSON.stringify(dunStats1));

  // 7) ĐÓI QUÉT: shop ĐÃ nhắc rồi KHÔNG được chiếm chỗ trong lô. Dựng shop "chắn" hạn gần
  // hơn A và đã nhắc đúng mốc, rồi quét với lô = 1. Bản cũ (LIMIT 200, không lọc còn-việc)
  // sẽ lấy đúng shop chắn, claim 0 dòng, A KHÔNG BAO GIỜ được nhắc — chính là kịch bản
  // >200 shop trong cửa sổ 7 ngày: khách hết hạn mà chưa hề nhận nhắc nào.
  const blockerR = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: `wk-chan-${uniq()}`, slug: `wk-chan-${uniq()}`, plan_code: 'platform' }, cookie: staff, origin: OO });
  await owner.query(
    `UPDATE subscriptions SET status = 'active', current_period_end = now() + interval '1 hour',
       reminded_period_end = now() + interval '1 hour', reminded_milestone = 'd1' WHERE shop_id = $1`, [blockerR.json.id]);
  await owner.query(`UPDATE subscriptions SET current_period_end = now() + interval '5 days' WHERE shop_id = $1`, [A.shopId]);
  await sweepSub('?batch=1');
  drows = await remRows();
  drows.length === 6 && drows[5].payload.milestone === 'd7'
    ? ok('shop ĐÃ nhắc không chiếm chỗ lô → shop phía sau VẪN được nhắc (chống đói quét)')
    : bad('đói quét: shop sau lô đầu không được nhắc', JSON.stringify(drows.map((x) => x.payload.milestone)));

  // 8) Tường quyền app_billing (0062 thu hẹp theo dòng như 0058): không giả mạo được
  // email đơn hàng, không đọc identity, không ghi reminder mồ côi shop.
  const billing = new pg.Pool({ connectionString: 'postgres://app_billing:devpassword@postgres:5432/app', max: 1 });
  const mustFail = async (q, args) => { try { await billing.query(q, args); return null; } catch (e) { return e.message; } };
  const forgeMsg = await mustFail(`INSERT INTO outbox (shop_id, topic, payload) VALUES ($1, 'order.paid', '{}'::jsonb)`, [A.shopId]);
  forgeMsg && /row-level security/i.test(forgeMsg) ? ok('app_billing INSERT outbox topic order.paid → CHẶN (policy chỉ subscription.reminder)') : bad('app_billing giả mạo được order.paid — LỖ HỔNG', forgeMsg ?? 'insert THÀNH CÔNG');
  const orphanMsg = await mustFail(`INSERT INTO outbox (shop_id, topic, payload) VALUES (NULL, 'subscription.reminder', '{}'::jsonb)`);
  orphanMsg && /row-level security/i.test(orphanMsg) ? ok('app_billing INSERT reminder shop_id NULL → CHẶN (phải gắn shop)') : bad('reminder mồ côi shop được ghi', orphanMsg ?? 'insert THÀNH CÔNG');
  const idMsg = await mustFail(`SELECT email FROM users LIMIT 1`);
  idMsg && /permission denied/i.test(idMsg) ? ok('app_billing SELECT users.email → permission denied (tường 0033 nguyên vẹn)') : bad('app_billing đọc được users — LỖ HỔNG', idMsg ?? 'select THÀNH CÔNG');
  await billing.end();
  dunStub.close();

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('worker e2e lỗi:', err); process.exit(2); });
