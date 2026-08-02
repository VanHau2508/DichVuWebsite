// E2E: SỬA ĐƠN ĐÃ TRẢ (v2). Kiểm: giảm tổng → HOÀN đúng chênh (bút toán refunds),
// tăng tổng → 409 (chưa thu thêm), NHIỀU lần sửa tính hoàn đúng (neo amount_paid),
// guard perm 'refund' + STEP-UP, đơn chưa trả → 409 (dùng /edit thường).
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = 'http://auth:3020', PLATFORM = 'http://platform:3030', SELLER = 'http://seller:3040';
const CO = new URL('http://checkout:3060');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 5 });
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  PASS ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? ' :: ' + String(d).slice(0, 170) : '')); };
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
const login = async (e, p) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email: e, password: p }, origin: OA })).sc);
const uidOf = async (e) => (await owner.query('SELECT id FROM users WHERE email=$1', [e])).rows[0]?.id ?? null;
let HOST;
function co(method, path, { json, cartCookie, idem } = {}) {
  return new Promise((resolve, reject) => {
    const data = json !== undefined ? JSON.stringify(json) : null;
    const headers = { host: HOST, origin: `https://${HOST}` };
    if (data != null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (cartCookie) headers.cookie = `__Host-cart=${cartCookie}`;
    if (idem) headers['idempotency-key'] = idem;
    const req = http.request({ hostname: CO.hostname, port: CO.port, path, method, headers }, (rs) => {
      let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch {} let tok = cartCookie; for (const c of rs.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) tok = m[1]; } resolve({ status: rs.statusCode, json: j, raw: b, cartCookie: tok }); });
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
const N = (x) => Number(x);
const refundsOf = async (oid) => N((await owner.query(`SELECT coalesce(sum(amount_vnd),0)::bigint s FROM refunds WHERE order_id=$1`, [oid])).rows[0].s);
const reservedOf = async (vid) => N((await owner.query('SELECT reserved FROM inventory_levels WHERE variant_id=$1', [vid])).rows[0].reserved);
const colOf = async (oid, col) => (await owner.query(`SELECT ${col} FROM orders WHERE id=$1`, [oid])).rows[0][col];

async function main() {
  const staff = await makeStaff();
  const slug = `epaid-${uniq()}`;
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
  const shopId = r.json.id; HOST = `${slug}.nentang.vn`;
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  const oc = await login(oe, op);
  const mk = async (title, price, stock) => {
    const p = await rq(SELLER, 'POST', `/shops/${shopId}/products`, { body: { title, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `${title}-${uniq()}`, price_vnd: price }] }, cookie: oc, origin: OS });
    const vid = (await rq(SELLER, 'GET', `/shops/${shopId}/products/${p.json.id}`, { cookie: oc })).json.variants[0].id;
    await rq(SELLER, 'POST', `/shops/${shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: oc, origin: OS });
    return vid;
  };
  const A = await mk('A', 100000, 20);
  const cust = { name: 'Khách', phone: '0912000111', email: 'k@x.vn', address_line: 'Số 1', province: 'Hà Nội' };
  // Đơn 5×A = 500k + ship 30k = 530k, rồi ÉP đã trả (mô phỏng khách chuyển khoản xong).
  const mkPaidOrder = async () => {
    const cart = (await co('POST', '/cart/items', { json: { variant_id: A, qty: 5 } })).cartCookie;
    await co('POST', '/checkout', { json: { customer: { name: 'Khách', phone: '0912000111', email: 'k@x.vn' }, address: { line: 'Số 1', province: 'Hà Nội' }, payment_method: 'cod' }, cartCookie: cart, idem: `p-${uniq()}` });
    const id = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 1`, [shopId])).rows[0].id;
    await owner.query(`UPDATE orders SET payment_status='paid', paid_at=now(), status='confirmed' WHERE id=$1`, [id]); // amount_paid_vnd VẪN 0 → lazy dùng total
    return id;
  };
  const eurl = (id) => `/shops/${shopId}/orders/${id}/edit-paid`;
  const stepUp = () => rq(AUTH, 'POST', '/auth/step-up', { body: { password: op }, cookie: oc, origin: OA });

  sect('Chưa step-up → 403 step_up_required (bar refund)');
  let id = await mkPaidOrder();
  r = await rq(SELLER, 'POST', eurl(id), { body: { lines: [{ variant_id: A, qty: 3 }], customer: cust }, cookie: oc, origin: OS });
  r.status === 403 && r.json?.step_up_required ? ok('sửa đơn đã trả CHƯA step-up → 403 step_up_required') : bad('không đòi step-up', `${r.status} ${JSON.stringify(r.json)}`);

  await stepUp();

  sect('GIẢM tổng: 5×A(530k đã trả) → 3×A = 330k → HOÀN đúng 200k, đơn vẫn paid');
  const rvBefore = await refundsOf(id);
  r = await rq(SELLER, 'POST', eurl(id), { body: { lines: [{ variant_id: A, qty: 3 }], customer: cust }, cookie: oc, origin: OS });
  const rvAfter = await refundsOf(id), tot = N(await colOf(id, 'total_vnd')), ps = await colOf(id, 'payment_status'), ap = N(await colOf(id, 'amount_paid_vnd'));
  r.status === 200 && N(r.json.refund_vnd) === 200000 && tot === 330000 && rvAfter - rvBefore === 200000 && ps === 'paid' && ap === 530000
    ? ok('giảm → hoàn 200k (bút toán refunds), total 330k, vẫn paid, amount_paid khoá=530k') : bad('giảm/hoàn sai', `st=${r.status} refund=${r.json?.refund_vnd} tot=${tot} rv+=${rvAfter - rvBefore} ps=${ps} ap=${ap}`);
  await reservedOf(A) === 3 ? ok('reserve nhả theo: A=3') : bad('reserve sai', await reservedOf(A));

  sect('SỬA LẦN 2 (neo amount_paid=530k): 3×A → 1×A = 130k → HOÀN THÊM đúng 200k (không tính lại sai)');
  r = await rq(SELLER, 'POST', eurl(id), { body: { lines: [{ variant_id: A, qty: 1 }], customer: cust }, cookie: oc, origin: OS });
  const rv2 = await refundsOf(id), tot2 = N(await colOf(id, 'total_vnd'));
  // đã thu 530k, đã hoàn 200k+200k=400k, net=130k == tổng mới 130k ✓
  r.status === 200 && N(r.json.refund_vnd) === 200000 && tot2 === 130000 && rv2 === 400000
    ? ok('lần 2 giảm → hoàn thêm 200k (tổng hoàn 400k = 530k−130k), total 130k — NEO đúng') : bad('sửa lần 2 tính hoàn sai', `refund=${r.json?.refund_vnd} tot=${tot2} rvSum=${rv2}`);

  sect('Sửa GIỮ NGUYÊN tổng (đổi địa chỉ, qty giữ) → KHÔNG hoàn thêm');
  const rvBeforeSame = await refundsOf(id);
  r = await rq(SELLER, 'POST', eurl(id), { body: { lines: [{ variant_id: A, qty: 1 }], customer: { ...cust, address_line: 'Địa chỉ khác' } }, cookie: oc, origin: OS });
  r.status === 200 && N(r.json.refund_vnd) === 0 && await refundsOf(id) === rvBeforeSame ? ok('tổng không đổi → refund_vnd=0, không bút toán thừa') : bad('hoàn thừa khi tổng không đổi', `refund=${r.json?.refund_vnd}`);

  sect('TĂNG tổng đơn đã trả → 409 (chưa thu thêm)');
  r = await rq(SELLER, 'POST', eurl(id), { body: { lines: [{ variant_id: A, qty: 4 }], customer: cust }, cookie: oc, origin: OS });
  r.status === 409 && /thiếu|tăng tổng/.test(r.json?.error ?? '') ? ok('tăng tổng đơn đã trả → 409 (khách còn thiếu)') : bad('tăng được tổng đơn đã trả!', `${r.status} ${r.json?.error}`);
  N(await colOf(id, 'total_vnd')) === 130000 ? ok('tổng KHÔNG đổi sau 409 (rollback)') : bad('409 vẫn đổi tổng', await colOf(id, 'total_vnd'));

  sect('Guard: đơn CHƯA trả → /edit-paid trả 409 (dùng /edit thường)');
  const cart2 = (await co('POST', '/cart/items', { json: { variant_id: A, qty: 2 } })).cartCookie;
  await co('POST', '/checkout', { json: { customer: { name: 'U', phone: '0912000333' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' }, cartCookie: cart2, idem: `u-${uniq()}` });
  const unpaidId = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 AND customer_phone='0912000333' ORDER BY created_at DESC LIMIT 1`, [shopId])).rows[0].id;
  r = await rq(SELLER, 'POST', eurl(unpaidId), { body: { lines: [{ variant_id: A, qty: 1 }], customer: { name: 'U', phone: '0912000333' } }, cookie: oc, origin: OS });
  r.status === 409 && /chưa thanh toán/.test(r.json?.error ?? '') ? ok('đơn chưa trả qua /edit-paid → 409') : bad('sai guard chưa-trả', `${r.status} ${r.json?.error}`);

  sect('Guard: role thấp (order_manager) KHÔNG có perm refund → 403');
  const oe2 = `mgr-${uniq()}@shop.vn`, op2 = 'manager passphrase strong';
  const iv = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe2, role: 'order_manager' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe2), password: op2 }, origin: OA });
  const mc = await login(oe2, op2);
  const id2 = await mkPaidOrder();
  r = await rq(SELLER, 'POST', eurl(id2), { body: { lines: [{ variant_id: A, qty: 3 }], customer: cust }, cookie: mc, origin: OS });
  r.status === 403 && r.json?.required === 'refund' ? ok('order_manager → 403 (thiếu perm refund)') : bad('role thấp sửa được đơn đã trả!', `${r.status} ${JSON.stringify(r.json)}`);

  sect('Huỷ đơn ĐÃ TRẢ TIỀN (0117): bắt buộc lý do, lý do đi vào email khách');
  // Trước 0117 nhánh cancel không hề nhìn payment_status: đơn khách đã chuyển khoản huỷ
  // được bằng một cú bấm, không lý do, không phiếu hoàn, email chỉ nói "đã huỷ". Tiền
  // không mất khỏi sổ nhưng KHOẢN NỢ KHÁCH biến mất khỏi tầm mắt.
  const cid = await mkPaidOrder();
  const curl = `/shops/${shopId}/orders/${cid}/cancel`;
  r = await rq(SELLER, 'POST', curl, { body: {}, cookie: oc, origin: OS });
  r.status === 400 && /lý do/i.test(r.json?.error ?? '')
    ? ok('đơn đã trả + KHÔNG lý do → 400') : bad('huỷ lọt không cần lý do', `${r.status} ${JSON.stringify(r.json)}`);
  (await colOf(cid, 'status')) === 'confirmed'
    ? ok('đơn KHÔNG bị huỷ khi thiếu lý do (không đổi trạng thái nửa vời)') : bad('đơn đã đổi trạng thái dù 400');

  r = await rq(SELLER, 'POST', curl, { body: { reason: 'hết hàng, không kịp giao' }, cookie: oc, origin: OS });
  r.status === 200 ? ok('có lý do → huỷ được (không CẤM, chỉ bắt nêu lý do)') : bad('huỷ có lý do vẫn hỏng', String(r.status));
  (await colOf(cid, 'cancel_reason')) === 'hết hàng, không kịp giao'
    ? ok('lý do lưu vào orders.cancel_reason') : bad('không lưu lý do');

  // Email khách PHẢI mang lý do + số tiền sẽ hoàn — người mất tiền có quyền biết.
  const ev = (await owner.query(
    `SELECT payload FROM outbox WHERE topic='order.status_changed'
       AND payload->>'status'='cancelled' AND shop_id=$1 ORDER BY id DESC LIMIT 1`, [shopId])).rows[0]?.payload;
  ev?.cancel_reason === 'hết hàng, không kịp giao' && Number(ev?.refund_due_vnd) === 530000
    ? ok('outbox mang cancel_reason + refund_due_vnd = 530.000đ') : bad('payload email thiếu', JSON.stringify(ev));

  // KHÔNG tự tạo phiếu hoàn: tiền ra khỏi tài khoản là việc người bán làm tay. Bịa một
  // bút toán "đã hoàn" trong khi tiền chưa đi là nói dối sổ sách.
  Number((await owner.query(`SELECT count(*)::int n FROM refunds WHERE order_id=$1`, [cid])).rows[0].n) === 0
    ? ok('KHÔNG tự tạo phiếu hoàn (tiền chưa thật sự đi)') : bad('tự bịa phiếu hoàn');

  // Đơn CHƯA trả tiền: lý do vẫn tuỳ chọn — không thêm ma sát chỗ không cần.
  const cartU = (await co("POST", "/cart/items", { json: { variant_id: A, qty: 1 } })).cartCookie;
  // payment_method BẮT BUỘC — thiếu thì checkout không tạo đơn, và truy vấn "đơn mới
  // nhất" bên dưới nhặt trúng đơn VỪA HUỶ ở trên rồi báo 409. Đã dính đúng bẫy đó.
  await co('POST', '/checkout', { json: { customer: { name: 'K2', phone: '0912000112', email: 'k2@x.vn' }, address: { line: 'Số 2', province: 'Hà Nội' }, payment_method: 'cod' }, cartCookie: cartU, idem: `u-${uniq()}` });
  const uid = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1`, [shopId])).rows[0].id;
  r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${uid}/cancel`, { body: {}, cookie: oc, origin: OS });
  r.status === 200 ? ok('đơn CHƯA trả → huỷ không cần lý do') : bad('bắt lý do cả đơn chưa trả', String(r.status));

  console.log(`\n${pass} pass, ${fail} fail`);
  // ── SỬA ĐƠN ĐÃ TRẢ rồi HOÀN NỐT: không được TRỪ ĐÚP phần chênh đã hoàn ─────
  // editPaidOrder vừa ghi phiếu kind='edit_adjustment' VỪA hạ orders.total_vnd. Khoản đó đã
  // được trừ MỘT LẦN ở total_vnd; refundOrder đếm nó lần nữa trong `already` là trừ đúp.
  // Dựng lại thật (2026-08-03): khách trả 1.025.000 → sửa còn 627.000 (hoàn chênh 398.000)
  // → bấm "hoàn toàn bộ" chỉ hoàn 229.000 thay vì 627.000; đơn khoá 'refunded'; hoàn lần nữa
  // → 409. Shop giữ 398.000 của khách và HẾT đường trả qua giao diện.
  sect('Sửa đơn đã trả → hoàn nốt: KHÔNG trừ đúp phần chênh (kind=edit_adjustment)');
  {
    const id2 = await mkPaidOrder();
    const thu = N(await colOf(id2, 'total_vnd'));
    await rq(AUTH, 'POST', '/auth/step-up', { body: { password: op }, cookie: oc, origin: OA });
    const re = await rq(SELLER, 'POST', eurl(id2), { body: { customer: cust, lines: [{ variant_id: A, qty: 3 }] }, cookie: oc, origin: OS });
    const conNo = N(await colOf(id2, 'total_vnd'));
    const daHoanChenh = await refundsOf(id2);
    await rq(AUTH, 'POST', '/auth/step-up', { body: { password: op }, cookie: oc, origin: OA });
    const rr = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${id2}/refund`, { body: {}, cookie: oc, origin: OS });
    const tongHoan = await refundsOf(id2);
    const hoanThem = tongHoan - daHoanChenh, shopGiu = thu - tongHoan;
    re.status === 200 && rr.status === 200 && hoanThem === conNo && shopGiu === 0
      ? ok(`hoàn nốt đúng ${hoanThem}đ (tổng hoàn ${tongHoan} = đã thu ${thu}) — không trừ đúp`)
      : bad('TRỪ ĐÚP khi hoàn nốt đơn đã sửa', `edit=${re.status} refund=${rr.status} hoanThem=${hoanThem} (ky vong ${conNo}) shopGiuLai=${shopGiu}`);
  }

  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
