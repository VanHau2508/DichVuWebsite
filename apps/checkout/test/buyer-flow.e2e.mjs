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
  await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA });
  return cookie;
}
async function makeShopOwner(staff, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: r.json.token, password }, origin: OA });
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
  /<img class="cthumb" src="[^"]*media-public/.test(r.body) && /img-src[^;]*media-public|img-src[^;]*minio/.test(r.headers['content-security-policy'] ?? '')
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
  r.status === 200 && idem && r.body.includes('action="/checkout/place"') && r.body.includes('payment_method')
    ? ok('GET /checkout → form đặt hàng + idem token') : bad('trang checkout lỗi', String(r.status));

  // ── 6. Đặt hàng COD (form → 303 success) ───────────────────────────────────
  sect('6. Đặt hàng (COD)');
  r = await co({ method: 'POST', host: A.host, path: '/checkout/place', cartCookie: cart,
    form: { idempotency_key: idem, name: 'Nguyễn Văn A', phone: '0901234567', email: `buyer-${uniq()}@kh.vn`, address_line: '123 Đường ABC', payment_method: 'cod' } });
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
  const idem2 = (await co({ host: A.host, path: '/checkout', accept: 'text/html', cartCookie: cart2 })).body.match(/name="idempotency_key" value="([^"]+)"/)?.[1];
  r = await co({ method: 'POST', host: A.host, path: '/checkout/place', cartCookie: cart2,
    form: { idempotency_key: idem2, name: 'Trần B', phone: '0912345678', address_line: 'X', payment_method: 'qr' } });
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

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('buyer-flow e2e lỗi:', err); process.exit(2); });
