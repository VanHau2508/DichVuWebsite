// E2E: ĐỔI-TRẢ (RMA v1). Kiểm: trả MỘT PHẦN → hoàn đúng + restock on_hand, trả TIẾP →
// cộng dồn không quá số mua, trả HẾT → đơn 'returned' + payment 'refunded', trần hoàn
// (đã hoàn trước), guard chưa-giao 409, không-restock giữ tồn, đua, perm+step-up, cross-shop.
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
const refundsOf = async (id) => N((await owner.query(`SELECT coalesce(sum(amount_vnd),0)::bigint s FROM refunds WHERE order_id=$1`, [id])).rows[0].s);
const col = async (id, c) => (await owner.query(`SELECT ${c} FROM orders WHERE id=$1`, [id])).rows[0][c];

async function main() {
  const staff = await makeStaff();
  const slug = `rma-${uniq()}`;
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
  const shopId = r.json.id; HOST = `${slug}.nentang.vn`;
  await owner.query(`UPDATE shops SET status='active', went_live_at=now() WHERE id=$1`, [shopId]);
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
  const A = await mk('A', 100000, 20), B = await mk('B', 50000, 20);
  const stepUp = () => rq(AUTH, 'POST', '/auth/step-up', { body: { password: op }, cookie: oc, origin: OA });
  // Đơn 3×A + 2×B = 400k + ship 30k = 430k, đưa tới 'delivered' (đã nhận, đã trả COD).
  const mkDelivered = async () => {
    let cart = (await co('POST', '/cart/items', { json: { variant_id: A, qty: 3 } })).cartCookie;
    cart = (await co('POST', '/cart/items', { json: { variant_id: B, qty: 2 }, cartCookie: cart })).cartCookie;
    await co('POST', '/checkout', { json: { customer: { name: 'K', phone: '0912000111', email: 'k@x.vn' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' }, cartCookie: cart, idem: `d-${uniq()}` });
    const id = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 1`, [shopId])).rows[0].id;
    // confirm → ship (consume on_hand) → deliver → COD paid
    await rq(SELLER, 'POST', `/shops/${shopId}/orders/${id}/confirm`, { cookie: oc, origin: OS });
    await rq(SELLER, 'POST', `/shops/${shopId}/orders/${id}/ship`, { body: { carrier: 'tay', tracking_number: 'T' + uniq() }, cookie: oc, origin: OS });
    await rq(SELLER, 'POST', `/shops/${shopId}/orders/${id}/deliver`, { cookie: oc, origin: OS });
    await owner.query(`UPDATE orders SET payment_status='paid', paid_at=now() WHERE id=$1`, [id]); // COD delivered = paid
    return id;
  };
  const rurl = (id) => `/shops/${shopId}/orders/${id}/return`;

  sect('Guard: chưa step-up → 403; đơn CHƯA giao → 409');
  const idPending = (await (async () => { const cart = (await co('POST', '/cart/items', { json: { variant_id: A, qty: 1 } })).cartCookie; await co('POST', '/checkout', { json: { customer: { name: 'P', phone: '0912000222' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' }, cartCookie: cart, idem: `p-${uniq()}` }); return (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 AND customer_phone='0912000222' ORDER BY created_at DESC LIMIT 1`, [shopId])).rows[0].id; })());
  r = await rq(SELLER, 'POST', rurl(idPending), { body: { lines: [{ variant_id: A, qty: 1 }] }, cookie: oc, origin: OS });
  r.status === 403 && r.json?.step_up_required ? ok('chưa step-up → 403 step_up_required') : bad('không đòi step-up', `${r.status}`);
  await stepUp();
  r = await rq(SELLER, 'POST', rurl(idPending), { body: { lines: [{ variant_id: A, qty: 1 }] }, cookie: oc, origin: OS });
  r.status === 409 && /đã giao/i.test(r.json?.error ?? '') ? ok('đơn chưa giao → 409 (chỉ trả đơn đã giao)') : bad('trả được đơn chưa giao', `${r.status} ${r.json?.error}`);

  const id = await mkDelivered();
  const ohA0 = await onHand(A), ohB0 = await onHand(B); // sau ship đã trừ: A 20-3=17, B 20-2=18

  sect('Trả MỘT PHẦN 1×A (restock) → hoàn 100k + on_hand A +1, đơn vẫn delivered');
  r = await rq(SELLER, 'POST', rurl(id), { body: { lines: [{ variant_id: A, qty: 1 }], reason: 'khách đổi ý', restock: true }, cookie: oc, origin: OS });
  r.status === 200 && N(r.json.refund_vnd) === 100000 && await onHand(A) === ohA0 + 1 && await refundsOf(id) === 100000 && await col(id, 'status') === 'delivered'
    ? ok('trả 1×A restock: hoàn 100k, on_hand A +1, đơn vẫn delivered') : bad('trả một phần sai', `refund=${r.json?.refund_vnd} ohA=${await onHand(A)}(kv ${ohA0 + 1}) rv=${await refundsOf(id)} st=${await col(id, 'status')}`);

  sect('Trả QUÁ số còn lại: A đã trả 1/3 → trả 3 nữa → 422 (còn 2)');
  r = await rq(SELLER, 'POST', rurl(id), { body: { lines: [{ variant_id: A, qty: 3 }], restock: true }, cookie: oc, origin: OS });
  r.status === 422 && /quá số/.test(r.json?.error ?? '') ? ok('trả quá số mua → 422') : bad('trả quá lọt', `${r.status} ${r.json?.error}`);

  sect('KHÔNG restock: trả 1×B không nhập kho → on_hand B GIỮ NGUYÊN, vẫn hoàn 50k');
  const ohBbefore = await onHand(B);
  r = await rq(SELLER, 'POST', rurl(id), { body: { lines: [{ variant_id: B, qty: 1 }], restock: false }, cookie: oc, origin: OS });
  r.status === 200 && N(r.json.refund_vnd) === 50000 && r.json.restocked === false && await onHand(B) === ohBbefore
    ? ok('trả 1×B không restock: hoàn 50k, on_hand B không đổi (hàng hỏng)') : bad('không-restock sai', `refund=${r.json?.refund_vnd} restocked=${r.json?.restocked} ohB=${await onHand(B)}(kv ${ohBbefore})`);

  sect('Trả HẾT hàng (2×A + 1×B) → đơn "returned"; hoàn = GIÁ HÀNG 400k, KHÔNG hoàn ship 30k → payment giữ "paid"');
  r = await rq(SELLER, 'POST', rurl(id), { body: { lines: [{ variant_id: A, qty: 2 }, { variant_id: B, qty: 1 }], restock: true }, cookie: oc, origin: OS });
  const st = await col(id, 'status'), ps = await col(id, 'payment_status'), rvTot = await refundsOf(id);
  // Trả hết hàng: refund luỹ kế = 3×A×100k + 2×B×50k = 400k (chỉ tiền hàng). Ship 30k KHÔNG
  // hoàn (dịch vụ đã thực hiện) → 400k < 430k đã thu → payment_status vẫn 'paid'. Đơn 'returned'.
  r.status === 200 && r.json.full_return === true && st === 'returned' && ps === 'paid' && rvTot === 400000
    ? ok('trả hết hàng → returned; hoàn 400k (hàng), ship 30k giữ lại, payment vẫn paid') : bad('trả hết sai', `full=${r.json?.full_return} st=${st} ps=${ps} rvTot=${rvTot}`);

  sect('Đơn khác: trần hoàn — đã refund tay 400k thì trả 3×A(300k) → 422 (chỉ còn 30k)');
  const id2 = await mkDelivered(); // 430k
  await stepUp();
  await rq(SELLER, 'POST', `/shops/${shopId}/orders/${id2}/refund`, { body: { amount_vnd: 400000, reason: 'giảm giá bù' }, cookie: oc, origin: OS });
  r = await rq(SELLER, 'POST', rurl(id2), { body: { lines: [{ variant_id: A, qty: 3 }], restock: true }, cookie: oc, origin: OS });
  r.status === 422 && /vượt số còn có thể hoàn/.test(r.json?.error ?? '') ? ok('hoàn vượt số còn lại → 422 (đã hoàn 400k/430k)') : bad('vượt trần hoàn lọt', `${r.status} ${r.json?.error}`);

  sect('Đua 2 phiếu trả cùng lúc trên đơn còn A=3: tổng qty trả KHÔNG vượt 3');
  const id3 = await mkDelivered();
  await stepUp();
  const races = await Promise.all([2, 2].map(() => rq(SELLER, 'POST', rurl(id3), { body: { lines: [{ variant_id: A, qty: 2 }], restock: true }, cookie: oc, origin: OS })));
  const okN = races.filter((x) => x.status === 200).length;
  const totRet = N((await owner.query(`SELECT coalesce(sum(rl.qty),0)::int q FROM return_lines rl JOIN returns r ON r.id=rl.return_id JOIN orders o ON o.id=r.order_id WHERE o.id=$1 AND rl.variant_id=$2`, [id3, A])).rows[0].q);
  totRet <= 3 && okN >= 1 ? ok(`đua 2 phiếu trả 2×A: tổng đã trả ${totRet} ≤ 3 (không vượt số mua) — khoá đơn tuần tự hoá`) : bad('đua trả vượt', `ok=${okN} totRet=${totRet}`);

  sect('Cross-shop: shop khác trả đơn này → 404 (RLS/membership)');
  const oe2 = `own2-${uniq()}@shop.vn`, op2 = 'owner two passphrase';
  const s2 = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: `y-${uniq()}`, slug: `y-${uniq()}`, plan_code: 'platform' }, cookie: staff, origin: OO });
  const iv = await rq(PLATFORM, 'POST', `/ops/shops/${s2.json.id}/invitations`, { body: { email: oe2, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe2), password: op2 }, origin: OA });
  const oc2 = await login(oe2, op2);
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: op2 }, cookie: oc2, origin: OA });
  r = await rq(SELLER, 'POST', `/shops/${s2.json.id}/orders/${id}/return`, { body: { lines: [{ variant_id: A, qty: 1 }] }, cookie: oc2, origin: OS });
  r.status === 404 ? ok('shop khác trả đơn shop A → 404') : bad('cross-shop trả được', `${r.status}`);

  // ── ĐƠN CHƯA THU TIỀN thì KHÔNG có gì để hoàn ─────────────────────────────
  // Dựng lại được thật (2026-08-03): đơn COD 627.000 giao xong nhưng CHƯA bấm "Đã nhận tiền"
  // → POST /return vẫn 200, ghi phiếu hoàn 199.000 và đóng đinh amount_paid_vnd = 627.000
  // (số BỊA). Người bán làm theo màn hình là CHUYỂN TIỀN THẬT cho người chưa trả đồng nào.
  // refundOrder có guard payment_status; createReturn thì không — cùng một bất biến, hai chỗ.
  sect('Đơn CHƯA THU TIỀN: không được nhận trả hàng (không có gì để hoàn)');
  {
    const idU = await mkDelivered();
    await owner.query(`UPDATE orders SET payment_status='unpaid', paid_at=NULL, amount_paid_vnd=0 WHERE id=$1`, [idU]);
    const refBefore = await refundsOf(idU);
    await rq(AUTH, 'POST', '/auth/step-up', { body: { password: op }, cookie: oc, origin: OA });
    const ru = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${idU}/return`, { body: { lines: [{ variant_id: A, qty: 1 }], restock: true }, cookie: oc, origin: OS });
    const refAfter = await refundsOf(idU);
    const paidAfter = N(await col(idU, 'amount_paid_vnd'));
    ru.status === 409 && refAfter === refBefore && paidAfter === 0
      ? ok('đơn chưa thu tiền → 409, KHÔNG ghi phiếu hoàn, KHÔNG bịa amount_paid_vnd')
      : bad('NHẬN TRẢ HÀNG CHO ĐƠN CHƯA TRẢ TIỀN', `http=${ru.status} refunds=${refBefore}→${refAfter} amount_paid=${paidAfter}`);
  }

  // ── Đơn CÓ GIẢM GIÁ: hoàn phải PHÂN BỔ coupon/điểm về hàng trả ───────────────
  // order_lines.unit_price_vnd là giá TRƯỚC giảm; coupon và điểm nằm ở HEADER đơn. Hoàn
  // thẳng Σ giá dòng là hoàn cả phần khách CHƯA HỀ TRẢ. Trước khi vá: trả 1/2 món của đơn
  // giảm 50% thì hoàn GẤP ĐÔI mức đúng, còn trả CẢ ĐƠN thì 422 — tức đơn dùng coupon KHÔNG
  // nhận trả hàng được. Mọi ca cũ trong bộ này đều dựng đơn KHÔNG giảm giá nên Σ dòng luôn
  // bằng số đã thu, sai lệch không bao giờ lộ ra.
  sect('Đơn CÓ COUPON: hoàn phân bổ giảm giá, và trả TOÀN BỘ vẫn nhận được');
  {
    const idD = await mkDelivered();
    const od = await owner.query(`SELECT subtotal_vnd, shipping_vnd FROM orders WHERE id=$1`, [idD]);
    const sub = N(od.rows[0].subtotal_vnd), ship = N(od.rows[0].shipping_vnd);
    const giam = Math.round(sub / 2);                       // coupon 50% tiền hàng
    await owner.query(
      `UPDATE orders SET discount_vnd=$2::bigint, coupon_code='GIAM50', total_vnd=$3::bigint, amount_paid_vnd=$3::bigint WHERE id=$1`,
      [idD, giam, sub - giam + ship]);
    const unitA = N((await owner.query(`SELECT unit_price_vnd FROM order_lines WHERE order_id=$1 AND variant_id=$2`, [idD, A])).rows[0].unit_price_vnd);

    await rq(AUTH, 'POST', '/auth/step-up', { body: { password: op }, cookie: oc, origin: OA });
    const r1 = await rq(SELLER, 'POST', rurl(idD), { body: { lines: [{ variant_id: A, qty: 1 }], restock: false }, cookie: oc, origin: OS });
    const ref1 = await refundsOf(idD);
    const dung1 = Math.round((unitA * (sub - giam)) / sub);
    r1.status === 200 && ref1 === dung1
      ? ok(`trả 1 món đơn giảm 50% → hoàn ${ref1}đ (phân bổ đúng, không phải ${unitA}đ nguyên giá)`)
      : bad('hoàn không phân bổ giảm giá', `http=${r1.status} hoàn=${ref1} kỳ vọng=${dung1} (nguyên giá=${unitA})`);

    // Trả nốt TOÀN BỘ phần còn lại: phải nhận được, và tổng hoàn = ĐÚNG tiền hàng đã trả.
    await rq(AUTH, 'POST', '/auth/step-up', { body: { password: op }, cookie: oc, origin: OA });
    const r2 = await rq(SELLER, 'POST', rurl(idD), { body: { lines: [{ variant_id: A, qty: 2 }, { variant_id: B, qty: 2 }], restock: false }, cookie: oc, origin: OS });
    const ref2 = await refundsOf(idD);
    r2.status === 200 && ref2 === sub - giam
      ? ok(`trả nốt cả đơn → tổng hoàn ${ref2}đ = đúng tiền hàng đã trả (phí ship ${ship}đ không hoàn)`)
      : bad('đơn có coupon KHÔNG trả hết hàng được', `http=${r2.status} ${r2.json?.error ?? ''} tổng hoàn=${ref2} kỳ vọng=${sub - giam}`);
  }

  sect('getOrder trả lịch sử returns + returned_qty mỗi dòng');
  const g = (await rq(SELLER, 'GET', `/shops/${shopId}/orders/${id}`, { cookie: oc })).json;
  const lineA = (g.lines ?? []).find((l) => l.variant_id === A);
  Array.isArray(g.returns) && g.returns.length >= 2 && lineA && lineA.returned_qty === 3 ? ok('getOrder: returns[] + line A returned_qty=3 (đã trả hết)') : bad('getOrder thiếu returns', `returns=${g.returns?.length} retA=${lineA?.returned_qty}`);

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
