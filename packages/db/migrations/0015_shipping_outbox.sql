-- 0015 — vận chuyển (shipment/tracking) + outbox cho thông báo email.
--
-- Outbox pattern (ADR-006): dịch vụ ghi sự kiện vào `outbox` TRONG CÙNG transaction
-- nghiệp vụ; worker đọc outbox → gửi email. Bất biến: transaction rollback → KHÔNG
-- có dòng outbox → KHÔNG email ma. `outbox` đã có từ 0002 (kèm RLS app_rw ở 0004).
--
-- Vai trò mới: app_worker (poller, xử lý outbox xuyên shop → gửi email qua SMTP relay).

-- ── shipments ────────────────────────────────────────────────────────────────
CREATE TABLE shipments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         uuid NOT NULL,
  order_id        uuid NOT NULL,
  carrier         text,
  tracking_number text,
  status          text NOT NULL DEFAULT 'created' CHECK (status IN ('created','in_transit','delivered')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders (shop_id, id)
);
CREATE INDEX shipments_order_idx ON shipments (shop_id, order_id);

ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipments FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shipments FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- Mốc trạng thái đơn (khi ship/deliver).
ALTER TABLE orders ADD COLUMN shipped_at   timestamptz;
ALTER TABLE orders ADD COLUMN delivered_at timestamptz;
ALTER TABLE orders ADD COLUMN cancelled_at timestamptz;

-- ── outbox: cho phép app_checkout + app_payment GHI sự kiện ───────────────────
-- (app_rw đã có full qua tenant_isolation 0004; seller ghi status-change events.)
GRANT INSERT ON outbox TO app_checkout, app_payment;
GRANT USAGE, SELECT ON SEQUENCE outbox_id_seq TO app_checkout, app_payment;
CREATE POLICY checkout_outbox ON outbox FOR INSERT TO app_checkout WITH CHECK (shop_id = current_shop_id());
CREATE POLICY payment_outbox  ON outbox FOR INSERT TO app_payment  WITH CHECK (shop_id = current_shop_id());

-- ── Vai trò app_worker (poller outbox, xuyên shop) ───────────────────────────
CREATE ROLE app_worker LOGIN PASSWORD 'devpassword'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE app TO app_worker;
GRANT USAGE   ON SCHEMA public TO app_worker;

-- Worker CHỈ đụng outbox: đọc chưa xử lý, đánh dấu đã xử lý / tăng attempts.
-- KHÔNG đọc orders/users/... — payload outbox tự chứa mọi thứ cần cho email.
-- Đây là lý do payload self-contained: worker có bán kính ảnh hưởng cực hẹp.
GRANT SELECT, UPDATE ON outbox TO app_worker;
-- Poller chạy xuyên shop (chưa có context) → policy USING(true), giống resolve domain.
CREATE POLICY worker_outbox ON outbox FOR ALL TO app_worker USING (true) WITH CHECK (true);

-- ── app_rw: đọc shipments đã có qua default privileges; thêm chắc chắn ────────
GRANT SELECT, INSERT, UPDATE ON shipments TO app_rw;
