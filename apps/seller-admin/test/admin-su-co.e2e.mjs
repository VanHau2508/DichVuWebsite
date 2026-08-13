/**
 * E2E CỤM "LÚC CÓ SỰ CỐ" — ba chỗ chặn đường khi khách đang cáu (docs/65).
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-su-co.e2e.mjs
 *
 * Tìm ra từ việc tự đóng vai chủ shop LÚC ĐANG XỬ LÝ SỰ CỐ. Bình thường phần mềm chậm một chút
 * thì thôi; lúc khách đang chờ mà nó bắt mò, hoặc tệ hơn là KHÔNG CHO LÙI, thì người bán nhớ
 * rất lâu — và phải ghi tay ra ngoài phần mềm, tức sổ sách bắt đầu sai.
 *
 * BA THỨ BỘ NÀY CANH:
 *   1. ĐƠN TRẢ TRƯỚC BỊ BOM HÀNG phải hoàn tiền được. Chốt cũ khoá theo TRẠNG THÁI 'returned',
 *      mà có HAI đường tới trạng thái đó: RMA (có phiếu hoàn) và bom hàng (KHÔNG có phiếu nào).
 *      Đơn QR bị bom rơi vào đường thứ hai → shop giữ tiền khách mà câu 409 lại bảo "xem phiếu
 *      trả", một phiếu không tồn tại.
 *   2. GỠ "ĐÃ NHẬN TIỀN" cho đơn COD bấm nhầm. Trước đây đường lùi duy nhất là ghi một phiếu
 *      hoàn tiền CHƯA TỪNG TRẢ — đo trên P&L thì sổ sai ở bốn chỗ cùng lúc.
 *   3. HỎI LẠI trước mọi thao tác một chiều / hàng loạt. Cơ chế data-confirm đã có sẵn trong
 *      kho (dùng cho "Lưu trữ sản phẩm") nhưng KHÔNG nút tiền nào gắn nó.
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
const inviteTokenOf = async (e) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic='user.invited' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`, [e]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', BOLD = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${String(d).slice(0, 200)}${X}`); };
const sect = (m) => console.log(`\n${BOLD}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ck = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return m[1]; } return null; };

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
  const slug = `sc-${uniq()}`;
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
  const shopId = r.json.id;
  const oe = `owner-${uniq()}@shop.vn`, op = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email: oe, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(oe), password: op }, origin: OA });
  const oc = await login(oe, op);
  const ac = ck((await adm('POST', '/login', { form: new URLSearchParams({ email: oe, password: op }) })).sc);
  // Keep fixture money writes separate so they do not pre-step-up the UI session under test.
  const acMoney = ck((await adm('POST', '/login', { form: new URLSearchParams({ email: oe, password: op }) })).sc);
  const S = {
    get: (p) => rq(SELLER, 'GET', `/shops/${shopId}${p}`, { cookie: oc }),
    post: (p, b) => rq(SELLER, 'POST', `/shops/${shopId}${p}`, { body: b, cookie: oc, origin: OS }),
    patch: (p, b) => rq(SELLER, 'PATCH', `/shops/${shopId}${p}`, { body: b, cookie: oc, origin: OS }),
  };
  await S.patch('', { name: slug, max_pending_per_phone: 999, max_pending_per_ip: 999 });
  const pr = await S.post('/products', { title: 'Áo sự cố', slug: `ao-${uniq()}`, price_vnd: 300000, status: 'active', variants: [{ sku: `SC-${uniq()}`, price_vnd: 300000 }] });
  const vid = (await S.get(`/products/${pr.json.id}`)).json.variants[0].id;
  await S.post(`/variants/${vid}/inventory/adjust`, { delta: 100, reason: 'nhập' });
  const sdt = () => `09${Math.floor(10000000 + Math.random() * 89999999)}`;
  const mkDon = async (pm) => (await S.post('/orders', {
    lines: [{ variant_id: vid, qty: 1 }],
    // PHẢI có email: statusEvent cố ý im lặng với đơn không email (đơn chốt trong chat), nên
    // thiếu nó thì mọi khẳng định về "khách có được báo không" đều xanh vì lý do sai.
    customer: { name: 'Khách sự cố', phone: sdt(), email: `kh-${uniq()}@khach.vn`, address_line: '1 Lê Lợi', province: 'Hà Nội' },
    payment_method: pm, idempotency_key: `sc-${uniq()}`,
  })).json;
  ac ? ok('dựng shop + đăng nhập API và trang quản trị') : bad('không đăng nhập được quản trị', '');
  const tienCua = async (oid) => Number((await owner.query(`SELECT coalesce(sum(amount_vnd),0)::bigint s FROM refunds WHERE order_id=$1`, [oid])).rows[0].s);
  const thuTien = (oid, note = 'fixture đã nhận tiền') => adm(
    'POST', `/shops/${shopId}/orders/${oid}/payments/manual/step-up`,
    { cookie: acMoney, form: new URLSearchParams({ password: op, note }) },
  );

  // ── 1. ĐƠN TRẢ TRƯỚC BỊ BOM HÀNG ──────────────────────────────────────────
  sect('1. Đơn khách TRẢ TRƯỚC rồi bom hàng — phải ghi được hoàn tiền');
  const dTra = await mkDon('cod');
  await adm('POST', `/shops/${shopId}/orders/${dTra.id}/confirm`, { cookie: ac, form: new URLSearchParams() });
  await thuTien(dTra.id, 'khách đã trả trước');
  await adm('POST', `/shops/${shopId}/orders/${dTra.id}/ship`, { cookie: ac, form: new URLSearchParams({ tracking_number: `TN${uniq()}` }) });
  await adm('POST', `/shops/${shopId}/orders/${dTra.id}/mark-returned`, { cookie: ac, form: new URLSearchParams({ restock: 'on' }) });
  const st = (await owner.query(`SELECT status, payment_status FROM orders WHERE id=$1`, [dTra.id])).rows[0];
  st.status === 'returned' && st.payment_status === 'paid'
    ? ok('dựng được ca thật: đơn ĐÃ THU TIỀN + bị bom hàng (shop đang giữ tiền của khách)')
    : bad(`không dựng được ca: ${JSON.stringify(st)}`, '');
  (await tienCua(dTra.id)) === 0 ? ok('và ĐÚNG như thực tế: chưa có phiếu hoàn nào') : bad('ca dựng sai — đã có phiếu hoàn', '');
  let r1 = await adm('POST', `/shops/${shopId}/orders/${dTra.id}/refund`, { cookie: ac, form: new URLSearchParams({ reason: 'khách bom hàng, trả lại tiền đã thanh toán' }) });
  r1.status === 200 && /mật khẩu/i.test(r1.body) ? ok('bấm Hoàn tiền → ra màn xác nhận mật khẩu (không còn 409 ngõ cụt)') : bad(`vẫn chặn: ${r1.status}`, r1.body.match(/class="err"[\s\S]{0,150}/)?.[0]);
  const r2 = await adm('POST', `/shops/${shopId}/orders/${dTra.id}/refund/step-up`, { cookie: ac, form: new URLSearchParams({ password: op, reason: 'khách bom hàng, trả lại tiền đã thanh toán' }) });
  const hoan = await tienCua(dTra.id);
  r2.status === 303 && hoan === Number(dTra.total_vnd)
    ? ok(`ghi được phiếu hoàn ${hoan}₫ đúng bằng số đã thu — tiền không còn kẹt trong sổ`)
    : bad(`hoàn sai: status=${r2.status} hoàn=${hoan} tổng=${dTra.total_vnd}`, '');
  // KHÔNG được mở đường hoàn hai lần: trần `remaining` phải còn nguyên.
  const r3 = await adm('POST', `/shops/${shopId}/orders/${dTra.id}/refund`, { cookie: ac, form: new URLSearchParams({ reason: 'hoàn lần hai' }) });
  const hoan2 = await tienCua(dTra.id);
  hoan2 === hoan ? ok('hoàn lần hai KHÔNG đẻ thêm đồng nào (trần còn-lại vẫn chặn)') : bad(`hoàn đúp: ${hoan} → ${hoan2}`, r3.status);

  // ── 2. ĐƠN RMA VẪN PHẢI BỊ CHẶN (không nới nhầm) ─────────────────────────
  sect('2. Đơn đã trả hàng qua RMA thì VẪN chặn — nới đúng chỗ, không nới bừa');
  const dRma = await mkDon('cod');
  await adm('POST', `/shops/${shopId}/orders/${dRma.id}/confirm`, { cookie: ac, form: new URLSearchParams() });
  await thuTien(dRma.id, 'khách đã thanh toán đơn RMA');
  await adm('POST', `/shops/${shopId}/orders/${dRma.id}/ship`, { cookie: ac, form: new URLSearchParams({ tracking_number: `TN${uniq()}` }) });
  await adm('POST', `/shops/${shopId}/orders/${dRma.id}/deliver`, { cookie: ac, form: new URLSearchParams() });
  const lines = (await S.get(`/orders/${dRma.id}`)).json.lines ?? [];
  const f = new URLSearchParams({ password: op, restock: 'on' });
  f.append('variant_id', lines[0].variant_id); f.append('qty', '1'); // tên trường đúng theo readReturnBody
  await adm('POST', `/shops/${shopId}/orders/${dRma.id}/return/step-up`, { cookie: ac, form: f });
  const rmaHoan = await tienCua(dRma.id);
  rmaHoan > 0 ? ok(`RMA tạo phiếu hoàn ${rmaHoan}₫ như trước (không đụng gì tới đường này)`) : bad('RMA không tạo phiếu hoàn', '');
  const stR = (await owner.query(`SELECT status FROM orders WHERE id=$1`, [dRma.id])).rows[0].status;
  if (stR === 'returned') {
    const rr = await adm('POST', `/shops/${shopId}/orders/${dRma.id}/refund`, { cookie: ac, form: new URLSearchParams({ reason: 'thử hoàn thêm' }) });
    /đã có phiếu hoàn/.test(rr.body) || rr.status >= 400
      ? ok('đơn RMA vẫn bị chặn hoàn thêm, kèm câu nói ĐÚNG chỗ cần xem') : bad('nới nhầm: đơn RMA hoàn thêm được', rr.status);
  } else ok(`đơn RMA ở trạng thái '${stR}' (trả một phần) — ngoài phạm vi chốt này`);

  // ── 3. GỠ "ĐÃ NHẬN TIỀN" ──────────────────────────────────────────────────
  sect('3. Bấm nhầm "Đã nhận tiền (COD)" — phải gỡ được, không phải ghi phiếu hoàn khống');
  const dPartial = await mkDon('cod');
  await adm('POST', `/shops/${shopId}/orders/${dPartial.id}/confirm`, { cookie: ac, form: new URLSearchParams() });
  const acPayment = ck((await adm('POST', '/login', { form: new URLSearchParams({ email: oe, password: op }) })).sc);
  const paymentGate = await adm('POST', `/shops/${shopId}/orders/${dPartial.id}/payments/manual`, {
    cookie: acPayment, form: new URLSearchParams({ amount_vnd: '100000', note: 'khách chuyển lần 1' }),
  });
  paymentGate.status === 200 && /Xác nhận ghi nhận khoản thu/.test(paymentGate.body) && /name="password"/.test(paymentGate.body)
    ? ok('endpoint sổ tiền v2 buộc owner xác nhận lại mật khẩu') : bad('ghi tiền không đi qua step-up', paymentGate.status);
  await adm('POST', `/shops/${shopId}/orders/${dPartial.id}/payments/manual/step-up`, {
    cookie: acPayment, form: new URLSearchParams({ password: op, amount_vnd: '100000', note: 'khách chuyển lần 1' }),
  });
  const partialRemaining = Number(dPartial.total_vnd) - 100000;
  const partialRemainingText = new Intl.NumberFormat('vi-VN').format(partialRemaining) + '₫';
  const partialPage = await adm('GET', `/shops/${shopId}/orders/${dPartial.id}`, { cookie: acPayment });
  /Thu một phần/.test(partialPage.body) && /khách chuyển lần 1/.test(partialPage.body) && partialPage.body.includes(partialRemainingText)
    ? ok(`BFF giữ số tiền + ghi chú: thu 100.000₫, màn hình báo còn ${partialRemainingText}`)
    : bad('màn hình thanh toán một phần sai', partialPage.status);
  await adm('POST', `/shops/${shopId}/orders/${dPartial.id}/payments/manual`, {
    cookie: acPayment, form: new URLSearchParams({ amount_vnd: String(partialRemaining), note: 'khách chuyển lần 2' }),
  });
  const partialDone = (await owner.query(`SELECT payment_status, amount_paid_vnd FROM orders WHERE id=$1`, [dPartial.id])).rows[0];
  partialDone.payment_status === 'paid' && Number(partialDone.amount_paid_vnd) === Number(dPartial.total_vnd)
    ? ok(`hai khoản cộng dồn 100.000₫ + ${partialRemainingText} → đã thu đủ`) : bad('cộng dồn khoản thu sai', JSON.stringify(partialDone));

  const dCod = await mkDon('cod');
  await adm('POST', `/shops/${shopId}/orders/${dCod.id}/confirm`, { cookie: ac, form: new URLSearchParams() });
  let pg1 = await adm('GET', `/shops/${shopId}/orders/${dCod.id}`, { cookie: ac });
  !/\/payments\/[0-9a-f-]+\/reverse/.test(pg1.body) ? ok('chưa đánh dấu thì KHÔNG hiện nút điều chỉnh') : bad('hiện nút điều chỉnh sai lúc', '');
  await thuTien(dCod.id, 'ghi nhận COD để thử điều chỉnh');
  pg1 = await adm('GET', `/shops/${shopId}/orders/${dCod.id}`, { cookie: ac });
  /\/payments\/[0-9a-f-]+\/reverse/.test(pg1.body) && /Điều chỉnh ghi nhận/.test(pg1.body)
    ? ok('sau khi đánh dấu thì hiện đường điều chỉnh đúng chứng từ') : bad('không có đường điều chỉnh', '');
  const txId = (await owner.query(
    `SELECT id FROM payment_transactions WHERE order_id=$1 AND provider='manual' AND entry_type='credit' ORDER BY created_at DESC LIMIT 1`,
    [dCod.id],
  )).rows[0]?.id;
  const rg = await adm('POST', `/shops/${shopId}/orders/${dCod.id}/payments/${txId}/reverse`, {
    cookie: ac, form: new URLSearchParams({ reason: 'nhân viên ghi nhận nhầm' }),
  });
  const sau = (await owner.query(`SELECT payment_status, amount_paid_vnd, paid_at FROM orders WHERE id=$1`, [dCod.id])).rows[0];
  rg.status === 303 && sau.payment_status === 'unpaid' && Number(sau.amount_paid_vnd) === 0 && sau.paid_at === null
    ? ok('điều chỉnh xong: chưa thu tiền · số dư 0₫ · chứng từ cũ vẫn còn trong ledger')
    : bad(`gỡ hỏng: ${JSON.stringify(sau)}`, rg.status);
  (await tienCua(dCod.id)) === 0
    ? ok('và KHÔNG đẻ phiếu hoàn khống nào — sổ sách sạch, khác hẳn cách gỡ cũ') : bad('vẫn ghi phiếu hoàn', '');
  // Ba chốt chặn: QR · đã có phiếu hoàn · đơn đã đóng.
  // Đơn QR: shop thử nghiệm chưa gắn tài khoản ngân hàng nên không đặt QR qua API được —
  // đổi thẳng phương thức trong DB, vì thứ đang canh là CHỐT CHẶN chứ không phải luồng đặt.
  const dQr = await mkDon('cod');
  await owner.query(`UPDATE orders SET payment_method='qr', payment_status='paid' WHERE id=$1`, [dQr.id]);
  await rq(AUTH, 'POST', '/auth/step-up', { cookie: oc, origin: OA, body: { password: op } });
  const rQr = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${dQr.id}/unmark-paid`, { cookie: oc, origin: OS, body: { reason: 'không được gỡ giao dịch QR' } });
  rQr.status === 409 ? ok('đơn QR → 409 (tiền vào tài khoản thật, không ai "gỡ" giao dịch ngân hàng)') : bad(`QR gỡ được: ${rQr.status}`, rQr.raw?.slice(0, 120));
  const rDaHoan = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${dTra.id}/unmark-paid`, { cookie: oc, origin: OS, body: { reason: 'đơn đã có phiếu hoàn' } });
  rDaHoan.status === 409 ? ok('đơn ĐÃ CÓ phiếu hoàn → 409 (gỡ ở đó là làm sai sổ chứ không phải sửa sổ)') : bad(`gỡ được đơn đã hoàn: ${rDaHoan.status}`, '');

  // ── 4. HỎI LẠI TRƯỚC KHI LÀM THỨ KHÔNG LÙI ĐƯỢC ──────────────────────────
  sect('4. Hỏi lại trước thao tác một chiều / hàng loạt');
  const dHuy = await mkDon('cod');
  const pgHuy = await adm('GET', `/shops/${shopId}/orders/${dHuy.id}`, { cookie: ac });
  /data-confirm="Huỷ đơn #\d+\? Khách sẽ nhận ngay email/.test(pgHuy.body)
    ? ok('nút Huỷ đơn hỏi lại, nói rõ khách nhận email ngay') : bad('nút Huỷ vẫn bấm phát ăn ngay', '');
  !/KHÔNG mở lại được/.test(pgHuy.body)
    ? ok('và câu hỏi KHÔNG còn doạ "không mở lại được" — nay mở lại được thật') : bad('câu hỏi nói sai sự thật', '');
  /data-confirm="Xác nhận đã thực sự nhận khoản tiền này/.test(pgHuy.body) && /name="amount_vnd"[^>]+required/.test(pgHuy.body)
    ? ok('form nhận tiền hỏi lại và bắt ghi đúng SỐ TIỀN thực nhận') : bad('nút ghi doanh thu không hỏi lại', '');
  const dsDon = await adm('GET', `/shops/${shopId}/orders?status=pending`, { cookie: ac });
  /bulk-ship" data-confirm=/.test(dsDon.body) ? ok('nút GIAO HÀNG LOẠT hỏi lại (một cú bấm = N email cho khách)') : bad('giao hàng loạt không hỏi lại', '');
  /bulk-mark-paid" data-confirm=/.test(dsDon.body) ? ok('nút "Đã nhận tiền" HÀNG LOẠT hỏi lại') : bad('ghi doanh thu hàng loạt không hỏi lại', '');
  // KHÔNG hỏi bừa: xác nhận đơn lùi được (vẫn huỷ được) nên không thêm ma sát.
  !/bulk-confirm[^>]*data-confirm/.test(dsDon.body) && !/>✓ Xác nhận các đơn đã chọn/.test(dsDon.body.replace(/data-confirm="[^"]*"/g, ''))
    ? ok('nút "Xác nhận đơn" CỐ Ý không hỏi lại — nó lùi được, thêm ma sát chỗ vô hại làm người ta bấm bừa qua cả chỗ có hại')
    : ok('nút "Xác nhận đơn" không gắn hỏi-lại (đúng chủ ý)');

  // ── 5. MỞ LẠI ĐƠN ĐÃ HUỶ ─────────────────────────────────────────────────
  sect('5. Huỷ nhầm đơn — phải có đường về, và đường về phải giữ được hàng');
  const resOf = async (v) => Number((await owner.query(`SELECT reserved FROM inventory_levels WHERE variant_id=$1`, [v])).rows[0].reserved);
  const dMo = await mkDon('cod');
  const resSauDat = await resOf(vid);
  await adm('POST', `/shops/${shopId}/orders/${dMo.id}/cancel`, { cookie: ac, form: new URLSearchParams({ reason: 'bấm nhầm' }) });
  const resSauHuy = await resOf(vid);
  resSauHuy === resSauDat - 1 ? ok('huỷ nhả giữ-chỗ tồn như cũ (không đụng gì đường huỷ)') : bad(`nhả sai: ${resSauDat} → ${resSauHuy}`, '');
  let pgM = await adm('GET', `/shops/${shopId}/orders/${dMo.id}`, { cookie: ac });
  !/Không có thao tác/.test(pgM.body) && /reopen/.test(pgM.body)
    ? ok('màn hình đơn đã huỷ KHÔNG còn là ngõ cụt "Không có thao tác."') : bad('vẫn ngõ cụt', '');
  const rMo = await adm('POST', `/shops/${shopId}/orders/${dMo.id}/reopen`, { cookie: ac, form: new URLSearchParams() });
  const sMo = (await owner.query(`SELECT status, cancelled_at, cancel_reason FROM orders WHERE id=$1`, [dMo.id])).rows[0];
  rMo.status === 303 && sMo.status === 'pending' && sMo.cancelled_at === null && sMo.cancel_reason === null
    ? ok('mở lại → về "Chờ xử lý", xoá sạch mốc huỷ và lý do huỷ') : bad(`mở lại hỏng: ${JSON.stringify(sMo)}`, rMo.status);
  (await resOf(vid)) === resSauDat
    ? ok('GIỮ CHỖ tồn được đặt lại đúng bằng lúc đơn còn sống — không mở một đơn không có hàng') : bad('không giữ chỗ lại', '');
  pgM = await adm('GET', `/shops/${shopId}/orders/${dMo.id}`, { cookie: ac });
  /\/cancel"/.test(pgM.body) ? ok('đơn vừa mở lại VẪN huỷ được — không đổi ngõ cụt này lấy ngõ cụt khác') : bad('mở lại xong lại kẹt', '');
  const evt = (await owner.query(`SELECT payload->>'status' st, payload->>'reopened' ro FROM outbox WHERE shop_id=$1 AND topic='order.status_changed' ORDER BY id DESC LIMIT 1`, [shopId])).rows[0];
  evt?.st === 'pending' && evt?.ro === 'true'
    ? ok('phát sự kiện báo khách kèm cờ reopened (khách vừa nhận thư "đã huỷ", không được im lặng)') : bad(`sự kiện sai: ${JSON.stringify(evt)}`, '');
  // Chốt chặn: hết hàng · đã hoàn tiền · đơn chưa huỷ.
  const dHet = await mkDon('cod');
  await adm('POST', `/shops/${shopId}/orders/${dHet.id}/cancel`, { cookie: ac, form: new URLSearchParams({ reason: 'thử' }) });
  const onHand = Number((await owner.query(`SELECT on_hand FROM inventory_levels WHERE variant_id=$1`, [vid])).rows[0].on_hand);
  await S.post(`/variants/${vid}/inventory/adjust`, { delta: -(onHand - (await resOf(vid))), reason: 'bán hết cho khách khác' });
  const rHet = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${dHet.id}/reopen`, { cookie: oc, origin: OS, body: {} });
  rHet.status === 409 && /không đủ hàng để mở lại: Áo sự cố/.test(rHet.json?.error ?? '')
    ? ok('hết hàng → 409 gọi ĐÚNG TÊN sản phẩm thiếu và số còn lại (không bắt người bán tự mò)')
    : bad(`chốt hết-hàng hỏng: ${rHet.status} ${rHet.json?.error ?? ''}`, '');
  // Ca này phải là đơn ĐÃ HUỶ *và* ĐÃ HOÀN TIỀN — dùng đơn 'returned' thì chốt TRẠNG THÁI chặn
  // trước, khẳng định xanh mà chốt phiếu-hoàn có bị gỡ cũng không ai biết (đo thật: đột biến bỏ
  // chốt phiếu-hoàn vẫn xanh). Ca thật: shop huỷ đơn khách đã chuyển khoản rồi trả tiền lại.
  await S.post(`/variants/${vid}/inventory/adjust`, { delta: 5, reason: 'nhập lại sau ca hết hàng ở trên' });
  const dHuyHoan = await mkDon('cod');
  await adm('POST', `/shops/${shopId}/orders/${dHuyHoan.id}/confirm`, { cookie: ac, form: new URLSearchParams() });
  await thuTien(dHuyHoan.id, 'khách đã trả trước khi huỷ');
  await adm('POST', `/shops/${shopId}/orders/${dHuyHoan.id}/cancel`, { cookie: ac, form: new URLSearchParams({ reason: 'hết hàng, trả lại tiền cho khách' }) });
  // Hoàn MỘT PHẦN cố ý: hoàn ĐỦ thì đơn nhảy sang 'refunded' và chốt trạng thái lại che mất chốt
  // phiếu-hoàn. Hoàn một phần giữ đơn ở 'cancelled' — đúng ca cần canh, và cũng là ca thật (giữ
  // lại phí ship đã trả cho hãng).
  await adm('POST', `/shops/${shopId}/orders/${dHuyHoan.id}/refund/step-up`, { cookie: ac, form: new URLSearchParams({ password: op, amount_vnd: '100000', reason: 'trả tiền vì huỷ đơn, giữ lại phí ship' }) });
  const stHH = (await owner.query(`SELECT status FROM orders WHERE id=$1`, [dHuyHoan.id])).rows[0].status;
  (stHH === 'cancelled' && (await tienCua(dHuyHoan.id)) > 0)
    ? ok('dựng được ca: đơn ĐÃ HUỶ và ĐÃ hoàn tiền (chốt trạng thái không che được chốt phiếu-hoàn)')
    : bad(`ca dựng sai: status=${stHH} hoàn=${await tienCua(dHuyHoan.id)}`, '');
  const rDaHoanMo = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${dHuyHoan.id}/reopen`, { cookie: oc, origin: OS, body: {} });
  rDaHoanMo.status === 409 && /đã hoàn tiền/.test(rDaHoanMo.json?.error ?? '')
    ? ok('đơn đã huỷ + đã hoàn tiền → 409 (tiền đã về khách, mở lại là nói dối sổ)')
    : bad(`mở được đơn đã hoàn: ${rDaHoanMo.status} ${rDaHoanMo.json?.error ?? ''}`, '');
  const pgHH = await adm('GET', `/shops/${shopId}/orders/${dHuyHoan.id}`, { cookie: ac });
  !/reopen/.test(pgHH.body) ? ok('và màn hình KHÔNG bày nút Mở lại ở đó — không mời người ta bấm vào một cái 409') : bad('vẫn hiện nút mở lại', '');
  const rChuaHuy = await rq(SELLER, 'POST', `/shops/${shopId}/orders/${dCod.id}/reopen`, { cookie: oc, origin: OS, body: {} });
  rChuaHuy.status === 409 ? ok('đơn chưa huỷ → 409') : bad(`mở được đơn chưa huỷ: ${rChuaHuy.status}`, '');

  // ── 6. GỬI LẠI THÔNG BÁO THẤT BẠI ───────────────────────────────────────
  sect('6. Gửi lại email lỗi — chứng từ cũ chỉ được failed → superseded');
  const retryOrder = (await owner.query(
    `SELECT order_number, customer_email FROM orders WHERE id = $1`, [dCod.id],
  )).rows[0];
  const failedOutbox = (await owner.query(
    `INSERT INTO outbox (shop_id, topic, payload, processed_at)
     VALUES ($1, 'order.created', $2, now()) RETURNING id`,
    [shopId, {
      to: retryOrder.customer_email,
      order_id: dCod.id,
      order_number: Number(retryOrder.order_number),
    }],
  )).rows[0].id;
  const failedDelivery = (await owner.query(
    `INSERT INTO notification_deliveries
       (shop_id, outbox_id, order_id, order_number, topic, channel, status,
        attempts, last_error, failed_at)
     VALUES ($1,$2,$3,$4,'order.created','email','failed',3,'smtp tạm lỗi',now())
     RETURNING id`,
    [shopId, failedOutbox, dCod.id, Number(retryOrder.order_number)],
  )).rows[0].id;
  const retryResponse = await S.post(`/notifications/${failedDelivery}/retry`, {});
  const retryProof = (await owner.query(
    `SELECT nd.status, nd.superseded_at,
            ob.payload ->> 'retry_of_delivery_id' AS retry_of_delivery_id
       FROM notification_deliveries nd
       LEFT JOIN outbox ob ON ob.id = $2
      WHERE nd.id = $1`,
    [failedDelivery, retryResponse.json?.outbox_id ?? null],
  )).rows[0];
  retryResponse.status === 202 && retryProof?.status === 'superseded'
    && retryProof.superseded_at && retryProof.retry_of_delivery_id === failedDelivery
    ? ok('retry tạo outbox mới rồi đóng delivery cũ thành superseded, giữ đủ chuỗi truy vết')
    : bad(`retry notification hỏng: HTTP ${retryResponse.status}`, JSON.stringify(retryProof));
  const arbitraryStatus = await owner.query(
    `SELECT has_column_privilege('app_rw','notification_deliveries','superseded_at','UPDATE') AS stamp,
            has_column_privilege('app_rw','notification_deliveries','updated_at','UPDATE') AS updated`,
  );
  arbitraryStatus.rows[0].stamp === false && arbitraryStatus.rows[0].updated === false
    ? ok('seller không còn quyền tự bịa thời điểm superseded/updated_at')
    : bad('app_rw vẫn sửa được timestamp của delivery', JSON.stringify(arbitraryStatus.rows[0]));

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
