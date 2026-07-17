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
// Base URL ảnh public (giống storefront) — thumbnail SP bán chạy trên Tổng quan.
const MEDIA_PUBLIC_BASE = process.env.MEDIA_PUBLIC_BASE ?? '/media-public';
const DAYS = 14; // độ dài chuỗi doanh thu theo ngày (biểu đồ Tổng quan)

async function stats(res, ctx) {
  const out = await withTenant(ctx.shopId, async (c) => {
    const k = (await c.query(`
      SELECT
        coalesce(sum(total_vnd) FILTER (WHERE payment_status = 'paid'
          AND paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh' >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')), 0) AS rev_today,
        coalesce(sum(total_vnd) FILTER (WHERE payment_status = 'paid'
          AND paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh' >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '6 days'), 0) AS rev_7d,
        coalesce(sum(total_vnd) FILTER (WHERE payment_status = 'paid'), 0) AS rev_all,
        -- Kỳ 7 ngày LIỀN TRƯỚC [today-13, today-6) → tính % tăng/giảm so với 7 ngày này.
        coalesce(sum(total_vnd) FILTER (WHERE payment_status = 'paid'
          AND paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh' >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '13 days'
          AND paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh' <  date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '6 days'), 0) AS rev_prev7,
        count(*) FILTER (WHERE created_at AT TIME ZONE 'Asia/Ho_Chi_Minh' >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')) AS orders_today,
        count(*) FILTER (WHERE status = 'pending')   AS n_pending,
        count(*) FILTER (WHERE status = 'confirmed') AS n_confirmed,
        count(*) FILTER (WHERE status = 'shipped')   AS n_shipped,
        count(*) FILTER (WHERE status = 'delivered') AS n_delivered,
        count(*) FILTER (WHERE status = 'cancelled') AS n_cancelled,
        count(*) FILTER (WHERE payment_status <> 'paid' AND status NOT IN ('cancelled', 'refunded', 'returned')) AS n_unpaid
      FROM orders`)).rows[0];
    // Hoàn MỘT PHẦN (0070) trừ khỏi doanh thu theo NGÀY TẠO bút toán. CHỈ đơn còn
    // payment_status='paid': đơn hoàn TOÀN BỘ đã lật 'refunded' và tự rớt khỏi
    // rev_* ở trên — trừ thêm bút toán của nó là trừ ĐÚP.
    const rf = (await c.query(`
      SELECT
        coalesce(sum(r.amount_vnd) FILTER (WHERE r.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh' >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')), 0) AS rf_today,
        coalesce(sum(r.amount_vnd) FILTER (WHERE r.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh' >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '6 days'), 0) AS rf_7d,
        coalesce(sum(r.amount_vnd) FILTER (WHERE r.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh' >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '13 days'
          AND r.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh' < date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '6 days'), 0) AS rf_prev7,
        coalesce(sum(r.amount_vnd), 0) AS rf_all
      FROM refunds r JOIN orders o ON o.id = r.order_id
      WHERE o.payment_status = 'paid'`)).rows[0];
    // Bán chạy 30 ngày + ẢNH: gộp theo tên/sku (snapshot), lấy biến thể GẦN NHẤT làm đại
    // diện → resolve ảnh (ưu tiên ảnh riêng biến thể, không có thì ảnh chính sản phẩm).
    const top = (await c.query(`
      SELECT t.title, t.sku, t.qty, t.revenue,
             (SELECT m.public_key FROM media m
                JOIN variants v ON v.product_id = m.product_id
               WHERE v.id = t.vid AND m.status = 'ready' AND m.deleted_at IS NULL
                 AND (m.variant_id = t.vid OR m.variant_id IS NULL)
               ORDER BY (m.variant_id IS NOT NULL) DESC, m.position, m.created_at LIMIT 1) AS image_key
        FROM (
          SELECT l.title_snapshot AS title, l.sku_snapshot AS sku,
                 sum(l.qty)::int AS qty, sum(l.qty * l.unit_price_vnd)::bigint AS revenue,
                 (array_agg(l.variant_id ORDER BY o.paid_at DESC))[1] AS vid
            FROM order_lines l JOIN orders o ON o.id = l.order_id
           WHERE o.payment_status = 'paid' AND o.paid_at >= now() - interval '30 days'
           GROUP BY l.title_snapshot, l.sku_snapshot
           ORDER BY revenue DESC LIMIT 5
        ) t`)).rows;
    // Doanh thu THEO NGÀY (14 ngày, giờ VN) — generate_series lấp ngày trống = 0 để biểu
    // đồ không "nhảy cóc". LEFT JOIN theo ngày đã quy đổi múi giờ VN.
    const series = (await c.query(`
      SELECT to_char(d, 'YYYY-MM-DD') AS day, coalesce(sum(o.total_vnd), 0)::bigint AS revenue
        FROM generate_series(
               date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '${DAYS - 1} days',
               date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh'),
               interval '1 day') AS d
        LEFT JOIN orders o ON o.payment_status = 'paid'
             AND date_trunc('day', o.paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = d
       GROUP BY d ORDER BY d`)).rows;
    // Bút toán hoàn một phần theo ngày (giờ VN) — trừ vào series cùng logic với rf ở trên.
    const rfByDay = (await c.query(`
      SELECT to_char(date_trunc('day', r.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM-DD') AS day,
             sum(r.amount_vnd)::bigint AS refunded
        FROM refunds r JOIN orders o ON o.id = r.order_id
       WHERE o.payment_status = 'paid' AND r.created_at >= now() - interval '${DAYS + 1} days'
       GROUP BY 1`)).rows;
    const rfMap = new Map(rfByDay.map((r) => [r.day, Number(r.refunded)]));
    for (const s of series) s.revenue = Number(s.revenue) - (rfMap.get(s.day) ?? 0);
    // Sắp hết hàng (0050): available <= ngưỡng shop (NULL → mặc định 5). Chỉ SP đang bán.
    const low = (await c.query(`
      SELECT p.title, v.sku, v.title AS variant_title, (il.on_hand - il.reserved)::int AS available
        FROM variants v
        JOIN products p ON p.id = v.product_id AND p.status = 'active' AND p.deleted_at IS NULL
        JOIN inventory_levels il ON il.variant_id = v.id
       WHERE (il.on_hand - il.reserved) <= coalesce((SELECT low_stock_threshold FROM shops WHERE id = current_shop_id()), 5)
       ORDER BY available ASC LIMIT 10`)).rows;
    return { k, rf, top, low, series };
  });
  const n = (x) => Number(x ?? 0);
  return send(res, 200, {
    revenue: {
      today: n(out.k.rev_today) - n(out.rf.rf_today), d7: n(out.k.rev_7d) - n(out.rf.rf_7d),
      prev7: n(out.k.rev_prev7) - n(out.rf.rf_prev7), all: n(out.k.rev_all) - n(out.rf.rf_all),
    },
    series: out.series.map((r) => ({ day: r.day, revenue: n(r.revenue) })),
    orders_today: n(out.k.orders_today),
    unpaid: n(out.k.n_unpaid),
    status: {
      pending: n(out.k.n_pending), confirmed: n(out.k.n_confirmed), shipped: n(out.k.n_shipped),
      delivered: n(out.k.n_delivered), cancelled: n(out.k.n_cancelled),
    },
    top_products: out.top.map((t) => ({
      title: t.title, sku: t.sku, qty: n(t.qty), revenue: n(t.revenue),
      image_url: t.image_key ? `${MEDIA_PUBLIC_BASE}/${t.image_key}` : null,
    })),
    low_stock: out.low.map((l) => ({ title: l.title, sku: l.sku, variant_title: l.variant_title, available: n(l.available) })),
  });
}

export const DASHBOARD_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/stats$`), perm: 'orders.read', fn: (res, ctx) => stats(res, ctx) },
];
