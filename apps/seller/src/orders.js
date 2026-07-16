/**
 * Quản lý đơn hàng (seller). Ngày 15.
 *
 * State machine: pending → confirmed → shipped → delivered; huỷ từ pending/confirmed.
 * Mỗi chuyển trạng thái ghi outbox 'order.status_changed' (email) TRONG cùng transaction.
 * Huỷ đơn RELEASE reserve tồn kho (trả lại chỗ đã giữ lúc checkout).
 */
import { send } from './http.js';
import { withTenant, audit } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

async function statusEvent(c, order, extra = {}) {
  if (!order.customer_email) return;
  await c.query(
    `INSERT INTO outbox (shop_id, topic, payload) VALUES (current_shop_id(), 'order.status_changed', $1)`,
    [{ to: order.customer_email, order_number: Number(order.order_number), status: order.status, ...extra }],
  );
}

async function listOrders(res, ctx, _b, _p, query) {
  const limit = Math.min(Math.max(parseInt(query.get('limit') ?? '20', 10) || 20, 1), 100);
  const offset = Math.max(parseInt(query.get('offset') ?? '0', 10) || 0, 0);
  const status = query.get('status');
  const where = [];
  const args = [];
  if (['pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'refunded'].includes(status)) { args.push(status); where.push(`status = $${args.length}`); }
  // Tìm: mã đơn (nếu q toàn số) hoặc tên/điện thoại khách (ILIKE, escape wildcard).
  const q = (query.get('q') ?? '').trim().slice(0, 100);
  if (q) {
    const like = '%' + q.replace(/[%_\\]/g, '\\$&') + '%';
    if (/^\d{1,15}$/.test(q)) {
      args.push(Number(q)); const on = args.length;
      args.push(like); const lk = args.length;
      where.push(`(order_number = $${on} OR customer_phone ILIKE $${lk} OR customer_name ILIKE $${lk})`);
    } else {
      args.push(like); const lk = args.length;
      where.push(`(customer_name ILIKE $${lk} OR customer_phone ILIKE $${lk})`);
    }
  }
  // Khoảng ngày (theo created_at, biên [from, to] tính cả ngày to).
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const from = (query.get('from') ?? '').trim();
  const to = (query.get('to') ?? '').trim();
  if (DATE_RE.test(from)) { args.push(from); where.push(`created_at >= $${args.length}::date`); }
  if (DATE_RE.test(to)) { args.push(to); where.push(`created_at < ($${args.length}::date + 1)`); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const data = await withTenant(ctx.shopId, async (c) => {
    const total = (await c.query(`SELECT count(*)::int n FROM orders ${whereSql}`, args)).rows[0].n;
    const rows = (await c.query(
      `SELECT o.id, o.order_number, o.status, o.payment_status, o.payment_method, o.total_vnd, o.customer_name, o.created_at,
              (SELECT count(DISTINCT o2.customer_phone)::int FROM orders o2
                 WHERE o2.shop_id = current_shop_id() AND o2.client_ip_hash = o.client_ip_hash
                   AND o2.client_ip_hash IS NOT NULL AND o2.status = 'pending') AS same_ip_phones
         FROM orders o ${whereSql} ORDER BY o.order_number DESC LIMIT ${limit} OFFSET ${offset}`, args,
    )).rows;
    return { total, orders: rows };
  });
  return send(res, 200, { ...data, limit, offset });
}

async function getOrder(res, ctx, _b, params) {
  const orderId = params[1];
  const data = await withTenant(ctx.shopId, async (c) => {
    const o = (await c.query(
      `SELECT id, order_number, status, payment_status, payment_method, subtotal_vnd, shipping_vnd, total_vnd,
              customer_name, customer_phone, customer_email, shipping_address, created_at, paid_at, shipped_at, delivered_at
         FROM orders WHERE id = $1`, [orderId],
    )).rows[0];
    if (!o) return null;
    o.lines = (await c.query(`SELECT title_snapshot, sku_snapshot, unit_price_vnd, qty FROM order_lines WHERE order_id = $1`, [o.id])).rows;
    o.shipments = (await c.query(`SELECT carrier, tracking_number, status FROM shipments WHERE order_id = $1`, [o.id])).rows;
    return o;
  });
  if (!data) return send(res, 404, { error: 'không tìm thấy đơn' });
  return send(res, 200, data);
}

// Chuyển trạng thái đơn giản (confirm/deliver).
function makeTransition(from, to, tsCol, action) {
  return async (res, ctx, params) => {
    const orderId = params[1];
    const out = await withTenant(ctx.shopId, async (c) => {
      const o = (await c.query(`SELECT id, status, order_number, customer_email FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
      if (!o) return { code: 404 };
      if (!from.includes(o.status)) return { code: 409, cur: o.status };
      await c.query(`UPDATE orders SET status = $1${tsCol ? `, ${tsCol} = now()` : ''} WHERE id = $2`, [to, orderId]);
      o.status = to;
      await audit(c, action, { actorId: ctx.user.id, ip: ctx.ip, metadata: { orderId, to } });
      await statusEvent(c, o);
      return { code: 200 };
    });
    if (out.code === 404) return send(res, 404, { error: 'không tìm thấy đơn' });
    if (out.code === 409) return send(res, 409, { error: `không thể chuyển từ ${out.cur}` });
    return send(res, 200, { ok: true, status: to });
  };
}

async function shipOrder(res, ctx, body, params) {
  const orderId = params[1];
  const tracking = String(body.tracking_number ?? '').trim();
  const carrier = String(body.carrier ?? '').trim();
  if (tracking.length < 1 || tracking.length > 64) return send(res, 400, { error: 'mã vận đơn không hợp lệ' });
  const out = await withTenant(ctx.shopId, async (c) => {
    const o = (await c.query(`SELECT id, status, order_number, customer_email FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
    if (!o) return { code: 404 };
    if (o.status !== 'confirmed') return { code: 409, cur: o.status };
    // CONSUME tồn: hàng rời kho. Mỗi dòng: on_hand -= qty, reserved -= qty, ghi ledger
    // 'ship' (giữ bất biến tổng delta ledger == on_hand). Chỉ xảy ra MỘT lần: guard
    // status='confirmed' ở trên = idempotent (ship lần 2 → 409). Cùng transaction với đổi trạng thái.
    const lines = (await c.query(`SELECT variant_id, qty FROM order_lines WHERE order_id = $1`, [orderId])).rows;
    for (const ln of lines) {
      const lvl = (await c.query(`SELECT on_hand, reserved FROM inventory_levels WHERE variant_id = $1 FOR UPDATE`, [ln.variant_id])).rows[0];
      if (!lvl) continue; // biến thể không theo dõi tồn (không nên xảy ra sau reserve)
      const nextOnHand = Math.max(0, lvl.on_hand - ln.qty);
      const nextReserved = Math.max(0, lvl.reserved - ln.qty);
      await c.query(`UPDATE inventory_levels SET on_hand = $2, reserved = $3, updated_at = now() WHERE variant_id = $1`, [ln.variant_id, nextOnHand, nextReserved]);
      const delta = nextOnHand - lvl.on_hand; // = -qty (âm); dùng thay đổi thực tế để khớp invariant
      if (delta !== 0) {
        await c.query(
          `INSERT INTO inventory_ledger (shop_id, variant_id, delta, kind, reason, actor_id)
           VALUES (current_shop_id(), $1, $2, 'ship', $3, $4)`,
          [ln.variant_id, delta, `đơn #${o.order_number}`, ctx.user.id],
        );
      }
    }
    await c.query(`INSERT INTO shipments (shop_id, order_id, carrier, tracking_number, status) VALUES (current_shop_id(), $1, $2, $3, 'in_transit')`, [orderId, carrier || null, tracking]);
    await c.query(`UPDATE orders SET status = 'shipped', shipped_at = now() WHERE id = $1`, [orderId]);
    o.status = 'shipped';
    await audit(c, 'order.shipped', { actorId: ctx.user.id, ip: ctx.ip, metadata: { orderId, tracking } });
    await statusEvent(c, o, { tracking_number: tracking });
    return { code: 200 };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy đơn' });
  if (out.code === 409) return send(res, 409, { error: `không thể giao từ ${out.cur}` });
  return send(res, 200, { ok: true, status: 'shipped', tracking_number: tracking });
}

async function cancelOrder(res, ctx, _body, params) {
  const orderId = params[1];
  const out = await withTenant(ctx.shopId, async (c) => {
    const o = (await c.query(`SELECT id, status, payment_status, coupon_code, order_number, customer_email FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
    if (!o) return { code: 404 };
    if (!['pending', 'confirmed'].includes(o.status)) return { code: 409, cur: o.status };
    // RELEASE reserve: trả lại tồn đã giữ chỗ lúc checkout.
    const lines = (await c.query(`SELECT variant_id, qty FROM order_lines WHERE order_id = $1`, [orderId])).rows;
    for (const ln of lines) {
      await c.query(`UPDATE inventory_levels SET reserved = GREATEST(0, reserved - $2), updated_at = now() WHERE variant_id = $1`, [ln.variant_id, ln.qty]);
    }
    await c.query(`UPDATE orders SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [orderId]);
    // Hoàn lại lượt coupon CHỈ khi đơn CHƯA trả (đơn đã trả = lượt dùng thật).
    if (o.coupon_code && o.payment_status !== 'paid') {
      await c.query(`UPDATE coupons SET used_count = GREATEST(used_count - 1, 0) WHERE shop_id = current_shop_id() AND upper(code) = upper($1)`, [o.coupon_code]);
    }
    o.status = 'cancelled';
    await audit(c, 'order.cancelled', { actorId: ctx.user.id, ip: ctx.ip, metadata: { orderId } });
    await statusEvent(c, o);
    return { code: 200 };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy đơn' });
  if (out.code === 409) return send(res, 409, { error: `không thể huỷ từ ${out.cur}` });
  return send(res, 200, { ok: true, status: 'cancelled' });
}

// Đánh dấu ĐÃ NHẬN TIỀN cho đơn COD (thu tiền mặt khi giao). CHỈ COD — đơn QR do
// webhook đối soát đặt paid; KHÔNG có đường nào cho người dùng tự đặt QR paid (bất
// biến chống gian lận "đã trả"). Idempotent: guard payment_status<>'paid'.
async function markPaid(res, ctx, _body, params) {
  const orderId = params[1];
  const out = await withTenant(ctx.shopId, async (c) => {
    const o = (await c.query(
      `SELECT id, order_number, payment_method, payment_status, status, customer_email, total_vnd
         FROM orders WHERE id = $1 FOR UPDATE`, [orderId],
    )).rows[0];
    if (!o) return { code: 404 };
    if (o.payment_method !== 'cod') return { code: 409, msg: 'chỉ đơn COD mới đánh dấu đã nhận tiền thủ công' };
    // 'refunded'/'cancelled' là TERMINAL: không cho đánh dấu đã-trả (khớp markPaidQr) — nếu
    // không, mark-paid (perm orders.write, không step-up) có thể ĐẢO NGƯỢC một lệnh hoàn tiền.
    if (['cancelled', 'refunded'].includes(o.status)) return { code: 409, msg: 'đơn đã huỷ/hoàn, không thể đánh dấu đã nhận tiền' };
    const upd = await c.query(
      `UPDATE orders SET payment_status = 'paid', paid_at = now()
        WHERE id = $1 AND payment_status <> 'paid'`, [orderId],
    );
    if (upd.rowCount !== 1) return { code: 409, msg: 'đơn đã thanh toán' };
    await audit(c, 'order.marked_paid', { actorId: ctx.user.id, ip: ctx.ip, metadata: { orderId } });
    // Biên nhận cho khách (giống QR): phát order.paid TRONG cùng transaction.
    if (o.customer_email) {
      await c.query(
        `INSERT INTO outbox (shop_id, topic, payload) VALUES (current_shop_id(), 'order.paid', $1)`,
        [{ to: o.customer_email, order_number: Number(o.order_number), total_vnd: Number(o.total_vnd) }],
      );
    }
    return { code: 200 };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy đơn' });
  if (out.code === 409) return send(res, 409, { error: out.msg });
  return send(res, 200, { ok: true, payment_status: 'paid' });
}

// Xác nhận TAY đơn QR đã nhận tiền — FALLBACK khi feed đối soát (SePay) vắng/chưa nối.
// Khác markPaid (COD, orders.write): đây là NỚI bất biến "QR chỉ webhook đặt paid" nên
// khoá chặt hơn — perm 'payment.write' (chỉ owner) + STEP-UP + audit RIÊNG (đánh dấu
// manual để phân biệt với webhook đối soát). Chỉ chủ shop tự nhận rủi ro "tiền đã về".
async function markPaidQr(res, ctx, _body, params) {
  const orderId = params[1];
  const out = await withTenant(ctx.shopId, async (c) => {
    const o = (await c.query(
      `SELECT id, order_number, payment_method, payment_status, status, customer_email, total_vnd
         FROM orders WHERE id = $1 FOR UPDATE`, [orderId],
    )).rows[0];
    if (!o) return { code: 404 };
    if (o.payment_method !== 'qr') return { code: 409, msg: 'chỉ đơn QR mới xác nhận tay tại đây' };
    if (['cancelled', 'refunded'].includes(o.status)) return { code: 409, msg: 'đơn đã huỷ/hoàn, không thể xác nhận thanh toán' };
    const upd = await c.query(
      `UPDATE orders SET payment_status = 'paid', paid_at = now()
        WHERE id = $1 AND payment_status <> 'paid'`, [orderId],
    );
    if (upd.rowCount !== 1) return { code: 409, msg: 'đơn đã thanh toán' };
    await audit(c, 'order.qr_marked_paid_manual', { actorId: ctx.user.id, ip: ctx.ip, metadata: { orderId, manual: true } });
    // Biên nhận cho khách (giống webhook): phát order.paid TRONG cùng transaction.
    if (o.customer_email) {
      await c.query(
        `INSERT INTO outbox (shop_id, topic, payload) VALUES (current_shop_id(), 'order.paid', $1)`,
        [{ to: o.customer_email, order_number: Number(o.order_number), total_vnd: Number(o.total_vnd) }],
      );
    }
    return { code: 200 };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy đơn' });
  if (out.code === 409) return send(res, 409, { error: out.msg });
  return send(res, 200, { ok: true, payment_status: 'paid' });
}

// Hoàn tiền / hoàn đơn: đơn ĐÃ THANH TOÁN → payment_status='refunded' + status='refunded'.
// Perm 'refund' (owner/admin) + STEP-UP. Tồn kho:
//   - pending/confirmed (còn GIỮ reserve, chưa giao) → GIẢI PHÓNG reserve (đơn không thực
//     hiện nữa, trả chỗ cho khách khác).
//   - shipped/delivered (hàng đã rời kho) / cancelled (reserve đã trả lúc huỷ) → KHÔNG đụng
//     tồn; chủ shop tự nhập lại kho nếu khách trả hàng (tránh giả định "hoàn = luôn trả hàng").
// Idempotent: guard status<>'refunded' + payment_status='paid'.
async function refundOrder(res, ctx, _body, params) {
  const orderId = params[1];
  const out = await withTenant(ctx.shopId, async (c) => {
    const o = (await c.query(
      `SELECT id, order_number, status, payment_status, customer_email, total_vnd
         FROM orders WHERE id = $1 FOR UPDATE`, [orderId],
    )).rows[0];
    if (!o) return { code: 404 };
    if (o.payment_status !== 'paid') return { code: 409, msg: 'chỉ hoàn được đơn đã thanh toán' };
    if (o.status === 'refunded') return { code: 409, msg: 'đơn đã hoàn tiền' };
    if (['pending', 'confirmed'].includes(o.status)) {
      const lines = (await c.query(`SELECT variant_id, qty FROM order_lines WHERE order_id = $1`, [orderId])).rows;
      for (const ln of lines) {
        await c.query(`UPDATE inventory_levels SET reserved = GREATEST(0, reserved - $2), updated_at = now() WHERE variant_id = $1`, [ln.variant_id, ln.qty]);
      }
    }
    await c.query(`UPDATE orders SET status = 'refunded', payment_status = 'refunded' WHERE id = $1`, [orderId]);
    o.status = 'refunded';
    await audit(c, 'order.refunded', { actorId: ctx.user.id, ip: ctx.ip, metadata: { orderId, total_vnd: Number(o.total_vnd) } });
    await statusEvent(c, o); // email báo khách: trạng thái = refunded
    return { code: 200 };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy đơn' });
  if (out.code === 409) return send(res, 409, { error: out.msg });
  return send(res, 200, { ok: true, status: 'refunded', payment_status: 'refunded' });
}

const confirmOrder = makeTransition(['pending'], 'confirmed', null, 'order.confirmed');
const deliverOrder = makeTransition(['shipped'], 'delivered', 'delivered_at', 'order.delivered');

export const ORDER_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/orders$`), perm: 'orders.read', fn: (res, ctx, b, p, q) => listOrders(res, ctx, b, p, q) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/orders/${UUID}$`), perm: 'orders.read', fn: (res, ctx, b, p) => getOrder(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/confirm$`), perm: 'orders.write', fn: (res, ctx, b, p) => confirmOrder(res, ctx, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/ship$`), perm: 'orders.write', fn: (res, ctx, b, p) => shipOrder(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/deliver$`), perm: 'orders.write', fn: (res, ctx, b, p) => deliverOrder(res, ctx, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/cancel$`), perm: 'orders.write', fn: (res, ctx, b, p) => cancelOrder(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/mark-paid$`), perm: 'orders.write', fn: (res, ctx, b, p) => markPaid(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/mark-paid-qr$`), perm: 'payment.write', stepUp: true, fn: (res, ctx, b, p) => markPaidQr(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/refund$`), perm: 'refund', stepUp: true, fn: (res, ctx, b, p) => refundOrder(res, ctx, b, p) },
];
