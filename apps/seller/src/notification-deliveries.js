/** Trạng thái giao email/thông báo bền vững, tách khỏi dấu "đã enqueue" của outbox. */
import { send, parseOffset } from './http.js';
import { withTenant, audit } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const STATUSES = new Set(['queued', 'sending', 'retrying', 'accepted', 'failed', 'skipped', 'superseded']);

const ROW_SQL = `
  SELECT nd.id, nd.outbox_id, coalesce(nd.order_id, o.id) AS order_id,
         coalesce(nd.order_number, o.order_number) AS order_number,
         nd.topic, nd.channel, nd.status, nd.attempts, nd.provider_message_id,
         nd.last_error, nd.last_attempt_at, nd.accepted_at, nd.failed_at,
         nd.superseded_at, nd.retry_of_delivery_id, nd.created_at, nd.updated_at
    FROM notification_deliveries nd
    LEFT JOIN orders o ON o.shop_id = nd.shop_id
      AND (o.id = nd.order_id OR (nd.order_id IS NULL AND o.order_number = nd.order_number))`;

const normalize = (r) => ({ ...r, outbox_id: Number(r.outbox_id), order_number: r.order_number == null ? null : Number(r.order_number), attempts: Number(r.attempts) });

export async function deliveriesForOrder(c, orderId, orderNumber) {
  return (await c.query(
    `${ROW_SQL}
      WHERE nd.order_id = $1 OR (nd.order_id IS NULL AND nd.order_number = $2)
      ORDER BY nd.created_at DESC, nd.id DESC`,
    [orderId, orderNumber],
  )).rows.map(normalize);
}

async function listDeliveries(res, ctx, _body, _params, query) {
  const requested = String(query?.get('status') ?? 'failed');
  const status = STATUSES.has(requested) ? requested : 'failed';
  const limit = Math.min(100, Math.max(1, Number(query?.get('limit')) || 20));
  const offset = parseOffset(query);
  const data = await withTenant(ctx.shopId, async (c) => {
    const rows = (await c.query(
      `${ROW_SQL} WHERE nd.status = $1 ORDER BY nd.updated_at DESC, nd.id DESC LIMIT $2 OFFSET $3`,
      [status, limit, offset],
    )).rows.map(normalize);
    const total = Number((await c.query(
      `SELECT count(*)::int AS n FROM notification_deliveries WHERE status = $1`, [status],
    )).rows[0].n);
    return { rows, total };
  });
  return send(res, 200, { status, total: data.total, limit, offset, deliveries: data.rows });
}

async function retryDelivery(res, ctx, _body, params) {
  const deliveryId = params[1];
  const out = await withTenant(ctx.shopId, async (c) => {
    const row = (await c.query(
      `SELECT nd.id, nd.status, nd.channel, nd.order_id, nd.order_number,
              nd.topic, ob.payload, o.id AS matched_order_id, o.order_number AS matched_order_number,
              o.customer_email
         FROM notification_deliveries nd
         JOIN outbox ob ON ob.id = nd.outbox_id
         LEFT JOIN orders o ON o.shop_id = nd.shop_id
           AND (o.id = nd.order_id OR (nd.order_id IS NULL AND o.order_number = nd.order_number))
        WHERE nd.id = $1 FOR UPDATE OF nd`, [deliveryId],
    )).rows[0];
    if (!row) return { code: 404 };
    if (row.channel !== 'email') return { code: 409, msg: 'hiện chỉ hỗ trợ gửi lại email' };
    if (row.status !== 'failed') return { code: 409, msg: 'chỉ gửi lại thông báo đã thất bại' };
    const payload = { ...(row.payload ?? {}) };
    const to = payload.to || row.customer_email;
    if (!to) return { code: 409, msg: 'không còn địa chỉ email để gửi lại' };
    payload.to = to;
    payload.retry_of_delivery_id = row.id;
    if (row.order_id || row.matched_order_id) payload.order_id = row.order_id || row.matched_order_id;
    if (row.order_number || row.matched_order_number) payload.order_number = Number(row.order_number || row.matched_order_number);
    const next = (await c.query(
      `INSERT INTO outbox (shop_id, topic, payload) VALUES (current_shop_id(), $1, $2) RETURNING id`,
      [row.topic, payload],
    )).rows[0];
    await c.query(
      `UPDATE notification_deliveries
          SET status = 'superseded'
        WHERE id = $1 AND status = 'failed'`, [row.id],
    );
    await audit(c, 'notification.retry_requested', {
      actorId: ctx.user.id, ip: ctx.ip,
      metadata: { delivery_id: row.id, old_status: row.status, new_outbox_id: Number(next.id), topic: row.topic },
    });
    return { code: 202, outboxId: Number(next.id) };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy lần gửi' });
  if (out.code === 409) return send(res, 409, { error: out.msg });
  return send(res, 202, { ok: true, status: 'queued', outbox_id: out.outboxId });
}

export const NOTIFICATION_DELIVERY_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/notification-deliveries$`), perm: 'orders.read', fn: listDeliveries },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/notification-deliveries/${UUID}/retry$`), perm: 'orders.write', fn: retryDelivery },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/notifications/${UUID}/retry$`), perm: 'orders.write', fn: retryDelivery },
];
