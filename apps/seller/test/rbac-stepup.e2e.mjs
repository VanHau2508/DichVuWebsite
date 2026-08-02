// E2E: BẤT BIẾN STEP-UP CHO MỌI BÚT TOÁN KHÔNG HOÀN TÁC ĐƯỢC.
//
// Vì sao cần bộ riêng: việc cưỡng chế nằm ở cờ `stepUp: true` trên TỪNG route, còn
// rbac.js/STEP_UP_PERMS chỉ là TÀI LIỆU (server.js không hề gọi needsStepUp). Hai bên đã
// từng lệch nhau mà không ai thấy: 'affiliate.manage' được khai trong STEP_UP_PERMS nhưng
// 0/7 route CTV bật cờ — kể cả chốt phiếu CHI TIỀN. 'payment.write' thiếu đúng một route
// (ghi phiếu đối soát COD, đóng vĩnh viễn tới 500 đơn).
//
// Bộ này đi từ NGOÀI VÀO qua HTTP thật: đăng nhập chủ shop, gọi route KHÔNG step-up trước,
// khẳng định 403 + step_up_required; rồi step-up và khẳng định KHÔNG còn 403. Kiểm được cái
// mà đọc mã không kiểm được: cờ có thật sự nối vào tầng dispatch hay không.
//
// THÊM ROUTE SINH TIỀN-RA MỚI thì thêm vào MONEY_OUT_ROUTES bên dưới.
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = 'http://auth:3020', PLATFORM = 'http://platform:3030', SELLER = 'http://seller:3040';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  PASS ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? ' :: ' + String(d).slice(0, 180) : '')); };
const sect = (m) => console.log('\n# ' + m);
const uniq = () => Math.random().toString(36).slice(2, 10);
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };
async function rq(base, method, path, { body, cookie, origin } = {}) {
  const h = {}; if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin; if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
const login = async (e, p) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email: e, password: p }, origin: OA })).sc);
const inviteTokenOf = async (email) => {
  const { rows } = await owner.query(
    `SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email]);
  return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null;
};

// Mỗi mục: [tên việc, method, path (sau /shops/:id), body]. Body KHÔNG cần hợp lệ — ta chỉ
// kiểm cổng step-up, và cổng đó chạy TRƯỚC khi handler đụng tới body.
const MONEY_OUT_ROUTES = (aff) => [
  ['ghi phiếu chuyển tiền COD (đóng vĩnh viễn đơn khỏi sổ đối soát)',
    'POST', '/cod/remittances', { amount_vnd: 1000, order_ids: ['00000000-0000-4000-8000-000000000001'] }],
  ['chốt phiếu chi hoa hồng CTV (sổ append-only, không sửa được)',
    'POST', `/affiliates/${aff}/payouts`, { method: 'bank' }],
  ['hoàn tiền đơn hàng',
    'POST', '/orders/00000000-0000-4000-8000-000000000001/refund', {}],
  // Khách định danh bằng SĐT, KHÔNG phải uuid — truyền uuid thì không khớp route nào và
  // nhận 404 "không tìm thấy", trông y hệt "cổng step-up không chạy". Đã dính một lần.
  ['xoá dữ liệu cá nhân khách (không khôi phục được)',
    'POST', '/customers/0919998888/erase', {}],
];

async function main() {
  // ── Dựng chủ shop (nhân viên nền tảng BẮT BUỘC bật MFA mới tạo shop được) ────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const semail = `staff-${uniq()}@nentang.vn`, spw = 'staff strong passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email: semail, password: spw }, origin: OA });
  let sc = await login(semail, spw);
  const en = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie: sc, origin: OA });
  const key = base32Decode(en.json.secret);
  await rq(AUTH, 'POST', '/auth/mfa/activate', { cookie: sc, body: { code: totp(key, {}) }, origin: OA });
  const suid = (await owner.query('SELECT id FROM users WHERE email=$1', [semail])).rows[0].id;
  await owner.query(`INSERT INTO platform_staff (user_id, role) VALUES ($1,'admin')`, [suid]);
  const c0 = counterFor(Date.now());
  while (counterFor(Date.now()) <= c0) await sleep(1000);   // TOTP không dùng lại cùng bước
  sc = await login(semail, spw);
  const staff = ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie: sc, body: { code: totp(key, {}) }, origin: OA })).sc) ?? sc;
  const shop = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: `su-${uniq()}`, slug: `su-${uniq()}`, plan_code: 'platform' }, cookie: staff, origin: OO });
  const shopId = shop.json?.id;
  if (!shopId) { bad('không tạo được shop', shop.raw); return done(); }
  const oe = `own-${uniq()}@shop.vn`, op = 'owner strong passphrase';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  const oc = await login(oe, op);
  oc ? ok('dựng được chủ shop') : bad('không đăng nhập được chủ shop');

  // Một CTV thật để có id hợp lệ cho route payouts.
  const ra = await rq(SELLER, 'POST', `/shops/${shopId}/affiliates`, { body: { name: `CTV ${uniq()}`, phone: '0917778888' }, cookie: oc, origin: OS });
  const affId = ra.json?.id ?? '00000000-0000-4000-8000-000000000002';

  // ── Chưa step-up → MỌI route tiền-ra phải 403 step_up_required ───────────────
  sect('Chưa xác thực lại: mọi bút toán không-hoàn-tác phải bị chặn');
  const routes = MONEY_OUT_ROUTES(affId);
  for (const [ten, method, path, body] of routes) {
    const r = await rq(SELLER, method, `/shops/${shopId}${path}`, { body, cookie: oc, origin: OS });
    r.status === 403 && r.json?.step_up_required === true
      ? ok(`${ten} → 403 step_up_required`)
      : bad(`KHÔNG ĐÒI XÁC THỰC LẠI: ${ten}`, `http=${r.status} ${JSON.stringify(r.json)?.slice(0, 120)}`);
  }

  // ── Sau step-up → KHÔNG còn 403 vì lý do step-up (lỗi nghiệp vụ thì được) ────
  // Chốt chặn hai đầu: nếu cổng luôn trả 403 bất kể gì thì test trên xanh giả.
  sect('Sau khi xác thực lại: cổng mở, chỉ còn lỗi nghiệp vụ (404/422/...)');
  await rq(AUTH, 'POST', '/auth/step-up', { body: { password: op }, cookie: oc, origin: OA });
  for (const [ten, method, path, body] of routes) {
    const r = await rq(SELLER, method, `/shops/${shopId}${path}`, { body, cookie: oc, origin: OS });
    r.json?.step_up_required !== true
      ? ok(`${ten} → qua cổng (http=${r.status})`)
      : bad(`vẫn đòi step-up sau khi đã xác thực lại: ${ten}`, `http=${r.status}`);
  }

  // ── Cửa sổ step-up là 5 PHÚT, không phải một-lần-một-thao-tác ────────────────
  // Bất biến TRẢI NGHIỆM, không phải bảo mật: nếu ai đó siết thành một-lần-một-thao-tác thì
  // chủ shop phải gõ mật khẩu cho TỪNG phiếu — đối soát một sao kê 50 đơn thành 50 lần gõ.
  sect('Cửa sổ 5 phút: xác thực một lần, cả loạt thao tác sau đó đi thẳng');
  const r2 = await rq(SELLER, 'POST', `/shops/${shopId}/cod/remittances`,
    { body: { amount_vnd: 1000, order_ids: ['00000000-0000-4000-8000-000000000001'] }, cookie: oc, origin: OS });
  r2.json?.step_up_required !== true
    ? ok('thao tác thứ hai trong cùng cửa sổ KHÔNG đòi gõ lại mật khẩu')
    : bad('bắt gõ mật khẩu lại cho từng thao tác — quá phiền cho việc làm theo đợt');

  done();
}
function done() {
  console.log(`\n${pass} pass, ${fail} fail`);
  owner.end().then(() => process.exit(fail === 0 ? 0 : 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
