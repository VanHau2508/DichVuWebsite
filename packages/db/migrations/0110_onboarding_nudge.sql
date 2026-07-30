-- 0110 — Nhắc MỘT LẦN người bán chưa đăng sản phẩm nào.
--
-- VÌ SAO. Khảo sát luồng self-serve: sau khi xác minh email, người bán KHÔNG nhận thêm gì cho
-- tới lúc thuê bao sắp hết hạn. Toàn bộ 12 chủ đề email hiện có đều là việc của KHÁCH mua hàng
-- (order.*, customer.*) hoặc việc đã muộn (subscription.reminder). Nền tảng im lặng đúng lúc
-- người bán cần được dắt nhất — mở shop lúc 2 giờ sáng, chưa biết bắt đầu từ đâu.
--
-- ĐÚNG MỘT LẦN, không phải chuỗi nhắc. Tên miền gửi thư còn mới, danh tiếng chưa có gì; nhắc
-- nhiều lần vào hộp thư người chưa từng tương tác là cách nhanh nhất để vào spam — và khi đó
-- MỌI email khác của nền tảng (xác nhận đơn, đặt lại mật khẩu) cùng chết theo.
--
-- Cột onboarding_nudged_at vừa là dấu ĐÃ GỬI vừa là chốt CHỐNG GỬI LẶP: worker chiếm quyền
-- bằng UPDATE ... WHERE onboarding_nudged_at IS NULL RETURNING, rồi ghi outbox TRONG CÙNG
-- transaction. Hai worker chạy song song thì chỉ một cái lấy được dòng. Cùng khuôn với
-- low_stock_alerted_on (0052).

ALTER TABLE shops ADD COLUMN onboarding_nudged_at timestamptz;

COMMENT ON COLUMN shops.onboarding_nudged_at IS
  'Mốc đã gửi email nhắc "chưa có sản phẩm nào". NULL = chưa gửi. Gửi ĐÚNG MỘT LẦN.';

-- app_expiry là vai chạy các sweep nhắc-nhở của worker (0050/0052: low stock). Cấp theo CỘT,
-- đúng kỷ luật siết quyền của 0075: chỉ thêm created_at (để tính mốc 48 giờ) và chính cột mới.
GRANT SELECT (created_at, onboarding_nudged_at) ON shops TO app_expiry;
GRANT UPDATE (onboarding_nudged_at)             ON shops TO app_expiry;

-- Quét tìm "shop quá N giờ mà chưa nhắc" — số dòng nhỏ dần theo thời gian vì đã nhắc thì thôi.
CREATE INDEX shops_nudge_pending_idx ON shops (created_at)
  WHERE onboarding_nudged_at IS NULL AND deleted_at IS NULL;
