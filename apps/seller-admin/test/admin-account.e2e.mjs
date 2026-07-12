/**
 * End-to-end tài khoản (bật MFA) + nhân sự (mời/đổi vai trò/gỡ) qua admin (BFF).
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-account.e2e.mjs
 *
 * Điểm nhấn: thao tác nhân sự cần STEP-UP (xác nhận lại mật khẩu) → interstitial mang
 * hành động đang chờ; sai mật khẩu chặn; đúng thì chạy tiếp. Guard "owner cuối", CSRF,
 * cô lập chéo shop. Bật MFA: enroll → activate (mã sai chặn) → mã khôi phục.
 */
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
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
  return { status: r.status, location: r.headers.get('location'), body: await r.text() };
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;
const members = (shopId, cookie) => rq(SELLER, 'GET', `/shops/${shopId}/members`, { cookie }).then((r) => r.json.members);

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
  await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA });
  return cookie;
}
async function makeShopOwner(staffCookie, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: r.json.token, password }, origin: OA });
  return { shopId, email, password, cookie: await login(email, password) };
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `ac-${uniq()}`);
  const Bo = await makeShopOwner(staff, `bc-${uniq()}`);
  ok('dựng shop + chủ shop (chưa MFA)');

  // ── 1. Bật MFA ─────────────────────────────────────────────────────────────
  sect('1. Tài khoản — bật MFA');
  let r = await adm('GET', '/account', { cookie: A.cookie });
  r.status === 200 && r.body.includes(A.email) && /Bật MFA/.test(r.body) ? ok('trang tài khoản: email + nút Bật MFA') : bad('trang account sai', r.body.slice(0, 160));

  r = await adm('POST', '/account/mfa/enroll', { cookie: A.cookie, origin: OADM });
  const secret = (/Khoá bí mật: <code>([A-Z2-7]+)<\/code>/.exec(r.body) || [])[1];
  const otpauth = (/otpauth: <code>([^<]+)<\/code>/.exec(r.body) || [])[1];
  r.status === 200 && secret && /Kích hoạt MFA/.test(r.body) ? ok('enroll → hiện secret + form kích hoạt') : bad('enroll lỗi', r.body.slice(0, 160));

  const key = base32Decode(secret);
  r = await adm('POST', '/account/mfa/activate', { cookie: A.cookie, origin: OADM, form: { code: '000000', secret, otpauth } });
  r.status >= 400 && /không đúng/.test(r.body) && /Kích hoạt MFA/.test(r.body) ? ok('mã sai → lỗi, vẫn ở bước kích hoạt (giữ secret)') : bad('mã sai không chặn', String(r.status));

  r = await adm('POST', '/account/mfa/activate', { cookie: A.cookie, origin: OADM, form: { code: totp(key, {}), secret, otpauth } });
  const meMfa = (await rq(AUTH, 'GET', '/auth/me', { cookie: A.cookie })).json.mfa_enabled;
  r.status === 200 && /Đã bật MFA/.test(r.body) && /<code>/.test(r.body) && meMfa === true ? ok('mã đúng → bật MFA + hiện mã khôi phục, /auth/me mfa_enabled') : bad('activate lỗi', `${r.status} me=${meMfa}`);

  r = await adm('POST', '/account/password/forgot', { cookie: A.cookie, origin: OADM });
  r.status === 200 && /đặt lại mật khẩu/.test(r.body) ? ok('gửi link đặt lại mật khẩu → thông báo') : bad('forgot lỗi', String(r.status));

  // ── 2. Nhân sự + step-up ───────────────────────────────────────────────────
  sect('2. Nhân sự — step-up');
  const M = (s) => `/shops/${A.shopId}/members${s}`;
  r = await adm('GET', M(''), { cookie: A.cookie });
  r.status === 200 && r.body.includes(A.email) && /Mời thành viên/.test(r.body) ? ok('danh sách nhân sự + form mời (owner)') : bad('members list sai', r.body.slice(0, 160));

  const invitee = `nv-${uniq()}@shop.vn`;
  r = await adm('POST', M('/invite'), { cookie: A.cookie, origin: OADM, form: { email: invitee, role: 'admin' } });
  r.status === 200 && /Xác nhận mật khẩu/.test(r.body) && !/Đã mời/.test(r.body) ? ok('mời khi CHƯA step-up → interstitial hỏi mật khẩu') : bad('không chặn bằng step-up', r.body.slice(0, 160));

  r = await adm('POST', M('/step-up'), { cookie: A.cookie, origin: OADM, form: { __action: 'invite', email: invitee, role: 'admin', password: 'sai mật khẩu' } });
  r.status >= 400 && /Mật khẩu không đúng/.test(r.body) ? ok('step-up sai mật khẩu → chặn') : bad('step-up sai vẫn qua', String(r.status));

  r = await adm('POST', M('/step-up'), { cookie: A.cookie, origin: OADM, form: { __action: 'invite', email: invitee, role: 'admin', password: A.password } });
  const token = decodeURIComponent((/invite\/accept\?token=([^"<]+)/.exec(r.body) || [])[1] ?? '');
  r.status === 200 && /Đã mời/.test(r.body) && token ? ok('step-up đúng → mời thành công + link chấp nhận') : bad('mời sau step-up lỗi', r.body.slice(0, 160));

  // Đã step-up (còn hạn 5') → mời tiếp KHÔNG hỏi lại mật khẩu.
  const invitee2 = `nv2-${uniq()}@shop.vn`;
  r = await adm('POST', M('/invite'), { cookie: A.cookie, origin: OADM, form: { email: invitee2, role: 'catalog_manager' } });
  const token2 = decodeURIComponent((/invite\/accept\?token=([^"<]+)/.exec(r.body) || [])[1] ?? '');
  r.status === 200 && /Đã mời/.test(r.body) && !/Xác nhận mật khẩu/.test(r.body) && token2 ? ok('trong cửa sổ step-up → mời thẳng + hiện link chấp nhận') : bad('vẫn hỏi step-up trong cửa sổ', r.body.slice(0, 120));

  // ── 3. Đổi vai trò + gỡ (thành viên thật) ──────────────────────────────────
  sect('3. Đổi vai trò & gỡ');
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token, password: 'thanhvien manh 2026' }, origin: OA });
  let ms = await members(A.shopId, A.cookie);
  const nv = ms.find((x) => x.email === invitee);
  ms.length === 2 && nv?.role === 'admin' ? ok('nhân viên chấp nhận lời mời → là admin của shop') : bad('accept invite lỗi', JSON.stringify(ms.map((x) => x.role)));

  // Select đổi vai trò của thành viên KHÔNG có option "owner" (nhất quán với mời); owner read-only.
  r = await adm('GET', M(''), { cookie: A.cookie });
  /<select name="role"/.test(r.body) && !/<option value="owner"/.test(r.body) ? ok('UI đổi vai trò không cho promote owner (không có option owner)') : bad('UI vẫn cho promote owner', '');

  r = await adm('POST', M(`/${nv.user_id}/role`), { cookie: A.cookie, origin: OADM, form: { role: 'order_manager' } });
  ms = await members(A.shopId, A.cookie);
  r.status === 303 && ms.find((x) => x.user_id === nv.user_id)?.role === 'order_manager' ? ok('đổi vai trò → order_manager (đang step-up)') : bad('đổi vai trò lỗi', `${r.status}`);

  // Guard: hạ owner cuối cùng → 409.
  const meUid = ms.find((x) => x.email === A.email).user_id;
  r = await adm('POST', M(`/${meUid}/role`), { cookie: A.cookie, origin: OADM, form: { role: 'admin' } });
  ms = await members(A.shopId, A.cookie);
  r.status >= 400 && /owner cuối/.test(r.body) && ms.find((x) => x.user_id === meUid).role === 'owner' ? ok('hạ owner cuối cùng → chặn, A vẫn owner') : bad('bỏ được owner cuối', `${r.status}`);

  r = await adm('POST', M(`/${nv.user_id}/remove`), { cookie: A.cookie, origin: OADM });
  ms = await members(A.shopId, A.cookie);
  r.status === 303 && ms.length === 1 ? ok('gỡ thành viên → còn 1 (owner)') : bad('gỡ thành viên lỗi', `${r.status} n=${ms.length}`);

  // ── 3b. Trang chấp nhận lời mời (công khai — người được mời chưa có phiên) ──
  sect('3b. Chấp nhận lời mời');
  r = await adm('GET', `/invite/accept?token=${encodeURIComponent(token2)}`, {});
  r.status === 200 && /Tham gia cửa hàng/.test(r.body) && r.body.includes('name="password"') ? ok('trang chấp nhận: form đặt mật khẩu') : bad('accept page sai', r.body.slice(0, 150));
  r = await adm('POST', '/invite/accept', { origin: OADM, form: { token: token2, password: 'nguoimoi2 manh 2026' } });
  const joined = (await members(A.shopId, A.cookie)).find((x) => x.email === invitee2);
  r.status === 200 && /Đã tham gia/.test(r.body) && joined?.role === 'catalog_manager' ? ok('chấp nhận qua trang → tạo tài khoản + tham gia (catalog_manager)') : bad('accept submit lỗi', `${r.status} ${joined?.role}`);
  r = await adm('POST', '/invite/accept', { origin: OADM, form: { token: token2, password: 'x'.repeat(12) } });
  r.status >= 400 && /(không hợp lệ|đã)/.test(r.body) ? ok('token đã dùng → chặn') : bad('token dùng lại vẫn qua', r.body.slice(0, 120));
  r = await adm('GET', '/invite/accept', {});
  r.status === 400 ? ok('mở /invite/accept thiếu token → 400') : bad('thiếu token không chặn', String(r.status));

  // ── 4. CSRF + cô lập ───────────────────────────────────────────────────────
  sect('4. CSRF & cô lập');
  r = await adm('POST', M('/invite'), { cookie: A.cookie, form: { email: `x-${uniq()}@x.vn`, role: 'admin' } }); // KHÔNG Origin
  r.status === 403 ? ok('mời không Origin → 403 (CSRF)') : bad('CSRF không chặn', String(r.status));
  r = await adm('GET', `/shops/${Bo.shopId}/members`, { cookie: A.cookie });
  r.status === 403 ? ok('owner A xem nhân sự shop B → 403') : bad('rò nhân sự chéo shop', String(r.status));

  // ── 5. Đổi mật khẩu + tắt MFA (qua admin) ──────────────────────────────────
  sect('5. Đổi mật khẩu & tắt MFA');
  const newPw = 'chu shop moi manh 2026';
  r = await adm('POST', '/account/password/change', { cookie: A.cookie, origin: OADM, form: { current_password: 'sai het roi', new_password: newPw } });
  r.status >= 400 && /hiện tại không đúng/.test(r.body) ? ok('đổi mk sai mật khẩu hiện tại → chặn') : bad('đổi mk sai không chặn', String(r.status));
  r = await adm('POST', '/account/password/change', { cookie: A.cookie, origin: OADM, form: { current_password: A.password, new_password: newPw } });
  r.status === 200 && /Đã đổi mật khẩu/.test(r.body) ? ok('đổi mật khẩu thành công') : bad('đổi mk lỗi', String(r.status));
  const oldL = await rq(AUTH, 'POST', '/auth/login', { body: { email: A.email, password: A.password }, origin: OA });
  const newL = await rq(AUTH, 'POST', '/auth/login', { body: { email: A.email, password: newPw }, origin: OA });
  oldL.status === 401 && newL.status === 200 ? ok('mật khẩu cũ vô hiệu, mật khẩu mới được chấp nhận') : bad('đổi mk không thực', `${oldL.status}/${newL.status}`);
  r = await adm('GET', '/account', { cookie: A.cookie });
  r.status === 200 ? ok('phiên hiện tại vẫn sống sau đổi mật khẩu') : bad('phiên bị đá sau đổi mk', String(r.status));
  r = await adm('POST', '/account/mfa/disable', { cookie: A.cookie, origin: OADM, form: { code: '000000' } });
  r.status >= 400 && /không đúng/.test(r.body) ? ok('tắt MFA mã sai → chặn') : bad('tắt MFA mã sai không chặn', String(r.status));
  r = await adm('POST', '/account/mfa/disable', { cookie: A.cookie, origin: OADM, form: { code: totp(key, {}) } });
  const meOff = (await rq(AUTH, 'GET', '/auth/me', { cookie: A.cookie })).json?.mfa_enabled;
  r.status === 200 && /Đã tắt MFA/.test(r.body) && meOff === false ? ok('tắt MFA thành công → mfa_enabled false') : bad('tắt MFA lỗi', `${r.status} ${meOff}`);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((err) => { console.error('admin account e2e lỗi:', err); process.exit(2); });
