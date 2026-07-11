-- 0022 — vòng đời tồn kho khép kín (P0-5): role app_expiry cho job hết hạn đơn QR.
--
-- reserve (checkout) phải LUÔN kết thúc bằng release HOẶC consume:
--   • cancel  → release (đã có, orders.js)
--   • ship    → consume (on_hand -= qty, reserved -= qty, ledger 'ship') — sửa ở seller
--   • expire  → release — job nền quét đơn QR chưa trả tiền quá hạn (worker)
--
-- Job expire chạy CROSS-SHOP (quét mọi shop) nên KHÔNG dùng app_rw (tenant-scoped) và
-- KHÔNG mở rộng app_worker (chỉ outbox). Role riêng app_expiry, cực hẹp: chỉ đọc cột
-- KHÔNG-PII của orders + đổi trạng thái, đọc order_lines, và giảm reserved. Không đụng
-- tiền, tên/điện thoại/địa chỉ khách, hay on_hand.

CREATE ROLE app_expiry LOGIN PASSWORD 'devpassword'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE app TO app_expiry;
GRANT USAGE   ON SCHEMA public TO app_expiry;

-- Quyền theo CỘT (không chạm PII/tiền/on_hand).
GRANT SELECT (id, shop_id, status, payment_status, payment_method, created_at) ON orders TO app_expiry;
GRANT UPDATE (status, cancelled_at)                                            ON orders TO app_expiry;
GRANT SELECT (order_id, variant_id, qty)                                       ON order_lines TO app_expiry;
GRANT SELECT (shop_id, variant_id, reserved), UPDATE (reserved, updated_at)    ON inventory_levels TO app_expiry;

-- Job nền hệ thống (không theo tenant) → policy cross-shop. RLS vẫn FORCE; quyền cột ở
-- trên mới là thứ giới hạn thực sự (chỉ trạng thái + reserved, không PII/tiền).
CREATE POLICY expiry_orders      ON orders           FOR ALL    TO app_expiry USING (true) WITH CHECK (true);
CREATE POLICY expiry_order_lines ON order_lines      FOR SELECT TO app_expiry USING (true);
CREATE POLICY expiry_levels      ON inventory_levels FOR ALL    TO app_expiry USING (true) WITH CHECK (true);
