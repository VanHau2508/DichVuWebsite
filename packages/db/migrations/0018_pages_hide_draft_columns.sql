-- 0018 — bịt cột DRAFT của pages khỏi app_store (siết bất biến "công khai không đọc được draft").
--
-- RLS lọc HÀNG, không lọc CỘT. Trang đã published → HÀNG của nó hiện với app_store (policy
-- store_pages), mà hàng đó gồm cả pages.blocks và pages.title = bản DRAFT đang sửa (có thể
-- khác bản published khi đang soạn v2). Storefront KHÔNG hề đọc hai cột này — published lấy
-- từ page_revisions, preview lấy từ page_previews — nhưng quyền cột vẫn để mở, nên một
-- truy vấn tương lai lỡ tay "SELECT blocks FROM pages" sẽ vô tình lộ draft của trang published.
--
-- Bịt bằng grant theo CỘT: app_store đọc mọi cột TRỪ blocks/title (nội dung draft). Sau migration
-- này, "app_store không đọc được draft" là đúng VỀ CẤU TRÚC, không chỉ vì code đang tránh né.
-- (Rà soát đối kháng preview lôi ra: xem docs/20 §8.)

REVOKE SELECT ON pages FROM app_store;
GRANT SELECT (id, shop_id, slug, status, published_revision_id, menu_position, created_at, updated_at, deleted_at)
  ON pages TO app_store;
