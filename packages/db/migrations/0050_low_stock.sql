-- 0050 — Cảnh báo SẮP HẾT HÀNG. Ngưỡng per-shop (NULL → mặc định 5); worker quét hằng
-- ngày → email chủ shop danh sách biến thể available <= ngưỡng.

ALTER TABLE shops ADD COLUMN low_stock_threshold int CHECK (low_stock_threshold IS NULL OR (low_stock_threshold >= 0 AND low_stock_threshold <= 10000));

-- Worker (app_expiry) cần đọc: shop (email nhận + ngưỡng), variants + products (tên hiển thị).
-- Policy cross-shop CHỈ SELECT (mẫu 0022); quyền cột hẹp.
GRANT SELECT (id, name, status, contact_email, low_stock_threshold) ON shops TO app_expiry;
CREATE POLICY expiry_shops ON shops FOR SELECT TO app_expiry USING (true);

GRANT SELECT (id, shop_id, product_id, title, sku) ON variants TO app_expiry;
CREATE POLICY expiry_variants ON variants FOR SELECT TO app_expiry USING (true);

GRANT SELECT (id, shop_id, title, status, deleted_at) ON products TO app_expiry;
CREATE POLICY expiry_products ON products FOR SELECT TO app_expiry USING (true);

-- 0022 chỉ cấp (shop_id, variant_id, reserved) — tính available cần thêm on_hand.
GRANT SELECT (on_hand) ON inventory_levels TO app_expiry;
