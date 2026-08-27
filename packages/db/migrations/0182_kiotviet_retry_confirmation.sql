-- 0182 — mỗi xác nhận retry của người vận hành chỉ được tiêu thụ một lần.
--
-- Discrepancy được dùng làm nonce do seller phát hành. Giữ nonce trên send-intent để
-- duplicate outbox/job hoặc một lượt retry cũ không thể gửi lại sau khi lượt đầu đã lỗi.
ALTER TABLE integration_order_send_intents
  ADD COLUMN last_retry_discrepancy_id uuid,
  ADD CONSTRAINT integration_order_send_intents_retry_discrepancy_fk
    FOREIGN KEY (shop_id, last_retry_discrepancy_id)
    REFERENCES integration_sync_discrepancies (shop_id, id);

COMMENT ON COLUMN integration_order_send_intents.last_retry_discrepancy_id IS
  'Nonce discrepancy đã được người vận hành dùng để cho phép đúng một lượt retry; không reset từ attempted.';
