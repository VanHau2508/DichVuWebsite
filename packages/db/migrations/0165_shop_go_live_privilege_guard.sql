-- 0165 — CHỐT QUYỀN GO-LIVE: seller không được tự lật trạng thái shop bằng UPDATE thường.
--
-- 0160 đã chặn checkout của shop onboarding và route seller đã kiểm readiness phía server.
-- Tuy nhiên app_rw vẫn còn UPDATE toàn bảng shops từ 0003, nên một route mới viết sai có thể
-- đổi thẳng status/went_live_at và bỏ qua checklist. Migration này biến go-live thành cửa hẹp:
--   • app_rw chỉ còn UPDATE các cột cấu hình seller thực sự quản lý;
--   • status + went_live_at chỉ đổi được qua activate_current_shop_after_readiness();
--   • hàm không nhận shop_id, chỉ chuyển đúng current_shop_id() onboarding → active;
--   • platform/billing giữ nguyên grant và policy riêng cho vòng đời suspend/reactivate.

-- Shop legacy đã có đơn: phục hồi cả backfill onboarding → active của 0160 trong trường hợp
-- migration đó bị FORCE RLS che hết dòng, đồng thời chuẩn hóa mốc go-live của shop active.
-- Ưu tiên bằng chứng đơn đầu tiên. Đơn lịch sử có thể mang ngày trước lúc tenant được tạo hoặc
-- ngày tương lai, nên chặn trong [shops.created_at, now()].
-- Shop active chưa có đơn dùng thời điểm migration — mốc bảo thủ, không suy diễn rằng shop đã
-- bán từ ngày tạo tài khoản.
--
-- `shops` và `orders` đã FORCE RLS, còn app_owner production không có BYPASSRLS. Vì vậy backfill
-- cần policy tạm cho đúng vai trò migration; nếu không câu lệnh vẫn có thể thành công nhưng nhìn
-- thấy 0 dòng. Policy chỉ mở các dòng cần chuẩn hóa và được gỡ ngay sau toàn bộ backfill.
CREATE POLICY go_live_backfill_owner_read ON shops
  FOR SELECT TO app_owner
  USING (status IN ('active', 'onboarding') AND deleted_at IS NULL);

CREATE POLICY go_live_backfill_owner_update ON shops
  FOR UPDATE TO app_owner
  USING (status IN ('active', 'onboarding') AND deleted_at IS NULL)
  WITH CHECK (
    status = 'active'
    AND deleted_at IS NULL
    AND went_live_at IS NOT NULL
    AND went_live_at >= created_at
    AND went_live_at <= now()
  );

CREATE POLICY go_live_backfill_orders_owner_read ON orders
  FOR SELECT TO app_owner
  USING (true);

-- Chỉ phục hồi shop đã có đơn TRƯỚC lúc 0160 được ghi nhận. Đơn seller/test tạo sau 0160 không
-- được phép tự biến onboarding thành active và bỏ qua checklist readiness.
WITH readiness_cutoff AS (
  SELECT applied_at
    FROM schema_migrations
   WHERE version = '0160_shop_readiness_go_live'
), legacy_first_orders AS (
  SELECT o.shop_id, min(o.created_at) AS first_order_at
    FROM orders o
    CROSS JOIN readiness_cutoff c
   WHERE o.created_at <= c.applied_at
   GROUP BY o.shop_id
)
UPDATE shops s
   SET status = 'active',
       went_live_at = LEAST(
         now(),
         GREATEST(s.created_at, f.first_order_at)
       )
  FROM legacy_first_orders f
 WHERE s.id = f.shop_id
   AND s.status = 'onboarding'
   AND s.deleted_at IS NULL;

-- 0160 đã điền thẳng min(order.created_at) cho shop onboarding có đơn. Vì vậy các mốc legacy
-- sai biên ở đó đã KHÔNG còn NULL; dùng lại đơn đầu tiên thay vì giữ rồi clamp timestamp sai.
WITH first_orders AS (
  SELECT shop_id, min(created_at) AS first_order_at
    FROM orders
   GROUP BY shop_id
)
UPDATE shops s
   SET went_live_at = LEAST(
         now(),
         GREATEST(s.created_at, f.first_order_at)
       )
  FROM first_orders f
 WHERE s.id = f.shop_id
   AND s.status = 'active'
   AND s.deleted_at IS NULL
   AND (
     s.went_live_at IS NULL
     OR s.went_live_at < s.created_at
     OR s.went_live_at > now()
   );

UPDATE shops
   SET went_live_at = LEAST(
         now(),
         GREATEST(created_at, coalesce(went_live_at, now()))
       )
 WHERE status = 'active'
   AND deleted_at IS NULL
   AND (
     went_live_at IS NULL
     OR went_live_at < created_at
     OR went_live_at > now()
   );

DROP POLICY go_live_backfill_owner_read ON shops;
DROP POLICY go_live_backfill_owner_update ON shops;
DROP POLICY go_live_backfill_orders_owner_read ON orders;

-- Tenant root không phải tài nguyên CRUD của seller. Giữ đúng các cột mà route seller hiện tại
-- quản lý; cột lifecycle/nguồn tạo/mốc worker không tự động lọt vào grant khi được thêm về sau.
REVOKE INSERT, UPDATE, DELETE ON shops FROM app_rw;
GRANT UPDATE (
  name,
  contact_email,
  contact_phone,
  business_address,
  ship_fee_vnd,
  free_ship_threshold_vnd,
  low_stock_threshold,
  max_pending_per_ip,
  max_pending_per_phone,
  ship_fee_far_vnd,
  ship_extra_per_500g_vnd,
  default_weight_gram,
  ship_from_province,
  pii_retention_months,
  ship_mode,
  ship_origin_lat,
  ship_origin_lng,
  ship_base_vnd,
  ship_per_km_vnd,
  ship_max_km,
  ship_road_factor,
  ship_over_max_behavior,
  require_mfa,
  logo_key,
  safety_stock_pct
) ON shops TO app_rw;

-- Role NOLOGIN chỉ làm chủ hàm SECURITY DEFINER. Nó không có mật khẩu/CONNECT, chỉ đọc các
-- cột blocker readiness và chỉ đổi status/went_live_at của current_shop_id(). FORCE RLS vẫn có
-- hiệu lực trong production, vì function-owner khớp policy hẹp thay vì dựa vào superuser.
CREATE ROLE app_go_live NOLOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO app_go_live;
GRANT SELECT (
        id, status, deleted_at, went_live_at,
        contact_email, contact_phone,
        ship_fee_vnd, ship_fee_far_vnd, ship_from_province, ship_mode,
        ship_origin_lat, ship_origin_lng, ship_base_vnd, ship_per_km_vnd, ship_max_km,
        safety_stock_pct
      ),
      UPDATE (status, went_live_at)
  ON shops TO app_go_live;

GRANT SELECT (id, shop_id, status, deleted_at, created_at)
  ON products TO app_go_live;
GRANT SELECT (id, shop_id, product_id, price_vnd, position)
  ON variants TO app_go_live;
GRANT SELECT (shop_id, variant_id, on_hand, reserved, safety_stock_qty)
  ON inventory_levels TO app_go_live;
GRANT SELECT (id, shop_id, product_id)
  ON product_options TO app_go_live;
GRANT SELECT (shop_id, variant_id, option_id)
  ON variant_option_values TO app_go_live;
GRANT SELECT (shop_id, slug, status, published_revision_id, deleted_at)
  ON pages TO app_go_live;
GRANT SELECT (shop_id, verified_at)
  ON domains TO app_go_live;

CREATE POLICY go_live_shop_read ON shops FOR SELECT TO app_go_live
  USING (id = current_shop_id());

CREATE POLICY go_live_shop_update ON shops FOR UPDATE TO app_go_live
  USING (
    id = current_shop_id()
    AND status = 'onboarding'
    AND deleted_at IS NULL
  )
  WITH CHECK (
    id = current_shop_id()
    AND status = 'active'
    AND went_live_at IS NOT NULL
    AND deleted_at IS NULL
  );

-- Hàm cần đọc đúng các tín hiệu readiness của một tenant, không cần quyền ghi lên bảng nào
-- ngoài hai cột lifecycle của shops. Policy tách theo bảng để FORCE RLS vẫn fail-closed.
CREATE POLICY go_live_read ON products FOR SELECT TO app_go_live
  USING (shop_id = current_shop_id());
CREATE POLICY go_live_read ON variants FOR SELECT TO app_go_live
  USING (shop_id = current_shop_id());
CREATE POLICY go_live_read ON inventory_levels FOR SELECT TO app_go_live
  USING (shop_id = current_shop_id());
CREATE POLICY go_live_read ON product_options FOR SELECT TO app_go_live
  USING (shop_id = current_shop_id());
CREATE POLICY go_live_read ON variant_option_values FOR SELECT TO app_go_live
  USING (shop_id = current_shop_id());
CREATE POLICY go_live_read ON pages FOR SELECT TO app_go_live
  USING (shop_id = current_shop_id());
CREATE POLICY go_live_read ON domains FOR SELECT TO app_go_live
  USING (shop_id = current_shop_id());

CREATE FUNCTION activate_current_shop_after_readiness()
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
     -- Chọn đúng biến thể mẫu như computeReadiness(): active, không mồ côi, ATS > 0.
     -- Ép numeric trước phép cộng để một bigint cực đoan không gây overflow; giới hạn trên
     -- là Number.MAX_SAFE_INTEGER vì seller trả dry-run qua JSON/JavaScript.
     AND EXISTS (
       SELECT 1
         FROM (
           SELECT v.price_vnd
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

REVOKE ALL ON FUNCTION activate_current_shop_after_readiness() FROM PUBLIC;

-- SECURITY DEFINER không thuộc app_owner: FORCE RLS sẽ làm owner thường không thấy dòng nào.
-- Chuyển ownership bằng membership tạm rồi thu hồi lại ngay trong migration.
GRANT CREATE ON SCHEMA public TO app_go_live;
GRANT app_go_live TO app_owner;
-- Cấp EXECUTE khi app_owner vẫn là function-owner. Nếu đặt sau ALTER OWNER + REVOKE membership,
-- app_owner production không phải superuser sẽ không còn grant option và migration bị dừng.
GRANT EXECUTE ON FUNCTION activate_current_shop_after_readiness() TO app_rw;
ALTER FUNCTION activate_current_shop_after_readiness() OWNER TO app_go_live;
REVOKE app_go_live FROM app_owner;
REVOKE CREATE ON SCHEMA public FROM app_go_live;
