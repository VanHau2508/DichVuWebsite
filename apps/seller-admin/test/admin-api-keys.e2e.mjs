/**
 * End-to-end TRANG "KẾT NỐI" (0120) qua admin BFF. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-api-keys.e2e.mjs
 *
 * Bài học từ lần trước (nút tải ảnh bìa blog "có mặt" nhưng CHƯA TỪNG chạy): test phải
 * BẤM nút, không phải kiểm nút tồn tại. Ở đây nghĩa là đi trọn đường người dùng —
 * mở trang → gửi form → qua màn xác nhận mật khẩu → nhận token → DÙNG token đó đẩy một
 * đơn thật vào → thấy đơn trong danh sách → thu hồi → đẩy lại thì bị chặn.
 *
 * Kiểm thêm: token chỉ hiện MỘT lần (tải lại trang là mất) · nguồn đơn trên form tạo đơn
 * tay ghi đúng vào đơn · cột + bộ lọc Nguồn trên danh sách · vai không đủ quyền không thấy.
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

async function rq(base, method, path, { body, cookie, origin, bearer } = {}) {
  const h = {};
  if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  if (bearer) h.authorization = `Bearer ${bearer}`;
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
  return { status: r.status, location: r.headers.get('location'), sc: r.headers.getSetCookie(), body: await r.text() };
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;

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
  const r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, slug, email, password, cookie: await login(email, password) };
}
async function setupProduct(shop, price, stock) {
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/products`, {
    body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `S-${uniq()}`, price_vnd: price }] }, cookie: shop.cookie, origin: OS });
  const detail = await rq(SELLER, 'GET', `/shops/${shop.shopId}/products/${r.json.id}`, { cookie: shop.cookie });
  const vid = detail.json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${shop.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: shop.cookie, origin: OS });
  return vid;
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `akey-${uniq()}`);
  const vid = await setupProduct(A, 120000, 30);
  const base = `/shops/${A.shopId}`;

  sect('1. Trang Kết nối mở được, có lối vào từ menu');
  let r = await adm('GET', `${base}/api-keys`, { cookie: A.cookie });
  r.status === 200 && r.body.includes('Kết nối phần mềm ngoài') ? ok('GET trang Kết nối 200') : bad(`trang Kết nối ${r.status}`, r.body.slice(0, 300));
  r.body.includes('/ingest/orders') ? ok('trang hiện địa chỉ nhận đơn') : bad('không thấy địa chỉ ingest trên trang');
  const home = await adm('GET', `${base}/orders`, { cookie: A.cookie });
  home.body.includes(`${base}/api-keys`) ? ok('menu trái có mục Kết nối') : bad('menu KHÔNG có lối vào trang Kết nối');

  sect('2. Bấm "Tạo khoá" — qua màn xác nhận mật khẩu rồi mới ra token');
  r = await adm('POST', `${base}/api-keys`, { cookie: A.cookie, origin: OADM, form: { name: 'Pancake' } });
  r.status === 200 && r.body.includes('Xác nhận mật khẩu') ? ok('chưa step-up → hiện màn xác nhận mật khẩu') : bad(`không chặn bằng step-up (${r.status})`, r.body.slice(0, 300));
  r.body.includes('value="Pancake"') ? ok('màn xác nhận GIỮ tên khoá đã gõ') : bad('mất tên khoá khi qua step-up');
  r = await adm('POST', `${base}/api-keys/step-up`, { cookie: A.cookie, origin: OADM, form: { name: 'Pancake', password: 'sai-mat-khau-roi' } });
  r.status === 401 ? ok('mật khẩu sai → 401, không tạo khoá') : bad(`mật khẩu sai vẫn qua (${r.status})`);
  r = await adm('POST', `${base}/api-keys/step-up`, { cookie: A.cookie, origin: OADM, form: { name: 'Pancake', password: A.password } });
  const tk = /(ntk_[A-Za-z0-9_-]{20,})/.exec(r.body);
  r.status === 200 && tk ? ok('mật khẩu đúng → trang hiện token đầy đủ') : bad('không thấy token sau step-up', r.body.slice(0, 400));
  const token = tk?.[1];
  r.body.includes('CHÉP NGAY BÂY GIỜ') ? ok('có cảnh báo token chỉ hiện một lần') : bad('thiếu cảnh báo chép token');

  sect('3. Tải lại trang — token BIẾN MẤT (không đọc lại được)');
  r = await adm('GET', `${base}/api-keys`, { cookie: A.cookie });
  !r.body.includes(token) ? ok('tải lại KHÔNG còn token') : bad('token vẫn đọc được sau khi tải lại trang!');
  r.body.includes('Pancake') ? ok('khoá vẫn trong danh sách (chỉ mất phần bí mật)') : bad('khoá biến mất khỏi danh sách');

  sect('4. DÙNG token thật — đẩy một đơn vào, đơn hiện trong admin');
  r = await rq(SELLER, 'POST', '/ingest/orders', {
    bearer: token,
    body: { lines: [{ variant_id: vid, qty: 2 }], customer: { name: 'Khách Chat FB', phone: '0987654321', address_line: '9 Trần Phú', province: 'Hà Nội' }, payment_method: 'cod', source: 'facebook', source_ref: 'https://m.me/shop-cua-ban', idempotency_key: `adm-${uniq()}` },
  });
  r.status === 201 ? ok(`token vừa tạo đẩy được đơn thật #${r.json.order_number}`) : bad('token mới KHÔNG đẩy được đơn', r.raw);
  const oid = r.json?.id;
  const list = await adm('GET', `${base}/orders`, { cookie: A.cookie });
  list.body.includes('Facebook') ? ok('danh sách đơn hiện nhãn nguồn "Facebook"') : bad('danh sách không hiện nguồn');
  const detail = await adm('GET', `${base}/orders/${oid}`, { cookie: A.cookie });
  detail.body.includes('Nguồn đơn') && detail.body.includes('m.me/shop-cua-ban')
    ? ok('chi tiết đơn hiện nguồn + link về hội thoại') : bad('chi tiết đơn thiếu nguồn/link', detail.body.slice(0, 300));
  const filt = await adm('GET', `${base}/orders?source=facebook`, { cookie: A.cookie });
  filt.status === 200 && filt.body.includes('Khách Chat FB') ? ok('?source=facebook lọc ra đơn đó') : bad('bộ lọc nguồn không ra kết quả');

  sect('5. Form tạo đơn tay — ô Nguồn ghi ĐÚNG vào đơn');
  const nw = await adm('GET', `${base}/orders/new`, { cookie: A.cookie });
  nw.body.includes('name="source"') && nw.body.includes('name="source_ref"')
    ? ok('form tạo đơn có ô Nguồn + Link hội thoại') : bad('form tạo đơn thiếu ô nguồn');
  const idem = `ui-${uniq()}`;
  const sub = await adm('POST', `${base}/orders/new`, { cookie: A.cookie, origin: OADM, form: {
    variant_id: vid, qty: '1', name: 'Khách Zalo', phone: '0911222333', address_line: '1 Nguyễn Trãi', province: 'Hà Nội',
    payment_method: 'cod', source: 'zalo', source_ref: '0911222333', idem,
  } });
  const newId = /\/orders\/([0-9a-f-]{36})/.exec(sub.location ?? '')?.[1];
  const srow = newId ? (await owner.query('SELECT source, source_ref FROM orders WHERE id=$1', [newId])).rows[0] : null;
  srow?.source === 'zalo' && srow.source_ref === '0911222333'
    ? ok('đơn gõ tay lưu source=zalo + source_ref') : bad('nguồn trên form KHÔNG vào đơn', `${sub.status} ${sub.location} ${JSON.stringify(srow)}`);

  sect('6. Thu hồi — phần mềm ngoài ngừng đẩy được ngay');
  const keyId = (await owner.query(`SELECT id FROM shop_api_keys WHERE shop_id=$1 AND name='Pancake'`, [A.shopId])).rows[0].id;
  r = await adm('POST', `${base}/api-keys/${keyId}/revoke`, { cookie: A.cookie, origin: OADM });
  r.status === 200 && r.body.includes('Đã thu hồi') ? ok('bấm Thu hồi → trang báo đã thu hồi') : bad(`thu hồi lỗi (${r.status})`, r.body.slice(0, 300));
  const after = await rq(SELLER, 'POST', '/ingest/orders', {
    bearer: token,
    body: { lines: [{ variant_id: vid, qty: 1 }], customer: { name: 'X', phone: '0900000000' }, payment_method: 'cod', idempotency_key: `dead-${uniq()}` },
  });
  after.status === 401 ? ok('token đã thu hồi → 401') : bad(`token thu hồi VẪN đẩy được đơn (${after.status})!`, after.raw);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
