/**
 * E2E hàng đợi PHIẾU HỖ TRỢ trong console nền tảng (0108). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/platform-support.e2e.mjs
 *
 * 0107 mới có chiều ĐI (người bán gửi → Telegram). Đây là chiều VỀ: hàng đợi thật, xử lý,
 * và lời giải thích quay lại tới người bán.
 *
 * Kiểm: xuyên shop · người ngoài không vào được · FIFO (chờ lâu nhất trước) · cờ quá hạn ·
 * xử lý → outbox báo người bán · KHÔNG nhân đôi thông báo khi bấm hai lần · mở lại · ghi chú
 * hiện đúng bên người bán · operator (không phải admin) vẫn xử lý được.
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
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email]); return new URL(rows[0].u).searchParams.get('token'); };

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
  const userId = await uidOf(email);
  await owner.query(`INSERT INTO platform_staff (user_id,role) VALUES ($1,'admin')`, [userId]);
  while (counterFor(Date.now()) <= c) await sleep(1000);
  cookie = await login(email, password);
  return { userId, cookie: ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).sc) ?? cookie };
}
async function makeShopOwner(staffCookie, slug) {
  const r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, email, cookie: await login(email, password) };
}
// Gửi một phiếu qua ĐÚNG giao diện người bán (không INSERT tay): phiếu phải mang from_email
// do chính seller chép vào, và test này muốn chứng minh cả đoạn đó.
async function fileTicket(shop, subject, body = 'Mô tả sự cố.') {
  await adm('POST', `/shops/${shop.shopId}/help`, { cookie: shop.cookie, origin: OADM, form: { subject, body, context_url: '/shops/x/orders' } });
  const { rows } = await owner.query(`SELECT id, from_email FROM support_tickets WHERE subject=$1`, [subject]);
  return rows[0];
}
const outboxCount = async (ticketId) => Number((await owner.query(
  `SELECT count(*)::int n FROM outbox WHERE topic='support.ticket_resolved' AND payload->>'ticket_id'=$1`, [ticketId])).rows[0].n);

async function main() {
  // Dọn hàng đợi TRƯỚC khi đo. Hàng đợi xếp CŨ-TRƯỚC và mỗi trang 20 phiếu, nên phiếu tồn
  // từ các lần chạy trước (bộ 0107 để lại ~24 phiếu mở mỗi lần, riêng bài "trần phiếu" tạo 20)
  // sẽ chiếm sạch trang 1 và đẩy phiếu của bài này sang trang 4 — khẳng định về THỨ TỰ hoá ra
  // đang đo bãi rác của lần chạy trước. Đây là dọn dữ liệu test, KHÔNG che lỗi sản phẩm:
  // xếp cũ-trước là hành vi đúng, và nó vẫn được đo ngay dưới đây trên hai phiếu ta tự tạo.
  await owner.query(`UPDATE support_tickets SET status='resolved', resolved_at=now() WHERE status='open'`);

  const staff = await makeStaff();
  const A = await makeShopOwner(staff.cookie, `psup-a-${uniq()}`);
  const Bs = await makeShopOwner(staff.cookie, `psup-b-${uniq()}`);
  ok('dựng nhân viên nền tảng + 2 shop');

  // ── 1. Hàng đợi XUYÊN SHOP ────────────────────────────────────────
  sect('1. Hàng đợi xuyên shop');
  const sOld = `Cũ-${uniq()} không tạo được vận đơn`;
  const sNew = `Mới-${uniq()} không đổi được logo`;
  const tOld = await fileTicket(A, sOld);
  await sleep(1100); // tách created_at để khẳng định THỨ TỰ, không phải may rủi
  const tNew = await fileTicket(Bs, sNew);

  let r = await adm('GET', '/platform/support', { cookie: staff.cookie });
  r.status === 200 && r.body.includes(sOld) && r.body.includes(sNew)
    ? ok('console thấy phiếu của CẢ HAI shop') : bad('không thấy phiếu xuyên shop', String(r.status));
  // Bối cảnh phải HIỆN RA, không chỉ nằm trong DB: dữ liệu đúng mà không ai thấy thì không
  // rút ngắn được vòng hỏi-đáp nào — mà rút ngắn nó mới là lý do 0109 tồn tại.
  /Vai: <strong>chủ shop<\/strong>/.test(r.body)
    ? ok('hàng đợi hiện VAI người gửi (dịch sang tiếng Việt, không đổ JSON)')
    : bad('console không hiện bối cảnh chẩn đoán');
  r.body.indexOf(sOld) < r.body.indexOf(sNew)
    ? ok('FIFO: phiếu chờ lâu nhất đứng trước') : bad('sai thứ tự hàng đợi (mới-trước bỏ đói người chờ lâu)');
  tOld.from_email === A.email
    ? ok('phiếu chép sẵn email người gửi (console không cần đọc bảng users)') : bad('thiếu from_email', String(tOld.from_email));
  /Trang:/.test(r.body) && r.body.includes('/shops/x/orders')
    ? ok('hiện trang người bán đang đứng lúc gửi') : bad('mất context_url');

  // ── 1b. Bối cảnh chẩn đoán (0109) ───────────────────────────────
  sect('1b. Phiếu tự mang bối cảnh chẩn đoán');
  const dg = (await owner.query(`SELECT diag FROM support_tickets WHERE id=$1`, [tOld.id])).rows[0].diag;
  dg && dg.role === 'owner' && dg.shop_status
    ? ok(`ghi vai + trạng thái shop (role=${dg.role}, shop=${dg.shop_status})`) : bad('thiếu diag', JSON.stringify(dg));
  // Vai phải do SELLER tự suy ra từ membership. Nếu nó tin body thì BFF (hoặc bất kỳ ai gọi
  // được API) khai vai nào cũng được — và phiếu sẽ nói sai đúng cái quyết định "vì sao anh
  // không thấy nút". Gửi kèm role giả rồi soi lại DB.
  const sFake = `Vai-giả-${uniq()}`;
  await adm('POST', `/shops/${A.shopId}/help`, { cookie: A.cookie, origin: OADM,
    form: { subject: sFake, body: 'thử khai vai giả', role: 'owner_gia', diag: '{"role":"root"}' } });
  const dgF = (await owner.query(`SELECT diag FROM support_tickets WHERE subject=$1`, [sFake])).rows[0]?.diag;
  dgF && dgF.role === 'owner'
    ? ok('vai lấy từ membership, KHÔNG nhận từ body (khai giả không ăn thua)')
    : bad('vai bị body chi phối', JSON.stringify(dgF));

  // ── 2. Người ngoài ──────────────────────────────────────────────
  sect('2. Người ngoài không vào được hàng đợi');
  r = await adm('GET', '/platform/support', { cookie: A.cookie });
  const denied = /chỉ dành cho/.test(r.body) && !r.body.includes(sNew);
  denied ? ok('chủ shop → trang từ chối, KHÔNG lộ phiếu shop khác') : bad('rò hàng đợi cho người ngoài', String(r.status));
  r = await adm('GET', '/platform/support', {});
  !r.body.includes(sNew) ? ok('không đăng nhập → không thấy phiếu') : bad('lộ phiếu khi chưa đăng nhập');

  // ── 3. Cờ quá hạn ───────────────────────────────────────────────
  sect('3. Cờ quá hạn 24h');
  await owner.query(`UPDATE support_tickets SET created_at = now() - interval '30 hours' WHERE id=$1`, [tOld.id]);
  r = await adm('GET', '/platform/support', { cookie: staff.cookie });
  /Quá hạn 24h/.test(r.body) ? ok('phiếu chờ >24h bị gắn cờ quá hạn') : bad('không gắn cờ quá hạn');
  /ngày trước/.test(r.body) ? ok('hiện thời gian chờ tương đối') : bad('thiếu tuổi phiếu');

  // ── 4. Xử lý + đóng vòng phản hồi ───────────────────────────────
  sect('4. Đánh dấu đã xử lý → báo người bán');
  const note = `Đã bật lại kết nối GHN ${uniq()}`;
  r = await adm('POST', `/platform/support/${tOld.id}/resolve`, { cookie: staff.cookie, origin: OADM, form: { status: 'open', note } });
  r.status === 303 && /status=resolved/.test(r.location ?? '')
    ? ok('xử xong → 303 về tab Đã xử lý (PRG)') : bad('không PRG', `${r.status} ${r.location}`);
  let row = (await owner.query(`SELECT status, resolution_note, resolved_by, resolved_at FROM support_tickets WHERE id=$1`, [tOld.id])).rows[0];
  row.status === 'resolved' && row.resolution_note === note && row.resolved_by === staff.userId && row.resolved_at
    ? ok('phiếu đóng, ghi ai xử + xử ra sao') : bad('trạng thái phiếu sai', JSON.stringify(row));
  const ob = (await owner.query(`SELECT payload FROM outbox WHERE topic='support.ticket_resolved' AND payload->>'ticket_id'=$1`, [tOld.id])).rows[0];
  ob?.payload?.to === A.email && ob.payload.note === note
    ? ok('outbox báo ĐÚNG người gửi kèm lời giải thích') : bad('outbox sai người nhận', JSON.stringify(ob?.payload));

  // ── 5. Bấm hai lần KHÔNG nhân đôi thông báo ─────────────────────
  sect('5. Idempotent (F5 / hai nhân viên cùng bấm)');
  r = await adm('POST', `/platform/support/${tOld.id}/resolve`, { cookie: staff.cookie, origin: OADM, form: { status: 'resolved', note: 'ghi đè' } });
  r.status === 303 && /already=1/.test(r.location ?? '')
    ? ok('lần hai vẫn 303 (không ném lỗi vào mặt người bấm)') : bad('lần hai không idempotent', `${r.status} ${r.location}`);
  await outboxCount(tOld.id) === 1
    ? ok('CHỈ MỘT thông báo — người bán không nhận hai email cùng một phiếu') : bad('nhân đôi thông báo');
  (await owner.query(`SELECT resolution_note n FROM support_tickets WHERE id=$1`, [tOld.id])).rows[0].n === note
    ? ok('lần hai không ghi đè ghi chú đã có') : bad('ghi chú bị ghi đè');

  // ── 6. Người bán thấy lời giải thích ────────────────────────────
  sect('6. Vòng phản hồi khép lại phía người bán');
  r = await adm('GET', `/shops/${A.shopId}/help`, { cookie: A.cookie });
  r.body.includes(note) && /Đã xử lý/.test(r.body)
    ? ok('người bán đọc được ghi chú xử lý trên trang Trợ giúp') : bad('người bán không thấy ghi chú');

  // ── 7. Mở lại ───────────────────────────────────────────────────
  sect('7. Mở lại phiếu đóng nhầm');
  r = await adm('POST', `/platform/support/${tOld.id}/reopen`, { cookie: staff.cookie, origin: OADM, form: { status: 'resolved' } });
  row = (await owner.query(`SELECT status, resolution_note, resolved_at FROM support_tickets WHERE id=$1`, [tOld.id])).rows[0];
  r.status === 303 && row.status === 'open' && row.resolution_note === null && row.resolved_at === null
    ? ok('mở lại → về hàng đợi, xoá lời giải thích không còn đúng') : bad('mở lại sai', JSON.stringify(row));
  await outboxCount(tOld.id) === 1
    ? ok('mở lại KHÔNG bắn thêm thông báo (không có gì mới để nói)') : bad('mở lại gửi thông báo thừa');

  // ── 8. Vai operator ─────────────────────────────────────────────
  sect('8. Operator cũng xử lý được phiếu');
  await owner.query(`UPDATE platform_staff SET role='operator' WHERE user_id=$1`, [staff.userId]);
  r = await adm('POST', `/platform/support/${tNew.id}/resolve`, { cookie: staff.cookie, origin: OADM, form: { status: 'open', note: 'xong' } });
  const opDone = (await owner.query(`SELECT status FROM support_tickets WHERE id=$1`, [tNew.id])).rows[0].status;
  r.status === 303 && opDone === 'resolved'
    ? ok('operator xử được (trả lời hỗ trợ chính là việc của họ)') : bad('operator bị chặn', `${r.status} ${opDone}`);
  r = await adm('POST', `/platform/shops/${A.shopId}/suspend`, { cookie: staff.cookie, origin: OADM, form: {} });
  !/Đã tạm khoá/.test(r.body) ? ok('nhưng operator vẫn KHÔNG khoá được shop (gate admin còn nguyên)') : bad('operator khoá được shop');
  await owner.query(`UPDATE platform_staff SET role='admin' WHERE user_id=$1`, [staff.userId]);

  // ── 9. Tab + đếm + tổng quan ────────────────────────────────────
  sect('9. Tab, số đếm, tổng quan');
  r = await adm('GET', '/platform/support?status=resolved', { cookie: staff.cookie });
  r.status === 200 && r.body.includes(note.slice(0, 12)) === false && r.body.includes(sNew)
    ? ok('tab Đã xử lý chỉ chứa phiếu đã đóng') : bad('tab đã-xử-lý sai nội dung');
  /Mở lại phiếu/.test(r.body) ? ok('tab đã xử lý có nút mở lại') : bad('thiếu nút mở lại');
  r = await adm('GET', '/platform', { cookie: staff.cookie });
  /Phiếu hỗ trợ chờ/.test(r.body) && /Phiếu hỗ trợ<\/a>|Phiếu hỗ trợ \(/.test(r.body)
    ? ok('console có ô "Phiếu hỗ trợ chờ" + đường vào hàng đợi') : bad('console thiếu lối vào hàng đợi');

  // ── 10. Tham số trang rác không làm sập console ─────────────────
  sect('10. ?page rác');
  // OFFSET nội suy thẳng vào SQL: `?page=9…9` (20 chữ số) cho 1e20 → OFFSET vượt bigint →
  // Postgres 'bigint out of range' → 500. Kẹp trần ở CẢ hàng đợi phiếu lẫn danh sách shop.
  for (const [path, label] of [['/platform/support?page=', 'hàng đợi phiếu'], ['/platform?page=', 'danh sách shop']]) {
    r = await adm('GET', `${path}99999999999999999999`, { cookie: staff.cookie });
    r.status === 200 ? ok(`${label}: ?page khổng lồ → 200, không 500`) : bad(`${label} sập vì ?page rác`, String(r.status));
  }
  r = await adm('GET', '/platform/support?page=abc', { cookie: staff.cookie });
  r.status === 200 ? ok('?page không phải số → 200') : bad('?page rác làm sập', String(r.status));

  // ── 11. CSRF ────────────────────────────────────────────────────
  sect('10. CSRF');
  r = await adm('POST', `/platform/support/${tOld.id}/resolve`, { cookie: staff.cookie, form: { status: 'open' } });
  const stillOpen = (await owner.query(`SELECT status FROM support_tickets WHERE id=$1`, [tOld.id])).rows[0].status;
  stillOpen === 'open' ? ok('POST thiếu Origin → không đổi được phiếu') : bad('CSRF: đổi được phiếu không cần Origin');

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
