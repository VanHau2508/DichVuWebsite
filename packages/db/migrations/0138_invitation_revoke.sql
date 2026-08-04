-- 0138 — LỜI MỜI phải THU HỒI được.
--
-- LỖ ĐANG VÁ. `invitations` (0006) có `accepted_at` và `expires_at`, KHÔNG có đường nào vô
-- hiệu hoá sớm. Mời nhầm email hoặc nhầm vai trò là NGÕ CỤT 7 NGÀY: token đã gửi đi vẫn
-- dùng được, người bán không có nút nào rút lại, và màn Thành viên còn không HIỆN lời mời
-- đang chờ nên họ có khi không biết là có. "Gỡ thành viên" cũng không đụng tới lời mời chưa
-- dùng — gỡ xong người kia bấm lại link cũ là vào lại.
--
-- Hai kịch bản KHÔNG cần ai làm sai:
--   · gõ nhầm tên miền email mà tên miền đó có người sở hữu thật → người lạ cầm chìa khoá
--     vào cửa hàng, hoàn toàn ngoài tầm kiểm soát của shop;
--   · bấm "Mời" lần thứ hai vì email vào spam → đẻ dòng thứ hai, token CŨ vẫn sống.
--
-- CỘT chứ không XOÁ DÒNG — cùng lối `shop_api_keys.revoked_at` (0120): thu hồi rồi vẫn phải
-- trả lời được "ai đã mời ai, lúc nào, rồi rút lại lúc nào". Lời mời là chuyện nhân sự, xoá
-- sạch là xoá luôn dấu vết.
ALTER TABLE invitations ADD COLUMN revoked_at timestamptz;

-- KHÔNG cấp GRANT/POLICY mới. Đã kiểm bằng information_schema:
--   · app_rw   — CRUD trên mọi bảng qua ALTER DEFAULT PRIVILEGES (0003), 0021 không REVOKE
--                gì trên bảng này; policy `tenant_isolation` (0006) đã phủ FOR ALL.
--   · app_auth — GRANT SELECT, UPDATE (0006:108) + policy đọc/nhận (0006:114-115).
--   · app_platform — GRANT SELECT, INSERT, UPDATE (0006:89) + policy `platform_all`.
-- GRANT ở đây là cấp-BẢNG (không cấp-cột) nên cột mới dùng được ngay. Thêm policy thứ hai
-- sẽ vi phạm bất biến "không LỆNH nào của bảng tenant bị ≥2 policy PERMISSIVE app_rw phủ"
-- (packages/db/test/schema-invariants.test.js) — đúng bài học 0121.

-- Index cũ `invitations_pending_email_idx` lọc theo `accepted_at IS NULL`, nay nghĩa "đang
-- chờ" gồm cả "chưa bị thu hồi". Thay để màn Thành viên liệt kê lời mời chờ không phải quét
-- cả bảng, và để đường nhận-lời-mời tra token vẫn hẹp.
DROP INDEX IF EXISTS invitations_pending_email_idx;
CREATE INDEX invitations_pending_idx ON invitations (shop_id, created_at DESC)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
