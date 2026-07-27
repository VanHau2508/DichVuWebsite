-- 0096 — TÍN HIỆU SÀN TMĐT trên sản phẩm: "Đã bán N" + sao đánh giá (cache trên products).
--
-- Bối cảnh: thẻ sản phẩm hiện chỉ có ảnh/tên/giá. Shopee & TikTok Shop luôn kèm 3 tín hiệu
--   mua-hàng: SỐ ĐÃ BÁN, ĐIỂM SAO, SỐ ĐÁNH GIÁ. Đó là thứ khiến khách tin và bấm vào.
--
-- VÌ SAO CACHE CỘT, KHÔNG TÍNH LIVE: query lưới đã có 6 subquery/hàng. Cộng thêm
--   sum(order_lines.qty) + avg(product_reviews) mỗi thẻ nữa thì 10-24 thẻ/trang × N shop
--   sẽ chết ở quy mô SaaS (đích 100-1000 shop). Cache cột → đọc O(1), sort "bán chạy" có
--   index dùng được. Đổi lại là NHẤT QUÁN CUỐI CÙNG: worker tính lại định kỳ (0096 backfill
--   một lần). Đúng cách các sàn thật làm — badge "đã bán" không cần realtime.
--
-- KHÔNG đụng đường tiền: 3 cột này CHỈ để hiển thị, không tham gia tính tiền/tồn kho.
--   Sai số tạm thời (tối đa 1 chu kỳ sweep) không gây thiệt hại tài chính.

-- ── Cột cache ────────────────────────────────────────────────────────────────
-- sold_count: TỔNG số lượng đã bán trọn đời, tính từ đơn ĐÃ TRẢ TIỀN và KHÔNG huỷ/trả.
ALTER TABLE products ADD COLUMN sold_count integer NOT NULL DEFAULT 0
  CONSTRAINT products_sold_count_nonneg CHECK (sold_count >= 0);

-- rating_avg: NULL = chưa có đánh giá nào (khác 0 sao — thẻ phải ẩn dòng sao, không hiện 0★).
ALTER TABLE products ADD COLUMN rating_avg numeric(3,2)
  CONSTRAINT products_rating_avg_range CHECK (rating_avg IS NULL OR (rating_avg >= 1 AND rating_avg <= 5));

ALTER TABLE products ADD COLUMN rating_count integer NOT NULL DEFAULT 0
  CONSTRAINT products_rating_count_nonneg CHECK (rating_count >= 0);

-- ── Backfill một lần ─────────────────────────────────────────────────────────
-- Đã bán = sum(qty) qua variants → order_lines → orders ĐÃ TRẢ (paid_at IS NOT NULL,
-- ngữ nghĩa "ever-paid" y như reports.js) và status không phải cancelled/returned.
UPDATE products p SET sold_count = sub.qty
  FROM (
    SELECT v.product_id, sum(ol.qty)::int AS qty
      FROM order_lines ol
      JOIN variants v ON v.id = ol.variant_id
      JOIN orders o   ON o.id = ol.order_id
     WHERE o.paid_at IS NOT NULL AND o.status NOT IN ('cancelled', 'returned')
     GROUP BY v.product_id
  ) sub
 WHERE sub.product_id = p.id AND p.sold_count IS DISTINCT FROM sub.qty;

-- Sao = chỉ đánh giá ĐÃ DUYỆT (approved) — đúng thứ storefront đang hiển thị.
UPDATE products p SET rating_avg = sub.avg_r, rating_count = sub.n
  FROM (
    SELECT r.product_id, round(avg(r.rating)::numeric, 2) AS avg_r, count(*)::int AS n
      FROM product_reviews r
     WHERE r.status = 'approved'
     GROUP BY r.product_id
  ) sub
 WHERE sub.product_id = p.id;

-- ── Index sort "Bán chạy" ────────────────────────────────────────────────────
-- Lưới storefront luôn lọc shop + còn sống + active rồi mới ORDER BY. Index một phần
-- (chỉ SP đang bán) giữ index nhỏ dù shop có nhiều bản nháp/lưu trữ.
CREATE INDEX products_sold_idx ON products (shop_id, sold_count DESC)
  WHERE deleted_at IS NULL AND status = 'active';

-- ── Quyền ────────────────────────────────────────────────────────────────────
-- app_store / app_checkout: đã GRANT SELECT mức BẢNG trên products (0011, 0012)
--   → 3 cột mới tự được phủ, storefront đọc ngay, KHÔNG cần grant thêm.
--
-- app_expiry (role worker, 0022): đang có GRANT SELECT theo CỘT trên products (0050) nên
--   cột mới KHÔNG tự có. Mở đúng mức tối thiểu để sweep tính lại được:
GRANT SELECT (id, shop_id, sold_count, rating_avg, rating_count) ON products TO app_expiry;
GRANT UPDATE (sold_count, rating_avg, rating_count)              ON products TO app_expiry;

-- Nguồn dữ liệu để tính:
--   orders      — 0022 cấp SELECT theo cột nhưng THIẾU paid_at → mở thêm.
--   order_lines — 0022 đã cấp (order_id, variant_id, qty) → ĐỦ, không cần thêm.
--   variants    — 0050 đã cấp (id, shop_id, product_id, …) + policy expiry_variants → ĐỦ.
GRANT SELECT (paid_at) ON orders TO app_expiry;
GRANT SELECT (product_id, rating, status) ON product_reviews TO app_expiry;

-- products đang RLS; app_expiry chạy cross-shop (job nền) nên policy USING(true), y hệt
-- expiry_orders/expiry_levels (0022). 0050 đã có expiry_products nhưng CHỈ FOR SELECT
-- → phải thêm policy riêng cho UPDATE thì sweep mới ghi được.
CREATE POLICY expiry_products_upd ON products FOR UPDATE TO app_expiry
  USING (true) WITH CHECK (true);

-- product_reviews đang ENABLE RLS (0047) → cần policy cho app_expiry đọc.
CREATE POLICY expiry_reviews ON product_reviews FOR SELECT TO app_expiry USING (true);
