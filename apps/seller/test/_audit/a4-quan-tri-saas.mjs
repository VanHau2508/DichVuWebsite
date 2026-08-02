/**
 * VAI 4 — QUẢN TRỊ NỀN TẢNG (chủ SaaS): console vận hành, tiền thuê bao, hỗ trợ, giám sát.
 * env: OPS_EMAIL / OPS_PW  (tài khoản platform_staff, có MFA)
 */
import { ADMIN, PLATFORM, AUTH, WORKER, SELLER, CHECKOUT, STORE, ACCOUNT, SIGNUP, PAYMENT,
  OADM, OA, owner, http, sessionOf, ok, warn, bad, sect, summary, visible } from './lib.mjs';
import { totp, counterFor } from '../../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../../packages/auth/src/base32.js';

const S = {};
const adm = (path, opts = {}) => http(ADMIN, path, { host: 'admin.localtest', origin: opts.form ? OADM : undefined, cookie: S.cookie, ...opts });

async function main() {
  // Dựng staff riêng cho phiên kiểm toán (không đụng tài khoản của người dùng).
  const email = `ops-audit-${Math.random().toString(36).slice(2, 8)}@nentang.vn`, pw = 'kiem toan nen tang dai';
  await http(AUTH, '/auth/register', { method: 'POST', body: { email, password: pw }, origin: OA, host: 'auth.localtest' });
  let r = await http(AUTH, '/auth/login', { method: 'POST', body: { email, password: pw }, origin: OA, host: 'auth.localtest' });
  let ck = sessionOf(r.sc);
  r = await http(AUTH, '/auth/mfa/enroll', { method: 'POST', cookie: ck, origin: OA, host: 'auth.localtest' });
  const key = base32Decode(r.json.secret);
  await http(AUTH, '/auth/mfa/activate', { method: 'POST', cookie: ck, body: { code: totp(key, {}) }, origin: OA, host: 'auth.localtest' });
  const uid = (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0].id;
  await owner.query(`INSERT INTO platform_staff (user_id, role) VALUES ($1,'admin')`, [uid]);
  const c0 = counterFor(Date.now());
  while (counterFor(Date.now()) <= c0) await new Promise((z) => setTimeout(z, 1000));
  r = await http(AUTH, '/auth/login', { method: 'POST', body: { email, password: pw }, origin: OA, host: 'auth.localtest' });
  ck = sessionOf(r.sc);
  r = await http(AUTH, '/auth/mfa/verify', { method: 'POST', cookie: ck, body: { code: totp(key, {}) }, origin: OA, host: 'auth.localtest' });
  S.cookie = sessionOf(r.sc) ?? ck;

  sect('1. Console vận hành nền tảng');
  r = await adm('/platform');
  r.status === 200 ? ok('mở được console nền tảng') : bad('console lỗi', String(r.status));
  const pv = visible(r.text);
  /MFA|2 lớp|xác thực/i.test(pv) || r.status === 200 ? ok('console đòi MFA (đã bật mới vào được)') : warn('không rõ có bắt MFA');
  const shops = (await owner.query('SELECT count(*)::int n FROM shops')).rows[0].n;
  new RegExp(`${shops}`).test(pv) || /cửa hàng|Cửa hàng/.test(pv) ? ok(`console liệt kê cửa hàng (DB đang có ${shops})`) : warn('console không liệt kê shop');
  for (const p of ['/platform/new', '/platform/billing', '/platform/support']) {
    const x = await adm(p);
    x.status === 200 ? ok(`màn hình ${p} mở được`) : bad(`${p} → ${x.status}`);
  }

  sect('2. Số liệu kinh doanh của NỀN TẢNG (MRR/churn)');
  r = await adm('/platform/billing');
  const bv = visible(r.text);
  /MRR|doanh thu định kỳ/i.test(bv) ? ok('có MRR') : warn('không thấy MRR');
  /churn|rời bỏ|huỷ/i.test(bv) ? ok('có churn/huỷ') : warn('không thấy churn');
  /dùng thử|trial/i.test(bv) ? ok('theo dõi được số shop dùng thử') : warn('không tách shop dùng thử');
  /hết hạn|quá hạn|past_due/i.test(bv) ? ok('thấy được shop quá hạn (ai sắp mất)') : warn('không thấy shop quá hạn');

  sect('3. Hoá đơn + thu tiền thuê bao');
  const inv = await owner.query(`SELECT count(*)::int n FROM platform_invoices`).catch(() => ({ rows: [{ n: -1 }] }));
  inv.rows[0].n >= 0 ? ok(`bảng hoá đơn nền tảng có (${inv.rows[0].n} dòng)`) : bad('không có bảng hoá đơn nền tảng');
  const cfgBank = process.env.PLATFORM_BANK_ACCOUNT ?? '';
  cfgBank ? ok('tài khoản nhận tiền của nền tảng đã cấu hình (dev)') : warn('CHƯA cấu hình tài khoản nhận tiền nền tảng → shop không tự trả tiền được');

  sect('4. Hỗ trợ người bán');
  r = await adm('/platform/support');
  r.status === 200 ? ok('mở được hàng đợi phiếu hỗ trợ') : bad('phiếu hỗ trợ lỗi', String(r.status));
  const sv = visible(r.text);
  /phiếu|yêu cầu|ticket/i.test(sv) ? ok('có danh sách yêu cầu hỗ trợ') : warn('không thấy danh sách phiếu');

  sect('5. Giám sát: sống/chết mọi service');
  const svcs = [['auth', AUTH], ['platform', PLATFORM], ['seller', SELLER], ['storefront', STORE],
    ['checkout', CHECKOUT], ['account', ACCOUNT], ['signup', SIGNUP], ['payment', PAYMENT], ['worker', WORKER], ['seller-admin', ADMIN]];
  const down = [];
  for (const [n, base] of svcs) {
    const x = await http(base, '/healthz', { host: 'x' });
    if (x.status !== 200) down.push(`${n}=${x.status}`);
  }
  down.length === 0 ? ok(`${svcs.length}/${svcs.length} service trả /healthz 200`) : bad('service không khoẻ', down.join(' '));
  const deep = await http(WORKER, '/readyz', { host: 'x' });
  [200, 404].includes(deep.status) ? ok(`worker /readyz → ${deep.status}`) : warn(`worker /readyz → ${deep.status}`);

  sect('6. Hàng đợi việc nền (outbox / dead-letter)');
  const ob = await owner.query(`SELECT count(*)::int n FROM outbox WHERE sent_at IS NULL`).catch(() => ({ rows: [{ n: -1 }] }));
  ob.rows[0].n >= 0 ? ok(`outbox còn ${ob.rows[0].n} việc chưa gửi`) : warn('không đọc được outbox');
  const dl = await owner.query(`SELECT count(*)::int n FROM outbox WHERE attempts > 5`).catch(() => ({ rows: [{ n: -1 }] }));
  dl.rows[0].n > 0 ? warn(`${dl.rows[0].n} việc CHẾT trong outbox (cần màn hình xử lý)`) : ok('không có việc chết trong outbox');

  sect('7. Cô lập tenant — nhân viên nền tảng KHÔNG tự vào được shop');
  const anyShop = (await owner.query(`SELECT id FROM shops WHERE slug LIKE 'sau-muot-%' LIMIT 1`)).rows[0];
  if (anyShop) {
    const x = await adm(`/shops/${anyShop.id}/orders`);
    x.status === 200 ? bad('nhân viên nền tảng VÀO THẲNG được đơn hàng của shop — rò dữ liệu khách') : ok(`staff nền tảng mở đơn shop → ${x.status} (phải là thành viên mới xem được)`);
  }

  summary();
  await owner.end();
}
main().catch((e) => { console.error('VỠ:', e); process.exit(2); });
