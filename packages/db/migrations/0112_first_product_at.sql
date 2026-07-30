-- 0112 — Cờ "shop đã đăng sản phẩm đầu tiên chưa".
--
-- VÌ SAO KHÔNG ĐẾM TRỰC TIẾP. Console nền tảng cần phân biệt shop mở 10 ngày chưa đăng gì với
-- shop đang bán tốt — hiện hai loại nhìn Y HỆT nhau, chỉ khác cột đã-thu bằng 0, nên chủ nền
-- tảng không biết gọi cho ai. Nhưng đếm bảng products từ app_platform là PHÁ nguyên tắc #1 của
-- dịch vụ đó: "platform không mặc định xem dữ liệu khách mua" (0006), có test canh và test đã
-- bắt ngay lần chạy đầu — permission denied for table products.
--
-- Một CỜ trên bảng shops trả lời đúng câu hỏi vận hành ("ai đang mắc kẹt") mà console vẫn
-- KHÔNG nhìn thấy hàng hoá của người bán. Đây là siêu dữ liệu về tài khoản, không phải dữ liệu
-- kinh doanh.
--
-- Giá trị là min(products.created_at) THẬT, không phải lúc sweep phát hiện — cùng công sức mà
-- không nói dối về thời điểm.

ALTER TABLE shops ADD COLUMN first_product_at timestamptz;

COMMENT ON COLUMN shops.first_product_at IS
  'Thời điểm shop có sản phẩm ĐẦU TIÊN (min products.created_at). NULL = chưa đăng gì. Worker duy trì.';

-- app_platform đã có SELECT mức BẢNG trên shops (0006) → cột mới tự đọc được, không cần cấp.
-- app_expiry là vai chạy sweep của worker: đọc để biết cần cập nhật, ghi khi phát hiện.
GRANT SELECT (first_product_at) ON shops TO app_expiry;
GRANT UPDATE (first_product_at) ON shops TO app_expiry;

CREATE INDEX shops_no_product_idx ON shops (created_at)
  WHERE first_product_at IS NULL AND deleted_at IS NULL;
