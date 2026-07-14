-- 0032 — seller (app_rw) đọc plans để ÉP giới hạn gói (max_products).
--
-- Ép gói: khi thêm sản phẩm, seller đọc gói của shop (subscriptions → plans.max_products)
-- rồi chặn nếu vượt. app_rw đã đọc được subscriptions (RLS tenant) nhưng plans chỉ cấp cho
-- app_platform (0006). plans là dữ liệu THAM CHIẾU toàn cục (không shop_id, không PII) → cấp
-- SELECT cho app_rw là an toàn.

GRANT SELECT ON plans TO app_rw;
