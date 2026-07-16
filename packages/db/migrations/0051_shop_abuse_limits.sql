-- 0051 — Shop TỰ CHỈNH ngưỡng chống đơn ảo (0040). NULL → dùng mặc định nền tảng (env).
-- Có TRẦN cứng (per_ip ≤ 200, per_phone ≤ 50) để shop không tự mở toang rồi bị spam.

ALTER TABLE shops ADD COLUMN max_pending_per_ip    int CHECK (max_pending_per_ip    IS NULL OR (max_pending_per_ip    BETWEEN 1 AND 200));
ALTER TABLE shops ADD COLUMN max_pending_per_phone int CHECK (max_pending_per_phone IS NULL OR (max_pending_per_phone BETWEEN 1 AND 50));

-- Checkout đọc để áp trần theo shop.
GRANT SELECT (max_pending_per_ip, max_pending_per_phone) ON shops TO app_checkout;
