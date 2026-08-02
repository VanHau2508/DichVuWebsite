/**
 * DỰNG LẠI: hoàn tiền TOÀN BỘ một đơn GIAO MỘT PHẦN có nhả chỗ phần chưa gửi không?
 *
 * refundOrder chỉ nhả reserve khi đơn ở 'pending'/'confirmed' (orders.js:650) — đúng cho
 * đơn chưa gửi gì. Nhưng đơn TÁCH VẬN ĐƠN bỏ dở đang ở 'shipped' và vẫn giữ chỗ phần chưa
 * gửi. Hoàn toàn bộ → status thành 'refunded', mà markReturnedBomb (nơi DUY NHẤT biết nhả
 * phần chưa gửi) lại đòi status='shipped' → hết đường. Chỗ giữ kẹt vĩnh viễn = hàng có
 * trong kho nhưng không bán được.
 * env: AUDIT_SLUG / AUDIT_EMAIL / AUDIT_PW
 */
import { SELLER, AUTH, OS, OA, owner, http, sessionOf, ok, warn, bad, sect, summary, uniq } from './lib.mjs';

const EMAIL = process.env.AUDIT_EMAIL, PW = process.env.AUDIT_PW, SLUG = process.env.AUDIT_SLUG;
const S = {};
const api = (p, o = {}) => http(SELLER, p, { cookie: S.ck, origin: o.body !== undefined ? OS : undefined, ...o });
const stepUp = () => http(AUTH, '/auth/step-up', { method: 'POST', body: { password: PW }, cookie: S.ck, origin: OA, host: 'auth.localtest' });
const q1 = async (sql, a) => (await owner.query(sql, a)).rows[0];
const ton = async (vid) => q1('SELECT on_hand, reserved, (on_hand-reserved) AS ban_duoc FROM inventory_levels WHERE variant_id=$1', [vid]);

async function main() {
  S.shopId = (await q1('SELECT id FROM shops WHERE slug=$1', [SLUG])).id;
  S.ck = sessionOf((await http(AUTH, '/auth/login', { method: 'POST', body: { email: EMAIL, password: PW }, origin: OA, host: 'auth.localtest' })).sc);
  S.ck ? ok('đăng nhập chủ shop') : bad('không đăng nhập được');
  const v = await q1(`SELECT v.id FROM variants v JOIN products p ON p.id=v.product_id
     JOIN inventory_levels il ON il.variant_id=v.id
    WHERE p.shop_id=$1 AND p.status='active' AND il.on_hand-il.reserved >= 6
      AND EXISTS (SELECT 1 FROM variant_option_values x WHERE x.variant_id=v.id)
    ORDER BY il.on_hand DESC LIMIT 1`, [S.shopId])
    ?? await q1(`SELECT v.id FROM variants v JOIN products p ON p.id=v.product_id
     JOIN inventory_levels il ON il.variant_id=v.id
    WHERE p.shop_id=$1 AND p.status='active' AND il.on_hand-il.reserved >= 6 ORDER BY il.on_hand DESC LIMIT 1`, [S.shopId]);
  if (!v) { bad('không đủ tồn'); summary(); await owner.end(); return; }

  sect('Hoàn tiền đơn TÁCH VẬN ĐƠN bỏ dở — chỗ giữ phần chưa gửi đi đâu?');
  const t0 = await ton(v.id);
  const od = await api(`/shops/${S.shopId}/orders`, { method: 'POST', body: {
    idempotency_key: `a12-${uniq()}-${uniq()}`,
    customer: { name: 'Khách tách kiện', phone: '0919992222', address_line: '7 Trần Hưng Đạo', province: 'Hà Nội' },
    payment_method: 'cod', lines: [{ variant_id: v.id, qty: 5 }] } });
  if (od.status !== 201) { bad(`tạo đơn lỗi ${od.status}`, od.text.slice(0, 160)); summary(); await owner.end(); return; }
  const oid = od.json.id ?? od.json.order?.id;
  await api(`/shops/${S.shopId}/orders/${oid}/confirm`, { method: 'POST', body: {} });
  const olid = (await q1('SELECT id FROM order_lines WHERE order_id=$1', [oid])).id;

  // Gửi 3/5 rồi thôi (đơn tách kiện bỏ dở) → còn giữ chỗ 2.
  const rs = await api(`/shops/${S.shopId}/orders/${oid}/ship`, { method: 'POST', body: {
    carrier: 'tay', tracking_number: `T${uniq()}`, lines: [{ order_line_id: olid, qty: 3 }] } });
  const st = await q1('SELECT status FROM orders WHERE id=$1', [oid]);
  const ln = await q1('SELECT qty, shipped_qty FROM order_lines WHERE id=$1', [olid]);
  const t1 = await ton(v.id);
  rs.status === 200 && st.status === 'shipped' && Number(ln.shipped_qty) === 3
    ? ok(`gửi 3/5 → đơn ${st.status}, còn giữ chỗ ${Number(t1.reserved) - Number(t0.reserved)} cho phần chưa gửi`)
    : bad('không dựng được cảnh tách kiện bỏ dở', `${rs.status} ${rs.text.slice(0, 140)} st=${st.status} shipped=${ln.shipped_qty}`);

  // Khách đã trả tiền, rồi shop hoàn TOÀN BỘ.
  await owner.query(`UPDATE orders SET payment_status='paid', paid_at=now(), amount_paid_vnd=total_vnd WHERE id=$1`, [oid]);
  await stepUp();
  const rr = await api(`/shops/${S.shopId}/orders/${oid}/refund`, { method: 'POST', body: {} });
  const st2 = await q1('SELECT status, payment_status FROM orders WHERE id=$1', [oid]);
  const t2 = await ton(v.id);
  const ketLai = Number(t2.reserved) - Number(t0.reserved);
  if (rr.status !== 200) { warn(`hoàn tiền → HTTP ${rr.status}`, rr.text.slice(0, 140)); summary(); await owner.end(); return; }
  ketLai === 0
    ? ok(`hoàn toàn bộ → nhả hết chỗ giữ (đơn ${st2.status}), tồn bán được về ${t2.ban_duoc}`)
    : bad(`CHỖ GIỮ KẸT: hoàn toàn bộ xong vẫn giữ ${ketLai} suất của phần chưa gửi`,
      `đơn ${st2.status}/${st2.payment_status} · bán được ${t0.ban_duoc} → ${t2.ban_duoc} (mất ${Number(t0.ban_duoc) - Number(t2.ban_duoc)} suất bán)`);

  // Còn đường gỡ không? markReturnedBomb là nơi DUY NHẤT biết nhả phần chưa gửi.
  if (ketLai !== 0) {
    const rb = await api(`/shops/${S.shopId}/orders/${oid}/mark-returned`, { method: 'POST', body: { restock: false } });
    rb.status === 200
      ? ok('vẫn "Đánh dấu hoàn về" được để gỡ chỗ giữ')
      : bad(`NGÕ CỤT: "Đánh dấu hoàn về" cũng chặn → HTTP ${rb.status} "${rb.json?.error ?? ''}"`,
        'chỗ giữ kẹt vĩnh viễn — hàng nằm trong kho mà không bán được, không thao tác nào gỡ ra');
  }

  console.log(`\n  → đơn=${oid} biến thể=${v.id}`);
  summary();
  await owner.end();
}
main().catch((e) => { console.error('VỠ:', e); process.exit(2); });
