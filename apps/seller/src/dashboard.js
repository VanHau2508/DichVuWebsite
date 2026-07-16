/**
 * Số liệu tổng quan cho chủ shop (GĐ2). Doanh thu + đơn theo trạng thái + bán chạy.
 *
 * Chạy qua withTenant → RLS cô lập theo shop. Perm 'orders.read' (khai ở route, router
 * cưỡng chế) — cần đọc đơn mới thấy doanh thu.
 *
 * "Doanh thu" = đơn ĐÃ THANH TOÁN (payment_status='paid'), tính theo paid_at. Mốc ngày
 * theo giờ VN (Asia/Ho_Chi_Minh) để "hôm nay" khớp cảm nhận người bán, không lệch theo
 * giờ UTC của container. pg trả bigint dạng CHUỖI → Number() ở tầng trả JSON.
 */
import { send } from './http.js';
import { withTenant } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

async function stats(res, ctx) {
  const out = await withTenant(ctx.shopId, async (c) => {
    const k = (await c.query(`
      SELECT
        coalesce(sum(total_vnd) FILTER (WHERE payment_status = 'paid'
          AND paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh' >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')), 0) AS rev_today,
        coalesce(sum(total_vnd) FILTER (WHERE payment_status = 'paid'
          AND paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh' >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '6 days'), 0) AS rev_7d,
        coalesce(sum(total_vnd) FILTER (WHERE payment_status = 'paid'), 0) AS rev_all,
        count(*) FILTER (WHERE created_at AT TIME ZONE 'Asia/Ho_Chi_Minh' >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')) AS orders_today,
        count(*) FILTER (WHERE status = 'pending')   AS n_pending,
        count(*) FILTER (WHERE status = 'confirmed') AS n_confirmed,
        count(*) FILTER (WHERE status = 'shipped')   AS n_shipped,
        count(*) FILTER (WHERE status = 'delivered') AS n_delivered,
        count(*) FILTER (WHERE status = 'cancelled') AS n_cancelled,
        count(*) FILTER (WHERE payment_status <> 'paid' AND status NOT IN ('cancelled', 'refunded')) AS n_unpaid
      FROM orders`)).rows[0];
    const top = (await c.query(`
      SELECT l.title_snapshot AS title, l.sku_snapshot AS sku,
             sum(l.qty)::int AS qty, sum(l.qty * l.unit_price_vnd)::bigint AS revenue
        FROM order_lines l JOIN orders o ON o.id = l.order_id
       WHERE o.payment_status = 'paid' AND o.paid_at >= now() - interval '30 days'
       GROUP BY l.title_snapshot, l.sku_snapshot
       ORDER BY revenue DESC LIMIT 5`)).rows;
    // Sắp hết hàng (0050): available <= ngưỡng shop (NULL → mặc định 5). Chỉ SP đang bán.
    const low = (await c.query(`
      SELECT p.title, v.sku, v.title AS variant_title, (il.on_hand - il.reserved)::int AS available
        FROM variants v
        JOIN products p ON p.id = v.product_id AND p.status = 'active' AND p.deleted_at IS NULL
        JOIN inventory_levels il ON il.variant_id = v.id
       WHERE (il.on_hand - il.reserved) <= coalesce((SELECT low_stock_threshold FROM shops WHERE id = current_shop_id()), 5)
       ORDER BY available ASC LIMIT 10`)).rows;
    return { k, top, low };
  });
  const n = (x) => Number(x ?? 0);
  return send(res, 200, {
    revenue: { today: n(out.k.rev_today), d7: n(out.k.rev_7d), all: n(out.k.rev_all) },
    orders_today: n(out.k.orders_today),
    unpaid: n(out.k.n_unpaid),
    status: {
      pending: n(out.k.n_pending), confirmed: n(out.k.n_confirmed), shipped: n(out.k.n_shipped),
      delivered: n(out.k.n_delivered), cancelled: n(out.k.n_cancelled),
    },
    top_products: out.top.map((t) => ({ title: t.title, sku: t.sku, qty: n(t.qty), revenue: n(t.revenue) })),
    low_stock: out.low.map((l) => ({ title: l.title, sku: l.sku, variant_title: l.variant_title, available: n(l.available) })),
  });
}

export const DASHBOARD_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/stats$`), perm: 'orders.read', fn: (res, ctx) => stats(res, ctx) },
];
