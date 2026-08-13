-- 0159 — đảo khoản thu tay không đòi quyền UPDATE trên sổ tiền.
--
-- 0154 khóa cả orders lẫn payment_transactions bằng FOR UPDATE. Khóa orders đã tuần tự hóa mọi thao tác
-- tiền của cùng một đơn; khóa thêm dòng transaction không tăng bảo vệ nhưng lại buộc app_payment có quyền
-- UPDATE trên bảng append-only. Giữ quyền hẹp và thay hàm, không nới GRANT chỉ để phục vụ một row lock thừa.

GRANT app_payment TO app_owner;

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

  SELECT id, status, payment_status, total_vnd, amount_paid_vnd, paid_at INTO v_order
    FROM orders
   WHERE id = p_order_id AND shop_id = v_shop_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM refunds r WHERE r.shop_id = v_shop_id AND r.order_id = p_order_id) THEN
    RAISE EXCEPTION 'order_has_refund' USING ERRCODE = '23514';
  END IF;

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
     WHERE pt.shop_id = v_shop_id
       AND pt.reverses_transaction_id = p_transaction_id
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
           WHEN v_after >= total_vnd THEN 'paid'
           WHEN v_after > 0 THEN 'pending'
           ELSE 'unpaid'
         END,
         paid_at = CASE
           WHEN status IN ('refunded','returned') THEN paid_at
           WHEN v_after < total_vnd THEN NULL
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

