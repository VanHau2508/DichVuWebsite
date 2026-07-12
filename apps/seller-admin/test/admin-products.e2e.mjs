/**
 * End-to-end quản sản phẩm & tồn kho qua admin (BFF). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-products.e2e.mjs
 *
 * Kiểm: tạo → sửa → đăng bán → điều chỉnh tồn → thêm/xoá biến thể → lưu trữ → xoá,
 * tất cả qua form PRG; cùng cô lập chéo shop + CSRF. BFF forward, `seller` cưỡng chế.
 */
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });

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
  const t = await r.text();
  return { status: r.status, location: r.headers.get('location'), sc: r.headers.getSetCookie(), body: t };
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
  return { shopId, name: slug, email, password, cookie: await login(email, password) };
}
// Đọc trạng thái thật từ seller (authoritative) để khỏi tin mỗi HTML.
const sget = (shopId, cookie, path) => rq(SELLER, 'GET', `/shops/${shopId}${path}`, { cookie });
const pidFrom = (loc) => /\/products\/([0-9a-f-]{36})$/.exec(loc ?? '')?.[1] ?? null;

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `pa-${uniq()}`);
  const Bo = await makeShopOwner(staff, `pb-${uniq()}`);
  const P = (p) => `/shops/${A.shopId}/products${p}`;
  ok('dựng 2 shop + chủ shop');

  // ── 1. Danh sách rỗng + form tạo ───────────────────────────────────────────
  sect('1. Danh sách & tạo');
  let r = await adm('GET', P(''), { cookie: A.cookie });
  r.status === 200 && /Chưa có sản phẩm/.test(r.body) && /Sản phẩm/.test(r.body) ? ok('danh sách rỗng + tab Sản phẩm') : bad('danh sách rỗng sai', r.body.slice(0, 200));

  r = await adm('GET', P('/new'), { cookie: A.cookie });
  r.status === 200 && /Thêm sản phẩm/.test(r.body) && r.body.includes('name="sku"') ? ok('form thêm sản phẩm render') : bad('form thêm sai', r.body.slice(0, 150));

  // Thiếu tên → backend 400 → BFF render lại form kèm lỗi.
  r = await adm('POST', P(''), { cookie: A.cookie, origin: OADM, form: { slug: `s-${uniq()}`, price_vnd: '100000', sku: `K-${uniq()}`, variant_price_vnd: '100000' } });
  r.status === 400 && /hợp lệ/.test(r.body) ? ok('tạo thiếu tên → 400 + báo lỗi') : bad('thiếu tên không bị chặn', String(r.status));

  const slug = `ghe-sofa-${uniq()}`;
  r = await adm('POST', P(''), { cookie: A.cookie, origin: OADM, form: { title: 'Ghế sofa demo', slug, price_vnd: '4990000', status: 'draft', description: 'Sofa 3 chỗ', sku: `SOFA-${uniq()}`, variant_price_vnd: '4990000' } });
  const pid = pidFrom(r.location);
  r.status === 303 && pid ? ok(`tạo sản phẩm → 303 chi tiết (pid ${pid.slice(0, 8)}…)`) : bad('tạo sản phẩm lỗi', `${r.status} ${r.location}`);

  // ── 2. Chi tiết + sửa ──────────────────────────────────────────────────────
  sect('2. Chi tiết & sửa');
  r = await adm('GET', P(`/${pid}`), { cookie: A.cookie });
  r.status === 200 && r.body.includes('Ghế sofa demo') && /Nháp/.test(r.body) && /4\.990\.000/.test(r.body) ? ok('chi tiết: tên + trạng thái Nháp + giá') : bad('chi tiết sai', r.body.slice(0, 200));

  r = await adm('POST', P(`/${pid}`), { cookie: A.cookie, origin: OADM, form: { title: 'Ghế sofa cao cấp', slug, price_vnd: '5290000', description: 'Đã nâng cấp' } });
  const afterEdit = (await sget(A.shopId, A.cookie, `/products/${pid}`)).json;
  r.status === 303 && afterEdit.title === 'Ghế sofa cao cấp' && Number(afterEdit.price_vnd) === 5290000 ? ok('sửa tên + giá → 303 + DB đổi') : bad('sửa lỗi', `${r.status} ${afterEdit.title} ${afterEdit.price_vnd}`);

  // ── 2b. Sửa lỗi phải GIỮ input vừa gõ (không revert về DB) ─────────────────
  sect('2b. Sửa lỗi giữ input');
  const slug2 = `ban-tra-${uniq()}`;
  r = await adm('POST', P(''), { cookie: A.cookie, origin: OADM, form: { title: 'Bàn trà', slug: slug2, price_vnd: '1850000', status: 'draft', sku: `BAN-${uniq()}`, variant_price_vnd: '1850000' } });
  // Sửa P1 sang slug đã dùng (P2) + tên/mô tả mới → backend 409, BFF phải giữ input.
  r = await adm('POST', P(`/${pid}`), { cookie: A.cookie, origin: OADM, form: { title: 'TÊN VỪA GÕ ĐẶC BIỆT', slug: slug2, price_vnd: '6000000', description: 'mô tả vừa gõ' } });
  const kept = r.body.includes('TÊN VỪA GÕ ĐẶC BIỆT') && r.body.includes(slug2) && r.body.includes('mô tả vừa gõ');
  const dbTitle = (await sget(A.shopId, A.cookie, `/products/${pid}`)).json.title;
  r.status >= 400 && kept && dbTitle === 'Ghế sofa cao cấp' ? ok('sửa đụng slug → lỗi + giữ input vừa gõ, DB không đổi') : bad('sửa lỗi nuốt input hoặc đổi DB', `${r.status} kept=${kept} db=${dbTitle}`);

  // ── 3. Đăng bán ────────────────────────────────────────────────────────────
  sect('3. Trạng thái');
  r = await adm('POST', P(`/${pid}/publish`), { cookie: A.cookie, origin: OADM });
  let st = (await sget(A.shopId, A.cookie, `/products/${pid}`)).json.status;
  r.status === 303 && st === 'active' ? ok('đăng bán → active') : bad('publish lỗi', `${r.status} ${st}`);

  // ── 4. Điều chỉnh tồn ──────────────────────────────────────────────────────
  sect('4. Tồn kho');
  const vid = afterEdit.variants[0].id;
  r = await adm('POST', P(`/${pid}/variants/${vid}/inventory`), { cookie: A.cookie, origin: OADM, form: { delta: '50', reason: 'nhập lô đầu' } });
  let lvl = (await sget(A.shopId, A.cookie, `/variants/${vid}/inventory`)).json;
  r.status === 303 && lvl.on_hand === 50 ? ok('nhập +50 → on_hand 50') : bad('điều chỉnh tồn lỗi', `${r.status} ${JSON.stringify(lvl)}`);

  r = await adm('POST', P(`/${pid}/variants/${vid}/inventory`), { cookie: A.cookie, origin: OADM, form: { delta: '-100', reason: 'thử vượt' } });
  lvl = (await sget(A.shopId, A.cookie, `/variants/${vid}/inventory`)).json;
  r.status >= 400 && /tồn/.test(r.body) && lvl.on_hand === 50 ? ok('giảm quá tồn → lỗi, on_hand giữ 50') : bad('cho tồn âm', `${r.status} ${lvl.on_hand}`);

  r = await adm('GET', P(`/${pid}`), { cookie: A.cookie });
  /50/.test(r.body) ? ok('chi tiết hiện tồn 50') : bad('chi tiết không hiện tồn', r.body.slice(0, 150));

  // ── 5. Biến thể ────────────────────────────────────────────────────────────
  sect('5. Biến thể');
  r = await adm('POST', P(`/${pid}/variants`), { cookie: A.cookie, origin: OADM, form: { sku: `SOFA2-${uniq()}`, price_vnd: '5590000' } });
  let prod = (await sget(A.shopId, A.cookie, `/products/${pid}`)).json;
  r.status === 303 && prod.variants.length === 2 ? ok('thêm biến thể → 2 biến thể') : bad('thêm biến thể lỗi', `${r.status} ${prod.variants.length}`);

  const v2 = prod.variants.find((v) => v.id !== vid).id;
  r = await adm('POST', P(`/${pid}/variants/${v2}/delete`), { cookie: A.cookie, origin: OADM });
  prod = (await sget(A.shopId, A.cookie, `/products/${pid}`)).json;
  r.status === 303 && prod.variants.length === 1 ? ok('xoá biến thể → còn 1') : bad('xoá biến thể lỗi', `${r.status} ${prod.variants.length}`);

  r = await adm('POST', P(`/${pid}/variants/${vid}/delete`), { cookie: A.cookie, origin: OADM });
  prod = (await sget(A.shopId, A.cookie, `/products/${pid}`)).json;
  r.status >= 400 && prod.variants.length === 1 ? ok('xoá biến thể cuối → chặn (còn 1)') : bad('xoá được biến thể cuối', `${r.status} ${prod.variants.length}`);

  // ── 6. Lưu trữ + xoá ───────────────────────────────────────────────────────
  sect('6. Lưu trữ & xoá');
  r = await adm('POST', P(`/${pid}/archive`), { cookie: A.cookie, origin: OADM });
  st = (await sget(A.shopId, A.cookie, `/products/${pid}`)).json.status;
  r.status === 303 && st === 'archived' ? ok('lưu trữ → archived') : bad('archive lỗi', `${r.status} ${st}`);

  r = await adm('POST', P(`/${pid}/delete`), { cookie: A.cookie, origin: OADM });
  const gone = (await sget(A.shopId, A.cookie, `/products/${pid}`)).status;
  r.status === 303 && r.location === P('') && gone === 404 ? ok('xoá sản phẩm → 303 danh sách + seller 404') : bad('xoá sản phẩm lỗi', `${r.status} ${r.location} ${gone}`);

  // ── 7. Cô lập chéo shop + CSRF ─────────────────────────────────────────────
  sect('7. Cô lập & CSRF');
  r = await adm('GET', `/shops/${Bo.shopId}/products`, { cookie: A.cookie });
  r.status === 403 ? ok('owner A xem sản phẩm shop B → 403') : bad('rò sản phẩm chéo shop', String(r.status));

  r = await adm('POST', P(''), { cookie: A.cookie, form: { title: 'x', slug: `x-${uniq()}`, price_vnd: '1000', sku: `X-${uniq()}`, variant_price_vnd: '1000' } }); // KHÔNG Origin
  r.status === 403 ? ok('tạo sản phẩm không Origin → 403 (CSRF)') : bad('tạo thiếu Origin không bị chặn', String(r.status));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((err) => { console.error('admin products e2e lỗi:', err); process.exit(2); });
