-- Tra cứu nguồn hoàn hàng ở trang chi tiết đơn.
--
-- `markReturnedBomb` đã ghi nguồn thật vào audit_logs. Không được suy luận từ
-- shipments.status='returned': hãng có thể cập nhật shipment SAU thao tác admin đã
-- cộng tồn, khiến UI hướng dẫn cộng lần hai. Index partial giữ truy vấn detail theo
-- orderId rẻ khi audit log của shop lớn dần.

CREATE INDEX audit_logs_returned_bomb_order_idx
  ON audit_logs (shop_id, ((metadata->>'orderId')))
  WHERE action = 'order.returned_bomb';
