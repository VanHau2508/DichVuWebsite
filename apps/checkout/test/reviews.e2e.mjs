/**
 * End-to-end ĐÁNH GIÁ SẢN PHẨM. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/checkout/test/reviews.e2e.mjs
 *
 * Kiểm: khách gửi (pending, KHÔNG hiện ngay), badge "đã mua" khớp đơn delivered,
 * honeypot nuốt im lặng, rate-limit 3/IP/ngày, shop duyệt → hiện trên storefront
 * (sao + nội dung), reject/xoá, cô lập chéo shop, XSS escape.
 */

import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const STORE = new URL(process.env.STOREFRONT_URL ?? 'http://storefront:3050');
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
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

// HTTP với Host header (fetch cấm đặt Host) — dùng cho checkout (form) + storefront (đọc trang).
function hostReq(target, host, method, path, { form, body, cartToken, idemKey } = {}) {
  return new Promise((resolve, reject) => {
    const data = form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : null;
    const headers = { host, origin: `https://${host}` };
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    else if (body) headers['content-type'] = 'application/json';
    if (data) headers['content-length'] = Buffer.byteLength(data);
    if (cartToken) headers['cookie'] = `__Host-cart=${cartToken}`;
    if (idemKey) headers['idempotency-key'] = idemKey;
    const req = http.request({ hostname: target.hostname, port: target.port, path, method, headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => {
        let j = null; try { j = b ? JSON.parse(b) : null; } catch {}
        let token = cartToken;
        for (const c of res.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) token = m[1]; }
        resolve({ status: res.statusCode, body: b, json: j, location: res.headers.location, cartToken: token });
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
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, slug, host: `${slug}.nentang.vn`, email, password, cookie: await login(email, password) };
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `rv-${uniq()}`);
  // Sản phẩm + tồn + slug
  const slug = `sp-${uniq()}`;
  let r = await rq(SELLER, 'POST', `/shops/${A.shopId}/products`, { body: { title: 'Ghế review', slug, price_vnd: 100000, status: 'active', variants: [{ sku: `RV-${uniq()}`, price_vnd: 100000 }] }, cookie: A.cookie, origin: OS });
  const pid = r.json.id;
  const vid = (await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${pid}`, { cookie: A.cookie })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${A.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: 20, reason: 'seed' }, cookie: A.cookie, origin: OS });
  ok('dựng shop + sản phẩm');

  // Đơn ĐÃ GIAO để test badge "đã mua"
  const buyerPhone = phone();
  const cart = (await hostReq(CO, A.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 1 } })).cartToken;
  const oc = await hostReq(CO, A.host, 'POST', '/checkout', { body: { customer: { name: 'Người Mua', phone: buyerPhone }, payment_method: 'cod' }, cartToken: cart, idemKey: `k-${uniq()}` });
  const oid = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2`, [A.shopId, oc.json.order_number])).rows[0].id;
  await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${oid}/confirm`, { cookie: A.cookie, origin: OS });
  await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${oid}/ship`, { body: { tracking_number: 'RVTEST1' }, cookie: A.cookie, origin: OS });
  await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${oid}/deliver`, { cookie: A.cookie, origin: OS });

  // ── 1. Gửi đánh giá (pending) ────────────────────────────────────────────────
  sect('1. Khách gửi đánh giá');
  r = await hostReq(CO, A.host, 'POST', '/checkout/review', { form: { product_id: pid, rating: '5', author_name: 'Chị Hoa', content: 'Sản phẩm rất tốt, đáng tiền!', order_number: String(oc.json.order_number), phone: buyerPhone } });
  r.status === 303 && r.location?.includes(`/p/${slug}?review=sent`) ? ok('gửi đánh giá → 303 PRG về trang SP') : bad('gửi lỗi', `${r.status} ${r.location}`);
  const rv1 = (await owner.query(`SELECT status, verified FROM product_reviews WHERE shop_id=$1 AND product_id=$2 AND author_name='Chị Hoa'`, [A.shopId, pid])).rows[0];
  rv1?.status === 'pending' ? ok('đánh giá vào hàng chờ (pending)') : bad('status sai', JSON.stringify(rv1));
  rv1?.verified === true ? ok('badge "đã mua" (khớp đơn delivered + SĐT + SP)') : bad('verified sai', JSON.stringify(rv1));

  let page = (await hostReq(STORE, A.host, 'GET', `/p/${slug}`, {})).body;
  !page.includes('Sản phẩm rất tốt') ? ok('PENDING chưa hiện trên storefront') : bad('pending bị lộ!');

  // Sai đơn/SĐT → verified=false
  r = await hostReq(CO, A.host, 'POST', '/checkout/review', { form: { product_id: pid, rating: '4', author_name: 'Anh Ba', content: 'Cũng được, giao hơi chậm.', order_number: '999999', phone: phone() } });
  const rv2 = (await owner.query(`SELECT verified FROM product_reviews WHERE shop_id=$1 AND author_name='Anh Ba'`, [A.shopId])).rows[0];
  rv2?.verified === false ? ok('đơn không khớp → KHÔNG badge đã mua') : bad('verified giả', JSON.stringify(rv2));

  // Honeypot: bot điền field ẩn → giả vờ thành công, KHÔNG lưu.
  r = await hostReq(CO, A.host, 'POST', '/checkout/review', { form: { product_id: pid, rating: '5', author_name: 'Bot', content: 'spam spam spam spam', website: 'http://spam.com' } });
  const nBot = Number((await owner.query(`SELECT count(*)::int n FROM product_reviews WHERE shop_id=$1 AND author_name='Bot'`, [A.shopId])).rows[0].n);
  r.status === 303 && nBot === 0 ? ok('honeypot → 303 giả thành công, KHÔNG lưu') : bad('honeypot lọt', `${r.status} n=${nBot}`);

  // Validation: content ngắn → PRG review=invalid, không lưu.
  r = await hostReq(CO, A.host, 'POST', '/checkout/review', { form: { product_id: pid, rating: '5', author_name: 'X', content: 'ngắn' } });
  r.location?.includes('review=invalid') ? ok('nội dung <10 ký tự → review=invalid') : bad('validation lỏng', r.location);

  // Rate limit: đã gửi 2 (Hoa + Ba) → cái thứ 3 OK, thứ 4 bị 429.
  await hostReq(CO, A.host, 'POST', '/checkout/review', { form: { product_id: pid, rating: '3', author_name: 'Thứ Ba', content: 'đánh giá thứ ba hợp lệ' } });
  r = await hostReq(CO, A.host, 'POST', '/checkout/review', { form: { product_id: pid, rating: '3', author_name: 'Thứ Tư', content: 'đánh giá thứ tư vượt trần' } });
  r.status === 429 ? ok('trần 3 đánh giá/IP/ngày → 429') : bad('không chặn spam', String(r.status));

  // ── 2. Shop duyệt → hiện trên storefront ────────────────────────────────────
  sect('2. Duyệt & hiển thị');
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/reviews?status=pending`, { cookie: A.cookie });
  r.json?.reviews?.length === 3 && r.json.pending_count === 3 ? ok('seller thấy 3 pending') : bad('list sai', `${r.json?.reviews?.length} pc=${r.json?.pending_count}`);
  const rvHoa = r.json.reviews.find((x) => x.author_name === 'Chị Hoa');
  const rvBa = r.json.reviews.find((x) => x.author_name === 'Anh Ba');
  await rq(SELLER, 'POST', `/shops/${A.shopId}/reviews/${rvHoa.id}/approve`, { cookie: A.cookie, origin: OS });
  await rq(SELLER, 'POST', `/shops/${A.shopId}/reviews/${rvBa.id}/reject`, { cookie: A.cookie, origin: OS });
  page = (await hostReq(STORE, A.host, 'GET', `/p/${slug}`, {})).body;
  page.includes('Sản phẩm rất tốt') && page.includes('Chị Hoa') ? ok('APPROVED hiện trên trang SP') : bad('approved không hiện');
  page.includes('Đã mua hàng') ? ok('badge ✓ Đã mua hàng hiển thị') : bad('thiếu badge');
  !page.includes('giao hơi chậm') ? ok('REJECTED không hiện') : bad('rejected bị lộ');
  page.includes('(1 đánh giá)') && page.includes('5') ? ok('tóm tắt sao: 5 (1 đánh giá)') : bad('thiếu tóm tắt sao');
  page.includes('aggregateRating') ? ok('microdata aggregateRating (SEO)') : bad('thiếu microdata');

  // ── 3. XSS + cô lập chéo shop ───────────────────────────────────────────────
  sect('3. XSS + cô lập');
  // Nhả rate-limit (đánh giá cũ lùi 2 ngày) để request XSS được nhận (mục tiêu là kiểm escape).
  await owner.query(`UPDATE product_reviews SET created_at = created_at - interval '2 days' WHERE shop_id = $1`, [A.shopId]);
  await hostReq(CO, A.host, 'POST', '/checkout/review', { form: { product_id: pid, rating: '1', author_name: '<script>alert(1)</script>', content: '<img src=x onerror=alert(2)> nội dung đủ dài' } });
  const rvXss = (await owner.query(`SELECT id FROM product_reviews WHERE shop_id=$1 AND author_name LIKE '%script%'`, [A.shopId])).rows[0];
  if (rvXss) await rq(SELLER, 'POST', `/shops/${A.shopId}/reviews/${rvXss.id}/approve`, { cookie: A.cookie, origin: OS });
  page = (await hostReq(STORE, A.host, 'GET', `/p/${slug}`, {})).body;
  !page.includes('<script>alert(1)') && !page.includes('<img src=x') && page.includes('&lt;script&gt;')
    ? ok('XSS trong đánh giá bị ESCAPE') : bad('XSS lọt!');
  const Bs = await makeShopOwner(staff, `rvb-${uniq()}`);
  r = await rq(SELLER, 'POST', `/shops/${Bs.shopId}/reviews/${rvHoa.id}/reject`, { cookie: Bs.cookie, origin: OS });
  r.status === 404 ? ok('shop B duyệt đánh giá shop A → 404 (cô lập)') : bad('rò chéo shop', r.raw);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
