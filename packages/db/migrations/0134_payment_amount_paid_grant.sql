-- 0134 — webhook đối soát ghi được SỐ TIỀN THẬT đã nhận vào orders.amount_paid_vnd.
--
-- Trước đây webhook chỉ đặt payment_status='paid' và để amount_paid_vnd = 0. Mọi nơi
-- tính tiền hoàn (sửa đơn đã trả, refund) phải SUY ĐOÁN "đã thu = total_vnd" — đúng chừng
-- nào khách chuyển vừa đủ và đơn chưa bị sửa, sai ngay khi một trong hai điều đó hỏng.
--
-- GRANT cấp CỘT: thiếu dòng này thì UPDATE mới ở apps/payment ném
-- "permission denied for table orders" — RLS đã mở dòng nhưng cột thì chưa. Đây là hàng
-- rào có chủ ý (0013): mỗi cột webhook được ghi phải khai báo tường minh ở đây.
GRANT UPDATE (amount_paid_vnd) ON orders TO app_payment;
