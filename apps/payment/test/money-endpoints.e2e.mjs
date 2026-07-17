/**
 * End-to-end 3 ENDPOINT ĐỤNG TIỀN chưa có test (Đợt 3.4). Chạy trong dbtest:
 *   docker compose -f infra/compose.dev.yml exec -T dbtest node apps/payment/test/money-endpoints.e2e.mjs
 *
 * Kiểm HỢP ĐỒNG THẬT của code (apps/seller/src/orders.js + payment-config.js):
 *   1. REFUND  (POST /orders/:id/refund — perm 'refund' owner/admin + step-up):
 *      chỉ đơn ĐÃ TRẢ, idempotent (đã hoàn → 409), pending/confirmed GIẢI PHÓNG reserve,
 *      delivered KHÔNG đụng tồn (chủ shop tự nhập lại), mark-paid không đảo được refund.
 *   2. MARK-PAID-QR (POST /orders/:id/mark-paid-qr — perm 'payment.write' CHỈ owner + step-up):
 *      fallback tay khi feed đối soát vắng; chỉ đơn QR (COD → 409), đã trả → 409,
 *      KHÔNG tự confirm đơn (khác webhook: webhook đặt paid + confirmed).
 *   3. RECONCILE resolve (POST /payment/reconcile/:id/resolve — 'payment.write' + step-up):
 *      chỉ đánh dấu resolved_at (KHÔNG gắn đơn, KHÔNG đặt paid — hợp đồng thật),
 *      resolve lần 2 → 409, chéo shop bị RLS chặn → 409, ngoài membership → 404.
 */
import pg from 'pg';
import { totp, counterFor } from '../../../packages/auth/src/totp.js';
import { base32Decode } from '../../../packages/auth/src/base32.js';

const AUTH = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM = process.env.PLATFORM_URL ?? 'http://platform:3030';
const SELLER = process.env.SELLER_URL ?? 'http://seller:3040';
const PAYMENT = process.env.PAYMENT_URL ?? 'http://payment:3070';
const OA = 'https://auth.localtest', OO = 'https://ops.localtest', OS = 'https://seller.localtest';
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
// Token lời mời KHÔNG còn trong API response (email hoá, 0073) — lấy từ outbox qua owner SQL (ADR-006: cùng tx với INSERT invitations nên đọc được ngay).
const inviteTokenOf = async (email) => { const { rows } = await owner.query(`SELECT payload->>'accept_url' AS u FROM outbox WHERE topic = 'user.invited' AND payload->>'to' = $1 ORDER BY id DESC LIMIT 1`, [email]); return rows[0]?.u ? new URL(rows[0].u).searchParams.get('token') : null; };

let pass = 0, fail = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => { pass++; console.log(`  ${G}PASS${X} ${m}`); };
const bad = (m, d) => { fail++; console.log(`  ${R}FAIL${X} ${m}`); if (d) console.log(`       ${D}${d}${X}`); };
const sect = (m) => console.log(`\n${B}${m}${X}`);
const uniq = () => Math.random().toString(36).slice(2, 10);
const phone = () => '09' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
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
const login = async (email, password) => ck((await rq(AUTH, 'POST', '/auth/login', { body: { email, password }, origin: OA })).sc);
const uidOf = async (email) => (await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id ?? null;
const stepUp = (cookie, password) => rq(AUTH, 'POST', '/auth/step-up', { body: { password }, cookie, origin: OA });

async function makeStaff() {
  const email = `staff-${uniq()}@nentang.vn`, password = 'staff strong passphrase';
  await rq(AUTH, 'POST', '/auth/register', { body: { email, password }, origin: OA });
  let cookie = await login(email, password);
  let r = await rq(AUTH, 'POST', '/auth/mfa/enroll', { cookie, origin: OA });
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
  let r = await rq(PLATFORM, 'POST', '/ops/shops', { body: { name: slug, slug, plan_code: 'platform' }, cookie: staffCookie, origin: OO });
  const shopId = r.json.id;
  const email = `owner-${uniq()}@shop.vn`, password = 'owner passphrase strong';
  r = await rq(PLATFORM, 'POST', `/ops/shops/${shopId}/invitations`, { body: { email, role: 'owner' }, cookie: staffCookie, origin: OO });
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { shopId, slug, email, password, cookie: await login(email, password) };
}
// Owner (ĐÃ step-up) mời thành viên vai trò role → trả cookie + password.
async function inviteMember(shopId, ownerCookie, role) {
  const email = `${role}-${uniq()}@shop.vn`, password = 'member passphrase good';
  const r = await rq(SELLER, 'POST', `/shops/${shopId}/members/invite`, { body: { email, role }, cookie: ownerCookie, origin: OS });
  if (r.status !== 201) throw new Error(`mời ${role} thất bại: ${r.raw}`);
  await rq(AUTH, 'POST', '/auth/invitations/accept', { body: { token: await inviteTokenOf(email), password }, origin: OA });
  return { email, password, cookie: await login(email, password) };
}
async function setupProduct(shop, price, stock) {
  const r = await rq(SELLER, 'POST', `/shops/${shop.shopId}/products`, {
    body: { title: `SP ${uniq()}`, slug: `sp-${uniq()}`, price_vnd: price, status: 'active', variants: [{ sku: `S-${uniq()}`, price_vnd: price }] }, cookie: shop.cookie, origin: OS });
  const detail = await rq(SELLER, 'GET', `/shops/${shop.shopId}/products/${r.json.id}`, { cookie: shop.cookie });
  const vid = detail.json.variants[0].id;
  await rq(SELLER, 'POST', `/shops/${shop.shopId}/variants/${vid}/inventory/adjust`, { body: { delta: stock, reason: 'nhập' }, cookie: shop.cookie, origin: OS });
  return vid;
}
const invOf = async (vid) => (await owner.query(`SELECT on_hand, reserved FROM inventory_levels WHERE variant_id=$1`, [vid])).rows[0];
const orderRow = async (id) => (await owner.query(`SELECT status, payment_status, paid_at FROM orders WHERE id=$1`, [id])).rows[0];

// Webhook SePay per-shop (Authorization: Apikey <token của shop>).
const ACC = '0011002345678';
async function webhookPerShop(token, body) {
  const full = { accountNumber: ACC, ...body };
  const r = await fetch(`${PAYMENT}/webhooks/sepay`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Apikey ${token}` }, body: JSON.stringify(full),
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j, raw: t };
}

async function main() {
  const staff = await makeStaff();
  const A = await makeShopOwner(staff, `mny-${uniq()}`);
  const Bs = await makeShopOwner(staff, `mny-${uniq()}`);
  const vid = await setupProduct(A, 100000, 20);
  // Bật QR bằng SQL owner (KHÔNG qua PUT payment-config vì PUT cần step-up — các
  // assertion "chưa step-up → 403" phía dưới phải chạy TRƯỚC lần step-up đầu tiên).
  await owner.query(
    `INSERT INTO shop_payment_config (shop_id, bank_bin, account_number, account_name, qr_enabled)
     VALUES ($1, '970415', $2, 'SHOP A', true)`, [A.shopId, ACC]);

  const a = {
    post: (p, b, c = A.cookie) => rq(SELLER, 'POST', `/shops/${A.shopId}${p}`, { body: b, cookie: c, origin: OS }),
    get: (p, c = A.cookie) => rq(SELLER, 'GET', `/shops/${A.shopId}${p}`, { cookie: c }),
  };
  const mkOrder = async (qty, method = 'cod') => {
    const r = await a.post('/orders', {
      lines: [{ variant_id: vid, qty }], payment_method: method, idempotency_key: `mny-${uniq()}`,
      customer: { name: 'Khách Tiền Nong', phone: phone(), address_line: '5 Lê Lợi', province: 'TP. Hồ Chí Minh' },
    });
    if (r.status !== 201) throw new Error(`tạo đơn ${method} lỗi: ${r.raw}`);
    return r.json; // {id, order_number, ...}
  };

  // Đơn dựng sẵn: o1/o2/o3/o4 COD, oq QR. reserve = 2+1+2+1+1 = 7.
  const o1 = await mkOrder(2), o2 = await mkOrder(1), o3 = await mkOrder(2), o4 = await mkOrder(1);
  const oq = await mkOrder(1, 'qr');
  oq.payment_ref?.startsWith('NTG') ? ok(`dựng 5 đơn (4 COD + 1 QR ref ${oq.payment_ref})`) : bad('đơn QR thiếu payment_ref', JSON.stringify(oq));
  let inv = await invOf(vid);
  Number(inv.reserved) === 7 && Number(inv.on_hand) === 20 ? ok('reserve tồn 7/20 sau 5 đơn') : bad(`tồn sai: ${inv.on_hand}/${inv.reserved}`);

  // ── 1. REFUND — guard trạng thái + step-up + tồn kho ──────────────────────
  sect('1. REFUND (perm refund + step-up)');
  let r = await a.post(`/orders/${o1.id}/mark-paid`, {});
  r.status === 200 && r.json.payment_status === 'paid' ? ok('mark-paid COD → 200 paid (orders.write, KHÔNG cần step-up)') : bad('mark-paid lỗi', r.raw);
  r = await a.post(`/orders/${o1.id}/refund`, {});
  r.status === 403 && r.json?.step_up_required === true ? ok('refund CHƯA step-up → 403 step_up_required') : bad('refund không đòi step-up', r.raw);
  r = await a.post(`/orders/${oq.id}/mark-paid-qr`, {});
  r.status === 403 && r.json?.step_up_required === true ? ok('mark-paid-qr CHƯA step-up → 403 step_up_required') : bad('mark-paid-qr không đòi step-up', r.raw);

  await stepUp(A.cookie, A.password);
  r = await a.post(`/orders/${o2.id}/refund`, {});
  r.status === 409 && /chỉ hoàn được đơn đã thanh toán/.test(r.json?.error ?? '') ? ok('refund đơn CHƯA TRẢ → 409') : bad('refund đơn chưa trả lọt', r.raw);

  let before = await invOf(vid);
  r = await a.post(`/orders/${o1.id}/refund`, {});
  r.status === 200 && r.json.status === 'refunded' && r.json.payment_status === 'refunded'
    ? ok('refund đơn pending+paid → 200 status=refunded payment=refunded') : bad('refund lỗi', r.raw);
  inv = await invOf(vid);
  Number(inv.reserved) === Number(before.reserved) - 2 && Number(inv.on_hand) === Number(before.on_hand)
    ? ok('refund từ pending → GIẢI PHÓNG reserve (−2), on_hand nguyên') : bad(`tồn sau refund: ${inv.on_hand}/${inv.reserved} (trước ${before.on_hand}/${before.reserved})`);
  // Hợp đồng thật: sau refund payment_status='refunded' nên guard "chưa paid"
  // (orders.js:335) bắn TRƯỚC guard "đã hoàn" (336 — nhánh chết) → message là
  // 'chỉ hoàn được đơn đã thanh toán'. Vẫn 409 idempotent, chỉ khác lời báo.
  r = await a.post(`/orders/${o1.id}/refund`, {});
  r.status === 409 && /chỉ hoàn được đơn đã thanh toán|đã hoàn tiền/.test(r.json?.error ?? '')
    ? ok('refund LẦN 2 → 409 (idempotent-guard; message qua nhánh "chưa paid")') : bad('refund double lọt', r.raw);
  r = await a.post(`/orders/${o1.id}/mark-paid`, {});
  r.status === 409 ? ok('mark-paid đơn ĐÃ HOÀN → 409 (không đảo ngược được refund)') : bad('mark-paid đảo được refund — LỖ HỔNG', r.raw);

  // Đơn đi trọn vòng đời: confirm → ship (consume tồn) → deliver → paid → refund.
  await a.post(`/orders/${o3.id}/confirm`, {});
  await a.post(`/orders/${o3.id}/ship`, { tracking_number: `E2E-${uniq()}`, carrier: 'GHTK' });
  await a.post(`/orders/${o3.id}/deliver`, {});
  r = await a.post(`/orders/${o3.id}/mark-paid`, {});
  inv = await invOf(vid);
  r.status === 200 && Number(inv.on_hand) === 18 ? ok('vòng đời confirm→ship→deliver→paid (ship consume on_hand −2)') : bad(`vòng đời lỗi: ${r.status} on_hand=${inv.on_hand}`, r.raw);
  before = inv;
  r = await a.post(`/orders/${o3.id}/refund`, {});
  r.status === 200 && r.json.status === 'refunded' ? ok('refund đơn DELIVERED+paid → 200') : bad('refund delivered lỗi', r.raw);
  inv = await invOf(vid);
  Number(inv.on_hand) === Number(before.on_hand) && Number(inv.reserved) === Number(before.reserved)
    ? ok('refund delivered KHÔNG đụng tồn (chủ shop tự nhập lại nếu khách trả hàng)') : bad(`tồn bị đụng: ${inv.on_hand}/${inv.reserved}`);

  // ── 2. RBAC refund: order_manager KHÔNG có, admin CÓ (kèm step-up riêng) ──
  sect('2. RBAC refund theo vai trò');
  const om = await inviteMember(A.shopId, A.cookie, 'order_manager');
  const adm = await inviteMember(A.shopId, A.cookie, 'admin');
  r = await a.post(`/orders/${o4.id}/mark-paid`, {});
  r.status === 200 ? ok('chuẩn bị: o4 COD mark-paid → 200') : bad('mark-paid o4 lỗi', r.raw);
  r = await a.post(`/orders/${o4.id}/refund`, {}, om.cookie);
  r.status === 403 && r.json?.required === 'refund' && !r.json?.step_up_required
    ? ok('order_manager refund → 403 không đủ quyền (perm refund chỉ owner/admin)') : bad('order_manager refund sai', r.raw);
  r = await a.post(`/orders/${o4.id}/refund`, {}, adm.cookie);
  r.status === 403 && r.json?.step_up_required === true ? ok('admin CÓ perm nhưng chưa step-up → 403 step_up_required') : bad('admin refund thiếu gác', r.raw);
  await stepUp(adm.cookie, adm.password);
  before = await invOf(vid);
  r = await a.post(`/orders/${o4.id}/refund`, {}, adm.cookie);
  inv = await invOf(vid);
  r.status === 200 && Number(inv.reserved) === Number(before.reserved) - 1
    ? ok('admin + step-up refund → 200 (rbac.js: admin có refund), reserve −1') : bad('admin refund lỗi', r.raw);

  // ── 3. MARK-PAID-QR — chỉ owner (payment.write), chỉ đơn QR ───────────────
  sect('3. MARK-PAID-QR (fallback tay, chỉ owner)');
  r = await a.post(`/orders/${oq.id}/mark-paid-qr`, {}, adm.cookie);
  r.status === 403 && r.json?.required === 'payment.write'
    ? ok('admin mark-paid-qr → 403 (payment.write CHỈ owner — admin không nới được bất biến QR)') : bad('admin mark-paid-qr sai', r.raw);
  r = await a.post(`/orders/${oq.id}/mark-paid-qr`, {});
  r.status === 200 && r.json.payment_status === 'paid' ? ok('owner + step-up mark-paid-qr → 200 paid') : bad('mark-paid-qr lỗi', r.raw);
  let row = await orderRow(oq.id);
  row.payment_status === 'paid' && row.paid_at && row.status === 'pending'
    ? ok('DB: paid + paid_at đặt; status GIỮ pending (hợp đồng thật: KHÔNG tự confirm như webhook)') : bad(`DB sai: ${JSON.stringify(row)}`);
  r = await a.post(`/orders/${oq.id}/mark-paid-qr`, {});
  r.status === 409 && /đã thanh toán/.test(r.json?.error ?? '') ? ok('mark-paid-qr LẦN 2 → 409 (idempotent-guard)') : bad('double mark-paid-qr lọt', r.raw);
  r = await a.post(`/orders/${o2.id}/mark-paid-qr`, {});
  r.status === 409 && /chỉ đơn QR/.test(r.json?.error ?? '') ? ok('mark-paid-qr trên đơn COD → 409 (hợp đồng thật: 409, không phải 400)') : bad('COD lọt mark-paid-qr', r.raw);
  r = await a.post(`/orders/${oq.id}/mark-paid`, {});
  r.status === 409 && /chỉ đơn COD/.test(r.json?.error ?? '') ? ok('mark-paid (COD) trên đơn QR → 409 (hai đường không giẫm nhau)') : bad('QR lọt mark-paid COD', r.raw);
  before = await invOf(vid);
  r = await a.post(`/orders/${oq.id}/refund`, {});
  inv = await invOf(vid);
  r.status === 200 && Number(inv.reserved) === Number(before.reserved) - 1
    ? ok('refund đơn QR vừa xác nhận tay → 200, reserve −1 (đường QR hoàn được như COD)') : bad('refund QR lỗi', r.raw);

  // ── 4. RECONCILE — hàng đợi chưa khớp + resolve ───────────────────────────
  sect('4. RECONCILE (unmatched_transfers)');
  r = await a.post('/payment/sepay/enable', {});
  const tokenA = r.json?.token;
  r.status === 200 && tokenA ? ok('bật SePay per-shop → token (owner đã step-up)') : bad('enable sepay lỗi', r.raw);
  const evtId = `evt-mny-${uniq()}`;
  r = await webhookPerShop(tokenA, { id: evtId, transferType: 'in', transferAmount: 123000, content: 'chuyen tien khong co ma dinh danh', transactionDate: '2026-07-17 09:00:00' });
  const urow = (await owner.query(`SELECT id, reason, resolved_at, resolved_order_id FROM unmatched_transfers WHERE shop_id=$1 AND provider_event_id=$2`, [A.shopId, evtId])).rows[0];
  r.status === 200 && r.json.reason === 'no_ref' && urow?.reason === 'no_ref' && !urow.resolved_at
    ? ok('webhook không mã ref → GHI hàng đợi (no_ref, chưa resolve)') : bad('hàng đợi không ghi', r.raw + ' ' + JSON.stringify(urow));
  r = await a.get('/payment/reconcile', om.cookie);
  const listed = (r.json?.transfers ?? []).find((t) => t.id === urow.id);
  r.status === 200 && listed && listed.received_account === '****5678'
    ? ok('GET reconcile (thành viên thường xem được) — số tài khoản CHE 4 số cuối') : bad('list reconcile sai', r.raw);
  r = await a.post(`/payment/reconcile/${urow.id}/resolve`, {}, adm.cookie);
  r.status === 403 && r.json?.required === 'payment.write' ? ok('admin resolve → 403 (payment.write chỉ owner)') : bad('admin resolve sai', r.raw);
  r = await a.post(`/payment/reconcile/${urow.id}/resolve`, {});
  row = (await owner.query(`SELECT resolved_at, resolved_order_id FROM unmatched_transfers WHERE id=$1`, [urow.id])).rows[0];
  r.status === 200 && r.json.ok === true && row.resolved_at ? ok('owner resolve → 200, resolved_at đặt') : bad('resolve lỗi', r.raw);
  // HỢP ĐỒNG THẬT: resolve CHỈ đánh dấu đã-xử-lý — KHÔNG gắn đơn, KHÔNG đặt paid.
  // (cột resolved_order_id trong 0035 tồn tại nhưng code không ghi; tiền muốn vào đơn
  //  phải đi đường mark-paid-qr riêng — đã kiểm ở mục 3.)
  row.resolved_order_id === null ? ok('resolve KHÔNG gắn đơn/đặt paid (resolved_order_id NULL — hợp đồng thật)') : bad('resolve gắn đơn?', JSON.stringify(row));
  r = await a.post(`/payment/reconcile/${urow.id}/resolve`, {});
  r.status === 409 && /không tìm thấy hoặc đã xử lý/.test(r.json?.error ?? '') ? ok('resolve LẦN 2 → 409 (không double-apply)') : bad('double resolve lọt', r.raw);

  // Chéo shop: dòng của A không resolve được từ shop B (RLS) lẫn path shop A (membership).
  const row2 = (await owner.query(
    `INSERT INTO unmatched_transfers (shop_id, provider, provider_event_id, amount_vnd, content, received_account, reason, raw)
     VALUES ($1,'sepay',$2,50000,'ck le','${ACC}','no_ref','{}'::jsonb) RETURNING id`, [A.shopId, `evt-x-${uniq()}`])).rows[0];
  await stepUp(Bs.cookie, Bs.password);
  r = await rq(SELLER, 'POST', `/shops/${Bs.shopId}/payment/reconcile/${row2.id}/resolve`, { cookie: Bs.cookie, origin: OS });
  const still = (await owner.query(`SELECT resolved_at FROM unmatched_transfers WHERE id=$1`, [row2.id])).rows[0];
  r.status === 409 && still.resolved_at === null
    ? ok('owner B resolve dòng shop A qua path shop B → 409, dòng KHÔNG đổi (RLS)') : bad('RLS reconcile vỡ!', r.raw);
  r = await rq(SELLER, 'POST', `/shops/${A.shopId}/payment/reconcile/${row2.id}/resolve`, { cookie: Bs.cookie, origin: OS });
  r.status === 404 ? ok('owner B gọi path shop A → 404 (không phải thành viên, không lộ tồn tại)') : bad('membership gate vỡ', r.raw);

  // ── 5. HOÀN MỘT PHẦN — bút toán refunds (0070) ────────────────────────────
  sect('5. HOÀN MỘT PHẦN (bút toán refunds 0070)');
  // Hoàn TOÀN BỘ ở mục 1 (o1, total 230000) giờ cũng phải để lại bút toán đủ tổng.
  let rrows = (await owner.query(`SELECT amount_vnd FROM refunds WHERE order_id=$1`, [o1.id])).rows;
  rrows.length === 1 && Number(rrows[0].amount_vnd) === 230000
    ? ok('hoàn toàn bộ (mục 1) ghi 1 bút toán đủ tổng 230000') : bad('bút toán hoàn toàn bộ sai', JSON.stringify(rrows));

  await stepUp(A.cookie, A.password); // cửa sổ step-up có thể đã nguội sau các mục trên
  const o5 = await mkOrder(2); // total = 2×100000 + 30000 ship = 230000
  r = await a.post(`/orders/${o5.id}/mark-paid`, {});
  r.status === 200 ? ok('chuẩn bị: o5 COD mark-paid → 200') : bad('mark-paid o5 lỗi', r.raw);
  r = await a.post(`/orders/${o5.id}/refund`, { amount_vnd: 'abc' });
  r.status === 400 && /không hợp lệ/.test(r.json?.error ?? '') ? ok('amount rác → 400') : bad('amount rác lọt', r.raw);
  r = await a.post(`/orders/${o5.id}/refund`, { amount_vnd: -5 });
  r.status === 400 ? ok('amount âm → 400') : bad('amount âm lọt', r.raw);

  before = await invOf(vid);
  r = await a.post(`/orders/${o5.id}/refund`, { amount_vnd: 100000, reason: 'khách trả 1 món' });
  r.status === 200 && r.json.payment_status === 'paid' && r.json.refund_vnd === 100000 && r.json.refunded_total_vnd === 100000
    ? ok('hoàn MỘT PHẦN 100k → 200, đơn GIỮ paid, refunded_total=100k') : bad('hoàn một phần lỗi', r.raw);
  row = await orderRow(o5.id);
  row.payment_status === 'paid' && row.status === 'pending'
    ? ok('DB: đơn vẫn paid + pending sau hoàn một phần') : bad(`DB sai sau partial: ${JSON.stringify(row)}`);
  inv = await invOf(vid);
  Number(inv.reserved) === Number(before.reserved) && Number(inv.on_hand) === Number(before.on_hand)
    ? ok('hoàn một phần KHÔNG đụng tồn kho') : bad(`tồn bị đụng sau partial: ${inv.on_hand}/${inv.reserved}`);
  rrows = (await owner.query(`SELECT amount_vnd, reason FROM refunds WHERE order_id=$1 ORDER BY created_at`, [o5.id])).rows;
  rrows.length === 1 && Number(rrows[0].amount_vnd) === 100000 && rrows[0].reason === 'khách trả 1 món'
    ? ok('bút toán partial ghi amount + reason') : bad('bút toán partial sai', JSON.stringify(rrows));
  r = await a.get(`/orders/${o5.id}`);
  r.status === 200 && (r.json.refunds ?? []).length === 1 && r.json.refunded_total_vnd === 100000
    ? ok('getOrder trả refunds[] + refunded_total_vnd') : bad('getOrder thiếu refunds', r.raw);

  r = await a.post(`/orders/${o5.id}/refund`, { amount_vnd: 200000 });
  r.status === 422 && /vượt quá/.test(r.json?.error ?? '')
    ? ok('hoàn vượt số còn lại (100k+200k > 230k) → 422 tiếng Việt') : bad('over-refund lọt', r.raw);

  before = await invOf(vid);
  r = await a.post(`/orders/${o5.id}/refund`, { amount_vnd: 130000 });
  r.status === 200 && r.json.status === 'refunded' && r.json.payment_status === 'refunded' && r.json.refunded_total_vnd === 230000
    ? ok('partial thứ 2 chạm tổng (100k+130k=230k) → LẬT refunded') : bad('chạm tổng không lật', r.raw);
  inv = await invOf(vid);
  Number(inv.reserved) === Number(before.reserved) - 2 && Number(inv.on_hand) === Number(before.on_hand)
    ? ok('nhát lật từ pending → GIẢI PHÓNG reserve (−2) như hoàn toàn bộ') : bad(`tồn sau lật: ${inv.on_hand}/${inv.reserved}`);
  r = await a.get(`/orders/${o5.id}`);
  (r.json?.refunds ?? []).length === 2 && r.json?.refunded_total_vnd === 230000
    ? ok('lịch sử 2 bút toán, luỹ kế = tổng đơn') : bad('lịch sử sau lật sai', r.raw);
  r = await a.post(`/orders/${o5.id}/refund`, { amount_vnd: 1000 });
  r.status === 409 ? ok('hoàn tiếp sau khi đã lật refunded → 409') : bad('refund sau lật lọt', r.raw);

  // ── 6. BULK MARK-PAID COD (gom tiền cuối ngày) ────────────────────────────
  sect('6. BULK MARK-PAID (chỉ COD, bỏ qua QR/terminal)');
  const c1 = await mkOrder(1), c2 = await mkOrder(1), q1 = await mkOrder(1, 'qr');
  r = await a.post('/orders/bulk/mark-paid', { order_ids: [c1.id, c2.id, q1.id] });
  r.status === 200 && r.json.paid === 2 && r.json.skipped === 1
    ? ok('bulk mark-paid [COD,COD,QR] → paid=2, skipped=1 (QR không đi đường tay)') : bad('bulk mark-paid sai', r.raw);
  const rows2 = (await owner.query(`SELECT id, payment_status, paid_at FROM orders WHERE id = ANY($1)`, [[c1.id, c2.id, q1.id]])).rows;
  rows2.filter((x) => x.payment_status === 'paid' && x.paid_at).length === 2
    && rows2.find((x) => x.id === q1.id)?.payment_status === 'unpaid'
    ? ok('DB: 2 COD paid+paid_at, QR vẫn unpaid') : bad('DB bulk mark-paid sai', JSON.stringify(rows2));
  r = await a.post('/orders/bulk/mark-paid', { order_ids: [c1.id, c2.id] });
  r.status === 200 && r.json.paid === 0 && r.json.skipped === 2
    ? ok('bulk mark-paid lần 2 → idempotent (paid=0, skipped=2)') : bad('bulk mark-paid không idempotent', r.raw);
  r = await a.post('/orders/bulk/mark-paid', { order_ids: [] });
  r.status === 400 ? ok('danh sách rỗng → 400') : bad('rỗng lọt', r.raw);

  console.log(`\n${B}${pass} pass, ${fail} fail${X}`);
  await owner.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
