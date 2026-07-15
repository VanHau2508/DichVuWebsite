-- 0035 — SePay PER-SHOP: mỗi shop dùng tài khoản SePay riêng (tiền vào THẲNG tài
-- khoản của shop, tự đối soát qua SePay của chính họ).
--
-- Trước đây: một key SePay TOÀN NỀN TẢNG, khớp theo tài khoản nhận (qr_account) —
-- giả định nền tảng giám sát mọi tài khoản. Không hợp mô hình "tiền vào thẳng tài
-- khoản shop". Giờ: mỗi shop có TOKEN webhook riêng (bí mật) → SePay của shop gọi
-- URL /webhooks/sepay/<token> → webhook resolve đúng shop rồi khớp đơn TRONG shop đó.
--
-- Bất biến bảo mật giữ nguyên: idempotent (UNIQUE provider_event_id), ràng buộc tài
-- khoản nhận, chỉ webhook/thao-tác-tay mới paid. Token lưu HASH (sha256), xoay được.
-- Bổ sung: hàng đợi giao dịch KHÔNG khớp (không rơi tiền lặng lẽ) để owner đối soát.

-- ── Cấu hình SePay per-shop (nối vào shop_payment_config) ─────────────────────
ALTER TABLE shop_payment_config ADD COLUMN sepay_enabled    boolean NOT NULL DEFAULT false;
ALTER TABLE shop_payment_config ADD COLUMN sepay_token_hash text;    -- sha256(token) hex; token bí mật chỉ hiện 1 lần
ALTER TABLE shop_payment_config ADD COLUMN sepay_token_prefix text;  -- 8 ký tự đầu (không bí mật) để owner nhận diện token đang dùng

-- Token duy nhất toàn nền tảng (để resolve shop 1-1 từ token). Partial: chỉ khi đã bật.
CREATE UNIQUE INDEX shop_payment_config_sepay_token_uq
  ON shop_payment_config (sepay_token_hash) WHERE sepay_token_hash IS NOT NULL;

-- ── Hàng đợi giao dịch CHƯA khớp (đối soát tay) ──────────────────────────────
-- Ghi lại mọi giao dịch webhook không tự khớp được đơn (không có ref / ref không tồn
-- tại trong shop / sai tài khoản) → owner thấy và xử lý, thay vì tiền "biến mất".
CREATE TABLE unmatched_transfers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES shops (id),
  provider          text NOT NULL,                 -- 'sepay'
  provider_event_id text NOT NULL,
  amount_vnd        bigint NOT NULL,
  content           text,
  received_account  text,
  reason            text NOT NULL CHECK (reason IN ('no_ref','order_not_found','account_mismatch')),
  raw               jsonb NOT NULL,
  resolved_at       timestamptz,
  resolved_order_id uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, provider, provider_event_id)     -- idempotent theo shop
);
ALTER TABLE unmatched_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE unmatched_transfers FORCE  ROW LEVEL SECURITY;
-- Seller (app_rw): xem + đánh dấu đã xử lý trong shop mình.
CREATE POLICY tenant_isolation ON unmatched_transfers FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT SELECT, UPDATE ON unmatched_transfers TO app_rw;

-- ── app_payment: resolve shop theo token + ghi hàng đợi chưa khớp ─────────────
-- Đọc cấu hình để resolve shop từ token (xuyên shop, giống payment_read trên orders).
-- CHỈ các cột cần: shop_id + token + trạng thái + tài khoản (để đối chiếu). KHÔNG cột lạ.
GRANT SELECT (shop_id, sepay_enabled, sepay_token_hash, account_number) ON shop_payment_config TO app_payment;
CREATE POLICY payment_paycfg_read ON shop_payment_config FOR SELECT TO app_payment USING (true);

-- Ghi hàng đợi chưa khớp TRONG context shop (đặt app.shop_id sau khi resolve token).
GRANT SELECT, INSERT ON unmatched_transfers TO app_payment;
CREATE POLICY payment_unmatched ON unmatched_transfers FOR ALL TO app_payment
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
