-- 0108 — Đóng VÒNG phản hồi cho phiếu hỗ trợ (0107).
--
-- 0107 mới có một chiều: người bán gửi, chủ nền tảng nhận qua Telegram. Chiều VỀ thiếu —
-- chủ nền tảng đánh dấu "đã xử lý" thì người bán chỉ thấy một cái nhãn đổi màu, không biết
-- đã xử ra sao. Nhãn không kèm lời giải thích là một lời hứa suông; nó còn tệ hơn im lặng
-- vì làm người bán tưởng mình đã được trả lời.
--
--   resolution_note — chủ nền tảng ghi ĐÃ LÀM GÌ; người bán đọc được ngay trên trang Trợ giúp
--                     và nhận qua email/Telegram. Không bắt buộc (có việc xử xong bằng một
--                     cuộc gọi), nhưng có chỗ để ghi thì người ta sẽ ghi.
--
--   from_email      — email người gửi, CHÉP LẠI lúc tạo phiếu.
--                     Vì sao chép chứ không JOIN users: app_platform KHÔNG có quyền nào trên
--                     bảng users (cố ý — xem 0075/0091 siết cột). Mở SELECT users cho console
--                     chỉ để hiện một địa chỉ email là nới đặc quyền vĩnh viễn đổi lấy một
--                     tiện nghi. Chép cũng ĐÚNG NGHĨA hơn: phiếu phải nhớ ai đã gửi nó, kể cả
--                     khi người đó rời shop hay bị xoá sau này — cùng lối nghĩ với snapshot
--                     giá/địa chỉ trên đơn hàng.
--
-- GRANT: 0107 cấp ở mức BẢNG (app_rw SELECT,INSERT — app_platform SELECT,UPDATE) nên cột mới
-- tự nằm trong phạm vi, không cần cấp thêm.

ALTER TABLE support_tickets ADD COLUMN resolution_note text;
ALTER TABLE support_tickets ADD COLUMN from_email     text;

COMMENT ON COLUMN support_tickets.resolution_note IS
  'Chủ nền tảng ghi đã xử lý ra sao — người bán đọc được trên trang Trợ giúp.';
COMMENT ON COLUMN support_tickets.from_email IS
  'Email người gửi, chép lúc tạo phiếu (console không có quyền đọc bảng users).';
