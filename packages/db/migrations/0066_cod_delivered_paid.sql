-- 0066 — COD hãng giao xong = ĐÃ THU TIỀN → worker tự đặt payment_status='paid'.
--
-- Bug (kiểm toán #19): sweepTracking đặt orders.status='delivered' nhưng KHÔNG đụng
-- payment_status → đơn COD hãng đã thu hộ tiền vẫn 'unpaid' vĩnh viễn: dashboard doanh
-- thu (FILTER payment_status='paid') THIẾU toàn bộ COD giao qua hãng, ô "Cần thu tiền"
-- phình giả, shop phải bấm tay "Đã nhận tiền" từng đơn dù hãng đã thu.
--
-- app_expiry đã có SELECT(payment_method, payment_status) từ 0044 — thiếu quyền GHI 2 cột
-- + SELECT(paid_at): biểu thức `paid_at = CASE ... ELSE paid_at END` ĐỌC giá trị hiện tại
-- → cần SELECT (bẫy quen: cột xuất hiện trong EXPRESSION cần SELECT, không chỉ UPDATE).
-- Worker chỉ flip unpaid→paid cho COD trong CÙNG câu UPDATE delivered (CASE nguyên tử).
GRANT UPDATE (payment_status, paid_at) ON orders TO app_expiry;
GRANT SELECT (paid_at) ON orders TO app_expiry;
