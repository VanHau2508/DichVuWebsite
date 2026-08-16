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
// Mời thêm một thành viên ở vai KHÁC owner. Cần vì mọi bộ e2e hiện có đều đăng nhập bằng
// owner — vai có sẵn mọi quyền — nên không bộ nào đi qua nhánh thiếu quyền của giao diện.
async function addMember(staffCookie, shopId, role) {
  const email = `m-${uniq()}@shop.vn`, password = 'member passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { email, password, cookie: await login(email, password) };
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
  // `&migrated=0` là phần BẮT BUỘC của link, không phải trang trí: con số trên ô được
  // dashboard.js đếm với `WHERE NOT is_migrated`, còn danh sách đơn mặc định KHÔNG lọc cờ đó
  // (đơn nhập từ sàn cũ phải tra cứu được — 0104). Thiếu nó là ô đếm một tập, mở ra tập khác.
  has(new RegExp(`href="/shops/${A.shopId}/orders\\?status=pending&migrated=0"`))
    && has(new RegExp(`href="/shops/${A.shopId}/orders\\?status=confirmed&migrated=0"`))
    ? ok('ô việc link tới trang đơn ĐÃ LỌC SẴN đúng trạng thái, không kể đơn di cư') : bad('link ô việc sai');
  has(new RegExp(`href="/shops/${A.shopId}/orders\\?payment=unpaid"`))
    && has(new RegExp(`href="/shops/${A.shopId}/orders\\?payment=pending"`))
    && has(new RegExp(`href="/shops/${A.shopId}/resolution-cases\\?status=active"`))
    && has(new RegExp(`href="/shops/${A.shopId}/notification-deliveries\\?status=failed"`))
    && has(new RegExp(`href="/shops/${A.shopId}/order-requests\\?status=requested"`))
    ? ok('ô tiền và hàng đợi mới đều link tới đúng danh sách đã lọc') : bad('thiếu link hàng đợi dashboard');
  // Số thật: 1 chờ xác nhận (o2), 1 chờ gửi (o1 đã confirmed).
  const cellOf = (label) => {
    const m = new RegExp(`<div class="todo-n"[^>]*>(\\d+)</div>\\s*<div class="todo-l">[^<]*${label}`).exec(r.body);
    return m ? Number(m[1]) : null;
  };
  cellOf('Đơn chờ xác nhận') === 1 ? ok('đếm "chờ xác nhận" = 1 (khớp dữ liệu thật)') : bad('đếm chờ xác nhận sai', `=${cellOf('Đơn chờ xác nhận')}`);
  cellOf('Đơn chờ gửi hàng') === 1 ? ok('đếm "chờ gửi hàng" = 1 (khớp dữ liệu thật)') : bad('đếm chờ gửi sai', `=${cellOf('Đơn chờ gửi hàng')}`);
  cellOf('Đơn chưa thu tiền') === 2 ? ok('đếm "chưa thu tiền" chỉ gồm đơn sống chưa nhận khoản nào') : bad('đếm chưa thu sai', `=${cellOf('Đơn chưa thu tiền')}`);
  cellOf('Đơn thu một phần') === 0 ? ok('đếm "thu một phần" không lẫn đơn unpaid') : bad('đếm thu một phần sai', `=${cellOf('Đơn thu một phần')}`);
  cellOf('Ca giao hàng cần xử lý') === 0 && cellOf('Thông báo gửi thất bại') === 0 && cellOf('Yêu cầu khách chờ xử lý') === 0
    ? ok('các hàng đợi resolution/notification/customer request mới đang rỗng đúng fixture')
    : bad('đếm hàng đợi mới sai');
  !/<script(?![^>]*nonce=)/.test(r.body) ? ok('Tổng quan: không script NÀO thiếu nonce (ADR-011)') : bad('lọt <script> không nonce');

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
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: A.password }, cookie: A.cookie, origin: OA });
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
  // Đổi cơ chế: trước đây tab đáy VẪN được phát rồi nhờ CSS `body:has(.pd-actions)` ẩn đi.
  // :has() chỉ có từ Chrome 105/Safari 15.4/Firefox 121 — trình duyệt cũ bỏ qua luật đó thì
  // tab đáy (z-index 60, fixed) ĐÈ LÊN thanh mua (z-index 55) và che nút "Thêm vào giỏ".
  // Nay SERVER quyết: trang có thanh mua thì KHÔNG phát thẻ tab đáy nữa. Khẳng định đổi
  // theo — và chặt hơn, vì "không có thẻ" đúng trên mọi trình duyệt, còn "có thẻ + có luật
  // CSS" chỉ đúng trên trình duyệt hiểu luật đó.
  if (/class="pd-actions"/.test(pdp)) {
    !/<nav class="tabbar"/.test(pdp) && /<body class="[^"]*has-buybar/.test(pdp)
      ? ok('trang SP có thanh mua: KHÔNG phát tab đáy (không phụ thuộc :has())')
      : bad('PDP vẫn phát tab đáy → che nút mua trên trình duyệt cũ');
  } else {
    /<nav class="tabbar"/.test(pdp) ? ok('trang SP hết hàng (không thanh mua): vẫn có tab đáy')
      : bad('PDP không thanh mua mà cũng mất tab đáy');
  }
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

  // ── 11. Lưới việc: LỌC THEO VAI, và con số dẫn tới ĐÚNG tập nó đếm ─────────
  //
  // Đặt CUỐI cùng có chủ ý: mục này lật cờ is_migrated của một đơn có thật, mà mục 1–3 đang
  // khẳng định số đếm trên hộp việc và trên tab. Chạy trước là làm hỏng chứng cứ của chúng.
  sect('11. Việc cần làm: lọc theo vai + con số khớp danh sách sau khi bấm');

  // (a) VAI. `order_manager` chỉ có orders.read/write. Trang /reviews đòi content.write và
  // /products đòi catalog.read, nên hai ô đó với họ là hai cái nút dẫn thẳng vào 403 — trong
  // khi thanh điều hướng đã giấu đúng hai mục ấy. Đây là ca không bộ e2e nào từng đi qua:
  // mọi bộ đều đăng nhập bằng owner, vai có sẵn mọi quyền.
  const om = await addMember(staff, A.shopId, 'order_manager');
  const omOv = await adm('GET', `/shops/${A.shopId}/overview`, { cookie: om.cookie });
  omOv.status === 200 ? ok('order_manager mở được Tổng quan') : bad('order_manager không mở được Tổng quan', String(omOv.status));
  // Chỉ xét các ô trong lưới TODO. Trang còn một card tồn thấp lịch sử ở phần báo cáo phía
  // dưới; tìm chữ trên toàn HTML sẽ kết luận nhầm rằng ô TODO vẫn hiện dù `.filter(see)` đã
  // bỏ nó. Chốt vào đúng bề mặt người dùng đang kiểm, không dựa vào nhãn có thể xuất hiện ở
  // một khối khác.
  const omTodo = [...omOv.body.matchAll(/<a class="todo-cell[^"]*"[^>]*>[\s\S]*?<\/a>/g)]
    .map((m) => m[0]).join('\n');
  !/Đánh giá chờ duyệt/.test(omTodo) && !/Sắp hết hàng/.test(omTodo)
    ? ok('order_manager KHÔNG thấy ô "Đánh giá chờ duyệt" và "Sắp hết hàng"')
    : bad('lưới việc vẫn mời vai thiếu quyền bấm vào trang sẽ 403');
  /Đơn chờ xác nhận/.test(omTodo)
    ? ok('order_manager vẫn thấy đủ ô đơn hàng thuộc phạm vi của mình') : bad('lọc quyền cắt nhầm ô đơn hàng');
  // Chứng minh tiền đề: hai trang đó THẬT SỰ từ chối vai này. Không có bước này thì khẳng
  // định trên chỉ nói "ô bị ẩn", không nói được "ẩn vì đúng lý do".
  const omRv = await adm('GET', `/shops/${A.shopId}/reviews?status=pending`, { cookie: om.cookie });
  const omSp = await adm('GET', `/shops/${A.shopId}/products?stock=low`, { cookie: om.cookie });
  omRv.status === 403 && omSp.status === 403
    ? ok('và đúng là hai trang đó trả 403 cho order_manager (ẩn vì có lý do, không phải tuỳ tiện)')
    : bad('tiền đề sai — trang đích không hề chặn vai này', `reviews=${omRv.status} products=${omSp.status}`);

  // (b) VAI KHÔNG CÓ orders.read. `catalog_manager` từng bị đẩy thẳng tới /overview sau khi
  // đăng nhập → 403 → trang lỗi, mà sideNav cũng ẩn "Tổng quan" khỏi họ nên không còn mục nào
  // để bấm lùi. Đăng nhập xong là gặp lỗi, mọi lần.
  const cm = await addMember(staff, A.shopId, 'catalog_manager');
  const cmHome = await adm('GET', '/', { cookie: cm.cookie });
  cmHome.status === 303 && (cmHome.location ?? '').endsWith(`/shops/${A.shopId}/products`)
    ? ok('catalog_manager đăng nhập → vào thẳng Quản lý sản phẩm, không bị ném vào Tổng quan')
    : bad('vai thiếu orders.read vẫn bị đẩy vào Tổng quan', `${cmHome.status} → ${cmHome.location}`);
  const cmOv = await adm('GET', `/shops/${A.shopId}/overview`, { cookie: cm.cookie });
  cmOv.status === 403 && /không xem được Tổng quan/.test(cmOv.body)
    && new RegExp(`href="/shops/${A.shopId}/products"`).test(cmOv.body)
    ? ok('vào thẳng URL Tổng quan → nói đúng lý do và chỉ ra màn hình họ mở được')
    : bad('trang 403 vẫn nói như hệ thống hỏng', `${cmOv.status} ${cmOv.body.slice(0, 200)}`);

  // (c) CON SỐ DẪN TỚI ĐÚNG TẬP. Biến đơn đã huỷ (o3) thành đơn nhập từ sàn cũ: Tổng quan
  // phải thôi đếm nó, và link từ Tổng quan phải mở ra đúng tập đã thôi đếm đó.
  await owner.query('UPDATE orders SET is_migrated=true WHERE id=$1', [o3.orderId]);
  const ovM = await adm('GET', `/shops/${A.shopId}/overview`, { cookie: A.cookie });
  const theHuy = /<div class="l"><span class="sdot"[^>]*><\/span>Đã huỷ<\/div><div class="v">(\d+)<\/div>/.exec(ovM.body)?.[1];
  theHuy === '0' ? ok('Tổng quan thôi đếm đơn di cư (thẻ "Đã huỷ" = 0)') : bad('Tổng quan vẫn đếm đơn di cư', `=${theHuy}`);
  const demDong = (b) => (b.match(/<td><a href="\/shops\/[^"]*\/orders\/[^"]*">#/g) ?? []).length;
  const dsTran = await adm('GET', `/shops/${A.shopId}/orders?status=cancelled`, { cookie: A.cookie });
  const dsLoc = await adm('GET', `/shops/${A.shopId}/orders?status=cancelled&migrated=0`, { cookie: A.cookie });
  demDong(dsTran.body) === 1 && demDong(dsLoc.body) === 0
    ? ok('danh sách trần vẫn TRA CỨU được đơn di cư (1 dòng), còn link từ Tổng quan mở ra 0 dòng — khớp con số')
    : bad('bộ lọc migrated không khớp con số trên Tổng quan', `trần=${demDong(dsTran.body)} lọc=${demDong(dsLoc.body)}`);
  /Đang lọc:/.test(dsLoc.body) && /Không gồm đơn nhập từ sàn cũ/.test(dsLoc.body) && /Xoá bộ lọc/.test(dsLoc.body)
    ? ok('trang nói rõ đang lọc gì và có lối xoá — không để người bán nhìn tập hẹp mà tưởng là tất cả')
    : bad('lọc im lặng, không có chip "đang lọc"');
  const dsRac = await adm('GET', `/shops/${A.shopId}/orders?status=cancelled&migrated=xyz`, { cookie: A.cookie });
  demDong(dsRac.body) === 1 && !/Đang lọc:/.test(dsRac.body)
    ? ok('giá trị migrated rác bị bỏ qua như mọi bộ lọc khác (không vỡ trang, không chip giả)')
    : bad('migrated rác không được chuẩn hoá', `${demDong(dsRac.body)} dòng`);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error('admin marketplace e2e lỗi:', e); await owner.end(); process.exit(1); });
