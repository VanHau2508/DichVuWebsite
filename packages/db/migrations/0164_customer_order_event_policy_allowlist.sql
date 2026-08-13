-- 0164 - Khách mua chỉ được ghi mốc timeline từ một order_request hợp lệ của chính mình.
--
-- Policy 0162 mới chỉ kiểm tra quyền sở hữu đơn. Nếu account service bị lỗi/bị lợi dụng API,
-- app_customer có thể giả payment.received, đổi actor/source, hoặc gắn event vào request khác.
-- Thay policy cũ bằng allowlist hẹp và nối bắt buộc payload.request_id với chứng từ gốc.

DROP POLICY order_events_customer_insert ON order_events;

CREATE POLICY order_events_customer_insert ON order_events
  FOR INSERT TO app_customer
  WITH CHECK (
    shop_id = current_shop_id()
    AND event_type IN (
      'order.cancel_requested',
      'order.address_change_requested',
      'return.requested'
    )
    AND actor_type = 'buyer'
    AND actor_id = current_customer_id()::text
    AND source = 'account'
    AND jsonb_typeof(payload -> 'request_id') = 'string'
    AND EXISTS (
      SELECT 1
        FROM order_requests r
       WHERE r.id::text = order_events.payload ->> 'request_id'
         AND r.shop_id = order_events.shop_id
         AND r.order_id = order_events.order_id
         AND r.customer_id = current_customer_id()
         AND r.requester_type = 'customer'
         AND r.status = 'requested'
         AND (
              (order_events.event_type = 'order.cancel_requested'
               AND r.request_type = 'cancel')
           OR (order_events.event_type = 'order.address_change_requested'
               AND r.request_type = 'address_change')
           OR (order_events.event_type = 'return.requested'
               AND r.request_type = 'return')
         )
    )
  );

-- Một request chỉ sinh đúng một mốc bắt đầu. Policy chặn giả nội dung; unique index chặn retry,
-- double-click hoặc một account service bị chiếm quyền làm timeline phình nhiều bản giống nhau.
CREATE UNIQUE INDEX order_events_customer_request_once
  ON order_events (shop_id, (payload ->> 'request_id'), event_type)
  WHERE source = 'account'
    AND actor_type = 'buyer'
    AND event_type IN (
      'order.cancel_requested',
      'order.address_change_requested',
      'return.requested'
    )
    AND jsonb_typeof(payload -> 'request_id') = 'string';
