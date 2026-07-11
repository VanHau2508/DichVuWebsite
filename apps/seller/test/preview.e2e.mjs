/**
 * End-to-end XEM TRƯỚC (preview) bản draft trên storefront (mở rộng Ngày 11). Chạy:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/preview.e2e.mjs
 *
 * Bất biến:
 *   - Draft KHÔNG hề công khai khi chưa publish; preview CHỈ mở qua token seller cấp.
 *   - Storefront đọc SNAPSHOT (page_previews), không đọc pages.blocks; snapshot đóng
 *     băng lúc bấm preview, bấm lại (upsert) làm chết token cũ.
 *   - Preview escape XSS, có banner cảnh báo, header no-store + noindex (không CDN/SEO).
 *   - Cô lập tenant: token shop A vô hình ở domain shop B (RLS store_preview).
 *   - Token ràng với slug; token hết hạn → 404 (RLS cưỡng chế); xoá trang → preview chết.
 *   - RBAC: content.read mới được cấp preview.
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

// Gọi storefront với Host = domain của shop (giữ nguyên query string).
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
  return { shopId, slug, host: `${slug}.nentang.vn`, email, password, cookie: await login(email, password) };
}

async function inviteMember(shopId, ownerCookie, role) {
  const email = `${role}-${uniq()}@shop.vn`, password = 'member passphrase good';
  const r = await rq(SELLER, 'POST', `/shops/${shopId}/members/invite`, { body: { email, role }, cookie: ownerCookie, origin: OS });
  if (r.status !== 201) throw new Error(`mời ${role} thất bại: ${r.raw}`);
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: r.json.token, password }, origin: OA });
  return { email, cookie: await login(email, password) };
}

const S = (shopId, cookie) => ({
  get: (p) => rq(SELLER, 'GET', `/shops/${shopId}${p}`, { cookie }),
  post: (p, body) => rq(SELLER, 'POST', `/shops/${shopId}${p}`, { body, cookie, origin: OS }),
  patch: (p, body) => rq(SELLER, 'PATCH', `/shops/${shopId}${p}`, { body, cookie, origin: OS }),
  del: (p) => rq(SELLER, 'DELETE', `/shops/${shopId}${p}`, { cookie, origin: OS }),
});

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `pv-${uniq()}`);
  const Bs = await makeShopOwner(staff, `pvb-${uniq()}`);
  const a = S(A.shopId, A.cookie);
  ok('dựng 2 shop + owner');

  const XSS = `<script>alert('x')</script>`;
  const V1 = 'BAN DRAFT MOT', V2 = 'BAN DRAFT HAI', V3 = 'BAN DRAFT BA';

  // ── 1. Tạo draft, chưa publish ─────────────────────────────────────────────
  sect('1. Draft chưa publish → không công khai');
  let r = await a.post('/pages', { slug: 'gioi-thieu', title: 'Giới thiệu', blocks: [{ type: 'paragraph', text: `${V1} ${XSS}` }] });
  const pageId = r.json?.id;
  r.status === 201 ? ok('tạo trang draft') : bad('tạo trang lỗi', r.raw);
  r = await sf(A.host, '/pages/gioi-thieu');
  r.status === 404 ? ok('công khai (chưa publish) → 404') : bad('draft lộ công khai', String(r.status));

  // ── 2. Cấp token preview ───────────────────────────────────────────────────
  sect('2. Seller cấp link preview');
  r = await a.post(`/pages/${pageId}/preview`, {});
  const token1 = r.json?.token;
  r.status === 201 && token1 && r.json.preview_url === `https://${A.host}/pages/gioi-thieu?preview=${token1}` && r.json.expires_in === 1800
    ? ok('preview → 201, preview_url + token + TTL đúng') : bad('cấp preview lỗi', r.raw);

  // ── 3. Storefront render preview ───────────────────────────────────────────
  sect('3. Storefront render bản nháp qua token');
  r = await sf(A.host, `/pages/gioi-thieu?preview=${token1}`);
  r.status === 200 && r.body.includes(V1) ? ok('preview → 200, hiện nội dung draft (V1)') : bad('preview không hiện draft', `status=${r.status}`);
  !r.body.includes('<script>alert') && r.body.includes('&lt;script&gt;') ? ok('XSS trong draft được ESCAPE') : bad('XSS không escape trong preview');
  r.body.includes('BẢN NHÁP') ? ok('có banner cảnh báo BẢN NHÁP') : bad('thiếu banner preview');
  r.headers['cache-control'] === 'no-store' ? ok('header Cache-Control: no-store') : bad('preview thiếu no-store', r.headers['cache-control']);
  /noindex/.test(r.headers['x-robots-tag'] ?? '') ? ok('header X-Robots-Tag: noindex') : bad('preview thiếu noindex', r.headers['x-robots-tag']);

  // ── 4. Token không cho vượt rào ────────────────────────────────────────────
  sect('4. Token không mở được cửa khác');
  r = await sf(A.host, '/pages/gioi-thieu');
  r.status === 404 ? ok('không token → vẫn 404 (preview không publish gì)') : bad('không token vẫn xem được', String(r.status));
  r = await sf(A.host, '/pages/gioi-thieu?preview=rac-khong-hop-le');
  r.status === 404 ? ok('token rác → 404') : bad('token rác vẫn mở', String(r.status));
  r = await sf(A.host, `/pages/slug-khac?preview=${token1}`);
  r.status === 404 ? ok('token đúng nhưng SAI slug → 404 (ràng slug)') : bad('token dùng được ở slug khác', String(r.status));
  r = await sf(Bs.host, `/pages/gioi-thieu?preview=${token1}`);
  r.status === 404 ? ok('token shop A ở domain shop B → 404 (cô lập tenant RLS)') : bad('rò preview chéo shop', String(r.status));

  // ── 5. Snapshot đóng băng + cấp lại làm chết token cũ ───────────────────────
  sect('5. Snapshot đóng băng; re-mint thay token');
  await a.patch(`/pages/${pageId}`, { blocks: [{ type: 'paragraph', text: V2 }] });
  r = await sf(A.host, `/pages/gioi-thieu?preview=${token1}`);
  r.body.includes(V1) && !r.body.includes(V2) ? ok('sửa draft xong token cũ VẪN hiện V1 (snapshot đóng băng)') : bad('snapshot không đóng băng');
  r = await a.post(`/pages/${pageId}/preview`, {});
  const token2 = r.json?.token;
  r = await sf(A.host, `/pages/gioi-thieu?preview=${token2}`);
  r.body.includes(V2) ? ok('cấp lại → token mới hiện V2') : bad('token mới không hiện V2');
  r = await sf(A.host, `/pages/gioi-thieu?preview=${token1}`);
  r.status === 404 ? ok('token cũ chết sau khi cấp lại (upsert thay hash)') : bad('token cũ vẫn sống', String(r.status));

  // ── 6. Published độc lập với preview ───────────────────────────────────────
  sect('6. Preview hiện draft kể cả khi trang đã published');
  await a.post(`/pages/${pageId}/publish`, {}); // publish snapshot V2
  r = await sf(A.host, '/pages/gioi-thieu');
  r.status === 200 && r.body.includes(V2) && !r.body.includes('BẢN NHÁP') ? ok('công khai → 200 bản published (V2), không banner') : bad('published sai', String(r.status));
  await a.patch(`/pages/${pageId}`, { blocks: [{ type: 'paragraph', text: V3 }] }); // draft → V3
  r = await a.post(`/pages/${pageId}/preview`, {});
  const token3 = r.json?.token;
  r = await sf(A.host, `/pages/gioi-thieu?preview=${token3}`);
  r.body.includes(V3) ? ok('preview hiện draft mới nhất (V3)') : bad('preview không hiện V3');
  r = await sf(A.host, '/pages/gioi-thieu');
  r.body.includes(V2) && !r.body.includes(V3) ? ok('công khai vẫn là V2 (published), không phải draft V3') : bad('draft rò ra công khai');

  // ── 7. Hết hạn (RLS cưỡng chế) ─────────────────────────────────────────────
  sect('7. Token hết hạn');
  await owner.query(`UPDATE page_previews SET expires_at = now() - interval '1 minute' WHERE page_id = $1`, [pageId]);
  r = await sf(A.host, `/pages/gioi-thieu?preview=${token3}`);
  r.status === 404 ? ok('preview quá hạn → 404') : bad('preview quá hạn vẫn mở', String(r.status));

  // ── 8. Xoá trang → preview chết ────────────────────────────────────────────
  sect('8. Xoá trang dọn preview');
  r = await a.post(`/pages/${pageId}/preview`, {}); // cấp lại token4 còn hạn
  const token4 = r.json?.token;
  await a.del(`/pages/${pageId}`);
  r = await sf(A.host, `/pages/gioi-thieu?preview=${token4}`);
  r.status === 404 ? ok('sau khi xoá trang, token còn hạn cũng → 404') : bad('preview sống sau khi xoá trang', String(r.status));
  const left = await owner.query('SELECT count(*)::int n FROM page_previews WHERE page_id = $1', [pageId]);
  left.rows[0].n === 0 ? ok('DB: dòng page_previews đã bị dọn') : bad('preview còn treo trong DB', String(left.rows[0].n));

  // ── 9. RBAC ────────────────────────────────────────────────────────────────
  sect('9. RBAC: chỉ content.read mới cấp được preview');
  const pg2 = (await a.post('/pages', { slug: `p2-${uniq()}`, title: 'Trang 2', blocks: [] })).json.id;
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: A.password }, cookie: A.cookie, origin: OA });
  const catalog = await inviteMember(A.shopId, A.cookie, 'catalog_manager');
  r = await S(A.shopId, catalog.cookie).post(`/pages/${pg2}/preview`, {});
  r.status === 403 ? ok('catalog_manager cấp preview → 403 (thiếu content.read)') : bad('catalog_manager cấp được preview', String(r.status));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('preview e2e lỗi:', err); process.exit(2); });
