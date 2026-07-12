-- 0025 — payment đọc customer_email để phát email "đã nhận thanh toán".
--
-- app_payment đối soát webhook → đặt paid → phát outbox `order.paid` (payload tự chứa
-- email để worker gửi biên nhận). Cần THÊM cột customer_email vào column-grant sẵn có
-- (payment đã đọc order_number/total_vnd/qr_account…). Vẫn KHÔNG cho đọc địa chỉ/điện thoại.

GRANT SELECT (customer_email) ON orders TO app_payment;
