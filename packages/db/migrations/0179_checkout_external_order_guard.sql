-- 0179 - trigger đơn ngoài phải đọc connector qua vai guard.
--
-- app_checkout không có quyền đọc trực tiếp shop_integrations; trigger cũ chạy dưới
-- vai gọi (SECURITY INVOKER) nên INSERT đơn external-master luôn chết với
-- "permission denied". Đưa trigger sang vai NOLOGIN có policy xuyên FORCE RLS,
-- nhưng vẫn dùng session_user để giữ đúng phân biệt app_checkout/app_expiry/
-- app_integration trong các nhánh bảo vệ.

CREATE OR REPLACE FUNCTION guard_external_order_local_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor text := session_user;
  v_integration_status text;
  v_integration_authority text;
  v_integration_generation bigint;
  v_integration_branch text;
BEGIN
  IF v_actor IN ('app_integration','app_integration_guard') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  -- Nghĩa vụ ẩn danh PII vẫn áp cho bản chiếu POS. Chỉ mở đúng các cột scrub + customer_id
  -- về NULL; app_expiry không được nhân ngoại lệ này để gán lại một customer bất kỳ.
  IF TG_OP = 'UPDATE' AND v_actor = 'app_expiry'
     AND (to_jsonb(NEW) - ARRAY[
            'customer_name','customer_phone','customer_email','shipping_address',
            'client_ip_hash','anonymized_at','customer_id'
          ]::text[])
         = (to_jsonb(OLD) - ARRAY[
            'customer_name','customer_phone','customer_email','shipping_address',
            'client_ip_hash','anonymized_at','customer_id'
          ]::text[])
     AND NEW.customer_name = '(đã ẩn danh)'
     AND NEW.customer_phone IS NULL AND NEW.customer_email IS NULL
     AND NEW.shipping_address IS NULL AND NEW.client_ip_hash IS NULL
     AND NEW.anonymized_at IS NOT NULL
     AND NEW.customer_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- Checkout công khai chỉ được tạo đơn website pending, chưa thanh toán.
  IF TG_OP = 'INSERT' AND v_actor = 'app_checkout' THEN
    IF NEW.source IS DISTINCT FROM 'web'
       OR NEW.status IS DISTINCT FROM 'pending'
       OR NEW.payment_status IS DISTINCT FROM 'unpaid'
       OR NEW.external_ref IS NOT NULL
       OR NEW.paid_at IS NOT NULL
       OR NEW.amount_paid_vnd IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'PIO01',
        MESSAGE = 'Checkout chỉ được tạo đơn website pending, chưa thanh toán.';
    END IF;
    IF NEW.integration_id IS NULL THEN
      IF NEW.integration_generation IS NOT NULL OR NEW.external_branch_ref IS NOT NULL
         OR NEW.sync_status IS DISTINCT FROM 'not_required' THEN
        RAISE EXCEPTION USING ERRCODE = 'PIO01',
          MESSAGE = 'Đơn local phải chưa gắn connector POS.';
      END IF;
    ELSE
      SELECT status, inventory_authority, generation, external_branch_ref
        INTO v_integration_status, v_integration_authority,
             v_integration_generation, v_integration_branch
        FROM shop_integrations
       WHERE id = NEW.integration_id AND shop_id = NEW.shop_id;
      IF NOT FOUND OR v_integration_status <> 'active'
         OR v_integration_authority <> 'external_master'
         OR NEW.integration_generation IS DISTINCT FROM v_integration_generation
         OR NEW.external_branch_ref IS DISTINCT FROM v_integration_branch
         OR NEW.payment_method IS DISTINCT FROM 'cod'
         OR NEW.sync_status IS DISTINCT FROM 'pending' THEN
        RAISE EXCEPTION USING ERRCODE = 'PIO01',
          MESSAGE = 'Đơn website external-master phải là COD pending của connector đang active.';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (TG_OP = 'INSERT' AND (
        NEW.source IN ('kiotviet_pos','sapo_pos') OR NEW.integration_id IS NOT NULL
        OR NEW.external_ref IS NOT NULL OR NEW.integration_generation IS NOT NULL
      )) OR (TG_OP = 'DELETE' AND (
        OLD.source IN ('kiotviet_pos','sapo_pos') OR OLD.external_ref IS NOT NULL
      )) OR (TG_OP = 'UPDATE' AND (
        OLD.source IN ('kiotviet_pos','sapo_pos') OR OLD.external_ref IS NOT NULL
        OR NEW.source IS DISTINCT FROM OLD.source
        OR NEW.integration_id IS DISTINCT FROM OLD.integration_id
        OR NEW.integration_generation IS DISTINCT FROM OLD.integration_generation
        OR NEW.external_ref IS DISTINCT FROM OLD.external_ref
        OR NEW.external_branch_ref IS DISTINCT FROM OLD.external_branch_ref
      )) THEN
    RAISE EXCEPTION USING ERRCODE = 'PIO01',
      MESSAGE = 'Đơn đã thuộc POS ngoài; hãy thao tác tại POS và chờ đồng bộ về nền tảng.';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
ALTER FUNCTION guard_external_order_local_update() OWNER TO app_integration_guard;
REVOKE ALL ON FUNCTION guard_external_order_local_update() FROM PUBLIC;
