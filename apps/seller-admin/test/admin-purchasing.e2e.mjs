/**
 * E2E admin-web (BFF) — NHẬP HÀNG (0085): NCC + phiếu nhập + nhận hàng + kiểm kê qua form no-JS.
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-purchasing.e2e.mjs
 *
 * Kiểm QUA BFF (form-encoded):
 *  1. Owner: nav có "Nhập hàng" + "Kiểm kê"; tạo NCC qua form → hiện trong danh sách.
 *  2. Tạo phiếu nhập (supplier + slot variant/qty/giá) → 303 → chi tiết; nhận hàng qua trang
 *     xác nhận → tồn tăng + giá vốn cập nhật (kiểm DB).
 *  3. Kiểm kê scope=all → đếm 1 dòng lệch → chốt → tồn điều chỉnh + ledger 'adjust' (kiểm DB).
 *  4. order_manager: nav KHÔNG có "Nhập hàng"; gõ tay URL → 403 trang lỗi.
 *  5. CSRF: POST thiếu Origin → 403.
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
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };
let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${String(d).slice(0, 200)}${X}`); };
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
  const t = await r.text();
  return { status: r.status, location: r.headers.get('location'), sc: r.headers.getSetCookie(), body: t };
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;
const admLogin = async (email, password) => ck((await adm('POST', '/login', { origin: OADM, form: { email, password } })).sc);
const onHandOf = async (shopId, vid) => N((await owner.query(`SELECT on_hand FROM inventory_levels WHERE shop_id=$1 AND variant_id=$2`, [shopId, vid])).rows[0]?.on_hand ?? 0);
const costOf = async (shopId, vid) => N((await owner.query(`SELECT cost_vnd FROM variant_costs WHERE shop_id=$1 AND variant_id=$2`, [shopId, vid])).rows[0]?.cost_vnd);

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
async function makeShopOwner(staffCookie) {
  const slug = `apo-${uniq()}`;
  const shopId = (await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO })).json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, email, password, cookie: await login(email, password) };
}
async function inviteRole(staffCookie, shopId, role) {
  const email = `${role}-${uniq()}@shop.vn`, password = 'member strong passphrase x';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { email, password };
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff);
  const base = `/shops/${A.shopId}`;
  // 1 SP active có tồn ban đầu.
  const p = await rq(SELLER, 'POST', `${base}/products`, { body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: 100000, status: 'active', variants: [{ sku: `K-${uniq()}`, price_vnd: 100000 }] }, cookie: A.cookie, origin: OS });
  const vid = (await rq(SELLER, 'GET', `${base}/products/${p.json.id}`, { cookie: A.cookie })).json.variants[0].id;
  await rq(SELLER, 'POST', `${base}/variants/${vid}/inventory/adjust`, { body: { delta: 5, reason: 'ban đầu' }, cookie: A.cookie, origin: OS });
  const cookieA = await admLogin(A.email, A.password);
  cookieA ? ok('dựng shop + SP (tồn 5), đăng nhập BFF owner') : bad('không login BFF');

  sect('1. Nav + tạo nhà cung cấp qua form');
  let r = await adm('GET', `${base}/overview`, { cookie: cookieA });
  r.body.includes('/purchasing') && r.body.includes('Nhập hàng') && r.body.includes('/stocktakes') && r.body.includes('Kiểm kê')
    ? ok('nav owner có "Nhập hàng" + "Kiểm kê"') : bad('nav thiếu mục Kho', r.body.match(/Nhập hàng|Kiểm kê/g));
  r = await adm('POST', `${base}/suppliers`, { cookie: cookieA, origin: OADM, form: { name: 'Xưởng Bắc', phone: '0900222333', contact: 'A. Ba', email: 'bac@ncc.vn', address: '', note: '' } });
  r.status === 303 ? ok('POST tạo NCC → 303') : bad('tạo NCC lỗi', `${r.status} ${r.body.slice(0, 150)}`);
  r = await adm('GET', `${base}/suppliers`, { cookie: cookieA });
  const supId = (await owner.query(`SELECT id FROM suppliers WHERE shop_id=$1 AND name='Xưởng Bắc'`, [A.shopId])).rows[0]?.id;
  r.body.includes('Xưởng Bắc') && supId ? ok('NCC "Xưởng Bắc" hiện trong danh sách') : bad('NCC không hiện', r.body.slice(0, 150));

  sect('2. Tạo phiếu nhập qua form → chi tiết → nhận hàng → tồn + giá vốn cập nhật');
  // Form nhiều slot: variant_id[]/qty[]/unit_cost[] song song (mảng cặp cho URLSearchParams).
  r = await adm('POST', `${base}/purchasing/new`, { cookie: cookieA, origin: OADM, form: [
    ['supplier_id', supId], ['note', 'lô đầu'], ['picker_q', ''],
    ['variant_id', vid], ['qty', '10'], ['unit_cost', '50000'],
    ['variant_id', ''], ['qty', ''], ['unit_cost', ''],
  ] });
  const poLoc = r.location ?? '';
  r.status === 303 && /\/purchasing\/[0-9a-f-]{36}$/.test(poLoc) ? ok('tạo phiếu → 303 chi tiết') : bad('tạo phiếu lỗi', `${r.status} ${poLoc} ${r.body.slice(0, 150)}`);
  const poId = poLoc.split('/').pop();
  r = await adm('GET', poLoc, { cookie: cookieA });
  r.body.includes('Nháp') && r.body.includes('Nhận hàng') && r.body.includes('50.000') ? ok('chi tiết phiếu: badge Nháp + nút Nhận hàng + giá nhập') : bad('chi tiết phiếu thiếu', r.body.match(/Nháp|Nhận hàng/g));
  r = await adm('GET', `${poLoc}/receive`, { cookie: cookieA });
  r.body.includes('Xác nhận nhận hàng') && r.body.includes('không hoàn tác') ? ok('trang xác nhận nhận hàng (preview)') : bad('preview nhận hàng lỗi', r.body.slice(0, 150));
  const before = await onHandOf(A.shopId, vid);
  r = await adm('POST', `${poLoc}/receive`, { cookie: cookieA, origin: OADM, form: {} });
  const after = await onHandOf(A.shopId, vid), cost = await costOf(A.shopId, vid);
  r.status === 303 && after === before + 10 && cost === 50000
    ? ok(`nhận hàng → 303, tồn ${before}→${after}, giá vốn=50.000`) : bad('nhận hàng sai', `${r.status} ${before}→${after} cost=${cost}`);
  r = await adm('GET', poLoc, { cookie: cookieA });
  r.body.includes('Đã nhận') ? ok('chi tiết phiếu sau nhận: badge "Đã nhận"') : bad('badge sau nhận sai', r.body.match(/Đã nhận|Nháp/g));

  sect('3. Kiểm kê qua form: tạo scope=all → đếm lệch → chốt → tồn điều chỉnh + ledger adjust');
  r = await adm('POST', `${base}/stocktakes`, { cookie: cookieA, origin: OADM, form: { scope: 'all', note: 'kiểm kê BFF' } });
  const stLoc = r.location ?? '';
  r.status === 303 && /\/stocktakes\/[0-9a-f-]{36}$/.test(stLoc) ? ok('tạo phiên kiểm kê → 303') : bad('tạo kiểm kê lỗi', `${r.status} ${stLoc}`);
  r = await adm('GET', stLoc, { cookie: cookieA });
  r.body.includes('Số đếm thực tế') && r.body.includes('name="counted_qty"') ? ok('trang đếm: ô nhập số đếm') : bad('trang đếm lỗi', r.body.slice(0, 150));
  const onHandNow = await onHandOf(A.shopId, vid); // = 15 sau nhận
  r = await adm('POST', `${stLoc}/count`, { cookie: cookieA, origin: OADM, form: [['variant_id', vid], ['counted_qty', String(onHandNow - 1)]] });
  r.status === 303 ? ok(`ghi đếm vid = ${onHandNow - 1} (lệch -1) → 303`) : bad('ghi đếm lỗi', `${r.status} ${r.body.slice(0, 150)}`);
  r = await adm('POST', `${stLoc}/complete`, { cookie: cookieA, origin: OADM, form: {} });
  const afterCount = await onHandOf(A.shopId, vid);
  const adjRow = (await owner.query(`SELECT delta FROM inventory_ledger WHERE shop_id=$1 AND variant_id=$2 AND kind='adjust' AND reason LIKE 'Kiểm kê%' ORDER BY id DESC LIMIT 1`, [A.shopId, vid])).rows[0];
  r.status === 303 && afterCount === onHandNow - 1 && N(adjRow?.delta) === -1
    ? ok(`chốt → 303, tồn ${onHandNow}→${afterCount}, ledger adjust delta=-1`) : bad('chốt kiểm kê sai', `${r.status} tồn=${afterCount} delta=${adjRow?.delta}`);
  r = await adm('GET', stLoc, { cookie: cookieA });
  r.body.includes('Đã chốt') ? ok('phiên sau chốt: badge "Đã chốt"') : bad('badge kiểm kê sai', r.body.match(/Đã chốt|Đang đếm/g));

  sect('4. RBAC: order_manager không thấy nav Nhập hàng + gõ tay URL → 403');
  const om = await inviteRole(staff, A.shopId, 'order_manager');
  const cookieOm = await admLogin(om.email, om.password);
  r = await adm('GET', `${base}/overview`, { cookie: cookieOm });
  !r.body.includes('/purchasing') ? ok('nav order_manager KHÔNG có mục Nhập hàng') : bad('nav rò mục Kho cho order_manager');
  r = await adm('GET', `${base}/purchasing`, { cookie: cookieOm });
  r.status === 403 && r.body.includes('bí mật kinh doanh') ? ok('order_manager GET /purchasing → 403 trang lỗi') : bad('RBAC BFF sai', `${r.status}`);

  sect('5. CSRF: POST thiếu Origin → 403');
  r = await adm('POST', `${base}/suppliers`, { cookie: cookieA, form: { name: 'X' } }); // không origin
  r.status === 403 ? ok('POST NCC thiếu Origin → 403') : bad('CSRF không chặn', r.status);

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
