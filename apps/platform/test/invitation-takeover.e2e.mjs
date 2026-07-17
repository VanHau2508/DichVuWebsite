/**
 * End-to-end P0-4: chiếm shop qua ĐĂNG KÝ TRƯỚC email lời mời. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/platform/test/invitation-takeover.e2e.mjs
 *
 * Bất biến (token lời mời = bằng chứng sở hữu email):
 *   1. Kẻ đăng ký trước owner@brand.vn KHÔNG chiếm được shop: accept CLAIM tài khoản
 *      chưa xác minh (đặt lại mật khẩu theo người giữ token) → mật khẩu kẻ tấn công chết.
 *   2. MFA do kẻ tấn công cài trên tài khoản chưa xác minh bị xoá khi claim (không khoá chủ thật).
 *   3. Tài khoản ĐÃ xác minh: accept đòi đăng nhập đúng tài khoản (không bind mù).
 *   4. Luồng mời hợp lệ (email mới) vẫn chạy — không hồi quy.
 */

import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
// Token lời mời KHÔNG còn trong API response (email hoá, 0073) — lấy từ outbox qua owner SQL.
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
const register = (email, password) => rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
const loginRaw = (email, password) => rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA });
const login = async (email, password) => ck((await loginRaw(email, password)).sc);
const accept = (token, password, cookie) => rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token, password }, cookie, origin: OA });
const uid = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;

async function makeStaff() {
  const email = `staff-${uniq()}@nentang.vn`, password = 'staff strong passphrase';
  await register(email, password);
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
async function makeShop(staff, slug) {
  return (await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO })).json.id;
}
const invite = async (staff, shopId, email, role = 'owner') => {
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role }, cookie: staff, origin: OO });
  return inviteTokenOf(email); // token chỉ nằm trong email (outbox) — người mời không nhận được
};
const membershipsOf = async (cookie) => (await rq(AUTH, 'GET', '/auth/me', { cookie })).json?.memberships ?? [];

async function main() {
  const staff = await makeStaff();
  ok('dựng platform staff');

  // ── 1. Đăng ký trước KHÔNG chiếm được shop ─────────────────────────────────
  sect('1. Chiếm shop qua đăng ký trước → bị chặn');
  const shop1 = await makeShop(staff, `tk-${uniq()}`);
  const email1 = `owner-${uniq()}@brand.vn`;
  const attackerPass = 'attacker password 123';
  const ownerPass = 'real owner password 456';
  await register(email1, attackerPass);                 // kẻ tấn công đăng ký trước
  const t1 = await invite(staff, shop1, email1, 'owner'); // platform mời chủ thật
  let r = await accept(t1, ownerPass);                    // chủ thật chấp nhận (mật khẩu của họ)
  r.status === 200 ? ok('chủ thật accept → 200') : bad('accept lỗi', r.raw);

  r = await loginRaw(email1, attackerPass);
  r.status === 401 ? ok('mật khẩu KẺ TẤN CÔNG không đăng nhập được (đã bị claim)') : bad('KẺ TẤN CÔNG vẫn đăng nhập được → CHIẾM SHOP', `status=${r.status}`);
  const ownerCookie = await login(email1, ownerPass);
  const ms = await membershipsOf(ownerCookie);
  ownerCookie && ms.some((m) => m.shop_id === shop1 && m.role === 'owner')
    ? ok('chủ thật đăng nhập được + là owner shop') : bad('chủ thật không kiểm soát được shop', JSON.stringify(ms));

  // ── 2. MFA kẻ tấn công cài bị xoá khi claim ────────────────────────────────
  sect('2. Claim xoá MFA của kẻ tấn công');
  const shop2 = await makeShop(staff, `tk2-${uniq()}`);
  const email2 = `owner-${uniq()}@brand.vn`;
  await register(email2, attackerPass);
  const aCookie = await login(email2, attackerPass);      // kẻ tấn công cài MFA trên tài khoản chiếm
  let er = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie: aCookie, origin: OA });
  const aKey = base32Decode(er.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie: aCookie, body: { code: totp(aKey, {}) }, origin: OA });
  const t2 = await invite(staff, shop2, email2, 'owner');
  await accept(t2, ownerPass);                            // chủ thật claim
  r = await loginRaw(email2, ownerPass);
  r.status === 200 && r.json?.mfa_required !== true
    ? ok('chủ thật đăng nhập KHÔNG bị chặn bởi MFA của kẻ tấn công (MFA đã reset)') : bad('MFA kẻ tấn công còn hiệu lực', r.raw);

  // ── 3. Tài khoản đã xác minh: accept đòi đăng nhập ─────────────────────────
  sect('3. Tài khoản đã xác minh cần đăng nhập mới bind');
  const email3 = `multi-${uniq()}@brand.vn`, passM = 'multishop password 789';
  const shopA = await makeShop(staff, `tka-${uniq()}`);
  const shopB = await makeShop(staff, `tkb-${uniq()}`);
  await accept(await invite(staff, shopA, email3, 'owner'), passM); // tạo tài khoản (verified) qua shopA
  const tB = await invite(staff, shopB, email3, 'owner');
  r = await accept(tB, passM);                            // accept KHÔNG đăng nhập
  r.status === 403 && r.json?.login_required ? ok('accept khi CHƯA đăng nhập → 403 login_required') : bad('bind mù tài khoản đã xác minh', `status=${r.status}`);
  const cookieM = await login(email3, passM);
  r = await accept(tB, passM, cookieM);                   // accept khi ĐÃ đăng nhập
  r.status === 200 ? ok('accept khi đã đăng nhập đúng tài khoản → 200') : bad('accept có phiên vẫn lỗi', r.raw);
  (await membershipsOf(cookieM)).filter((m) => m.shop_id === shopA || m.shop_id === shopB).length === 2
    ? ok('là thành viên cả hai shop') : bad('thiếu membership');

  // ── 4. Luồng mời hợp lệ (email mới) — không hồi quy ────────────────────────
  sect('4. Email mới vẫn accept bình thường');
  const shop4 = await makeShop(staff, `tk4-${uniq()}`);
  const email4 = `fresh-${uniq()}@brand.vn`, pass4 = 'fresh owner password 000';
  r = await accept(await invite(staff, shop4, email4, 'owner'), pass4);
  const c4 = await login(email4, pass4);
  r.status === 200 && c4 && (await membershipsOf(c4)).some((m) => m.shop_id === shop4)
    ? ok('email mới: tạo tài khoản + là owner (không hồi quy)') : bad('luồng hợp lệ hỏng', r.raw);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('takeover e2e lỗi:', err); process.exit(2); });
