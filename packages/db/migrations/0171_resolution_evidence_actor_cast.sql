-- 0171 - Compare timeline actor_id (text) with resolution user ids (uuid) explicitly.
--
-- order_events.actor_id is text because events can originate from providers and
-- external actors, while receipt/resolution evidence stores internal users as uuid.
-- The deferred integrity triggers from 0168 compared them directly, so a valid
-- receive-return transaction failed at COMMIT with "operator does not exist: text = uuid".

CREATE OR REPLACE FUNCTION enforce_resolution_return_receipt()
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
       AND e.actor_id = NEW.received_by::text
       AND e.payload->>'receipt_id' = NEW.id::text
  ) THEN
    RAISE EXCEPTION 'resolution_return_receipt_evidence_missing'
      USING ERRCODE = '23514', CONSTRAINT = 'resolution_return_receipt_requires_evidence';
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_order_resolution_completion_evidence()
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
