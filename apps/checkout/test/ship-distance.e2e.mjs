// E2E: SHIP THEO KM (0089, commit 1 money-path) — tính phí SERVER từ toạ độ, offline (haversine).
// Kiểm: phí = base + km×perKm (SÀN = phí vùng, chống toạ-độ-giả-sát-shop); km>max → 422 ngoài-vùng;
// KHÔNG coords (no-JS) → phí vùng (KHÔNG 0/NaN); coords rác (NaN) → bỏ → phí vùng; region-mode giữ nguyên.
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = 'http://auth:3020', PLATFORM = 'http://platform:3030', SELLER = 'http://seller:3040';
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
const N = (x) => (x == null ? null : Number(x));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };
// haversine THUẦN (bản sao geo.js) để test tự tính km kỳ vọng — không cần mount module.
function hav(lat1, lng1, lat2, lng2) { const R = 6371, r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r; const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(a))); }
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
  const slug = `km-${uniq()}`;
  const shopId = (await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO })).json.id;
  await owner.query(`UPDATE shops SET status='active', went_live_at=now() WHERE id=$1`, [shopId]);
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  return { shopId, host: `${slug}.nentang.vn`, oc: await login(oe, op) };
}

// Gốc shop = Hà Nội. base 5k, perKm 2k, roadFactor 1.0, maxKm 20; region near 20k, far 50k.
const ORIGIN = { lat: 21.0285, lng: 105.8542 };
const CFG = { base: 5000, perKm: 2000, maxKm: 20, near: 20000, far: 50000 };
const kmFee = (km) => Math.max(CFG.base + km * CFG.perKm, CFG.near); // SÀN = phí vùng nội miền (Hà Nội = from)

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff);
  const p = await rq(SELLER, 'POST', `/shops/${A.shopId}/products`, { body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: 100000, status: 'active', variants: [{ sku: `K-${uniq()}`, price_vnd: 100000 }] }, cookie: A.oc, origin: OS });
  const vid = (await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${p.json.id}`, { cookie: A.oc })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${A.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: 500, reason: 'seed' }, cookie: A.oc, origin: OS });
  // Bật ship theo km qua seller PATCH (validate + CHECK). over = hành vi ngoài bán kính.
  const patchShip = (over) => rq(SELLER, 'PATCH', `/shops/${A.shopId}`, { body: {
    name: 'Shop KM', ship_mode: 'distance', ship_origin_lat: ORIGIN.lat, ship_origin_lng: ORIGIN.lng,
    ship_base_vnd: CFG.base, ship_per_km_vnd: CFG.perKm, ship_max_km: CFG.maxKm, ship_road_factor: 1.0,
    ship_fee_vnd: CFG.near, ship_fee_far_vnd: CFG.far, ship_from_province: 'Hà Nội', ship_over_max_behavior: over,
  }, cookie: A.oc, origin: OS });
  let r = await patchShip('region');
  r.status === 200 ? ok('bật ship theo km (gốc HN, base 5k, 2k/km, trần 20km, sàn vùng 20k, ngoài-bán-kính=vùng)') : bad('bật distance lỗi', r.body);

  async function order(coords, province = 'Hà Nội') {
    const cart = (await co(A.host, 'POST', '/cart/items', { json: { variant_id: vid, qty: 1 } })).cartTok;
    const address = { line: '1 Test', province };
    if (coords) { address.lat = coords.lat; address.lng = coords.lng; }
    return co(A.host, 'POST', '/checkout', { json: { customer: { name: 'K', phone: '0911222333' }, address, payment_method: 'cod' }, cartTok: cart, idem: `k-${uniq()}` });
  }
  const at = (km) => ({ lat: ORIGIN.lat + km / 111.19, lng: ORIGIN.lng }); // dịch bắc ~km

  sect('1. Coords ~10km → phí = base + km×perKm (> phí vùng)');
  let c10 = at(10); let km10 = Math.ceil(hav(ORIGIN.lat, ORIGIN.lng, c10.lat, c10.lng));
  r = await order(c10);
  N(r.json?.shipping_vnd) === kmFee(km10) && kmFee(km10) > CFG.near
    ? ok(`~${km10}km → phí ${r.json.shipping_vnd}đ (= ${CFG.base}+${km10}×${CFG.perKm}, > vùng)`) : bad('phí km sai', `${r.status} ship=${r.json?.shipping_vnd} kỳ vọng=${kmFee(km10)}`);

  sect('2. SÀN PHÍ: coords SÁT shop (giả) → KHÔNG rẻ hơn phí vùng (chống gian lận)');
  r = await order(at(0.2)); // ~0.2km → km=1 → base+perKm=7k < vùng 20k → SÀN 20k
  N(r.json?.shipping_vnd) === CFG.near
    ? ok(`toạ-độ-giả-sát-shop → phí = SÀN vùng ${CFG.near}đ (không phải 7k)`) : bad('sàn phí không áp', `ship=${r.json?.shipping_vnd} kỳ vọng=${CFG.near}`);

  sect('3. NGOÀI bán kính (TOÀN QUỐC): rơi PHÍ VÙNG liên miền — KHÔNG per-km vô lý, KHÔNG từ chối');
  r = await order(at(30), 'TP. Hồ Chí Minh'); // ~30km>20 + tỉnh XA → phí vùng liên miền (vd Cà Mau→Hà Nội)
  r.status === 201 && N(r.json?.shipping_vnd) === CFG.far
    ? ok(`ngoài bán kính + tỉnh xa → phí vùng liên miền ${CFG.far}đ (KHÔNG 30×${CFG.perKm}, KHÔNG từ chối)`) : bad('ngoài bán kính không rơi phí vùng', `${r.status} ship=${r.json?.shipping_vnd}`);

  sect('3b. Shop CHỈ giao nội thành (reject) → ngoài bán kính = 422 "ngoài vùng giao"');
  await patchShip('reject');
  r = await order(at(30), 'Hà Nội');
  r.status === 422 && /ngoài vùng giao/i.test(r.body) ? ok('reject: ~30km (>trần) → 422 ngoài vùng giao (như tieutieu chỉ nội thành)') : bad('reject không chặn', `${r.status} ${r.body.slice(0, 120)}`);
  await patchShip('region'); // trả về mặc định toàn quốc cho các test sau

  sect('4. KHÔNG coords (no-JS/từ chối GPS) → phí VÙNG (không 0, không NaN)');
  r = await order(null, 'Hà Nội'); // Hà Nội = from → near 20k
  N(r.json?.shipping_vnd) === CFG.near
    ? ok(`không coords → phí vùng nội miền ${CFG.near}đ (fallback, không 0)`) : bad('fallback vùng sai', `ship=${r.json?.shipping_vnd}`);

  sect('5. Coords RÁC (lat/lng không hữu hạn) → bỏ coords → phí vùng (không NaN/total hỏng)');
  {
    const cart = (await co(A.host, 'POST', '/cart/items', { json: { variant_id: vid, qty: 1 } })).cartTok;
    r = await co(A.host, 'POST', '/checkout', { json: { customer: { name: 'K', phone: '0911222333' }, address: { line: '1 Test', province: 'Hà Nội', lat: 'abc', lng: 1e400 }, payment_method: 'cod' }, cartTok: cart, idem: `k-${uniq()}` });
  }
  r.status === 201 && N(r.json?.shipping_vnd) === CFG.near && Number.isFinite(N(r.json?.total_vnd))
    ? ok('coords rác → bỏ → phí vùng, total hữu hạn (không NaN)') : bad('coords rác lọt', `${r.status} ship=${r.json?.shipping_vnd} total=${r.json?.total_vnd}`);

  sect('6. Ngoài lãnh thổ VN (coords hợp lệ nhưng ngoài bbox VN) → phí vùng');
  r = await order({ lat: 48.85, lng: 2.35 }, 'Hà Nội'); // Paris
  r.status === 201 && N(r.json?.shipping_vnd) === CFG.near
    ? ok('coords ngoài VN → rơi phí vùng (không tính km)') : bad('coords ngoài VN vẫn tính km', `ship=${r.json?.shipping_vnd}`);

  sect('7. Shop REGION-mode → coords bị bỏ qua (tương thích ngược)');
  const B = await makeShopOwner(staff);
  const pb = await rq(SELLER, 'POST', `/shops/${B.shopId}/products`, { body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: 100000, status: 'active', variants: [{ sku: `K-${uniq()}`, price_vnd: 100000 }] }, cookie: B.oc, origin: OS });
  const vidB = (await rq(SELLER, 'GET', `/shops/${B.shopId}/products/${pb.json.id}`, { cookie: B.oc })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${B.shopId}/variants/${vidB}/inventory/adjust`, { body: { delta: 50, reason: 'seed' }, cookie: B.oc, origin: OS });
  await rq(SELLER, 'PATCH', `/shops/${B.shopId}`, { body: { name: 'Shop Region', ship_fee_vnd: 30000 }, cookie: B.oc, origin: OS });
  {
    const cart = (await co(B.host, 'POST', '/cart/items', { json: { variant_id: vidB, qty: 1 } })).cartTok;
    r = await co(B.host, 'POST', '/checkout', { json: { customer: { name: 'K', phone: '0911222444' }, address: { line: '1 Test', province: 'Hà Nội', lat: 21.5, lng: 105.9 }, payment_method: 'cod' }, cartTok: cart, idem: `k-${uniq()}` });
  }
  N(r.json?.shipping_vnd) === 30000
    ? ok('region-mode: gửi coords vẫn tính phí phẳng 30k (không đụng km)') : bad('region-mode bị coords đổi', `ship=${r.json?.shipping_vnd}`);

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
