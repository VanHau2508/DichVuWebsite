-- 0046 — gia cố vận chuyển sau rà soát đối kháng (0044/0045).
--
-- (1) BACKSTOP DB "một vận đơn SỐNG mỗi đơn": guard app-level (shipping.js + shipOrder)
--     có cửa sổ đua giữa pha claim và pha chốt — partial unique index chặn tuyệt đối
--     dòng sống thứ hai (app bắt 23505 → 409). order_id là uuid duy nhất toàn cục.
-- (2) Worker dọn claim chết cần đọc shipments.created_at (0044 thiếu grant cột này).

-- Dọn dữ liệu tồn đọng TRƯỚC khi tạo index: đơn nào lỡ có >1 vận đơn sống (tạo trước khi
-- có guard) → giữ dòng MỚI NHẤT, các dòng cũ đánh 'cancelled' (không xoá — giữ vết).
UPDATE shipments SET status = 'cancelled', provider_status = coalesce(provider_status, 'dedup_0046')
 WHERE status IN ('created', 'in_transit')
   AND id NOT IN (
     SELECT DISTINCT ON (order_id) id FROM shipments
      WHERE status IN ('created', 'in_transit')
      ORDER BY order_id, created_at DESC, id DESC
   );

CREATE UNIQUE INDEX shipments_one_live_per_order_uq ON shipments (order_id)
  WHERE status IN ('created', 'in_transit');

GRANT SELECT (created_at) ON shipments TO app_expiry;
