/**
 * End-to-end LUỒNG MUA của khách (UI form thuần, không JS). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/checkout/test/buyer-flow.e2e.mjs
 *
 * Kiểm cả hành trình trình duyệt: trang sản phẩm (storefront) → thêm giỏ (POST form,
 * 303) → trang giỏ (HTML) → sửa số lượng → trang checkout (HTML, có idem token) →
 * đặt hàng (POST form, 303) → trang kết quả (COD + QR). Escape XSS. API JSON vẫn còn.
 */

import http from 'node:http';
import zlib from 'node:zlib';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const STORE = new URL(process.env.STOREFRONT_URL ?? 'http://storefront:3050');
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
// Token lời mời KHÔNG còn trong API response (email hoá, 0073) — lấy từ outbox qua owner SQL (ADR-006: cùng tx với INSERT invitations nên đọc được ngay).
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic = 'user.invited' AND payload->>'to' = $1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${String(d).slice(0, 200)}${X}`); };
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

// HTTP thô để đặt Host + Accept + form body + cookie giỏ (như trình duyệt).
function http1(target, { method = 'GET', host, path, accept, form, cartCookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = form ? new URLSearchParams(form).toString() : null;
    const headers = { host };
    if (accept) headers.accept = accept;
    if (data != null) { headers['content-type'] = 'application/x-www-form-urlencoded'; headers['content-length'] = Buffer.byteLength(data); headers.origin = `https://${host}`; }
    if (cartCookie) headers.cookie = `__Host-cart=${cartCookie}`;
    const req = http.request({ hostname: target.hostname, port: target.port, path, method, headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => {
        let token = cartCookie;
        for (const c of res.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) token = m[1]; }
        resolve({ status: res.statusCode, headers: res.headers, body: b, location: res.headers.location, cartCookie: token });
      });
    });
    req.on('error', reject); if (data != null) req.write(data); req.end();
  });
}
const store = (o) => http1(STORE, o);
const co = (o) => http1(CO, o);

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
async function makeShopOwner(staff, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, slug, host: `${slug}.nentang.vn`, cookie: await login(email, password) };
}
async function setupProduct(shop, title, slug, price, stock) {
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/products`, {
    body: { title, slug, price_vnd: price, status: 'active', variants: [{ sku: `S-${uniq()}`, price_vnd: price }] }, cookie: shop.cookie, origin: OS });
  const vid = (await rq(SELLER, 'GET', `/shops/${shop.shopId}/products/${r.json.id}`, { cookie: shop.cookie })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${shop.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: shop.cookie, origin: OS });
  return { productId: r.json.id, slug, vid };
}
// PNG 1x1 hợp lệ (sharp giải mã được) để upload ảnh sản phẩm.
function makePng() {
  const crc = (b) => { let c = ~0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const T = Buffer.from(t); const cc = Buffer.alloc(4); cc.writeUInt32BE(crc(Buffer.concat([T, d]))); return Buffer.concat([l, T, d, cc]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(1, 0); ih.writeUInt32BE(1, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 200, 50, 50]))), chunk('IEND', Buffer.alloc(0))]);
}
const uploadImage = (shop, productId) => fetch(SELLER + `/shops/${shop.shopId}/products/${productId}/media`, { method: 'POST', headers: { cookie: `__Host-session=${shop.cookie}`, origin: OS, 'content-type': 'application/octet-stream' }, body: makePng() });

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `buy-${uniq()}`);
  const XSSNAME = `<script>alert(1)</script>Áo`;
  const prod = await setupProduct(A, XSSNAME, `sp-${uniq()}`, 150000, 10);
  await uploadImage(A, prod.productId); // để kiểm thumbnail trong giỏ
  ok('dựng shop + sản phẩm (tồn 10) + ảnh');

  // ── 1. Trang sản phẩm có form thêm giỏ ─────────────────────────────────────
  sect('1. Trang sản phẩm (storefront) — nút thêm giỏ');
  let r = await store({ host: A.host, path: `/p/${prod.slug}`, accept: 'text/html' });
  r.status === 200 && r.body.includes('action="/cart/add"') && r.body.includes(`value="${prod.vid}"`)
    ? ok('có form POST /cart/add + variant_id') : bad('thiếu form thêm giỏ', r.body.match(/addcart[\s\S]{0,120}/)?.[0]);
  !r.body.includes('<script>alert(1)') && r.body.includes('&lt;script&gt;') ? ok('tên sản phẩm XSS được escape') : bad('XSS không escape ở trang sản phẩm');

  // ── 2. Thêm vào giỏ (form → 303) ───────────────────────────────────────────
  sect('2. Thêm vào giỏ');
  r = await co({ method: 'POST', host: A.host, path: '/cart/add', form: { variant_id: prod.vid, qty: '1' } });
  const cart = r.cartCookie;
  r.status === 303 && r.location === '/cart' && cart ? ok('POST /cart/add → 303 /cart + cookie giỏ') : bad('thêm giỏ lỗi', `status=${r.status} loc=${r.location}`);

  // ── 3. Trang giỏ (HTML) + content negotiation (JSON còn cho API) ───────────
  sect('3. Trang giỏ');
  r = await co({ host: A.host, path: '/cart', accept: 'text/html', cartCookie: cart });
  r.status === 200 && r.body.includes('Giỏ hàng') && r.body.includes('/cart/update') && r.body.includes('/checkout')
    ? ok('GET /cart (html) → trang giỏ có item + nút thanh toán') : bad('trang giỏ lỗi', String(r.status));
  // Ảnh phục vụ same-origin (/media-public) → CSP 'self' cho phép; nếu prod đặt CDN tuyệt đối
  // thì origin đó có trong img-src. Chấp nhận cả hai: 'self' HOẶC origin media rõ ràng.
  /<img class="cthumb" src="[^"]*media-public/.test(r.body) && /img-src[^;]*('self'|media-public|minio|https?:)/.test(r.headers['content-security-policy'] ?? '')
    ? ok('giỏ hiện thumbnail ảnh SP + CSP img-src cho phép') : bad('thiếu thumbnail/CSP trong giỏ', r.body.match(/cthumb[\s\S]{0,80}/)?.[0]);
  !r.body.includes('<script>alert(1)') ? ok('tên trong giỏ được escape') : bad('XSS trong giỏ');
  const rjson = await co({ host: A.host, path: '/cart', accept: 'application/json', cartCookie: cart });
  { let j = null; try { j = JSON.parse(rjson.body); } catch {} j && j.total_vnd === 180000 ? ok('GET /cart (json) vẫn trả API (total=150k+30k ship)') : bad('content-negotiation JSON hỏng', rjson.body.slice(0,120)); }

  // ── 4. Sửa số lượng (form) ─────────────────────────────────────────────────
  sect('4. Cập nhật số lượng');
  r = await co({ method: 'POST', host: A.host, path: '/cart/update', form: { variant_id: prod.vid, qty: '3' }, cartCookie: cart });
  r.status === 303 ? ok('POST /cart/update → 303') : bad('update lỗi', String(r.status));
  r = await co({ host: A.host, path: '/cart', accept: 'application/json', cartCookie: cart });
  { const j = JSON.parse(r.body); j.items[0]?.qty === 3 && j.subtotal_vnd === 450000 ? ok('số lượng = 3, tạm tính 450k') : bad('cập nhật không đúng', r.body.slice(0,120)); }

  // ── 5. Trang checkout (HTML, có idem token) ────────────────────────────────
  sect('5. Trang checkout');
  r = await co({ host: A.host, path: '/checkout', accept: 'text/html', cartCookie: cart });
  const idem = r.body.match(/name="idempotency_key" value="([^"]+)"/)?.[1];
  const ct = r.body.match(/name="ct" value="([^"]+)"/)?.[1]; // token time-trap chống bot (Bước 7)
  r.status === 200 && idem && ct && r.body.includes('action="/checkout/place"') && r.body.includes('payment_method')
    ? ok('GET /checkout → form đặt hàng + idem token + time-trap') : bad('trang checkout lỗi', String(r.status));

  // ── 6. Đặt hàng COD (form → 303 success) ───────────────────────────────────
  sect('6. Đặt hàng (COD)');
  await sleep(2600); // như người thật: điền form > MIN_FILL_MS (bot-guard Bước 7)
  r = await co({ method: 'POST', host: A.host, path: '/checkout/place', cartCookie: cart,
    form: { idempotency_key: idem, ct, name: 'Nguyễn Văn A', phone: '0901234567', email: `buyer-${uniq()}@kh.vn`, address_line: '123 Đường ABC', province: 'TP. Hồ Chí Minh', payment_method: 'cod' } });
  const m = /\/checkout\/success\?number=(\d+)&token=([^&\s]+)/.exec(r.location ?? '');
  r.status === 303 && m ? ok(`đặt hàng → 303 /checkout/success (đơn #${m[1]})`) : bad('đặt hàng COD lỗi', `status=${r.status} loc=${r.location}`);

  // ── 7. Trang kết quả đơn ───────────────────────────────────────────────────
  sect('7. Trang kết quả (COD)');
  r = await co({ host: A.host, path: `/checkout/success?number=${m[1]}&token=${m[2]}`, accept: 'text/html', cartCookie: cart });
  r.status === 200 && r.body.includes(`#${m[1]}`) && /COD/i.test(r.body) ? ok('trang success: số đơn + COD') : bad('trang success lỗi', String(r.status));
  const dbCount = (await owner.query('SELECT count(*)::int n FROM orders WHERE shop_id=$1 AND order_number=$2', [A.shopId, Number(m[1])])).rows[0].n;
  dbCount === 1 ? ok('đơn đã ghi vào DB') : bad('đơn không có trong DB');

  // ── 8. Luồng QR: cấu hình bank → đặt QR → trang có QR + nội dung CK ────────
  sect('8. Đặt hàng QR (có mã QR + thông tin chuyển khoản)');
  await owner.query(`INSERT INTO shop_payment_config (shop_id, bank_bin, account_number, account_name, qr_enabled) VALUES ($1,'970415','113366668888','SHOP ABC',true)
                     ON CONFLICT (shop_id) DO UPDATE SET bank_bin=EXCLUDED.bank_bin, account_number=EXCLUDED.account_number, account_name=EXCLUDED.account_name, qr_enabled=true`, [A.shopId]);
  // Giỏ MỚI (không gửi cookie cũ — giỏ cũ đã 'converted' sau khi đặt COD).
  const cart2 = (await co({ method: 'POST', host: A.host, path: '/cart/add', form: { variant_id: prod.vid, qty: '1' } })).cartCookie;
  const page2 = (await co({ host: A.host, path: '/checkout', accept: 'text/html', cartCookie: cart2 })).body;
  const idem2 = page2.match(/name="idempotency_key" value="([^"]+)"/)?.[1];
  const ct2 = page2.match(/name="ct" value="([^"]+)"/)?.[1];
  await sleep(2600);
  r = await co({ method: 'POST', host: A.host, path: '/checkout/place', cartCookie: cart2,
    form: { idempotency_key: idem2, ct: ct2, name: 'Trần B', phone: '0912345678', address_line: 'X', province: 'Hà Nội', payment_method: 'qr' } });
  const m2 = /number=(\d+)&token=([^&\s]+)/.exec(r.location ?? '');
  r.status === 303 && m2 ? ok(`đặt hàng QR → #${m2[1]}`) : bad('đặt hàng QR lỗi', `status=${r.status} loc=${r.location} ${r.body.slice(0,120)}`);
  r = await co({ host: A.host, path: `/checkout/success?number=${m2[1]}&token=${m2[2]}`, accept: 'text/html', cartCookie: cart2 });
  r.body.includes('<svg') && r.body.includes('113366668888') && /NTG[0-9A-F]{12}/.test(r.body)
    ? ok('trang QR: mã QR (SVG) + số TK + nội dung đối soát') : bad('trang QR thiếu QR/thông tin', r.body.match(/Chuyển khoản[\s\S]{0,200}/)?.[0]);

  // ── 9. Tra cứu đơn (khách quay lại) ────────────────────────────────────────
  sect('9. Tra cứu đơn');
  r = await co({ host: A.host, path: '/checkout/lookup', accept: 'text/html' });
  r.status === 200 && r.body.includes('action="/checkout/success"') && r.body.includes('name="number"') && r.body.includes('name="token"')
    ? ok('trang tra cứu có form (số đơn + mã)') : bad('form tra cứu lỗi', String(r.status));
  r = await co({ host: A.host, path: `/checkout/success?number=${m[1]}&token=${m[2]}`, accept: 'text/html' });
  r.status === 200 && r.body.includes(`Đơn hàng #${m[1]}`) && !r.body.includes('Đặt hàng thành công')
    ? ok('tra cứu đúng → xem đơn (không banner "vừa đặt")') : bad('tra cứu đúng lỗi', String(r.status));
  r = await co({ host: A.host, path: `/checkout/success?number=${m[1]}&token=${m[2]}&placed=1`, accept: 'text/html' });
  r.body.includes('Đặt hàng thành công') ? ok('vừa đặt (placed=1) → banner thành công') : bad('không có banner khi vừa đặt');
  r = await co({ host: A.host, path: `/checkout/success?number=${m[1]}&token=saimakhonghople`, accept: 'text/html' });
  r.status === 404 && r.body.includes('Không tìm thấy') && !r.body.includes('Giao tới')
    ? ok('sai mã → KHÔNG lộ đơn, hiện form + lỗi') : bad('sai mã vẫn lộ đơn?', String(r.status));
  r = await co({ host: A.host, path: '/checkout/success', accept: 'text/html' });
  r.status === 200 && r.body.includes('Tra cứu đơn hàng') ? ok('thiếu tham số → form tra cứu (không ngõ cụt)') : bad('thiếu tham số không về form');

  // ── 10. Phí liên miền + vòng trung thực ship_seen (no-JS, re-render 409) ────
  sect('10. Phí vùng miền + vòng xác nhận lại phí (ship_seen)');
  r = await rq(SELLER, 'PATCH', `/shops/${A.shopId}`, { body: { name: A.slug, ship_fee_vnd: 20000, ship_fee_far_vnd: 40000, ship_from_province: 'Hà Nội' }, cookie: A.cookie, origin: OS });
  r.status === 200 ? ok('cấu hình phí vùng: nội 20k / liên 40k / gửi từ Hà Nội') : bad('không cấu hình được phí vùng', r.raw);
  const cart3 = (await co({ method: 'POST', host: A.host, path: '/cart/add', form: { variant_id: prod.vid, qty: '1' } })).cartCookie;
  const page3 = (await co({ host: A.host, path: '/checkout', accept: 'text/html', cartCookie: cart3 })).body;
  const grab = (b) => ({
    idem: b.match(/name="idempotency_key" value="([^"]+)"/)?.[1],
    ct: b.match(/name="ct" value="([^"]+)"/)?.[1],
    seen: b.match(/name="ship_seen" value="(\d+)"/)?.[1],
  });
  let fm = grab(page3);
  fm.seen === '20000' && page3.includes('nội miền')
    ? ok('trang checkout: hidden ship_seen=20000 + ghi chú "nội miền" (chưa rõ tỉnh nhận)') : bad('thiếu ship_seen/ghi chú vùng', `seen=${fm.seen}`);

  // (a) thiếu tỉnh → re-render bắt chọn (form người mua BẮT BUỘC tỉnh; API JSON vẫn tuỳ chọn)
  await sleep(2600);
  r = await co({ method: 'POST', host: A.host, path: '/checkout/place', cartCookie: cart3,
    form: { idempotency_key: fm.idem, ct: fm.ct, ship_seen: fm.seen, name: 'Lê Thị C', phone: '0904444444', address_line: '99 Nguyễn Huệ', payment_method: 'cod' } });
  r.status === 200 && r.body.includes('Vui lòng chọn Tỉnh/Thành phố')
    ? ok('POST thiếu tỉnh → 200 re-render lỗi "Vui lòng chọn Tỉnh/Thành phố"') : bad('thiếu tỉnh không bị chặn', `status=${r.status}`);
  fm = grab(r.body);

  // (b) tỉnh LIÊN MIỀN + ship_seen CŨ (20000) → 409 trong tx → 200 re-render, KHÔNG tạo đơn
  const nBefore = (await owner.query('SELECT count(*)::int n FROM orders WHERE shop_id=$1', [A.shopId])).rows[0].n;
  await sleep(2600);
  r = await co({ method: 'POST', host: A.host, path: '/checkout/place', cartCookie: cart3,
    form: { idempotency_key: fm.idem, ct: fm.ct, ship_seen: fm.seen, name: 'Lê Thị C', phone: '0904444444', address_line: '99 Nguyễn Huệ', province: 'TP. Hồ Chí Minh', payment_method: 'cod' } });
  const nAfter = (await owner.query('SELECT count(*)::int n FROM orders WHERE shop_id=$1', [A.shopId])).rows[0].n;
  r.status === 200 && nAfter === nBefore && r.body.includes('40.000')
    ? ok('ship_seen cũ (20k) + tỉnh liên miền → 200 re-render báo phí 40.000₫, KHÔNG tạo đơn') : bad('vòng trung thực phí hỏng', `status=${r.status} orders ${nBefore}→${nAfter}`);
  fm = grab(r.body);
  fm.seen === '40000' ? ok('form dựng lại mang ship_seen=40000 (tổng đã tính theo tỉnh)') : bad('ship_seen dựng lại sai', fm.seen);

  // (c) bấm Đặt hàng lại (ship_seen đúng, idem/ct MỚI từ re-render) → 303 + phí lưu đúng
  await sleep(2600);
  r = await co({ method: 'POST', host: A.host, path: '/checkout/place', cartCookie: cart3,
    form: { idempotency_key: fm.idem, ct: fm.ct, ship_seen: fm.seen, name: 'Lê Thị C', phone: '0904444444', address_line: '99 Nguyễn Huệ', province: 'TP. Hồ Chí Minh', payment_method: 'cod' } });
  const m3 = /number=(\d+)&token=([^&\s]+)/.exec(r.location ?? '');
  r.status === 303 && m3 ? ok(`Đặt hàng lại → 303 success (đơn #${m3[1]})`) : bad('repost với phí đúng thất bại', `status=${r.status} ${r.body?.slice(0, 150)}`);
  const rowS = m3 ? (await owner.query('SELECT shipping_vnd, total_vnd FROM orders WHERE shop_id=$1 AND order_number=$2', [A.shopId, Number(m3[1])])).rows[0] : null;
  rowS && Number(rowS.shipping_vnd) === 40000 && Number(rowS.total_vnd) === 190000
    ? ok('orders.shipping_vnd=40000 (liên miền), total=190k — khớp nút đã bấm') : bad('phí ship lưu sai', JSON.stringify(rowS));

  // ── 11. Vòng trung thực ƯU ĐÃI (giam_seen): mã chết giữa chừng KHÔNG được âm thầm thu đủ ──
  sect('11. Mã giảm giá chết giữa lúc xem và lúc bấm → phải hỏi lại, không thu thêm');
  // Hai cổng trước chỉ phủ tiền HÀNG và phí SHIP. Mã giảm giá có thể chết theo 4 đường (hết
  // hạn / shop tắt / hết lượt do đua với đơn khác / shop sửa giá trị) — khi đó discount về 0
  // mà hàng + ship vẫn khớp, hai cổng kia cho qua → đơn tạo LUÔN với giá ĐỦ. Khách bị thu
  // nhiều hơn con số trên nút "Đặt hàng · …" mà không có bước xác nhận nào.
  const MA = `HONEST${uniq()}`.toUpperCase().slice(0, 16);
  await owner.query(
    `INSERT INTO coupons (shop_id, code, kind, value, min_subtotal_vnd, active) VALUES ($1,$2,'fixed',30000,0,true)`,
    [A.shopId, MA]);
  const cart4 = (await co({ method: 'POST', host: A.host, path: '/cart/add', form: { variant_id: prod.vid, qty: '1' } })).cartCookie;
  await co({ method: 'POST', host: A.host, path: '/cart/coupon', form: { code: MA }, cartCookie: cart4 });
  const page4 = (await co({ host: A.host, path: '/checkout', accept: 'text/html', cartCookie: cart4 })).body;
  // PHẢI lấy cả subtotal_seen: chính nó là cổng sinh ra vòng 409 ở ca biến thể mồ côi.
  // Bản đầu của bộ này quên gửi ô đó nên mutation KHÔNG đỏ — test đo nhầm thứ.
  const grab2 = (b) => ({ ...grab(b), giam: b.match(/name="giam_seen" value="(\d+)"/)?.[1],
    sub: b.match(/name="subtotal_seen" value="(\d+)"/)?.[1] });
  let fm4 = grab2(page4);
  fm4.giam === '30000'
    ? ok('trang checkout mang hidden giam_seen=30000 (khách đang thấy giảm 30k)') : bad('không phát giam_seen', `giam=${fm4.giam} ${page4.slice(0, 200)}`);

  // Shop TẮT mã ngay lúc khách đang điền form.
  await owner.query(`UPDATE coupons SET active = false WHERE shop_id=$1 AND code=$2`, [A.shopId, MA]);
  const n4Before = (await owner.query('SELECT count(*)::int n FROM orders WHERE shop_id=$1', [A.shopId])).rows[0].n;
  await sleep(2600);
  r = await co({ method: 'POST', host: A.host, path: '/checkout/place', cartCookie: cart4,
    form: { idempotency_key: fm4.idem, ct: fm4.ct, ship_seen: fm4.seen, giam_seen: fm4.giam, subtotal_seen: fm4.sub, name: 'Vũ Thị D', phone: '0905555555', address_line: '7 Trần Phú', province: 'Hà Nội', payment_method: 'cod' } });
  const n4After = (await owner.query('SELECT count(*)::int n FROM orders WHERE shop_id=$1', [A.shopId])).rows[0].n;
  r.status === 200 && n4After === n4Before && /Ưu đãi trên đơn vừa thay đổi/.test(r.body)
    ? ok('mã bị tắt giữa chừng → 200 dựng lại form báo "ưu đãi vừa thay đổi", KHÔNG tạo đơn')
    : bad('đơn vẫn được tạo với giá ĐỦ (khách bị thu thêm im lặng)', `status=${r.status} orders ${n4Before}→${n4After}`);
  fm4 = grab2(r.body);
  fm4.giam === '0' ? ok('form dựng lại mang giam_seen=0 (khách thấy đúng tổng mới rồi tự quyết)') : bad('giam_seen dựng lại sai', fm4.giam);

  // Bấm lại với con số đúng → đơn tạo được, tổng KHÔNG có giảm giá.
  await sleep(2600);
  r = await co({ method: 'POST', host: A.host, path: '/checkout/place', cartCookie: cart4,
    form: { idempotency_key: fm4.idem, ct: fm4.ct, ship_seen: fm4.seen, giam_seen: fm4.giam, subtotal_seen: fm4.sub, name: 'Vũ Thị D', phone: '0905555555', address_line: '7 Trần Phú', province: 'Hà Nội', payment_method: 'cod' } });
  const m4 = /number=(\d+)&token=([^&\s]+)/.exec(r.location ?? '');
  const row4 = m4 ? (await owner.query('SELECT discount_vnd, total_vnd FROM orders WHERE shop_id=$1 AND order_number=$2', [A.shopId, Number(m4[1])])).rows[0] : null;
  r.status === 303 && row4 && Number(row4.discount_vnd) === 0
    ? ok(`bấm lại → 303 tạo đơn #${m4[1]}, giảm giá 0 đúng như màn hình vừa báo`)
    : bad('bấm lại sau khi xác nhận vẫn hỏng', `status=${r.status} ${JSON.stringify(row4)}`);

  // ── 12. Món KHÔNG CÒN BÁN kẹt trong giỏ: KHÔNG được khoá cả giỏ ────────────
  sect('12. Biến thể mồ côi trong giỏ → vẫn đặt được các món còn lại');
  // Ca thật: khách bỏ vào giỏ, SAU đó shop thu hẹp phân loại (bỏ bớt một giá trị) →
  // biến thể cũ mất ánh xạ trục = "mồ côi", vẫn active + còn giá/tồn.
  // createOrderTx loại nó (dòng ~810) còn summarize thì KHÔNG → subtotal_seen luôn CAO HƠN
  // subtotal tính lại lúc chốt → 409 "giá vừa cập nhật" → dựng lại form → summarize lại kèm
  // đúng món đó → 409 lại. VÒNG LẶP VÔ TẬN, và nó khoá CẢ GIỎ chứ không riêng món hỏng.
  const pOrp = await rq(SELLER, 'POST', `/shops/${A.shopId}/products`, {
    body: { title: `SP mo coi ${uniq()}`, slug: `orp-${uniq()}`, status: 'active', price_vnd: 70000,
      variants: [{ sku: `O-${uniq()}`, price_vnd: 70000 }] }, cookie: A.cookie, origin: OS });
  const pid = pOrp.json?.id;
  if (!pid) bad('không tạo được SP để dựng ca mồ côi', `${pOrp.status} ${pOrp.raw?.slice(0, 200)}`);
  await rq(SELLER, 'PUT', `/shops/${A.shopId}/products/${pid}/options`, {
    body: { options: [{ name: 'Màu', values: ['Đỏ', 'Vàng'] }] }, cookie: A.cookie, origin: OS });
  const rOpt = await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${pid}`, { cookie: A.cookie });
  const vs = rOpt.json?.variants ?? [];
  if (vs.length < 2) bad('không sinh được 2 biến thể theo trục Màu', `${rOpt.status} ${JSON.stringify(rOpt.json?.variants ?? rOpt.raw?.slice(0, 200))}`);
  for (const v of vs) await rq(SELLER, 'POST', `/shops/${A.shopId}/variants/${v.id}/inventory/adjust`, { body: { delta: 20, reason: 'nhập' }, cookie: A.cookie, origin: OS });
  const vVang = vs.find((v) => /Vàng/.test(v.title ?? ''))?.id ?? vs[1].id;
  // Khách bỏ CẢ hai món vào giỏ: một món bình thường + món sắp thành mồ côi.
  let cart5 = (await co({ method: 'POST', host: A.host, path: '/cart/add', form: { variant_id: prod.vid, qty: '1' } })).cartCookie;
  cart5 = (await co({ method: 'POST', host: A.host, path: '/cart/add', form: { variant_id: vVang, qty: '1' }, cartCookie: cart5 })).cartCookie;
  // Shop bỏ giá trị 'Vàng' → biến thể Vàng thành mồ côi.
  await rq(SELLER, 'PUT', `/shops/${A.shopId}/products/${pid}/options`, {
    body: { options: [{ name: 'Màu', values: ['Đỏ'] }] }, cookie: A.cookie, origin: OS });
  const gio5 = (await co({ host: A.host, path: '/cart', accept: 'text/html', cartCookie: cart5 })).body;
  /không còn được bán/.test(gio5)
    ? ok('giỏ NÓI RA có món không còn bán (không lẳng lặng bớt, không lẳng lặng giữ)') : bad('giỏ không báo món mồ côi', gio5.slice(0, 300));
  // Các mục trước đã để lại nhiều đơn 'pending' cùng IP → hàng rào chống bot leo thang sang
  // câu hỏi xác minh, che mất thứ đang đo. Coi như shop đã xử lý xong chỗ đơn đó.
  await owner.query(`UPDATE orders SET status='confirmed' WHERE shop_id=$1 AND status='pending'`, [A.shopId]);
  const page5 = (await co({ host: A.host, path: '/checkout', accept: 'text/html', cartCookie: cart5 })).body;
  const fm5 = grab2(page5);
  await sleep(2600);
  r = await co({ method: 'POST', host: A.host, path: '/checkout/place', cartCookie: cart5,
    form: { idempotency_key: fm5.idem, ct: fm5.ct, ship_seen: fm5.seen, giam_seen: fm5.giam, subtotal_seen: fm5.sub, name: 'Đỗ Văn E', phone: '0906666666', address_line: '3 Bà Triệu', province: 'Hà Nội', payment_method: 'cod' } });
  const m5 = /number=(\d+)&token=([^&\s]+)/.exec(r.location ?? '');
  r.status === 303 && m5
    ? ok(`đặt được ngay lần đầu (đơn #${m5[1]}) — không còn vòng 409 vô tận`)
    : bad('vẫn kẹt vòng 409 với món mồ côi trong giỏ', `status=${r.status} LỖI=${(String(r.body).match(/(Vui lòng[^<]*|Ưu đãi[^<]*|Phí giao[^<]*|Giá sản phẩm[^<]*|giỏ hàng[^<]*|hết hàng[^<]*|xác minh[^<]*)/g) ?? ['(không thấy thông báo)']).join(' | ')}`);
  const nLine = m5 ? (await owner.query(
    `SELECT count(*)::int n FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE o.shop_id=$1 AND o.order_number=$2`,
    [A.shopId, Number(m5[1])])).rows[0].n : null;
  nLine === 1 ? ok('đơn chỉ gồm 1 dòng hàng còn bán được (món mồ côi không lọt vào đơn)') : bad('số dòng hàng sai', String(nLine));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('buyer-flow e2e lỗi:', err); process.exit(2); });
