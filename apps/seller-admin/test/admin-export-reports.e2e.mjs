/**
 * E2E nhóm "rẻ" — XUẤT CSV ĐƠN HÀNG + BÁO CÁO chọn nhanh kỳ/so sánh. Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-export-reports.e2e.mjs
 *
 * Kiểm:
 *   1. Xuất CSV đơn — perm 'export' (order_manager KHÔNG được), step-up bắt buộc, BOM UTF-8,
 *      SĐT giữ số 0 đầu, KHÔNG rò bí mật (lookup_token_hash / ip hash), theo ĐÚNG bộ lọc.
 *   2. Báo cáo — preset kỳ, so sánh kỳ trước (tháng so tháng), compare=off, và tham số rác
 *      KHÔNG được làm 500 (lỗ prototype của ?sort=constructor).
 */
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const ADMIN = process.env.ADMIN_URL ?? 'http://seller-admin:3001';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const OADM = process.env.ADMIN_ORIGIN ?? 'https://admin.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${String(d).slice(0, 220)}${X}`); };
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
  const bytes = Buffer.from(await r.arrayBuffer());   // BYTES THÔ: Response.text() tự lột BOM
  return { status: r.status, location: r.headers.get('location'), ctype: r.headers.get('content-type'), cdisp: r.headers.get('content-disposition'), bytes, body: bytes.toString('utf8') };
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
  cookie = ck((await rq(AUTH, 'POST', '/auth/mfa/verify', { cookie, body: { code: totp(key, {}) }, origin: OA })).sc) ?? cookie;
  return cookie;
}
async function makeShopOwner(staffCookie, slug) {
  const r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, slug, email, password, cookie: await login(email, password) };
}
async function addMember(staffCookie, shopId, role) {
  const email = `m-${uniq()}@shop.vn`, password = 'member passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { email, password, cookie: await login(email, password) };
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `exp-${uniq()}`);
  // Đơn tay: SĐT có số 0 ĐẦU (điểm dễ hỏng nhất khi mở CSV bằng Excel).
  const pr = await rq(SELLER, 'POST', `/shops/${A.shopId}/products`, {
    body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: 250000, status: 'active', variants: [{ sku: `S-${uniq()}`, price_vnd: 250000 }] },
    cookie: A.cookie, origin: OS });
  const det = await rq(SELLER, 'GET', `/shops/${A.shopId}/products/${pr.json.id}`, { cookie: A.cookie });
  const vid = det.json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${A.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: 10, reason: 'nhập' }, cookie: A.cookie, origin: OS });
  const mk = await rq(SELLER, 'POST', `/shops/${A.shopId}/orders`, {
    body: { customer: { name: 'Nguyễn Văn A', phone: '0912345678' }, address: { line: 'HN' }, payment_method: 'cod', lines: [{ variant_id: vid, qty: 2 }], idempotency_key: `exp-${uniq()}` },
    cookie: A.cookie, origin: OS });
  mk.status === 200 || mk.status === 201 ? ok('dựng shop + SP + 1 đơn tay (SĐT 0912345678)') : bad('không tạo được đơn', `${mk.status} ${mk.raw?.slice(0, 150)}`);

  // ── 1. Phân quyền xuất ─────────────────────────────────────────────────────
  sect('1. Xuất CSV đơn: chỉ chủ shop, và phải xác nhận mật khẩu');
  const om = await addMember(staff, A.shopId, 'order_manager');
  let r = await rq(SELLER, 'GET', `/shops/${A.shopId}/orders/export`, { cookie: om.cookie });
  r.status === 403 ? ok('order_manager → 403 (không được hút SĐT khách hàng loạt)') : bad('perm quá lỏng', `${r.status}`);

  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/orders/export`, { cookie: A.cookie });
  r.status === 401 || r.status === 403 ? ok(`owner chưa step-up → ${r.status} (bắt xác nhận lại mật khẩu)`) : bad('thiếu step-up!', String(r.status));

  let a = await adm('POST', `/shops/${A.shopId}/orders/export`, { cookie: A.cookie, origin: OADM, form: { status: '', q: '', from: '', to: '' } });
  a.status === 200 && /Xác nhận mật khẩu/.test(a.body) ? ok('BFF hiện màn xác nhận mật khẩu') : bad('không có interstitial', `${a.status}`);
  /số điện thoại và địa chỉ khách/.test(a.body) ? ok('giải thích rõ vì sao phải xác nhận (có PII)') : bad('thiếu giải thích PII');

  a = await adm('POST', `/shops/${A.shopId}/orders/export/step-up`, {
    cookie: A.cookie, origin: OADM, form: { status: '', q: '', from: '', to: '', password: 'sai mat khau' } });
  a.status === 401 ? ok('mật khẩu sai → 401, không tải file') : bad('mật khẩu sai vẫn qua', String(a.status));

  sect('2. Xuất thành công: BOM · SĐT giữ số 0 · không rò bí mật');
  a = await adm('POST', `/shops/${A.shopId}/orders/export/step-up`, {
    cookie: A.cookie, origin: OADM, form: { status: '', q: '', from: '', to: '', password: A.password } });
  a.status === 200 && /text\/csv/.test(a.ctype ?? '') ? ok('mật khẩu đúng → tải được CSV') : bad('không tải được', `${a.status} ${a.ctype} ${a.body.slice(0, 150)}`);
  /attachment; filename="don-hang/.test(a.cdisp ?? '') ? ok('header tải về + tên file ASCII') : bad('content-disposition sai', a.cdisp);
  a.bytes[0] === 0xEF && a.bytes[1] === 0xBB && a.bytes[2] === 0xBF ? ok('có BOM UTF-8 (Excel đọc đúng tiếng Việt)') : bad('thiếu BOM', a.bytes.slice(0, 6).toString('hex'));
  /Nguyễn Văn A/.test(a.body) ? ok('tên khách có dấu ghi đúng') : bad('tên khách sai');
  // Trong CSV thô, ô ="0912345678" được bọc theo RFC 4180 → nháy nhân đôi: "=""0912345678"""
  /"=""0912345678"""/.test(a.body) ? ok('SĐT xuất dạng văn bản → Excel KHÔNG nuốt số 0 đầu') : bad('SĐT mất số 0', a.body.split('\r\n')[1]?.slice(0, 160));
  !/lookup_token|client_ip|token_hash/i.test(a.body) ? ok('KHÔNG rò mã tra cứu / hash IP của khách') : bad('RÒ BÍ MẬT trong CSV!');
  /order_number,created_at,status/.test(a.body) ? ok('dòng tiêu đề đúng thứ tự cột') : bad('header CSV sai', a.body.slice(3, 90));

  sect('3. Xuất theo ĐÚNG bộ lọc đang xem');
  a = await adm('POST', `/shops/${A.shopId}/orders/export/step-up`, {
    cookie: A.cookie, origin: OADM, form: { status: 'delivered', q: '', from: '', to: '', password: A.password } });
  const lines = a.body.split('\r\n').filter(Boolean);
  a.status === 200 && lines.length === 1 ? ok('lọc "Đã giao" (chưa có đơn nào) → chỉ có dòng tiêu đề') : bad('bộ lọc không áp vào CSV', `${lines.length} dòng`);
  /don-hang-delivered/.test(a.cdisp ?? '') ? ok('tên file phản ánh bộ lọc') : bad('tên file không mang bộ lọc', a.cdisp);

  sect('4. Nút xuất chỉ hiện với chủ shop');
  a = await adm('GET', `/shops/${A.shopId}/orders`, { cookie: A.cookie });
  /Xuất CSV/.test(a.body) ? ok('chủ shop thấy nút Xuất CSV') : bad('thiếu nút xuất');
  a = await adm('GET', `/shops/${A.shopId}/orders`, { cookie: om.cookie });
  !/Xuất CSV/.test(a.body) ? ok('order_manager KHÔNG thấy nút xuất') : bad('lộ nút xuất cho vai không có quyền');

  // ── 5. Báo cáo: preset + so sánh kỳ trước ──────────────────────────────────
  sect('5. Báo cáo: chọn nhanh kỳ + so sánh kỳ trước');
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/reports/sales?preset=30d`, { cookie: A.cookie });
  const days = r.status === 200 ? Math.round((Date.parse(r.json.range.to) - Date.parse(r.json.range.from)) / 86400e3) + 1 : 0;
  days === 30 ? ok('preset=30d → đúng 30 ngày') : bad('preset 30d sai', `${days} ngày`);
  r.json?.previous?.totals ? ok('mặc định KÈM số liệu kỳ trước để so sánh') : bad('thiếu previous');
  const p = r.json?.previous?.range;
  p && p.to === new Date(Date.parse(r.json.range.from) - 86400e3).toISOString().slice(0, 10)
    ? ok('kỳ trước kết thúc ĐÚNG ngày liền trước kỳ này') : bad('kỳ trước lệch', JSON.stringify(p));

  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/reports/sales?preset=last_month`, { cookie: A.cookie });
  const pm = r.json?.previous?.range;
  // Tháng trước-của-tháng-trước phải là THÁNG dương lịch đủ, không phải "N ngày trước".
  pm && pm.from.endsWith('-01') && pm.from.slice(0, 7) !== r.json.range.from.slice(0, 7)
    ? ok('kỳ THÁNG so với THÁNG dương lịch liền trước (không phải N ngày)') : bad('so sánh tháng sai', JSON.stringify(pm));

  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/reports/sales?preset=30d&compare=off`, { cookie: A.cookie });
  r.json?.previous == null && r.json?.compare === false ? ok('compare=off → bỏ hẳn kỳ trước') : bad('không tắt được so sánh');

  // BẪY: tháng NGẮN so tháng DÀI. Xem TRỌN tháng 2 (28 ngày) phải so TRỌN tháng 1 (31 ngày),
  // không được cắt còn 01–28/01 — cắt là bịa ra tăng trưởng (mất doanh thu 29–31/01).
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/reports/sales?from=2026-02-01&to=2026-02-28`, { cookie: A.cookie });
  let q = r.json?.previous?.range;
  q && q.from === '2026-01-01' && q.to === '2026-01-31'
    ? ok('trọn tháng 2 (28 ngày) so TRỌN tháng 1 (31 ngày) — không cắt cụt') : bad('kỳ trước bị cắt cụt', JSON.stringify(q));
  // Ngược lại: trọn tháng 3 (31 ngày) so trọn tháng 2 (28 ngày) — không được đòi 31/02.
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/reports/sales?from=2026-03-01&to=2026-03-31`, { cookie: A.cookie });
  q = r.json?.previous?.range;
  q && q.from === '2026-02-01' && q.to === '2026-02-28'
    ? ok('trọn tháng 3 so trọn tháng 2 (28 ngày, không đòi 31/02)') : bad('kỳ trước tháng sai', JSON.stringify(q));
  // Khoảng ngày TỰ CHỌN 01–15/03 (không nói "tháng này") = 15 ngày → so 15 ngày liền trước.
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/reports/sales?from=2026-03-01&to=2026-03-15`, { cookie: A.cookie });
  q = r.json?.previous?.range;
  q && q.from === '2026-02-14' && q.to === '2026-02-28'
    ? ok('khoảng tự chọn 01–15/3 so 15 ngày liền trước (14–28/2)') : bad('khoảng tự chọn sai', JSON.stringify(q));
  // Nhưng khi NÓI RÕ "Tháng này" (preset=mtd) thì so cùng số ngày ĐẦU tháng trước — đây mới
  // là ngữ nghĩa "tháng này so tháng trước" mà chủ shop mong đợi.
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/reports/sales?preset=mtd`, { cookie: A.cookie });
  q = r.json?.previous?.range;
  const curFrom = r.json?.range?.from ?? '';
  q && q.from.endsWith('-01') && q.from.slice(0, 7) !== curFrom.slice(0, 7)
    ? ok('preset "Tháng này" so từ mùng 1 tháng trước (ngữ nghĩa tháng, khác khoảng tự chọn)') : bad('preset mtd sai', JSON.stringify(q));
  // BẪY: kỳ BẮT ĐẦU từ mùng 1 nhưng CHƯA hết tháng (nút "7 ngày" bấm vào mùng 7) KHÔNG được
  // coi là kỳ tháng. Phải so 7 ngày LIỀN TRƯỚC (22–28/02), không phải 01–07/02.
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/reports/sales?from=2026-03-01&to=2026-03-07`, { cookie: A.cookie });
  q = r.json?.previous?.range;
  q && q.from === '2026-02-22' && q.to === '2026-02-28'
    ? ok('kỳ 01–07/03 so 7 ngày LIỀN TRƯỚC (không nhảy sang so tháng)') : bad('kỳ ngày bị cướp sang nhánh tháng', JSON.stringify(q));
  // Vượt biên năm: tháng 1 phải lùi về tháng 12 NĂM TRƯỚC.
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/reports/sales?from=2026-01-01&to=2026-01-31`, { cookie: A.cookie });
  q = r.json?.previous?.range;
  q && q.from === '2025-12-01' && q.to === '2025-12-31'
    ? ok('tháng 1 lùi đúng về tháng 12 năm trước') : bad('vượt biên năm sai', JSON.stringify(q));

  sect('6. BẢO VỆ: tham số rác KHÔNG được làm sập trang báo cáo');
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/reports/sales?sort=constructor`, { cookie: A.cookie });
  r.status === 200 ? ok('?sort=constructor → 200 (lỗ prototype đã vá, trước đây 500)') : bad('sort rác làm sập', String(r.status));
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/reports/sales?sort=__proto__`, { cookie: A.cookie });
  r.status === 200 ? ok('?sort=__proto__ → 200') : bad('__proto__ làm sập', String(r.status));
  r = await rq(SELLER, 'GET', `/shops/${A.shopId}/reports/sales?preset=khong-ton-tai`, { cookie: A.cookie });
  r.status === 200 ? ok('preset lạ → bỏ qua, KHÔNG 400 (không làm mất trang Báo cáo)') : bad('preset lạ trả lỗi', String(r.status));

  sect('7. Trang Báo cáo hiện nút chọn nhanh + dòng so sánh');
  a = await adm('GET', `/shops/${A.shopId}/reports`, { cookie: A.cookie });
  /Hôm nay/.test(a.body) && /7 ngày/.test(a.body) && /Tháng trước/.test(a.body) ? ok('có nút chọn nhanh kỳ (gồm "Hôm nay" mới)') : bad('thiếu nút chọn nhanh');
  /So với kỳ trước:/.test(a.body) ? ok('hiện rõ kỳ đang so sánh') : bad('không nói kỳ so sánh là gì');
  /preset=last_month/.test(a.body) ? ok('nút "Tháng trước" mang &preset= để server chọn đúng kỳ so') : bad('nút tháng thiếu preset');
  !/<script(?![^>]*nonce=)/.test(a.body) ? ok('trang Báo cáo: không script NÀO thiếu nonce (ADR-011)') : bad('lọt <script> không nonce');

  // ── Bộ lọc TÌNH TRẠNG THANH TOÁN phải sống sót MỌI đường rời trang ─────────
  // `payment` từng bị đánh rơi ở NĂM nơi: form Lọc, tab trạng thái, phân trang, hidden của
  // nút Xuất CSV, và hàm dựng query của BFF. Mà đường vào mặc định của nó là ô "Đơn chưa thu
  // tiền" trên Tổng quan. Hậu quả không chỉ khó chịu: bản CSV chứa TÊN, SĐT, ĐỊA CHỈ khách —
  // rơi bộ lọc là phát tán PII của mọi đơn thay vì đúng tập người bán định lấy, và với shop
  // lớn còn đâm vào trần 413 nên không xuất được gì.
  sect('4b. Bộ lọc "tình trạng thanh toán" không được rơi khi lọc/đổi tab/sang trang/xuất CSV');
  {
    const M = `/shops/${A.shopId}/orders`;
    let p = await adm('GET', `${M}?payment=unpaid`, { cookie: A.cookie });
    p.status === 200 ? ok('mở trang Đơn hàng với ?payment=unpaid') : bad('không mở được', String(p.status));
    // (1) hidden trong FORM LỌC — bấm "Lọc" không được nuốt điều kiện.
    /<input type="hidden" name="payment" value="unpaid">/.test(p.body)
      ? ok('form Lọc mang theo payment (hidden)') : bad('form Lọc đánh rơi payment');
    // (2) TAB trạng thái + (3) PHÂN TRANG: link phải mang payment.
    /href="\?status=[^"]*payment=unpaid/.test(p.body)
      ? ok('link tab trạng thái mang theo payment') : bad('đổi tab là mất bộ lọc thanh toán');
    // Phân trang: link chỉ render khi có >20 đơn (limit đóng cứng 20 ở BFF), dựng 21 đơn chỉ
    // để kiểm một chuỗi query là không đáng. Bất biến đó được canh ở tầng MÃ NGUỒN thay vì
    // ở đây: apps/seller/test/order-filter-fields.test.js đối chiếu BỐN nơi khai trường lọc
    // với danh sách thật của buildOrderFilter — phủ cả lớp lỗi, không chỉ mỗi `payment`.
    // (5) BFF phải CHUYỂN TIẾP payment xuống seller — đo bằng NỘI DUNG file, không đoán.
    //     Đơn duy nhất của fixture là đơn tay CHƯA thu tiền, nên lọc paid phải ra file RỖNG
    //     (chỉ còn dòng tiêu đề); lọc unpaid phải có đơn đó.
    const xuat = async (payment) => adm('POST', `${M}/export/step-up`, {
      cookie: A.cookie, origin: OADM, form: { status: '', q: '', from: '', to: '', payment, password: A.password } });
    const chuaThu = await xuat('unpaid');
    const daThu = await xuat('paid');
    const dem = (r) => r.body.split('\r\n').filter(Boolean).length - 1;   // trừ dòng tiêu đề
    chuaThu.status === 200 && dem(chuaThu) >= 1
      ? ok(`lọc "chưa thu tiền" → ${dem(chuaThu)} đơn trong CSV`) : bad('lọc unpaid không ra đơn nào', `${chuaThu.status}`);
    daThu.status === 200 && dem(daThu) === 0
      ? ok('lọc "đã thu tiền" → CSV rỗng (bộ lọc ĐI TỚI được seller, không bị nuốt)')
      : bad('BFF nuốt payment: xuất ra cả đơn ngoài bộ lọc (rò SĐT/địa chỉ)', `${daThu.status} ${dem(daThu)} dòng`);
    !daThu.body.includes('0912345678')
      ? ok('CSV "đã thu tiền" KHÔNG chứa SĐT của đơn chưa thu') : bad('SĐT khách lọt ra ngoài phạm vi lọc');
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error('admin export/reports e2e lỗi:', e); await owner.end(); process.exit(1); });
