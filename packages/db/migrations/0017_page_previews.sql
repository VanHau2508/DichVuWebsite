-- 0017 — xem trước (preview) BẢN NHÁP trên storefront: snapshot draft + token ngắn hạn.
--
-- Vấn đề: storefront (app_store) BỊ CẤM VỀ CẤU TRÚC đọc pages.blocks (draft) — policy
-- store_pages ở 0016 chỉ cho published. Đó là bất biến bảo mật, KHÔNG được nới.
--
-- Cách làm: seller (app_rw, đã xác thực + content.read) CHỤP ẢNH draft hiện tại vào
-- page_previews rồi trả một token ngẫu nhiên (lưu HASH, TTL ngắn). Storefront đọc
-- SNAPSHOT qua token — KHÔNG bao giờ đọc pages.blocks. Nhờ vậy:
--   • draft vẫn vô hình về cấu trúc với công khai (app_store không hề thấy pages.blocks);
--   • chỉ nội dung seller CHỦ ĐỘNG cho preview, và chỉ khi có token, mới lộ;
--   • cô lập tenant vẫn do RLS lo (shop_id = current_shop_id() theo domain).
-- Đánh đổi: snapshot đóng băng lúc bấm preview; sửa draft xong bấm lại để làm mới.
--
-- Mỗi trang tối đa MỘT preview (PK theo (shop_id,page_id) → upsert). Xoá trang →
-- CASCADE dọn preview.

CREATE TABLE page_previews (
  shop_id     uuid NOT NULL,
  page_id     uuid NOT NULL,
  token_hash  text NOT NULL,                 -- sha256(token trong URL); không lưu token thô
  slug        text NOT NULL,                 -- ràng token với slug của trang lúc chụp
  title       text NOT NULL,                 -- snapshot draft
  blocks      jsonb NOT NULL,                -- snapshot draft
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (shop_id, page_id),
  UNIQUE (token_hash),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, page_id) REFERENCES pages (shop_id, id) ON DELETE CASCADE
);

-- ── RLS: app_rw (seller chụp/thay preview của shop mình) ──────────────────────
ALTER TABLE page_previews ENABLE ROW LEVEL SECURITY; ALTER TABLE page_previews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON page_previews FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- ── app_store (storefront công khai): CHỈ ĐỌC preview CHƯA hết hạn của shop hiện tại ─
-- Hết hạn cưỡng chế Ở RLS (không chỉ ở query) → dù code storefront quên lọc, DB vẫn
-- giấu preview quá hạn. Cô lập tenant cũng ở RLS: token shop A vô hình ở tenant shop B.
GRANT SELECT ON page_previews TO app_store;
CREATE POLICY store_preview ON page_previews FOR SELECT TO app_store
  USING (shop_id = current_shop_id() AND expires_at > now());
