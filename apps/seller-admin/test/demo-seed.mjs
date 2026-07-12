/**
 * Seed DỮ LIỆU DEMO SẠCH để xem hệ thống (KHÔNG phải test). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/demo-seed.mjs
 *
 * Tạo 1 cửa hàng nội thất có tên thật, chủ shop (đăng nhập được), 6 sản phẩm + tồn,
 * và 6 đơn ở các trạng thái khác nhau (pending/confirmed/shipped/delivered/cancelled)
 * để màn quản đơn "sống". In ra thông tin đăng nhập + URL ở cuối.
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
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const uniq = () => Math.random().toString(36).slice(2, 8);
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
function co(host, method, path, { body, cartToken, idemKey } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = { host, origin: `https://${host}` };
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (cartToken) headers['cookie'] = `__Host-cart=${cartToken}`;
    if (idemKey) headers['idempotency-key'] = idemKey;
    const req = http.request({ hostname: CO.hostname, port: CO.port, path, method, headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch {} let token = cartToken; for (const c of res.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) token = m[1]; } resolve({ status: res.statusCode, json: j, cartToken: token }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;

async function makeStaff() {
  const email = `staff-${uniq()}@nentang.vn`, password = 'staff strong passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let cookie = await login(email, password);
  const r = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie, origin: OA });
  const key = base32Decode(r.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie, body: { code: totp(key, {}) }, origin: OA });
  const c = counterFor(Date.now());
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,'admin')`, [await uidOf(email)]);
  while (counterFor(Date.now()) <= c) await sleep(1000);
  cookie = await login(email, password);
  // A6: mfa/verify ROTATE token → lấy cookie mới
  cookie = ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).sc) ?? cookie;
  return cookie;
}

const SLUG = `nha-xinh-${uniq()}`;                 // duy nhất để chạy lại không đụng
const OWNER_EMAIL = `chushop-${uniq()}@nhaxinh.vn`;
const OWNER_PW = 'nha xinh chu shop 2026';
const SHOP_NAME = 'Nhà Xinh Décor';

const PRODUCTS = [
  { title: 'Ghế sofa vải nỉ 3 chỗ', price: 4990000, stock: 8 },
  { title: 'Bàn trà gỗ sồi tự nhiên', price: 1850000, stock: 15 },
  { title: 'Đèn ngủ để bàn phong cách Bắc Âu', price: 390000, stock: 40 },
  { title: 'Kệ sách 5 tầng khung sắt', price: 1290000, stock: 12 },
  { title: 'Thảm trải sàn lông ngắn 1m6x2m3', price: 650000, stock: 25 },
  { title: 'Gương treo tường viền mây đan', price: 820000, stock: 18 },
];
const CUSTOMERS = [
  { name: 'Nguyễn Thị Hương', phone: '0912345678' },
  { name: 'Trần Văn Nam', phone: '0987654321' },
  { name: 'Lê Minh Anh', phone: '0903334455' },
  { name: 'Phạm Thu Hà', phone: '0977889900' },
  { name: 'Hoàng Đức Long', phone: '0938112233' },
  { name: 'Đỗ Thị Mai', phone: '0961445566' },
];

async function main() {
  const staff = await makeStaff();
  // Shop + chủ shop.
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: SHOP_NAME, slug: SLUG, plan_code: 'platform' }, cookie: staff, origin: OO });
  const shopId = r.json.id;
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: OWNER_EMAIL, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: r.json.token, password: OWNER_PW }, origin: OA });
  const oc = await login(OWNER_EMAIL, OWNER_PW);
  const host = `${SLUG}.nentang.vn`;

  // Sản phẩm + tồn.
  const vids = [];
  for (const p of PRODUCTS) {
    const pr = await rq(SELLER, 'POST', `/shops/${shopId}/products`, { body: { title: p.title, slug: `${p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}-${uniq()}`, price_vnd: p.price, status: 'active', variants: [{ sku: `NX-${uniq()}`, price_vnd: p.price }] }, cookie: oc, origin: OS });
    const det = await rq(SELLER, 'GET', `/shops/${shopId}/products/${pr.json.id}`, { cookie: oc });
    const vid = det.json.variants[0].id;
    await rq(SELLER, 'POST', `/shops/${shopId}/variants/${vid}/inventory/adjust`, { body: { delta: p.stock, reason: 'nhập lô đầu' }, cookie: oc, origin: OS });
    vids.push(vid);
  }

  // Đơn: đặt qua checkout (COD) rồi chuyển trạng thái để có đủ pha.
  async function place(cust, items) {
    let cart;
    for (const it of items) cart = (await co(host, 'POST', '/cart/items', { body: { variant_id: it.vid, qty: it.qty }, cartToken: cart })).cartToken;
    const cr = await co(host, 'POST', '/checkout', { body: { customer: cust, address: { line: 'Số 12 Ngõ 34 Trần Duy Hưng, Cầu Giấy, Hà Nội' }, payment_method: 'cod' }, cartToken: cart, idemKey: `demo-${uniq()}` });
    const oid = (await owner.query('SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2', [shopId, cr.json.order_number])).rows[0].id;
    return oid;
  }
  const act = (oid, action, body) => rq(SELLER, 'POST', `/shops/${shopId}/orders/${oid}/${action}`, { body, cookie: oc, origin: OS });

  const o0 = await place(CUSTOMERS[0], [{ vid: vids[0], qty: 1 }, { vid: vids[2], qty: 2 }]); // pending
  const o1 = await place(CUSTOMERS[1], [{ vid: vids[1], qty: 1 }]);                            // pending
  const o2 = await place(CUSTOMERS[2], [{ vid: vids[3], qty: 1 }, { vid: vids[4], qty: 1 }]); await act(o2, 'confirm'); // confirmed
  const o3 = await place(CUSTOMERS[3], [{ vid: vids[5], qty: 1 }]); await act(o3, 'confirm'); await act(o3, 'ship', { tracking_number: 'GHN' + uniq().toUpperCase(), carrier: 'GHN' }); // shipped
  const o4 = await place(CUSTOMERS[4], [{ vid: vids[2], qty: 3 }]); await act(o4, 'confirm'); await act(o4, 'ship', { tracking_number: 'GHTK' + uniq().toUpperCase(), carrier: 'GHTK' }); await act(o4, 'deliver'); // delivered
  const o5 = await place(CUSTOMERS[5], [{ vid: vids[4], qty: 2 }]); await act(o5, 'cancel'); // cancelled

  const out = { shopId, slug: SLUG, host, ownerEmail: OWNER_EMAIL, ownerPassword: OWNER_PW, shopName: SHOP_NAME, products: PRODUCTS.length, orders: 6 };
  console.log('\n=== DEMO SEED OK ===');
  console.log(JSON.stringify(out, null, 2));
  await owner.end();
  process.exit(0);
}
main().catch((e) => { console.error('demo seed lỗi:', e); process.exit(2); });
