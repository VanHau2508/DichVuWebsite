// E2E: GPS reverse-geocode + nút định vị (0089 ship-2). Kiểm: /checkout/geocode đổi toạ độ → địa
// chỉ + phí (stub, không mạng); provider lỗi → soft-fallback (checkout không chết); ngoài VN / non-
// distance / coords rác xử đúng; trang checkout distance có nút "Dùng vị trí" + CSP script-src nonce;
// trang region KHÔNG có script (CSP khoá cứng như cũ).
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
// node:http → set Host + đọc HEADER (CSP). json/form; trả {status, body, json, headers, cartTok}.
function hreq(host, method, path, { json, cartTok } = {}) {
  return new Promise((resolve, reject) => {
    const data = json !== undefined ? JSON.stringify(json) : null;
    const headers = { host, origin: `https://${host}` };
    if (data != null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (cartTok) headers.cookie = `__Host-cart=${cartTok}`;
    const req = http.request({ hostname: CO.hostname, port: CO.port, path, method, headers }, (rs) => {
      let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch {} let tok = cartTok; for (const c of rs.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) tok = m[1]; } resolve({ status: rs.statusCode, body: b, json: j, headers: rs.headers, cartTok: tok }); });
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
  const slug = `geo-${uniq()}`;
  const shopId = (await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO })).json.id;
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  return { shopId, host: `${slug}.nentang.vn`, oc: await login(oe, op) };
}
const ORIGIN = { lat: 21.0285, lng: 105.8542 }; // Hà Nội
const CFG = { base: 5000, perKm: 2000, maxKm: 20, near: 20000, far: 50000 };
const kmFee = (km) => Math.max(CFG.base + km * CFG.perKm, CFG.near);

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff);
  const p = await rq(SELLER, 'POST', `/shops/${A.shopId}/products`, { body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: 100000, status: 'active', variants: [{ sku: `K-${uniq()}`, price_vnd: 100000 }] }, cookie: A.oc, origin: OS });
  const vid = (await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${p.json.id}`, { cookie: A.oc })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${A.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: 200, reason: 'seed' }, cookie: A.oc, origin: OS });
  let r = await rq(SELLER, 'PATCH', `/shops/${A.shopId}`, { body: {
    name: 'Shop GPS', ship_mode: 'distance', ship_origin_lat: ORIGIN.lat, ship_origin_lng: ORIGIN.lng,
    ship_base_vnd: CFG.base, ship_per_km_vnd: CFG.perKm, ship_max_km: CFG.maxKm, ship_road_factor: 1.0,
    ship_fee_vnd: CFG.near, ship_fee_far_vnd: CFG.far, ship_from_province: 'Hà Nội',
  }, cookie: A.oc, origin: OS });
  r.status === 200 ? ok('dựng shop ship theo km + GPS (stub)') : bad('setup lỗi', r.raw);
  const newCart = async () => (await hreq(A.host, 'POST', '/cart/items', { json: { variant_id: vid, qty: 1 } })).cartTok;
  const at = (km) => ({ lat: ORIGIN.lat + km / 111.19, lng: ORIGIN.lng });

  sect('1. /checkout/geocode: toạ độ → địa chỉ + phí (stub, không gọi mạng)');
  let cart = await newCart();
  const c10 = at(10); const km10 = Math.ceil(hav(ORIGIN.lat, ORIGIN.lng, c10.lat, c10.lng));
  r = await hreq(A.host, 'POST', '/checkout/geocode', { json: { lat: c10.lat, lng: c10.lng, accuracy: 20 }, cartTok: cart });
  r.status === 200 && r.json?.available === true && r.json.address?.province === 'Hà Nội' && r.json.address?.line && N(r.json.shipping_vnd) === kmFee(km10) && N(r.json.ship_seen) === kmFee(km10)
    ? ok(`geocode → địa chỉ (tỉnh Hà Nội) + phí ${r.json.shipping_vnd}đ (~${km10}km) + ship_seen`) : bad('geocode sai', JSON.stringify(r.json));

  sect('2. Provider LỖI (stub ném) → soft-fallback available:false, KHÔNG 500');
  cart = await newCart();
  r = await hreq(A.host, 'POST', '/checkout/geocode', { json: { lat: 22.95, lng: 105.85, accuracy: 20 }, cartTok: cart }); // dải stub ném lỗi
  r.status === 200 && r.json?.available === false && r.json?.reason === 'geocode_failed'
    ? ok('provider lỗi → available:false (checkout vẫn đặt được, nhập tay)') : bad('không soft-fallback', JSON.stringify(r.json));

  sect('3. Coords NGOÀI VN → available:false (không gọi provider)');
  cart = await newCart();
  r = await hreq(A.host, 'POST', '/checkout/geocode', { json: { lat: 48.85, lng: 2.35 }, cartTok: cart }); // Paris
  r.status === 200 && r.json?.available === false && r.json?.reason === 'outside_vn' ? ok('ngoài VN → available:false') : bad('ngoài VN sai', JSON.stringify(r.json));

  sect('4. Coords RÁC → 400');
  cart = await newCart();
  r = await hreq(A.host, 'POST', '/checkout/geocode', { json: { lat: 'abc', lng: 1e400 }, cartTok: cart });
  r.status === 400 ? ok('coords rác → 400') : bad('coords rác không chặn', r.status);

  sect('5. Shop REGION-mode → available:false (không tính km)');
  const B = await makeShopOwner(staff);
  const pb = await rq(SELLER, 'POST', `/shops/${B.shopId}/products`, { body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: 100000, status: 'active', variants: [{ sku: `K-${uniq()}`, price_vnd: 100000 }] }, cookie: B.oc, origin: OS });
  const vidB = (await rq(SELLER, 'GET', `/shops/${B.shopId}/products/${pb.json.id}`, { cookie: B.oc })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${B.shopId}/variants/${vidB}/inventory/adjust`, { body: { delta: 50, reason: 'seed' }, cookie: B.oc, origin: OS });
  const cartB = (await hreq(B.host, 'POST', '/cart/items', { json: { variant_id: vidB, qty: 1 } })).cartTok;
  r = await hreq(B.host, 'POST', '/checkout/geocode', { json: { lat: c10.lat, lng: c10.lng }, cartTok: cartB });
  r.json?.available === false && r.json?.reason === 'not_distance' ? ok('region-mode → available:false (not_distance)') : bad('region-mode geocode sai', JSON.stringify(r.json));

  sect('6. Trang checkout DISTANCE: có nút "Dùng vị trí" + CSP script-src nonce + script khớp nonce');
  cart = await newCart();
  r = await hreq(A.host, 'GET', '/checkout', { cartTok: cart });
  const csp = r.headers['content-security-policy'] ?? '';
  const nonceInCsp = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
  const nonceInScript = /<script nonce="([^"]+)"/.exec(r.body)?.[1];
  r.body.includes('Dùng vị trí') && r.body.includes('id="use-gps"') && /connect-src 'self'/.test(csp) && nonceInCsp && nonceInCsp === nonceInScript
    ? ok('checkout distance: nút GPS + CSP script-src nonce + <script> khớp nonce') : bad('trang GPS sai', `btn=${r.body.includes('use-gps')} csp=${csp.slice(0, 80)} nonceMatch=${nonceInCsp === nonceInScript}`);
  !/innerHTML/.test(r.body) ? ok('script KHÔNG dùng innerHTML (XSS-safe)') : bad('script có innerHTML (nguy cơ XSS)');

  sect('7. Trang checkout REGION: KHÔNG script (CSP khoá cứng như cũ)');
  r = await hreq(B.host, 'GET', '/checkout', { cartTok: cartB });
  const cspB = r.headers['content-security-policy'] ?? '';
  !/<script/.test(r.body) && !/script-src/.test(cspB) && /default-src 'none'/.test(cspB)
    ? ok('region: không <script>, CSP không script-src (no-JS khoá cứng)') : bad('region rò script', `hasScript=${/<script/.test(r.body)} csp=${cspB.slice(0, 80)}`);

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
