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
const mkShop = async (staff, slug) => {
  const r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
  // Bộ account có đặt đơn tích hợp; dùng shop đã mở bán, readiness được test riêng.
  await owner.query(`UPDATE shops SET status='active', went_live_at=now() WHERE id=$1`, [r.json.id]);
  return { shopId: r.json.id, host: `${slug}.nentang.vn` };
};
const N = (x) => Number(x);
// Gọi checkout service với Host shop + cart cookie + cust cookie (đăng nhập).
function co(host, method, path, { json, form, cartTok, custTok, idem, origin = `https://${host}` } = {}) {
  return new Promise((resolve, reject) => {
    const data = form !== undefined ? new URLSearchParams(form).toString() : json !== undefined ? JSON.stringify(json) : null;
    const headers = { host };
    if (origin) headers.origin = origin;
    if (data != null) {
      headers['content-type'] = form !== undefined ? 'application/x-www-form-urlencoded' : 'application/json';
      headers['content-length'] = Buffer.byteLength(data);
    }
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
  let tok = r.setTok;
  r.status === 303 && r.location === '/account' && tok ? ok('đăng nhập đúng → 303 /account + set cookie') : bad('đăng nhập lỗi', `${r.status} ${r.location}`);
  r = await acc(host, 'GET', '/account', { cookie: tok });
  r.status === 200 && r.body.includes(email) ? ok('dashboard hiện email khách') : bad('dashboard lỗi', r.status);

  // next chỉ nhận đường nội bộ đã allowlist. Giữ next khi nhập sai để khách không mất nơi đang xem.
  r = await acc(host, 'GET', '/account/login?next=%2Fp%2Fsan-pham-dang-xem');
  r.status === 200 && r.body.includes('name="next" value="/p/san-pham-dang-xem"')
    ? ok('trang login giữ next nội bộ trong hidden field') : bad('login làm rơi next', r.status);
  r = await acc(host, 'POST', '/account/login', { origin: O, form: { email, password: 'sai', next: '/p/san-pham-dang-xem' } });
  r.status === 401 && r.body.includes('name="next" value="/p/san-pham-dang-xem"')
    ? ok('đăng nhập sai vẫn giữ next để thử lại') : bad('lỗi login làm rơi next', r.status);
  r = await acc(host, 'POST', '/account/login', { origin: O, form: { email, password: pw, next: '/p/san-pham-dang-xem' } });
  r.status === 303 && r.location === '/p/san-pham-dang-xem'
    ? ok('đăng nhập đúng quay lại trang sản phẩm') : bad('đăng nhập không quay lại next', `${r.status} ${r.location}`);
  r = await acc(host, 'POST', '/account/login', { origin: O, form: { email, password: pw, next: '//evil.example/lay-cookie' } });
  r.status === 303 && r.location === '/account'
    ? ok('next protocol-relative bị chặn, không open redirect') : bad('open redirect qua next', `${r.status} ${r.location}`);

  sect('3b. Xác minh email + quên/đặt lại mật khẩu (token 1 lần, thu hồi phiên)');
  const outLink = (topic, to) => owner.query(`SELECT payload->>'link' AS l FROM outbox WHERE topic=$1 AND payload->>'to'=$2 ORDER BY id DESC LIMIT 1`, [topic, to]).then((r) => r.rows[0]?.l ?? null);
  // Đăng ký đã tạo outbox verify (mục 2). Lấy link → GET verify → email_verified_at set.
  const vLink = await outLink('customer.email_verify', email);
  const vTok = vLink ? new URL(vLink).searchParams.get('token') : null;
  vTok ? ok('đăng ký sinh outbox customer.email_verify (link về domain shop)') : bad('không có outbox verify');
  r = await acc(host, 'GET', `/account/verify?token=${vTok}`);
  r.status === 200 && r.body.includes('Đã xác minh') ? ok('GET verify token → xác minh email') : bad('verify lỗi', r.status);
  const verified = (await owner.query(`SELECT email_verified_at FROM customers WHERE shop_id=$1 AND lower(email)=lower($2)`, [A.shopId, email])).rows[0].email_verified_at;
  verified ? ok('DB: email_verified_at đã set') : bad('email chưa verify trong DB');
  // Forgot email KHÔNG tồn tại → vẫn 200 (enum-safe), không outbox.
  r = await acc(host, 'POST', '/account/forgot', { origin: O, form: { email: `khong-${uniq()}@x.vn` } });
  r.status === 200 && r.body.includes('Đã gửi') ? ok('forgot email lạ → 200 trung tính (enum-safe)') : bad('forgot lộ email lạ', r.status);
  // Forgot email THẬT → outbox reset.
  r = await acc(host, 'POST', '/account/forgot', { origin: O, form: { email } });
  const rLink = await outLink('customer.password_reset', email);
  const rTok = rLink ? new URL(rLink).searchParams.get('token') : null;
  r.status === 200 && rTok ? ok('forgot email thật → 200 + outbox reset') : bad('không có outbox reset', r.status);
  r = await acc(host, 'GET', `/account/reset?token=${rTok}`);
  r.status === 200 && r.body.includes('mật khẩu mới') ? ok('GET reset token hợp lệ → form') : bad('form reset lỗi', r.status);
  const newPw = 'mat khau moi 2026 abc';
  r = await acc(host, 'POST', '/account/reset', { origin: O, form: { token: rTok, password: newPw } });
  r.status === 200 && r.body.includes('Đăng nhập') ? ok('đặt MK mới → về trang đăng nhập') : bad('reset lỗi', r.status);
  // Token dùng LẠI → vô hiệu.
  r = await acc(host, 'GET', `/account/reset?token=${rTok}`);
  r.status === 400 && r.body.includes('hết hạn') ? ok('reuse token reset → 400 (dùng-một-lần)') : bad('token tái dùng được', r.status);
  // Đăng nhập bằng MK MỚI (MK cũ vô hiệu — nhưng chưa test cũ; test mới đủ).
  r = await acc(host, 'POST', '/account/login', { origin: O, form: { email, password: newPw } });
  r.status === 303 && r.setTok ? ok('đăng nhập bằng MK MỚI thành công') : bad('MK mới không đăng nhập được', r.status);
  tok = r.setTok; // phiên cũ đã bị reset thu hồi → dùng phiên MỚI cho các mục sau

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
  const mkOrder = async (num, custIdOrNull, tokenHash, status = 'delivered') => (await owner.query(
    `INSERT INTO orders (shop_id,order_number,total_vnd,subtotal_vnd,customer_id,lookup_token_hash,customer_name,customer_phone,status,payment_status)
     VALUES ($1,$2,150000,150000,$3,$4,'Khách','0900000000',$5,$6) RETURNING id`,
    [A.shopId, num, custIdOrNull, tokenHash, status, status === 'delivered' ? 'paid' : 'unpaid'])).rows[0].id;
  const crypto = await import('node:crypto');
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const gTok = 'guest-token-' + uniq() + uniq();
  await mkOrder(9001, custId, null);          // đơn của mình
  await mkOrder(9002, otherCust, null);       // đơn khách KHÁC cùng shop
  const guestId = await mkOrder(9003, null, sha(gTok)); // đơn vãng lai (claim được)
  const pendingId = await mkOrder(9004, custId, null, 'pending');
  r = await acc(host, 'GET', '/account/orders', { cookie: tok });
  r.status === 200 && r.body.includes('#9001') && !r.body.includes('#9002') ? ok('lịch sử: thấy đơn của mình (9001), KHÔNG thấy đơn khách khác (9002)') : bad('lịch sử rò đơn người khác', r.body.match(/#900\d/g)?.join());
  r = await acc(host, 'GET', '/account/orders/9001', { cookie: tok });
  r.status === 200 && r.body.includes('Đơn #9001') ? ok('chi tiết đơn 9001 của mình → 200') : bad('chi tiết đơn lỗi', r.status);
  r = await acc(host, 'GET', '/account/orders/9002', { cookie: tok });
  r.status === 404 ? ok('chi tiết đơn 9002 (khách khác) → 404 (IDOR chặn)') : bad('IDOR đọc đơn người khác', r.status);

  sect('6a. Yêu cầu hậu mãi: request-only, chống trùng và IDOR');
  r = await acc(host, 'POST', '/account/orders/9004/requests', { cookie: tok, form: { request_type: 'cancel', reason: 'Đặt nhầm' } });
  r.status === 403 ? ok('gửi yêu cầu thiếu Origin → 403 CSRF') : bad('CSRF yêu cầu hậu mãi lọt', r.status);
  r = await acc(host, 'POST', '/account/orders/9004/requests', { origin: O, cookie: tok, form: { request_type: 'cancel', reason: 'Đặt nhầm sản phẩm' } });
  let reqRows = (await owner.query(`SELECT request_type,status,reason FROM order_requests WHERE order_id=$1 ORDER BY created_at`, [pendingId])).rows;
  let pendingStatus = (await owner.query(`SELECT status FROM orders WHERE id=$1`, [pendingId])).rows[0].status;
  r.status === 303 && /request=created/.test(r.location ?? '') && reqRows.length === 1 && reqRows[0].status === 'requested' && pendingStatus === 'pending'
    ? ok('yêu cầu huỷ chỉ tạo request, KHÔNG tự huỷ đơn') : bad('request-only bị phá', `${r.status} ${r.location} rows=${JSON.stringify(reqRows)} order=${pendingStatus}`);
  await acc(host, 'POST', '/account/orders/9004/requests', { origin: O, cookie: tok, form: { request_type: 'cancel', reason: 'Bấm lại' } });
  reqRows = (await owner.query(`SELECT id FROM order_requests WHERE order_id=$1 AND request_type='cancel'`, [pendingId])).rows;
  reqRows.length === 1 ? ok('double-submit yêu cầu huỷ → vẫn đúng 1 request mở') : bad('yêu cầu bị nhân đôi', reqRows.length);
  r = await acc(host, 'POST', '/account/orders/9004/requests', { origin: O, cookie: tok, form: {
    request_type: 'address_change', recipient_name: 'Người nhận mới', phone: '+84912345678',
    line: '22 Nguyễn Huệ', ward: 'Bến Nghé', district: 'Quận 1', province: 'TP. Hồ Chí Minh', reason: 'Chuyển chỗ nhận',
  } });
  const addrReq = (await owner.query(`SELECT request_payload FROM order_requests WHERE order_id=$1 AND request_type='address_change'`, [pendingId])).rows[0];
  const unchanged = (await owner.query(`SELECT shipping_address FROM orders WHERE id=$1`, [pendingId])).rows[0].shipping_address;
  r.status === 303 && addrReq?.request_payload?.phone === '0912345678' && unchanged === null
    ? ok('đổi địa chỉ chỉ lưu payload chuẩn hoá, chưa sửa đơn') : bad('đổi địa chỉ áp dụng sớm/sai payload', `${r.status} ${JSON.stringify(addrReq)} order=${JSON.stringify(unchanged)}`);
  r = await acc(host, 'POST', '/account/orders/9001/requests', { origin: O, cookie: tok, form: { request_type: 'return', reason: 'Sản phẩm lỗi đường may' } });
  const retReq = (await owner.query(`SELECT status FROM order_requests WHERE order_id=(SELECT id FROM orders WHERE shop_id=$1 AND order_number=9001) AND request_type='return'`, [A.shopId])).rows[0];
  r.status === 303 && retReq?.status === 'requested' ? ok('đơn đã giao → gửi yêu cầu trả hàng, chưa refund/restock') : bad('yêu cầu trả hàng lỗi', `${r.status} ${JSON.stringify(retReq)}`);
  r = await acc(host, 'GET', '/account/orders/9001', { cookie: tok });
  r.status === 200 && r.body.includes('Đang chờ cửa hàng') && r.body.includes('Sản phẩm lỗi đường may')
    ? ok('chi tiết đơn hiển thị lịch sử/trạng thái yêu cầu') : bad('UI không hiện yêu cầu', r.status);
  r = await acc(host, 'POST', '/account/orders/9002/requests', { origin: O, cookie: tok, form: { request_type: 'return', reason: 'Thử IDOR' } });
  const leaked = Number((await owner.query(`SELECT count(*)::int AS n FROM order_requests WHERE order_id=(SELECT id FROM orders WHERE shop_id=$1 AND order_number=9002)`, [A.shopId])).rows[0].n);
  r.status === 404 && leaked === 0 ? ok('không tạo được request trên đơn khách khác (IDOR)') : bad('IDOR request lọt', `${r.status} n=${leaked}`);
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
  r = await acc(host, 'POST', '/account/addresses/add', { origin: O, cookie: tok, form: { recipient_name: 'Sai SĐT', phone: '1.2.3.4.5.6', line1: 'X', province: 'Hà Nội' } });
  r.status === 400 && r.body.includes('Số điện thoại không hợp lệ')
    ? ok('sổ địa chỉ dùng cùng luật SĐT với checkout') : bad('sổ địa chỉ nhận SĐT checkout sẽ chặn', r.status);
  // Xoá là luồng SSR hai bước: GET chỉ hiển thị đúng địa chỉ của mình, POST phải có marker xác nhận.
  r = await acc(host, 'GET', `/account/addresses?delete=${addrs[0].id}`, { cookie: tok });
  let ownAddrCount = N((await owner.query(`SELECT count(*)::int n FROM customer_addresses WHERE customer_id=$1`, [custId])).rows[0].n);
  r.status === 200 && r.body.includes('Xác nhận xoá địa chỉ') && r.body.includes('12 Lê Lợi') && ownAddrCount === 2
    ? ok('mở xác nhận xoá chỉ hiển thị, chưa xoá địa chỉ') : bad('GET xác nhận đã xoá/không hiện đúng địa chỉ', `${r.status} n=${ownAddrCount}`);
  r = await acc(host, 'POST', '/account/addresses/delete', { cookie: tok, form: { id: addrs[0].id, confirm_delete: '1' } });
  ownAddrCount = N((await owner.query(`SELECT count(*)::int n FROM customer_addresses WHERE customer_id=$1`, [custId])).rows[0].n);
  r.status === 403 && ownAddrCount === 2 ? ok('xoá địa chỉ thiếu Origin → 403 CSRF') : bad('CSRF xoá địa chỉ lọt', `${r.status} n=${ownAddrCount}`);
  await acc(host, 'POST', '/account/addresses/delete', { origin: O, cookie: tok, form: { id: addrs[0].id } });
  ownAddrCount = N((await owner.query(`SELECT count(*)::int n FROM customer_addresses WHERE customer_id=$1`, [custId])).rows[0].n);
  ownAddrCount === 2 ? ok('POST thiếu xác nhận không xoá địa chỉ') : bad('thiếu marker vẫn xoá địa chỉ', ownAddrCount);
  // IDOR: xoá địa chỉ của khách khác (tạo địa chỉ cho otherCust) → RLS chặn, còn nguyên.
  const otherAddr = (await owner.query(`INSERT INTO customer_addresses (shop_id,customer_id,recipient_name,phone,line1) VALUES ($1,$2,'Khác','09','X') RETURNING id`, [A.shopId, otherCust])).rows[0].id;
  r = await acc(host, 'GET', `/account/addresses?delete=${otherAddr}`, { cookie: tok });
  r.status === 200 && !r.body.includes(otherAddr) && !r.body.includes('Xác nhận xoá địa chỉ')
    ? ok('xác nhận không làm lộ địa chỉ khách khác') : bad('GET xác nhận làm lộ địa chỉ khách khác');
  await acc(host, 'POST', '/account/addresses/delete', { origin: O, cookie: tok, form: { id: otherAddr, confirm_delete: '1' } });
  const stillThere = (await owner.query(`SELECT count(*)::int n FROM customer_addresses WHERE id=$1`, [otherAddr])).rows[0].n;
  N(stillThere) === 1 ? ok('xoá địa chỉ khách khác → RLS chặn, còn nguyên (IDOR)') : bad('xoá được địa chỉ người khác');
  // Xoá địa chỉ của mình → còn 1.
  await acc(host, 'POST', '/account/addresses/delete', { origin: O, cookie: tok, form: { id: addrs[0].id, confirm_delete: '1' } });
  ownAddrCount = N((await owner.query(`SELECT count(*)::int n FROM customer_addresses WHERE customer_id=$1`, [custId])).rows[0].n);
  ownAddrCount === 1 ? ok('xác nhận xoá địa chỉ của mình → còn 1') : bad('xoá địa chỉ mình lỗi');
  await acc(host, 'POST', '/account/addresses/delete', { origin: O, cookie: tok, form: { id: addrs[0].id, confirm_delete: '1' } });
  ownAddrCount = N((await owner.query(`SELECT count(*)::int n FROM customer_addresses WHERE customer_id=$1`, [custId])).rows[0].n);
  ownAddrCount === 1 ? ok('gửi lại xác nhận xoá không ảnh hưởng địa chỉ còn lại') : bad('double-submit xoá nhầm địa chỉ khác', ownAddrCount);

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

  // ── YÊU THÍCH (0100) ───────────────────────────────────────────────────────
  sect('4b. Yêu thích: toggle, gắn TÀI KHOẢN, cách ly khách khác + shop khác');
  const pSlug = (await owner.query('SELECT slug FROM products WHERE id=$1', [pId])).rows[0].slug;
  // Chưa đăng nhập → đẩy sang trang đăng nhập, KHÔNG ghi gì.
  r = await acc(host, 'POST', '/account/wishlist/toggle', { origin: O, form: { product_id: pId, slug: pSlug } });
  let wn = N((await owner.query('SELECT count(*)::int n FROM wishlist_items WHERE product_id=$1', [pId])).rows[0].n);
  r.status === 303 && /\/account\/login/.test(r.location ?? '') && wn === 0
    ? ok('chưa đăng nhập → 303 login, KHÔNG ghi yêu thích') : bad('toggle khi chưa đăng nhập sai', `${r.status} ${r.location} n=${wn}`);
  /next=/.test(r.location ?? '') ? ok('link đăng nhập mang ?next= để quay lại đúng trang SP') : bad('mất đường quay lại', r.location);

  r = await acc(host, 'POST', '/account/wishlist/toggle', { origin: O, cookie: tok, form: { product_id: pId, slug: pSlug } });
  wn = N((await owner.query('SELECT count(*)::int n FROM wishlist_items WHERE product_id=$1', [pId])).rows[0].n);
  r.status === 303 && /wish=added/.test(r.location ?? '') && wn === 1 ? ok('đã đăng nhập → lưu yêu thích, quay về trang SP') : bad('thêm yêu thích lỗi', `${r.status} ${r.location} n=${wn}`);

  r = await acc(host, 'POST', '/account/wishlist/toggle', { origin: O, cookie: tok, form: { product_id: pId, slug: pSlug } });
  wn = N((await owner.query('SELECT count(*)::int n FROM wishlist_items WHERE product_id=$1', [pId])).rows[0].n);
  /wish=removed/.test(r.location ?? '') && wn === 0 ? ok('bấm lại → BỎ thích (toggle), không tạo dòng thứ hai') : bad('toggle không bỏ được', `${r.location} n=${wn}`);

  await acc(host, 'POST', '/account/wishlist/toggle', { origin: O, cookie: tok, form: { product_id: pId, slug: pSlug } });
  const imageKey = `wishlist/${uniq()}.webp`;
  await owner.query(
    `INSERT INTO media (shop_id,product_id,status,original_key,public_key,position)
     VALUES ($1,$2,'ready',$3,$4,0)`, [A.shopId, pId, `private/${imageKey}`, imageKey]);
  const promoId = (await owner.query(
    `INSERT INTO promotions (shop_id,title,kind,value,scope,starts_at,ends_at)
     VALUES ($1,'Wishlist sale','percent',20,'products',now() - interval '1 hour',now() + interval '1 hour') RETURNING id`,
    [A.shopId])).rows[0].id;
  await owner.query(
    `INSERT INTO promotion_products (shop_id,promotion_id,product_id) VALUES ($1,$2,$3)`,
    [A.shopId, promoId, pId]);
  await owner.query(`UPDATE shops SET safety_stock_pct=20 WHERE id=$1`, [A.shopId]);
  const expectedWishlistAts = N((await owner.query(
    `SELECT greatest(0, on_hand - reserved - coalesce(safety_stock_qty, ceil(on_hand * 20 / 100.0)::int))::int AS ats
       FROM inventory_levels WHERE variant_id=$1`, [vId])).rows[0].ats);
  r = await acc(host, 'GET', '/account/wishlist', { cookie: tok });
  r.status === 200 && r.body.includes('Sản phẩm yêu thích') && new RegExp(`/p/${pSlug}`).test(r.body)
    ? ok('trang Yêu thích liệt kê đúng SP đã lưu') : bad('trang yêu thích sai', `${r.status}`);
  r.body.includes(`/media-public/${imageKey}`) && r.body.includes('72.000₫') && r.body.includes('<del>90.000₫</del>') && r.body.includes('-20%')
    ? ok('Wishlist projection hiện ảnh + giá sale + giá gốc + phần trăm giảm') : bad('Wishlist thiếu projection giá/ảnh', r.body.slice(r.body.indexOf(pSlug), r.body.indexOf(pSlug) + 900));
  r.body.includes(`Còn ${expectedWishlistAts} sản phẩm`) && r.body.includes('action="/cart/add"') && r.body.includes(`name="variant_id" value="${vId}"`) && r.body.includes('name="qty" value="1"')
    ? ok('ATS trừ safety stock và SP phẳng còn hàng có form quick-add SSR') : bad('ATS/quick-add Wishlist sai');
  let cartPost = await co(host, 'POST', '/cart/add', { origin: null, form: { variant_id: vId, qty: '1' } });
  cartPost.status === 403 ? ok('quick-add thiếu Origin → checkout chặn CSRF') : bad('quick-add CSRF lọt', cartPost.status);
  cartPost = await co(host, 'POST', '/cart/add', { form: { variant_id: vId, qty: '1' } });
  cartPost.status === 303 && cartPost.cartTok ? ok('form quick-add SSR hợp lệ → thêm giỏ và chuyển hướng') : bad('quick-add SSR không hoạt động', cartPost.status);

  // Tồn vật lý vẫn còn nhưng safety override giữ hết 50 → ATS=0: Wishlist phải bỏ form mua.
  await owner.query(`UPDATE inventory_levels SET safety_stock_qty=50 WHERE variant_id=$1`, [vId]);
  r = await acc(host, 'GET', '/account/wishlist', { cookie: tok });
  r.body.includes('Hết hàng') && !r.body.includes(`name="variant_id" value="${vId}"`)
    ? ok('ATS=0 → hiện hết hàng và không render quick-add stale') : bad('Wishlist vẫn cho mua khi safety stock chặn hết');

  // Nhiều biến thể dù còn hàng vẫn phải về PDP để khách chọn, không tự chọn biến thể đầu.
  const multiSlug = `chon-loai-${uniq()}`;
  const multiId = (await owner.query(
    `INSERT INTO products (shop_id,slug,title,price_vnd,status) VALUES ($1,$2,'SP cần chọn phân loại',120000,'active') RETURNING id`,
    [A.shopId, multiSlug])).rows[0].id;
  const multiV1 = (await owner.query(
    `INSERT INTO variants (shop_id,product_id,sku,price_vnd,position) VALUES ($1,$2,$3,120000,0) RETURNING id`,
    [A.shopId, multiId, `MULTI-A-${uniq()}`])).rows[0].id;
  const multiV2 = (await owner.query(
    `INSERT INTO variants (shop_id,product_id,sku,price_vnd,position) VALUES ($1,$2,$3,125000,1) RETURNING id`,
    [A.shopId, multiId, `MULTI-B-${uniq()}`])).rows[0].id;
  await owner.query(
    `INSERT INTO inventory_levels (shop_id,variant_id,on_hand) VALUES ($1,$2,10),($1,$3,10)`,
    [A.shopId, multiV1, multiV2]);
  await acc(host, 'POST', '/account/wishlist/toggle', { origin: O, cookie: tok, form: { product_id: multiId, slug: multiSlug } });
  r = await acc(host, 'GET', '/account/wishlist', { cookie: tok });
  r.body.includes('SP cần chọn phân loại') && r.body.includes(`href="/p/${multiSlug}">Chọn phân loại</a>`) && !r.body.includes(`value="${multiV1}"`) && !r.body.includes(`value="${multiV2}"`)
    ? ok('SP nhiều biến thể → dẫn PDP chọn phân loại, không tự chọn biến thể') : bad('Wishlist tự quick-add SP cần chọn phân loại');
  r = await acc(host, 'GET', '/account/wishlist');
  r.status === 303 ? ok('chưa đăng nhập xem trang Yêu thích → 303 login') : bad('lộ trang yêu thích', String(r.status));

  // Thiếu Origin → chặn CSRF, không ghi.
  const before = N((await owner.query('SELECT count(*)::int n FROM wishlist_items WHERE product_id=$1', [pId])).rows[0].n);
  r = await acc(host, 'POST', '/account/wishlist/toggle', { cookie: tok, form: { product_id: pId, slug: pSlug } });
  const after = N((await owner.query('SELECT count(*)::int n FROM wishlist_items WHERE product_id=$1', [pId])).rows[0].n);
  r.status === 403 && after === before ? ok('thiếu Origin → 403, không đổi yêu thích') : bad('CSRF không chặn', `${r.status} ${before}→${after}`);
  // product_id rác không được rơi xuống Postgres thành 22P02 → 500.
  r = await acc(host, 'POST', '/account/wishlist/toggle', { origin: O, cookie: tok, form: { product_id: '------------------------------------', slug: pSlug } });
  r.status === 303 ? ok('product_id rác → chuyển hướng về, không 500') : bad('id rác làm sập', String(r.status));
  // SP của shop KHÁC không thể lọt vào yêu thích ở shop này.
  const pB = (await owner.query(`SELECT id FROM products WHERE shop_id=$1 LIMIT 1`, [B.shopId])).rows[0];
  if (pB) {
    await acc(host, 'POST', '/account/wishlist/toggle', { origin: O, cookie: tok, form: { product_id: pB.id, slug: pSlug } });
    const cross = N((await owner.query('SELECT count(*)::int n FROM wishlist_items WHERE product_id=$1', [pB.id])).rows[0].n);
    cross === 0 ? ok('SP shop khác KHÔNG lưu được vào yêu thích') : bad('rò chéo shop qua yêu thích');
  }

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
