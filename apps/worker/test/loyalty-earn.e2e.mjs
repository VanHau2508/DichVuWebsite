// E2E: TÍCH ĐIỂM THƯỞNG (0086) — worker sweep tích điểm. Kiểm đường tồn-tiền của điểm:
//   earn = floor(net_hàng/1000)×rate (LOẠI ship + points_discount); vesting (đơn paid < N ngày
//   CHƯA tích); idempotent (chạy đè không double); guest/đơn-huỷ KHÔNG tích; balance==Σledger;
//   RLS 2 trục (khách A không đọc số dư khách B); append-only (app_loyalty không UPDATE/DELETE).
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
const custDb = new pg.Pool({ connectionString: process.env.DATABASE_URL_CUSTOMER, max: 2 });
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
function acc(host, method, path, { form, cookie, origin } = {}) {
  return new Promise((resolve, reject) => {
    const data = form !== undefined ? new URLSearchParams(form).toString() : null;
    const headers = { host };
    if (data != null) { headers['content-type'] = 'application/x-www-form-urlencoded'; headers['content-length'] = Buffer.byteLength(data); }
    if (origin) headers.origin = origin;
    if (cookie) headers.cookie = `__Host-cust_session=${cookie}`;
    const req = http.request({ hostname: ACC.hostname, port: ACC.port, path, method, headers }, (rs) => {
      let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => {
        let tok = null; for (const c of rs.headers['set-cookie'] ?? []) { const m = /^__Host-cust_session=([^;]*)/.exec(c); if (m) tok = m[1]; }
        resolve({ status: rs.statusCode, body: b, setTok: tok });
      });
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
  const slug = `loy-${uniq()}`;
  const shopId = (await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO })).json.id;
  await owner.query(`UPDATE shops SET status='active', went_live_at=now() WHERE id=$1`, [shopId]);
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  return { shopId, host: `${slug}.nentang.vn`, oc: await login(oe, op), op };
}
async function makeCustomer(host, shopId) {
  const email = `kh-${uniq()}@mail.vn`, pw = 'khach manh 2026 xyz';
  await acc(host, 'POST', '/account/register', { origin: `https://${host}`, form: { email, password: pw, full_name: 'KH' } });
  const lg = await acc(host, 'POST', '/account/login', { origin: `https://${host}`, form: { email, password: pw } });
  const id = (await owner.query(`SELECT id FROM customers WHERE shop_id=$1 AND lower(email)=lower($2)`, [shopId, email])).rows[0]?.id;
  return { email, custTok: lg.setTok, id };
}
// Bật/chỉnh cấu hình điểm (PUT endpoint là commit sau — fixture ghi thẳng DB).
const setCfg = (shopId, { rate = 1, redeem = 100, vesting = 0 } = {}) => owner.query(
  `INSERT INTO shop_loyalty_config (shop_id, enabled, earn_points_per_1000, redeem_vnd_per_point, earn_vesting_days)
   VALUES ($1, true, $2, $3, $4)
   ON CONFLICT (shop_id) DO UPDATE SET enabled=true, earn_points_per_1000=$2, redeem_vnd_per_point=$3, earn_vesting_days=$4, updated_at=now()`,
  [shopId, rate, redeem, vesting]);
const earnSweep = () => fetch(`${WORKER}/internal/loyalty-earn-sweep`, { method: 'POST' }).then((r) => r.json());
const balOf = async (shopId, cid) => N((await owner.query(`SELECT balance_points FROM loyalty_balances WHERE shop_id=$1 AND customer_id=$2`, [shopId, cid])).rows[0]?.balance_points ?? 0);
const ledgerOf = async (shopId, cid) => (await owner.query(`SELECT kind, delta, order_id FROM loyalty_ledger WHERE shop_id=$1 AND customer_id=$2 ORDER BY id`, [shopId, cid])).rows.map((r) => ({ kind: r.kind, delta: N(r.delta) }));
// Chạy SELECT dưới vai app_customer với GUC 2 trục (kiểm RLS thật).
async function asCustomer(shopId, cid, sql, params) {
  const c = await custDb.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.shop_id',$1,true)`, [shopId]);
    await c.query(`SELECT set_config('app.customer_id',$1,true)`, [cid]);
    return (await c.query(sql, params)).rows;
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff);
  const mk = async (title, price, stock) => {
    const p = await rq(SELLER, 'POST', `/shops/${A.shopId}/products`, { body: { title, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `${title}-${uniq()}`, price_vnd: price }] }, cookie: A.oc, origin: OS });
    if (!p.json?.id) throw new Error(`product create ${p.status}: ${p.raw}`);
    const vid = (await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${p.json.id}`, { cookie: A.oc })).json.variants[0].id;
    await rq(SELLER, 'POST', `/shops/${A.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: A.oc, origin: OS });
    return vid;
  };
  const V = await mk('SP', 100000, 100);
  const orderRow = async (num) => (await owner.query(`SELECT id, customer_id, subtotal_vnd, shipping_vnd, status FROM orders WHERE shop_id=$1 AND order_number=$2`, [A.shopId, num])).rows[0];
  // Đặt đơn (tuỳ chọn đăng nhập) rồi mark-paid → paid_at set.
  async function paidOrder(custTok, qty = 1) {
    let cart = (await co(A.host, 'POST', '/cart/items', { json: { variant_id: V, qty } })).cartTok;
    const r = await co(A.host, 'POST', '/checkout', { json: { customer: { name: 'KH', phone: '0911222333', email: 'kh@x.vn' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' }, cartTok: cart, custTok, idem: `l-${uniq()}` });
    if (!r.json?.order_number) { bad('đặt đơn lỗi', r.body); return null; }
    const o = await orderRow(r.json.order_number);
    await rq(AUTH, 'POST', '/auth/step-up', { body: { password: A.op }, cookie: A.oc, origin: OA });
    await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${o.id}/mark-paid`, { cookie: A.oc, origin: OS });
    return o;
  }

  const cust = await makeCustomer(A.host, A.shopId);
  cust.id && cust.custTok ? ok('dựng shop + SP + khách đăng nhập') : bad('setup lỗi', JSON.stringify(cust));

  sect('1. Tích điểm cơ bản: earn = floor(subtotal/1000)×rate, balance == Σledger');
  await setCfg(A.shopId, { rate: 1, vesting: 0 });
  const o1 = await paidOrder(cust.custTok, 1); // subtotal 100.000 → 100 điểm
  N(o1?.customer_id) === null ? bad('đơn KHÔNG gắn customer_id (khách chưa được stamp)', o1?.customer_id) : ok('đơn gắn customer_id (khách đăng nhập)');
  let sw = await earnSweep();
  const bal1 = await balOf(A.shopId, cust.id), led1 = await ledgerOf(A.shopId, cust.id);
  bal1 === 100 && led1.length === 1 && led1[0].kind === 'earn' && led1[0].delta === 100
    ? ok(`tích 100 điểm (đơn 100.000đ, rate 1/1000), 1 dòng ledger earn`) : bad('tích điểm sai', `bal=${bal1} ledger=${JSON.stringify(led1)} sweep=${JSON.stringify(sw)}`);

  sect('2. Idempotent: chạy sweep lại KHÔNG tích đúp');
  sw = await earnSweep();
  const bal2 = await balOf(A.shopId, cust.id);
  bal2 === 100 && (await ledgerOf(A.shopId, cust.id)).length === 1 ? ok('sweep lần 2 → vẫn 100 điểm (idempotent)') : bad('tích đúp', `bal=${bal2}`);

  sect('3. VESTING: đơn paid < N ngày CHƯA tích, đủ ngày mới tích');
  await setCfg(A.shopId, { rate: 1, vesting: 1 }); // cần paid ≥ 1 ngày
  const o3 = await paidOrder(cust.custTok, 1); // paid vừa xong → chưa đủ vesting
  await earnSweep();
  const led3 = await ledgerOf(A.shopId, cust.id);
  led3.filter((x) => x.kind === 'earn').length === 1 ? ok('đơn mới paid + vesting 1 ngày → CHƯA tích (điểm cũ giữ nguyên)') : bad('vesting không chặn', JSON.stringify(led3));
  // Lùi paid_at 2 ngày → đủ vesting → tích.
  await owner.query(`UPDATE orders SET paid_at = now() - interval '2 days' WHERE id=$1`, [o3.id]);
  await earnSweep();
  (await balOf(A.shopId, cust.id)) === 200 ? ok('lùi paid_at qua vesting → tích thêm 100 (tổng 200)') : bad('vesting không mở', await balOf(A.shopId, cust.id));
  await setCfg(A.shopId, { rate: 1, vesting: 0 });

  sect('4. Cơ số tích LOẠI ship (net hàng), không tính phí vận chuyển');
  // Đơn có ship: subtotal hàng 100.000 + ship. earn phải theo 100.000 (=100), KHÔNG gồm ship.
  const o4 = await paidOrder(cust.custTok, 1);
  const shipOnO4 = N(o4.shipping_vnd);
  await earnSweep();
  const earnRows = (await owner.query(`SELECT delta FROM loyalty_ledger WHERE shop_id=$1 AND order_id=$2 AND kind='earn'`, [A.shopId, o4.id])).rows;
  N(earnRows[0]?.delta) === Math.floor(N(o4.subtotal_vnd) / 1000) * 1
    ? ok(`tích theo net hàng ${N(o4.subtotal_vnd)}đ = ${earnRows[0].delta}đ điểm (ship ${shipOnO4}đ KHÔNG tính)`) : bad('cơ số tích sai (gồm ship?)', `delta=${earnRows[0]?.delta} sub=${o4.subtotal_vnd} ship=${shipOnO4}`);

  sect('5. Guest (không đăng nhập) KHÔNG tích điểm');
  const oG = await paidOrder(null, 1);
  N(oG.customer_id) === null ? ok('đơn guest customer_id NULL') : bad('guest có customer_id?', oG.customer_id);
  await earnSweep();
  (await owner.query(`SELECT count(*)::int n FROM loyalty_ledger WHERE shop_id=$1 AND order_id=$2`, [A.shopId, oG.id])).rows[0].n === 0
    ? ok('đơn guest → KHÔNG có bút toán điểm') : bad('guest vẫn tích điểm');

  sect('6. Đơn HUỶ (terminal) KHÔNG tích điểm');
  const oC = await paidOrder(cust.custTok, 1);
  await owner.query(`UPDATE orders SET status='cancelled', cancelled_at=now() WHERE id=$1`, [oC.id]);
  const balBefore = await balOf(A.shopId, cust.id);
  await earnSweep();
  (await balOf(A.shopId, cust.id)) === balBefore ? ok('đơn cancelled → KHÔNG tích (số dư không đổi)') : bad('đơn huỷ vẫn tích', await balOf(A.shopId, cust.id));

  sect('7. RLS 2 trục: khách B KHÔNG đọc được số dư/sổ điểm khách A');
  const custB = await makeCustomer(A.host, A.shopId);
  const aSeesOwn = await asCustomer(A.shopId, cust.id, `SELECT balance_points FROM loyalty_balances`, []);
  const bSeesA = await asCustomer(A.shopId, custB.id, `SELECT balance_points FROM loyalty_balances`, []);
  aSeesOwn.length === 1 && N(aSeesOwn[0].balance_points) > 0 ? ok('khách A đọc ĐÚNG số dư của mình') : bad('A không đọc được số dư mình', JSON.stringify(aSeesOwn));
  bSeesA.length === 0 ? ok('khách B đọc loyalty_balances → 0 dòng (KHÔNG thấy A — RLS 2 trục)') : bad('B thấy số dư A (rò RLS)', JSON.stringify(bSeesA));
  const bSeesLedgerA = await asCustomer(A.shopId, custB.id, `SELECT count(*)::int n FROM loyalty_ledger WHERE customer_id=$1`, [cust.id]);
  N(bSeesLedgerA[0].n) === 0 ? ok('khách B đọc sổ điểm của A → 0 dòng (RLS chặn dù WHERE customer_id=A)') : bad('B đọc được sổ A', JSON.stringify(bSeesLedgerA));

  sect('8. Append-only: app_customer/app_loyalty KHÔNG sửa/xoá được loyalty_ledger');
  let blocked = 0;
  for (const role of ['app_customer', 'app_loyalty']) {
    const r = await owner.query(`SELECT has_table_privilege($1,'loyalty_ledger','UPDATE') u, has_table_privilege($1,'loyalty_ledger','DELETE') d`, [role]);
    if (!r.rows[0].u && !r.rows[0].d) blocked++;
  }
  blocked === 2 ? ok('app_customer + app_loyalty: KHÔNG UPDATE/DELETE loyalty_ledger') : bad('sổ điểm sửa được', blocked);

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end(); await custDb.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
