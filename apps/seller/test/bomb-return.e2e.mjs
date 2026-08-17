// E2E: BOM HÀNG / HOÀN VỀ đơn ĐANG GIAO (audit sẵn-sàng #58). Vá 2 lỗ: đơn tách-vận-đơn bỏ dở →
// reserve phần chưa gửi kẹt; đơn giao-tay/hãng bị bom → kẹt 'shipped' (RMA đòi delivered). mark-returned:
// RESTOCK phần đã gửi (on_hand + ledger receive) + NHẢ reserve phần chưa gửi + status=returned.
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = 'http://auth:3020', PLATFORM = 'http://platform:3030', SELLER = 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const CO = new URL('http://checkout:3060');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 5 });
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  PASS ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? ' :: ' + String(d).slice(0, 200) : '')); };
const sect = (m) => console.log('\n# ' + m);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };
const N = (x) => Number(x);
async function rq(base, method, path, { body, cookie, origin } = {}) {
  const h = {}; if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin; if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
async function adm(method, path, { cookie, form } = {}) {
  const h = { origin: OADM };
  if (form !== undefined) h['content-type'] = 'application/x-www-form-urlencoded';
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(ADMIN + path, { method, headers: h, redirect: 'manual', body: form !== undefined ? String(form) : undefined });
  return { status: r.status, body: await r.text(), sc: r.headers.getSetCookie() };
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
      let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => { let tok = cartCookie; for (const c of rs.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) tok = m[1]; } resolve({ status: rs.statusCode, cartCookie: tok }); });
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
async function inviteOrderManager(shopId, ownerCookie) {
  const email = `order-manager-${uniq()}@shop.vn`, password = 'order manager passphrase';
  const r = await rq(SELLER, 'POST', `/shops/${shopId}/members/invite`, {
    body: { email, role: 'order_manager' }, cookie: ownerCookie, origin: OS,
  });
  if (r.status !== 201) throw new Error(`mời order_manager lỗi: ${r.raw}`);
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  const api = await login(email, password);
  const ui = ck((await adm('POST', '/login', { form: new URLSearchParams({ email, password }) })).sc);
  return { api, ui };
}
const onHand = async (vid) => N((await owner.query('SELECT on_hand FROM inventory_levels WHERE variant_id=$1', [vid])).rows[0].on_hand);
const reserved = async (vid) => N((await owner.query('SELECT reserved FROM inventory_levels WHERE variant_id=$1', [vid])).rows[0].reserved);
const statusOf = async (id) => (await owner.query('SELECT status FROM orders WHERE id=$1', [id])).rows[0].status;

async function main() {
  const staff = await makeStaff();
  const slug = `bomb-${uniq()}`;
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
  const shopId = r.json.id; HOST = `${slug}.nentang.vn`;
  await owner.query(`UPDATE shops SET status='active', went_live_at=now() WHERE id=$1`, [shopId]);
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  const oc = await login(oe, op);
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: op }, cookie: oc, origin: OA });
  const om = await inviteOrderManager(shopId, oc);
  const p = await rq(SELLER, 'POST', `/shops/${shopId}/products`, { body: { title: 'A', slug: `sp-${uniq()}`, price_vnd: 100000, status: 'active', variants: [{ sku: `A-${uniq()}`, price_vnd: 100000 }] }, cookie: oc, origin: OS });
  const A = (await rq(SELLER, 'GET', `/shops/${shopId}/products/${p.json.id}`, { cookie: oc })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${shopId}/variants/${A}/inventory/adjust`, { body: { delta: 20, reason: 'nhập' }, cookie: oc, origin: OS });
  const order = async (qty) => {
    const cart = (await co('POST', '/cart/items', { json: { variant_id: A, qty } })).cartCookie;
    await co('POST', '/checkout', { json: { customer: { name: 'K', phone: '0912000111', email: `kh-${uniq()}@mail.vn` }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' }, cartCookie: cart, idem: `s-${uniq()}` });
    const id = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 1`, [shopId])).rows[0].id;
    await rq(SELLER, 'POST', `/shops/${shopId}/orders/${id}/confirm`, { cookie: oc, origin: OS });
    const olA = (await rq(SELLER, 'GET', `/shops/${shopId}/orders/${id}`, { cookie: oc })).json.lines[0].order_line_id;
    return { id, olA };
  };
  const ship = (id, olA, qty) => rq(SELLER, 'POST', `/shops/${shopId}/orders/${id}/ship`, { body: { tracking_number: 'T' + uniq(), lines: [{ order_line_id: olA, qty }] }, cookie: oc, origin: OS });
  const ledgerReceive = async (num) => N((await owner.query(`SELECT coalesce(sum(delta),0) s FROM inventory_ledger WHERE variant_id=$1 AND kind='receive' AND reason LIKE $2`, [A, `%đơn #${num}%`])).rows[0].s);

  sect('1. TÁCH bỏ dở + bom: giao 2/3 rồi bom → restock 2 đã gửi + NHẢ reserve 1 chưa gửi + returned');
  const oh0 = await onHand(A); // 20
  const o1 = await order(3); // reserved +3 = 3
  await ship(o1.id, o1.olA, 2); // shipped 2 → on_hand 18, reserved 1 (còn 1 chưa gửi)
  const ohShip = await onHand(A), resShip = await reserved(A);
  const managerPage = await adm('GET', `/shops/${shopId}/orders/${o1.id}`, { cookie: om.ui });
  managerPage.status === 200 && managerPage.body.includes(`/orders/${o1.id}/mark-returned`) && /name="restock"[^>]*checked/.test(managerPage.body)
    ? ok('order_manager thấy nút Bom hàng và ô chọn nhập lại kho') : bad('order_manager thiếu thao tác hoàn về', managerPage.status);
  const deltaBefore = (await owner.query(`
    SELECT
      (SELECT count(*)::int FROM inventory_ledger WHERE shop_id=$1) AS ledger,
      (SELECT count(*)::int FROM audit_logs WHERE shop_id=$1 AND action='order.returned_bomb') AS audit,
      (SELECT count(*)::int FROM order_events WHERE shop_id=$1 AND order_id=$2 AND event_type='shipment.returned') AS events,
      (SELECT count(*)::int FROM outbox WHERE shop_id=$1 AND payload->>'order_id'=$2::text) AS outbox
  `, [shopId, o1.id])).rows[0];
  r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o1.id}/mark-returned`, { body: { reason: 'khách bom' }, cookie: om.api, origin: OS });
  const num1 = N((await owner.query(`SELECT order_number FROM orders WHERE id=$1`, [o1.id])).rows[0].order_number);
  const deltaAfter = (await owner.query(`
    SELECT
      (SELECT count(*)::int FROM inventory_ledger WHERE shop_id=$1) AS ledger,
      (SELECT count(*)::int FROM audit_logs WHERE shop_id=$1 AND action='order.returned_bomb') AS audit,
      (SELECT count(*)::int FROM order_events WHERE shop_id=$1 AND order_id=$2 AND event_type='shipment.returned') AS events,
      (SELECT count(*)::int FROM outbox WHERE shop_id=$1 AND payload->>'order_id'=$2::text) AS outbox
  `, [shopId, o1.id])).rows[0];
  r.status === 200 && await statusOf(o1.id) === 'returned' && await onHand(A) === oh0 && await reserved(A) === 0 && await ledgerReceive(num1) === 2
    && N(deltaAfter.ledger) - N(deltaBefore.ledger) === 1
    && N(deltaAfter.audit) - N(deltaBefore.audit) === 1
    && N(deltaAfter.events) - N(deltaBefore.events) === 1
    && N(deltaAfter.outbox) - N(deltaBefore.outbox) === 1
    ? ok(`giao 2/3 (on_hand ${ohShip} reserved ${resShip}) → bom: on_hand về ${oh0} (restock 2), reserved 0 (nhả 1 chưa gửi), ledger receive 2, returned`)
    : bad('bom tách bỏ dở sai', `st=${await statusOf(o1.id)} oh=${await onHand(A)}(kv ${oh0}) res=${await reserved(A)} led=${await ledgerReceive(num1)}`);
  const replayBefore = { onHand: await onHand(A), reserved: await reserved(A), ...deltaAfter };
  const replay = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o1.id}/mark-returned`, { body: { reason: 'bấm lặp', restock: true }, cookie: om.api, origin: OS });
  const replayAfter = (await owner.query(`
    SELECT
      (SELECT count(*)::int FROM inventory_ledger WHERE shop_id=$1) AS ledger,
      (SELECT count(*)::int FROM audit_logs WHERE shop_id=$1 AND action='order.returned_bomb') AS audit,
      (SELECT count(*)::int FROM order_events WHERE shop_id=$1 AND order_id=$2 AND event_type='shipment.returned') AS events,
      (SELECT count(*)::int FROM outbox WHERE shop_id=$1 AND payload->>'order_id'=$2::text) AS outbox
  `, [shopId, o1.id])).rows[0];
  replay.status === 409 && replay.json?.error_code === 'order_already_returned'
    && await onHand(A) === replayBefore.onHand && await reserved(A) === replayBefore.reserved
    && ['ledger', 'audit', 'events', 'outbox'].every((k) => N(replayAfter[k]) === N(replayBefore[k]))
    ? ok('bấm lặp mark-returned → lỗi rõ, mọi delta tiền/tồn/audit/outbox bằng 0')
    : bad('mark-returned replay tạo tác dụng phụ', `${replay.raw} ${JSON.stringify({ replayBefore, replayAfter })}`);

  sect('2. Gate: mark-returned đơn CHƯA giao (confirmed) → 409');
  const o2 = await order(2);
  r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o2.id}/mark-returned`, { cookie: oc, origin: OS });
  const res2 = await reserved(A);
  r.status === 409 && await statusOf(o2.id) === 'confirmed' ? ok('đơn confirmed → 409 (chỉ hoàn-về đơn shipped)') : bad('gate sai', `${r.status} st=${await statusOf(o2.id)}`);
  // dọn: giao rồi bom để trả reserve o2 (giữ tồn sạch cho case 3)
  await ship(o2.id, o2.olA, 2);
  await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o2.id}/mark-returned`, { cookie: oc, origin: OS });

  sect('3. restock=false: hàng bom HỎNG → KHÔNG nhập lại (on_hand giữ thấp) nhưng vẫn nhả reserve + returned');
  const oh3 = await onHand(A);
  const o3 = await order(2);
  await ship(o3.id, o3.olA, 2); // full ship → on_hand oh3-2, reserved 0
  const ohShip3 = await onHand(A);
  r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o3.id}/mark-returned`, { body: { restock: false, reason: 'hàng hỏng' }, cookie: oc, origin: OS });
  r.status === 200 && await statusOf(o3.id) === 'returned' && await onHand(A) === ohShip3
    ? ok(`restock=false → on_hand GIỮ ${ohShip3} (ghi nhận mất, không nhập lại), returned`) : bad('restock=false sai', `oh=${await onHand(A)}(kv ${ohShip3}) st=${await statusOf(o3.id)}`);

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
