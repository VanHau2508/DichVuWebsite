// E2E service tài khoản khách (0083) — commit 2: đăng ký ENUM-SAFE + KHÔNG auto-login,
// đăng nhập (DUMMY_HASH timing-safe), đăng xuất, CSRF, cô lập shop, chặn MK yếu.
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = 'http://auth:3020', PLATFORM = 'http://platform:3030';
const ACC = new URL(process.env.ACCOUNT_URL ?? 'http://account:3062');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  PASS ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? ' :: ' + String(d).slice(0, 200) : '')); };
const sect = (m) => console.log('\n# ' + m);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };
async function rq(base, method, path, { body, cookie, origin } = {}) {
  const h = {}; if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin; if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie() };
}
const login = async (e, p) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email: e, password: p }, origin: OA })).sc);
const uidOf = async (e) => (await owner.query('SELECT id FROM users WHERE email=$1', [e])).rows[0]?.id ?? null;
// Gọi account service: Host = domain shop; đọc __Host-cust_session từ set-cookie.
function acc(host, method, path, { form, cookie, origin } = {}) {
  return new Promise((resolve, reject) => {
    const data = form !== undefined ? new URLSearchParams(form).toString() : null;
    const headers = { host };
    if (data != null) { headers['content-type'] = 'application/x-www-form-urlencoded'; headers['content-length'] = Buffer.byteLength(data); }
    if (origin) headers.origin = origin;
    if (cookie) headers.cookie = `__Host-cust_session=${cookie}`;
    const req = http.request({ hostname: ACC.hostname, port: ACC.port, path, method, headers }, (rs) => {
      let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => {
        let tok = null; for (const c of rs.headers['set-cookie'] ?? []) { const m = /^__Host-cust_session=([^;]*)/.exec(c); if (m) tok = m[1]; }
        resolve({ status: rs.statusCode, body: b, location: rs.headers.location, setTok: tok, hasSetCookie: (rs.headers['set-cookie'] ?? []).some((c) => c.startsWith('__Host-cust_session=')) });
      });
    });
    req.on('error', reject); if (data != null) req.write(data); req.end();
  });
}
async function makeStaff() {
  const email = `staff-${uniq()}@nentang.vn`, password = 'staff strong passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let c = await login(email, password);
  const en = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie: c, origin: OA });
  const key = base32Decode(en.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie: c, body: { code: totp(key, {}) }, origin: OA });
  const c0 = counterFor(Date.now());
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,'admin')`, [await uidOf(email)]);
  while (counterFor(Date.now()) <= c0) await sleep(1000);
  c = await login(email, password);
  return ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie: c, body: { code: totp(key, {}) }, origin: OA })).sc) ?? c;
}
const mkShop = async (staff, slug) => { const r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO }); return { shopId: r.json.id, host: `${slug}.nentang.vn` }; };
const N = (x) => Number(x);

async function main() {
  const staff = await makeStaff();
  const A = await mkShop(staff, `acc-${uniq()}`);
  const B = await mkShop(staff, `accb-${uniq()}`);
  const host = A.host, O = `https://${host}`;
  const email = `kh-${uniq()}@mail.vn`, pw = 'khach manh 2026 xyz';
  const custCount = (shopId, em) => owner.query(`SELECT count(*)::int n FROM customers WHERE shop_id=$1 AND lower(email)=lower($2)`, [shopId, em]).then((r) => r.rows[0].n);

  sect('1. GET /account/login → form; GET /account (chưa đăng nhập) → 303 login');
  let r = await acc(host, 'GET', '/account/login');
  r.status === 200 && r.body.includes('Đăng nhập') && r.body.includes('name="password"') ? ok('trang đăng nhập render') : bad('login page lỗi', r.status);
  r = await acc(host, 'GET', '/account');
  r.status === 303 && r.location === '/account/login' ? ok('/account chưa đăng nhập → 303 login') : bad('dashboard không chặn', `${r.status} ${r.location}`);

  sect('2. Đăng ký ENUM-SAFE + KHÔNG auto-login');
  r = await acc(host, 'POST', '/account/register', { origin: O, form: { email, password: pw, full_name: 'Nguyễn Khách' } });
  const doneBody = r.body;
  r.status === 200 && r.body.includes('Gần xong') && !r.hasSetCookie ? ok('đăng ký email mới → trang trung tính, KHÔNG set cookie (không auto-login)') : bad('đăng ký auto-login/sai', `${r.status} setCookie=${r.hasSetCookie}`);
  N(await custCount(A.shopId, email)) === 1 ? ok('DB: 1 khách được tạo') : bad('không tạo khách');
  // Đăng ký LẠI cùng email → phản hồi Y HỆT (không lộ "đã tồn tại"), vẫn 1 khách.
  r = await acc(host, 'POST', '/account/register', { origin: O, form: { email, password: 'khac han mat khau 99', full_name: 'X' } });
  r.status === 200 && r.body === doneBody && !r.hasSetCookie ? ok('đăng ký lại cùng email → body Y HỆT (enum-safe)') : bad('lộ email đã tồn tại', `${r.status} same=${r.body === doneBody}`);
  N(await custCount(A.shopId, email)) === 1 ? ok('DB: vẫn 1 khách (không tạo trùng)') : bad('tạo khách trùng');
  // MK yếu → 400.
  r = await acc(host, 'POST', '/account/register', { origin: O, form: { email: `y-${uniq()}@x.vn`, password: 'password123' } });
  r.status === 400 && r.body.includes('mật khẩu') ? ok('MK yếu → 400') : bad('không chặn MK yếu', r.status);

  sect('3. Đăng nhập / đăng xuất');
  r = await acc(host, 'POST', '/account/login', { origin: O, form: { email, password: 'sai-mat-khau-hoan-toan' } });
  r.status === 401 && r.body.includes('không đúng') ? ok('sai MK → 401 lỗi chung') : bad('sai MK không 401', r.status);
  r = await acc(host, 'POST', '/account/login', { origin: O, form: { email: `khong-ton-tai-${uniq()}@x.vn`, password: pw } });
  r.status === 401 && r.body.includes('không đúng') ? ok('email không tồn tại → 401 lỗi CHUNG (enum-safe)') : bad('email lạ lộ khác', r.status);
  r = await acc(host, 'POST', '/account/login', { origin: O, form: { email, password: pw } });
  const tok = r.setTok;
  r.status === 303 && r.location === '/account' && tok ? ok('đăng nhập đúng → 303 /account + set cookie') : bad('đăng nhập lỗi', `${r.status} ${r.location}`);
  r = await acc(host, 'GET', '/account', { cookie: tok });
  r.status === 200 && r.body.includes(email) ? ok('dashboard hiện email khách') : bad('dashboard lỗi', r.status);

  sect('4. CSRF + cô lập shop');
  r = await acc(host, 'POST', '/account/login', { form: { email, password: pw } }); // KHÔNG origin
  r.status === 403 ? ok('POST login thiếu Origin → 403 (CSRF)') : bad('CSRF lọt', r.status);
  // Cookie shop A gửi tới host shop B → phiên vô hiệu (shop_id khác) → dashboard 303 login.
  r = await acc(B.host, 'GET', '/account', { cookie: tok });
  r.status === 303 && r.location === '/account/login' ? ok('cookie shop A ở host shop B → phiên vô hiệu (cô lập)') : bad('phiên rò chéo shop', `${r.status} ${r.location}`);
  // Cùng email đăng ký được ở shop B (per-store).
  r = await acc(B.host, 'POST', '/account/register', { origin: `https://${B.host}`, form: { email, password: pw } });
  r.status === 200 && N(await custCount(B.shopId, email)) === 1 ? ok('cùng email đăng ký ở shop B → tài khoản độc lập') : bad('per-store email lỗi', r.status);

  sect('5. Đăng xuất → phiên revoked');
  r = await acc(host, 'POST', '/account/logout', { origin: O, cookie: tok });
  r.status === 303 && /\/account\/login/.test(r.location ?? '') ? ok('đăng xuất → 303 login') : bad('logout lỗi', `${r.status} ${r.location}`);
  r = await acc(host, 'GET', '/account', { cookie: tok });
  r.status === 303 ? ok('sau đăng xuất, cookie cũ vô hiệu → 303 login') : bad('phiên chưa revoke', r.status);
  const revoked = N((await owner.query(`SELECT count(*)::int n FROM customer_sessions s JOIN customers c ON c.id=s.customer_id WHERE c.shop_id=$1 AND lower(c.email)=lower($2) AND s.revoked_at IS NOT NULL`, [A.shopId, email])).rows[0].n);
  revoked >= 1 ? ok('DB: phiên có revoked_at') : bad('phiên chưa revoke trong DB');

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
