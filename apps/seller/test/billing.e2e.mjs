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
const sepay = (token, { ref, amount, account }) => rq(PAYMENT, 'POST', '/webhooks/sepay', {
  headers: { authorization: `Apikey ${token}` },
  body: { id: Math.floor(Math.random() * 1e9), gateway: 'VCB', transactionDate: new Date().toISOString().slice(0, 19).replace('T', ' '),
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

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
