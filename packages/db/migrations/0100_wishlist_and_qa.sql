-- 0100 — YÊU THÍCH (wishlist) + HỎI ĐÁP sản phẩm.
--
-- Hai thứ cuối trong nhóm "cần bảng mới". Cả hai đều là hành vi của NGƯỜI MUA, mà storefront
-- cố ý chỉ-đọc → mỗi cái đi qua service ghi phù hợp:
--   Yêu thích  → apps/account  (cần BIẾT LÀ AI ⇒ phải có phiên khách hàng)
--   Hỏi đáp    → apps/checkout (KHÔNG cần đăng nhập, y như gửi đánh giá)

-- ── 1. Yêu thích ─────────────────────────────────────────────────────────────
-- Gắn với TÀI KHOẢN KHÁCH (0083), không phải cookie: yêu thích mà mất khi đổi máy thì
-- vô nghĩa. Chưa đăng nhập → account đẩy sang trang đăng nhập rồi quay lại.
CREATE TABLE wishlist_items (
  shop_id     uuid NOT NULL,
  customer_id uuid NOT NULL,
  product_id  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Một khách chỉ thích một SP MỘT lần; bấm lại là BỎ thích (toggle), không tạo dòng thứ hai.
  PRIMARY KEY (customer_id, product_id),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, customer_id) REFERENCES customers (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, product_id)  REFERENCES products  (shop_id, id) ON DELETE CASCADE
);
-- Liệt kê "SP tôi đã thích", mới nhất trước.
CREATE INDEX wishlist_items_customer_idx ON wishlist_items (shop_id, customer_id, created_at DESC);

ALTER TABLE wishlist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE wishlist_items FORCE  ROW LEVEL SECURITY;

-- app_customer (apps/account): CHỈ thấy/sửa yêu thích CỦA CHÍNH MÌNH. current_customer_id()
-- là GUC do account đặt sau khi xác thực phiên — cùng cơ chế với customer_addresses (0083).
GRANT SELECT, INSERT, DELETE ON wishlist_items TO app_customer;
CREATE POLICY customer_self ON wishlist_items FOR ALL TO app_customer
  USING (shop_id = current_shop_id() AND customer_id = current_customer_id())
  WITH CHECK (shop_id = current_shop_id() AND customer_id = current_customer_id());

-- app_customer cần ĐỌC sản phẩm để (a) chặn thích SP không tồn tại/đã ẩn và (b) hiện tên,
-- giá, ảnh trong trang Yêu thích. Trước 0100 nó KHÔNG có quyền nào trên products/media.
-- Cấp THEO CỘT + policy giống store_products: chỉ SP ĐANG BÁN của CHÍNH shop đó. Không có
-- INSERT/UPDATE — dịch vụ tài khoản khách không được sửa catalog.
GRANT SELECT (id, shop_id, slug, title, price_vnd, status, deleted_at) ON products TO app_customer;
CREATE POLICY customer_products ON products FOR SELECT TO app_customer
  USING (shop_id = current_shop_id() AND status = 'active' AND deleted_at IS NULL);
GRANT SELECT (shop_id, product_id, public_key, status, position, created_at, deleted_at) ON media TO app_customer;
CREATE POLICY customer_media ON media FOR SELECT TO app_customer
  USING (shop_id = current_shop_id());

-- app_rw (seller): CHỈ ĐỌC, và chỉ để ĐẾM "bao nhiêu khách đã thích SP này" — tín hiệu
-- thật cho chủ shop (nhiều người thích mà không mua ⇒ giá cao? hết size?).
-- KHÔNG cấp INSERT/DELETE: thêm/bớt yêu thích HỘ khách là bịa ý định của khách, và con số
-- đếm sẽ mất hết ý nghĩa. Chặt hơn customer_addresses (0083 cho app_rw FOR ALL) một cách
-- CÓ CHỦ Ý — địa chỉ giao hàng thì shop cần sửa hộ khi khách gọi điện, yêu thích thì không.
GRANT SELECT ON wishlist_items TO app_rw;
CREATE POLICY tenant_isolation ON wishlist_items FOR SELECT TO app_rw
  USING (shop_id = current_shop_id());

-- CỐ Ý KHÔNG cấp cho app_store: storefront không có phiên khách (và theo test
-- customer-accounts.test.js nó KHÔNG được có quyền nào trên bảng khách) → nó không thể
-- biết trái tim nên đầy hay rỗng. Trang SP hiện nút trung tính, phản hồi "đã lưu" đến từ
-- account sau khi chuyển hướng về. Đánh đổi có ý thức, ghi rõ để lần sau khỏi tưởng sót.

-- ── 2. Hỏi đáp sản phẩm ──────────────────────────────────────────────────────
-- Mô hình y hệt đánh giá (0047): khách gửi → CHỜ DUYỆT → shop trả lời + duyệt → hiện công
-- khai. Câu hỏi chưa duyệt không bao giờ lộ (tránh biến phần hỏi đáp thành bảng tin spam).
CREATE TABLE product_questions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops (id),
  product_id  uuid NOT NULL,
  asker_name  text NOT NULL CHECK (length(asker_name) BETWEEN 1 AND 80),
  question    text NOT NULL CHECK (length(question) BETWEEN 10 AND 500),
  answer      text CHECK (answer IS NULL OR length(answer) <= 1000),
  answered_at timestamptz,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  ip_hash     text,                       -- HMAC IP (không lưu IP thô) — chặn spam theo ngày
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, product_id) REFERENCES products (shop_id, id) ON DELETE CASCADE
);
CREATE INDEX product_questions_product_idx ON product_questions (shop_id, product_id, status);
CREATE INDEX product_questions_ip_idx ON product_questions (shop_id, ip_hash, created_at);

ALTER TABLE product_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_questions FORCE  ROW LEVEL SECURITY;

-- Seller: duyệt + trả lời trong shop mình.
GRANT SELECT, INSERT, UPDATE, DELETE ON product_questions TO app_rw;
CREATE POLICY tenant_isolation ON product_questions FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- Checkout (nhận form công khai): CHỈ ghi câu hỏi mới + đọc để đếm chống spam. KHÔNG có
-- UPDATE → không thể tự duyệt câu hỏi của mình hay sửa câu trả lời của shop.
GRANT SELECT, INSERT ON product_questions TO app_checkout;
CREATE POLICY checkout_questions ON product_questions FOR ALL TO app_checkout
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- Storefront: CHỈ câu hỏi ĐÃ DUYỆT của sản phẩm đang hiện (EXISTS chạy dưới policy
-- store_products → SP nháp vô hình), y hệt store_reviews (0047).
GRANT SELECT ON product_questions TO app_store;
CREATE POLICY store_questions ON product_questions FOR SELECT TO app_store
  USING (shop_id = current_shop_id() AND status = 'approved'
         AND EXISTS (SELECT 1 FROM products p WHERE p.id = product_questions.product_id));
