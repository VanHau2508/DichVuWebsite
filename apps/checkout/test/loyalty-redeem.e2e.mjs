// E2E: ĐỔI ĐIỂM khi checkout (0086 commit 2) — đường tiền đồng bộ. Kiểm: đổi điểm giảm tiền
// HÀNG (không giảm ship); 3 trần (số dư / tiền hàng / %tiền hàng); guest KHÔNG đổi; total ≥ 0;
// idempotency replay không trừ đúp; chống farming (earn tính trên net SAU trừ điểm); disabled→0.
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = 'http://auth:3020', PLATFORM = 'http://platform:3030', SELLER = 'http://seller:3040';
const WORKER = process.env.WORKER_URL ?? 'http://worker:3080';
const ACC = new URL(process.env.ACCOUNT_URL ?? 'http://account:3062');
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  PASS ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? ' :: ' + String(d).slice(0, 220) : '')); };
const sect = (m) => console.log('\n# ' + m);
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
const login = async (e, p) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email: e, password: p }, origin: OA })).sc);
const uidOf = async (e) => (await owner.query('SELECT id FROM users WHERE email=$1', [e])).rows[0]?.id ?? null;
function acc(host, method, path, { form, origin } = {}) {
  return new Promise((resolve, reject) => {
    const data = form !== undefined ? new URLSearchParams(form).toString() : null;
    const headers = { host };
    if (data != null) { headers['content-type'] = 'application/x-www-form-urlencoded'; headers['content-length'] = Buffer.byteLength(data); }
    if (origin) headers.origin = origin;
    const req = http.request({ hostname: ACC.hostname, port: ACC.port, path, method, headers }, (rs) => {
      let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => { let tok = null; for (const c of rs.headers['set-cookie'] ?? []) { const m = /^__Host-cust_session=([^;]*)/.exec(c); if (m) tok = m[1]; } resolve({ status: rs.statusCode, body: b, setTok: tok }); });
    });
    req.on('error', reject); if (data != null) req.write(data); req.end();
  });
}
function co(host, method, path, { json, cartTok, custTok, idem } = {}) {
  return new Promise((resolve, reject) => {
    const data = json !== undefined ? JSON.stringify(json) : null;
    const headers = { host, origin: `https://${host}` };
    if (data != null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const cks = []; if (cartTok) cks.push(`__Host-cart=${cartTok}`); if (custTok) cks.push(`__Host-cust_session=${custTok}`);
    if (cks.length) headers.cookie = cks.join('; ');
    if (idem) headers['idempotency-key'] = idem;
    const req = http.request({ hostname: CO.hostname, port: CO.port, path, method, headers }, (rs) => {
      let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch {} let tok = cartTok; for (const c of rs.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) tok = m[1]; } resolve({ status: rs.statusCode, json: j, body: b, cartTok: tok }); });
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
async function makeShopOwner(staff) {
  const slug = `red-${uniq()}`;
  const shopId = (await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO })).json.id;
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  return { shopId, host: `${slug}.nentang.vn`, oc: await login(oe, op) };
}
async function makeCustomer(host, shopId) {
  const email = `kh-${uniq()}@mail.vn`, pw = 'khach manh 2026 xyz';
  await acc(host, 'POST', '/account/register', { origin: `https://${host}`, form: { email, password: pw, full_name: 'KH' } });
  const lg = await acc(host, 'POST', '/account/login', { origin: `https://${host}`, form: { email, password: pw } });
  const id = (await owner.query(`SELECT id FROM customers WHERE shop_id=$1 AND lower(email)=lower($2)`, [shopId, email])).rows[0]?.id;
  return { custTok: lg.setTok, id };
}
const setCfg = (shopId, { rate = 1, redeem = 100, vesting = 0, pct = 50, min = 0, enabled = true } = {}) => owner.query(
  `INSERT INTO shop_loyalty_config (shop_id, enabled, earn_points_per_1000, redeem_vnd_per_point, earn_vesting_days, max_redeem_pct, min_redeem_points)
   VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (shop_id) DO UPDATE SET
   enabled=$2, earn_points_per_1000=$3, redeem_vnd_per_point=$4, earn_vesting_days=$5, max_redeem_pct=$6, min_redeem_points=$7, updated_at=now()`,
  [shopId, enabled, rate, redeem, vesting, pct, min]);
const seedBalance = (shopId, cid, pts) => owner.query(
  `INSERT INTO loyalty_balances (shop_id, customer_id, balance_points) VALUES ($1,$2,$3)
   ON CONFLICT (shop_id,customer_id) DO UPDATE SET balance_points=$3, updated_at=now()`, [shopId, cid, pts]);
const balOf = async (shopId, cid) => N((await owner.query(`SELECT balance_points FROM loyalty_balances WHERE shop_id=$1 AND customer_id=$2`, [shopId, cid])).rows[0]?.balance_points ?? 0);
const redeemLedger = async (shopId, oid) => (await owner.query(`SELECT delta FROM loyalty_ledger WHERE shop_id=$1 AND order_id=$2 AND kind='redeem'`, [shopId, oid])).rows.map((r) => N(r.delta));
const orderRow = async (shopId, num) => (await owner.query(`SELECT id, subtotal_vnd, shipping_vnd, discount_vnd, total_vnd, points_redeemed, points_discount_vnd FROM orders WHERE shop_id=$1 AND order_number=$2`, [shopId, num])).rows[0];

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff);
  const mk = async (title, price, stock) => {
    const p = await rq(SELLER, 'POST', `/shops/${A.shopId}/products`, { body: { title, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `${title}-${uniq()}`, price_vnd: price }] }, cookie: A.oc, origin: OS });
    if (!p.json?.id) throw new Error(`product ${p.status}: ${p.raw}`);
    const vid = (await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${p.json.id}`, { cookie: A.oc })).json.variants[0].id;
    await rq(SELLER, 'POST', `/shops/${A.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: A.oc, origin: OS });
    return vid;
  };
  const V = await mk('SP', 100000, 500);
  // Đặt đơn (tuỳ chọn đổi điểm) qua JSON API.
  async function order({ custTok, redeem, idem } = {}) {
    let cart = (await co(A.host, 'POST', '/cart/items', { json: { variant_id: V, qty: 1 } })).cartTok;
    const body = { customer: { name: 'KH', phone: '0911222333', email: 'kh@x.vn' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' };
    if (redeem != null) body.points_redeem = redeem;
    return co(A.host, 'POST', '/checkout', { json: body, cartTok: cart, custTok, idem: idem ?? `r-${uniq()}` });
  }

  const cust = await makeCustomer(A.host, A.shopId);
  await setCfg(A.shopId, { rate: 1, redeem: 100, vesting: 0, pct: 50 });
  cust.id ? ok('dựng shop + SP + khách + bật điểm (đổi 100đ/điểm, trần 50% tiền hàng)') : bad('setup lỗi');

  sect('1. Đổi điểm: giảm tiền HÀNG, snapshot đúng, số dư trừ, sổ redeem âm');
  await seedBalance(A.shopId, cust.id, 800);
  let r = await order({ custTok: cust.custTok, redeem: 300 }); // 300 điểm × 100 = 30.000đ; trần 50%×100k=50k OK
  let o = await orderRow(A.shopId, r.json.order_number);
  r.status === 201 && N(o.points_redeemed) === 300 && N(o.points_discount_vnd) === 30000
    && N(o.total_vnd) === N(o.subtotal_vnd) - N(o.discount_vnd) - 30000 + N(o.shipping_vnd)
    ? ok(`đổi 300 điểm = 30.000đ giảm, total = hàng − điểm + ship (${o.total_vnd})`) : bad('đổi điểm sai', JSON.stringify(o));
  N(await balOf(A.shopId, cust.id)) === 500 ? ok('số dư 800 → 500 (trừ 300)') : bad('số dư sai', await balOf(A.shopId, cust.id));
  JSON.stringify(await redeemLedger(A.shopId, o.id)) === '[-300]' ? ok('1 dòng sổ redeem delta=-300') : bad('sổ redeem sai', JSON.stringify(await redeemLedger(A.shopId, o.id)));

  sect('2. TRẦN %tiền hàng: đổi vượt 50% bị cắt');
  await seedBalance(A.shopId, cust.id, 2000);
  r = await order({ custTok: cust.custTok, redeem: 2000 }); // muốn 2000 (=200k) nhưng trần 50%×100k=50k → 500 điểm
  o = await orderRow(A.shopId, r.json.order_number);
  N(o.points_redeemed) === 500 && N(o.points_discount_vnd) === 50000
    ? ok('đòi 2000 điểm → cắt còn 500 (trần 50% tiền hàng), giảm 50.000đ') : bad('trần % không cắt', JSON.stringify(o));
  N(await balOf(A.shopId, cust.id)) === 1500 ? ok('số dư 2000 → 1500 (chỉ trừ 500 đã đổi)') : bad('trừ số dư sai khi cắt trần', await balOf(A.shopId, cust.id));

  sect('3. TRẦN số dư: không đổi quá số điểm có');
  await seedBalance(A.shopId, cust.id, 120);
  r = await order({ custTok: cust.custTok, redeem: 500 }); // có 120, muốn 500 → chỉ 120 (dưới trần 500)
  o = await orderRow(A.shopId, r.json.order_number);
  N(o.points_redeemed) === 120 && N(await balOf(A.shopId, cust.id)) === 0
    ? ok('đòi 500 nhưng số dư 120 → đổi 120, số dư về 0 (không âm)') : bad('trần số dư sai', `${o.points_redeemed}/${await balOf(A.shopId, cust.id)}`);

  sect('4. GUEST (không đăng nhập) KHÔNG đổi được điểm');
  r = await order({ custTok: null, redeem: 500 });
  o = await orderRow(A.shopId, r.json.order_number);
  N(o.points_redeemed) === 0 && N(o.points_discount_vnd) === 0 && N(o.total_vnd) === N(o.subtotal_vnd) + N(o.shipping_vnd)
    ? ok('guest gửi points_redeem=500 → BỎ QUA (giảm 0, total đủ)') : bad('guest đổi được điểm', JSON.stringify(o));

  sect('5. Idempotency: retry cùng key + cùng điểm → replay, KHÔNG trừ đúp');
  await seedBalance(A.shopId, cust.id, 400);
  const key = `idem-${uniq()}`;
  let cart5 = (await co(A.host, 'POST', '/cart/items', { json: { variant_id: V, qty: 1 } })).cartTok;
  const b5 = { customer: { name: 'KH', phone: '0911222333' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod', points_redeem: 200 };
  const r5a = await co(A.host, 'POST', '/checkout', { json: b5, cartTok: cart5, custTok: cust.custTok, idem: key });
  const r5b = await co(A.host, 'POST', '/checkout', { json: b5, cartTok: cart5, custTok: cust.custTok, idem: key }); // replay
  r5a.json?.order_number === r5b.json?.order_number && N(await balOf(A.shopId, cust.id)) === 200
    ? ok('replay cùng key+điểm → cùng đơn, số dư trừ ĐÚNG 1 lần (400→200)') : bad('idempotency trừ đúp', `${r5a.json?.order_number}/${r5b.json?.order_number} bal=${await balOf(A.shopId, cust.id)}`);
  const r5c = await co(A.host, 'POST', '/checkout', { json: { ...b5, points_redeem: 50 }, cartTok: cart5, custTok: cust.custTok, idem: key }); // khác điểm
  r5c.status === 422 ? ok('cùng key + KHÁC số điểm → 422 (request_hash gồm pointsRedeem)') : bad('không chặn key-khác-điểm', r5c.status);

  sect('6. CHỐNG FARMING: earn tính trên net SAU trừ điểm (không redeem→earn vòng lặp)');
  await seedBalance(A.shopId, cust.id, 400);
  r = await order({ custTok: cust.custTok, redeem: 300 }); // giảm 30.000 → net = 100.000 − 30.000 = 70.000
  o = await orderRow(A.shopId, r.json.order_number);
  await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${o.id}/mark-paid`, { cookie: A.oc, origin: OS });
  await owner.query(`UPDATE orders SET paid_at = now() - interval '1 day' WHERE id=$1`, [o.id]);
  await fetch(`${WORKER}/internal/loyalty-earn-sweep`, { method: 'POST' }).then((x) => x.json());
  const earnDelta = N((await owner.query(`SELECT delta FROM loyalty_ledger WHERE shop_id=$1 AND order_id=$2 AND kind='earn'`, [A.shopId, o.id])).rows[0]?.delta);
  earnDelta === Math.floor((N(o.subtotal_vnd) - N(o.discount_vnd) - N(o.points_discount_vnd)) / 1000) * 1 && earnDelta === 70
    ? ok(`đơn đổi 300 điểm → chỉ tích 70 điểm (trên net 70.000, KHÔNG 100)`) : bad('farming: tích trên gộp', `earn=${earnDelta}`);

  sect('7. Điểm TẮT (config disabled) → không đổi dù có số dư');
  await setCfg(A.shopId, { enabled: false });
  await seedBalance(A.shopId, cust.id, 500);
  r = await order({ custTok: cust.custTok, redeem: 300 });
  o = await orderRow(A.shopId, r.json.order_number);
  N(o.points_redeemed) === 0 && N(await balOf(A.shopId, cust.id)) === 500
    ? ok('config tắt → không đổi (số dư giữ nguyên)') : bad('tắt vẫn đổi', JSON.stringify(o));

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
