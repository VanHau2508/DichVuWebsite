-- 0115: thêm ngành 'general' (Khác / Đa ngành).
--
-- Vì sao: shop không chọn ngành thì trước đây KHÔNG có dòng themes, storefront
-- rơi về DEFAULT_LAYOUT 5 khối (thiếu hero_side/promo_banners/flash_sale/
-- category_bar) — tức cả một nhóm shop nhận bố cục cũ, và banner mặc định
-- (0114) không với tới được vì không có gì để ghi vào.
--
-- 'general' vừa là lựa chọn "Khác" trên form, vừa là preset RƠI-VỀ. Nhưng chỉ
-- ghi vào shops.industry khi người ta CHỌN nó — bỏ trống vẫn để NULL. Cột này
-- ghi "họ nói gì", không phải "ta đoán gì"; đoán rồi lưu là bịa dữ liệu.
--
-- CHECK chứ không enum: đúng lối repo (0094) — thêm ngành sau chỉ là một ALTER,
-- không phải ALTER TYPE khoá bảng.
ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_industry_check;
ALTER TABLE shops ADD CONSTRAINT shops_industry_check
  CHECK (industry IS NULL OR industry = ANY (ARRAY['fashion','food','furniture','cosmetics','general']));

ALTER TABLE shop_signups DROP CONSTRAINT IF EXISTS shop_signups_industry_check;
ALTER TABLE shop_signups ADD CONSTRAINT shop_signups_industry_check
  CHECK (industry IS NULL OR industry = ANY (ARRAY['fashion','food','furniture','cosmetics','general']));
