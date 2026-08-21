-- 0176 - Gắn nhiều phiếu hoàn tiền làm bằng chứng cho một ca giao một phần.
--
-- Bằng chứng cũ chỉ giữ một refund_id trong JSON và cộng mọi refund tạo sau detected_at.
-- Vì vậy một phiếu không được chọn vẫn có thể làm ca đủ tiền, còn phiếu tạo trước lúc worker
-- phát hiện ca thì không dùng được. Bảng này ghi đúng tập chứng từ người bán đã chọn; số tiền
-- luôn đọc từ refunds.amount_vnd, không chép thêm một con số có thể trôi.

CREATE UNIQUE INDEX order_resolution_cases_shop_order_id_uq
  ON order_resolution_cases (shop_id, order_id, id);
CREATE UNIQUE INDEX refunds_shop_order_id_uq
  ON refunds (shop_id, order_id, id);

CREATE TABLE order_resolution_refund_attributions (
  shop_id       uuid NOT NULL,
  order_id      uuid NOT NULL,
  case_id       uuid NOT NULL,
  refund_id     uuid NOT NULL,
  attributed_by uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, case_id, refund_id),
  UNIQUE (shop_id, refund_id),
  FOREIGN KEY (shop_id, order_id, case_id)
    REFERENCES order_resolution_cases (shop_id, order_id, id),
  FOREIGN KEY (shop_id, order_id, refund_id)
    REFERENCES refunds (shop_id, order_id, id)
);
CREATE INDEX order_resolution_refund_attributions_case_idx
  ON order_resolution_refund_attributions (shop_id, case_id, created_at, refund_id);

ALTER TABLE order_resolution_refund_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_resolution_refund_attributions FORCE ROW LEVEL SECURITY;

-- 0003 cấp CRUD mặc định cho bảng mới: thu hồi trước rồi chỉ mở đúng hai bề mặt đọc/ghi.
REVOKE ALL ON order_resolution_refund_attributions FROM PUBLIC, app_rw, app_resolution;
GRANT SELECT ON order_resolution_refund_attributions TO app_rw;
GRANT SELECT, INSERT ON order_resolution_refund_attributions TO app_resolution;

CREATE POLICY attrib_rw_select ON order_resolution_refund_attributions
  FOR SELECT TO app_rw USING (shop_id = current_shop_id());
CREATE POLICY attrib_resolution_select ON order_resolution_refund_attributions
  FOR SELECT TO app_resolution USING (shop_id = current_shop_id());
CREATE POLICY attrib_resolution_insert ON order_resolution_refund_attributions
  FOR INSERT TO app_resolution WITH CHECK (shop_id = current_shop_id());

CREATE FUNCTION guard_resolution_refund_attribution_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM order_resolution_cases rc
     WHERE rc.shop_id = OLD.shop_id
       AND rc.id = OLD.case_id
       AND rc.status = 'resolved'
  ) THEN
    RAISE EXCEPTION 'resolved_case_refund_attribution_is_immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'resolution_refund_attribution_immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
REVOKE ALL ON FUNCTION guard_resolution_refund_attribution_immutable() FROM PUBLIC;

CREATE TRIGGER resolution_refund_attribution_immutable
  BEFORE UPDATE OR DELETE ON order_resolution_refund_attributions
  FOR EACH ROW EXECUTE FUNCTION guard_resolution_refund_attribution_immutable();

-- Chuyển trạng thái vẫn được chứng minh ở DB. Với định dạng mới, chỉ đúng các phiếu đã gắn
-- mới được cộng; không còn cửa sổ created_at và không còn bộ đếm refund toàn đơn.
CREATE OR REPLACE FUNCTION guard_order_resolution_case_transition()
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
  v_refund_amount bigint;
  v_refund_count int;
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
  IF v_action = 'handled_separately' THEN
    SELECT count(*)::int, coalesce(sum(r.amount_vnd), 0)::bigint
      INTO v_refund_count, v_refund_amount
      FROM order_resolution_refund_attributions a
      JOIN refunds r
        ON r.shop_id = a.shop_id
       AND r.order_id = a.order_id
       AND r.id = a.refund_id
     WHERE a.shop_id = NEW.shop_id
       AND a.order_id = NEW.order_id
       AND a.case_id = NEW.id
       AND r.kind <> 'edit_adjustment';
    IF v_refund_count = 0 OR v_refund_amount < NEW.required_refund_vnd THEN
      RAISE EXCEPTION 'resolution_refund_evidence_invalid'
        USING ERRCODE = '23514', CONSTRAINT = 'order_resolution_refund_evidence';
    END IF;
  ELSIF v_action = 'not_required' THEN
    IF EXISTS (
         SELECT 1 FROM order_resolution_refund_attributions a
          WHERE a.shop_id = NEW.shop_id AND a.case_id = NEW.id
       )
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

-- Audit/event vẫn do Node/app_rw ghi. Trigger deferred buộc transaction có đủ cả ba lớp
-- bằng chứng trước COMMIT, nhưng không mở quyền ghi audit/event cho SECURITY DEFINER role.
CREATE OR REPLACE FUNCTION enforce_order_resolution_completion_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'resolved' AND OLD.status <> 'resolved' THEN
    IF (NEW.resolution_payload->>'financial_action') = 'handled_separately'
       AND NOT EXISTS (
         SELECT 1 FROM order_resolution_refund_attributions a
          WHERE a.shop_id = NEW.shop_id
            AND a.order_id = NEW.order_id
            AND a.case_id = NEW.id
       ) THEN
      RAISE EXCEPTION 'resolution_refund_attribution_missing'
        USING ERRCODE = '23514', CONSTRAINT = 'order_resolution_completion_requires_attribution';
    END IF;
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
         AND e.actor_id = NEW.resolved_by::text
         AND e.payload->>'case_id' = NEW.id::text
    ) THEN
      RAISE EXCEPTION 'resolution_completion_evidence_missing'
        USING ERRCODE = '23514', CONSTRAINT = 'order_resolution_completion_requires_evidence';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION attribute_resolution_refunds(
  p_case_id uuid,
  p_refund_ids uuid[],
  p_note text,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_case order_resolution_cases%ROWTYPE;
  v_order orders%ROWTYPE;
  v_refund_ids uuid[];
  v_saved_ids uuid[];
  v_saved_amount bigint;
  v_delivered int;
  v_returned int;
  v_unresolved int;
  v_received int;
  v_refund_amount bigint;
  v_refund_count int;
  v_conflict record;
BEGIN
  IF nullif(btrim(p_note), '') IS NULL OR char_length(p_note) > 1000 THEN
    RETURN jsonb_build_object('error_code', 'resolution_note_invalid');
  END IF;
  SELECT array_agg(x ORDER BY x) INTO v_refund_ids
    FROM (SELECT DISTINCT unnest(p_refund_ids) AS x) q
   WHERE x IS NOT NULL;
  IF coalesce(cardinality(v_refund_ids), 0) = 0
     OR cardinality(v_refund_ids) > 100
     OR cardinality(v_refund_ids) <> cardinality(p_refund_ids) THEN
    RETURN jsonb_build_object('error_code', 'refund_ids_invalid');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.shop_id = current_shop_id()
       AND m.user_id = p_actor_id
       AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'resolution_refund_actor_not_authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_case
    FROM order_resolution_cases
   WHERE shop_id = current_shop_id()
     AND id = p_case_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error_code', 'case_not_found');
  END IF;

  IF v_case.status = 'resolved' THEN
    SELECT array_agg(a.refund_id ORDER BY a.refund_id), coalesce(sum(r.amount_vnd), 0)::bigint
      INTO v_saved_ids, v_saved_amount
      FROM order_resolution_refund_attributions a
      JOIN refunds r ON r.shop_id=a.shop_id AND r.order_id=a.order_id AND r.id=a.refund_id
     WHERE a.shop_id = current_shop_id()
       AND a.case_id = p_case_id;
    IF v_case.resolution = 'accept_partial'
       AND v_case.resolution_note = p_note
       AND v_saved_ids = v_refund_ids THEN
      RETURN jsonb_build_object(
        'replayed', true,
        'order_id', v_case.order_id,
        'refund_ids', to_jsonb(v_saved_ids),
        'attributed_refund_vnd', v_saved_amount
      );
    END IF;
    IF v_case.resolution = 'accept_partial' THEN
      RETURN jsonb_build_object('error_code', 'resolution_replay_conflict');
    END IF;
    RETURN jsonb_build_object('error_code', 'case_already_resolved');
  END IF;

  SELECT * INTO v_order
    FROM orders
   WHERE shop_id = current_shop_id()
     AND id = v_case.order_id
   FOR UPDATE;
  IF NOT FOUND OR v_order.status <> 'shipped' THEN
    RETURN jsonb_build_object('error_code', 'order_state_changed');
  END IF;

  SELECT count(*)::int,
         coalesce(sum(cl.delivered_qty), 0)::int,
         coalesce(sum(cl.returned_qty), 0)::int,
         coalesce(sum(cl.unresolved_qty), 0)::int,
         coalesce((
           SELECT sum(rl.qty)::int
             FROM order_resolution_return_receipt_lines rl
            WHERE rl.shop_id = current_shop_id()
              AND rl.case_id = p_case_id
         ), 0)::int
    INTO v_refund_count, v_delivered, v_returned, v_unresolved, v_received
    FROM order_resolution_case_lines cl
   WHERE cl.shop_id = current_shop_id()
     AND cl.case_id = p_case_id;
  IF v_refund_count = 0 THEN
    RETURN jsonb_build_object('error_code', 'resolution_snapshot_missing');
  END IF;
  IF v_unresolved > 0 THEN
    RETURN jsonb_build_object('error_code', 'shipment_qty_unresolved', 'unresolved_qty', v_unresolved);
  END IF;
  IF v_received <> v_returned THEN
    RETURN jsonb_build_object(
      'error_code', CASE WHEN v_received > v_returned
        THEN 'resolution_inventory_integrity_error' ELSE 'returned_goods_not_received' END,
      'remaining_return_qty', v_returned - v_received
    );
  END IF;
  IF v_delivered <= 0 THEN
    RETURN jsonb_build_object('error_code', 'no_delivered_qty');
  END IF;

  -- app_resolution chỉ có SELECT trên refunds, nên không dùng FOR UPDATE (PostgreSQL đòi
  -- thêm quyền UPDATE). Advisory xact lock theo shop+refund vẫn tuần tự hai case tranh cùng
  -- chứng từ và tự nhả ở COMMIT/ROLLBACK, không mở rộng table privilege.
  PERFORM pg_advisory_xact_lock(hashtextextended(current_shop_id()::text || ':' || x::text, 0))
    FROM unnest(v_refund_ids) AS x
   ORDER BY x;

  SELECT count(*)::int, coalesce(sum(r.amount_vnd), 0)::bigint
    INTO v_refund_count, v_refund_amount
    FROM refunds r
   WHERE r.shop_id = current_shop_id()
     AND r.order_id = v_case.order_id
     AND r.id = ANY(v_refund_ids)
     AND r.kind <> 'edit_adjustment';
  IF v_refund_count <> cardinality(v_refund_ids) THEN
    RETURN jsonb_build_object('error_code', 'refund_evidence_invalid');
  END IF;
  IF v_refund_amount < v_case.required_refund_vnd THEN
    RETURN jsonb_build_object(
      'error_code', 'refund_amount_insufficient',
      'attributed_refund_vnd', v_refund_amount,
      'required_refund_vnd', v_case.required_refund_vnd
    );
  END IF;

  SELECT a.case_id, a.refund_id INTO v_conflict
    FROM order_resolution_refund_attributions a
   WHERE a.shop_id = current_shop_id()
     AND a.refund_id = ANY(v_refund_ids)
     AND a.case_id <> p_case_id
   ORDER BY a.refund_id
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'error_code', 'refund_already_attributed',
      'refund_id', v_conflict.refund_id,
      'case_id', v_conflict.case_id
    );
  END IF;

  INSERT INTO order_resolution_refund_attributions
    (shop_id, order_id, case_id, refund_id, attributed_by)
  SELECT current_shop_id(), v_case.order_id, p_case_id, x, p_actor_id
    FROM unnest(v_refund_ids) AS x
   ORDER BY x;

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
           'financial_action', 'handled_separately',
           'refund_evidence_format', 'attributions',
           'delivered_qty', v_delivered,
           'returned_qty', v_returned,
           'received_return_qty', v_received
         ),
         resolved_at = now(),
         resolved_by = p_actor_id
   WHERE shop_id = current_shop_id()
     AND id = p_case_id;

  RETURN jsonb_build_object(
    'replayed', false,
    'order_id', v_case.order_id,
    'delivered_qty', v_delivered,
    'returned_qty', v_returned,
    'received_return_qty', v_received,
    'refund_ids', to_jsonb(v_refund_ids),
    'attributed_refund_vnd', v_refund_amount
  );
END;
$$;

REVOKE ALL ON FUNCTION attribute_resolution_refunds(uuid,uuid[],text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION attribute_resolution_refunds(uuid,uuid[],text,uuid) TO app_rw;

GRANT app_resolution TO app_owner;
GRANT CREATE ON SCHEMA public TO app_resolution;
ALTER FUNCTION attribute_resolution_refunds(uuid,uuid[],text,uuid) OWNER TO app_resolution;
REVOKE app_resolution FROM app_owner;
REVOKE CREATE ON SCHEMA public FROM app_resolution;

COMMENT ON TABLE order_resolution_refund_attributions IS
  'Tập phiếu refund người bán chọn làm bằng chứng cho một ca giao một phần; tiền được dẫn xuất từ refunds.';
