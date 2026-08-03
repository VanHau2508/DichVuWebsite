/**
 * End-to-end ĐƯỜNG TIỀN CỦA NỀN TẢNG (0124/0125) — shop tự trả tiền thuê bao. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/billing.e2e.mjs
 *
 * Đi TRỌN vòng: shop xem hạn → tạo hoá đơn + QR → webhook SePay (token NỀN TẢNG) khớp
 * pay_ref → worker cộng hạn + ghi sổ thu. Kèm cưỡng chế: hết hạn + quá ân hạn → khoá bán;
 * trả tiền → tự mở lại. Và các ca tiền dễ mất: trả TRÙNG không cộng đúp, trả THIẾU không
 * cộng, pay_ref lạ không khớp, token per-shop KHÔNG mở được hoá đơn nền tảng.
 */
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const PAYMENT = process.env.PAYMENT_URL ?? 'http://payment:3070';
const WORKER = process.env.WORKER_URL ?? 'http://worker:3080';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic = 'user.invited' AND payload->>'to' = $1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${d}${X}`); };
const sect = (m) => console.log(`\n${B}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };

async function rq(base, method, path, { body, cookie, origin, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
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
  return ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).sc) ?? cookie;
}
async function makeShopOwner(staffCookie, slug) {
  const r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, email, password, cookie: await login(email, password) };
}

// SePay gửi gì: payload tối thiểu mà parseEvent của payment chấp nhận.
// eventId: đặt TÊN cho giao dịch để tra lại đúng dòng trong hàng đợi đối soát, và để dựng
// được ca "SePay gửi LẠI cùng sự kiện" (idempotency) — mặc định vẫn ngẫu nhiên như cũ.
const sepay = (token, { ref, amount, account, eventId }) => rq(PAYMENT, 'POST', '/webhooks/sepay', {
  headers: { authorization: `Apikey ${token}` },
  body: { id: eventId ?? Math.floor(Math.random() * 1e9), gateway: 'VCB', transactionDate: new Date().toISOString().slice(0, 19).replace('T', ' '),
    accountNumber: account, transferType: 'in', transferAmount: amount, content: `CK ${ref}`, referenceCode: `FT${uniq()}` },
});
const billSweep = () => fetch(`${WORKER}/internal/billing-sweep`, { method: 'POST' }).then((r) => r.json()).catch(() => null);
const subOf = async (shopId) => (await owner.query('SELECT status, current_period_end, suspended_at FROM subscriptions WHERE shop_id=$1', [shopId])).rows[0];
const shopOf = async (shopId) => (await owner.query('SELECT status FROM shops WHERE id=$1', [shopId])).rows[0];

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `bill-${uniq()}`);

  // Cắm tài khoản nhận tiền của NỀN TẢNG (vai chủ nền tảng làm việc này ở console).
  // Số tài khoản nằm ở ENV của service seller (0128) — phải khớp compose.dev.
  // DB chỉ giữ hash token để webhook khớp tiền về.
  const PLAT_TOKEN = `plat-sepay-${uniq()}`;
  const ACC = process.env.PLATFORM_BANK_ACCOUNT ?? '0123456789';
  await owner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`).catch(() => {});
  await owner.query(
    `UPDATE platform_billing_config SET sepay_token_hash = encode(digest($1,'sha256'),'hex'), enabled = true`,
    [PLAT_TOKEN],
  );

  const a = {
    get: (p) => rq(SELLER, 'GET', `/shops/${A.shopId}${p}`, { cookie: A.cookie }),
    post: (p, b) => rq(SELLER, 'POST', `/shops/${A.shopId}${p}`, { body: b, cookie: A.cookie, origin: OS }),
  };

  sect('1. Chủ shop XEM được gói + hạn của mình');
  let r = await a.get('/billing');
  r.status === 200 && r.json?.plan_code ? ok(`thấy gói "${r.json.plan_code}"`) : bad('không xem được gói', r.raw);
  typeof r.json?.days_left === 'number' ? ok(`thấy còn ${r.json.days_left} ngày`) : bad('không có số ngày còn lại', r.raw);
  r.json?.available === true ? ok('nền tảng đã cắm tài khoản nhận tiền') : bad('billing chưa sẵn sàng', r.raw);
  Array.isArray(r.json?.plans) && r.json.plans.length ? ok('thấy bảng giá các gói') : bad('không có bảng giá');

  sect('2. Tạo hoá đơn gia hạn → có mã chuyển khoản + QR');
  r = await a.post('/billing/charge', { months: 0 });
  r.status === 400 ? ok('0 tháng → 400') : bad('không chặn số tháng rác', r.raw);
  r = await a.post('/billing/charge', { months: 3 });
  const ch = r.json;
  r.status === 201 && /^SUB[0-9A-F]{10}$/.test(ch?.pay_ref ?? '') ? ok(`hoá đơn 201, mã CK ${ch.pay_ref}`) : bad('tạo hoá đơn lỗi', r.raw);
  ch?.qr_string?.startsWith('00020101') ? ok('có chuỗi VietQR để khách quét') : bad('không dựng được QR', String(ch?.qr_string).slice(0, 40));
  const planPrice = (await owner.query(`SELECT price_vnd_month FROM plans WHERE code='platform'`)).rows[0].price_vnd_month;
  Number(ch?.amount_vnd) === Number(planPrice) * 3 ? ok('số tiền = giá gói × 3 tháng (giá lấy từ DB)') : bad(`tiền sai: ${ch?.amount_vnd}`);
  // Giá KHÔNG được nhận từ client — client gửi giá là client tự đặt giá.
  const spoof = await a.post('/billing/charge', { months: 1, amount_vnd: 1 });
  Number(spoof.json?.amount_vnd) === Number(planPrice) ? ok('client gửi amount_vnd bị BỎ QUA') : bad(`client tự đặt được giá: ${spoof.json?.amount_vnd}`);
  const live = await a.post('/billing/charge', { months: 2 });

  sect('3. Webhook tiền về → cộng hạn + ghi sổ thu');
  const before = await subOf(A.shopId);
  r = await sepay(PLAT_TOKEN, { ref: 'SUBKHONGCOTHAT', amount: 999000, account: ACC });
  r.status === 200 && r.json?.matched === false ? ok('mã CK lạ → không khớp, không cộng gì') : bad('mã lạ vẫn khớp!', r.raw);
  r = await sepay(PLAT_TOKEN, { ref: live.json.pay_ref, amount: Number(live.json.amount_vnd) - 1000, account: ACC });
  r.json?.reason === 'amount_short' ? ok('trả THIẾU → không ghi nhận (không cộng hạn hụt)') : bad('trả thiếu vẫn qua!', r.raw);
  r = await sepay(PLAT_TOKEN, { ref: live.json.pay_ref, amount: Number(live.json.amount_vnd), account: ACC });
  r.status === 200 && r.json?.matched === true ? ok('trả ĐÚNG → webhook khớp hoá đơn') : bad('không khớp hoá đơn', r.raw);
  let sw = await billSweep();
  Number(sw?.applied) >= 1 ? ok('worker áp dụng khoản đã trả') : bad('worker không áp dụng', JSON.stringify(sw));
  const after = await subOf(A.shopId);
  const gained = (new Date(after.current_period_end) - new Date(before.current_period_end)) / 86400000;
  gained > 55 && gained < 65 ? ok(`cộng đúng 2 tháng (+${Math.round(gained)} ngày)`) : bad(`cộng hạn sai: +${Math.round(gained)} ngày`);
  after.status === 'active' ? ok("thuê bao về 'active'") : bad(`status sai: ${after.status}`);
  const inv = (await owner.query(`SELECT count(*)::int n FROM platform_invoices WHERE shop_id=$1`, [A.shopId])).rows[0].n;
  inv === 1 ? ok('ghi ĐÚNG 1 dòng sổ thu') : bad(`sổ thu có ${inv} dòng`);

  sect('4. Trả TRÙNG không cộng đúp');
  const end1 = (await subOf(A.shopId)).current_period_end;
  await sepay(PLAT_TOKEN, { ref: live.json.pay_ref, amount: Number(live.json.amount_vnd), account: ACC });
  sw = await billSweep();
  const end2 = (await subOf(A.shopId)).current_period_end;
  String(end1) === String(end2) ? ok('webhook lặp → hạn KHÔNG đổi') : bad('cộng hạn hai lần!', `${end1} → ${end2}`);
  const inv2 = (await owner.query(`SELECT count(*)::int n FROM platform_invoices WHERE shop_id=$1`, [A.shopId])).rows[0].n;
  inv2 === 1 ? ok('sổ thu vẫn 1 dòng (không nhân đôi doanh thu)') : bad(`sổ thu thành ${inv2} dòng`);

  sect('5. Token PER-SHOP không mở được hoá đơn nền tảng');
  const c2 = await a.post('/billing/charge', { months: 1 });
  r = await sepay('token-cua-shop-khac', { ref: c2.json.pay_ref, amount: Number(c2.json.amount_vnd), account: ACC });
  r.status === 401 ? ok('token lạ → 401, không đụng hoá đơn') : bad(`token lạ lọt (${r.status})`, r.raw);
  const st = (await owner.query(`SELECT status FROM billing_charges WHERE id=$1`, [c2.json.id])).rows[0].status;
  st === 'pending' ? ok('hoá đơn vẫn pending') : bad(`hoá đơn bị đổi sang ${st}`);

  sect('6. Hết hạn + quá ân hạn → KHOÁ BÁN, trả tiền → mở lại');
  // Đẩy hạn về quá khứ xa hơn ân hạn (7 ngày) rồi cho worker cưỡng chế.
  const before6 = (await shopOf(A.shopId)).status;
  await owner.query(`UPDATE subscriptions SET status='past_due', current_period_end = now() - interval '30 days', suspended_at = NULL, suspended_from = NULL WHERE shop_id=$1`, [A.shopId]);
  sw = await billSweep();
  Number(sw?.suspended) >= 1 ? ok('worker khoá shop quá ân hạn') : bad('không khoá', JSON.stringify(sw));
  (await shopOf(A.shopId)).status === 'suspended' ? ok("shops.status = 'suspended' (storefront tự chặn)") : bad('shop vẫn active');
  // Chủ shop VẪN vào được admin để trả tiền — khoá cả lối trả tiền là tự chặn tiền của mình.
  r = await a.get('/billing');
  r.status === 200 && r.json?.suspended_for_nonpayment === true
    ? ok('admin VẪN vào được + báo rõ đang khoá vì chưa thanh toán') : bad('chủ shop không vào được để trả tiền!', r.raw);
  const pay = await a.post('/billing/charge', { months: 1 });
  await sepay(PLAT_TOKEN, { ref: pay.json.pay_ref, amount: Number(pay.json.amount_vnd), account: ACC });
  await billSweep();
  const un = await shopOf(A.shopId), unsub = await subOf(A.shopId);
  un.status !== 'suspended' && !unsub.suspended_at
    ? ok(`trả tiền → TỰ MỞ LẠI ngay (về '${un.status}')`) : bad(`chưa mở lại: shop=${un.status} suspended_at=${unsub.suspended_at}`);
  // Trả về ĐÚNG trạng thái cũ, không phải ép 'active': shop chưa bấm "Mở bán" thì trả tiền
  // xong vẫn ở 'onboarding' — bấm hộ là quyết định thay chủ shop.
  un.status === before6 ? ok(`về ĐÚNG trạng thái trước khi khoá ('${before6}')`) : bad(`trả về sai trạng thái: ${before6} → ${un.status}`);

  sect('7. Shop bị nhân viên nền tảng khoá KHÔNG tự mở bằng cách trả tiền');
  await owner.query(`UPDATE shops SET status='suspended' WHERE id=$1`, [A.shopId]);
  await owner.query(`UPDATE subscriptions SET suspended_at = NULL WHERE shop_id=$1`, [A.shopId]);
  const pay2 = await a.post('/billing/charge', { months: 1 });
  await sepay(PLAT_TOKEN, { ref: pay2.json.pay_ref, amount: Number(pay2.json.amount_vnd), account: ACC });
  await billSweep();
  (await shopOf(A.shopId)).status === 'suspended'
    ? ok('khoá do nền tảng KHÔNG bị tiền mở ra (cưỡng chế vẫn có nghĩa)') : bad('trả tiền mở được cả shop bị nền tảng khoá!');

  sect('7b. Shop bị SWEEP THUÊ BAO khoá (không phải sweep tiền) vẫn mở lại được khi trả tiền');
  // HAI sweep cùng khoá shop: sweepBillingEnforce (đóng dấu suspended_at) và
  // sweepSubscriptions (trước đây KHÔNG đóng dấu). Đường mở khoá chỉ nhìn suspended_at, mà
  // sau khi trả tiền thì sub thành 'active' nên enforce KHÔNG BAO GIỜ chọn lại để đóng dấu
  // bù → shop kẹt 'suspended' VĨNH VIỄN dù đã trả tiền. Hai sweep là hai setInterval riêng
  // còn apply chạy mỗi 30s, nên cửa sổ này có thật ở cấu hình mặc định. Dựng lại: a8.
  await owner.query(`UPDATE shops SET status='active' WHERE id=$1`, [A.shopId]);
  await owner.query(
    `UPDATE subscriptions SET status='past_due', current_period_end = now() - interval '30 days',
            suspended_at = NULL, suspended_from = NULL WHERE shop_id=$1`, [A.shopId]);
  await fetch(`${WORKER}/internal/subscription-sweep`, { method: 'POST' }).then((x) => x.json()).catch(() => null);
  const sh7b = await shopOf(A.shopId), sub7b = await subOf(A.shopId);
  sh7b.status === 'suspended' && sub7b.suspended_at
    ? ok('sweep thuê bao khoá shop VÀ đóng dấu suspended_at (đường mở khoá cần dấu này)')
    : bad('sweep thuê bao khoá mà không đóng dấu → trả tiền cũng không mở được', `shop=${sh7b.status} dấu=${sub7b.suspended_at}`);
  const pay7b = await a.post('/billing/charge', { months: 1 });
  await sepay(PLAT_TOKEN, { ref: pay7b.json.pay_ref, amount: Number(pay7b.json.amount_vnd), account: ACC });
  await billSweep();
  const un7b = await shopOf(A.shopId);
  un7b.status !== 'suspended'
    ? ok(`trả tiền → mở lại được (về '${un7b.status}') dù kẻ khoá là sweep thuê bao`)
    : bad('TRẢ TIỀN RỒI VẪN BỊ KHOÁ VĨNH VIỄN', `shop=${un7b.status}`);

  sect('7c. Shop bị nền tảng khoá vì VI PHẠM: cưỡng chế nợ phí KHÔNG được đóng dấu hộ');
  // Lỗ hợp thành: (1) enforce khoá shop rồi đóng dấu suspended_at để đường mở khoá biết
  // "chính ta khoá"; (2) apply mở khoá dựa DUY NHẤT vào dấu đó. Shop đã bị nền tảng khoá tay
  // thì UPDATE ở (1) trượt (guard status IN active/onboarding) NHƯNG dấu vẫn bị đóng → shop
  // vi phạm TỰ MỞ LẠI ĐƯỢC bằng cách trả một tháng tiền. §7 ở trên không bắt được vì nó
  // không hề chạy enforce ở giữa — đúng kiểu "test xanh mà lỗ vẫn còn".
  await owner.query(`UPDATE shops SET status='suspended' WHERE id=$1`, [A.shopId]);
  await owner.query(
    `UPDATE subscriptions SET status='past_due', current_period_end = now() - interval '60 days',
            suspended_at = NULL, suspended_from = NULL WHERE shop_id=$1`, [A.shopId]);
  await billSweep();
  const sub7c = await subOf(A.shopId);
  !sub7c.suspended_at
    ? ok('enforce KHÔNG đóng dấu lên shop nó không khoá được (dấu vẫn trống)')
    : bad('enforce đóng dấu khống → shop vi phạm mở lại được bằng tiền', `dấu=${sub7c.suspended_at}`);
  const pay7c = await a.post('/billing/charge', { months: 1 });
  await sepay(PLAT_TOKEN, { ref: pay7c.json.pay_ref, amount: Number(pay7c.json.amount_vnd), account: ACC });
  await billSweep();
  (await shopOf(A.shopId)).status === 'suspended'
    ? ok('trả tiền xong shop vi phạm VẪN khoá (cưỡng chế của nền tảng còn nguyên nghĩa)')
    : bad('TRẢ TIỀN MỞ ĐƯỢC SHOP BỊ KHOÁ VÌ VI PHẠM');

  sect('7d. Nền tảng mở lại shop → dọn cờ nợ phí, kỳ sau vẫn khoá lại được');
  // Cờ suspended_at là điều kiện LỌC của enforce (suspended_at IS NULL). Mở shop mà để cờ
  // nguyên = shop rơi khỏi tập cưỡng chế VĨNH VIỄN → dùng miễn phí mãi mãi.
  await owner.query(`UPDATE shops SET status='active' WHERE id=$1`, [A.shopId]);
  await owner.query(
    `UPDATE subscriptions SET status='past_due', current_period_end = now() - interval '60 days',
            suspended_at = NULL, suspended_from = NULL WHERE shop_id=$1`, [A.shopId]);
  await billSweep();                                   // → khoá thật + đóng dấu thật
  const sub7d0 = await subOf(A.shopId);
  sub7d0.suspended_at ? ok('enforce khoá shop nợ phí và đóng dấu') : bad('enforce không khoá được', JSON.stringify(sub7d0));
  // Nhân viên nền tảng bấm "Mở lại" (/ops/shops/:id/restore — admin + step-up).
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: 'staff strong passphrase' }, cookie: staff, origin: OA });
  const rest = await rq(PLATFORM, 'POST', `/ops/shops/${A.shopId}/restore`, { cookie: staff, origin: OO });
  const sub7d1 = await subOf(A.shopId);
  rest.status === 200 && !sub7d1.suspended_at
    ? ok('bấm Mở lại → cờ nợ phí được DỌN (shop trở lại tầm ngắm của cưỡng chế)')
    : bad('mở lại mà cờ còn nguyên → shop dùng miễn phí vĩnh viễn', `http=${rest.status} dấu=${sub7d1.suspended_at}`);
  await billSweep();
  (await shopOf(A.shopId)).status === 'suspended'
    ? ok('vẫn nợ → nhịp cưỡng chế sau khoá lại được (không mù vĩnh viễn)')
    : bad('mở lại xong cưỡng chế MÙ với shop này');

  sect('7e. Tiền shop trả nền tảng KHÔNG khớp → vào hàng đợi đối soát, không bốc hơi');
  // Lỗ: nhánh tiền-thuê-bao của webhook return TRƯỚC persistUnmatched (và cũng chưa set
  // app.shop_id nên không dùng được bảng của tiền-khách). Mọi lý do trượt chỉ đẻ MỘT DÒNG
  // LOG; sweepMoneyAlerts đếm từ `unmatched_transfers` nên không bao giờ kêu. Tiền nằm
  // trong tài khoản nền tảng, DB không vết, 7 ngày sau shop bị khoá vì "chưa trả". (0135)
  const openQ = async () => Number((await owner.query(
    `SELECT count(*)::int n FROM platform_unmatched_transfers WHERE resolved_at IS NULL`)).rows[0].n);
  // shop KHÔNG lưu thành cột (bảng cấp nền tảng, không bật RLS) — suy ra qua pay_ref.
  const rowOf = async (evId) => (await owner.query(
    `SELECT u.reason, u.amount_vnd, u.pay_ref, bc.shop_id
       FROM platform_unmatched_transfers u LEFT JOIN billing_charges bc ON bc.pay_ref = u.pay_ref
      WHERE u.provider_event_id = $1`, [evId])).rows[0];
  await owner.query(`DELETE FROM platform_unmatched_transfers`);   // bộ khác có thể để lại

  // (a) shop gõ THIẾU nội dung chuyển khoản → không dò ra mã.
  const ev1 = `noref-${uniq()}`;
  await sepay(PLAT_TOKEN, { ref: 'CHUYEN TIEN', amount: 299000, account: ACC, eventId: ev1 });
  const r1 = await rowOf(ev1);
  r1?.reason === 'no_ref' && Number(r1.amount_vnd) === 299000
    ? ok('gõ thiếu nội dung CK → ghi hàng đợi (no_ref, 299.000đ)') : bad('no_ref bốc hơi', JSON.stringify(r1));

  // (b) shop bấm "Tạo mã thanh toán" LẦN NỮA sau khi đã chuyển theo mã cũ → mã cũ bị huỷ.
  const cu = await a.post('/billing/charge', { months: 1 });
  await a.post('/billing/charge', { months: 3 });                  // huỷ mã cũ (billing.js:128)
  const ev2 = `cancel-${uniq()}`;
  await sepay(PLAT_TOKEN, { ref: cu.json.pay_ref, amount: Number(cu.json.amount_vnd), account: ACC, eventId: ev2 });
  const r2 = await rowOf(ev2);
  r2?.reason === 'charge_cancelled' && r2.shop_id === A.shopId
    ? ok('đổi số tháng sau khi đã chuyển tiền → ghi hàng đợi kèm ĐÚNG shop') : bad('tiền theo mã đã huỷ bốc hơi', JSON.stringify(r2));

  // (c) ngân hàng trừ phí → về thiếu vài nghìn.
  const thieu = await a.post('/billing/charge', { months: 1 });
  const ev3 = `short-${uniq()}`;
  await sepay(PLAT_TOKEN, { ref: thieu.json.pay_ref, amount: Number(thieu.json.amount_vnd) - 3000, account: ACC, eventId: ev3 });
  const r3 = await rowOf(ev3);
  r3?.reason === 'amount_short' ? ok('về thiếu tiền → ghi hàng đợi (amount_short)') : bad('tiền về thiếu bốc hơi', JSON.stringify(r3));

  // (d) SePay gửi LẠI cùng sự kiện → không đẻ dòng thứ hai.
  const truocLap = await openQ();
  await sepay(PLAT_TOKEN, { ref: 'CHUYEN TIEN', amount: 299000, account: ACC, eventId: ev1 });
  (await openQ()) === truocLap ? ok('gửi lại cùng sự kiện → không nhân đôi dòng') : bad('hàng đợi nhân đôi khi SePay gửi lại');

  // (e) và cảnh báo tiền PHẢI kêu — ngưỡng 1, không chờ 1 tiếng như tiền-khách.
  const al = await fetch(`${WORKER}/internal/alert-sweep`, { method: 'POST' }).then((x) => x.json()).catch(() => null);
  Number(al?.metrics?.plat_unmatched_open) >= 3
    ? ok(`cảnh báo đếm được ${al.metrics.plat_unmatched_open} khoản chưa khớp cấp nền tảng`)
    : bad('cảnh báo tiền MÙ với đường tiền nền tảng', JSON.stringify(al?.metrics ?? al));

  sect('8. MÀN HÌNH: chủ shop BẤM THẬT trên trang Gói dịch vụ');
  // Bài học cũ: nút "có mặt" không nói gì về việc bấm vào có chạy. Ở đây gửi form thật.
  const adm = async (method, path, form) => {
    const h = { cookie: `__Host-session=${A.cookie}` };
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; h.origin = OADM; }
    const rr = await fetch(ADMIN + path, { method, headers: h, redirect: 'manual', body: form ? new URLSearchParams(form).toString() : undefined });
    return { status: rr.status, body: await rr.text() };
  };
  let pg = await adm('GET', `/shops/${A.shopId}/billing`);
  pg.status === 200 && /Gói dịch vụ/.test(pg.body) ? ok('trang Gói dịch vụ mở được') : bad(`trang lỗi (${pg.status})`, pg.body.slice(0, 200));
  /(Còn \d+ ngày|quá hạn|Hết hạn hôm nay|ĐANG BỊ KHOÁ)/.test(pg.body)
    ? ok('hiện tình trạng hạn bằng câu người thường đọc được') : bad('không thấy tình trạng hạn', pg.body.slice(0, 300));
  const home = await adm('GET', `/shops/${A.shopId}/orders`);
  home.body.includes(`/shops/${A.shopId}/billing`) ? ok('menu trái có mục Gói dịch vụ') : bad('menu thiếu lối vào');
  pg = await adm('POST', `/shops/${A.shopId}/billing/charge`, { months: '6', plan_code: '' });
  const uiRef = /SUB[0-9A-F]{10}/.exec(pg.body)?.[0];
  pg.status === 200 && uiRef ? ok(`bấm "Tạo mã thanh toán" → trang hiện mã ${uiRef}`) : bad('bấm nút không ra mã', pg.body.slice(0, 300));
  /<svg/.test(pg.body) ? ok('có ảnh QR nội tuyến (khách quét được ngay)') : bad('không vẽ được QR');
  const dbCh = uiRef ? (await owner.query(`SELECT amount_vnd, months FROM billing_charges WHERE pay_ref=$1`, [uiRef])).rows[0] : null;
  // Màn hình lệch DB nghĩa là người bán chuyển số tiền khác số hệ thống chờ → không khớp.
  Number(dbCh?.months) === 6 && pg.body.includes(new Intl.NumberFormat('vi-VN').format(Number(dbCh.amount_vnd)))
    ? ok('số tiền + số tháng trên màn hình khớp DB') : bad(`màn hình lệch DB: ${JSON.stringify(dbCh)}`);

  sect('9b. Console: người vận hành THẤY và ĐÓNG được khoản tiền lạc');
  // Cảnh báo Telegram chỉ nói CÓ BAO NHIÊU. Không có màn hình thì không ai biết là gì, của
  // shop nào, và không đóng lại được → cảnh báo kêu mãi rồi bị bỏ qua (tệ hơn không có).
  const admStaff = async (method, path, form) => {
    const h = { cookie: `__Host-session=${staff}` };
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; h.origin = OADM; }
    const rr = await fetch(ADMIN + path, { method, headers: h, redirect: 'manual', body: form ? new URLSearchParams(form).toString() : undefined });
    return { status: rr.status, body: await rr.text() };
  };
  const bp = await admStaff('GET', '/platform/billing');
  /khoản tiền shop chuyển về CHƯA khớp/.test(bp.body) && /299\.000₫/.test(bp.body)
    ? ok('màn Thu tiền hiện danh sách tiền lạc kèm số tiền') : bad('màn hình không hiện tiền lạc', bp.body.slice(0, 400));
  /Nội dung chuyển khoản thiếu mã SUB/.test(bp.body)
    ? ok('nói RÕ vì sao lạc bằng câu người thường đọc được') : bad('không giải thích lý do lạc');
  const lacId = (await owner.query(
    `SELECT id FROM platform_unmatched_transfers WHERE resolved_at IS NULL ORDER BY created_at LIMIT 1`)).rows[0]?.id;
  const rr9 = await admStaff('POST', `/platform/billing/unmatched/${lacId}/resolve`, {});
  const conLai = await openQ();
  rr9.status === 200 && conLai === 2
    ? ok(`bấm "Đã xử lý" → khoản đó đóng lại, còn ${conLai} khoản`) : bad('không đóng được khoản tiền lạc', `http=${rr9.status} còn=${conLai}`);
  const lai = await admStaff('POST', `/platform/billing/unmatched/${lacId}/resolve`, {});
  /đã xử lý rồi/.test(lai.body) ? ok('bấm lại lần nữa → báo đã xử lý rồi (không ghi đè người xử)') : bad('đóng hai lần lọt', lai.body.slice(0, 200));

  sect('9. Console nền tảng: màn cấu hình thu tiền');
  const cons = await fetch(`${ADMIN}/platform/billing`, { headers: { cookie: `__Host-session=${staff}` }, redirect: 'manual' });
  const stBody = await cons.text();
  cons.status === 200 && /Thu tiền thuê bao/.test(stBody) ? ok('chủ nền tảng mở được màn cấu hình') : bad(`console billing lỗi (${cons.status})`, stBody.slice(0, 200));
  // Màn này phải cho thấy CẢ HAI nửa (token ở DB + số tài khoản ở env) — cấu hình đúng một
  // nửa mà tưởng xong là shop không thấy nút trả tiền, còn mình không biết vì sao.
  /PLATFORM_BANK_ACCOUNT/.test(stBody) && /Token SePay/.test(stBody)
    ? ok('hiện cả token (DB) lẫn số tài khoản (env) để đối chiếu') : bad('màn cấu hình thiếu một nửa', stBody.slice(0, 300));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
