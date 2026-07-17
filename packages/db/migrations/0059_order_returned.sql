-- 0059 — trạng thái đơn 'returned' (hàng hoàn / bom hàng).
--
-- Đơn COD bị hoàn (khách bom hàng) trước đây kẹt 'shipped' vĩnh viễn: worker sweepTracking
-- chỉ đánh dấu shipments.status='returned' + log('warn'), KHÔNG đổi trạng thái đơn. Thêm
-- trạng thái đơn 'returned' để worker chốt đơn (guard status='shipped' = idempotent), báo
-- shop (Telegram) và hiện trong admin.
--
-- KHÔNG tự cộng lại on_hand: hàng chưa chắc về kho / có thể hỏng; app_expiry CỐ TÌNH không
-- có quyền on_hand/inventory_ledger (0022) — chủ shop tự nhập lại tồn qua Điều chỉnh tồn khi
-- nhận hàng thực tế (giống refundOrder với đơn đã giao). Reserve đã trả lúc ship (consumeAndShip).

-- CHECK inline ở 0002 được Postgres đặt tên mặc định 'orders_status_check' (giống cách 0044
-- nới 'shipments_status_check'). Nếu tên khác, tra: SELECT conname FROM pg_constraint WHERE
-- conrelid='orders'::regclass AND contype='c';
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('pending','confirmed','shipped','delivered','cancelled','refunded','returned'));

-- Mốc thời điểm đơn bị hoàn (song song delivered_at/cancelled_at).
ALTER TABLE orders ADD COLUMN returned_at timestamptz;

-- Worker (app_expiry) đã có UPDATE(status) từ 0022; cấp thêm returned_at để chốt mốc.
GRANT UPDATE (returned_at) ON orders TO app_expiry;
