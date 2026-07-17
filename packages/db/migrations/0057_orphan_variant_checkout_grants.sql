-- 0057 — Chặn BIẾN THỂ MỒ CÔI ở checkout (đường tiền).
--
-- Khi shop thu hẹp phân loại, saveProductOptions (apps/seller/src/catalog.js) DELETE toàn bộ
-- product_options rồi map lại; biến thể của tổ hợp không còn tồn tại mất hết
-- variant_option_values (cascade) nhưng VẪN active + còn giá/tồn cũ ("mồ côi").
-- Storefront (app_store) đã có quyền đọc các bảng option từ 0041 → lọc được ở tầng query.
-- Checkout (app_checkout) CHƯA có grant/policy trên hai bảng này: chỉ grant mà thiếu policy
-- thì RLS FORCE default-deny → subquery đếm ra 0 → predicate lọt HẾT (no-op âm thầm);
-- thiếu cả grant thì query lỗi 'permission denied'. Nên phải cấp CẢ HAI (gương store_* 0041).
-- option_values KHÔNG cần (predicate chỉ đếm theo option_id).
-- RLS đã ENABLE+FORCE từ 0041 (không bật lại).

GRANT SELECT ON product_options, variant_option_values TO app_checkout;

-- EXISTS chạy dưới policy checkout_products (active-only, 0012) → option của SP nháp vô hình.
CREATE POLICY checkout_product_options ON product_options FOR SELECT TO app_checkout
  USING (shop_id = current_shop_id()
         AND EXISTS (SELECT 1 FROM products p WHERE p.id = product_options.product_id));

-- EXISTS chạy dưới policy checkout_variants (0012) → mapping của biến thể ẩn vô hình.
CREATE POLICY checkout_vov ON variant_option_values FOR SELECT TO app_checkout
  USING (shop_id = current_shop_id()
         AND EXISTS (SELECT 1 FROM variants v WHERE v.id = variant_option_values.variant_id));
