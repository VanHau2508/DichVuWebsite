/**
 * DỰNG LẠI 2 NGHI VẤN NẶNG NHẤT VỀ TIỀN (workflow phân tích chỉ ra, đây là bước CHỨNG MINH).
 *
 * Không tin phân tích, không tin đọc mã — chạy thật rồi soi DB.
 *   A. Nhận TRẢ HÀNG cho đơn khách CHƯA TRẢ ĐỒNG NÀO → có ghi phiếu hoàn không?
 *   B. Sửa đơn ĐÃ TRẢ rồi hoàn tiền → có bị TRỪ ĐÚP phần đã hoàn khi sửa không?
 * env: AUDIT_SLUG / AUDIT_EMAIL / AUDIT_PW
 */
import { SELLER, AUTH, OS, OA, owner, http, sessionOf, ok, warn, bad, sect, summary, uniq, sleep } from './lib.mjs';

const EMAIL = process.env.AUDIT_EMAIL, PW = process.env.AUDIT_PW, SLUG = process.env.AUDIT_SLUG;
const S = {};
const api = (path, opts = {}) => http(SELLER, path, { cookie: S.ck, origin: opts.body !== undefined ? OS : undefined, ...opts });
const stepUp = () => http(AUTH, '/auth/step-up', { method: 'POST', body: { password: PW }, cookie: S.ck, origin: OA, host: 'auth.localtest' });

// Tạo đơn TAY qua API seller (giá 100% server-side, y như checkout) rồi đẩy tới trạng thái muốn.
async function taoDon(vid, qty) {
  const r = await api(`/shops/${S.shopId}/orders`, { method: 'POST', body: {
    idempotency_key: `audit-${uniq()}-${uniq()}`,
    customer: { name: `Khách ${uniq()}`, phone: '0912345678', address_line: '1 Lê Lợi', province: 'TP. Hồ Chí Minh' },
    payment_method: 'cod', lines: [{ variant_id: vid, qty }] } });
  if (r.status !== 201) throw new Error(`không tạo được đơn: ${r.status} ${r.text.slice(0, 200)}`);
  return r.json.id ?? r.json.order?.id;
}
const q1 = async (sql, args) => (await owner.query(sql, args)).rows[0];

async function main() {
  const shop = await q1('SELECT id FROM shops WHERE slug=$1', [SLUG]);
  S.shopId = shop.id;
  S.ck = sessionOf((await http(AUTH, '/auth/login', { method: 'POST', body: { email: EMAIL, password: PW }, origin: OA, host: 'auth.localtest' })).sc);
  S.ck ? ok('đăng nhập chủ shop') : bad('không đăng nhập được');
  const v = await q1(`SELECT v.id, v.price_vnd FROM variants v JOIN products p ON p.id=v.product_id
     JOIN inventory_levels il ON il.variant_id=v.id
    WHERE p.shop_id=$1 AND p.status='active' AND il.on_hand-il.reserved >= 5 ORDER BY v.price_vnd DESC LIMIT 1`, [S.shopId]);
  if (!v) { bad('shop không có biến thể nào đủ tồn để dựng ca'); summary(); await owner.end(); return; }
  ok(`dùng biến thể giá ${v.price_vnd}đ`);

  // ── A. TRẢ HÀNG cho đơn CHƯA TRẢ TIỀN ────────────────────────────────────
  sect('A. Nhận trả hàng cho đơn khách CHƯA TRẢ ĐỒNG NÀO');
  const oidA = await taoDon(v.id, 3);
  for (const b of ['confirm', 'ship', 'deliver']) {
    await api(`/shops/${S.shopId}/orders/${oidA}/${b}`, { method: 'POST', body: b === 'ship' ? { carrier: 'ghtk', tracking_number: `T${uniq()}` } : {} });
  }
  let o = await q1('SELECT status, payment_status, amount_paid_vnd, total_vnd FROM orders WHERE id=$1', [oidA]);
  o.status === 'delivered' && o.payment_status === 'unpaid'
    ? ok(`dựng được cảnh: đơn ${o.total_vnd}đ đã GIAO nhưng CHƯA thu tiền (amount_paid=${o.amount_paid_vnd})`)
    : bad('không dựng được cảnh', JSON.stringify(o));

  await stepUp();
  const rA = await api(`/shops/${S.shopId}/orders/${oidA}/return`, { method: 'POST', body: { lines: [{ variant_id: v.id, qty: 1 }], restock: true } });
  const refA = await q1('SELECT coalesce(sum(amount_vnd),0)::bigint s, count(*)::int n FROM refunds WHERE order_id=$1', [oidA]);
  const oA = await q1('SELECT status, payment_status, amount_paid_vnd FROM orders WHERE id=$1', [oidA]);
  if (rA.status === 409) ok(`HỆ THỐNG CHẶN: ${rA.json?.error ?? ''} — không có lỗi`);
  else if (Number(refA.s) > 0) {
    bad(`NHẬN TRẢ HÀNG CHO ĐƠN CHƯA TRẢ TIỀN → ghi phiếu hoàn ${refA.s}đ (${refA.n} phiếu)`,
      `HTTP ${rA.status} · amount_paid_vnd bị đặt thành ${oA.amount_paid_vnd} (khách chưa trả đồng nào) · status=${oA.status}/${oA.payment_status}`);
  } else warn(`trả hàng qua (HTTP ${rA.status}) nhưng không ghi phiếu hoàn`, JSON.stringify(oA));

  // ── B. Sửa đơn ĐÃ TRẢ rồi hoàn tiền → trừ đúp? ───────────────────────────
  sect('B. Sửa đơn đã trả tiền rồi hoàn nốt — có bị TRỪ ĐÚP không?');
  const oidB = await taoDon(v.id, 5);
  await api(`/shops/${S.shopId}/orders/${oidB}/confirm`, { method: 'POST', body: {} });
  await api(`/shops/${S.shopId}/orders/${oidB}/mark-paid`, { method: 'POST', body: {} });
  let b0 = await q1('SELECT total_vnd, amount_paid_vnd, payment_status FROM orders WHERE id=$1', [oidB]);
  b0.payment_status === 'paid' ? ok(`đơn B đã thu ${b0.total_vnd}đ`) : bad('không đặt được paid', JSON.stringify(b0));
  const daThu = Number(b0.total_vnd);

  await stepUp();
  const rEdit = await api(`/shops/${S.shopId}/orders/${oidB}/edit-paid`, { method: 'POST', body: {
    customer: { name: 'Khách B', phone: '0912345678', address_line: '1 Lê Lợi', province: 'TP. Hồ Chí Minh' },
    lines: [{ variant_id: v.id, qty: 3 }] } });
  const b1 = await q1('SELECT total_vnd, amount_paid_vnd FROM orders WHERE id=$1', [oidB]);
  const ref1 = await q1(`SELECT coalesce(sum(amount_vnd),0)::bigint s, string_agg(kind||':'||amount_vnd, ' ') k FROM refunds WHERE order_id=$1`, [oidB]);
  rEdit.status === 200
    ? ok(`sửa xuống 3 món → total ${daThu}đ → ${b1.total_vnd}đ, đã hoàn chênh: ${ref1.k ?? '(không)'}`)
    : warn(`sửa đơn đã trả → HTTP ${rEdit.status}`, rEdit.text.slice(0, 160));

  if (rEdit.status === 200) {
    await stepUp();
    const rRef = await api(`/shops/${S.shopId}/orders/${oidB}/refund`, { method: 'POST', body: {} }); // để trống = hoàn nốt
    const ref2 = await q1('SELECT coalesce(sum(amount_vnd),0)::bigint s FROM refunds WHERE order_id=$1', [oidB]);
    const b2 = await q1('SELECT status, payment_status FROM orders WHERE id=$1', [oidB]);
    const conLai = Number(b1.total_vnd);           // số khách đáng được hoàn nốt
    const hoanThem = Number(ref2.s) - Number(ref1.s);
    const shopGiu = daThu - Number(ref2.s);
    if (hoanThem === conLai) ok(`hoàn nốt ĐÚNG ${hoanThem}đ — không trừ đúp`);
    else bad(`HOÀN THIẾU: bấm "hoàn toàn bộ" chỉ hoàn ${hoanThem}đ (đúng phải ${conLai}đ)`,
      `khách trả ${daThu}đ · tổng đã hoàn ${ref2.s}đ · SHOP GIỮ LẠI ${shopGiu}đ · đơn giờ ${b2.status}/${b2.payment_status}`);
    const rAgain = await api(`/shops/${S.shopId}/orders/${oidB}/refund`, { method: 'POST', body: {} });
    rAgain.status === 409 && shopGiu > 0
      ? bad(`NGÕ CỤT: hoàn lần nữa → 409 "${rAgain.json?.error ?? ''}" — ${shopGiu}đ của khách kẹt vĩnh viễn qua UI`)
      : ok(`còn đường hoàn tiếp (HTTP ${rAgain.status})`);
  }

  console.log(`\n  → đơn A=${oidA} · đơn B=${oidB}`);
  summary();
  await owner.end();
}
main().catch((e) => { console.error('VỠ:', e); process.exit(2); });
