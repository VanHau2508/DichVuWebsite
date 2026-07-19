-- 0092 — HIỆN MÃ VẬN ĐƠN cho KHÁCH (tra cứu guest + tài khoản). Audit sẵn-sàng bắt: web không
-- hiển thị mã vận đơn/hãng ở đâu → khách (nhất là không-email) không tự tra GHN/GHTK được.
--
-- shipments (0015) trước CHỈ app_rw (seller) đọc được. Cấp SELECT THEO CỘT (loại carrier_fee_vnd —
-- giá vốn ship của shop, KHÔNG cho khách) cho:
--   • app_checkout — trang tra cứu guest (/checkout/success), đã chứng minh sở hữu đơn bằng token.
--   • app_customer — trang chi tiết đơn trong tài khoản khách.
-- Policy shop-scoped: service luôn lọc thêm theo order_id CỦA đơn khách (đơn đã RLS-verify), nên
-- không rò vận đơn đơn khác (mẫu checkout_customers 0083).

GRANT SELECT (id, shop_id, order_id, carrier, tracking_number, status, created_at) ON shipments TO app_checkout;
GRANT SELECT (id, shop_id, order_id, carrier, tracking_number, status, created_at) ON shipments TO app_customer;

CREATE POLICY checkout_ship_read ON shipments FOR SELECT TO app_checkout USING (shop_id = current_shop_id());
CREATE POLICY customer_ship_read ON shipments FOR SELECT TO app_customer USING (shop_id = current_shop_id());
