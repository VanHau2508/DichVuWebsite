// E2E: CHỌN NHANH ĐỊA CHỈ khi checkout (tối ưu chốt đơn) — khách đăng nhập có địa chỉ đã lưu.
// Kiểm: trang /checkout hiện picker radio; chọn địa chỉ đã lưu → đơn dùng ĐÚNG tên/SĐT/địa chỉ
// đó (không phải gõ tay); IDOR address_id lạ → dựng lại form (không dùng); "địa chỉ khác" → gõ tay.
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = 'http://auth:3020', PLATFORM = 'http://platform:3030', SELLER = 'http://seller:3040';
const ACC = new URL(process.env.ACCOUNT_URL ?? 'http://account:3062');
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  PASS ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? ' :: ' + String(d).slice(0, 240) : '')); };
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
function acc(host, method, path, { form, origin } = {}) {
  return new Promise((resolve, reject) => {
    const data = form !== undefined ? new URLSearchParams(form).toString() : null;
    const headers = { host };
    if (data != null) { headers['content-type'] = 'application/x-www-form-urlencoded'; headers['content-length'] = Buffer.byteLength(data); }
    if (origin) headers.origin = origin;
    const req = http.request({ hostname: ACC.hostname, port: ACC.port, path, method, headers }, (rs) => {
      let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => { let tok = null; for (const c of rs.headers['set-cookie'] ?? []) { const m = /^__Host-cust_session=([^;]*)/.exec(c); if (m) tok = m[1]; } resolve({ status: rs.statusCode, body: b, setTok: tok }); });
    });
    req.on('error', reject); if (data != null) req.write(data); req.end();
  });
}
// Checkout: gửi CẢ cart cookie + cust cookie (đăng nhập).
function hreq(host, method, path, { form, json, cartTok, custTok } = {}) {
  return new Promise((resolve, reject) => {
    const data = form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : null;
    const headers = { host, origin: `https://${host}` };
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    else if (json) headers['content-type'] = 'application/json';
    if (data) headers['content-length'] = Buffer.byteLength(data);
    const cks = []; if (cartTok) cks.push(`__Host-cart=${cartTok}`); if (custTok) cks.push(`__Host-cust_session=${custTok}`);
    if (cks.length) headers.cookie = cks.join('; ');
    const req = http.request({ hostname: CO.hostname, port: CO.port, path, method, headers }, (rs) => {
      let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => { let tok = cartTok; for (const c of rs.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) tok = m[1]; } let j = null; try { j = b ? JSON.parse(b) : null; } catch {} resolve({ status: rs.statusCode, body: b, json: j, location: rs.headers.location, cartTok: tok }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
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
  const slug = `addr-${uniq()}`;
  const shopId = (await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO })).json.id;
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  return { shopId, host: `${slug}.nentang.vn`, oc: await login(oe, op) };
}
async function makeCustomer(host, shopId) {
  const email = `kh-${uniq()}@mail.vn`, pw = 'khach manh 2026 xyz';
  await acc(host, 'POST', '/account/register', { origin: `https://${host}`, form: { email, password: pw, full_name: 'KH' } });
  const lg = await acc(host, 'POST', '/account/login', { origin: `https://${host}`, form: { email, password: pw } });
  const id = (await owner.query(`SELECT id FROM customers WHERE shop_id=$1 AND lower(email)=lower($2)`, [shopId, email])).rows[0]?.id;
  return { custTok: lg.setTok, id };
}
const addAddress = (shopId, cid, a) => owner.query(
  `INSERT INTO customer_addresses (shop_id, customer_id, recipient_name, phone, line1, province, is_default)
   VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [shopId, cid, a.name, a.phone, a.line1, a.province, a.def ?? false]).then((r) => r.rows[0].id);
async function getForm(host, vid, custTok) {
  const cart = (await hreq(host, 'POST', '/cart/items', { json: { variant_id: vid, qty: 1 } })).cartTok;
  const page = await hreq(host, 'GET', '/checkout', { cartTok: cart, custTok });
  return { cart, ct: /name="ct" value="([^"]*)"/.exec(page.body)?.[1], idem: /name="idempotency_key" value="([^"]*)"/.exec(page.body)?.[1], body: page.body };
}
const orderByNum = async (shopId, num) => (await owner.query(`SELECT customer_name, customer_phone, shipping_address FROM orders WHERE shop_id=$1 AND order_number=$2`, [shopId, num])).rows[0];
const numFromLoc = (loc) => Number(new URL('http://x' + loc).searchParams.get('number'));

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff);
  const p = await rq(SELLER, 'POST', `/shops/${A.shopId}/products`, { body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: 90000, status: 'active', variants: [{ sku: `K-${uniq()}`, price_vnd: 90000 }] }, cookie: A.oc, origin: OS });
  const vid = (await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${p.json.id}`, { cookie: A.oc })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${A.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: 200, reason: 'seed' }, cookie: A.oc, origin: OS });
  const cust = await makeCustomer(A.host, A.shopId);
  const addr1 = await addAddress(A.shopId, cust.id, { name: 'Nguyễn Nhà', phone: '0911000111', line1: '12 Lê Lợi, P.Bến Nghé', province: 'TP. Hồ Chí Minh', def: true });
  const addr2 = await addAddress(A.shopId, cust.id, { name: 'Nguyễn Cơ Quan', phone: '0911000222', line1: '99 Trần Hưng Đạo', province: 'Hà Nội' });
  cust.id && addr1 && addr2 ? ok('dựng shop + SP + khách đăng nhập + 2 địa chỉ đã lưu') : bad('setup lỗi');

  sect('1. Trang /checkout hiện PICKER địa chỉ (radio) cho khách đăng nhập');
  let fm = await getForm(A.host, vid, cust.custTok);
  fm.body.includes('name="address_choice"') && fm.body.includes('Nguyễn Nhà') && fm.body.includes('Nguyễn Cơ Quan') && fm.body.includes('Giao tới địa chỉ khác')
    ? ok('picker: 2 địa chỉ đã lưu + "Giao tới địa chỉ khác"') : bad('không hiện picker', fm.body.slice(0, 200));
  fm.body.includes('Mặc định') ? ok('địa chỉ mặc định có nhãn "Mặc định"') : bad('thiếu nhãn mặc định');

  sect('1b. Layout 2 cột: khung .co-grid + tóm tắt đơn có ảnh/placeholder mỗi dòng + đủ hidden fields');
  fm.body.includes('class="co-grid"') && fm.body.includes('class="co-summary"') && fm.body.includes('class="co-main"')
    ? ok('khung 2 cột .co-grid / .co-main / .co-summary') : bad('thiếu khung 2 cột', fm.body.slice(0, 200));
  // Mỗi dòng tóm tắt có ảnh (<img class="cthumb") HOẶC placeholder (cthumb ph) — SP seed không ảnh → placeholder.
  (fm.body.includes('class="cthumb"') || fm.body.includes('class="cthumb ph"')) && fm.body.includes('class="co-line"')
    ? ok('tóm tắt đơn: mỗi dòng có ảnh thu nhỏ hoặc placeholder') : bad('tóm tắt thiếu ảnh/placeholder', fm.body.slice(0, 200));
  // Hidden fields đường tiền/idempotency/anti-bot vẫn còn nguyên trong form.
  ['idempotency_key', 'ct', 'ship_seen', 'subtotal_seen', 'lat', 'lng'].every((n) => fm.body.includes(`name="${n}"`))
    ? ok('đủ hidden fields (idempotency_key/ct/ship_seen/subtotal_seen/lat/lng)') : bad('thiếu hidden field', fm.body.slice(0, 300));
  fm.body.includes('action="/checkout/place"') && fm.body.includes('name="company"')
    ? ok('POST target /checkout/place + honeypot company còn nguyên') : bad('thiếu POST target hoặc honeypot');

  sect('2. Chọn địa chỉ đã lưu → đơn dùng ĐÚNG tên/SĐT/địa chỉ đó (không gõ tay)');
  await sleep(2600);
  let r = await hreq(A.host, 'POST', '/checkout/place', { form: { idempotency_key: fm.idem, ct: fm.ct, address_choice: addr2, payment_method: 'cod' }, cartTok: fm.cart, custTok: cust.custTok });
  if (r.status !== 303) { bad('đặt đơn địa chỉ đã lưu lỗi', `${r.status} ${r.body.slice(0, 200)}`); }
  else {
    const o = await orderByNum(A.shopId, numFromLoc(r.location));
    o.customer_name === 'Nguyễn Cơ Quan' && o.customer_phone === '0911000222' && String(o.shipping_address?.line ?? '').includes('Trần Hưng Đạo') && o.shipping_address?.province === 'Hà Nội'
      ? ok('đơn dùng địa chỉ 2 đã chọn (tên/SĐT/địa chỉ/tỉnh khớp — KHÔNG gõ tay)') : bad('đơn không dùng địa chỉ đã chọn', JSON.stringify(o));
  }

  sect('3. IDOR: address_choice = id LẠ (địa chỉ khách khác) → dựng lại form, KHÔNG đặt đơn');
  fm = await getForm(A.host, vid, cust.custTok);
  await sleep(2600);
  r = await hreq(A.host, 'POST', '/checkout/place', { form: { idempotency_key: fm.idem, ct: fm.ct, address_choice: '00000000-0000-0000-0000-000000000000', payment_method: 'cod' }, cartTok: fm.cart, custTok: cust.custTok });
  r.status === 200 && /không còn khả dụng|chọn lại/.test(r.body) ? ok('address_id lạ → dựng lại form (IDOR chặn)') : bad('IDOR không chặn', `${r.status} ${r.body.slice(0, 150)}`);

  sect('4. "Giao tới địa chỉ khác" → gõ tay, đơn dùng địa chỉ mới');
  fm = await getForm(A.host, vid, cust.custTok);
  await sleep(2600);
  r = await hreq(A.host, 'POST', '/checkout/place', { form: { idempotency_key: fm.idem, ct: fm.ct, address_choice: 'new', name: 'Khách Mới', phone: '0912345678', address_line: '5 Nguyễn Huệ', province: 'Đà Nẵng', payment_method: 'cod' }, cartTok: fm.cart, custTok: cust.custTok });
  if (r.status !== 303) { bad('đặt đơn địa chỉ mới lỗi', `${r.status} ${r.body.slice(0, 200)}`); }
  else {
    const o = await orderByNum(A.shopId, numFromLoc(r.location));
    o.customer_name === 'Khách Mới' && o.customer_phone === '0912345678' && o.shipping_address?.province === 'Đà Nẵng'
      ? ok('đơn dùng địa chỉ MỚI gõ tay (Khách Mới / Đà Nẵng)') : bad('địa chỉ mới không áp', JSON.stringify(o));
  }

  sect('5. Guest (không đăng nhập) → form thường (KHÔNG picker)');
  fm = await getForm(A.host, vid, null);
  !fm.body.includes('name="address_choice"') && fm.body.includes('name="name" required')
    ? ok('guest: form nhập tay thường (không picker, field required)') : bad('guest thấy picker?', fm.body.slice(0, 150));

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
