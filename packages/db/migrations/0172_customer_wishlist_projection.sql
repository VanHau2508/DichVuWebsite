-- 0172 - Projection đọc hẹp cho trang sản phẩm yêu thích của khách.
--
-- apps/account đã quản lý dòng wishlist của chính khách và được đọc các cột công khai của
-- products/media từ 0100. Chỉ để vẽ thẻ sản phẩm đẹp hơn, app_customer không được nhận thêm quyền
-- đọc trực tiếp variants, tồn kho, option hay khuyến mãi. Role NOLOGIN bên dưới chỉ đọc đúng các
-- tín hiệu cần thiết qua FORCE RLS, rồi trả một phép chiếu hẹp cho app_customer.

CREATE ROLE app_customer_wishlist NOLOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO app_customer_wishlist;

GRANT SELECT (shop_id, customer_id, product_id, created_at)
  ON wishlist_items TO app_customer_wishlist;
GRANT SELECT (id, shop_id, slug, title, price_vnd, status, deleted_at)
  ON products TO app_customer_wishlist;
GRANT SELECT (id, shop_id, product_id, status, public_key, position, created_at, deleted_at)
  ON media TO app_customer_wishlist;
GRANT SELECT (id, shop_id, product_id, position)
  ON variants TO app_customer_wishlist;
GRANT SELECT (shop_id, variant_id, on_hand, reserved, safety_stock_qty)
  ON inventory_levels TO app_customer_wishlist;
GRANT SELECT (id, status, deleted_at, safety_stock_pct)
  ON shops TO app_customer_wishlist;
GRANT SELECT (id, shop_id, product_id)
  ON product_options TO app_customer_wishlist;
GRANT SELECT (shop_id, variant_id, option_id)
  ON variant_option_values TO app_customer_wishlist;
GRANT SELECT (id, shop_id, kind, value, scope, starts_at, ends_at, active)
  ON promotions TO app_customer_wishlist;
GRANT SELECT (shop_id, promotion_id, product_id)
  ON promotion_products TO app_customer_wishlist;
GRANT EXECUTE ON FUNCTION promo_effective(uuid, bigint, timestamptz)
  TO app_customer_wishlist;

-- Tất cả bảng nguồn vẫn FORCE RLS. Role làm chủ hàm chỉ thấy tenant hiện tại; riêng wishlist còn bị
-- khóa tiếp theo current_customer_id(). Policy products/media lặp lại quy tắc catalog công khai ở
-- tang database, de sau nay sua query trong ham cung khong vo tinh lo hang an hoặc anh chua xu ly.
CREATE POLICY customer_wishlist_projection_rows ON wishlist_items
  FOR SELECT TO app_customer_wishlist
  USING (shop_id = current_shop_id() AND customer_id = current_customer_id());

CREATE POLICY customer_wishlist_projection_products ON products
  FOR SELECT TO app_customer_wishlist
  USING (shop_id = current_shop_id() AND status = 'active' AND deleted_at IS NULL);

CREATE POLICY customer_wishlist_projection_media ON media
  FOR SELECT TO app_customer_wishlist
  USING (
    shop_id = current_shop_id()
    AND status = 'ready'
    AND public_key IS NOT NULL
    AND deleted_at IS NULL
  );

CREATE POLICY customer_wishlist_projection_variants ON variants
  FOR SELECT TO app_customer_wishlist
  USING (
    shop_id = current_shop_id()
    AND EXISTS (
      SELECT 1
        FROM products p
       WHERE p.shop_id = current_shop_id()
         AND p.id = variants.product_id
    )
  );

CREATE POLICY customer_wishlist_projection_inventory ON inventory_levels
  FOR SELECT TO app_customer_wishlist
  USING (
    shop_id = current_shop_id()
    AND EXISTS (
      SELECT 1
        FROM variants v
       WHERE v.shop_id = current_shop_id()
         AND v.id = inventory_levels.variant_id
    )
  );

CREATE POLICY customer_wishlist_projection_shop ON shops
  FOR SELECT TO app_customer_wishlist
  USING (
    id = current_shop_id()
    AND deleted_at IS NULL
    AND status NOT IN ('terminated', 'suspended')
  );

CREATE POLICY customer_wishlist_projection_options ON product_options
  FOR SELECT TO app_customer_wishlist
  USING (
    shop_id = current_shop_id()
    AND EXISTS (
      SELECT 1
        FROM products p
       WHERE p.shop_id = current_shop_id()
         AND p.id = product_options.product_id
    )
  );

CREATE POLICY customer_wishlist_projection_mappings ON variant_option_values
  FOR SELECT TO app_customer_wishlist
  USING (
    shop_id = current_shop_id()
    AND EXISTS (
      SELECT 1
        FROM variants v
       WHERE v.shop_id = current_shop_id()
         AND v.id = variant_option_values.variant_id
    )
  );

CREATE POLICY customer_wishlist_projection_promotions ON promotions
  FOR SELECT TO app_customer_wishlist
  USING (shop_id = current_shop_id() AND active);

CREATE POLICY customer_wishlist_projection_promotion_products ON promotion_products
  FOR SELECT TO app_customer_wishlist
  USING (shop_id = current_shop_id());

CREATE FUNCTION current_customer_wishlist()
RETURNS TABLE (
  product_id uuid,
  slug text,
  title text,
  base_price_vnd bigint,
  price_vnd bigint,
  promotion_id uuid,
  off_pct int,
  image_key text,
  available_qty bigint,
  default_variant_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_shop_id uuid := current_shop_id();
  v_customer_id uuid := current_customer_id();
BEGIN
  IF v_shop_id IS NULL OR v_customer_id IS NULL THEN
    RAISE EXCEPTION 'customer_wishlist_context_required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT p.id,
         p.slug,
         p.title,
         p.price_vnd,
         coalesce(pe.price_vnd, p.price_vnd),
         pe.promotion_id,
         pe.off_pct,
         first_media.public_key,
         stock.available_qty,
         CASE
           WHEN options.option_count = 0
            AND stock.variant_count = 1
            AND stock.only_variant_available > 0
           THEN stock.only_variant_id
           ELSE NULL
         END AS default_variant_id
    FROM wishlist_items wi
    JOIN products p
      ON p.shop_id = wi.shop_id
     AND p.id = wi.product_id
    JOIN shops s
      ON s.id = p.shop_id
    LEFT JOIN LATERAL promo_effective(p.id, p.price_vnd, now()) pe ON true
    LEFT JOIN LATERAL (
      SELECT m.public_key
        FROM media m
       WHERE m.shop_id = v_shop_id
         AND m.product_id = p.id
         AND m.status = 'ready'
         AND m.public_key IS NOT NULL
         AND m.deleted_at IS NULL
       ORDER BY m.position, m.created_at, m.id
       LIMIT 1
    ) first_media ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS option_count
        FROM product_options po
       WHERE po.shop_id = v_shop_id
         AND po.product_id = p.id
    ) options ON true
    LEFT JOIN LATERAL (
      SELECT coalesce(sum(vq.available_qty), 0)::bigint AS available_qty,
             count(*)::int AS variant_count,
             (array_agg(vq.variant_id ORDER BY vq.position, vq.variant_id))[1]
               AS only_variant_id,
             (array_agg(vq.available_qty ORDER BY vq.position, vq.variant_id))[1]
               AS only_variant_available
        FROM (
          SELECT v.id AS variant_id,
                 v.position,
                 greatest(
                   0,
                   coalesce(il.on_hand, 0)
                   - coalesce(il.reserved, 0)
                   - coalesce(
                       il.safety_stock_qty,
                       ceil(coalesce(il.on_hand, 0) * s.safety_stock_pct / 100.0)::int
                     )
                 )::int AS available_qty
            FROM variants v
            LEFT JOIN inventory_levels il
              ON il.shop_id = v.shop_id
             AND il.variant_id = v.id
           WHERE v.shop_id = v_shop_id
             AND v.product_id = p.id
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
        ) vq
    ) stock ON true
   WHERE wi.shop_id = v_shop_id
     AND wi.customer_id = v_customer_id
     AND p.status = 'active'
     AND p.deleted_at IS NULL
   ORDER BY wi.created_at DESC, p.id
   LIMIT 100;
END;
$$;

REVOKE ALL ON FUNCTION current_customer_wishlist() FROM PUBLIC;

-- Chuyển ownership để app_owner không trở thành SECURITY DEFINER lúc runtime. PostgreSQL cần
-- membership tạm và quyền CREATE trên schema để ALTER OWNER; cả hai được thu hồi ngay trong
-- migration này.
GRANT CREATE ON SCHEMA public TO app_customer_wishlist;
GRANT app_customer_wishlist TO app_owner;
GRANT EXECUTE ON FUNCTION current_customer_wishlist() TO app_customer;
ALTER FUNCTION current_customer_wishlist() OWNER TO app_customer_wishlist;
REVOKE app_customer_wishlist FROM app_owner;
REVOKE CREATE ON SCHEMA public FROM app_customer_wishlist;
