-- 0168 - Biến ca delivered + returned thành một quy trình nhận hàng hoàn có chứng từ.
--
-- 0155 mới chỉ lưu một quyết định bằng chữ. Ca có thể bị đóng trong khi hàng hoàn chưa về, tồn chưa
-- được xử lý, hoặc số lượng không còn giải thích được theo từng dòng đơn. Migration này giữ snapshot
-- tại lúc mở ca, ghi từng lần nhận hàng hoàn append-only và nối ledger restock về đúng dòng nhận.

ALTER TABLE order_resolution_cases
  DROP CONSTRAINT order_resolution_cases_status_check,
  DROP CONSTRAINT order_resolution_cases_check,
  ADD COLUMN resolution_payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(resolution_payload) = 'object'),
  ADD COLUMN required_refund_vnd bigint NOT NULL DEFAULT 0
    CHECK (required_refund_vnd >= 0),
  ADD CONSTRAINT order_resolution_cases_status_check
    CHECK (status IN ('open','waiting_return','resolved')),
  ADD CONSTRAINT order_resolution_cases_check CHECK (
       (status IN ('open','waiting_return') AND resolution IS NULL AND resolved_at IS NULL)
    OR (status = 'resolved' AND resolution IS NOT NULL AND resolved_at IS NOT NULL)
  );

DROP INDEX order_resolution_one_open_idx;
CREATE UNIQUE INDEX order_resolution_one_open_idx
  ON order_resolution_cases (shop_id, order_id, kind)
  WHERE status IN ('open','waiting_return');

GRANT UPDATE (resolution_payload) ON order_resolution_cases TO app_rw;

-- Worker chỉ được mở ca; không được tự chốt thay seller bằng cách INSERT một dòng resolved.
DROP POLICY expiry_resolution_cases_insert ON order_resolution_cases;
REVOKE INSERT ON order_resolution_cases FROM app_expiry;

-- Các khóa bốn/ba cột làm đích cho FK composite bên dưới. id đã duy nhất toàn cục; thêm order/case
-- không đổi tính duy nhất mà buộc snapshot không thể trỏ sang dòng của đơn hoặc ca khác cùng shop.
CREATE UNIQUE INDEX order_lines_shop_order_id_variant_unique
  ON order_lines (shop_id, order_id, id, variant_id);
CREATE UNIQUE INDEX order_resolution_cases_shop_order_id_unique
  ON order_resolution_cases (shop_id, order_id, id);

CREATE TABLE order_resolution_case_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        uuid NOT NULL,
  case_id        uuid NOT NULL,
  order_id       uuid NOT NULL,
  order_line_id  uuid NOT NULL,
  variant_id     uuid NOT NULL,
  ordered_qty    int NOT NULL CHECK (ordered_qty > 0),
  delivered_qty  int NOT NULL CHECK (delivered_qty >= 0),
  returned_qty   int NOT NULL CHECK (returned_qty >= 0),
  unresolved_qty int NOT NULL CHECK (unresolved_qty >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (shop_id, id),
  UNIQUE (shop_id, case_id, order_line_id),
  UNIQUE (shop_id, case_id, id, variant_id),
  FOREIGN KEY (shop_id) REFERENCES shops(id),
  FOREIGN KEY (shop_id, order_id, case_id)
    REFERENCES order_resolution_cases(shop_id, order_id, id),
  FOREIGN KEY (shop_id, order_id, order_line_id, variant_id)
    REFERENCES order_lines(shop_id, order_id, id, variant_id),
  CHECK (delivered_qty + returned_qty + unresolved_qty = ordered_qty)
);
CREATE INDEX order_resolution_case_lines_case_idx
  ON order_resolution_case_lines (shop_id, case_id, order_line_id);

ALTER TABLE order_resolution_case_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_resolution_case_lines FORCE ROW LEVEL SECURITY;
REVOKE ALL ON order_resolution_case_lines FROM PUBLIC, app_rw, app_expiry;
GRANT SELECT ON order_resolution_case_lines TO app_rw;
GRANT SELECT ON order_resolution_case_lines TO app_expiry;
CREATE POLICY seller_resolution_case_lines ON order_resolution_case_lines
  FOR SELECT TO app_rw USING (shop_id = current_shop_id());
CREATE POLICY expiry_resolution_case_lines_read ON order_resolution_case_lines
  FOR SELECT TO app_expiry USING (true);

-- Backfill các ca đã mở trước 0168 bằng trạng thái shipment hiện tại. Nếu dữ liệu cũ đã giao/hoàn
-- vượt số đặt, CHECK tổng sẽ làm migration dừng để operator đối soát thay vì chôn snapshot sai.
-- Production chạy migration bằng app_owner NOBYPASSRLS, vì vậy mở đúng quyền tạm thời cho nguồn
-- và đích của backfill. Tất cả policy này bị gỡ ngay sau INSERT, không trở thành đường runtime.
CREATE POLICY resolution_0168_owner_cases_read ON order_resolution_cases
  FOR SELECT TO app_owner USING (true);
CREATE POLICY resolution_0168_owner_cases_update ON order_resolution_cases
  FOR UPDATE TO app_owner USING (true) WITH CHECK (true);
CREATE POLICY resolution_0168_owner_orders_read ON orders
  FOR SELECT TO app_owner USING (true);
CREATE POLICY resolution_0168_owner_order_lines_read ON order_lines
  FOR SELECT TO app_owner USING (true);
CREATE POLICY resolution_0168_owner_shipment_lines_read ON shipment_lines
  FOR SELECT TO app_owner USING (true);
CREATE POLICY resolution_0168_owner_shipments_read ON shipments
  FOR SELECT TO app_owner USING (true);
CREATE POLICY resolution_0168_owner_case_lines_insert ON order_resolution_case_lines
  FOR INSERT TO app_owner WITH CHECK (true);

WITH line_totals AS (
  SELECT rc.shop_id, rc.id AS case_id, rc.order_id,
         ol.id AS order_line_id, ol.variant_id, ol.qty AS ordered_qty,
         coalesce(sum(sl.qty) FILTER (WHERE s.status = 'delivered'), 0)::int AS delivered_qty,
         coalesce(sum(sl.qty) FILTER (WHERE s.status = 'returned'), 0)::int AS returned_qty
    FROM order_resolution_cases rc
    JOIN order_lines ol
      ON ol.shop_id = rc.shop_id AND ol.order_id = rc.order_id
    LEFT JOIN shipment_lines sl
      ON sl.shop_id = rc.shop_id AND sl.order_line_id = ol.id
    LEFT JOIN shipments s
      ON s.shop_id = rc.shop_id AND s.id = sl.shipment_id
     AND s.order_id = rc.order_id AND s.status <> 'cancelled'
   GROUP BY rc.shop_id, rc.id, rc.order_id, ol.id, ol.variant_id, ol.qty
)
INSERT INTO order_resolution_case_lines (
  shop_id, case_id, order_id, order_line_id, variant_id,
  ordered_qty, delivered_qty, returned_qty, unresolved_qty
)
SELECT shop_id, case_id, order_id, order_line_id, variant_id,
       ordered_qty, delivered_qty, returned_qty,
       ordered_qty - delivered_qty - returned_qty
  FROM line_totals;

-- Active legacy cases receive the minimum refund snapshot. Resolved legacy cases stay at zero
-- because older rows do not retain enough evidence to reconstruct an already-completed decision.
WITH refund_basis AS (
  SELECT rc.shop_id, rc.id AS case_id,
         o.subtotal_vnd, o.discount_vnd, o.points_discount_vnd,
         o.total_vnd, o.amount_paid_vnd, o.paid_at,
         coalesce(sum(cl.returned_qty::bigint * ol.unit_price_vnd), 0)::bigint AS returned_gross_vnd
    FROM order_resolution_cases rc
    JOIN orders o
      ON o.shop_id = rc.shop_id AND o.id = rc.order_id
    JOIN order_resolution_case_lines cl
      ON cl.shop_id = rc.shop_id AND cl.case_id = rc.id
    JOIN order_lines ol
      ON ol.shop_id = cl.shop_id AND ol.id = cl.order_line_id
   WHERE rc.status IN ('open', 'waiting_return')
   GROUP BY rc.shop_id, rc.id,
            o.subtotal_vnd, o.discount_vnd, o.points_discount_vnd,
            o.total_vnd, o.amount_paid_vnd, o.paid_at
), required_refunds AS (
  SELECT shop_id, case_id,
         least(
           CASE
             WHEN subtotal_vnd <= 0 OR returned_gross_vnd <= 0 THEN 0::numeric
             ELSE ceil(
               returned_gross_vnd::numeric
               * greatest(0::bigint, subtotal_vnd - discount_vnd - points_discount_vnd)::numeric
               / subtotal_vnd::numeric
             )
           END,
           greatest(0::bigint, total_vnd)::numeric,
           greatest(0::bigint, CASE
             WHEN amount_paid_vnd > 0 THEN amount_paid_vnd
             WHEN paid_at IS NOT NULL THEN total_vnd
             ELSE 0
           END)::numeric
         )::bigint AS required_refund_vnd
    FROM refund_basis
)
UPDATE order_resolution_cases rc
   SET required_refund_vnd = rr.required_refund_vnd
  FROM required_refunds rr
 WHERE rc.shop_id = rr.shop_id
   AND rc.id = rr.case_id;

DROP POLICY resolution_0168_owner_cases_read ON order_resolution_cases;
DROP POLICY resolution_0168_owner_cases_update ON order_resolution_cases;
DROP POLICY resolution_0168_owner_orders_read ON orders;
DROP POLICY resolution_0168_owner_order_lines_read ON order_lines;
DROP POLICY resolution_0168_owner_shipment_lines_read ON shipment_lines;
DROP POLICY resolution_0168_owner_shipments_read ON shipments;
DROP POLICY resolution_0168_owner_case_lines_insert ON order_resolution_case_lines;

-- Worker cần id dòng đơn để tạo snapshot cho ca phát sinh sau migration; các cột còn lại đã được cấp
-- từ 0022. 0155 đã GRANT shipment_lines nhưng thiếu policy nên FORCE RLS vẫn trả rỗng; mở đúng SELECT
-- xuyên shop cho poller, không mở ghi chứng từ shipment.
GRANT SELECT (id) ON order_lines TO app_expiry;
CREATE POLICY expiry_shipment_lines_resolution_read ON shipment_lines
  FOR SELECT TO app_expiry USING (true);

-- app_expiry la LOGIN role cross-shop, vi vay khong duoc tu ghi bang chung phat hien. Ham hep nay
-- khoa order, tu tinh ket qua terminal tu shipment va ghi case + snapshot trong cung transaction.
DO $$ BEGIN
  CREATE ROLE app_resolution_detector NOLOGIN
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER ROLE app_resolution_detector NOLOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO app_resolution_detector;
GRANT SELECT ON orders, order_lines, shipments, shipment_lines, order_resolution_cases
  TO app_resolution_detector;
-- SELECT ... FOR UPDATE needs one UPDATE column privilege; no UPDATE policy is granted,
-- so the role can lock the order but cannot mutate it.
GRANT UPDATE (id) ON orders TO app_resolution_detector;
GRANT INSERT ON order_resolution_cases, order_resolution_case_lines
  TO app_resolution_detector;

CREATE POLICY resolution_detector_orders_read ON orders
  FOR SELECT TO app_resolution_detector USING (true);
-- PostgreSQL áp dụng policy UPDATE cho SELECT ... FOR UPDATE. Chỉ cấp quyền cột id mà không có
-- policy này sẽ không báo lỗi: câu khóa chỉ âm thầm trả 0 dòng, làm detector không bao giờ mở case.
-- WITH CHECK false vẫn cho khóa dòng nhưng chặn mọi UPDATE thật, kể cả câu tự gán id = id.
CREATE POLICY resolution_detector_orders_lock ON orders
  FOR UPDATE TO app_resolution_detector USING (true) WITH CHECK (false);
CREATE POLICY resolution_detector_order_lines_read ON order_lines
  FOR SELECT TO app_resolution_detector USING (true);
CREATE POLICY resolution_detector_shipments_read ON shipments
  FOR SELECT TO app_resolution_detector USING (true);
CREATE POLICY resolution_detector_shipment_lines_read ON shipment_lines
  FOR SELECT TO app_resolution_detector USING (true);
CREATE POLICY resolution_detector_cases_read ON order_resolution_cases
  FOR SELECT TO app_resolution_detector USING (true);
CREATE POLICY resolution_detector_cases_insert ON order_resolution_cases
  FOR INSERT TO app_resolution_detector WITH CHECK (
    status = 'open'
    AND resolution IS NULL
    AND resolution_note IS NULL
    AND resolved_at IS NULL
    AND resolved_by IS NULL
    AND resolution_payload = '{}'::jsonb
  );
CREATE POLICY resolution_detector_case_lines_insert ON order_resolution_case_lines
  FOR INSERT TO app_resolution_detector WITH CHECK (true);

CREATE FUNCTION open_mixed_shipment_resolution(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order record;
  v_case_id uuid;
  v_existing_id uuid;
  v_has_delivered boolean;
  v_has_returned boolean;
  v_has_active boolean;
  v_snapshot_lines int;
  v_delivered int;
  v_returned int;
  v_unresolved int;
  v_unresolved_lines int;
  v_over_accounted_lines int;
  v_returned_gross bigint;
  v_merchandise_net bigint;
  v_required_refund bigint;
BEGIN
  SELECT o.id, o.shop_id, o.status, o.subtotal_vnd, o.discount_vnd,
         o.points_discount_vnd, o.total_vnd, o.amount_paid_vnd, o.paid_at
    INTO v_order
    FROM orders o
   WHERE o.id = p_order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('opened', false, 'reason', 'order_not_found');
  END IF;

  SELECT rc.id INTO v_existing_id
    FROM order_resolution_cases rc
   WHERE rc.shop_id = v_order.shop_id
     AND rc.order_id = p_order_id
     AND rc.kind = 'mixed_shipment_outcome'
     AND rc.status IN ('open', 'waiting_return');
  IF FOUND THEN
    RETURN jsonb_build_object(
      'opened', false, 'reason', 'already_open', 'case_id', v_existing_id
    );
  END IF;

  SELECT bool_or(s.status = 'delivered'),
         bool_or(s.status = 'returned'),
         bool_or(s.status IN ('created', 'in_transit'))
    INTO v_has_delivered, v_has_returned, v_has_active
    FROM shipments s
   WHERE s.shop_id = v_order.shop_id
     AND s.order_id = p_order_id
     AND s.status <> 'cancelled';
  IF NOT coalesce(v_has_delivered, false)
     OR NOT coalesce(v_has_returned, false)
     OR coalesce(v_has_active, false) THEN
    RETURN jsonb_build_object('opened', false, 'reason', 'not_mixed_terminal');
  END IF;

  WITH line_totals AS (
    SELECT ol.id AS order_line_id, ol.variant_id, ol.qty AS ordered_qty,
           ol.unit_price_vnd,
           coalesce(sum(sl.qty) FILTER (WHERE s.status = 'delivered'), 0)::int AS delivered_qty,
           coalesce(sum(sl.qty) FILTER (WHERE s.status = 'returned'), 0)::int AS returned_qty
      FROM order_lines ol
      LEFT JOIN shipment_lines sl
        ON sl.shop_id = v_order.shop_id AND sl.order_line_id = ol.id
      LEFT JOIN shipments s
        ON s.shop_id = v_order.shop_id AND s.id = sl.shipment_id
       AND s.order_id = p_order_id AND s.status <> 'cancelled'
     WHERE ol.shop_id = v_order.shop_id AND ol.order_id = p_order_id
     GROUP BY ol.id, ol.variant_id, ol.qty, ol.unit_price_vnd
  )
  SELECT count(*)::int,
         coalesce(sum(delivered_qty), 0)::int,
         coalesce(sum(returned_qty), 0)::int,
         coalesce(sum(ordered_qty - delivered_qty - returned_qty), 0)::int,
         count(*) FILTER (
           WHERE ordered_qty - delivered_qty - returned_qty > 0
         )::int,
         count(*) FILTER (
           WHERE ordered_qty - delivered_qty - returned_qty < 0
         )::int,
         coalesce(sum(returned_qty::bigint * unit_price_vnd), 0)::bigint
    INTO v_snapshot_lines, v_delivered, v_returned, v_unresolved,
         v_unresolved_lines, v_over_accounted_lines, v_returned_gross
    FROM line_totals;

  IF v_snapshot_lines = 0 OR v_delivered <= 0 OR v_returned <= 0 THEN
    RETURN jsonb_build_object('opened', false, 'reason', 'not_mixed_terminal');
  END IF;
  IF v_over_accounted_lines > 0 THEN
    RAISE EXCEPTION 'resolution_snapshot_over_accounted'
      USING ERRCODE = '23514', CONSTRAINT = 'mixed_resolution_snapshot_over_accounted';
  END IF;
  IF v_unresolved_lines > 0 THEN
    RETURN jsonb_build_object(
      'opened', false,
      'reason', 'shipment_qty_unresolved',
      'unresolved_qty', v_unresolved
    );
  END IF;

  v_merchandise_net := greatest(
    0::bigint,
    v_order.subtotal_vnd - v_order.discount_vnd - v_order.points_discount_vnd
  );
  v_required_refund := CASE
    WHEN v_order.subtotal_vnd <= 0 OR v_returned_gross <= 0 THEN 0
    ELSE ((v_returned_gross * v_merchandise_net) + v_order.subtotal_vnd - 1)
         / v_order.subtotal_vnd
  END;
  v_required_refund := least(
    v_required_refund,
    greatest(0::bigint, v_order.total_vnd),
    greatest(0::bigint, CASE
      WHEN v_order.amount_paid_vnd > 0 THEN v_order.amount_paid_vnd
      WHEN v_order.paid_at IS NOT NULL THEN v_order.total_vnd
      ELSE 0
    END)
  );

  INSERT INTO order_resolution_cases (
    shop_id, order_id, kind, status, required_refund_vnd
  ) VALUES (
    v_order.shop_id, p_order_id, 'mixed_shipment_outcome', 'open', v_required_refund
  )
  RETURNING id INTO v_case_id;

  WITH line_totals AS (
    SELECT ol.id AS order_line_id, ol.variant_id, ol.qty AS ordered_qty,
           coalesce(sum(sl.qty) FILTER (WHERE s.status = 'delivered'), 0)::int AS delivered_qty,
           coalesce(sum(sl.qty) FILTER (WHERE s.status = 'returned'), 0)::int AS returned_qty
      FROM order_lines ol
      LEFT JOIN shipment_lines sl
        ON sl.shop_id = v_order.shop_id AND sl.order_line_id = ol.id
      LEFT JOIN shipments s
        ON s.shop_id = v_order.shop_id AND s.id = sl.shipment_id
       AND s.order_id = p_order_id AND s.status <> 'cancelled'
     WHERE ol.shop_id = v_order.shop_id AND ol.order_id = p_order_id
     GROUP BY ol.id, ol.variant_id, ol.qty
  ), inserted AS (
    INSERT INTO order_resolution_case_lines (
      shop_id, case_id, order_id, order_line_id, variant_id,
      ordered_qty, delivered_qty, returned_qty, unresolved_qty
    )
    SELECT v_order.shop_id, v_case_id, p_order_id, order_line_id, variant_id,
           ordered_qty, delivered_qty, returned_qty,
           ordered_qty - delivered_qty - returned_qty
      FROM line_totals
    RETURNING 1
  )
  SELECT count(*)::int INTO v_unresolved_lines FROM inserted;

  IF v_unresolved_lines <> v_snapshot_lines THEN
    RAISE EXCEPTION 'resolution_snapshot_insert_mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'mixed_resolution_snapshot_insert_count';
  END IF;

  RETURN jsonb_build_object(
    'opened', true,
    'case_id', v_case_id,
    'shop_id', v_order.shop_id,
    'order_id', p_order_id,
    'snapshot_lines', v_snapshot_lines,
    'delivered_qty', v_delivered,
    'returned_qty', v_returned,
    'unresolved_qty', v_unresolved,
    'required_refund_vnd', v_required_refund
  );
END;
$$;

REVOKE ALL ON FUNCTION open_mixed_shipment_resolution(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION open_mixed_shipment_resolution(uuid) TO app_expiry;
GRANT app_resolution_detector TO app_owner;
GRANT CREATE ON SCHEMA public TO app_resolution_detector;
ALTER FUNCTION open_mixed_shipment_resolution(uuid) OWNER TO app_resolution_detector;
REVOKE app_resolution_detector FROM app_owner;
REVOKE CREATE ON SCHEMA public FROM app_resolution_detector;

REVOKE INSERT ON order_resolution_cases, order_resolution_case_lines FROM app_expiry;

CREATE TABLE order_resolution_return_receipts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         uuid NOT NULL,
  case_id         uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_hash    text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  disposition     text NOT NULL CHECK (disposition IN ('restock','quarantine')),
  note            text CHECK (note IS NULL OR char_length(note) <= 1000),
  received_by     uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (shop_id, id),
  UNIQUE (shop_id, case_id, id),
  UNIQUE (shop_id, case_id, idempotency_key),
  FOREIGN KEY (shop_id) REFERENCES shops(id),
  FOREIGN KEY (shop_id, case_id) REFERENCES order_resolution_cases(shop_id, id)
);
CREATE INDEX order_resolution_return_receipts_case_idx
  ON order_resolution_return_receipts (shop_id, case_id, created_at, id);

CREATE TABLE order_resolution_return_receipt_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL,
  case_id      uuid NOT NULL,
  receipt_id   uuid NOT NULL,
  case_line_id uuid NOT NULL,
  variant_id   uuid NOT NULL,
  qty          int NOT NULL CHECK (qty > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE (shop_id, id),
  UNIQUE (shop_id, receipt_id, case_line_id),
  UNIQUE (shop_id, id, variant_id, qty),
  FOREIGN KEY (shop_id) REFERENCES shops(id),
  FOREIGN KEY (shop_id, case_id, receipt_id)
    REFERENCES order_resolution_return_receipts(shop_id, case_id, id),
  FOREIGN KEY (shop_id, case_id, case_line_id, variant_id)
    REFERENCES order_resolution_case_lines(shop_id, case_id, id, variant_id)
);
CREATE INDEX order_resolution_return_receipt_lines_case_idx
  ON order_resolution_return_receipt_lines (shop_id, case_id, case_line_id);

ALTER TABLE order_resolution_return_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_resolution_return_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE order_resolution_return_receipt_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_resolution_return_receipt_lines FORCE ROW LEVEL SECURITY;

REVOKE ALL ON order_resolution_return_receipts,
              order_resolution_return_receipt_lines
  FROM PUBLIC, app_rw, app_expiry;
GRANT SELECT ON order_resolution_return_receipts,
                order_resolution_return_receipt_lines
  TO app_rw;
CREATE POLICY tenant_isolation ON order_resolution_return_receipts FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY tenant_isolation ON order_resolution_return_receipt_lines FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- Dòng ledger có nguồn receipt là khóa exactly-once của restock. Replay cùng idempotency key trả
-- chứng từ cũ; key khác nhưng nhận vượt returned_qty bị transaction seller chặn dưới khóa case.
ALTER TABLE inventory_ledger
  ADD COLUMN resolution_receipt_line_id uuid,
  ADD CONSTRAINT inventory_ledger_resolution_receipt_fk
    FOREIGN KEY (shop_id, resolution_receipt_line_id, variant_id, delta)
    REFERENCES order_resolution_return_receipt_lines(shop_id, id, variant_id, qty),
  ADD CONSTRAINT inventory_ledger_resolution_receipt_kind_check
    CHECK (resolution_receipt_line_id IS NULL OR kind = 'receive');
CREATE UNIQUE INDEX inventory_ledger_resolution_receipt_once
  ON inventory_ledger (shop_id, resolution_receipt_line_id)
  WHERE resolution_receipt_line_id IS NOT NULL;

-- Một phiếu refund chỉ được dùng làm bằng chứng đóng một ca. Dùng text expression để index vẫn
-- fail-safe với payload cũ; trigger bên dưới mới chịu trách nhiệm kiểm UUID + FK nghiệp vụ.
CREATE UNIQUE INDEX order_resolution_refund_once_idx
  ON order_resolution_cases (shop_id, (resolution_payload->>'refund_id'))
  WHERE status = 'resolved' AND resolution_payload ? 'refund_id';

-- Serial hóa mọi lần nhận hàng cùng một case, kể cả caller cố INSERT thẳng bỏ qua route. Nhờ khóa
-- case, deferred aggregate check ở cuối transaction luôn nhìn thấy lần nhận đã commit trước đó.
CREATE FUNCTION lock_resolution_return_case()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM 1
    FROM order_resolution_cases rc
   WHERE rc.shop_id = NEW.shop_id
     AND rc.id = NEW.case_id
     AND rc.status IN ('open', 'waiting_return')
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolution_case_not_active'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION lock_resolution_return_case() FROM PUBLIC;

CREATE TRIGGER resolution_return_case_lock
  BEFORE INSERT ON order_resolution_return_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION lock_resolution_return_case();

-- Header/line được ghi trước ledger, audit và timeline nên kiểm ở cuối transaction. Đây là chốt
-- chống app_rw INSERT trực tiếp tạo phiếu rỗng, nhận quá số hãng báo hoặc restock không có ledger.
CREATE FUNCTION enforce_resolution_return_receipt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order_id uuid;
BEGIN
  SELECT rc.order_id INTO v_order_id
    FROM order_resolution_cases rc
   WHERE rc.shop_id = NEW.shop_id
     AND rc.id = NEW.case_id;

  IF NOT EXISTS (
    SELECT 1
      FROM order_resolution_return_receipt_lines rl
     WHERE rl.shop_id = NEW.shop_id
       AND rl.receipt_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'resolution_return_receipt_empty'
      USING ERRCODE = '23514', CONSTRAINT = 'resolution_return_receipt_requires_lines';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM audit_logs a
     WHERE a.shop_id = NEW.shop_id
       AND a.action = 'order.resolution_return_received'
       AND a.actor_id = NEW.received_by
       AND a.metadata->>'receipt_id' = NEW.id::text
  ) OR NOT EXISTS (
    SELECT 1
      FROM order_events e
     WHERE e.shop_id = NEW.shop_id
       AND e.order_id = v_order_id
       AND e.event_type = 'resolution.return_received'
       AND e.actor_id = NEW.received_by
       AND e.payload->>'receipt_id' = NEW.id::text
  ) THEN
    RAISE EXCEPTION 'resolution_return_receipt_evidence_missing'
      USING ERRCODE = '23514', CONSTRAINT = 'resolution_return_receipt_requires_evidence';
  END IF;

  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION enforce_resolution_return_receipt() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER resolution_return_receipt_integrity
  AFTER INSERT ON order_resolution_return_receipts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_resolution_return_receipt();

CREATE FUNCTION enforce_resolution_return_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_returned int;
  v_received int;
  v_disposition text;
  v_ledger_total int;
  v_ledger_matching int;
BEGIN
  SELECT cl.returned_qty, rr.disposition
    INTO v_returned, v_disposition
    FROM order_resolution_case_lines cl
    JOIN order_resolution_return_receipts rr
      ON rr.shop_id = NEW.shop_id
     AND rr.case_id = NEW.case_id
     AND rr.id = NEW.receipt_id
   WHERE cl.shop_id = NEW.shop_id
     AND cl.case_id = NEW.case_id
     AND cl.id = NEW.case_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolution_return_line_reference_invalid'
      USING ERRCODE = '23503';
  END IF;

  SELECT coalesce(sum(rl.qty), 0)::int
    INTO v_received
    FROM order_resolution_return_receipt_lines rl
   WHERE rl.shop_id = NEW.shop_id
     AND rl.case_line_id = NEW.case_line_id;
  IF v_received > v_returned THEN
    RAISE EXCEPTION 'resolution_return_qty_exceeds_snapshot'
      USING ERRCODE = '23514', CONSTRAINT = 'resolution_return_qty_cap';
  END IF;

  SELECT count(*)::int,
         count(*) FILTER (
           WHERE il.variant_id = NEW.variant_id
             AND il.delta = NEW.qty
             AND il.kind = 'receive'
         )::int
    INTO v_ledger_total, v_ledger_matching
    FROM inventory_ledger il
   WHERE il.shop_id = NEW.shop_id
     AND il.resolution_receipt_line_id = NEW.id;

  IF v_disposition = 'restock' AND (v_ledger_total <> 1 OR v_ledger_matching <> 1) THEN
    RAISE EXCEPTION 'resolution_restock_ledger_missing_or_mismatched'
      USING ERRCODE = '23514', CONSTRAINT = 'resolution_restock_requires_exact_ledger';
  ELSIF v_disposition = 'quarantine' AND v_ledger_total <> 0 THEN
    RAISE EXCEPTION 'resolution_quarantine_must_not_change_inventory'
      USING ERRCODE = '23514', CONSTRAINT = 'resolution_quarantine_forbids_ledger';
  END IF;

  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION enforce_resolution_return_line() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER resolution_return_line_integrity
  AFTER INSERT ON order_resolution_return_receipt_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_resolution_return_line();

-- Chặn ledger gắn vào quarantine ngay tại câu INSERT; deferred line trigger tiếp tục chứng minh
-- chiều ngược lại: mọi restock line bắt buộc có đúng một ledger.
CREATE FUNCTION guard_resolution_receipt_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_disposition text;
  v_variant uuid;
  v_qty int;
BEGIN
  IF NEW.resolution_receipt_line_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT rr.disposition, rl.variant_id, rl.qty
    INTO v_disposition, v_variant, v_qty
    FROM order_resolution_return_receipt_lines rl
    JOIN order_resolution_return_receipts rr
      ON rr.shop_id = rl.shop_id
     AND rr.case_id = rl.case_id
     AND rr.id = rl.receipt_id
   WHERE rl.shop_id = NEW.shop_id
     AND rl.id = NEW.resolution_receipt_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolution_receipt_line_not_found'
      USING ERRCODE = '23503';
  END IF;
  IF v_disposition <> 'restock'
     OR NEW.kind <> 'receive'
     OR NEW.variant_id <> v_variant
     OR NEW.delta <> v_qty THEN
    RAISE EXCEPTION 'resolution_receipt_ledger_mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'resolution_receipt_ledger_exact_match';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_resolution_receipt_ledger() FROM PUBLIC;

CREATE TRIGGER resolution_receipt_ledger_guard
  BEFORE INSERT OR UPDATE ON inventory_ledger
  FOR EACH ROW EXECUTE FUNCTION guard_resolution_receipt_ledger();

-- app_rw vẫn giữ UPDATE cột từ 0155 để route seller hoạt động, nhưng mọi chuyển trạng thái đều bị
-- chứng minh lại bằng snapshot, chứng từ nhận hàng, trạng thái order và bằng chứng tài chính.
CREATE FUNCTION guard_order_resolution_case_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lines int;
  v_delivered int;
  v_returned int;
  v_unresolved int;
  v_received int;
  v_order_status text;
  v_fulfillment text;
  v_payment_status text;
  v_amount_paid bigint;
  v_paid_at timestamptz;
  v_action text;
  v_refund_text text;
  v_refund_amount bigint;
  v_refund_selected int;
BEGIN
  IF NEW.required_refund_vnd IS DISTINCT FROM OLD.required_refund_vnd THEN
    RAISE EXCEPTION 'resolution_required_refund_is_immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'order_resolution_required_refund_immutable';
  END IF;

  IF OLD.status = 'resolved' THEN
    RAISE EXCEPTION 'resolved_case_is_immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'order_resolution_resolved_immutable';
  END IF;

  IF NEW.status IN ('open', 'waiting_return') THEN
    IF NEW.resolution IS NOT NULL
       OR NEW.resolution_note IS NOT NULL
       OR NEW.resolved_at IS NOT NULL
       OR NEW.resolved_by IS NOT NULL
       OR NEW.resolution_payload <> '{}'::jsonb THEN
      RAISE EXCEPTION 'active_case_cannot_have_resolution_fields'
        USING ERRCODE = '23514', CONSTRAINT = 'order_resolution_active_fields_empty';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status <> 'resolved'
     OR NEW.resolution <> 'accept_partial'
     OR nullif(btrim(NEW.resolution_note), '') IS NULL
     OR NEW.resolved_at IS NULL
     OR NEW.resolved_by IS NULL THEN
    RAISE EXCEPTION 'unsupported_or_incomplete_resolution'
      USING ERRCODE = '23514', CONSTRAINT = 'order_resolution_accept_partial_only';
  END IF;

  SELECT count(*)::int,
         coalesce(sum(cl.delivered_qty), 0)::int,
         coalesce(sum(cl.returned_qty), 0)::int,
         coalesce(sum(cl.unresolved_qty), 0)::int,
         coalesce((
           SELECT sum(rl.qty)::int
             FROM order_resolution_return_receipt_lines rl
            WHERE rl.shop_id = NEW.shop_id
              AND rl.case_id = NEW.id
         ), 0)::int
    INTO v_lines, v_delivered, v_returned, v_unresolved, v_received
    FROM order_resolution_case_lines cl
   WHERE cl.shop_id = NEW.shop_id
     AND cl.case_id = NEW.id;

  IF v_lines = 0 OR v_delivered <= 0 OR v_unresolved <> 0 OR v_received <> v_returned THEN
    RAISE EXCEPTION 'resolution_quantities_not_ready'
      USING ERRCODE = '23514', CONSTRAINT = 'order_resolution_quantities_ready';
  END IF;

  SELECT o.status, o.fulfillment_status, o.payment_status, o.amount_paid_vnd, o.paid_at
    INTO v_order_status, v_fulfillment, v_payment_status, v_amount_paid, v_paid_at
    FROM orders o
   WHERE o.shop_id = NEW.shop_id
     AND o.id = NEW.order_id;
  IF NOT FOUND OR v_order_status <> 'delivered' OR v_fulfillment <> 'partial' THEN
    RAISE EXCEPTION 'resolution_order_state_not_finalized'
      USING ERRCODE = '23514', CONSTRAINT = 'order_resolution_order_partial_delivered';
  END IF;

  v_action := NEW.resolution_payload->>'financial_action';
  v_refund_text := nullif(NEW.resolution_payload->>'refund_id', '');
  IF v_action = 'handled_separately' THEN
    IF v_refund_text IS NULL
       OR v_refund_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'resolution_refund_evidence_invalid'
        USING ERRCODE = '23514', CONSTRAINT = 'order_resolution_refund_evidence';
    END IF;
    SELECT coalesce(sum(r.amount_vnd), 0)::bigint,
           count(*) FILTER (WHERE r.id = v_refund_text::uuid)::int
      INTO v_refund_amount, v_refund_selected
      FROM refunds r
     WHERE r.shop_id = NEW.shop_id
       AND r.order_id = NEW.order_id
       AND r.kind <> 'edit_adjustment'
       AND r.created_at >= OLD.detected_at;
    IF v_refund_selected <> 1 OR v_refund_amount < NEW.required_refund_vnd THEN
      RAISE EXCEPTION 'resolution_refund_evidence_invalid'
        USING ERRCODE = '23514', CONSTRAINT = 'order_resolution_refund_evidence';
    END IF;
  ELSIF v_action = 'not_required' THEN
    IF v_refund_text IS NOT NULL
       OR v_payment_status IN ('paid', 'refunded')
       OR coalesce(v_amount_paid, 0) > 0
       OR v_paid_at IS NOT NULL THEN
      RAISE EXCEPTION 'resolution_refund_evidence_required_for_paid_order'
        USING ERRCODE = '23514', CONSTRAINT = 'order_resolution_paid_requires_refund';
    END IF;
  ELSE
    RAISE EXCEPTION 'resolution_financial_action_invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'order_resolution_financial_action';
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_order_resolution_case_transition() FROM PUBLIC;

CREATE TRIGGER order_resolution_case_transition_guard
  BEFORE UPDATE OF status, resolution, resolution_note, resolution_payload,
                   required_refund_vnd, resolved_at, resolved_by
  ON order_resolution_cases
  FOR EACH ROW EXECUTE FUNCTION guard_order_resolution_case_transition();

CREATE FUNCTION enforce_order_resolution_completion_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'resolved' AND OLD.status <> 'resolved' THEN
    IF NOT EXISTS (
      SELECT 1 FROM audit_logs a
       WHERE a.shop_id = NEW.shop_id
         AND a.action = 'order.resolution_case_resolved'
         AND a.actor_id = NEW.resolved_by
         AND a.metadata->>'case_id' = NEW.id::text
    ) OR NOT EXISTS (
      SELECT 1 FROM order_events e
       WHERE e.shop_id = NEW.shop_id
         AND e.order_id = NEW.order_id
         AND e.event_type = 'resolution.completed'
         AND e.actor_id = NEW.resolved_by
         AND e.payload->>'case_id' = NEW.id::text
    ) THEN
      RAISE EXCEPTION 'resolution_completion_evidence_missing'
        USING ERRCODE = '23514', CONSTRAINT = 'order_resolution_completion_requires_evidence';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION enforce_order_resolution_completion_evidence() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER order_resolution_completion_evidence
  AFTER UPDATE ON order_resolution_cases
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_order_resolution_completion_evidence();

-- app_rw không còn được tự INSERT chứng từ hoặc UPDATE case. Bốn hàm SECURITY DEFINER bên dưới
-- là bề mặt ghi hẹp: khóa case, tạo header/line, chuyển active status và chốt accept_partial.
DO $$ BEGIN
  CREATE ROLE app_resolution NOLOGIN
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER ROLE app_resolution NOLOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO app_resolution;
GRANT SELECT ON order_resolution_cases TO app_resolution;
GRANT UPDATE (status, resolution, resolution_note, resolution_payload, resolved_at, resolved_by)
  ON order_resolution_cases TO app_resolution;
GRANT SELECT ON order_resolution_case_lines,
                order_resolution_return_receipts,
                order_resolution_return_receipt_lines,
                refunds,
                audit_logs,
                order_events,
                inventory_ledger,
                memberships
  TO app_resolution;
GRANT INSERT ON order_resolution_return_receipts,
                order_resolution_return_receipt_lines
  TO app_resolution;
GRANT SELECT ON orders TO app_resolution;
GRANT UPDATE (status, fulfillment_status, delivered_at) ON orders TO app_resolution;

CREATE POLICY resolution_service_cases_read ON order_resolution_cases
  FOR SELECT TO app_resolution USING (shop_id = current_shop_id());
CREATE POLICY resolution_service_cases_update ON order_resolution_cases
  FOR UPDATE TO app_resolution
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY resolution_service_case_lines_read ON order_resolution_case_lines
  FOR SELECT TO app_resolution USING (shop_id = current_shop_id());
CREATE POLICY resolution_service_receipts_read ON order_resolution_return_receipts
  FOR SELECT TO app_resolution USING (shop_id = current_shop_id());
CREATE POLICY resolution_service_receipts_insert ON order_resolution_return_receipts
  FOR INSERT TO app_resolution WITH CHECK (shop_id = current_shop_id());
CREATE POLICY resolution_service_receipt_lines_read ON order_resolution_return_receipt_lines
  FOR SELECT TO app_resolution USING (shop_id = current_shop_id());
CREATE POLICY resolution_service_receipt_lines_insert ON order_resolution_return_receipt_lines
  FOR INSERT TO app_resolution WITH CHECK (shop_id = current_shop_id());
CREATE POLICY resolution_service_orders_read ON orders
  FOR SELECT TO app_resolution USING (shop_id = current_shop_id());
CREATE POLICY resolution_service_orders_update ON orders
  FOR UPDATE TO app_resolution
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
-- users không tenant-scoped; chỉ cần FK received_by/resolved_by kiểm tồn tại. Không tạo policy mới
-- vì bảng FORCE RLS đã có các policy danh tính riêng và FK chạy với quyền owner của bảng.
CREATE POLICY resolution_service_refunds_read ON refunds
  FOR SELECT TO app_resolution USING (shop_id = current_shop_id());
CREATE POLICY resolution_service_audit_read ON audit_logs
  FOR SELECT TO app_resolution USING (shop_id = current_shop_id());
CREATE POLICY resolution_service_events_read ON order_events
  FOR SELECT TO app_resolution USING (shop_id = current_shop_id());
CREATE POLICY resolution_service_inventory_ledger_read ON inventory_ledger
  FOR SELECT TO app_resolution USING (shop_id = current_shop_id());
CREATE POLICY resolution_service_memberships_read ON memberships
  FOR SELECT TO app_resolution USING (shop_id = current_shop_id());

CREATE FUNCTION lock_current_order_resolution_case(p_case_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM 1
    FROM order_resolution_cases
   WHERE shop_id = current_shop_id()
     AND id = p_case_id
   FOR UPDATE;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION create_order_resolution_return_receipt(
  p_case_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_disposition text,
  p_note text,
  p_received_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.shop_id = current_shop_id()
       AND m.user_id = p_received_by
       AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'resolution_receiver_not_authorized' USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM order_resolution_cases
   WHERE shop_id = current_shop_id()
     AND id = p_case_id
     AND status IN ('open', 'waiting_return')
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolution_case_not_active' USING ERRCODE = '55000';
  END IF;

  INSERT INTO order_resolution_return_receipts
    (shop_id, case_id, idempotency_key, request_hash, disposition, note, received_by)
  VALUES
    (current_shop_id(), p_case_id, p_idempotency_key, p_request_hash,
     p_disposition, p_note, p_received_by)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE FUNCTION create_order_resolution_return_receipt_line(
  p_case_id uuid,
  p_receipt_id uuid,
  p_case_line_id uuid,
  p_variant_id uuid,
  p_qty int
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO order_resolution_return_receipt_lines
    (shop_id, case_id, receipt_id, case_line_id, variant_id, qty)
  VALUES
    (current_shop_id(), p_case_id, p_receipt_id, p_case_line_id, p_variant_id, p_qty)
  RETURNING id
$$;

CREATE FUNCTION set_order_resolution_active_status(p_case_id uuid, p_status text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_status NOT IN ('open', 'waiting_return') THEN
    RAISE EXCEPTION 'resolution_active_status_invalid' USING ERRCODE = '22023';
  END IF;
  UPDATE order_resolution_cases
     SET status = p_status
   WHERE shop_id = current_shop_id()
     AND id = p_case_id
     AND status IN ('open', 'waiting_return');
  RETURN FOUND;
END;
$$;

CREATE FUNCTION complete_order_resolution_accept_partial(
  p_case_id uuid,
  p_note text,
  p_financial_action text,
  p_refund_id uuid,
  p_resolved_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_case order_resolution_cases%ROWTYPE;
  v_delivered int;
  v_returned int;
  v_received int;
  v_refund_amount bigint;
  v_refund_selected int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.shop_id = current_shop_id()
       AND m.user_id = p_resolved_by
       AND m.role IN ('owner','admin','order_manager')
  ) THEN
    RAISE EXCEPTION 'resolution_decider_not_authorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_case
    FROM order_resolution_cases
   WHERE shop_id = current_shop_id()
     AND id = p_case_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error_code', 'case_not_found');
  END IF;

  SELECT coalesce(sum(cl.delivered_qty), 0)::int,
         coalesce(sum(cl.returned_qty), 0)::int,
         coalesce((SELECT sum(rl.qty)::int
                     FROM order_resolution_return_receipt_lines rl
                    WHERE rl.shop_id = current_shop_id()
                      AND rl.case_id = p_case_id), 0)::int
    INTO v_delivered, v_returned, v_received
    FROM order_resolution_case_lines cl
   WHERE cl.shop_id = current_shop_id()
     AND cl.case_id = p_case_id;

  IF p_refund_id IS NOT NULL THEN
    SELECT coalesce(sum(r.amount_vnd), 0)::bigint,
           count(*) FILTER (WHERE r.id = p_refund_id)::int
      INTO v_refund_amount, v_refund_selected
      FROM refunds r
     WHERE r.shop_id = current_shop_id()
       AND r.order_id = v_case.order_id
       AND r.kind <> 'edit_adjustment'
       AND r.created_at >= v_case.detected_at;
  END IF;
  IF p_financial_action = 'handled_separately'
     AND (coalesce(v_refund_selected, 0) <> 1
          OR v_refund_amount IS NULL
          OR v_refund_amount < v_case.required_refund_vnd) THEN
    RAISE EXCEPTION 'resolution_refund_amount_insufficient'
      USING ERRCODE = '23514', CONSTRAINT = 'order_resolution_required_refund';
  END IF;
  IF p_financial_action = 'not_required' AND v_case.required_refund_vnd > 0 THEN
    RAISE EXCEPTION 'resolution_refund_required'
      USING ERRCODE = '23514', CONSTRAINT = 'order_resolution_required_refund';
  END IF;

  UPDATE orders
     SET status = 'delivered',
         fulfillment_status = 'partial',
         delivered_at = coalesce(delivered_at, now())
   WHERE shop_id = current_shop_id()
     AND id = v_case.order_id
     AND status = 'shipped';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolution_order_must_be_shipped'
      USING ERRCODE = '55000', CONSTRAINT = 'order_resolution_order_must_be_shipped';
  END IF;

  UPDATE order_resolution_cases
     SET status = 'resolved',
         resolution = 'accept_partial',
         resolution_note = p_note,
         resolution_payload = jsonb_build_object(
           'financial_action', p_financial_action,
           'delivered_qty', v_delivered,
           'returned_qty', v_returned,
           'received_return_qty', v_received
         ) || CASE WHEN p_refund_id IS NULL THEN '{}'::jsonb
                   ELSE jsonb_build_object('refund_id', p_refund_id, 'refund_amount_vnd', v_refund_amount)
              END,
         resolved_at = now(),
         resolved_by = p_resolved_by
   WHERE shop_id = current_shop_id()
     AND id = p_case_id;

  RETURN jsonb_build_object(
    'order_id', v_case.order_id,
    'delivered_qty', v_delivered,
    'returned_qty', v_returned,
    'received_return_qty', v_received,
    'refund_amount_vnd', v_refund_amount
  );
END;
$$;

REVOKE ALL ON FUNCTION lock_current_order_resolution_case(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_order_resolution_return_receipt(uuid,text,text,text,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_order_resolution_return_receipt_line(uuid,uuid,uuid,uuid,int) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_order_resolution_active_status(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_order_resolution_accept_partial(uuid,text,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_current_order_resolution_case(uuid) TO app_rw;
GRANT EXECUTE ON FUNCTION create_order_resolution_return_receipt(uuid,text,text,text,text,uuid) TO app_rw;
GRANT EXECUTE ON FUNCTION create_order_resolution_return_receipt_line(uuid,uuid,uuid,uuid,int) TO app_rw;
GRANT EXECUTE ON FUNCTION set_order_resolution_active_status(uuid,text) TO app_rw;
GRANT EXECUTE ON FUNCTION complete_order_resolution_accept_partial(uuid,text,text,uuid,uuid) TO app_rw;

GRANT app_resolution TO app_owner;
GRANT CREATE ON SCHEMA public TO app_resolution;
ALTER FUNCTION lock_current_order_resolution_case(uuid) OWNER TO app_resolution;
ALTER FUNCTION create_order_resolution_return_receipt(uuid,text,text,text,text,uuid) OWNER TO app_resolution;
ALTER FUNCTION create_order_resolution_return_receipt_line(uuid,uuid,uuid,uuid,int) OWNER TO app_resolution;
ALTER FUNCTION set_order_resolution_active_status(uuid,text) OWNER TO app_resolution;
ALTER FUNCTION complete_order_resolution_accept_partial(uuid,text,text,uuid,uuid) OWNER TO app_resolution;
REVOKE app_resolution FROM app_owner;
REVOKE CREATE ON SCHEMA public FROM app_resolution;

REVOKE UPDATE (status, resolution, resolution_note, resolved_at, resolved_by, resolution_payload)
  ON order_resolution_cases FROM app_rw;
REVOKE INSERT ON order_resolution_return_receipts,
                 order_resolution_return_receipt_lines
  FROM app_rw;

COMMENT ON TABLE order_resolution_case_lines IS
  'Snapshot số đặt/giao/hoàn/chưa xử lý theo dòng đơn tại lúc mở mixed-shipment case; immutable.';
COMMENT ON TABLE order_resolution_return_receipts IS
  'Chứng từ shop xác nhận hàng hoàn đã thực sự về; restock vào tồn hoặc quarantine ngoài ATS.';
