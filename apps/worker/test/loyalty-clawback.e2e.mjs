// E2E: THU HỒI / HOÀN ĐIỂM khi đơn terminal (0086 commit 3). Kiểm: reversal hoàn điểm đã đổi
// (ĐỘC LẬP paid_at — đơn chưa-trả bị huỷ vẫn hoàn); clawback thu hồi điểm đã tích (full, có thể
// đẩy số dư ÂM = nợ); vòng earn→spend→refund tạo nợ + earn sau bù nợ + redeem bị chặn khi nợ;
// idempotent (sweep đè không double); partial-refund (status còn delivered) KHÔNG đụng điểm.
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
  const slug = `claw-${uniq()}`;
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
const setCfg = (shopId, { rate = 1, redeem = 100, vesting = 0, pct = 50 } = {}) => owner.query(
  `INSERT INTO shop_loyalty_config (shop_id, enabled, earn_points_per_1000, redeem_vnd_per_point, earn_vesting_days, max_redeem_pct)
   VALUES ($1,true,$2,$3,$4,$5) ON CONFLICT (shop_id) DO UPDATE SET enabled=true, earn_points_per_1000=$2, redeem_vnd_per_point=$3, earn_vesting_days=$4, max_redeem_pct=$5, updated_at=now()`,
  [shopId, rate, redeem, vesting, pct]);
const seedBalance = (shopId, cid, pts) => owner.query(
  `INSERT INTO loyalty_balances (shop_id, customer_id, balance_points) VALUES ($1,$2,$3)
   ON CONFLICT (shop_id,customer_id) DO UPDATE SET balance_points=$3, updated_at=now()`, [shopId, cid, pts]);
const balOf = async (shopId, cid) => N((await owner.query(`SELECT balance_points FROM loyalty_balances WHERE shop_id=$1 AND customer_id=$2`, [shopId, cid])).rows[0]?.balance_points ?? 0);
const kinds = async (shopId, oid) => (await owner.query(`SELECT kind, delta FROM loyalty_ledger WHERE shop_id=$1 AND order_id=$2 ORDER BY id`, [shopId, oid])).rows.map((r) => `${r.kind}:${N(r.delta)}`);
const setStatus = (oid, st) => owner.query(`UPDATE orders SET status=$2 WHERE id=$1`, [oid, st]);
const earnSweep = () => fetch(`${WORKER}/internal/loyalty-earn-sweep`, { method: 'POST' }).then((r) => r.json());
const clawSweep = () => fetch(`${WORKER}/internal/loyalty-clawback-sweep`, { method: 'POST' }).then((r) => r.json());

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
  const oidOf = async (num) => (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2`, [A.shopId, num])).rows[0].id;
  async function order({ custTok, redeem } = {}) {
    let cart = (await co(A.host, 'POST', '/cart/items', { json: { variant_id: V, qty: 1 } })).cartTok;
    const body = { customer: { name: 'KH', phone: '0911222333' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' };
    if (redeem != null) body.points_redeem = redeem;
    const r = await co(A.host, 'POST', '/checkout', { json: body, cartTok: cart, custTok, idem: `c-${uniq()}` });
    return oidOf(r.json.order_number);
  }
  // Đơn ĐÃ TÍCH điểm: đặt (không đổi) → mark-paid → lùi paid_at → earn sweep.
  async function earnedOrder(custTok) {
    const oid = await order({ custTok });
    await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${oid}/mark-paid`, { cookie: A.oc, origin: OS });
    await owner.query(`UPDATE orders SET paid_at = now() - interval '1 day' WHERE id=$1`, [oid]);
    await earnSweep();
    return oid;
  }

  await setCfg(A.shopId, { rate: 1, redeem: 100, vesting: 0, pct: 50 });
  ok('dựng shop + SP + bật điểm');

  sect('1. REVERSAL: hoàn điểm đã đổi khi đơn HUỶ — ĐỘC LẬP paid_at (đơn chưa trả)');
  const cust1 = await makeCustomer(A.host, A.shopId);
  await seedBalance(A.shopId, cust1.id, 500);
  const o1 = await order({ custTok: cust1.custTok, redeem: 200 }); // COD pending (chưa trả), đổi 200
  N(await balOf(A.shopId, cust1.id)) === 300 ? ok('đổi 200 → số dư 500→300') : bad('đổi sai', await balOf(A.shopId, cust1.id));
  await setStatus(o1, 'cancelled'); // huỷ đơn CHƯA thanh toán (paid_at NULL)
  let sw = await clawSweep();
  (await kinds(A.shopId, o1)).includes('reversal:200') && N(await balOf(A.shopId, cust1.id)) === 500
    ? ok('huỷ đơn chưa-trả có đổi điểm → reversal +200 (số dư về 500)') : bad('reversal không chạy', `${JSON.stringify(await kinds(A.shopId, o1))} bal=${await balOf(A.shopId, cust1.id)} sw=${JSON.stringify(sw)}`);

  sect('2. CLAWBACK: thu hồi điểm đã tích khi đơn HOÀN toàn bộ');
  const cust2 = await makeCustomer(A.host, A.shopId);
  const o2 = await earnedOrder(cust2.custTok); // tích 100
  N(await balOf(A.shopId, cust2.id)) === 100 ? ok('đơn paid+vested → tích 100') : bad('không tích', await balOf(A.shopId, cust2.id));
  await setStatus(o2, 'refunded');
  await clawSweep();
  (await kinds(A.shopId, o2)).includes('clawback:-100') && N(await balOf(A.shopId, cust2.id)) === 0
    ? ok('đơn refunded → clawback -100 (số dư về 0)') : bad('clawback không chạy', `${JSON.stringify(await kinds(A.shopId, o2))} bal=${await balOf(A.shopId, cust2.id)}`);

  sect('3. NỢ điểm: earn→tiêu-đơn-khác→hoàn-đơn-nguồn → số dư ÂM, earn sau bù nợ, redeem chặn');
  const cust3 = await makeCustomer(A.host, A.shopId);
  const oA = await earnedOrder(cust3.custTok); // A tích 100 → balance 100
  const oB = await order({ custTok: cust3.custTok, redeem: 100 }); // tiêu 100 sang đơn B → balance 0
  N(await balOf(A.shopId, cust3.id)) === 0 ? ok('earn 100 (A) rồi tiêu 100 (B) → số dư 0') : bad('sai số dư trước hoàn', await balOf(A.shopId, cust3.id));
  await setStatus(oA, 'refunded'); // hoàn đơn nguồn A (điểm đã tiêu sang B)
  await clawSweep();
  N(await balOf(A.shopId, cust3.id)) === -100 ? ok('hoàn A → clawback -100 → số dư -100 (NỢ điểm)') : bad('nợ không ghi', await balOf(A.shopId, cust3.id));
  // Redeem bị chặn khi đang nợ.
  const oC = await order({ custTok: cust3.custTok, redeem: 50 });
  N((await owner.query(`SELECT points_redeemed FROM orders WHERE id=$1`, [oC])).rows[0].points_redeemed) === 0
    ? ok('đang nợ (-100) → redeem bị chặn (points_redeemed=0, không tiêu vào nợ)') : bad('tiêu được khi nợ');
  // Earn tương lai bù nợ.
  const oD = await earnedOrder(cust3.custTok); // tích 100 → -100 + 100 = 0
  N(await balOf(A.shopId, cust3.id)) === 0 ? ok('earn 100 sau đó → bù nợ (-100 → 0)') : bad('earn không bù nợ', await balOf(A.shopId, cust3.id));

  sect('4. Idempotent: clawback sweep chạy lại KHÔNG double');
  await clawSweep(); await clawSweep();
  const dupR = (await owner.query(`SELECT count(*)::int n FROM loyalty_ledger WHERE order_id=$1 AND kind='reversal'`, [o1])).rows[0].n;
  const dupC = (await owner.query(`SELECT count(*)::int n FROM loyalty_ledger WHERE order_id=$1 AND kind='clawback'`, [o2])).rows[0].n;
  dupR === 1 && dupC === 1 ? ok('reversal + clawback vẫn ĐÚNG 1 dòng/đơn sau nhiều sweep') : bad('double clawback/reversal', `R=${dupR} C=${dupC}`);

  sect('5. PARTIAL refund (đơn còn delivered) KHÔNG đụng điểm (v1)');
  const cust5 = await makeCustomer(A.host, A.shopId);
  const o5 = await earnedOrder(cust5.custTok); // tích 100
  await setStatus(o5, 'delivered'); // KHÔNG terminal (giao một phần / hoàn một phần)
  const balBefore = await balOf(A.shopId, cust5.id);
  await clawSweep();
  N(await balOf(A.shopId, cust5.id)) === balBefore && !(await kinds(A.shopId, o5)).some((k) => k.startsWith('clawback'))
    ? ok('đơn delivered (partial) → KHÔNG clawback (giữ điểm, v1)') : bad('partial vẫn clawback', await kinds(A.shopId, o5));

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
