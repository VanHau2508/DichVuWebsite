/** Trạng thái giao email/thông báo bền vững, tách khỏi dấu "đã enqueue" của outbox. */
import { send, parseOffset } from './http.js';
import { withTenant, audit } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const STATUSES = new Set(['queued', 'sending', 'retrying', 'accepted', 'failed', 'skipped', 'superseded']);
const RETRYABLE_EMAIL_TOPICS = new Set(['order.created', 'order.paid', 'order.status_changed']);
const RETRY_PII_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_PII_EXPIRY_KEY = 'retry_pii_expires_at_ms';

const ROW_SQL = `
  SELECT nd.id, nd.outbox_id, coalesce(nd.order_id, o.id) AS order_id,
         coalesce(nd.order_number, o.order_number) AS order_number,
         nd.topic, nd.channel, nd.status, nd.attempts, nd.provider_message_id,
         nd.last_error, nd.last_attempt_at, nd.accepted_at, nd.failed_at,
         nd.superseded_at, nd.retry_of_delivery_id, nd.created_at, nd.updated_at,
         ob.processed_at AS outbox_processed_at,
         ob.payload ? 'to' AS payload_has_to,
         ob.payload ->> '${RETRY_PII_EXPIRY_KEY}' AS retry_pii_expires_at_ms
    FROM notification_deliveries nd
    JOIN outbox ob ON ob.id = nd.outbox_id AND ob.shop_id = nd.shop_id
    LEFT JOIN orders o ON o.shop_id = nd.shop_id
      AND (o.id = nd.order_id OR (nd.order_id IS NULL AND o.order_number = nd.order_number))`;

function retryEligibility(row, nowMs = Date.now()) {
  if (row.status !== 'failed') return { retryable: false, retry_block_reason: 'status_not_failed' };
  if (row.channel !== 'email') return { retryable: false, retry_block_reason: 'channel_not_supported' };
  if (!RETRYABLE_EMAIL_TOPICS.has(row.topic)) return { retryable: false, retry_block_reason: 'topic_not_retryable' };
  if (!row.order_id) return { retryable: false, retry_block_reason: 'order_not_found' };
  if (!row.payload_has_to) return { retryable: false, retry_block_reason: 'recipient_scrubbed' };
  const inheritedExpiry = Number(row.retry_pii_expires_at_ms);
  const processedAt = row.outbox_processed_at instanceof Date
    ? row.outbox_processed_at.getTime()
    : Date.parse(row.outbox_processed_at ?? '');
  const baseExpiry = Number.isFinite(processedAt) ? processedAt + RETRY_PII_TTL_MS : NaN;
  const expiry = Number.isFinite(inheritedExpiry) && inheritedExpiry > 0
    ? Math.min(inheritedExpiry, baseExpiry)
    : baseExpiry;
  if (!Number.isFinite(expiry) || expiry <= nowMs) return { retryable: false, retry_block_reason: 'retry_window_expired' };
  return { retryable: true, retry_block_reason: null, retry_pii_expires_at_ms: expiry };
}

const normalize = (r) => ({
  ...r,
  outbox_id: Number(r.outbox_id),
  order_number: r.order_number == null ? null : Number(r.order_number),
  attempts: Number(r.attempts),
  ...retryEligibility(r),
  payload_has_to: undefined,
  retry_pii_expires_at_ms: undefined,
  outbox_processed_at: undefined,
});

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
              nd.topic, ob.payload, ob.processed_at AS outbox_processed_at,
              o.id AS matched_order_id, o.order_number AS matched_order_number
         FROM notification_deliveries nd
         JOIN outbox ob ON ob.id = nd.outbox_id AND ob.shop_id = nd.shop_id
         LEFT JOIN orders o ON o.shop_id = nd.shop_id
           AND (o.id = nd.order_id OR (nd.order_id IS NULL AND o.order_number = nd.order_number))
        WHERE nd.id = $1 FOR UPDATE OF nd`, [deliveryId],
    )).rows[0];
    if (!row) return { code: 404 };
    if (row.channel !== 'email') return { code: 409, msg: 'hiện chỉ hỗ trợ gửi lại email' };
    if (row.status !== 'failed') return { code: 409, msg: 'chỉ gửi lại thông báo đã thất bại' };
    if (!RETRYABLE_EMAIL_TOPICS.has(row.topic)) return {
      code: 409, errorCode: 'notification_topic_not_retryable',
      msg: 'chỉ email giao dịch của đơn hàng mới được gửi lại từ màn hình này',
    };
    if (!row.matched_order_id) return {
      code: 409, errorCode: 'notification_order_not_found',
      msg: 'thông báo không còn khớp với đơn hàng của shop',
    };
    const payload = { ...(row.payload ?? {}) };
    if (!payload.to) return {
      code: 409, errorCode: 'notification_recipient_scrubbed',
      msg: 'dữ liệu người nhận đã hết hạn lưu trữ nên không thể gửi lại',
    };
    const eligibility = retryEligibility({
      ...row,
      order_id: row.matched_order_id,
      payload_has_to: true,
      retry_pii_expires_at_ms: payload[RETRY_PII_EXPIRY_KEY],
    });
    if (!eligibility.retryable) return {
      code: 409, errorCode: 'notification_retry_window_expired',
      msg: 'đã hết thời hạn gửi lại thông báo có dữ liệu cá nhân',
    };
    payload[RETRY_PII_EXPIRY_KEY] = eligibility.retry_pii_expires_at_ms;
    payload.retry_of_delivery_id = row.id;
    payload.order_id = row.matched_order_id;
    payload.order_number = Number(row.matched_order_number);
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
  if (out.code === 409) return send(res, 409, { error_code: out.errorCode, error: out.msg, message: out.msg });
  return send(res, 202, { ok: true, status: 'queued', outbox_id: out.outboxId });
}

export const NOTIFICATION_DELIVERY_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/notification-deliveries$`), perm: 'orders.read', fn: listDeliveries },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/notification-deliveries/${UUID}/retry$`), perm: 'orders.write', fn: retryDelivery },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/notifications/${UUID}/retry$`), perm: 'orders.write', fn: retryDelivery },
];
