// E2E admin-web (BFF) + account + checkout — ĐIỂM THƯỞNG cấu hình + UI (0086 commit 4). Kiểm:
// nav "Điểm thưởng"; lưu cấu hình QUA step-up; báo cáo nợ; RBAC order_manager 403; trang
// /account/points (số dư + lịch sử); widget đổi điểm trên giỏ (khách đăng nhập thấy số dư).
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = 'http://auth:3020', PLATFORM = 'http://platform:3030', SELLER = 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const ACC = new URL(process.env.ACCOUNT_URL ?? 'http://account:3062');
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };
let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${String(d).slice(0, 220)}${X}`); };
const sect = (m) => console.log(`\n${B}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const N = (x) => (x == null ? null : Number(x));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };
async function rq(base, method, path, { body, cookie, origin } = {}) {
  const h = {}; if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin; if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
async function adm(method, path, { cookie, origin, form } = {}) {
  const h = {}; if (form !== undefined) h['content-type'] = 'application/x-www-form-urlencoded';
  if (origin) h.origin = origin; if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(ADMIN + path, { method, headers: h, redirect: 'manual', body: form !== undefined ? new URLSearchParams(form).toString() : undefined });
  return { status: r.status, location: r.headers.get('location'), body: await r.text(), sc: r.headers.getSetCookie() };
}
function acc(host, method, path, { form, cookie, origin } = {}) {
  return new Promise((resolve, reject) => {
    const data = form !== undefined ? new URLSearchParams(form).toString() : null;
    const headers = { host };
    if (data != null) { headers['content-type'] = 'application/x-www-form-urlencoded'; headers['content-length'] = Buffer.byteLength(data); }
    if (origin) headers.origin = origin; if (cookie) headers.cookie = `__Host-cust_session=${cookie}`;
    const req = http.request({ hostname: ACC.hostname, port: ACC.port, path, method, headers }, (rs) => {
      let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => { let tok = null; for (const c of rs.headers['set-cookie'] ?? []) { const m = /^__Host-cust_session=([^;]*)/.exec(c); if (m) tok = m[1]; } resolve({ status: rs.statusCode, body: b, setTok: tok }); });
    });
    req.on('error', reject); if (data != null) req.write(data); req.end();
  });
}
function co(host, method, path, { json, cartTok, custTok } = {}) {
  return new Promise((resolve, reject) => {
    const data = json !== undefined ? JSON.stringify(json) : null;
    const headers = { host, origin: `https://${host}`, accept: 'text/html' };
    if (data != null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const cks = []; if (cartTok) cks.push(`__Host-cart=${cartTok}`); if (custTok) cks.push(`__Host-cust_session=${custTok}`);
    if (cks.length) headers.cookie = cks.join('; ');
    const req = http.request({ hostname: CO.hostname, port: CO.port, path, method, headers }, (rs) => {
      let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch {} let tok = cartTok; for (const c of rs.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) tok = m[1]; } resolve({ status: rs.statusCode, json: j, body: b, cartTok: tok }); });
    });
    req.on('error', reject); if (data != null) req.write(data); req.end();
  });
}
const login = async (e, p) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email: e, password: p }, origin: OA })).sc);
const uidOf = async (e) => (await owner.query('SELECT id FROM users WHERE email=$1', [e])).rows[0]?.id ?? null;
const admLogin = async (email, password) => ck((await adm('POST', '/login', { origin: OADM, form: { email, password } })).sc);
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
async function makeShopOwner(staff) {
  const slug = `loya-${uniq()}`;
  const shopId = (await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO })).json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, host: `${slug}.nentang.vn`, email, password, cookie: await login(email, password) };
}
async function inviteRole(staff, shopId, role) {
  const email = `${role}-${uniq()}@shop.vn`, password = 'member strong passphrase x';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { email, password };
}
async function makeCustomer(host, shopId) {
  const email = `kh-${uniq()}@mail.vn`, pw = 'khach manh 2026 xyz';
  await acc(host, 'POST', '/account/register', { origin: `https://${host}`, form: { email, password: pw, full_name: 'KH' } });
  const lg = await acc(host, 'POST', '/account/login', { origin: `https://${host}`, form: { email, password: pw } });
  const id = (await owner.query(`SELECT id FROM customers WHERE shop_id=$1 AND lower(email)=lower($2)`, [shopId, email])).rows[0]?.id;
  return { custTok: lg.setTok, id };
}
const seedBalance = (shopId, cid, pts) => owner.query(
  `INSERT INTO loyalty_balances (shop_id, customer_id, balance_points) VALUES ($1,$2,$3) ON CONFLICT (shop_id,customer_id) DO UPDATE SET balance_points=$3`, [shopId, cid, pts]);
const seedLedger = (shopId, cid, kind, delta) => owner.query(
  `INSERT INTO loyalty_ledger (shop_id, customer_id, kind, delta, reason) VALUES ($1,$2,$3,$4,'seed')`, [shopId, cid, kind, delta]);

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff);
  const cookieA = await admLogin(A.email, A.password);
  const base = `/shops/${A.shopId}`;
  cookieA ? ok('dựng shop + đăng nhập BFF owner') : bad('không login BFF');

  sect('1. Nav + trang cấu hình (mặc định tắt)');
  let r = await adm('GET', `${base}/overview`, { cookie: cookieA });
  r.body.includes('/loyalty') && r.body.includes('Điểm thưởng') ? ok('nav có "Điểm thưởng"') : bad('nav thiếu', r.body.match(/Điểm thưởng/));
  r = await adm('GET', `${base}/loyalty`, { cookie: cookieA });
  r.status === 200 && r.body.includes('Bật chương trình') && r.body.includes('name="earn_points_per_1000"') ? ok('trang cấu hình render (form)') : bad('trang config lỗi', r.status);

  sect('2. Lưu cấu hình QUA step-up (chạm đường tiền)');
  r = await adm('POST', `${base}/loyalty`, { cookie: cookieA, origin: OADM, form: { enabled: '1', earn_points_per_1000: '2', redeem_vnd_per_point: '150', earn_vesting_days: '7', min_redeem_points: '0', max_redeem_pct: '40' } });
  r.status === 200 && r.body.includes('Xác nhận mật khẩu') ? ok('POST cấu hình → chặn step-up (interstitial)') : bad('không đòi step-up', `${r.status} ${r.body.slice(0, 120)}`);
  r = await adm('POST', `${base}/loyalty/step-up`, { cookie: cookieA, origin: OADM, form: { password: A.password, enabled: '1', earn_points_per_1000: '2', redeem_vnd_per_point: '150', earn_vesting_days: '7', min_redeem_points: '0', max_redeem_pct: '40' } });
  const cfg = (await owner.query(`SELECT enabled, earn_points_per_1000, redeem_vnd_per_point, max_redeem_pct FROM shop_loyalty_config WHERE shop_id=$1`, [A.shopId])).rows[0];
  r.status === 303 && cfg?.enabled === true && N(cfg.earn_points_per_1000) === 2 && N(cfg.redeem_vnd_per_point) === 150 && N(cfg.max_redeem_pct) === 40
    ? ok('step-up đúng MK → lưu (bật, 2đ/1000, 150đ/điểm, trần 40%)') : bad('lưu cấu hình sai', `${r.status} ${JSON.stringify(cfg)}`);
  r = await adm('POST', `${base}/loyalty/step-up`, { cookie: cookieA, origin: OADM, form: { password: 'sai-mat-khau', enabled: '1', earn_points_per_1000: '2', redeem_vnd_per_point: '150', earn_vesting_days: '7', min_redeem_points: '0', max_redeem_pct: '40' } });
  r.status === 401 && r.body.includes('Mật khẩu không đúng') ? ok('step-up SAI mật khẩu → 401') : bad('step-up sai không chặn', r.status);

  sect('3. Báo cáo nợ điểm (sau khi có khách có điểm)');
  const cust = await makeCustomer(A.host, A.shopId);
  await seedBalance(A.shopId, cust.id, 300);
  await seedLedger(A.shopId, cust.id, 'earn', 300);
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/reports/loyalty`, { cookie: A.cookie });
  r.status === 200 && N(r.json.outstanding_points) === 300 && N(r.json.liability_vnd) === 300 * 150 && N(r.json.members_with_points) === 1
    ? ok(`báo cáo: 300 điểm lưu hành = nợ ${300 * 150}đ, 1 khách`) : bad('báo cáo nợ sai', r.raw);
  r = await adm('GET', `${base}/loyalty`, { cookie: cookieA });
  r.body.includes('Nợ điểm hiện tại') && r.body.includes('300') ? ok('trang cấu hình hiện card báo cáo nợ') : bad('thiếu card báo cáo', r.body.slice(0, 100));

  sect('4. RBAC: order_manager KHÔNG vào được Điểm thưởng');
  const om = await inviteRole(staff, A.shopId, 'order_manager');
  const omc = await admLogin(om.email, om.password);
  r = await adm('GET', `${base}/overview`, { cookie: omc });
  !r.body.includes('/loyalty') ? ok('nav order_manager KHÔNG có Điểm thưởng') : bad('rò nav');
  r = await adm('GET', `${base}/loyalty`, { cookie: omc });
  r.status === 403 ? ok('order_manager GET /loyalty → 403') : bad('RBAC BFF sai', r.status);
  r = await rq(SELLER, 'PUT', `/shops/${A.shopId}/loyalty`, { cookie: await login(om.email, om.password), body: { enabled: false }, origin: OS });
  r.status === 403 ? ok('order_manager PUT /loyalty (seller API) → 403') : bad('seller RBAC sai', r.status);

  sect('5. Trang /account/points — số dư + lịch sử');
  const ap = await acc(A.host, 'GET', '/account/points', { cookie: cust.custTok });
  ap.status === 200 && ap.body.includes('300') && ap.body.includes('Lịch sử điểm') && ap.body.includes('Tích điểm')
    ? ok('/account/points: số dư 300 + lịch sử (Tích điểm)') : bad('account points lỗi', `${ap.status} ${ap.body.slice(0, 120)}`);
  const dash = await acc(A.host, 'GET', '/account', { cookie: cust.custTok });
  dash.body.includes('Điểm thưởng') && dash.body.includes('300') ? ok('dashboard có thẻ Điểm thưởng (300)') : bad('dashboard thiếu thẻ điểm');

  sect('6. Widget đổi điểm trên GIỎ (khách đăng nhập)');
  const p = await rq(SELLER, 'POST', `/shops/${A.shopId}/products`, { body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: 100000, status: 'active', variants: [{ sku: `K-${uniq()}`, price_vnd: 100000 }] }, cookie: A.cookie, origin: OS });
  const vid = (await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${p.json.id}`, { cookie: A.cookie })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${A.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: 50, reason: 'nhập' }, cookie: A.cookie, origin: OS });
  const cart = (await co(A.host, 'POST', '/cart/items', { json: { variant_id: vid, qty: 1 } })).cartTok;
  const cg = await co(A.host, 'GET', '/cart', { cartTok: cart, custTok: cust.custTok });
  cg.body.includes('Bạn có 300 điểm') && cg.body.includes('/cart/points') ? ok('giỏ (đăng nhập): widget "Bạn có 300 điểm" + form đổi') : bad('widget giỏ thiếu', cg.body.match(/điểm[^<]*/)?.[0] ?? cg.body.slice(0, 100));
  // Guest KHÔNG thấy widget.
  const cgGuest = await co(A.host, 'GET', '/cart', { cartTok: (await co(A.host, 'POST', '/cart/items', { json: { variant_id: vid, qty: 1 } })).cartTok });
  !cgGuest.body.includes('Bạn có') ? ok('giỏ (guest): KHÔNG hiện widget điểm') : bad('guest thấy widget điểm');

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
