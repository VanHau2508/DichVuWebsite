/**
 * End-to-end trang nội dung/chính sách (Ngày 11). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/content.e2e.mjs
 *
 * Kiểm vòng đời draft → publish → sửa draft → publish lại → rollback, và bất biến:
 *   - Storefront CHỈ hiện bản PUBLISHED (draft vô hình, sửa draft không đổi live).
 *   - Rollback trỏ published về revision cũ, KHÔNG đụng draft.
 *   - Block text-only được ESCAPE (chống XSS).
 *   - Menu chân trang chỉ gồm trang đã published có menu_position.
 *   - Cô lập tenant: thành viên/khách shop A không chạm nội dung shop B.
 *   - RBAC: content.write/read theo vai trò; append-only revisions.
 *   - Soft delete: ẩn khỏi storefront + menu, dữ liệu còn trong DB.
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
const uid = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;

// Gọi storefront với Host = domain của shop.
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
  return { shopId, slug, host: `${slug}.nentang.vn`, email, password, cookie: await login(email, password) };
}

// Owner (đã step-up) mời thành viên vai trò role → trả cookie thành viên.
async function inviteMember(shopId, ownerCookie, role) {
  const email = `${role}-${uniq()}@shop.vn`, password = 'member passphrase good';
  const r = await rq(SELLER, 'POST', `/shops/${shopId}/members/invite`, { body: { email, role }, cookie: ownerCookie, origin: OS });
  if (r.status !== 201) throw new Error(`mời ${role} thất bại: ${r.raw}`);
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { email, cookie: await login(email, password) };
}

// helper gọi seller content theo shop
const S = (shopId, cookie) => ({
  get: (p) => rq(SELLER, 'GET', `/shops/${shopId}${p}`, { cookie }),
  post: (p, body) => rq(SELLER, 'POST', `/shops/${shopId}${p}`, { body, cookie, origin: OS }),
  patch: (p, body) => rq(SELLER, 'PATCH', `/shops/${shopId}${p}`, { body, cookie, origin: OS }),
  del: (p) => rq(SELLER, 'DELETE', `/shops/${shopId}${p}`, { cookie, origin: OS }),
});

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `cnt-${uniq()}`);
  const Bs = await makeShopOwner(staff, `cntb-${uniq()}`);
  const a = S(A.shopId, A.cookie);
  const b = S(Bs.shopId, Bs.cookie);
  ok('dựng 2 shop + owner');

  const XSS = `<script>alert('x')</script>`;
  const V1 = 'NOI DUNG BAN MOT';
  const V2 = 'NOI DUNG BAN HAI';

  // ── 1. Tạo trang (draft) — chưa xuất bản ───────────────────────────────────
  sect('1. Tạo trang draft');
  let r = await a.post('/pages', {
    slug: 'chinh-sach', title: 'Chính sách đổi trả',
    blocks: [{ type: 'heading', text: 'Điều khoản' }, { type: 'paragraph', text: `${V1} ${XSS}` }],
  });
  const pageId = r.json?.id;
  r.status === 201 && pageId && r.json.status === 'draft' ? ok('tạo trang → 201 draft') : bad('tạo trang lỗi', r.raw);

  r = await sf(A.host, '/pages/chinh-sach');
  r.status === 404 ? ok('storefront: trang DRAFT chưa publish → 404') : bad('draft bị lộ trên storefront', String(r.status));

  r = await sf(A.host, '/');
  !r.body.includes('Chính sách đổi trả') ? ok('menu chân trang CHƯA có trang draft') : bad('draft đã lọt vào menu');

  // ── 2. Validation ──────────────────────────────────────────────────────────
  sect('2. Validation');
  const badCases = [
    ['slug sai', { slug: 'Không Hợp Lệ', title: 'X', blocks: [] }],
    ['tiêu đề rỗng', { slug: `s-${uniq()}`, title: '  ', blocks: [] }],
    ['block type lạ', { slug: `s-${uniq()}`, title: 'X', blocks: [{ type: 'iframe', text: 'x' }] }],
    ['quá 100 block', { slug: `s-${uniq()}`, title: 'X', blocks: Array.from({ length: 101 }, () => ({ type: 'paragraph', text: 'x' })) }],
  ];
  for (const [name, body] of badCases) {
    const rr = await a.post('/pages', body);
    rr.status === 400 ? ok(`${name} → 400`) : bad(`${name} → ${rr.status}, mong 400`, rr.raw);
  }
  r = await a.post('/pages', { slug: 'chinh-sach', title: 'Trùng', blocks: [] });
  r.status === 409 ? ok('slug trùng trong shop → 409') : bad('slug trùng vẫn tạo', r.raw);

  // ── 3. Publish → hiện trên storefront (escape XSS) ─────────────────────────
  sect('3. Publish → storefront hiện bản published');
  r = await a.post(`/pages/${pageId}/publish`, {});
  r.status === 200 && r.json.revision === 1 ? ok('publish → revision 1') : bad('publish lỗi', r.raw);

  r = await sf(A.host, '/pages/chinh-sach');
  r.status === 200 && r.body.includes('Điều khoản') && r.body.includes(V1)
    ? ok('storefront: trang published → 200, hiện nội dung v1') : bad('published không hiện', `status=${r.status}`);
  !r.body.includes('<script>alert') && r.body.includes('&lt;script&gt;')
    ? ok('nội dung chứa XSS được ESCAPE (không có <script> thô)') : bad('XSS trong block không escape');

  // ── 4. Menu chân trang ─────────────────────────────────────────────────────
  sect('4. Menu chân trang');
  await a.patch(`/pages/${pageId}`, { menu_position: 1 });
  r = await sf(A.host, '/');
  r.body.includes('/pages/chinh-sach') && r.body.includes('Chính sách đổi trả')
    ? ok('trang published có menu_position → hiện trong menu chân trang') : bad('menu không hiện trang', 'thiếu link /pages/chinh-sach');

  // ── 5. Sửa draft KHÔNG đổi bản live ────────────────────────────────────────
  sect('5. Draft độc lập với published');
  await a.patch(`/pages/${pageId}`, { blocks: [{ type: 'paragraph', text: V2 }] });
  r = await sf(A.host, '/pages/chinh-sach');
  r.body.includes(V1) && !r.body.includes(V2)
    ? ok('sửa draft xong storefront VẪN hiện v1 (published không đổi)') : bad('sửa draft làm đổi bản live');
  r = await a.get(`/pages/${pageId}`);
  const draftText = JSON.stringify(r.json?.blocks ?? []);
  r.json?.published_revision === 1 && draftText.includes(V2)
    ? ok('seller: draft = v2, published_revision vẫn = 1') : bad('trạng thái draft/published sai', r.raw);

  r = await a.post(`/pages/${pageId}/publish`, {});
  r.json?.revision === 2 ? ok('publish lại → revision 2') : bad('publish lần 2 lỗi', r.raw);
  r = await sf(A.host, '/pages/chinh-sach');
  r.body.includes(V2) && !r.body.includes(V1) ? ok('storefront giờ hiện v2') : bad('published lần 2 không hiện v2');

  // ── 6. Rollback ────────────────────────────────────────────────────────────
  sect('6. Rollback về revision cũ');
  r = await a.post(`/pages/${pageId}/rollback`, { revision: 1 });
  r.status === 200 ? ok('rollback về revision 1 → 200') : bad('rollback lỗi', r.raw);
  r = await sf(A.host, '/pages/chinh-sach');
  r.body.includes(V1) && !r.body.includes(V2) ? ok('storefront quay lại v1 sau rollback') : bad('rollback không đổi bản live');
  r = await a.get(`/pages/${pageId}`);
  JSON.stringify(r.json?.blocks ?? []).includes(V2) ? ok('draft vẫn = v2 (rollback KHÔNG đụng draft)') : bad('rollback đã ghi đè draft');
  r.json?.revisions?.length === 2 ? ok('lịch sử có 2 revision') : bad('số revision sai', JSON.stringify(r.json?.revisions));
  r = await a.post(`/pages/${pageId}/rollback`, { revision: 99 });
  r.status === 409 ? ok('rollback revision không tồn tại → 409') : bad('rollback revision lạ không chặn', r.raw);

  // ── 7. Append-only page_revisions (REVOKE UPDATE/DELETE trên app_rw) ───────
  sect('7. Revision append-only');
  const revCount = await owner.query('SELECT count(*)::int n FROM page_revisions WHERE page_id=$1', [pageId]);
  revCount.rows[0].n === 2 ? ok('DB: đúng 2 revision (không bị ghi đè)') : bad('số revision trong DB sai', String(revCount.rows[0].n));

  // ── 8. Cô lập tenant ───────────────────────────────────────────────────────
  sect('8. Cô lập tenant');
  r = await b.get(`/pages/${pageId}`);
  r.status === 404 ? ok('owner shop B GET trang shop A → 404 (không là thành viên)') : bad('rò trang chéo shop qua API', String(r.status));
  // B tạo + publish trang riêng cùng slug 'chinh-sach'
  const pgB = (await b.post('/pages', { slug: 'chinh-sach', title: 'Chính sách của B', blocks: [{ type: 'paragraph', text: 'RIENG CUA B' }] })).json.id;
  await b.post(`/pages/${pgB}/publish`, {});
  r = await sf(A.host, '/pages/chinh-sach');
  !r.body.includes('RIENG CUA B') && r.body.includes(V1) ? ok('storefront A không lộ nội dung shop B (cùng slug, RLS)') : bad('rò nội dung chéo shop trên storefront');
  r = await sf(Bs.host, '/pages/chinh-sach');
  r.status === 200 && r.body.includes('RIENG CUA B') ? ok('storefront B hiện đúng trang của B') : bad('storefront B sai', String(r.status));

  // ── 9. RBAC ────────────────────────────────────────────────────────────────
  sect('9. RBAC content.read / content.write');
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: A.password }, cookie: A.cookie, origin: OA });
  const catalog = await inviteMember(A.shopId, A.cookie, 'catalog_manager');
  const admin = await inviteMember(A.shopId, A.cookie, 'admin');
  const cat = S(A.shopId, catalog.cookie);
  const adm = S(A.shopId, admin.cookie);
  r = await cat.get('/pages');
  r.status === 403 ? ok('catalog_manager GET pages → 403 (thiếu content.read)') : bad('catalog_manager đọc được content', String(r.status));
  r = await cat.post('/pages', { slug: `c-${uniq()}`, title: 'X', blocks: [] });
  r.status === 403 ? ok('catalog_manager tạo trang → 403 (thiếu content.write)') : bad('catalog_manager ghi được content', String(r.status));
  r = await adm.post('/pages', { slug: `admin-${uniq()}`, title: 'Admin tạo', blocks: [] });
  r.status === 201 ? ok('admin tạo trang → 201 (có content.write)') : bad('admin không tạo được content', r.raw);

  // ── 10. Soft delete ────────────────────────────────────────────────────────
  sect('10. Soft delete');
  r = await a.del(`/pages/${pageId}`);
  r.status === 200 ? ok('xoá trang (soft) → 200') : bad('xoá trang lỗi', r.raw);
  r = await sf(A.host, '/pages/chinh-sach');
  r.status === 404 ? ok('storefront: trang đã xoá → 404') : bad('trang xoá vẫn hiện', String(r.status));
  r = await sf(A.host, '/');
  !r.body.includes('Chính sách đổi trả') ? ok('trang đã xoá biến khỏi menu') : bad('trang xoá vẫn trong menu');
  r = await a.get(`/pages/${pageId}`);
  r.status === 404 ? ok('seller: trang đã xoá → 404') : bad('trang xoá vẫn xem được', String(r.status));
  const still = await owner.query('SELECT deleted_at FROM pages WHERE id=$1', [pageId]);
  still.rows[0]?.deleted_at ? ok('dữ liệu còn trong DB (soft delete)') : bad('bị xoá cứng');

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('content e2e lỗi:', err); process.exit(2); });
