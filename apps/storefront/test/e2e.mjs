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
  await owner.query(`UPDATE shops SET status='active', went_live_at=now() WHERE id=$1`, [shopId]);
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
  r.body.includes("fetch('/cart/items',{method:'PATCH'") && r.body.includes('id="cd-error"')
    && r.body.includes("fetch('/cart/add'") && r.body.includes("name==='buynow'")
    ? ok('script drawer: PATCH JSON + lỗi tại chỗ; chặn /cart/add trừ Mua ngay (buynow)') : bad('script drawer thiếu logic update/add');

  // ── 2. Chi tiết sản phẩm ───────────────────────────────────────────────────
  sect('2. Chi tiết sản phẩm');
  r = await sf(A.host, `/p/${activeSlug}`);
  r.status === 200 && r.body.includes('&lt;script&gt;') ? ok('chi tiết sản phẩm active → 200') : bad('chi tiết active lỗi', String(r.status));
  // Thanh MUA dính đáy và tabbar đáy KHÔNG được cùng tồn tại: tabbar (z-index 60, fixed đáy)
  // sẽ đè lên thanh mua (z-index 55) và che nút "Thêm vào giỏ"/"Mua ngay". Trước đây chỉ CSS
  // `body:has(.pd-actions)` lo việc đó — một tính năng CSS mới (Chrome 105+) đặt ngay trên
  // nút ra tiền: trình duyệt cũ bỏ qua luật là hỏng thầm lặng. Nay SERVER quyết, nên khẳng
  // định được ở mức MARKUP, không cần trình duyệt.
  // BƠM TỒN trước khi đo. Lần đầu viết khẳng định này nó rẽ nhánh "hết hàng" và XANH mà
  // KHÔNG kiểm điều đang cần kiểm — sản phẩm của bộ test không có inventory_levels nên
  // storefront ẩn form mua. Một khẳng định xanh nhờ đi nhầm nhánh còn tệ hơn không có.
  await owner.query(
    `INSERT INTO inventory_levels (shop_id, variant_id, on_hand)
     SELECT $1, v.id, 25 FROM variants v JOIN products p ON p.id = v.product_id
      WHERE p.shop_id = $1 AND p.slug = $2
     ON CONFLICT (shop_id, variant_id) DO UPDATE SET on_hand = 25, reserved = 0`,
    [A.shopId, activeSlug]);
  r = await sf(A.host, `/p/${activeSlug}`);
  r.body.includes('class="pd-actions"') ? ok('có tồn → trang SP hiện form mua (tiền đề của 2 khẳng định dưới)')
    : bad('bơm tồn rồi mà vẫn không có form mua — khẳng định dưới sẽ đi nhầm nhánh');
  if (r.body.includes('class="pd-actions"')) {
    !r.body.includes('class="tabbar"') && /<body class="[^"]*has-buybar/.test(r.body)
      ? ok('trang SP có thanh mua: KHÔNG phát tabbar + body.has-buybar (không phụ thuộc :has())')
      : bad('trang SP vừa có thanh mua vừa có tabbar → tabbar che nút mua trên trình duyệt cũ');
  } else {
    r.body.includes('class="tabbar"') ? ok('trang SP hết hàng (không thanh mua) → vẫn có tabbar')
      : bad('trang SP không thanh mua mà cũng mất tabbar');
  }
  const home = await sf(A.host, '/');
  home.body.includes('class="tabbar"') && !/<body class="[^"]*has-buybar/.test(home.body)
    ? ok('trang chủ: có tabbar, không gắn has-buybar') : bad('trang chủ mất tabbar');
  // TRẢ LẠI tồn = 0. Bài "?instock=1" ở mục sau dùng CHÍNH sản phẩm này làm ca ÂM (phải bị
  // lọc ra vì hết hàng); để nguyên 25 là bài đó đỏ — và đỏ ở chỗ chẳng liên quan gì tới nó.
  await owner.query(
    `UPDATE inventory_levels SET on_hand = 0 WHERE shop_id = $1 AND variant_id IN
       (SELECT v.id FROM variants v JOIN products p ON p.id = v.product_id
         WHERE p.shop_id = $1 AND p.slug = $2)`, [A.shopId, activeSlug]);
  r = await sf(A.host, `/p/${draftSlug}`);
  r.status === 404 ? ok('chi tiết sản phẩm DRAFT → 404 (không lộ)') : bad('draft detail lộ', String(r.status));

  // ── 3. Cô lập chéo shop ────────────────────────────────────────────────────
  sect('3. Cô lập chéo shop');
  const Bs = await makeShopOwner(staff, `storeb-${uniq()}`);
  // Shop VỪA DỰNG, CHƯA CÓ HÀNG — đúng cảnh người bán tự đăng ký lúc 2 giờ sáng: subdomain
  // đã sống và công khai ngay. Vẫn phục vụ người có link (shop onboarding bán được ngay), NHƯNG
  // không được mời công cụ tìm kiếm lập chỉ mục một cửa hàng rỗng — ấn tượng đầu tiên của họ
  // trên Google sẽ là "chưa có sản phẩm nào", và Google giữ ảnh chụp đó rất lâu sau khi đã có hàng.
  let rEmpty = await sf(Bs.host, '/');
  rEmpty.status === 200 && /noindex/.test(rEmpty.headers['x-robots-tag'] ?? '')
    ? ok('shop chưa có hàng: vẫn 200 cho người có link, nhưng x-robots-tag noindex')
    : bad('shop rỗng vẫn mời lập chỉ mục', `${rEmpty.status} robots=${rEmpty.headers['x-robots-tag'] ?? '(không có)'}`);
  /no-store/.test(rEmpty.headers['cache-control'] ?? '')
    ? ok('shop rỗng: no-store (CDN không giữ bản noindex sau khi shop đã đăng hàng)')
    : bad('bản noindex bị CDN cache', rEmpty.headers['cache-control'] ?? '(không có)');
  // Ba mặt SEO còn lại của một shop rỗng. Vá mỗi trang chủ là chưa đủ: lưới /products và
  // /blog rỗng vẫn là trang mỏng, còn sitemap thì TỰ MÂU THUẪN — mời Google vào '/' trong khi
  // '/' trả noindex.
  for (const [path, ten] of [['/products', 'lưới sản phẩm'], ['/blog', 'trang blog']]) {
    const rp = await sf(Bs.host, path);
    /noindex/.test(rp.headers['x-robots-tag'] ?? '')
      ? ok(`shop rỗng: ${ten} cũng noindex`) : bad(`${ten} rỗng vẫn cho lập chỉ mục`, rp.headers['x-robots-tag'] ?? '-');
  }
  const smEmpty = await sf(Bs.host, '/sitemap.xml');
  (smEmpty.body.match(/<url>/g) ?? []).length === 0
    ? ok('shop rỗng: sitemap KHÔNG mời vào trang nào')
    : bad('sitemap vẫn mời vào trang rỗng', String((smEmpty.body.match(/<loc>[^<]*<\/loc>/g) ?? []).slice(0, 3)));
  await mkProduct(Bs.shopId, Bs.cookie, { title: 'HÀNG CỦA SHOP B', slug: `b-${uniq()}`, price_vnd: 1, status: 'active', variants: [{ sku: `B-${uniq()}`, price_vnd: 1 }] });
  // Ngay khi có SP đầu tiên, noindex phải TỰ TẮT — cơ chế bám hàng hoá, không bám trạng thái
  // shop và không cần ai bấm nút. Đây là nửa quan trọng hơn: noindex NHẦM một shop đang bán là
  // tự tay cắt nguồn khách của họ, tệ hơn hẳn cái nó định phòng.
  rEmpty = await sf(Bs.host, '/');
  !/noindex/.test(rEmpty.headers['x-robots-tag'] ?? '')
    ? ok('có SP đầu tiên → noindex TỰ TẮT (không nút bấm, không cờ DB)')
    : bad('shop đã có hàng mà vẫn noindex — đang cắt nguồn khách', rEmpty.headers['x-robots-tag']);
  const smFull = await sf(Bs.host, '/sitemap.xml');
  smFull.body.includes('<loc>') && /\/products</.test(smFull.body)
    ? ok('có SP đầu tiên → sitemap mời lại / và /products')
    : bad('sitemap không hồi phục sau khi shop có hàng', String((smFull.body.match(/<url>/g) ?? []).length));
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

  // ── 6b. Gallery: mũi tên trái/phải + mô tả về cột phải ──────────────────────
  // Chủ shop báo: ảnh chính chiếm nửa trang, thumbnail rơi xuống dòng, và mô tả nằm
  // tít dưới đáy nên đọc giá xong là gặp khoảng trắng. Ba thứ này kiểm được ở HTML.
  // Ảnh cắm thẳng bằng SQL: đường upload thật cần MinIO + sharp, không phải thứ ca
  // này muốn kiểm — nó kiểm CÁCH DỰNG gallery khi đã có nhiều ảnh.
  sect('6b. Mũi tên gallery + mô tả cột phải');
  for (let i = 0; i < 3; i++) {
    await owner.query(
      `INSERT INTO media (shop_id, product_id, status, original_key, public_key, position)
       VALUES ($1,$2,'ready',$3,$3,$4)`, [A.shopId, axPid, `${A.shopId}/ax-${i}.webp`, i]);
  }
  const longText = 'Thảm dệt thủ công, sợi dày, chống trượt. '.repeat(12); // > 320 ký tự → phải kẹp
  await owner.query(`UPDATE products SET description = $2 WHERE id = $1`, [axPid, longText]);
  pr = await sf(A.host, `/p/${axSlug}`);
  const nThumb = (pr.body.match(/class="th t-\d+"/g) ?? []).length;
  const nPrev = (pr.body.match(/class="pv n-\d+"/g) ?? []).length;
  nThumb === 3 && nPrev === 3 ? ok('3 ảnh → 3 thumbnail + 3 cặp mũi tên') : bad('gallery sai số lượng', `thumb ${nThumb}, mũi tên ${nPrev}`);
  // Vòng lại hai đầu: ảnh đầu lùi về ảnh cuối, ảnh cuối tiến về ảnh đầu.
  /class="pv n-0" for="gsel-2"/.test(pr.body) && /class="nx n-2" for="gsel-0"/.test(pr.body)
    ? ok('mũi tên vòng lại hai đầu (0←→2)') : bad('mũi tên không vòng lại');
  // Mô tả phải nằm TRONG cột phải (.pd-info), tức sau .pd-info và trước khi lưới đóng.
  // Cắt bỏ khối <style> trước khi đo — trong CSS cũng có chuỗi .pd-desc.
  const bodyOnly = pr.body.slice(pr.body.indexOf('</style>'));
  const iInfo = bodyOnly.indexOf('class="pd-info"'), iDesc = bodyOnly.indexOf('class="pd-desc"');
  // Đo ĐỘ SÂU <div>, không đo thứ tự. Bản đầu chỉ so vị trí pd-info < pd-desc < pd-block —
  // và đột biến "trả mô tả về dưới lưới" VẪN XANH, vì ở bố cục cũ mô tả cũng nằm giữa hai
  // mốc đó. Đếm thẻ mở/đóng thì phân biệt được: đo thật cho 1 (còn trong pd-info) và
  // −1 (pd-info + pd-grid đã đóng). Thẻ mở của chính pd-desc tính vào +1 nên mốc là > 0.
  const seg = bodyOnly.slice(iInfo, iDesc);
  const depth = (seg.match(/<div\b/g) ?? []).length - (seg.match(/<\/div>/g) ?? []).length;
  iInfo > 0 && iDesc > iInfo && depth > 0 ? ok('mô tả nằm TRONG cột phải (.pd-info chưa đóng)') : bad('mô tả không ở cột phải', `độ sâu ${depth}`);
  pr.body.includes('id="descmore"') && pr.body.includes('Xem thêm') && !/class="dsc open"/.test(pr.body)
    ? ok('mô tả DÀI → kẹp lại + nút "Xem thêm"') : bad('mô tả dài không kẹp');
  // Mô tả NGẮN thì hiện trọn, không có nút — bấm "Xem thêm" mà không thêm gì là tệ hơn.
  await owner.query(`UPDATE products SET description = 'Thảm ngắn gọn.' WHERE id = $1`, [axPid]);
  pr = await sf(A.host, `/p/${axSlug}`);
  /class="dsc open"/.test(pr.body) && !pr.body.includes('id="descmore"')
    ? ok('mô tả NGẮN → hiện trọn, không có nút thừa') : bad('mô tả ngắn vẫn bị kẹp');
  await owner.query(`UPDATE products SET description = $2 WHERE id = $1`, [axPid, longText]);
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
  // Canonical phân trang (#28): lưới đầy đủ giờ ở /products; link cũ /?page=/?sort= 301 sang.
  r = await sf(A.host, '/?page=2');
  r.status === 301 && r.headers.location === '/products?page=2'
    ? ok('/?page=2 → 301 /products?page=2 (link cũ không gãy)') : bad('redirect ?page trang chủ sai', `${r.status} ${r.headers.location}`);
  r = await sf(A.host, '/?sort=price_asc');
  r.status === 301 && r.headers.location === '/products?sort=price_asc'
    ? ok('/?sort= → 301 /products?sort= (dropdown/bookmark cũ không gãy)') : bad('redirect ?sort trang chủ sai', `${r.status} ${r.headers.location}`);
  r = await sf(A.host, '/products?page=2');
  r.body.includes(`<link rel="canonical" href="https://${A.host}/products?page=2">`) ? ok('canonical /products?page=2 chứa page=2 (không gộp về trang 1)') : bad('canonical trang 2 sai', r.body.match(/rel="canonical"[^>]*/)?.[0]);
  r.body.includes(`<link rel="prev" href="https://${A.host}/products">`) ? ok('trang 2 có rel=prev về /products (URL sạch)') : bad('thiếu rel=prev');
  r = await sf(A.host, '/');
  r.body.includes(`<link rel="canonical" href="https://${A.host}/">`) && !r.body.includes('?page=1') ? ok('trang chủ canonical URL sạch (không ?page=1)') : bad('canonical trang chủ sai');

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
  // Header mobile phải là MỘT HÀNG. Không đo được pixel trong e2e (không có trình duyệt), nên
  // chốt bằng chính ba khai báo CSS quyết định điều đó — nếu ai gỡ, khẳng định này đỏ:
  //  * flex:1 1 0 cho .brand — basis 0 mới ngăn xuống hàng. flex:1 1 auto KHÔNG đủ vì container
  //    có flex-wrap:wrap thì trình duyệt quyết định xuống hàng TRƯỚC khi co, dựa trên basis;
  //  * .hicons flex:0 0 auto — giỏ/tài khoản không nhường chỗ cho tên shop;
  //  * min-height 56px trong media mobile — sàn 68px của desktop là trần thật, gom một hàng
  //    rồi mà không hạ sàn thì header vẫn 69px.
  const css = (await sf(A.host, '/')).body;
  /\.brand\{order:1;margin-right:auto;flex:1 1 0;min-width:0\}/.test(css)
    ? ok('header mobile: .brand flex-basis 0 (ngăn cụm icon xuống hàng 2)')
    : bad('mất flex:1 1 0 của .brand — header mobile sẽ tách 2 hàng lại');
  /\.hicons\{order:2;flex:0 0 auto\}/.test(css)
    ? ok('header mobile: cụm icon KHÔNG co') : bad('icon giỏ/tài khoản bị cho co');
  /\.hdr \.wrap\{min-height:56px/.test(css)
    ? ok('header mobile: sàn chiều cao 56px (desktop vẫn 68px)') : bad('mất sàn 56px cho mobile');
  // Tìm kiếm rời khỏi header mobile → vào ngăn kéo burger, dạng Ô NHẬP THẬT (không phải icon).
  // Form GET thuần, no-JS chạy y nguyên. Ba thứ phải cùng đúng, thiếu một là hỏng:
  /<form class="hnav-search" method="GET" action="\/search"/.test(css)
    ? ok('ngăn kéo có ô tìm THẬT (form GET, no-JS)') : bad('thiếu ô tìm trong ngăn kéo burger');
  /\.hicons \.hsearch-wrap\{display:none\}/.test(css)
    ? ok('mobile: icon tìm rời khỏi header (trả 46px cho tên shop)') : bad('icon tìm vẫn chiếm chỗ ở header mobile');
  css.includes('.hnav-search{display:none}')
    ? ok('desktop: ô trong ngăn kéo vẫn ẩn (giữ nguyên icon thả-xuống)') : bad('ô ngăn kéo lọt ra desktop');

  // ?page KHỔNG LỒ: trang blog CÔNG KHAI, không cần đăng nhập. offset nội suy thẳng vào SQL
  // nên trước khi kẹp trần thì 1e20 > bigint → 'bigint out of range' → 500 mà BẤT KỲ AI trên
  // Internet cũng bắn được vào storefront của shop. Lưới sản phẩm đã kẹp từ đầu, blog quên.
  // Đặt SAU cụm khẳng định blog ở trên: cả cụm dùng chung biến `r`, chèn vào giữa là cướp
  // response của bài sau (đã cắn đúng một lần — bài "cover thumb" quay sang soi /products).
  r = await sf(A.host, '/blog?page=99999999999999999999');
  r.status === 200 ? ok('blog ?page khổng lồ → 200, không 500 (công khai)') : bad('blog sập vì ?page rác', String(r.status));
  r = await sf(A.host, '/products?page=99999999999999999999');
  r.status === 200 ? ok('lưới SP ?page khổng lồ → 200') : bad('lưới SP sập vì ?page rác', String(r.status));

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
  r.body.includes('class="card-qvwrap"') && r.body.includes('class="card-qv"') && r.body.includes('>Xem nhanh<')
    ? ok('thẻ có nút "Xem nhanh" nổi giữa ảnh (hover) + card-add trong thân') : bad('thiếu Xem nhanh');
  r.body.includes('class="card-add-form"') && r.body.includes('action="/cart/add"') && r.body.includes(`value="${p3v}"`)
    ? ok('SP phẳng: thẻ có <form> POST /cart/add (variant_id mặc định + qty=1)') : bad('thiếu form thêm-nhanh SP phẳng');
  // SP nhiều biến thể (axSlug ở mục 6) → "Thêm vào giỏ" là LINK về PDP (no-JS an toàn).
  r.body.includes(`<a class="card-add" href="/p/${axSlug}">`) ? ok('SP nhiều biến thể: "Thêm vào giỏ" là LINK về /p/:slug (no-JS)') : bad('multi-variant add không phải link');
  // HTML HỢP LỆ: không có <form>/<button> LỒNG trong <a class="card-media"> (interactive không trong <a>).
  const mediaBlocks = r.body.split('<a class="card-media"').slice(1).map((s) => s.slice(0, s.indexOf('</a>')));
  mediaBlocks.length && !mediaBlocks.some((b) => /<form|<button/.test(b))
    ? ok('HTML hợp lệ: không lồng <form>/<button> trong <a class="card-media">') : bad('interactive lồng trong <a> media');
  // "Xem tất cả →" trên đầu-mục lưới SP → /products (lưới đầy đủ).
  r.body.includes('Xem tất cả →') && r.body.includes('href="/products"') ? ok('lưới SP có link "Xem tất cả →" (/products)') : bad('thiếu Xem tất cả');
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

  // ── Trang chủ NỔI BẬT (tối đa 8 SP, không chips/sort/pager) + /products lưới đầy đủ ──
  sect('Trang chủ nổi bật (8 SP + Xem thêm) + /products (chips lọc + sort + pager)');
  const catKiemSlug = `kiem-${uniq()}`;
  const catMk = await rq(SELLER, 'POST', `/shops/${A.shopId}/categories`, { body: { slug: catKiemSlug, name: 'Danh Mục Kiểm' }, cookie: A.cookie, origin: OS });
  await rq(SELLER, 'PUT', `/shops/${A.shopId}/products/${rugPid}/categories`, { body: { category_ids: [catMk.json.id] }, cookie: A.cookie, origin: OS });
  for (let i = 0; i < 6; i++) await mkProduct(A.shopId, A.cookie, { title: `SP Đầy ${i}`, slug: `day-${i}-${uniq()}`, price_vnd: 100000 + i * 1000, status: 'active', variants: [{ sku: `DAY${i}-${uniq()}`, price_vnd: 100000 + i * 1000 }] });
  r = await sf(A.host, '/'); // shop A layout rỗng → DEFAULT_LAYOUT (product_grid 3 cột, limit:9 chẵn hàng)
  const homeCards = (r.body.match(/<div class="card(?: is-out)?">/g) || []).length;
  homeCards === 9 ? ok('trang chủ đúng 9 thẻ SP nổi bật (3×3, không ôm cả catalog)') : bad(`trang chủ ${homeCards} thẻ (mong 9)`);
  !r.body.includes('class="chips"') && !r.body.includes('class="sortbar"') && !r.body.includes('class="pager"')
    ? ok('trang chủ KHÔNG còn chips/sortbar/pager (chuyển sang /products)') : bad('trang chủ vẫn còn chips/sort/pager');
  r.body.includes('class="grid-more"') && /class="btn btn-primary btn-more" href="\/products"/.test(r.body)
    ? ok('nút "Xem thêm" to, căn giữa → /products') : bad('thiếu nút Xem thêm');
  // Section "Bài viết mới nhất" (3 bài published gần nhất, kiểu Haravan) — layout cũ vẫn tự có.
  r.body.includes('Bài viết mới nhất') && (r.body.match(/class="hblog-card"/g) || []).length === 3
    ? ok('trang chủ có section blog: 3 thẻ bài viết mới nhất') : bad('section blog trang chủ thiếu/sai số thẻ', String((r.body.match(/class="hblog-card"/g) || []).length));
  r.body.includes('Tháng') && r.body.includes('class="hblog-more"')
    ? ok('thẻ blog: ngày "dd Tháng MM, yyyy" + link Xem thêm → /blog/:slug') : bad('thẻ blog thiếu ngày/Xem thêm');
  // /products (redesign 2 cột): SIDEBAR bộ lọc TRÁI (ô tìm + danh sách danh mục ?cat= + còn-hàng
  // + khoảng giá) + LƯỚI SP PHẢI (đếm SP + sort). Tất cả no-JS. Đủ 11 SP (≤24 → 1 trang).
  r = await sf(A.host, '/products');
  r.status === 200 && r.body.includes('Tất cả sản phẩm') ? ok('/products 200, tiêu đề "Tất cả sản phẩm"') : bad('/products lỗi', String(r.status));
  const prodCards = (r.body.match(/<div class="card(?: is-out)?">/g) || []).length;
  prodCards === 11 ? ok(`/products hiện đủ 11 SP active`) : bad(`/products ${prodCards} thẻ (mong 11)`);
  // Sidebar bộ lọc: container + danh sách danh mục dạng NÚT LỌC (?cat=) + có danh mục kiểm.
  r.body.includes('class="pf-side"') && r.body.includes('class="pf-layout"') && r.body.includes('class="pf-cats"')
    && r.body.includes(`href="/products?cat=`) && r.body.includes('Danh Mục Kiểm')
    ? ok('/products có SIDEBAR bộ lọc + danh mục lọc tại chỗ (?cat=, không nhảy trang)') : bad('thiếu sidebar/danh mục lọc trên /products');
  // Ô tìm trong sidebar (GET /products, name=q) + form lọc còn-hàng/giá (no-JS).
  r.body.includes('class="pf-search"') && r.body.includes('name="q"') && r.body.includes('name="instock"')
    && r.body.includes('name="pmin"') && r.body.includes('Áp dụng')
    ? ok('/products sidebar: ô tìm + còn-hàng + khoảng giá (form GET no-JS)') : bad('thiếu ô tìm/lọc trong sidebar');
  // Cột phải: hàng đầu đếm "N sản phẩm" + thanh sắp xếp còn hoạt động.
  r.body.includes('class="pf-head"') && r.body.includes('class="pf-count"') && r.body.includes('11 sản phẩm')
    && r.body.includes('class="sortbar"') && r.body.includes('Sắp xếp:')
    ? ok('/products cột phải: đếm "11 sản phẩm" + thanh sắp xếp') : bad('thiếu đếm SP/sort trên cột phải');
  // Thẻ SP vẫn giữ nút thêm-giỏ (form POST /cart/add) + xem-nhanh (👁) cho lớp JS nonce.
  r.body.includes('class="card-add-form"') && r.body.includes('action="/cart/add"') && r.body.includes('class="card-qv"')
    ? ok('/products: thẻ giữ form thêm-giỏ + nút xem-nhanh (lớp JS không gãy)') : bad('thẻ mất form thêm-giỏ/xem-nhanh');
  r = await sf(A.host, `/products?cat=${catKiemSlug}`);
  r.status === 200 && r.body.includes('Thảm trải sàn cao cấp') && !r.body.includes('SP Đầy 0')
    ? ok('?cat= lọc đúng: chỉ SP thuộc danh mục') : bad('lọc ?cat sai');
  r.body.includes('aria-current="true"') ? ok('danh mục đang chọn được đánh dấu (aria-current)') : bad('mục danh mục chọn không đánh dấu');

  // ── Danh mục 2 CẤP (0095): cha gộp con · con lọc hẹp · mega-menu · breadcrumb · /c/ 301 · ép 2 cấp ──
  sect('Danh mục 2 cấp (cha↔con): gộp/lọc + mega-menu + /c/ 301 + ép 2 cấp');
  const parentSlug = `thit-${uniq()}`, heoSlug = `heo-${uniq()}`, boSlug = `bo-${uniq()}`;
  const parentCat = await rq(SELLER, 'POST', `/shops/${A.shopId}/categories`, { body: { slug: parentSlug, name: 'Thịt' }, cookie: A.cookie, origin: OS });
  const heoCat = await rq(SELLER, 'POST', `/shops/${A.shopId}/categories`, { body: { slug: heoSlug, name: 'Thịt heo', parent_id: parentCat.json.id }, cookie: A.cookie, origin: OS });
  const boCat = await rq(SELLER, 'POST', `/shops/${A.shopId}/categories`, { body: { slug: boSlug, name: 'Thịt bò', parent_id: parentCat.json.id }, cookie: A.cookie, origin: OS });
  (parentCat.status === 201 && heoCat.status === 201 && boCat.status === 201)
    ? ok('tạo cha "Thịt" + 2 con "Thịt heo"/"Thịt bò"') : bad('tạo cây danh mục lỗi', `${parentCat.status}/${heoCat.status}/${boCat.status}`);
  // SP gán vào CON (không gán trực tiếp cha) → kiểm cha GỘP con.
  const heoPid = (await mkProduct(A.shopId, A.cookie, { title: 'Ba chỉ heo', slug: `bachi-${uniq()}`, price_vnd: 120000, status: 'active', variants: [{ sku: `HEO-${uniq()}`, price_vnd: 120000 }] })).json.id;
  const boPid = (await mkProduct(A.shopId, A.cookie, { title: 'Bắp bò Mỹ', slug: `bapbo-${uniq()}`, price_vnd: 260000, status: 'active', variants: [{ sku: `BO-${uniq()}`, price_vnd: 260000 }] })).json.id;
  await rq(SELLER, 'PUT', `/shops/${A.shopId}/products/${heoPid}/categories`, { body: { category_ids: [heoCat.json.id] }, cookie: A.cookie, origin: OS });
  await rq(SELLER, 'PUT', `/shops/${A.shopId}/products/${boPid}/categories`, { body: { category_ids: [boCat.json.id] }, cookie: A.cookie, origin: OS });

  // ÉP 2 CẤP: tạo con-của-con → 400; hạ cấp cha đang có con → 400.
  const threeLvl = await rq(SELLER, 'POST', `/shops/${A.shopId}/categories`, { body: { slug: `suon-${uniq()}`, name: 'Sườn heo', parent_id: heoCat.json.id }, cookie: A.cookie, origin: OS });
  threeLvl.status === 400 ? ok('ÉP 2 CẤP: tạo con-của-con bị chặn (400)') : bad('cây 3 cấp lọt', String(threeLvl.status));
  const demote = await rq(SELLER, 'PATCH', `/shops/${A.shopId}/categories/${parentCat.json.id}`, { body: { parent_id: catMk.json.id }, cookie: A.cookie, origin: OS });
  demote.status === 400 ? ok('ÉP 2 CẤP: danh mục CÓ CON không thể tự làm con (400)') : bad('hạ cấp cha có con lọt', String(demote.status));

  // Mega-menu: cha "Thịt" (mega-h) + con "Thịt heo"/"Thịt bò" (mega-subs), tất cả trỏ /products?cat=.
  r = await sf(A.host, '/');
  r.body.includes('hnav-mega') && new RegExp(`class="mega-h" href="/products\\?cat=${parentSlug}">Thịt<`).test(r.body)
    && r.body.includes(`href="/products?cat=${heoSlug}">Thịt heo<`) && r.body.includes(`href="/products?cat=${boSlug}">Thịt bò<`)
    ? ok('mega-menu: cha "Thịt" + con "Thịt heo"/"Thịt bò" (trỏ /products?cat=)') : bad('mega-menu thiếu cây danh mục');

  // Cha GỘP con: /products?cat=Thịt → CÓ CẢ "Ba chỉ heo" lẫn "Bắp bò Mỹ".
  r = await sf(A.host, `/products?cat=${parentSlug}`);
  r.status === 200 && r.body.includes('Ba chỉ heo') && r.body.includes('Bắp bò Mỹ')
    ? ok('cha GỘP con: /products?cat=Thịt hiện SP của cả 2 con') : bad('cha không gộp con');
  r.body.includes('<h1 class="products-title">Thịt</h1>') && r.body.includes('class="pf-crumb"')
    && r.body.includes('class="pf-subcats"') && r.body.includes('>Thịt heo</a>') && r.body.includes('>Thịt bò</a>')
    ? ok('trang cha: H1="Thịt" + breadcrumb + sidebar xổ danh mục con') : bad('trang cha thiếu H1/breadcrumb/cây con');

  // Con LỌC HẸP: /products?cat=Thịt-heo → CHỈ "Ba chỉ heo", KHÔNG "Bắp bò Mỹ".
  r = await sf(A.host, `/products?cat=${heoSlug}`);
  r.status === 200 && r.body.includes('Ba chỉ heo') && !r.body.includes('Bắp bò Mỹ')
    ? ok('con LỌC HẸP: /products?cat=Thịt-heo chỉ hiện SP của con đó') : bad('con không lọc hẹp');
  r.body.includes('<h1 class="products-title">Thịt heo</h1>') && /class="pf-crumb"[\s\S]*?>Thịt<\/a>[\s\S]*?>Thịt heo</.test(r.body)
    ? ok('trang con: H1="Thịt heo" + breadcrumb "Sản phẩm / Thịt / Thịt heo"') : bad('trang con thiếu H1/breadcrumb cha');

  // /c/:slug → 301 sang /products?cat= (bố cục danh mục THỐNG NHẤT).
  r = await sf(A.host, `/c/${parentSlug}`);
  (r.status === 301 && (r.headers.location || '').includes(`/products?cat=${parentSlug}`))
    ? ok('/c/:slug 301 → /products?cat= (thống nhất bố cục)') : bad('/c/ không redirect', `${r.status} ${r.headers.location}`);

  // Ô tìm sidebar: ?q= dùng cơ chế token /search — "trai tham" ra "Thảm trải sàn cao cấp".
  r = await sf(A.host, `/products?q=${encodeURIComponent('trai tham')}`);
  r.status === 200 && r.body.includes('Thảm trải sàn cao cấp') && !r.body.includes('SP Đầy 0')
    ? ok('/products?q= tìm không dấu + đảo từ (trai tham → Thảm trải sàn)') : bad('/products?q= tìm sai');
  r = await sf(A.host, '/products?sort=price_asc');
  r.status === 200 ? ok('/products?sort=price_asc 200 (đích mới của "Khuyến mãi")') : bad('sort trên /products lỗi', String(r.status));
  r = await sf(A.host, '/sitemap.xml');
  r.body.includes(`<loc>https://${A.host}/products</loc>`) ? ok('sitemap có /products') : bad('sitemap thiếu /products');

  // ── Danh mục VƯỢT TRẦN vẫn phải vào được ────────────────────────────────────
  // Cây menu vốn lấy LIMIT 100 còn sitemap lấy LIMIT 200, mà seller không có trần nào khi
  // tạo. Nên danh mục thứ 101 biến mất khỏi menu VÀ trả 404 khi bấm vào — trong khi sitemap
  // vẫn mời Google vào đúng URL đó. Rất dễ chạm: bộ nhập CSV từ sàn khác tự đẻ danh mục theo
  // mỗi đường dẫn. Nay resolve slug tra thẳng DB khi vượt trần: menu có thể không liệt kê hết
  // (dropdown 200 dòng là vô dụng) nhưng ĐIỀU HƯỚNG thì không được có mép.
  {
    // PHẢI vượt trần THẬT thì khẳng định mới có nghĩa. Shop test chỉ có vài danh mục nên
    // position=9999 vẫn lọt LIMIT 200 — đo như vậy là đo cái không tồn tại (đã bắt được bằng
    // đột biến: gỡ hẳn fallback mà test vẫn xanh). Chèn 205 danh mục đệm để đẩy mục cần đo
    // ra NGOÀI trần.
    await owner.query(
      `INSERT INTO categories (shop_id, slug, name, position)
       SELECT $1, 'dem-' || $2 || '-' || g, 'Đệm ' || g, g FROM generate_series(1, 205) g`,
      [A.shopId, uniq()]);
    const catSlug = `xa-tran-${uniq()}`;
    const cid = (await owner.query(
      `INSERT INTO categories (shop_id, slug, name, position) VALUES ($1, $2, 'Danh mục xa trần', 9999) RETURNING id`,
      [A.shopId, catSlug])).rows[0].id;
    // Gắn một SP vào đó để trang có nội dung thật, không chỉ "không tìm thấy sản phẩm".
    const pid = (await owner.query(`SELECT id FROM products WHERE shop_id=$1 AND status='active' AND deleted_at IS NULL LIMIT 1`, [A.shopId])).rows[0]?.id;
    if (pid) await owner.query(`INSERT INTO product_categories (shop_id, product_id, category_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [A.shopId, pid, cid]);
    // position=9999 đẩy nó xuống CUỐI ORDER BY position → nằm ngoài mọi trần hữu hạn.
    const rc = await sf(A.host, `/products?cat=${catSlug}`);
    rc.status === 200 && !/không tìm thấy|404/i.test(rc.body.slice(0, 400))
      ? ok('danh mục xếp CUỐI (ngoài trần menu) vẫn mở được trang, không 404')
      : bad('danh mục vượt trần trả 404 — sitemap mời Google vào URL chết', String(rc.status));
    pid && rc.body.includes('Danh mục xa trần')
      ? ok('trang hiện đúng tên danh mục đó (resolve tra DB, không chỉ đoán)') : bad('không nhận ra danh mục', rc.body.slice(0, 120));
    const rx = await sf(A.host, `/products?cat=khong-ton-tai-${uniq()}`);
    /không tìm thấy|Không có sản phẩm|404/i.test(rx.body) || rx.status === 404
      ? ok('slug KHÔNG có thật vẫn báo không tìm thấy (fallback không nới lỏng)') : bad('slug rác cũng ra trang', String(rx.status));
  }

  // MỌI <loc> PHẢI TRỎ VÀO CHỖ CÓ THẬT — lấy CHÍNH chuỗi trong sitemap rồi fetch lại.
  // KHÔNG gõ tay đường dẫn vào test: gõ tay đúng là cách lỗi này sống sót. Sitemap phát
  // `/<slug>` cho trang nội dung trong khi route thật là `/pages/<slug>`, nên MỌI URL trang
  // chính sách nộp cho Google đều 404 — mà cả sitemap lẫn test đều "tự tin" về cùng một
  // đường dẫn không tồn tại. Nộp sitemap toàn URL chết còn hạ uy tín cả tên miền.
  //
  // Gom theo KHUÔN url (đoạn cuối → :x, kèm tên tham số) rồi thử MỘT đại diện mỗi khuôn:
  // lớp lỗi ở đây là sai TIỀN TỐ, nên một đại diện là đủ, và không bắn N request vào
  // chính rate-limit của storefront.
  {
    const locs = [...r.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    const daiDien = new Map();
    for (const u of locs) {
      const { pathname, search, searchParams } = new URL(u);
      const seg = pathname.split('/').filter(Boolean);
      const khuon = (seg.length ? '/' + seg.slice(0, -1).concat(seg.length > 1 ? ':x' : seg[0]).join('/') : '/')
        + (search ? '?' + [...searchParams.keys()].sort().join('&') : '');
      if (!daiDien.has(khuon)) daiDien.set(khuon, pathname + search);
    }
    // Nếu fixture không có trang nội dung nào thì khẳng định dưới đây RỖNG NGHĨA — chặn trước.
    [...daiDien.keys()].some((k) => k.startsWith('/pages/'))
      ? ok(`sitemap có khuôn /pages/:x (${daiDien.size} khuôn URL)`)
      : bad('sitemap KHÔNG có URL trang nội dung — ca kiểm dưới đây vô nghĩa', [...daiDien.keys()].join(' '));
    const chet = [];
    for (const [khuon, p] of daiDien) {
      const rr = await sf(A.host, p);
      if (rr.status !== 200) chet.push(`${khuon} → ${rr.status} (${p})`);
    }
    chet.length === 0
      ? ok(`mọi khuôn URL trong sitemap đều trả 200 (${[...daiDien.keys()].join(' · ')})`)
      : bad('sitemap mời Google vào URL CHẾT', chet.join(' | '));
  }

  // ── Banner trang chủ tuỳ chỉnh (Phase 5): carousel ảnh tải riêng + fallback ──
  sect('Banner trang chủ (ảnh tự tải) + fallback hero tự động');
  // Upload 1 ảnh banner thật (seller re-encode WebP) → lấy key banner-.
  const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC', 'base64');
  const upB = await fetch(`${SELLER}/shops/${A.shopId}/banner-image`, { method: 'POST', headers: { 'content-type': 'image/png', origin: OS, cookie: `__Host-session=${A.cookie}` }, body: PNG_1x1 });
  const upBJson = await upB.json().catch(() => null);
  const bnKey = upBJson?.key;
  bnKey ? ok(`upload ảnh banner → key ${bnKey.slice(0, 18)}…`) : bad('upload banner fail', JSON.stringify(upBJson));
  // Cấu hình slides vào hero.props.slides.
  await rq(SELLER, 'PUT', `/shops/${A.shopId}/theme`, { cookie: A.cookie, origin: OS, body: { tokens: {}, layout: [
    { section: 'header', props: {} },
    { section: 'hero', props: { title: 'HERO-TU-DONG-CU', subtitle: 'phu-tu-dong', slides: [
      { image_key: bnKey, headline: 'Banner Khuyến Mãi Lớn', sub: 'Giảm tới 50%', button_label: 'Xem ngay', button_link: '/c/sale' },
    ] } },
    { section: 'product_grid', props: { title: 'Sản phẩm' } },
    { section: 'footer', props: {} },
  ] } });
  r = await sf(A.host, '/');
  r.body.includes('class="hero hero-banner') && r.body.includes(`/media-public/${bnKey}`)
    ? ok('storefront render carousel BANNER (hero-banner + ảnh tải riêng)') : bad('không render banner tuỳ chỉnh', r.body.match(/class="hero[^"]*"/)?.[0]);
  r.body.includes('Banner Khuyến Mãi Lớn') && r.body.includes('Giảm tới 50%') && r.body.includes('>Xem ngay<') && r.body.includes('href="/c/sale"')
    ? ok('overlay: headline + sub + nút (link nội bộ)') : bad('overlay banner thiếu field');
  !r.body.includes('phu-tu-dong')
    ? ok('có banner → KHÔNG render hero tự động (subtitle cũ biến mất)') : bad('hero tự động vẫn render cùng banner');
  // ── Menu "Sản phẩm" trên mobile: GẬP, không xổ sẵn ──────────────────────────
  // Chủ shop báo: mở hamburger là toàn bộ danh mục xổ hết, "nhìn hơi rối". Cơ chế gập
  // là CSS thuần (checkbox ẩn + luật ~), nên e2e không đo được cái hiện/ẩn — nhưng đo
  // được thứ mà nếu hỏng thì CSS đó chết câm: THỨ TỰ DOM. Luật `.catdrop:checked~
  // .hnav-menu` chỉ chạy khi checkbox đứng TRƯỚC menu trong cùng cha; ai đó đảo hai
  // dòng đó là menu mở không được nữa mà chẳng có gì báo.
  sect('Menu mobile: nút gập danh mục');
  r = await sf(A.host, '/');
  const drop = /<div class="hnav-drop">([\s\S]*?)<\/div>\s*<\/div>/.exec(r.body)?.[0] ?? '';
  const iCb = drop.indexOf('id="catdrop"'), iMenu = drop.indexOf('class="hnav-menu');
  (iCb > 0 && iMenu > iCb)
    ? ok('checkbox gập đứng TRƯỚC menu trong cùng .hnav-drop (luật ~ mới chạy)')
    : bad('sai thứ tự DOM — menu sẽ không mở được', `cb=${iCb} menu=${iMenu}`);
  /<label class="hnav-trigm" for="catdrop">/.test(drop)
    ? ok('nhãn gập trỏ đúng checkbox') : bad('nhãn gập sai/thiếu');
  // Nhãn thay thẻ <a> ở mobile → phải còn một đường tới /products bên trong menu.
  /<a class="mega-all" href="\/products">/.test(drop)
    ? ok('có "Tất cả sản phẩm" trong menu (mobile không mất đường tới /products)') : bad('thiếu lối vào /products');

  // ── Ảnh danh mục (0118): tự đặt THẮNG ảnh suy từ SP; không có ảnh → chữ cái đầu ──
  // Chủ shop báo "ô danh mục trống, xấu": dải danh mục lấy ảnh SP mới nhất trong danh
  // mục, shop chưa có SP thì mọi ô là một icon lưới xám giống hệt nhau.
  sect('Ảnh danh mục: tự đặt thắng ảnh SP + chữ cái đầu khi trống');
  const barSlug = `nuoc-${uniq()}`;
  const barCat = (await rq(SELLER, 'POST', `/shops/${A.shopId}/categories`, { body: { slug: barSlug, name: 'Đồ uống' }, cookie: A.cookie, origin: OS })).json.id;
  await rq(SELLER, 'PUT', `/shops/${A.shopId}/theme`, { cookie: A.cookie, origin: OS, body: { tokens: {}, layout: [
    { section: 'header', props: {} }, { section: 'category_bar', props: { title: 'Danh mục' } },
    { section: 'product_grid', props: {} }, { section: 'footer', props: {} },
  ] } });
  r = await sf(A.host, '/');
  // "Đồ uống" chưa có SP nào → phải là chữ Đ, không phải icon lưới dùng chung.
  /class="catbar-mono"[^>]*>Đ</.test(r.body)
    ? ok('danh mục chưa có ảnh → chữ cái đầu (Đ), không phải icon lưới') : bad('không có chữ cái đầu', r.body.match(/catbar-ic">[^<]*<[^>]*/)?.[0]);
  // Cho danh mục này MỘT sản phẩm CÓ ẢNH: từ đây trở đi ảnh SP là "đối thủ" thật của
  // ảnh tự đặt. Không có bước này thì ca "tự đặt thắng" chẳng so với gì cả.
  const barPid = (await mkProduct(A.shopId, A.cookie, { title: 'Trà sữa', slug: `trasua-${uniq()}`, price_vnd: 35000, status: 'active', variants: [{ sku: `TS-${uniq()}`, price_vnd: 35000 }] })).json.id;
  await rq(SELLER, 'PUT', `/shops/${A.shopId}/products/${barPid}/categories`, { body: { category_ids: [barCat] }, cookie: A.cookie, origin: OS });
  const prodImgKey = `${A.shopId}/anh-sp-${uniq()}.webp`;
  await owner.query(`INSERT INTO media (shop_id, product_id, status, original_key, public_key, position) VALUES ($1,$2,'ready',$3,$3,0)`, [A.shopId, barPid, prodImgKey]);
  // CHỈ soi trong dải danh mục. Bản đầu soi cả trang và ca "ảnh tự đặt thắng" báo đỏ
  // oan: ảnh SP cũng nằm ở THẺ SẢN PHẨM dưới lưới, nên !includes(prodImgKey) không bao
  // giờ đúng dù dải danh mục đã đổi sang ảnh tự đặt.
  const catbar = (body) => { const i = body.indexOf('class="catbar-row"'); return i < 0 ? '' : body.slice(i, body.indexOf('</section>', i)); };
  r = await sf(A.host, '/');
  catbar(r.body).includes(`/media-public/${prodImgKey}`)
    ? ok('chưa tự đặt ảnh → suy từ ảnh SP trong danh mục (như cũ)') : bad('không suy được ảnh từ SP');
  // Giờ mới gắn ảnh riêng: phải THẮNG ảnh SP ở trên.
  const upCat = await fetch(`${SELLER}/shops/${A.shopId}/categories/${barCat}/image`, { method: 'POST', headers: { 'content-type': 'image/png', origin: OS, cookie: `__Host-session=${A.cookie}` }, body: PNG_1x1 });
  const catKey = (await upCat.json().catch(() => null))?.key;
  r = await sf(A.host, '/');
  (catKey && catbar(r.body).includes(`/media-public/${catKey}`) && !catbar(r.body).includes(`/media-public/${prodImgKey}`))
    ? ok('ảnh tự đặt THẮNG ảnh suy từ SP') : bad('ảnh tự đặt không thắng', String(catKey));
  // Gỡ ảnh → rơi về ảnh SP, không phải chữ cái đầu (danh mục này giờ đã có SP có ảnh).
  await rq(SELLER, 'DELETE', `/shops/${A.shopId}/categories/${barCat}/image`, { cookie: A.cookie, origin: OS });
  r = await sf(A.host, '/');
  (!catbar(r.body).includes(`/media-public/${catKey}`) && catbar(r.body).includes(`/media-public/${prodImgKey}`))
    ? ok('gỡ ảnh → rơi về ảnh SP') : bad('gỡ ảnh không có tác dụng');

  // Link javascript: phải bị chặn ở render (đề phòng) — nút về '#'.
  await rq(SELLER, 'PUT', `/shops/${A.shopId}/theme`, { cookie: A.cookie, origin: OS, body: { tokens: {}, layout: [
    { section: 'hero', props: { slides: [{ image_key: bnKey, headline: 'X', button_label: 'Bấm', button_link: '/an/toan' }] } },
    { section: 'product_grid', props: {} },
  ] } });
  r = await sf(A.host, '/');
  r.body.includes('href="/an/toan"') ? ok('button_link nội bộ giữ nguyên khi render') : bad('link nội bộ render sai');
  // Bỏ slides → fallback hero tự động (chữ + ảnh sản phẩm) trở lại.
  await rq(SELLER, 'PUT', `/shops/${A.shopId}/theme`, { cookie: A.cookie, origin: OS, body: { tokens: {}, layout: [
    { section: 'hero', props: { title: 'HERO-QUAY-LAI' } },
    { section: 'product_grid', props: {} },
  ] } });
  r = await sf(A.host, '/');
  // Lưu ý: chuỗi "hero-banner" cũng nằm trong CSS nội tuyến → phải khớp CLASS trong markup.
  !r.body.includes('class="hero hero-banner') && r.body.includes('hero-track')
    ? ok('bỏ banner → fallback hero tự động (không còn hero-banner)') : bad('fallback hero tự động lỗi', r.body.match(/<section class="hero[^"]*"/)?.[0]);

  // ── Nâng cấp banner: fallback CSS nhanh hơn + khung tỷ lệ cố định + JS carousel ──
  r.body.includes('hcycle2 10s') && r.body.includes('hcycle3 15s') && r.body.includes('animation-delay:5s')
    ? ok('CSS fallback tăng tốc: hcycle2 10s / hcycle3 15s / delay 5s') : bad('keyframes fallback chưa đổi tốc độ');
  r.body.includes('aspect-ratio:21/8') && r.body.includes('aspect-ratio:4/3') && r.body.includes('object-position:center')
    ? ok('banner khung tỷ lệ CỐ ĐỊNH 21/8 (mobile 4/3) + object-fit cover — upload là khớp') : bad('thiếu aspect-ratio/cover banner');
  const heroScript = (r.body.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/) || [])[1] || '';
  heroScript.includes('js-run') && heroScript.includes('hero-arrow') && heroScript.includes('5000') && heroScript.includes('mouseenter')
    ? ok('script carousel: .js-run + mũi tên/chấm JS dựng + 5s + dừng khi rê') : bad('script carousel thiếu');
  !heroScript.includes('.innerHTML') && (r.body.match(/<script/g) || []).length === 1
    ? ok('carousel nằm TRONG một khối <script> duy nhất, không innerHTML') : bad('script carousel vi phạm quy ước');

  // ── Phase 5b: menu header tự chỉnh (toggle shortcut + nav_links) qua HTTP ─────
  // Shortcut khớp CHUỖI ĐẦY ĐỦ (href+text) để không đụng chuỗi khác trong trang.
  await rq(SELLER, 'PUT', `/shops/${A.shopId}/theme`, { cookie: A.cookie, origin: OS, body: { tokens: {}, layout: [
    { section: 'header', props: { menu_show_new: false, nav_links: [
      { label: 'NAVLINK-AN-TOAN', url: '/pages/gioi-thieu' },
      { label: '<b>XSSNAV</b>', url: '/pages/xss' },      // url AN TOÀN, nhãn XSS → nhãn phải esc
      { label: 'BADURL', url: 'javascript:alert(1)' },    // url độc → seller BỎ NGUYÊN mục
    ] } },
    { section: 'product_grid', props: {} },
  ] } });
  r = await sf(A.host, '/');
  !r.body.includes('<a href="/products?sort=new">Hàng mới</a>')
    ? ok('menu_show_new=false → shortcut "Hàng mới" ẩn') : bad('toggle shortcut không ẩn');
  r.body.includes('href="/pages/gioi-thieu">NAVLINK-AN-TOAN</a>')
    ? ok('nav_links tuỳ chỉnh render (nhãn + href nội bộ)') : bad('nav_links không render');
  (r.body.includes('&lt;b&gt;XSSNAV&lt;/b&gt;') && !r.body.includes('<b>XSSNAV</b>'))
    ? ok('nav_link nhãn XSS bị escape khi render') : bad('nhãn nav_link không escape');
  (!r.body.includes('>BADURL<') && !r.body.includes('javascript:alert'))
    ? ok('nav_link url javascript: → seller BỎ nguyên mục (không lọt)') : bad('url javascript: lọt');
  // Bỏ cấu hình header → 3 shortcut hiện đủ lại (mặc định = hành vi cũ).
  await rq(SELLER, 'PUT', `/shops/${A.shopId}/theme`, { cookie: A.cookie, origin: OS, body: { tokens: {}, layout: [
    { section: 'header', props: {} },
    { section: 'product_grid', props: {} },
  ] } });
  r = await sf(A.host, '/');
  r.body.includes('<a href="/products?sort=new">Hàng mới</a>') && r.body.includes('<a href="/products?sort=price_asc">Khuyến mãi</a>')
    ? ok('bỏ cấu hình header → 3 shortcut hiện đủ, trỏ /products?sort= (đích mới)') : bad('shortcut mặc định không hiện/không trỏ /products');

  // ── FLASH SALE SECTION (preset mỹ phẩm/M.O.I): đồng hồ đếm ngược + hàng SP đang sale, TỰ ẨN khi hết promo ──
  sect('Flash sale SECTION (mỹ phẩm): countdown data-ends + hàng SP sale + tự ẩn');
  // Đặt layout có flash_sale qua owner pool (cuối test → không ảnh hưởng assertion trước).
  await owner.query(
    `INSERT INTO themes (shop_id, tokens, layout, version) VALUES ($1,'{}'::jsonb,$2::jsonb,1)
       ON CONFLICT (shop_id) DO UPDATE SET layout = EXCLUDED.layout, version = themes.version + 1`,
    [A.shopId, JSON.stringify([
      { section: 'header', props: {} }, { section: 'hero', props: { slides: [] } },
      { section: 'flash_sale', props: { title: 'Flash sale' } }, { section: 'footer', props: {} },
    ])]);
  const { rows: [fsPromo] } = await owner.query(
    `INSERT INTO promotions (shop_id,title,kind,value,scope,starts_at,ends_at,active)
     VALUES ($1,'FS Section','percent',30,'all', now()-interval '1 hour', now()+interval '5 hour', true) RETURNING id`, [A.shopId]);
  r = await sf(A.host, '/');
  const fsEnds = Number((r.body.match(/class="fs-timer" data-ends="(\d+)"/) || [])[1]);
  r.body.includes('class="section flashsale"') && r.body.includes('class="fs-timer"') && Number.isFinite(fsEnds) && fsEnds > Date.now()
    ? ok('flash_sale hiện: section + đồng hồ data-ends (epoch tương lai)') : bad('flash_sale thiếu/đồng hồ sai', String(fsEnds));
  r.body.includes('class="fs-d"') && r.body.includes('class="fs-s"') && r.body.includes('class="fs-row"') && r.body.includes('-30%')
    ? ok('flash_sale: ô đếm ngược Ngày…Giây + hàng thẻ SP đang giảm (-30%)') : bad('flash_sale thiếu ô đếm/hàng SP sale');
  await owner.query(`DELETE FROM promotions WHERE id=$1`, [fsPromo.id]); // hết promo
  r = await sf(A.host, '/');
  !r.body.includes('class="section flashsale"')
    ? ok('hết promo → flash_sale TỰ ẨN (layout vẫn có section nhưng không dữ liệu)') : bad('flash_sale vẫn hiện khi hết promo');

  // ── BỐ CỤC M.O.I (preset mỹ phẩm): nav HỒNG band + hero SPLIT + promo_banners tự-ẩn + lưới 5×2 ──
  sect('Bố cục M.O.I: header band + hero split + promo_banners + lưới 10');
  const bkey = () => `${A.shopId}/banner-${A.shopId}.webp`; // đúng BANNER_KEY_RE (uuid/banner-uuid.webp)
  const SIDE2 = [{ image_key: bkey(), headline: 'Son thỏi' }, { image_key: bkey(), headline: 'Đối tác' }];
  const setLayout = (promoSlides, sideSlides) => owner.query(
    `INSERT INTO themes (shop_id, tokens, layout, version) VALUES ($1,'{}'::jsonb,$2::jsonb,1)
       ON CONFLICT (shop_id) DO UPDATE SET layout = EXCLUDED.layout, version = themes.version + 1`,
    [A.shopId, JSON.stringify([
      { section: 'header', props: { nav_style: 'band' } },
      { section: 'hero', props: { variant: 'split', slides: [ // ô lớn = CAROUSEL (2 slide)
        { image_key: bkey(), headline: 'Chốt deal tháng 7' }, { image_key: bkey(), headline: 'Deal tháng 8' },
      ] } },
      { section: 'hero_side', props: { slides: sideSlides } }, // 2 banner phụ phải
      { section: 'promo_banners', props: { slides: promoSlides } },
      { section: 'product_grid', props: { title: 'Bán chạy', columns: 5 } },
      { section: 'footer', props: {} },
    ])]);
  await setLayout([], SIDE2); // promo rỗng · có 2 banner phụ → hero split đầy đủ
  r = await sf(A.host, '/');
  r.body.includes('class="hdr hdr-band"') && r.body.includes('class="hnav-band"')
    ? ok('header dải nav HỒNG (band): .hdr-band + .hnav-band') : bad('thiếu dải nav band');
  const heroSeg = (r.body.match(/class="hero hero-split[^"]*"[\s\S]*?<\/section>/) || [''])[0];
  r.body.includes('class="hero-split-grid"') && heroSeg.includes('class="hs-main"') && heroSeg.includes('class="hslide') && (heroSeg.match(/class="hs-cell"/g) || []).length === 2 && (r.body.match(/<h1/g) || []).length === 1
    ? ok('hero SPLIT: ô lớn CAROUSEL (.hslide) + 2 ô phụ (.hs-cell) · đúng 1 <h1>') : bad('hero split sai');
  !r.body.includes('class="promo-grid"') ? ok('promo_banners RỖNG → tự ẩn (không .promo-grid)') : bad('promo rỗng vẫn hiện');
  (r.body.match(/<div class="card(?: is-out)?">/g) || []).length === 10 && r.body.includes('grid-c5')
    ? ok('lưới bán chạy .grid-c5 đủ 10 thẻ (5×2)') : bad(`lưới 5×2 sai (${(r.body.match(/<div class="card(?: is-out)?">/g) || []).length} thẻ)`);
  await setLayout([], []); // KHÔNG banner phụ → hero về carousel full-width (fallback, không vỡ)
  r = await sf(A.host, '/');
  r.body.includes('class="hero hero-banner') && !r.body.includes('class="hero-split-grid"')
    ? ok('hero split KHÔNG có banner phụ → carousel full-width (fallback)') : bad('fallback hero split sai');
  await setLayout([{ image_key: bkey(), headline: 'Ưu đãi 1', button_link: '/products' }, { image_key: bkey(), headline: 'Ưu đãi 2' }, { image_key: bkey() }], SIDE2);
  r = await sf(A.host, '/');
  r.body.includes('class="promo-grid"') && (r.body.match(/class="promo-cell"/g) || []).length === 3
    ? ok('promo_banners CÓ 3 ảnh → dải 3 ô (.promo-cell ×3)') : bad('promo 3 ô sai');
  // Hồi quy: header KHÔNG band (preset khác) → không có .hdr-band.
  await owner.query(`INSERT INTO themes (shop_id, tokens, layout, version) VALUES ($1,'{}'::jsonb,$2::jsonb,1) ON CONFLICT (shop_id) DO UPDATE SET layout = EXCLUDED.layout, version = themes.version + 1`,
    [A.shopId, JSON.stringify([{ section: 'header', props: {} }, { section: 'product_grid', props: {} }])]);
  r = await sf(A.host, '/');
  // (kiểm CLASS phần tử, không phải chuỗi 'hdr-band' trong CSS): band = <header class="hdr hdr-band">.
  !r.body.includes('class="hdr hdr-band"') && r.body.includes('class="hdr"') ? ok('header KHÔNG band (ngành khác) → header 1 thanh cũ, không hồi quy') : bad('header thường lại thành band');

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('storefront e2e lỗi:', err); process.exit(2); });
