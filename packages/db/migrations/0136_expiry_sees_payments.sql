-- 0136 — vòng quét hết hạn phải THẤY được "đơn này đã nhận tiền hay chưa".
--
-- LỖ ĐANG VÁ. `orders.payment_status = 'unpaid'` KHÔNG có nghĩa "chưa trả đồng nào".
-- Webhook SePay cộng dồn mọi giao dịch của đơn (apps/payment/src/server.js:202) và CHỈ đụng
-- bảng `orders` khi ĐỦ tiền — chính chú thích ở đó viết "khách có thể chuyển nhiều lần", tức
-- hệ thống LƯỜNG TRƯỚC việc trả góp nhiều lượt. Chuyển thiếu (phí ngân hàng, gõ nhầm số, hoặc
-- cố ý chuyển làm hai lần) thì: tiền vào `payment_transactions`, còn `orders` vẫn nguyên
-- `payment_status='unpaid'`, `amount_paid_vnd=0`.
--
-- Ba mươi phút sau, sweepExpired thấy đúng `payment_method='qr' AND payment_status='unpaid'`
-- → HUỶ ĐƠN, nhả giữ chỗ, hoàn lượt coupon, và gửi email "đơn đã tự huỷ" cho khách — trong
-- khi tiền của họ đã nằm trong tài khoản shop, không gắn với đơn còn sống nào. Không cảnh báo
-- nào kêu: hàng đợi đối soát (`unmatched_transfers`) chỉ nhận giao dịch KHÔNG KHỚP ĐƠN, còn
-- đây là khớp-nhưng-thiếu.
--
-- QUYẾT ĐỊNH (chủ nền tảng chọn): đơn đã nhận đồng nào thì KHÔNG tự huỷ nữa. Nó nằm lại danh
-- sách đơn chờ để người bán nhìn thấy và xử tay. Đánh đổi có thật và CHẤP NHẬN: giữ chỗ lâu
-- hơn. Phương án còn lại (vẫn huỷ + đẩy vào hàng đợi đối soát) đắt hơn và vẫn để khách nhận
-- email "đã huỷ" trong lúc tiền của họ đang ở đây.
--
-- Để làm được, app_expiry cần biết đơn có giao dịch nào chưa. Giữ nguyên tinh thần 0022:
-- CỘT HẸP NHẤT có thể — chỉ `order_id`. Vai này KHÔNG được thấy số tiền, không thấy nhà cung
-- cấp thanh toán, không thấy payload thô. Nó chỉ cần trả lời đúng một câu hỏi CÓ/KHÔNG.
GRANT SELECT (order_id) ON payment_transactions TO app_expiry;

-- Job nền chạy CHÉO SHOP → policy cross-shop, y như expiry_orders (0022). RLS vẫn FORCE;
-- thứ giới hạn thực sự là quyền CỘT ở trên.
CREATE POLICY expiry_payment_txn ON payment_transactions FOR SELECT TO app_expiry USING (true);
