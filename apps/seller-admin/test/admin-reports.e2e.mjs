/**
 * E2E admin-web (BFF) — TRANG BÁO CÁO LỢI NHUẬN + Ô GIÁ VỐN qua form no-JS (0081).
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-reports.e2e.mjs
 *
 * Kiểm QUA BFF (form-encoded):
 *  1. Nhập giá vốn qua form biến thể (price + cost_vnd) → trang SP hiện "biên ~X%".
 *  2. Owner: nav có "Báo cáo"; GET /reports render P&L + KPI + chú giải chart + preset link
 *     mang from/to; badge độ phủ khi còn dòng thiếu cost + "(tạm tính)".
 *  3. order_manager: nav KHÔNG có "Báo cáo"; gõ tay URL → trang lỗi (403 seller).
 *  4. Xuất CSV: POST → interstitial mật khẩu (mang hidden type/from/to) → step-up →
 *     tải CSV text/csv + attachment. CSRF: POST thiếu Origin → 403.
 * Harness mirror admin-order-edit.
 */
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
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
  return { status: r.status, location: r.headers.get('location'), sc: r.headers.getSetCookie(), body: t, ct: r.headers.get('content-type'), cd: r.headers.get('content-disposition') };
}
function co(host, method, path, { body, cartToken, idemKey } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = { host, origin: `https://${host}` };
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (cartToken) headers['cookie'] = `__Host-cart=${cartToken}`;
    if (idemKey) headers['idempotency-key'] = idemKey;
    const req = http.request({ hostname: CO.hostname, port: CO.port, path, method, headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => {
        let j = null; try { j = b ? JSON.parse(b) : null; } catch {}
        let token = cartToken;
        for (const c of res.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) token = m[1]; }
        resolve({ status: res.statusCode, json: j, raw: b, cartToken: token });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;
const admLogin = async (email, password) => ck((await adm('POST', '/login', { origin: OADM, form: { email, password } })).sc);

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
  cookie = ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).sc) ?? cookie;
  return cookie;
}
async function makeShopOwner(staffCookie, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, slug, host: `${slug}.nentang.vn`, email, password, cookie: await login(email, password) };
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `arpt-${uniq()}`);
  // Sản phẩm 1 biến thể (fixture qua seller API, NHẬP COST sẽ qua BFF form để test parsing).
  const p = await rq(SELLER, 'POST', `/shops/${A.shopId}/products`, { body: { title: `SP Lãi ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: 100000, status: 'active', variants: [{ sku: `L-${uniq()}`, price_vnd: 100000 }] }, cookie: A.cookie, origin: OS });
  const pid = p.json.id;
  const vid = (await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${pid}`, { cookie: A.cookie })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${A.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: 30, reason: 'nhập' }, cookie: A.cookie, origin: OS });
  // Sản phẩm 2 KHÔNG cost (để badge độ phủ bật).
  const p2 = await rq(SELLER, 'POST', `/shops/${A.shopId}/products`, { body: { title: `SP Mù ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: 50000, status: 'active', variants: [{ sku: `M-${uniq()}`, price_vnd: 50000 }] }, cookie: A.cookie, origin: OS });
  const vid2 = (await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${p2.json.id}`, { cookie: A.cookie })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${A.shopId}/variants/${vid2}/inventory/adjust`, { body: { delta: 30, reason: 'nhập' }, cookie: A.cookie, origin: OS });
  const cookieA = await admLogin(A.email, A.password);
  cookieA ? ok('dựng shop + 2 SP (1 sẽ có cost, 1 không), đăng nhập BFF') : bad('không login BFF');
  const rbase = `/shops/${A.shopId}/reports`;

  sect('1. Nhập giá vốn qua form biến thể BFF → biên gợi ý');
  let r = await adm('POST', `/shops/${A.shopId}/products/${pid}/variants/${vid}/price`, {
    cookie: cookieA, origin: OADM,
    form: { price_vnd: '100000', compare_at_vnd: '', weight_gram: '', cost_vnd: '60000' },
  });
  r.status === 303 ? ok('POST price+cost_vnd → 303') : bad('lưu cost qua BFF lỗi', `${r.status} ${r.body.slice(0, 150)}`);
  r = await adm('GET', `/shops/${A.shopId}/products/${pid}`, { cookie: cookieA });
  // Ô giá vốn nằm trong BẢNG biến thể sửa-hàng-loạt (form bulkvars) nên tên trường là
  // cost_<variantId>, KHÔNG phải cost_vnd — cost_vnd chỉ là tên trường của endpoint POST
  // /variants/:id/price ở trên. Khẳng định đúng cái đang hiển thị: giá vốn ghi vào ĐỌC
  // LẠI ĐƯỢC trên trang (nếu không, chủ shop mở form thấy trống rồi lưu đè = mất giá vốn).
  r.body.includes(`name="cost_${vid}"`) && /value="60000"/.test(r.body) && r.body.includes('biên ~40%')
    ? ok('trang SP: ô Giá vốn=60.000 + "biên ~40%"') : bad('thiếu ô cost/biên', r.body.match(/name="cost_[^"]*"[^>]*/)?.[0] ?? 'không thấy ô cost');

  sect('2. Đặt 2 đơn paid (1 SP có cost, 1 không) → trang Báo cáo');
  const place = async (v, qty, phone) => {
    const cart = (await co(A.host, 'POST', '/cart/items', { body: { variant_id: v, qty } })).cartToken;
    const rr = await co(A.host, 'POST', '/checkout', { body: { customer: { name: 'K', phone }, address: { line: 'HN' }, payment_method: 'cod' }, cartToken: cart, idemKey: `k-${uniq()}` });
    return (await owner.query('SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2', [A.shopId, rr.json.order_number])).rows[0].id;
  };
  const o1 = await place(vid, 2, '0901111222');
  const o2 = await place(vid2, 1, '0901111333');
  await adm('POST', `/shops/${A.shopId}/orders/${o1}/mark-paid`, { cookie: cookieA, origin: OADM });
  await adm('POST', `/shops/${A.shopId}/orders/${o2}/mark-paid`, { cookie: cookieA, origin: OADM });
  r = await adm('GET', `/shops/${A.shopId}/overview`, { cookie: cookieA });
  r.body.includes('Báo cáo') && r.body.includes(`${rbase}`) ? ok('nav + link "Xem báo cáo" hiện với owner') : bad('thiếu nav Báo cáo', '');
  r = await adm('GET', rbase, { cookie: cookieA });
  const hasPnl = r.body.includes('Kết quả kinh doanh') && r.body.includes('LÃI GỘP') && r.body.includes('Doanh thu thuần');
  const hasLegend = r.body.includes('Doanh thu thuần') && r.body.includes('Lãi gộp');
  const hasCov = r.body.includes('Giá vốn mới phủ') && r.body.includes('(tạm tính)');
  const presetOk = /href="[^"]*\/reports\?from=\d{4}-\d{2}-\d{2}&amp;to=\d{4}-\d{2}-\d{2}"/.test(r.body) || /href="[^"]*\/reports\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}"/.test(r.body);
  r.status === 200 && hasPnl ? ok('trang Báo cáo 200 + khối P&L') : bad('P&L thiếu', `${r.status}`);
  hasLegend ? ok('chú giải chart bằng CHỮ (không chỉ màu)') : bad('thiếu chú giải');
  hasCov ? ok('badge độ phủ + "(tạm tính)" khi còn dòng thiếu cost') : bad('thiếu badge coverage');
  presetOk ? ok('preset link mang from/to tường minh') : bad('preset không mang tham số');
  r.body.includes('Lãi theo sản phẩm') && r.body.includes('—') ? ok('bảng SP: dòng thiếu cost hiện "—"') : bad('bảng SP sai');

  sect('3. order_manager: ẩn nav + gõ tay URL → trang lỗi');
  const em = `om-${uniq()}@shop.vn`, pw = 'member passphrase strong';
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: A.password }, cookie: A.cookie, origin: OA });
  await rq(SELLER, 'POST', `/shops/${A.shopId}/members/invite`, { body: { email: em, role: 'order_manager' }, cookie: A.cookie, origin: OS });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(em), password: pw }, origin: OA });
  const cookieOm = await admLogin(em, pw);
  r = await adm('GET', `/shops/${A.shopId}/orders`, { cookie: cookieOm });
  !r.body.includes(`href="${rbase}"`) ? ok('nav order_manager KHÔNG có "Báo cáo"') : bad('nav rò Báo cáo');
  r = await adm('GET', rbase, { cookie: cookieOm });
  r.status === 403 && /Chỉ chủ shop|quản trị viên/.test(r.body) ? ok('gõ tay /reports → 403 trang lỗi rõ ràng') : bad('order_manager lọt trang lãi', `${r.status}`);

  sect('4. Xuất CSV: step-up interstitial → tải file; CSRF');
  const cookieA2 = await admLogin(A.email, A.password); // session MỚI: chưa step-up
  r = await adm('POST', `${rbase}/export`, { cookie: cookieA2, origin: OADM, form: { type: 'pnl', from: '', to: '' } });
  const isInter = r.status === 200 && r.body.includes('Xác nhận mật khẩu') && r.body.includes('name="type" value="pnl"');
  isInter ? ok('POST export chưa step-up → interstitial mật khẩu mang hidden type') : bad('thiếu interstitial', `${r.status}`);
  r = await adm('POST', `${rbase}/export/step-up`, { cookie: cookieA2, origin: OADM, form: { password: A.password, type: 'pnl', from: '', to: '' } });
  (r.ct ?? '').includes('text/csv') && (r.cd ?? '').includes('attachment') && r.body.includes('bucket,orders_paid')
    ? ok('step-up đúng → tải CSV text/csv attachment + header cột') : bad('CSV qua BFF sai', `${r.status} ${r.ct} ${r.cd}`);
  r = await adm('POST', `${rbase}/export`, { cookie: cookieA2, form: { type: 'pnl' } }); // KHÔNG origin
  r.status === 403 ? ok('POST export thiếu Origin → 403 (CSRF)') : bad('CSRF lọt', r.status);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((err) => { console.error('admin reports e2e lỗi:', err); process.exit(2); });
