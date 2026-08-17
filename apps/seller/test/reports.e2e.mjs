// E2E: BÁO CÁO LỢI NHUẬN (0081) — đối kháng số liệu từng đồng theo quy tắc sổ cái.
// Kiểm: happy-path revenue/COGS/coverage · đơn chưa trả bị loại · hoàn tiền ngày phiếu +
// đơn full-refund GIỮ doanh thu ở ngày thu (ever-paid) · edit-paid KHÔNG trừ đúp
// (kind=edit_adjustment) · COGS loại đơn hoàn-chưa-xuất-kho · RMA đảo COGS restock ·
// by_product NULL-cost → '—' + NULLS LAST · validate ngày thật/khoảng · RBAC 403 ·
// export CSV step-up + số âm không bị apostrophe · cô lập tenant · bất biến Σ.
import http from 'node:http';
import crypto from 'node:crypto';
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
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? ' :: ' + String(d).slice(0, 220) : '')); };
const sect = (m) => console.log('\n# ' + m);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };
async function rq(base, method, path, { body, cookie, origin } = {}) {
  const h = {}; if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin; if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t, headers: r.headers };
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
const N = (x) => Number(x ?? 0);

async function main() {
  const staff = await makeStaff();
  const mkShop = async (slug) => {
    const r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
    const shopId = r.json.id;
    await owner.query(`UPDATE shops SET status='active', went_live_at=now() WHERE id=$1`, [shopId]);
    const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
    await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
    await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
    return { shopId, host: `${slug}.nentang.vn`, oe, op, oc: await login(oe, op) };
  };
  const A = await mkShop(`rpt-${uniq()}`);
  const { shopId, oc, op } = A; HOST = A.host;
  const stepUp = (cookie = oc, password = op) => rq(AUTH, 'POST', '/auth/step-up', { body: { password }, cookie, origin: OA });
  const inviteRole = async (role) => {
    const em = `${role}-${uniq()}@shop.vn`, pw = 'member passphrase strong';
    await rq(SELLER, 'POST', `/shops/${shopId}/members/invite`, { body: { email: em, role }, cookie: oc, origin: OS })
      .then(async (r0) => { if (r0.status === 403) { await stepUp(); await rq(SELLER, 'POST', `/shops/${shopId}/members/invite`, { body: { email: em, role }, cookie: oc, origin: OS }); } });
    await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(em), password: pw }, origin: OA });
    return login(em, pw);
  };
  const mk = async (t, price, stock, cost) => {
    const p = await rq(SELLER, 'POST', `/shops/${shopId}/products`, { body: { title: t, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `${t}-${uniq()}`, price_vnd: price }] }, cookie: oc, origin: OS });
    const vid = (await rq(SELLER, 'GET', `/shops/${shopId}/products/${p.json.id}`, { cookie: oc })).json.variants[0].id;
    await rq(SELLER, 'POST', `/shops/${shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: oc, origin: OS });
    if (cost != null) await rq(SELLER, 'PATCH', `/shops/${shopId}/products/${p.json.id}/variants/${vid}`, { body: { cost_vnd: cost }, cookie: oc, origin: OS });
    return vid;
  };
  // vA: giá 100k vốn 60k · vB: giá 50k KHÔNG vốn · vC: giá 10k vốn 50k (bán LỖ — CSV số âm)
  const vA = await mk('SPA', 100000, 60, 60000);
  const vB = await mk('SPB', 50000, 60, null);
  const vC = await mk('SPC', 10000, 60, 50000);
  const place = async (items, phone) => {
    let cart = null;
    for (const [vid, qty] of items) cart = (await co('POST', '/cart/items', { json: { variant_id: vid, qty }, cartCookie: cart })).cartCookie;
    const r = await co('POST', '/checkout', { json: { customer: { name: 'K', phone }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' }, cartCookie: cart, idem: `i-${uniq()}` });
    return (await owner.query(`SELECT id, subtotal_vnd, shipping_vnd FROM orders WHERE shop_id=$1 AND order_number=$2`, [shopId, r.json.order_number])).rows[0];
  };
  const markPaid = async (id) => {
    await stepUp();
    return rq(SELLER, 'POST', `/shops/${shopId}/orders/${id}/mark-paid`, { cookie: oc, origin: OS });
  };
  const sales = (qs = '') => rq(SELLER, 'GET', `/shops/${shopId}/reports/sales${qs}`, { cookie: oc });

  sect('1. Happy path: 2 đơn paid hôm nay — revenue/COGS/coverage từng đồng');
  const o1 = await place([[vA, 2], [vB, 1]], '0900000001'); await markPaid(o1.id);
  const o2 = await place([[vA, 1]], '0900000002'); await markPaid(o2.id);
  const oU = await place([[vA, 5]], '0900000003'); // KHÔNG mark-paid → vô hình
  let r = await sales();
  let t = r.json?.totals;
  const expRev = 250000 + 100000; // (2×100k + 50k) + 100k — subtotal, không ship
  r.status === 200 && t.orders_paid === 2 && t.revenue_goods_vnd === expRev
    ? ok(`revenue_goods=${expRev} từ 2 đơn paid (đơn chưa trả vô hình)`) : bad('revenue sai', `${r.status} ${JSON.stringify(t)}`);
  t.cogs_vnd === 180000 ? ok('COGS=180.000 (3×A×60k; B NULL không tính)') : bad('COGS sai', t.cogs_vnd);
  t.gross_profit_vnd === expRev - 180000 ? ok(`lãi gộp=${expRev - 180000}`) : bad('gross sai', t.gross_profit_vnd);
  const ship12 = N(o1.shipping_vnd) + N(o2.shipping_vnd);
  t.shipping_income_vnd === ship12 ? ok(`thu ship=${ship12} (2 đơn paid)`) : bad('ship income sai', `${t.shipping_income_vnd} kv ${ship12}`);
  // coverage CƠ SỞ DÒNG: with = 300k (A), missing = 50k (B) → 86%
  const cc = t.cost_coverage;
  cc.revenue_with_cost_vnd === 300000 && cc.revenue_missing_cost_vnd === 50000 && cc.lines_missing_cost === 1 && cc.pct === 86
    ? ok('coverage dòng: with=300k missing=50k 1 dòng pct=86%') : bad('coverage sai', JSON.stringify(cc));

  sect('2. by_product: B thiếu cost → profit/margin NULL; sort=profit NULLS LAST');
  r = await sales('?sort=profit');
  const bp = r.json.by_product;
  const rowA = bp.find((x) => x.title.startsWith('SPA')), rowB = bp.find((x) => x.title.startsWith('SPB'));
  rowA.profit_vnd === 3 * 40000 && rowA.margin_pct === 40 ? ok('SPA profit=120.000 margin 40%') : bad('SPA sai', JSON.stringify(rowA));
  rowB.profit_vnd === null && rowB.margin_pct === null && rowB.has_missing_cost === true
    ? ok('SPB thiếu cost → profit/margin NULL (không bịa 0)') : bad('SPB sai', JSON.stringify(rowB));
  bp[bp.length - 1].title.startsWith('SPB') ? ok('sort=profit: dòng NULL xuống CUỐI (NULLS LAST)') : bad('NULLS LAST sai', JSON.stringify(bp.map((x) => x.title)));

  sect('3. Sổ cái hoàn tiền: full-refund GIỮ doanh thu ở ngày thu, phiếu trừ ở ngày phiếu');
  // Đơn o2 (100k+ship) lùi paid_at về HÔM QUA → hoàn TOÀN BỘ hôm nay.
  await owner.query(`UPDATE orders SET paid_at = paid_at - interval '1 day' WHERE id=$1`, [o2.id]);
  await stepUp();
  r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o2.id}/refund`, { body: { idempotency_key: crypto.randomUUID() }, cookie: oc, origin: OS });
  const o2st = (await owner.query(`SELECT payment_status, paid_at FROM orders WHERE id=$1`, [o2.id])).rows[0];
  r.status === 200 && o2st.payment_status === 'refunded' && o2st.paid_at !== null
    ? ok('hoàn toàn bộ → payment_status=refunded nhưng GIỮ paid_at') : bad('refund setup sai', `${r.status} ${JSON.stringify(o2st)}`);
  r = await sales();
  t = r.json.totals;
  // Ever-paid: o2 VẪN trong revenue (350k tổng); phiếu hoàn (100k+ship o2) trừ hôm nay.
  const o2total = 100000 + N(o2.shipping_vnd);
  t.revenue_goods_vnd === expRev && t.refunds_vnd === o2total
    ? ok(`ever-paid: revenue GIỮ ${expRev}, refunds=${o2total} tại ngày phiếu`) : bad('sổ cái refund sai', `rev=${t.revenue_goods_vnd} rf=${t.refunds_vnd}`);
  // COGS ghost guard: o2 refunded + unfulfilled (chưa ship) → COGS của nó BỎ (còn 2×60k của o1)
  t.cogs_vnd === 120000 ? ok('COGS loại đơn hoàn-chưa-xuất-kho (còn 120.000 của o1)') : bad('COGS ghost', t.cogs_vnd);

  sect('4. Edit-paid KHÔNG trừ đúp (kind=edit_adjustment loại khỏi phép trừ)');
  const o4 = await place([[vA, 2]], '0900000004'); await markPaid(o4.id); // 200k hàng
  let before = (await sales()).json.totals;
  await stepUp();
  r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o4.id}/edit-paid`, { body: { lines: [{ variant_id: vA, qty: 1 }], customer: { name: 'K', phone: '0900000004' } }, cookie: oc, origin: OS });
  let after = (await sales()).json.totals;
  // header 200k→100k (−100k revenue, −60k COGS vì dòng còn 1×A); refunds KHÔNG đổi.
  r.status === 200 && after.revenue_goods_vnd === before.revenue_goods_vnd - 100000 && after.refunds_vnd === before.refunds_vnd
    ? ok('edit-paid giảm 100k: revenue −100k, refunds GIỮ NGUYÊN (không trừ đúp)') : bad('edit-paid trừ đúp!', `rev ${before.revenue_goods_vnd}→${after.revenue_goods_vnd}, rf ${before.refunds_vnd}→${after.refunds_vnd}`);
  after.net_revenue_vnd === before.net_revenue_vnd - 100000
    ? ok('net −100k đúng (bug cũ sẽ −200k)') : bad('net sai', `${before.net_revenue_vnd}→${after.net_revenue_vnd}`);

  sect('5. RMA đảo COGS khi restock (tại ngày phiếu)');
  const o5 = await place([[vA, 2]], '0900000005');
  await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o5.id}/confirm`, { cookie: oc, origin: OS });
  await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o5.id}/ship`, { body: { tracking_number: 'T' + uniq() }, cookie: oc, origin: OS });
  await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o5.id}/deliver`, { cookie: oc, origin: OS });
  await markPaid(o5.id);
  before = (await sales()).json.totals;
  await stepUp();
  r = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o5.id}/return`, { body: { lines: [{ variant_id: vA, qty: 1 }], restock: true }, cookie: oc, origin: OS });
  after = (await sales()).json.totals;
  r.status === 200 && after.cogs_reversal_vnd === before.cogs_reversal_vnd + 60000
    ? ok('trả 1×A restock → cogs_reversal +60.000') : bad('đảo COGS sai', `${before.cogs_reversal_vnd}→${after.cogs_reversal_vnd}`);
  after.refunds_vnd === before.refunds_vnd + 100000 ? ok('phiếu RMA (kind=rma) VẪN trừ doanh thu như refund thường') : bad('rma refund sai', `${before.refunds_vnd}→${after.refunds_vnd}`);

  sect('6. Bất biến Σ: net = Σ(subtotal−discount ever-paid) − Σ refunds(kind≠edit_adjustment)');
  const db = (await owner.query(`
    SELECT (SELECT coalesce(sum(subtotal_vnd - discount_vnd),0)::bigint FROM orders WHERE shop_id=$1 AND paid_at IS NOT NULL) AS rev,
           (SELECT coalesce(sum(r.amount_vnd),0)::bigint FROM refunds r JOIN orders o ON o.id=r.order_id AND o.paid_at IS NOT NULL WHERE r.shop_id=$1 AND r.kind <> 'edit_adjustment') AS rf`, [shopId])).rows[0];
  r = await sales('?from=2020-01-01&to=2020-01-01'); // kỳ rỗng để lấy shape — rồi kỳ phủ hết
  const wide = await sales(`?from=${new Date(Date.now() - 5 * 86400e3).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 86400e3).toISOString().slice(0, 10)}`);
  N(wide.json.totals.net_revenue_vnd) === N(db.rev) - N(db.rf)
    ? ok(`bất biến khớp DB: ${N(db.rev)} − ${N(db.rf)} = ${N(wide.json.totals.net_revenue_vnd)}`) : bad('bất biến vỡ', `api=${wide.json.totals.net_revenue_vnd} db=${N(db.rev) - N(db.rf)}`);
  r.json.totals.orders_paid === 0 && r.json.totals.cost_coverage.pct === 100
    ? ok('kỳ 0 đơn: coverage pct=100 (không 0/0 NaN)') : bad('kỳ rỗng sai', JSON.stringify(r.json.totals.cost_coverage));

  sect('7. Validate: ngày ma, đảo, quá dài, ép group');
  r = await sales('?from=2026-02-31&to=2026-03-01');
  r.status === 400 ? ok('2026-02-31 (lọt regex, không tồn tại) → 400 không 500') : bad('ngày ma lọt', `${r.status}`);
  r = await sales('?from=2026-05-01&to=2026-04-01');
  r.status === 400 ? ok('from>to → 400') : bad('đảo ngày lọt', r.status);
  r = await sales('?from=2025-01-01&to=2026-07-01');
  r.status === 400 ? ok('547 ngày > 366 → 400') : bad('quá dài lọt', r.status);
  r = await sales('?from=2026-01-01&to=2026-06-30');
  r.status === 200 && r.json.range.group === 'month' ? ok('181 ngày → tự ép group=month') : bad('ép month sai', JSON.stringify(r.json.range));

  sect('8. RBAC: manager 403; export owner-only + step-up; CSV đúng');
  const om = await inviteRole('order_manager');
  r = await rq(SELLER, 'GET', `/shops/${shopId}/reports/sales`, { cookie: om });
  r.status === 403 ? ok('order_manager GET sales → 403 (không chỉ ẩn nav)') : bad('order_manager lọt', r.status);
  r = await rq(SELLER, 'GET', `/shops/${shopId}/reports/export?type=pnl`, { cookie: om });
  r.status === 403 ? ok('order_manager export → 403') : bad('om export lọt', r.status);
  // owner chưa step-up (đợi hết cửa sổ? — step-up vừa gọi ở mục 5 còn hạn 5'; kiểm bằng session MỚI)
  const oc2 = await login(A.oe, op);
  r = await rq(SELLER, 'GET', `/shops/${shopId}/reports/export?type=pnl`, { cookie: oc2 });
  r.status === 403 && r.json?.error === 'step_up_required' ? ok('owner session mới chưa step-up → 403 step_up_required') : bad('export không đòi step-up', `${r.status} ${r.raw?.slice(0, 80)}`);
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: op }, cookie: oc2, origin: OA });
  // Bán LỖ để CSV có số âm: đơn C×1 (giá 10k vốn 50k) paid, LÙI về ngày yên tĩnh (10 ngày
  // trước — không đơn nào khác) để bucket đó gross = 10k − 50k = −40k không bị hoà tan.
  const oL = await place([[vC, 1]], '0900000006'); await markPaid(oL.id);
  await owner.query(`UPDATE orders SET paid_at = paid_at - interval '10 days' WHERE id=$1`, [oL.id]);
  r = await rq(SELLER, 'GET', `/shops/${shopId}/reports/export?type=pnl`, { cookie: oc2 });
  const isCsv = (r.headers.get('content-type') ?? '').includes('text/csv');
  // BOM: kiểm BYTES thô (Response.text() tự lột BOM nên không soi được qua r.raw).
  const rawBytes = new Uint8Array(await (await fetch(`${SELLER}/shops/${shopId}/reports/export?type=pnl`, { headers: { cookie: `__Host-session=${oc2}` } })).arrayBuffer());
  r.status === 200 && isCsv && rawBytes[0] === 0xEF && rawBytes[1] === 0xBB && rawBytes[2] === 0xBF
    ? ok('export CSV 200 + BOM UTF-8 (bytes thô)') : bad('CSV/BOM sai', `${r.status} ${r.headers.get('content-type')} b0=${rawBytes[0]}`);
  const negLine = r.raw.split('\r\n').find((l) => l.includes('-40000'));
  r.raw.includes('-40000') && !r.raw.includes("'-40000") ? ok('số ÂM (bucket lỗ −40k) giữ nguyên, KHÔNG bị apostrophe thành text') : bad('số âm CSV sai', negLine ?? '(không thấy -40000)');
  r = await rq(SELLER, 'GET', `/shops/${shopId}/reports/export?type=products`, { cookie: oc2 });
  r.status === 200 && r.raw.includes('title,sku,qty') ? ok('export products CSV 200') : bad('products CSV sai', r.status);
  const audExp = (await owner.query(`SELECT count(*)::int n FROM audit_logs WHERE shop_id=$1 AND action='report.exported'`, [shopId])).rows[0].n;
  audExp >= 2 ? ok(`audit report.exported ghi ${audExp} lần`) : bad('thiếu audit export', audExp);

  sect('9. Cô lập tenant: shop B cùng ngày không lẫn một đồng');
  const B2 = await mkShop(`rpt2-${uniq()}`);
  HOST = B2.host;
  const vX = await (async () => {
    const p = await rq(SELLER, 'POST', `/shops/${B2.shopId}/products`, { body: { title: 'X', slug: `sp-${uniq()}`, price_vnd: 77000, status: 'active', variants: [{ sku: `X-${uniq()}`, price_vnd: 77000 }] }, cookie: B2.oc, origin: OS });
    const vid = (await rq(SELLER, 'GET', `/shops/${B2.shopId}/products/${p.json.id}`, { cookie: B2.oc })).json.variants[0].id;
    await rq(SELLER, 'POST', `/shops/${B2.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: 9, reason: 'nhập' }, cookie: B2.oc, origin: OS });
    return vid;
  })();
  let cartB = (await co('POST', '/cart/items', { json: { variant_id: vX, qty: 1 } })).cartCookie;
  const rB = await co('POST', '/checkout', { json: { customer: { name: 'K', phone: '0900000007' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' }, cartCookie: cartB, idem: `b-${uniq()}` });
  const oB = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2`, [B2.shopId, rB.json.order_number])).rows[0];
  await stepUp(B2.oc, B2.op);
  await rq(SELLER, 'POST', `/shops/${B2.shopId}/orders/${oB.id}/mark-paid`, { cookie: B2.oc, origin: OS });
  const tA = (await sales()).json.totals;
  const tB = (await rq(SELLER, 'GET', `/shops/${B2.shopId}/reports/sales`, { cookie: B2.oc })).json.totals;
  tB.revenue_goods_vnd === 77000 && !String(tA.revenue_goods_vnd).includes('77')
    ? ok('shop B thấy đúng 77.000 của mình; shop A không đổi') : bad('lẫn tenant', `A=${tA.revenue_goods_vnd} B=${tB.revenue_goods_vnd}`);

  sect('10. Test CHÉO /stats ↔ /reports: hai trang MỘT quy tắc sổ cái, khớp từng đồng');
  // stats.revenue.d7 = Σ total_vnd(ever-paid, paid 7 ngày VN) − Σ refunds(kind≠edit, 7 ngày)
  // reports cùng cửa sổ: (revenue_goods + shipping) − refunds = Σ total − Σ refunds — PHẢI bằng.
  // Fixture sẵn ca ác: o2 full-refund vắt cửa sổ (paid hôm qua, phiếu hôm nay) + o4 edit-paid.
  HOST = A.host;
  const st = await rq(SELLER, 'GET', `/shops/${shopId}/stats`, { cookie: oc });
  const tv = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const from7 = new Date(Date.parse(tv + 'T00:00:00Z') - 6 * 86400e3).toISOString().slice(0, 10);
  const rp7 = (await sales(`?from=${from7}&to=${tv}`)).json.totals;
  const lhs = N(st.json.revenue.d7);
  const rhs = N(rp7.revenue_goods_vnd) + N(rp7.shipping_income_vnd) - N(rp7.refunds_vnd);
  lhs === rhs ? ok(`stats.d7 (${lhs}) === reports 7 ngày (${rhs}) — kể cả full-refund vắt cửa sổ + edit-paid`)
    : bad('HAI TRANG HAI SỐ', `stats=${lhs} reports=${rhs}`);
  // Đơn full-refund (o2) vẫn nằm trong doanh thu stats (ever-paid) — chứng minh dashboard ĐÃ đổi quy tắc.
  const stAll = N(st.json.revenue.all);
  const dbAll = (await owner.query(`
    SELECT (SELECT coalesce(sum(total_vnd),0)::bigint FROM orders WHERE shop_id=$1 AND paid_at IS NOT NULL)
         - (SELECT coalesce(sum(r.amount_vnd),0)::bigint FROM refunds r JOIN orders o ON o.id=r.order_id AND o.paid_at IS NOT NULL
             WHERE r.shop_id=$1 AND r.kind <> 'edit_adjustment') AS v`, [shopId])).rows[0].v;
  stAll === N(dbAll) ? ok(`stats.revenue.all=${stAll} khớp sổ cái ever-paid − phiếu(≠edit)`) : bad('stats.all lệch sổ cái', `${stAll} kv ${dbAll}`);

  sect('11. HOÀ GIẢI ĐỐI SOÁT: tiền hãng THỰC chuyển kéo lãi vận hành về đúng');
  // Trước đợt này P&L chỉ trừ phí hãng BÁO GIÁ (shipments.carrier_fee_vnd) và KHÔNG bao giờ
  // đọc cod_remittances — hãng trừ thêm phí hoàn hàng/bảo hiểm thì shop vẫn thấy lãi cao hơn
  // thật. Đây là loại sai đắt nhất: người bán ra quyết định giá dựa trên con số đó.
  const opBefore = N((await sales()).json.totals.operating_profit_vnd);
  const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  // Phiếu chuyển tiền: hãng KỲ VỌNG trả 500.000 nhưng THỰC chuyển 470.000 → hụt 30.000.
  await owner.query(
    `INSERT INTO cod_remittances (shop_id, carrier, amount_vnd, expected_vnd, order_count, remitted_at)
     VALUES ($1, 'ghtk', 470000, 500000, 1, $2::date)`, [shopId, today]);
  const tAfter = (await sales()).json.totals;
  N(tAfter.settlement_variance_vnd) === -30000
    ? ok('chênh đối soát = −30.000 (thực 470k so với kỳ vọng 500k)') : bad('chênh đối soát sai', tAfter.settlement_variance_vnd);
  N(tAfter.operating_profit_vnd) === opBefore - 30000
    ? ok(`lãi vận hành GIẢM đúng 30.000 (${opBefore} → ${tAfter.operating_profit_vnd})`)
    : bad('lãi vận hành không phản ánh đối soát', `${opBefore} → ${tAfter.operating_profit_vnd}`);
  // Lãi GỘP không được đụng: đối soát là chuyện vận chuyển, không phải giá vốn hàng.
  N(tAfter.gross_profit_vnd) === N((await sales()).json.totals.gross_profit_vnd)
    ? ok('lãi gộp KHÔNG đổi (đối soát chỉ nằm ở tầng vận hành)') : bad('đối soát rò vào lãi gộp');

  // BẪY NGÀY: remitted_at là DATE, không phải timestamptz. Nếu ai đó dùng bucketSql của cột
  // timestamptz cho nó, Postgres dịch 7 giờ và phiếu rơi sang ngày khác — tiền nhảy kỳ.
  const yday = new Date(Date.parse(today + 'T00:00:00Z') - 86400e3).toISOString().slice(0, 10);
  await owner.query(
    `INSERT INTO cod_remittances (shop_id, carrier, amount_vnd, expected_vnd, order_count, remitted_at)
     VALUES ($1, 'ghn', 100000, 90000, 1, $2::date)`, [shopId, yday]);
  const two = (await sales(`?from=${yday}&to=${today}`)).json.series;
  const bY = two.find((s) => s.bucket === yday), bT = two.find((s) => s.bucket === today);
  N(bY?.settlement_variance_vnd) === 10000 && N(bT?.settlement_variance_vnd) === -30000
    ? ok('phiếu rơi ĐÚNG ngày ghi trên sao kê (+10k hôm qua, −30k hôm nay)')
    : bad('phiếu lệch ngày — nghi dịch múi giờ trên cột DATE', JSON.stringify({ [yday]: bY?.settlement_variance_vnd, [today]: bT?.settlement_variance_vnd }));
  // Chỉ hỏi ngày HÔM QUA thì phiếu hôm nay phải nằm ngoài — chặn lỗi lọc bao trùm.
  N((await sales(`?from=${yday}&to=${yday}`)).json.totals.settlement_variance_vnd) === 10000
    ? ok('lọc kỳ 1 ngày: chỉ lấy phiếu của đúng ngày đó') : bad('lọc kỳ đối soát bao trùm sai');

  sect('12. Hãng còn giữ tiền: hiện thành MEMO, KHÔNG trừ vào lãi');
  const codMemo = (await sales()).json.totals.cod_outstanding;
  codMemo && typeof codMemo.amount_vnd === 'number' && typeof codMemo.orders === 'number'
    ? ok(`memo phải-thu có mặt (${codMemo.amount_vnd}đ / ${codMemo.orders} đơn)`) : bad('thiếu memo phải-thu', JSON.stringify(codMemo));
  // Cột CSV phải khớp trang: thiếu một cột thì kế toán cộng tay KHÔNG ra lãi vận hành.
  HOST = A.host;
  const csvR = await rq(SELLER, 'GET', `/shops/${shopId}/reports/export?type=pnl&from=${today}&to=${today}`, { cookie: oc });
  /settlement_variance_vnd/.test(String(csvR.raw ?? ''))
    ? ok('CSV theo kỳ có cột settlement_variance_vnd') : bad('CSV thiếu cột chênh đối soát — hai màn hình hai số');

  // ── ĐIỂM THƯỞNG: doanh thu phải TRỪ điểm khách đổi ──────────────────────────
  // docs/41 đã chốt từ đầu: "chi phí điểm ghi tại REDEEM giảm doanh thu". reports.js thì
  // chưa cài — công thức `subtotal − discount` viết ra TRƯỚC khi có tính năng điểm (0086)
  // và chưa từng được sửa lại. Ba nơi khác đã trừ đúng (checkout total, sửa đơn, worker tích
  // điểm); chỉ báo cáo sót, nên lãi trên màn hình cao hơn thật ĐÚNG bằng số điểm khách đổi —
  // và luôn lệch theo chiều đó, không bao giờ tự triệt tiêu.
  //
  // Dựng trạng thái đơn bằng owner SQL thay vì đi trọn luồng điểm thưởng: luồng đó cần thêm
  // service tài khoản khách + vòng quét vesting, vốn đã có bộ e2e riêng. Thứ đang kiểm ở đây
  // là BÁO CÁO ĐỌC dòng đơn thế nào, nên tái dựng ĐÚNG những cột checkout ghi ra là đủ và
  // đúng chỗ.
  sect('ĐIỂM THƯỞNG: doanh thu hàng phải trừ points_discount_vnd');
  {
    const stats = async () => N((await rq(SELLER, 'GET', `/shops/${shopId}/stats`, { cookie: oc })).json?.revenue?.today);
    const t0 = (await sales()).json.totals;
    const st0 = await stats();
    const oP = await place([[vA, 1]], '0900000009');          // tiền hàng 100.000
    await markPaid(oP.id);
    const DIEM = 40000;
    // Y HỆT checkout: total = subtotal − discount − points + ship; đã thu = total.
    await owner.query(
      `UPDATE orders SET points_discount_vnd = $2, total_vnd = total_vnd - $2, amount_paid_vnd = total_vnd - $2 WHERE id = $1`,
      [oP.id, DIEM]);
    const t1 = (await sales()).json.totals;
    const st1 = await stats();
    const dRev = N(t1.revenue_goods_vnd) - N(t0.revenue_goods_vnd);
    dRev === 100000 - DIEM
      ? ok(`doanh thu hàng tăng ${dRev} = tiền hàng 100.000 − điểm ${DIEM} (không phải 100.000)`)
      : bad('doanh thu KHÔNG trừ điểm — lãi trên màn cao hơn thật', `tăng ${dRev}, đúng phải ${100000 - DIEM}`);
    N(t1.points_discount_vnd) - N(t0.points_discount_vnd) === DIEM
      ? ok(`có dòng memo "giảm giá bằng điểm" = ${DIEM} (chủ shop thấy chương trình tốn bao nhiêu)`)
      : bad('thiếu dòng memo điểm thưởng', `${t1.points_discount_vnd} vs ${t0.points_discount_vnd}`);
    // BẤT BIẾN CHÉO (docs/37 quy tắc 7): Tổng quan và Báo cáo phải nói MỘT con số.
    // stats = Σ total_vnd (đã trừ điểm) — reports = revenue_goods + ship. Chỉ khớp khi
    // revenue_goods cũng đã trừ điểm. Đây chính là chỗ lỗ cũ ẩn được: fixture chưa từng có
    // đơn đổi điểm nên đẳng thức luôn đúng một cách may mắn.
    const dStats = st1 - st0;
    const dReports = dRev + (N(t1.shipping_income_vnd) - N(t0.shipping_income_vnd));
    dStats === dReports
      ? ok(`Tổng quan (+${dStats}) === Báo cáo (+${dReports}) trên đơn CÓ đổi điểm`)
      : bad('HAI TRANG HAI SỐ trên đơn đổi điểm', `stats +${dStats} reports +${dReports}`);
    const csvP = await rq(SELLER, 'GET', `/shops/${shopId}/reports/export?type=pnl`, { cookie: oc });
    /points_discount_vnd/.test(String(csvP.raw ?? ''))
      ? ok('CSV P&L có cột points_discount_vnd') : bad('CSV thiếu cột điểm — cộng tay không ra lãi');
  }

  // ── BIÊN NGÀY: danh sách đơn phải cắt theo GIỜ VN như báo cáo ───────────────
  // DB chạy UTC, nên `created_at >= '2026-07-15'::date` trần cắt tại 0h UTC = 7 GIỜ SÁNG giờ
  // VN. Đơn đặt lúc 2h sáng — khung săn sale 0h — bị đẩy sang ngày hôm trước ở trang Đơn hàng,
  // trong khi Báo cáo (AT TIME ZONE) xếp đúng ngày. Cùng một ô "Từ/Đến", hai trang hai tập đơn.
  sect('BIÊN NGÀY giờ VN: đơn đặt 2h sáng phải thuộc ĐÚNG ngày đó ở danh sách đơn');
  {
    // 02:00 giờ VN hôm nay = 19:00 UTC hôm qua. Đặt thẳng để không phụ thuộc giờ chạy test.
    const hnay = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
    const oSom = await place([[vA, 1]], '0900000010');
    await owner.query(
      `UPDATE orders SET created_at = ($2::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh') + interval '2 hours' WHERE id = $1`,
      [oSom.id, hnay]);
    const trongNgay = async (f, t) => {
      const rr = await rq(SELLER, 'GET', `/shops/${shopId}/orders?from=${f}&to=${t}&limit=100`, { cookie: oc });
      return (rr.json?.orders ?? []).some((x) => x.id === oSom.id);
    };
    (await trongNgay(hnay, hnay))
      ? ok(`đơn 02:00 sáng ${hnay} NẰM TRONG bộ lọc "từ ${hnay} đến ${hnay}"`)
      : bad('đơn sáng sớm rơi khỏi ngày của nó (biên UTC)');
    const homQua = new Date(Date.parse(hnay + 'T00:00:00Z') - 86400e3).toISOString().slice(0, 10);
    !(await trongNgay(homQua, homQua))
      ? ok(`và KHÔNG lọt vào ngày hôm trước (${homQua})`)
      : bad('đơn bị xếp nhầm sang ngày hôm trước');
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
