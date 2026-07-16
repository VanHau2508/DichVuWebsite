-- 0043 — Thông số kỹ thuật sản phẩm (bảng name/value hiển thị trên trang SP kiểu Shopee).
-- Ví dụ: "Chất liệu"="Polyester", "Kích thước"="1m6 x 2m3", "Xuất xứ"="Việt Nam".

CREATE TABLE product_specs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    uuid NOT NULL REFERENCES shops (id),
  product_id uuid NOT NULL,
  name       text NOT NULL,
  value      text NOT NULL,
  position   int  NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, product_id) REFERENCES products (shop_id, id) ON DELETE CASCADE
);
CREATE INDEX product_specs_product_idx ON product_specs (shop_id, product_id);

ALTER TABLE product_specs ENABLE ROW LEVEL SECURITY; ALTER TABLE product_specs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON product_specs FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON product_specs TO app_rw;

GRANT SELECT ON product_specs TO app_store;
CREATE POLICY store_product_specs ON product_specs FOR SELECT TO app_store
  USING (shop_id = current_shop_id() AND EXISTS (SELECT 1 FROM products p WHERE p.id = product_specs.product_id));
