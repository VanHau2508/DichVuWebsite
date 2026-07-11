-- 0019 — SEO meta theo trang: seo_title + seo_description (versioned theo draft/publish).
--
-- SEO là NỘI DUNG → phải theo đúng mô hình draft → publish → revision → rollback như blocks:
-- sửa ở pages (draft), CHỤP vào page_revisions khi publish, chụp vào page_previews khi
-- preview, rollback tự khôi phục (vì trỏ lại revision cũ). KHÔNG để SEO ngoài revision —
-- nếu để trên pages và storefront đọc thẳng, sửa draft sẽ đổi luôn SEO của bản đang chạy,
-- vỡ bất biến "chưa publish thì chưa live".
--
-- Quyền: page_revisions/page_previews có GRANT SELECT mức BẢNG cho app_store (0016/0017) →
-- cột mới tự được phủ. Trên pages, app_store dùng grant theo CỘT (0018) KHÔNG liệt kê hai
-- cột này → SEO của bản DRAFT vẫn kín với công khai (đúng như blocks/title).

ALTER TABLE pages          ADD COLUMN seo_title text, ADD COLUMN seo_description text;
ALTER TABLE page_revisions ADD COLUMN seo_title text, ADD COLUMN seo_description text;
ALTER TABLE page_previews  ADD COLUMN seo_title text, ADD COLUMN seo_description text;
