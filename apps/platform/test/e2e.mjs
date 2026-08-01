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

import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const STOREFRONT = process.env.STOREFRONT_URL ?? 'http://storefront:3050';

// GET storefront với Host tuỳ ý (fetch/undici không cho đặt header host → node:http,
// mirror apps/storefront/test/e2e.mjs).
function storeGet(host, path = '/') {
  const u = new URL(STOREFRONT);
  return new Promise((resolve, reject) => {
    http.request(
      { hostname: u.hostname, port: u.port, path, method: 'GET', headers: { host } },
      (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); },
    ).on('error', reject).end();
  });
}
const ORIGIN_AUTH = 'https://auth.localtest';
const ORIGIN_OPS = 'https://ops.localtest';

const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
// Token lời mời KHÔNG còn trong API response (email hoá, 0073) — lấy từ outbox qua owner SQL.
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic = 'user.invited' AND payload->>'to' = $1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };
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
    // A6: mfa/verify ROTATE token → lấy cookie mới
    cookie = cookieFrom(r.setCookie) ?? cookie;
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
  r.status === 201 && r.json?.invitation_id ? ok('tạo lời mời owner → 201') : bad('mời owner lỗi', r.raw);
  // #11: token = bằng chứng sở hữu email — KHÔNG được trả cho người mời qua API.
  r.json?.token === undefined && r.raw && !r.raw.includes('"token"')
    ? ok('response KHÔNG chứa token thô (email hoá lời mời)') : bad('response vẫn lộ token', r.raw);
  // Outbox user.invited ghi CÙNG transaction: đọc được ngay, accept_url chứa token.
  const obRow = (await owner.query(
    `SELECT shop_id, payload FROM outbox WHERE topic = 'user.invited' AND payload->>'to' = $1`, [ownerEmail],
  )).rows[0];
  obRow && obRow.shop_id === shopId && obRow.payload?.accept_url?.includes('/invite/accept?token=')
    && obRow.payload?.role === 'owner' && obRow.payload?.shop_name
    ? ok('outbox user.invited: shop_id + accept_url + role + shop_name') : bad('outbox lời mời sai', JSON.stringify(obRow));
  const inviteToken = await inviteTokenOf(ownerEmail);
  inviteToken ? ok('lấy được token từ accept_url trong outbox') : bad('không lấy được token từ outbox');

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
  const raceEmail = `race-${uniq()}@a.vn`;
  let rr = await req(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, {
    body: { email: raceEmail, role: 'admin' }, cookie: staffCookie, origin: ORIGIN_OPS,
  });
  const raceToken = await inviteTokenOf(raceEmail);
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
  // Thao tác phá hoại của staff đòi STEP-UP (mirror phía shop): chưa gõ lại mật khẩu → 403.
  r = await req(PLATFORM, 'POST', `/ops/shops/${shopId}/suspend`, {
    body: { reason: 'quá hạn thanh toán' }, cookie: staffCookie, origin: ORIGIN_OPS,
  });
  r.status === 403 && r.json?.step_up_required ? ok('suspend chưa step-up → 403 step_up_required') : bad('không đòi step-up', r.raw);
  // Step-up một lần — cửa sổ 5 phút phủ toàn bộ các lệnh suspend/restore/renew phía dưới.
  r = await req(AUTH, 'POST', '/auth/step-up', { body: { password: 'a strong platform passphrase' }, cookie: staffCookie, origin: ORIGIN_AUTH });
  r.status === 200 ? ok('staff step-up → 200') : bad('step-up lỗi', r.raw);
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

  // ── 5b. Gia hạn + hoá đơn (sổ thu platform_invoices) ───────────────────────
  sect('5b. Gia hạn + hoá đơn (platform_invoices)');

  // Giá gói lấy từ DB làm mốc so sánh — KHÔNG hardcode lại trong assert.
  const dbPlans = await owner.query(`SELECT code, price_vnd_month FROM plans WHERE active`);
  const priceOf = (c) => Number(dbPlans.rows.find((p) => p.code === c)?.price_vnd_month);

  // /ops/plans — Console render select gói từ đây (giết giá hardcode ở BFF).
  r = await req(PLATFORM, 'GET', '/ops/plans', { cookie: staffCookie });
  const apiPlans = r.json?.plans ?? [];
  r.status === 200 && apiPlans.length >= 3 && apiPlans.every((p) => Number(p.price_vnd_month) === priceOf(p.code))
    ? ok('/ops/plans → giá từng gói khớp DB') : bad('/ops/plans lỗi', r.raw);

  // Renew trần (không ghi đè): amount = giá gói hiện tại × months; kỳ cộng dồn GREATEST.
  const before = await owner.query(`SELECT current_period_end FROM subscriptions WHERE shop_id = $1`, [shopId]);
  const prevEnd = before.rows[0].current_period_end;
  r = await req(PLATFORM, 'POST', `/ops/shops/${shopId}/subscription/renew`, {
    body: { months: 3 }, cookie: staffCookie, origin: ORIGIN_OPS,
  });
  r.status === 200 && r.json.amount_vnd === priceOf('platform') * 3 && r.json.months === 3 && r.json.plan_code === 'platform'
    ? ok(`renew 3 tháng → amount ${r.json.amount_vnd} = giá gói × 3`) : bad('renew 3 tháng lỗi', r.raw);
  let chk = await owner.query(
    `SELECT status, (current_period_end - $2::timestamptz) BETWEEN interval '85 days' AND interval '95 days' AS stacked
       FROM subscriptions WHERE shop_id = $1`, [shopId, prevEnd]);
  chk.rows[0].status === 'active' && chk.rows[0].stacked
    ? ok('sub → active, kỳ cộng dồn ~3 tháng từ mốc GREATEST') : bad('kỳ/trạng thái sau renew sai', JSON.stringify(chk.rows));

  // Hoá đơn đầu tiên: đúng từng cột (amount là bigint → pg trả string → Number()).
  let inv = await owner.query(
    `SELECT plan_code, months, amount_vnd, note, created_by FROM platform_invoices WHERE shop_id = $1 ORDER BY created_at`, [shopId]);
  inv.rowCount === 1 && Number(inv.rows[0].amount_vnd) === priceOf('platform') * 3
    && inv.rows[0].months === 3 && inv.rows[0].plan_code === 'platform'
    && inv.rows[0].created_by === staff.userId && inv.rows[0].note === null
    ? ok('hoá đơn 1: amount/months/plan/created_by/note đúng') : bad('hoá đơn 1 sai', JSON.stringify(inv.rows));

  // Renew đổi gói: hoá đơn ghi giá gói MỚI; kỳ stack thêm ~1 tháng (GREATEST cộng dồn).
  const end2 = await owner.query(`SELECT current_period_end FROM subscriptions WHERE shop_id = $1`, [shopId]);
  r = await req(PLATFORM, 'POST', `/ops/shops/${shopId}/subscription/renew`, {
    body: { months: 1, plan_code: 'growth' }, cookie: staffCookie, origin: ORIGIN_OPS,
  });
  r.status === 200 && r.json.amount_vnd === priceOf('growth') && r.json.plan_code === 'growth'
    ? ok('renew đổi gói → amount = giá gói MỚI (growth)') : bad('renew đổi gói lỗi', r.raw);
  chk = await owner.query(
    `SELECT plan_code, (current_period_end - $2::timestamptz) BETWEEN interval '28 days' AND interval '32 days' AS stacked
       FROM subscriptions WHERE shop_id = $1`, [shopId, end2.rows[0].current_period_end]);
  chk.rows[0].plan_code === 'growth' && chk.rows[0].stacked
    ? ok('sub đổi gói growth, kỳ stack thêm ~1 tháng') : bad('stack đổi gói sai', JSON.stringify(chk.rows));
  inv = await owner.query(`SELECT plan_code FROM platform_invoices WHERE shop_id = $1 ORDER BY created_at DESC LIMIT 1`, [shopId]);
  inv.rows[0].plan_code === 'growth' ? ok('hoá đơn 2 ghi gói growth') : bad('hoá đơn 2 sai gói', JSON.stringify(inv.rows));

  // Ghi đè deal thương lượng: amount tuỳ ý + note.
  r = await req(PLATFORM, 'POST', `/ops/shops/${shopId}/subscription/renew`, {
    body: { months: 6, amount_vnd: 123456, note: 'deal thử nghiệm' }, cookie: staffCookie, origin: ORIGIN_OPS,
  });
  r.status === 200 && r.json.amount_vnd === 123456 ? ok('ghi đè số tiền → 123456') : bad('ghi đè lỗi', r.raw);
  inv = await owner.query(`SELECT amount_vnd, note FROM platform_invoices WHERE shop_id = $1 ORDER BY created_at DESC LIMIT 1`, [shopId]);
  Number(inv.rows[0].amount_vnd) === 123456 && inv.rows[0].note === 'deal thử nghiệm'
    ? ok('hoá đơn 3: amount ghi đè + note') : bad('hoá đơn 3 sai', JSON.stringify(inv.rows));

  // Validate ghi đè: âm / không phải số → 400, KHÔNG thêm hoá đơn.
  r = await req(PLATFORM, 'POST', `/ops/shops/${shopId}/subscription/renew`, {
    body: { months: 1, amount_vnd: -5 }, cookie: staffCookie, origin: ORIGIN_OPS,
  });
  const rAbc = await req(PLATFORM, 'POST', `/ops/shops/${shopId}/subscription/renew`, {
    body: { months: 1, amount_vnd: 'abc' }, cookie: staffCookie, origin: ORIGIN_OPS,
  });
  let cnt = await owner.query(`SELECT count(*)::int AS n FROM platform_invoices WHERE shop_id = $1`, [shopId]);
  r.status === 400 && rAbc.status === 400 && cnt.rows[0].n === 3
    ? ok('amount âm/chữ → 400, không thêm hoá đơn') : bad('validate ghi đè hỏng', `${r.status}/${rAbc.status}/n=${cnt.rows[0].n}`);

  // Clamp months: 99→24, 0→1 — hoá đơn ghi số tháng ĐÃ clamp.
  r = await req(PLATFORM, 'POST', `/ops/shops/${shopId}/subscription/renew`, {
    body: { months: 99 }, cookie: staffCookie, origin: ORIGIN_OPS,
  });
  const r0 = await req(PLATFORM, 'POST', `/ops/shops/${shopId}/subscription/renew`, {
    body: { months: 0 }, cookie: staffCookie, origin: ORIGIN_OPS,
  });
  inv = await owner.query(`SELECT months FROM platform_invoices WHERE shop_id = $1 ORDER BY created_at DESC LIMIT 2`, [shopId]);
  r.json?.months === 24 && r0.json?.months === 1 && inv.rows.some((x) => x.months === 24) && inv.rows.some((x) => x.months === 1)
    ? ok('clamp months 99→24, 0→1 (cả response lẫn hoá đơn)') : bad('clamp lỗi', `${r.raw} / ${r0.raw}`);

  // Gói sai → 400, không thêm hoá đơn.
  r = await req(PLATFORM, 'POST', `/ops/shops/${shopId}/subscription/renew`, {
    body: { months: 1, plan_code: 'khong-ton-tai' }, cookie: staffCookie, origin: ORIGIN_OPS,
  });
  cnt = await owner.query(`SELECT count(*)::int AS n FROM platform_invoices WHERE shop_id = $1`, [shopId]);
  r.status === 400 && cnt.rows[0].n === 5 ? ok('gói sai → 400, không thêm hoá đơn') : bad('gói sai lọt', r.raw);

  // Suspended → renew MỞ LẠI shop (kênh reopened).
  await req(PLATFORM, 'POST', `/ops/shops/${shopId}/suspend`, { cookie: staffCookie, origin: ORIGIN_OPS });
  r = await req(PLATFORM, 'POST', `/ops/shops/${shopId}/subscription/renew`, {
    body: { months: 1 }, cookie: staffCookie, origin: ORIGIN_OPS,
  });
  chk = await owner.query(`SELECT status FROM shops WHERE id = $1`, [shopId]);
  r.status === 200 && chk.rows[0].status === 'active'
    ? ok('renew mở lại shop suspended') : bad('không mở lại suspended', `${r.status}/${chk.rows[0]?.status}`);

  // Terminated KHÔNG mở lại — nhưng tiền VẪN ghi (ghi nhận thu ≠ mở shop, CHỦ ĐÍCH).
  await owner.query(`UPDATE shops SET status = 'terminated' WHERE id = $1`, [shopId]);
  r = await req(PLATFORM, 'POST', `/ops/shops/${shopId}/subscription/renew`, {
    body: { months: 1 }, cookie: staffCookie, origin: ORIGIN_OPS,
  });
  chk = await owner.query(`SELECT status FROM shops WHERE id = $1`, [shopId]);
  cnt = await owner.query(`SELECT count(*)::int AS n FROM platform_invoices WHERE shop_id = $1`, [shopId]);
  r.status === 200 && chk.rows[0].status === 'terminated' && cnt.rows[0].n === 7
    ? ok('terminated: KHÔNG mở lại, hoá đơn vẫn ghi') : bad('semantics terminated sai', `${r.status}/${chk.rows[0]?.status}/n=${cnt.rows[0].n}`);
  await owner.query(`UPDATE shops SET status = 'active' WHERE id = $1`, [shopId]);

  // Shop không tồn tại → 404 (trong transaction, trước mọi UPDATE).
  r = await req(PLATFORM, 'POST', `/ops/shops/00000000-0000-4000-8000-000000000000/subscription/renew`, {
    body: { months: 1 }, cookie: staffCookie, origin: ORIGIN_OPS,
  });
  r.status === 404 ? ok('shop lạ → 404 (không tìm thấy thuê bao)') : bad('shop lạ không 404', r.raw);

  // Lịch sử + tổng qua API khớp SUM trong DB; list shops có cột total_collected_vnd.
  const sum = await owner.query(`SELECT COALESCE(SUM(amount_vnd),0)::bigint AS t FROM platform_invoices WHERE shop_id = $1`, [shopId]);
  r = await req(PLATFORM, 'GET', `/ops/shops/${shopId}`, { cookie: staffCookie });
  r.status === 200 && r.json.invoices?.length === 7 && r.json.invoice_count === 7
    && String(r.json.invoice_total_vnd) === String(sum.rows[0].t)
    ? ok(`chi tiết shop: 7 hoá đơn, tổng ${r.json.invoice_total_vnd} khớp DB`) : bad('lịch sử/tổng qua API sai', r.raw);
  r = await req(PLATFORM, 'GET', '/ops/shops', { cookie: staffCookie });
  const listed = r.json?.shops?.find((s) => s.id === shopId);
  String(listed?.total_collected_vnd) === String(sum.rows[0].t)
    ? ok('list shops: total_collected_vnd khớp tổng') : bad('total_collected_vnd sai', JSON.stringify(listed ?? null));

  // Cô lập role: app_platform đọc được + KHÔNG sửa được (sổ thu append-only);
  // app_rw KHÔNG quyền nào — lưới bắt rò default-privileges 0003 (test "bảng GLOBAL"
  // của schema-invariants MIỄN bảng có shop_id nên không phủ bảng này).
  try {
    await platformRole.query('SELECT 1 FROM platform_invoices LIMIT 1');
    ok('app_platform SELECT platform_invoices OK');
  } catch (err) { bad('app_platform không đọc được platform_invoices', err.code); }
  try {
    await platformRole.query(`UPDATE platform_invoices SET amount_vnd = 0 WHERE shop_id = $1`, [shopId]);
    bad('app_platform SỬA được hoá đơn — chứng từ phải bất biến');
  } catch (err) {
    err.code === '42501' ? ok('app_platform UPDATE bị từ chối (42501) — chứng từ bất biến') : bad('lỗi khác khi UPDATE hoá đơn', err.code);
  }
  const rw = await owner.query(`
    SELECT has_table_privilege('app_rw','platform_invoices','SELECT') AS sel,
           has_table_privilege('app_rw','platform_invoices','INSERT') AS ins,
           has_table_privilege('app_rw','platform_invoices','UPDATE') AS upd,
           has_table_privilege('app_rw','platform_invoices','DELETE') AS del`);
  // ĐỔI KỲ VỌNG (0124): app_rw NAY được SELECT — chủ shop xem lịch sử đóng phí của chính
  // mình trên trang Gói dịch vụ, và RLS (tenant_isolation) siết về đúng shop đó. Chính 0061
  // đã chừa sẵn đường này ("v2 muốn cho seller xem… chỉ cần GRANT SELECT").
  //
  // Thứ PHẢI giữ nguyên là cấm GHI: platform_invoices là sổ THU append-only, chứng từ doanh
  // thu. Shop tự ghi được dòng vào đó nghĩa là tự tuyên bố đã đóng tiền — hỏng cả sổ tiền
  // lẫn báo cáo MRR mà không ai thấy sai. Nên khẳng định siết vào ĐÚNG chỗ đó thay vì bỏ.
  !rw.rows[0].ins && !rw.rows[0].upd && !rw.rows[0].del
    ? ok('app_rw KHÔNG ghi được platform_invoices (sổ thu append-only, chỉ đọc)')
    : bad('app_rw GHI được sổ thu — shop tự tuyên bố đã đóng tiền!', JSON.stringify(rw.rows[0]));
  rw.rows[0].sel
    ? ok('app_rw đọc được platform_invoices (RLS siết về shop của chính họ)')
    : bad('app_rw không đọc được → trang Gói dịch vụ mất lịch sử đóng phí');

  // ── 5c. Metrics điều hành (/ops/metrics) ───────────────────────────────────
  sect('5c. Metrics điều hành (/ops/metrics)');

  // Non-staff (owner của shop) → 403.
  r = await req(PLATFORM, 'GET', '/ops/metrics', { cookie: ownerCookie });
  r.status === 403 ? ok('non-staff GET /ops/metrics → 403') : bad('non-staff xem được metrics', r.raw);

  // Dựng shop SẮP HẾT HẠN: tạo mới (sub trial 14 ngày) rồi kéo kỳ về +3 ngày →
  // phải lọt cửa sổ cảnh báo 7 ngày của expiring_soon.
  const expSlug = `exp-${uniq()}`;
  r = await req(PLATFORM, 'POST', '/ops/shops', {
    body: { name: 'Shop sắp hết hạn', slug: expSlug, plan_code: 'care' },
    cookie: staffCookie, origin: ORIGIN_OPS,
  });
  const expShopId = r.json?.id;
  await owner.query(
    `UPDATE subscriptions SET current_period_end = now() + interval '3 days' WHERE shop_id = $1`,
    [expShopId],
  );

  r = await req(PLATFORM, 'GET', '/ops/metrics', { cookie: staffCookie });
  const mtr = r.json ?? {};
  r.status === 200 ? ok('staff GET /ops/metrics → 200') : bad('metrics lỗi', r.raw);

  // MRR khớp giá trị TÍNH TỪ DB (cùng công thức: active+past_due, join plans, bỏ shop đã xoá).
  const dbMrr = await owner.query(
    `SELECT COALESCE(SUM(p.price_vnd_month), 0)::bigint AS mrr
       FROM subscriptions s JOIN plans p ON p.code = s.plan_code
       JOIN shops sh ON sh.id = s.shop_id
      WHERE s.status IN ('active','past_due') AND sh.deleted_at IS NULL`,
  );
  String(mtr.mrr_vnd) === String(dbMrr.rows[0].mrr) && Number(mtr.mrr_vnd) > 0
    ? ok(`mrr_vnd = ${mtr.mrr_vnd} khớp SUM giá gói active/past_due trong DB`)
    : bad('mrr_vnd lệch DB', `api=${mtr.mrr_vnd} db=${dbMrr.rows[0].mrr}`);

  // revenue_by_month: đúng 12 tháng, LẤP THÁNG TRỐNG; entry cuối = tháng hiện tại
  // và khớp SUM hoá đơn tháng này trong DB.
  const dbMonth = await owner.query(
    `SELECT COALESCE(SUM(amount_vnd), 0)::bigint AS t,
            to_char(date_trunc('month', now()), 'YYYY-MM') AS ym
       FROM platform_invoices WHERE created_at >= date_trunc('month', now())`,
  );
  const months = mtr.revenue_by_month ?? [];
  months.length === 12 ? ok('revenue_by_month có đủ 12 entry (gap-fill)') : bad('revenue_by_month thiếu tháng', JSON.stringify(months.map((x) => x.month)));
  const lastM = months[months.length - 1];
  lastM?.month === dbMonth.rows[0].ym && String(lastM?.amount_vnd) === String(dbMonth.rows[0].t)
    ? ok(`tháng hiện tại ${lastM.month}: amount ${lastM.amount_vnd} khớp SUM DB`)
    : bad('entry tháng hiện tại sai', JSON.stringify(lastM ?? null));

  // expiring_soon chứa shop vừa dựng (kỳ +3 ngày, status trial).
  //
  // Khẳng định HỢP ĐỒNG, không phải sự trùng hợp. Bản đầu chỉ tìm shop mình trong danh sách
  // và ĐỎ VĨNH VIỄN trên DB dev: endpoint trả 20 shop sắp hết hạn SỚM NHẤT, mà DB dev tích
  // 1748 shop hết hạn sớm hơn mốc +3 ngày ⇒ shop của bài test không bao giờ lọt LIMIT 20.
  // CI chạy DB trắng nên xanh — tức là bài test chỉ đúng trên một loại máy, và ở loại máy
  // còn lại nó dạy người ta bỏ qua màu đỏ.
  //
  // Điều thật sự cần kiểm: shop nằm trong cửa sổ 7 ngày thì PHẢI có mặt, TRỪ KHI danh sách
  // đã đầy 20 chỗ bởi những shop hết hạn còn sớm hơn nó. Viết đúng như vậy thì đúng trên cả
  // hai loại máy, và còn chặt HƠN bản cũ vì kiểm luôn thứ tự + trần.
  const expList = mtr.expiring_soon ?? [];
  const expHit = expList.find((x) => x.id === expShopId);
  const expEnd = new Date((await owner.query(
    `SELECT current_period_end e FROM subscriptions WHERE shop_id = $1`, [expShopId])).rows[0].e).getTime();
  const crowdedOut = expList.length >= 20 && expList.every((x) => new Date(x.current_period_end).getTime() <= expEnd);
  if (expHit) {
    expHit.plan_code === 'care' && expHit.sub_status === 'trial'
      ? ok('expiring_soon chứa shop hết hạn sau 3 ngày (trial/care)')
      : bad('expiring_soon có shop nhưng sai gói/trạng thái', JSON.stringify(expHit));
  } else if (crowdedOut) {
    ok(`expiring_soon đầy ${expList.length} chỗ bởi shop hết hạn sớm hơn — đúng thứ tự + trần (DB dev tích dữ liệu)`);
  } else {
    bad('expiring_soon thiếu shop đã dựng mà danh sách CHƯA đầy shop sớm hơn', JSON.stringify(expList));
  }
  const sorted = expList.every((x, i) => i === 0
    || new Date(expList[i - 1].current_period_end).getTime() <= new Date(x.current_period_end).getTime());
  sorted ? ok('expiring_soon sắp theo hạn tăng dần (sắp hết trước)') : bad('expiring_soon sai thứ tự');

  // Đếm theo trạng thái khớp DB; churn là số (proxy — không có cancelled_at).
  const dbActive = await owner.query(
    `SELECT COUNT(*)::int AS n FROM subscriptions s JOIN shops sh ON sh.id = s.shop_id
      WHERE s.status = 'active' AND sh.deleted_at IS NULL`,
  );
  mtr.shops_by_sub_status?.active === dbActive.rows[0].n
    ? ok(`shops_by_sub_status.active = ${dbActive.rows[0].n} khớp DB`)
    : bad('đếm active lệch', `api=${mtr.shops_by_sub_status?.active} db=${dbActive.rows[0].n}`);
  // 0072: churn_90d = mốc huỷ THẬT (cancelled_at); legacy_estimate = dòng huỷ
  // trước 0072 (NULL) vẫn ước lượng; cờ is_estimate CHỈ true khi còn phần legacy.
  Number.isInteger(mtr.churn_90d) && Number.isInteger(mtr.churn_90d_legacy_estimate)
    && mtr.churn_90d_is_estimate === (mtr.churn_90d_legacy_estimate > 0)
    ? ok('churn_90d (thật) + legacy_estimate tách bạch, cờ is_estimate khớp legacy>0')
    : bad('churn_90d sai dạng', JSON.stringify({ churn: mtr.churn_90d, legacy: mtr.churn_90d_legacy_estimate, flag: mtr.churn_90d_is_estimate }));

  // Tổng đã thu ≥ tổng của shop test này (sổ toàn nền tảng bao trùm sổ 1 shop).
  Number(mtr.collected_total_vnd) >= Number(sum.rows[0].t)
    ? ok('collected_total_vnd bao trùm tổng đã thu của shop test')
    : bad('collected_total_vnd nhỏ hơn tổng 1 shop', `${mtr.collected_total_vnd} < ${sum.rows[0].t}`);

  // ── 5d. listShops: phân trang + tìm + lọc (?page/?q/?sub_status) ───────────
  sect('5d. listShops phân trang + tìm + lọc');
  r = await req(PLATFORM, 'GET', `/ops/shops?q=${slug}`, { cookie: staffCookie });
  r.status === 200 && r.json.shops.some((s) => s.id === shopId) && r.json.page === 1
    && Number.isInteger(r.json.total) && r.json.total >= 1 && r.json.page_size === 50
    ? ok(`?q=${slug} tìm thấy shop + meta {page,total,page_size}`) : bad('tìm theo slug lỗi', r.raw);
  r.json?.staff_role === 'admin'
    ? ok('list trả staff_role=admin (Console ẩn/hiện nút theo vai trò)') : bad('thiếu staff_role', r.raw);

  // Cờ "đã đăng sản phẩm chưa" + bộ lọc nhóm mắc kẹt. ĐỌC CỜ trên shops, KHÔNG đếm bảng
  // products: app_platform cố tình không có quyền ở đó (nguyên tắc #1 đầu file). Bản đầu tôi
  // viết NOT EXISTS(products) và chính bộ test này bắt ngay — permission denied.
  const shopsList = (await req(PLATFORM, 'GET', '/ops/shops', { cookie: staffCookie })).json?.shops ?? [];
  shopsList.length && 'first_product_at' in shopsList[0]
    ? ok('danh sách shop mang cờ first_product_at (không đụng bảng products)')
    : bad('thiếu cờ first_product_at', JSON.stringify(Object.keys(shopsList[0] ?? {})));
  const loc = await req(PLATFORM, 'GET', '/ops/shops?activity=noproduct', { cookie: staffCookie });
  loc.status === 200 && (loc.json?.shops ?? []).every((x) => x.first_product_at === null)
    ? ok('lọc activity=noproduct chỉ trả shop CHƯA đăng sản phẩm')
    : bad('bộ lọc chưa-có-SP lọt shop đang bán', String(loc.status));
  loc.json?.activity === 'noproduct' ? ok('payload trả lại activity để UI giữ bộ lọc') : bad('thiếu activity trong payload');
  r = await req(PLATFORM, 'GET', `/ops/shops?q=khong-ton-tai-${uniq()}`, { cookie: staffCookie });
  r.status === 200 && r.json.shops.length === 0 && r.json.total === 0 && r.json.has_more === false
    ? ok('?q không khớp → rỗng, total 0, has_more false') : bad('q không khớp vẫn ra shop', r.raw);
  r = await req(PLATFORM, 'GET', '/ops/shops?page=9999', { cookie: staffCookie });
  r.status === 200 && r.json.shops.length === 0 && r.json.has_more === false && r.json.page === 9999
    ? ok('?page=9999 → trang rỗng, has_more false') : bad('phân trang xa lỗi', r.raw);
  // Lọc sub_status kết hợp q: shop exp (trial) khớp, shop chính (active) không.
  r = await req(PLATFORM, 'GET', `/ops/shops?q=${expSlug}&sub_status=trial`, { cookie: staffCookie });
  const rActive = await req(PLATFORM, 'GET', `/ops/shops?q=${expSlug}&sub_status=active`, { cookie: staffCookie });
  r.status === 200 && r.json.total === 1 && r.json.shops[0]?.id === expShopId
    && rActive.json.total === 0
    ? ok('?sub_status=trial + q → đúng 1 shop trial; lọc active → 0') : bad('lọc sub_status lỗi', `${r.raw} / ${rActive.raw}`);

  // ── 5e. Terminate (offboard) + export + cancelled_at ───────────────────────
  sect('5e. Chấm dứt hợp đồng (terminate) + xuất dữ liệu (export)');
  // Re-step-up cho chắc (cửa sổ 5' — suite có thể chạy sát biên).
  await req(AUTH, 'POST', '/auth/step-up', { body: { password: 'a strong platform passphrase' }, cookie: staffCookie, origin: ORIGIN_AUTH });
  const termSlug = `term-${uniq()}`;
  r = await req(PLATFORM, 'POST', '/ops/shops', {
    body: { name: 'Shop sắp đóng', slug: termSlug, plan_code: 'platform' },
    cookie: staffCookie, origin: ORIGIN_OPS,
  });
  const termShopId = r.json?.id;
  termShopId ? ok('dựng shop để terminate') : bad('không dựng được shop terminate', r.raw);

  // Guard giai đoạn nguội: shop CHƯA suspended → 409 dù slug đúng.
  r = await req(PLATFORM, 'POST', `/ops/shops/${termShopId}/terminate`, {
    body: { confirm_slug: termSlug }, cookie: staffCookie, origin: ORIGIN_OPS,
  });
  r.status === 409 ? ok('terminate shop chưa suspended → 409 (buộc khoá trước)') : bad('đóng thẳng shop đang chạy', r.raw);

  await req(PLATFORM, 'POST', `/ops/shops/${termShopId}/suspend`, { cookie: staffCookie, origin: ORIGIN_OPS });
  // Suspended → storefront trả 503 (trang tạm ngưng) — mốc so sánh cho serving-stop.
  let sf = await storeGet(`${termSlug}.nentang.vn`);
  sf.status === 503 ? ok('storefront shop suspended → 503 (trang tạm ngưng)') : bad('storefront suspended sai', String(sf.status));

  // Typed confirmation: gõ sai slug → 422, shop VẪN suspended.
  r = await req(PLATFORM, 'POST', `/ops/shops/${termShopId}/terminate`, {
    body: { confirm_slug: 'go-sai-slug' }, cookie: staffCookie, origin: ORIGIN_OPS,
  });
  chk = await owner.query(`SELECT status, deleted_at FROM shops WHERE id = $1`, [termShopId]);
  r.status === 422 && chk.rows[0].status === 'suspended' && chk.rows[0].deleted_at === null
    ? ok('confirm_slug sai → 422, shop còn nguyên suspended') : bad('typed confirmation thủng', `${r.status}/${JSON.stringify(chk.rows)}`);

  // Export TRƯỚC khi đóng (nghĩa vụ Luật 91/2025): dữ liệu quản lý + ghi chú tenant.
  r = await req(PLATFORM, 'GET', `/ops/shops/${termShopId}/export`, { cookie: staffCookie });
  r.status === 200 && r.json.shop?.slug === termSlug && r.json.domains?.length >= 1
    && r.json.subscriptions?.length === 1 && typeof r.json.tenant_data_note === 'string'
    && r.json.truncated?.audit_logs === false
    ? ok('export shop → JSON đủ mục quản lý + tenant_data_note + cờ truncated') : bad('export lỗi', r.raw);
  // Export shop CHÍNH: có lời mời — và KHÔNG rò token_hash / verification_token.
  r = await req(PLATFORM, 'GET', `/ops/shops/${shopId}/export`, { cookie: staffCookie });
  r.status === 200 && r.json.invitations?.length >= 1
    && r.json.invitations.every((i) => !('token_hash' in i))
    && r.json.domains.every((d) => !('verification_token' in d))
    ? ok('export không rò token_hash lời mời / verification_token domain') : bad('export rò bí mật', r.raw);

  // Terminate đúng slug → 200; DB: terminated + deleted_at + sub cancelled + cancelled_at + audit.
  r = await req(PLATFORM, 'POST', `/ops/shops/${termShopId}/terminate`, {
    body: { confirm_slug: termSlug, reason: 'khách ngừng kinh doanh' }, cookie: staffCookie, origin: ORIGIN_OPS,
  });
  chk = await owner.query(`SELECT status, deleted_at FROM shops WHERE id = $1`, [termShopId]);
  const subChk = await owner.query(`SELECT status, cancelled_at FROM subscriptions WHERE shop_id = $1`, [termShopId]);
  const audChk = await owner.query(`SELECT 1 FROM audit_logs WHERE shop_id = $1 AND action = 'shop.terminated'`, [termShopId]);
  r.status === 200 && r.json.status === 'terminated' && chk.rows[0].status === 'terminated' && chk.rows[0].deleted_at
    ? ok('terminate đúng slug → shops.status=terminated + deleted_at set') : bad('terminate lỗi', `${r.raw}/${JSON.stringify(chk.rows)}`);
  subChk.rows[0]?.status === 'cancelled' && subChk.rows[0]?.cancelled_at
    ? ok('thuê bao → cancelled + cancelled_at set (0072)') : bad('sub sau terminate sai', JSON.stringify(subChk.rows));
  audChk.rowCount === 1 ? ok('audit shop.terminated đã ghi') : bad('thiếu audit terminate');

  // SERVING-STOP thật: storefront giờ 404 (RLS store_shop loại terminated/deleted).
  sf = await storeGet(`${termSlug}.nentang.vn`);
  sf.status === 404 ? ok('storefront shop terminated → 404 (ngừng phục vụ tự nhiên)') : bad('storefront terminated vẫn phục vụ', String(sf.status));

  // Shop đã đóng biến khỏi danh sách (deleted_at filter); terminate lần 2 → 404;
  // export VẪN chạy được (bằng chứng hậu đóng — cố ý không lọc deleted_at).
  r = await req(PLATFORM, 'GET', `/ops/shops?q=${termSlug}`, { cookie: staffCookie });
  const rT2 = await req(PLATFORM, 'POST', `/ops/shops/${termShopId}/terminate`, {
    body: { confirm_slug: termSlug }, cookie: staffCookie, origin: ORIGIN_OPS,
  });
  const rEx2 = await req(PLATFORM, 'GET', `/ops/shops/${termShopId}/export`, { cookie: staffCookie });
  r.json?.total === 0 && rT2.status === 404 && rEx2.status === 200 && rEx2.json.shop?.status === 'terminated'
    ? ok('shop đóng: biến khỏi list, terminate lần 2 → 404, export hậu đóng vẫn được')
    : bad('hậu terminate sai', `list=${r.json?.total} t2=${rT2.status} ex=${rEx2.status}`);

  // Metrics: sub vừa huỷ có cancelled_at → churn_90d (THẬT) ≥ 1.
  r = await req(PLATFORM, 'GET', '/ops/metrics', { cookie: staffCookie });
  r.json?.churn_90d >= 1 ? ok(`churn_90d (mốc thật) = ${r.json.churn_90d} ≥ 1 sau terminate`) : bad('churn_90d không nhặt sub vừa huỷ', JSON.stringify(r.json?.churn_90d));

  // Renew TÁI KÍCH HOẠT phải xoá cancelled_at (hết churn khi khách trả tiền lại).
  await owner.query(`UPDATE subscriptions SET status = 'cancelled', cancelled_at = now() WHERE shop_id = $1`, [expShopId]);
  r = await req(PLATFORM, 'POST', `/ops/shops/${expShopId}/subscription/renew`, {
    body: { months: 1 }, cookie: staffCookie, origin: ORIGIN_OPS,
  });
  chk = await owner.query(`SELECT status, cancelled_at FROM subscriptions WHERE shop_id = $1`, [expShopId]);
  r.status === 200 && chk.rows[0].status === 'active' && chk.rows[0].cancelled_at === null
    ? ok('renew sub đã huỷ → active + cancelled_at NULL (hết churn)') : bad('renew không xoá cancelled_at', JSON.stringify(chk.rows));

  // ── 5f. Ma trận vai trò: operator CHỈ đọc, admin mới ghi ───────────────────
  sect('5f. Vai trò operator vs admin (minRole)');
  const oper = await makeMfaUser('operator');
  oper.userId = await userIdOf(oper.email);
  await owner.query(`INSERT INTO platform_staff (user_id, role) VALUES ($1, 'operator')`, [oper.userId]);
  const operLogin = await fullLogin(oper.email, oper.password, oper.key, oper.usedCounter);
  operLogin.ok ? ok('operator (MFA) đăng nhập đầy đủ') : bad('operator đăng nhập lỗi');
  const operCookie = operLogin.cookie;

  r = await req(PLATFORM, 'GET', '/ops/shops', { cookie: operCookie });
  r.status === 200 && r.json.staff_role === 'operator'
    ? ok('operator GET /ops/shops → 200 + staff_role=operator') : bad('operator không đọc được list', r.raw);
  r = await req(PLATFORM, 'GET', '/ops/metrics', { cookie: operCookie });
  r.status === 200 ? ok('operator GET /ops/metrics → 200 (đọc OK)') : bad('operator không xem được metrics', r.raw);
  r = await req(PLATFORM, 'GET', `/ops/shops/${shopId}`, { cookie: operCookie });
  r.status === 200 && r.json.staff_role === 'operator'
    ? ok('operator GET chi tiết shop → 200') : bad('operator không xem được chi tiết', r.raw);

  // Route ghi/tiền/phá hoại → 403 'cần quyền admin nền tảng'. Với route stepUp:
  // lỗi phải là LỖI VAI TRÒ (không phải step_up_required) — gate vai trò đứng TRƯỚC.
  const adminOnly = [
    ['POST', '/ops/shops', { name: 'X', slug: `op-${uniq()}`, plan_code: 'platform' }],
    ['POST', `/ops/shops/${shopId}/invitations`, { email: 'x@y.vn', role: 'owner' }],
    ['POST', `/ops/shops/${shopId}/suspend`, {}],
    ['POST', `/ops/shops/${shopId}/restore`, {}],
    ['POST', `/ops/shops/${shopId}/subscription/renew`, { months: 1 }],
    ['POST', `/ops/shops/${shopId}/terminate`, { confirm_slug: slug }],
  ];
  let matrixOk = true;
  for (const [m, p, b] of adminOnly) {
    const rr2 = await req(PLATFORM, m, p, { body: b, cookie: operCookie, origin: ORIGIN_OPS });
    if (rr2.status !== 403 || rr2.json?.error !== 'cần quyền admin nền tảng' || rr2.json?.step_up_required) {
      matrixOk = false;
      bad(`operator ${m} ${p} không bị chặn đúng`, rr2.raw);
    }
  }
  if (matrixOk) ok('operator bị 403 "cần quyền admin nền tảng" trên CẢ 6 route ghi (trước cả step-up)');
  r = await req(PLATFORM, 'GET', `/ops/shops/${shopId}/export`, { cookie: operCookie });
  r.status === 403 && r.json?.error === 'cần quyền admin nền tảng'
    ? ok('operator GET export → 403 (dump sổ quản lý là admin-only)') : bad('operator export lọt', r.raw);
  // DB xác nhận không có hiệu ứng phụ: shop chính vẫn active.
  chk = await owner.query(`SELECT status FROM shops WHERE id = $1`, [shopId]);
  chk.rows[0].status === 'active' ? ok('shop chính vẫn active sau loạt gọi operator') : bad('operator gây hiệu ứng phụ', JSON.stringify(chk.rows));

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
