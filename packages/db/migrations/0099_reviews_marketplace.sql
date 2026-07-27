-- 0099 — ĐÁNH GIÁ KIỂU SÀN: shop TRẢ LỜI + đếm HỮU ÍCH.
--
-- product_reviews (0047) mới chỉ là hàng đợi duyệt MỘT CHIỀU: khách viết, shop duyệt, hết.
-- Trên Shopee/TikTok Shop, phần đánh giá là nơi shop CHỨNG MINH dịch vụ — trả lời một
-- đánh giá 2 sao tử tế còn thuyết phục hơn mười đánh giá 5 sao. Và nút "Hữu ích" đẩy đánh
-- giá có ích lên trên thay vì chỉ xếp theo thời gian.
--
-- KHÔNG làm ẢNH trong đánh giá ở đợt này: ảnh cần một đường TẢI LÊN cho NGƯỜI MUA, mà
-- storefront cố ý chỉ-đọc và checkout chưa có hạ tầng media (multipart + tái mã hoá +
-- hạn ngạch dung lượng theo shop + kiểm duyệt ảnh bẩn). Đó là một dự án riêng, không phải
-- một cột. Ghi rõ ở đây để lần sau khỏi tưởng là bỏ sót.

-- ── 1. Shop trả lời đánh giá ─────────────────────────────────────────────────
ALTER TABLE product_reviews ADD COLUMN seller_reply text
  CONSTRAINT product_reviews_reply_len CHECK (seller_reply IS NULL OR length(seller_reply) <= 1000);
ALTER TABLE product_reviews ADD COLUMN seller_replied_at timestamptz;

-- ── 2. Đếm "Hữu ích" ─────────────────────────────────────────────────────────
-- Số đếm để NGAY trên review (đọc O(1) khi render trang SP); bảng phiếu chỉ để CHỐNG BẤM
-- NHIỀU LẦN, không bao giờ phải đếm lại từ nó lúc hiển thị.
ALTER TABLE product_reviews ADD COLUMN helpful_count integer NOT NULL DEFAULT 0
  CONSTRAINT product_reviews_helpful_nonneg CHECK (helpful_count >= 0);

-- voter_hash = HMAC của IP (cùng cách với product_reviews.ip_hash) — KHÔNG lưu IP thô.
-- Đây là chống-lạm-dụng mức "đủ dùng": cùng IP chỉ tính 1 phiếu/đánh giá. Không chống được
-- người đổi IP, nhưng phiếu hữu ích không phải tiền — đánh đổi này là cố ý.
CREATE TABLE review_votes (
  shop_id    uuid NOT NULL,
  review_id  uuid NOT NULL,
  voter_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (review_id, voter_hash),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  -- Composite FK: phiếu không thể trỏ sang đánh giá của shop khác. Xoá đánh giá → xoá phiếu.
  FOREIGN KEY (shop_id, review_id) REFERENCES product_reviews (shop_id, id) ON DELETE CASCADE
);

ALTER TABLE review_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_votes FORCE  ROW LEVEL SECURITY;

-- Checkout (service nhận form công khai phía người mua — nơi đã nhận chính đánh giá):
-- ghi phiếu + cộng số đếm. Cộng số đếm cấp theo CỘT: checkout không được đụng
-- rating/status/content của đánh giá (sửa được là tự nâng sao cho shop mình).
GRANT SELECT, INSERT ON review_votes TO app_checkout;
CREATE POLICY checkout_votes ON review_votes FOR ALL TO app_checkout
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT UPDATE (helpful_count) ON product_reviews TO app_checkout;

-- Seller: đã có GRANT mức BẢNG trên product_reviews (0047) → 3 cột mới tự được phủ, trả
-- lời đánh giá được ngay. Cấp thêm quyền đọc phiếu cho trang quản trị (nếu sau này cần).
GRANT SELECT ON review_votes TO app_rw;
CREATE POLICY tenant_isolation ON review_votes FOR SELECT TO app_rw
  USING (shop_id = current_shop_id());

-- Storefront: đã có GRANT SELECT mức BẢNG trên product_reviews (0047) → đọc được
-- seller_reply + helpful_count ngay. KHÔNG cấp gì trên review_votes: trang chỉ hiện SỐ
-- ĐẾM, không cần biết ai đã bấm (và vai công khai vẫn chỉ-đọc).

-- Sắp "hữu ích nhất trước" trong phần đánh giá của một sản phẩm.
CREATE INDEX product_reviews_helpful_idx ON product_reviews (shop_id, product_id, helpful_count DESC)
  WHERE status = 'approved';
