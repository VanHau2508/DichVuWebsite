-- 0041 — Biến thể ĐA TRỤC (product options / values). Cho phép 1 sản phẩm có nhiều TRỤC
-- (Màu, Size, Chất liệu...), mỗi trục nhiều GIÁ TRỊ; mỗi biến thể = 1 TỔ HỢP giá trị (n:n).
--
-- variants VẪN là nguồn sự thật của giá/tồn/sku (checkout KHÔNG đổi — chỉ cần variant_id
-- cuối). options chỉ là lớp metadata phía trên để render lựa chọn + resolve tổ hợp →
-- variant_id. Sản phẩm KHÔNG có option = sản phẩm phẳng (storefront fallback như cũ).

CREATE TABLE product_options (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    uuid NOT NULL REFERENCES shops (id),
  product_id uuid NOT NULL,
  name       text NOT NULL,                 -- "Màu", "Size"
  position   int  NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, product_id) REFERENCES products (shop_id, id) ON DELETE CASCADE
);
CREATE INDEX product_options_product_idx ON product_options (shop_id, product_id);

CREATE TABLE option_values (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    uuid NOT NULL REFERENCES shops (id),
  option_id  uuid NOT NULL,
  value      text NOT NULL,                 -- "Đỏ", "M"
  position   int  NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, option_id) REFERENCES product_options (shop_id, id) ON DELETE CASCADE
);
CREATE INDEX option_values_option_idx ON option_values (shop_id, option_id);

-- Mỗi biến thể ánh xạ tới ĐÚNG 1 giá trị / trục (PK chặn trùng trục trên cùng biến thể).
CREATE TABLE variant_option_values (
  shop_id         uuid NOT NULL,
  variant_id      uuid NOT NULL,
  option_id       uuid NOT NULL,
  option_value_id uuid NOT NULL,
  PRIMARY KEY (shop_id, variant_id, option_id),
  FOREIGN KEY (shop_id, variant_id)      REFERENCES variants (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, option_id)       REFERENCES product_options (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, option_value_id) REFERENCES option_values (shop_id, id) ON DELETE CASCADE
);
CREATE INDEX vov_variant_idx ON variant_option_values (shop_id, variant_id);
CREATE INDEX vov_value_idx   ON variant_option_values (shop_id, option_value_id);

-- RLS FORCE + cô lập tenant cho seller (app_rw).
ALTER TABLE product_options       ENABLE ROW LEVEL SECURITY; ALTER TABLE product_options       FORCE ROW LEVEL SECURITY;
ALTER TABLE option_values         ENABLE ROW LEVEL SECURITY; ALTER TABLE option_values         FORCE ROW LEVEL SECURITY;
ALTER TABLE variant_option_values ENABLE ROW LEVEL SECURITY; ALTER TABLE variant_option_values FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON product_options       FOR ALL TO app_rw USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY tenant_isolation ON option_values         FOR ALL TO app_rw USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY tenant_isolation ON variant_option_values FOR ALL TO app_rw USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON product_options, option_values, variant_option_values TO app_rw;

-- Storefront (app_store, chỉ đọc): thấy option/value/mapping của sản phẩm ĐANG BÁN.
-- EXISTS chạy dưới chính policy store_* của products/variants → draft vô hình về cấu trúc.
GRANT SELECT ON product_options, option_values, variant_option_values TO app_store;
CREATE POLICY store_product_options ON product_options FOR SELECT TO app_store
  USING (shop_id = current_shop_id() AND EXISTS (SELECT 1 FROM products p WHERE p.id = product_options.product_id));
CREATE POLICY store_option_values ON option_values FOR SELECT TO app_store
  USING (shop_id = current_shop_id() AND EXISTS (SELECT 1 FROM product_options o WHERE o.id = option_values.option_id));
CREATE POLICY store_vov ON variant_option_values FOR SELECT TO app_store
  USING (shop_id = current_shop_id() AND EXISTS (SELECT 1 FROM variants v WHERE v.id = variant_option_values.variant_id));
