-- 0162 - Khách chỉ được ghi sự kiện cho đơn của chính mình.
--
-- order_requests đã chặn bằng customer_id/lookup token, nhưng nếu không ghi cùng transaction thì
-- timeline của seller chỉ thấy quyết định cuối, không thấy lúc khách bắt đầu yêu cầu. Quyền này chỉ
-- mở cho app_customer và policy lặp lại đúng hàng rào sở hữu đơn; không mở UPDATE/DELETE lịch sử.

GRANT INSERT ON order_events TO app_customer;

CREATE POLICY order_events_customer_insert ON order_events
  FOR INSERT TO app_customer
  WITH CHECK (
    shop_id = current_shop_id()
    AND EXISTS (
      SELECT 1 FROM orders o
       WHERE o.id = order_events.order_id
         AND o.shop_id = order_events.shop_id
         AND o.customer_id = current_customer_id()
    )
  );

GRANT EXECUTE ON FUNCTION record_order_event(uuid,text,text,text,text,jsonb,timestamptz)
  TO app_customer;
