-- 0152 — tham chiếu định danh từ sàn ngoài cho import và upsert.
--
-- Tên sản phẩm/slug không phải khoá ổn định: người bán có thể đổi chúng bất cứ lúc nào.
-- Bảng riêng giữ product_id/sku_id của nguồn, đồng thời giữ raw_row để sửa mapper mà không
-- biến dữ liệu bên thứ ba thành cột vận hành trên products.
CREATE TABLE product_source_refs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       uuid NOT NULL REFERENCES shops(id),
  source        text NOT NULL CHECK (source IN ('tiktok','shopify','haravan','sapo','shopee')),
  kind          text NOT NULL CHECK (kind IN ('product','variant','category')),
  external_id   text NOT NULL,
  product_id    uuid,
  variant_id    uuid,
  raw_row       jsonb,
  imported_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, source, kind, external_id),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, product_id) REFERENCES products (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, variant_id) REFERENCES variants (shop_id, id) ON DELETE CASCADE
);

ALTER TABLE product_source_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_source_refs FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_source_refs TO app_rw;
CREATE POLICY tenant_isolation ON product_source_refs FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

REVOKE ALL ON product_source_refs FROM app_store, app_checkout, app_customer;
CREATE INDEX product_source_refs_product_idx ON product_source_refs (shop_id, product_id)
  WHERE product_id IS NOT NULL;
CREATE INDEX product_source_refs_variant_idx ON product_source_refs (shop_id, variant_id)
  WHERE variant_id IS NOT NULL;
