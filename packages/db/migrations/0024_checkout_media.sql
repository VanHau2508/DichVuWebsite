-- 0024 — checkout đọc ảnh sản phẩm (thumbnail trong giỏ).
--
-- app_checkout là role tối thiểu (ghi đơn). Cho đọc THÊM media để hiện ảnh trong giỏ,
-- nhưng CHỈ ảnh đã re-encode xong (ready) + tenant-scoped — y hệt store_media của
-- storefront. Bản pending/failed và ảnh shop khác vẫn vô hình.

GRANT SELECT ON media TO app_checkout;

CREATE POLICY checkout_media ON media FOR SELECT TO app_checkout
  USING (shop_id = current_shop_id() AND status = 'ready' AND deleted_at IS NULL);
