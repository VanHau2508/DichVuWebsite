-- 0154 — SỔ TIỀN v2: ghi được thanh toán một phần và sửa nhầm bằng reversal, không xoá lịch sử.
--
-- Trước migration này, khoản SePay thiếu tiền có transaction nhưng orders.amount_paid_vnd vẫn 0;
-- còn nút "gỡ đã nhận tiền" xoá sạch dấu vết bằng cách đặt cột về 0. Hai hành vi khiến seller và
-- khách có thể nhìn hai con số khác nhau, đồng thời audit không chứng minh được khoản nào bị sửa.

ALTER TABLE payment_transactions
  ADD COLUMN entry_type text NOT NULL DEFAULT 'credit'
    CHECK (entry_type IN ('credit','reversal')),
  ADD COLUMN recorded_by uuid REFERENCES users (id),
  ADD COLUMN note text CHECK (note IS NULL OR length(note) <= 500),
  ADD COLUMN reverses_transaction_id uuid;

ALTER TABLE payment_transactions
  ADD CONSTRAINT payment_transactions_reversal_shape
    CHECK (
      (entry_type = 'credit' AND reverses_transaction_id IS NULL)
      OR
      (entry_type = 'reversal' AND reverses_transaction_id IS NOT NULL)
    ),
  ADD CONSTRAINT payment_transactions_reversal_not_self
    CHECK (reverses_transaction_id IS NULL OR reverses_transaction_id <> id),
  ADD CONSTRAINT payment_transactions_reversal_fk
    FOREIGN KEY (shop_id, reverses_transaction_id)
    REFERENCES payment_transactions (shop_id, id);

CREATE UNIQUE INDEX payment_transactions_one_reversal_uq
  ON payment_transactions (shop_id, reverses_transaction_id)
  WHERE entry_type = 'reversal';
CREATE INDEX payment_transactions_order_time_idx
  ON payment_transactions (shop_id, order_id, created_at, id);

-- Đưa phần tiền lịch sử chưa có chứng từ vào một bút toán mở sổ. Nếu chỉ giữ nó trong
-- orders.amount_paid_vnd thì lần đảo giao dịch mới đầu tiên sẽ tính lại từ ledger và làm mất phần cũ.
WITH ledger AS (
  SELECT shop_id, order_id, coalesce(sum(amount_vnd), 0)::bigint AS received_vnd
    FROM payment_transactions
   GROUP BY shop_id, order_id
), opening AS (
  SELECT o.shop_id, o.id AS order_id, o.total_vnd,
         greatest(
           o.amount_paid_vnd,
           CASE WHEN o.paid_at IS NOT NULL THEN o.total_vnd ELSE 0 END
         ) AS known_received_vnd,
         coalesce(l.received_vnd, 0) AS ledger_received_vnd
    FROM orders o
    LEFT JOIN ledger l ON l.shop_id = o.shop_id AND l.order_id = o.id
)
INSERT INTO payment_transactions (
  shop_id, order_id, provider, provider_event_id, amount_vnd, status,
  entry_type, note, raw
)
SELECT shop_id, order_id, 'legacy', 'legacy-opening:' || order_id::text,
       known_received_vnd - ledger_received_vnd,
       CASE WHEN known_received_vnd >= total_vnd THEN 'received' ELSE 'underpaid' END,
       'credit', 'Số dư mở sổ được chuyển từ dữ liệu trước migration 0154',
       jsonb_build_object('backfilled', true, 'opening_balance', true)
  FROM opening
 WHERE known_received_vnd > ledger_received_vnd;

-- Từ migration này trở đi amount_paid_vnd là cache của tổng credit trừ reversal. greatest vẫn giữ
-- được fixture/đơn legacy bất thường; hai hàm bên dưới cũng bảo toàn phần chênh này khi đảo giao dịch.
UPDATE orders o
   SET amount_paid_vnd = greatest(o.amount_paid_vnd, x.received_vnd)
  FROM (
    SELECT order_id,
           coalesce(sum(CASE WHEN entry_type = 'credit' THEN amount_vnd ELSE -amount_vnd END), 0)::bigint AS received_vnd
      FROM payment_transactions
     GROUP BY order_id
  ) x
 WHERE x.order_id = o.id;

-- Hàm definer chạy dưới app_payment: vai này vốn đã sở hữu đường webhook tiền và có policy tenant
-- trên orders/payment_transactions. Hai bảng phụ chỉ mở đúng cột đọc cần để xác minh actor/refund.
GRANT SELECT (shop_id, user_id) ON memberships TO app_payment;
CREATE POLICY memberships_payment_function ON memberships FOR SELECT TO app_payment
  USING (shop_id = current_shop_id());

GRANT SELECT (shop_id, order_id) ON refunds TO app_payment;
CREATE POLICY refunds_payment_function ON refunds FOR SELECT TO app_payment
  USING (shop_id = current_shop_id());

GRANT SELECT (amount_paid_vnd, paid_at) ON orders TO app_payment;

-- app_rw vẫn KHÔNG có INSERT/UPDATE/DELETE trên payment_transactions. Hai hàm SECURITY DEFINER
-- dưới đây là cửa hẹp: xác minh tenant, membership, trạng thái đơn và hình dạng reversal trước khi
-- chủ bảng ghi chứng từ. Nhờ vậy không phải nới quyền cả bảng chỉ để hỗ trợ một nút quản trị.
CREATE FUNCTION record_manual_payment(
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

  SELECT id, status, payment_status, total_vnd, amount_paid_vnd, paid_at INTO v_order
    FROM orders
   WHERE id = p_order_id AND shop_id = v_shop_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT coalesce(sum(CASE WHEN entry_type = 'credit' THEN amount_vnd ELSE -amount_vnd END), 0)::bigint
    INTO v_ledger_before
    FROM payment_transactions
   WHERE shop_id = v_shop_id AND order_id = p_order_id;
  -- Fixture hoặc dữ liệu nhập cũ vẫn có thể xuất hiện sau migration mà không có bút toán mở sổ.
  -- Lấy phần chênh làm opening balance để một reversal mới không xoá nhầm số dư lịch sử đó.
  v_known_before := greatest(v_ledger_before, v_order.amount_paid_vnd,
    CASE WHEN v_order.paid_at IS NOT NULL THEN v_order.total_vnd ELSE 0 END);
  v_before := v_known_before;
  v_after := v_before + p_amount_vnd;
  v_became_paid := v_order.status NOT IN ('cancelled','refunded','returned')
    AND v_before < v_order.total_vnd AND v_after >= v_order.total_vnd;

  INSERT INTO payment_transactions (
    shop_id, order_id, provider, provider_event_id, amount_vnd, status,
    entry_type, recorded_by, note
  ) VALUES (
    v_shop_id, p_order_id, 'manual', 'manual:' || gen_random_uuid()::text, p_amount_vnd,
    CASE WHEN v_after >= v_order.total_vnd THEN 'received' ELSE 'underpaid' END,
    'credit', p_actor_id, nullif(trim(p_note), '')
  ) RETURNING id INTO v_transaction_id;

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

CREATE FUNCTION reverse_manual_payment(
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
     AND order_id = p_order_id
   FOR UPDATE;
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

REVOKE ALL ON FUNCTION record_manual_payment(uuid,bigint,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION reverse_manual_payment(uuid,uuid,uuid,text) FROM PUBLIC;

-- SECURITY DEFINER không được thuộc app_owner: production bật FORCE RLS và app_owner không phải
-- superuser, nên function-owner đó sẽ không khớp policy tenant. app_payment là role không bypass RLS,
-- đã có đúng policy/cột tiền và không dùng ngoài tiến trình payment hoặc hai hàm hẹp này.
GRANT CREATE ON SCHEMA public TO app_payment;
GRANT app_payment TO app_owner;
ALTER FUNCTION record_manual_payment(uuid,bigint,uuid,text) OWNER TO app_payment;
ALTER FUNCTION reverse_manual_payment(uuid,uuid,uuid,text) OWNER TO app_payment;
REVOKE app_payment FROM app_owner;
REVOKE CREATE ON SCHEMA public FROM app_payment;

GRANT EXECUTE ON FUNCTION record_manual_payment(uuid,bigint,uuid,text) TO app_rw;
GRANT EXECUTE ON FUNCTION reverse_manual_payment(uuid,uuid,uuid,text) TO app_rw;
