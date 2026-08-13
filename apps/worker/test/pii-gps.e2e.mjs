// E2E: TOẠ ĐỘ GPS KHÔNG SỐNG QUÁ HẠN LƯU TRỮ (0089 ship-4, Luật BVDLCN 91/2025). GPS lat/lng
// nằm TRONG orders.shipping_address (jsonb) → sweep ẩn danh (shipping_address = NULL) phải xoá luôn
// toạ độ. Khoá bất biến: nếu sau này ai tách lat/lng ra cột riêng mà quên nối vào sweep → test này đỏ.
// Chuỗi đầy-đủ: checkout GPS ghi lat/lng vào đơn → quá hạn + terminal → worker pii-sweep → toạ độ mất.
// Chứng: đơn TƯƠI (chưa quá hạn) GIỮ toạ độ (sweep có mục tiêu, không quét mù); doanh thu giữ nguyên.
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = 'http://auth:3020', PLATFORM = 'http://platform:3030', SELLER = 'http://seller:3040';
const WORKER = process.env.WORKER_URL ?? 'http://worker:3080';
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
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
function co(host, method, path, { json, cartTok, idem } = {}) {
  return new Promise((resolve, reject) => {
    const data = json !== undefined ? JSON.stringify(json) : null;
    const headers = { host, origin: `https://${host}` };
    if (data != null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (cartTok) headers.cookie = `__Host-cart=${cartTok}`;
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
  const slug = `piigps-${uniq()}`;
  const shopId = (await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO })).json.id;
  await owner.query(`UPDATE shops SET status='active', went_live_at=now() WHERE id=$1`, [shopId]);
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  return { shopId, host: `${slug}.nentang.vn`, oc: await login(oe, op) };
}
const swp = async () => { const r = await fetch(WORKER + '/internal/pii-sweep', { method: 'POST' }); return r.json(); };
const ORIGIN = { lat: 21.0285, lng: 105.8542 };

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff);
  const p = await rq(SELLER, 'POST', `/shops/${A.shopId}/products`, { body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: 100000, status: 'active', variants: [{ sku: `K-${uniq()}`, price_vnd: 100000 }] }, cookie: A.oc, origin: OS });
  const vid = (await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${p.json.id}`, { cookie: A.oc })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${A.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: 500, reason: 'seed' }, cookie: A.oc, origin: OS });
  let r = await rq(SELLER, 'PATCH', `/shops/${A.shopId}`, { body: {
    name: 'Shop GPS PII', ship_mode: 'distance', ship_origin_lat: ORIGIN.lat, ship_origin_lng: ORIGIN.lng,
    ship_base_vnd: 5000, ship_per_km_vnd: 2000, ship_max_km: 20, ship_road_factor: 1.0,
    ship_fee_vnd: 20000, ship_fee_far_vnd: 50000, ship_from_province: 'Hà Nội',
  }, cookie: A.oc, origin: OS });
  r.status === 200 ? ok('dựng shop ship theo km') : bad('setup lỗi', r.raw);

  // Đặt 1 đơn GPS (toạ độ cách gốc ~5km) → lat/lng vào shipping_address.
  async function gpsOrder() {
    const cart = (await co(A.host, 'POST', '/cart/items', { json: { variant_id: vid, qty: 1 } })).cartTok;
    const coords = { lat: ORIGIN.lat + 5 / 111.19, lng: ORIGIN.lng };
    const res = await co(A.host, 'POST', '/checkout', { json: { customer: { name: 'Khách GPS', phone: `09${Math.floor(1e7 + Math.random() * 8e7)}` }, address: { line: '1 Test', province: 'Hà Nội', lat: coords.lat, lng: coords.lng }, payment_method: 'cod' }, cartTok: cart, idem: `k-${uniq()}` });
    return res.json?.order_number;
  }

  sect('1. Checkout GPS ghi lat/lng vào shipping_address (jsonb)');
  const n1 = await gpsOrder();
  const n2 = await gpsOrder(); // đơn chứng (control) — sẽ để TƯƠI
  const coordsOf = async (num) => (await owner.query(`SELECT shipping_address->>'lat' AS lat, shipping_address->>'lng' AS lng, shipping_address IS NULL AS isnull, customer_name, customer_phone, anonymized_at, total_vnd, status FROM orders WHERE shop_id=$1 AND order_number=$2`, [A.shopId, num])).rows[0];
  let o1 = await coordsOf(n1);
  o1 && o1.lat && o1.lng && Number(o1.lat) > 20 ? ok(`đơn #${n1}: shipping_address có lat=${Number(o1.lat).toFixed(3)} lng=${Number(o1.lng).toFixed(3)}`) : bad('không ghi toạ độ vào đơn', JSON.stringify(o1));

  sect('2. Quá hạn + terminal → worker pii-sweep xoá TOẠ ĐỘ');
  // Bật hạn lưu 6 tháng; đơn #1 lùi 8 tháng + delivered (quá hạn). Đơn #2 delivered nhưng TƯƠI.
  await owner.query(`UPDATE shops SET pii_retention_months = 6 WHERE id=$1`, [A.shopId]);
  await owner.query(`UPDATE orders SET status='delivered', created_at = now() - interval '8 months' WHERE shop_id=$1 AND order_number=$2`, [A.shopId, n1]);
  await owner.query(`UPDATE orders SET status='delivered' WHERE shop_id=$1 AND order_number=$2`, [A.shopId, n2]); // tươi (created_at = now)
  const sweep = await swp();
  typeof sweep.anonymized === 'number' && sweep.anonymized >= 1 ? ok(`pii-sweep chạy (ẩn danh ${sweep.anonymized} đơn)`) : bad('sweep không chạy', JSON.stringify(sweep));
  o1 = await coordsOf(n1);
  o1.isnull === true && o1.lat === null && o1.lng === null && o1.customer_name === '(đã ẩn danh)' && o1.customer_phone === null && o1.anonymized_at
    ? ok(`đơn #${n1}: shipping_address=NULL → TOẠ ĐỘ GPS bị xoá + tên sentinel + SĐT NULL + anonymized_at`) : bad('toạ độ GPS SỐNG SÓT qua hạn lưu', JSON.stringify(o1));
  Number(o1.total_vnd) > 0 && o1.status === 'delivered' ? ok('doanh thu + trạng thái đơn GIỮ NGUYÊN (chỉ mất danh tính)') : bad('mất dữ liệu doanh thu', JSON.stringify(o1));

  sect('3. Đơn TƯƠI (chưa quá hạn) GIỮ toạ độ — sweep có mục tiêu, không quét mù');
  const o2 = await coordsOf(n2);
  o2.isnull === false && o2.lat && o2.lng ? ok(`đơn #${n2} (tươi): shipping_address còn toạ độ (không bị đụng)`) : bad('sweep quét cả đơn chưa quá hạn', JSON.stringify(o2));

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
