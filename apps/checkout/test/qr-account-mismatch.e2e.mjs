// E2E #26: shop đổi TK nhận tiền → trang đơn KHÔNG vẽ QR theo config mới
// (webhook chỉ khớp snapshot qr_account) mà báo khách liên hệ shop. Đổi lại → QR trở lại.
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = 'http://auth:3020', PLATFORM = 'http://platform:3030', SELLER = 'http://seller:3040';
const CO = new URL('http://checkout:3060');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  PASS ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? ' :: ' + d : '')); };
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
const login = async (e, p) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email: e, password: p }, origin: OA })).sc);
const uidOf = async (e) => (await owner.query('SELECT id FROM users WHERE email=$1', [e])).rows[0]?.id ?? null;
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
async function main() {
  // staff + shop + product (mirror manual-orders harness)
  const email = `staff-${uniq()}@nentang.vn`, password = 'staff strong passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let staff = await login(email, password);
  let r = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie: staff, origin: OA });
  const key = base32Decode(r.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie: staff, body: { code: totp(key, {}) }, origin: OA });
  const c0 = counterFor(Date.now());
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,'admin')`, [await uidOf(email)]);
  while (counterFor(Date.now()) <= c0) await sleep(1000);
  staff = await login(email, password);
  staff = ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie: staff, body: { code: totp(key, {}) }, origin: OA })).sc) ?? staff;
  const slug = `qrp-${uniq()}`;
  r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
  const shopId = r.json.id, host = `${slug}.nentang.vn`;
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: r.json.token, password: op }, origin: OA });
  const ck1 = await login(oe, op);
  r = await rq(SELLER, 'POST', `/shops/${shopId}/products`, { body: { title: 'SP QR', slug: `sp-${uniq()}`, price_vnd: 200000, status: 'active', variants: [{ sku: `Q-${uniq()}`, price_vnd: 200000 }] }, cookie: ck1, origin: OS });
  const vid = (await rq(SELLER, 'GET', `/shops/${shopId}/products/${r.json.id}`, { cookie: ck1 })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${shopId}/variants/${vid}/inventory/adjust`, { body: { delta: 5, reason: 'seed' }, cookie: ck1, origin: OS });
  // bật QR (payment.write + step-up)
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: op }, cookie: ck1, origin: OA });
  r = await rq(SELLER, 'PUT', `/shops/${shopId}/payment-config`, { body: { bank_bin: '970415', account_number: '1111111111', account_name: 'SHOP QR', qr_enabled: true }, cookie: ck1, origin: OS });
  r.status === 200 ? ok('bật QR (TK 1111111111)') : bad('config lỗi', r.raw);
  // đặt đơn QR
  const cart = (await co(host, 'POST', '/cart/items', { body: { variant_id: vid, qty: 1 } })).cartToken;
  const oc = await co(host, 'POST', '/checkout', { body: { customer: { name: 'K', phone: '0912345679' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'qr' }, cartToken: cart, idemKey: `k-${uniq()}` });
  oc.status === 201 ? ok('đơn QR tạo 201') : bad('checkout lỗi', oc.raw);
  const num = oc.json.order_number, tok = oc.json.lookup_token;
  // 1) TK khớp snapshot → có QR
  let pg1 = await co(host, 'GET', `/checkout/success?number=${num}&token=${encodeURIComponent(tok)}`);
  /<svg/.test(pg1.raw) && /1111111111/.test(pg1.raw) ? ok('TK khớp → trang vẽ QR + số TK snapshot') : bad('không thấy QR', String(pg1.status));
  // 2) shop ĐỔI TK → trang phải NGỪNG vẽ QR + báo liên hệ shop
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: op }, cookie: ck1, origin: OA });
  await rq(SELLER, 'PUT', `/shops/${shopId}/payment-config`, { body: { bank_bin: '970415', account_number: '2222222222', account_name: 'SHOP QR', qr_enabled: true }, cookie: ck1, origin: OS });
  let pg2 = await co(host, 'GET', `/checkout/success?number=${num}&token=${encodeURIComponent(tok)}`);
  !/2222222222/.test(pg2.raw) && /Thanh toán tạm gián đoạn/.test(pg2.raw)
    ? ok('TK ĐỔI → KHÔNG vẽ QR theo TK mới, báo "liên hệ cửa hàng"') : bad('vẫn dụ khách trả TK mới!', String(pg2.status));
  // 3) đổi LẠI TK cũ → QR trở lại
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: op }, cookie: ck1, origin: OA });
  await rq(SELLER, 'PUT', `/shops/${shopId}/payment-config`, { body: { bank_bin: '970415', account_number: '1111111111', account_name: 'SHOP QR', qr_enabled: true }, cookie: ck1, origin: OS });
  let pg3 = await co(host, 'GET', `/checkout/success?number=${num}&token=${encodeURIComponent(tok)}`);
  /<svg/.test(pg3.raw) && /1111111111/.test(pg3.raw) ? ok('TK khôi phục → QR trở lại') : bad('QR không trở lại', String(pg3.status));
  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
