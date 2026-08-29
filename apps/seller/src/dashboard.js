/**
 * Số liệu tổng quan cho chủ shop (GĐ2). Doanh thu + đơn theo trạng thái + bán chạy.
 *
 * Chạy qua withTenant → RLS cô lập theo shop. Perm 'orders.read' (khai ở route, router
 * cưỡng chế) — cần đọc đơn mới thấy doanh thu.
 *
 * "Doanh thu" = đơn ĐÃ TỪNG thanh toán (EVER-PAID: paid_at IS NOT NULL — quy tắc sổ cái
 * 0081, ĐỒNG BỘ với trang Báo cáo): refundOrder lật payment_status='refunded' nhưng GIỮ
 * paid_at → lọc theo payment_status làm đơn full-refund rớt ngược khỏi kỳ đã đóng. Doanh
 * thu đứng yên ở ngày thu tiền; phiếu hoàn trừ tại NGÀY PHIẾU (mọi kind trừ
 * 'edit_adjustment' — phiếu chênh sửa-đơn-đã-trả đã phản ánh qua header đơn bị hạ).
 * Mốc ngày theo giờ VN (Asia/Ho_Chi_Minh). pg trả bigint dạng CHUỖI → Number().
 */
import { send } from './http.js';
import { withTenant } from './db.js';
import { withOptionalDashboardGroup } from './dashboard-contract.js';
import { OWED_SQL, PAYMENT_PARTIAL_SQL, PAYMENT_UNPAID_SQL } from '../owed.js';
import { AVAIL_SQL } from '../safety-stock.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
// Base URL ảnh public (giống storefront) — thumbnail SP bán chạy trên Tổng quan.
const MEDIA_PUBLIC_BASE = process.env.MEDIA_PUBLIC_BASE ?? '/media-public';
const DAYS = 14; // độ dài chuỗi doanh thu theo ngày (biểu đồ Tổng quan)

const TODO_DEFS = [
  { code: 'owed', field: 'owed_count', severity: 'khẩn', source: 'web' },
  { code: 'order_requests', field: 'order_requests', severity: 'khẩn', source: 'web' },
  { code: 'resolution_cases', field: 'resolution_cases', severity: 'khẩn', source: 'system' },
  { code: 'shipment_attention', field: 'shipment_attention', severity: 'khẩn', source: 'system' },
  { code: 'to_confirm', field: 'to_confirm', severity: 'chờ', source: 'web' },
  { code: 'to_ship', field: 'to_ship', severity: 'chờ', source: 'web' },
  { code: 'unpaid', field: 'unpaid', severity: 'chờ', source: 'web' },
  { code: 'partial_payments', field: 'partial_payments', severity: 'chờ', source: 'web' },
  { code: 'notification_failures', field: 'notification_failures', severity: 'theo_dõi', source: 'system' },
  { code: 'reviews_pending', field: 'reviews_pending', severity: 'theo_dõi', source: 'system' },
  { code: 'low_stock', field: 'low_stock', severity: 'theo_dõi', source: 'system' },
];

async function stats(res, ctx) {
  const out = await withTenant(ctx.shopId, async (c) => {
    const partial = [];
    // Mốc snapshot lấy ngay đầu transaction, trước mọi truy vấn nghiệp vụ. Không dùng đồng
    // hồ ứng dụng sau COMMIT vì lúc đó nó chỉ còn là thời điểm gửi response.
    const generatedAt = (await c.query('SELECT now() AS generated_at')).rows[0].generated_at;
    // Optional dashboard groups recover to a savepoint so one unavailable widget never
    // turns its count into a misleading zero or aborts the rest of the snapshot.
    const optional = (name, fn, fallback = null) => withOptionalDashboardGroup(c, partial, name, fn, fallback);
    const k = (await c.query(`
      SELECT
        coalesce(sum(total_vnd) FILTER (WHERE paid_at IS NOT NULL
          AND paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh' >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')), 0) AS rev_today,
        coalesce(sum(total_vnd) FILTER (WHERE paid_at IS NOT NULL
          AND paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh' >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '6 days'), 0) AS rev_7d,
        coalesce(sum(total_vnd) FILTER (WHERE paid_at IS NOT NULL), 0) AS rev_all,
        -- Kỳ 7 ngày LIỀN TRƯỚC [today-13, today-6) → tính % tăng/giảm so với 7 ngày này.
        coalesce(sum(total_vnd) FILTER (WHERE paid_at IS NOT NULL
          AND paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh' >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '13 days'
          AND paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh' <  date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '6 days'), 0) AS rev_prev7,
        count(*) FILTER (WHERE created_at AT TIME ZONE 'Asia/Ho_Chi_Minh' >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')) AS orders_today,
        count(*) FILTER (WHERE status = 'pending')   AS n_pending,
        count(*) FILTER (WHERE status = 'confirmed') AS n_confirmed,
        count(*) FILTER (WHERE status = 'shipped')   AS n_shipped,
        count(*) FILTER (WHERE status = 'delivered') AS n_delivered,
        count(*) FILTER (WHERE status = 'cancelled') AS n_cancelled,
        count(*) FILTER (WHERE ${PAYMENT_UNPAID_SQL}) AS n_unpaid,
        count(*) FILTER (WHERE ${PAYMENT_PARTIAL_SQL}) AS n_partial
      FROM orders o
      -- Đơn DI CƯ (0104) bị loại khỏi MỌI con số ở đây: doanh thu, đơn hôm nay, đếm theo
      -- trạng thái, số đơn chưa thu. Chúng là lịch sử từ sàn khác — tính vào là vừa sai
      -- doanh thu vừa đẻ ra "việc cần làm" ma mà người bán không xử lý được.
      WHERE NOT is_migrated`)).rows[0];
    // Hoàn tiền (0070) trừ khỏi doanh thu theo NGÀY TẠO bút toán — MỌI phiếu trên đơn
    // từng paid (ever-paid ở trên KHÔNG loại đơn refunded khỏi doanh thu nữa nên không
    // trừ đúp), TRỪ kind='edit_adjustment' (0081): phiếu chênh sửa-đơn-đã-trả đã phản
    // ánh qua header đơn bị hạ — trừ thêm là trừ ĐÚP đúng khoản chênh.
    const rf = (await c.query(`
      SELECT
        coalesce(sum(r.amount_vnd) FILTER (WHERE r.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh' >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')), 0) AS rf_today,
        coalesce(sum(r.amount_vnd) FILTER (WHERE r.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh' >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '6 days'), 0) AS rf_7d,
        coalesce(sum(r.amount_vnd) FILTER (WHERE r.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh' >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '13 days'
          AND r.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh' < date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '6 days'), 0) AS rf_prev7,
        coalesce(sum(r.amount_vnd), 0) AS rf_all
      FROM refunds r JOIN orders o ON o.id = r.order_id
      WHERE o.paid_at IS NOT NULL AND NOT o.is_migrated AND r.kind <> 'edit_adjustment'`)).rows[0];
    // Bán chạy 30 ngày + ẢNH: gộp theo tên/sku (snapshot), lấy biến thể GẦN NHẤT làm đại
    // diện → resolve ảnh (ưu tiên ảnh riêng biến thể, không có thì ảnh chính sản phẩm).
    const top = await optional('top_products', async () => (await c.query(`
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
           WHERE o.paid_at >= now() - interval '30 days' AND NOT o.is_migrated
           GROUP BY l.title_snapshot, l.sku_snapshot
           ORDER BY revenue DESC LIMIT 5
        ) t`)).rows, []);
    // Doanh thu THEO NGÀY (14 ngày, giờ VN) — generate_series lấp ngày trống = 0 để biểu
    // đồ không "nhảy cóc". LEFT JOIN theo ngày đã quy đổi múi giờ VN.
    const series = await optional('series', async () => {
      const rows = (await c.query(`
      SELECT to_char(d, 'YYYY-MM-DD') AS day, coalesce(sum(o.total_vnd), 0)::bigint AS revenue
        FROM generate_series(
               date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '${DAYS - 1} days',
               date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh'),
               interval '1 day') AS d
        LEFT JOIN orders o ON o.paid_at IS NOT NULL AND NOT o.is_migrated
             AND date_trunc('day', o.paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = d
       GROUP BY d ORDER BY d`)).rows;
    // Bút toán hoàn theo ngày (giờ VN) — trừ vào series cùng quy tắc sổ cái với rf ở trên.
    const rfByDay = (await c.query(`
      SELECT to_char(date_trunc('day', r.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM-DD') AS day,
             sum(r.amount_vnd)::bigint AS refunded
        FROM refunds r JOIN orders o ON o.id = r.order_id
       WHERE o.paid_at IS NOT NULL AND NOT o.is_migrated AND r.kind <> 'edit_adjustment' AND r.created_at >= now() - interval '${DAYS + 1} days'
       GROUP BY 1`)).rows;
      const rfMap = new Map(rfByDay.map((r) => [r.day, Number(r.refunded)]));
      for (const s of rows) s.revenue = Number(s.revenue) - (rfMap.get(s.day) ?? 0);
      return rows;
    }, []);
    // Sắp hết hàng ONLINE: cùng ATS đã trừ vùng đệm với storefront/checkout.
    const low = await optional('low_stock', async () => (await c.query(`
      SELECT p.title, v.sku, v.title AS variant_title, (${AVAIL_SQL})::int AS available
        FROM variants v
        JOIN products p ON p.id = v.product_id AND p.status = 'active' AND p.deleted_at IS NULL
        JOIN inventory_levels il ON il.variant_id = v.id
       WHERE ${AVAIL_SQL} <= coalesce((SELECT low_stock_threshold FROM shops WHERE id = current_shop_id()), 5)
       ORDER BY available ASC LIMIT 10`)).rows, []);
    // Hai trạng thái này đều chặn tạo vận đơn mới để tránh hãng thu COD hai lần. Đưa tối đa
    // 10 ca mới nhất lên Tổng quan; thao tác phục hồi thật vẫn nằm trong chi tiết từng đơn.
    const shipmentAttention = await optional('shipment_attention', async () => (await c.query(`
      SELECT s.id AS shipment_id, s.order_id, o.order_number, s.provider,
             s.provider_status, s.tracking_number, s.created_at
        FROM shipments s
        JOIN orders o ON o.shop_id = s.shop_id AND o.id = s.order_id
       WHERE s.status = 'created'
         AND s.provider_status IN ('ambiguous','finalize_failed')
         AND NOT o.is_migrated
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT 10`)).rows, []);
    // "VIỆC CẦN LÀM" (hộp hành động kiểu TikTok Shop): 2 tín hiệu còn thiếu so với payload cũ.
    //   - đánh giá CHỜ DUYỆT: khách đã viết nhưng chưa hiện lên storefront → mất social proof.
    //   - TỔNG số biến thể sắp hết: `low` ở trên bị LIMIT 10 (bảng hiển thị), không dùng để
    //     đếm được; muốn hiện đúng "23 mục sắp hết" phải đếm riêng không giới hạn.
    const todo = await optional('todo', async () => (await c.query(`
      SELECT
        (SELECT count(*)::int FROM product_reviews WHERE status = 'pending') AS reviews_pending,
        (SELECT count(*)::int
           FROM variants v
           JOIN products p ON p.id = v.product_id AND p.status = 'active' AND p.deleted_at IS NULL
           JOIN inventory_levels il ON il.variant_id = v.id
          WHERE ${AVAIL_SQL} <= coalesce((SELECT low_stock_threshold FROM shops WHERE id = current_shop_id()), 5)
        ) AS low_stock_count,
        -- CÒN NỢ KHÁCH: tiền của khách đang nằm trong túi shop. Dùng CHUNG biểu thức với trang
        -- Công nợ và băng đỏ trên đơn (owed.js) — ba nơi hiện cùng một con số thì mới tin được.
        -- Đây là việc cần làm GẤP NHẤT trong hộp này: mọi việc khác chỉ chậm tiền về, việc này
        -- là tiền của người khác đang giữ nhầm.
        (SELECT count(*)::int FROM orders o WHERE ${OWED_SQL} > 0) AS owed_count,
        (SELECT coalesce(sum(${OWED_SQL}), 0)::bigint FROM orders o WHERE ${OWED_SQL} > 0) AS owed_vnd,
        (SELECT count(*)::int FROM order_resolution_cases WHERE status IN ('open','waiting_return')) AS resolution_cases_open,
        (SELECT count(*)::int FROM notification_deliveries WHERE status = 'failed') AS notification_failures,
        (SELECT count(*)::int FROM order_requests WHERE status = 'requested') AS order_requests_pending,
        (SELECT count(*)::int
           FROM shipments s
           JOIN orders o ON o.shop_id = s.shop_id AND o.id = s.order_id
          WHERE s.status = 'created'
            AND s.provider_status IN ('ambiguous','finalize_failed')
            AND NOT o.is_migrated
        ) AS shipment_attention`)).rows[0], null);
    const sync = await optional('sync', async () => {
      const row = (await c.query(`
        SELECT i.provider, i.status, i.inventory_authority, i.inventory_synced_at,
               EXTRACT(EPOCH FROM (now() - i.inventory_synced_at))::bigint AS lag_seconds,
               (SELECT count(*)::int FROM integration_sync_discrepancies d
                  WHERE d.shop_id = current_shop_id() AND d.status = 'open') AS discrepancies_open
          FROM shop_integrations i
         WHERE i.shop_id = current_shop_id()
         ORDER BY (i.inventory_authority = 'external_master') DESC, i.id
         LIMIT 1`)).rows[0];
      return row ? {
        mode: row.inventory_authority,
        source: row.provider,
        provider: row.provider,
        status: row.status,
        freshness_at: row.inventory_synced_at,
        lag_seconds: row.lag_seconds == null ? null : Number(row.lag_seconds),
        discrepancies_open: Number(row.discrepancies_open ?? 0),
      } : {
        mode: 'local', source: 'local', provider: null, status: 'not_connected',
        freshness_at: null, lag_seconds: null, discrepancies_open: 0,
      };
    }, null);
    return { generatedAt, k, rf, top, low, shipmentAttention, series, todo, sync, partial };
  });
  const n = (x) => Number(x ?? 0);
  // Giữ nguyên hình dạng `todo` cũ để client cũ không phải xử lý null cả object. Bốn số
  // trạng thái đơn đã có trong KPI lõi; chỉ các mục lấy từ truy vấn tùy chọn mới mất khi
  // nhóm todo lỗi. `todo_items[].available` nói rõ từng mục nào đã được xác minh.
  const todo = {
    to_confirm: n(out.k.n_pending),
    to_ship: n(out.k.n_confirmed),
    unpaid: n(out.k.n_unpaid),
    partial_payments: n(out.k.n_partial),
    reviews_pending: out.todo ? n(out.todo.reviews_pending) : null,
    low_stock: out.todo ? n(out.todo.low_stock_count) : null,
    owed_count: out.todo ? n(out.todo.owed_count) : null,
    owed_vnd: out.todo ? n(out.todo.owed_vnd) : null,
    resolution_cases: out.todo ? n(out.todo.resolution_cases_open) : null,
    notification_failures: out.todo ? n(out.todo.notification_failures) : null,
    order_requests: out.todo ? n(out.todo.order_requests_pending) : null,
    shipment_attention: out.todo ? n(out.todo.shipment_attention) : null,
  };
  const CORE_TODO_FIELDS = new Set(['to_confirm', 'to_ship', 'unpaid', 'partial_payments']);
  const todoItems = TODO_DEFS.map((d) => {
    const available = CORE_TODO_FIELDS.has(d.field) || !!out.todo;
    return {
      code: d.code, count: available ? todo[d.field] : null, severity: d.severity, source: d.source, available,
    };
  });
  return send(res, 200, {
    generated_at: out.generatedAt,
    partial: { failed: out.partial },
    sync: out.sync,
    revenue: {
      today: n(out.k.rev_today) - n(out.rf.rf_today), d7: n(out.k.rev_7d) - n(out.rf.rf_7d),
      prev7: n(out.k.rev_prev7) - n(out.rf.rf_prev7), all: n(out.k.rev_all) - n(out.rf.rf_all),
    },
    series: out.series.map((r) => ({ day: r.day, revenue: n(r.revenue) })),
    orders_today: n(out.k.orders_today),
    unpaid: n(out.k.n_unpaid),
    partial_payments: n(out.k.n_partial),
    status: {
      pending: n(out.k.n_pending), confirmed: n(out.k.n_confirmed), shipped: n(out.k.n_shipped),
      delivered: n(out.k.n_delivered), cancelled: n(out.k.n_cancelled),
    },
    top_products: out.top.map((t) => ({
      title: t.title, sku: t.sku, qty: n(t.qty), revenue: n(t.revenue),
      image_url: t.image_key ? `${MEDIA_PUBLIC_BASE}/${t.image_key}` : null,
    })),
    low_stock: out.low.map((l) => ({ title: l.title, sku: l.sku, variant_title: l.variant_title, available: n(l.available) })),
    shipment_attention: out.shipmentAttention.map((s) => ({
      shipment_id: s.shipment_id,
      order_id: s.order_id,
      order_number: s.order_number,
      provider: s.provider,
      provider_status: s.provider_status,
      tracking_number: s.tracking_number,
      created_at: s.created_at,
    })),
    // Hộp "Việc cần làm" trên Tổng quan: mỗi số là 1 việc chủ shop phải xử lý HÔM NAY,
    // kèm link tới đúng trang lọc sẵn (mẫu màn hình chính của TikTok Shop / Shopee).
    todo,
    todo_items: todoItems,
  });
}

export const DASHBOARD_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/stats$`), perm: 'orders.read', fn: (res, ctx) => stats(res, ctx) },
];
