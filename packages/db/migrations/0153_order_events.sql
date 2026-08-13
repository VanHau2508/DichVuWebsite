-- 0153 — NHẬT KÝ ĐƠN HÀNG: một dòng thời gian append-only cho tiền, hàng và thông báo.
--
-- Audit log hiện trả lời "ai đã làm gì trong shop", nhưng người xử lý một đơn phải ghép audit,
-- shipment, refund và return từ nhiều màn hình. Bảng này là read-model theo ĐƠN; nó không thay thế
-- chứng từ gốc và tuyệt đối không được dùng để tính tiền hoặc tồn kho.

CREATE TABLE order_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL,
  order_id    uuid NOT NULL,
  event_type  text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  actor_type  text NOT NULL CHECK (actor_type IN (
                'user','buyer','system','payment_provider','carrier','marketplace','platform_staff','migration'
              )),
  actor_id    text,
  source      text NOT NULL CHECK (length(source) BETWEEN 1 AND 80),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders (shop_id, id)
);

CREATE INDEX order_events_order_idx
  ON order_events (shop_id, order_id, occurred_at, recorded_at, id);
CREATE INDEX order_events_type_idx
  ON order_events (shop_id, event_type, occurred_at DESC);

-- Dựng timeline tối thiểu cho đơn cũ. Đây chỉ là mốc được chứng minh bởi cột/chứng từ hiện có;
-- không bịa "đã xác nhận" vì schema cũ không lưu confirmed_at.
INSERT INTO order_events (shop_id, order_id, event_type, actor_type, source, payload, occurred_at)
SELECT shop_id, id, 'order.created', 'migration', 'migration', '{"backfilled":true}', created_at
  FROM orders;

INSERT INTO order_events (shop_id, order_id, event_type, actor_type, source, payload, occurred_at)
SELECT shop_id, id, 'order.cancelled', 'migration', 'migration',
       jsonb_build_object('backfilled', true, 'reason', cancel_reason), cancelled_at
  FROM orders WHERE cancelled_at IS NOT NULL;

INSERT INTO order_events (shop_id, order_id, event_type, actor_type, source, payload, occurred_at)
SELECT shop_id, id, 'shipment.in_transit', 'migration', 'migration', '{"backfilled":true}', shipped_at
  FROM orders WHERE shipped_at IS NOT NULL;

INSERT INTO order_events (shop_id, order_id, event_type, actor_type, source, payload, occurred_at)
SELECT shop_id, id, 'shipment.delivered', 'migration', 'migration', '{"backfilled":true}', delivered_at
  FROM orders WHERE delivered_at IS NOT NULL;

INSERT INTO order_events (shop_id, order_id, event_type, actor_type, source, payload, occurred_at)
SELECT pt.shop_id, pt.order_id, 'payment.received', 'migration', 'migration',
       jsonb_build_object(
         'backfilled', true,
         'amount_vnd', pt.amount_vnd,
         'provider', pt.provider,
         'provider_event_id', pt.provider_event_id
       ),
       pt.created_at
  FROM payment_transactions pt;

-- Đơn đã thu tay trước khi có transaction ledger v2 vẫn cần một mốc dễ hiểu. Chỉ tạo khi không
-- có transaction thật để timeline không đếm cùng một khoản hai lần.
INSERT INTO order_events (shop_id, order_id, event_type, actor_type, source, payload, occurred_at)
SELECT o.shop_id, o.id, 'payment.received', 'migration', 'migration',
       jsonb_build_object(
         'backfilled', true,
         'legacy', true,
         'amount_vnd', CASE WHEN o.amount_paid_vnd > 0 THEN o.amount_paid_vnd ELSE o.total_vnd END
       ),
       o.paid_at
  FROM orders o
 WHERE o.paid_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM payment_transactions pt WHERE pt.order_id = o.id);

INSERT INTO order_events (shop_id, order_id, event_type, actor_type, source, payload, occurred_at)
SELECT s.shop_id, s.order_id, 'shipment.created', 'migration', 'migration',
       jsonb_build_object(
         'backfilled', true,
         'shipment_id', s.id,
         'carrier', s.carrier,
         'tracking_number', s.tracking_number,
         'status', s.status
       ),
       s.created_at
  FROM shipments s;

INSERT INTO order_events (shop_id, order_id, event_type, actor_type, source, payload, occurred_at)
SELECT r.shop_id, r.order_id, 'payment.refunded', 'migration', 'migration',
       jsonb_build_object('backfilled', true, 'amount_vnd', r.amount_vnd, 'reason', r.reason),
       r.created_at
  FROM refunds r;

INSERT INTO order_events (shop_id, order_id, event_type, actor_type, source, payload, occurred_at)
SELECT r.shop_id, r.order_id, 'return.completed', 'migration', 'migration',
       jsonb_build_object(
         'backfilled', true,
         'return_id', r.id,
         'refund_vnd', r.refund_vnd,
         'restocked', r.restocked,
         'reason', r.reason
       ),
       r.created_at
  FROM returns r;

ALTER TABLE order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_events FORCE ROW LEVEL SECURITY;

-- Default privileges của app_rw là CRUD; chứng từ timeline chỉ được ghi thêm.
REVOKE ALL ON order_events FROM PUBLIC, app_rw;
GRANT SELECT, INSERT ON order_events TO app_rw;
CREATE POLICY order_events_rw ON order_events FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

GRANT SELECT, INSERT ON order_events TO app_checkout;
CREATE POLICY order_events_checkout ON order_events FOR ALL TO app_checkout
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

GRANT INSERT ON order_events TO app_payment;
CREATE POLICY order_events_payment ON order_events FOR INSERT TO app_payment
  WITH CHECK (shop_id = current_shop_id());

-- app_expiry xử lý shipment xuyên shop và không mang tenant context. Vai này chỉ được ghi sự kiện,
-- không được đọc timeline hay sửa/xóa chứng từ.
GRANT INSERT ON order_events TO app_expiry;
CREATE POLICY order_events_expiry ON order_events FOR INSERT TO app_expiry WITH CHECK (true);

GRANT SELECT ON order_events TO app_customer;
CREATE POLICY order_events_customer ON order_events FOR SELECT TO app_customer
  USING (
    shop_id = current_shop_id()
    AND EXISTS (
      SELECT 1 FROM orders o
       WHERE o.id = order_events.order_id
         AND o.shop_id = order_events.shop_id
         AND o.customer_id = current_customer_id()
    )
  );

-- Helper invoker giữ một hình dạng event cho ba dịch vụ tenant. Nó không nâng quyền: caller vẫn
-- phải có INSERT và vẫn đi qua RLS của order_events.
CREATE FUNCTION record_order_event(
  p_order_id uuid,
  p_event_type text,
  p_actor_type text,
  p_actor_id text,
  p_source text,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_occurred_at timestamptz DEFAULT now()
) RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO order_events (
    shop_id, order_id, event_type, actor_type, actor_id, source, payload, occurred_at
  )
  SELECT current_shop_id(), o.id, p_event_type, p_actor_type, p_actor_id, p_source,
         coalesce(p_payload, '{}'::jsonb), coalesce(p_occurred_at, now())
    FROM orders o
   WHERE o.id = p_order_id AND o.shop_id = current_shop_id()
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'order_not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION record_order_event(uuid,text,text,text,text,jsonb,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_order_event(uuid,text,text,text,text,jsonb,timestamptz)
  TO app_rw, app_checkout, app_payment;

