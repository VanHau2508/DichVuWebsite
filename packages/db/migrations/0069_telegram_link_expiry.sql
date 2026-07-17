-- 0069 — HẠN DÙNG cho mã liên kết Telegram (audit #54). Trước đây link_code sống VĨNH VIỄN
-- tới khi có người /start: mã lộ/cũ (chụp màn hình, log, email chuyển tiếp) bind được chat
-- lạ vào shop bất kỳ lúc nào. Giờ: seller đặt hạn 30 phút khi (tái) tạo mã; worker CHỈ bind
-- khi còn hạn + mỗi nhịp poll tự xoá mã hết hạn (deep-link cũ chết hẳn).

ALTER TABLE shop_telegram ADD COLUMN link_code_expires_at timestamptz;

-- Quyền (bẫy quen thuộc: GRANT cấp CỘT không tự phủ cột mới):
--   • app_rw (seller): 0055 GRANT cấp BẢNG → tự phủ cột mới, không cần gì thêm.
--   • app_expiry (worker): 0055 GRANT cấp CỘT → phải cấp tường minh:
--       SELECT — cột nằm trong WHERE của bind (expires > now()) + WHERE của sweep dọn mã;
--       UPDATE — worker xoá hạn khi bind xong và khi dọn mã hết hạn.
GRANT SELECT (link_code_expires_at) ON shop_telegram TO app_expiry;
GRANT UPDATE (link_code_expires_at) ON shop_telegram TO app_expiry;
