/**
 * End-to-end auth flow. Chạy TRONG container auth:
 *   docker compose -f infra/compose.dev.yml exec -T auth node apps/auth/test/e2e.mjs
 *
 * Gọi thẳng http://127.0.0.1:3020 (loopback trong container auth). Tự quản cookie,
 * tự tính mã TOTP thật từ secret enroll trả về. Mỗi bài chứng minh một tính chất
 * bảo mật cụ thể — và quan trọng nhất là chứng minh hệ thống TỪ CHỐI đúng chỗ.
 *
 * Test có thể chạy tới ~60 giây: TOTP nghiêm ngặt buộc mỗi lần verify phải dùng
 * một BƯỚC THỜI GIAN mới, nên test phải chờ sang bước kế (tối đa 30s mỗi lần).
 * Đó là hành vi đúng, không phải chỗ để đi tắt.
 */

import Redis from 'ioredis';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const BASE = 'http://127.0.0.1:3020';
const ORIGIN = 'https://auth.localtest';
const redis = new Redis(process.env.REDIS_URL);

let pass = 0;
let fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${d}${X}`); };
const sect = (m) => console.log(`\n${B}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let key = null; // Buffer secret TOTP, gán sau khi enroll

function codeNow() {
  const t = Date.now();
  return { code: totp(key, { tMillis: t }), counter: counterFor(t) };
}

/**
 * Mã hợp lệ cho một bước thời gian MỚI hơn `usedCounter`.
 * Server chặn replay bằng last_counter, nên phải chờ sang bước kế — đúng như
 * người dùng thật phải chờ app Authenticator đổi số.
 */
async function freshCodeAfter(usedCounter) {
  while (counterFor(Date.now()) <= usedCounter) await sleep(1000);
  return codeNow();
}

function tokenFromSetCookie(setCookie) {
  for (const c of setCookie) {
    const m = /^__Host-session=([^;]*)/.exec(c);
    if (m) return m[1];
  }
  return null;
}

async function req(method, path, { body, cookie, origin = ORIGIN, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (origin !== null) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, json, setCookie: res.headers.getSetCookie(), raw: text };
}

async function main() {
  await redis.flushdb(); // dev: bắt đầu sạch để rate-limit không lây từ lần chạy trước

  // ── 1. Đăng ký + đăng nhập không MFA ───────────────────────────────────────
  sect('1. Đăng ký & đăng nhập (không MFA)');
  const email = `user-${uniq()}@shopa.vn`;
  const password = 'correct horse battery';

  let r = await req('POST', '/auth/register', { body: { email, password } });
  r.status === 201 ? ok('đăng ký tạo user') : bad('đăng ký thất bại', r.raw);

  // Thân response phải Y HỆT cho email mới và email đã tồn tại — không chỉ status.
  // (Bài test cũ chỉ kiểm status 201 nên bỏ lọt oracle liệt kê qua body khác nhau.)
  const bodyNew = r.raw;
  r = await req('POST', '/auth/register', { body: { email, password } });
  r.status === 201 && r.raw === bodyNew
    ? ok('đăng ký lại email tồn tại → status VÀ body y hệt (không dò được)')
    : bad('register rò tồn tại email qua body khác nhau', `mới=${bodyNew} | trùng=${r.raw}`);

  r = await req('POST', '/auth/register', { body: { email: `x-${uniq()}@a.vn`, password: 'short' } });
  r.status === 400 ? ok('mật khẩu quá ngắn bị từ chối') : bad('nhận mật khẩu yếu', r.raw);

  r = await req('POST', '/auth/login', { body: { email, password: 'wrong wrong wrong' } });
  r.status === 401 && !r.json?.mfa_required ? ok('sai mật khẩu → 401 chung chung') : bad('sai mật khẩu không bị chặn đúng', r.raw);

  r = await req('POST', '/auth/login', { body: { email, password } });
  const cookie = tokenFromSetCookie(r.setCookie);
  r.status === 200 && cookie ? ok('đúng mật khẩu → 200 + cookie phiên') : bad('đăng nhập đúng thất bại', r.raw);

  // ── 2. Thuộc tính cookie ───────────────────────────────────────────────────
  sect('2. Thuộc tính cookie phiên');
  const sc = r.setCookie[0] ?? '';
  for (const attr of ['__Host-session=', 'Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) {
    sc.includes(attr) ? ok(`cookie có "${attr}"`) : bad(`cookie thiếu "${attr}"`, sc);
  }

  // ── 3. Phiên hoạt động ─────────────────────────────────────────────────────
  sect('3. Phiên & /auth/me');
  r = await req('GET', '/auth/me', { cookie });
  r.status === 200 && r.json?.email === email ? ok('/auth/me trả đúng user') : bad('/auth/me lỗi', r.raw);

  r = await req('GET', '/auth/me', { cookie: 'invalid-garbage-token-xyz' });
  r.status === 401 ? ok('cookie rác → 401') : bad('cookie rác được chấp nhận', r.raw);

  // ── 4. CSRF ────────────────────────────────────────────────────────────────
  sect('4. Chống CSRF (Origin)');
  r = await req('POST', '/auth/logout', { cookie, origin: null });
  r.status === 403 ? ok('POST thiếu Origin → 403') : bad('mutation không cần Origin', r.raw);

  r = await req('POST', '/auth/logout', { cookie, origin: 'https://evil.example' });
  r.status === 403 ? ok('POST Origin lạ → 403') : bad('Origin lạ được chấp nhận', r.raw);

  // ── 5. Bật MFA ─────────────────────────────────────────────────────────────
  sect('5. Enroll & kích hoạt MFA');
  r = await req('POST', '/auth/mfa/enroll', { cookie });
  const secret = r.json?.secret;
  r.status === 200 && secret && r.json?.otpauth_url?.startsWith('otpauth://')
    ? ok('enroll trả secret + otpauth URL') : bad('enroll lỗi', r.raw);
  key = base32Decode(secret);

  r = await req('POST', '/auth/mfa/activate', { cookie, body: { code: '000000' } });
  r.status === 401 ? ok('kích hoạt bằng mã sai → 401') : bad('mã sai vẫn kích hoạt', r.raw);

  const act = codeNow();
  r = await req('POST', '/auth/mfa/activate', { cookie, body: { code: act.code } });
  const recovery = r.json?.recovery_codes;
  r.status === 200 && Array.isArray(recovery) && recovery.length === 10
    ? ok('kích hoạt bằng mã đúng → nhận 10 mã khôi phục') : bad('kích hoạt lỗi', r.raw);
  let usedCounter = act.counter;

  // ── 6. Đăng nhập hai bước ──────────────────────────────────────────────────
  sect('6. Đăng nhập hai bước');
  r = await req('POST', '/auth/login', { body: { email, password } });
  const halfCookie = tokenFromSetCookie(r.setCookie);
  r.status === 200 && r.json?.mfa_required && halfCookie
    ? ok('login → mfa_required + phiên nửa vời') : bad('không vào bước MFA', r.raw);

  r = await req('GET', '/auth/me', { cookie: halfCookie });
  r.status === 401 && r.json?.mfa_required ? ok('phiên nửa vời bị /auth/me từ chối') : bad('phiên nửa vời lọt qua', r.raw);

  // Mã dùng để KÍCH HOẠT đã bị tiêu thụ — không được dùng lại để đăng nhập.
  r = await req('POST', '/auth/mfa/verify', { cookie: halfCookie, body: { code: act.code } });
  r.status === 401 ? ok('mã đã dùng khi kích hoạt không đăng nhập lại được') : bad('mã kích hoạt tái sử dụng được', r.raw);

  const v1 = await freshCodeAfter(usedCounter);
  r = await req('POST', '/auth/mfa/verify', { cookie: halfCookie, body: { code: v1.code } });
  r.status === 200 ? ok('mfa/verify mã mới → phiên đầy đủ') : bad('mfa/verify lỗi', r.raw);
  usedCounter = v1.counter;

  r = await req('GET', '/auth/me', { cookie: halfCookie });
  r.status === 200 ? ok('sau verify, /auth/me hoạt động') : bad('phiên chưa nâng cấp', r.raw);

  // ── 7. Chống replay TOTP ───────────────────────────────────────────────────
  sect('7. Chống replay TOTP');
  r = await req('POST', '/auth/login', { body: { email, password } });
  const half2 = tokenFromSetCookie(r.setCookie);
  r = await req('POST', '/auth/mfa/verify', { cookie: half2, body: { code: v1.code } });
  r.status === 401 ? ok('dùng lại mã TOTP vừa dùng → 401 (last_counter chặn)') : bad('replay TOTP lọt', r.raw);

  // ── 8. Mã khôi phục ────────────────────────────────────────────────────────
  sect('8. Mã khôi phục (một lần)');
  r = await req('POST', '/auth/login', { body: { email, password } });
  const half3 = tokenFromSetCookie(r.setCookie);
  const rc = recovery[0];
  r = await req('POST', '/auth/mfa/verify', { cookie: half3, body: { code: rc } });
  r.status === 200 ? ok('mã khôi phục đăng nhập được') : bad('mã khôi phục không dùng được', r.raw);

  r = await req('POST', '/auth/login', { body: { email, password } });
  const half4 = tokenFromSetCookie(r.setCookie);
  r = await req('POST', '/auth/mfa/verify', { cookie: half4, body: { code: rc } });
  r.status === 401 ? ok('mã khôi phục dùng lại → 401 (một lần)') : bad('mã khôi phục dùng được lần hai', r.raw);

  // ── 9. Logout ──────────────────────────────────────────────────────────────
  sect('9. Đăng xuất thu hồi phiên');
  r = await req('POST', '/auth/logout', { cookie });
  r.status === 200 ? ok('logout 200') : bad('logout lỗi', r.raw);
  r = await req('GET', '/auth/me', { cookie });
  r.status === 401 ? ok('sau logout, phiên cũ bị thu hồi') : bad('phiên sống sót sau logout', r.raw);

  // ── 10. Quên & đặt lại mật khẩu ────────────────────────────────────────────
  sect('10. Đặt lại mật khẩu');

  // Dựng một phiên ĐẦY ĐỦ (qua MFA). Dùng phiên nửa vời ở đây sẽ khiến bài
  // "reset thu hồi phiên" pass giả: /auth/me từ chối phiên nửa vời dù có reset hay không.
  r = await req('POST', '/auth/login', { body: { email, password } });
  const fullCookie = tokenFromSetCookie(r.setCookie);
  const v2 = await freshCodeAfter(usedCounter);
  r = await req('POST', '/auth/mfa/verify', { cookie: fullCookie, body: { code: v2.code } });
  usedCounter = v2.counter;
  r = await req('GET', '/auth/me', { cookie: fullCookie });
  r.status === 200 ? ok('có phiên ĐẦY ĐỦ trước khi reset (điều kiện của bài test)') : bad('không dựng được phiên đầy đủ', r.raw);

  r = await req('POST', '/auth/password/forgot', { body: { email } });
  r.status === 200 ? ok('forgot luôn trả 200') : bad('forgot lỗi', r.raw);

  r = await req('POST', '/auth/password/forgot', { body: { email: `khong-ton-tai-${uniq()}@a.vn` } });
  r.status === 200 ? ok('forgot email lạ cũng 200 (không dò được)') : bad('forgot rò tồn tại', r.raw);

  const resetToken = await redis.get(`dev:reset:${email}`);
  resetToken ? ok('lấy được reset token (dev stash)') : bad('không có reset token');

  const newPassword = 'brand new passphrase 42';
  r = await req('POST', '/auth/password/reset', { body: { token: 'sai-token', password: newPassword } });
  r.status === 400 ? ok('reset token sai → 400') : bad('token sai được chấp nhận', r.raw);

  r = await req('POST', '/auth/password/reset', { body: { token: resetToken, password: newPassword } });
  r.status === 200 ? ok('reset token đúng → 200') : bad('reset lỗi', r.raw);

  r = await req('POST', '/auth/password/reset', { body: { token: resetToken, password: 'another one here' } });
  r.status === 400 ? ok('reset token dùng lại → 400 (một lần)') : bad('reset token dùng lại được', r.raw);

  r = await req('GET', '/auth/me', { cookie: fullCookie });
  r.status === 401 ? ok('đổi mật khẩu thu hồi phiên ĐẦY ĐỦ đang sống') : bad('phiên sống sót sau reset', r.raw);

  r = await req('POST', '/auth/login', { body: { email, password } });
  r.status === 401 ? ok('mật khẩu CŨ không đăng nhập được nữa') : bad('mật khẩu cũ vẫn dùng được', r.raw);

  r = await req('POST', '/auth/login', { body: { email, password: newPassword } });
  r.status === 200 && r.json?.mfa_required ? ok('mật khẩu MỚI đăng nhập được (vẫn hỏi MFA)') : bad('mật khẩu mới lỗi', r.raw);

  // ── 11. Rate limit đăng nhập ───────────────────────────────────────────────
  sect('11. Rate limit đăng nhập (theo tài khoản)');
  await redis.flushdb();
  const victim = `rl-${uniq()}@a.vn`;
  await req('POST', '/auth/register', { body: { email: victim, password } });
  let got429 = false;
  let attempts = 0;
  for (let i = 0; i < 13; i++) {
    const rr = await req('POST', '/auth/login', { body: { email: victim, password: 'nope nope nope' } });
    attempts++;
    if (rr.status === 429) { got429 = true; break; }
  }
  got429 ? ok(`bị chặn 429 sau ${attempts} lần thử sai (ngưỡng 10/tài khoản)`) : bad('không có rate limit đăng nhập');

  // Sau khi kẻ tấn công làm nạn nhân bị 429 bằng mật khẩu sai, mật khẩu ĐÚNG của
  // nạn nhân KHÔNG được bị khoá lây (chống lockout DoS). Bộ đếm theo IP dùng chung
  // IP container ở đây, nên né bằng cách xoá bộ đếm IP, giữ bộ đếm lần-sai theo acct.
  await redis.del(`rl:login:ip:127.0.0.1`);
  r = await req('POST', '/auth/login', { body: { email: victim, password } });
  r.status === 200
    ? ok('mật khẩu ĐÚNG vẫn đăng nhập được dù acct đã bị spam sai (không lockout)')
    : bad('lockout DoS: mật khẩu đúng bị chặn lây', r.raw);

  // ── 12. Rate limit đăng ký (chống DoS Argon2) ──────────────────────────────
  sect('12. Rate limit đăng ký');
  await redis.flushdb();
  let reg429 = false;
  for (let i = 0; i < 12; i++) {
    const rr = await req('POST', '/auth/register', { body: { email: `reg-${uniq()}@a.vn`, password } });
    if (rr.status === 429) { reg429 = true; break; }
  }
  reg429 ? ok('register bị chặn 429 (ngưỡng 10/giờ theo IP)') : bad('register không rate limit → DoS Argon2');

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await redis.quit();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('e2e lỗi:', err);
  process.exit(2);
});
