-- 0042 — Ảnh THEO BIẾN THỂ. media.variant_id:
--   NULL      = ảnh chung cấp sản phẩm (hiện cho MỌI biến thể) — hành vi cũ, tương thích ngược.
--   có giá trị = ảnh riêng của 1 biến thể (storefront đổi ảnh khi khách chọn biến thể đó).
-- ON DELETE SET NULL: xoá biến thể thì ảnh rớt về cấp sản phẩm (không mất ảnh).

ALTER TABLE media ADD COLUMN variant_id uuid;
ALTER TABLE media ADD CONSTRAINT media_variant_fk
  FOREIGN KEY (shop_id, variant_id) REFERENCES variants (shop_id, id) ON DELETE SET NULL;
CREATE INDEX media_variant_idx ON media (shop_id, variant_id) WHERE deleted_at IS NULL AND variant_id IS NOT NULL;
