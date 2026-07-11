-- 0014 — ràng buộc TÀI KHOẢN NHẬN cho thanh toán QR.
--
-- Sửa lỗ hổng rà soát bảo mật Ngày 14 (high): webhook đánh dấu paid chỉ dựa trên
-- payment_ref + số tiền, KHÔNG kiểm tiền có vào ĐÚNG tài khoản của shop sở hữu đơn.
-- Vì mỗi shop khai tài khoản RIÊNG, kẻ tấn công có thể chuyển tiền vào tài khoản
-- CỦA MÌNH với nội dung = ref đơn của shop khác → "đánh dấu hộ" → nhận hàng miễn phí.
--
-- Sửa: snapshot tài khoản nhận vào đơn lúc tạo QR; webhook so khớp tài khoản mà
-- SePay báo với snapshot này trước khi paid.

ALTER TABLE orders ADD COLUMN qr_account text;   -- tài khoản nhận, chốt lúc tạo QR

-- app_payment cần đọc cột này để đối chiếu (thêm vào column-grant sẵn có).
GRANT SELECT (qr_account) ON orders TO app_payment;
