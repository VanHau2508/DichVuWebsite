/**
 * End-to-end storefront công khai. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/storefront/test/e2e.mjs
 *
 * Kiểm: domain→shop, chỉ hiện sản phẩm active (ẩn draft), escape XSS, sanitize
 * token theme, cô lập chéo shop, trang bảo trì khi suspended, 404 domain lạ.
 *
 * Dùng node:http (không phải fetch) để đặt được header Host = subdomain của shop.
 */

import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const STORE = new URL(process.env.STOREFRONT_URL ?? 'http://storefront:3050');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
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
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;

// Gọi storefront với Host = domain của shop (node:http cho phép đặt Host).
function sf(host, path = '/') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: STORE.hostname, port: STORE.port, path, method: 'GET', headers: { host } },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); },
    );
    req.on('error', reject);
    req.end();
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
const mkProduct = (shopId, cookie, body) => rq(SELLER, 'POST', `/shops/${shopId}/products`, { body, cookie, origin: OS });

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `store-${uniq()}`);

  const XSS = `<script>alert('xss')</script>Áo Thun Đỏ`;
  const activeSlug = `active-${uniq()}`;
  await mkProduct(A.shopId, A.cookie, { title: XSS, slug: activeSlug, price_vnd: 250000, status: 'active', variants: [{ sku: `A-${uniq()}`, price_vnd: 250000 }] });
  const draftSlug = `draft-${uniq()}`;
  await mkProduct(A.shopId, A.cookie, { title: 'SẢN PHẨM NHÁP BÍ MẬT', slug: draftSlug, price_vnd: 1, variants: [{ sku: `D-${uniq()}`, price_vnd: 1 }] });

  // Theme: một token HỢP LỆ + một token ĐỘC (phải bị sanitize).
  await rq(SELLER, 'PUT', `/shops/${A.shopId}/theme`, {
    body: { tokens: { color: { primary: '#22c55e', bg: 'red;}evilrule{display:none' } } },
    cookie: A.cookie, origin: OS,
  });
  ok('dựng shop + sản phẩm active/draft + theme');

  // ── 1. Trang chủ ───────────────────────────────────────────────────────────
  sect('1. Trang chủ (domain→shop, active-only, escape, token)');
  let r = await sf(A.host, '/');
  r.status === 200 && r.headers['x-shop-slug'] === A.slug ? ok(`home 200, X-Shop-Slug=${A.slug}`) : bad('home lỗi', `status=${r.status} slug=${r.headers['x-shop-slug']}`);

  !r.body.includes('<script>alert') && r.body.includes('&lt;script&gt;')
    ? ok('tên sản phẩm chứa XSS được ESCAPE (không có <script> thô)') : bad('XSS không escape', 'body chứa <script> thô');

  !r.body.includes('SẢN PHẨM NHÁP BÍ MẬT') ? ok('sản phẩm DRAFT KHÔNG hiện trên storefront') : bad('draft bị lộ');

  r.body.includes('--color-primary: #22c55e') ? ok('token hợp lệ (#22c55e) được áp') : bad('token hợp lệ không áp', 'thiếu --color-primary');
  // Token độc `red;}evilrule{display:none` phải bị sanitize: marker `evilrule` KHÔNG được
  // xuất hiện (display:none là CSS hợp lệ của gallery nên không dùng làm dấu hiệu nữa).
  !r.body.includes('evilrule')
    ? ok('token ĐỘC bị sanitize (không breakout CSS)') : bad('token độc breakout', 'body chứa evilrule');

  // CSP: lớp phòng thủ XSS thứ hai. Trang có badge giỏ → script-src CHỈ nonce (KHÔNG unsafe-inline,
  // KHÔNG script ngoài); default-src vẫn 'none'; frame-ancestors 'none'. Nonce có mặt trong CẢ
  // header lẫn thân HTML (<script nonce>).
  const csp = r.headers['content-security-policy'] ?? '';
  const scriptSrc = (csp.match(/script-src ([^;]*)/) || [])[1] || '';
  csp.includes("default-src 'none'")
    && /'nonce-[A-Za-z0-9+/=]+'/.test(scriptSrc) && !scriptSrc.includes("'unsafe-inline'")
    && csp.includes("frame-ancestors 'none'")
    ? ok('CSP: script-src CHỈ nonce (không unsafe-inline), default-src none, chống clickjacking') : bad('CSP thiếu/lỏng', csp);
  // Nonce trong CSP phải KHỚP thuộc tính <script nonce> trong thân (script badge giỏ chạy được).
  const nonceInCsp = (scriptSrc.match(/'nonce-([A-Za-z0-9+/=]+)'/) || [])[1];
  nonceInCsp && r.body.includes(`<script nonce="${nonceInCsp}">`) && r.body.includes("fetch('/cart/summary'")
    ? ok('badge giỏ: <script nonce> khớp CSP + fetch /cart/summary') : bad('nonce/script badge không khớp', scriptSrc);
  r.headers['x-frame-options'] === 'DENY' ? ok('X-Frame-Options: DENY') : bad('thiếu X-Frame-Options');

  // ── 1b. Drawer giỏ hàng (Phase 2): shell TĨNH, cache-CDN-an-toàn ───────────
  sect('1b. Drawer giỏ hàng (shell tĩnh)');
  const aside = (r.body.match(/<aside id="cart-drawer"[\s\S]*?<\/aside>/) || [])[0] || '';
  aside && aside.includes('role="dialog"') && aside.includes('aria-modal="true"') && aside.includes('aria-label="Giỏ hàng"') && aside.includes(' hidden')
    && r.body.includes('<div id="cart-backdrop" hidden></div>')
    ? ok('shell: <aside role=dialog aria-modal hidden> + backdrop hidden') : bad('thiếu/sai drawer shell', aside.slice(0, 200) || 'không có <aside id="cart-drawer">');
  aside.includes('Giỏ hàng') && aside.includes('Tạm tính') && aside.includes('href="/checkout"') && aside.includes('Thanh toán') && aside.includes('href="/cart"')
    ? ok('shell: nhãn tĩnh tiếng Việt + link /checkout + /cart') : bad('drawer thiếu nhãn/link tĩnh');
  r.body.includes('<template id="cd-empty-tpl">') && r.body.includes('Giỏ hàng trống')
    ? ok('template trạng-thái-rỗng tĩnh (JS clone, không innerHTML)') : bad('thiếu template giỏ rỗng');
  // Trang cache CDN ~60s dùng chung mọi khách → shell KHÔNG được server-render dữ liệu giỏ/SP:
  // không tên SP, không giá (₫ + số), vùng item + subtotal rỗng chờ JS.
  !aside.includes('Áo Thun') && !aside.includes('cd-row') && !/\d\s*₫/.test(aside) && aside.includes('<div class="cd-items" id="cd-items" aria-live="polite"></div>') && aside.includes('<strong id="cd-subtotal"></strong>')
    ? ok('shell KHÔNG chứa dữ liệu giỏ/sản phẩm server-side (cache-safe)') : bad('drawer lộ dữ liệu per-user vào trang cache', aside);
  // Vẫn đúng 1 khối <script nonce> duy nhất (drawer mở rộng script badge, không thêm khối mới).
  (r.body.match(/<script/g) || []).length === 1
    ? ok('vẫn CHỈ 1 khối <script nonce> duy nhất (badge + drawer chung)') : bad('số khối <script> khác 1', String((r.body.match(/<script/g) || []).length));
  r.body.includes("fetch('/cart/update'") && r.body.includes("fetch('/cart/add'") && r.body.includes("name==='buynow'")
    ? ok('script drawer: POST /cart/update + chặn /cart/add trừ Mua ngay (buynow)') : bad('script drawer thiếu logic update/add');

  // ── 2. Chi tiết sản phẩm ───────────────────────────────────────────────────
  sect('2. Chi tiết sản phẩm');
  r = await sf(A.host, `/p/${activeSlug}`);
  r.status === 200 && r.body.includes('&lt;script&gt;') ? ok('chi tiết sản phẩm active → 200') : bad('chi tiết active lỗi', String(r.status));
  r = await sf(A.host, `/p/${draftSlug}`);
  r.status === 404 ? ok('chi tiết sản phẩm DRAFT → 404 (không lộ)') : bad('draft detail lộ', String(r.status));

  // ── 3. Cô lập chéo shop ────────────────────────────────────────────────────
  sect('3. Cô lập chéo shop');
  const Bs = await makeShopOwner(staff, `storeb-${uniq()}`);
  await mkProduct(Bs.shopId, Bs.cookie, { title: 'HÀNG CỦA SHOP B', slug: `b-${uniq()}`, price_vnd: 1, status: 'active', variants: [{ sku: `B-${uniq()}`, price_vnd: 1 }] });
  r = await sf(A.host, '/');
  !r.body.includes('HÀNG CỦA SHOP B') ? ok('storefront A KHÔNG hiện sản phẩm shop B (RLS)') : bad('rò sản phẩm chéo shop');
  r = await sf(Bs.host, '/');
  r.body.includes('HÀNG CỦA SHOP B') && r.headers['x-shop-slug'] === Bs.slug ? ok('storefront B hiện đúng hàng của B') : bad('storefront B sai', r.headers['x-shop-slug']);

  // ── 4. Domain lạ / chưa verify ─────────────────────────────────────────────
  sect('4. Domain lạ / chưa verify');
  r = await sf(`khong-ton-tai-${uniq()}.nentang.vn`, '/');
  r.status === 404 ? ok('domain chưa kết nối → 404') : bad('domain lạ không 404', String(r.status));
  // shopb.test (seed): có trong domains nhưng verified_at NULL → KHÔNG được route.
  r = await sf('shopb.test', '/');
  r.status === 404 ? ok('domain CHƯA verify (shopb.test) → 404 (chống chiếm domain)') : bad('domain chưa verify vẫn route', String(r.status));

  // ── 5. Bảo trì khi suspended ───────────────────────────────────────────────
  sect('5. Trang bảo trì khi shop suspended');
  // suspend/restore là thao tác phá hoại đòi step-up 5' (đợt 4.4) — xác thực lại trước.
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: 'staff strong passphrase' }, cookie: staff, origin: OA });
  await rq(PLATFORM, 'POST', `/ops/shops/${A.shopId}/suspend`, { body: { reason: 'test' }, cookie: staff, origin: OO });
  r = await sf(A.host, '/');
  r.status === 503 && !r.body.includes('&lt;script&gt;') ? ok('shop suspended → 503 trang bảo trì (không render sản phẩm)') : bad('suspended vẫn render', String(r.status));
  await rq(PLATFORM, 'POST', `/ops/shops/${A.shopId}/restore`, { cookie: staff, origin: OO });
  r = await sf(A.host, '/');
  r.status === 200 ? ok('restore → storefront hoạt động lại (200)') : bad('restore không phục hồi', String(r.status));

  // ── 6. Trang sản phẩm ĐA TRỤC (chip biến thể + specs + Mua ngay + đổi giá theo biến thể) ──
  sect('6. Trang sản phẩm đa trục (no-JS)');
  const axSlug = `axis-${uniq()}`;
  const axPid = (await mkProduct(A.shopId, A.cookie, { title: 'Thảm đa trục', slug: axSlug, price_vnd: 500000, status: 'active', variants: [{ sku: `AX-${uniq()}`, price_vnd: 500000 }] })).json.id;
  await rq(SELLER, 'PUT', `/shops/${A.shopId}/products/${axPid}/options`, { body: { options: [{ name: 'Màu', values: ['Đỏ', 'Xanh'] }, { name: 'Size', values: ['M', 'L'] }] }, cookie: A.cookie, origin: OS });
  await rq(SELLER, 'PUT', `/shops/${A.shopId}/products/${axPid}/specs`, { body: { specs: [{ name: 'Chất liệu', value: 'Polyester' }] }, cookie: A.cookie, origin: OS });
  // Đặt tồn + giá RIÊNG cho từng biến thể (để kiểm giá đổi theo ?variant=).
  const vrows = (await owner.query(`SELECT id, title FROM variants WHERE product_id=$1 ORDER BY position`, [axPid])).rows;
  for (let i = 0; i < vrows.length; i++) {
    await owner.query(`UPDATE variants SET price_vnd = $2 WHERE id = $1`, [vrows[i].id, 500000 + i * 10000]);
    await owner.query(`INSERT INTO inventory_levels (shop_id, variant_id, on_hand) VALUES ($1,$2,50) ON CONFLICT (shop_id,variant_id) DO UPDATE SET on_hand=50`, [A.shopId, vrows[i].id]);
  }
  let pr = await sf(A.host, `/p/${axSlug}`);
  pr.status === 200 ? ok('trang SP đa trục 200') : bad('SP đa trục lỗi', String(pr.status));
  pr.body.includes('class="chip') && pr.body.includes('>Đỏ<') && pr.body.includes('>Xanh<') && pr.body.includes('Size')
    ? ok('hiện chip 2 trục (Màu: Đỏ/Xanh + Size)') : bad('thiếu chip trục');
  pr.body.includes('Mua ngay') && pr.body.includes('name="buynow"') ? ok('nút "Mua ngay" (buynow)') : bad('thiếu Mua ngay');
  pr.body.includes('class="specs"') && pr.body.includes('Chất liệu') ? ok('bảng thông số hiển thị') : bad('thiếu specs');
  pr.body.includes('id="gsel-0"') || pr.body.includes('class="pd-media"') ? ok('khối gallery render') : bad('thiếu gallery');
  // ?variant= biến thể cuối → giá của nó (500000 + 3*10000 = 530.000) + chip đánh dấu.
  const lastV = vrows[vrows.length - 1].id;
  pr = await sf(A.host, `/p/${axSlug}?variant=${lastV}`);
  pr.body.includes('aria-current="true"') ? ok('?variant= → chip đang chọn được đánh dấu') : bad('không đánh dấu chip chọn');
  pr.body.includes('530.000') ? ok('giá ĐỔI theo biến thể đang chọn (530.000)') : bad('giá không đổi theo biến thể', 'thiếu 530.000');

  // ── 7. Tìm kiếm KHÔNG DẤU (0048) ────────────────────────────────────────────
  sect('7. Tìm kiếm không dấu');
  r = await sf(A.host, `/search?q=${encodeURIComponent('ao thun do')}`);
  r.status === 200 && r.body.includes('Áo Thun Đỏ') ? ok('"ao thun do" (không dấu) → tìm ra "Áo Thun Đỏ"') : bad('tìm không dấu fail', String(r.status));
  r = await sf(A.host, `/search?q=${encodeURIComponent('Áo Thun')}`);
  r.body.includes('Áo Thun Đỏ') ? ok('có dấu vẫn tìm ra (tương thích cũ)') : bad('tìm có dấu hỏng');
  r = await sf(A.host, `/search?q=khongtontai${uniq()}`);
  !r.body.includes('Áo Thun Đỏ') ? ok('từ khoá lạ → không ra kết quả sai') : bad('tìm ra kết quả ma');

  // ── 8. Đợt 5.2: tìm ĐẢO TỪ + SKU, lọc còn hàng/giá, canonical phân trang ────
  sect('8. Tìm đảo từ + SKU, lọc, canonical phân trang');
  const rugSku = `RUG-${uniq()}`.toUpperCase();
  const rugPid = (await mkProduct(A.shopId, A.cookie, { title: 'Thảm trải sàn cao cấp', slug: `rug-${uniq()}`, price_vnd: 350000, status: 'active', variants: [{ sku: rugSku, price_vnd: 350000 }] })).json.id;
  const rugV = (await owner.query(`SELECT id FROM variants WHERE product_id=$1`, [rugPid])).rows[0].id;
  await owner.query(`INSERT INTO inventory_levels (shop_id, variant_id, on_hand) VALUES ($1,$2,10) ON CONFLICT (shop_id,variant_id) DO UPDATE SET on_hand=10`, [A.shopId, rugV]);
  r = await sf(A.host, `/search?q=${encodeURIComponent('trai tham')}`);
  r.body.includes('Thảm trải sàn cao cấp') ? ok('"trai tham" (ĐẢO TỪ) vẫn tìm ra "Thảm trải sàn..."') : bad('đảo từ không ra', String(r.status));
  !r.body.includes('Thảm đa trục') ? ok('AND theo token: "trai tham" KHÔNG ra "Thảm đa trục"') : bad('AND token sai — ra cả SP chỉ khớp 1 từ');
  r = await sf(A.host, `/search?q=${encodeURIComponent(rugSku)}`);
  r.body.includes('Thảm trải sàn cao cấp') ? ok('tìm theo SKU biến thể ra sản phẩm') : bad('tìm SKU fail');
  // Lọc: "ao thun do" (XSS product) KHÔNG có tồn → instock=1 phải ẩn nó.
  r = await sf(A.host, `/search?q=${encodeURIComponent('ao thun do')}&instock=1`);
  !r.body.includes('Áo Thun Đỏ') ? ok('?instock=1 ẩn sản phẩm hết hàng') : bad('instock=1 vẫn hiện SP hết hàng');
  r = await sf(A.host, `/search?q=${encodeURIComponent('trai tham')}&instock=1`);
  r.body.includes('Thảm trải sàn cao cấp') && r.body.includes('name="instock"') && r.body.includes('Áp dụng')
    ? ok('?instock=1 giữ SP còn hàng + form lọc no-JS render') : bad('instock giữ hàng còn / form lọc thiếu');
  r = await sf(A.host, `/search?q=${encodeURIComponent('trai tham')}&pmin=400000`);
  !r.body.includes('Thảm trải sàn cao cấp') ? ok('?pmin=400000 loại SP giá 350k') : bad('pmin không lọc');
  r = await sf(A.host, `/search?q=${encodeURIComponent('trai tham')}&pmax=400000`);
  r.body.includes('Thảm trải sàn cao cấp') && r.body.includes('pmax=400000')
    ? ok('?pmax=400000 giữ SP giá 350k + link mang theo bộ lọc') : bad('pmax lọc sai / link rơi lọc');
  r = await sf(A.host, `/search?q=${encodeURIComponent('trai tham')}&pmin=abc`);
  r.body.includes('Thảm trải sàn cao cấp') ? ok('pmin không hợp lệ bị BỎ QUA (không 500/không lọc bậy)') : bad('pmin rác phá kết quả');
  // Canonical phân trang (#28): trang 2 canonical về CHÍNH NÓ, kèm rel=prev.
  r = await sf(A.host, '/?page=2');
  r.body.includes(`<link rel="canonical" href="https://${A.host}/?page=2">`) ? ok('canonical /?page=2 chứa page=2 (không gộp về trang 1)') : bad('canonical trang 2 sai', r.body.match(/rel="canonical"[^>]*/)?.[0]);
  r.body.includes(`<link rel="prev" href="https://${A.host}/">`) ? ok('trang 2 có rel=prev về trang 1 (URL sạch)') : bad('thiếu rel=prev');
  r = await sf(A.host, '/');
  r.body.includes(`<link rel="canonical" href="https://${A.host}/">`) && !r.body.includes('?page=1') ? ok('trang 1 canonical URL sạch (không ?page=1)') : bad('canonical trang 1 sai');

  // ── 9. Block ẢNH trong trang nội dung (escape + CSP-sạch) ───────────────────
  sect('9. Block ảnh CMS (escape)');
  const FAKE_MEDIA = `${A.shopId}/00000000-0000-4000-8000-000000000000.webp`;
  const pgSlug = `anh-${uniq()}`;
  let pg = await rq(SELLER, 'POST', `/shops/${A.shopId}/pages`, { body: { slug: pgSlug, title: 'Trang có ảnh', blocks: [
    { type: 'paragraph', text: 'Đoạn mở đầu' },
    { type: 'image', key: FAKE_MEDIA, alt: `"><script>alert('img')</script>`, caption: 'Chú thích <b>đậm</b>' },
  ] }, cookie: A.cookie, origin: OS });
  pg.status === 201 ? ok('tạo trang với block image (key media hợp lệ) → 201') : bad('tạo trang image fail', JSON.stringify(pg.json));
  await rq(SELLER, 'POST', `/shops/${A.shopId}/pages/${pg.json.id}/publish`, { body: {}, cookie: A.cookie, origin: OS });
  r = await sf(A.host, `/pages/${pgSlug}`);
  r.body.includes('<figure') && r.body.includes(`/media-public/${FAKE_MEDIA}`) ? ok('block image render <figure><img src=/media-public/key>') : bad('block image không render', String(r.status));
  !r.body.includes(`<script>alert('img')`) && r.body.includes('&lt;script&gt;') ? ok('alt chứa <script> được ESCAPE') : bad('alt XSS không escape');
  !r.body.includes('<b>đậm</b>') ? ok('caption HTML được escape') : bad('caption HTML thô lọt');
  const badKey = await rq(SELLER, 'POST', `/shops/${A.shopId}/pages`, { body: { slug: `bad-${uniq()}`, title: 'x', blocks: [{ type: 'image', key: '../../etc/passwd', alt: 'x' }] }, cookie: A.cookie, origin: OS });
  badKey.status === 400 ? ok('key ảnh sai định dạng → 400') : bad('key rác được nhận', String(badKey.status));
  const crossKey = await rq(SELLER, 'POST', `/shops/${A.shopId}/pages`, { body: { slug: `cross-${uniq()}`, title: 'x', blocks: [{ type: 'image', key: `${Bs.shopId}/00000000-0000-4000-8000-000000000000.webp`, alt: 'x' }] }, cookie: A.cookie, origin: OS });
  crossKey.status === 400 ? ok('key ảnh CHÉO SHOP → 400 (không trỏ media shop khác)') : bad('key chéo shop lọt', String(crossKey.status));

  // ── 10. Blog: ảnh bìa + ảnh trong bài + phân trang ──────────────────────────
  sect('10. Blog: ảnh bìa + [anh:] + phân trang');
  const mkPost = async (i, extra = {}) => {
    const b = await rq(SELLER, 'POST', `/shops/${A.shopId}/blog`, { body: { title: `Bài số ${i}`, slug: `bai-${i}-${uniq()}`, body: `Nội dung bài ${i}`, ...extra }, cookie: A.cookie, origin: OS });
    await rq(SELLER, 'POST', `/shops/${A.shopId}/blog/${b.json.id}/publish`, { body: {}, cookie: A.cookie, origin: OS });
    return b;
  };
  const coverPost = await mkPost(0, { cover_image_key: FAKE_MEDIA, body: `Đoạn đầu bài viết.\n\n[anh:${FAKE_MEDIA}|Ảnh minh hoạ <script>xau</script>]\n\nĐoạn cuối.` });
  coverPost.status === 201 ? ok('tạo bài blog có cover_image_key → 201') : bad('blog cover fail', JSON.stringify(coverPost.json));
  const badCover = await rq(SELLER, 'POST', `/shops/${A.shopId}/blog`, { body: { title: 'x', slug: `bc-${uniq()}`, cover_image_key: 'javascript:alert(1)' }, cookie: A.cookie, origin: OS });
  badCover.status === 400 ? ok('cover key rác → 400') : bad('cover rác lọt', String(badCover.status));
  for (let i = 1; i <= 12; i++) await mkPost(i);
  const coverSlug = (await owner.query(`SELECT slug FROM blog_posts WHERE id=$1`, [coverPost.json.id])).rows[0].slug;
  r = await sf(A.host, '/blog');
  r.status === 200 && r.body.includes('Trang 1/2') ? ok('blog 13 bài → phân trang Trang 1/2 (12/trang)') : bad('blog pager thiếu', String(r.status));
  r = await sf(A.host, '/blog?page=2');
  r.body.includes(`<link rel="canonical" href="https://${A.host}/blog?page=2">`) ? ok('canonical /blog?page=2 chứa page=2') : bad('canonical blog trang 2 sai');
  r.body.includes('Bài số 0') ? ok('trang 2 hiện bài cũ nhất (Bài số 0)') : bad('phân trang blog sai nội dung');
  r.body.includes('blog-thumb') && r.body.includes(`/media-public/${FAKE_MEDIA}`) ? ok('danh sách blog hiện ảnh bìa thumbnail') : bad('thiếu cover thumb ở danh sách');
  r = await sf(A.host, `/blog/${coverSlug}`);
  r.body.includes('blog-cover') && r.body.includes(`/media-public/${FAKE_MEDIA}`) ? ok('bài blog hiện ảnh bìa trên đầu') : bad('thiếu ảnh bìa trong bài');
  r.body.includes(`<meta property="og:image" content="https://${A.host}/media-public/${FAKE_MEDIA}">`) ? ok('og:image ƯU TIÊN ảnh bìa bài (URL tuyệt đối)') : bad('og:image không ưu tiên cover');
  r.body.includes('<figure') && !r.body.includes('<script>xau') && r.body.includes('Ảnh minh hoạ') ? ok('[anh:key|alt] trong bài → <figure>, alt escape') : bad('[anh:] không render/không escape');
  const cspB = r.headers['content-security-policy'] ?? '';
  cspB.includes("default-src 'none'") && cspB.includes("img-src 'self' data:") && /script-src 'nonce-[A-Za-z0-9+/=]+'/.test(cspB)
    ? ok('CSP: giữ default-src none + img-src; script-src CHỈ nonce (badge giỏ, không origin mới)') : bad('CSP đổi', cspB);

  // ── Flash sale (0082): giá sale + gạch giá gốc + badge + khung giờ, đè compare_at ──
  sect('Flash sale hiển thị storefront');
  const saleSlug = `sale-${uniq()}`;
  const sp = await mkProduct(A.shopId, A.cookie, { title: 'SP Flash Sale', slug: saleSlug, price_vnd: 200000, status: 'active', variants: [{ sku: `FS-${uniq()}`, price_vnd: 200000 }] });
  const svid = (await owner.query(`SELECT id FROM variants WHERE product_id=$1`, [sp.json.id])).rows[0].id;
  await owner.query(`INSERT INTO inventory_levels (shop_id, variant_id, on_hand) VALUES ($1,$2,20) ON CONFLICT (shop_id,variant_id) DO UPDATE SET on_hand=20`, [A.shopId, svid]);
  const { rows: [promo] } = await owner.query(
    `INSERT INTO promotions (shop_id,title,kind,value,scope,starts_at,ends_at,active)
     VALUES ($1,'Sale 25','percent',25,'all', now()-interval '1 hour', now()+interval '3 hour', true) RETURNING id`, [A.shopId]);
  // Trang chủ (thẻ lưới): giá sale 150.000 + gạch 200.000 + badge -25%.
  r = await sf(A.host, '/');
  const money150 = /150[.,]000/, money200 = /200[.,]000/;
  r.body.includes('SP Flash Sale') && money150.test(r.body) && money200.test(r.body) && r.body.includes('-25%')
    ? ok('thẻ lưới: giá sale 150k + gạch 200k + badge -25%') : bad('thẻ sale sai', r.body.match(/SP Flash Sale[\s\S]{0,200}/)?.[0]);
  // PDP: microdata itemprop=price = giá HIỆU LỰC (150000) + khung giờ flash sale.
  r = await sf(A.host, `/p/${saleSlug}`);
  r.body.includes('itemprop="price" content="150000"') ? ok('PDP microdata price = giá SALE 150000 (Google Merchant)') : bad('microdata không phải giá sale', r.body.match(/itemprop="price"[^>]*/)?.[0]);
  r.body.includes('Flash sale') && /đến \d{2}:\d{2}/.test(r.body) ? ok('PDP khung giờ "Flash sale — đến HH:MM" (text tĩnh, no-JS)') : bad('thiếu text khung giờ');
  // Tắt promo → giá về gốc (không worker/cron, đọc kế tiếp tự cập nhật).
  await owner.query(`UPDATE promotions SET active=false WHERE id=$1`, [promo.id]);
  r = await sf(A.host, `/p/${saleSlug}`);
  r.body.includes('itemprop="price" content="200000"') && !r.body.includes('Flash sale')
    ? ok('tắt promo → giá về gốc 200000, hết khung giờ (tự cập nhật)') : bad('promo tắt vẫn hiện sale', r.body.match(/itemprop="price"[^>]*/)?.[0]);

  // ── 11. Phase 3: thẻ hover (ảnh2 + lớp phủ 👁/Thêm giỏ) + quick-view modal + endpoint ──
  sect('11. Phase 3 — thẻ hover + quick-view');
  const p3Slug = `hover-${uniq()}`;
  const p3 = await mkProduct(A.shopId, A.cookie, { title: 'SP Hover Phase3', slug: p3Slug, price_vnd: 300000, status: 'active', variants: [{ sku: `H-${uniq()}`, price_vnd: 300000 }] });
  const p3v = (await owner.query(`SELECT id FROM variants WHERE product_id=$1`, [p3.json.id])).rows[0].id;
  await owner.query(`INSERT INTO inventory_levels (shop_id, variant_id, on_hand) VALUES ($1,$2,30) ON CONFLICT (shop_id,variant_id) DO UPDATE SET on_hand=30`, [A.shopId, p3v]);
  // Hai ảnh READY → thẻ có ảnh THỨ HAI để hover đổi ảnh (card-img2).
  const k1 = `${A.shopId}/11111111-1111-4111-8111-111111111111.webp`;
  const k2 = `${A.shopId}/22222222-2222-4222-8222-222222222222.webp`;
  await owner.query(`INSERT INTO media (shop_id,product_id,status,original_key,public_key,position) VALUES ($1,$2,'ready','o1',$3,0),($1,$2,'ready','o2',$4,1)`, [A.shopId, p3.json.id, k1, k2]);
  r = await sf(A.host, '/');
  r.body.includes('class="card-media"') && r.body.includes('class="card-img2"') && r.body.includes(`/media-public/${k2}`)
    ? ok('thẻ có ảnh THỨ HAI (card-img2) để hover đổi ảnh') : bad('thiếu ảnh2 hover', r.body.match(/SP Hover Phase3[\s\S]{0,300}/)?.[0]);
  r.body.includes('class="card-actions"') && r.body.includes('class="card-qv"') && r.body.includes('Xem nhanh')
    ? ok('thẻ có lớp phủ hành-động + 👁 quick-view (aria-label)') : bad('thiếu overlay/👁');
  r.body.includes('class="card-add-form"') && r.body.includes('action="/cart/add"') && r.body.includes(`value="${p3v}"`)
    ? ok('SP phẳng: thẻ có <form> POST /cart/add (variant_id mặc định + qty=1)') : bad('thiếu form thêm-nhanh SP phẳng');
  // SP nhiều biến thể (axSlug ở mục 6) → "Thêm vào giỏ" là LINK về PDP (no-JS an toàn).
  r.body.includes(`<a class="card-add" href="/p/${axSlug}">`) ? ok('SP nhiều biến thể: "Thêm vào giỏ" là LINK về /p/:slug (no-JS)') : bad('multi-variant add không phải link');
  // HTML HỢP LỆ: không có <form>/<button> LỒNG trong <a class="card-media"> (interactive không trong <a>).
  const mediaBlocks = r.body.split('<a class="card-media"').slice(1).map((s) => s.slice(0, s.indexOf('</a>')));
  mediaBlocks.length && !mediaBlocks.some((b) => /<form|<button/.test(b))
    ? ok('HTML hợp lệ: không lồng <form>/<button> trong <a class="card-media">') : bad('interactive lồng trong <a> media');
  // "Xem tất cả →" trên đầu-mục lưới SP → route có sẵn (không 404).
  r.body.includes('Xem tất cả →') && r.body.includes('href="/?sort=new"') ? ok('lưới SP có link "Xem tất cả →" (/?sort=new, route có sẵn)') : bad('thiếu Xem tất cả');
  // Shell quick-view + script DOM-only.
  r.body.includes('id="qv-modal"') && r.body.includes('role="dialog"') && r.body.includes('id="qv-backdrop"')
    ? ok('shell quick-view: #qv-modal role=dialog + #qv-backdrop (ẩn; JS dựng thân)') : bad('thiếu shell quick-view');
  const sfScript = (r.body.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/) || [])[1] || '';
  sfScript.includes("fetch(href+'/quickview'") && sfScript.includes('createElement') && !sfScript.includes('.innerHTML') && !sfScript.includes('insertAdjacentHTML')
    ? ok('script: fetch quickview + dựng DOM (createElement), KHÔNG .innerHTML/insertAdjacentHTML') : bad('script quick-view thiếu / dùng innerHTML');
  (r.body.match(/<script/g) || []).length === 1 ? ok('vẫn CHỈ 1 khối <script> (badge + drawer + quick-view chung)') : bad('số <script> khác 1', String((r.body.match(/<script/g) || []).length));

  // Endpoint quick-view JSON (mô hình theo query PDP; RLS store_products lọc active).
  let qv = await sf(A.host, `/p/${axSlug}/quickview`);
  let qj = null; try { qj = JSON.parse(qv.body); } catch {}
  qv.status === 200 && qj && Array.isArray(qj.options) && qj.options.length === 2 && Array.isArray(qj.variants) && qj.variants.length >= 4
    ? ok('GET /p/:slug/quickview → JSON 2 options + ≥4 variants') : bad('quickview JSON sai', qv.body.slice(0, 200));
  qj && qj.variants[0] && Array.isArray(qj.variants[0].value_ids) && qj.variants[0].value_ids.length === 2 && ('available' in qj.variants[0]) && ('price_vnd' in qj.variants[0])
    ? ok('quickview variant có value_ids (2 trục) + available + price_vnd') : bad('variant thiếu field', JSON.stringify(qj?.variants?.[0]));
  qj && qj.options[0] && Array.isArray(qj.options[0].values) && qj.options[0].values[0] && ('label' in qj.options[0].values[0])
    ? ok('quickview option có values[{id,label}]') : bad('option values thiếu label');
  (qv.headers['content-type'] || '').includes('application/json') && (qv.headers['cache-control'] || '').includes('s-maxage')
    ? ok('quickview: content-type JSON + cache CDN (catalog public)') : bad('quickview header sai', String(qv.headers['cache-control']));
  qv = await sf(A.host, `/p/${draftSlug}/quickview`);
  qv.status === 404 ? ok('quickview SP DRAFT → 404 (không lộ dữ liệu chưa bán)') : bad('quickview lộ draft', String(qv.status));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('storefront e2e lỗi:', err); process.exit(2); });
