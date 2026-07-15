-- 0038 — Mã giảm giá (coupon). Giảm theo % hoặc số tiền cố định, có điều kiện đơn tối
-- thiểu / hạn dùng / số lượt. Giảm áp trên SUBTOTAL (không giảm ship), total không âm.
-- Đụng đường tiền: total = subtotal - discount + ship được CHỐT lúc tạo đơn → QR/webhook khớp.

CREATE TABLE coupons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          uuid NOT NULL REFERENCES shops (id),
  code             text NOT NULL,                              -- mã (lưu HOA, so khớp không phân biệt hoa/thường)
  kind             text NOT NULL CHECK (kind IN ('percent','fixed')),
  value            bigint NOT NULL CHECK (value > 0),          -- percent: 1..100 ; fixed: VND
  min_subtotal_vnd bigint NOT NULL DEFAULT 0 CHECK (min_subtotal_vnd >= 0),
  max_uses         integer CHECK (max_uses IS NULL OR max_uses > 0),  -- null = không giới hạn
  used_count       integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  starts_at        timestamptz,
  expires_at       timestamptz,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, code),
  CHECK (kind <> 'percent' OR value <= 100)                    -- percent tối đa 100%
);
ALTER TABLE coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupons FORCE  ROW LEVEL SECURITY;

-- Snapshot mã đã dùng lên đơn + lưu mã đang áp trên giỏ (để summarize/createOrder khớp).
ALTER TABLE orders ADD COLUMN coupon_code text;
ALTER TABLE carts  ADD COLUMN coupon_code text;

-- Seller (app_rw): CRUD coupon của shop mình.
CREATE POLICY tenant_isolation ON coupons FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON coupons TO app_rw;

-- Checkout (app_checkout): ĐỌC để validate + tăng used_count (CHỈ cột used_count) khi tạo đơn.
GRANT SELECT, UPDATE (used_count) ON coupons TO app_checkout;
CREATE POLICY checkout_coupon ON coupons FOR ALL TO app_checkout
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
