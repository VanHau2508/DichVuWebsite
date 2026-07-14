-- 0031 — logo cửa hàng (media cấp-shop, hiển thị ở header storefront).
--
-- shops.logo_key trỏ tới object WebP trong bucket PUBLIC (đã re-encode + kiểm magic byte,
-- giống ảnh sản phẩm). NULL = chưa có logo → header hiện tên shop. app_store SELECT full
-- trên shops (0011) đọc được; app_rw UPDATE table-level tự phủ cột mới. Không cần đổi grant.

ALTER TABLE shops ADD COLUMN logo_key text;
