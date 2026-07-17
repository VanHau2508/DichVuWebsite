-- 0072 — subscriptions.cancelled_at: mốc HUỶ chính xác cho churn + offboard.
--
-- Trước giờ churn_90d của /ops/metrics phải ƯỚC LƯỢNG qua current_period_end đóng
-- băng (lệch đúng khoảng ân hạn past_due — chú thích cũ trong platform server.js).
-- Cột này chốt mốc huỷ thật. Ai ghi:
--   * worker sweepSubscriptions (app_billing): past_due quá ân hạn → cancelled
--     + cancelled_at = now(). BẪY QUEN: 0033 cấp UPDATE THEO CỘT (status) — quyền
--     theo cột KHÔNG tự phủ cột mới → phải GRANT tường minh bên dưới.
--   * platform terminate/renew (app_platform): 0006 cấp UPDATE CẢ BẢNG subscriptions
--     → tự phủ cột mới, không cần grant thêm.
-- Dòng cancelled TRƯỚC migration: cancelled_at NULL — GIỮ NULL (không bịa mốc);
-- metrics tách riêng các dòng này thành churn_90d_legacy_estimate (vẫn ước lượng).

ALTER TABLE subscriptions ADD COLUMN cancelled_at timestamptz;

GRANT UPDATE (cancelled_at) ON subscriptions TO app_billing;

-- Sửa grant "chết" từ 0006: GRANT SELECT ON memberships cho app_platform có sẵn
-- ("liệt kê nhân sự") nhưng KHÔNG có policy → FORCE RLS trả 0 dòng im lặng.
-- Kích hoạt đúng ý định gốc để bản xuất offboard (GET /ops/shops/:id/export) liệt kê
-- được nhân sự shop. Đây là bảng QUẢN LÝ (user_id + vai trò), KHÔNG phải dữ liệu
-- khách mua — không vi phạm "platform không xem dữ liệu khách mua".
CREATE POLICY platform_read ON memberships FOR SELECT TO app_platform USING (true);
