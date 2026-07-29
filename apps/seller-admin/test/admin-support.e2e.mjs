/**
 * E2E kênh HỖ TRỢ (0107). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-support.e2e.mjs
 *
 * Vì sao tính năng này tồn tại: từ khi có self-serve signup, một người mở shop lúc 2 giờ sáng
 * mà không qua concierge nào — gặp trục trặc thì họ KHÔNG có đường nào liên hệ từ trong sản
 * phẩm, chỉ có thể bỏ đi.
 *
 * Kiểm: gửi được · MỌI vai gửi được (kể cả nhân viên bán hàng) · phát outbox cho chủ nền tảng ·
 * cô lập chéo shop · trần phiếu chưa xử · PRG không gửi lặp khi F5.
 */
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest';
const OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${d}${X}`); };
const sect = (m) => console.log(`\n${B}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };

async function rq(base, method, path, { body, cookie, origin } = {}) {
  const h = {};
  if (body !== undefined) h['content-type'] = 'application/json';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, sc: r.headers.getSetCookie(), raw: t };
}
async function adm(method, path, { cookie, origin, form } = {}) {
  const h = {};
  if (form !== undefined) h['content-type'] = 'application/x-www-form-urlencoded';
  if (origin) h.origin = origin;
  if (cookie) h.cookie = `__Host-session=${cookie}`;
  const r = await fetch(ADMIN + path, { method, headers: h, redirect: 'manual', body: form !== undefined ? new URLSearchParams(form).toString() : undefined });
  return { status: r.status, location: r.headers.get('location'), body: await r.text() };
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
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, email, cookie: await login(email, password) };
}
/**
 * Thêm một thành viên vai thấp vào shop, GHI THẲNG memberships.
 * Cố ý KHÔNG đi qua luồng mời của giao diện: mời thành viên ĐÒI step-up (xác thực lại) —
 * đúng thiết kế, nhưng dựng lại cả màn step-up ở đây chỉ để có một tài khoản order_manager
 * là để bộ test hỗ trợ phụ thuộc vào luồng nhân sự, hai thứ chẳng liên quan gì nhau.
 * Luồng mời + step-up đã có bộ test riêng lo.
 */
async function addMember(_ownerCookie, shopId, role) {
  const email = `nv-${uniq()}@shop.vn`, password = 'nhan vien passphrase manh';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  await owner.query(`INSERT INTO memberships (shop_id, user_id, role) VALUES ($1, $2, $3)`,
    [shopId, await uidOf(email), role]);
  return { email, cookie: await login(email, password) };
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `sup-a-${uniq()}`);
  const Bs = await makeShopOwner(staff, `sup-b-${uniq()}`);
  ok('dựng 2 shop + chủ shop');

  // ── 1. Trang trợ giúp ───────────────────────────────────────────────────
  sect('1. Trang Trợ giúp');
  let r = await adm('GET', `/shops/${A.shopId}/help`, { cookie: A.cookie });
  r.status === 200 && /Gửi yêu cầu hỗ trợ/.test(r.body) && /name="subject"/.test(r.body) && /name="body"/.test(r.body)
    ? ok('trang có form gửi yêu cầu') : bad('trang trợ giúp sai', String(r.status));
  /Trợ giúp<\/span>/.test(r.body) || /\/help"/.test(r.body)
    ? ok('có mục Trợ giúp trong menu bên') : bad('thiếu mục sidebar');

  // ── 2. Gửi yêu cầu ──────────────────────────────────────────────────────
  sect('2. Gửi yêu cầu → lưu DB + phát outbox cho chủ nền tảng');
  const subj = `Không tạo được vận đơn ${uniq()}`;
  r = await adm('POST', `/shops/${A.shopId}/help`, { cookie: A.cookie, origin: OADM,
    form: { subject: subj, body: 'Bấm tạo vận đơn GHN thì hiện lỗi 500.', context_url: '/shops/x/orders' } });
  // PRG: phải REDIRECT chứ không render thẳng — F5 sau khi gửi sẽ gửi lại phiếu y hệt.
  r.status === 303 && /sent=1/.test(r.location ?? '')
    ? ok('gửi xong → 303 (PRG: F5 không gửi lặp)') : bad('không PRG', `${r.status} ${r.location}`);

  const t = (await owner.query(`SELECT id, shop_id, subject, status, context_url FROM support_tickets WHERE subject = $1`, [subj])).rows[0];
  t && t.shop_id === A.shopId && t.status === 'open' && t.context_url === '/shops/x/orders'
    ? ok('phiếu lưu DB, gắn đúng shop, trạng thái open, có ngữ cảnh trang')
    : bad('phiếu không lưu đúng', JSON.stringify(t));

  // Outbox CÙNG TRANSACTION với phiếu: không có chuyện báo một phiếu chưa tồn tại, cũng
  // không có phiếu nằm im không ai biết.
  const ob = (await owner.query(
    `SELECT topic, payload FROM outbox WHERE topic = 'support.ticket_created' AND payload->>'ticket_id' = $1`, [t?.id])).rows[0];
  ob && ob.payload.subject === subj
    ? ok('phát outbox support.ticket_created (worker báo Telegram chủ nền tảng)')
    : bad('không phát outbox', JSON.stringify(ob));

  r = await adm('GET', `/shops/${A.shopId}/help?sent=1`, { cookie: A.cookie });
  /Đã gửi yêu cầu/.test(r.body) && r.body.includes(subj)
    ? ok('trang xác nhận đã gửi + phiếu hiện trong lịch sử')
    : bad('không thấy xác nhận/lịch sử');

  // ── 3. MỌI vai gửi được ─────────────────────────────────────────────────
  sect('3. Nhân viên bán hàng (vai thấp nhất) cũng gửi được');
  const nv = await addMember(A.cookie, A.shopId, 'order_manager');
  if (!nv.cookie) { bad('không mời được nhân viên'); } else {
    r = await adm('GET', `/shops/${A.shopId}/help`, { cookie: nv.cookie });
    const okPage = r.status === 200;
    r = await adm('POST', `/shops/${A.shopId}/help`, { cookie: nv.cookie, origin: OADM,
      form: { subject: `NV báo lỗi ${uniq()}`, body: 'Máy in đơn không ra giấy.' } });
    okPage && r.status === 303
      ? ok('order_manager mở được trang VÀ gửi được — bắt phải có quyền cấu hình mới kêu cứu là chặn đúng người đang cần giúp')
      : bad('vai thấp không gửi được', `page=${okPage} post=${r.status}`);
  }

  // ── 4. Cô lập chéo shop ─────────────────────────────────────────────────
  sect('4. Cô lập chéo shop');
  // Phiếu hỗ trợ chứa mô tả sự cố vận hành — rò sang shop khác là rò dữ liệu kinh doanh.
  r = await adm('GET', `/shops/${Bs.shopId}/help`, { cookie: Bs.cookie });
  !r.body.includes(subj)
    ? ok('shop B KHÔNG thấy phiếu của shop A') : bad('rò phiếu chéo shop');
  r = await adm('POST', `/shops/${Bs.shopId}/help`, { cookie: A.cookie, origin: OADM,
    form: { subject: 'chen ngang', body: 'x' } });
  const leaked = (await owner.query(`SELECT count(*)::int n FROM support_tickets WHERE shop_id = $1`, [Bs.shopId])).rows[0].n;
  r.status === 403 && Number(leaked) === 0
    ? ok('chủ shop A gửi vào shop B → 403, shop B không có phiếu lạ')
    : bad('cô lập chéo shop hỏng', `${r.status} n=${leaked}`);

  // ── 5. Chặn dữ liệu rỗng + trần phiếu chưa xử ───────────────────────────
  sect('5. Chặn rỗng + trần phiếu chưa xử lý');
  r = await adm('POST', `/shops/${A.shopId}/help`, { cookie: A.cookie, origin: OADM, form: { subject: '', body: '' } });
  r.status === 400 && /thiếu/.test(r.body)
    ? ok('tiêu đề/nội dung trống → 400 kèm lý do') : bad('gửi rỗng lọt qua', String(r.status));

  // Trần theo SỐ PHIẾU CHƯA XỬ (không phải rate-limit thời gian): người đang gặp sự cố thật
  // có thể gửi vài phiếu liên tiếp — thứ cần giới hạn là hàng đợi của chủ nền tảng.
  await owner.query(
    `INSERT INTO support_tickets (shop_id, subject, body)
     SELECT $1, 'spam ' || g, 'x' FROM generate_series(1, 20) g`, [A.shopId]);
  r = await adm('POST', `/shops/${A.shopId}/help`, { cookie: A.cookie, origin: OADM,
    form: { subject: 'quá trần', body: 'x' } });
  r.status === 400 && /chưa được xử lý/.test(r.body)
    ? ok('vượt 20 phiếu chưa xử → chặn kèm lý do rõ (không chặn im lặng)')
    : bad('trần phiếu không chặn', String(r.status));

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
