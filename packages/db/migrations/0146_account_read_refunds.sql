-- 0146: khách ĐÃ ĐĂNG NHẬP cũng đọc được số tiền hoàn của chính đơn mình — mirror 0145.
--
-- 0145 mở cho trang tra cứu (checkout, khách dán số đơn + mã). Nhưng khách CÓ TÀI KHOẢN xem
-- lịch sử đơn ở apps/account, và ở đó lỗ hổng còn lộ liễu hơn: trang in thẳng hai nhãn cạnh
-- nhau — `Đã trả` (trạng thái đơn) và `Đã thanh toán` (trạng thái tiền) — vì đơn bom hàng
-- giữ nguyên payment_status='paid'. Khách đã trả hàng đọc được đúng câu "Đã thanh toán" và
-- không có gì nói cho họ biết tiền đã về hay chưa.
--
-- Vá một trong hai màn là để nguyên lời nói dối ở màn kia. Hai đường vào cùng một sự thật thì
-- phải nói cùng một câu — mà muốn nói được thì cả hai vai đều phải đọc được `refunds`.
--
-- CẤP THEO CỘT y hệt 0145: KHÔNG `reason` (ghi chú nội bộ của người bán), KHÔNG `created_by`
-- (danh tính nhân viên). Khách chỉ cần biết bao nhiêu và bao giờ.
--
-- RLS: bảng refunds cô lập theo shop. Vai app_customer còn bị siết thêm một tầng ở tầng ứng
-- dụng (withCustomer đặt current_customer_id() và truy vấn đơn luôn kèm customer_id =
-- current_customer_id()), nên dòng hoàn chỉ tới được khách qua đúng đơn của họ.

GRANT SELECT (shop_id, order_id, amount_vnd, created_at) ON refunds TO app_customer;

CREATE POLICY customer_refunds_read ON refunds
  FOR SELECT TO app_customer USING (shop_id = current_shop_id());
