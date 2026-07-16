-- 0047 — Đánh giá sản phẩm (reviews). Khách gửi qua checkout (form no-JS, public);
-- mặc định PENDING — shop DUYỆT mới hiện (spam không có giá trị hiển thị). Badge
-- "đã mua" khi khớp đơn (số đơn + SĐT) chứa đúng sản phẩm.

CREATE TABLE product_reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL REFERENCES shops (id),
  product_id   uuid NOT NULL,
  order_number int,                                   -- đơn đối chiếu (nếu khách cung cấp)
  rating       int  NOT NULL CHECK (rating BETWEEN 1 AND 5),
  author_name  text NOT NULL,
  content      text NOT NULL,
  verified     boolean NOT NULL DEFAULT false,        -- khớp đơn đã mua sản phẩm này
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  ip_hash      text,                                  -- HMAC IP (chống spam, không lưu IP thô)
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, product_id) REFERENCES products (shop_id, id) ON DELETE CASCADE
);
CREATE INDEX product_reviews_product_idx ON product_reviews (shop_id, product_id, status);
CREATE INDEX product_reviews_ip_idx ON product_reviews (shop_id, ip_hash, created_at);

ALTER TABLE product_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_reviews FORCE  ROW LEVEL SECURITY;

-- Seller (app_rw): duyệt/từ chối/xoá trong shop mình.
CREATE POLICY tenant_isolation ON product_reviews FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON product_reviews TO app_rw;

-- Checkout (public, nhận form): INSERT pending + SELECT để đếm rate-limit/chống trùng.
CREATE POLICY checkout_reviews ON product_reviews FOR ALL TO app_checkout
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT SELECT, INSERT ON product_reviews TO app_checkout;

-- Storefront (công khai): CHỈ đánh giá ĐÃ DUYỆT của sản phẩm đang hiện (EXISTS chạy
-- dưới policy store_products → draft vô hình).
CREATE POLICY store_reviews ON product_reviews FOR SELECT TO app_store
  USING (shop_id = current_shop_id() AND status = 'approved'
         AND EXISTS (SELECT 1 FROM products p WHERE p.id = product_reviews.product_id));
GRANT SELECT ON product_reviews TO app_store;
