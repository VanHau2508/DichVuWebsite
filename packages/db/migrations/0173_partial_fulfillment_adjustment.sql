-- 0173 - Keep the amount a shop may retain after accepting a partial delivery.

ALTER TABLE orders
  ADD COLUMN fulfillment_adjustment_vnd bigint NOT NULL DEFAULT 0
    CHECK (fulfillment_adjustment_vnd >= 0);

GRANT SELECT (fulfillment_adjustment_vnd) ON orders TO app_checkout, app_customer, app_payment;
GRANT UPDATE (fulfillment_adjustment_vnd) ON orders TO app_resolution;

CREATE POLICY adjustment_0173_owner_orders_read ON orders
  FOR SELECT TO app_owner USING (true);
CREATE POLICY adjustment_0173_owner_orders_update ON orders
  FOR UPDATE TO app_owner USING (true) WITH CHECK (true);
CREATE POLICY adjustment_0173_owner_cases_read ON order_resolution_cases
  FOR SELECT TO app_owner USING (true);
CREATE POLICY adjustment_0173_owner_case_lines_read ON order_resolution_case_lines
  FOR SELECT TO app_owner USING (true);
CREATE POLICY adjustment_0173_owner_order_lines_read ON order_lines
  FOR SELECT TO app_owner USING (true);

WITH per_case AS (
  SELECT rc.shop_id, rc.order_id,
         CASE
           WHEN o.subtotal_vnd <= 0 THEN 0::bigint
           ELSE least(
             o.total_vnd,
             (
               coalesce(sum(cl.returned_qty::bigint * ol.unit_price_vnd), 0)
               * greatest(0::bigint, o.subtotal_vnd - o.discount_vnd - o.points_discount_vnd)
               + o.subtotal_vnd - 1
             ) / o.subtotal_vnd
           )
         END AS adjustment_vnd
    FROM order_resolution_cases rc
    JOIN orders o
      ON o.shop_id = rc.shop_id AND o.id = rc.order_id
    JOIN order_resolution_case_lines cl
      ON cl.shop_id = rc.shop_id AND cl.case_id = rc.id
    JOIN order_lines ol
      ON ol.shop_id = rc.shop_id AND ol.id = cl.order_line_id
   WHERE rc.status = 'resolved' AND rc.resolution = 'accept_partial'
   GROUP BY rc.shop_id, rc.order_id, rc.id, o.subtotal_vnd, o.discount_vnd,
            o.points_discount_vnd, o.total_vnd
), per_order AS (
  SELECT shop_id, order_id, max(adjustment_vnd)::bigint AS adjustment_vnd
    FROM per_case
   GROUP BY shop_id, order_id
)
UPDATE orders o
   SET fulfillment_adjustment_vnd = p.adjustment_vnd
  FROM per_order p
 WHERE o.shop_id = p.shop_id AND o.id = p.order_id;

DROP POLICY adjustment_0173_owner_orders_read ON orders;
DROP POLICY adjustment_0173_owner_orders_update ON orders;
DROP POLICY adjustment_0173_owner_cases_read ON order_resolution_cases;
DROP POLICY adjustment_0173_owner_case_lines_read ON order_resolution_case_lines;
DROP POLICY adjustment_0173_owner_order_lines_read ON order_lines;

-- app_rw có UPDATE cấp bảng trên orders từ schema legacy, nên column GRANT không thể tự
-- thu hẹp cột mới. Chặn tại DB: chỉ SECURITY DEFINER do app_resolution sở hữu mới được ghi.
CREATE FUNCTION guard_fulfillment_adjustment_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.fulfillment_adjustment_vnd IS DISTINCT FROM OLD.fulfillment_adjustment_vnd
     AND current_user <> 'app_resolution' THEN
    RAISE EXCEPTION 'fulfillment_adjustment_write_forbidden'
      USING ERRCODE = '42501', CONSTRAINT = 'fulfillment_adjustment_resolution_only';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_fulfillment_adjustment_write() FROM PUBLIC;

CREATE TRIGGER fulfillment_adjustment_write_guard
  BEFORE UPDATE OF fulfillment_adjustment_vnd ON orders
  FOR EACH ROW EXECUTE FUNCTION guard_fulfillment_adjustment_write();

CREATE FUNCTION set_order_partial_fulfillment_adjustment(p_case_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_case order_resolution_cases%ROWTYPE;
  v_order orders%ROWTYPE;
  v_returned_gross bigint;
  v_adjustment bigint;
BEGIN
  SELECT * INTO v_case
    FROM order_resolution_cases
   WHERE shop_id = current_shop_id()
     AND id = p_case_id
     AND status = 'resolved'
     AND resolution = 'accept_partial';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'partial_resolution_not_finalized'
      USING ERRCODE = '55000', CONSTRAINT = 'partial_resolution_required';
  END IF;

  SELECT * INTO v_order
    FROM orders
   WHERE shop_id = current_shop_id() AND id = v_case.order_id
   FOR UPDATE;

  SELECT coalesce(sum(cl.returned_qty::bigint * ol.unit_price_vnd), 0)::bigint
    INTO v_returned_gross
    FROM order_resolution_case_lines cl
    JOIN order_lines ol
      ON ol.shop_id = cl.shop_id AND ol.id = cl.order_line_id
   WHERE cl.shop_id = current_shop_id() AND cl.case_id = p_case_id;

  v_adjustment := CASE
    WHEN v_order.subtotal_vnd <= 0 THEN 0
    ELSE least(
      v_order.total_vnd,
      (
        v_returned_gross
        * greatest(0::bigint, v_order.subtotal_vnd - v_order.discount_vnd - v_order.points_discount_vnd)
        + v_order.subtotal_vnd - 1
      ) / v_order.subtotal_vnd
    )
  END;

  UPDATE orders
     SET fulfillment_adjustment_vnd = v_adjustment
   WHERE shop_id = current_shop_id()
     AND id = v_case.order_id
     AND fulfillment_adjustment_vnd IN (0, v_adjustment);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'partial_fulfillment_adjustment_immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'partial_fulfillment_adjustment_immutable';
  END IF;
  RETURN v_adjustment;
END;
$$;

REVOKE ALL ON FUNCTION set_order_partial_fulfillment_adjustment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_order_partial_fulfillment_adjustment(uuid) TO app_rw;

GRANT app_resolution TO app_owner;
GRANT CREATE ON SCHEMA public TO app_resolution;
ALTER FUNCTION set_order_partial_fulfillment_adjustment(uuid) OWNER TO app_resolution;
REVOKE app_resolution FROM app_owner;
REVOKE CREATE ON SCHEMA public FROM app_resolution;

GRANT app_payment TO app_owner;

CREATE OR REPLACE FUNCTION record_manual_payment(
  p_order_id uuid,
  p_amount_vnd bigint,
  p_actor_id uuid,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_shop_id uuid := current_shop_id();
  v_order record;
  v_ledger_before bigint;
  v_known_before bigint;
  v_before bigint;
  v_after bigint;
  v_payable bigint;
  v_transaction_id uuid;
  v_became_paid boolean;
  v_payment_status text;
BEGIN
  IF v_shop_id IS NULL OR p_amount_vnd IS NULL OR p_amount_vnd <= 0 THEN
    RAISE EXCEPTION 'payment_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_note IS NOT NULL AND length(trim(p_note)) > 500 THEN
    RAISE EXCEPTION 'payment_note_too_long' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM memberships m WHERE m.shop_id = v_shop_id AND m.user_id = p_actor_id
  ) THEN
    RAISE EXCEPTION 'actor_not_member' USING ERRCODE = '42501';
  END IF;

  SELECT id, status, payment_status, total_vnd, fulfillment_adjustment_vnd,
         amount_paid_vnd, paid_at
    INTO v_order
    FROM orders
   WHERE id = p_order_id AND shop_id = v_shop_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found' USING ERRCODE = 'P0002';
  END IF;
  v_payable := greatest(0::bigint, v_order.total_vnd - v_order.fulfillment_adjustment_vnd);

  SELECT coalesce(sum(CASE WHEN entry_type = 'credit' THEN amount_vnd ELSE -amount_vnd END), 0)::bigint
    INTO v_ledger_before
    FROM payment_transactions
   WHERE shop_id = v_shop_id AND order_id = p_order_id;
  v_known_before := greatest(v_ledger_before, v_order.amount_paid_vnd,
    CASE WHEN v_order.paid_at IS NOT NULL THEN v_order.total_vnd ELSE 0 END);
  v_before := v_known_before;
  v_after := v_before + p_amount_vnd;
  v_became_paid := v_order.status NOT IN ('cancelled','refunded','returned')
    AND v_before < v_payable AND v_after >= v_payable;

  INSERT INTO payment_transactions (
    shop_id, order_id, provider, provider_event_id, amount_vnd, status,
    entry_type, recorded_by, note
  ) VALUES (
    v_shop_id, p_order_id, 'manual', 'manual:' || gen_random_uuid()::text, p_amount_vnd,
    CASE WHEN v_after >= v_payable THEN 'received' ELSE 'underpaid' END,
    'credit', p_actor_id, nullif(trim(p_note), '')
  ) RETURNING id INTO v_transaction_id;

  UPDATE orders
     SET amount_paid_vnd = v_after,
         payment_status = CASE
           WHEN status IN ('refunded','returned') THEN payment_status
           WHEN v_after >= v_payable THEN 'paid'
           WHEN v_after > 0 THEN 'pending'
           ELSE 'unpaid'
         END,
         paid_at = CASE
           WHEN status IN ('refunded','returned') THEN paid_at
           WHEN v_after < v_payable THEN NULL
           WHEN status = 'cancelled' THEN paid_at
           ELSE coalesce(paid_at, now())
         END
   WHERE id = p_order_id AND shop_id = v_shop_id;

  SELECT payment_status INTO v_payment_status
    FROM orders WHERE id = p_order_id AND shop_id = v_shop_id;

  INSERT INTO order_events (
    shop_id, order_id, event_type, actor_type, actor_id, source, payload
  ) VALUES (
    v_shop_id, p_order_id, 'payment.received', 'user', p_actor_id::text, 'seller_admin',
    jsonb_build_object(
      'transaction_id', v_transaction_id,
      'amount_vnd', p_amount_vnd,
      'received_vnd', v_after,
      'provider', 'manual'
    )
  );

  RETURN jsonb_build_object(
    'transaction_id', v_transaction_id,
    'amount_paid_vnd', v_after,
    'payment_status', v_payment_status,
    'became_paid', v_became_paid
  );
END;
$$;

CREATE OR REPLACE FUNCTION reverse_manual_payment(
  p_order_id uuid,
  p_transaction_id uuid,
  p_actor_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_shop_id uuid := current_shop_id();
  v_order record;
  v_target record;
  v_ledger_before bigint;
  v_known_before bigint;
  v_opening_balance bigint;
  v_after bigint;
  v_payable bigint;
  v_reversal_id uuid;
  v_payment_status text;
BEGIN
  IF v_shop_id IS NULL OR p_reason IS NULL OR length(trim(p_reason)) < 3 OR length(trim(p_reason)) > 500 THEN
    RAISE EXCEPTION 'reversal_reason_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM memberships m WHERE m.shop_id = v_shop_id AND m.user_id = p_actor_id
  ) THEN
    RAISE EXCEPTION 'actor_not_member' USING ERRCODE = '42501';
  END IF;

  SELECT id, status, payment_status, total_vnd, fulfillment_adjustment_vnd,
         amount_paid_vnd, paid_at
    INTO v_order
    FROM orders
   WHERE id = p_order_id AND shop_id = v_shop_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM refunds r WHERE r.shop_id = v_shop_id AND r.order_id = p_order_id) THEN
    RAISE EXCEPTION 'order_has_refund' USING ERRCODE = '23514';
  END IF;
  v_payable := greatest(0::bigint, v_order.total_vnd - v_order.fulfillment_adjustment_vnd);

  SELECT id, provider, entry_type, amount_vnd INTO v_target
    FROM payment_transactions
   WHERE id = p_transaction_id
     AND shop_id = v_shop_id
     AND order_id = p_order_id;
  IF NOT FOUND OR v_target.provider <> 'manual' OR v_target.entry_type <> 'credit' THEN
    RAISE EXCEPTION 'manual_payment_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM payment_transactions pt
     WHERE pt.shop_id = v_shop_id AND pt.reverses_transaction_id = p_transaction_id
  ) THEN
    RAISE EXCEPTION 'payment_already_reversed' USING ERRCODE = '23505';
  END IF;

  SELECT coalesce(sum(CASE WHEN entry_type = 'credit' THEN amount_vnd ELSE -amount_vnd END), 0)::bigint
    INTO v_ledger_before
    FROM payment_transactions
   WHERE shop_id = v_shop_id AND order_id = p_order_id;
  v_known_before := greatest(v_ledger_before, v_order.amount_paid_vnd,
    CASE WHEN v_order.paid_at IS NOT NULL THEN v_order.total_vnd ELSE 0 END);
  v_opening_balance := greatest(0, v_known_before - v_ledger_before);

  INSERT INTO payment_transactions (
    shop_id, order_id, provider, provider_event_id, amount_vnd, status,
    entry_type, recorded_by, note, reverses_transaction_id
  ) VALUES (
    v_shop_id, p_order_id, 'manual', 'reversal:' || gen_random_uuid()::text,
    v_target.amount_vnd, 'received', 'reversal', p_actor_id, trim(p_reason), p_transaction_id
  ) RETURNING id INTO v_reversal_id;

  v_after := greatest(0, v_opening_balance + v_ledger_before - v_target.amount_vnd);

  UPDATE orders
     SET amount_paid_vnd = v_after,
         payment_status = CASE
           WHEN status IN ('refunded','returned') THEN payment_status
           WHEN v_after >= v_payable THEN 'paid'
           WHEN v_after > 0 THEN 'pending'
           ELSE 'unpaid'
         END,
         paid_at = CASE
           WHEN status IN ('refunded','returned') THEN paid_at
           WHEN v_after < v_payable THEN NULL
           WHEN status = 'cancelled' THEN paid_at
           ELSE coalesce(paid_at, now())
         END
   WHERE id = p_order_id AND shop_id = v_shop_id;

  SELECT payment_status INTO v_payment_status
    FROM orders WHERE id = p_order_id AND shop_id = v_shop_id;

  INSERT INTO order_events (
    shop_id, order_id, event_type, actor_type, actor_id, source, payload
  ) VALUES (
    v_shop_id, p_order_id, 'payment.reversed', 'user', p_actor_id::text, 'seller_admin',
    jsonb_build_object(
      'transaction_id', v_reversal_id,
      'reverses_transaction_id', p_transaction_id,
      'amount_vnd', v_target.amount_vnd,
      'received_vnd', v_after,
      'reason', trim(p_reason)
    )
  );

  RETURN jsonb_build_object(
    'transaction_id', v_reversal_id,
    'amount_paid_vnd', v_after,
    'payment_status', v_payment_status
  );
END;
$$;

REVOKE app_payment FROM app_owner;

COMMENT ON COLUMN orders.fulfillment_adjustment_vnd IS
  'Value of merchandise the shop may no longer retain after a resolved partial-delivery case.';
