/**
 * Đối soát COD với hãng (kiểm toán #20). Sổ THỦ CÔNG: shop nhập phiếu chuyển tiền từ
 * sao kê hãng → đánh dấu các đơn COD-giao-qua-hãng đã đối soát + ghi chênh lệch kỳ-vọng/thực.
 *
 * Đơn giao TAY (shipments.provider NULL) không cần đối soát — shop đã cầm tiền mặt.
 * cod_remittances APPEND-ONLY (0079). Mỗi đơn đối soát ĐÚNG MỘT LẦN (cod_settled_at + FOR UPDATE).
 */
import { send } from './http.js';
import { withTenant, audit } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Đơn COD đã giao QUA HÃNG chưa đối soát (kèm phí hãng → COD-net kỳ vọng nhận về).
const OUTSTANDING_SQL = `
  SELECT o.id, o.order_number, o.total_vnd, o.delivered_at, sh.provider, sh.carrier, sh.carrier_fee_vnd,
         (o.total_vnd - coalesce(sh.carrier_fee_vnd, 0)) AS expected_net_vnd
    FROM orders o
    JOIN LATERAL (
      SELECT provider, carrier, carrier_fee_vnd FROM shipments s
       WHERE s.order_id = o.id AND s.provider IS NOT NULL
       ORDER BY s.created_at DESC LIMIT 1
    ) sh ON true
   WHERE o.payment_method = 'cod' AND o.status = 'delivered' AND o.cod_settled_at IS NULL`;

async function reconciliation(res, ctx) {
  const data = await withTenant(ctx.shopId, async (c) => {
    const outstanding = (await c.query(`${OUTSTANDING_SQL} ORDER BY sh.provider, o.delivered_at`)).rows.map((r) => ({
      id: r.id, order_number: Number(r.order_number), total_vnd: Number(r.total_vnd), delivered_at: r.delivered_at,
      provider: r.provider, carrier: r.carrier, carrier_fee_vnd: r.carrier_fee_vnd == null ? null : Number(r.carrier_fee_vnd),
      expected_net_vnd: Number(r.expected_net_vnd),
    }));
    // Tổng chờ đối soát theo hãng.
    const byCarrier = new Map();
    for (const o of outstanding) {
      const k = o.provider ?? '(khác)';
      const g = byCarrier.get(k) ?? { provider: k, count: 0, expected_vnd: 0 };
      g.count++; g.expected_vnd += o.expected_net_vnd; byCarrier.set(k, g);
    }
    const remittances = (await c.query(
      `SELECT r.id, r.carrier, r.amount_vnd, r.expected_vnd, r.order_count, r.remitted_at, r.note, r.created_at, u.email AS created_by_email
         FROM cod_remittances r LEFT JOIN users u ON u.id = r.created_by
        ORDER BY r.created_at DESC, r.id DESC LIMIT 50`,
    )).rows.map((r) => ({
      id: r.id, carrier: r.carrier, amount_vnd: Number(r.amount_vnd), expected_vnd: Number(r.expected_vnd),
      discrepancy_vnd: Number(r.amount_vnd) - Number(r.expected_vnd), order_count: r.order_count,
      remitted_at: r.remitted_at, note: r.note, created_at: r.created_at, created_by_email: r.created_by_email,
    }));
    return {
      outstanding, by_carrier: [...byCarrier.values()],
      total_outstanding_vnd: outstanding.reduce((s, o) => s + o.expected_net_vnd, 0),
      remittances,
    };
  });
  return send(res, 200, data);
}

async function recordRemittance(res, ctx, body) {
  const fail = (statusCode, msg) => { throw Object.assign(new Error(msg), { statusCode }); };
  const rawIds = Array.isArray(body?.order_ids) ? body.order_ids : [];
  const orderIds = [...new Set(rawIds.filter((x) => UUID_RE.test(String(x ?? ''))).map(String))];
  if (orderIds.length === 0 || orderIds.length > 500) return send(res, 400, { error: 'chọn 1-500 đơn để đối soát' });
  const amount = Number(body?.amount_vnd);
  if (!Number.isSafeInteger(amount) || amount < 0) return send(res, 400, { error: 'số tiền nhận về không hợp lệ (số nguyên ≥ 0)' });
  const carrier = body?.carrier != null && String(body.carrier).trim() !== '' ? String(body.carrier).trim().slice(0, 40) : null;
  const note = String(body?.note ?? '').trim().slice(0, 500) || null;
  const remittedAt = /^\d{4}-\d{2}-\d{2}$/.test(String(body?.remitted_at ?? '')) ? String(body.remitted_at) : null;

  try {
    const out = await withTenant(ctx.shopId, async (c) => {
      // Khoá các đơn theo THỨ TỰ id (chống deadlock). Chỉ đơn COD giao-qua-hãng, delivered,
      // CHƯA đối soát. Đơn không đủ điều kiện / đã đối soát → 422 (không đối soát nhầm/2 lần).
      const sorted = [...orderIds].sort((a, b) => a.localeCompare(b));
      const rows = (await c.query(
        `SELECT o.id, o.order_number, o.payment_method, o.status, o.cod_settled_at, o.total_vnd,
                sh.provider, coalesce(sh.carrier_fee_vnd, 0) AS fee
           FROM orders o
           LEFT JOIN LATERAL (SELECT provider, carrier_fee_vnd FROM shipments s
                               WHERE s.order_id = o.id AND s.provider IS NOT NULL
                               ORDER BY s.created_at DESC LIMIT 1) sh ON true
          WHERE o.id = ANY($1::uuid[]) ORDER BY o.id FOR UPDATE OF o`, [sorted],
      )).rows;
      const found = new Map(rows.map((r) => [r.id, r]));
      let expected = 0;
      for (const id of orderIds) {
        const o = found.get(id);
        if (!o) fail(422, 'có đơn không thuộc cửa hàng này');
        if (o.payment_method !== 'cod') fail(422, `đơn #${Number(o.order_number)} không phải COD`);
        if (o.status !== 'delivered') fail(422, `đơn #${Number(o.order_number)} chưa giao xong`);
        if (!o.provider) fail(422, `đơn #${Number(o.order_number)} giao tay (không qua hãng) — không cần đối soát`);
        if (o.cod_settled_at) fail(409, `đơn #${Number(o.order_number)} đã đối soát rồi`);
        if (carrier && o.provider !== carrier) fail(422, `đơn #${Number(o.order_number)} giao qua ${o.provider}, không phải ${carrier}`);
        expected += Number(o.total_vnd) - Number(o.fee);
      }

      const rem = (await c.query(
        `INSERT INTO cod_remittances (shop_id, carrier, amount_vnd, expected_vnd, order_count, remitted_at, note, created_by)
         VALUES (current_shop_id(), $1, $2, $3, $4, coalesce($5::date, current_date), $6, $7) RETURNING id`,
        [carrier, amount, expected, orderIds.length, remittedAt, note, ctx.user.id],
      )).rows[0];
      await c.query(`UPDATE orders SET cod_settled_at = now(), cod_remittance_id = $2 WHERE id = ANY($1::uuid[])`, [orderIds, rem.id]);

      const discrepancy = amount - expected;
      await audit(c, 'cod.reconciled', { actorId: ctx.user.id, ip: ctx.ip, metadata: { remittance_id: rem.id, carrier, amount_vnd: amount, expected_vnd: expected, discrepancy_vnd: discrepancy, order_count: orderIds.length } });
      return { remittance_id: rem.id, expected_vnd: expected, amount_vnd: amount, discrepancy_vnd: discrepancy, order_count: orderIds.length };
    });
    return send(res, 200, { ok: true, ...out });
  } catch (err) {
    if (err.statusCode) return send(res, err.statusCode, { error: err.message });
    throw err;
  }
}

export const COD_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/cod/reconciliation$`), perm: 'orders.read', fn: (res, ctx) => reconciliation(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/cod/remittances$`), perm: 'payment.write', fn: (res, ctx, b) => recordRemittance(res, ctx, b) },
];
