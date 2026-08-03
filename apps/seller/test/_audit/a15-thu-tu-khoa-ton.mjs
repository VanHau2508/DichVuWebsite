/**
 * ĐO ĐIỀU KIỆN TIÊN QUYẾT của một nghi vấn DEADLOCK — chưa kết luận gì về deadlock.
 *
 * Nghi vấn: ba vòng nhả/tiêu tồn khoá dòng inventory_levels theo thứ tự do
 * `SELECT ... FROM order_lines WHERE order_id = $1` trả về, mà truy vấn đó KHÔNG có ORDER BY:
 *   · cancelOrderTx      (apps/seller/src/orders.js:434)
 *   · refundOrder        (apps/seller/src/orders.js:659)
 *   · sweepExpired       (apps/worker/src/index.js:791 — tệ nhất: 200 đơn trong MỘT giao dịch)
 * Bốn chỗ còn lại thì CÓ sắp xếp (bom hàng ORDER BY, RMA .sort, sửa đơn allVids.sort,
 * checkout [...new Set()].sort() — chính là bản vá "diệt deadlock" đã làm trước đây).
 *
 * Deadlock chỉ xảy ra khi HAI giao dịch khoá CÙNG hai biến thể theo THỨ TỰ NGƯỢC NHAU.
 * Nên câu hỏi phải trả lời TRƯỚC là: hai đơn cùng chứa X và Y, thêm vào giỏ theo thứ tự
 * ngược nhau, thì truy vấn không-ORDER-BY kia có trả về thứ tự ngược nhau không?
 *
 * Nếu KHÔNG (Postgres luôn trả cùng thứ tự, vd theo ctid ~ thứ tự chèn của từng đơn riêng)
 * thì nghi vấn YẾU đi rất nhiều và tôi phải nói vậy, chứ không vá cho có.
 *
 * env: AUDIT_SLUG / AUDIT_EMAIL / AUDIT_PW
 */
import { SELLER, AUTH, CHECKOUT, OS, OA, owner, http, sessionOf, ok, warn, bad, sect, summary, uniq } from './lib.mjs';

const EMAIL = process.env.AUDIT_EMAIL, PW = process.env.AUDIT_PW, SLUG = process.env.AUDIT_SLUG;
const S = {};
const api = (p, o = {}) => http(SELLER, p, { cookie: S.ck, origin: o.body !== undefined ? OS : undefined, ...o });
const q = async (sql, a) => (await owner.query(sql, a)).rows;
const CUST = { name: 'Khách thứ tự', phone: '0913336666', address_line: '5 Hai Bà Trưng', province: 'Hà Nội' };

async function donVoiThuTu(vids) {
  const r = await api(`/shops/${S.shopId}/orders`, { method: 'POST', body: {
    idempotency_key: `a15-${uniq()}-${uniq()}`, customer: CUST, payment_method: 'cod',
    lines: vids.map((v) => ({ variant_id: v, qty: 1 })) } });
  if (r.status !== 201) throw new Error(`tạo đơn lỗi ${r.status}: ${r.text.slice(0, 180)}`);
  return r.json.id ?? r.json.order?.id;
}

async function main() {
  S.shopId = (await q('SELECT id FROM shops WHERE slug=$1', [SLUG]))[0].id;
  S.ck = sessionOf((await http(AUTH, '/auth/login', { method: 'POST', body: { email: EMAIL, password: PW }, origin: OA, host: 'auth.localtest' })).sc);
  S.ck ? ok('đăng nhập chủ shop') : bad('không đăng nhập được');

  const vs = await q(`SELECT v.id FROM variants v JOIN products p ON p.id=v.product_id
     JOIN inventory_levels il ON il.variant_id=v.id
    WHERE p.shop_id=$1 AND p.status='active' AND p.deleted_at IS NULL AND il.on_hand-il.reserved >= 4
      AND NOT EXISTS (SELECT 1 FROM product_options po WHERE po.product_id = v.product_id
        AND NOT EXISTS (SELECT 1 FROM variant_option_values vov WHERE vov.variant_id = v.id AND vov.option_id = po.id))
    ORDER BY v.id LIMIT 2`, [S.shopId]);
  if (vs.length < 2) { bad('cần 2 biến thể còn tồn'); summary(); await owner.end(); return; }
  const [X, Y] = [vs[0].id, vs[1].id];   // X < Y theo thứ tự uuid
  ok(`hai biến thể: X=${X.slice(0, 8)} < Y=${Y.slice(0, 8)}`);

  // ĐƯỜNG GÕ TAY (seller /orders) chèn dòng theo variant_id ĐÃ SẮP XẾP (orders.js:820) →
  // hai đơn luôn cùng thứ tự. ĐO Ở ĐÂY LÀ ĐO NHẦM ĐƯỜNG. Đường của KHÁCH THẬT (checkout)
  // chèn theo `ORDER BY ci.created_at` = thứ tự BỎ VÀO GIỎ (checkout/server.js:859) —
  // đó mới là chỗ thứ tự có thể khác nhau giữa hai đơn.
  sect('Đường GÕ TAY: chèn theo variant_id đã sắp xếp → luôn cùng thứ tự (không phải chỗ hở)');
  const idM1 = await donVoiThuTu([X, Y]);
  const idM2 = await donVoiThuTu([Y, X]);
  const thuTu = async (id) => (await q(`SELECT variant_id FROM order_lines WHERE order_id = $1`, [id]))
    .map((r) => (r.variant_id === X ? 'X' : 'Y')).join(' → ');
  const m1 = await thuTu(idM1), m2 = await thuTu(idM2);
  m1 === m2 ? ok(`đơn gõ tay: cả hai đều ${m1} — đúng như mã, đường này KHÔNG hở`)
    : bad('đơn gõ tay cũng ngược thứ tự?', `${m1} vs ${m2}`);

  sect('Đường KHÁCH THẬT (checkout): thứ tự dòng = thứ tự bỏ vào giỏ');
  const dom = (await q(`SELECT hostname FROM domains WHERE shop_id=$1 AND is_primary ORDER BY created_at LIMIT 1`, [S.shopId]))[0]?.hostname;
  if (!dom) { bad('shop chưa có tên miền để checkout'); summary(); await owner.end(); return; }
  const co = (path, opt = {}) => http(CHECKOUT, path, { host: dom, origin: `https://${dom}`, ...opt });
  async function donKhach(vids, phone) {
    let tok = null;
    for (const vid of vids) {
      const r = await co('/cart/items', { method: 'POST', body: { variant_id: vid, qty: 1 }, cookie: tok ? `__Host-cart=${tok}` : undefined, rawCookie: true });
      tok = /__Host-cart=([^;]*)/.exec((r.sc ?? []).join(';'))?.[1] ?? tok;
    }
    const r = await co('/checkout', { method: 'POST', cookie: `__Host-cart=${tok}`, rawCookie: true,
      headers: { 'idempotency-key': `a15-${uniq()}-${uniq()}` },
      body: { customer: { name: 'Khách giỏ', phone, email: 'k@x.vn' }, address: { line: 'x', province: 'Hà Nội' }, payment_method: 'cod' } });
    if (r.status !== 201) throw new Error(`checkout lỗi ${r.status}: ${r.text.slice(0, 200)}`);
    return (await q(`SELECT id FROM orders WHERE shop_id=$1 AND order_number=$2`, [S.shopId, r.json.order_number]))[0].id;
  }
  const idC1 = await donKhach([X, Y], '0913337001');   // khách 1: bỏ X trước
  const idC2 = await donKhach([Y, X], '0913337002');   // khách 2: bỏ Y trước
  const c1 = await thuTu(idC1), c2 = await thuTu(idC2);
  ok(`khách 1 (bỏ X trước) → dòng đơn: ${c1}`);
  ok(`khách 2 (bỏ Y trước) → dòng đơn: ${c2}`);
  c1 !== c2
    ? bad('THỨ TỰ NGƯỢC NHAU giữa hai đơn khách thật → huỷ/hoàn/quét-hết-hạn song song khoá chéo được = deadlock CÓ THẬT')
    : warn('cùng thứ tự — nghi vấn YẾU, không vá theo cảm tính');

  summary();
  await owner.end();
}
main().catch(async (e) => { bad(`NGOẠI LỆ: ${e.message}`); summary(); await owner.end(); process.exit(1); });
