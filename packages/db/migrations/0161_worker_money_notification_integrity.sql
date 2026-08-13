-- 0161 - COD giao thanh cong phai vao so tien; notification phai tham chieu dung tenant.
--
-- Worker tracking truoc day lat orders.payment_status/paid_at truc tiep. Bao cao nhin thay "paid"
-- nhung payment_transactions khong co chung tu, nen khong the giai thich tien den tu dau va replay
-- sweep khong co mot khoa idempotency ben vung. Ham hep ben duoi chi chap nhan shipment da delivered,
-- khoa order, ghi phan COD con thieu va timeline trong cung transaction cua sweep.

-- Hai FK cua 0156 chi tro bang id. Voi bang tenant, nhu vay mot delivery shop A co the tham chieu
-- outbox/retry delivery cua shop B neu duong ghi nao do bi loi. Sua forward-only bang cap khoa composite.
ALTER TABLE outbox
  ADD CONSTRAINT outbox_shop_id_id_key UNIQUE (shop_id, id);

ALTER TABLE notification_deliveries
  DROP CONSTRAINT notification_deliveries_outbox_id_fkey,
  DROP CONSTRAINT notification_deliveries_retry_of_delivery_id_fkey,
  ADD CONSTRAINT notification_deliveries_outbox_tenant_fkey
    FOREIGN KEY (shop_id, outbox_id) REFERENCES outbox (shop_id, id),
  ADD CONSTRAINT notification_deliveries_retry_tenant_fkey
    FOREIGN KEY (shop_id, retry_of_delivery_id) REFERENCES notification_deliveries (shop_id, id);

-- Du lieu 0156 da ghi truoc migration nay co the chi mang order_number. Backfill de timeline notification
-- gan vao dung order; khong doc PII va khong doan theo ten/email.
UPDATE notification_deliveries nd
   SET order_id = o.id,
       updated_at = now()
  FROM orders o
 WHERE nd.order_id IS NULL
   AND nd.shop_id = o.shop_id
   AND nd.order_number = o.order_number;

-- app_worker chi duoc thay ba cot dinh danh, khong thay tien hay PII. Quyen nay cho phep noi delivery
-- cua outbox cu (payload chua co order_id) voi timeline bang shop_id + order_number.
GRANT SELECT (id, shop_id, order_number) ON orders TO app_worker;
CREATE POLICY worker_order_identity ON orders FOR SELECT TO app_worker USING (true);

GRANT INSERT ON order_events TO app_worker;
CREATE POLICY order_events_worker ON order_events FOR INSERT TO app_worker WITH CHECK (true);

-- Role NOLOGIN chi lam chu ham COD. Khong service nao co mat khau cua role nay, nen quyen ghi so tien
-- khong bi mo truc tiep cho app_expiry (vai sweep co the ket noi tu worker).
CREATE ROLE app_cod_ledger NOLOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO app_cod_ledger;

GRANT SELECT (id, shop_id, order_id, status) ON shipments TO app_cod_ledger;
CREATE POLICY cod_ledger_shipments ON shipments FOR SELECT TO app_cod_ledger USING (true);

GRANT SELECT (id, shop_id, status, payment_method, payment_status, total_vnd,
              amount_paid_vnd, paid_at)
  ON orders TO app_cod_ledger;
GRANT UPDATE (payment_status, amount_paid_vnd, paid_at) ON orders TO app_cod_ledger;
CREATE POLICY cod_ledger_orders_read ON orders FOR SELECT TO app_cod_ledger USING (true);
CREATE POLICY cod_ledger_orders_write ON orders FOR UPDATE TO app_cod_ledger
  USING (true) WITH CHECK (true);

GRANT SELECT (id, shop_id, order_id, provider, provider_event_id, amount_vnd, entry_type)
  ON payment_transactions TO app_cod_ledger;
GRANT INSERT (shop_id, order_id, provider, provider_event_id, amount_vnd, status,
              raw, entry_type, note)
  ON payment_transactions TO app_cod_ledger;
CREATE POLICY cod_ledger_payments_read ON payment_transactions FOR SELECT TO app_cod_ledger USING (true);
CREATE POLICY cod_ledger_payments_write ON payment_transactions FOR INSERT TO app_cod_ledger
  WITH CHECK (true);

GRANT INSERT (shop_id, order_id, event_type, actor_type, actor_id, source, payload)
  ON order_events TO app_cod_ledger;
CREATE POLICY cod_ledger_events ON order_events FOR INSERT TO app_cod_ledger WITH CHECK (true);

CREATE FUNCTION record_cod_delivery_payment(
  p_order_id uuid,
  p_shipment_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order record;
  v_shipment record;
  v_ledger bigint;
  v_known bigint;
  v_due bigint;
  v_after bigint;
  v_transaction_id uuid;
  v_event_key text := 'shipment-delivered:' || p_shipment_id::text;
BEGIN
  SELECT id, shop_id, order_id, status
    INTO v_shipment
    FROM shipments
   WHERE id = p_shipment_id
     AND order_id = p_order_id;

  IF NOT FOUND OR v_shipment.status <> 'delivered' THEN
    RAISE EXCEPTION 'shipment_not_delivered' USING ERRCODE = '23514';
  END IF;

  SELECT id, shop_id, status, payment_method, payment_status, total_vnd,
         amount_paid_vnd, paid_at
    INTO v_order
    FROM orders
   WHERE id = p_order_id
     AND shop_id = v_shipment.shop_id
   FOR UPDATE;

  IF NOT FOUND OR v_order.status <> 'delivered' THEN
    RAISE EXCEPTION 'order_not_delivered' USING ERRCODE = '23514';
  END IF;
  IF v_order.payment_method <> 'cod' THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'not_cod');
  END IF;

  SELECT id INTO v_transaction_id
    FROM payment_transactions
   WHERE shop_id = v_order.shop_id
     AND provider = 'cod'
     AND provider_event_id = v_event_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'recorded', false,
      'replayed', true,
      'transaction_id', v_transaction_id,
      'amount_paid_vnd', v_order.amount_paid_vnd
    );
  END IF;

  SELECT coalesce(sum(CASE WHEN entry_type = 'credit' THEN amount_vnd ELSE -amount_vnd END), 0)::bigint
    INTO v_ledger
    FROM payment_transactions
   WHERE shop_id = v_order.shop_id
     AND order_id = p_order_id;

  -- Bao toan du lieu legacy/lazy: paid_at cu co nghia he thong da tung biet du tien, con
  -- amount_paid_vnd co the lon hon ledger neu du lieu duoc nhap sau migration mo so.
  v_known := greatest(
    v_ledger,
    v_order.amount_paid_vnd,
    CASE WHEN v_order.paid_at IS NOT NULL THEN v_order.total_vnd ELSE 0 END
  );
  v_due := greatest(0, v_order.total_vnd - v_known);
  v_after := v_known + v_due;

  IF v_due > 0 THEN
    INSERT INTO payment_transactions (
      shop_id, order_id, provider, provider_event_id, amount_vnd, status,
      entry_type, note, raw
    ) VALUES (
      v_order.shop_id, p_order_id, 'cod', v_event_key, v_due, 'received',
      'credit', 'COD duoc ghi nhan khi hang van chuyen bao giao thanh cong',
      jsonb_build_object('shipment_id', p_shipment_id)
    )
    RETURNING id INTO v_transaction_id;
  END IF;

  UPDATE orders
     SET amount_paid_vnd = v_after,
         payment_status = CASE WHEN v_after >= total_vnd THEN 'paid' ELSE payment_status END,
         paid_at = CASE WHEN v_after >= total_vnd THEN coalesce(paid_at, now()) ELSE paid_at END
   WHERE id = p_order_id
     AND shop_id = v_order.shop_id;

  IF v_transaction_id IS NOT NULL THEN
    INSERT INTO order_events (
      shop_id, order_id, event_type, actor_type, actor_id, source, payload
    ) VALUES (
      v_order.shop_id, p_order_id, 'payment.received', 'carrier', NULL, 'worker',
      jsonb_build_object(
        'transaction_id', v_transaction_id,
        'shipment_id', p_shipment_id,
        'amount_vnd', v_due,
        'received_vnd', v_after,
        'provider', 'cod'
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'recorded', v_transaction_id IS NOT NULL,
    'replayed', false,
    'transaction_id', v_transaction_id,
    'amount_vnd', v_due,
    'amount_paid_vnd', v_after
  );
END;
$$;

REVOKE ALL ON FUNCTION record_cod_delivery_payment(uuid,uuid) FROM PUBLIC;
GRANT CREATE ON SCHEMA public TO app_cod_ledger;
GRANT app_cod_ledger TO app_owner;
ALTER FUNCTION record_cod_delivery_payment(uuid,uuid) OWNER TO app_cod_ledger;
REVOKE app_cod_ledger FROM app_owner;
REVOKE CREATE ON SCHEMA public FROM app_cod_ledger;
GRANT EXECUTE ON FUNCTION record_cod_delivery_payment(uuid,uuid) TO app_expiry;

-- Tu nay app_expiry khong con duoc lat paid truc tiep; moi COD tu tracking phai qua ham tren de
-- payment_status, cache amount_paid_vnd, transaction va timeline cung thanh cong hoac cung rollback.
REVOKE UPDATE (payment_status, paid_at) ON orders FROM app_expiry;
