// E2E UI: NHẬN TRẢ HÀNG (RMA 0078) xuyên BFF seller-admin. Kiểm: nút "Nhận trả hàng" HIỆN
// trên đơn ĐÃ GIAO, GET form liệt kê dòng (đã mua/đã trả + action), POST trả 1 CHƯA step-up →
// interstitial mật khẩu GIỮ input, step-up SAI → 401 (giữ input), ĐÚNG → tạo phiếu trả + hoàn
// 100k + banner, chi tiết đơn hiện card "Lịch sử đổi-trả" + dòng "đã trả 1", đơn CHƯA giao KHÔNG
// có nút + GET /return từ chối. Mirror harness admin-edit-paid (adm() trả sc set-cookie).
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
// Đơn ĐÃ GIAO + đã trả COD (đủ điều kiện nhận trả hàng): checkout COD → confirm → ship → deliver
// → ép payment 'paid' (COD giao = thu tiền). Dùng cookie JSON của chủ shop cho seller API.
async function placeDeliveredOrder(shop, vid, qty, phone) {
  const cart = (await co(shop.host, 'POST', '/cart/items', { body: { variant_id: vid, qty } })).cartToken;
  const r = await co(shop.host, 'POST', '/checkout', { body: { customer: { name: 'Khách Giao', phone }, address: { line: 'HN', province: 'Hà Nội' }, payment_method: 'cod' }, cartToken: cart, idemKey: `d-${uniq()}` });
  if (!r.json?.order_number) throw new Error(`checkout did not create order: ${r.status} ${r.raw}`);
  const id = (await owner.query('SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2', [shop.shopId, r.json.order_number])).rows[0].id;
  await rq(SELLER, 'POST', `/shops/${shop.shopId}/orders/${id}/confirm`, { cookie: shop.cookie, origin: OS });
  await rq(SELLER, 'POST', `/shops/${shop.shopId}/orders/${id}/ship`, { body: { carrier: 'tay', tracking_number: 'T' + uniq() }, cookie: shop.cookie, origin: OS });
  await rq(SELLER, 'POST', `/shops/${shop.shopId}/orders/${id}/deliver`, { cookie: shop.cookie, origin: OS });
  await owner.query(`UPDATE orders SET payment_status='paid', paid_at=now() WHERE id=$1`, [id]);
  return id;
}
const N = (x) => Number(x);
const refundsOf = async (id) => N((await owner.query(`SELECT coalesce(sum(amount_vnd),0)::bigint s FROM refunds WHERE order_id=$1`, [id])).rows[0].s);
const refundCountOf = async (id) => N((await owner.query(`SELECT count(*)::int n FROM refunds WHERE order_id=$1`, [id])).rows[0].n);
const returnsCountOf = async (id) => N((await owner.query(`SELECT count(*)::int n FROM returns WHERE order_id=$1`, [id])).rows[0].n);
const stockOf = async (shopId, vid) => N((await owner.query(`SELECT on_hand FROM inventory_levels WHERE shop_id=$1 AND variant_id=$2`, [shopId, vid])).rows[0].on_hand);
const col = async (id, c) => (await owner.query(`SELECT ${c} FROM orders WHERE id=$1`, [id])).rows[0][c];

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `rmaui-${uniq()}`);
  const vid = await setupProduct(A, 100000, 20);
  const cookieA = await admLogin(A.email, A.password); // phiên BFF (chưa step-up)
  const id = await placeDeliveredOrder(A, vid, 3, '0901234567'); // 3×100k + ship 30k = 330k, delivered+paid
  const base = `/shops/${A.shopId}/orders/${id}`;
  const requestId = (await owner.query(
    `INSERT INTO order_requests (shop_id, order_id, request_type, requester_type, reason)
     VALUES ($1, $2, 'return', 'guest', 'Sản phẩm lỗi') RETURNING id`,
    [A.shopId, id],
  )).rows[0].id;
  const queueBase = `/shops/${A.shopId}/order-requests`;
  const retForm = [['request_id', requestId], ['variant_id', vid], ['qty', '1'], ['restock', 'on'], ['reason', 'khách đổi ý']];
  const stepForm = [['request_id', requestId], ['variant_id', vid], ['qty', '1'], ['restock', '1'], ['reason', 'khách đổi ý']];
  const stockBeforeReturn = await stockOf(A.shopId, vid);
  const ledgerBefore = N((await owner.query(`SELECT coalesce(max(id),0)::bigint id FROM inventory_ledger`)).rows[0].id);

  sect('Duyệt yêu cầu trả hàng → chuyển thẳng tới form RMA có request_id');
  let r = await adm('POST', `${queueBase}/${requestId}/approve`, {
    cookie: cookieA, origin: OADM, form: { order_id: id, note: 'Đã kiểm tra yêu cầu' },
  });
  const linkedReturnUrl = `${base}/return?request_id=${requestId}`;
  const approved = (await owner.query(`SELECT status FROM order_requests WHERE id=$1`, [requestId])).rows[0]?.status;
  r.status === 303 && r.location === linkedReturnUrl && approved === 'approved'
    ? ok('approve redirect đúng form có request_id; DB = approved')
    : bad('approve chưa nối sang RMA', `st=${r.status} loc=${r.location} db=${approved}`);

  sect('Nút "Nhận trả hàng" HIỆN trên trang chi tiết đơn ĐÃ GIAO');
  r = await adm('GET', base, { cookie: cookieA });
  r.status === 200 && /Nhận trả hàng/.test(r.body) && new RegExp(`${base}/return"`).test(r.body) ? ok('đơn delivered có nút "Nhận trả hàng" → /return') : bad('không thấy nút trả', r.status);

  sect('GET form trả liệt kê dòng hàng (đã mua) + action /return');
  r = await adm('GET', linkedReturnUrl, { cookie: cookieA });
  r.status === 200 && /Nhận trả hàng/.test(r.body) && /đã mua 3/.test(r.body) && new RegExp(`value="${vid}"`).test(r.body) && new RegExp(`action="${base}/return"`).test(r.body) && new RegExp(`name="request_id" value="${requestId}"`).test(r.body) ? ok('form trả giữ đúng hidden request_id') : bad('form trả sai/mất request_id', r.status);

  sect('POST trả 1 CHƯA step-up → interstitial mật khẩu GIỮ dữ liệu, chưa tạo phiếu hoàn');
  r = await adm('POST', `${base}/return`, { cookie: cookieA, origin: OADM, form: retForm });
  const kept = r.body.includes('Xác nhận mật khẩu') && new RegExp(`value="${vid}"`).test(r.body) && /name="qty" value="1"/.test(r.body) && new RegExp(`name="request_id" value="${requestId}"`).test(r.body);
  r.status === 200 && kept && await refundsOf(id) === 0 ? ok('chưa step-up → interstitial giữ dòng (qty=1, vid), chưa hoàn') : bad('interstitial sai/đã hoàn', `st=${r.status} kept=${kept} rv=${await refundsOf(id)}`);

  sect('POST step-up SAI mật khẩu → 401 + interstitial lại (giữ input)');
  r = await adm('POST', `${base}/return/step-up`, { cookie: cookieA, origin: OADM, form: [...stepForm, ['password', 'sai roi']] });
  r.status === 401 && /Mật khẩu không đúng/.test(r.body) && /name="qty" value="1"/.test(r.body) && new RegExp(`name="request_id" value="${requestId}"`).test(r.body) ? ok('sai mật khẩu → 401 + giữ input/request_id') : bad('sai mật khẩu lọt', r.status);

  sect('POST step-up ĐÚNG → nhận trả: hoàn 100k, redirect banner có refund');
  r = await adm('POST', `${base}/return/step-up`, { cookie: cookieA, origin: OADM, form: [...stepForm, ['password', A.password]] });
  const loc = r.location ?? '';
  r.status === 303 && /returned=1/.test(loc) && /refund=100000/.test(loc) && await refundsOf(id) === 100000
    ? ok('step-up đúng → trả 1×A, hoàn 100k, redirect ?returned=1&refund=100000') : bad('trả qua UI sai', `st=${r.status} loc=${loc} rv=${await refundsOf(id)}`);

  sect('RMA hoàn tất request và chỉ ghi một refund/return/restock');
  const linked = (await owner.query(
    `SELECT r.status, r.result_return_id, rt.id AS return_id, rt.refund_vnd, rt.restocked
       FROM order_requests r LEFT JOIN returns rt ON rt.id=r.result_return_id
      WHERE r.id=$1`, [requestId],
  )).rows[0];
  const receiveLedger = (await owner.query(
    `SELECT count(*)::int n, coalesce(sum(delta),0)::int delta FROM inventory_ledger
      WHERE id>$1 AND shop_id=$2 AND variant_id=$3 AND kind='receive'`,
    [ledgerBefore, A.shopId, vid],
  )).rows[0];
  linked?.status === 'completed' && linked.result_return_id && linked.result_return_id === linked.return_id
    && N(linked.refund_vnd) === 100000 && linked.restocked === true
    && await refundCountOf(id) === 1 && await returnsCountOf(id) === 1
    && await stockOf(A.shopId, vid) === stockBeforeReturn + 1
    && N(receiveLedger.n) === 1 && N(receiveLedger.delta) === 1
    ? ok('request completed + result_return_id; refund/return/restock đúng một lần')
    : bad('RMA/request linkage sai', JSON.stringify({ linked, receiveLedger, stockBeforeReturn, stockAfter: await stockOf(A.shopId, vid) }));

  sect('Replay request đã completed không nhân đôi tiền hoặc tồn');
  r = await adm('POST', `${base}/return/step-up`, { cookie: cookieA, origin: OADM, form: [...stepForm, ['password', A.password]] });
  const replayLedger = (await owner.query(
    `SELECT count(*)::int n, coalesce(sum(delta),0)::int delta FROM inventory_ledger
      WHERE id>$1 AND shop_id=$2 AND variant_id=$3 AND kind='receive'`,
    [ledgerBefore, A.shopId, vid],
  )).rows[0];
  r.status === 303 && /refund=100000/.test(r.location ?? '')
    && await refundCountOf(id) === 1 && await refundsOf(id) === 100000 && await returnsCountOf(id) === 1
    && await stockOf(A.shopId, vid) === stockBeforeReturn + 1
    && N(replayLedger.n) === 1 && N(replayLedger.delta) === 1
    ? ok('replay trả kết quả cũ, không double-refund/double-restock')
    : bad('replay bị nhân đôi', JSON.stringify({ status: r.status, location: r.location, refunds: await refundCountOf(id), returns: await returnsCountOf(id), stock: await stockOf(A.shopId, vid), replayLedger }));

  sect('Chi tiết đơn (banner redirect) hiện card "Lịch sử đổi-trả" + số hoàn + notice');
  r = await adm('GET', `${base}?returned=1&refund=100000&restock=1`, { cookie: cookieA });
  /Lịch sử đổi-trả/.test(r.body) && /100\.000/.test(r.body) && /Đã nhận trả hàng/.test(r.body) ? ok('card "Lịch sử đổi-trả" + hoàn 100.000₫ + banner thành công') : bad('card/banner thiếu', '');

  sect('Trả MỘT PHẦN: đơn VẪN delivered, còn nút trả + dòng "đã trả 1"');
  r = await adm('GET', base, { cookie: cookieA });
  await col(id, 'status') === 'delivered' && /Nhận trả hàng/.test(r.body) && /đã trả 1/.test(r.body) ? ok('trả một phần → vẫn delivered, còn nút trả, dòng "đã trả 1"') : bad('trả một phần sai', `st=${await col(id, 'status')}`);

  sect('Đơn CHƯA giao → KHÔNG nút trả + GET /return từ chối');
  const cart2 = (await co(A.host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 1 } })).cartToken;
  await co(A.host, 'POST', '/checkout', { body: { customer: { name: 'U', phone: '0901239999' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' }, cartToken: cart2, idemKey: `u-${uniq()}` });
  const pendId = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 AND customer_phone='0901239999' ORDER BY created_at DESC LIMIT 1`, [A.shopId])).rows[0].id;
  const gd = await adm('GET', `/shops/${A.shopId}/orders/${pendId}`, { cookie: cookieA });
  const gr = await adm('GET', `/shops/${A.shopId}/orders/${pendId}/return`, { cookie: cookieA });
  !/Nhận trả hàng/.test(gd.body) && /ĐÃ GIAO/.test(gr.body) ? ok('đơn chưa giao: không nút + GET /return → về chi tiết kèm lý do') : bad('đơn chưa giao xử sai', `nút=${/Nhận trả hàng/.test(gd.body)} gr=${gr.status}`);

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
