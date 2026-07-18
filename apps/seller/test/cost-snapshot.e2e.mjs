// E2E: SNAPSHOT GIÁ VỐN (0081) — 4 điểm ghi + phân loại phiếu hoàn. Kiểm: checkout
// storefront snapshot cost lúc đặt (NULL khi chưa khai — không 0), đổi cost sau KHÔNG hồi
// tố; đơn tay snapshot cost hiện hành; SỬA ĐƠN dòng giữ mang cost CŨ + dòng mới cost MỚI
// (cạm bẫy re-cost); RMA copy cost vào return_lines + kind='rma'; edit-paid kind=
// 'edit_adjustment'; refund thường kind='refund'.
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
const N = (x) => (x == null ? null : Number(x));

async function main() {
  const staff = await makeStaff();
  const slug = `cost-${uniq()}`;
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
  const shopId = r.json.id; HOST = `${slug}.nentang.vn`;
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  const oc = await login(oe, op);
  const stepUp = () => rq(AUTH, 'POST', '/auth/step-up', { body: { password: op }, cookie: oc, origin: OA });
  const mk = async (t, price, stock) => {
    const p = await rq(SELLER, 'POST', `/shops/${shopId}/products`, { body: { title: t, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `${t}-${uniq()}`, price_vnd: price }] }, cookie: oc, origin: OS });
    const vid = (await rq(SELLER, 'GET', `/shops/${shopId}/products/${p.json.id}`, { cookie: oc })).json.variants[0].id;
    await rq(SELLER, 'POST', `/shops/${shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: oc, origin: OS });
    return vid;
  };
  // Fixture giá vốn ghi thẳng DB (UI nhập cost là commit sau; e2e này kiểm ĐƯỜNG TIỀN snapshot).
  const setCost = (vid, cost) => owner.query(
    `INSERT INTO variant_costs (shop_id, variant_id, cost_vnd) VALUES ($1,$2,$3)
     ON CONFLICT (shop_id, variant_id) DO UPDATE SET cost_vnd = $3, updated_at = now()`, [shopId, vid, cost]);
  const A = await mk('A', 100000, 30), B = await mk('B', 50000, 30), C = await mk('C', 80000, 30);
  await setCost(A, 60000); // B: KHÔNG khai cost. C: khai sau.
  const lineOf = async (orderId, vid) => (await owner.query(`SELECT unit_cost_vnd, unit_price_vnd, qty FROM order_lines WHERE order_id=$1 AND variant_id=$2`, [orderId, vid])).rows[0];
  const orderBy = async (num) => (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2`, [shopId, num])).rows[0].id;

  sect('Checkout storefront: snapshot cost lúc đặt — A=60.000, B (chưa khai) = NULL');
  let cart = (await co('POST', '/cart/items', { json: { variant_id: A, qty: 2 } })).cartCookie;
  cart = (await co('POST', '/cart/items', { json: { variant_id: B, qty: 1 }, cartCookie: cart })).cartCookie;
  r = await co('POST', '/checkout', { json: { customer: { name: 'K', phone: '0911000222', email: 'k@x.vn' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' }, cartCookie: cart, idem: `c-${uniq()}` });
  const o1 = await orderBy(r.json.order_number);
  const l1A = await lineOf(o1, A), l1B = await lineOf(o1, B);
  N(l1A.unit_cost_vnd) === 60000 && l1B.unit_cost_vnd === null
    ? ok('checkout: A.unit_cost=60.000, B.unit_cost=NULL (không bịa 0)') : bad('checkout snapshot sai', `A=${l1A.unit_cost_vnd} B=${l1B.unit_cost_vnd}`);

  sect('Đổi giá vốn SAU khi đặt → đơn cũ KHÔNG hồi tố');
  await setCost(A, 75000);
  const l1A2 = await lineOf(o1, A);
  N(l1A2.unit_cost_vnd) === 60000 ? ok('đơn cũ giữ cost 60.000 (chứng từ đứng yên)') : bad('cost đơn cũ bị hồi tố', l1A2.unit_cost_vnd);

  sect('Đơn tay seller: snapshot cost HIỆN HÀNH (75.000)');
  r = await rq(SELLER, 'POST', `/shops/${shopId}/orders`, { body: { idempotency_key: `man-${uniq()}`, lines: [{ variant_id: A, qty: 1 }], customer: { name: 'Tay', phone: '0911000333' }, payment_method: 'cod' }, cookie: oc, origin: OS });
  if (r.status !== 201) bad('tạo đơn tay lỗi', r.raw);
  else {
    const oM = await orderBy(r.json.order_number);
    const lM = await lineOf(oM, A);
    N(lM.unit_cost_vnd) === 75000 ? ok('đơn tay: unit_cost=75.000 (giá vốn hiện hành)') : bad('đơn tay snapshot sai', lM.unit_cost_vnd);
  }

  sect('SỬA ĐƠN (unpaid): dòng GIỮ mang cost CŨ, dòng MỚI cost hiện tại');
  // o1 đang pending unpaid. Đổi cost A lên 90.000 + khai C=40.000 rồi sửa: giữ A (qty 2→1), thêm C.
  await setCost(A, 90000); await setCost(C, 40000);
  r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o1}/edit`, { body: { lines: [{ variant_id: A, qty: 1 }, { variant_id: C, qty: 2 }], customer: { name: 'K', phone: '0911000222' } }, cookie: oc, origin: OS });
  const eA = await lineOf(o1, A), eC = await lineOf(o1, C);
  r.status === 200 && N(eA.unit_cost_vnd) === 60000 && N(eC.unit_cost_vnd) === 40000
    ? ok('sửa đơn: A giữ cost 60.000 (KHÔNG re-cost 90.000), C mới = 40.000') : bad('sửa đơn re-cost sai', `${r.status} A=${eA?.unit_cost_vnd}(kv 60000) C=${eC?.unit_cost_vnd}(kv 40000)`);

  sect('SỬA ĐƠN ĐÃ TRẢ: phiếu chênh kind=edit_adjustment');
  // Tạo đơn mới A×2 (cost snapshot 90.000), mark-paid, rồi edit-paid giảm còn A×1.
  cart = (await co('POST', '/cart/items', { json: { variant_id: A, qty: 2 } })).cartCookie;
  r = await co('POST', '/checkout', { json: { customer: { name: 'P', phone: '0911000444' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' }, cartCookie: cart, idem: `p-${uniq()}` });
  const o2 = await orderBy(r.json.order_number);
  await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o2}/mark-paid`, { cookie: oc, origin: OS });
  await stepUp();
  r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o2}/edit-paid`, { body: { lines: [{ variant_id: A, qty: 1 }], customer: { name: 'P', phone: '0911000444' } }, cookie: oc, origin: OS });
  const rf1 = (await owner.query(`SELECT kind, amount_vnd FROM refunds WHERE order_id=$1`, [o2])).rows;
  r.status === 200 && rf1.length === 1 && rf1[0].kind === 'edit_adjustment'
    ? ok(`edit-paid giảm → 1 phiếu kind=edit_adjustment (${N(rf1[0].amount_vnd)}đ)`) : bad('kind edit_adjustment sai', `${r.status} ${JSON.stringify(rf1)}`);

  sect('RMA: return_lines copy cost snapshot + phiếu kind=rma');
  // Đơn mới A×2 → confirm → ship → deliver → mark-paid → trả 1 A restock.
  cart = (await co('POST', '/cart/items', { json: { variant_id: A, qty: 2 } })).cartCookie;
  r = await co('POST', '/checkout', { json: { customer: { name: 'R', phone: '0911000555' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' }, cartCookie: cart, idem: `r-${uniq()}` });
  const o3 = await orderBy(r.json.order_number);
  await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o3}/confirm`, { cookie: oc, origin: OS });
  await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o3}/ship`, { body: { tracking_number: 'T' + uniq() }, cookie: oc, origin: OS });
  await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o3}/deliver`, { cookie: oc, origin: OS });
  await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o3}/mark-paid`, { cookie: oc, origin: OS });
  await stepUp();
  r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o3}/return`, { body: { lines: [{ variant_id: A, qty: 1 }], restock: true, reason: 'khách trả' }, cookie: oc, origin: OS });
  const rl = (await owner.query(`SELECT rl.unit_cost_vnd FROM return_lines rl JOIN returns rt ON rt.id=rl.return_id WHERE rt.order_id=$1`, [o3])).rows;
  const rf2 = (await owner.query(`SELECT kind FROM refunds WHERE order_id=$1`, [o3])).rows;
  r.status === 200 && rl.length === 1 && N(rl[0].unit_cost_vnd) === 90000 && rf2.length === 1 && rf2[0].kind === 'rma'
    ? ok('RMA: return_lines.unit_cost=90.000 (copy snapshot) + phiếu kind=rma') : bad('RMA cost/kind sai', `${r.status} rl=${JSON.stringify(rl)} rf=${JSON.stringify(rf2)}`);

  sect('Refund thường: kind mặc định = refund');
  await stepUp();
  r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o3}/refund`, { body: { amount_vnd: 10000, reason: 'thiện chí' }, cookie: oc, origin: OS });
  const rf3 = (await owner.query(`SELECT kind FROM refunds WHERE order_id=$1 AND reason='thiện chí'`, [o3])).rows;
  r.status === 200 && rf3[0]?.kind === 'refund' ? ok('refund thường → kind=refund') : bad('kind refund sai', `${r.status} ${JSON.stringify(rf3)}`);

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
