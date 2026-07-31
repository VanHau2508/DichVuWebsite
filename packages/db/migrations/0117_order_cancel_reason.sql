-- 0117: lý do huỷ đơn.
--
-- Người bán báo: đơn khách ĐÃ CHUYỂN KHOẢN vẫn huỷ được bằng một cú bấm — không
-- cảnh báo, không lý do, không phiếu hoàn, và email báo khách chỉ nói "đã huỷ".
-- Kiểm lại đúng vậy: cancelOrder chỉ chặn theo `status` (pending/confirmed), KHÔNG
-- hề nhìn `payment_status`.
--
-- Hệ thống không mất tiền — khoản đã thu vẫn ghi nhận đủ. Cái mất là KHOẢN NỢ
-- KHÁCH: không chỗ nào nói shop còn phải trả lại, nên nó biến mất khỏi tầm mắt.
--
-- Chọn cảnh-báo thay vì cấm (chủ shop quyết): người bán hết hàng vẫn phải huỷ được
-- đơn đã trả. Nhưng phải nêu lý do, lý do đi thẳng vào email cho khách, và trang
-- đơn treo băng "còn nợ khách" tới khi có phiếu hoàn.
--
-- app_rw có quyền cấp BẢNG trên orders nên cột mới tự được phủ, không cần GRANT.
-- Các vai khác (app_expiry/app_payment/app_loyalty) cấp theo CỘT và không cần cột
-- này — để nguyên, đúng nguyên tắc bán kính hẹp.
ALTER TABLE orders ADD COLUMN cancel_reason text;

COMMENT ON COLUMN orders.cancel_reason IS
  'Lý do huỷ do người bán nhập. BẮT BUỘC khi payment_status = paid (xem cancelOrder).';
