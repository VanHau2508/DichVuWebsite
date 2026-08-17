/**
 * E2E CÔNG NỢ KHÁCH — "tôi còn nợ khách bao nhiêu" (docs/66).
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-cong-no.e2e.mjs
 *
 * Trước khi có màn hình này, câu hỏi đó không có chỗ nào trả lời: số tiền nằm rải trong từng
 * đơn và chủ shop chỉ biết mình nợ khi khách gọi tới đòi. Đo trên shop ngày-60 (395 đơn):
 * 6.050.000₫ trên 11 đơn, phần mềm hiện 0₫.
 *
 * BỘ NÀY CANH BA THỨ:
 *   1. CÔNG THỨC bắt đủ mọi hình dạng nợ, nhất là hai hình dạng luật cũ bỏ sót:
 *      · đơn BOM HÀNG khách đã trả trước (trạng thái 'returned', luật cũ chỉ xét 'cancelled');
 *      · đơn từng SỬA GIẢM rồi bị huỷ — luật cũ lấy `total - đã hoàn` nên ra số ÂM và kết luận
 *        "không nợ" cho một khoản nợ có thật.
 *   2. MỘT CON SỐ, BA NƠI: trang Công nợ · ô "Việc cần làm" · băng đỏ trên đơn phải khớp nhau.
 *      Ba nơi tự tính riêng là ba con số sẽ lệch nhau ở đúng lần sửa thứ ba.
 *   3. DANH SÁCH TỰ RỖNG khi trả xong — nó là hàng đợi việc, không phải kho lưu trữ.
 *
 * Nhánh lý do thứ ba `thu_thua` (thu nhiều hơn giá trị đơn) CỐ Ý không có ca thử: hôm nay không
 * đường nào của sản phẩm tới được đó — sửa-đơn-giảm tự sinh phiếu hoàn bù đúng phần chênh. Giữ
 * nhánh để nếu có ngày tiền thừa lọt vào thì nó HIỆN RA thay vì lặng lẽ biến mất.
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
async function adminRefund(shopId, oid, { cookie, password, amount_vnd = '', reason = '' }) {
  const prepare = await adm('POST', `/shops/${shopId}/orders/${oid}/refund`, {
    cookie, form: new URLSearchParams({ amount_vnd, reason }),
  });
  const key = (prepare.body.match(/name="idempotency_key" value="([0-9a-f-]{36})"/) ?? [])[1];
  if (!key) return { prepare, result: { status: 0, body: 'confirmation thiếu idempotency_key' } };
  const final = { amount_vnd, reason, idempotency_key: key };
  if (/name="password"/.test(prepare.body)) final.password = password;
  return { prepare, result: await adm('POST', `/shops/${shopId}/orders/${oid}/refund/confirm`, {
    cookie, form: new URLSearchParams(final),
  }), key };
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

// Dựng một shop có chủ + 1 sản phẩm còn hàng. Trả về đủ đồ nghề để đặt đơn và đi màn.
async function makeShop(staff) {
  const slug = `no-${uniq()}`;
  const r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staff, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staff, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  const api = await login(email, password);
  const ui = ck((await adm('POST', '/login', { form: new URLSearchParams({ email, password }) })).sc);
  const S = {
    get: (p) => rq(SELLER, 'GET', `/shops/${shopId}${p}`, { cookie: api }),
    post: (p, b) => rq(SELLER, 'POST', `/shops/${shopId}${p}`, { body: b, cookie: api, origin: OS }),
    patch: (p, b) => rq(SELLER, 'PATCH', `/shops/${shopId}${p}`, { body: b, cookie: api, origin: OS }),
  };
  await S.patch('', { name: slug, max_pending_per_phone: 999, max_pending_per_ip: 999 });
  const pr = await S.post('/products', { title: 'Áo công nợ', slug: `ao-${uniq()}`, price_vnd: 500000, status: 'active', variants: [{ sku: `NO-${uniq()}`, price_vnd: 500000 }] });
  const vid = (await S.get(`/products/${pr.json.id}`)).json.variants[0].id;
  await S.post(`/variants/${vid}/inventory/adjust`, { delta: 200, reason: 'nhập' });
  const sdt = () => `09${Math.floor(10000000 + Math.random() * 89999999)}`;
  const datDon = async () => (await S.post('/orders', {
    lines: [{ variant_id: vid, qty: 1 }],
    customer: { name: 'Khách nợ', phone: sdt(), email: `kh-${uniq()}@khach.vn`, address_line: '1 Lê Lợi', province: 'Hà Nội' },
    payment_method: 'cod', idempotency_key: `no-${uniq()}`,
  })).json;
  const A = (oid, act, f = {}) => act === 'mark-paid'
    ? adm('POST', `/shops/${shopId}/orders/${oid}/payments/manual/step-up`, {
        cookie: ui, form: new URLSearchParams({ password, note: 'fixture công nợ đã nhận tiền' }),
      })
    : adm('POST', `/shops/${shopId}/orders/${oid}/${act}`, { cookie: ui, form: new URLSearchParams(f) });
  return { shopId, email, password, api, ui, S, vid, datDon, A };
}

async function main() {
  const staff = await makeStaff();
  const s = await makeShop(staff);
  const congNo = async () => (await rq(SELLER, 'GET', `/shops/${s.shopId}/orders/owed`, { cookie: s.api })).json;
  const trang = async () => (await adm('GET', `/shops/${s.shopId}/orders/owed`, { cookie: s.ui }));
  const oCua = async (oid) => Number((await rq(SELLER, 'GET', `/shops/${s.shopId}/orders/${oid}`, { cookie: s.api })).json.owed_vnd);
  const tongQuan = async () => (await adm('GET', `/shops/${s.shopId}/overview`, { cookie: s.ui })).body;

  // ── 0. SHOP SẠCH ──────────────────────────────────────────────────────────
  sect('0. Shop chưa nợ ai — màn hình phải nói THẲNG là không nợ');
  let cn = await congNo();
  cn?.total_owed_vnd === 0 && cn.count === 0 ? ok('API: tổng 0₫, 0 đơn') : bad(`API sai: ${JSON.stringify(cn)}`, '');
  let tr = await trang();
  tr.status === 200 && /Không nợ khách đồng nào/.test(tr.body)
    ? ok('trang nói "Không nợ khách đồng nào" — không để người đọc tự suy ra từ bảng rỗng') : bad(`trang sai: ${tr.status}`, '');

  // ── 1. ĐƠN HUỶ ĐÃ THU TIỀN ────────────────────────────────────────────────
  sect('1. Huỷ đơn khách đã trả tiền → nợ đúng số đã thu');
  const dHuy = await s.datDon();
  await s.A(dHuy.id, 'confirm'); await s.A(dHuy.id, 'mark-paid');
  await s.A(dHuy.id, 'cancel', { reason: 'hết hàng' });
  cn = await congNo();
  cn.total_owed_vnd === Number(dHuy.total_vnd) && cn.count === 1
    ? ok(`nợ ${cn.total_owed_vnd}₫ đúng bằng số đã thu`) : bad(`sai: ${JSON.stringify({ t: cn.total_owed_vnd, n: cn.count })} vs ${dHuy.total_vnd}`, '');
  cn.orders[0]?.owed_reason === 'huy_da_thu' ? ok("kèm LÝ DO 'huy_da_thu' — biết nợ chưa đủ, phải biết vì sao") : bad(`lý do sai: ${cn.orders[0]?.owed_reason}`, '');
  (await oCua(dHuy.id)) === Number(dHuy.total_vnd) ? ok('API đơn lẻ trả owed_vnd KHỚP với trang tổng (một con số, hai nơi)') : bad('lệch giữa hai nơi', '');
  let ct = await adm('GET', `/shops/${s.shopId}/orders/${dHuy.id}`, { cookie: s.ui });
  /Còn nợ khách/.test(ct.body) && /đơn đã huỷ nhưng khách đã thanh toán/.test(ct.body)
    ? ok('băng đỏ trên đơn hiện, nói đúng lý do') : bad('không có băng đỏ', '');

  // ── 2. BOM HÀNG ĐÃ TRẢ TRƯỚC — CA LUẬT CŨ BỎ TRẮNG ───────────────────────
  sect('2. Bom hàng khách đã trả trước — ca luật cũ KHÔNG hề thấy');
  const dBom = await s.datDon();
  await s.A(dBom.id, 'confirm'); await s.A(dBom.id, 'mark-paid');
  await s.A(dBom.id, 'ship', { tracking_number: `TN${uniq()}` });
  await s.A(dBom.id, 'mark-returned', { restock: 'on' });
  const st = (await owner.query(`SELECT status, payment_status FROM orders WHERE id=$1`, [dBom.id])).rows[0];
  st.status === 'returned' && st.payment_status === 'paid'
    ? ok("dựng đúng ca: trạng thái 'returned', vẫn 'paid' — luật cũ chỉ xét 'cancelled' nên mù hoàn toàn ở đây")
    : bad(`ca sai: ${JSON.stringify(st)}`, '');
  cn = await congNo();
  cn.count === 2 && cn.total_owed_vnd === Number(dHuy.total_vnd) + Number(dBom.total_vnd)
    ? ok(`bắt được: tổng lên ${cn.total_owed_vnd}₫ / 2 đơn`) : bad(`bỏ sót: ${JSON.stringify({ t: cn.total_owed_vnd, n: cn.count })}`, '');
  cn.orders.find((o) => o.id === dBom.id)?.owed_reason === 'hoan_ve_chua_tra'
    ? ok("lý do 'hoan_ve_chua_tra' — hàng về rồi, tiền chưa về") : bad('lý do sai', '');

  // ── 2b. ĐƠN TỪNG SỬA GIẢM RỒI BỊ HUỶ ─────────────────────────────────────
  // CA QUYẾT ĐỊNH của cả bộ này: nó là ca DUY NHẤT phân biệt được "đã thu" với "giá trị đơn".
  // Ở mọi ca khác hai số đó bằng nhau, nên một công thức lấy nhầm `total_vnd` vẫn xanh trơn.
  // Đây cũng đúng là ca đã bắt luật cũ nói dối trên shop ngày-60: thu 1.990.000₫, sửa giảm còn
  // 430.000₫ (tự hoàn 1.560.000₫), rồi huỷ → luật cũ tính 430.000 − 1.560.000 = −1.130.000 và
  // kết luận "không nợ", trong khi shop đang giữ 430.000₫ của khách.
  sect('2b. Đơn ĐÃ THU NHIỀU rồi sửa giảm rồi huỷ — ca duy nhất phân biệt "đã thu" với "giá trị đơn"');
  const dSua = (await s.S.post('/orders', {
    lines: [{ variant_id: s.vid, qty: 4 }],
    customer: { name: 'Khách sửa', phone: `09${Math.floor(10000000 + Math.random() * 89999999)}`, email: `kh-${uniq()}@khach.vn`, address_line: '1 Lê Lợi', province: 'Hà Nội' },
    payment_method: 'cod', idempotency_key: `no-${uniq()}`,
  })).json;
  await s.A(dSua.id, 'confirm'); await s.A(dSua.id, 'mark-paid');
  const cust = [['name', 'Khách sửa'], ['phone', '0901234567'], ['email', ''], ['address_line', 'HN'], ['province', 'Hà Nội'], ['ship_fee_vnd', ''], ['note', '']];
  await adm('POST', `/shops/${s.shopId}/orders/${dSua.id}/edit-paid/step-up`,
    { cookie: s.ui, form: new URLSearchParams([['variant_id', s.vid], ['qty', '1'], ...cust, ['password', s.password]]) });
  const sauSua = (await owner.query(
    `SELECT total_vnd, amount_paid_vnd, coalesce((SELECT sum(amount_vnd) FROM refunds r WHERE r.order_id=o.id),0) hoan
       FROM orders o WHERE id=$1`, [dSua.id])).rows[0];
  Number(sauSua.amount_paid_vnd) > Number(sauSua.total_vnd) && Number(sauSua.hoan) > 0
    ? ok(`dựng đúng ca: đã thu ${sauSua.amount_paid_vnd}₫ > giá trị đơn ${sauSua.total_vnd}₫, đã tự hoàn ${sauSua.hoan}₫`)
    : bad(`ca sai: ${JSON.stringify(sauSua)}`, '');
  (await oCua(dSua.id)) === 0 ? ok('lúc đơn còn sống: KHÔNG nợ gì (đã hoàn đúng phần chênh)') : bad(`nợ nhầm khi đơn còn sống: ${await oCua(dSua.id)}`, '');
  await s.A(dSua.id, 'cancel', { reason: 'khách đổi ý' });
  const noSua = await oCua(dSua.id);
  noSua === Number(sauSua.total_vnd)
    ? ok(`huỷ xong → nợ đúng ${noSua}₫ (dùng "đã thu"; nếu lấy "giá trị đơn" thì ra số âm và cảnh báo tắt ngóm)`)
    : bad(`sai: ${noSua} ≠ ${sauSua.total_vnd}`, '');
  cn = await congNo();
  cn.orders.some((o) => o.id === dSua.id && o.owed_vnd === noSua) ? ok('và nó có mặt trong danh sách công nợ') : bad('lọt khỏi danh sách', '');
  // Trả nốt cho đơn này để các phần sau đếm trên nền sạch.
  await adminRefund(s.shopId, dSua.id, { cookie: s.ui, password: s.password, reason: 'trả nốt' });
  (await oCua(dSua.id)) === 0 ? ok('hoàn nốt → về 0, dọn nền cho các phần sau') : bad('còn nợ sau khi hoàn đủ', '');

  // ── 3. HOÀN MỘT PHẦN RỒI HOÀN ĐỦ ─────────────────────────────────────────
  sect('3. Trả tiền dần — nợ phải tụt theo, và tự rời danh sách khi trả xong');
  const nua = Math.floor(Number(dHuy.total_vnd) / 2);
  await adminRefund(s.shopId, dHuy.id, { cookie: s.ui, password: s.password, amount_vnd: String(nua), reason: 'trả trước một nửa' });
  cn = await congNo();
  const conLai = cn.orders.find((o) => o.id === dHuy.id)?.owed_vnd;
  conLai === Number(dHuy.total_vnd) - nua ? ok(`hoàn ${nua}₫ → còn nợ ${conLai}₫, vẫn nằm trong danh sách`) : bad(`còn nợ sai: ${conLai}`, '');
  await adminRefund(s.shopId, dHuy.id, { cookie: s.ui, password: s.password, reason: 'trả nốt' });
  cn = await congNo();
  !cn.orders.some((o) => o.id === dHuy.id) && cn.count === 1
    ? ok('trả đủ → đơn TỰ RỜI danh sách (đây là hàng đợi việc, không phải kho lưu trữ)') : bad(`vẫn còn: ${JSON.stringify({ n: cn.count })}`, '');
  ct = await adm('GET', `/shops/${s.shopId}/orders/${dHuy.id}`, { cookie: s.ui });
  !/Còn nợ khách/.test(ct.body) ? ok('băng đỏ trên đơn cũng biến mất') : bad('băng đỏ còn treo', '');

  // ── 4. HOÀN THIỆN CHÍ TRÊN ĐƠN GIAO XONG — KHÔNG PHẢI NỢ ─────────────────
  sect('4. Đơn giao xong mà hoàn thiện chí một phần — KHÔNG được tính là nợ');
  const dGiao = await s.datDon();
  await s.A(dGiao.id, 'confirm'); await s.A(dGiao.id, 'mark-paid');
  await s.A(dGiao.id, 'ship', { tracking_number: `TN${uniq()}` }); await s.A(dGiao.id, 'deliver');
  await adminRefund(s.shopId, dGiao.id, { cookie: s.ui, password: s.password, amount_vnd: '50000', reason: 'xin lỗi giao chậm' });
  cn = await congNo();
  !cn.orders.some((o) => o.id === dGiao.id)
    ? ok('shop trả DƯ thì đó là quà, không phải nợ — không lọt vào danh sách') : bad('tính nhầm thành nợ', '');
  // Phải kiểm CHÍNH con số, không chỉ kiểm "vắng mặt trong danh sách": danh sách lọc `> 0` nên
  // một số ÂM cũng vắng mặt y hệt số 0. Bỏ chặn-ở-0 mà chỉ canh danh sách thì không ai biết,
  // cho tới ngày con số âm đó bị cộng vào một tổng nào đó và ăn mất tiền nợ của đơn khác.
  (await oCua(dGiao.id)) === 0
    ? ok('và con số của đơn đó đúng bằng 0, không phải số âm (chặn ở 0, không cho âm)') : bad(`không chặn ở 0: ${await oCua(dGiao.id)}`, '');

  // ── 5. BA NƠI CÙNG MỘT CON SỐ ────────────────────────────────────────────
  sect('5. Trang Công nợ · ô "Việc cần làm" · tổng cộng phải khớp nhau');
  cn = await congNo();
  const tongTuDong = cn.orders.reduce((a, o) => a + o.owed_vnd, 0);
  tongTuDong === cn.total_owed_vnd ? ok(`tổng ${cn.total_owed_vnd}₫ = cộng các dòng (không phải hai phép đếm khác nhau)`) : bad(`lệch: ${tongTuDong} vs ${cn.total_owed_vnd}`, '');
  const tq = await tongQuan();
  const soTrenO = /↩ Còn nợ khách/.test(tq);
  soTrenO ? ok('ô "Còn nợ khách" có mặt trên Tổng quan') : bad('không thấy ô trên Tổng quan', '');
  new RegExp(`href="/shops/${s.shopId}/orders/owed"`).test(tq)
    ? ok('và ô ĐI ĐƯỢC tới đúng danh sách (con số không dẫn đi đâu thì dạy người ta bỏ qua nó)') : bad('ô không có link đúng', '');
  const vnd = new Intl.NumberFormat('vi-VN').format(cn.total_owed_vnd);
  tq.includes(vnd) ? ok(`ô mang theo SỐ TIỀN ${vnd}₫ khớp trang Công nợ`) : bad(`ô không khớp số tiền ${vnd}`, '');
  tr = await trang();
  tr.body.includes(vnd) ? ok('trang Công nợ hiện cùng con số') : bad('trang lệch số', '');

  // ── 6. KHÔNG RÒ SANG SHOP KHÁC ───────────────────────────────────────────
  sect('6. Nợ của shop khác KHÔNG được cộng vào đây');
  const s2 = await makeShop(staff);
  const d2 = await s2.datDon();
  await s2.A(d2.id, 'confirm'); await s2.A(d2.id, 'mark-paid'); await s2.A(d2.id, 'cancel', { reason: 'x' });
  const cn2 = await rq(SELLER, 'GET', `/shops/${s2.shopId}/orders/owed`, { cookie: s2.api });
  const cnSau = await congNo();
  cn2.json.total_owed_vnd === Number(d2.total_vnd) ? ok('shop thứ hai thấy đúng nợ của mình') : bad('shop 2 sai', '');
  cnSau.total_owed_vnd === cn.total_owed_vnd && !cnSau.orders.some((o) => o.id === d2.id)
    ? ok('shop thứ nhất KHÔNG đổi một đồng — tổng tiền là chỗ rò tenant đắt nhất') : bad(`rò: ${cn.total_owed_vnd} → ${cnSau.total_owed_vnd}`, '');
  const trom = await rq(SELLER, 'GET', `/shops/${s2.shopId}/orders/owed`, { cookie: s.api });
  trom.status === 403 || trom.status === 404 ? ok(`chủ shop 1 gọi API của shop 2 → ${trom.status}`) : bad(`đọc được: ${trom.status}`, '');

  console.log(`\n${pass} pass, ${fail} fail`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
