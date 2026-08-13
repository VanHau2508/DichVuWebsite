-- 0148: Chủ shop chỉ được TẠO yêu cầu trả tiền pending và HUỶ yêu cầu pending.
--
-- 0124 có ý đúng nhưng `GRANT SELECT, INSERT` không thu hồi CRUD mà default privileges
-- 0003 đã tự cấp cho app_rw. Hậu quả đo được: app_rw chèn thẳng status='paid', paid_at và
-- applied_at thành công — tenant tự tuyên bố đã trả thuê bao. Khoá cả CỘT lẫn DÒNG:
--   · INSERT chỉ các input nghiệp vụ; status/timestamp bắt buộc dùng default an toàn;
--   · UPDATE chỉ cột status, và policy chỉ cho pending → cancelled;
--   · DELETE không có đường nào.

DROP POLICY tenant_isolation ON billing_charges;
REVOKE ALL ON billing_charges FROM app_rw;

CREATE POLICY tenant_billing_select ON billing_charges FOR SELECT TO app_rw
  USING (shop_id = current_shop_id());

CREATE POLICY tenant_billing_insert ON billing_charges FOR INSERT TO app_rw
  WITH CHECK (
    shop_id = current_shop_id()
    AND status = 'pending'
    AND paid_at IS NULL
    AND applied_at IS NULL
  );

CREATE POLICY tenant_billing_cancel ON billing_charges FOR UPDATE TO app_rw
  USING (shop_id = current_shop_id() AND status = 'pending')
  WITH CHECK (
    shop_id = current_shop_id()
    AND status = 'cancelled'
    AND paid_at IS NULL
    AND applied_at IS NULL
  );

GRANT SELECT ON billing_charges TO app_rw;
GRANT INSERT (shop_id, plan_code, months, amount_vnd, pay_ref, expires_at)
  ON billing_charges TO app_rw;
GRANT UPDATE (status) ON billing_charges TO app_rw;
