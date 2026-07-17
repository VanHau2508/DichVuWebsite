// E2E 4.4: staff bấm Tạm khoá trong console → gặp form "Xác nhận mật
// khẩu" (không phải bị từ chối, không thực hiện luôn) → gõ đúng mật khẩu → shop khoá.
// Gõ sai → 401 + form lại. Renew giữ nguyên tham số qua hidden fields.
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = 'http://auth:3020', PLATFORM = 'http://platform:3030', ADMIN = 'http://seller-admin:3001';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OAD = 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  PASS ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? ' :: ' + String(d).slice(0, 120) : '')); };
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };
async function rq(base, method, path, { body, form, cookie, origin } = {}) {
  const h = {};
  if (body !== undefined) h['content-type'] = 'application/json';
  if (form !== undefined) h['content-type'] = 'application/x-www-form-urlencoded';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, redirect: 'manual',
    body: body !== undefined ? JSON.stringify(body) : form !== undefined ? new URLSearchParams(form).toString() : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
async function main() {
  const email = `staff-${uniq()}@nentang.vn`, password = 'staff strong passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let c = ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
  let r = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie: c, origin: OA });
  const key = base32Decode(r.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie: c, body: { code: totp(key, {}) }, origin: OA });
  const c0 = counterFor(Date.now());
  const uid = (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0].id;
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,'admin')`, [uid]);
  while (counterFor(Date.now()) <= c0) await sleep(1000);
  c = ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
  c = ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie: c, body: { code: totp(key, {}) }, origin: OA })).sc) ?? c;
  const slug = `sup-${uniq()}`;
  r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: c, origin: OO });
  const shopId = r.json.id;

  // 1) Chưa step-up: bấm Tạm khoá qua BFF → interstitial, KHÔNG khoá
  r = await rq(ADMIN, 'POST', `/platform/shops/${shopId}/suspend`, { form: {}, cookie: c, origin: OAD });
  r.status === 200 && /Xác nhận mật khẩu/.test(r.raw) && /tạm khoá cửa hàng/.test(r.raw)
    ? ok('chưa step-up → interstitial "Xác nhận mật khẩu" (không khoá luôn)') : bad('không ra interstitial', `${r.status}`);
  let st = (await owner.query('SELECT status FROM shops WHERE id=$1', [shopId])).rows[0].status;
  st !== 'suspended' ? ok('shop CHƯA bị khoá khi chưa xác thực') : bad('khoá dù chưa step-up!');

  // 2) Gõ SAI mật khẩu → 401 + form lại
  r = await rq(ADMIN, 'POST', `/platform/shops/${shopId}/step-up`, { form: { __action: 'suspend', password: 'sai bet nhe' }, cookie: c, origin: OAD });
  r.status === 401 && /Mật khẩu không đúng/.test(r.raw) ? ok('sai mật khẩu → 401 + báo lỗi, form lại') : bad('sai mà lọt?', `${r.status}`);

  // 3) Gõ ĐÚNG → thực hiện suspend, trang chi tiết báo đã khoá
  r = await rq(ADMIN, 'POST', `/platform/shops/${shopId}/step-up`, { form: { __action: 'suspend', password }, cookie: c, origin: OAD });
  st = (await owner.query('SELECT status FROM shops WHERE id=$1', [shopId])).rows[0].status;
  r.status === 200 && st === 'suspended' && /Đã tạm khoá/.test(r.raw)
    ? ok('đúng mật khẩu → suspend chạy + notice "Đã tạm khoá"') : bad('suspend sau step-up lỗi', `${r.status} ${st}`);

  // 4) Trong cửa sổ 5': restore đi thẳng KHÔNG hỏi lại
  r = await rq(ADMIN, 'POST', `/platform/shops/${shopId}/restore`, { form: {}, cookie: c, origin: OAD });
  st = (await owner.query('SELECT status FROM shops WHERE id=$1', [shopId])).rows[0].status;
  r.status === 200 && st === 'active' && !/Xác nhận mật khẩu/.test(r.raw)
    ? ok('trong cửa sổ 5 phút → restore đi thẳng (không hỏi lại)') : bad('restore trong cửa sổ lỗi', `${r.status} ${st}`);

  // 5) Renew giữ tham số qua hidden fields: ép hết hạn step-up rồi thử renew 3 tháng
  await owner.query(`UPDATE sessions SET stepped_up_at = now() - interval '10 minutes' WHERE user_id=$1`, [uid]);
  r = await rq(ADMIN, 'POST', `/platform/shops/${shopId}/renew`, { form: { months: '3', note: 'deal thu cong' }, cookie: c, origin: OAD });
  r.status === 200 && /Xác nhận mật khẩu/.test(r.raw) && /name="months" value="3"/.test(r.raw) && /name="note" value="deal thu cong"/.test(r.raw)
    ? ok('renew hết cửa sổ → interstitial GIỮ months=3 + note (hidden)') : bad('renew interstitial mất tham số', `${r.status}`);
  r = await rq(ADMIN, 'POST', `/platform/shops/${shopId}/step-up`, { form: { __action: 'renew', months: '3', note: 'deal thu cong', password }, cookie: c, origin: OAD });
  const inv = (await owner.query('SELECT months, note FROM platform_invoices WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 1', [shopId])).rows[0];
  r.status === 200 && inv?.months === 3 && inv?.note === 'deal thu cong' && /Đã ghi nhận thu/.test(r.raw)
    ? ok('step-up xong → renew chạy đúng 3 tháng + note vào sổ thu') : bad('renew sau step-up lỗi', `${r.status} ${JSON.stringify(inv)}`);

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
