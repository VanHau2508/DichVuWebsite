/**
 * E2E "KHÁCH NHÌN THẤY GÌ LÚC TRANH CHẤP" (docs/67).
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/checkout/test/khach-luc-tranh-chap.e2e.mjs
 *
 * Hai màn hình khách đọc khi đơn đã hỏng — trang TRA CỨU (dán số đơn + mã, không cần tài
 * khoản) và trang LỊCH SỬ ĐƠN của khách đã đăng nhập. Đây là lúc khách vừa trả hàng xong,
 * đang chờ tiền về, và mở điện thoại ra xem.
 *
 * ĐO THẬT TRƯỚC KHI VIẾT, trên shop ngày-60:
 *   · đơn #275 — khách trả hàng, shop ĐÃ hoàn 1.405.000₫. Trang in trạng thái là chữ
 *     `refunded` (tiếng Anh thô, badge xanh), vẫn ghi "Thanh toán khi nhận hàng (COD)", và
 *     KHÔNG một chữ nào về khoản đã hoàn.
 *   · đơn #267 — huỷ, khách đã trả 1.990.000₫, shop hoàn 1.560.000₫. Trang chỉ ghi "Đã huỷ",
 *     im lặng hoàn toàn về 430.000₫ còn lại.
 * Đọc mã ra thêm hai biến thể tệ hơn, bộ này dựng lại cả hai bằng luồng thật:
 *   · đơn QR BOM HÀNG giữ payment_status='paid' → hiện "Đã thanh toán ✓" như chưa có gì;
 *   · đơn QR ĐÃ HOÀN TIỀN có payment_status='refunded' → rơi vào nhánh cuối và trang VẼ LẠI
 *     MÃ QR ĐÒI TIỀN kèm tự tải lại mỗi 8 giây.
 *
 * BẤT BIẾN LỚN NHẤT bộ này canh: con số tiền KHÁCH thấy phải BẰNG con số SHOP thấy. Hai đầu
 * một cuộc tranh chấp mà đọc hai màn hình nói hai số thì phần mềm đang châm dầu vào lửa.
 */
import http from 'node:http';
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const CO = new URL(process.env.CHECKOUT_URL ?? 'http://checkout:3060');
const ACC = new URL(process.env.ACCOUNT_URL ?? 'http://account:3062');
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const inviteTokenOf = async (e) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [e]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', BOLD = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${String(d).slice(0, 200)}${X}`); };
const sect = (m) => console.log(`\n${BOLD}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };
const money = (v) => new Intl.NumberFormat('vi-VN').format(Number(v)) + '₫';

async function rq(base, method, path, { body, cookie, origin } = {}) {
  const h = {}; if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin; if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, raw: t, sc: r.headers.getSetCookie() };
}
async function adm(method, path, { cookie, form } = {}) {
  const h = {}; if (form !== undefined) h['content-type'] = 'application/x-www-form-urlencoded';
  h.origin = OADM; if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(ADMIN + path, { method, headers: h, redirect: 'manual', body: form !== undefined ? String(form) : undefined });
  return { status: r.status, loc: r.headers.get('location'), body: await r.text(), sc: r.headers.getSetCookie() };
}
// Trang khách phải gọi qua http.request: fetch của Node CẤM đặt header Host (forbidden
// header), nên shop được phân giải theo tên miền sẽ không bao giờ khớp — mất nửa giờ vì nó.
function byHost(hostname, port, path, host, { cookie, method = 'GET', form, origin } = {}) {
  const headers = { host };
  if (cookie) headers.cookie = cookie;
  const body = form ? new URLSearchParams(form).toString() : null;
  if (body) { headers['content-type'] = 'application/x-www-form-urlencoded'; headers['content-length'] = Buffer.byteLength(body); }
  if (origin) headers.origin = origin;
  return new Promise((resolve) => {
    const r = http.request({ hostname, port, path, method, headers }, (x) => {
      let b = ''; x.on('data', (c) => { b += c; }); x.on('end', () => resolve({ status: x.statusCode, body: b }));
    });
    if (body) r.write(body);
    r.end();
  });
}
const co = (path, host, o = {}) => byHost(CO.hostname, CO.port, path, host, o);
const acct = (path, host, o = {}) => byHost(ACC.hostname, ACC.port, path, host, o);
const login = async (e, p) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email: e, password: p }, origin: OA })).sc);
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

async function main() {
  const staff = await makeStaff();
  const slug = `tc-${uniq()}`;
  const shopId = (await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO })).json.id;
  await owner.query(`UPDATE shops SET status='active', went_live_at=now() WHERE id=$1`, [shopId]);
  const host = `${slug}.nentang.vn`;
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  const api = await login(oe, op);
  const ui = ck((await adm('POST', '/login', { form: new URLSearchParams({ email: oe, password: op }) })).sc);
  const S = {
    get: (p) => rq(SELLER, 'GET', `/shops/${shopId}${p}`, { cookie: api }),
    post: (p, b) => rq(SELLER, 'POST', `/shops/${shopId}${p}`, { body: b, cookie: api, origin: OS }),
    patch: (p, b) => rq(SELLER, 'PATCH', `/shops/${shopId}${p}`, { body: b, cookie: api, origin: OS }),
  };
  await S.patch('', { name: slug, max_pending_per_phone: 999, max_pending_per_ip: 999 });
  const pr = await S.post('/products', { title: 'Áo tranh chấp', slug: `ao-${uniq()}`, price_vnd: 400000, status: 'active', variants: [{ sku: `TC-${uniq()}`, price_vnd: 400000 }] });
  const vid = (await S.get(`/products/${pr.json.id}`)).json.variants[0].id;
  await S.post(`/variants/${vid}/inventory/adjust`, { delta: 200, reason: 'nhập' });
  const A = (oid, act, f = {}) => adm('POST', `/shops/${shopId}/orders/${oid}/${act}`, { cookie: ui, form: new URLSearchParams(f) });
  const markPaid = (oid) => adm('POST', `/shops/${shopId}/orders/${oid}/mark-paid/step-up`, {
    cookie: ui, form: new URLSearchParams({ password: op }),
  });
  // Đơn tạo qua API seller: token tra cứu do máy chủ sinh và trả về trong response.
  const datDon = async (pm = 'cod') => (await S.post('/orders', {
    lines: [{ variant_id: vid, qty: 1 }],
    customer: { name: 'Khách tranh chấp', phone: `09${Math.floor(10000000 + Math.random() * 89999999)}`, email: `kh-${uniq()}@khach.vn`, address_line: '1 Lê Lợi', province: 'Hà Nội' },
    payment_method: pm, idempotency_key: `tc-${uniq()}`,
  })).json;
  // Trang tra cứu cần token THÔ; API tạo đơn của seller không trả nó (chỉ checkout trả). Lấy
  // bằng cách đặt lại hash theo một token ta tự chọn — CHỈ để thử trang, không đụng nghiệp vụ.
  const capToken = async (oid) => {
    const t = `e2e-${uniq()}`;
    await owner.query(`UPDATE orders SET lookup_token_hash = encode(sha256($2::bytea),'hex') WHERE id = $1`, [oid, t]);
    return t;
  };
  const xemTraCuu = async (o) => co(`/checkout/success?number=${o.order_number}&token=${encodeURIComponent(await capToken(o.id))}`, host);
  const owedCuaShop = async (oid) => Number((await rq(SELLER, 'GET', `/shops/${shopId}/orders/${oid}`, { cookie: api })).json.owed_vnd);
  ui ? ok('dựng shop + sản phẩm + đăng nhập quản trị') : bad('không đăng nhập được', '');

  // ── 1. ĐƠN QR BOM HÀNG — "Đã thanh toán ✓" như chưa có chuyện gì ─────────
  sect('1. Đơn QR bị bom hàng — trước đây khách vẫn thấy "Đã thanh toán ✓"');
  const dBom = await datDon('cod');
  await A(dBom.id, 'confirm'); await markPaid(dBom.id);
  await A(dBom.id, 'ship', { tracking_number: `TN${uniq()}` });
  await A(dBom.id, 'mark-returned', { restock: 'on' });
  // Đơn QR: shop thử nghiệm chưa gắn ngân hàng nên không đặt QR qua API được — đổi phương
  // thức trong DB vì thứ đang canh là TRANG HIỂN THỊ, không phải luồng đặt.
  await owner.query(`UPDATE orders SET payment_method='qr' WHERE id=$1`, [dBom.id]);
  let p = await xemTraCuu(dBom);
  p.status === 200 && !/Đã thanh toán ✓/.test(p.body)
    ? ok('KHÔNG còn "Đã thanh toán ✓" trên đơn khách đã trả hàng') : bad('vẫn khoe đã thanh toán', p.status);
  /Đã hoàn hàng/.test(p.body) ? ok('trạng thái hiện bằng tiếng Việt: "Đã hoàn hàng"') : bad(`nhãn sai: ${(p.body.match(/badge [a-z]*">([^<]*)</) ?? [])[1]}`, '');
  !/http-equiv="refresh"/.test(p.body) ? ok('không còn tự tải lại mỗi 8 giây (đơn đã đóng thì chờ gì nữa)') : bad('vẫn tự tải lại', '');
  const noBom = await owedCuaShop(dBom.id);
  new RegExp(`Cửa hàng còn phải hoàn</span><span><strong>${money(noBom).replace(/[.]/g, '\\.')}`).test(p.body)
    ? ok(`nói thẳng "còn phải hoàn ${money(noBom)}" — ĐÚNG con số shop nhìn thấy`) : bad(`không khớp số của shop (${money(noBom)})`, p.body.match(/còn phải hoàn[\s\S]{0,80}/)?.[0]);

  // ── 2. ĐƠN QR ĐÃ HOÀN TIỀN — trước đây vẽ lại QR ĐÒI TIỀN ────────────────
  sect('2. Đơn QR đã hoàn tiền — trước đây trang vẽ lại mã QR đòi khách chuyển khoản');
  const dHoan = await datDon('cod');
  await A(dHoan.id, 'confirm'); await markPaid(dHoan.id);
  await adm('POST', `/shops/${shopId}/orders/${dHoan.id}/refund/step-up`,
    { cookie: ui, form: new URLSearchParams({ password: op, reason: 'khách đổi ý, hoàn đủ' }) });
  await owner.query(`UPDATE orders SET payment_method='qr' WHERE id=$1`, [dHoan.id]);
  const st = (await owner.query(`SELECT status, payment_status FROM orders WHERE id=$1`, [dHoan.id])).rows[0];
  st.payment_status === 'refunded'
    ? ok(`dựng đúng ca: payment_status='${st.payment_status}' (KHÁC 'paid' → luật cũ rơi vào nhánh vẽ QR)`) : bad(`ca sai: ${JSON.stringify(st)}`, '');
  p = await xemTraCuu(dHoan);
  !/Chuyển khoản QR/.test(p.body) && !/Đang chờ thanh toán/.test(p.body)
    ? ok('KHÔNG còn vẽ mã QR đòi tiền trên đơn đã hoàn tiền') : bad('vẫn đòi khách chuyển khoản!', '');
  /Đã hoàn tiền/.test(p.body) ? ok('trạng thái "Đã hoàn tiền" bằng tiếng Việt') : bad('nhãn thô', '');
  /Cửa hàng đã hoàn đủ khoản bạn thanh toán/.test(p.body)
    ? ok('và nói rõ đã hoàn ĐỦ — khách hết phải đoán') : bad('không nói gì về việc đã hoàn đủ', '');

  // ── 3. ĐƠN HUỶ HOÀN MỘT PHẦN — con số hai bên phải BẰNG NHAU ─────────────
  sect('3. Huỷ đơn, hoàn một phần — số khách thấy phải BẰNG số shop thấy');
  const dMot = await datDon('cod');
  await A(dMot.id, 'confirm'); await markPaid(dMot.id);
  await A(dMot.id, 'cancel', { reason: 'hết hàng' });
  await adm('POST', `/shops/${shopId}/orders/${dMot.id}/refund/step-up`,
    { cookie: ui, form: new URLSearchParams({ password: op, amount_vnd: '100000', reason: 'trả trước một phần' }) });
  p = await xemTraCuu(dMot);
  const noShop = await owedCuaShop(dMot.id);
  const soTrenTrang = (p.body.match(/Cửa hàng còn phải hoàn<\/span><span><strong>([^<]*)/) ?? [])[1];
  soTrenTrang === money(noShop) && noShop > 0
    ? ok(`khách thấy "${soTrenTrang}", shop thấy ${money(noShop)} — MỘT con số ở hai đầu tranh chấp`)
    : bad(`lệch: khách "${soTrenTrang}" vs shop ${money(noShop)}`, '');
  /Bạn đã thanh toán<\/span><span><strong>/.test(p.body) && /Cửa hàng đã hoàn lại<\/span><span><strong>/.test(p.body)
    ? ok('kèm đủ hai số kia (đã trả / đã được hoàn) — trả lời trọn câu khách hỏi') : bad('thiếu số', '');
  /liên hệ cửa hàng kèm số đơn/.test(p.body) ? ok('có lối ra: bảo khách liên hệ kèm số đơn') : bad('không có lối ra', '');
  !/vào ngày|trong vòng \d+ ngày/.test(p.body)
    ? ok('KHÔNG hứa hộ shop một mốc thời gian cụ thể (nền tảng không biết shop chuyển lúc nào)') : bad('hứa hộ shop', '');

  // ── 4. ĐƠN CÒN SỐNG KHÔNG BỊ ĐỤNG ────────────────────────────────────────
  sect('4. Đơn đang chạy bình thường — không được đổi gì');
  const dSong = await datDon('cod');
  await A(dSong.id, 'confirm');
  p = await xemTraCuu(dSong);
  /Thanh toán khi nhận hàng \(COD\)/.test(p.body) && !/Khoản tiền của đơn này/.test(p.body)
    ? ok('đơn COD đang giao vẫn hiện đúng như cũ, không mọc thêm khối tiền') : bad('đụng nhầm đơn còn sống', '');

  // ── 5. MÀN HÌNH KHÁCH ĐÃ ĐĂNG NHẬP — cùng một sự thật ────────────────────
  sect('5. Khách ĐÃ ĐĂNG NHẬP xem lịch sử đơn — phải nói cùng câu với trang tra cứu');
  const cEmail = `kh-${uniq()}@khach.vn`, cPass = 'khach passphrase manh';
  // PHẢI đi qua http.request: fetch của Node cấm đặt header Host, mà account phân giải shop
  // theo tên miền — dùng fetch thì mọi lời gọi rơi vào 404 "tên miền chưa kết nối". Đã vấp
  // đúng bẫy này hai lần trong một buổi, lần thứ hai ngay sau khi vừa viết chú thích về nó.
  const regRes = await acct('/account/register', host, {
    method: 'POST', origin: `https://${host}`,
    form: { email: cEmail, password: cPass, full_name: 'Khách Đăng Nhập' },
  });
  const cust = (await owner.query(`SELECT id FROM customers WHERE shop_id=$1 AND email=$2`, [shopId, cEmail])).rows[0];
  cust ? ok('tạo được tài khoản khách trên storefront') : bad(`không tạo được khách: ${regRes.status}`, regRes.body.slice(0, 140));
  if (cust) {
    await owner.query(`UPDATE orders SET customer_id=$2 WHERE id=$1`, [dMot.id, cust.id]);
    const sess = `e2e${uniq()}${uniq()}`;
    await owner.query(
      `INSERT INTO customer_sessions (shop_id, customer_id, token_hash, expires_at)
       VALUES ($1,$2, encode(sha256($3::bytea),'hex'), now() + interval '1 hour')`, [shopId, cust.id, sess]);
    const r = await acct(`/account/orders/${dMot.order_number}`, host, { cookie: `__Host-cust_session=${sess}` });
    r.status === 200 ? ok('mở được trang đơn trong tài khoản khách') : bad(`không mở được: ${r.status}`, r.body.slice(0, 140));
    if (r.status === 200) {
      !/>Đã thanh toán</.test(r.body)
        ? ok('KHÔNG còn nhãn trần "Đã thanh toán" cạnh "Đã huỷ" (nửa sự thật đã bỏ)') : bad('vẫn hiện nhãn nửa-sự-thật', '');
      r.body.includes(money(noShop))
        ? ok(`hiện ĐÚNG ${money(noShop)} — bằng trang tra cứu và bằng màn hình shop`) : bad(`lệch số: không thấy ${money(noShop)}`, '');
      /Khoản tiền của đơn này/.test(r.body) ? ok('có khối tiền đầy đủ như trang tra cứu') : bad('thiếu khối tiền', '');
    }
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
