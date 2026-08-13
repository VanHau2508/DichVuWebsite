// E2E: FLASH SALE đường tiền checkout (0082). Kiểm: snapshot giá sale + orig + promotion_id;
// no-promo → NULL; coupon STACK trên giá sale; báo cáo lãi phản ánh giá sale; VÒNG TRUNG THỰC
// no-JS 409 CẢ HAI chiều (promo hết → giá tăng; promo bật → giá giảm) qua form /checkout/place.
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
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
const login = async (e, p) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email: e, password: p }, origin: OA })).sc);
const uidOf = async (e) => (await owner.query('SELECT id FROM users WHERE email=$1', [e])).rows[0]?.id ?? null;
let HOST;
// hreq: JSON hoặc form-urlencoded; trả status/json/body/location/cartCookie.
function hreq(method, path, { json, form, cartCookie, idem, accept } = {}) {
  return new Promise((resolve, reject) => {
    let data = null, ctype = null;
    if (json !== undefined) { data = JSON.stringify(json); ctype = 'application/json'; }
    else if (form !== undefined) { data = new URLSearchParams(form).toString(); ctype = 'application/x-www-form-urlencoded'; }
    const headers = { host: HOST, origin: `https://${HOST}` };
    if (accept) headers.accept = accept;
    if (data != null) { headers['content-type'] = ctype; headers['content-length'] = Buffer.byteLength(data); }
    if (cartCookie) headers.cookie = `__Host-cart=${cartCookie}`;
    if (idem) headers['idempotency-key'] = idem;
    const req = http.request({ hostname: CO.hostname, port: CO.port, path, method, headers }, (rs) => {
      let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch {} let tok = cartCookie; for (const c of rs.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) tok = m[1]; } resolve({ status: rs.statusCode, json: j, body: b, location: rs.headers.location, cartCookie: tok }); });
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
const W = ["now() - interval '1 hour'", "now() + interval '1 hour'"]; // khung giờ đang chạy
// Promo scope='all' qua owner SQL (API seller là commit sau). active điều khiển bật/tắt.
const mkPromo = (shopId, kind, value, active = true) => owner.query(
  `INSERT INTO promotions (shop_id,title,kind,value,scope,starts_at,ends_at,active)
   VALUES ($1,'Flash',$2,$3,'all',${W[0]},${W[1]},$4) RETURNING id`, [shopId, kind, value, active]).then((r) => r.rows[0].id);
const setActive = (id, a) => owner.query(`UPDATE promotions SET active=$2 WHERE id=$1`, [id, a]);

async function main() {
  const staff = await makeStaff();
  const slug = `promo-${uniq()}`;
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
  const shopId = r.json.id; HOST = `${slug}.nentang.vn`;
  await owner.query(`UPDATE shops SET status='active', went_live_at=now() WHERE id=$1`, [shopId]);
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  const oc = await login(oe, op);
  const mk = async (price, stock) => {
    const p = await rq(SELLER, 'POST', `/shops/${shopId}/products`, { body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `S-${uniq()}`, price_vnd: price }] }, cookie: oc, origin: OS });
    const vid = (await rq(SELLER, 'GET', `/shops/${shopId}/products/${p.json.id}`, { cookie: oc })).json.variants[0].id;
    await rq(SELLER, 'POST', `/shops/${shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: oc, origin: OS });
    return vid;
  };
  const vid = await mk(100000, 100), vidB = await mk(50000, 100);
  const lastOrder = async () => (await owner.query(`SELECT id, subtotal_vnd, total_vnd, discount_vnd FROM orders WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 1`, [shopId])).rows[0];
  const linesOf = async (oid) => (await owner.query(`SELECT variant_id, unit_price_vnd, orig_unit_price_vnd, promotion_id, qty FROM order_lines WHERE order_id=$1`, [oid])).rows;
  const jsonOrder = async (items, extra = {}) => {
    let cart = null;
    for (const [v, q] of items) cart = (await hreq('POST', '/cart/items', { json: { variant_id: v, qty: q }, cartCookie: cart })).cartCookie;
    if (extra.coupon) await hreq('POST', '/cart/coupon', { form: { code: extra.coupon }, cartCookie: cart });
    await hreq('POST', '/checkout', { json: { customer: { name: 'K', phone: extra.phone ?? '0900000001', email: 'k@x.vn' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' }, cartCookie: cart, idem: `i-${uniq()}` });
    return cart;
  };

  sect('1. Snapshot: promo −30% → unit=sale, orig=base, promotion_id set');
  const pid1 = await mkPromo(shopId, 'percent', 30);
  await jsonOrder([[vid, 2]]);
  let o = await lastOrder(); let ls = await linesOf(o.id);
  N(o.subtotal_vnd) === 140000 && N(ls[0].unit_price_vnd) === 70000 && N(ls[0].orig_unit_price_vnd) === 100000 && ls[0].promotion_id === pid1
    ? ok('đơn 2×SP: subtotal 140k, unit 70k, orig 100k, promotion_id đúng') : bad('snapshot sale sai', `${o.subtotal_vnd} ${JSON.stringify(ls[0])}`);
  await setActive(pid1, false);

  sect('2. Không promo → unit=base, orig NULL, promotion_id NULL');
  await jsonOrder([[vid, 1]]);
  o = await lastOrder(); ls = await linesOf(o.id);
  N(ls[0].unit_price_vnd) === 100000 && ls[0].orig_unit_price_vnd === null && ls[0].promotion_id === null
    ? ok('không promo: unit 100k, orig NULL, promotion_id NULL') : bad('no-promo snapshot sai', JSON.stringify(ls[0]));

  sect('3. Coupon STACK trên giá SALE (min_subtotal xét trên subtotal đã sale)');
  const pid3 = await mkPromo(shopId, 'percent', 50); // SP về 50k
  const code = 'SALE20-' + uniq().slice(0, 4).toUpperCase();
  await owner.query(`INSERT INTO coupons (shop_id, code, kind, value, min_subtotal_vnd, active) VALUES ($1,$2,'percent',20,40000,true)`, [shopId, code]);
  // 1×SP: sale subtotal = 50000 (≥ min 40000 → coupon áp). coupon = floor(50000*20/100)=10000.
  await jsonOrder([[vid, 1]], { coupon: code, phone: '0900000003' });
  o = await lastOrder();
  // Coupon 20% trên subtotal SALE 50k = 10k (nếu tính trên GỐC 100k sẽ là 20k → sai). total =
  // subtotal − discount + ship. min_subtotal 40k ≤ 50k sale → coupon áp (nếu xét gốc 100k cũng áp,
  // nhưng số giảm phân biệt: 10k = trên sale).
  N(o.subtotal_vnd) === 50000 && N(o.discount_vnd) === 10000
    ? ok('coupon 20% trên subtotal SALE 50k → giảm 10k (không phải 20k trên gốc)') : bad('coupon-on-sale sai', `sub=${o.subtotal_vnd} disc=${o.discount_vnd} total=${o.total_vnd}`);
  await setActive(pid3, false);

  sect('4. Báo cáo lãi phản ánh giá SALE (revenue = giá đã giảm)');
  const pid4 = await mkPromo(shopId, 'percent', 40); // SP 100k → 60k
  await jsonOrder([[vid, 1]], { phone: '0900000004' });
  o = await lastOrder();
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: op }, cookie: oc, origin: OA });
  await rq(SELLER, 'POST', `/shops/${shopId}/orders/${o.id}/mark-paid`, { cookie: oc, origin: OS });
  const rep = await rq(SELLER, 'GET', `/shops/${shopId}/reports/sales`, { cookie: oc });
  // revenue_goods gồm đơn này (60k) + đơn coupon mục 3 (50k, đã paid? chưa). Chỉ đơn mục 4 paid.
  const revHasSale = rep.status === 200 && N(rep.json.by_product.find((p) => N(p.revenue_vnd) === 60000) ? 60000 : rep.json.totals.revenue_goods_vnd) >= 60000;
  rep.status === 200 && rep.json.by_product.some((p) => N(p.revenue_vnd) === 60000)
    ? ok('báo cáo: doanh thu theo giá SALE 60k (không phải gốc 100k)') : bad('báo cáo không theo giá sale', JSON.stringify(rep.json?.by_product));
  await setActive(pid4, false);

  // Dọn đơn pending: challenge toán kích sau ≥4 đơn pending/IP (mọi request cùng IP dbtest)
  // → re-render challenge sẽ lẫn với re-render cổng giá. Chuyển pending→confirmed để count=0.
  await owner.query(`UPDATE orders SET status='confirmed' WHERE shop_id=$1 AND status='pending'`, [shopId]);

  sect('5. VÒNG TRUNG THỰC: promo HẾT giữa giỏ→đặt → 409 dựng lại form (giá tăng)');
  const pid5 = await mkPromo(shopId, 'percent', 30);
  let cart = (await hreq('POST', '/cart/items', { json: { variant_id: vid, qty: 2 } })).cartCookie;
  let page = await hreq('POST', '/checkout', { json: { customer: { name: 'K', phone: '0900000005' }, address: { line: 'x', province: 'TP. Hồ Chí Minh' }, payment_method: 'cod' }, cartCookie: cart });
  // Lấy form thật (idem/ct/subtotal_seen) từ GET /checkout HTML.
  page = await hreq('GET', '/checkout', { cartCookie: cart, accept: 'text/html' });
  const grab = (b) => ({ idem: b.match(/name="idempotency_key" value="([^"]+)"/)?.[1], ct: b.match(/name="ct" value="([^"]+)"/)?.[1], sub: b.match(/name="subtotal_seen" value="([^"]+)"/)?.[1] });
  let f = grab(page.body);
  f.sub === '140000' ? ok('GET /checkout: subtotal_seen=140000 (đã sale)') : bad('subtotal_seen thiếu/sai', f.sub);
  await setActive(pid5, false); // promo HẾT trong lúc khách điền form
  await sleep(2600);            // > MIN_FILL_MS
  const baseForm = { idempotency_key: f.idem, ct: f.ct, subtotal_seen: f.sub, name: 'Khách Thật', phone: '0900000005', address_line: '12 Lê Lợi', province: 'TP. Hồ Chí Minh', payment_method: 'cod' };
  r = await hreq('POST', '/checkout/place', { form: baseForm, cartCookie: cart, accept: 'text/html' });
  const rerendered = r.status === 200 && /cập nhật|khuyến mãi/.test(r.body) && !r.location;
  rerendered ? ok('promo hết + subtotal_seen cũ → KHÔNG đặt, dựng lại form + thông báo') : bad('không chặn giá cũ', `st=${r.status} loc=${r.location}`);
  const nOrders1 = N((await owner.query(`SELECT count(*)::int n FROM orders WHERE shop_id=$1 AND customer_phone='0900000005'`, [shopId])).rows[0].n);
  nOrders1 === 0 ? ok('chưa đẻ đơn (reserve/idem rollback)') : bad('đã tạo đơn giá cũ!', nOrders1);
  // Bấm Đặt lại với form MỚI (subtotal_seen=200000 giá gốc) → 303, đơn giá gốc.
  const f2 = grab(r.body);
  f2.sub === '200000' ? ok('form dựng lại: subtotal_seen=200000 (giá gốc)') : bad('re-render subtotal sai', f2.sub);
  await sleep(2600);
  r = await hreq('POST', '/checkout/place', { form: { idempotency_key: f2.idem, ct: f2.ct, subtotal_seen: f2.sub, name: 'Khách Thật', phone: '0900000005', address_line: '12 Lê Lợi', province: 'TP. Hồ Chí Minh', payment_method: 'cod' }, cartCookie: cart, accept: 'text/html' });
  o = await lastOrder(); ls = await linesOf(o.id);
  r.status === 303 && N(o.subtotal_vnd) === 200000 && N(ls[0].unit_price_vnd) === 100000 && ls[0].orig_unit_price_vnd === null
    ? ok('đặt lại → 303, đơn GIÁ GỐC 200k (unit 100k, orig NULL)') : bad('đặt lại sai giá', `st=${r.status} sub=${o.subtotal_vnd}`);

  sect('6. Chiều NGƯỢC: promo BẬT giữa chừng → 409 (giá giảm), đặt lại theo giá sale');
  let cart6 = (await hreq('POST', '/cart/items', { json: { variant_id: vidB, qty: 2 } })).cartCookie; // base 50k, chưa promo
  await hreq('POST', '/checkout', { json: { customer: { name: 'K', phone: '0900000006' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' }, cartCookie: cart6 });
  page = await hreq('GET', '/checkout', { cartCookie: cart6, accept: 'text/html' });
  let f6 = grab(page.body);
  f6.sub === '100000' ? ok('GET checkout không promo: subtotal_seen=100000') : bad('sub sai', f6.sub);
  const pid6 = await mkPromo(shopId, 'percent', 50); // BẬT −50% (SP về 25k → subtotal 50k)
  await sleep(2600);
  r = await hreq('POST', '/checkout/place', { form: { idempotency_key: f6.idem, ct: f6.ct, subtotal_seen: f6.sub, name: 'K', phone: '0900000006', address_line: 'x', province: 'Hà Nội', payment_method: 'cod' }, cartCookie: cart6, accept: 'text/html' });
  r.status === 200 && !r.location && /cập nhật|khuyến mãi/.test(r.body) ? ok('promo bật (giá GIẢM) cũng 409 dựng lại form (không lặng lẽ)') : bad('không chặn khi giá giảm', `st=${r.status}`);
  const f6b = grab(r.body);
  f6b.sub === '50000' ? ok('re-render: subtotal_seen=50000 (đã sale)') : bad('re-render sub sai', f6b.sub);
  await sleep(2600);
  r = await hreq('POST', '/checkout/place', { form: { idempotency_key: f6b.idem, ct: f6b.ct, subtotal_seen: f6b.sub, name: 'K', phone: '0900000006', address_line: 'x', province: 'Hà Nội', payment_method: 'cod' }, cartCookie: cart6, accept: 'text/html' });
  o = await lastOrder(); ls = await linesOf(o.id);
  r.status === 303 && N(o.subtotal_vnd) === 50000 && N(ls[0].unit_price_vnd) === 25000 && N(ls[0].orig_unit_price_vnd) === 50000
    ? ok('đặt lại → 303, đơn GIÁ SALE 50k (unit 25k, orig 50k)') : bad('đặt lại giá sale sai', `st=${r.status} sub=${o.subtotal_vnd} ${JSON.stringify(ls[0])}`);
  await setActive(pid6, false);

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
