// E2E: ĐỐI SOÁT COD với hãng. Kiểm: đơn COD giao-qua-hãng vào danh sách chờ (kỳ vọng =
// total − phí hãng), ghi phiếu chuyển tiền → đánh dấu đã đối soát + chênh lệch, đối soát 2
// lần → 409, đơn giao tay/không-COD/chưa-giao → 422, cross-shop, perm payment.write.
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
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? ' :: ' + String(d).slice(0, 180) : '')); };
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
const col = async (id, c) => (await owner.query(`SELECT ${c} FROM orders WHERE id=$1`, [id])).rows[0][c];

async function main() {
  const staff = await makeStaff();
  const slug = `cod-${uniq()}`;
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
  const shopId = r.json.id; HOST = `${slug}.nentang.vn`;
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  const oc = await login(oe, op);
  const pr = await rq(SELLER, 'POST', `/shops/${shopId}/products`, { body: { title: 'SP', slug: `sp-${uniq()}`, price_vnd: 100000, status: 'active', variants: [{ sku: `S-${uniq()}`, price_vnd: 100000 }] }, cookie: oc, origin: OS });
  const vid = (await rq(SELLER, 'GET', `/shops/${shopId}/products/${pr.json.id}`, { cookie: oc })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${shopId}/variants/${vid}/inventory/adjust`, { body: { delta: 100, reason: 'nhập' }, cookie: oc, origin: OS });

  // Đơn COD giao QUA HÃNG (giả lập shipment provider='ghn' + phí 15k), tới delivered.
  const mkCodViaCarrier = async (qty, fee) => {
    const cart = (await co('POST', '/cart/items', { json: { variant_id: vid, qty } })).cartCookie;
    await co('POST', '/checkout', { json: { customer: { name: 'K', phone: '0912000111' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' }, cartCookie: cart, idem: `c-${uniq()}` });
    const id = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 1`, [shopId])).rows[0].id;
    await rq(SELLER, 'POST', `/shops/${shopId}/orders/${id}/confirm`, { cookie: oc, origin: OS });
    // shipment giao qua hãng ghn với phí (giả lập — thay vì gọi API hãng thật)
    await owner.query(`INSERT INTO shipments (shop_id, order_id, carrier, tracking_number, status, provider, carrier_fee_vnd) VALUES ($1,$2,'GHN','TN'||$3,'delivered','ghn',$4)`, [shopId, id, uniq(), fee]);
    await owner.query(`UPDATE orders SET status='delivered', delivered_at=now(), payment_status='paid', paid_at=now() WHERE id=$1`, [id]);
    return id;
  };
  // đơn giao TAY (provider NULL) — không cần đối soát
  const mkCodManual = async (qty) => {
    const cart = (await co('POST', '/cart/items', { json: { variant_id: vid, qty } })).cartCookie;
    await co('POST', '/checkout', { json: { customer: { name: 'M', phone: '0912000222' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' }, cartCookie: cart, idem: `m-${uniq()}` });
    const id = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 1`, [shopId])).rows[0].id;
    await rq(SELLER, 'POST', `/shops/${shopId}/orders/${id}/confirm`, { cookie: oc, origin: OS });
    await owner.query(`INSERT INTO shipments (shop_id, order_id, carrier, tracking_number, status) VALUES ($1,$2,'tay','TT'||$3,'delivered')`, [shopId, id, uniq()]);
    await owner.query(`UPDATE orders SET status='delivered', delivered_at=now(), payment_status='paid', paid_at=now() WHERE id=$1`, [id]);
    return id;
  };
  const o1 = await mkCodViaCarrier(3, 15000); // total 330k, phí 15k → kỳ vọng 315k
  const o2 = await mkCodViaCarrier(2, 20000); // total 230k, phí 20k → kỳ vọng 210k
  const oManual = await mkCodManual(1);

  sect('Danh sách chờ đối soát: 2 đơn qua hãng (kỳ vọng 315k+210k=525k), giao tay KHÔNG có');
  let g = (await rq(SELLER, 'GET', `/shops/${shopId}/cod/reconciliation`, { cookie: oc })).json;
  const ids = new Set(g.outstanding.map((o) => o.id));
  g.outstanding.length === 2 && ids.has(o1) && ids.has(o2) && !ids.has(oManual) && g.total_outstanding_vnd === 525000
    ? ok('chờ đối soát: đúng 2 đơn qua hãng, tổng kỳ vọng 525k, giao tay bị loại') : bad('danh sách chờ sai', `n=${g.outstanding.length} tot=${g.total_outstanding_vnd} manual=${ids.has(oManual)}`);
  const expO1 = g.outstanding.find((o) => o.id === o1)?.expected_net_vnd;
  expO1 === 315000 ? ok('kỳ vọng đơn = total − phí hãng (330k−15k=315k)') : bad('kỳ vọng sai', expO1);

  sect('Ghi phiếu: nhận 520k từ GHN cho 2 đơn (kỳ vọng 525k → thiếu 5k)');
  // Ghi phiếu đối soát nay ĐÒI STEP-UP (bút toán không hoàn tác). Xác thực lại trước mỗi
  // lần gọi: cửa sổ 5 phút thừa sức, nhưng gọi tường minh thì test không phụ thuộc thời gian.
  const su = (ck2 = oc, pw = op) => rq(AUTH, 'POST', '/auth/step-up', { body: { password: pw }, cookie: ck2, origin: OA });
  await su(oc, op);
  r = await rq(SELLER, 'POST', `/shops/${shopId}/cod/remittances`, { body: { carrier: 'ghn', amount_vnd: 520000, order_ids: [o1, o2], note: 'sao kê GHN 18/07' }, cookie: oc, origin: OS });
  r.status === 200 && r.json.expected_vnd === 525000 && r.json.amount_vnd === 520000 && r.json.discrepancy_vnd === -5000 && r.json.order_count === 2
    ? ok('phiếu: kỳ vọng 525k, nhận 520k, chênh −5k (hãng nợ), 2 đơn') : bad('ghi phiếu sai', JSON.stringify(r.json));
  await col(o1, 'cod_settled_at') && await col(o2, 'cod_settled_at') ? ok('2 đơn đánh dấu cod_settled_at') : bad('đơn chưa đánh dấu settled');

  sect('Sau đối soát: danh sách chờ RỖNG, phiếu vào lịch sử');
  g = (await rq(SELLER, 'GET', `/shops/${shopId}/cod/reconciliation`, { cookie: oc })).json;
  g.outstanding.length === 0 && g.total_outstanding_vnd === 0 && g.remittances.length === 1 && g.remittances[0].discrepancy_vnd === -5000
    ? ok('chờ đối soát rỗng; lịch sử 1 phiếu chênh −5k') : bad('sau đối soát sai', `n=${g.outstanding.length} rem=${g.remittances.length}`);

  sect('Đối soát LẠI đơn đã đối soát → 409');
  await su(oc, op);
  r = await rq(SELLER, 'POST', `/shops/${shopId}/cod/remittances`, { body: { carrier: 'ghn', amount_vnd: 100000, order_ids: [o1] }, cookie: oc, origin: OS });
  r.status === 409 && /đã đối soát/.test(r.json?.error ?? '') ? ok('đối soát lại → 409') : bad('đối soát 2 lần lọt', `${r.status} ${r.json?.error}`);

  sect('Đơn giao TAY → 422 (không cần đối soát)');
  await su(oc, op);
  r = await rq(SELLER, 'POST', `/shops/${shopId}/cod/remittances`, { body: { amount_vnd: 100000, order_ids: [oManual] }, cookie: oc, origin: OS });
  r.status === 422 && /giao tay/.test(r.json?.error ?? '') ? ok('đơn giao tay → 422') : bad('giao tay lọt', `${r.status} ${r.json?.error}`);

  sect('Đơn CHƯA giao / KHÔNG COD → 422');
  const cart = (await co('POST', '/cart/items', { json: { variant_id: vid, qty: 1 } })).cartCookie;
  await co('POST', '/checkout', { json: { customer: { name: 'P', phone: '0912000333' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' }, cartCookie: cart, idem: `p-${uniq()}` });
  const pending = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 AND customer_phone='0912000333' ORDER BY created_at DESC LIMIT 1`, [shopId])).rows[0].id;
  await su(oc, op);
  r = await rq(SELLER, 'POST', `/shops/${shopId}/cod/remittances`, { body: { amount_vnd: 100000, order_ids: [pending] }, cookie: oc, origin: OS });
  r.status === 422 && /chưa giao/.test(r.json?.error ?? '') ? ok('đơn chưa giao → 422') : bad('chưa giao lọt', `${r.status} ${r.json?.error}`);

  sect('Sai hãng: đơn qua ghn nhưng khai ghtk → 422');
  const o3 = await mkCodViaCarrier(1, 10000);
  await su(oc, op);
  r = await rq(SELLER, 'POST', `/shops/${shopId}/cod/remittances`, { body: { carrier: 'ghtk', amount_vnd: 120000, order_ids: [o3] }, cookie: oc, origin: OS });
  r.status === 422 && /không phải ghtk|qua ghn/.test(r.json?.error ?? '') ? ok('khai sai hãng → 422') : bad('sai hãng lọt', `${r.status} ${r.json?.error}`);

  sect('Perm: order_manager (không payment.write) → 403');
  const oe2 = `mgr-${uniq()}@shop.vn`, op2 = 'manager passphrase strong';
  const iv = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe2, role: 'order_manager' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe2), password: op2 }, origin: OA });
  const mc = await login(oe2, op2);
  await su(mc, op2);
  r = await rq(SELLER, 'POST', `/shops/${shopId}/cod/remittances`, { body: { amount_vnd: 100000, order_ids: [o3] }, cookie: mc, origin: OS });
  r.status === 403 ? ok('order_manager ghi phiếu → 403 (cần payment.write)') : bad('role thấp ghi được', `${r.status}`);

  sect('Cross-shop: shop khác đối soát đơn này → 422 (RLS không thấy đơn)');
  const oe3 = `own2-${uniq()}@shop.vn`, op3 = 'owner two passphrase';
  const s2 = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: `z-${uniq()}`, slug: `z-${uniq()}`, plan_code: 'platform' }, cookie: staff, origin: OO });
  const iv3 = await rq(PLATFORM, 'POST', `/ops/shops/${s2.json.id}/invitations`, { body: { email: oe3, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe3), password: op3 }, origin: OA });
  const oc3 = await login(oe3, op3);
  await su(oc3, op3);
  r = await rq(SELLER, 'POST', `/shops/${s2.json.id}/cod/remittances`, { body: { amount_vnd: 100000, order_ids: [o3] }, cookie: oc3, origin: OS });
  r.status === 422 ? ok('shop khác đối soát đơn shop A → 422 (RLS che đơn)') : bad('cross-shop lọt', `${r.status}`);

  // ── Đơn hoàn tiền / trả hàng VẪN phải đối soát được với hãng ─────────────────
  // Hãng đã thu tiền của khách xong là món nợ giữa SHOP và HÃNG. Chuyện shop hoàn tiền hay
  // nhận trả hàng sau đó là giữa SHOP và KHÁCH — hai việc khác nhau. Trước đây sổ lọc theo
  // status='delivered' nên refundOrder ('refunded') và createReturn ('returned') đẩy đơn ra
  // khỏi sổ, mà recordRemittance cũng chặn theo status → KHÔNG CÒN đường nào đối soát:
  // tiền hãng đang giữ mất dấu vĩnh viễn. Dựng lại: a10.
  sect('Đơn đã HOÀN TIỀN / TRẢ HÀNG vẫn nằm trong sổ đối soát (tiền hãng vẫn đang giữ)');
  {
    const chosSo = async (id) => {
      const rr = await rq(SELLER, 'GET', `/shops/${shopId}/cod/reconciliation`, { cookie: oc });
      return (rr.json?.outstanding ?? []).some((x) => x.id === id);
    };
    const idR = await mkCodViaCarrier(1, 15000);
    (await chosSo(idR)) ? ok('đơn mới giao: có trong sổ chờ đối soát') : bad('đơn không vào sổ — không dựng được cảnh');
    // Ép trạng thái hậu-giao như refundOrder/createReturn vẫn làm (delivered_at giữ nguyên).
    await owner.query(`UPDATE orders SET status='returned', returned_at=now() WHERE id=$1`, [idR]);
    (await chosSo(idR))
      ? ok("đơn đã TRẢ HÀNG vẫn trong sổ (lọc theo delivered_at, không theo status)")
      : bad('đơn trả hàng RƠI khỏi sổ đối soát — tiền hãng giữ mất dấu');
    await owner.query(`UPDATE orders SET status='refunded' WHERE id=$1`, [idR]);
    (await chosSo(idR)) ? ok('đơn đã HOÀN TIỀN vẫn trong sổ') : bad('đơn hoàn tiền RƠI khỏi sổ đối soát');
    // Và phải ghi được phiếu chuyển tiền cho chính đơn đó (không ngõ cụt 422).
    await rq(AUTH, 'POST', '/auth/step-up', { body: { password: op }, cookie: oc, origin: OA });
    await su(oc, op);
    const rrem = await rq(SELLER, 'POST', `/shops/${shopId}/cod/remittances`,
      { body: { carrier: 'ghn', amount_vnd: 50000, order_ids: [idR] }, cookie: oc, origin: OS });
    rrem.status === 200
      ? ok('ghi được phiếu chuyển tiền cho đơn đã hoàn/trả (còn đường đối soát)')
      : bad('NGÕ CỤT: không ghi được phiếu cho đơn đã hoàn/trả', `${rrem.status} ${rrem.json?.error ?? ''}`);
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
