// E2E Console nền tảng qua BFF (đợt 5.3): search/lọc no-JS, offboard card (chỉ hiện
// form terminate khi suspended), export JSON attachment, terminate typed-confirm
// (sai slug → lỗi, đúng → 303 + DB terminated), và operator ẨN nút ghi (list ẩn
// "Tạo cửa hàng", detail ẩn renew/invite/offboard — gate thật là minRole 403 phía
// platform, đã kiểm ở apps/platform/test/e2e.mjs mục 5f).
// Chạy: docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/platform-console.e2e.mjs
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = 'http://auth:3020', PLATFORM = 'http://platform:3030', ADMIN = 'http://seller-admin:3001';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OAD = 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  PASS ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? ' :: ' + String(d).slice(0, 200) : '')); };
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
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t, headers: r.headers };
}
async function makeStaff(role) {
  const email = `smk-${role}-${uniq()}@nentang.vn`, password = 'smoke strong passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let c = ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
  const r = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie: c, origin: OA });
  const key = base32Decode(r.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie: c, body: { code: totp(key, {}) }, origin: OA });
  const c0 = counterFor(Date.now());
  const uid = (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0].id;
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,$2)`, [uid, role]);
  while (counterFor(Date.now()) <= c0) await sleep(1000);
  c = ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
  c = ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie: c, body: { code: totp(key, {}) }, origin: OA })).sc) ?? c;
  return { cookie: c, password };
}
async function main() {
  const adm = await makeStaff('admin');
  const slug = `smk-${uniq()}`;
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: `Smoke ${slug}`, slug, plan_code: 'platform' }, cookie: adm.cookie, origin: OO });
  const shopId = r.json.id;

  // 1) Trang list: search box + tìm ?q → thấy shop; admin thấy nút tạo.
  r = await rq(ADMIN, 'GET', `/platform?q=${slug}`, { cookie: adm.cookie });
  r.status === 200 && r.raw.includes('name="q"') && r.raw.includes(`Smoke ${slug}`) && r.raw.includes('+ Tạo cửa hàng')
    ? ok('list: search box + ?q khớp + nút tạo (admin)') : bad('list admin sai', `${r.status}`);
  r.raw.includes('sub_status=trial') ? ok('list: chip lọc sub_status render') : bad('thiếu chip lọc');

  // 2) Detail (chưa suspended): offboard card nhắc phải tạm khoá trước, KHÔNG có form terminate.
  r = await rq(ADMIN, 'GET', `/platform/shops/${shopId}`, { cookie: adm.cookie });
  r.raw.includes('Đóng cửa hàng (offboard)') && !r.raw.includes('name="confirm_slug"') && r.raw.includes('tạm khoá')
    ? ok('detail active: offboard card không có form terminate (nhắc khoá trước)') : bad('offboard card active sai', `${r.status}`);

  // 3) Suspend qua BFF (step-up interstitial → mật khẩu).
  await rq(ADMIN, 'POST', `/platform/shops/${shopId}/suspend`, { form: {}, cookie: adm.cookie, origin: OAD });
  r = await rq(ADMIN, 'POST', `/platform/shops/${shopId}/step-up`, { form: { __action: 'suspend', password: adm.password }, cookie: adm.cookie, origin: OAD });
  (await owner.query('SELECT status FROM shops WHERE id=$1', [shopId])).rows[0].status === 'suspended'
    ? ok('suspend qua BFF + step-up') : bad('suspend BFF lỗi', `${r.status}`);

  // 4) Detail (suspended): form terminate hiện.
  r = await rq(ADMIN, 'GET', `/platform/shops/${shopId}`, { cookie: adm.cookie });
  r.raw.includes('name="confirm_slug"') && r.raw.includes('Chấm dứt hợp đồng')
    ? ok('detail suspended: form terminate + confirm_slug hiện') : bad('form terminate không hiện');

  // 5) Export qua BFF: file JSON đính kèm, có tenant_data_note.
  r = await rq(ADMIN, 'GET', `/platform/shops/${shopId}/export`, { cookie: adm.cookie });
  const disp = r.headers.get('content-disposition') ?? '';
  let exp = null; try { exp = JSON.parse(r.raw); } catch {}
  r.status === 200 && disp.includes('attachment') && exp?.shop?.slug === slug && typeof exp?.tenant_data_note === 'string'
    ? ok('export BFF: tải JSON attachment + tenant_data_note') : bad('export BFF lỗi', `${r.status} ${disp}`);

  // 6) Terminate sai slug (trong cửa sổ step-up) → detail hiện lỗi, shop còn suspended.
  r = await rq(ADMIN, 'POST', `/platform/shops/${shopId}/terminate`, { form: { confirm_slug: 'sai-slug' }, cookie: adm.cookie, origin: OAD });
  r.raw.includes('gõ đúng slug') && (await owner.query('SELECT status FROM shops WHERE id=$1', [shopId])).rows[0].status === 'suspended'
    ? ok('terminate sai slug → báo lỗi trên detail, không đóng') : bad('terminate sai slug lọt?', `${r.status}`);

  // 7) Terminate đúng slug → 303 về /platform; DB terminated.
  r = await rq(ADMIN, 'POST', `/platform/shops/${shopId}/terminate`, { form: { confirm_slug: slug }, cookie: adm.cookie, origin: OAD });
  const st = (await owner.query('SELECT status, deleted_at FROM shops WHERE id=$1', [shopId])).rows[0];
  r.status === 303 && st.status === 'terminated' && st.deleted_at
    ? ok('terminate đúng slug → 303 /platform + DB terminated') : bad('terminate BFF lỗi', `${r.status} ${JSON.stringify(st)}`);

  // 8) Operator: list ẩn nút tạo, hiện nhãn chỉ-xem; detail ẩn form ghi.
  const op = await makeStaff('operator');
  r = await rq(ADMIN, 'GET', '/platform', { cookie: op.cookie });
  r.status === 200 && r.raw.includes('operator (chỉ xem)') && !r.raw.includes('+ Tạo cửa hàng')
    ? ok('operator: list ẩn nút tạo + nhãn chỉ-xem') : bad('operator list sai', `${r.status}`);
  const anyShop = (await owner.query(`SELECT id FROM shops WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`)).rows[0].id;
  r = await rq(ADMIN, 'GET', `/platform/shops/${anyShop}`, { cookie: op.cookie });
  r.status === 200 && !r.raw.includes('name="confirm_slug"') && !r.raw.includes(`action="/platform/shops/${anyShop}/renew"`) && !r.raw.includes('Đóng cửa hàng (offboard)')
    ? ok('operator: detail ẩn renew/invite/offboard') : bad('operator detail sai', `${r.status}`);

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
