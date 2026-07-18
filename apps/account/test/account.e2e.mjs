// E2E service tài khoản khách (0083) — commit 2: đăng ký ENUM-SAFE + KHÔNG auto-login,
// đăng nhập (DUMMY_HASH timing-safe), đăng xuất, CSRF, cô lập shop, chặn MK yếu.
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = 'http://auth:3020', PLATFORM = 'http://platform:3030';
const ACC = new URL(process.env.ACCOUNT_URL ?? 'http://account:3062');
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
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
  return { status: r.status, json: j, sc: r.headers.getSetCookie() };
}
const login = async (e, p) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email: e, password: p }, origin: OA })).sc);
const uidOf = async (e) => (await owner.query('SELECT id FROM users WHERE email=$1', [e])).rows[0]?.id ?? null;
// Gọi account service: Host = domain shop; đọc __Host-cust_session từ set-cookie.
function acc(host, method, path, { form, cookie, origin } = {}) {
  return new Promise((resolve, reject) => {
    const data = form !== undefined ? new URLSearchParams(form).toString() : null;
    const headers = { host };
    if (data != null) { headers['content-type'] = 'application/x-www-form-urlencoded'; headers['content-length'] = Buffer.byteLength(data); }
    if (origin) headers.origin = origin;
    if (cookie) headers.cookie = `__Host-cust_session=${cookie}`;
    const req = http.request({ hostname: ACC.hostname, port: ACC.port, path, method, headers }, (rs) => {
      let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => {
        let tok = null; for (const c of rs.headers['set-cookie'] ?? []) { const m = /^__Host-cust_session=([^;]*)/.exec(c); if (m) tok = m[1]; }
        resolve({ status: rs.statusCode, body: b, location: rs.headers.location, setTok: tok, hasSetCookie: (rs.headers['set-cookie'] ?? []).some((c) => c.startsWith('__Host-cust_session=')) });
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
const mkShop = async (staff, slug) => { const r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO }); return { shopId: r.json.id, host: `${slug}.nentang.vn` }; };
const N = (x) => Number(x);
// Gọi checkout service với Host shop + cart cookie + cust cookie (đăng nhập).
function co(host, method, path, { json, cartTok, custTok, idem } = {}) {
  return new Promise((resolve, reject) => {
    const data = json !== undefined ? JSON.stringify(json) : null;
    const headers = { host, origin: `https://${host}` };
    if (data != null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const cks = []; if (cartTok) cks.push(`__Host-cart=${cartTok}`); if (custTok) cks.push(`__Host-cust_session=${custTok}`);
    if (cks.length) headers.cookie = cks.join('; ');
    if (idem) headers['idempotency-key'] = idem;
    const req = http.request({ hostname: CO.hostname, port: CO.port, path, method, headers }, (rs) => {
      let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch {} let tok = cartTok; for (const c of rs.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) tok = m[1]; } resolve({ status: rs.statusCode, json: j, body: b, cartTok: tok }); });
    });
    req.on('error', reject); if (data != null) req.write(data); req.end();
  });
}

async function main() {
  const staff = await makeStaff();
  const A = await mkShop(staff, `acc-${uniq()}`);
  const B = await mkShop(staff, `accb-${uniq()}`);
  const host = A.host, O = `https://${host}`;
  const email = `kh-${uniq()}@mail.vn`, pw = 'khach manh 2026 xyz';
  const custCount = (shopId, em) => owner.query(`SELECT count(*)::int n FROM customers WHERE shop_id=$1 AND lower(email)=lower($2)`, [shopId, em]).then((r) => r.rows[0].n);

  sect('1. GET /account/login → form; GET /account (chưa đăng nhập) → 303 login');
  let r = await acc(host, 'GET', '/account/login');
  r.status === 200 && r.body.includes('Đăng nhập') && r.body.includes('name="password"') ? ok('trang đăng nhập render') : bad('login page lỗi', r.status);
  r = await acc(host, 'GET', '/account');
  r.status === 303 && r.location === '/account/login' ? ok('/account chưa đăng nhập → 303 login') : bad('dashboard không chặn', `${r.status} ${r.location}`);

  sect('2. Đăng ký ENUM-SAFE + KHÔNG auto-login');
  r = await acc(host, 'POST', '/account/register', { origin: O, form: { email, password: pw, full_name: 'Nguyễn Khách' } });
  const doneBody = r.body;
  r.status === 200 && r.body.includes('Gần xong') && !r.hasSetCookie ? ok('đăng ký email mới → trang trung tính, KHÔNG set cookie (không auto-login)') : bad('đăng ký auto-login/sai', `${r.status} setCookie=${r.hasSetCookie}`);
  N(await custCount(A.shopId, email)) === 1 ? ok('DB: 1 khách được tạo') : bad('không tạo khách');
  // Đăng ký LẠI cùng email → phản hồi Y HỆT (không lộ "đã tồn tại"), vẫn 1 khách.
  r = await acc(host, 'POST', '/account/register', { origin: O, form: { email, password: 'khac han mat khau 99', full_name: 'X' } });
  r.status === 200 && r.body === doneBody && !r.hasSetCookie ? ok('đăng ký lại cùng email → body Y HỆT (enum-safe)') : bad('lộ email đã tồn tại', `${r.status} same=${r.body === doneBody}`);
  N(await custCount(A.shopId, email)) === 1 ? ok('DB: vẫn 1 khách (không tạo trùng)') : bad('tạo khách trùng');
  // MK yếu → 400.
  r = await acc(host, 'POST', '/account/register', { origin: O, form: { email: `y-${uniq()}@x.vn`, password: 'password123' } });
  r.status === 400 && r.body.includes('mật khẩu') ? ok('MK yếu → 400') : bad('không chặn MK yếu', r.status);

  sect('3. Đăng nhập / đăng xuất');
  r = await acc(host, 'POST', '/account/login', { origin: O, form: { email, password: 'sai-mat-khau-hoan-toan' } });
  r.status === 401 && r.body.includes('không đúng') ? ok('sai MK → 401 lỗi chung') : bad('sai MK không 401', r.status);
  r = await acc(host, 'POST', '/account/login', { origin: O, form: { email: `khong-ton-tai-${uniq()}@x.vn`, password: pw } });
  r.status === 401 && r.body.includes('không đúng') ? ok('email không tồn tại → 401 lỗi CHUNG (enum-safe)') : bad('email lạ lộ khác', r.status);
  r = await acc(host, 'POST', '/account/login', { origin: O, form: { email, password: pw } });
  const tok = r.setTok;
  r.status === 303 && r.location === '/account' && tok ? ok('đăng nhập đúng → 303 /account + set cookie') : bad('đăng nhập lỗi', `${r.status} ${r.location}`);
  r = await acc(host, 'GET', '/account', { cookie: tok });
  r.status === 200 && r.body.includes(email) ? ok('dashboard hiện email khách') : bad('dashboard lỗi', r.status);

  sect('4. CSRF + cô lập shop');
  r = await acc(host, 'POST', '/account/login', { form: { email, password: pw } }); // KHÔNG origin
  r.status === 403 ? ok('POST login thiếu Origin → 403 (CSRF)') : bad('CSRF lọt', r.status);
  // Cookie shop A gửi tới host shop B → phiên vô hiệu (shop_id khác) → dashboard 303 login.
  r = await acc(B.host, 'GET', '/account', { cookie: tok });
  r.status === 303 && r.location === '/account/login' ? ok('cookie shop A ở host shop B → phiên vô hiệu (cô lập)') : bad('phiên rò chéo shop', `${r.status} ${r.location}`);
  // Cùng email đăng ký được ở shop B (per-store).
  r = await acc(B.host, 'POST', '/account/register', { origin: `https://${B.host}`, form: { email, password: pw } });
  r.status === 200 && N(await custCount(B.shopId, email)) === 1 ? ok('cùng email đăng ký ở shop B → tài khoản độc lập') : bad('per-store email lỗi', r.status);

  sect('6. Lịch sử đơn (RLS chỉ đơn của mình) + chi tiết + nhận đơn cũ');
  const custId = (await owner.query(`SELECT id FROM customers WHERE shop_id=$1 AND lower(email)=lower($2)`, [A.shopId, email])).rows[0].id;
  const otherCust = (await owner.query(`INSERT INTO customers (shop_id,email,password_hash) VALUES ($1,$2,'H') RETURNING id`, [A.shopId, `other-${uniq()}@x.vn`])).rows[0].id;
  const mkOrder = async (num, custIdOrNull, tokenHash) => (await owner.query(
    `INSERT INTO orders (shop_id,order_number,total_vnd,subtotal_vnd,customer_id,lookup_token_hash,customer_name,customer_phone,status,payment_status)
     VALUES ($1,$2,150000,150000,$3,$4,'Khách','0900','delivered','paid') RETURNING id`, [A.shopId, num, custIdOrNull, tokenHash])).rows[0].id;
  const crypto = await import('node:crypto');
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const gTok = 'guest-token-' + uniq() + uniq();
  await mkOrder(9001, custId, null);          // đơn của mình
  await mkOrder(9002, otherCust, null);       // đơn khách KHÁC cùng shop
  const guestId = await mkOrder(9003, null, sha(gTok)); // đơn vãng lai (claim được)
  r = await acc(host, 'GET', '/account/orders', { cookie: tok });
  r.status === 200 && r.body.includes('#9001') && !r.body.includes('#9002') ? ok('lịch sử: thấy đơn của mình (9001), KHÔNG thấy đơn khách khác (9002)') : bad('lịch sử rò đơn người khác', r.body.match(/#900\d/g)?.join());
  r = await acc(host, 'GET', '/account/orders/9001', { cookie: tok });
  r.status === 200 && r.body.includes('Đơn #9001') ? ok('chi tiết đơn 9001 của mình → 200') : bad('chi tiết đơn lỗi', r.status);
  r = await acc(host, 'GET', '/account/orders/9002', { cookie: tok });
  r.status === 404 ? ok('chi tiết đơn 9002 (khách khác) → 404 (IDOR chặn)') : bad('IDOR đọc đơn người khác', r.status);
  // Claim SAI token → đơn vẫn vãng lai.
  r = await acc(host, 'POST', '/account/claim', { origin: O, cookie: tok, form: { order_number: '9003', token: 'token-sai-hoan-toan' } });
  let own = (await owner.query(`SELECT customer_id FROM orders WHERE id=$1`, [guestId])).rows[0].customer_id;
  own === null ? ok('claim SAI token → đơn vẫn vãng lai (không cướp)') : bad('claim sai token vẫn gán', own);
  // Claim ĐÚNG token → đơn về tài khoản.
  r = await acc(host, 'POST', '/account/claim', { origin: O, cookie: tok, form: { order_number: '9003', token: gTok } });
  own = (await owner.query(`SELECT customer_id FROM orders WHERE id=$1`, [guestId])).rows[0].customer_id;
  own === custId ? ok('claim ĐÚNG token → đơn 9003 về tài khoản') : bad('claim đúng token thất bại', own);

  sect('6b. Sổ địa chỉ CRUD + 1-default + IDOR');
  r = await acc(host, 'POST', '/account/addresses/add', { origin: O, cookie: tok, form: { recipient_name: 'Nguyễn A', phone: '0911222333', line1: '12 Lê Lợi', province: 'Hà Nội', is_default: '1' } });
  r.status === 303 ? ok('thêm địa chỉ (mặc định) → 303') : bad('thêm địa chỉ lỗi', `${r.status} ${r.body.slice(0,120)}`);
  r = await acc(host, 'POST', '/account/addresses/add', { origin: O, cookie: tok, form: { recipient_name: 'Nguyễn B', phone: '0911222444', line1: '5 Bà Triệu', province: 'TP. Hồ Chí Minh', is_default: '1' } });
  const addrs = (await owner.query(`SELECT id, recipient_name, is_default FROM customer_addresses WHERE customer_id=$1 ORDER BY created_at`, [custId])).rows;
  const nDefault = addrs.filter((a) => a.is_default).length;
  addrs.length === 2 && nDefault === 1 && addrs.find((a) => a.recipient_name === 'Nguyễn B').is_default
    ? ok('2 địa chỉ, ĐÚNG 1 mặc định (đổi sang cái mới)') : bad('nhiều mặc định', JSON.stringify(addrs));
  r = await acc(host, 'GET', '/account/addresses', { cookie: tok });
  r.status === 200 && r.body.includes('12 Lê Lợi') && r.body.includes('Mặc định') ? ok('trang địa chỉ liệt kê + badge mặc định') : bad('trang địa chỉ lỗi');
  // IDOR: xoá địa chỉ của khách khác (tạo địa chỉ cho otherCust) → RLS chặn, còn nguyên.
  const otherAddr = (await owner.query(`INSERT INTO customer_addresses (shop_id,customer_id,recipient_name,phone,line1) VALUES ($1,$2,'Khác','09','X') RETURNING id`, [A.shopId, otherCust])).rows[0].id;
  await acc(host, 'POST', '/account/addresses/delete', { origin: O, cookie: tok, form: { id: otherAddr } });
  const stillThere = (await owner.query(`SELECT count(*)::int n FROM customer_addresses WHERE id=$1`, [otherAddr])).rows[0].n;
  N(stillThere) === 1 ? ok('xoá địa chỉ khách khác → RLS chặn, còn nguyên (IDOR)') : bad('xoá được địa chỉ người khác');
  // Xoá địa chỉ của mình → 0 còn 1.
  await acc(host, 'POST', '/account/addresses/delete', { origin: O, cookie: tok, form: { id: addrs[0].id } });
  N((await owner.query(`SELECT count(*)::int n FROM customer_addresses WHERE customer_id=$1`, [custId])).rows[0].n) === 1 ? ok('xoá địa chỉ của mình → còn 1') : bad('xoá địa chỉ mình lỗi');

  sect('7. Tích hợp checkout: đăng nhập → prefill + đặt đơn tự vào lịch sử (customer_id)');
  // Sản phẩm + tồn cho shop A (owner SQL).
  const pId = (await owner.query(`INSERT INTO products (shop_id,slug,title,price_vnd,status) VALUES ($1,$2,'SP Checkout',90000,'active') RETURNING id`, [A.shopId, `sp-${uniq()}`])).rows[0].id;
  const vId = (await owner.query(`INSERT INTO variants (shop_id,product_id,sku,price_vnd) VALUES ($1,$2,$3,90000) RETURNING id`, [A.shopId, pId, `SKU-${uniq()}`])).rows[0].id;
  await owner.query(`INSERT INTO inventory_levels (shop_id,variant_id,on_hand) VALUES ($1,$2,50)`, [A.shopId, vId]);
  // GET /checkout khi đăng nhập → prefill tên/SĐT khách (đã có địa chỉ 'Nguyễn B' mặc định).
  let cart = (await co(host, 'POST', '/cart/items', { json: { variant_id: vId, qty: 1 } })).cartTok;
  let r2 = await new Promise((rs) => { const req = http.request({ hostname: CO.hostname, port: CO.port, path: '/checkout', method: 'GET', headers: { host, accept: 'text/html', cookie: `__Host-cart=${cart}; __Host-cust_session=${tok}` } }, (x) => { let b = ''; x.on('data', (d) => b += d); x.on('end', () => rs({ status: x.statusCode, body: b })); }); req.end(); });
  r2.status === 200 && r2.body.includes('Nguyễn Khách') ? ok('GET /checkout đăng nhập → prefill tên khách') : bad('không prefill', r2.body.match(/name="name"[^>]*/)?.[0]);
  // Đặt đơn qua JSON path với cust cookie → order.customer_id = khách.
  const rr = await co(host, 'POST', '/checkout', { json: { customer: { name: 'Nguyễn Khách', phone: '0900111222', email }, address: { line: '1 Test', province: 'Hà Nội' }, payment_method: 'cod' }, cartTok: cart, custTok: tok, idem: `cust-${uniq()}` });
  const stampedId = rr.json?.order_number ? (await owner.query(`SELECT customer_id FROM orders WHERE shop_id=$1 AND order_number=$2`, [A.shopId, rr.json.order_number])).rows[0]?.customer_id : null;
  rr.status === 201 && stampedId === custId ? ok('đặt đơn khi đăng nhập → orders.customer_id = khách (stamp)') : bad('không stamp customer_id', `${rr.status} ${stampedId}`);
  r = await acc(host, 'GET', '/account/orders', { cookie: tok });
  r.body.includes(`#${rr.json.order_number}`) ? ok('đơn vừa đặt TỰ xuất hiện trong lịch sử /account/orders') : bad('đơn không vào lịch sử');
  // Khách VÃNG LAI (không cust cookie) vẫn đặt được, customer_id NULL.
  let cart2 = (await co(host, 'POST', '/cart/items', { json: { variant_id: vId, qty: 1 } })).cartTok;
  const rg = await co(host, 'POST', '/checkout', { json: { customer: { name: 'Vãng Lai', phone: '0900999888' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' }, cartTok: cart2, idem: `guest-${uniq()}` });
  const guestCid = rg.json?.order_number ? (await owner.query(`SELECT customer_id FROM orders WHERE shop_id=$1 AND order_number=$2`, [A.shopId, rg.json.order_number])).rows[0]?.customer_id : 'x';
  rg.status === 201 && guestCid === null ? ok('khách VÃNG LAI vẫn đặt được, customer_id NULL (tương thích ngược)') : bad('khách vãng lai lỗi', `${rg.status} ${guestCid}`);

  sect('5. Đăng xuất → phiên revoked');
  r = await acc(host, 'POST', '/account/logout', { origin: O, cookie: tok });
  r.status === 303 && /\/account\/login/.test(r.location ?? '') ? ok('đăng xuất → 303 login') : bad('logout lỗi', `${r.status} ${r.location}`);
  r = await acc(host, 'GET', '/account', { cookie: tok });
  r.status === 303 ? ok('sau đăng xuất, cookie cũ vô hiệu → 303 login') : bad('phiên chưa revoke', r.status);
  const revoked = N((await owner.query(`SELECT count(*)::int n FROM customer_sessions s JOIN customers c ON c.id=s.customer_id WHERE c.shop_id=$1 AND lower(c.email)=lower($2) AND s.revoked_at IS NOT NULL`, [A.shopId, email])).rows[0].n);
  revoked >= 1 ? ok('DB: phiên có revoked_at') : bad('phiên chưa revoke trong DB');

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
