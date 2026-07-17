/**
 * Quản lý đơn hàng (seller). Ngày 15.
 *
 * State machine: pending → confirmed → shipped → delivered; huỷ từ pending/confirmed.
 * Mỗi chuyển trạng thái ghi outbox 'order.status_changed' (email) TRONG cùng transaction.
 * Huỷ đơn RELEASE reserve tồn kho (trả lại chỗ đã giữ lúc checkout).
 */
import crypto from 'node:crypto';
import { send } from './http.js';
import { withTenant, audit } from './db.js';
import { isProvince } from './provinces.js';

// Base URL ảnh public (giống storefront) — dựng thumbnail dòng hàng trong chi tiết đơn.
const MEDIA_PUBLIC_BASE = process.env.MEDIA_PUBLIC_BASE ?? '/media-public';
// Phí ship mặc định nền tảng (mirror checkout — '' lọt qua ?? nên phải kiểm hữu hạn).
const SHIP_FEE = (() => { const r = process.env.SHIP_FEE_VND; return (r != null && r !== '' && Number.isFinite(Number(r))) ? Number(r) : 30000; })();

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Chuẩn hoá SĐT (mirror checkout canonPhone): chỉ số, +84→0, tối thiểu 8 số.
function canonPhone(p) {
  let d = String(p ?? '').replace(/\D/g, '');
  if (d.startsWith('84') && d.length > 9) d = '0' + d.slice(2);
  return d.length >= 8 ? d : null;
}
// Biến thể KHÔNG mồ côi (mirror checkout/storefront 0057): phải có ánh xạ cho MỌI trục.
const VARIANT_NOT_ORPHAN_SQL = `NOT EXISTS (
  SELECT 1 FROM product_options po WHERE po.product_id = v.product_id
    AND NOT EXISTS (SELECT 1 FROM variant_option_values vov
                     WHERE vov.variant_id = v.id AND vov.option_id = po.id))`;
const genToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

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
  if (['pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'refunded', 'returned'].includes(status)) { args.push(status); where.push(`status = $${args.length}`); }
  // Tìm: mã đơn (nếu q toàn số) hoặc tên/điện thoại khách (ILIKE, escape wildcard).
  const q = (query.get('q') ?? '').trim().slice(0, 100);
  if (q) {
    // Tên khách tìm KHÔNG DẤU (0048): "nguyen" khớp "Nguyễn". SĐT giữ ILIKE (toàn số).
    const like = '%' + q.replace(/[%_\\]/g, '\\$&') + '%';
    if (/^\d{1,15}$/.test(q)) {
      args.push(Number(q)); const on = args.length;
      args.push(like); const lk = args.length;
      where.push(`(order_number = $${on} OR customer_phone ILIKE $${lk} OR vn_unaccent(customer_name) LIKE vn_unaccent($${lk}))`);
    } else {
      args.push(like); const lk = args.length;
      where.push(`(vn_unaccent(customer_name) LIKE vn_unaccent($${lk}) OR customer_phone ILIKE $${lk})`);
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
              customer_name, customer_phone, customer_email, shipping_address, note, created_at, paid_at, shipped_at, delivered_at
         FROM orders WHERE id = $1`, [orderId],
    )).rows[0];
    if (!o) return null;
    // Ảnh dòng hàng: ưu tiên ảnh RIÊNG của biến thể, không có thì lấy ảnh CHÍNH của sản phẩm.
    o.lines = (await c.query(
      `SELECT ol.title_snapshot, ol.sku_snapshot, ol.unit_price_vnd, ol.qty,
              (SELECT m.public_key FROM media m
                 JOIN variants v ON v.product_id = m.product_id
                WHERE v.id = ol.variant_id AND m.status = 'ready' AND m.deleted_at IS NULL
                  AND (m.variant_id = ol.variant_id OR m.variant_id IS NULL)
                ORDER BY (m.variant_id IS NOT NULL) DESC, m.position, m.created_at LIMIT 1) AS image_key
         FROM order_lines ol WHERE ol.order_id = $1`, [o.id]
    )).rows.map(({ image_key, ...l }) => ({ ...l, image_url: image_key ? `${MEDIA_PUBLIC_BASE}/${image_key}` : null }));
    o.shipments = (await c.query(`SELECT carrier, tracking_number, status, provider, carrier_fee_vnd, provider_status FROM shipments WHERE order_id = $1`, [o.id])).rows;
    return o;
  });
  if (!data) return send(res, 404, { error: 'không tìm thấy đơn' });
  return send(res, 200, data);
}

// XÁC NHẬN HÀNG LOẠT: mỗi đơn 1 transaction RIÊNG → thành công một phần (đơn đã
// confirm/huỷ bị bỏ qua, không chặn cả lô). Trần 100 đơn/lần.
async function bulkConfirm(res, ctx, body) {
  const ids = Array.isArray(body.order_ids) ? [...new Set(body.order_ids.filter((x) => typeof x === 'string' && /^[0-9a-f-]{36}$/.test(x)))] : [];
  if (!ids.length) return send(res, 400, { error: 'không có đơn nào được chọn' });
  if (ids.length > 100) return send(res, 400, { error: 'tối đa 100 đơn mỗi lần' });
  let confirmed = 0, skipped = 0;
  for (const orderId of ids) {
    try {
      const out = await withTenant(ctx.shopId, async (c) => {
        const o = (await c.query(`SELECT id, status, order_number, customer_email FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
        if (!o || o.status !== 'pending') return false;
        await c.query(`UPDATE orders SET status = 'confirmed' WHERE id = $1`, [orderId]);
        o.status = 'confirmed';
        await audit(c, 'order.confirmed', { actorId: ctx.user.id, ip: ctx.ip, metadata: { orderId, bulk: true } });
        await statusEvent(c, o);
        return true;
      });
      out ? confirmed++ : skipped++;
    } catch { skipped++; }
  }
  return send(res, 200, { ok: true, confirmed, skipped });
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

/**
 * CONSUME tồn + chốt shipped — DÙNG CHUNG cho giao tay (shipOrder) và giao qua hãng
 * VC (shipping.js carrier-shipment). PHẢI gọi trong transaction đã khoá đơn FOR UPDATE
 * với o.status === 'confirmed'. Mỗi dòng: on_hand -= qty, reserved -= qty, ghi ledger
 * 'ship' (giữ bất biến tổng delta ledger == on_hand). shipmentId có sẵn (đường hãng —
 * dòng claim đã tạo trước) → UPDATE; không có → INSERT dòng mới.
 */
export async function consumeAndShip(c, ctx, o, { tracking, carrier = null, shipmentId = null, provider = null, fee = null, providerStatus = null }) {
  const lines = (await c.query(`SELECT variant_id, qty FROM order_lines WHERE order_id = $1`, [o.id])).rows;
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
  if (shipmentId) {
    await c.query(
      `UPDATE shipments SET carrier = $2, tracking_number = $3, status = 'in_transit',
              carrier_fee_vnd = $4, provider_status = $5, synced_at = now() WHERE id = $1`,
      [shipmentId, carrier, tracking, fee, providerStatus],
    );
  } else {
    await c.query(`INSERT INTO shipments (shop_id, order_id, carrier, tracking_number, status) VALUES (current_shop_id(), $1, $2, $3, 'in_transit')`, [o.id, carrier, tracking]);
  }
  await c.query(`UPDATE orders SET status = 'shipped', shipped_at = now() WHERE id = $1`, [o.id]);
  o.status = 'shipped';
  await audit(c, 'order.shipped', { actorId: ctx.user.id, ip: ctx.ip, metadata: { orderId: o.id, tracking, ...(provider ? { provider } : {}) } });
  await statusEvent(c, o, { tracking_number: tracking });
}

async function shipOrder(res, ctx, body, params) {
  const orderId = params[1];
  const tracking = String(body.tracking_number ?? '').trim();
  const carrier = String(body.carrier ?? '').trim();
  if (tracking.length < 1 || tracking.length > 64) return send(res, 400, { error: 'mã vận đơn không hợp lệ' });
  const out = await withTenant(ctx.shopId, async (c) => {
    const o = (await c.query(`SELECT id, status, order_number, customer_email FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
    if (!o) return { code: 404 };
    if (o.status !== 'confirmed') return { code: 409, cur: o.status }; // idempotent: ship lần 2 → 409
    // Chặn giao TAY khi đang có vận đơn hãng chạy (kể cả claim 'created' đang chờ chốt)
    // — cùng guard với đường hãng, index 0046 làm backstop DB.
    const live = (await c.query(`SELECT 1 FROM shipments WHERE order_id = $1 AND status IN ('created','in_transit')`, [orderId])).rows[0];
    if (live) return { code: 4091 };
    await consumeAndShip(c, ctx, o, { tracking, carrier: carrier || null });
    return { code: 200 };
  }).catch((e) => (e.code === '23505' ? { code: 4091 } : Promise.reject(e)));
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy đơn' });
  if (out.code === 4091) return send(res, 409, { error: 'đơn đã có vận đơn đang chạy' });
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
    if (['cancelled', 'refunded', 'returned'].includes(o.status)) return { code: 409, msg: 'đơn đã huỷ/hoàn/trả, không thể đánh dấu đã nhận tiền' };
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
    if (['cancelled', 'refunded', 'returned'].includes(o.status)) return { code: 409, msg: 'đơn đã huỷ/hoàn/trả, không thể xác nhận thanh toán' };
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

// ── TẠO ĐƠN THỦ CÔNG (nhân viên chốt đơn qua Facebook/Zalo rồi gõ vào hệ thống) ──
// Mirror bất biến của checkout createOrderTx: giá 100% server-side từ variants.price_vnd
// (snapshot), MỘT transaction FOR UPDATE reserve tồn, shop_counters, outbox cùng tx.
// KHÁC checkout: KHÔNG bot-guard/trần IP (nhân viên tạo, client_ip_hash NULL), phí ship
// cho phép GHI ĐÈ tay (nhân viên biết phí đã thoả thuận), không coupon (v1).

// Danh sách biến thể BÁN ĐƯỢC cho form chọn (perm orders.write — nhân viên đơn không
// chắc có catalog.read). Chỉ SP active + biến thể không mồ côi, kèm tồn khả dụng.
async function listSellableVariants(res, ctx) {
  const rows = await withTenant(ctx.shopId, async (c) =>
    (await c.query(
      `SELECT v.id, p.title AS product_title, v.title AS variant_title, v.sku, v.price_vnd,
              coalesce(il.on_hand - il.reserved, 0)::int AS available
         FROM variants v
         JOIN products p ON p.id = v.product_id AND p.status = 'active' AND p.deleted_at IS NULL
         LEFT JOIN inventory_levels il ON il.variant_id = v.id
        WHERE ${VARIANT_NOT_ORPHAN_SQL}
        ORDER BY p.title, v.title NULLS FIRST, v.sku
        LIMIT 500`,
    )).rows);
  return send(res, 200, { variants: rows.map((r) => ({ ...r, price_vnd: Number(r.price_vnd) })) });
}

async function createManualOrder(res, ctx, body) {
  // ── validate đầu vào (giá/total client gửi bị BỎ QUA — như checkout) ──
  const rawLines = Array.isArray(body?.lines) ? body.lines : [];
  const lines0 = rawLines.filter((l) => l && UUID_RE.test(String(l.variant_id ?? '')) && Number.isInteger(Number(l.qty)) && Number(l.qty) >= 1 && Number(l.qty) <= 1000)
    .map((l) => ({ variant_id: String(l.variant_id), qty: Number(l.qty) }));
  if (lines0.length === 0 || lines0.length > 50) return send(res, 400, { error: 'đơn cần 1-50 dòng hàng hợp lệ' });
  const name = String(body?.customer?.name ?? '').trim();
  const phoneRaw = String(body?.customer?.phone ?? '').trim();
  const phone = canonPhone(phoneRaw);
  if (!name || name.length > 120) return send(res, 400, { error: 'thiếu tên khách (≤120 ký tự)' });
  if (!phone) return send(res, 400, { error: 'SĐT không hợp lệ (tối thiểu 8 số)' });
  const email = String(body?.customer?.email ?? '').trim().toLowerCase() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: 'email không hợp lệ' });
  const addressLine = String(body?.customer?.address_line ?? '').trim().slice(0, 300) || null;
  const province = String(body?.customer?.province ?? '').trim().slice(0, 60) || null;
  // Validate tỉnh (nếu ghi) — form tạo vận đơn GHN/GHTK prefill từ đây, tỉnh sai = hãng từ chối.
  if (province && !isProvince(province)) return send(res, 400, { error: 'tỉnh/thành không hợp lệ (chọn theo danh sách 34 tỉnh thành)' });
  const paymentMethod = body?.payment_method === 'qr' ? 'qr' : 'cod';
  const note = String(body?.note ?? '').trim().slice(0, 500) || null;
  // Phí ship: nhân viên ghi đè (>=0), không ghi → tính theo cấu hình shop (phẳng + ngưỡng).
  const shipOverride = body?.ship_fee_vnd != null && body.ship_fee_vnd !== ''
    ? Number(body.ship_fee_vnd) : null;
  if (shipOverride != null && !(Number.isInteger(shipOverride) && shipOverride >= 0 && shipOverride <= 10_000_000)) {
    return send(res, 400, { error: 'phí ship ghi đè không hợp lệ' });
  }
  // Idempotency: chống double-submit form (key do BFF sinh, nhét hidden input).
  const idemKey = String(body?.idempotency_key ?? '');
  if (idemKey.length < 8 || idemKey.length > 200) return send(res, 400, { error: 'thiếu idempotency_key' });

  // Lỗi nghiệp vụ PHẢI throw (không return {code}) → withTenant ROLLBACK: nhả reserve
  // dở dang + nhả idempotency claim (retry sạch). Dispatcher seller đọc err.statusCode.
  const fail = (statusCode, msg) => { throw Object.assign(new Error(msg), { statusCode }); };
  const out = await withTenant(ctx.shopId, async (c) => {
    const requestHash = sha256(idemKey + JSON.stringify({ lines: lines0, name, phone, email, addressLine, province, paymentMethod, shipOverride }));
    const claim = await c.query(
      `INSERT INTO idempotency_keys (shop_id, key, request_hash, status)
       VALUES (current_shop_id(), $1, $2, 'in_progress')
       ON CONFLICT (shop_id, key) DO NOTHING RETURNING key`, [idemKey, requestHash],
    );
    if (claim.rows.length === 0) {
      const ex = (await c.query(`SELECT request_hash, status, response_code, response_body FROM idempotency_keys WHERE key = $1`, [idemKey])).rows[0];
      if (!ex || ex.request_hash !== requestHash) fail(422, 'idempotency_key dùng lại với nội dung khác');
      if (ex.status === 'completed') return { code: ex.response_code, body: ex.response_body };
      fail(409, 'đơn đang được xử lý, thử lại');
    }

    // Gộp dòng trùng biến thể (chọn 2 slot cùng SP trên form) → 1 dòng cộng dồn qty.
    const byVid = new Map();
    for (const l of lines0) byVid.set(l.variant_id, (byVid.get(l.variant_id) ?? 0) + l.qty);

    // Khoá tồn + reserve + snapshot giá server-side. Chỉ SP active + không mồ côi.
    // SORT theo variant_id trước khi FOR UPDATE → 2 nhân viên tạo đơn chéo biến thể
    // không deadlock (thứ tự khoá cố định).
    let subtotal = 0;
    const lines = [];
    for (const [vid, qty] of [...byVid.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const v = (await c.query(
        `SELECT v.id, v.price_vnd, v.title AS variant_title, v.sku, p.title AS product_title
           FROM variants v JOIN products p ON p.id = v.product_id AND p.status = 'active' AND p.deleted_at IS NULL
          WHERE v.id = $1 AND ${VARIANT_NOT_ORPHAN_SQL}`, [vid],
      )).rows[0];
      if (!v) fail(422, 'sản phẩm không tồn tại hoặc ngừng bán');
      const lvl = (await c.query(`SELECT on_hand, reserved FROM inventory_levels WHERE variant_id = $1 FOR UPDATE`, [vid])).rows[0];
      const available = lvl ? lvl.on_hand - lvl.reserved : 0;
      if (qty > available) fail(422, `hết hàng: ${v.product_title} (còn ${Math.max(0, available)})`);
      await c.query(`UPDATE inventory_levels SET reserved = reserved + $2, updated_at = now() WHERE variant_id = $1`, [vid, qty]);
      const unit = Number(v.price_vnd);
      subtotal += unit * qty;
      lines.push({ variant_id: vid, title: v.product_title + (v.variant_title ? ` - ${v.variant_title}` : ''), sku: v.sku, unit, qty });
    }

    // Phí ship: ghi đè tay ?? cấu hình shop (mirror checkout computeShipping, phẳng+ngưỡng).
    let shipping = shipOverride;
    if (shipping == null) {
      const s = (await c.query(`SELECT ship_fee_vnd, free_ship_threshold_vnd FROM shops WHERE id = current_shop_id()`)).rows[0] ?? {};
      const fee = s.ship_fee_vnd != null ? Number(s.ship_fee_vnd) : SHIP_FEE;
      const threshold = s.free_ship_threshold_vnd != null ? Number(s.free_ship_threshold_vnd) : null;
      shipping = (threshold != null && subtotal >= threshold) ? 0 : fee;
    }
    const total = subtotal + shipping;

    // QR: cần shop đã bật; payment_ref để webhook SePay tự khớp. KHÔNG cần dựng qr_string —
    // trang /checkout/success (link trong email) tự vẽ QR cho đơn QR chưa trả.
    let paymentRef = null, qrAccount = null;
    if (paymentMethod === 'qr') {
      const cfg = (await c.query(`SELECT bank_bin, account_number, qr_enabled FROM shop_payment_config WHERE shop_id = current_shop_id()`)).rows[0];
      if (!cfg || !cfg.qr_enabled || !cfg.bank_bin || !cfg.account_number) fail(400, 'shop chưa bật thanh toán QR');
      paymentRef = 'NTG' + crypto.randomBytes(6).toString('hex').toUpperCase();
      qrAccount = cfg.account_number;
    }

    const num = (await c.query(
      `INSERT INTO shop_counters (shop_id, name, value) VALUES (current_shop_id(), 'order_number', 1)
       ON CONFLICT (shop_id, name) DO UPDATE SET value = shop_counters.value + 1 RETURNING value`,
    )).rows[0].value;
    const lookupToken = genToken();
    const address = (addressLine || province) ? { ...(addressLine ? { line: addressLine } : {}), ...(province ? { province } : {}) } : null;
    const order = (await c.query(
      `INSERT INTO orders (shop_id, order_number, status, payment_status, payment_method,
         customer_name, customer_phone, customer_email, shipping_address,
         subtotal_vnd, shipping_vnd, discount_vnd, total_vnd, lookup_token_hash, payment_ref, qr_account, client_ip_hash, note)
       VALUES (current_shop_id(), $1, 'pending', 'unpaid', $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, $11, $12, NULL, $13) RETURNING id`,
      [num, paymentMethod, name, phone, email, address, subtotal, shipping, total, hashToken(lookupToken), paymentRef, qrAccount, note],
    )).rows[0];
    for (const ln of lines) {
      await c.query(
        `INSERT INTO order_lines (shop_id, order_id, variant_id, title_snapshot, sku_snapshot, unit_price_vnd, qty)
         VALUES (current_shop_id(), $1, $2, $3, $4, $5, $6)`,
        [order.id, ln.variant_id, ln.title, ln.sku, ln.unit, ln.qty],
      );
    }

    // Email xác nhận cho khách (nếu có email): link tra cứu trỏ DOMAIN CHÍNH của shop —
    // trang /checkout/success hiện chi tiết + QR trả tiền (đơn QR). Không email → outbox
    // vẫn phát để chủ shop nhận Telegram "đơn mới" (nhất quán với checkout).
    let link;
    if (email) {
      const host = (await c.query(`SELECT hostname FROM domains WHERE shop_id = current_shop_id() AND is_primary AND verified_at IS NOT NULL LIMIT 1`)).rows[0]?.hostname;
      if (host) link = `https://${host}/checkout/success?number=${Number(num)}&token=${lookupToken}`;
    }
    await c.query(
      `INSERT INTO outbox (shop_id, topic, payload) VALUES (current_shop_id(), 'order.created', $1)`,
      [{ ...(email ? { to: email } : {}), order_number: Number(num), total_vnd: total, customer_name: name, payment_method: paymentMethod, source: 'manual', ...(link ? { link } : {}) }],
    );
    await audit(c, 'order.created_manual', { actorId: ctx.user.id, ip: ctx.ip, metadata: { order_number: Number(num), total_vnd: total, lines: lines.length } });

    const response = { id: order.id, order_number: Number(num), subtotal_vnd: subtotal, shipping_vnd: shipping, total_vnd: total, status: 'pending', payment_method: paymentMethod, ...(paymentRef ? { payment_ref: paymentRef } : {}) };
    await c.query(`UPDATE idempotency_keys SET status = 'completed', response_code = 201, response_body = $2 WHERE key = $1`, [idemKey, response]);
    return { code: 201, body: response };
  });
  return send(res, out.code, out.body);
}

export const ORDER_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/orders$`), perm: 'orders.read', fn: (res, ctx, b, p, q) => listOrders(res, ctx, b, p, q) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders$`), perm: 'orders.write', fn: (res, ctx, b) => createManualOrder(res, ctx, b) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/sellable-variants$`), perm: 'orders.write', fn: (res, ctx) => listSellableVariants(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/bulk/confirm$`), perm: 'orders.write', fn: (res, ctx, b) => bulkConfirm(res, ctx, b) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/orders/${UUID}$`), perm: 'orders.read', fn: (res, ctx, b, p) => getOrder(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/confirm$`), perm: 'orders.write', fn: (res, ctx, b, p) => confirmOrder(res, ctx, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/ship$`), perm: 'orders.write', fn: (res, ctx, b, p) => shipOrder(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/deliver$`), perm: 'orders.write', fn: (res, ctx, b, p) => deliverOrder(res, ctx, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/cancel$`), perm: 'orders.write', fn: (res, ctx, b, p) => cancelOrder(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/mark-paid$`), perm: 'orders.write', fn: (res, ctx, b, p) => markPaid(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/mark-paid-qr$`), perm: 'payment.write', stepUp: true, fn: (res, ctx, b, p) => markPaidQr(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/refund$`), perm: 'refund', stepUp: true, fn: (res, ctx, b, p) => refundOrder(res, ctx, b, p) },
];
