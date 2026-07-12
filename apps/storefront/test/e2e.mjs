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
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: r.json.token, password }, origin: OA });
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
  !r.body.includes('evilrule') && !r.body.includes('display:none')
    ? ok('token ĐỘC bị sanitize (không breakout CSS)') : bad('token độc breakout', 'body chứa evilrule/display:none');

  // CSP: lớp phòng thủ XSS thứ hai. Phải chặn script; frame-ancestors none.
  const csp = r.headers['content-security-policy'] ?? '';
  csp.includes("default-src 'none'") && !csp.includes("script-src 'unsafe-inline'") && csp.includes("frame-ancestors 'none'")
    ? ok('có CSP nghiêm ngặt (default-src none, không script, chống clickjacking)') : bad('CSP thiếu/lỏng', csp);
  r.headers['x-frame-options'] === 'DENY' ? ok('X-Frame-Options: DENY') : bad('thiếu X-Frame-Options');

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
  await rq(PLATFORM, 'POST', `/ops/shops/${A.shopId}/suspend`, { body: { reason: 'test' }, cookie: staff, origin: OO });
  r = await sf(A.host, '/');
  r.status === 503 && !r.body.includes('&lt;script&gt;') ? ok('shop suspended → 503 trang bảo trì (không render sản phẩm)') : bad('suspended vẫn render', String(r.status));
  await rq(PLATFORM, 'POST', `/ops/shops/${A.shopId}/restore`, { cookie: staff, origin: OO });
  r = await sf(A.host, '/');
  r.status === 200 ? ok('restore → storefront hoạt động lại (200)') : bad('restore không phục hồi', String(r.status));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('storefront e2e lỗi:', err); process.exit(2); });
