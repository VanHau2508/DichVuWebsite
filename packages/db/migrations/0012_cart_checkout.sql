-- 0012 — giỏ hàng + checkout. Phần lõi thương mại, bảo mật gắt nhất.
--
-- Vai trò mới: app_checkout (công khai, người mua ẩn danh, GHI đơn hàng).
-- Bất biến luồng tiền (docs/01 §8) được cưỡng chế bằng cấu trúc:
--   - cart_items KHÔNG lưu giá → giá luôn tra tươi từ variants (không tin client).
--   - order_lines lưu SNAPSHOT (tên/sku/giá lúc mua).
--   - reserved <= on_hand (CHECK 0009) → không oversell dù có đua.
--   - order_number theo shop (shop_counters), không sequence toàn cục.

-- ── carts (ẩn danh, token lưu HASH) ──────────────────────────────────────────
CREATE TABLE carts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    uuid NOT NULL REFERENCES shops (id),
  token_hash text NOT NULL UNIQUE,      -- sha256(cart token trong cookie); không lưu token thô
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','converted','abandoned')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);

CREATE TABLE cart_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    uuid NOT NULL,
  cart_id    uuid NOT NULL,
  variant_id uuid NOT NULL,
  qty        int NOT NULL CHECK (qty > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- KHÔNG có cột giá: giá tra tươi từ variants khi hiển thị/checkout.
  UNIQUE (shop_id, cart_id, variant_id),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, cart_id)    REFERENCES carts    (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, variant_id) REFERENCES variants (shop_id, id)
);
CREATE INDEX cart_items_cart_idx ON cart_items (shop_id, cart_id);

-- ── orders: thêm thông tin người mua + tiền (đã có shop_id/order_number/... ở 0002) ──
ALTER TABLE orders ADD COLUMN customer_name     text;
ALTER TABLE orders ADD COLUMN customer_phone    text;
ALTER TABLE orders ADD COLUMN customer_email    text;
ALTER TABLE orders ADD COLUMN shipping_address  jsonb;     -- SNAPSHOT địa chỉ lúc đặt
ALTER TABLE orders ADD COLUMN subtotal_vnd      bigint NOT NULL DEFAULT 0 CHECK (subtotal_vnd >= 0);
ALTER TABLE orders ADD COLUMN shipping_vnd      bigint NOT NULL DEFAULT 0 CHECK (shipping_vnd >= 0);
ALTER TABLE orders ADD COLUMN discount_vnd      bigint NOT NULL DEFAULT 0 CHECK (discount_vnd >= 0);
ALTER TABLE orders ADD COLUMN payment_method    text CHECK (payment_method IN ('cod','qr'));
ALTER TABLE orders ADD COLUMN lookup_token_hash text;      -- tra cứu đơn (khách)

-- ── RLS: app_rw (seller) — bắt buộc để bất biến schema qua ────────────────────
ALTER TABLE carts ENABLE ROW LEVEL SECURITY; ALTER TABLE carts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON carts FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
ALTER TABLE cart_items ENABLE ROW LEVEL SECURITY; ALTER TABLE cart_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cart_items FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- ── Vai trò app_checkout (công khai, ghi đơn) ────────────────────────────────
CREATE ROLE app_checkout LOGIN PASSWORD 'devpassword'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE app TO app_checkout;
GRANT USAGE   ON SCHEMA public TO app_checkout;

-- Đọc để định giá + kiểm tồn; KHÔNG đụng users/memberships/audit/products-write.
GRANT SELECT                         ON domains, shops, products, variants TO app_checkout;
GRANT SELECT, UPDATE                 ON inventory_levels TO app_checkout;    -- reserve
GRANT SELECT, INSERT, UPDATE, DELETE ON carts, cart_items TO app_checkout;
GRANT SELECT, INSERT                 ON orders, order_lines TO app_checkout; -- tạo + tra cứu
GRANT SELECT, INSERT, UPDATE         ON idempotency_keys TO app_checkout;
GRANT SELECT, INSERT, UPDATE         ON shop_counters TO app_checkout;       -- order_number

-- Resolve domain (chưa có context).
CREATE POLICY checkout_lookup ON domains FOR SELECT TO app_checkout USING (true);
-- Chỉ shop còn NHẬN ĐƠN (không suspended/terminated).
CREATE POLICY checkout_shop ON shops FOR SELECT TO app_checkout
  USING (id = current_shop_id() AND deleted_at IS NULL AND status NOT IN ('terminated','suspended'));
-- Chỉ sản phẩm/biến thể ĐANG BÁN (định giá theo giá thật, active).
CREATE POLICY checkout_products ON products FOR SELECT TO app_checkout
  USING (shop_id = current_shop_id() AND status = 'active' AND deleted_at IS NULL);
CREATE POLICY checkout_variants ON variants FOR SELECT TO app_checkout
  USING (shop_id = current_shop_id() AND EXISTS (SELECT 1 FROM products p WHERE p.id = variants.product_id));

-- Tenant-scoped cho các bảng ghi của luồng checkout.
CREATE POLICY checkout_inv     ON inventory_levels  FOR ALL TO app_checkout USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY checkout_carts   ON carts             FOR ALL TO app_checkout USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY checkout_citems  ON cart_items        FOR ALL TO app_checkout USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY checkout_orders  ON orders            FOR ALL TO app_checkout USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY checkout_olines  ON order_lines       FOR ALL TO app_checkout USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY checkout_idem    ON idempotency_keys  FOR ALL TO app_checkout USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY checkout_counter ON shop_counters     FOR ALL TO app_checkout USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
