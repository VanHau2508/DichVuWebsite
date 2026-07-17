-- 0071 — Ảnh bìa bài blog (đợt 5.2 #25). cover_image_key = key media PUBLIC của shop
-- (định dạng "<shop_id>/<media_id>.webp" — ảnh đã upload qua luồng media sản phẩm/logo,
-- re-encode WebP; storefront dựng URL /media-public/<key>). Seller validate định dạng
-- + tiền tố shop_id (không trỏ chéo shop); NULL = không có ảnh bìa.
--
-- GRANTS: KHÔNG cần gì mới (đối chiếu 0034_blog.sql):
--   app_rw    — 0034:26 GRANT SELECT, INSERT, UPDATE, DELETE table-level → cột mới tự phủ.
--   app_store — 0034:31 GRANT SELECT table-level → tự phủ (storefront đọc để render).
-- RLS giữ nguyên (tenant_isolation + store_blog lọc published).

ALTER TABLE blog_posts ADD COLUMN cover_image_key text;
