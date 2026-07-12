/**
 * End-to-end seller-admin: RBAC + step-up + cô lập tenant. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/e2e.mjs
 *
 * Dựng một shop với đủ 4 vai trò (owner/admin/catalog/order), rồi kiểm ma trận
 * quyền theo docs/01 §11, step-up cho thao tác nhạy cảm, chặn owner-cuối-cùng,
 * và cô lập chéo shop (thành viên shop A không chạm shop B).
 *
 * Chỉ nhân viên nền tảng cần MFA (một lần chờ TOTP). Owner/nhân sự shop đăng nhập
 * không MFA nên phần lớn chạy nhanh.
 */

import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
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

const uid = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;

// User thường (không MFA). Trả cookie phiên đầy đủ.
async function makeUser(label) {
  const email = `${label}-${uniq()}@nentang.vn`, password = 'a decent passphrase here';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  const r = await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA });
  return { email, password, cookie: ck(r.sc) };
}

// Nhân viên nền tảng có MFA (để tạo shop).
async function makeStaff() {
  const u = await makeUser('staff');
  let r = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie: u.cookie, origin: OA });
  const key = base32Decode(r.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie: u.cookie, body: { code: totp(key, {}) }, origin: OA });
  const c = counterFor(Date.now());
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,'admin')`, [await uid(u.email)]);
  while (counterFor(Date.now()) <= c) await sleep(1000);
  r = await rq(AUTH, 'POST', '/auth/login', { body: { email: u.email, password: u.password }, origin: OA });
  let cookie = ck(r.sc);
  r = await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA });
  // A6: mfa/verify ROTATE token → lấy cookie mới
  cookie = ck(r.sc) ?? cookie;
  return { ...u, cookie };
}

// Mời (qua platform) + chấp nhận → trả cookie owner mới.
async function createShopWithOwner(staffCookie, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: r.json.token, password }, origin: OA });
  r = await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA });
  return { shopId, email, password, cookie: ck(r.sc) };
}

// Owner mời (qua seller) + thành viên chấp nhận → trả cookie thành viên.
async function inviteMember(shopId, ownerCookie, role) {
  const email = `${role}-${uniq()}@shop.vn`, password = 'member passphrase good';
  const r = await rq(SELLER, 'POST', `/shops/${shopId}/members/invite`, { body: { email, role }, cookie: ownerCookie, origin: OS });
  if (r.status !== 201) throw new Error(`mời ${role} thất bại: ${r.raw}`);
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: r.json.token, password }, origin: OA });
  const lr = await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA });
  return { email, password, cookie: ck(lr.sc), userId: await uid(email) };
}

async function main() {
  const staff = await makeStaff();
  const A = await createShopWithOwner(staff.cookie, `shopa-${uniq()}`);
  ok('dựng shop A + owner');

  // ── 1. Step-up gác thao tác nhạy cảm ───────────────────────────────────────
  sect('1. Step-up cho thao tác nhạy cảm');
  let r = await rq(SELLER, 'POST', `/shops/${A.shopId}/members/invite`, {
    body: { email: `x-${uniq()}@a.vn`, role: 'admin' }, cookie: A.cookie, origin: OS,
  });
  r.status === 403 && r.json.step_up_required ? ok('mời thành viên khi chưa step-up → 403 step_up_required') : bad('mời được mà không cần step-up', r.raw);

  r = await rq(AUTH, 'POST', '/auth/step-up', { body: { password: 'sai mật khẩu' }, cookie: A.cookie, origin: OA });
  r.status === 401 ? ok('step-up mật khẩu sai → 401') : bad('step-up nhận mật khẩu sai', r.raw);

  r = await rq(AUTH, 'POST', '/auth/step-up', { body: { password: A.password }, cookie: A.cookie, origin: OA });
  r.status === 200 ? ok('step-up mật khẩu đúng → 200') : bad('step-up lỗi', r.raw);

  // ── 2. Owner mời đủ 3 vai trò ──────────────────────────────────────────────
  sect('2. Owner mời admin / catalog / order (đã step-up)');
  const admin = await inviteMember(A.shopId, A.cookie, 'admin');
  const catalog = await inviteMember(A.shopId, A.cookie, 'catalog_manager');
  const order = await inviteMember(A.shopId, A.cookie, 'order_manager');
  ok('mời + chấp nhận 3 thành viên');

  // ── 3. whoami phản ánh đúng vai trò ────────────────────────────────────────
  sect('3. whoami theo vai trò');
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/whoami`, { cookie: A.cookie });
  r.json?.role === 'owner' && r.json.permissions.includes('members.write') ? ok('owner: đủ quyền') : bad('owner whoami sai', r.raw);
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/whoami`, { cookie: admin.cookie });
  r.json?.role === 'admin' && !r.json.permissions.includes('members.write') ? ok('admin: có nhưng KHÔNG members.write') : bad('admin whoami sai', r.raw);

  // ── 4. Ma trận RBAC ────────────────────────────────────────────────────────
  sect('4. Ma trận quyền');
  const G200 = async (cookie, path, who) => {
    const rr = await rq(SELLER, 'GET', `/shops/${A.shopId}${path}`, { cookie });
    rr.status === 200 ? ok(`${who} ${path} → 200`) : bad(`${who} ${path} → ${rr.status}, mong 200`, rr.raw);
  };
  const G403 = async (cookie, path, who) => {
    const rr = await rq(SELLER, 'GET', `/shops/${A.shopId}${path}`, { cookie });
    rr.status === 403 ? ok(`${who} ${path} → 403 (đúng, thiếu quyền)`) : bad(`${who} ${path} → ${rr.status}, mong 403`, rr.raw);
  };
  await G200(catalog.cookie, '/products', 'catalog_mgr');
  await G403(catalog.cookie, '/orders', 'catalog_mgr');
  await G403(catalog.cookie, '/members', 'catalog_mgr');
  await G200(order.cookie, '/orders', 'order_mgr');
  await G403(order.cookie, '/products', 'order_mgr');
  await G200(admin.cookie, '/members', 'admin');
  await G200(admin.cookie, '/products', 'admin');
  // admin KHÔNG được mời (members.write chỉ owner) — kể cả khi step-up.
  r = await rq(AUTH, 'POST', '/auth/step-up', { body: { password: admin.password }, cookie: admin.cookie, origin: OA });
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/members/invite`, { body: { email: `z-${uniq()}@a.vn`, role: 'catalog_manager' }, cookie: admin.cookie, origin: OS });
  r.status === 403 ? ok('admin mời thành viên → 403 (chỉ owner)') : bad('admin mời được thành viên', r.raw);

  // ── 5. Đổi vai trò (owner + step-up) ───────────────────────────────────────
  sect('5. Đổi vai trò');
  r = await rq(SELLER, 'PATCH', `/shops/${A.shopId}/members/${catalog.userId}/role`, { body: { role: 'admin' }, cookie: A.cookie, origin: OS });
  r.status === 200 ? ok('owner đổi catalog_mgr → admin (đã step-up)') : bad('đổi vai trò lỗi', r.raw);
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/whoami`, { cookie: catalog.cookie });
  r.json?.role === 'admin' ? ok('thành viên thấy vai trò mới (introspection tươi)') : bad('vai trò chưa đổi', r.raw);

  // ── 6. Chặn owner cuối cùng ────────────────────────────────────────────────
  sect('6. Không bỏ được owner cuối cùng');
  const ownerAId = await uid(A.email);
  r = await rq(SELLER, 'PATCH', `/shops/${A.shopId}/members/${ownerAId}/role`, { body: { role: 'admin' }, cookie: A.cookie, origin: OS });
  r.status === 409 ? ok('hạ cấp owner cuối cùng → 409') : bad('hạ cấp được owner cuối', r.raw);
  r = await rq(SELLER, 'DELETE', `/shops/${A.shopId}/members/${ownerAId}`, { cookie: A.cookie, origin: OS });
  r.status === 409 ? ok('xoá owner cuối cùng → 409') : bad('xoá được owner cuối', r.raw);

  // ── 7. Cô lập chéo shop ────────────────────────────────────────────────────
  sect('7. Cô lập chéo shop (tenant/RLS)');
  const Bshop = await createShopWithOwner(staff.cookie, `shopb-${uniq()}`);
  r = await rq(SELLER, 'GET', `/shops/${Bshop.shopId}/members`, { cookie: A.cookie });
  r.status === 404 ? ok('owner A xem nhân sự shop B → 404 (không phải thành viên)') : bad('owner A chạm được shop B', r.raw);
  r = await rq(SELLER, 'GET', `/shops/${Bshop.shopId}`, { cookie: admin.cookie });
  r.status === 404 ? ok('thành viên shop A xem shop B → 404') : bad('thành viên A chạm shop B', r.raw);
  // Owner B chỉ thấy shop B.
  r = await rq(SELLER, 'GET', `/shops/${Bshop.shopId}/members`, { cookie: Bshop.cookie });
  const emails = (r.json?.members ?? []).map((m) => m.email);
  r.status === 200 && emails.includes(Bshop.email) && !emails.includes(admin.email)
    ? ok('owner B chỉ thấy nhân sự shop B (RLS cô lập)') : bad('rò nhân sự chéo shop', r.raw);

  // ── 8. Không phải thành viên / chưa đăng nhập ──────────────────────────────
  sect('8. Ngoài phạm vi');
  const out = await makeUser('outsider');
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/whoami`, { cookie: out.cookie });
  r.status === 404 ? ok('người ngoài → 404') : bad('người ngoài truy cập được', r.raw);
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/whoami`, {});
  r.status === 401 ? ok('không cookie → 401') : bad('không cookie vẫn qua', r.raw);
  r = await rq(SELLER, 'GET', '/shops', { cookie: A.cookie });
  (r.json?.shops ?? []).some((s) => s.shop_id === A.shopId) ? ok('GET /shops liệt kê shop của mình') : bad('GET /shops lỗi', r.raw);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('seller e2e lỗi:', err); process.exit(2); });
