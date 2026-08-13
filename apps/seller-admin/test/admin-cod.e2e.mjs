// E2E UI: ĐỐI SOÁT COD với hãng xuyên BFF seller-admin. Kiểm: trang /cod hiện đơn COD giao-qua-hãng
// đang chờ + tổng kỳ vọng + ô tick no-JS (name="order_ids" form="codf") + form "Ghi phiếu chuyển tiền";
// submit KHÔNG tick đơn → lỗi thân thiện (không gọi API); chủ shop ghi phiếu (tick 2 đơn, nhận 520k) →
// redirect banner done=1 + chênh −5k, 2 đơn RỜI danh sách chờ + VÀO lịch sử; order_manager KHÔNG thấy
// form ghi phiếu (chỉ xem) và POST /cod/remittances → 403. Mirror harness admin-return (adm() trả sc).
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest', OADM = 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 5 });
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
// ADMIN form client (urlencoded; form = MẢNG cặp [k,v] cho khoá trùng order_ids).
async function adm(method, path, { cookie, origin, form } = {}) {
  const h = {}; if (form !== undefined) h['content-type'] = 'application/x-www-form-urlencoded';
  if (origin) h.origin = origin; if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(ADMIN + path, { method, headers: h, redirect: 'manual', body: form !== undefined ? new URLSearchParams(form).toString() : undefined });
  const t = await r.text();
  return { status: r.status, location: r.headers.get('location'), sc: r.headers.getSetCookie(), body: t };
}
function co(host, method, path, { body, cartToken, idemKey } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = { host, origin: `https://${host}` };
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (cartToken) headers['cookie'] = `__Host-cart=${cartToken}`;
    if (idemKey) headers['idempotency-key'] = idemKey;
    const req = http.request({ hostname: CO.hostname, port: CO.port, path, method, headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch {} let tok = cartToken; for (const c of res.headers['set-cookie'] ?? []) { const m = /^__Host-cart=([^;]*)/.exec(c); if (m) tok = m[1]; } resolve({ status: res.statusCode, json: j, raw: b, cartToken: tok }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const login = async (e, p) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email: e, password: p }, origin: OA })).sc);
const admLogin = async (e, p) => ck((await adm('POST', '/login', { origin: OADM, form: { email: e, password: p } })).sc);
const uidOf = async (e) => (await owner.query('SELECT id FROM users WHERE email=$1', [e])).rows[0]?.id ?? null;
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
async function makeShopOwner(staff, slug) {
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
  const shopId = r.json.id;
  await owner.query(`UPDATE shops SET status='active', went_live_at=now() WHERE id=$1`, [shopId]);
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, host: `${slug}.nentang.vn`, email, password, cookie: await login(email, password) };
}
async function makeMember(shop, staff, role) {
  const email = `${role}-${uniq()}@shop.vn`, password = 'member passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shop.shopId}/invitations`, { body: { email, role }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { email, password };
}
async function setupProduct(shop, price, stock) {
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/products`, { body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `S-${uniq()}`, price_vnd: price }] }, cookie: shop.cookie, origin: OS });
  const vid = (await rq(SELLER, 'GET', `/shops/${shop.shopId}/products/${r.json.id}`, { cookie: shop.cookie })).json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${shop.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: shop.cookie, origin: OS });
  return vid;
}
// Đơn COD GIAO QUA HÃNG (đủ điều kiện đối soát): checkout COD → confirm → giả lập shipment
// provider='ghn' + phí hãng, ép order delivered+paid (COD giao = thu tiền). Mirror seed của
// apps/seller/test/cod-reconcile.e2e.mjs (thay vì gọi API hãng thật).
async function placeCodViaCarrier(shop, vid, qty, fee, phone) {
  const cart = (await co(shop.host, 'POST', '/cart/items', { body: { variant_id: vid, qty } })).cartToken;
  const r = await co(shop.host, 'POST', '/checkout', { body: { customer: { name: 'Khách COD', phone }, address: { line: 'HN', province: 'Hà Nội' }, payment_method: 'cod' }, cartToken: cart, idemKey: `c-${uniq()}` });
  const id = (await owner.query('SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2', [shop.shopId, r.json.order_number])).rows[0].id;
  await rq(SELLER, 'POST', `/shops/${shop.shopId}/orders/${id}/confirm`, { cookie: shop.cookie, origin: OS });
  await owner.query(`INSERT INTO shipments (shop_id, order_id, carrier, tracking_number, status, provider, carrier_fee_vnd) VALUES ($1,$2,'GHN','TN'||$3,'delivered','ghn',$4)`, [shop.shopId, id, uniq(), fee]);
  await owner.query(`UPDATE orders SET status='delivered', delivered_at=now(), payment_status='paid', paid_at=now() WHERE id=$1`, [id]);
  return { id, order_number: r.json.order_number };
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `codui-${uniq()}`);
  const vid = await setupProduct(A, 100000, 50);
  const cookieOwner = await admLogin(A.email, A.password); // phiên BFF chủ shop
  // o1: 3×100k + ship 30k = 330k, phí 15k → kỳ vọng 315k. o2: 2×100k + 30k = 230k, phí 20k → 210k.
  const o1 = await placeCodViaCarrier(A, vid, 3, 15000, '0901110001');
  const o2 = await placeCodViaCarrier(A, vid, 2, 20000, '0901110002');
  const base = `/shops/${A.shopId}/cod`;

  sect('Chủ shop mở /cod: hiện 2 đơn chờ + tổng 525k + ô tick no-JS + form ghi phiếu');
  let r = await adm('GET', base, { cookie: cookieOwner });
  const hasCbs = new RegExp(`name="order_ids" value="${o1.id}" form="codf"`).test(r.body) && new RegExp(`name="order_ids" value="${o2.id}"`).test(r.body);
  const hasForm = /Ghi phiếu chuyển tiền/.test(r.body) && new RegExp(`action="${base}/remittances"`).test(r.body);
  r.status === 200 && r.body.includes(o1.id) && r.body.includes(o2.id) && /525\.000/.test(r.body) && hasCbs && hasForm
    ? ok('trang tải: 2 đơn chờ, tổng 525.000₫, ô tick order_ids[form=codf], form ghi phiếu') : bad('trang /cod sai', `st=${r.status} cbs=${hasCbs} form=${hasForm}`);

  sect('Submit KHÔNG tick đơn nào → lỗi thân thiện (không gọi API), chưa tạo phiếu');
  r = await adm('POST', `${base}/remittances`, { cookie: cookieOwner, origin: OADM, form: [['amount_vnd', '500000'], ['note', 'thiếu tick']] });
  const remCount0 = Number((await owner.query('SELECT count(*)::int c FROM cod_remittances WHERE shop_id=$1', [A.shopId])).rows[0].c);
  r.status === 400 && /Hãy tick ít nhất một đơn/.test(r.body) && remCount0 === 0
    ? ok('không tick đơn → lỗi "Hãy tick ít nhất một đơn", chưa ghi phiếu') : bad('empty submit xử sai', `st=${r.status} rem=${remCount0}`);

  sect('order_manager (không payment.write): KHÔNG thấy form ghi phiếu, vẫn xem được danh sách chờ');
  const mgr = await makeMember(A, staff, 'order_manager');
  const cookieMgr = await admLogin(mgr.email, mgr.password);
  r = await adm('GET', base, { cookie: cookieMgr });
  const mgrNoForm = !/Ghi phiếu chuyển tiền/.test(r.body) && !new RegExp(`action="${base}/remittances"`).test(r.body) && !/name="order_ids"/.test(r.body);
  r.status === 200 && r.body.includes(o1.id) && /525\.000/.test(r.body) && mgrNoForm
    ? ok('order_manager: thấy đơn chờ + tổng nhưng KHÔNG có form/ô tick ghi phiếu') : bad('order_manager thấy form ghi phiếu', `st=${r.status} noForm=${mgrNoForm}`);

  sect('order_manager POST /cod/remittances → 403 (payment.write chỉ chủ shop)');
  r = await adm('POST', `${base}/remittances`, { cookie: cookieMgr, origin: OADM, form: [['order_ids', o1.id], ['amount_vnd', '315000']] });
  r.status === 403 ? ok('order_manager ghi phiếu → 403') : bad('order_manager ghi được phiếu', r.status);

  sect('Chưa xác thực lại → CỔNG MẬT KHẨU, và các ô đã tick được mang sang nguyên vẹn');
  // Ghi phiếu là bút toán không hoàn tác → seller đòi step-up. Giao diện KHÔNG được để
  // người dùng ăn lỗi "không ghi được phiếu": phải hỏi mật khẩu, và mang theo TOÀN BỘ đơn
  // đã tick — bắt tick lại 50 đơn là cách chắc chắn nhất để người ta bỏ luôn việc đối soát.
  const donTick = [['order_ids', o1.id], ['order_ids', o2.id], ['carrier', 'ghn'], ['amount_vnd', '520000'], ['note', 'sao ke GHN 18/07']];
  r = await adm('POST', `${base}/remittances`, { cookie: cookieOwner, origin: OADM, form: donTick });
  const giuLai = r.body.includes(o1.id) && r.body.includes(o2.id) && /name="amount_vnd" value="520000"/.test(r.body);
  r.status === 200 && /Xác nhận mật khẩu/.test(r.body) && /name="password"/.test(r.body) && giuLai
    ? ok('hiện cổng mật khẩu, giữ nguyên 2 đơn đã tick + số tiền đã nhập')
    : bad('cổng step-up sai/mất dữ liệu đã nhập', `st=${r.status} giuLai=${giuLai}`);

  sect('Sai mật khẩu → 401, VẪN giữ dữ liệu (không bắt làm lại từ đầu)');
  r = await adm('POST', `${base}/remittances/step-up`, { cookie: cookieOwner, origin: OADM, form: [...donTick, ['password', 'sai-mat-khau-roi']] });
  r.status === 401 && r.body.includes(o1.id) && /Mật khẩu không đúng/.test(r.body)
    ? ok('sai mật khẩu → 401 + vẫn giữ đơn đã tick') : bad('sai mật khẩu làm mất dữ liệu', `st=${r.status}`);

  sect('Chủ shop tick 2 đơn, nhận 520k → redirect done=1 + chênh −5k, 2 đơn');
  r = await adm('POST', `${base}/remittances/step-up`, { cookie: cookieOwner, origin: OADM, form: [...donTick, ['password', 'owner passphrase strong']] });
  const loc = r.location ?? '';
  r.status === 303 && /done=1/.test(loc) && /expected=525000/.test(loc) && /received=520000/.test(loc) && /disc=-5000/.test(loc) && /count=2/.test(loc)
    ? ok('ghi phiếu → 303 done=1&expected=525000&received=520000&disc=-5000&count=2') : bad('ghi phiếu qua UI sai', `st=${r.status} loc=${loc}`);

  sect('Theo redirect ?done=1: banner thành công (kỳ vọng vs thực nhận + chênh −5k)');
  r = await adm('GET', `${base}?done=1&expected=525000&received=520000&disc=-5000&count=2`, { cookie: cookieOwner });
  /Đã ghi phiếu chuyển tiền/.test(r.body) && /520\.000/.test(r.body) && /-5\.000/.test(r.body) && /hãng còn nợ/.test(r.body)
    ? ok('banner: "Đã ghi phiếu chuyển tiền" + thực nhận 520.000 + chênh −5.000 (hãng còn nợ)') : bad('banner thành công thiếu', '');

  sect('Sau đối soát: 2 đơn RỜI danh sách chờ (rỗng) + tổng chờ 0');
  r = await adm('GET', base, { cookie: cookieOwner });
  // Dùng UUID đơn (o.id — xuất hiện ở ô tick + link hàng chờ) làm dấu; order_number "1" đụng mã màu CSS.
  const gone = !r.body.includes(o1.id) && !r.body.includes(o2.id);
  gone && /Không có đơn COD nào đang chờ/.test(r.body)
    ? ok('danh sách chờ rỗng: 2 đơn đã rời, hiện "Không có đơn COD nào đang chờ"') : bad('đơn chưa rời danh sách chờ', `gone=${gone}`);

  sect('Lịch sử đối soát hiện phiếu: hãng GHN, 2 đơn, kỳ vọng 525k, thực nhận 520k, chênh −5k, ghi chú');
  const hist = /Lịch sử đối soát/.test(r.body) && /525\.000/.test(r.body) && /520\.000/.test(r.body) && /-5\.000/.test(r.body) && /sao ke GHN 18\/07/.test(r.body);
  hist ? ok('lịch sử: kỳ vọng 525.000, thực nhận 520.000, chênh −5.000, ghi chú "sao ke GHN 18/07"') : bad('lịch sử đối soát thiếu', '');

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
