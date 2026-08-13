-- 0156 — SỔ GIAO THÔNG BÁO BỀN VỮNG.
--
-- `outbox.processed_at` chỉ có nghĩa "đã đưa vào Redis", KHÔNG có nghĩa SMTP/Telegram/
-- Messenger đã nhận. BullMQ dead-letter cho vận hành thấy lỗi, nhưng chủ shop không thể biết
-- một thông báo cụ thể của đơn nào đã gửi hay thất bại. Bảng này lưu kết quả theo từng kênh.

CREATE TABLE notification_deliveries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id              uuid REFERENCES shops(id),
  outbox_id            bigint NOT NULL REFERENCES outbox(id),
  order_id             uuid,
  order_number         bigint CHECK (order_number IS NULL OR order_number > 0),
  topic                text NOT NULL,
  channel              text NOT NULL CHECK (channel IN ('email','telegram','messenger')),
  status               text NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued','sending','retrying','accepted','failed','skipped','superseded')),
  attempts             int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  provider_message_id  text,
  last_error           text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  last_attempt_at      timestamptz,
  accepted_at          timestamptz,
  failed_at            timestamptz,
  superseded_at        timestamptz,
  retry_of_delivery_id uuid REFERENCES notification_deliveries(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (outbox_id, channel),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  CHECK (order_id IS NULL OR shop_id IS NOT NULL),
  CHECK (status <> 'accepted' OR accepted_at IS NOT NULL),
  CHECK (status <> 'failed' OR failed_at IS NOT NULL),
  CHECK (status <> 'superseded' OR superseded_at IS NOT NULL)
);

CREATE INDEX notification_delivery_order_idx
  ON notification_deliveries (shop_id, order_id, created_at DESC)
  WHERE order_id IS NOT NULL;
CREATE INDEX notification_delivery_order_number_idx
  ON notification_deliveries (shop_id, order_number, created_at DESC)
  WHERE order_number IS NOT NULL;
CREATE INDEX notification_delivery_failed_idx
  ON notification_deliveries (shop_id, updated_at DESC)
  WHERE status = 'failed';

ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_deliveries FOR ALL TO app_rw
  USING (shop_id = current_shop_id())
  WITH CHECK (shop_id = current_shop_id());

-- Seller đọc sổ và chỉ được đánh dấu một lần gửi cũ đã được thay bằng yêu cầu gửi lại.
-- Không cho ứng dụng tự ghi "accepted" hoặc xoá lịch sử.
REVOKE INSERT, DELETE, UPDATE ON notification_deliveries FROM app_rw;
GRANT SELECT ON notification_deliveries TO app_rw;
GRANT UPDATE (status, superseded_at, updated_at) ON notification_deliveries TO app_rw;

GRANT SELECT, INSERT, UPDATE ON notification_deliveries TO app_worker;
CREATE POLICY worker_notification_deliveries ON notification_deliveries
  FOR ALL TO app_worker USING (true) WITH CHECK (true);

