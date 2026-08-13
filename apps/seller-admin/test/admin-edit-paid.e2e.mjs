// E2E UI: SỬA ĐƠN ĐÃ TRẢ (v2) xuyên BFF seller-admin. Kiểm: nút hiện trên đơn paid,
// GET form chế độ paid có cảnh báo hoàn, POST chưa step-up → interstitial mật khẩu (giữ
// dữ liệu), step-up → GIẢM sinh HOÀN + banner, TĂNG → lỗi giữ form, đơn chưa trả → từ chối.
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest', OADM = 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 5 });
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
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
// ADMIN form client (urlencoded; form = MẢNG cặp [k,v] cho khoá trùng variant_id/qty).
async function adm(method, path, { cookie, origin, form } = {}) {
  const h = {}; if (form !== undefined) h['content-type'] = 'application/x-www-form-urlencoded';
  if (origin) h.origin = origin; if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(ADMIN + path, { method, headers: h, redirect: 'manual', body: form !== undefined ? new URLSearchParams(form).toString() : undefined });
  const t = await r.text();
  return { status: r.status, location: r.headers.get('location'), sc: r.headers.getSetCookie(), body: t };
}
function co(host, method, path, { body, cartToken, idemKey } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = { host, origin: `https://${host}` };
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (cartToken) headers['cookie'] = `__Host-cart=${cartToken}`;
    if (idemKey) headers['idempotency-key'] = idemKey;
    const req = http.request({ hostname: CO.hostname, port: CO.port, path, method, headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch {} let tok = cartToken; for (const c of res.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) tok = m[1]; } resolve({ status: res.statusCode, json: j, raw: b, cartToken: tok }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const login = async (e, p) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email: e, password: p }, origin: OA })).sc);
const admLogin = async (e, p) => ck((await adm('POST', '/login', { origin: OADM, form: { email: e, password: p } })).sc);
const uidOf = async (e) => (await owner.query('SELECT id FROM users WHERE email=$1', [e])).rows[0]?.id ?? null;
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
async function makeShopOwner(staff, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
  const shopId = r.json.id;
  await owner.query(`UPDATE shops SET status='active', went_live_at=now() WHERE id=$1`, [shopId]);
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, host: `${slug}.nentang.vn`, email, password, cookie: await login(email, password) };
}
async function setupProduct(shop, price, stock) {
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/products`, { body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `S-${uniq()}`, price_vnd: price }] }, cookie: shop.cookie, origin: OS });
  const vid = (await rq(SELLER, 'GET', `/shops/${shop.shopId}/products/${r.json.id}`, { cookie: shop.cookie })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${shop.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: shop.cookie, origin: OS });
  return vid;
}
async function placePaidOrder(shop, vid, qty) {
  const cart = (await co(shop.host, 'POST', '/cart/items', { body: { variant_id: vid, qty } })).cartToken;
  const r = await co(shop.host, 'POST', '/checkout', { body: { customer: { name: 'Khách', phone: '0901234567' }, address: { line: 'HN', province: 'Hà Nội' }, payment_method: 'cod' }, cartToken: cart, idemKey: `k-${uniq()}` });
  const id = (await owner.query('SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2', [shop.shopId, r.json.order_number]).then((x) => x.rows[0].id));
  await owner.query(`UPDATE orders SET payment_status='paid', paid_at=now(), status='confirmed' WHERE id=$1`, [id]);
  return id;
}
const N = (x) => Number(x);
const totalOf = async (id) => N((await owner.query('SELECT total_vnd FROM orders WHERE id=$1', [id])).rows[0].total_vnd);
const refundsOf = async (id) => N((await owner.query(`SELECT coalesce(sum(amount_vnd),0)::bigint s FROM refunds WHERE order_id=$1`, [id])).rows[0].s);

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `epui-${uniq()}`);
  const vid = await setupProduct(A, 100000, 20);
  const cookieA = await admLogin(A.email, A.password);
  const id = await placePaidOrder(A, vid, 5); // 5×100k + ship 30k = 530k, ép paid
  const base = `/shops/${A.shopId}/orders/${id}`;
  const custForm = [['name', 'Khách'], ['phone', '0901234567'], ['email', ''], ['address_line', 'HN'], ['province', 'Hà Nội'], ['ship_fee_vnd', ''], ['note', '']];

  sect('Nút "Sửa đơn đã trả" HIỆN trên trang chi tiết đơn paid');
  let r = await adm('GET', base, { cookie: cookieA });
  r.status === 200 && /Sửa đơn đã trả/.test(r.body) && new RegExp(`${base}/edit-paid`).test(r.body) ? ok('chi tiết đơn paid có nút "Sửa đơn đã trả"') : bad('không thấy nút', r.status);

  sect('GET trang sửa chế độ paid có cảnh báo hoàn + action /edit-paid');
  r = await adm('GET', `${base}/edit-paid`, { cookie: cookieA });
  r.status === 200 && /Đơn đã thanh toán/.test(r.body) && /tự tạo <strong>phiếu hoàn/.test(r.body) && new RegExp(`action="${base}/edit-paid"`).test(r.body) ? ok('form paid: cảnh báo hoàn + action đúng') : bad('form paid sai', r.status);

  sect('POST sửa (giảm 5→3) CHƯA step-up → interstitial mật khẩu GIỮ dữ liệu');
  r = await adm('POST', `${base}/edit-paid`, { cookie: cookieA, origin: OADM, form: [['variant_id', vid], ['qty', '3'], ...custForm] });
  const keptData = r.body.includes('Xác nhận mật khẩu') && new RegExp(`value="${vid}"`).test(r.body) && /name="qty" value="3"/.test(r.body);
  r.status === 200 && keptData && await totalOf(id) === 530000 ? ok('chưa step-up → interstitial giữ dòng (qty=3, vid), chưa đụng đơn') : bad('interstitial sai/đã đổi đơn', `st=${r.status} kept=${keptData} tot=${await totalOf(id)}`);

  sect('POST step-up SAI mật khẩu → 401 + form lại');
  r = await adm('POST', `${base}/edit-paid/step-up`, { cookie: cookieA, origin: OADM, form: [['variant_id', vid], ['qty', '3'], ...custForm, ['password', 'sai roi']] });
  r.status === 401 && /Mật khẩu không đúng/.test(r.body) ? ok('sai mật khẩu → 401 + interstitial lại') : bad('sai mật khẩu lọt', r.status);

  sect('POST step-up ĐÚNG → GIẢM chạy: hoàn 200k, redirect banner có refund');
  const rvBefore = await refundsOf(id);
  r = await adm('POST', `${base}/edit-paid/step-up`, { cookie: cookieA, origin: OADM, form: [['variant_id', vid], ['qty', '3'], ...custForm, ['password', A.password]] });
  const loc = r.location ?? '';
  r.status === 303 && /edited=1/.test(loc) && /refund=200000/.test(loc) && await totalOf(id) === 330000 && await refundsOf(id) - rvBefore === 200000
    ? ok('step-up đúng → giảm 5→3, total 330k, hoàn 200k, redirect ?edited=1&refund=200000') : bad('giảm qua UI sai', `st=${r.status} loc=${loc} tot=${await totalOf(id)} rv+=${await refundsOf(id) - rvBefore}`);

  sect('Banner chi tiết đơn hiện số hoàn');
  r = await adm('GET', `${base}?edited=1&refund=200000`, { cookie: cookieA });
  /phiếu hoàn/.test(r.body) && /200\.000/.test(r.body) ? ok('banner "Đã tạo phiếu hoàn 200.000₫"') : bad('banner thiếu số hoàn', '');

  sect('TĂNG tổng đơn đã trả → lỗi giữ form (không đổi đơn)');
  // đã step-up gần đây (còn cửa sổ) → submit đi thẳng doEditPaid → seller 409
  r = await adm('POST', `${base}/edit-paid`, { cookie: cookieA, origin: OADM, form: [['variant_id', vid], ['qty', '9'], ...custForm] });
  r.status === 400 && /(thiếu|tăng tổng)/.test(r.body) && /value="9"/.test(r.body) && await totalOf(id) === 330000
    ? ok('tăng → 400 giữ form (qty=9), đơn KHÔNG đổi') : bad('tăng qua UI sai', `st=${r.status} textOK=${/(thiếu|tăng tổng)/.test(r.body)} q9=${/value="9"/.test(r.body)} tot=${await totalOf(id)}`);

  sect('Đơn CHƯA trả → nút edit-paid không có + GET /edit-paid từ chối');
  const cart2 = (await co(A.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 1 } })).cartToken;
  await co(A.host, 'POST', '/checkout', { body: { customer: { name: 'U', phone: '0901239999' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' }, cartToken: cart2, idemKey: `u-${uniq()}` });
  const unpaidId = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 AND customer_phone='0901239999' ORDER BY created_at DESC LIMIT 1`, [A.shopId])).rows[0].id;
  const gd = await adm('GET', `/shops/${A.shopId}/orders/${unpaidId}`, { cookie: cookieA });
  const gep = await adm('GET', `/shops/${A.shopId}/orders/${unpaidId}/edit-paid`, { cookie: cookieA });
  !/Sửa đơn đã trả/.test(gd.body) && /chưa thanh toán/.test(gep.body) ? ok('đơn chưa trả: không nút + GET /edit-paid → về chi tiết kèm lý do') : bad('đơn chưa trả xử sai', `nút=${/Sửa đơn đã trả/.test(gd.body)} ep=${gep.status}`);

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
