-- 0163 - Vai worker chỉ được ghi đúng các loại sự kiện hệ thống mà nó thực sự tạo.
--
-- 0153/0161 mở WITH CHECK(true) cho app_expiry và app_worker vì hai vai chạy xuyên shop.
-- Cross-shop là cần thiết, nhưng không đồng nghĩa được phép giả một event tiền hoặc một actor người
-- dùng. Allowlist dưới đây giữ quyền xuyên tenant, đồng thời biến event_type/actor/source thành hàng
-- rào DB thay vì chỉ là lời hứa trong mã worker.

DROP POLICY order_events_expiry ON order_events;
CREATE POLICY order_events_expiry ON order_events
  FOR INSERT TO app_expiry
  WITH CHECK (
    source = 'worker'
    AND (
      (event_type IN ('order.cancelled', 'resolution.opened')
        AND actor_type = 'system' AND actor_id IS NULL)
      OR
      (event_type IN ('shipment.delivered', 'shipment.returned')
        AND actor_type = 'carrier' AND actor_id IS NOT NULL)
    )
  );

DROP POLICY order_events_worker ON order_events;
CREATE POLICY order_events_worker ON order_events
  FOR INSERT TO app_worker
  WITH CHECK (
    source = 'worker'
    AND actor_type = 'system'
    AND actor_id IS NULL
    AND event_type IN ('notification.sent', 'notification.failed')
  );
