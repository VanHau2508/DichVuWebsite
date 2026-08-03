/**
 * DỰNG LẠI: SỬA ĐƠN xuống thấp trong khi MÃ GIẢM GIÁ giữ nguyên số tuyệt đối.
 *
 * Checkout KẸP giảm giá: `Math.max(0, Math.min(raw, subtotal))` (checkout/server.js:315) và
 * còn chặn `subtotal < min_subtotal_vnd` (dòng 327). Đường SỬA ĐƠN thì bê nguyên
 * `o.discount_vnd` sang subtotal MỚI (seller/orders.js:998) — không kẹp lại, không xét lại
 * điều kiện đơn tối thiểu. Nghĩa là bất biến "giảm giá ≤ tiền hàng" mà checkout giữ, đường
 * sửa đơn phá được.
 *   Ca A — mã GIẢM SỐ TIỀN: đơn 3 món dùng mã giảm = giá 2 món, sửa còn 1 món.
 *           Kỳ vọng ĐÚNG: giảm bị kẹp ≤ tiền hàng mới. Nếu không: khách ôm hàng, trả mỗi ship.
 *   Ca B — mã có ĐƠN TỐI THIỂU: sửa xuống dưới ngưỡng, mã vẫn ăn nguyên.
 * env: AUDIT_SLUG / AUDIT_EMAIL / AUDIT_PW
 */
import { SELLER, AUTH, OS, OA, owner, http, sessionOf, ok, warn, bad, sect, summary, uniq } from './lib.mjs';

const EMAIL = process.env.AUDIT_EMAIL, PW = process.env.AUDIT_PW, SLUG = process.env.AUDIT_SLUG;
const S = {};
const api = (p, o = {}) => http(SELLER, p, { cookie: S.ck, origin: o.body !== undefined ? OS : undefined, ...o });
const q1 = async (sql, a) => (await owner.query(sql, a)).rows[0];
const CUST = { name: 'Khách sửa đơn', phone: '0913335555', address_line: '14 Lý Thường Kiệt', province: 'Hà Nội' };

// Đơn N món rồi ÉP header mang mã giảm giá — y như checkout ghi khi khách dùng mã.
async function donCoMa(vid, qty, giam) {
  const r = await api(`/shops/${S.shopId}/orders`, { method: 'POST', body: {
    idempotency_key: `a14-${uniq()}-${uniq()}`, customer: CUST, payment_method: 'cod', lines: [{ variant_id: vid, qty }] } });
  if (r.status !== 201) throw new Error(`tạo đơn lỗi ${r.status}: ${r.text.slice(0, 200)}`);
  const id = r.json.id ?? r.json.order?.id;
  await owner.query(
    `UPDATE orders SET discount_vnd = $2::bigint, coupon_code = 'A14MA', total_vnd = total_vnd - $2::bigint WHERE id = $1`,
    [id, giam]);
  return id;
}

async function main() {
  S.shopId = (await q1('SELECT id FROM shops WHERE slug=$1', [SLUG])).id;
  S.ck = sessionOf((await http(AUTH, '/auth/login', { method: 'POST', body: { email: EMAIL, password: PW }, origin: OA, host: 'auth.localtest' })).sc);
  S.ck ? ok('đăng nhập chủ shop') : bad('không đăng nhập được');
  // Phải LOẠI biến thể MỒ CÔI (tổ hợp cũ mất ánh xạ sau khi shop thu hẹp phân loại) — đơn
  // gõ tay từ chối chúng bằng 422, và đó không phải cái đang đo.
  const v = await q1(`SELECT v.id, v.price_vnd FROM variants v JOIN products p ON p.id=v.product_id
     JOIN inventory_levels il ON il.variant_id=v.id
    WHERE p.shop_id=$1 AND p.status='active' AND p.deleted_at IS NULL AND il.on_hand-il.reserved >= 8
      AND NOT EXISTS (SELECT 1 FROM product_options po WHERE po.product_id = v.product_id
        AND NOT EXISTS (SELECT 1 FROM variant_option_values vov WHERE vov.variant_id = v.id AND vov.option_id = po.id))
    ORDER BY v.price_vnd DESC LIMIT 1`, [S.shopId]);
  if (!v) { bad('không đủ tồn'); summary(); await owner.end(); return; }
  const gia = Number(v.price_vnd);

  // ── Ca A: mã giảm SỐ TIỀN bằng giá 2 món; sửa đơn 3 món → còn 1 món ─────────
  sect('A. Sửa đơn 3 món → 1 món, mã giảm = giá 2 món');
  const giam = gia * 2;
  const idA = await donCoMa(v.id, 3, giam);
  const o0 = await q1('SELECT subtotal_vnd, discount_vnd, shipping_vnd, total_vnd FROM orders WHERE id=$1', [idA]);
  ok(`trước sửa: hàng ${o0.subtotal_vnd} − giảm ${o0.discount_vnd} + ship ${o0.shipping_vnd} = ${o0.total_vnd}`);

  const rA = await api(`/shops/${S.shopId}/orders/${idA}/edit`, { method: 'POST', body: {
    customer: CUST, lines: [{ variant_id: v.id, qty: 1 }] } });
  const o1 = await q1('SELECT subtotal_vnd, discount_vnd, shipping_vnd, total_vnd FROM orders WHERE id=$1', [idA]);
  ok(`sửa đơn → ${rA.status}; sau sửa: hàng ${o1.subtotal_vnd} − giảm ${o1.discount_vnd} + ship ${o1.shipping_vnd} = ${o1.total_vnd}`);

  const hang = Number(o1.subtotal_vnd), giamSau = Number(o1.discount_vnd), ship = Number(o1.shipping_vnd);
  if (rA.status >= 400) {
    ok(`chặn tại API (${rA.status}: ${String(rA.json?.error ?? rA.text).slice(0, 90)}) — không phá được bất biến`);
  } else if (giamSau > hang) {
    bad(`GIẢM GIÁ (${giamSau}) VƯỢT TIỀN HÀNG (${hang}) — checkout kẹp min(raw, subtotal), sửa đơn thì không`);
    bad(`  → khách nhận hàng trị giá ${hang}, chỉ phải trả ${Number(o1.total_vnd)} (ship ${ship}). Shop mất ${hang - Math.max(0, Number(o1.total_vnd) - ship)}`);
  } else {
    ok(`giảm ${giamSau} ≤ tiền hàng ${hang} — bất biến còn`);
  }

  // ── Ca B: mã có ĐƠN TỐI THIỂU, sửa xuống dưới ngưỡng ───────────────────────
  sect('B. Mã đòi đơn tối thiểu; sửa xuống DƯỚI ngưỡng');
  // Mã thật trong bảng coupons để đọc lại được điều kiện — kiểm cả hướng "có tra lại không".
  const code = `A14MIN${uniq()}`.toUpperCase().slice(0, 20);
  await owner.query(
    `INSERT INTO coupons (shop_id, code, kind, value, min_subtotal_vnd, active)
     VALUES ($1, $2, 'fixed', $3::bigint, $4::bigint, true)`, [S.shopId, code, gia, gia * 4]);
  const idB = await donCoMa(v.id, 5, gia);
  await owner.query(`UPDATE orders SET coupon_code = $2 WHERE id = $1`, [idB, code]);
  const rB = await api(`/shops/${S.shopId}/orders/${idB}/edit`, { method: 'POST', body: {
    customer: CUST, lines: [{ variant_id: v.id, qty: 1 }] } });
  const oB = await q1('SELECT subtotal_vnd, discount_vnd, total_vnd FROM orders WHERE id=$1', [idB]);
  ok(`sửa đơn → ${rB.status}; hàng ${oB.subtotal_vnd} (ngưỡng mã ${gia * 4}) − giảm ${oB.discount_vnd}`);
  if (rB.status < 400 && Number(oB.discount_vnd) > 0 && Number(oB.subtotal_vnd) < gia * 4) {
    warn(`mã đòi đơn từ ${gia * 4} nhưng đơn sửa còn ${oB.subtotal_vnd} vẫn ăn giảm ${oB.discount_vnd} — không tra lại điều kiện`);
  } else {
    ok('điều kiện đơn tối thiểu được xét lại (hoặc bị chặn)');
  }

  await owner.query(`DELETE FROM coupons WHERE shop_id=$1 AND code=$2`, [S.shopId, code]);
  summary();
  await owner.end();
}
main().catch(async (e) => { bad(`NGOẠI LỆ: ${e.message}`); summary(); await owner.end(); process.exit(1); });
