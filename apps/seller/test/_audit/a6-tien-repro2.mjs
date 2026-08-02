/**
 * DỰNG LẠI 3 NGHI VẤN TIỀN CÒN NỢ (workflow chỉ ra, chưa ai chứng minh).
 *   C. Xác nhận đơn TRƯỚC khi tiền về → webhook có TỪ CHỐI tiền không?
 *   D. Sửa đơn có ĐỔI ĐIỂM → tổng có nhảy lên đúng bằng phần đã giảm không?
 *   E. Thu tiền có ghi amount_paid_vnd không, hay "đã thu" đang bị suy đoán?
 * env: AUDIT_SLUG / AUDIT_EMAIL / AUDIT_PW
 */
import { SELLER, AUTH, PAYMENT, OS, OA, owner, http, sessionOf, ok, warn, bad, sect, summary, uniq } from './lib.mjs';

const EMAIL = process.env.AUDIT_EMAIL, PW = process.env.AUDIT_PW, SLUG = process.env.AUDIT_SLUG;
const KEY = process.env.SEPAY_WEBHOOK_KEY ?? 'dev-sepay-secret-key-12345';
const S = {};
const api = (p, o = {}) => http(SELLER, p, { cookie: S.ck, origin: o.body !== undefined ? OS : undefined, ...o });
const stepUp = () => http(AUTH, '/auth/step-up', { method: 'POST', body: { password: PW }, cookie: S.ck, origin: OA, host: 'auth.localtest' });
const q1 = async (sql, a) => (await owner.query(sql, a)).rows[0];
const CUST = { name: 'Khách kiểm toán', phone: '0912345678', address_line: '1 Lê Lợi', province: 'TP. Hồ Chí Minh' };

async function taoDon(vid, qty, pm = 'cod') {
  const r = await api(`/shops/${S.shopId}/orders`, { method: 'POST', body: {
    idempotency_key: `a6-${uniq()}-${uniq()}`, customer: CUST, payment_method: pm, lines: [{ variant_id: vid, qty }] } });
  if (r.status !== 201) throw new Error(`tạo đơn lỗi ${r.status}: ${r.text.slice(0, 180)}`);
  return r.json.id ?? r.json.order?.id;
}

async function main() {
  S.shopId = (await q1('SELECT id FROM shops WHERE slug=$1', [SLUG])).id;
  S.ck = sessionOf((await http(AUTH, '/auth/login', { method: 'POST', body: { email: EMAIL, password: PW }, origin: OA, host: 'auth.localtest' })).sc);
  S.ck ? ok('đăng nhập chủ shop') : bad('không đăng nhập được');
  const v = await q1(`SELECT v.id, v.price_vnd FROM variants v JOIN products p ON p.id=v.product_id
     JOIN inventory_levels il ON il.variant_id=v.id
    WHERE p.shop_id=$1 AND p.status='active' AND il.on_hand-il.reserved >= 6 ORDER BY v.price_vnd DESC LIMIT 1`, [S.shopId]);
  if (!v) { bad('không đủ tồn để dựng ca'); summary(); await owner.end(); return; }

  // ── C. Xác nhận đơn TRƯỚC khi tiền về ────────────────────────────────────
  sect('C. Bấm "Xác nhận đơn" trước khi tiền về — webhook có nuốt tiền không?');
  const oidC = await taoDon(v.id, 2, 'qr');
  const c0 = await q1('SELECT status, payment_status, payment_ref, total_vnd, qr_account FROM orders WHERE id=$1', [oidC]);
  if (!c0.payment_ref) { warn('đơn QR không có payment_ref — bỏ ca C', JSON.stringify(c0)); }
  else {
    await api(`/shops/${S.shopId}/orders/${oidC}/confirm`, { method: 'POST', body: {} }); // ← bước UI CHỦ ĐỘNG MỜI
    const c1 = await q1('SELECT status FROM orders WHERE id=$1', [oidC]);
    ok(`đơn QR ${c0.total_vnd}đ · đã bấm Xác nhận → status=${c1.status} (khách vẫn chưa chuyển tiền)`);
    const wh = await http(PAYMENT, '/webhooks/sepay', { method: 'POST', host: 'hooks.localtest',
      headers: { authorization: `Apikey ${KEY}` },
      body: { id: `evt-${uniq()}`, transferType: 'in', transferAmount: Number(c0.total_vnd),
        content: `CK ${c0.payment_ref}`, accountNumber: c0.qr_account ?? '0123456789' } });
    const c2 = await q1('SELECT status, payment_status FROM orders WHERE id=$1', [oidC]);
    if (c2.payment_status === 'paid') ok(`tiền về sau khi đã xác nhận → vẫn ghi nhận paid`);
    else bad(`WEBHOOK TỪ CHỐI TIỀN vì đơn đã được xác nhận`,
      `HTTP ${wh.status} · ${JSON.stringify(wh.json)} · đơn vẫn ${c2.status}/${c2.payment_status} — khách ĐÃ CHUYỂN TIỀN THẬT`);
  }

  // ── D. Sửa đơn có ĐỔI ĐIỂM ───────────────────────────────────────────────
  sect('D. Sửa đơn có đổi điểm thưởng — tổng có tự nhảy lên không?');
  const oidD = await taoDon(v.id, 4);
  const d0 = await q1('SELECT total_vnd, subtotal_vnd, shipping_vnd, discount_vnd FROM orders WHERE id=$1', [oidD]);
  const diem = 50000;
  await owner.query(`UPDATE orders SET points_redeemed=$2::int, points_discount_vnd=$2::bigint, total_vnd=total_vnd-$2::bigint WHERE id=$1`, [oidD, diem]);
  const d1 = await q1('SELECT total_vnd, points_discount_vnd FROM orders WHERE id=$1', [oidD]);
  ok(`dựng đơn đã đổi ${diem}đ điểm: tổng ${d0.total_vnd} → ${d1.total_vnd}`);
  const rD = await api(`/shops/${S.shopId}/orders/${oidD}/edit`, { method: 'POST', body: {
    customer: { ...CUST, address_line: '2 Lê Lợi' }, lines: [{ variant_id: v.id, qty: 4 }] } }); // GIỮ NGUYÊN hàng, chỉ đổi địa chỉ
  const d2 = await q1('SELECT total_vnd, points_discount_vnd FROM orders WHERE id=$1', [oidD]);
  const nhay = Number(d2.total_vnd) - Number(d1.total_vnd);
  if (rD.status !== 200) warn(`sửa đơn → HTTP ${rD.status}`, rD.text.slice(0, 140));
  else if (nhay === 0) ok('sửa đơn không đụng tới giảm giá điểm — đúng');
  else bad(`SỬA ĐƠN XOÁ GIẢM GIÁ ĐIỂM: tổng nhảy +${nhay}đ (đúng bằng ${diem}đ đã đổi)`,
    `${d1.total_vnd} → ${d2.total_vnd} · points_discount_vnd vẫn ${d2.points_discount_vnd} nhưng KHÔNG được trừ · khách bị đòi thêm đúng số điểm đã dùng`);

  // ── E. Thu tiền có ghi amount_paid_vnd không? ────────────────────────────
  sect('E. Thu tiền COD — có ghi amount_paid_vnd không?');
  const oidE = await taoDon(v.id, 1);
  await api(`/shops/${S.shopId}/orders/${oidE}/confirm`, { method: 'POST', body: {} });
  await api(`/shops/${S.shopId}/orders/${oidE}/mark-paid`, { method: 'POST', body: {} });
  const e1 = await q1('SELECT payment_status, amount_paid_vnd, total_vnd FROM orders WHERE id=$1', [oidE]);
  e1.payment_status === 'paid' && Number(e1.amount_paid_vnd) === Number(e1.total_vnd)
    ? ok(`bấm "Đã nhận tiền" → ghi amount_paid_vnd=${e1.amount_paid_vnd}`)
    : warn(`thu tiền xong nhưng amount_paid_vnd=${e1.amount_paid_vnd} (total ${e1.total_vnd})`,
      '"đã thu" đang được SUY ĐOÁN từ total_vnd. Đúng khi khách trả vừa đủ; sai khi trả thừa/thiếu.');

  console.log(`\n  → C=${oidC} D=${oidD} E=${oidE}`);
  summary();
  await owner.end();
}
main().catch((e) => { console.error('VỠ:', e); process.exit(2); });
