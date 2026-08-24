-- 0180 - không ghi bút toán hoàn cục bộ cho đơn đang thuộc POS ngoài.
--
-- Connector chưa được phép suy đoán API hoàn tiền của provider. Cho tới khi spike
-- KiotViet xác minh được đường hoàn hai chiều, mọi refund của đơn external-master,
-- đơn POS ngoài hoặc đơn đã nhận external_ref phải dừng ở DB thay vì tạo lệch tiền.
-- Chốt này bổ trợ guard sửa orders: không một route mới nào có thể lách chỉ vì nó
-- ghi bảng refunds thay vì cập nhật trực tiếp orders.

CREATE FUNCTION guard_external_order_refund()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_source text;
  v_external_ref text;
  v_integration_id uuid;
  v_inventory_authority text;
BEGIN
  SELECT o.source, o.external_ref, o.integration_id, i.inventory_authority
    INTO v_source, v_external_ref, v_integration_id, v_inventory_authority
    FROM orders o
    LEFT JOIN shop_integrations i
      ON i.shop_id = o.shop_id AND i.id = o.integration_id
   WHERE o.shop_id = NEW.shop_id AND o.id = NEW.order_id;

  IF v_source IN ('kiotviet_pos', 'sapo_pos')
     OR v_external_ref IS NOT NULL
     OR v_integration_id IS NOT NULL
     OR v_inventory_authority = 'external_master' THEN
    RAISE EXCEPTION USING ERRCODE = 'PIF01',
      MESSAGE = 'Đơn thuộc POS ngoài; chưa có đường hoàn tiền provider đã xác minh.';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION guard_external_order_refund() OWNER TO app_integration_guard;
REVOKE ALL ON FUNCTION guard_external_order_refund() FROM PUBLIC;

CREATE TRIGGER external_order_refund_guard
BEFORE INSERT ON refunds
FOR EACH ROW EXECUTE FUNCTION guard_external_order_refund();

COMMENT ON FUNCTION guard_external_order_refund() IS
  'Fail-closed refund cục bộ cho đơn POS ngoài cho tới khi connector có API hoàn tiền đã xác minh.';
