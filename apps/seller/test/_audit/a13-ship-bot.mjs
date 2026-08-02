/**
 * DỰNG LẠI: phí ship đơn KHÔNG QUA WEB (bot Messenger / nhân viên gõ tay) có thu đủ
 * PHỤ PHÍ CÂN như checkout web không?
 *
 * shopShipFee trước đây chỉ đọc ship_fee_vnd + free_ship_threshold_vnd, bỏ
 * ship_extra_per_500g_vnd mà checkout web đang thu → shop thu THIẾU trên mọi đơn bot.
 * Hai điều phải đúng cùng lúc:
 *   (1) báo giá bot == số thu lúc tạo đơn (nếu không: bot hứa một đằng thu một nẻo);
 *   (2) số đó == phí checkout web tính cho cùng giỏ hàng (nếu không: hai kênh hai giá).
 * env: AUDIT_SLUG / AUDIT_EMAIL / AUDIT_PW
 */
import { SELLER, AUTH, OS, OA, owner, http, sessionOf, ok, warn, bad, sect, summary, uniq } from './lib.mjs';

const EMAIL = process.env.AUDIT_EMAIL, PW = process.env.AUDIT_PW, SLUG = process.env.AUDIT_SLUG;
const S = {};
const api = (p, o = {}) => http(SELLER, p, { cookie: S.ck, origin: o.body !== undefined ? OS : undefined, ...o });
const q1 = async (sql, a) => (await owner.query(sql, a)).rows[0];

async function main() {
  S.shopId = (await q1('SELECT id FROM shops WHERE slug=$1', [SLUG])).id;
  S.ck = sessionOf((await http(AUTH, '/auth/login', { method: 'POST', body: { email: EMAIL, password: PW }, origin: OA, host: 'auth.localtest' })).sc);
  S.ck ? ok('đăng nhập chủ shop') : bad('không đăng nhập được');

  const v = await q1(`SELECT v.id, v.price_vnd FROM variants v JOIN products p ON p.id=v.product_id
     JOIN inventory_levels il ON il.variant_id=v.id
    WHERE p.shop_id=$1 AND p.status='active' AND il.on_hand-il.reserved >= 5 ORDER BY v.price_vnd LIMIT 1`, [S.shopId]);
  if (!v) { bad('không đủ tồn'); summary(); await owner.end(); return; }

  // Cấu hình shop: phí phẳng 30k, phụ phí 10k mỗi 500g, cân mặc định 600g, KHÔNG freeship.
  const cu = await q1(`SELECT ship_fee_vnd, ship_extra_per_500g_vnd, default_weight_gram, free_ship_threshold_vnd FROM shops WHERE id=$1`, [S.shopId]);
  await owner.query(
    `UPDATE shops SET ship_fee_vnd=30000, ship_extra_per_500g_vnd=10000, default_weight_gram=600,
            free_ship_threshold_vnd=NULL WHERE id=$1`, [S.shopId]);
  await owner.query(`UPDATE variants SET weight_gram=NULL WHERE id=$1`, [v.id]);

  sect('Phụ phí cân: 3 món × 600g = 1800g → vượt 500g đầu 1300g → 3 bậc × 10.000 = 30.000');
  const QTY = 3, grams = QTY * 600;
  const phuPhi = Math.ceil(Math.max(0, grams - 500) / 500) * 10000;
  const kyVong = 30000 + phuPhi;

  // (1) BÁO GIÁ mà bot nhận được — tạo khoá kết nối mới để lấy token thô (DB chỉ lưu hash).
  await http(AUTH, '/auth/step-up', { method: 'POST', body: { password: PW }, cookie: S.ck, origin: OA, host: 'auth.localtest' });
  const mk = await api(`/shops/${S.shopId}/api-keys`, { method: 'POST', body: { name: `a13-${uniq()}` } });
  const token = mk.json?.token ?? mk.json?.key ?? null;
  const sub = Number(v.price_vnd) * QTY;
  const quote = token ? await http(SELLER, `/ingest/shipping-quote?subtotal=${sub}&items=${v.id}:${QTY}`,
    { headers: { authorization: `Bearer ${token}` } }) : { status: 0, json: null };
  const baoGia = quote.status === 200 ? Number(quote.json.shipping_vnd) : null;

  // (2) SỐ THU khi tạo đơn (đường nhân viên gõ tay — cùng hàm shopShipFee).
  const od = await api(`/shops/${S.shopId}/orders`, { method: 'POST', body: {
    idempotency_key: `a13-${uniq()}-${uniq()}`,
    customer: { name: 'Khách cân nặng', phone: '0916665555', address_line: '1 Nguyễn Trãi', province: 'Cà Mau' },
    payment_method: 'cod', lines: [{ variant_id: v.id, qty: QTY }] } });
  const soThu = od.status === 201 ? Number((await q1('SELECT shipping_vnd FROM orders WHERE id=$1', [od.json.id ?? od.json.order?.id])).shipping_vnd) : null;

  soThu === kyVong
    ? ok(`số THU đúng ${soThu}đ = 30.000 phẳng + ${phuPhi} phụ phí cân (${grams}g)`)
    : bad(`THU THIẾU phụ phí cân: thu ${soThu}đ, đúng phải ${kyVong}đ`, `đơn ${od.status} · thiếu ${kyVong - (soThu ?? 0)}đ mỗi đơn`);

  if (baoGia == null) warn(`không gọi được /ingest/shipping-quote (HTTP ${quote.status}) — cần token khoá kết nối, bỏ qua đối chiếu`);
  else baoGia === soThu
    ? ok(`BÁO GIÁ bot (${baoGia}đ) == số THU (${soThu}đ) — bot không hứa sai`)
    : bad(`BOT HỨA MỘT ĐẰNG THU MỘT NẺO: báo ${baoGia}đ, thu ${soThu}đ`);

  await owner.query(
    `UPDATE shops SET ship_fee_vnd=$2, ship_extra_per_500g_vnd=$3, default_weight_gram=$4, free_ship_threshold_vnd=$5 WHERE id=$1`,
    [S.shopId, cu.ship_fee_vnd, cu.ship_extra_per_500g_vnd, cu.default_weight_gram, cu.free_ship_threshold_vnd]);
  ok('đã trả cấu hình ship về như cũ');
  summary();
  await owner.end();
}
main().catch((e) => { console.error('VỠ:', e); process.exit(2); });
