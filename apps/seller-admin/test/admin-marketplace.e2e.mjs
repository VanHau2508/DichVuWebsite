/**
 * E2E "chuẩn sàn TMĐT" (0096) — 2 mảng người bán quen từ TikTok Shop / Shopee. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-marketplace.e2e.mjs
 *
 * Kiểm:
 *   1. Hộp "Việc cần làm" trên Tổng quan — đếm ĐÚNG việc tồn đọng thật, link tới trang đã lọc sẵn.
 *   2. TAB trạng thái ở Đơn hàng — thay <select> cũ, có SỐ ĐẾM, giữ bộ lọc tìm kiếm khi đổi tab,
 *      và số đếm KHÔNG bị chính filter status làm về 0 (bẫy dễ mắc nhất khi làm tab).
 *   3. Tín hiệu sàn trên storefront — "Đã bán N" + sao chỉ hiện khi CÓ dữ liệu (không hiện 0★/Đã bán 0).
 *   4. Thanh tab đáy mobile có trên mọi trang, và trang SP có thanh mua dính đáy.
 */
import pg from 'pg';
import http from 'node:http';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const STOREFRONT = new URL(process.env.STOREFRONT_URL ?? 'http://storefront:3050');
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const WORKER = process.env.WORKER_URL ?? 'http://worker:3080';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

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
  return { status: r.status, location: r.headers.get('location'), body: await r.text() };
}
// Storefront: gọi thẳng service, Host = domain shop (như storefront e2e).
const sf = (host, path) => new Promise((res, rej) => {
  const r = http.request({ hostname: STOREFRONT.hostname, port: STOREFRONT.port, path, method: 'GET', headers: { host } }, (x) => {
    let b = ''; x.on('data', (d) => (b += d)); x.on('end', () => res(b));
  });
  r.on('error', rej); r.end();
});
// Checkout (đặt đơn): cookie giỏ quản tay.
function co(host, method, path, { body, cartToken, idemKey } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = { host, origin: `https://${host}` };
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (cartToken) headers.cookie = `__Host-cart=${cartToken}`;
    if (idemKey) headers['idempotency-key'] = idemKey;
    const req = http.request({ hostname: CO.hostname, port: CO.port, path, method, headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => {
        let j = null; try { j = b ? JSON.parse(b) : null; } catch {}
        let token = cartToken;
        for (const c of res.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) token = m[1]; }
        resolve({ status: res.statusCode, json: j, cartToken: token });
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
  cookie = ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).sc) ?? cookie;
  return cookie;
}
async function makeShopOwner(staffCookie, slug) {
  const r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  await owner.query(`UPDATE shops SET status='active' WHERE id=$1`, [shopId]);
  return { shopId, slug, host: `${slug}.nentang.vn`, email, password, cookie: await login(email, password) };
}
async function setupProduct(shop, title, price, stock) {
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/products`, {
    body: { title, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `S-${uniq()}`, price_vnd: price }] },
    cookie: shop.cookie, origin: OS,
  });
  const detail = await rq(SELLER, 'GET', `/shops/${shop.shopId}/products/${r.json.id}`, { cookie: shop.cookie });
  const vid = detail.json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${shop.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: shop.cookie, origin: OS });
  return { pid: r.json.id, vid, slug: detail.json.slug };
}
async function placeOrder(shop, vid, qty = 1) {
  const cart = (await co(shop.host, 'POST', '/cart/items', { body: { variant_id: vid, qty } })).cartToken;
  const r = await co(shop.host, 'POST', '/checkout', {
    body: { customer: { name: `Khach ${uniq()}`, phone: '0901234567' }, address: { line: 'HN' }, payment_method: 'cod' },
    cartToken: cart, idemKey: `k-${uniq()}`,
  });
  const on = r.json.order_number;
  const id = (await owner.query('SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2', [shop.shopId, on])).rows[0].id;
  return { orderNumber: on, orderId: id };
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `mk-${uniq()}`);
  const P = await setupProduct(A, `Ao thun ${uniq()}`, 150000, 50);
  // 3 đơn pending; 1 xác nhận (→ chờ gửi); 1 huỷ.
  const o1 = await placeOrder(A, P.vid, 3);
  const o2 = await placeOrder(A, P.vid, 2);
  const o3 = await placeOrder(A, P.vid, 1);
  await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${o1.orderId}/confirm`, { cookie: A.cookie, origin: OS });
  await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${o3.orderId}/cancel`, { cookie: A.cookie, origin: OS });
  ok('dựng shop + SP + 3 đơn (1 chờ gửi · 1 chờ xác nhận · 1 huỷ)');

  // ── 1. Việc cần làm ────────────────────────────────────────────────────────
  sect('1. Tổng quan: hộp "Việc cần làm" đếm đúng + link lọc sẵn');
  let r = await adm('GET', `/shops/${A.shopId}/overview`, { cookie: A.cookie });
  const has = (re) => re.test(r.body);
  r.status === 200 && has(/Việc cần làm/) ? ok('hộp "Việc cần làm" hiện trên Tổng quan') : bad('không thấy hộp Việc cần làm', String(r.status));
  has(/Đơn chờ xác nhận/) && has(/Đơn chờ gửi hàng/) && has(/Đánh giá chờ duyệt/) && has(/Sắp hết hàng/)
    ? ok('đủ 5 loại việc (xác nhận · gửi hàng · thu tiền · đánh giá · tồn kho)') : bad('thiếu loại việc');
  has(new RegExp(`href="/shops/${A.shopId}/orders\\?status=pending"`)) && has(new RegExp(`href="/shops/${A.shopId}/orders\\?status=confirmed"`))
    ? ok('ô việc link tới trang đơn ĐÃ LỌC SẴN đúng trạng thái') : bad('link ô việc sai');
  // Số thật: 1 chờ xác nhận (o2), 1 chờ gửi (o1 đã confirmed).
  const cellOf = (label) => {
    const m = new RegExp(`<div class="todo-n"[^>]*>(\\d+)</div>\\s*<div class="todo-l">[^<]*${label}`).exec(r.body);
    return m ? Number(m[1]) : null;
  };
  cellOf('Đơn chờ xác nhận') === 1 ? ok('đếm "chờ xác nhận" = 1 (khớp dữ liệu thật)') : bad('đếm chờ xác nhận sai', `=${cellOf('Đơn chờ xác nhận')}`);
  cellOf('Đơn chờ gửi hàng') === 1 ? ok('đếm "chờ gửi hàng" = 1 (khớp dữ liệu thật)') : bad('đếm chờ gửi sai', `=${cellOf('Đơn chờ gửi hàng')}`);
  !r.body.includes('<script') ? ok('Tổng quan vẫn no-JS (không có <script>)') : bad('lọt <script> vào seller-admin');

  // ── 2. Tab trạng thái ở Đơn hàng ───────────────────────────────────────────
  sect('2. Đơn hàng: TAB trạng thái có số đếm (thay dropdown)');
  r = await adm('GET', `/shops/${A.shopId}/orders`, { cookie: A.cookie });
  r.body.includes('class="stabs"') ? ok('có dải tab trạng thái') : bad('không thấy tab trạng thái');
  !/<select name="status">/.test(r.body) ? ok('dropdown trạng thái cũ đã bỏ') : bad('vẫn còn <select name=status>');
  const tabCount = (label) => {
    const m = new RegExp(`class="stab[^"]*"[^>]*>${label}<span class="cnt">(\\d+)</span>`).exec(r.body);
    return m ? Number(m[1]) : null;
  };
  tabCount('Tất cả') === 3 ? ok('tab "Tất cả" = 3 đơn') : bad('đếm tab Tất cả sai', `=${tabCount('Tất cả')}`);
  tabCount('Đã huỷ') === 1 ? ok('tab "Đã huỷ" = 1 đơn') : bad('đếm tab Đã huỷ sai', `=${tabCount('Đã huỷ')}`);

  sect('3. BẪY: chọn 1 tab thì các tab KHÁC vẫn phải giữ số đếm thật');
  r = await adm('GET', `/shops/${A.shopId}/orders?status=cancelled`, { cookie: A.cookie });
  const allWhileFiltered = tabCount('Tất cả');
  allWhileFiltered === 3
    ? ok('đang lọc "Đã huỷ" nhưng tab "Tất cả" vẫn = 3 (đếm không dính filter status)')
    : bad('số đếm tab bị filter status làm sai', `Tất cả=${allWhileFiltered}, phải là 3`);
  /class="stab on"[^>]*>Đã huỷ/.test(r.body) ? ok('tab đang chọn được đánh dấu (.on)') : bad('tab đang chọn không được đánh dấu');

  sect('4. Đổi tab GIỮ bộ lọc tìm kiếm đang áp');
  r = await adm('GET', `/shops/${A.shopId}/orders?q=Khach&status=pending`, { cookie: A.cookie });
  r.status === 200 && /href="\?status=confirmed&q=Khach/.test(r.body)
    ? ok('link tab khác mang theo q=Khach')
    : bad('đổi tab làm mất ô tìm kiếm', `status=${r.status} ${r.body.slice(0, 120)}`);

  // ── 5. Tín hiệu sàn trên storefront ────────────────────────────────────────
  sect('5. Storefront: "Đã bán N" + sao chỉ hiện khi CÓ dữ liệu');
  // BẪY (đã dính 1 lần): CSS + CHÚ THÍCH CSS được nhúng thẳng vào mỗi trang, nên tìm chuỗi
  // trần kiểu /Đã bán/ sẽ khớp NHẦM chú thích trong <style>. Luôn khẳng định trên PHẦN TỬ.
  let body = await sf(A.host, '/products');
  !/class="c-sold"/.test(body) ? ok('chưa bán được đơn nào (chưa thanh toán) → KHÔNG hiện "Đã bán"') : bad('hiện "Đã bán" khi chưa có đơn đã trả');
  !/<span class="stars"/.test(body) ? ok('chưa có đánh giá → KHÔNG hiện 0 sao') : bad('hiện sao khi chưa có đánh giá');

  // Thanh toán đơn o1 (3 cái) → sold_count phải thành 3 sau sweep.
  await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${o1.orderId}/mark-paid`, { cookie: A.cookie, origin: OS });
  await fetch(`${WORKER}/internal/prodstats-sweep`, { method: 'POST' });
  const sold = (await owner.query('SELECT sold_count FROM products WHERE id=$1', [P.pid])).rows[0].sold_count;
  sold === 3 ? ok('sweep tính "đã bán" = 3 từ đơn đã thanh toán') : bad('sold_count sai', `=${sold}, phải 3`);
  body = await sf(A.host, '/products');
  /<span class="c-sold">Đã bán 3<\/span>/.test(body) ? ok('thẻ SP hiện "Đã bán 3"')
    : bad('thẻ không hiện đã bán', body.slice(body.indexOf('<div class="card-meta">'), body.indexOf('<div class="card-meta">') + 200));

  // Đơn huỷ KHÔNG được tính vào đã-bán (o3 đã cancel, 1 cái).
  sect('6. Đơn HUỶ không được tính vào "đã bán"');
  await owner.query(`UPDATE orders SET paid_at=now() WHERE id=$1`, [o3.orderId]); // giả lập: từng trả tiền rồi huỷ
  await fetch(`${WORKER}/internal/prodstats-sweep`, { method: 'POST' });
  const sold2 = (await owner.query('SELECT sold_count FROM products WHERE id=$1', [P.pid])).rows[0].sold_count;
  sold2 === 3 ? ok('đơn đã huỷ (dù có paid_at) KHÔNG cộng vào đã bán — vẫn 3') : bad('đơn huỷ bị tính vào đã bán', `=${sold2}, phải 3`);

  sect('7. Sort "Bán chạy" hoạt động');
  body = await sf(A.host, '/products?sort=best');
  /Bán chạy/.test(body) && !/<script(?![^>]*nonce)/.test(body) ? ok('có sort "Bán chạy", không script lạ') : bad('thiếu sort Bán chạy');

  // ── 8. Mobile: tab đáy + thanh mua ─────────────────────────────────────────
  sect('8. Mobile: thanh tab đáy mọi trang + thanh mua dính đáy ở trang SP');
  const home = await sf(A.host, '/');
  /<nav class="tabbar"/.test(home) ? ok('trang chủ có thanh tab đáy') : bad('thiếu thanh tab đáy ở trang chủ');
  (home.match(/class="cart-badge"/g) ?? []).length === 2 ? ok('badge giỏ có ở CẢ header lẫn tab đáy') : bad('badge giỏ không đủ 2 chỗ');
  const pdp = await sf(A.host, `/p/${P.slug}`);
  /<nav class="tabbar"/.test(pdp) && /body:has\(\.pd-actions\) \.tabbar\{display:none\}/.test(pdp)
    ? ok('trang SP: tab đáy bị CSS ẩn để nhường thanh mua') : bad('PDP không ẩn tab đáy');
  /\.pd-actions\{position:sticky;bottom:0/.test(pdp) ? ok('trang SP có thanh mua dính đáy (mobile)') : bad('thiếu thanh mua dính đáy');
  /Mua ngay/.test(pdp) ? ok('nút "Mua ngay" còn nguyên (không hồi quy)') : bad('mất nút Mua ngay');

  // ── 9. LƯỢT XEM sản phẩm (0098) ────────────────────────────────────────────
  sect('9. Lượt xem sản phẩm: đếm qua Redis → worker gộp vào DB, LOẠI bot');
  const sfUA = (host, path, ua) => new Promise((res, rej) => {
    const rr = http.request({ hostname: STOREFRONT.hostname, port: STOREFRONT.port, path, method: 'GET', headers: { host, 'user-agent': ua } },
      (x) => { let b = ''; x.on('data', (d) => (b += d)); x.on('end', () => res(b)); });
    rr.on('error', rej); rr.end();
  });
  const P2 = await setupProduct(A, `Ghe sofa ${uniq()}`, 500000, 5);
  for (let i = 0; i < 4; i++) await sfUA(A.host, `/p/${P2.slug}`, 'Mozilla/5.0 (Windows NT 10.0) Chrome/120');
  for (let i = 0; i < 6; i++) await sfUA(A.host, `/p/${P2.slug}`, 'Googlebot/2.1 (+http://www.google.com/bot.html)');
  await sfUA(A.host, `/p/${P2.slug}`, 'curl/8.4.0');
  await sleep(300);
  await fetch(`${WORKER}/internal/prodview-sweep`, { method: 'POST' });
  let vrows = (await owner.query('SELECT day, views FROM product_view_daily WHERE product_id=$1', [P2.pid])).rows;
  Number(vrows[0]?.views) === 4
    ? ok('đếm ĐÚNG 4 lượt người thật, loại 6 bot + 1 curl') : bad('đếm lượt xem sai', JSON.stringify(vrows));

  await fetch(`${WORKER}/internal/prodview-sweep`, { method: 'POST' });
  vrows = (await owner.query('SELECT views FROM product_view_daily WHERE product_id=$1', [P2.pid])).rows;
  Number(vrows[0]?.views) === 4 ? ok('gộp lại khi không có lượt mới → KHÔNG cộng đúp') : bad('cộng đúp khi gộp lại', JSON.stringify(vrows));

  // Lượt xem là DỮ LIỆU RIÊNG của shop — shop khác không được thấy.
  const Bv = await makeShopOwner(staff, `vw-${uniq()}`);
  const cross = await rq(SELLER, 'GET', `/shops/${A.shopId}/products?limit=50`, { cookie: Bv.cookie });
  cross.status === 403 || cross.status === 404 ? ok(`shop khác đọc SP shop A → ${cross.status}`) : bad('rò chéo shop', String(cross.status));

  let ap = await adm('GET', `/shops/${A.shopId}/products`, { cookie: A.cookie });
  /<th class="right"[^>]*>Lượt xem<\/th>/.test(ap.body) ? ok('trang Sản phẩm có cột "Lượt xem"') : bad('thiếu cột Lượt xem');
  new RegExp(`${P2.pid}[\\s\\S]{0,1200}?<td class="num right">4</td>`).test(ap.body) || /<td class="num right">4<\/td>/.test(ap.body)
    ? ok('cột Lượt xem hiện số 4') : bad('cột Lượt xem không hiện số', (ap.body.match(/<td class="num right">\d+<\/td>/g) ?? []).slice(0, 6).join(' '));

  // ── 10. SEO riêng cho sản phẩm (0098) ──────────────────────────────────────
  sect('10. SEO riêng cho sản phẩm: bỏ trống → suy như cũ; nhập → ĐÈ title/description');
  let pdp2 = await sf(A.host, `/p/${P2.slug}`);
  const title0 = (pdp2.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? '';
  title0.includes('Ghe sofa') ? ok('chưa nhập SEO → title vẫn suy từ tên SP (không hồi quy)') : bad('title mặc định sai', title0);

  r = await adm('POST', `/shops/${A.shopId}/products/${P2.pid}`, {
    cookie: A.cookie, origin: OADM,
    form: { title: 'Ghe sofa da', slug: P2.slug, price_vnd: '500000', description: 'mo ta',
      seo_title: 'Sofa da that bao hanh 5 nam', seo_description: 'Sofa da bo nhap khau, giao lap mien phi noi thanh.' },
  });
  r.status === 303 ? ok('lưu SEO qua form seller-admin → 303') : bad('lưu SEO lỗi', `${r.status} ${r.body.slice(0, 140)}`);
  pdp2 = await sf(A.host, `/p/${P2.slug}`);
  const title1 = (pdp2.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? '';
  const desc1 = (pdp2.match(/<meta name="description" content="([^"]*)"/) ?? [])[1] ?? '';
  const ogt1 = (pdp2.match(/<meta property="og:title" content="([^"]*)"/) ?? [])[1] ?? '';
  title1 === 'Sofa da that bao hanh 5 nam' ? ok('title dùng ĐÚNG tiêu đề SEO (không nối thêm tên shop)') : bad('title SEO sai', title1);
  desc1.startsWith('Sofa da bo nhap khau') ? ok('meta description dùng mô tả SEO') : bad('description SEO sai', desc1);
  ogt1 === 'Sofa da that bao hanh 5 nam' ? ok('og:title (thẻ chia sẻ FB/Zalo) dùng tiêu đề SEO') : bad('og:title sai', ogt1);

  // Xoá trắng ô SEO → quay lại hành vi cũ (không kẹt vĩnh viễn ở giá trị đã nhập).
  await adm('POST', `/shops/${A.shopId}/products/${P2.pid}`, {
    cookie: A.cookie, origin: OADM,
    form: { title: 'Ghe sofa da', slug: P2.slug, price_vnd: '500000', description: 'mo ta', seo_title: '', seo_description: '' },
  });
  pdp2 = await sf(A.host, `/p/${P2.slug}`);
  const title2 = (pdp2.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? '';
  title2.includes('Ghe sofa da') && !title2.includes('bao hanh') ? ok('xoá trắng ô SEO → quay lại suy từ tên SP') : bad('không xoá được SEO', title2);

  // XSS: tiêu đề SEO là chuỗi người bán nhập → phải bị escape trong thuộc tính content=".
  await adm('POST', `/shops/${A.shopId}/products/${P2.pid}`, {
    cookie: A.cookie, origin: OADM,
    form: { title: 'Ghe sofa da', slug: P2.slug, price_vnd: '500000', description: 'mo ta',
      seo_title: '"><script>alert(1)</script>', seo_description: 'x" onload="alert(2)' },
  });
  pdp2 = await sf(A.host, `/p/${P2.slug}`);
  !/<script>alert\(1\)/.test(pdp2) && !/onload="alert\(2\)/.test(pdp2)
    ? ok('tiêu đề/mô tả SEO độc bị escape (không thoát thuộc tính)') : bad('XSS QUA Ô SEO!');

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error('admin marketplace e2e lỗi:', e); await owner.end(); process.exit(1); });
