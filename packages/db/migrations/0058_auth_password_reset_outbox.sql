-- 0058 — auth phát email ĐẶT LẠI MẬT KHẨU qua outbox (ADR-006).
--
-- Bug: forgot() (apps/auth) ghi password_reset_tokens nhưng KHÔNG gửi email — auth
-- không có quyền outbox, không SMTP; reset chết trong prod trong khi UI báo "đã gửi".
--
-- Sự kiện reset là CẤP IDENTITY (không thuộc shop nào) — giống audit_logs (0005) ghi
-- shop_id NULL. Nhưng outbox.shop_id đang NOT NULL (0002). Nới NULL cho dòng identity
-- (audit_logs.shop_id vốn đã nullable và qua mọi schema-invariant), rồi cấp app_auth
-- INSERT với policy WITH CHECK (shop_id IS NULL) — HẸP như auth_audit: auth KHÔNG thể
-- nguỵ tạo outbox gắn cho một shop cụ thể. app_rw không thấy dòng shop_id NULL (policy
-- tenant_isolation: shop_id = current_shop_id()). Worker bỏ qua Telegram khi shop_id
-- NULL (guard !shopId) nên sự kiện này chỉ đi đường email.

-- Dòng outbox cấp identity không có shop. FK REFERENCES shops(id) cho phép NULL;
-- bất biến composite-FK miễn FK→shops (shops không có cột shop_id).
ALTER TABLE outbox ALTER COLUMN shop_id DROP NOT NULL;

GRANT INSERT ON outbox TO app_auth;
GRANT USAGE, SELECT ON SEQUENCE outbox_id_seq TO app_auth;

-- app_auth chỉ ghi được outbox KHÔNG gắn shop (mirror auth_audit trên audit_logs 0005).
CREATE POLICY auth_outbox ON outbox FOR INSERT TO app_auth WITH CHECK (shop_id IS NULL);
