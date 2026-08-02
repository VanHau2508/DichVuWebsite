/**
 * DỰNG LẠI: nhận trả hàng (RMA) trên đơn CÓ GIẢM GIÁ (coupon / điểm thưởng).
 *
 * createReturn tính hoàn = Σ(giá dòng × số lượng) — giá dòng là giá TRƯỚC giảm. Coupon và
 * điểm thưởng nằm ở HEADER đơn (discount_vnd, points_discount_vnd), hàm này không đọc.
 * Đơn không giảm giá thì Σ dòng = số đã thu nên mọi test cũ đều xanh.
 *   Ca A — trả MỘT PHẦN: hoàn thừa đúng bằng phần giảm giá phân bổ cho hàng trả?
 *   Ca B — trả TOÀN BỘ: Σ dòng > số đã thu → 422, tức KHÔNG nhận trả hàng được?
 * env: AUDIT_SLUG / AUDIT_EMAIL / AUDIT_PW
 */
import { SELLER, AUTH, OS, OA, owner, http, sessionOf, ok, warn, bad, sect, summary, uniq } from './lib.mjs';

const EMAIL = process.env.AUDIT_EMAIL, PW = process.env.AUDIT_PW, SLUG = process.env.AUDIT_SLUG;
const S = {};
const api = (p, o = {}) => http(SELLER, p, { cookie: S.ck, origin: o.body !== undefined ? OS : undefined, ...o });
const stepUp = () => http(AUTH, '/auth/step-up', { method: 'POST', body: { password: PW }, cookie: S.ck, origin: OA, host: 'auth.localtest' });
const q1 = async (sql, a) => (await owner.query(sql, a)).rows[0];
const CUST = { name: 'Khách RMA', phone: '0913334444', address_line: '9 Bà Triệu', province: 'Hà Nội' };

// Đơn 2 món, rồi ÉP header có giảm giá — đúng những gì checkout ghi khi khách dùng coupon.
async function donCoGiamGia(vid, qty, giam) {
  const r = await api(`/shops/${S.shopId}/orders`, { method: 'POST', body: {
    idempotency_key: `a9-${uniq()}-${uniq()}`, customer: CUST, payment_method: 'cod', lines: [{ variant_id: vid, qty }] } });
  if (r.status !== 201) throw new Error(`tạo đơn lỗi ${r.status}: ${r.text.slice(0, 160)}`);
  const id = r.json.id ?? r.json.order?.id;
  await owner.query(
    `UPDATE orders SET discount_vnd = $2::bigint, coupon_code = 'GIAMTEST', total_vnd = total_vnd - $2::bigint WHERE id = $1`,
    [id, giam]);
  for (const b of ['confirm', 'ship', 'deliver']) {
    await api(`/shops/${S.shopId}/orders/${id}/${b}`, { method: 'POST', body: b === 'ship' ? { carrier: 'tay', tracking_number: `T${uniq()}` } : {} });
  }
  // Khách trả đúng số tiền SAU giảm giá.
  await owner.query(
    `UPDATE orders SET payment_status='paid', paid_at=now(), amount_paid_vnd = total_vnd WHERE id=$1`, [id]);
  return id;
}

async function main() {
  S.shopId = (await q1('SELECT id FROM shops WHERE slug=$1', [SLUG])).id;
  S.ck = sessionOf((await http(AUTH, '/auth/login', { method: 'POST', body: { email: EMAIL, password: PW }, origin: OA, host: 'auth.localtest' })).sc);
  S.ck ? ok('đăng nhập chủ shop') : bad('không đăng nhập được');
  const v = await q1(`SELECT v.id, v.price_vnd FROM variants v JOIN products p ON p.id=v.product_id
     JOIN inventory_levels il ON il.variant_id=v.id
    WHERE p.shop_id=$1 AND p.status='active' AND il.on_hand-il.reserved >= 6 ORDER BY v.price_vnd DESC LIMIT 1`, [S.shopId]);
  if (!v) { bad('không đủ tồn'); summary(); await owner.end(); return; }
  const gia = Number(v.price_vnd);

  // ── Ca A: trả MỘT PHẦN (1 trong 2) trên đơn giảm 50% tiền hàng ──────────────
  sect('A. Trả 1 trong 2 món, đơn đã giảm 50% tiền hàng');
  const giamA = gia;                       // giảm đúng giá 1 món = 50% của 2 món
  const idA = await donCoGiamGia(v.id, 2, giamA);
  const oA = await q1('SELECT subtotal_vnd, discount_vnd, shipping_vnd, total_vnd, amount_paid_vnd FROM orders WHERE id=$1', [idA]);
  ok(`đơn: hàng ${oA.subtotal_vnd} − giảm ${oA.discount_vnd} + ship ${oA.shipping_vnd} = khách trả ${oA.amount_paid_vnd}`);

  await stepUp();
  const rA = await api(`/shops/${S.shopId}/orders/${idA}/return`, { method: 'POST', body: { lines: [{ variant_id: v.id, qty: 1 }], restock: true } });
  const refA = Number((await q1('SELECT coalesce(sum(amount_vnd),0)::bigint s FROM refunds WHERE order_id=$1', [idA])).s);
  // Công bằng: hàng trả trị giá `gia` trên tổng hàng `subtotal`, khách đã trả tiền-hàng
  // (subtotal − giảm) → hoàn = gia × (subtotal − giảm) / subtotal.
  const dung = Math.round(gia * (Number(oA.subtotal_vnd) - Number(oA.discount_vnd)) / Number(oA.subtotal_vnd));
  if (rA.status !== 200) warn(`trả hàng → HTTP ${rA.status}`, rA.text.slice(0, 140));
  else if (refA === dung) ok(`hoàn ĐÚNG ${refA}đ (đã phân bổ giảm giá)`);
  else bad(`HOÀN THỪA ${refA - dung}đ: ghi phiếu hoàn ${refA}đ, đúng phải ${dung}đ`,
    `khách trả ${oA.amount_paid_vnd}đ cho 2 món, trả lại 1 món mà shop hoàn ${refA}đ — khách giữ 1 món trị giá ${gia}đ gần như miễn phí`);

  // ── Ca B: trả TOÀN BỘ đơn có giảm giá ───────────────────────────────────────
  sect('B. Trả TOÀN BỘ đơn có giảm giá — có nhận được không?');
  const idB = await donCoGiamGia(v.id, 2, giamA);
  await stepUp();
  const rB = await api(`/shops/${S.shopId}/orders/${idB}/return`, { method: 'POST', body: { lines: [{ variant_id: v.id, qty: 2 }], restock: true } });
  const refB = Number((await q1('SELECT coalesce(sum(amount_vnd),0)::bigint s FROM refunds WHERE order_id=$1', [idB])).s);
  const oB = await q1('SELECT amount_paid_vnd, subtotal_vnd, discount_vnd, shipping_vnd FROM orders WHERE id=$1', [idB]);
  // Mốc đúng là tiền HÀNG khách trả, KHÔNG gồm phí ship — hoàn theo dòng hàng thì phí ship
  // giữ nguyên (hành vi vốn có, đơn không giảm giá cũng vậy). So với amount_paid là so sai mốc.
  const tienHang = Number(oB.subtotal_vnd) - Number(oB.discount_vnd);
  if (rB.status === 422) bad(`KHÔNG NHẬN TRẢ HÀNG ĐƯỢC cho đơn có coupon`, `HTTP 422 · ${rB.json?.error ?? ''} — khách trả hết hàng mà hệ thống chặn`);
  else if (rB.status === 200 && refB === tienHang) ok(`trả toàn bộ → hoàn đúng ${refB}đ = tiền hàng đã trả (giữ phí ship ${oB.shipping_vnd}đ)`);
  else bad(`trả toàn bộ → HTTP ${rB.status}, hoàn ${refB}đ (đúng phải ${tienHang}đ tiền hàng)`);

  console.log(`\n  → đơn A=${idA} B=${idB}`);
  summary();
  await owner.end();
}
main().catch((e) => { console.error('VỠ:', e); process.exit(2); });
