-- 0126: nhớ trạng thái shop TRƯỚC KHI bị khoá vì chưa thanh toán.
--
-- Bug e2e bắt được: 0124 khoá bằng `WHERE status = 'active'` và mở lại bằng
-- `SET status = 'active'`. Hai chỗ sai:
--   1. Shop mới tạo ở trạng thái 'onboarding' (0006) và VẪN BÁN ĐƯỢC — nên nó lọt lưới
--      cưỡng chế hoàn toàn: không trả tiền mà cũng không bị khoá.
--   2. Nếu có khoá được, lúc mở lại ta ép về 'active' — âm thầm bấm hộ nút "Mở bán" mà
--      chủ shop chưa từng bấm. Trả tiền xong phải được TRẢ LẠI ĐÚNG thứ mình đang có.
ALTER TABLE subscriptions ADD COLUMN suspended_from text;
GRANT SELECT (suspended_from), UPDATE (suspended_from) ON subscriptions TO app_billing;
