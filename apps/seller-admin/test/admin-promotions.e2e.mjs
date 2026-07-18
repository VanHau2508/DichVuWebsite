/**
 * E2E admin-web (BFF) — FLASH SALE qua form no-JS (0082).
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-promotions.e2e.mjs
 *
 * Kiểm QUA BFF (form-encoded):
 *  1. Nav: "Flash sale" + "Mã giảm giá" (coupon đổi nhãn).
 *  2. Tạo scope=all → 303 danh sách + chương trình hiện (ưu đãi/phạm vi/trạng thái).
 *  3. Tạo scope=products → 303 sang trang CHI TIẾT; tìm SP (?q=) → Thêm → hiện trong list; Gỡ.
 *  4. Kết thúc sớm (POST /end) → "Đã tắt"; Xoá.
 *  5. CSRF POST tạo thiếu Origin → 403.
 *  6. order_manager: nav KHÔNG có Flash sale; GET /promotions → trang lỗi.
 * Harness mirror admin-reports.
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
  const t = await r.text();
  return { status: r.status, location: r.headers.get('location'), body: t };
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
  return ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).sc) ?? cookie;
}
async function makeShopOwner(staffCookie, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, email, password, cookie: await login(email, password) };
}
// datetime-local giờ VN (tương lai).
const dtl = (daysFromNow, hour) => { const d = new Date(Date.now() + daysFromNow * 86400e3); const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {}); return `${p.year}-${p.month}-${p.day}T${String(hour).padStart(2, '0')}:00`; };

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `apromo-${uniq()}`);
  const prod = await rq(SELLER, 'POST', `/shops/${A.shopId}/products`, { body: { title: `Áo Sale ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: 200000, status: 'active', variants: [{ sku: `PS-${uniq()}`, price_vnd: 200000 }] }, cookie: A.cookie, origin: OS });
  const cookieA = A.cookie; // phiên owner trực tiếp (admin forward __Host-session sang auth)
  cookieA ? ok('dựng shop + SP, phiên owner') : bad('không có phiên owner');
  const base = `/shops/${A.shopId}`;

  sect('1. Nav: Flash sale + Mã giảm giá');
  let r = await adm('GET', `${base}/products`, { cookie: cookieA });
  r.body.includes('Flash sale') && r.body.includes('Mã giảm giá') && r.body.includes(`${base}/promotions`)
    ? ok('nav có "Flash sale" + "Mã giảm giá" (coupon đổi nhãn)') : bad('nav thiếu mục', '');


  sect('2. Tạo promo scope=all → danh sách');
  r = await adm('POST', `${base}/promotions`, { cookie: cookieA, origin: OADM, form: { title: 'Sale cuối tuần', kind: 'percent', value: '20', scope: 'all', starts_at: dtl(0, 8), ends_at: dtl(2, 22) } });
  const created = (r.status === 200 && r.body.includes('Sale cuối tuần')) || r.status === 303;
  created ? ok('tạo scope=all → hiện danh sách') : bad('tạo all lỗi', `${r.status} ${r.body.slice(0, 150)}`);
  r = await adm('GET', `${base}/promotions`, { cookie: cookieA });
  r.body.includes('Sale cuối tuần') && r.body.includes('-20%') && r.body.includes('Toàn shop')
    ? ok('danh sách: tên + "-20%" + "Toàn shop" + trạng thái') : bad('danh sách sai', r.body.match(/Sale cuối tuần[\s\S]{0,200}/)?.[0]);

  sect('3. Tạo scope=products → chi tiết + picker + thêm/gỡ SP');
  r = await adm('POST', `${base}/promotions`, { cookie: cookieA, origin: OADM, form: { title: 'Flash SP', kind: 'percent', value: '30', scope: 'products', starts_at: dtl(0, 8), ends_at: dtl(1, 22) } });
  r.status === 303 && /\/promotions\/[0-9a-f-]{36}$/.test(r.location ?? '') ? ok('tạo scope=products → 303 sang trang chi tiết') : bad('không sang chi tiết', `${r.status} ${r.location}`);
  const detailPath = r.location.replace(ADMIN, '');
  const pid = detailPath.split('/').pop();
  r = await adm('GET', `${detailPath}?q=Áo Sale`, { cookie: cookieA });
  r.status === 200 && r.body.includes('Thêm') && r.body.includes('/products"')
    ? ok('chi tiết: tìm SP hiện nút "Thêm"') : bad('picker không hiện SP', r.body.match(/Thêm sản phẩm[\s\S]{0,300}/)?.[0]);
  r = await adm('POST', `${base}/promotions/${pid}/products`, { cookie: cookieA, origin: OADM, form: { product_id: prod.json.id } });
  r.status === 303 ? ok('POST thêm SP → 303') : bad('thêm SP lỗi', `${r.status} ${r.body.slice(0, 150)}`);
  r = await adm('GET', detailPath, { cookie: cookieA });
  r.body.includes('Áo Sale') && r.body.includes('/remove') ? ok('chi tiết: SP đã thêm + nút Gỡ') : bad('SP không vào list', '');
  const dbCount = Number((await owner.query(`SELECT count(*)::int n FROM promotion_products WHERE promotion_id=$1`, [pid])).rows[0].n);
  dbCount === 1 ? ok('DB: 1 dòng promotion_products') : bad('DB promotion_products sai', dbCount);
  r = await adm('POST', `${base}/promotions/${pid}/products/${prod.json.id}/remove`, { cookie: cookieA, origin: OADM });
  const dbCount2 = Number((await owner.query(`SELECT count(*)::int n FROM promotion_products WHERE promotion_id=$1`, [pid])).rows[0].n);
  r.status === 303 && dbCount2 === 0 ? ok('Gỡ SP → 303, DB 0 dòng') : bad('gỡ SP lỗi', `${r.status} db=${dbCount2}`);

  sect('4. Kết thúc sớm + xoá');
  r = await adm('POST', `${base}/promotions/${pid}/end`, { cookie: cookieA, origin: OADM });
  const act = (await owner.query(`SELECT active FROM promotions WHERE id=$1`, [pid])).rows[0].active;
  r.status === 303 && act === false ? ok('kết thúc sớm → 303, DB active=false') : bad('end lỗi', `${r.status} act=${act}`);
  r = await adm('GET', `${base}/promotions`, { cookie: cookieA });
  r.body.includes('Đã tắt') ? ok('danh sách hiện "Đã tắt"') : bad('không hiện trạng thái tắt', '');
  r = await adm('POST', `${base}/promotions/${pid}/delete`, { cookie: cookieA, origin: OADM });
  r.status === 303 && Number((await owner.query(`SELECT count(*)::int n FROM promotions WHERE id=$1`, [pid])).rows[0].n) === 0
    ? ok('xoá → 303, DB sạch') : bad('xoá lỗi', r.status);

  sect('5. CSRF + RBAC');
  r = await adm('POST', `${base}/promotions`, { cookie: cookieA, form: { title: 'x', kind: 'percent', value: '10', scope: 'all', starts_at: dtl(0, 8), ends_at: dtl(1, 8) } });
  r.status === 403 ? ok('POST tạo thiếu Origin → 403 (CSRF)') : bad('CSRF lọt', r.status);
  const em = `om-${uniq()}@shop.vn`, pw = 'member passphrase strong';
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: A.password }, cookie: A.cookie, origin: OA });
  await rq(SELLER, 'POST', `/shops/${A.shopId}/members/invite`, { body: { email: em, role: 'order_manager' }, cookie: A.cookie, origin: OS });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(em), password: pw }, origin: OA });
  const cookieOm = await login(em, pw);
  r = await adm('GET', `${base}/orders`, { cookie: cookieOm });
  !r.body.includes(`${base}/promotions"`) ? ok('nav order_manager KHÔNG có Flash sale') : bad('nav rò Flash sale');
  r = await adm('GET', `${base}/promotions`, { cookie: cookieOm });
  r.status === 403 && /Chỉ chủ shop|quản trị|nhân viên sản phẩm/.test(r.body) ? ok('order_manager GET /promotions → 403 trang lỗi') : bad('order_manager lọt', r.status);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((err) => { console.error('admin promotions e2e lỗi:', err); process.exit(2); });
