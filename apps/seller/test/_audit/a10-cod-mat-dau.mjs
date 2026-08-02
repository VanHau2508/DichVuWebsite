/**
 * DỰNG LẠI: đơn COD giao QUA HÃNG, sau khi hoàn tiền / nhận trả hàng thì có còn
 * đối soát được với hãng không?
 *
 * Sổ "hãng còn nợ tiền" định nghĩa bằng o.status='delivered' (cod.js:26), còn refundOrder
 * và createReturn thì ĐẨY đơn ra khỏi 'delivered' ('refunded' / 'returned'). Hai bên không
 * biết nhau. Nếu đúng: đơn rơi khỏi sổ, và recordRemittance chặn cứng non-delivered → tiền
 * hãng đang giữ mất dấu vĩnh viễn.
 * env: AUDIT_SLUG / AUDIT_EMAIL / AUDIT_PW
 */
import { SELLER, AUTH, OS, OA, owner, http, sessionOf, ok, warn, bad, sect, summary, uniq } from './lib.mjs';

const EMAIL = process.env.AUDIT_EMAIL, PW = process.env.AUDIT_PW, SLUG = process.env.AUDIT_SLUG;
const S = {};
const api = (p, o = {}) => http(SELLER, p, { cookie: S.ck, origin: o.body !== undefined ? OS : undefined, ...o });
const stepUp = () => http(AUTH, '/auth/step-up', { method: 'POST', body: { password: PW }, cookie: S.ck, origin: OA, host: 'auth.localtest' });
const q1 = async (sql, a) => (await owner.query(sql, a)).rows[0];
const CUST = { name: 'Khách COD', phone: '0915556666', address_line: '3 Hai Bà Trưng', province: 'Hà Nội' };

async function donCodDaGiao(vid, qty) {
  const r = await api(`/shops/${S.shopId}/orders`, { method: 'POST', body: {
    idempotency_key: `a10-${uniq()}-${uniq()}`, customer: CUST, payment_method: 'cod', lines: [{ variant_id: vid, qty }] } });
  if (r.status !== 201) throw new Error(`tạo đơn lỗi ${r.status}: ${r.text.slice(0, 160)}`);
  const id = r.json.id ?? r.json.order?.id;
  await api(`/shops/${S.shopId}/orders/${id}/confirm`, { method: 'POST', body: {} });
  await api(`/shops/${S.shopId}/orders/${id}/ship`, { method: 'POST', body: { carrier: 'ghtk', tracking_number: `T${uniq()}` } });
  // Đơn giao qua HÃNG: shipments.provider phải khác NULL thì mới vào sổ đối soát.
  await owner.query(
    `UPDATE shipments SET provider='ghtk', carrier_fee_vnd=15000 WHERE order_id=$1`, [id]);
  await api(`/shops/${S.shopId}/orders/${id}/deliver`, { method: 'POST', body: {} });
  await owner.query(`UPDATE orders SET payment_status='paid', paid_at=now(), amount_paid_vnd=total_vnd WHERE id=$1`, [id]);
  return id;
}
const trongSo = async (id) => {
  const r = await api(`/shops/${S.shopId}/cod/reconciliation`);
  const ds = r.json?.outstanding ?? [];
  return { co: ds.some((x) => x.id === id), tong: (r.json?.by_carrier ?? []).reduce((s, g) => s + Number(g.expected_vnd), 0), n: ds.length };
};

async function main() {
  S.shopId = (await q1('SELECT id FROM shops WHERE slug=$1', [SLUG])).id;
  S.ck = sessionOf((await http(AUTH, '/auth/login', { method: 'POST', body: { email: EMAIL, password: PW }, origin: OA, host: 'auth.localtest' })).sc);
  S.ck ? ok('đăng nhập chủ shop') : bad('không đăng nhập được');
  const v = await q1(`SELECT v.id, v.price_vnd FROM variants v JOIN products p ON p.id=v.product_id
     JOIN inventory_levels il ON il.variant_id=v.id
    WHERE p.shop_id=$1 AND p.status='active' AND il.on_hand-il.reserved >= 6 ORDER BY v.price_vnd DESC LIMIT 1`, [S.shopId]);
  if (!v) { bad('không đủ tồn'); summary(); await owner.end(); return; }

  // ── A. NHẬN TRẢ HÀNG toàn bộ ────────────────────────────────────────────────
  sect('A. Đơn COD giao qua GHTK, khách trả hàng → còn đối soát được không?');
  const idA = await donCodDaGiao(v.id, 2);
  const t0 = await trongSo(idA);
  t0.co ? ok(`đơn nằm trong sổ chờ đối soát (tổng hãng nợ ${t0.tong}đ, ${t0.n} đơn)`) : bad('đơn không vào sổ — không dựng được cảnh');

  await stepUp();
  const rA = await api(`/shops/${S.shopId}/orders/${idA}/return`, { method: 'POST', body: { lines: [{ variant_id: v.id, qty: 2 }], restock: true } });
  const oA = await q1('SELECT status, cod_settled_at FROM orders WHERE id=$1', [idA]);
  const t1 = await trongSo(idA);
  if (rA.status !== 200) { warn(`trả hàng → HTTP ${rA.status}`, rA.text.slice(0, 140)); }
  else if (t1.co) ok(`sau khi trả hàng, đơn VẪN trong sổ đối soát (status=${oA.status})`);
  else {
    bad(`ĐƠN RƠI KHỎI SỔ ĐỐI SOÁT sau khi nhận trả hàng`,
      `status=${oA.status} · cod_settled_at=${oA.cod_settled_at ?? 'NULL (chưa hề đối soát)'} · tổng hãng nợ tụt ${t0.tong - t1.tong}đ`);
    // Còn đường ghi phiếu tay không?
    await stepUp();
    const rr = await api(`/shops/${S.shopId}/cod/remittances`, { method: 'POST', body: {
      carrier: 'ghtk', amount_vnd: 1000, remitted_at: '2026-08-02', order_ids: [idA] } });
    rr.status === 200
      ? ok('vẫn ghi phiếu chuyển tiền tay được')
      : bad(`NGÕ CỤT: ghi phiếu tay cũng chặn → HTTP ${rr.status} "${rr.json?.error ?? ''}"`,
        'tiền hãng đang giữ không còn cách nào đối chiếu hay đòi');
  }

  // ── B. HOÀN TIỀN toàn bộ ────────────────────────────────────────────────────
  sect('B. Đơn COD giao qua GHTK, chủ shop hoàn tiền toàn bộ → còn đối soát được không?');
  const idB = await donCodDaGiao(v.id, 1);
  const u0 = await trongSo(idB);
  u0.co ? ok('đơn B nằm trong sổ chờ đối soát') : bad('đơn B không vào sổ');
  await stepUp();
  const rB = await api(`/shops/${S.shopId}/orders/${idB}/refund`, { method: 'POST', body: {} });
  const oB = await q1('SELECT status, cod_settled_at FROM orders WHERE id=$1', [idB]);
  const u1 = await trongSo(idB);
  if (rB.status !== 200) warn(`hoàn tiền → HTTP ${rB.status}`, rB.text.slice(0, 140));
  else if (u1.co) ok(`sau khi hoàn tiền, đơn VẪN trong sổ (status=${oB.status})`);
  else bad(`ĐƠN RƠI KHỎI SỔ ĐỐI SOÁT sau khi hoàn tiền`,
    `status=${oB.status} · cod_settled_at=${oB.cod_settled_at ?? 'NULL'} · tổng hãng nợ tụt ${u0.tong - u1.tong}đ`);

  console.log(`\n  → đơn A=${idA} B=${idB}`);
  summary();
  await owner.end();
}
main().catch((e) => { console.error('VỠ:', e); process.exit(2); });
