-- 0062 — NHẮC HẠN thuê bao 7/3/1 ngày + past_due (dunning), qua outbox (ADR-006).
--
-- 0033 cố ý KHÔNG cho app_billing đọc email đăng nhập của owner (users/memberships) — GIỮ
-- NGUYÊN lập trường đó. Nhắc hạn gửi tới shops.contact_email (0029 — email LIÊN HỆ công
-- khai của shop; concierge thường trùng email owner) + Telegram per-shop (0055 — consumer
-- worker định tuyến bằng pool app_expiry sẵn có, app_billing KHÔNG cần đụng shop_telegram).
-- Đánh đổi chấp nhận: shop chưa khai contact_email và chưa link Telegram thì không nhận
-- nhắc tự động — Console vẫn hiện sub_status cho staff đòi nợ tay (backstop như 0033).
--
-- Idempotent theo MỐC (mirror claim-theo-ngày lowstock 0052): claim nguyên tử trên cặp
-- (reminded_milestone, reminded_period_end). Ghi kèm current_period_end tại lúc claim →
-- gia hạn (platform đẩy current_period_end tới) tự RE-ARM mốc, không cần platform reset.

ALTER TABLE subscriptions ADD COLUMN reminded_milestone text
  CHECK (reminded_milestone IN ('d7', 'd3', 'd1', 'past_due'));
ALTER TABLE subscriptions ADD COLUMN reminded_period_end timestamptz;

-- Quyền theo CỘT cho app_billing (0033 chỉ có id/shop_id/status/current_period_end):
-- UPDATE ... WHERE so cột reminded_* → PHẢI có cả SELECT cột đó (bẫy quen thuộc).
GRANT SELECT (plan_code, reminded_milestone, reminded_period_end),
      UPDATE (reminded_milestone, reminded_period_end) ON subscriptions TO app_billing;

-- Soạn nội dung nhắc: tên shop + email liên hệ. KHÔNG phải bảng identity; policy
-- billing_shops (0033) FOR ALL đã cho qua RLS — chỉ thiếu quyền cột.
GRANT SELECT (name, contact_email) ON shops TO app_billing;

-- Tên gói cho nội dung. plans là dữ liệu tham chiếu KHÔNG RLS (như 0032 cấp app_rw).
GRANT SELECT ON plans TO app_billing;

-- Outbox: app_billing chỉ được ghi ĐÚNG topic nhắc hạn, luôn gắn shop (định tuyến
-- Telegram per-shop; KHÔNG giả mạo được email đơn hàng/reset — thu hẹp theo dòng,
-- mirror auth_outbox 0058).
GRANT INSERT ON outbox TO app_billing;
GRANT USAGE, SELECT ON SEQUENCE outbox_id_seq TO app_billing;
CREATE POLICY billing_outbox ON outbox FOR INSERT TO app_billing
  WITH CHECK (shop_id IS NOT NULL AND topic = 'subscription.reminder');
