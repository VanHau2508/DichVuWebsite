-- 0029 — hồ sơ cửa hàng: thông tin liên hệ hiển thị trên storefront.
--
-- Chủ shop (shop.write = owner/admin) sửa được danh tính cửa hàng: email/điện thoại liên hệ
-- + địa chỉ kinh doanh. Hiển thị ở chân trang storefront (khách liên hệ / tin cậy).
-- Cột nullable text (không bắt buộc). app_rw đã có UPDATE table-level trên shops (cột mới tự
-- phủ); app_store đã có SELECT full trên shops (đọc được để render). Không cần đổi grant.
-- (Logo cửa hàng cần hạ tầng media cấp-shop → làm riêng sau.)

ALTER TABLE shops ADD COLUMN contact_email    text;
ALTER TABLE shops ADD COLUMN contact_phone    text;
ALTER TABLE shops ADD COLUMN business_address text;
