/**
 * End-to-end catalog. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/catalog.e2e.mjs
 *
 * Kiểm các bất biến catalog: SKU/slug duy nhất TRONG shop nhưng lặp được across
 * shop, composite FK chặn gắn danh mục shop khác, validation, phân trang/tìm,
 * chuyển trạng thái, chặn xoá biến thể cuối, soft delete, cô lập tenant khi list.
 */

import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
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
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;

async function makeStaff() {
  const email = `staff-${uniq()}@nentang.vn`, password = 'staff strong passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let r = await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA });
  let cookie = ck(r.sc);
  r = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie, origin: OA });
  const key = base32Decode(r.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie, body: { code: totp(key, {}) }, origin: OA });
  const c = counterFor(Date.now());
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,'admin')`, [await uidOf(email)]);
  while (counterFor(Date.now()) <= c) await sleep(1000);
  r = await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA });
  cookie = ck(r.sc);
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
  r = await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA });
  return { shopId, cookie: ck(r.sc) };
}

// helper gọi seller theo shop
const S = (shopId, cookie) => ({
  get: (p, q = '') => rq(SELLER, 'GET', `/shops/${shopId}${p}${q}`, { cookie }),
  post: (p, body) => rq(SELLER, 'POST', `/shops/${shopId}${p}`, { body, cookie, origin: OS }),
  patch: (p, body) => rq(SELLER, 'PATCH', `/shops/${shopId}${p}`, { body, cookie, origin: OS }),
  del: (p) => rq(SELLER, 'DELETE', `/shops/${shopId}${p}`, { cookie, origin: OS }),
});

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `cata-${uniq()}`);
  const Bs = await makeShopOwner(staff, `catb-${uniq()}`);
  const a = S(A.shopId, A.cookie);
  const b = S(Bs.shopId, Bs.cookie);
  ok('dựng 2 shop + owner');

  // ── 1. Danh mục ────────────────────────────────────────────────────────────
  sect('1. Danh mục');
  let r = await a.post('/categories', { slug: 'ao-thun', name: 'Áo thun' });
  const catA = r.json?.id;
  r.status === 201 && catA ? ok('tạo danh mục') : bad('tạo danh mục lỗi', r.raw);
  r = await a.post('/categories', { slug: 'ao-thun', name: 'Trùng' });
  r.status === 409 ? ok('slug danh mục trùng → 409') : bad('slug danh mục trùng vẫn tạo', r.raw);
  const catB = (await b.post('/categories', { slug: 'quan', name: 'Quần' })).json.id;

  // ── 2. Tạo sản phẩm + biến thể + danh mục ──────────────────────────────────
  sect('2. Tạo sản phẩm');
  const sku1 = `SKU-${uniq()}`;
  r = await a.post('/products', {
    title: 'Áo thun basic', slug: 'ao-thun-basic', price_vnd: 250000, description: 'Cotton',
    variants: [{ title: 'Đỏ / M', sku: sku1, price_vnd: 250000 }, { title: 'Đỏ / L', sku: `${sku1}-L`, price_vnd: 260000 }],
    category_ids: [catA],
  });
  const prodA = r.json?.id;
  r.status === 201 && prodA ? ok('tạo sản phẩm 2 biến thể + danh mục') : bad('tạo sản phẩm lỗi', r.raw);

  // ── 3. Validation ──────────────────────────────────────────────────────────
  sect('3. Validation');
  const badCases = [
    ['tiêu đề rỗng', { title: '', slug: `s-${uniq()}`, price_vnd: 1, variants: [{ sku: `k-${uniq()}`, price_vnd: 1 }] }],
    ['giá âm', { title: 'X', slug: `s-${uniq()}`, price_vnd: -1, variants: [{ sku: `k-${uniq()}`, price_vnd: 1 }] }],
    ['giá không nguyên', { title: 'X', slug: `s-${uniq()}`, price_vnd: 1.5, variants: [{ sku: `k-${uniq()}`, price_vnd: 1 }] }],
    ['không biến thể', { title: 'X', slug: `s-${uniq()}`, price_vnd: 1, variants: [] }],
    ['slug sai', { title: 'X', slug: 'Không Hợp Lệ', price_vnd: 1, variants: [{ sku: `k-${uniq()}`, price_vnd: 1 }] }],
    ['SKU trùng trong payload', { title: 'X', slug: `s-${uniq()}`, price_vnd: 1, variants: [{ sku: 'DUP', price_vnd: 1 }, { sku: 'DUP', price_vnd: 2 }] }],
  ];
  for (const [name, body] of badCases) {
    const rr = await a.post('/products', body);
    rr.status === 400 ? ok(`${name} → 400`) : bad(`${name} → ${rr.status}, mong 400`, rr.raw);
  }

  // ── 4. Duy nhất theo shop, lặp across shop ─────────────────────────────────
  sect('4. SKU/slug duy nhất trong shop, lặp được across shop');
  r = await a.post('/products', { title: 'Khác', slug: `khac-${uniq()}`, price_vnd: 1, variants: [{ sku: sku1, price_vnd: 1 }] });
  r.status === 409 && /SKU/.test(r.json.error) ? ok('SKU trùng trong shop A → 409') : bad('SKU trùng không bị chặn', r.raw);

  r = await a.post('/products', { title: 'Trùng slug', slug: 'ao-thun-basic', price_vnd: 1, variants: [{ sku: `z-${uniq()}`, price_vnd: 1 }] });
  r.status === 409 && /slug/.test(r.json.error) ? ok('slug trùng trong shop A → 409') : bad('slug trùng không bị chặn', r.raw);

  r = await b.post('/products', { title: 'Cùng SKU khác shop', slug: 'ao-thun-basic', price_vnd: 1, variants: [{ sku: sku1, price_vnd: 1 }] });
  r.status === 201 ? ok('shop B dùng LẠI cùng SKU + slug → 201 (tenant-scoped)') : bad('SKU/slug không lặp được across shop', r.raw);

  // ── 5. Composite FK: không gắn danh mục shop khác ──────────────────────────
  sect('5. Composite FK danh mục');
  r = await a.post('/products', { title: 'Gắn danh mục shop B', slug: `x-${uniq()}`, price_vnd: 1, variants: [{ sku: `y-${uniq()}`, price_vnd: 1 }], category_ids: [catB] });
  r.status === 400 ? ok('gắn danh mục của shop B → 400 (composite FK chặn)') : bad('gắn được danh mục chéo shop', r.raw);

  // ── 6. Phân trang & tìm & lọc ──────────────────────────────────────────────
  sect('6. List / phân trang / tìm / lọc');
  for (let i = 0; i < 3; i++) await a.post('/products', { title: `Quần jeans ${i}`, slug: `jeans-${uniq()}`, price_vnd: 300000, variants: [{ sku: `j-${uniq()}`, price_vnd: 300000 }] });
  // Shop A đã tạo: ao-thun-basic + 3 jeans = 4 (các case lỗi/409 KHÔNG tạo gì).
  r = await a.get('/products', '?limit=2');
  r.status === 200 && r.json.products.length === 2 && r.json.total === 4 ? ok(`phân trang limit=2 (total=${r.json.total})`) : bad('phân trang lỗi', r.raw);
  r = await a.get('/products', '?q=jeans');
  r.status === 200 && r.json.products.length >= 3 && r.json.products.every((p) => /jeans/i.test(p.title)) ? ok('tìm q=jeans lọc đúng') : bad('tìm lỗi', r.raw);
  r = await a.get('/products', '?status=draft');
  r.status === 200 && r.json.products.every((p) => p.status === 'draft') ? ok('lọc status=draft') : bad('lọc status lỗi', r.raw);

  // ?offset= KHỔNG LỒ không được làm sập trang. offset nội suy thẳng vào SQL nên trước khi
  // kẹp trần thì 1e20 > bigint → Postgres 'bigint out of range' → 500. `limit` ngay dòng
  // trên đã kẹp Math.min(...,100) từ đầu, chỉ offset là quên — nên chốt lại bằng test.
  r = await a.get('/products', '?offset=99999999999999999999');
  r.status === 200 && Array.isArray(r.json.products) && r.json.products.length === 0
    ? ok('offset khổng lồ → 200 rỗng, không 500') : bad('offset khổng lồ làm sập list', `${r.status} ${r.raw?.slice(0, 80)}`);
  r = await a.get('/products', '?offset=-5');
  r.status === 200 ? ok('offset âm → 200 (OFFSET âm là lỗi cú pháp SQL)') : bad('offset âm làm sập list', r.raw);

  // ── 7. Chi tiết / cập nhật / trạng thái ────────────────────────────────────
  sect('7. Chi tiết & vòng đời');
  r = await a.get(`/products/${prodA}`);
  r.status === 200 && r.json.variants.length === 2 && r.json.category_ids.includes(catA) ? ok('chi tiết: 2 biến thể + danh mục') : bad('chi tiết lỗi', r.raw);

  r = await a.patch(`/products/${prodA}`, { title: 'Áo thun premium' });
  r = await a.get(`/products/${prodA}`);
  r.json?.title === 'Áo thun premium' ? ok('cập nhật tiêu đề') : bad('cập nhật lỗi', r.raw);

  r = await a.patch(`/products/${prodA}`, { slug: 'ao-thun-basic' }); // đã dùng bởi chính nó? không, prodA CÓ slug này
  // prodA slug là 'ao-thun-basic' rồi → patch cùng slug OK (update chính nó)
  r = await a.post(`/products/${prodA}/publish`, {});
  r.status === 200 && r.json.status === 'active' ? ok('publish → active') : bad('publish lỗi', r.raw);
  r = await a.post(`/products/${prodA}/archive`, {});
  r.status === 200 && r.json.status === 'archived' ? ok('archive → archived') : bad('archive lỗi', r.raw);

  // ── 8. Biến thể ────────────────────────────────────────────────────────────
  sect('8. Biến thể');
  r = await a.post(`/products/${prodA}/variants`, { title: 'Xanh / S', sku: `${sku1}-S`, price_vnd: 240000 });
  const v3 = r.json?.id;
  r.status === 201 ? ok('thêm biến thể') : bad('thêm biến thể lỗi', r.raw);
  r = await a.post(`/products/${prodA}/variants`, { sku: sku1, price_vnd: 1 });
  r.status === 409 ? ok('thêm biến thể SKU trùng → 409') : bad('SKU trùng khi thêm biến thể', r.raw);
  // xoá 2 trong 3 biến thể được, biến thể cuối thì không
  const det = await a.get(`/products/${prodA}`);
  const vids = det.json.variants.map((v) => v.id);
  r = await a.del(`/products/${prodA}/variants/${vids[0]}`);
  r.status === 200 ? ok('xoá 1 biến thể (còn 2)') : bad('xoá biến thể lỗi', r.raw);
  r = await a.del(`/products/${prodA}/variants/${vids[1]}`);
  r = await a.del(`/products/${prodA}/variants/${vids[2] ?? v3}`);
  r.status === 409 ? ok('xoá biến thể cuối cùng → 409') : bad('xoá được biến thể cuối', r.raw);

  // ── 9. Soft delete ─────────────────────────────────────────────────────────
  sect('9. Soft delete');
  r = await a.del(`/products/${prodA}`);
  r.status === 200 ? ok('xoá sản phẩm (soft) → 200') : bad('xoá sản phẩm lỗi', r.raw);
  r = await a.get(`/products/${prodA}`);
  r.status === 404 ? ok('sản phẩm đã xoá → 404') : bad('sản phẩm xoá vẫn xem được', r.raw);
  const stillDb = await owner.query('SELECT deleted_at FROM products WHERE id=$1', [prodA]);
  stillDb.rows[0]?.deleted_at ? ok('dữ liệu còn trong DB (soft delete, không xoá cứng)') : bad('bị xoá cứng');

  // ── 10. Cô lập tenant khi list ─────────────────────────────────────────────
  sect('10. Cô lập tenant khi list');
  r = await b.get('/products');
  const titles = r.json.products.map((p) => p.title);
  r.status === 200 && titles.includes('Cùng SKU khác shop') && !titles.includes('Quần jeans 0')
    ? ok('shop B chỉ thấy sản phẩm của shop B (RLS)') : bad('rò sản phẩm chéo shop', r.raw);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('catalog e2e lỗi:', err); process.exit(2); });
