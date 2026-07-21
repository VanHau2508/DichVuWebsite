-- 0093 — ĐỒNG BỘ GIÁ "TỪ" của sản phẩm (products.price_vnd = min giá biến thể). Bug thật
-- chủ shop báo: thẻ lưới/sort/lọc storefront đọc products.price_vnd nhưng luồng SỬA GIÁ
-- BIẾN THỂ (PATCH variant, sinh ma trận…) không ghi ngược → thẻ hiện giá cũ (vd 99đ) trong
-- khi biến thể đã 1.850.000đ. Checkout KHÔNG ảnh hưởng (luôn tính trên variants.price_vnd).
--
-- Backfill MỘT LẦN dữ liệu đang lệch; từ nay apps/seller/src/catalog.js đồng bộ lại
-- products.price_vnd trong CÙNG transaction ở mọi điểm ghi làm đổi giá/tập biến thể.
-- LOẠI biến thể MỒ CÔI (thiếu ánh xạ variant_option_values cho một trục — storefront ẩn,
-- không bán được): giá cũ của tổ hợp bỏ đi không được kéo giá "từ" xuống sai.

UPDATE products p SET price_vnd = sub.min_price
FROM (
  SELECT v.product_id, min(v.price_vnd) AS min_price FROM variants v
   WHERE NOT EXISTS (SELECT 1 FROM product_options po WHERE po.product_id = v.product_id
       AND NOT EXISTS (SELECT 1 FROM variant_option_values vov
                        WHERE vov.variant_id = v.id AND vov.option_id = po.id))
   GROUP BY v.product_id
) sub
WHERE sub.product_id = p.id AND p.price_vnd IS DISTINCT FROM sub.min_price;
