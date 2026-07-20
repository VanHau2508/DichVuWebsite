// E2E "MUA NGAY" mua ĐÚNG 1 món (audit polish). Kiểm: giỏ chính có X; bấm "Mua ngay" trên Y → giỏ
// RIÊNG (cookie __Host-buynow) → /checkout?bn=1 hiện CHỈ Y (không X); đặt xong → đơn CHỈ Y; giỏ chính
// vẫn còn X (không đụng). Đây là hành vi kiểu Shopee (trước đây "Mua ngay" thanh toán CẢ giỏ).
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
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? ' :: ' + String(d).slice(0, 200) : '')); };
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
// Giữ CẢ 2 cookie giỏ (__Host-cart + __Host-buynow). redirect:manual để đọc Location + Set-Cookie.
function co(host, method, path, { json, form, jar = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = json !== undefined ? JSON.stringify(json) : form !== undefined ? new URLSearchParams(form).toString() : null;
    const headers = { host, origin: `https://${host}` };
    if (json !== undefined) headers['content-type'] = 'application/json';
    else if (form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (data != null) headers['content-length'] = Buffer.byteLength(data);
    const cks = Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`);
    if (cks.length) headers.cookie = cks.join('; ');
    const req = http.request({ hostname: CO.hostname, port: CO.port, path, method, headers }, (rs) => {
      let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => {
        const nj = { ...jar };
        for (const c of rs.headers['set-cookie'] ?? []) { const m = /^(__Host-cart|__Host-buynow)=([^;]*)/.exec(c); if (m) nj[m[1]] = m[2]; }
        resolve({ status: rs.statusCode, body: b, location: rs.headers.location, jar: nj });
      });
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
const hid = (html, name) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? '';

async function main() {
  const staff = await makeStaff();
  const slug = `bn-${uniq()}`;
  const shopId = (await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO })).json.id;
  const HOST = `${slug}.nentang.vn`;
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  const oc = await login(oe, op);
  const mk = async (title) => {
    const p = await rq(SELLER, 'POST', `/shops/${shopId}/products`, { body: { title, slug: `sp-${uniq()}`, price_vnd: 100000, status: 'active', variants: [{ sku: `K-${uniq()}`, price_vnd: 100000 }] }, cookie: oc, origin: OS });
    const vid = (await rq(SELLER, 'GET', `/shops/${shopId}/products/${p.json.id}`, { cookie: oc })).json.variants[0].id;
    await rq(SELLER, 'POST', `/shops/${shopId}/variants/${vid}/inventory/adjust`, { body: { delta: 100, reason: 'seed' }, cookie: oc, origin: OS });
    return vid;
  };
  const X = await mk('SẢN PHẨM X'), Y = await mk('SẢN PHẨM Y');

  sect('1. Giỏ CHÍNH có X; "Mua ngay" Y → giỏ RIÊNG (__Host-buynow), /checkout?bn=1');
  let r = await co(HOST, 'POST', '/cart/add', { form: { variant_id: X, qty: 1 } });        // thêm X vào giỏ chính
  let jar = r.jar;
  jar['__Host-cart'] ? ok('thêm X vào giỏ chính (có __Host-cart)') : bad('không có cookie giỏ chính');
  r = await co(HOST, 'POST', '/cart/add', { form: { variant_id: Y, qty: 2, buynow: '1' }, jar }); // Mua ngay Y
  jar = r.jar;
  r.status === 303 && r.location === '/checkout?bn=1' && jar['__Host-buynow'] && jar['__Host-buynow'] !== jar['__Host-cart']
    ? ok('Mua ngay Y → 303 /checkout?bn=1 + cookie __Host-buynow RIÊNG (khác giỏ chính)') : bad('mua ngay sai', `${r.status} ${r.location} bn=${!!jar['__Host-buynow']}`);

  sect('2. /checkout?bn=1 hiện CHỈ Y (2×), KHÔNG có X');
  r = await co(HOST, 'GET', '/checkout?bn=1', { jar });
  const showY = /SẢN PHẨM Y/.test(r.body), showX = /SẢN PHẨM X/.test(r.body);
  r.status === 200 && showY && !showX ? ok('trang thanh toán mua-ngay: có Y, KHÔNG X') : bad('bn checkout sai', `Y=${showY} X=${showX}`);

  sect('3. Đặt đơn mua-ngay → đơn CHỈ Y; giỏ chính vẫn còn X');
  await sleep(2600); // qua cổng chống-bot MIN_FILL_MS (2.5s) — người thật điền form lâu hơn
  const place = await co(HOST, 'POST', '/checkout/place', { jar, form: {
    idempotency_key: hid(r.body, 'idempotency_key'), ct: hid(r.body, 'ct'),
    subtotal_seen: hid(r.body, 'subtotal_seen'), ship_seen: hid(r.body, 'ship_seen'), bn: '1',
    name: 'Khách Mua Ngay', phone: '0912345678', address_line: '1 Test', province: 'Hà Nội', payment_method: 'cod',
  } });
  const oid = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 1`, [shopId])).rows[0]?.id;
  const olines = oid ? (await owner.query(`SELECT variant_id, qty FROM order_lines WHERE order_id=$1`, [oid])).rows : [];
  const onlyY = olines.length === 1 && olines[0].variant_id === Y && Number(olines[0].qty) === 2;
  place.status === 303 && /checkout\/success/.test(place.location ?? '') && onlyY
    ? ok('đơn chốt CHỈ có Y ×2 (không kèm X của giỏ chính)') : bad('đơn mua-ngay sai', `st=${place.status} lines=${JSON.stringify(olines)}`);
  // Giỏ chính (__Host-cart) vẫn còn X — GET /cart.
  const cart = await co(HOST, 'GET', '/cart', { jar: { '__Host-cart': jar['__Host-cart'] } });
  /SẢN PHẨM X/.test(cart.body) ? ok('giỏ CHÍNH vẫn còn X (mua-ngay không đụng)') : bad('giỏ chính bị mất X', cart.body.slice(0, 120));

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
