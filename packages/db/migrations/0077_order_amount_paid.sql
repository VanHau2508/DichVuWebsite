-- 0077 — Sửa đơn v2 (sửa đơn ĐÃ TRẢ): ghi nhớ TIỀN KHÁCH ĐÃ THỰC TRẢ.
--
-- Sửa đơn đã trả có thể GIẢM tổng → hoàn phần chênh. Muốn tính đúng phần hoàn qua NHIỀU
-- lần sửa, phải neo vào "số tiền đã thu" cố định — không thể suy từ total_vnd vì total_vnd
-- chính là thứ đang bị sửa (lần sửa 2 sẽ tính sai nếu dựa vào total đã đổi).
--
-- amount_paid_vnd = tiền khách thực trả. editPaidOrder KHOÁ giá trị này lúc sửa lần đầu
-- (lazy: cột 0 = chưa khoá → dùng total_vnd hiện tại vì đơn chưa từng sửa nên total == đã
-- thu). KHÔNG cần đụng đường thanh toán (webhook/worker/markPaid) — lazy phủ đơn mới; backfill
-- phủ đơn cũ. net giữ = amount_paid_vnd − Σrefunds; hoàn khi sửa = net − tổng mới.
--
-- app_rw có UPDATE/SELECT table-level trên orders (seller sở hữu đơn) → cột mới tự phủ,
-- KHÔNG cần GRANT thêm. app_payment/app_expiry KHÔNG đọc/ghi cột này (lazy, không đụng
-- đường thanh toán) nên không cần grant.
ALTER TABLE orders ADD COLUMN amount_paid_vnd bigint NOT NULL DEFAULT 0
  CHECK (amount_paid_vnd >= 0);

-- Backfill đơn ĐÃ TRẢ: số đã thu = total_vnd tại thời điểm này (đơn chưa từng sửa nên
-- total == số đã charge). Đơn unpaid/refunded/cancelled giữ 0 (lazy xử khi cần).
UPDATE orders SET amount_paid_vnd = total_vnd WHERE payment_status = 'paid';
