-- 0124: SHOP TỰ TRẢ TIỀN THUÊ BAO — đường tiền CỦA NỀN TẢNG.
--
-- ── Vì sao đây là nút thắt, không phải tính năng phụ ────────────────────────
-- Hôm nay shop tự đăng ký được (0091) nhưng KHÔNG có cách nào tự trả tiền: gia hạn chỉ có
-- ở /ops/shops/:id/subscription/renew — nhân viên nền tảng gõ tay SAU KHI đã nhận tiền.
-- Chủ shop cũng không có màn hình nào thấy gói/hạn của mình. Và hết hạn thì worker lật
-- subscriptions.status sang past_due → cancelled nhưng KHÔNG AI ĐỌC cột đó: storefront chỉ
-- kiểm shops.status='suspended', mà cột ấy do người bấm tay.
-- Tức là: thu hút khách tự động, THU TIỀN thủ công, và người không trả thì im lặng dùng mãi.
-- 10 shop còn làm tay được; 100 shop là việc toàn thời gian; 1000 shop là không thể.
--
-- ── Hai bảng, KHÔNG gộp ────────────────────────────────────────────────────
-- platform_invoices (0061) là SỔ THU append-only: "đã nhận bao nhiêu, của ai, lúc nào" —
-- chứng từ, không UPDATE/DELETE cho bất kỳ vai nào. Nhét hoá đơn CHƯA TRẢ vào đó là bơm
-- dòng chưa-có-tiền vào sổ doanh thu; báo cáo MRR sẽ nói dối mà không ai thấy sai.
-- billing_charges dưới đây là YÊU CẦU TRẢ TIỀN: có vòng đời (pending → paid → applied),
-- có thể hết hạn, có thể huỷ. Tiền về thì mới sinh một dòng platform_invoices.

-- Tài khoản NHẬN TIỀN của chính nền tảng. Một dòng duy nhất (singleton) — nền tảng chỉ có
-- một túi tiền. Khác shop_payment_config (0035) là cấu hình per-shop để shop nhận tiền KHÁCH.
CREATE TABLE platform_billing_config (
  id                 boolean PRIMARY KEY DEFAULT true CHECK (id),  -- ép đúng MỘT dòng
  bank_bin           text,
  account_number     text,
  account_name       text,
  -- sha256(token SePay của nền tảng). KHÁC token per-shop: webhook phải phân biệt được
  -- "tiền khách trả cho shop" với "tiền shop trả cho nền tảng" — trộn hai luồng là ghi
  -- nhầm sổ, và ghi nhầm sổ tiền thì không có cách nào phát hiện muộn.
  sepay_token_hash   text UNIQUE,
  enabled            boolean NOT NULL DEFAULT false,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_billing_config (id) VALUES (true);
ALTER TABLE platform_billing_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_billing_config FORCE  ROW LEVEL SECURITY;
REVOKE ALL ON platform_billing_config FROM app_rw;   -- default privileges 0003 vừa tự cấp

-- Yêu cầu trả tiền. pay_ref là NỘI DUNG CHUYỂN KHOẢN duy nhất — thứ duy nhất nối một lần
-- chuyển khoản với một shop. Không có nó thì phải đối chiếu tay theo số tiền + thời điểm,
-- đúng việc mà cả tính năng này sinh ra để bỏ.
CREATE TABLE billing_charges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  plan_code   text NOT NULL REFERENCES plans(code),
  months      int  NOT NULL CHECK (months >= 1 AND months <= 24),
  amount_vnd  bigint NOT NULL CHECK (amount_vnd >= 0),
  pay_ref     text NOT NULL UNIQUE,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','cancelled')),
  paid_at     timestamptz,
  -- ÁP DỤNG tách khỏi ĐÃ TRẢ: payment service chỉ đánh dấu paid (vai hẹp, không được
  -- đụng subscriptions/shops); worker mới cộng hạn + mở khoá + ghi sổ thu. applied_at
  -- NULL = còn việc → sweep nhặt. Máy chết giữa chừng thì nhịp sau làm lại, không mất tiền.
  applied_at  timestamptz,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);
CREATE INDEX billing_charges_shop_idx ON billing_charges (shop_id, created_at DESC);
CREATE INDEX billing_charges_todo_idx ON billing_charges (paid_at) WHERE status = 'paid' AND applied_at IS NULL;

ALTER TABLE billing_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_charges FORCE  ROW LEVEL SECURITY;
-- Chủ shop XEM + TẠO hoá đơn của chính mình (đó là cả điểm của "tự phục vụ"). KHÔNG cho
-- UPDATE: shop mà sửa được status/amount thì tự tuyên bố đã trả tiền.
CREATE POLICY tenant_isolation ON billing_charges FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT SELECT, INSERT ON billing_charges TO app_rw;

-- ── app_payment: khớp tiền về, CHỈ đánh dấu đã trả ──────────────────────────
-- Vai này không được cộng hạn hay mở khoá shop — nó là vai xử lý webhook từ Internet.
GRANT SELECT (id, bank_bin, account_number, account_name, sepay_token_hash, enabled)
  ON platform_billing_config TO app_payment;
CREATE POLICY payment_billing_cfg ON platform_billing_config FOR SELECT TO app_payment USING (true);
GRANT SELECT (id, shop_id, plan_code, months, amount_vnd, pay_ref, status, paid_at, expires_at),
      UPDATE (status, paid_at) ON billing_charges TO app_payment;
CREATE POLICY payment_charges ON billing_charges FOR ALL TO app_payment USING (true) WITH CHECK (true);

-- ── app_billing (worker): áp dụng khoản đã trả + cưỡng chế hết hạn ──────────
GRANT SELECT (id, shop_id, plan_code, months, amount_vnd, status, paid_at, applied_at),
      UPDATE (applied_at) ON billing_charges TO app_billing;
CREATE POLICY billing_charges_apply ON billing_charges FOR ALL TO app_billing USING (true) WITH CHECK (true);
-- Cộng hạn + ghi lý do khoá. suspended_at nằm ở subscriptions chứ không phải shops: shops
-- chỉ cấp UPDATE(status) cho app_billing (0033), và ta cần phân biệt "khoá vì không trả"
-- với "khoá do nhân viên nền tảng" — trả tiền chỉ được mở lại loại thứ nhất.
ALTER TABLE subscriptions ADD COLUMN suspended_at timestamptz;
GRANT SELECT (id, shop_id, plan_code, status, current_period_end, suspended_at),
      UPDATE (status, current_period_end, suspended_at) ON subscriptions TO app_billing;
-- Ghi sổ THU khi tiền đã về (append-only, mirror 0061).
GRANT INSERT ON platform_invoices TO app_billing;
CREATE POLICY billing_invoice_insert ON platform_invoices FOR INSERT TO app_billing WITH CHECK (true);

-- ── app_platform: chủ nền tảng xem/cấu hình ────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON platform_billing_config TO app_platform;
CREATE POLICY platform_billing_cfg ON platform_billing_config FOR ALL TO app_platform USING (true) WITH CHECK (true);
GRANT SELECT, UPDATE ON billing_charges TO app_platform;
CREATE POLICY platform_charges ON billing_charges FOR ALL TO app_platform USING (true) WITH CHECK (true);

-- Chủ shop xem được lịch sử ĐÃ ĐÓNG PHÍ của chính mình — 0061 đã chừa sẵn đường này
-- ("v2 muốn cho seller xem lịch sử đóng phí của chính họ thì chỉ cần GRANT SELECT").
-- Policy tenant_isolation đang "ngủ" ở 0061 nay thức dậy đúng như dự tính.
GRANT SELECT ON platform_invoices TO app_rw;
