/**
 * E2E admin-web (BFF) — SỬA ĐƠN qua form no-JS. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-order-edit.e2e.mjs
 *
 * Kiểm QUA BFF (HTTP, form-encoded), KHÔNG gọi thẳng seller:
 *  1. Đơn sửa được: chi tiết hiện nút "Sửa đơn"; trang /edit 200 kèm dòng hiện tại.
 *  2. Giảm SL 3→1 → 303 redirect + chi tiết đơn hiện tổng mới (DB khớp).
 *  3. Đơn ĐÃ TRẢ: chi tiết ẩn nút "Sửa đơn"; mở /edit → 409 từ chối kèm lý do.
 *  4. Oversell: form render lại kèm lỗi tiếng Việt + GIỮ giá trị đã gõ (SL + ghi chú),
 *     DB KHÔNG đổi (rollback).
 *  5. CSRF: POST /edit thiếu Origin → 403, đơn giữ nguyên.
 * Harness mirror admin-flow (staff→shop→owner cookie qua inviteTokenOf từ outbox).
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

// ADMIN client: POST form (urlencoded). form có thể là OBJECT hoặc MẢNG cặp [k,v] (khoá trùng).
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
  const title = detail.json.title;
  await rq(SELLER, 'POST', `/shops/${shop.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: shop.cookie, origin: OS });
  return { vid, title };
}

// Đặt 1 đơn COD (→ pending, unpaid) với SL cho trước. Trả {orderNumber, orderId}.
async function placeOrder(shop, vid, qty) {
  const cart = (await co(shop.host, 'POST', '/cart/items', { body: { variant_id: vid, qty } })).cartToken;
  const r = await co(shop.host, 'POST', '/checkout', { body: { customer: { name: `Khách ${uniq()}`, phone: '0901234567' }, address: { line: 'HN' }, payment_method: 'cod' }, cartToken: cart, idemKey: `k-${uniq()}` });
  const orderNumber = r.json.order_number;
  const orderId = (await owner.query('SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2', [shop.shopId, orderNumber])).rows[0].id;
  return { orderNumber, orderId };
}
const orderRow = async (shopId, orderId) => (await owner.query('SELECT status, payment_status, subtotal_vnd, shipping_vnd, total_vnd, customer_name, customer_phone FROM orders WHERE shop_id=$1 AND id=$2', [shopId, orderId])).rows[0];
const lineQty = async (orderId, vid) => (await owner.query('SELECT qty FROM order_lines WHERE order_id=$1 AND variant_id=$2', [orderId, vid])).rows[0]?.qty;
const vnd = (v) => new Intl.NumberFormat('vi-VN').format(Number(v)) + '₫';

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `edt-${uniq()}`);
  const { vid, title } = await setupProduct(A, 100000, 20); // giá 100k, tồn 20
  const o1 = await placeOrder(A, vid, 3); // sẽ giảm 3→1 + oversell
  const o2 = await placeOrder(A, vid, 1); // sẽ ép "đã trả"
  const cookieA = await admLogin(A.email, A.password);
  cookieA ? ok('dựng shop + sản phẩm (tồn 20) + 2 đơn pending, đăng nhập BFF') : bad('không lấy được cookie BFF');

  const g0 = await orderRow(A.shopId, o1.orderId);
  const eurl = `/shops/${A.shopId}/orders/${o1.orderId}/edit`;
  const durl = `/shops/${A.shopId}/orders/${o1.orderId}`;
  const cust = { name: g0.customer_name, phone: g0.customer_phone };

  // ── 1. Đơn sửa được: nút + trang /edit ─────────────────────────────────────
  sect('1. Trang sửa đơn (đơn pending, chưa trả)');
  let r = await adm('GET', durl, { cookie: cookieA });
  r.status === 200 && r.body.includes(`${o1.orderId}/edit`) ? ok('chi tiết đơn sửa được: hiện nút/link "Sửa đơn"') : bad('thiếu nút Sửa đơn trên đơn sửa được', r.body.slice(0, 200));

  r = await adm('GET', eurl, { cookie: cookieA });
  r.status === 200 && r.body.includes('Sửa đơn') && r.body.includes(title) && r.body.includes('Hàng trong đơn') && /name="qty"[^>]*value="3"/.test(r.body)
    ? ok('GET /edit → 200, hiện dòng hiện tại (tên SP + SL=3) + ô thêm hàng') : bad('trang /edit sai', r.body.slice(0, 300));

  // ── 2. Giảm SL 3→1 → redirect + tổng mới ───────────────────────────────────
  sect('2. Giảm SL 3→1 (declarative POST)');
  const expTotal = 100000 * 1 + Number(g0.shipping_vnd);
  r = await adm('POST', eurl, {
    cookie: cookieA, origin: OADM,
    form: [['picker_q', ''], ['variant_id', vid], ['qty', '1'], ['name', cust.name], ['phone', cust.phone], ['email', ''], ['address_line', ''], ['province', ''], ['ship_fee_vnd', ''], ['note', '']],
  });
  const g1 = await orderRow(A.shopId, o1.orderId);
  (r.status === 303 && r.location === `${durl}?edited=1` && Number(g1.total_vnd) === expTotal && await lineQty(o1.orderId, vid) === 1)
    ? ok(`giảm SL → 303 ?edited=1 + DB total=${vnd(expTotal)}, SL=1`) : bad('giảm SL sai', `${r.status} ${r.location} total=${g1.total_vnd}(kv ${expTotal})`);

  r = await adm('GET', `${durl}?edited=1`, { cookie: cookieA });
  r.status === 200 && r.body.includes(vnd(expTotal)) && r.body.includes('Đã lưu sửa đơn') ? ok('chi tiết đơn: tổng mới + banner "Đã lưu sửa đơn"') : bad('chi tiết sau sửa thiếu tổng/banner', r.body.slice(0, 200));

  // ── 3. Đơn ĐÃ TRẢ → không sửa được ─────────────────────────────────────────
  sect('3. Đơn đã thanh toán → từ chối');
  await owner.query(`UPDATE orders SET payment_status='paid', paid_at=now() WHERE id=$1`, [o2.orderId]);
  const durl2 = `/shops/${A.shopId}/orders/${o2.orderId}`;
  r = await adm('GET', durl2, { cookie: cookieA });
  // Đơn đã trả: ẨN nút "Sửa đơn" (v1 unpaid, link kết thúc /edit") — nhưng CÓ nút "Sửa đơn
  // đã trả" (v2, link /edit-paid"). Phân biệt bằng dấu nháy đóng để /edit-paid không khớp nhầm.
  r.status === 200 && !r.body.includes(`${o2.orderId}/edit"`) ? ok('đơn đã trả: ẨN nút "Sửa đơn" (v1); có nút v2 /edit-paid') : bad('đơn đã trả vẫn hiện nút Sửa đơn v1', r.body.slice(0, 200));

  r = await adm('GET', `${durl2}/edit`, { cookie: cookieA });
  r.status === 409 && /thanh toán|CHƯA thanh toán/.test(r.body) ? ok('mở /edit đơn đã trả → 409 kèm lý do (không vào form chết)') : bad('mở /edit đơn đã trả không bị chặn', `${r.status} ${r.body.slice(0, 160)}`);

  // ── 4. Oversell → render lại kèm lỗi + GIỮ giá trị ─────────────────────────
  sect('4. Oversell (SL 50 > tồn) → lỗi + giữ giá trị + rollback');
  const beforeQty = await lineQty(o1.orderId, vid); // = 1
  r = await adm('POST', eurl, {
    cookie: cookieA, origin: OADM,
    form: [['picker_q', ''], ['variant_id', vid], ['qty', '50'], ['name', cust.name], ['phone', cust.phone], ['email', ''], ['address_line', ''], ['province', ''], ['ship_fee_vnd', ''], ['note', 'ghi-chu-oversell-XYZ']],
  });
  const afterQty = await lineQty(o1.orderId, vid);
  const keptQty = /name="qty"[^>]*value="50"/.test(r.body);
  const keptNote = r.body.includes('ghi-chu-oversell-XYZ');
  const hasErr = /hết hàng|còn/.test(r.body);
  (r.status === 400 && hasErr && keptQty && keptNote && afterQty === beforeQty)
    ? ok('oversell → render lại (400) kèm lỗi VN, GIỮ SL=50 + ghi chú, DB SL không đổi') : bad('oversell xử lý sai', `st=${r.status} err=${hasErr} qty50=${keptQty} note=${keptNote} db=${afterQty}(kv ${beforeQty})`);

  // ── 5. CSRF trên POST /edit ────────────────────────────────────────────────
  sect('5. CSRF');
  r = await adm('POST', eurl, {
    cookie: cookieA, // KHÔNG Origin
    form: [['variant_id', vid], ['qty', '2'], ['name', cust.name], ['phone', cust.phone]],
  });
  (r.status === 403 && await lineQty(o1.orderId, vid) === 1) ? ok('POST /edit không Origin → 403, đơn giữ nguyên') : bad('edit thiếu Origin không bị chặn', `${r.status} db=${await lineQty(o1.orderId, vid)}`);

  // ── Cụm thao tác chia theo VIỆC (khiếu nại: "nằm không đều, rối, không hiểu mục đích")
  // Bất biến: mỗi nhóm nút PHẢI có nhãn, và KHÔNG có nhãn nào trơ không nút nào bên dưới.
  // Nhãn trơ là cách hỏng dễ xảy ra nhất khi thêm điều kiện hiện/ẩn nút về sau.
  r = await adm('GET', durl, { cookie: cookieA });
  // Cắt theo NHÃN chứ không cố khớp cặp <div> lồng nhau — regex không đếm được ngoặc,
  // và bản đầu của chính ca này báo "1 nhóm rỗng" chỉ vì nhóm "Sửa đơn" dùng thẻ
  // <a class="btn"> chứ không phải <button>. Chấp nhận CẢ HAI dạng nút.
  const labels = [...r.body.matchAll(/<span class="actgrp-l">([^<]+)<\/span>/g)].map((m) => m[1]);
  const chunks = r.body.split('<span class="actgrp-l">').slice(1)
    .map((c) => c.split('<span class="actgrp-l">')[0]);
  const emptyGroups = chunks.filter((c) => !/<button|<a class="btn/.test(c)).length;
  labels.length >= 2 && emptyGroups === 0
    ? ok(`cụm thao tác chia nhóm có nhãn (${labels.join(' · ')}), không nhóm rỗng`)
    : bad('cụm thao tác không chia nhóm / có nhãn trơ', `nhãn=${labels.join(',')} rỗng=${emptyGroups}`);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('admin order-edit e2e lỗi:', err); process.exit(2); });
