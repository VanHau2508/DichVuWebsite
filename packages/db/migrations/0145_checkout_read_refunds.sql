-- 0145: checkout được đọc SỐ TIỀN hoàn của đơn — để trang tra cứu nói thật với khách.
--
-- VÌ SAO. Trang tra cứu đơn (khách dán số đơn + mã, không cần tài khoản) là nơi khách nhìn
-- vào ĐÚNG LÚC đang tranh chấp: đã trả hàng, đang chờ tiền về. Đo trên shop ngày-60:
--   · đơn #275 (khách trả hàng, shop ĐÃ hoàn 1.405.000₫) — trang không có một chữ nào về
--     khoản hoàn đó, và còn ghi "Thanh toán khi nhận hàng (COD)";
--   · đơn #267 (huỷ, khách đã trả 1.990.000₫, shop hoàn 1.560.000₫) — im lặng về tiền.
-- Khách không có cách nào biết shop đã trả hay chưa, trả bao nhiêu. Họ gọi điện hỏi, và đó
-- là cuộc gọi mà phần mềm đáng lẽ phải làm thừa.
--
-- CẤP THEO CỘT, không cấp cả bảng. `refunds` còn có `reason` (người bán gõ tự do, có thể là
-- ghi chú nội bộ về chính khách đó) và `created_by` (danh tính nhân viên). Khách không cần
-- hai thứ đó, nên checkout không được đọc chúng — cấp cả bảng cho tiện là cách rò dữ liệu
-- nội bộ ra ngoài mà không ai nhớ tại sao.
--   · shop_id  — RLS + tự bảo vệ khi truy vấn lỡ quên điều kiện;
--   · order_id — nối về đơn;
--   · amount_vnd, created_at — số tiền và thời điểm, đúng thứ khách cần biết.

GRANT SELECT (shop_id, order_id, amount_vnd, created_at) ON refunds TO app_checkout;

-- Cô lập tenant y như mọi bảng khác: chỉ dòng của shop đang phục vụ. KHÔNG dùng USING(true)
-- dù checkout đã bị khoá theo tên miền — policy hằng-true là đúng hình dạng sẽ rò chéo shop
-- ngay lần đầu ai đó tái dùng vai này (xem 0128 khi phải gỡ đúng lỗi ấy).
CREATE POLICY checkout_refunds_read ON refunds
  FOR SELECT TO app_checkout USING (shop_id = current_shop_id());
