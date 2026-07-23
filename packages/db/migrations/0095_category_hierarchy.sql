-- 0095 — danh mục 2 CẤP (cha–con).
--
-- categories (0008) đang PHẲNG. Thêm parent_id (tự trỏ) để có danh mục con:
--   Thịt (cha) → Thịt heo / Thịt bò / Thịt gà (con). Chỉ 2 CẤP — ràng buộc "con
--   không được có con nữa" ép ở TẦNG ỨNG DỤNG (seller catalog.js), không cần trigger:
--   chỉ cho gán cha là danh mục cấp-1 (parent_id IS NULL) + cấm gán cha cho danh mục
--   đang có con. Nhờ vậy cây tối đa 2 tầng, không thể tạo vòng dài.
--
-- FK composite (shop_id, parent_id) → cha PHẢI cùng shop (chống trỏ chéo shop, y hệt
--   product_categories 0008). ON DELETE SET NULL: xoá danh mục cha thì con nhả về cấp
--   trên (an toàn hơn CASCADE — không âm thầm mất danh mục con + sản phẩm giữ nguyên).

ALTER TABLE categories ADD COLUMN parent_id uuid;

-- Cha cùng shop + là danh mục có thật. (shop_id, id) là UNIQUE trên categories (0008).
ALTER TABLE categories
  ADD CONSTRAINT categories_parent_fk
  FOREIGN KEY (shop_id, parent_id) REFERENCES categories (shop_id, id) ON DELETE SET NULL;

-- Chống tự làm cha của chính mình (vòng 1 nút). Vòng dài hơn bất khả vì tầng ứng dụng
-- chỉ cho cha là danh mục cấp-1.
ALTER TABLE categories
  ADD CONSTRAINT categories_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id);

-- Liệt kê con theo cha nhanh (chỉ index hàng có cha — phần lớn danh mục là cấp-1).
CREATE INDEX categories_parent_idx ON categories (shop_id, parent_id) WHERE parent_id IS NOT NULL;

-- Grant: categories đã GRANT SELECT mức BẢNG cho app_store (0011) → cột parent_id tự
-- được phủ, storefront đọc được ngay. app_rw dùng policy tenant (0008) → không cần đổi.
