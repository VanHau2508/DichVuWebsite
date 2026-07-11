/**
 * End-to-end SEO meta theo trang (mở rộng Ngày 11). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/seo.e2e.mjs
 *
 * Bất biến:
 *   - seo_title/seo_description render đúng vào <title> + meta description + OG + Twitter + canonical.
 *   - SEO versioned theo draft/publish: sửa draft KHÔNG đổi bản live; publish/rollback mới đổi.
 *   - Escape thuộc tính: seo độc (">/</title>) không breakout được (ADR-008).
 *   - Fallback: thiếu seo → tiêu đề "Trang — Shop" + mô tả suy từ block đầu.
 *   - Preview hiện SEO của draft + robots noindex.
 *   - Validation độ dài; getPage trả seo.
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
const uid = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;

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
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,'admin')`, [await uid(email)]);
  while (counterFor(Date.now()) <= c) await sleep(1000);
  cookie = await login(email, password);
  await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA });
  return cookie;
}
async function makeShopOwner(staffCookie, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: r.json.token, password }, origin: OA });
  return { shopId, slug, host: `${slug}.nentang.vn`, name: slug, cookie: await login(email, password) };
}
const S = (shopId, cookie) => ({
  get: (p) => rq(SELLER, 'GET', `/shops/${shopId}${p}`, { cookie }),
  post: (p, body) => rq(SELLER, 'POST', `/shops/${shopId}${p}`, { body, cookie, origin: OS }),
  patch: (p, body) => rq(SELLER, 'PATCH', `/shops/${shopId}${p}`, { body, cookie, origin: OS }),
});

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `seo-${uniq()}`);
  const a = S(A.shopId, A.cookie);
  ok('dựng shop + owner');

  const SEO_T = 'Chính sách đổi trả 30 ngày | Shop ABC';
  const SEO_D = 'Đổi trả miễn phí trong 30 ngày, hoàn tiền 100% nếu lỗi nhà sản xuất.';

  // ── 1. Tạo + publish trang có SEO ──────────────────────────────────────────
  sect('1. Render SEO/OG khi published');
  let r = await a.post('/pages', {
    slug: 'doi-tra', title: 'Đổi trả', blocks: [{ type: 'paragraph', text: 'Nội dung chi tiết chính sách.' }],
    seo_title: SEO_T, seo_description: SEO_D,
  });
  const pageId = r.json?.id;
  r.status === 201 ? ok('tạo trang có seo') : bad('tạo trang lỗi', r.raw);
  r = await a.get(`/pages/${pageId}`);
  r.json?.seo_title === SEO_T && r.json?.seo_description === SEO_D ? ok('getPage trả seo (draft)') : bad('getPage thiếu seo', r.raw);
  await a.post(`/pages/${pageId}/publish`, {});

  r = await sf(A.host, '/pages/doi-tra');
  const canonical = `https://${A.host}/pages/doi-tra`;
  r.status === 200 && r.body.includes(`<title>${SEO_T}</title>`) ? ok('<title> = seo_title') : bad('title sai', r.body.match(/<title>[^<]*<\/title>/)?.[0]);
  r.body.includes(`<meta name="description" content="${SEO_D}">`) ? ok('meta description = seo_description') : bad('thiếu meta description');
  r.body.includes(`<meta property="og:title" content="${SEO_T}">`) ? ok('og:title') : bad('thiếu og:title');
  r.body.includes(`<meta property="og:description" content="${SEO_D}">`) ? ok('og:description') : bad('thiếu og:description');
  r.body.includes('<meta property="og:type" content="article">') ? ok('og:type=article') : bad('thiếu og:type');
  r.body.includes(`<meta property="og:url" content="${canonical}">`) ? ok('og:url = canonical') : bad('og:url sai');
  r.body.includes(`<link rel="canonical" href="${canonical}">`) ? ok('link canonical') : bad('thiếu canonical');
  r.body.includes(`<meta property="og:site_name" content="${A.name}">`) ? ok('og:site_name = tên shop') : bad('thiếu og:site_name');
  r.body.includes('<meta name="twitter:card" content="summary">') ? ok('twitter:card') : bad('thiếu twitter:card');

  // ── 2. Escape thuộc tính (attribute injection) ─────────────────────────────
  sect('2. Escape thuộc tính SEO');
  const XT = '</title><script>alert(1)</script>';
  const XD = '"><script>alert(2)</script>';
  await a.patch(`/pages/${pageId}`, { seo_title: XT, seo_description: XD });
  await a.post(`/pages/${pageId}/publish`, {});
  r = await sf(A.host, '/pages/doi-tra');
  !r.body.includes('</title><script>') && r.body.includes('&lt;/title&gt;') ? ok('seo_title độc bị escape (không breakout <title>)') : bad('seo_title breakout');
  !r.body.includes('"><script>') && r.body.includes('&lt;script&gt;') ? ok('seo_description độc bị escape (không breakout attribute)') : bad('seo_description breakout');

  // ── 3. SEO versioned theo draft/publish ────────────────────────────────────
  sect('3. Sửa draft SEO không đổi bản live');
  const SEO_D2 = 'MÔ TẢ PHIÊN BẢN HAI';
  await a.patch(`/pages/${pageId}`, { seo_title: 'Tiêu đề SEO v2', seo_description: SEO_D2 });
  r = await sf(A.host, '/pages/doi-tra');
  !r.body.includes(SEO_D2) ? ok('sửa draft SEO xong bản live VẪN như cũ (versioned)') : bad('draft SEO rò ra bản live');
  await a.post(`/pages/${pageId}/publish`, {});
  r = await sf(A.host, '/pages/doi-tra');
  r.body.includes(`<meta name="description" content="${SEO_D2}">`) ? ok('publish → SEO mới lên live') : bad('publish không cập nhật SEO');

  // ── 4. Rollback khôi phục SEO cũ ───────────────────────────────────────────
  sect('4. Rollback khôi phục SEO');
  // revision 1 = SEO_T/SEO_D (bản đầu). Rollback về 1 → live quay lại SEO_D.
  r = await a.post(`/pages/${pageId}/rollback`, { revision: 1 });
  r.status === 200 ? ok('rollback về revision 1') : bad('rollback lỗi', r.raw);
  r = await sf(A.host, '/pages/doi-tra');
  r.body.includes(`<meta name="description" content="${SEO_D}">`) && !r.body.includes(SEO_D2)
    ? ok('storefront khôi phục SEO của revision 1') : bad('rollback không khôi phục SEO');

  // ── 5. Fallback khi thiếu SEO ──────────────────────────────────────────────
  sect('5. Fallback tiêu đề + mô tả suy từ block');
  const FB = 'Đây là đoạn mở đầu dùng làm mô tả dự phòng cho SEO.';
  const p2 = (await a.post('/pages', { slug: 'gioi-thieu', title: 'Giới thiệu', blocks: [{ type: 'paragraph', text: FB }] })).json.id;
  await a.post(`/pages/${p2}/publish`, {});
  r = await sf(A.host, '/pages/gioi-thieu');
  r.body.includes(`<title>Giới thiệu — ${A.name}</title>`) ? ok('thiếu seo_title → "Trang — Shop"') : bad('fallback title sai', r.body.match(/<title>[^<]*<\/title>/)?.[0]);
  r.body.includes(`<meta name="description" content="${FB}">`) ? ok('thiếu seo_description → suy từ block đầu') : bad('fallback description sai');

  // ── 6. Preview hiện SEO draft + noindex ────────────────────────────────────
  sect('6. Preview SEO của draft');
  await a.patch(`/pages/${p2}`, { seo_title: 'SEO NHÁP MỚI' });
  const tok = (await a.post(`/pages/${p2}/preview`, {})).json.token;
  r = await sf(A.host, `/pages/gioi-thieu?preview=${tok}`);
  r.body.includes('SEO NHÁP MỚI') ? ok('preview hiện seo_title của draft') : bad('preview thiếu seo draft');
  /noindex/.test((r.body.match(/<meta name="robots" content="([^"]*)"/) ?? [])[1] ?? '') ? ok('preview có meta robots noindex') : bad('preview thiếu meta noindex');
  r = await sf(A.host, '/pages/gioi-thieu');
  !r.body.includes('SEO NHÁP MỚI') ? ok('công khai KHÔNG lộ seo draft') : bad('seo draft rò ra công khai');

  // ── 7. Validation ──────────────────────────────────────────────────────────
  sect('7. Validation độ dài');
  r = await a.post('/pages', { slug: `v-${uniq()}`, title: 'X', blocks: [], seo_title: 'x'.repeat(121) });
  r.status === 400 ? ok('seo_title > 120 → 400') : bad('seo_title dài vẫn nhận', String(r.status));
  r = await a.post('/pages', { slug: `v-${uniq()}`, title: 'X', blocks: [], seo_description: 'x'.repeat(321) });
  r.status === 400 ? ok('seo_description > 320 → 400') : bad('seo_description dài vẫn nhận', String(r.status));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('seo e2e lỗi:', err); process.exit(2); });
