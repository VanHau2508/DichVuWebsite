-- 0160 — READINESS + GO-LIVE: onboarding chỉ được xem trước, chưa được nhận đơn công khai.
--
-- Trước migration này, `shops.status='onboarding'` chỉ là nhãn: app_checkout vẫn có thể
-- reserve tồn và tạo đơn. Vì vậy nút "Mở bán" không bảo vệ gì, còn một shop cấu hình dở
-- vẫn có thể nhận tiền/đơn thật. Chốt mới nằm ở hai lớp:
--   1. seller kiểm readiness phía server trước khi đổi onboarding → active;
--   2. RLS của vai công khai chỉ cho ghi giỏ/tồn/đơn/outbox khi shop đã active.
-- Lớp (2) giữ bất biến ngay cả khi về sau một route checkout mới quên gọi chốt ở HTTP.

ALTER TABLE shops ADD COLUMN went_live_at timestamptz;

-- Shop onboarding đã từng có đơn là shop đang bán thật từ trước. Khoá chúng sau deploy sẽ
-- là hồi quy nặng hơn lỗ đang vá, nên lấy mốc đơn đầu tiên làm bằng chứng để backfill active.
UPDATE shops s
   SET status = 'active',
       went_live_at = coalesce(s.went_live_at, (
         SELECT min(o.created_at) FROM orders o WHERE o.shop_id = s.id
       ))
 WHERE s.status = 'onboarding'
   AND EXISTS (SELECT 1 FROM orders o WHERE o.shop_id = s.id);

-- Token xem trước TOÀN storefront. Giống page_previews: chỉ lưu hash, TTL cưỡng chế ở RLS,
-- một shop có tối đa một token còn hiệu lực (cấp token mới làm token cũ chết ngay).
CREATE TABLE shop_previews (
  shop_id     uuid PRIMARY KEY REFERENCES shops (id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  created_by  uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);

ALTER TABLE shop_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_previews FORCE  ROW LEVEL SECURITY;

-- Default privileges cấp CRUD cho app_rw; preview chỉ cần đọc/cấp lại, không cần xoá tay.
REVOKE ALL ON shop_previews FROM PUBLIC, app_rw;
GRANT SELECT, INSERT, UPDATE ON shop_previews TO app_rw;
CREATE POLICY tenant_isolation ON shop_previews FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

GRANT SELECT ON shop_previews TO app_store;
CREATE POLICY store_shop_preview ON shop_previews FOR SELECT TO app_store
  USING (shop_id = current_shop_id() AND expires_at > now());

-- Một nguồn sự thật cho mọi policy ghi của app_checkout. SECURITY INVOKER: không nâng quyền,
-- vai gọi vẫn phải nhìn được đúng shop qua checkout_shop + current_shop_id().
CREATE FUNCTION current_shop_is_live() RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM shops s
     WHERE s.id = current_shop_id() AND s.status = 'active' AND s.deleted_at IS NULL
  )
$$;

REVOKE ALL ON FUNCTION current_shop_is_live() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_shop_is_live() TO app_checkout;

-- Thay (không cộng thêm) policy permissive: nhiều policy cùng lệnh sẽ OR và vô hiệu chốt.
DROP POLICY checkout_inv ON inventory_levels;
CREATE POLICY checkout_inv ON inventory_levels FOR ALL TO app_checkout
  USING (shop_id = current_shop_id() AND current_shop_is_live())
  WITH CHECK (shop_id = current_shop_id() AND current_shop_is_live());

DROP POLICY checkout_carts ON carts;
CREATE POLICY checkout_carts ON carts FOR ALL TO app_checkout
  USING (shop_id = current_shop_id() AND current_shop_is_live())
  WITH CHECK (shop_id = current_shop_id() AND current_shop_is_live());

DROP POLICY checkout_citems ON cart_items;
CREATE POLICY checkout_citems ON cart_items FOR ALL TO app_checkout
  USING (shop_id = current_shop_id() AND current_shop_is_live())
  WITH CHECK (shop_id = current_shop_id() AND current_shop_is_live());

DROP POLICY checkout_orders ON orders;
CREATE POLICY checkout_orders ON orders FOR ALL TO app_checkout
  USING (shop_id = current_shop_id() AND current_shop_is_live())
  WITH CHECK (shop_id = current_shop_id() AND current_shop_is_live());

DROP POLICY checkout_olines ON order_lines;
CREATE POLICY checkout_olines ON order_lines FOR ALL TO app_checkout
  USING (shop_id = current_shop_id() AND current_shop_is_live())
  WITH CHECK (shop_id = current_shop_id() AND current_shop_is_live());

DROP POLICY checkout_idem ON idempotency_keys;
CREATE POLICY checkout_idem ON idempotency_keys FOR ALL TO app_checkout
  USING (shop_id = current_shop_id() AND current_shop_is_live())
  WITH CHECK (shop_id = current_shop_id() AND current_shop_is_live());

DROP POLICY checkout_counter ON shop_counters;
CREATE POLICY checkout_counter ON shop_counters FOR ALL TO app_checkout
  USING (shop_id = current_shop_id() AND current_shop_is_live())
  WITH CHECK (shop_id = current_shop_id() AND current_shop_is_live());

DROP POLICY checkout_outbox ON outbox;
CREATE POLICY checkout_outbox ON outbox FOR INSERT TO app_checkout
  WITH CHECK (shop_id = current_shop_id() AND current_shop_is_live());

DROP POLICY order_events_checkout ON order_events;
CREATE POLICY order_events_checkout ON order_events FOR ALL TO app_checkout
  USING (shop_id = current_shop_id() AND current_shop_is_live())
  WITH CHECK (shop_id = current_shop_id() AND current_shop_is_live());
