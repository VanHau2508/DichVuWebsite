/**
 * Quản lý đơn hàng (seller). Ngày 15.
 *
 * State machine: pending → confirmed → shipped → delivered; huỷ từ pending/confirmed.
 * Mỗi chuyển trạng thái ghi outbox 'order.status_changed' (email) TRONG cùng transaction.
 * Huỷ đơn RELEASE reserve tồn kho (trả lại chỗ đã giữ lúc checkout).
 */
import crypto from 'node:crypto';
import { send, parseOffset } from './http.js';
import { withTenant, audit } from './db.js';
import { toCsv, CsvText, EXPORT_ORDERS_MAX_ROWS } from './export.js';
import { isProvince } from './provinces.js';

// Base URL ảnh public (giống storefront) — dựng thumbnail dòng hàng trong chi tiết đơn.
const MEDIA_PUBLIC_BASE = process.env.MEDIA_PUBLIC_BASE ?? '/media-public';
// Phí ship mặc định nền tảng (mirror checkout — '' lọt qua ?? nên phải kiểm hữu hạn).
const SHIP_FEE = (() => { const r = process.env.SHIP_FEE_VND; return (r != null && r !== '' && Number.isFinite(Number(r))) ? Number(r) : 30000; })();

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
// Nguồn đơn hợp lệ — PHẢI khớp CHECK của cột orders.source (migration 0119). Thêm kênh
// mới thì sửa cả hai nơi trong cùng commit; lệch nhau thì DB từ chối và người bán thấy
// lỗi 500 thay vì thông báo tử tế.
const ORDER_SOURCES = new Set(['web', 'manual', 'facebook', 'zalo', 'tiktok', 'other']);
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
  // NGUỒN đơn quyết định có kênh báo nào ngoài email không (0122). Đơn chốt trong chat
  // Facebook KHÔNG có email — bot không hỏi email, và bắt khách gõ email trong chat là
  // thêm một bước để họ bỏ giữa chừng. Trước đây hàm này `return` ngay khi thiếu email,
  // nghĩa là đơn từ bot sẽ KHÔNG phát sự kiện nào — khách đặt xong rồi im lặng mãi mãi.
  const src = (await c.query(
    `SELECT source, source_ref FROM orders WHERE id = $1 AND shop_id = current_shop_id()`, [order.id],
  )).rows[0] ?? {};
  const psid = /[?&]psid=([^&\s]+)$/.exec(src.source_ref ?? '')?.[1] ?? null;
  const canMessenger = src.source === 'facebook' && !!psid;
  if (!order.customer_email && !canMessenger) return;
  // shop_name → email báo trạng thái hiện ĐÚNG brand cửa hàng (trước đây thiếu → rơi về 'nentang.vn');
  // customer_name → cá nhân hoá "Chào <tên>". Email builder (worker compose) đã dùng 2 field này +
  // tracking_number (shipped truyền qua extra) — chỉ thiếu ở payload nên bổ sung tại đây.
  const shopName = (await c.query(`SELECT name FROM shops WHERE id = current_shop_id()`)).rows[0]?.name ?? null;
  await c.query(
    `INSERT INTO outbox (shop_id, topic, payload) VALUES (current_shop_id(), 'order.status_changed', $1)`,
    // `to` để null khi không có email — deliverNotification tự bỏ qua, không gửi tới địa chỉ ma.
    [{ to: order.customer_email ?? null, order_number: Number(order.order_number), status: order.status,
       shop_name: shopName, customer_name: order.customer_name ?? null,
       ...(canMessenger ? { messenger_psid: psid } : {}), ...extra }],
  );
}

const ORDER_STATUSES = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'refunded', 'returned'];
// Allowlist khớp CHECK constraint của DB (0002). 'pending' = chờ đối soát chuyển khoản.
const PAYMENT_STATUSES = ['unpaid', 'pending', 'paid', 'refunded'];
// Bộ lọc đơn dùng CHUNG cho danh sách và xuất CSV — MỘT nguồn sự thật, để "xuất theo bộ lọc
// đang xem" không bao giờ lệch với thứ người bán đang nhìn.
//
// HAI bộ điều kiện dựng ĐỘC LẬP (không cắt-ghép/đánh-số-lại tham số — cách đó sai ngay khi
// một tham số dùng ở 2 chỗ, như $lk trong mệnh đề tìm kiếm):
//   whereNoStatusSql/countArgs = tìm kiếm + khoảng ngày → SỐ ĐẾM cho TAB trạng thái.
//   whereSql/args              = trên + mệnh đề status  → danh sách/CSV đang xem.
// Tab phải đếm "trong kết quả tìm hiện tại, mỗi trạng thái có bao nhiêu đơn"; đếm kèm cả
// filter status thì mọi tab về 0 trừ tab đang chọn.
//
// Cột để TRẦN (không qualify o.*): mọi truy vấn dùng helper này chỉ có MỘT bảng orders.
// Nếu sau này JOIN order_lines/shipments thì PHẢI qualify (shipments cũng có cột status).
function buildOrderFilter(query) {
  const where = [];
  const args = [];
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
  // Lọc theo NGUỒN đơn (0119). Giá trị lạ bị BỎ QUA (không lọc) chứ không lỗi: đây là
  // tham số trên URL, người dùng sửa tay hoặc link cũ không được làm vỡ trang danh sách.
  const src = (query.get('source') ?? '').trim();
  if (ORDER_SOURCES.has(src)) { args.push(src); where.push(`source = $${args.length}`); }
  // Lọc theo TÌNH TRẠNG THANH TOÁN. Ô "Đơn chưa thu tiền" ở Tổng quan bấm vào đây —
  // docs/44 §7: bấm vào con số phải ra ĐÚNG danh sách đã lọc, không phải danh sách đầy đủ.
  // Ô báo "3 đơn chưa thu" mà mở ra 400 đơn thì tệ hơn không có link: người bán mất niềm
  // tin vào con số, và lần sau không bấm nữa.
  // Đặt TRƯỚC mốc chốt countArgs ⇒ số đếm trên tab trạng thái cũng nằm trong phạm vi lọc
  // ("trong các đơn chưa thu tiền, có bao nhiêu đơn đang chờ xác nhận").
  const payment = query.get('payment');
  if (PAYMENT_STATUSES.includes(payment)) { args.push(payment); where.push(`payment_status = $${args.length}`); }
  // Chốt bản "không kể trạng thái" TRƯỚC khi thêm mệnh đề status → khỏi phải đánh số lại.
  const countArgs = [...args];
  const whereNoStatusSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  // Giờ mới thêm status (luôn là tham số CUỐI) cho truy vấn danh sách.
  const status = query.get('status');
  if (ORDER_STATUSES.includes(status)) { args.push(status); where.push(`status = $${args.length}`); }
  return {
    args, countArgs, whereNoStatusSql,
    whereSql: where.length ? 'WHERE ' + where.join(' AND ') : '',
    status: ORDER_STATUSES.includes(status) ? status : '',
    payment: PAYMENT_STATUSES.includes(payment) ? payment : '', from, to, q,
  };
}

async function listOrders(res, ctx, _b, _p, query) {
  const limit = Math.min(Math.max(parseInt(query.get('limit') ?? '20', 10) || 20, 1), 100);
  const offset = parseOffset(query);
  const { args, countArgs, whereNoStatusSql, whereSql } = buildOrderFilter(query);
  const data = await withTenant(ctx.shopId, async (c) => {
    const total = (await c.query(`SELECT count(*)::int n FROM orders ${whereSql}`, args)).rows[0].n;
    // Số đếm theo trạng thái cho TAB (kiểu TikTok Shop/Shopee) — 1 lần quét, FILTER theo status.
    const cnt = (await c.query(`
      SELECT count(*)::int AS all_n,
             count(*) FILTER (WHERE status = 'pending')   AS pending,
             count(*) FILTER (WHERE status = 'confirmed') AS confirmed,
             count(*) FILTER (WHERE status = 'shipped')   AS shipped,
             count(*) FILTER (WHERE status = 'delivered') AS delivered,
             count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
             count(*) FILTER (WHERE status = 'refunded')  AS refunded,
             count(*) FILTER (WHERE status = 'returned')  AS returned
        FROM orders ${whereNoStatusSql}`, countArgs)).rows[0];
    const rows = (await c.query(
      `SELECT o.id, o.order_number, o.status, o.payment_status, o.payment_method, o.total_vnd, o.customer_name, o.created_at, o.source, o.is_migrated,
              (SELECT count(DISTINCT o2.customer_phone)::int FROM orders o2
                 WHERE o2.shop_id = current_shop_id() AND o2.client_ip_hash = o.client_ip_hash
                   AND o2.client_ip_hash IS NOT NULL AND o2.status = 'pending') AS same_ip_phones
         FROM orders o ${whereSql} ORDER BY o.order_number DESC LIMIT ${limit} OFFSET ${offset}`, args,
    )).rows;
    const n = (x) => Number(x ?? 0);
    return { total, orders: rows, counts: {
      '': n(cnt.all_n), pending: n(cnt.pending), confirmed: n(cnt.confirmed), shipped: n(cnt.shipped),
      delivered: n(cnt.delivered), cancelled: n(cnt.cancelled), refunded: n(cnt.refunded), returned: n(cnt.returned),
    } };
  });
  return send(res, 200, { ...data, limit, offset });
}

async function getOrder(res, ctx, _b, params) {
  const orderId = params[1];
  const data = await withTenant(ctx.shopId, async (c) => {
    const o = (await c.query(
      `SELECT id, order_number, status, payment_status, payment_method, fulfillment_status, subtotal_vnd, shipping_vnd, total_vnd,
              customer_name, customer_phone, customer_email, shipping_address, note, created_at, paid_at, shipped_at, delivered_at,
              cancelled_at, cancel_reason, source, source_ref
         FROM orders WHERE id = $1`, [orderId],
    )).rows[0];
    if (!o) return null;
    // Ảnh dòng hàng: ưu tiên ảnh RIÊNG của biến thể, không có thì lấy ảnh CHÍNH của sản phẩm.
    o.lines = (await c.query(
      `SELECT ol.id AS order_line_id, ol.variant_id, ol.title_snapshot, ol.sku_snapshot, ol.unit_price_vnd, ol.qty, ol.shipped_qty,
              (SELECT m.public_key FROM media m
                 JOIN variants v ON v.product_id = m.product_id
                WHERE v.id = ol.variant_id AND m.status = 'ready' AND m.deleted_at IS NULL
                  AND (m.variant_id = ol.variant_id OR m.variant_id IS NULL)
                ORDER BY (m.variant_id IS NOT NULL) DESC, m.position, m.created_at LIMIT 1) AS image_key
         FROM order_lines ol WHERE ol.order_id = $1`, [o.id]
    )).rows.map(({ image_key, ...l }) => ({ ...l, image_url: image_key ? `${MEDIA_PUBLIC_BASE}/${image_key}` : null }));
    o.shipments = (await c.query(
      `SELECT s.id, s.carrier, s.tracking_number, s.status, s.provider, s.carrier_fee_vnd, s.provider_status,
              coalesce((SELECT json_agg(json_build_object('order_line_id', sl.order_line_id, 'sku', ol.sku_snapshot, 'qty', sl.qty))
                          FROM shipment_lines sl JOIN order_lines ol ON ol.id = sl.order_line_id
                         WHERE sl.shipment_id = s.id), '[]') AS lines
         FROM shipments s WHERE s.order_id = $1 ORDER BY s.created_at`, [o.id])).rows;
    // Lịch sử hoàn tiền (bút toán 0070). LEFT JOIN users: người thao tác đã rời shop →
    // email NULL nhưng dòng VẪN hiện (mirror audit-log.js — không nuốt chứng từ).
    o.refunds = (await c.query(
      `SELECT r.amount_vnd, r.reason, r.restock, r.created_at, u.email AS created_by_email
         FROM refunds r LEFT JOIN users u ON u.id = r.created_by
        WHERE r.order_id = $1 ORDER BY r.created_at, r.id`, [o.id],
    )).rows.map((r) => ({ ...r, amount_vnd: Number(r.amount_vnd) }));
    o.refunded_total_vnd = o.refunds.reduce((s, r) => s + r.amount_vnd, 0);
    // Đổi-trả (RMA 0078): lịch sử phiếu trả + qty ĐÃ TRẢ mỗi biến thể (form trả biết còn
    // trả được bao nhiêu). LEFT JOIN users: người thao tác đã rời shop → email NULL, dòng còn.
    o.returns = (await c.query(
      `SELECT r.id, r.reason, r.refund_vnd, r.restocked, r.created_at, u.email AS created_by_email,
              coalesce((SELECT sum(rl.qty)::int FROM return_lines rl WHERE rl.return_id = r.id), 0) AS qty
         FROM returns r LEFT JOIN users u ON u.id = r.created_by
        WHERE r.order_id = $1 ORDER BY r.created_at, r.id`, [o.id],
    )).rows.map((r) => ({ ...r, refund_vnd: Number(r.refund_vnd), qty: Number(r.qty) }));
    const retByVid = new Map();
    for (const rr of (await c.query(
      `SELECT rl.variant_id, sum(rl.qty)::int AS q FROM return_lines rl JOIN returns r ON r.id = rl.return_id
        WHERE r.order_id = $1 GROUP BY rl.variant_id`, [o.id])).rows) retByVid.set(rr.variant_id, Number(rr.q));
    o.lines = o.lines.map((l) => ({ ...l, returned_qty: retByVid.get(l.variant_id) ?? 0 }));
    // Khối lượng ƯỚC TÍNH cho form vận đơn (prefill, shop sửa được): Σ qty × cân biến thể
    // SỐNG (NULL → mặc định shop). KHÔNG snapshot trên order_lines — shop đổi cân sau khi
    // đơn tạo thì prefill lệch, chấp nhận v1; phí ship ĐÃ THU của khách chốt tại
    // createOrderTx (checkout) nên không lệch tiền.
    o.est_weight_gram = Number((await c.query(
      `SELECT coalesce(sum(ol.qty * coalesce(v.weight_gram, s.default_weight_gram)), 0)::int AS g
         FROM order_lines ol JOIN variants v ON v.id = ol.variant_id
         JOIN shops s ON s.id = current_shop_id() WHERE ol.order_id = $1`, [o.id])).rows[0].g);
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

// ĐÃ NHẬN TIỀN HÀNG LOẠT (COD, gom tiền cuối ngày): mirror bulkConfirm — mỗi đơn 1
// transaction riêng, thành công một phần, trần 100. Cùng perm 'orders.write' + cùng
// guard với markPaid đơn lẻ: CHỈ COD, chưa paid, không ở trạng thái terminal
// (cancelled/refunded/returned — mark-paid không được đảo lệnh hoàn/huỷ).
async function bulkMarkPaid(res, ctx, body) {
  const ids = Array.isArray(body.order_ids) ? [...new Set(body.order_ids.filter((x) => typeof x === 'string' && /^[0-9a-f-]{36}$/.test(x)))] : [];
  if (!ids.length) return send(res, 400, { error: 'không có đơn nào được chọn' });
  if (ids.length > 100) return send(res, 400, { error: 'tối đa 100 đơn mỗi lần' });
  let paid = 0, skipped = 0;
  for (const orderId of ids) {
    try {
      const out = await withTenant(ctx.shopId, async (c) => {
        const o = (await c.query(
          `SELECT id, order_number, payment_method, payment_status, status, customer_email, total_vnd
             FROM orders WHERE id = $1 FOR UPDATE`, [orderId],
        )).rows[0];
        if (!o || o.payment_method !== 'cod' || ['cancelled', 'refunded', 'returned'].includes(o.status)) return false;
        const upd = await c.query(
          `UPDATE orders SET payment_status = 'paid', paid_at = now()
            WHERE id = $1 AND payment_status <> 'paid'`, [orderId],
        );
        if (upd.rowCount !== 1) return false;
        await audit(c, 'order.marked_paid', { actorId: ctx.user.id, ip: ctx.ip, metadata: { orderId, bulk: true } });
        // Biên nhận cho khách (mirror markPaid): phát order.paid TRONG cùng transaction.
        if (o.customer_email) {
          await c.query(
            `INSERT INTO outbox (shop_id, topic, payload) VALUES (current_shop_id(), 'order.paid', $1)`,
            [{ to: o.customer_email, order_number: Number(o.order_number), total_vnd: Number(o.total_vnd) }],
          );
        }
        return true;
      });
      out ? paid++ : skipped++;
    } catch { skipped++; }
  }
  return send(res, 200, { ok: true, paid, skipped });
}

// Chuyển trạng thái đơn giản (confirm/deliver). guard(o) tuỳ chọn → chuỗi lỗi 409 hoặc null.
function makeTransition(from, to, tsCol, action, guard = null) {
  return async (res, ctx, params) => {
    const orderId = params[1];
    const out = await withTenant(ctx.shopId, async (c) => {
      const o = (await c.query(`SELECT id, status, fulfillment_status, order_number, customer_email FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
      if (!o) return { code: 404 };
      if (!from.includes(o.status)) return { code: 409, cur: o.status };
      if (guard) { const g = guard(o); if (g) return { code: 4092, msg: g }; }
      await c.query(`UPDATE orders SET status = $1${tsCol ? `, ${tsCol} = now()` : ''} WHERE id = $2`, [to, orderId]);
      o.status = to;
      await audit(c, action, { actorId: ctx.user.id, ip: ctx.ip, metadata: { orderId, to } });
      await statusEvent(c, o);
      return { code: 200 };
    });
    if (out.code === 404) return send(res, 404, { error: 'không tìm thấy đơn' });
    if (out.code === 4092) return send(res, 409, { error: out.msg });
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
export async function consumeAndShip(c, ctx, o, { shipmentId, tracking, carrier = null, provider = null, fee = null, providerStatus = null }) {
  // SPLIT SHIPMENT (0080): tiêu tồn CHỈ SUBSET dòng của vận đơn NÀY (đọc shipment_lines đã
  // ghi lúc tạo vận đơn), KHÔNG phải toàn đơn. Mỗi dòng: on_hand-=qty, reserved-=qty, ĐÚNG 1
  // ledger 'ship' (bất biến 0009); luỹ kế order_lines.shipped_qty (CHECK<=qty backstop).
  const lines = (await c.query(
    `SELECT order_line_id, variant_id, qty FROM shipment_lines WHERE shipment_id = $1 ORDER BY variant_id`, [shipmentId],
  )).rows;
  for (const ln of lines) {
    const lvl = (await c.query(`SELECT on_hand, reserved FROM inventory_levels WHERE variant_id = $1 FOR UPDATE`, [ln.variant_id])).rows[0];
    if (lvl) {
      const nextOnHand = Math.max(0, lvl.on_hand - ln.qty);
      const nextReserved = Math.max(0, lvl.reserved - ln.qty);
      await c.query(`UPDATE inventory_levels SET on_hand = $2, reserved = $3, updated_at = now() WHERE variant_id = $1`, [ln.variant_id, nextOnHand, nextReserved]);
      const delta = nextOnHand - lvl.on_hand; // = -qty (âm) thực tế → khớp bất biến ledger
      if (delta !== 0) {
        await c.query(
          `INSERT INTO inventory_ledger (shop_id, variant_id, delta, kind, reason, actor_id)
           VALUES (current_shop_id(), $1, $2, 'ship', $3, $4)`,
          [ln.variant_id, delta, `đơn #${o.order_number}`, ctx.user.id],
        );
      }
    }
    await c.query(`UPDATE order_lines SET shipped_qty = shipped_qty + $2 WHERE id = $1`, [ln.order_line_id, ln.qty]);
  }
  // Chốt vận đơn: created → in_transit + tracking (đường hãng: dòng claim đã có sẵn).
  await c.query(
    `UPDATE shipments SET carrier = $2, tracking_number = $3, status = 'in_transit',
            carrier_fee_vnd = $4, provider_status = $5, synced_at = now() WHERE id = $1`,
    [shipmentId, carrier, tracking, fee, providerStatus],
  );
  // fulfillment_status: 'fulfilled' nếu MỌI dòng đã gửi đủ, else 'partial'. status='shipped'
  // ngay kiện ĐẦU (giữ nguyên — tự chặn cancel/edit/refund-release vốn gate pending/confirmed).
  const remain = (await c.query(`SELECT 1 FROM order_lines WHERE order_id = $1 AND shipped_qty < qty LIMIT 1`, [o.id])).rows[0];
  const ff = remain ? 'partial' : 'fulfilled';
  await c.query(`UPDATE orders SET status = 'shipped', shipped_at = coalesce(shipped_at, now()), fulfillment_status = $2 WHERE id = $1`, [o.id, ff]);
  o.status = 'shipped'; o.fulfillment_status = ff;
  await audit(c, 'order.shipped', { actorId: ctx.user.id, ip: ctx.ip, metadata: { orderId: o.id, tracking, fulfillment: ff, ...(provider ? { provider } : {}) } });
  await statusEvent(c, o, { tracking_number: tracking });
}

// GIAO TAY — hỗ trợ GỬI MỘT PHẦN (0080). body.lines=[{order_line_id, qty}] = subset; RỖNG =
// gửi TẤT CẢ phần còn lại (tương thích ngược). Khoá đơn FOR UPDATE; còn-lại = qty − đã_gửi −
// đang_claim('created'); vượt → 422 (backstop DB CHECK shipped_qty<=qty). Cho phép status
// 'confirmed' HOẶC 'shipped'+còn hàng (gửi tiếp kiện sau). MỌI lỗi THROW → ROLLBACK.
async function shipOrder(res, ctx, body, params) {
  const orderId = params[1];
  const fail = (statusCode, msg) => { throw Object.assign(new Error(msg), { statusCode }); };
  const tracking = String(body.tracking_number ?? '').trim();
  const carrier = String(body.carrier ?? '').trim();
  if (tracking.length < 1 || tracking.length > 64) return send(res, 400, { error: 'mã vận đơn không hợp lệ' });
  const rawLines = Array.isArray(body?.lines) ? body.lines : null; // null = gửi tất cả còn lại
  const want = new Map();
  if (rawLines) {
    for (const l of rawLines) {
      if (!l || !UUID_RE.test(String(l.order_line_id ?? '')) || !Number.isInteger(Number(l.qty)) || Number(l.qty) < 1) continue;
      const k = String(l.order_line_id);
      want.set(k, (want.get(k) ?? 0) + Number(l.qty));
    }
    if (want.size === 0) return send(res, 400, { error: 'chọn ít nhất 1 dòng hàng để gửi' });
  }
  try {
    const out = await withTenant(ctx.shopId, async (c) => {
      const o = (await c.query(`SELECT id, status, order_number, customer_email FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
      if (!o) fail(404, 'không tìm thấy đơn');
      if (!['confirmed', 'shipped'].includes(o.status)) fail(409, `không thể giao từ ${o.status}`);
      // Dòng đơn + đã gửi + đang claim (created) → còn lại có thể gửi.
      const ol = (await c.query(
        `SELECT ol.id, ol.variant_id, ol.qty, ol.unit_price_vnd, ol.shipped_qty,
                coalesce((SELECT sum(sl.qty)::int FROM shipment_lines sl JOIN shipments s ON s.id = sl.shipment_id
                           WHERE sl.order_line_id = ol.id AND s.status = 'created'), 0) AS planned
           FROM order_lines ol WHERE ol.order_id = $1`, [orderId])).rows;
      const byId = new Map(ol.map((l) => [l.id, l]));
      let ship;
      if (!rawLines) {
        ship = ol.map((l) => ({ order_line_id: l.id, variant_id: l.variant_id, qty: l.qty - l.shipped_qty - l.planned, unit: Number(l.unit_price_vnd) })).filter((x) => x.qty > 0);
      } else {
        ship = [];
        for (const [olid, qty] of want) {
          const l = byId.get(olid);
          if (!l) fail(422, 'có dòng không thuộc đơn này');
          const remaining = l.qty - l.shipped_qty - l.planned;
          if (qty > remaining) fail(422, `gửi quá số còn lại: dòng chỉ còn ${Math.max(0, remaining)} chưa gửi`);
          ship.push({ order_line_id: olid, variant_id: l.variant_id, qty, unit: Number(l.unit_price_vnd) });
        }
      }
      if (ship.length === 0) fail(409, 'đơn đã gửi đủ — không còn hàng để giao');
      // Tạo vận đơn (created) + shipment_lines → consumeAndShip tiêu tồn subset + chốt.
      const sh = (await c.query(`INSERT INTO shipments (shop_id, order_id, carrier, status) VALUES (current_shop_id(), $1, $2, 'created') RETURNING id`, [orderId, carrier || null])).rows[0];
      for (const s of ship) {
        await c.query(`INSERT INTO shipment_lines (shop_id, shipment_id, order_line_id, variant_id, qty, unit_price_vnd) VALUES (current_shop_id(), $1, $2, $3, $4, $5)`, [sh.id, s.order_line_id, s.variant_id, s.qty, s.unit]);
      }
      await consumeAndShip(c, ctx, o, { shipmentId: sh.id, tracking, carrier: carrier || null });
      return { fulfillment: o.fulfillment_status };
    });
    return send(res, 200, { ok: true, status: 'shipped', fulfillment_status: out.fulfillment, tracking_number: tracking });
  } catch (err) {
    if (err.statusCode) return send(res, err.statusCode, { error: err.message });
    throw err;
  }
}

/**
 * THÂN GIAO DỊCH của huỷ đơn — DÙNG CHUNG cho hai đường: nhân viên bấm trong admin, và
 * khách tự huỷ trong chat Messenger (/ingest/orders/cancel).
 *
 * Vì sao phải tách thay vì chép: huỷ đơn nhả tồn đã giữ chỗ, hoàn lượt coupon, và phát sự
 * kiện báo khách. Hai bản của chuỗi đó sẽ lệch nhau ở đúng lần sửa thứ ba — và lệch ở đây
 * nghĩa là tồn kho sai hoặc khách không được báo.
 *
 * `actorId` null = khách tự huỷ (audit ghi actor_type 'system', cùng lối /ingest/orders).
 * PHẢI gọi trong transaction đã set tenant; caller tự lo khoá và kiểm quyền sở hữu.
 */
export async function cancelOrderTx(c, orderId, { reason = null, actorId = null, ip = null, source = 'admin' } = {}) {
  const o = (await c.query(`SELECT id, status, payment_status, coupon_code, order_number, customer_email, customer_name, total_vnd FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
  if (!o) return { code: 404 };
  if (!['pending', 'confirmed'].includes(o.status)) return { code: 409, cur: o.status };
  if (o.payment_status === 'paid' && !reason) {
    return { code: 400, msg: 'đơn đã thanh toán: phải nêu lý do huỷ (khách sẽ nhận được lý do này)' };
  }
  // RELEASE reserve: trả lại tồn đã giữ chỗ lúc checkout.
  const lines = (await c.query(`SELECT variant_id, qty FROM order_lines WHERE order_id = $1`, [orderId])).rows;
  for (const ln of lines) {
    await c.query(`UPDATE inventory_levels SET reserved = GREATEST(0, reserved - $2), updated_at = now() WHERE variant_id = $1`, [ln.variant_id, ln.qty]);
  }
  await c.query(`UPDATE orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2 WHERE id = $1`, [orderId, reason]);
  if (o.coupon_code && o.payment_status !== 'paid') {
    await c.query(`UPDATE coupons SET used_count = GREATEST(used_count - 1, 0) WHERE shop_id = current_shop_id() AND upper(code) = upper($1)`, [o.coupon_code]);
  }
  o.status = 'cancelled';
  const paid = o.payment_status === 'paid';
  await audit(c, 'order.cancelled', {
    actorId, ip,
    metadata: { orderId, reason, was_paid: paid, refund_due_vnd: paid ? Number(o.total_vnd) : 0, source },
  });
  await statusEvent(c, o, { cancel_reason: reason, refund_due_vnd: paid ? Number(o.total_vnd) : 0 });
  return { code: 200 };
}

async function cancelOrder(res, ctx, body, params) {
  const orderId = params[1];
  const reason = String(body?.reason ?? '').trim().slice(0, 500) || null;
  // Quy tắc huỷ (nhả reserve · hoàn lượt coupon · bắt buộc lý do khi đã trả tiền · phát sự
  // kiện báo khách) nằm TRỌN trong cancelOrderTx — dùng chung với đường khách tự huỷ trong
  // chat Messenger. Đừng viết lại ở đây: hai bản sẽ lệch ở đúng lần sửa thứ ba.
  const out = await withTenant(ctx.shopId, (c) =>
    cancelOrderTx(c, orderId, { reason, actorId: ctx.user.id, ip: ctx.ip, source: 'admin' }));
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy đơn' });
  if (out.code === 400) return send(res, 400, { error: out.msg });
  if (out.code === 409) return send(res, 409, { error: `không thể huỷ từ ${out.cur}` });
  return send(res, 200, { ok: true, status: 'cancelled' });
}

// BOM HÀNG / HOÀN VỀ — đơn ĐANG GIAO (shipped) khách KHÔNG NHẬN → hàng về shop. Vá 2 lỗ audit:
//  (1) đơn TÁCH-VẬN-ĐƠN bỏ dở (gửi 3/5 rồi thôi) → reserve phần CHƯA gửi kẹt vĩnh viễn (cancel gate
//      pending/confirmed, deliver đòi fulfilled) → NHẢ reserve phần chưa gửi.
//  (2) đơn GIAO TAY/hãng bị bom → kẹt 'shipped' (RMA đòi 'delivered') → RESTOCK phần ĐÃ gửi (hàng về).
// restock (mặc định true): hàng bom còn bán được → on_hand += shipped + ledger 'receive'; false = hàng
// hỏng, ghi nhận mất (không restock) nhưng VẪN nhả reserve. KHÔNG tự hoàn tiền (COD bom = chưa thu;
// đơn đã trả → shop hoàn qua nút Hoàn tiền riêng). Khoá on_hand theo variant_id (chống deadlock).
async function markReturnedBomb(res, ctx, body, params) {
  const orderId = params[1];
  const reason = String(body?.reason ?? '').trim().slice(0, 500) || null;
  const restock = body?.restock !== false && body?.restock !== 'false' && body?.restock !== 'off'; // mặc định TRUE
  const out = await withTenant(ctx.shopId, async (c) => {
    const o = (await c.query(`SELECT id, status, payment_status, coupon_code, order_number, customer_email, customer_name FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
    if (!o) return { code: 404 };
    if (o.status !== 'shipped') return { code: 409, cur: o.status };
    const lines = (await c.query(`SELECT variant_id, qty, shipped_qty FROM order_lines WHERE order_id = $1 ORDER BY variant_id`, [orderId])).rows;
    for (const ln of lines) {
      const shipped = Number(ln.shipped_qty), unshipped = Number(ln.qty) - shipped;
      if (restock && shipped > 0) { // hàng vật lý đã gửi về kho → nhập lại (mirror RMA restock)
        await c.query(`INSERT INTO inventory_levels (shop_id, variant_id) VALUES (current_shop_id(), $1) ON CONFLICT (shop_id, variant_id) DO NOTHING`, [ln.variant_id]);
        await c.query(`SELECT on_hand FROM inventory_levels WHERE variant_id = $1 FOR UPDATE`, [ln.variant_id]);
        await c.query(`UPDATE inventory_levels SET on_hand = on_hand + $2, updated_at = now() WHERE variant_id = $1`, [ln.variant_id, shipped]);
        await c.query(`INSERT INTO inventory_ledger (shop_id, variant_id, delta, kind, reason, actor_id) VALUES (current_shop_id(), $1, $2, 'receive', $3, $4)`,
          [ln.variant_id, shipped, `Hoàn về (bom) đơn #${o.order_number}`, ctx.user.id]);
      }
      if (unshipped > 0) { // phần CHƯA gửi (đơn tách bỏ dở) → nhả reserve (chưa xuất kho, on_hand giữ)
        await c.query(`UPDATE inventory_levels SET reserved = GREATEST(0, reserved - $2), updated_at = now() WHERE variant_id = $1`, [ln.variant_id, unshipped]);
      }
    }
    await c.query(`UPDATE orders SET status = 'returned', returned_at = now() WHERE id = $1`, [orderId]);
    if (o.coupon_code && o.payment_status !== 'paid') {
      await c.query(`UPDATE coupons SET used_count = GREATEST(used_count - 1, 0) WHERE shop_id = current_shop_id() AND upper(code) = upper($1)`, [o.coupon_code]);
    }
    o.status = 'returned';
    await audit(c, 'order.returned_bomb', { actorId: ctx.user.id, ip: ctx.ip, metadata: { orderId, reason, restock } });
    await statusEvent(c, o);
    return { code: 200 };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy đơn' });
  if (out.code === 409) return send(res, 409, { error: `chỉ hoàn-về đơn ĐANG GIAO (shipped); đơn hiện ${out.cur}` });
  return send(res, 200, { ok: true, status: 'returned' });
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

// Hoàn tiền = BÚT TOÁN (0070): mỗi lần hoàn ghi MỘT dòng refunds (append-only, có số tiền).
// Perm 'refund' (owner/admin) + STEP-UP. Body {amount_vnd?, reason?, restock?}:
//   - KHÔNG amount → hoàn TOÀN BỘ số còn lại (tổng − đã hoàn) + lật refunded như trước.
//   - amount < số còn lại → hoàn MỘT PHẦN: đơn GIỮ paid + status, audit 'order.refund_partial';
//     khi LUỸ KẾ chạm tổng → lật refunded (đúng đường hoàn toàn bộ).
//   - luỹ kế vượt tổng → 422.
// Tồn kho (CHỈ ở nhát lật refunded — giữ nguyên semantics cũ):
//   - pending/confirmed (còn GIỮ reserve, chưa giao) → GIẢI PHÓNG reserve.
//   - shipped/delivered / cancelled → KHÔNG đụng tồn; chủ shop tự nhập lại kho nếu khách
//     trả hàng. restock trên dòng refunds là Ý ĐỊNH GHI NHẬN (v1 không tự đụng tồn —
//     hoàn theo số tiền không ánh xạ được sang qty từng dòng hàng).
// Idempotent: guard payment_status='paid' (sau lật → 'refunded' → 409).
async function refundOrder(res, ctx, body, params) {
  const orderId = params[1];
  // Validate amount TRƯỚC transaction: null/'' = hoàn toàn bộ; có giá trị phải là số nguyên dương.
  const rawAmount = body?.amount_vnd;
  let amountReq = null;
  if (rawAmount != null && rawAmount !== '') {
    const n = Number(rawAmount);
    if (!Number.isSafeInteger(n) || n <= 0) return send(res, 400, { error: 'số tiền hoàn không hợp lệ (số nguyên dương, đơn vị đồng)' });
    amountReq = n;
  }
  const reason = String(body?.reason ?? '').trim().slice(0, 500) || null;
  const restock = body?.restock === true || body?.restock === 'true';
  const out = await withTenant(ctx.shopId, async (c) => {
    const o = (await c.query(
      `SELECT id, order_number, status, payment_status, customer_email, total_vnd
         FROM orders WHERE id = $1 FOR UPDATE`, [orderId],
    )).rows[0];
    if (!o) return { code: 404 };
    if (o.payment_status !== 'paid') return { code: 409, msg: 'chỉ hoàn được đơn đã thanh toán' };
    if (o.status === 'refunded') return { code: 409, msg: 'đơn đã hoàn tiền' };
    // Đã hoàn luỹ kế (khoá đơn FOR UPDATE ở trên → không ai chen dòng refunds mới của đơn này).
    const already = Number((await c.query(
      `SELECT coalesce(sum(amount_vnd), 0)::bigint AS s FROM refunds WHERE order_id = $1`, [orderId],
    )).rows[0].s);
    const total = Number(o.total_vnd);
    const remaining = total - already;
    const amount = amountReq ?? remaining; // không ghi số tiền = hoàn nốt phần còn lại
    if (amount > remaining) {
      return { code: 422, msg: `số tiền hoàn vượt quá số còn lại (đã hoàn ${already}đ / tổng ${total}đ, còn ${remaining}đ)` };
    }
    if (amount > 0) { // đơn 0đ (hàng tặng + freeship) hoàn toàn bộ = chỉ lật, không có bút toán 0đ
      await c.query(
        `INSERT INTO refunds (shop_id, order_id, amount_vnd, reason, restock, created_by)
         VALUES (current_shop_id(), $1, $2, $3, $4, $5)`,
        [orderId, amount, reason, restock, ctx.user.id],
      );
    }
    const refundedTotal = already + amount;
    if (refundedTotal < total) {
      // MỘT PHẦN: đơn giữ nguyên paid + status. Không statusEvent (trạng thái không đổi).
      await audit(c, 'order.refund_partial', { actorId: ctx.user.id, ip: ctx.ip, metadata: { orderId, amount_vnd: amount, refunded_total_vnd: refundedTotal, ...(reason ? { reason } : {}) } });
      return { code: 200, partial: true, status: o.status, refundedTotal, amount };
    }
    // LUỸ KẾ CHẠM TỔNG → lật refunded (giữ NGUYÊN semantics tồn kho như trước 0070).
    if (['pending', 'confirmed'].includes(o.status)) {
      const lines = (await c.query(`SELECT variant_id, qty FROM order_lines WHERE order_id = $1`, [orderId])).rows;
      for (const ln of lines) {
        await c.query(`UPDATE inventory_levels SET reserved = GREATEST(0, reserved - $2), updated_at = now() WHERE variant_id = $1`, [ln.variant_id, ln.qty]);
      }
    }
    await c.query(`UPDATE orders SET status = 'refunded', payment_status = 'refunded' WHERE id = $1`, [orderId]);
    o.status = 'refunded';
    await audit(c, 'order.refunded', { actorId: ctx.user.id, ip: ctx.ip, metadata: { orderId, total_vnd: total, amount_vnd: amount, ...(reason ? { reason } : {}) } });
    await statusEvent(c, o); // email báo khách: trạng thái = refunded
    return { code: 200, partial: false, refundedTotal, amount };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy đơn' });
  if (out.code === 409) return send(res, 409, { error: out.msg });
  if (out.code === 422) return send(res, 422, { error: out.msg });
  if (out.partial) return send(res, 200, { ok: true, status: out.status, payment_status: 'paid', refund_vnd: out.amount, refunded_total_vnd: out.refundedTotal });
  return send(res, 200, { ok: true, status: 'refunded', payment_status: 'refunded', refund_vnd: out.amount, refunded_total_vnd: out.refundedTotal });
}

const confirmOrder = makeTransition(['pending'], 'confirmed', null, 'order.confirmed');
// Giao xong: đòi fulfillment='fulfilled' (0080) — không cho chốt 'delivered' khi CÒN kiện
// chưa gửi (đơn giao một phần). Đơn cũ (backfill) và giao đủ đều 'fulfilled'.
const deliverOrder = makeTransition(['shipped'], 'delivered', 'delivered_at', 'order.delivered',
  (o) => (o.fulfillment_status === 'fulfilled' ? null : 'còn kiện chưa gửi — hoàn tất giao các phần còn lại trước khi đánh dấu đã giao'));

// ── TẠO ĐƠN THỦ CÔNG (nhân viên chốt đơn qua Facebook/Zalo rồi gõ vào hệ thống) ──
// Mirror bất biến của checkout createOrderTx: giá 100% server-side từ variants.price_vnd
// (snapshot), MỘT transaction FOR UPDATE reserve tồn, shop_counters, outbox cùng tx.
// KHÁC checkout: KHÔNG bot-guard/trần IP (nhân viên tạo, client_ip_hash NULL), phí ship
// cho phép GHI ĐÈ tay (nhân viên biết phí đã thoả thuận), không coupon (v1).

// Danh sách biến thể BÁN ĐƯỢC cho form chọn (perm orders.write — nhân viên đơn không
// chắc có catalog.read). Chỉ SP active + biến thể không mồ côi, kèm tồn khả dụng.
// ?q= lọc theo tên SP KHÔNG DẤU (0048) hoặc SKU (mirror catalog.js likeEscape) — shop
// nhiều hàng vượt trần 500 vẫn chọn được đúng biến thể. Chạm trần → truncated:true.
async function listSellableVariants(res, ctx, query) {
  const q = (query?.get('q') ?? '').trim().slice(0, 100);
  const args = [];
  let filterSql = '';
  if (q) {
    args.push('%' + q.replace(/[%_\\]/g, '\\$&') + '%');
    filterSql = ` AND (vn_unaccent(p.title) LIKE vn_unaccent($${args.length}) OR v.sku ILIKE $${args.length})`;
  }
  const rows = await withTenant(ctx.shopId, async (c) =>
    (await c.query(
      `SELECT v.id, p.title AS product_title, v.title AS variant_title, v.sku, v.price_vnd,
              coalesce(il.on_hand - il.reserved, 0)::int AS available
         FROM variants v
         JOIN products p ON p.id = v.product_id AND p.status = 'active' AND p.deleted_at IS NULL
         LEFT JOIN inventory_levels il ON il.variant_id = v.id
        WHERE ${VARIANT_NOT_ORPHAN_SQL}${filterSql}
        ORDER BY p.title, v.title NULLS FIRST, v.sku
        LIMIT 500`, args,
    )).rows);
  return send(res, 200, {
    variants: rows.map((r) => ({ ...r, price_vnd: Number(r.price_vnd) })),
    ...(rows.length === 500 ? { truncated: true } : {}),
  });
}

/**
 * Phí ship theo cấu hình shop (phẳng + ngưỡng free-ship) — NGUỒN DUY NHẤT của quy tắc này.
 *
 * Tách ra vì bot Messenger phải BÁO TRƯỚC phí ship trong tóm tắt, còn đơn thì tính lúc tạo.
 * Hai chỗ tính bằng hai đoạn mã chép tay chắc chắn sẽ lệch — và lệch ở phí ship nghĩa là
 * bot hứa một con số rồi thu con số khác. Gọi TRONG withTenant (dùng current_shop_id()).
 */
export async function shopShipFee(c, subtotal) {
  const s = (await c.query(`SELECT ship_fee_vnd, free_ship_threshold_vnd FROM shops WHERE id = current_shop_id()`)).rows[0] ?? {};
  const fee = s.ship_fee_vnd != null ? Number(s.ship_fee_vnd) : SHIP_FEE;
  const threshold = s.free_ship_threshold_vnd != null ? Number(s.free_ship_threshold_vnd) : null;
  return (threshold != null && subtotal >= threshold) ? 0 : fee;
}

export async function createManualOrder(res, ctx, body) {
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
  // NGUỒN ĐƠN (0119). Mặc định 'manual' — người gõ form là nhân viên. Bot Messenger ở
  // chặng 2 gửi 'facebook' qua CHÍNH đường này, không cần endpoint riêng.
  // Kiểm theo whitelist chứ không nhận text tự do: cột này để ĐẾM, mà 'fb' lẫn
  // 'facebook' là hỏng báo cáo âm thầm. Giá trị lạ → 400 chứ không lặng lẽ về mặc định,
  // vì lặng lẽ nghĩa là bot gửi sai tên kênh suốt nhiều tuần mà không ai biết.
  const source = body?.source == null || body.source === '' ? 'manual' : String(body.source);
  if (!ORDER_SOURCES.has(source)) return send(res, 400, { error: `nguồn đơn không hợp lệ (${[...ORDER_SOURCES].join('/')})` });
  const sourceRef = String(body?.source_ref ?? '').trim().slice(0, 200) || null;
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
        `SELECT v.id, v.price_vnd, v.title AS variant_title, v.sku, p.title AS product_title,
                pe.price_vnd AS sale_price_vnd
           FROM variants v JOIN products p ON p.id = v.product_id AND p.status = 'active' AND p.deleted_at IS NULL
           LEFT JOIN LATERAL promo_effective(p.id, v.price_vnd, now()) pe ON true
          WHERE v.id = $1 AND ${VARIANT_NOT_ORPHAN_SQL}`, [vid],
      )).rows[0];
      if (!v) fail(422, 'sản phẩm không tồn tại hoặc ngừng bán');
      const lvl = (await c.query(`SELECT on_hand, reserved FROM inventory_levels WHERE variant_id = $1 FOR UPDATE`, [vid])).rows[0];
      const available = lvl ? lvl.on_hand - lvl.reserved : 0;
      if (qty > available) fail(422, `hết hàng: ${v.product_title} (còn ${Math.max(0, available)})`);
      await c.query(`UPDATE inventory_levels SET reserved = reserved + $2, updated_at = now() WHERE variant_id = $1`, [vid, qty]);
      // GIÁ: đơn qua KHOÁ KẾT NỐI ăn flash sale giống hệt website; đơn NHÂN VIÊN GÕ TAY thì không.
      //
      // Không phải tuỳ tiện — khác nhau ở chỗ AI chọn giá. Bot/tích hợp là khách tự phục vụ:
      // nó vừa báo giá sale cho khách trong chat thì đơn phải tính đúng giá đó, nếu không là
      // tính sai tiền khách (bot nói 70k, hệ thống thu 100k). Nhân viên gõ tay là người, có
      // thể đang chốt giá riêng đã thoả thuận — áp sale đè lên là ghi đè quyết định của họ.
      const unit = ctx.apiKeyId && v.sale_price_vnd != null ? Number(v.sale_price_vnd) : Number(v.price_vnd);
      subtotal += unit * qty;
      lines.push({ variant_id: vid, title: v.product_title + (v.variant_title ? ` - ${v.variant_title}` : ''), sku: v.sku, unit, qty });
    }

    // Phí ship: ghi đè tay ?? cấu hình shop (mirror checkout computeShipping, phẳng+ngưỡng).
    let shipping = shipOverride;
    if (shipping == null) shipping = await shopShipFee(c, subtotal);
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
         subtotal_vnd, shipping_vnd, discount_vnd, total_vnd, lookup_token_hash, payment_ref, qr_account, client_ip_hash, note,
         source, source_ref, api_key_id)
       VALUES (current_shop_id(), $1, 'pending', 'unpaid', $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, $11, $12, NULL, $13, $14, $15, $16) RETURNING id`,
      [num, paymentMethod, name, phone, email, address, subtotal, shipping, total, hashToken(lookupToken), paymentRef, qrAccount, note, source, sourceRef, ctx.apiKeyId ?? null],
    )).rows[0];
    for (const ln of lines) {
      // unit_cost_vnd (0081): snapshot giá vốn hiện hành lúc tạo đơn — mirror checkout.
      await c.query(
        `INSERT INTO order_lines (shop_id, order_id, variant_id, title_snapshot, sku_snapshot, unit_price_vnd, qty, unit_cost_vnd)
         VALUES (current_shop_id(), $1, $2, $3, $4, $5, $6,
                 (SELECT cost_vnd FROM variant_costs WHERE shop_id = current_shop_id() AND variant_id = $2))`,
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
      [{ ...(email ? { to: email } : {}), order_number: Number(num), total_vnd: total, customer_name: name, payment_method: paymentMethod, source, ...(link ? { link } : {}) }],
    );
    await audit(c, 'order.created_manual', {
      actorType: ctx.apiKeyId ? 'system' : 'user',
      actorId: ctx.user?.id ?? null,
      ip: ctx.ip,
      metadata: { order_number: Number(num), total_vnd: total, lines: lines.length, source, ...(ctx.apiKeyId ? { api_key_id: ctx.apiKeyId } : {}) },
    });

    const response = { id: order.id, order_number: Number(num), subtotal_vnd: subtotal, shipping_vnd: shipping, total_vnd: total, status: 'pending', payment_method: paymentMethod, ...(paymentRef ? { payment_ref: paymentRef } : {}) };
    await c.query(`UPDATE idempotency_keys SET status = 'completed', response_code = 201, response_body = $2 WHERE key = $1`, [idemKey, response]);
    return { code: 201, body: response };
  });
  return send(res, out.code, out.body);
}

// ── SỬA ĐƠN (v1) ─────────────────────────────────────────────────────────────
// CHỈ sửa được đơn CHƯA GỬI HÃNG (pending/confirmed) VÀ CHƯA THANH TOÁN (unpaid) —
// ca chính: khách đổi số lượng/địa chỉ COD trước khi giao. Đơn ĐÃ TRẢ (cần hoàn/thu
// bù) là v2 riêng, rủi ro cao hơn nhiều.
//
// DECLARATIVE: body mang TRẠNG THÁI ĐÍCH (danh sách dòng mong muốn) → tính delta so
// với hiện tại. Post lại 2 lần = delta 0 = no-op; đua thì khoá đơn FOR UPDATE tuần tự
// hoá → idempotent tự nhiên, không cần idempotency_key.
//
// BẤT BIẾN: (1) giá SNAPSHOT — dòng CŨ giữ unit_price đã chốt (khách đã đồng ý), dòng
// MỚI snapshot giá hiện tại; (2) tồn kho — khoá đơn rồi khoá biến thể theo THỨ TỰ (chống
// deadlock, khớp createOrderTx/createManualOrder), tăng thì kiểm tồn+reserve, giảm thì
// nhả; (3) MỌI lỗi trong tx THROW → ROLLBACK (oversell có thể xảy ra giữa vòng lặp sau
// khi đã reserve biến thể trước — return {code} sẽ COMMIT reserve dở dang). Phí ship GIỮ
// NGUYÊN trừ khi ghi đè (không tự tính lại — tránh đổi phí bất ngờ khi trộn region/flat).
// Parse + validate body sửa đơn (dùng chung v1 unpaid + v2 paid). Trả {ok, ...fields}
// hoặc {error} (nơi gọi trả 400). KHÔNG chạm DB.
function parseEditBody(body) {
  const rawLines = Array.isArray(body?.lines) ? body.lines : [];
  const lines0 = rawLines.filter((l) => l && UUID_RE.test(String(l.variant_id ?? '')) && Number.isInteger(Number(l.qty)) && Number(l.qty) >= 1 && Number(l.qty) <= 1000)
    .map((l) => ({ variant_id: String(l.variant_id), qty: Number(l.qty) }));
  if (lines0.length === 0 || lines0.length > 50) return { error: 'đơn cần 1-50 dòng hàng hợp lệ' };
  const name = String(body?.customer?.name ?? '').trim();
  const phone = canonPhone(String(body?.customer?.phone ?? '').trim());
  if (!name || name.length > 120) return { error: 'thiếu tên khách (≤120 ký tự)' };
  if (!phone) return { error: 'SĐT không hợp lệ (tối thiểu 8 số)' };
  const email = String(body?.customer?.email ?? '').trim().toLowerCase() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'email không hợp lệ' };
  const addressLine = String(body?.customer?.address_line ?? '').trim().slice(0, 300) || null;
  const province = String(body?.customer?.province ?? '').trim().slice(0, 60) || null;
  if (province && !isProvince(province)) return { error: 'tỉnh/thành không hợp lệ (chọn theo danh sách 34 tỉnh thành)' };
  const hasNote = Object.prototype.hasOwnProperty.call(body ?? {}, 'note');
  const noteVal = hasNote ? (String(body.note ?? '').trim().slice(0, 500) || null) : undefined;
  const shipOverride = body?.ship_fee_vnd != null && body.ship_fee_vnd !== '' ? Number(body.ship_fee_vnd) : null;
  if (shipOverride != null && !(Number.isInteger(shipOverride) && shipOverride >= 0 && shipOverride <= 10_000_000)) return { error: 'phí ship ghi đè không hợp lệ' };
  return { ok: true, lines0, name, phone, email, addressLine, province, hasNote, noteVal, shipOverride };
}

// Đối chiếu dòng hàng + tồn kho + tính tiền — LÕI CHUNG v1/v2. Đơn `o` ĐÃ khoá FOR UPDATE
// và ĐÃ qua guard trạng thái ở nơi gọi. Khoá biến thể theo THỨ TỰ (chống deadlock), tăng
// kiểm tồn+reserve / giảm nhả, thay order_lines, cập nhật header (KHÔNG đụng payment_status/
// amount_paid — phần đó do nơi gọi tự xử theo v1/v2). `fail` THROW → ROLLBACK.
async function reconcileEditLines(c, o, P, fail) {
  // Chặn sửa khi đơn đã có VẬN ĐƠN (kể cả claim 'created' của hãng): sửa xoá+chèn lại
  // order_lines sẽ vỡ FK shipment_lines→order_lines + reset shipped_qty (0080). Đơn đang
  // giao dở phải xử qua đổi-trả/hoàn, không sửa dòng.
  const shipped = (await c.query(
    `SELECT 1 FROM shipment_lines sl JOIN shipments s ON s.id = sl.shipment_id WHERE s.order_id = $1 LIMIT 1`, [o.id])).rows[0];
  if (shipped) fail(409, 'đơn đã có vận đơn — không sửa được dòng hàng (dùng đổi-trả/hoàn nếu cần)');
  const cur = (await c.query(`SELECT variant_id, unit_price_vnd, unit_cost_vnd, qty, title_snapshot, sku_snapshot FROM order_lines WHERE order_id = $1`, [o.id])).rows;
  const curByVid = new Map(cur.map((l) => [l.variant_id, l]));
  const desired = new Map();
  for (const l of P.lines0) desired.set(l.variant_id, (desired.get(l.variant_id) ?? 0) + l.qty);
  const allVids = [...new Set([...curByVid.keys(), ...desired.keys()])].sort((a, b) => a.localeCompare(b));
  const targetLines = [];
  for (const vid of allVids) {
    const oldQty = curByVid.get(vid)?.qty ?? 0;
    const newQty = desired.get(vid) ?? 0;
    const delta = newQty - oldQty;
    const lvl = (await c.query(`SELECT on_hand, reserved FROM inventory_levels WHERE variant_id = $1 FOR UPDATE`, [vid])).rows[0];
    if (newQty > 0) {
      if (curByVid.has(vid)) {
        // Dòng GIỮ NGUYÊN: mang lại CẢ unit_cost_vnd CŨ (0081) — y như đang giữ giá/title/sku.
        // Quên = mỗi lần sửa đơn re-cost theo giá nhập HÔM NAY → lãi quá khứ trôi lặng lẽ.
        const ol = curByVid.get(vid);
        targetLines.push({ variant_id: vid, unit: Number(ol.unit_price_vnd), cost: ol.unit_cost_vnd != null ? Number(ol.unit_cost_vnd) : null, qty: newQty, title: ol.title_snapshot, sku: ol.sku_snapshot });
      } else {
        const v = (await c.query(
          `SELECT v.price_vnd, v.title AS variant_title, v.sku, p.title AS product_title, vc.cost_vnd
             FROM variants v JOIN products p ON p.id = v.product_id AND p.status = 'active' AND p.deleted_at IS NULL
             LEFT JOIN variant_costs vc ON vc.shop_id = v.shop_id AND vc.variant_id = v.id
            WHERE v.id = $1 AND ${VARIANT_NOT_ORPHAN_SQL}`, [vid],
        )).rows[0];
        if (!v) fail(422, 'sản phẩm mới thêm không tồn tại hoặc ngừng bán');
        targetLines.push({ variant_id: vid, unit: Number(v.price_vnd), cost: v.cost_vnd != null ? Number(v.cost_vnd) : null, qty: newQty, title: v.product_title + (v.variant_title ? ` - ${v.variant_title}` : ''), sku: v.sku });
      }
    }
    if (delta > 0) {
      const available = lvl ? lvl.on_hand - lvl.reserved : 0;
      if (delta > available) fail(422, `hết hàng: cần thêm ${delta}, còn ${Math.max(0, available)}`);
      await c.query(`UPDATE inventory_levels SET reserved = reserved + $2, updated_at = now() WHERE variant_id = $1`, [vid, delta]);
    } else if (delta < 0) {
      await c.query(`UPDATE inventory_levels SET reserved = GREATEST(0, reserved + $2), updated_at = now() WHERE variant_id = $1`, [vid, delta]);
    }
  }
  let subtotal = 0;
  for (const t of targetLines) subtotal += t.unit * t.qty;
  const discount = Number(o.discount_vnd);
  const shipping = P.shipOverride != null ? P.shipOverride : Number(o.shipping_vnd);
  const total = subtotal + shipping - discount;
  if (total < 0) fail(422, 'tổng đơn âm (giảm giá vượt tiền hàng + ship) — điều chỉnh lại');

  await c.query(`DELETE FROM order_lines WHERE order_id = $1`, [o.id]);
  for (const t of targetLines) {
    await c.query(
      `INSERT INTO order_lines (shop_id, order_id, variant_id, title_snapshot, sku_snapshot, unit_price_vnd, qty, unit_cost_vnd)
       VALUES (current_shop_id(), $1, $2, $3, $4, $5, $6, $7)`, [o.id, t.variant_id, t.title, t.sku, t.unit, t.qty, t.cost],
    );
  }
  const note = P.hasNote ? P.noteVal : o.note;
  const address = (P.addressLine || P.province) ? { ...(P.addressLine ? { line: P.addressLine } : {}), ...(P.province ? { province: P.province } : {}) } : null;
  // Header CHUNG (khách/địa chỉ/tiền) — payment_status/amount_paid_vnd để nơi gọi tự set.
  await c.query(
    `UPDATE orders SET customer_name = $2, customer_phone = $3, customer_email = $4, shipping_address = $5,
            subtotal_vnd = $6, shipping_vnd = $7, total_vnd = $8, note = $9 WHERE id = $1`,
    [o.id, P.name, P.phone, P.email, address, subtotal, shipping, total, note],
  );
  // Audit diff from→to.
  const changed = {};
  const setIf = (k, from, to) => { if (String(from ?? '') !== String(to ?? '')) changed[k] = { from: from ?? null, to: to ?? null }; };
  setIf('subtotal_vnd', Number(o.subtotal_vnd), subtotal);
  setIf('shipping_vnd', Number(o.shipping_vnd), shipping);
  setIf('total_vnd', Number(o.total_vnd), total);
  setIf('customer_name', o.customer_name, P.name);
  setIf('customer_phone', o.customer_phone, P.phone);
  const lineChg = [];
  for (const vid of allVids) {
    const from = curByVid.get(vid)?.qty ?? 0, to = desired.get(vid) ?? 0;
    if (from !== to) lineChg.push({ sku: curByVid.get(vid)?.sku_snapshot ?? targetLines.find((t) => t.variant_id === vid)?.sku ?? '', from, to });
  }
  return { subtotal, shipping, total, changed, lineChg };
}

// v1: sửa đơn CHƯA THANH TOÁN (pending/confirmed + unpaid). perm orders.write, không step-up.
async function editOrder(res, ctx, body, params) {
  const orderId = params[1];
  const fail = (statusCode, msg) => { throw Object.assign(new Error(msg), { statusCode }); };
  const P = parseEditBody(body);
  if (P.error) return send(res, 400, { error: P.error });
  try {
    const out = await withTenant(ctx.shopId, async (c) => {
      const o = (await c.query(
        `SELECT id, order_number, status, payment_status, subtotal_vnd, shipping_vnd, discount_vnd, total_vnd,
                customer_name, customer_phone, note FROM orders WHERE id = $1 FOR UPDATE`, [orderId],
      )).rows[0];
      if (!o) fail(404, 'không tìm thấy đơn');
      if (!['pending', 'confirmed'].includes(o.status)) fail(409, 'chỉ sửa được đơn chưa gửi hãng (pending/confirmed)');
      if (o.payment_status !== 'unpaid') fail(409, 'đơn đã thanh toán — dùng "Sửa đơn đã trả" (hoàn/thu bù, cần xác thực lại)');
      const r = await reconcileEditLines(c, o, P, fail);
      const meta = { orderId, order_number: Number(o.order_number), ...(Object.keys(r.changed).length ? { changed: r.changed } : {}), ...(r.lineChg.length ? { lines: r.lineChg.slice(0, 40) } : {}) };
      await audit(c, 'order.edited', { actorId: ctx.user.id, ip: ctx.ip, metadata: meta });
      return { subtotal: r.subtotal, shipping: r.shipping, total: r.total, order_number: Number(o.order_number) };
    });
    return send(res, 200, { ok: true, order_number: out.order_number, subtotal_vnd: out.subtotal, shipping_vnd: out.shipping, total_vnd: out.total });
  } catch (err) {
    if (err.statusCode) return send(res, err.statusCode, { error: err.message });
    throw err;
  }
}

// v2: sửa đơn ĐÃ THANH TOÁN (pending/confirmed + paid). Vì sinh TIỀN-RA → route mang bar
// cao NHƯ refund (perm 'refund' + step-up). Chỉ hỗ trợ GIẢM/GIỮ tổng: chênh dư được HOÀN
// (bút toán refunds 0070, tiền chủ shop tự chuyển). TĂNG tổng (thu thêm) chưa hỗ trợ (409).
//
// TIỀN ĐÃ THU = amount_paid_vnd (khoá lúc sửa lần đầu = total lúc đó; lazy — legacy dùng
// total_vnd nếu cột =0). net giữ = đã thu − đã hoàn; refund = net − tổng mới.
async function editPaidOrder(res, ctx, body, params) {
  const orderId = params[1];
  const fail = (statusCode, msg) => { throw Object.assign(new Error(msg), { statusCode }); };
  const P = parseEditBody(body);
  if (P.error) return send(res, 400, { error: P.error });
  try {
    const out = await withTenant(ctx.shopId, async (c) => {
      const o = (await c.query(
        `SELECT id, order_number, status, payment_status, subtotal_vnd, shipping_vnd, discount_vnd, total_vnd, amount_paid_vnd,
                customer_name, customer_phone, customer_email, note FROM orders WHERE id = $1 FOR UPDATE`, [orderId],
      )).rows[0];
      if (!o) fail(404, 'không tìm thấy đơn');
      if (!['pending', 'confirmed'].includes(o.status)) fail(409, 'chỉ sửa được đơn chưa gửi hãng (pending/confirmed)');
      if (o.payment_status !== 'paid') fail(409, 'đơn chưa thanh toán — dùng "Sửa đơn" thường');

      // Tiền khách đã thực trả (khoá lần đầu; lazy: cột 0 = chưa khoá → dùng total hiện tại
      // vì đơn chưa từng sửa nên total == số đã thu).
      const collected = Number(o.amount_paid_vnd) > 0 ? Number(o.amount_paid_vnd) : Number(o.total_vnd);
      const refundsSum = Number((await c.query(`SELECT coalesce(sum(amount_vnd),0)::bigint AS s FROM refunds WHERE order_id = $1`, [orderId])).rows[0].s);

      const r = await reconcileEditLines(c, o, P, fail);
      const netHeld = collected - refundsSum;         // tiền chủ shop đang giữ của đơn này
      const refundNeeded = netHeld - r.total;         // >0: hoàn bớt; <0: khách còn thiếu
      if (refundNeeded < 0) fail(409, `tăng tổng trên đơn ĐÃ TRẢ chưa hỗ trợ (khách còn thiếu ${-refundNeeded}đ) — tạo đơn mới cho phần thêm, hoặc giảm bớt`);

      // Khoá amount_paid_vnd = số đã thu (để lần sửa sau tính đúng); total đã set = tổng mới.
      await c.query(`UPDATE orders SET amount_paid_vnd = $2 WHERE id = $1`, [orderId, collected]);

      if (refundNeeded > 0) {
        // Bút toán hoàn (append-only 0070) — tiền chủ shop tự chuyển lại khách (nền tảng không giữ tiền).
        // kind='edit_adjustment' (0081): header đơn ĐÃ hạ xuống tổng mới ở reconcileEditLines →
        // báo cáo LOẠI phiếu này khỏi phép trừ doanh thu (kẻo trừ ĐÚP cùng một khoản chênh).
        await c.query(
          `INSERT INTO refunds (shop_id, order_id, amount_vnd, reason, restock, created_by, kind)
           VALUES (current_shop_id(), $1, $2, $3, false, $4, 'edit_adjustment')`, [orderId, refundNeeded, 'điều chỉnh đơn (sửa giảm)', ctx.user.id],
        );
        await audit(c, 'order.refund_partial', { actorId: ctx.user.id, ip: ctx.ip, metadata: { orderId, amount_vnd: refundNeeded, refunded_total_vnd: refundsSum + refundNeeded, reason: 'sửa đơn giảm' } });
      }
      const meta = { orderId, order_number: Number(o.order_number), paid_edit: true, ...(refundNeeded > 0 ? { refund_vnd: refundNeeded } : {}), ...(Object.keys(r.changed).length ? { changed: r.changed } : {}), ...(r.lineChg.length ? { lines: r.lineChg.slice(0, 40) } : {}) };
      await audit(c, 'order.edited', { actorId: ctx.user.id, ip: ctx.ip, metadata: meta });
      return { subtotal: r.subtotal, shipping: r.shipping, total: r.total, order_number: Number(o.order_number), refund_vnd: refundNeeded };
    });
    return send(res, 200, { ok: true, order_number: out.order_number, subtotal_vnd: out.subtotal, shipping_vnd: out.shipping, total_vnd: out.total, refund_vnd: out.refund_vnd });
  } catch (err) {
    if (err.statusCode) return send(res, err.statusCode, { error: err.message });
    throw err;
  }
}

// ── ĐỔI-TRẢ (RMA) v1 ─────────────────────────────────────────────────────────
// Khách ĐÃ NHẬN hàng (đơn 'delivered') trả lại vài/ toàn bộ món → HOÀN tiền phần trả +
// NHẬP LẠI KHO (nếu hàng còn bán được). Sinh tiền-ra + đổi tồn → route bar cao NHƯ refund
// (perm 'refund' + STEP-UP). Đổi hàng (trả A lấy B) = trả + tạo đơn mới, chưa gộp (v2).
//
// BẤT BIẾN: (1) chỉ trả đơn 'delivered'; (2) qty trả mỗi biến thể ≤ đã mua − đã trả trước
// (khoá đơn FOR UPDATE → cộng dồn chính xác, không trả quá); (3) hoàn = Σ(qty × giá
// SNAPSHOT dòng đơn), ≤ số CÒN CÓ THỂ HOÀN (đã thu − đã hoàn); (4) restock: on_hand +=
// qty + ledger 'receive' (mirror adjust); (5) tái dùng refunds (0070) cho tiền +
// returns/return_lines (0078) cho chứng từ trả → nhất quán lịch sử. MỌI lỗi THROW → ROLLBACK.
async function createReturn(res, ctx, body, params) {
  const orderId = params[1];
  const fail = (statusCode, msg) => { throw Object.assign(new Error(msg), { statusCode }); };
  const rawLines = Array.isArray(body?.lines) ? body.lines : [];
  const lines0 = rawLines.filter((l) => l && UUID_RE.test(String(l.variant_id ?? '')) && Number.isInteger(Number(l.qty)) && Number(l.qty) >= 1 && Number(l.qty) <= 100000)
    .map((l) => ({ variant_id: String(l.variant_id), qty: Number(l.qty) }));
  if (lines0.length === 0 || lines0.length > 50) return send(res, 400, { error: 'chọn 1-50 dòng hàng để trả' });
  const reason = String(body?.reason ?? '').trim().slice(0, 500) || null;
  const restock = body?.restock === true || body?.restock === 'true' || body?.restock === 'on';

  try {
    const out = await withTenant(ctx.shopId, async (c) => {
      const o = (await c.query(
        `SELECT id, order_number, status, payment_status, total_vnd, amount_paid_vnd, customer_email
           FROM orders WHERE id = $1 FOR UPDATE`, [orderId],
      )).rows[0];
      if (!o) fail(404, 'không tìm thấy đơn');
      if (o.status !== 'delivered') fail(409, 'chỉ nhận trả hàng cho đơn ĐÃ GIAO (khách đã nhận). Đơn chưa giao: huỷ/hoàn thay vì trả.');

      // Dòng đơn + giá snapshot. Gộp qty trả trùng biến thể.
      const ol = (await c.query(`SELECT variant_id, unit_price_vnd, unit_cost_vnd, qty FROM order_lines WHERE order_id = $1`, [orderId])).rows;
      const orderByVid = new Map(ol.map((l) => [l.variant_id, { unit: Number(l.unit_price_vnd), cost: l.unit_cost_vnd != null ? Number(l.unit_cost_vnd) : null, qty: l.qty }]));
      // Đã trả trước (cộng dồn qua các phiếu trả của đơn này).
      const prevRet = new Map();
      for (const rrow of (await c.query(
        `SELECT rl.variant_id, sum(rl.qty)::int AS q FROM return_lines rl JOIN returns r ON r.id = rl.return_id
          WHERE r.order_id = $1 GROUP BY rl.variant_id`, [orderId])).rows) prevRet.set(rrow.variant_id, Number(rrow.q));
      const want = new Map();
      for (const l of lines0) want.set(l.variant_id, (want.get(l.variant_id) ?? 0) + l.qty);

      let refund = 0;
      const retLines = [];
      for (const [vid, qty] of want) {
        const line = orderByVid.get(vid);
        if (!line) fail(422, 'có dòng không thuộc đơn này');
        const remaining = line.qty - (prevRet.get(vid) ?? 0);
        if (qty > remaining) fail(422, `trả quá số đã mua: biến thể chỉ còn ${Math.max(0, remaining)} có thể trả`);
        refund += line.unit * qty;
        retLines.push({ variant_id: vid, qty, unit: line.unit, cost: line.cost });
      }

      // Trần hoàn = đã thu − đã hoàn (neo amount_paid như v2; lazy: cột 0 → total).
      const collected = Number(o.amount_paid_vnd) > 0 ? Number(o.amount_paid_vnd) : Number(o.total_vnd);
      const refundsSum = Number((await c.query(`SELECT coalesce(sum(amount_vnd),0)::bigint AS s FROM refunds WHERE order_id = $1`, [orderId])).rows[0].s);
      if (refund > collected - refundsSum) fail(422, `số hoàn ${refund}đ vượt số còn có thể hoàn (đã thu ${collected}, đã hoàn ${refundsSum})`);

      // Phiếu trả + dòng trả.
      const ret = (await c.query(
        `INSERT INTO returns (shop_id, order_id, reason, refund_vnd, restocked, created_by)
         VALUES (current_shop_id(), $1, $2, $3, $4, $5) RETURNING id`, [orderId, reason, refund, restock, ctx.user.id],
      )).rows[0];
      for (const t of retLines) {
        // unit_cost_vnd (0081): copy snapshot GIÁ VỐN từ dòng đơn → SQL đảo COGS đọc thẳng
        // return_lines không join ngược. Dòng đơn NULL → NULL (COGS gốc chưa từng ghi).
        await c.query(
          `INSERT INTO return_lines (shop_id, return_id, variant_id, qty, unit_price_vnd, unit_cost_vnd)
           VALUES (current_shop_id(), $1, $2, $3, $4, $5)`, [ret.id, t.variant_id, t.qty, t.unit, t.cost],
        );
      }
      // Nhập lại kho (nếu hàng còn bán được) — khoá theo THỨ TỰ variant_id (chống deadlock).
      if (restock) {
        for (const t of [...retLines].sort((a, b) => a.variant_id.localeCompare(b.variant_id))) {
          await c.query(`INSERT INTO inventory_levels (shop_id, variant_id) VALUES (current_shop_id(), $1) ON CONFLICT (shop_id, variant_id) DO NOTHING`, [t.variant_id]);
          await c.query(`SELECT on_hand FROM inventory_levels WHERE variant_id = $1 FOR UPDATE`, [t.variant_id]);
          await c.query(`UPDATE inventory_levels SET on_hand = on_hand + $2, updated_at = now() WHERE variant_id = $1`, [t.variant_id, t.qty]);
          await c.query(
            `INSERT INTO inventory_ledger (shop_id, variant_id, delta, kind, reason, actor_id)
             VALUES (current_shop_id(), $1, $2, 'receive', $3, $4)`, [t.variant_id, t.qty, `Trả hàng đơn #${Number(o.order_number)}`, ctx.user.id],
          );
        }
      }
      // Bút toán hoàn (0070) — tiền chủ shop tự chuyển lại. restock cờ ghi nhận ý định.
      // kind='rma' (0081): phân loại nguồn phiếu — báo cáo trừ như 'refund' thường.
      await c.query(
        `INSERT INTO refunds (shop_id, order_id, amount_vnd, reason, restock, created_by, kind)
         VALUES (current_shop_id(), $1, $2, $3, $4, $5, 'rma')`, [orderId, refund, reason ? `Đổi-trả: ${reason}` : 'Đổi-trả hàng', restock, ctx.user.id],
      );
      await c.query(`UPDATE orders SET amount_paid_vnd = $2 WHERE id = $1`, [orderId, collected]); // neo đã-thu

      // Trạng thái: TRẢ HẾT mọi dòng → đơn 'returned' + returned_at. Hoàn CHẠM đủ đã-thu →
      // payment_status='refunded'. Trả một phần → giữ 'delivered'.
      const totalOrdered = ol.reduce((s, l) => s + l.qty, 0);
      const totalReturned = [...prevRet.values()].reduce((s, q) => s + q, 0) + retLines.reduce((s, t) => s + t.qty, 0);
      const refundedAfter = refundsSum + refund;
      const fullReturn = totalReturned >= totalOrdered;
      const fullRefund = refundedAfter >= collected;
      if (fullReturn || fullRefund) {
        await c.query(
          `UPDATE orders SET ${fullReturn ? "status = 'returned', returned_at = now(), " : ''}${fullRefund ? "payment_status = 'refunded'" : 'id = id'} WHERE id = $1`, [orderId],
        );
        if (fullReturn) { o.status = 'returned'; await statusEvent(c, o); }
      }
      await audit(c, 'order.returned_rma', { actorId: ctx.user.id, ip: ctx.ip, metadata: { orderId, order_number: Number(o.order_number), refund_vnd: refund, restocked: restock, lines: retLines.map((t) => ({ variant_id: t.variant_id, qty: t.qty })).slice(0, 40), full: fullReturn } });
      return { return_id: ret.id, refund_vnd: refund, restocked: restock, full_return: fullReturn };
    });
    return send(res, 200, { ok: true, ...out });
  } catch (err) {
    if (err.statusCode) return send(res, err.statusCode, { error: err.message });
    throw err;
  }
}

// XUẤT CSV ĐƠN HÀNG theo ĐÚNG bộ lọc đang xem (dùng chung buildOrderFilter với danh sách).
//
// Perm 'export' + step-up (KHÔNG phải 'orders.read'): danh sách đơn CỐ TÌNH không trả
// customer_phone — PII chỉ lộ từng đơn ở trang chi tiết. Cho 'orders.read' xuất CSV là mở
// kênh hút SĐT/địa chỉ HÀNG LOẠT chưa từng tồn tại. Cùng bậc với xuất báo cáo P&L.
//
// KHÔNG xuất bí mật: lookup_token_hash (năng lực tra/huỷ đơn của khách), client_ip_hash, id nội bộ.
async function exportOrders(res, ctx, _b, _p, query) {
  const F = buildOrderFilter(query);
  const out = await withTenant(ctx.shopId, async (c) => {
    // Đếm TRƯỚC → vượt trần thì bỏ ngay, không dựng chuỗi khổng lồ trong RAM.
    const n = Number((await c.query(`SELECT count(*)::int AS n FROM orders ${F.whereSql}`, F.args)).rows[0].n);
    if (n > EXPORT_ORDERS_MAX_ROWS) return { tooMany: n };
    return { rows: (await c.query(
      `SELECT order_number, created_at, status, payment_status, payment_method, fulfillment_status,
              customer_name, customer_phone, customer_email, shipping_address,
              subtotal_vnd, shipping_vnd, discount_vnd, total_vnd, amount_paid_vnd,
              coupon_code, points_redeemed, points_discount_vnd, payment_ref, note,
              paid_at, shipped_at, delivered_at, cancelled_at, returned_at, anonymized_at,
              source, source_ref
         FROM orders ${F.whereSql} ORDER BY order_number DESC`, F.args)).rows };
  });
  if (out.tooMany) {
    return send(res, 413, { error: `bộ lọc khớp ${out.tooMany} đơn (tối đa ${EXPORT_ORDERS_MAX_ROWS}). Hãy thu hẹp khoảng ngày rồi xuất lại.` });
  }
  for (const o of out.rows) {
    // shipping_address là jsonb → stringify giữ TRỌN (phường/quận/ghi chú). Đơn đã ẩn danh
    // (0064) có address NULL → phải ra ô RỖNG, không phải chuỗi 'null'.
    const a = o.shipping_address;
    o.shipping_address = a == null ? '' : (typeof a === 'string' ? a : JSON.stringify(a));
    o.customer_phone = new CsvText(o.customer_phone);  // giữ số 0 đầu khi mở bằng Excel
  }
  const csv = toCsv(
    ['order_number', 'created_at', 'status', 'payment_status', 'payment_method', 'fulfillment_status',
      'customer_name', 'customer_phone', 'customer_email', 'shipping_address',
      'subtotal_vnd', 'shipping_vnd', 'discount_vnd', 'total_vnd', 'amount_paid_vnd',
      'coupon_code', 'points_redeemed', 'points_discount_vnd', 'payment_ref', 'note',
      'paid_at', 'shipped_at', 'delivered_at', 'cancelled_at', 'returned_at', 'anonymized_at',
      'source', 'source_ref'],
    out.rows);
  // Xuất PII hàng loạt PHẢI để lại dấu vết. KHÔNG ghi `q` vào nhật ký — người bán hay tìm
  // bằng SĐT khách, ghi lại là bơm PII vào audit log.
  await withTenant(ctx.shopId, (c) => audit(c, 'orders.exported', {
    actorId: ctx.user.id, ip: ctx.ip,
    metadata: { count: out.rows.length, from: F.from || null, to: F.to || null, status: F.status || null, searched: !!F.q },
  }));
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="don-hang-${F.from || 'tat-ca'}-${F.to || 'tat-ca'}.csv"`,
  });
  return res.end(csv);
}

export const ORDER_ROUTES = [
  // /orders/export PHẢI đứng trước /orders/:uuid — 'export' không khớp UUID nhưng giữ thứ tự cho rõ.
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/orders/export$`), perm: 'export', stepUp: true, fn: (res, ctx, b, p, q) => exportOrders(res, ctx, b, p, q) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/orders$`), perm: 'orders.read', fn: (res, ctx, b, p, q) => listOrders(res, ctx, b, p, q) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders$`), perm: 'orders.write', fn: (res, ctx, b) => createManualOrder(res, ctx, b) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/sellable-variants$`), perm: 'orders.write', fn: (res, ctx, b, p, q) => listSellableVariants(res, ctx, q) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/bulk/confirm$`), perm: 'orders.write', fn: (res, ctx, b) => bulkConfirm(res, ctx, b) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/bulk/mark-paid$`), perm: 'orders.write', fn: (res, ctx, b) => bulkMarkPaid(res, ctx, b) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/orders/${UUID}$`), perm: 'orders.read', fn: (res, ctx, b, p) => getOrder(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/edit$`), perm: 'orders.write', fn: (res, ctx, b, p) => editOrder(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/edit-paid$`), perm: 'refund', stepUp: true, fn: (res, ctx, b, p) => editPaidOrder(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/return$`), perm: 'refund', stepUp: true, fn: (res, ctx, b, p) => createReturn(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/confirm$`), perm: 'orders.write', fn: (res, ctx, b, p) => confirmOrder(res, ctx, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/ship$`), perm: 'orders.write', fn: (res, ctx, b, p) => shipOrder(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/deliver$`), perm: 'orders.write', fn: (res, ctx, b, p) => deliverOrder(res, ctx, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/cancel$`), perm: 'orders.write', fn: (res, ctx, b, p) => cancelOrder(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/mark-returned$`), perm: 'orders.write', fn: (res, ctx, b, p) => markReturnedBomb(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/mark-paid$`), perm: 'orders.write', fn: (res, ctx, b, p) => markPaid(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/mark-paid-qr$`), perm: 'payment.write', stepUp: true, fn: (res, ctx, b, p) => markPaidQr(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/refund$`), perm: 'refund', stepUp: true, fn: (res, ctx, b, p) => refundOrder(res, ctx, b, p) },
];
