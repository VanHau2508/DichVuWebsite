-- 0109 — Phiếu hỗ trợ tự mang theo BỐI CẢNH CHẨN ĐOÁN.
--
-- VÌ SAO. Vòng hỏi-đáp đắt nhất của hỗ trợ không phải "lỗi gì" mà là "anh đang ở đâu, với
-- tư cách gì". Rất nhiều phiếu hoá ra không phải lỗi: người gửi đang ở vai order_manager nên
-- không thấy nút cấu hình, hoặc shop đang 'onboarding' nên chưa bật thứ họ đang tìm, hoặc họ
-- dùng một trình duyệt mà tính năng đó không chạy. Ba câu hỏi đó tốn một vòng qua lại — mà
-- người bán đang bực thì mỗi vòng là một cơ hội để họ bỏ đi.
--
-- Máy BIẾT sẵn cả ba lúc bấm gửi. Chép lại thì chủ nền tảng đọc phiếu là trả lời được ngay.
--
-- Vì sao jsonb chứ không phải cột rời: đây là bối cảnh CHẨN ĐOÁN, còn nở thêm theo thời gian
-- (phiên bản app, cờ tính năng…), và KHÔNG có truy vấn nghiệp vụ nào lọc theo nó — chỉ đọc
-- bằng mắt trên đúng một màn hình. Cột rời cho mỗi mẩu là bắt migration chạy theo mỗi lần
-- muốn thêm một dòng hiển thị.
--
-- KHÔNG chứa PII mới: vai trò + trạng thái shop là dữ liệu vận hành; user-agent đã nằm sẵn
-- trong log HTTP. Email người gửi vẫn ở cột from_email riêng (0108), không nhét vào đây.

ALTER TABLE support_tickets ADD COLUMN diag jsonb;

COMMENT ON COLUMN support_tickets.diag IS
  'Bối cảnh chẩn đoán chép lúc gửi: vai người gửi, trạng thái shop, trình duyệt. Chỉ để đọc.';
