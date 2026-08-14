/**
 * Yêu cầu hậu mãi từ khách (0158).
 *
 * Khách chỉ ghi một yêu cầu. Mọi thay đổi thật trên đơn vẫn do seller thực hiện dưới
 * khoá đơn và transaction tenant: huỷ dùng cancelOrderTx, đổi địa chỉ chỉ cập nhật
 * snapshot người nhận, còn trả hàng phải qua RMA sau khi shop nhận hàng thực tế.
 */
import { send, parseOffset } from './http.js';
import { withTenant, audit } from './db.js';
import { cancelOrderTx } from './orders.js';
import { isProvince, regionOf } from './provinces.js';
import { canonPhone } from '../phone.js';
import { computeShipping } from '../shipping-quote.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const TYPES = new Set(['cancel', 'address_change', 'return']);
const STATUSES = new Set(['requested', 'approved', 'completed', 'rejected']);

function parseAddressPayload(raw) {
  const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const recipientName = String(p.recipient_name ?? '').trim();
  const phone = canonPhone(p.phone);
  const line = String(p.line ?? '').trim().slice(0, 300);
  const province = String(p.province ?? '').trim().slice(0, 60);
  const district = String(p.district ?? '').trim().slice(0, 60) || null;
  const ward = String(p.ward ?? '').trim().slice(0, 60) || null;
  if (!recipientName || recipientName.length > 120 || /[\r\n]/.test(recipientName)) return { error: 'tên người nhận không hợp lệ' };
  if (!phone) return { error: 'số điện thoại không hợp lệ' };
  if (!line) return { error: 'thiếu địa chỉ giao hàng' };
  if (!province || !isProvince(province)) return { error: 'tỉnh/thành không hợp lệ' };
  return { value: { recipient_name: recipientName, phone, line, province, district, ward } };
}

async function quoteAddressChange(c, order, province) {
  const shop = (await c.query(
    `SELECT ship_fee_vnd, free_ship_threshold_vnd, ship_fee_far_vnd,
            ship_extra_per_500g_vnd, default_weight_gram, ship_from_province,
            ship_mode, ship_base_vnd, ship_per_km_vnd, ship_max_km,
            ship_over_max_behavior
       FROM shops WHERE id = current_shop_id()`,
  )).rows[0] ?? {};
  if (shop.ship_mode === 'distance' && shop.ship_over_max_behavior === 'reject') {
    return {
      errorCode: 'shipping_location_required',
      message: 'shop chỉ giao trong bán kính nhưng yêu cầu đổi địa chỉ không có vị trí đã xác minh',
      action: 'Không duyệt mù. Liên hệ khách để xác minh vị trí rồi sửa đơn bằng luồng chỉnh sửa có kiểm tra phí vận chuyển.',
    };
  }
  const items = (await c.query(
    `SELECT ol.qty, v.weight_gram
       FROM order_lines ol
       JOIN variants v ON v.id = ol.variant_id
      WHERE ol.order_id = $1`,
    [order.order_id],
  )).rows;
  const cfg = {
    fee: shop.ship_fee_vnd != null ? Number(shop.ship_fee_vnd) : 30000,
    threshold: shop.free_ship_threshold_vnd != null ? Number(shop.free_ship_threshold_vnd) : null,
    feeFar: shop.ship_fee_far_vnd != null ? Number(shop.ship_fee_far_vnd) : null,
    extraPer500g: shop.ship_extra_per_500g_vnd != null ? Number(shop.ship_extra_per_500g_vnd) : 0,
    defaultWeightGram: Number(shop.default_weight_gram ?? 500),
    fromRegion: regionOf(shop.ship_from_province),
    mode: shop.ship_mode ?? 'region',
    base: shop.ship_base_vnd != null ? Number(shop.ship_base_vnd) : null,
    perKm: shop.ship_per_km_vnd != null ? Number(shop.ship_per_km_vnd) : null,
    maxKm: shop.ship_max_km != null ? Number(shop.ship_max_km) : null,
    overMax: shop.ship_over_max_behavior ?? 'region',
  };
  const shipping = computeShipping(
    cfg,
    Number(order.subtotal_vnd),
    items,
    regionOf(province),
    { assumeFarWhenUnknown: true },
  );
  return { shippingVnd: Number(shipping) };
}

async function listOrderRequests(res, ctx, _body, _params, query) {
  const limit = Math.min(Math.max(parseInt(query.get('limit') ?? '50', 10) || 50, 1), 100);
  const offset = parseOffset(query);
  const status = STATUSES.has(query.get('status')) ? query.get('status') : 'requested';
  const type = TYPES.has(query.get('type')) ? query.get('type') : null;
  const args = [status];
  const typeSql = type ? (args.push(type), ` AND r.request_type = $${args.length}`) : '';
  const data = await withTenant(ctx.shopId, async (c) => {
    const total = Number((await c.query(
      `SELECT count(*)::int AS n FROM order_requests r WHERE r.status = $1${typeSql}`, args,
    )).rows[0].n);
    const rows = (await c.query(
      `SELECT r.id, r.order_id, r.request_type, r.requester_type, r.status, r.reason,
              r.request_payload, r.decision_note, r.resolution_payload, r.result_return_id,
              r.created_at, r.decided_at, r.completed_at, r.updated_at,
              o.order_number, o.status AS order_status, o.payment_status,
              o.customer_name, o.customer_phone
         FROM order_requests r JOIN orders o ON o.id = r.order_id
        WHERE r.status = $1${typeSql}
        ORDER BY r.created_at, r.id LIMIT ${limit} OFFSET ${offset}`, args,
    )).rows;
    return { total, requests: rows };
  });
  return send(res, 200, { ...data, limit, offset, status, type });
}

async function loadLocked(c, requestId) {
  return (await c.query(
    `SELECT r.*, o.order_number, o.status AS order_status, o.payment_status,
            o.customer_name, o.customer_phone, o.shipping_address,
            o.subtotal_vnd, o.shipping_vnd, o.total_vnd, o.amount_paid_vnd, o.paid_at
       FROM order_requests r JOIN orders o ON o.id = r.order_id
      WHERE r.id = $1 FOR UPDATE OF r, o`, [requestId],
  )).rows[0] ?? null;
}

async function rejectLocked(c, r, ctx, note, action = 'order_request.rejected') {
  await c.query(
    `UPDATE order_requests
        SET status = 'rejected', decision_note = $2, decided_by = $3,
            decided_at = now(), updated_at = now()
      WHERE id = $1`, [r.id, note, ctx.user.id],
  );
  await audit(c, action, {
    actorId: ctx.user.id,
    ip: ctx.ip,
    metadata: { request_id: r.id, order_id: r.order_id, order_number: Number(r.order_number), request_type: r.request_type, note },
  });
  await c.query(
    `SELECT record_order_event($1, 'order.request_rejected', 'user', $2, 'seller_admin', $3)`,
    [r.order_id, ctx.user.id, { request_id: r.id, request_type: r.request_type, reason: note }],
  );
}

async function approveOrderRequest(res, ctx, body, params) {
  const requestId = params[1];
  const decisionNote = String(body?.note ?? '').trim().slice(0, 500) || null;
  const out = await withTenant(ctx.shopId, async (c) => {
    const r = await loadLocked(c, requestId);
    if (!r) return { code: 404, body: { error: 'không tìm thấy yêu cầu' } };
    if (r.status === 'completed' || r.status === 'approved') {
      return { code: 200, body: { ok: true, id: r.id, status: r.status, replayed: true } };
    }
    if (r.status === 'rejected') return { code: 409, body: { error: 'yêu cầu đã bị từ chối' } };

    if (r.request_type === 'cancel') {
      const reason = r.reason || decisionNote || 'Khách yêu cầu huỷ đơn';
      const cancelled = await cancelOrderTx(c, r.order_id, {
        reason,
        actorId: ctx.user.id,
        ip: ctx.ip,
        source: 'customer_request',
      });
      if (cancelled.code !== 200) {
        const note = cancelled.code === 409
          ? `Không thể huỷ vì đơn đang ở trạng thái ${cancelled.cur}.`
          : (cancelled.msg ?? 'Không thể huỷ đơn ở trạng thái hiện tại.');
        await rejectLocked(c, r, ctx, note, 'order_request.auto_rejected');
        return { code: 409, body: { error: note, request_status: 'rejected' } };
      }
      await c.query(
        `UPDATE order_requests
            SET status = 'completed', decision_note = $2, decided_by = $3,
                decided_at = now(), completed_at = now(), updated_at = now(),
                resolution_payload = jsonb_build_object('order_status', 'cancelled')
          WHERE id = $1`, [r.id, decisionNote, ctx.user.id],
      );
      await audit(c, 'order_request.completed', {
        actorId: ctx.user.id, ip: ctx.ip,
        metadata: { request_id: r.id, order_id: r.order_id, request_type: r.request_type },
      });
      return { code: 200, body: { ok: true, id: r.id, status: 'completed', order_status: 'cancelled' } };
    }

    if (r.request_type === 'address_change') {
      const parsed = parseAddressPayload(r.request_payload);
      if (parsed.error) {
        await rejectLocked(c, r, ctx, `Dữ liệu địa chỉ không hợp lệ: ${parsed.error}`, 'order_request.auto_rejected');
        return { code: 409, body: { error: parsed.error, request_status: 'rejected' } };
      }
      const activeShipment = (await c.query(
        `SELECT 1 FROM shipments WHERE order_id = $1 AND status <> 'cancelled' LIMIT 1`, [r.order_id],
      )).rowCount > 0;
      if (!['pending', 'confirmed'].includes(r.order_status) || activeShipment) {
        const note = 'Đơn đã bắt đầu giao nên không thể đổi địa chỉ.';
        await rejectLocked(c, r, ctx, note, 'order_request.auto_rejected');
        return { code: 409, body: { error: note, request_status: 'rejected' } };
      }
      const next = parsed.value;
      const quote = await quoteAddressChange(c, r, next.province);
      if (quote.errorCode) return {
        code: 409,
        body: { error_code: quote.errorCode, error: quote.message, message: quote.message, action: quote.action },
      };
      const previousShipping = Number(r.shipping_vnd ?? 0);
      const nextShipping = Number(quote.shippingVnd);
      const shippingDelta = nextShipping - previousShipping;
      const hasRecordedPayment = Number(r.amount_paid_vnd ?? 0) > 0
        || r.paid_at != null
        || ['paid', 'refunded'].includes(r.payment_status);
      if (shippingDelta !== 0 && hasRecordedPayment) return {
        code: 409,
        body: {
          error_code: 'shipping_fee_change_requires_order_edit',
          error: `Phí giao hàng thay đổi từ ${previousShipping}đ thành ${nextShipping}đ trên đơn đã ghi nhận tiền.`,
          message: `Phí giao hàng thay đổi từ ${previousShipping}đ thành ${nextShipping}đ trên đơn đã ghi nhận tiền.`,
          action: 'Dùng luồng sửa đơn đã thanh toán để ghi nhận khoản thu thêm hoặc hoàn lại có chứng từ; không duyệt địa chỉ trực tiếp.',
          shipping_vnd: nextShipping,
          shipping_delta_vnd: shippingDelta,
        },
      };
      const previous = {
        recipient_name: r.customer_name,
        phone: r.customer_phone,
        ...(r.shipping_address && typeof r.shipping_address === 'object' ? r.shipping_address : {}),
      };
      const address = { line: next.line, province: next.province,
        ...(next.district ? { district: next.district } : {}), ...(next.ward ? { ward: next.ward } : {}) };
      const nextTotal = Number(r.total_vnd) + shippingDelta;
      await c.query(
        `UPDATE orders
            SET customer_name = $2, customer_phone = $3, shipping_address = $4,
                shipping_vnd = $5, total_vnd = $6
          WHERE id = $1`,
        [r.order_id, next.recipient_name, next.phone, address, nextShipping, nextTotal],
      );
      await c.query(
        `UPDATE order_requests
            SET status = 'completed', decision_note = $2, decided_by = $3,
                decided_at = now(), completed_at = now(), updated_at = now(),
                resolution_payload = $4
          WHERE id = $1`, [r.id, decisionNote, ctx.user.id, {
          previous,
          applied: next,
          previous_shipping_vnd: previousShipping,
          shipping_vnd: nextShipping,
          shipping_delta_vnd: shippingDelta,
        }],
      );
      await audit(c, 'order.address_changed_from_request', {
        actorId: ctx.user.id, ip: ctx.ip,
        metadata: {
          request_id: r.id,
          order_id: r.order_id,
          order_number: Number(r.order_number),
          previous,
          applied: next,
          previous_shipping_vnd: previousShipping,
          shipping_vnd: nextShipping,
          shipping_delta_vnd: shippingDelta,
        },
      });
      await c.query(
        `SELECT record_order_event($1, 'order.address_changed', 'user', $2, 'seller_admin', $3)`,
        [r.order_id, ctx.user.id, {
          request_id: r.id,
          previous_shipping_vnd: previousShipping,
          shipping_vnd: nextShipping,
          shipping_delta_vnd: shippingDelta,
        }],
      );
      return {
        code: 200,
        body: {
          ok: true,
          id: r.id,
          status: 'completed',
          shipping_vnd: nextShipping,
          shipping_delta_vnd: shippingDelta,
          total_vnd: nextTotal,
        },
      };
    }

    if (r.order_status !== 'delivered') {
      const note = 'Chỉ có thể duyệt trả hàng sau khi đơn đã giao.';
      await rejectLocked(c, r, ctx, note, 'order_request.auto_rejected');
      return { code: 409, body: { error: note, request_status: 'rejected' } };
    }
    await c.query(
      `UPDATE order_requests
          SET status = 'approved', decision_note = $2, decided_by = $3,
              decided_at = now(), updated_at = now()
        WHERE id = $1`, [r.id, decisionNote, ctx.user.id],
    );
    await audit(c, 'order_request.approved', {
      actorId: ctx.user.id, ip: ctx.ip,
      metadata: { request_id: r.id, order_id: r.order_id, order_number: Number(r.order_number), request_type: r.request_type },
    });
    await c.query(
      `SELECT record_order_event($1, 'return.approved', 'user', $2, 'seller_admin', $3)`,
      [r.order_id, ctx.user.id, { request_id: r.id }],
    );
    return { code: 200, body: { ok: true, id: r.id, status: 'approved', next_action: 'receive_return' } };
  });
  return send(res, out.code, out.body);
}

async function rejectOrderRequest(res, ctx, body, params) {
  const requestId = params[1];
  const note = String(body?.note ?? '').trim().slice(0, 500);
  if (!note) return send(res, 400, { error: 'cần nêu lý do từ chối để khách biết phải làm gì tiếp theo' });
  const out = await withTenant(ctx.shopId, async (c) => {
    const r = await loadLocked(c, requestId);
    if (!r) return { code: 404, body: { error: 'không tìm thấy yêu cầu' } };
    if (r.status === 'rejected') return { code: 200, body: { ok: true, id: r.id, status: 'rejected', replayed: true } };
    if (r.status !== 'requested') return { code: 409, body: { error: `không thể từ chối yêu cầu đang ở trạng thái ${r.status}` } };
    await rejectLocked(c, r, ctx, note);
    return { code: 200, body: { ok: true, id: r.id, status: 'rejected' } };
  });
  return send(res, out.code, out.body);
}

export const ORDER_REQUEST_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/order-requests$`), perm: 'orders.read', fn: (res, ctx, b, p, q) => listOrderRequests(res, ctx, b, p, q) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/order-requests/${UUID}/approve$`), perm: 'orders.write', fn: (res, ctx, b, p) => approveOrderRequest(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/order-requests/${UUID}/reject$`), perm: 'orders.write', fn: (res, ctx, b, p) => rejectOrderRequest(res, ctx, b, p) },
];
