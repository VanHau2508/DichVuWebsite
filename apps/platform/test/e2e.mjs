/**
 * End-to-end onboarding shop. Chạy TRONG container dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/platform/test/e2e.mjs
 *
 * dbtest có: pg (bootstrap platform_staff bằng app_owner), totp (tính mã MFA,
 * mount từ packages/auth/src), và mạng nội bộ để gọi thẳng auth:3020 + platform:3030.
 *
 * Chứng minh chuỗi onboarding thật: nhân viên nền tảng tạo shop → subdomain tự
 * verified → mời owner → owner nhận lời mời (tạo tài khoản + membership) → owner
 * đăng nhập thấy shop → khoá/mở shop. Cộng các cổng phân quyền và cô lập role DB.
 *
 * Chậm (~60s) vì MFA buộc chờ sang bước thời gian mới — đúng như thiết kế.
 */

import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const ORIGIN_AUTH = 'https://auth.localtest';
const ORIGIN_OPS = 'https://ops.localtest';

const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
const platformRole = new pg.Pool({ connectionString: process.env.DATABASE_URL_PLATFORM, max: 2 });

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${d}${X}`); };
const sect = (m) => console.log(`\n${B}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cookieFrom(setCookie) {
  for (const c of setCookie ?? []) {
    const m = /^__Host-session=([^;]*)/.exec(c);
    if (m) return m[1];
  }
  return null;
}

async function req(base, method, path, { body, cookie, origin } = {}) {
  const h = {};
  if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const res = await fetch(base + path, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* */ }
  return { status: res.status, json, setCookie: res.headers.getSetCookie(), raw: text };
}

// Đăng nhập đầy đủ (qua MFA nếu bật). Trả cookie phiên đầy đủ.
async function fullLogin(email, password, totpKey, afterCounter) {
  let r = await req(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: ORIGIN_AUTH });
  let cookie = cookieFrom(r.setCookie);
  if (r.json?.mfa_required) {
    let c = afterCounter;
    while (counterFor(Date.now()) <= c) await sleep(1000);
    const code = totp(totpKey, {});
    const used = counterFor(Date.now());
    r = await req(AUTH, 'POST', '/auth/mfa/verify', { body: { code }, cookie, origin: ORIGIN_AUTH });
    return { cookie, ok: r.status === 200, usedCounter: used };
  }
  return { cookie, ok: r.status === 200, usedCounter: afterCounter };
}

// Tạo user đã bật MFA. Trả {email, cookie, key, usedCounter}.
async function makeMfaUser(label) {
  const email = `${label}-${uniq()}@nentang.vn`;
  const password = 'a strong platform passphrase';
  await req(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: ORIGIN_AUTH });
  let r = await req(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: ORIGIN_AUTH });
  let cookie = cookieFrom(r.setCookie);
  r = await req(AUTH, 'POST', '/auth/mfa/enroll', { cookie, origin: ORIGIN_AUTH });
  const key = base32Decode(r.json.secret);
  const code = totp(key, {});
  const usedCounter = counterFor(Date.now());
  r = await req(AUTH, 'POST', '/auth/mfa/activate', { cookie, body: { code }, origin: ORIGIN_AUTH });
  if (r.status !== 200) throw new Error('activate MFA thất bại: ' + r.raw);
  return { email, password, cookie, key, usedCounter, userId: null };
}

async function userIdOf(email) {
  const { rows } = await owner.query('SELECT id FROM users WHERE email = $1', [email]);
  return rows[0]?.id ?? null;
}

async function main() {
  // ── Bootstrap nhân viên nền tảng ───────────────────────────────────────────
  sect('0. Bootstrap nhân viên nền tảng (đăng ký + MFA + platform_staff)');
  const staff = await makeMfaUser('staff');
  staff.userId = await userIdOf(staff.email);
  await owner.query(`INSERT INTO platform_staff (user_id, role) VALUES ($1, 'admin')`, [staff.userId]);
  ok('tạo nhân viên nền tảng có MFA');

  // Đăng nhập đầy đủ, lấy cookie dùng cho mọi /ops.
  const login = await fullLogin(staff.email, staff.password, staff.key, staff.usedCounter);
  login.ok ? ok('nhân viên đăng nhập đầy đủ (qua MFA)') : bad('đăng nhập nhân viên thất bại');
  const staffCookie = login.cookie;

  // ── 1. Cổng phân quyền ─────────────────────────────────────────────────────
  sect('1. Cổng phân quyền /ops');
  let r = await req(PLATFORM, 'POST', '/ops/shops', { body: { name: 'X', slug: 'x' }, origin: ORIGIN_OPS });
  r.status === 401 ? ok('không cookie → 401') : bad('không cookie vẫn qua', r.raw);

  // User thường (không MFA, không staff) → bị chặn.
  const outsiderEmail = `outsider-${uniq()}@a.vn`;
  await req(AUTH, 'POST', '/auth/register', { body: { email: outsiderEmail, password: 'just a normal user pw' }, origin: ORIGIN_AUTH });
  let o = await req(AUTH, 'POST', '/auth/login', { body: { email: outsiderEmail, password: 'just a normal user pw' }, origin: ORIGIN_AUTH });
  const outsiderCookie = cookieFrom(o.setCookie);
  r = await req(PLATFORM, 'POST', '/ops/shops', { body: { name: 'X', slug: 'x' }, cookie: outsiderCookie, origin: ORIGIN_OPS });
  r.status === 403 ? ok('user thường → 403') : bad('user thường tạo được shop', r.raw);

  r = await req(PLATFORM, 'POST', '/ops/shops', { body: { name: 'X', slug: 'x' }, cookie: staffCookie, origin: null });
  r.status === 403 ? ok('thiếu Origin → 403 (CSRF)') : bad('mutation không cần Origin', r.raw);

  // ── 2. Tạo shop ────────────────────────────────────────────────────────────
  sect('2. Tạo shop + subdomain + thuê bao');
  const slug = `brand-${uniq()}`;
  r = await req(PLATFORM, 'POST', '/ops/shops', {
    body: { name: 'Thời trang Demo', slug, plan_code: 'platform', currency: 'VND' },
    cookie: staffCookie, origin: ORIGIN_OPS,
  });
  const shopId = r.json?.id;
  r.status === 201 && shopId && r.json.subdomain === `${slug}.nentang.vn`
    ? ok(`tạo shop → subdomain ${r.json.subdomain}`) : bad('tạo shop lỗi', r.raw);

  r = await req(PLATFORM, 'POST', '/ops/shops', {
    body: { name: 'Gói sai', slug: `y-${uniq()}`, plan_code: 'khong-ton-tai' },
    cookie: staffCookie, origin: ORIGIN_OPS,
  });
  r.status === 400 ? ok('gói không hợp lệ → 400') : bad('nhận gói lạ', r.raw);

  r = await req(PLATFORM, 'POST', '/ops/shops', {
    body: { name: 'Trùng slug', slug, plan_code: 'platform' },
    cookie: staffCookie, origin: ORIGIN_OPS,
  });
  r.status === 409 ? ok('slug trùng → 409') : bad('slug trùng vẫn tạo', r.raw);

  // Subdomain verified ngay (nền tảng tự sở hữu). verified_at cần cho ROUTING
  // (storefront chỉ phục vụ domain đã verify). SSL cho *.nentang.vn đến từ chứng
  // chỉ wildcard (khối riêng trong Caddyfile prod), KHÔNG qua on-demand/ask.
  const dom = await owner.query(
    `SELECT verified_at FROM domains WHERE hostname = $1`, [`${slug}.nentang.vn`],
  );
  dom.rows[0]?.verified_at ? ok('subdomain verified ngay (đủ điều kiện routing)') : bad('subdomain chưa verified');

  const sub = await owner.query(`SELECT plan_code, status FROM subscriptions WHERE shop_id = $1`, [shopId]);
  sub.rows[0]?.plan_code === 'platform' && sub.rows[0]?.status === 'trial'
    ? ok('thuê bao tạo ở trạng thái trial') : bad('thuê bao lỗi', JSON.stringify(sub.rows));

  // ── 3. Liệt kê & xem shop ──────────────────────────────────────────────────
  sect('3. Liệt kê & chi tiết');
  r = await req(PLATFORM, 'GET', '/ops/shops', { cookie: staffCookie });
  r.status === 200 && r.json.shops.some((s) => s.id === shopId) ? ok('shop mới có trong danh sách') : bad('list lỗi', r.raw);

  r = await req(PLATFORM, 'GET', `/ops/shops/${shopId}`, { cookie: staffCookie });
  r.status === 200 && r.json.status === 'onboarding' ? ok('chi tiết shop: status onboarding') : bad('get shop lỗi', r.raw);

  // ── 4. Mời owner → chấp nhận → đăng nhập ───────────────────────────────────
  sect('4. Mời owner & chấp nhận lời mời');
  const ownerEmail = `owner-${uniq()}@shopdemo.vn`;
  r = await req(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, {
    body: { email: ownerEmail, role: 'owner' }, cookie: staffCookie, origin: ORIGIN_OPS,
  });
  const inviteToken = r.json?.token;
  r.status === 201 && inviteToken ? ok('tạo lời mời owner → nhận token') : bad('mời owner lỗi', r.raw);

  const ownerPw = 'owner brand new passphrase';
  r = await req(AUTH, 'POST', '/auth/invitations/accept', {
    body: { token: 'sai', password: ownerPw }, origin: ORIGIN_AUTH,
  });
  r.status === 400 ? ok('token lời mời sai → 400') : bad('token sai được nhận', r.raw);

  r = await req(AUTH, 'POST', '/auth/invitations/accept', {
    body: { token: inviteToken, password: ownerPw }, origin: ORIGIN_AUTH,
  });
  r.status === 200 && r.json.account_created && r.json.shop_id === shopId
    ? ok('chấp nhận lời mời → tạo tài khoản + membership') : bad('chấp nhận lời mời lỗi', r.raw);

  r = await req(AUTH, 'POST', '/auth/invitations/accept', {
    body: { token: inviteToken, password: ownerPw }, origin: ORIGIN_AUTH,
  });
  r.status === 400 ? ok('lời mời dùng lại → 400 (một lần, tuần tự)') : bad('lời mời dùng được lần hai', r.raw);

  // Đua: hai accept ĐỒNG THỜI cùng token → đúng MỘT thắng (claim atomic).
  // Bài tuần tự ở trên bị lọc SELECT (accepted_at IS NULL) chặn; chỉ bài đua này
  // mới chạm tới UPDATE ... WHERE accepted_at IS NULL có kiểm rowCount.
  let rr = await req(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, {
    body: { email: `race-${uniq()}@a.vn`, role: 'admin' }, cookie: staffCookie, origin: ORIGIN_OPS,
  });
  const raceToken = rr.json.token;
  const racePw = 'race condition passphrase';
  const [a, b] = await Promise.all([
    req(AUTH, 'POST', '/auth/invitations/accept', { body: { token: raceToken, password: racePw }, origin: ORIGIN_AUTH }),
    req(AUTH, 'POST', '/auth/invitations/accept', { body: { token: raceToken, password: racePw }, origin: ORIGIN_AUTH }),
  ]);
  const wins = [a, b].filter((x) => x.status === 200).length;
  wins === 1 ? ok('hai accept ĐỒNG THỜI → đúng một thắng (claim atomic)') : bad(`race: ${wins} thắng (mong đợi 1)`, `${a.status}/${b.status}`);

  // Owner đăng nhập (chưa MFA) → /auth/me thấy membership owner của đúng shop.
  r = await req(AUTH, 'POST', '/auth/login', { body: { email: ownerEmail, password: ownerPw }, origin: ORIGIN_AUTH });
  const ownerCookie = cookieFrom(r.setCookie);
  r = await req(AUTH, 'GET', '/auth/me', { cookie: ownerCookie });
  const mem = r.json?.memberships?.find((m) => m.shop_id === shopId);
  r.status === 200 && mem?.role === 'owner'
    ? ok('owner đăng nhập → /auth/me thấy membership owner đúng shop') : bad('membership owner lỗi', r.raw);

  // Owner KHÔNG phải nhân viên nền tảng → không vào /ops.
  r = await req(PLATFORM, 'GET', '/ops/shops', { cookie: ownerCookie });
  r.status === 403 ? ok('owner không truy cập được /ops') : bad('owner vào được /ops', r.raw);

  // ── 5. Khoá & mở shop ──────────────────────────────────────────────────────
  sect('5. Khoá & mở shop (không xoá dữ liệu)');
  r = await req(PLATFORM, 'POST', `/ops/shops/${shopId}/suspend`, {
    body: { reason: 'quá hạn thanh toán' }, cookie: staffCookie, origin: ORIGIN_OPS,
  });
  r.status === 200 && r.json.status === 'suspended' ? ok('suspend → 200') : bad('suspend lỗi', r.raw);

  // Dữ liệu shop còn nguyên (subscription vẫn đó).
  const stillThere = await owner.query(`SELECT 1 FROM subscriptions WHERE shop_id = $1`, [shopId]);
  stillThere.rowCount === 1 ? ok('khoá KHÔNG xoá dữ liệu') : bad('dữ liệu bị xoá khi khoá');

  r = await req(PLATFORM, 'POST', `/ops/shops/${shopId}/suspend`, { cookie: staffCookie, origin: ORIGIN_OPS });
  r.status === 409 ? ok('suspend lần hai → 409 (đã suspended)') : bad('suspend lặp không chặn', r.raw);

  r = await req(PLATFORM, 'POST', `/ops/shops/${shopId}/restore`, { cookie: staffCookie, origin: ORIGIN_OPS });
  r.status === 200 && r.json.status === 'active' ? ok('restore → active') : bad('restore lỗi', r.raw);

  // ── 6. Cổng staff (bỏ khỏi platform_staff → mất quyền dù MFA còn) ───────────
  sect('6. Cổng platform_staff');
  await owner.query(`DELETE FROM platform_staff WHERE user_id = $1`, [staff.userId]);
  r = await req(PLATFORM, 'GET', '/ops/shops', { cookie: staffCookie });
  r.status === 403 ? ok('bỏ khỏi platform_staff → 403 dù phiên MFA còn') : bad('vẫn vào được sau khi bỏ staff', r.raw);
  await owner.query(`INSERT INTO platform_staff (user_id, role) VALUES ($1, 'admin')`, [staff.userId]);

  // Staff KHÔNG bật MFA → vẫn bị chặn (MFA bắt buộc cho nhân viên nền tảng).
  // Dùng outsider (không MFA), tạm thêm vào platform_staff.
  const outsiderId = await userIdOf(outsiderEmail);
  await owner.query(`INSERT INTO platform_staff (user_id, role) VALUES ($1, 'operator')`, [outsiderId]);
  r = await req(PLATFORM, 'GET', '/ops/shops', { cookie: outsiderCookie });
  r.status === 403 ? ok('staff chưa bật MFA → 403 (MFA bắt buộc)') : bad('staff không MFA vẫn vào được', r.raw);
  await owner.query(`DELETE FROM platform_staff WHERE user_id = $1`, [outsiderId]);

  // ── 7. Cô lập role DB: app_platform KHÔNG đọc được dữ liệu nghiệp vụ ────────
  sect('7. Cô lập role DB app_platform');
  try {
    await platformRole.query('SELECT 1 FROM orders LIMIT 1');
    bad('app_platform ĐỌC được orders — vi phạm "không xem dữ liệu khách mua"');
  } catch (err) {
    err.code === '42501' ? ok('app_platform bị từ chối quyền trên orders (42501)') : bad('lỗi khác orders', err.code);
  }
  try {
    await platformRole.query('SELECT 1 FROM products LIMIT 1');
    bad('app_platform ĐỌC được products');
  } catch (err) {
    err.code === '42501' ? ok('app_platform bị từ chối quyền trên products (42501)') : bad('lỗi khác products', err.code);
  }
  // Nhưng ĐỌC được bảng quản lý (shops).
  try {
    await platformRole.query('SELECT 1 FROM shops LIMIT 1');
    ok('app_platform đọc được shops (bảng quản lý)');
  } catch (err) {
    bad('app_platform không đọc được shops', err.code);
  }

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  await platformRole.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('platform e2e lỗi:', err);
  process.exit(2);
});
