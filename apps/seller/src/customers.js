/**
 * CRM-lite — danh sách khách hàng DẪN XUẤT từ orders (gộp theo SĐT chuẩn hoá),
 * lịch sử mua + ghi chú của shop (customer_notes, 0049). Perm orders.read/write.
 * Đơn 'cancelled' không tính vào tổng chi/số đơn (nhưng vẫn hiện trong lịch sử).
 */
import { send } from './http.js';
import { withTenant, audit } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const PHONE = '([0-9]{8,15})';

async function listCustomers(res, ctx, _b, _p, query) {
  const limit = Math.min(Math.max(parseInt(query.get('limit') ?? '20', 10) || 20, 1), 100);
  const offset = Math.max(parseInt(query.get('offset') ?? '0', 10) || 0, 0);
  const q = (query.get('q') ?? '').trim().slice(0, 100);
  const minOrders = Math.min(Math.max(parseInt(query.get('min_orders') ?? '1', 10) || 1, 1), 1000);
  const args = [minOrders];
  let filter = '';
  if (q) {
    args.push('%' + q.replace(/[%_\\]/g, '\\$&') + '%');
    filter = `AND (vn_unaccent(o.customer_name) LIKE vn_unaccent($${args.length}) OR o.customer_phone LIKE $${args.length})`;
  }
  const data = await withTenant(ctx.shopId, async (c) => {
    // Gộp theo SĐT: tên/email lấy từ đơn MỚI NHẤT; chi tiêu chỉ tính đơn không huỷ.
    const rows = (await c.query(
      `SELECT o.customer_phone AS phone,
              (array_agg(o.customer_name ORDER BY o.created_at DESC))[1] AS name,
              (array_agg(o.customer_email ORDER BY o.created_at DESC) FILTER (WHERE o.customer_email IS NOT NULL))[1] AS email,
              count(*)::int AS n_orders,
              sum(o.total_vnd)::bigint AS total_spent_vnd,
              count(*) FILTER (WHERE o.payment_status = 'paid')::int AS n_paid,
              max(o.created_at) AS last_order_at
         FROM orders o
        WHERE o.status <> 'cancelled' AND o.customer_phone IS NOT NULL ${filter}
        GROUP BY o.customer_phone
       HAVING count(*) >= $1
        ORDER BY max(o.created_at) DESC
        LIMIT ${limit} OFFSET ${offset}`, args)).rows;
    const total = Number((await c.query(
      `SELECT count(*)::int n FROM (
         SELECT 1 FROM orders o WHERE o.status <> 'cancelled' AND o.customer_phone IS NOT NULL ${filter}
         GROUP BY o.customer_phone HAVING count(*) >= $1) x`, args)).rows[0].n);
    return { customers: rows, total };
  });
  return send(res, 200, { ...data, limit, offset, min_orders: minOrders });
}

async function getCustomer(res, ctx, _b, params) {
  const phone = params[1];
  const data = await withTenant(ctx.shopId, async (c) => {
    const orders = (await c.query(
      `SELECT id, order_number, status, payment_status, payment_method, total_vnd, created_at, customer_name, customer_email
         FROM orders WHERE customer_phone = $1 ORDER BY created_at DESC LIMIT 100`, [phone])).rows;
    if (!orders.length) return null;
    const live = orders.filter((o) => o.status !== 'cancelled');
    const note = (await c.query(`SELECT note, updated_at FROM customer_notes WHERE phone = $1`, [phone])).rows[0] ?? null;
    return {
      phone,
      name: live[0]?.customer_name ?? orders[0].customer_name,
      email: orders.find((o) => o.customer_email)?.customer_email ?? null,
      n_orders: live.length,
      total_spent_vnd: live.reduce((s, o) => s + Number(o.total_vnd), 0),
      orders, note: note?.note ?? '', note_updated_at: note?.updated_at ?? null,
    };
  });
  if (!data) return send(res, 404, { error: 'không tìm thấy khách hàng' });
  return send(res, 200, data);
}

async function setNote(res, ctx, body, params) {
  const phone = params[1];
  const note = String(body.note ?? '').trim().slice(0, 2000);
  await withTenant(ctx.shopId, async (c) => {
    if (note === '') await c.query(`DELETE FROM customer_notes WHERE phone = $1`, [phone]);
    else await c.query(
      `INSERT INTO customer_notes (shop_id, phone, note, updated_at) VALUES (current_shop_id(), $1, $2, now())
       ON CONFLICT (shop_id, phone) DO UPDATE SET note = $2, updated_at = now()`, [phone, note]);
    // Audit KHÔNG ghi SĐT thô (append-only, app_rw không sửa được — ghi thô = tự phá erasure).
    await audit(c, 'customer.note_set', { actorId: ctx.user.id, ip: ctx.ip, metadata: { phone_masked: '•••' + phone.slice(-3) } });
  });
  return send(res, 200, { ok: true });
}

// ── Ẩn danh khách theo yêu cầu (Luật BVDLCN 91/2025) — CHỈ owner + step-up ────
// ANONYMIZE chứ không xoá đơn: doanh thu/trạng thái/dòng hàng giữ nguyên; chỉ gỡ danh
// tính (tên → sentinel, SĐT/email/địa chỉ/ip_hash → NULL). Kèm: xoá ghi chú CRM, ẩn tên
// trên đánh giá ĐÃ XÁC MINH (chứng minh được là khách này qua order_number), scrub
// payload outbox. Chặn khi còn đơn đang xử lý (cần địa chỉ để giao nốt).
async function eraseCustomer(res, ctx, _b, params) {
  const phone = params[1];
  const out = await withTenant(ctx.shopId, async (c) => {
    const inflight = Number((await c.query(
      `SELECT count(*)::int n FROM orders WHERE customer_phone = $1 AND status IN ('pending','confirmed','shipped')`, [phone],
    )).rows[0].n);
    if (inflight > 0) return { code: 409, body: { error: `khách còn ${inflight} đơn đang xử lý — hoàn tất hoặc huỷ các đơn đó trước khi ẩn danh` } };
    const nums = (await c.query(`SELECT order_number FROM orders WHERE customer_phone = $1`, [phone])).rows.map((r) => Number(r.order_number));
    if (nums.length === 0) return { code: 404, body: { error: 'không tìm thấy khách hàng' } };
    const ord = await c.query(
      `UPDATE orders SET customer_name = '(đã ẩn danh)', customer_phone = NULL, customer_email = NULL,
              shipping_address = NULL, client_ip_hash = NULL, anonymized_at = now()
        WHERE customer_phone = $1`, [phone],
    );
    // Đánh giá VERIFIED khớp order_number = liên kết chứng minh được (badge tính theo
    // SĐT+đơn lúc gửi). Đánh giá thường tên tự do — không xoá được đáng tin cậy.
    const rev = await c.query(
      `UPDATE product_reviews SET author_name = '(đã ẩn danh)', ip_hash = NULL
        WHERE verified AND order_number = ANY($1::int[])`, [nums],
    );
    await c.query(`DELETE FROM customer_notes WHERE phone = $1`, [phone]);
    // Outbox: gỡ to/link/customer_name khỏi payload các đơn của khách (RLS scope shop này).
    await c.query(
      `UPDATE outbox SET payload = payload - 'to' - 'link' - 'customer_name'
        WHERE payload ? 'order_number' AND (payload->>'order_number')::bigint = ANY($1::bigint[])`, [nums],
    );
    await audit(c, 'customer.erased', {
      actorId: ctx.user.id, ip: ctx.ip,
      metadata: { phone_masked: '•••' + phone.slice(-3), orders: ord.rowCount, reviews: rev.rowCount },
    });
    return { code: 200, body: { ok: true, orders_anonymized: ord.rowCount, reviews_anonymized: rev.rowCount } };
  });
  return send(res, out.code, out.body);
}

export const CUSTOMER_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/customers$`), perm: 'orders.read', fn: (res, ctx, b, p, q) => listCustomers(res, ctx, b, p, q) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/customers/${PHONE}$`), perm: 'orders.read', fn: (res, ctx, b, p) => getCustomer(res, ctx, b, p) },
  { m: 'PUT', re: new RegExp(`^/shops/${UUID}/customers/${PHONE}/note$`), perm: 'orders.write', fn: (res, ctx, b, p) => setNote(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/customers/${PHONE}/erase$`), perm: 'privacy.erase', stepUp: true, fn: (res, ctx, b, p) => eraseCustomer(res, ctx, b, p) },
];
