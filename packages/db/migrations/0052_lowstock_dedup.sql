-- 0052 — vá cảnh báo sắp hết hàng (0050): idempotent THEO NGÀY. Chống gửi email TRÙNG khi
-- /internal/lowstock-sweep bị gọi nhiều lần trong ngày (cron/e2e). Claim nguyên tử per-shop.

ALTER TABLE shops ADD COLUMN low_stock_alerted_on date;

GRANT UPDATE (low_stock_alerted_on) ON shops TO app_expiry;
CREATE POLICY expiry_shops_upd ON shops FOR UPDATE TO app_expiry USING (true) WITH CHECK (true);
