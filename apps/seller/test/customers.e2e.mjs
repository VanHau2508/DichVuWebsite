/**
 * End-to-end CRM-lite (khách hàng). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/customers.e2e.mjs
 *
 * Kiểm: gộp theo SĐT chuẩn hoá (2 đơn 1 khách = 1 dòng), không tính đơn huỷ, tìm không
 * dấu, lọc mua ≥N, chi tiết + lịch sử, ghi chú upsert/xoá, cô lập chéo shop.
 */
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${d}${X}`); };
const sect = (m) => console.log(`\n${B}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };

async function rq(base, method, path, { body, cookie, origin } = {}) {
  const h = {};
  if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;

function co(host, method, path, { body, cartToken, idemKey } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = { host, origin: `https://${host}` };
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (cartToken) headers['cookie'] = `__Host-cart=${cartToken}`;
    if (idemKey) headers['idempotency-key'] = idemKey;
    const req = http.request({ hostname: CO.hostname, port: CO.port, path, method, headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => {
        let j = null; try { j = b ? JSON.parse(b) : null; } catch {}
        let token = cartToken;
        for (const c of res.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) token = m[1]; }
        resolve({ status: res.statusCode, json: j, raw: b, cartToken: token });
      });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

async function makeStaff() {
  const email = `staff-${uniq()}@nentang.vn`, password = 'staff strong passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let cookie = await login(email, password);
  let r = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie, origin: OA });
  const key = base32Decode(r.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie, body: { code: totp(key, {}) }, origin: OA });
  const c = counterFor(Date.now());
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,'admin')`, [await uidOf(email)]);
  while (counterFor(Date.now()) <= c) await sleep(1000);
  cookie = await login(email, password);
  cookie = ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).sc) ?? cookie;
  return cookie;
}
async function makeShopOwner(staffCookie, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: r.json.token, password }, origin: OA });
  return { shopId, slug, host: `${slug}.nentang.vn`, email, password, cookie: await login(email, password) };
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `crm-${uniq()}`);
  let r = await rq(SELLER, 'POST', `/shops/${A.shopId}/products`, { body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: 100000, status: 'active', variants: [{ sku: `C-${uniq()}`, price_vnd: 100000 }] }, cookie: A.cookie, origin: OS });
  const vid = (await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${r.json.id}`, { cookie: A.cookie })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${A.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: 30, reason: 'seed' }, cookie: A.cookie, origin: OS });

  const buy = async (name, phone, qty = 1) => {
    const cart = (await co(A.host, 'POST', '/cart/items', { body: { variant_id: vid, qty } })).cartToken;
    const oc = await co(A.host, 'POST', '/checkout', { body: { customer: { name, phone }, payment_method: 'cod' }, cartToken: cart, idemKey: `k-${uniq()}` });
    if (oc.status !== 201) throw new Error(oc.raw);
    return oc.json.order_number;
  };
  // Khách "Nguyễn Văn Tèo": 2 đơn với 2 ĐỊNH DẠNG SĐT khác nhau (phải gộp 1 dòng nhờ canonPhone).
  const P = '0911222333';
  await buy('Nguyễn Văn Tèo', '0911222333');
  await buy('Nguyễn Văn Tèo', '+84 911 222 333', 2);
  // Khách khác 1 đơn + 1 đơn bị HUỶ (không được tính).
  const n2 = await buy('Trần Thị Hai', '0988777666');
  const cancelNum = await buy('Trần Thị Hai', '0988777666');
  const cid = (await owner.query(`SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2`, [A.shopId, cancelNum])).rows[0].id;
  await rq(SELLER, 'POST', `/shops/${A.shopId}/orders/${cid}/cancel`, { cookie: A.cookie, origin: OS });
  ok('dựng shop + 4 đơn (2 khách, 1 đơn huỷ)');

  sect('1. Danh sách khách gộp theo SĐT');
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/customers`, { cookie: A.cookie });
  r.json?.total === 2 ? ok('2 khách (đơn huỷ không sinh khách ma)') : bad(`total sai: ${r.json?.total}`, r.raw);
  const teo = r.json.customers.find((c) => c.phone === P);
  teo && teo.n_orders === 2 && Number(teo.total_spent_vnd) === (100000 + 30000) + (200000 + 30000)
    ? ok('2 định dạng SĐT gộp 1 khách, 2 đơn, tổng chi đúng (360k)') : bad('gộp SĐT sai', JSON.stringify(teo));
  const hai = r.json.customers.find((c) => c.phone === '0988777666');
  hai?.n_orders === 1 ? ok('đơn HUỶ không tính vào số đơn') : bad('đơn huỷ bị tính', JSON.stringify(hai));

  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/customers?q=${encodeURIComponent('nguyen van')}`, { cookie: A.cookie });
  r.json?.customers?.length === 1 && r.json.customers[0].phone === P ? ok('tìm "nguyen van" (không dấu) ra đúng khách') : bad('tìm không dấu fail', r.raw);
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/customers?min_orders=2`, { cookie: A.cookie });
  r.json?.total === 1 ? ok('lọc mua ≥2 đơn → 1 khách') : bad('lọc min_orders sai', r.raw);

  sect('2. Chi tiết + ghi chú');
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/customers/${P}`, { cookie: A.cookie });
  r.status === 200 && r.json.orders.length === 2 && r.json.n_orders === 2 ? ok('chi tiết: lịch sử 2 đơn') : bad('chi tiết sai', r.raw);
  r = await rq(SELLER, 'PUT', `/shops/${A.shopId}/customers/${P}/note`, { body: { note: 'Khách quen, giao giờ hành chính' }, cookie: A.cookie, origin: OS });
  r.status === 200 ? ok('lưu ghi chú → 200') : bad('note lỗi', r.raw);
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/customers/${P}`, { cookie: A.cookie });
  r.json.note === 'Khách quen, giao giờ hành chính' ? ok('đọc lại ghi chú đúng') : bad('note sai', r.json.note);
  await rq(SELLER, 'PUT', `/shops/${A.shopId}/customers/${P}/note`, { body: { note: '' }, cookie: A.cookie, origin: OS });
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/customers/${P}`, { cookie: A.cookie });
  r.json.note === '' ? ok('note rỗng → xoá') : bad('xoá note fail', r.json.note);

  sect('3. Cô lập chéo shop');
  const Bs = await makeShopOwner(staff, `crmb-${uniq()}`);
  r = await rq(SELLER, 'GET', `/shops/${Bs.shopId}/customers`, { cookie: Bs.cookie });
  r.json?.total === 0 ? ok('shop B không thấy khách shop A') : bad('rò khách chéo shop', r.raw);
  r = await rq(SELLER, 'GET', `/shops/${Bs.shopId}/customers/${P}`, { cookie: Bs.cookie });
  r.status === 404 ? ok('shop B xem chi tiết khách shop A → 404') : bad('rò chi tiết', r.raw);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
