-- 0020 — xác minh email + bịt lỗ CHIẾM SHOP qua đăng ký trước (P0-4).
--
-- Lỗ hổng: acceptInvitation gắn membership vào user CÓ SẴN theo email mà không đòi
-- bằng chứng sở hữu. Kẻ tấn công đăng ký trước owner@brand.vn (register công khai,
-- không verify) → khi lời mời thật được chấp nhận, shop gắn vào tài khoản của hắn.
--
-- Nguyên tắc sửa: TOKEN LỜI MỜI = BẰNG CHỨNG SỞ HỮU EMAIL (nó gửi tới đúng hộp thư đó).
--   • Tài khoản tạo/claim qua lời mời → email_verified_at = now().
--   • Tài khoản CHƯA verify (vd kẻ đăng ký trước) → người giữ token CLAIM được: đặt lại
--     mật khẩu + tắt MFA + thu hồi phiên (logic ở apps/auth acceptInvitation).
--   • Tài khoản ĐÃ verify = chủ email hợp lệ → accept đòi đăng nhập đúng tài khoản.
-- Register công khai vẫn còn nhưng chỉ tạo tài khoản CHƯA verify (mặc định NULL) nên
-- không thể dùng để chiếm; siết/tắt hẳn register là bước làm cứng P1 tiếp theo.

ALTER TABLE users ADD COLUMN email_verified_at timestamptz;

-- Dữ liệu hiện có coi như đã xác minh (môi trường tin cậy / seed). User MỚI từ register
-- mặc định NULL = chưa xác minh. app_auth có GRANT ...UPDATE ON users (0005) nên phủ cột mới.
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;
