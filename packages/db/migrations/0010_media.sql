-- 0010 — media (ảnh sản phẩm).
--
-- Luồng: upload → kiểm magic byte + kích thước → lưu bản gốc vào bucket PRIVATE
-- (status=pending) → re-encode sang WebP → lưu vào bucket PUBLIC (status=ready).
-- File CHƯA qua re-encode KHÔNG BAO GIỜ public.

CREATE TABLE media (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL REFERENCES shops (id),
  product_id   uuid NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','failed')),
  original_key text NOT NULL,               -- key trong bucket private
  public_key   text,                        -- key trong bucket public (khi ready)
  content_type text,                        -- kiểu THẬT phát hiện từ magic byte
  width        int,
  height       int,
  size_bytes   int,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,

  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, product_id) REFERENCES products (shop_id, id) ON DELETE CASCADE
);
CREATE INDEX media_product_idx ON media (shop_id, product_id) WHERE deleted_at IS NULL;

ALTER TABLE media ENABLE ROW LEVEL SECURITY;
ALTER TABLE media FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON media FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
