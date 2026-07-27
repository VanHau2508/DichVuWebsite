-- 0101 — ẢNH TRONG ĐÁNH GIÁ.
--
-- Trên Shopee/TikTok Shop, ảnh thật của người mua là tín hiệu tin cậy mạnh nhất của phần
-- đánh giá — mạnh hơn cả số sao. Nhưng đây là lần ĐẦU nền tảng nhận tệp từ NGƯỜI LẠ
-- (không đăng nhập), nên rủi ro khác hẳn ảnh sản phẩm (do chính chủ shop tải lên).
--
-- ── VÌ SAO ẢNH NẰM Ở BUCKET RIÊNG TƯ CHO TỚI KHI DUYỆT ───────────────────────
-- Nếu đẩy thẳng lên bucket PUBLIC lúc nhận: kẻ xấu gửi đánh giá kèm ảnh khiêu dâm/vi phạm.
-- Đánh giá ở trạng thái chờ nên KHÔNG hiện trên trang — nhưng URL ảnh thì SỐNG trên tên
-- miền của shop, và kẻ đó chỉ việc phát tán URL. Cửa hàng của khách hàng ta bỗng thành nơi
-- lưu trữ ảnh bẩn, kèm rủi ro pháp lý. Không có cách nào gỡ trước vì không ai kịp nhìn.
--
-- Nên: nhận → re-encode → cất vào bucket PRIVATE. Chủ shop XEM được khi duyệt (qua endpoint
-- stream có xác thực). CHỈ khi duyệt đánh giá, ảnh mới được sao sang bucket PUBLIC. Ảnh của
-- đánh giá bị từ chối không bao giờ có URL công khai.
--
-- Vẫn re-encode sang WebP ngay lúc nhận (không đợi duyệt): sharp giải mã + mã hoá lại sẽ
-- biến "ảnh có payload nhúng" thành ảnh sạch, và tệp không-phải-ảnh sẽ hỏng ngay tại chỗ
-- thay vì nằm chờ trong kho.

CREATE TABLE review_images (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL REFERENCES shops (id),
  review_id    uuid NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  original_key text NOT NULL,          -- key trong bucket PRIVATE (bản WebP đã làm sạch)
  public_key   text,                   -- key trong bucket PUBLIC — CHỈ có khi đánh giá được duyệt
  content_type text,                   -- kiểu THẬT phát hiện từ magic byte của tệp gốc
  width        int,
  height       int,
  size_bytes   int,
  position     int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  UNIQUE (shop_id, id),
  -- Composite FK: ảnh không thể trỏ sang đánh giá của shop khác. Xoá đánh giá → xoá ảnh.
  FOREIGN KEY (shop_id, review_id) REFERENCES product_reviews (shop_id, id) ON DELETE CASCADE
);
CREATE INDEX review_images_review_idx ON review_images (shop_id, review_id) WHERE deleted_at IS NULL;
-- Worker dọn rác: ảnh của đánh giá bị từ chối, hoặc treo ở 'pending' quá lâu.
CREATE INDEX review_images_gc_idx ON review_images (status, created_at) WHERE deleted_at IS NULL;

ALTER TABLE review_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_images FORCE  ROW LEVEL SECURITY;

-- Checkout (nhận tệp từ người lạ): CHỈ ghi ảnh mới + đọc để đếm trần mỗi đánh giá.
-- KHÔNG UPDATE → không thể tự đặt public_key cho ảnh của mình (tự thăng lên công khai).
GRANT SELECT, INSERT ON review_images TO app_checkout;
CREATE POLICY checkout_review_images ON review_images FOR ALL TO app_checkout
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- Seller: xem khi duyệt, THĂNG lên public khi duyệt, đánh dấu xoá khi từ chối.
GRANT SELECT, UPDATE, DELETE ON review_images TO app_rw;
CREATE POLICY tenant_isolation ON review_images FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- Storefront: CHỈ ảnh ĐÃ SẴN SÀNG (đã sao sang public) của đánh giá ĐÃ DUYỆT. Hai điều kiện
-- độc lập — kể cả nếu một ngày nào đó có ảnh 'ready' dính vào đánh giá bị gỡ duyệt, nó vẫn
-- không lộ ra ngoài.
GRANT SELECT ON review_images TO app_store;
CREATE POLICY store_review_images ON review_images FOR SELECT TO app_store
  USING (shop_id = current_shop_id() AND status = 'ready' AND deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM product_reviews r
                      WHERE r.id = review_images.review_id AND r.status = 'approved'));

-- Worker (dọn object rác trong MinIO sau khi xoá mềm).
GRANT SELECT (id, shop_id, review_id, status, original_key, public_key, created_at, deleted_at) ON review_images TO app_expiry;
GRANT UPDATE (deleted_at) ON review_images TO app_expiry;
CREATE POLICY expiry_review_images ON review_images FOR ALL TO app_expiry
  USING (true) WITH CHECK (true);
