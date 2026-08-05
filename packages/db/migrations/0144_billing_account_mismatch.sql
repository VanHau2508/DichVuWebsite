-- 0144: nhận thêm lý do 'account_mismatch' cho hàng đợi đối soát tiền NỀN TẢNG.
--
-- VÌ SAO CÓ. Đường tiền ĐƠN HÀNG từ lâu đã chốt: chỉ ghi nhận khoản chuyển khi nó rơi ĐÚNG
-- tài khoản mà mã QR đã vẽ (payment/server.js so `ev.rcvAccount` với `orders.qr_account`,
-- trượt thì vào `unmatched_transfers` với reason 'account_mismatch'). Đường tiền NỀN TẢNG —
-- shop trả tiền thuê bao — KHÔNG có chốt đó, suốt từ 0124. Cùng một luật, có ở nhánh đi
-- nhiều, thiếu ở nhánh kia; và nhánh thiếu lại đúng là nhánh tiền về túi chủ nền tảng.
--
-- Token webhook bí mật KHÔNG cứu được: SePay bắn sự kiện cho MỌI tài khoản ngân hàng gắn vào
-- tài khoản SePay đó. Chỉ cần gắn thêm (hoặc gắn nhầm) một tài khoản thứ hai là mọi chuyển
-- khoản vào đó mang mã SUB… sẽ cộng hạn thuê bao, trong khi tiền không nằm ở tài khoản in
-- trên mã QR. Hoá đơn ghi 'paid', shop dùng tiếp, sổ ngân hàng không có khoản đó — không có
-- cách nào phát hiện muộn.
--
-- Bảng 0135 liệt kê RÕ danh sách lý do (CHECK IN …) chứ không để text tự do — đúng, vì một
-- cột lý do tự do là cột không ai đọc được. Cái giá là thêm lý do phải có migration, và đây
-- là migration đó. Migration là BẤT BIẾN: 0135 giữ nguyên, ràng buộc thay bằng cái mới.

ALTER TABLE platform_unmatched_transfers
  DROP CONSTRAINT platform_unmatched_transfers_reason_check;

ALTER TABLE platform_unmatched_transfers
  ADD CONSTRAINT platform_unmatched_transfers_reason_check
  CHECK (reason IN ('no_ref','charge_not_found','charge_cancelled','charge_paid','amount_short','account_mismatch'));
