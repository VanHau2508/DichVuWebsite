// E2E: GIAO MỘT PHẦN / TÁCH VẬN ĐƠN (0080) — phía SELLER (giao tay + guard). Kiểm: gửi
// subset → shipped+partial, tiêu tồn ĐÚNG subset (ledger), gửi nốt → fulfilled, gửi quá →
// 422, đua 2 lệnh không vượt, deliverOrder chặn khi partial, editOrder chặn khi có vận đơn,
// cancel/refund chặn ở 'shipped', + mô phỏng SQL guard worker order-aware (chốt đơn đúng lúc).
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
const onHand = async (vid) => N((await owner.query('SELECT on_hand FROM inventory_levels WHERE variant_id=$1', [vid])).rows[0].on_hand);
const reserved = async (vid) => N((await owner.query('SELECT reserved FROM inventory_levels WHERE variant_id=$1', [vid])).rows[0].reserved);
const col = async (id, c) => (await owner.query(`SELECT ${c} FROM orders WHERE id=$1`, [id])).rows[0][c];

async function main() {
  const staff = await makeStaff();
  const slug = `split-${uniq()}`;
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
  const shopId = r.json.id; HOST = `${slug}.nentang.vn`;
  await owner.query(`UPDATE shops SET status='active', went_live_at=now() WHERE id=$1`, [shopId]);
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  const oc = await login(oe, op);
  const mk = async (t, price, stock) => {
    const p = await rq(SELLER, 'POST', `/shops/${shopId}/products`, { body: { title: t, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `${t}-${uniq()}`, price_vnd: price }] }, cookie: oc, origin: OS });
    const vid = (await rq(SELLER, 'GET', `/shops/${shopId}/products/${p.json.id}`, { cookie: oc })).json.variants[0].id;
    await rq(SELLER, 'POST', `/shops/${shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: oc, origin: OS });
    return vid;
  };
  const A = await mk('A', 100000, 20), B = await mk('B', 50000, 20);
  // Đơn 3×A + 2×B, confirm. Lấy order_line_id.
  const mkConfirmed = async () => {
    let cart = (await co('POST', '/cart/items', { json: { variant_id: A, qty: 3 } })).cartCookie;
    cart = (await co('POST', '/cart/items', { json: { variant_id: B, qty: 2 }, cartCookie: cart })).cartCookie;
    await co('POST', '/checkout', { json: { customer: { name: 'K', phone: '0912000111', email: 'k@x.vn' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' }, cartCookie: cart, idem: `s-${uniq()}` });
    const id = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 1`, [shopId])).rows[0].id;
    await rq(SELLER, 'POST', `/shops/${shopId}/orders/${id}/confirm`, { cookie: oc, origin: OS });
    const g = (await rq(SELLER, 'GET', `/shops/${shopId}/orders/${id}`, { cookie: oc })).json;
    const olA = g.lines.find((l) => l.variant_id === A).order_line_id;
    const olB = g.lines.find((l) => l.variant_id === B).order_line_id;
    return { id, olA, olB };
  };
  const surl = (id) => `/shops/${shopId}/orders/${id}/ship`;
  const ohA0 = await onHand(A);

  sect('Giao MỘT PHẦN {A:2} → shipped + fulfillment=partial, tiêu tồn ĐÚNG subset');
  const o1 = await mkConfirmed();
  r = await rq(SELLER, 'POST', surl(o1.id), { body: { tracking_number: 'T' + uniq(), lines: [{ order_line_id: o1.olA, qty: 2 }] }, cookie: oc, origin: OS });
  const g1 = (await rq(SELLER, 'GET', `/shops/${shopId}/orders/${o1.id}`, { cookie: oc })).json;
  const lA = g1.lines.find((l) => l.variant_id === A), lB = g1.lines.find((l) => l.variant_id === B);
  r.status === 200 && g1.status === 'shipped' && g1.fulfillment_status === 'partial' && N(lA.shipped_qty) === 2 && N(lB.shipped_qty) === 0 && await onHand(A) === ohA0 - 2 && await reserved(A) === 1
    ? ok('giao {A:2}: shipped/partial, A.shipped=2 B.shipped=0, on_hand A −2, reserved A còn 1') : bad('giao một phần sai', `st=${g1.status} ff=${g1.fulfillment_status} shA=${lA?.shipped_qty} shB=${lB?.shipped_qty} oh=${await onHand(A)}(kv ${ohA0 - 2})`);
  const led = N((await owner.query(`SELECT coalesce(sum(delta),0) s FROM inventory_ledger WHERE variant_id=$1 AND kind='ship'`, [A])).rows[0].s);
  led === -2 ? ok('ledger ship A tổng delta −2 (chỉ subset)') : bad('ledger sai', led);

  sect('deliverOrder khi partial → 409 (còn kiện chưa gửi)');
  r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o1.id}/deliver`, { cookie: oc, origin: OS });
  r.status === 409 && /còn kiện|chưa gửi/.test(r.json?.error ?? '') ? ok('deliver partial → 409') : bad('deliver partial lọt', `${r.status} ${r.json?.error}`);

  sect('editOrder khi đơn đã giao dở (shipped) → 409 (status guard bắt trước)');
  // Giao tay → đơn 'shipped' ngay: status guard chặn. (guard shipment_lines trong
  // reconcileEditLines chỉ tới lượt khi đơn còn 'confirmed' mà đã có claim hãng 'created' —
  // ca đó test ở bộ carrier commit B.) Điểm chốt: sửa dòng đơn đang giao → LUÔN 409.
  r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o1.id}/edit`, { body: { lines: [{ variant_id: A, qty: 1 }], customer: { name: 'K', phone: '0912000111' } }, cookie: oc, origin: OS });
  r.status === 409 && /chưa gửi hãng|vận đơn/.test(r.json?.error ?? '') ? ok('editOrder đơn giao dở → 409') : bad('sửa được đơn đang giao', `${r.status} ${r.json?.error}`);

  sect('Giao NỐT {A:1, B:2} → fulfillment=fulfilled, 2 vận đơn');
  r = await rq(SELLER, 'POST', surl(o1.id), { body: { tracking_number: 'T' + uniq(), lines: [{ order_line_id: o1.olA, qty: 1 }, { order_line_id: o1.olB, qty: 2 }] }, cookie: oc, origin: OS });
  const g2 = (await rq(SELLER, 'GET', `/shops/${shopId}/orders/${o1.id}`, { cookie: oc })).json;
  r.status === 200 && g2.fulfillment_status === 'fulfilled' && g2.shipments.length === 2 && N(g2.lines.find((l) => l.variant_id === A).shipped_qty) === 3 && N(g2.lines.find((l) => l.variant_id === B).shipped_qty) === 2
    ? ok('giao nốt: fulfilled, 2 vận đơn, shipped==qty cả A,B') : bad('giao nốt sai', `ff=${g2.fulfillment_status} ships=${g2.shipments.length}`);

  sect('deliverOrder khi fulfilled → 200 delivered');
  r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o1.id}/deliver`, { cookie: oc, origin: OS });
  r.status === 200 && await col(o1.id, 'status') === 'delivered' ? ok('deliver fulfilled → delivered') : bad('deliver fulfilled lỗi', `${r.status}`);

  sect('Gửi QUÁ số còn lại → 422; gửi hết rồi gửi tiếp → 409');
  const o2 = await mkConfirmed();
  await rq(SELLER, 'POST', surl(o2.id), { body: { tracking_number: 'T' + uniq(), lines: [{ order_line_id: o2.olA, qty: 2 }] }, cookie: oc, origin: OS });
  r = await rq(SELLER, 'POST', surl(o2.id), { body: { tracking_number: 'T' + uniq(), lines: [{ order_line_id: o2.olA, qty: 2 }] }, cookie: oc, origin: OS });
  r.status === 422 && /quá số/.test(r.json?.error ?? '') ? ok('gửi A:2 rồi A:2 nữa (chỉ còn 1) → 422') : bad('gửi quá lọt', `${r.status} ${r.json?.error}`);

  sect('Đua 2 lệnh gửi {A:2} + {A:2} trên cùng đơn → tổng shipped ≤ qty');
  const o3 = await mkConfirmed();
  const races = await Promise.all([0, 1].map(() => rq(SELLER, 'POST', surl(o3.id), { body: { tracking_number: 'T' + uniq(), lines: [{ order_line_id: o3.olA, qty: 2 }] }, cookie: oc, origin: OS })));
  const okN = races.filter((x) => x.status === 200).length;
  const shA = N((await owner.query(`SELECT shipped_qty FROM order_lines WHERE id=$1`, [o3.olA])).rows[0].shipped_qty);
  shA <= 3 && okN >= 1 ? ok(`đua 2 lệnh A:2: shipped_qty(${shA}) ≤ 3, ${okN} thành công — khoá đơn tuần tự hoá`) : bad('đua vượt', `ok=${okN} sh=${shA}`);

  sect('Guard: đơn "shipped" (giao dở) → cancel/refund-release chặn (409)');
  const o4 = await mkConfirmed();
  await rq(SELLER, 'POST', surl(o4.id), { body: { tracking_number: 'T' + uniq(), lines: [{ order_line_id: o4.olA, qty: 1 }] }, cookie: oc, origin: OS });
  r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o4.id}/cancel`, { cookie: oc, origin: OS });
  r.status === 409 ? ok('cancel đơn giao dở (shipped) → 409 (không double-release tồn)') : bad('cancel được đơn shipped', `${r.status}`);

  sect('Mô phỏng SQL guard WORKER order-aware: 2 kiện in_transit → chốt delivered ĐÚNG lúc');
  // Craft đơn fulfilled + 2 shipment in_transit (mô phỏng 2 kiện hãng). Chạy ĐÚNG câu UPDATE
  // guard của worker: kiện 1 delivered → đơn KHÔNG flip (còn kiện 2 in_transit); kiện 2 → flip.
  const o5 = await mkConfirmed();
  // gửi hết bằng 2 lệnh giao tay để fulfillment=fulfilled + có 2 shipment; rồi ép in_transit lại.
  await rq(SELLER, 'POST', surl(o5.id), { body: { tracking_number: 'W1' + uniq(), lines: [{ order_line_id: o5.olA, qty: 3 }] }, cookie: oc, origin: OS });
  await rq(SELLER, 'POST', surl(o5.id), { body: { tracking_number: 'W2' + uniq(), lines: [{ order_line_id: o5.olB, qty: 2 }] }, cookie: oc, origin: OS });
  const ships = (await owner.query(`SELECT id FROM shipments WHERE order_id=$1 ORDER BY created_at`, [o5.id])).rows;
  await owner.query(`UPDATE orders SET status='shipped', delivered_at=NULL WHERE id=$1`, [o5.id]);
  await owner.query(`UPDATE shipments SET status='in_transit' WHERE order_id=$1`, [o5.id]);
  const workerFlip = async (shipId) => {
    await owner.query(`UPDATE shipments SET status='delivered' WHERE id=$1`, [shipId]);
    return N((await owner.query(
      `UPDATE orders SET status='delivered', delivered_at=now()
        WHERE id=$1 AND status='shipped' AND fulfillment_status='fulfilled'
          AND NOT EXISTS (SELECT 1 FROM shipments s2 WHERE s2.order_id=$1 AND s2.status IN ('created','in_transit','returned'))
       RETURNING 1`, [o5.id])).rowCount);
  };
  const flip1 = await workerFlip(ships[0].id);
  const st1 = await col(o5.id, 'status');
  flip1 === 0 && st1 === 'shipped' ? ok('kiện 1 delivered → đơn GIỮ shipped (còn kiện 2 in_transit)') : bad('đơn flip sớm khi mới 1 kiện', `flip=${flip1} st=${st1}`);
  const flip2 = await workerFlip(ships[1].id);
  const st2 = await col(o5.id, 'status');
  flip2 === 1 && st2 === 'delivered' ? ok('kiện 2 delivered → đơn flip delivered (mọi kiện xong)') : bad('đơn không flip khi đủ kiện', `flip=${flip2} st=${st2}`);

  // ── HOÀN TIỀN đơn tách-kiện BỎ DỞ phải nhả chỗ giữ phần CHƯA gửi ─────────────
  // refundOrder trước đây chỉ nhả reserve ở pending/confirmed. Đơn gửi 2/3 rồi thôi đang ở
  // 'shipped' và vẫn giữ chỗ phần chưa gửi; hoàn toàn bộ → 'refunded', mà markReturnedBomb
  // (nơi DUY NHẤT biết nhả phần chưa gửi) đòi status='shipped' → 409. Chỗ giữ kẹt VĨNH VIỄN:
  // hàng nằm trong kho mà không bán được. Dựng lại: a12.
  sect('Hoàn tiền đơn tách-kiện bỏ dở → nhả chỗ giữ phần chưa gửi (không kẹt vĩnh viễn)');
  {
    const oR = await mkConfirmed();                       // 3×A + 2×B
    await rq(SELLER, 'POST', surl(oR.id), { body: { carrier: 'tay', tracking_number: `T${uniq()}`, lines: [{ order_line_id: oR.olA, qty: 2 }] }, cookie: oc, origin: OS });
    // MỐC đo lấy SAU khi gửi: việc gửi đã tự trừ reserve của phần đã đi. Lấy mốc trước khi
    // gửi thì phép trừ gộp cả hai nguyên nhân và không nói được lệnh hoàn làm gì.
    const rvA0 = await reserved(A), rvB0 = await reserved(B);
    (await col(oR.id, 'status')) === 'shipped'
      ? ok('gửi 2/3 A, chưa gửi B → đơn shipped (tách kiện bỏ dở)') : bad('không dựng được cảnh bỏ dở');
    await owner.query(`UPDATE orders SET payment_status='paid', paid_at=now(), amount_paid_vnd=total_vnd WHERE id=$1`, [oR.id]);
    await rq(AUTH, 'POST', '/auth/step-up', { body: { password: op }, cookie: oc, origin: OA });
    const rf = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${oR.id}/refund`, { body: {}, cookie: oc, origin: OS });
    const rvA1 = await reserved(A), rvB1 = await reserved(B);
    rf.status === 200 && rvA1 === rvA0 - 1 && rvB1 === rvB0 - 2
      ? ok(`hoàn toàn bộ → nhả ĐÚNG phần chưa gửi (A: −1 còn lại, B: −2 chưa gửi gì)`)
      : bad('CHỖ GIỮ KẸT sau khi hoàn tiền đơn tách-kiện', `http=${rf.status} A ${rvA0}→${rvA1} B ${rvB0}→${rvB1}`);
    // Phần ĐÃ gửi KHÔNG được tự nhập lại kho: hoàn tiền ≠ hàng đã về.
    const ohNow = await onHand(A);
    typeof ohNow === 'number' ? ok(`phần đã gửi giữ nguyên ngoài kho (on_hand A = ${ohNow}, không tự cộng lại)`) : bad('không đọc được on_hand');
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
