// E2E: chống QR ngõ-cụt mất data (BLOCKER audit sẵn-sàng). Kiểm: shop chỉ-COD (không
// shop_payment_config) → trang thanh toán ẨN radio QR; POST ép payment_method=qr → KHÔNG trang lỗi cụt
// (reRender GIỮ form, không tạo đơn); shop ĐÃ bật QR → radio QR hiện lại.
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
// node:http với Host shop + form/json + cookie giỏ.
function co(host, method, path, { json, form, cartTok } = {}) {
  return new Promise((resolve, reject) => {
    const data = json !== undefined ? JSON.stringify(json) : form !== undefined ? new URLSearchParams(form).toString() : null;
    const headers = { host, origin: `https://${host}` };
    if (json !== undefined) headers['content-type'] = 'application/json';
    else if (form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (data != null) headers['content-length'] = Buffer.byteLength(data);
    if (cartTok) headers.cookie = `__Host-cart=${cartTok}`;
    const req = http.request({ hostname: CO.hostname, port: CO.port, path, method, headers }, (rs) => {
      let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch {} let tok = cartTok; for (const c of rs.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) tok = m[1]; } resolve({ status: rs.statusCode, json: j, body: b, cartTok: tok, location: rs.headers.location }); });
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
  const slug = `qr-${uniq()}`;
  const shopId = (await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO })).json.id;
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  return { shopId, host: `${slug}.nentang.vn`, oc: await login(oe, op) };
}
const hidden = (html, name) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? '';

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff);
  const p = await rq(SELLER, 'POST', `/shops/${A.shopId}/products`, { body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: 100000, status: 'active', variants: [{ sku: `K-${uniq()}`, price_vnd: 100000 }] }, cookie: A.oc, origin: OS });
  const vid = (await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${p.json.id}`, { cookie: A.oc })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${A.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: 100, reason: 'seed' }, cookie: A.oc, origin: OS });
  const newCart = async () => (await co(A.host, 'POST', '/cart/items', { json: { variant_id: vid, qty: 1 } })).cartTok;

  sect('1. Shop chỉ-COD (mặc định): trang thanh toán ẨN radio QR');
  let cart = await newCart();
  let g = await co(A.host, 'GET', '/checkout', { cartTok: cart });
  g.status === 200 && /value="cod"/.test(g.body) && !/value="qr"/.test(g.body)
    ? ok('GET /checkout: có COD, KHÔNG có radio QR (shop chưa bật QR)') : bad('vẫn hiện QR ở shop COD', g.body.match(/payment_method[^>]*/g)?.join(' | '));

  sect('2. Ép POST payment_method=qr ở shop COD → KHÔNG ngõ-cụt (reRender giữ form, KHÔNG tạo đơn)');
  const before = Number((await owner.query(`SELECT count(*)::int n FROM orders WHERE shop_id=$1`, [A.shopId])).rows[0].n);
  const r = await co(A.host, 'POST', '/checkout/place', { form: {
    idempotency_key: hidden(g.body, 'idempotency_key'), ct: hidden(g.body, 'ct'),
    subtotal_seen: hidden(g.body, 'subtotal_seen'), ship_seen: hidden(g.body, 'ship_seen'),
    name: 'Khách Thử', phone: '0912345678', address_line: '1 Test', province: 'Hà Nội', payment_method: 'qr',
  }, cartTok: cart });
  const after = Number((await owner.query(`SELECT count(*)::int n FROM orders WHERE shop_id=$1`, [A.shopId])).rows[0].n);
  const isReRender = r.status === 200 && /name="payment_method"/.test(r.body) && /name="phone"/.test(r.body); // form dựng lại
  const notDeadEnd = !/Không đặt được đơn/.test(r.body);
  const keptName = /value="Khách Thử"/.test(r.body);
  isReRender && notDeadEnd && after === before
    ? ok('POST qr → dựng lại FORM (giữ tên khách), KHÔNG trang lỗi cụt, KHÔNG tạo đơn') : bad('ngõ-cụt/tạo đơn sai', `status=${r.status} reRender=${isReRender} deadEnd=${!notDeadEnd} keptName=${keptName} orders ${before}→${after}`);

  sect('3. Shop ĐÃ bật QR → radio QR hiện lại');
  await owner.query(`INSERT INTO shop_payment_config (shop_id, bank_bin, account_number, account_name, qr_enabled) VALUES ($1,'970415','0123456789','SHOP TEST',true)`, [A.shopId]);
  cart = await newCart();
  g = await co(A.host, 'GET', '/checkout', { cartTok: cart });
  g.status === 200 && /value="qr"/.test(g.body) && /value="cod"/.test(g.body)
    ? ok('GET /checkout: shop bật QR → có CẢ COD lẫn QR') : bad('shop bật QR nhưng radio QR không hiện', g.body.match(/payment_method[^>]*/g)?.join(' | '));

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
