-- 0040 — chống ĐƠN ẢO (order griefing): kẻ xấu đặt nhiều đơn tên/SĐT khác nhau, không
-- nhận hàng → giữ tồn kho, chặn khách thật.
--   Lớp 1: worker cũng tự HUỶ đơn COD 'pending' quá lâu (trả tồn) — trước chỉ huỷ đơn QR.
--   Lớp 2: checkout GIỚI HẠN số đơn 'pending' theo nguồn (hash IP) + theo SĐT.
--   Lớp 3: CỜ "nghi ngờ" cho chủ shop (đếm đơn cùng nguồn) — seller đọc + hiện badge.
--
-- Lưu HASH sha256 của IP (KHÔNG lưu IP thô) → gom nhóm "cùng thiết bị" mà không phơi PII
-- khách. Chủ shop chỉ thấy SỐ đơn cùng nguồn, không thấy địa chỉ IP.
ALTER TABLE orders ADD COLUMN client_ip_hash text;

-- Index đếm đơn pending theo nguồn / SĐT (checkout rate-limit + cờ nghi ngờ). Partial =
-- chỉ đơn 'pending' (nhẹ, vì đơn đã xử lý không còn tính).
CREATE INDEX orders_pending_ip_idx    ON orders (shop_id, client_ip_hash) WHERE status = 'pending';
CREATE INDEX orders_pending_phone_idx ON orders (shop_id, customer_phone)  WHERE status = 'pending';

-- app_checkout: đã có SELECT/INSERT table-level trên orders (0012) → cột + đếm tự phủ.
-- app_expiry:   đã có SELECT(payment_method,created_at) + UPDATE(status) (0022) → COD sweep đủ quyền.
