-- 0183 — nối chốt nguồn tồn external-master vào cửa hẹp go-live.
--
-- Đo trên nhánh readiness: tầng ứng dụng trả 409 cho connector degraded, nhưng gọi thẳng
-- activate_current_shop_after_readiness() vẫn mở shop (mã 200/active). Đây là lớp phòng thủ
-- thứ hai của 0165, nên phải được dựng lại ở DB thay vì tin riêng vào route seller.
--
-- Độ tươi không nằm trong hàm này có chủ ý. Go-live là một khẳng định tại một thời điểm;
-- nó không phải bảo đảm provider sẽ tiếp tục tươi sau đó. Readiness và checkout vẫn kiểm
-- inventory_synced_at trong 5 phút khi quyết định có cho khách đặt hàng hay không.
-- Shop đã active sẵn không bị hồi tố: hàm chỉ UPDATE dòng đang onboarding như 0165.

-- app_go_live là chủ sở hữu hàm và 0165 đã thu hồi membership ở cuối file. Cấp membership
-- tạm để app_owner có quyền CREATE OR REPLACE, sau đó trả ownership và thu hồi lại ngay.
GRANT app_go_live TO app_owner;

GRANT SELECT (id, shop_id, status, inventory_authority, generation)
  ON shop_integrations TO app_go_live;
GRANT SELECT (shop_id, integration_id, entity_type, local_id, mapping_status, inventory_generation)
  ON integration_entity_refs TO app_go_live;

CREATE POLICY go_live_integration_read ON shop_integrations
  FOR SELECT TO app_go_live
  USING (shop_id = current_shop_id());
CREATE POLICY go_live_integration_ref_read ON integration_entity_refs
  FOR SELECT TO app_go_live
  USING (shop_id = current_shop_id());

CREATE OR REPLACE FUNCTION activate_current_shop_after_readiness()
RETURNS TABLE (status text, went_live_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_shop_id uuid := current_shop_id();
BEGIN
  IF v_shop_id IS NULL THEN
    RAISE EXCEPTION 'shop_context_required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  UPDATE shops s
     SET status = 'active',
         went_live_at = now()
   WHERE s.id = v_shop_id
     AND s.status = 'onboarding'
     AND s.deleted_at IS NULL
     -- Cùng công thức shippingReady() của seller. COD là phương thức nền nên không cần đọc
     -- shop_payment_config; QR chỉ là lựa chọn bổ sung và không được biến thành blocker.
     AND CASE WHEN s.ship_mode = 'distance' THEN
       s.ship_origin_lat IS NOT NULL
       AND s.ship_origin_lng IS NOT NULL
       AND s.ship_base_vnd IS NOT NULL
       AND s.ship_per_km_vnd IS NOT NULL
       AND s.ship_max_km IS NOT NULL
       AND s.ship_from_province IS NOT NULL
       AND s.ship_fee_far_vnd IS NOT NULL
     ELSE s.ship_fee_vnd IS NOT NULL END
     AND (
       NULLIF(btrim(coalesce(s.contact_email, '')), '') IS NOT NULL
       OR NULLIF(btrim(coalesce(s.contact_phone, '')), '') IS NOT NULL
     )
     AND EXISTS (
       SELECT 1
         FROM pages p
        WHERE p.shop_id = v_shop_id
          AND p.status = 'published'
          AND p.published_revision_id IS NOT NULL
          AND p.deleted_at IS NULL
          AND p.slug = ANY(ARRAY[
            'chinh-sach-mua-hang', 'dieu-khoan-mua-hang',
            'chinh-sach-doi-tra', 'dieu-khoan'
          ]::text[])
     )
     AND EXISTS (
       SELECT 1
         FROM pages p
        WHERE p.shop_id = v_shop_id
          AND p.status = 'published'
          AND p.published_revision_id IS NOT NULL
          AND p.deleted_at IS NULL
          AND p.slug = ANY(ARRAY[
            'chinh-sach-bao-mat', 'bao-mat', 'quyen-rieng-tu'
          ]::text[])
     )
     AND EXISTS (
       SELECT 1 FROM domains d
        WHERE d.shop_id = v_shop_id AND d.verified_at IS NOT NULL
     )
     -- Một external-master chưa active là blocker bền của go-live. Index unique
     -- shop_integrations_one_external_master bảo đảm tối đa một dòng external-master/shop.
     AND NOT EXISTS (
       SELECT 1
         FROM shop_integrations si
        WHERE si.shop_id = v_shop_id
          AND si.inventory_authority = 'external_master'
          AND si.status <> 'active'
     )
     -- Chọn đúng biến thể mẫu như computeReadiness(): active, không mồ côi, ATS > 0.
     -- Với external-master, mẫu phải có ref mapped đúng generation của connector. Không
     -- lặp si.status='active' ở đây: blocker phía trên đã là một chốt duy nhất cho trạng thái.
     -- Không kiểm freshness ở DB; đó là bằng chứng nhất thời do readiness/checkout kiểm.
     AND EXISTS (
       SELECT 1
         FROM (
           SELECT v.id, v.price_vnd
             FROM products p
             JOIN variants v
               ON v.shop_id = p.shop_id AND v.product_id = p.id
             JOIN inventory_levels il
               ON il.shop_id = v.shop_id AND il.variant_id = v.id
            WHERE p.shop_id = v_shop_id
              AND p.status = 'active'
              AND p.deleted_at IS NULL
              AND v.price_vnd >= 0
              AND NOT EXISTS (
                SELECT 1
                  FROM product_options po
                 WHERE po.shop_id = v_shop_id
                   AND po.product_id = v.product_id
                   AND NOT EXISTS (
                     SELECT 1
                       FROM variant_option_values vov
                      WHERE vov.shop_id = v_shop_id
                        AND vov.variant_id = v.id
                        AND vov.option_id = po.id
                   )
              )
              AND (
                NOT EXISTS (
                  SELECT 1
                    FROM shop_integrations si
                   WHERE si.shop_id = v_shop_id
                     AND si.inventory_authority = 'external_master'
                )
                OR EXISTS (
                  SELECT 1
                    FROM shop_integrations si
                    JOIN integration_entity_refs ier
                      ON ier.shop_id = si.shop_id
                     AND ier.integration_id = si.id
                   WHERE si.shop_id = v_shop_id
                     AND si.inventory_authority = 'external_master'
                     AND ier.entity_type = 'variant'
                     AND ier.local_id = v.id
                     AND ier.mapping_status = 'mapped'
                     AND ier.inventory_generation = si.generation
                )
              )
              AND greatest(
                0,
                il.on_hand - il.reserved - coalesce(
                  il.safety_stock_qty,
                  ceil(il.on_hand * s.safety_stock_pct / 100.0)::int
                )
              ) > 0
            ORDER BY p.created_at, v.position, v.id
            LIMIT 1
         ) sample
        WHERE sample.price_vnd::numeric
              + (CASE WHEN s.ship_mode = 'distance'
                  THEN s.ship_fee_far_vnd ELSE s.ship_fee_vnd END)::numeric
              BETWEEN 0::numeric AND 9007199254740991::numeric
     )
  RETURNING s.status, s.went_live_at;
END;
$$;

ALTER FUNCTION activate_current_shop_after_readiness() OWNER TO app_go_live;
REVOKE app_go_live FROM app_owner;
