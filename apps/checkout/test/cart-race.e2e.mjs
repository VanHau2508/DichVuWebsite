// E2E Đợt 6.1: đua giỏ→đơn. Kiểm toán tấn công tái hiện: N request đồng thời KHÁC
// Idempotency-Key nhưng CÙNG cart cookie → trước khi vá, 1 giỏ đẻ N đơn + reserved phình N.
// Sau vá (findCart FOR UPDATE + guard convert status='active'): đúng 1 đơn, phần còn lại 400/409.
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 5 });
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  PASS ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? ' :: ' + String(d).slice(0, 160) : '')); };
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
// HTTP thô đặt Host + cookie giỏ + Idempotency-Key.
function co(method, path, { json, cartCookie, idem } = {}) {
  return new Promise((resolve, reject) => {
    const data = json !== undefined ? JSON.stringify(json) : null;
    const headers = { host: HOST, origin: `https://${HOST}` };
    if (data != null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (cartCookie) headers.cookie = `__Host-cart=${cartCookie}`;
    if (idem) headers['idempotency-key'] = idem;
    const req = http.request({ hostname: CO.hostname, port: CO.port, path, method, headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => {
        let j = null; try { j = b ? JSON.parse(b) : null; } catch {}
        let token = cartCookie;
        for (const c of res.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) token = m[1]; }
        resolve({ status: res.statusCode, json: j, raw: b, cartCookie: token });
      });
    });
    req.on('error', reject); if (data != null) req.write(data); req.end();
  });
}
let HOST;
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
async function main() {
  const staff = await makeStaff();
  const slug = `race-${uniq()}`;
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
  const shopId = r.json.id; HOST = `${slug}.nentang.vn`;
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  const oc = await login(oe, op);
  r = await rq(SELLER, 'POST', `/shops/${shopId}/products`, { body: { title: 'SP đua', slug: `sp-${uniq()}`, price_vnd: 100000, status: 'active', variants: [{ sku: `R-${uniq()}`, price_vnd: 100000 }] }, cookie: oc, origin: OS });
  const vid = (await rq(SELLER, 'GET', `/shops/${shopId}/products/${r.json.id}`, { cookie: oc })).json.variants[0].id;
  // tồn RỘNG (50) để loại trừ chuyện oversell tự chặn — ta muốn thấy CHÍNH cơ chế giỏ.
  await rq(SELLER, 'POST', `/shops/${shopId}/variants/${vid}/inventory/adjust`, { body: { delta: 50, reason: 'nhập' }, cookie: oc, origin: OS });

  console.log('\n# Đua N=10 request /checkout đồng thời, KHÁC Idempotency-Key, CÙNG 1 giỏ');
  const N = 10;
  const cart = (await co('POST', '/cart/items', { json: { variant_id: vid, qty: 1 } })).cartCookie;
  const reqs = Array.from({ length: N }, (_, i) => co('POST', '/checkout', {
    json: { customer: { name: 'K', phone: '0912000111', email: `k${i}@x.vn` }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' },
    cartCookie: cart, idem: `race-${uniq()}-${i}`,
  }));
  const res = await Promise.all(reqs);
  const created = res.filter((x) => x.status === 201);
  const nums = new Set(created.map((x) => x.json?.order_number));
  console.log(`  → tạo 201: ${created.length} | mã đơn KHÁC nhau: ${nums.size} | status: ${res.map((x) => x.status).sort().join(',')}`);

  created.length === 1 ? ok('ĐÚNG 1 đơn được tạo từ 1 giỏ (đua bị chặn)') : bad(`${created.length} đơn từ 1 giỏ — LỖ HỔNG đua`, JSON.stringify(res.map((x) => x.status)));
  const orderRows = Number((await owner.query(`SELECT count(*)::int n FROM orders WHERE shop_id=$1`, [shopId])).rows[0].n);
  orderRows === 1 ? ok('DB: đúng 1 dòng orders') : bad(`DB có ${orderRows} đơn`, '');
  const rsv = Number((await owner.query(`SELECT reserved FROM inventory_levels WHERE variant_id=$1`, [vid])).rows[0].reserved);
  rsv === 1 ? ok('reserved = 1 (không phình theo số request đua)') : bad(`reserved = ${rsv} (kỳ vọng 1)`, '');
  const cst = (await owner.query(`SELECT status FROM carts WHERE token_hash = encode(digest($1,'sha256'),'hex')`, [cart])).rows[0]?.status;
  cst === 'converted' ? ok("giỏ → 'converted' đúng 1 lần") : bad(`giỏ status=${cst}`, '');

  console.log('\n# Đua lần 2: giỏ đã converted → mọi request phải TRƯỢT (không đơn mới)');
  const res2 = await Promise.all(Array.from({ length: 5 }, (_, i) => co('POST', '/checkout', {
    json: { customer: { name: 'K', phone: '0912000111' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' },
    cartCookie: cart, idem: `race2-${uniq()}-${i}`,
  })));
  res2.every((x) => x.status !== 201) ? ok('giỏ đã đặt → 0 đơn mới (tất cả 400/409)') : bad('vẫn tạo được đơn từ giỏ đã converted', JSON.stringify(res2.map((x) => x.status)));
  const finalN = Number((await owner.query(`SELECT count(*)::int n FROM orders WHERE shop_id=$1`, [shopId])).rows[0].n);
  finalN === 1 ? ok('DB vẫn đúng 1 đơn sau đua lần 2') : bad(`DB có ${finalN} đơn`, '');

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
