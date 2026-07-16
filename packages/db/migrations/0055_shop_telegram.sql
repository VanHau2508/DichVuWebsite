-- 0055 — Kênh THÔNG BÁO TELEGRAM per-shop. MỘT bot nền tảng phục vụ mọi shop; mỗi shop
-- link chat riêng (chat_id) qua deep-link /start <link_code>. Thông báo đơn mới / thanh toán /
-- huỷ / sắp hết hàng bắn tới chat của chủ shop. Chỉ config (chat_id) — không PII khách.

CREATE TABLE shop_telegram (
  shop_id    uuid PRIMARY KEY REFERENCES shops (id),
  chat_id    text,                             -- Telegram chat id (có khi ĐÃ link)
  link_code  text,                             -- mã 1 lần đang chờ /start (xoá khi link xong)
  enabled    boolean NOT NULL DEFAULT true,
  linked_at  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX shop_telegram_link_code_idx ON shop_telegram (link_code) WHERE link_code IS NOT NULL;

ALTER TABLE shop_telegram ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_telegram FORCE  ROW LEVEL SECURITY;

-- Seller (app_rw): shop tự kết nối/ngắt.
CREATE POLICY tenant_isolation ON shop_telegram FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON shop_telegram TO app_rw;

-- Worker (app_expiry): bind chat_id khi nhận /start (tra theo link_code) + đọc chat_id để
-- định tuyến thông báo. Cross-shop (job hệ thống). Chỉ cột cần.
GRANT SELECT (shop_id, chat_id, link_code, enabled) ON shop_telegram TO app_expiry;
GRANT UPDATE (chat_id, link_code, linked_at)        ON shop_telegram TO app_expiry;
CREATE POLICY expiry_telegram ON shop_telegram FOR ALL TO app_expiry USING (true) WITH CHECK (true);
