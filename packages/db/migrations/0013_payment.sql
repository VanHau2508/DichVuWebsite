-- 0013 — thanh toán QR (đối soát webhook) + sổ giao dịch.
--
-- Vai trò mới: app_payment (nhận webhook từ SePay/Casso, đánh dấu đã thanh toán).
-- Bất biến bảo mật (ADR-007, mỗi cái có test):
--   - CHỈ webhook đã xác thực chữ ký mới đánh dấu paid — KHÔNG từ redirect trình duyệt.
--   - Đối chiếu SỐ TIỀN chính xác (thiếu tiền → không paid).
--   - provider_event_id UNIQUE → idempotent / chống replay.
--   - KHÔNG lưu thông tin thẻ (không xử lý thẻ).

-- ── Cấu hình thanh toán của shop (để sinh VietQR) ────────────────────────────
CREATE TABLE shop_payment_config (
  shop_id        uuid PRIMARY KEY REFERENCES shops (id),
  bank_bin       text,          -- BIN ngân hàng (napas, 6 chữ số)
  account_number text,
  account_name   text,
  qr_enabled     boolean NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE shop_payment_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_payment_config FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shop_payment_config FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- ── orders: mã đối soát + mốc thanh toán ─────────────────────────────────────
ALTER TABLE orders ADD COLUMN payment_ref text UNIQUE;   -- duy nhất TOÀN nền tảng
ALTER TABLE orders ADD COLUMN paid_at      timestamptz;

-- ── sổ giao dịch thanh toán (append-only) ────────────────────────────────────
CREATE TABLE payment_transactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES shops (id),
  order_id          uuid NOT NULL,
  provider          text NOT NULL,               -- 'sepay' | 'casso' | 'manual'
  provider_event_id text NOT NULL,
  amount_vnd        bigint NOT NULL,
  status            text NOT NULL CHECK (status IN ('received','underpaid')),
  raw               jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),

  UNIQUE (provider, provider_event_id),           -- chống replay/trùng (toàn cục)
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders (shop_id, id)
);
ALTER TABLE payment_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_transactions FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_transactions FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- ── app_checkout: đọc cấu hình để sinh QR ────────────────────────────────────
GRANT SELECT ON shop_payment_config TO app_checkout;
CREATE POLICY checkout_paycfg ON shop_payment_config FOR SELECT TO app_checkout
  USING (shop_id = current_shop_id());

-- ── app_rw: xem giao dịch + cấu hình (chỉ đọc giao dịch) ──────────────────────
GRANT SELECT, INSERT, UPDATE ON shop_payment_config TO app_rw;
GRANT SELECT                 ON payment_transactions TO app_rw;

-- ── Vai trò app_payment (webhook đối soát) ───────────────────────────────────
CREATE ROLE app_payment LOGIN PASSWORD 'devpassword'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE app TO app_payment;
GRANT USAGE   ON SCHEMA public TO app_payment;

-- Tìm đơn theo payment_ref (xuyên shop) — CHỈ các cột không phải PII.
GRANT SELECT (id, shop_id, order_number, total_vnd, payment_status, payment_ref) ON orders TO app_payment;
-- Đánh dấu thanh toán — CHỈ các cột trạng thái, không đụng tiền/khách.
GRANT UPDATE (payment_status, paid_at, status) ON orders TO app_payment;
GRANT SELECT, INSERT ON payment_transactions TO app_payment;

-- Tra cứu đơn theo payment_ref không cần context (giống resolve domain).
CREATE POLICY payment_read ON orders FOR SELECT TO app_payment USING (true);
-- Cập nhật chỉ trong shop của đơn (đặt context = shop_id sau khi tìm thấy).
CREATE POLICY payment_write ON orders FOR UPDATE TO app_payment
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
-- Ghi sổ giao dịch trong context shop.
CREATE POLICY payment_txn ON payment_transactions FOR ALL TO app_payment
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
