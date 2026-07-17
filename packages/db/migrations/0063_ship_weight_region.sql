-- 0063 — Phí ship theo CÂN NẶNG + VÙNG MIỀN (per-shop).
--
-- Mô hình v1: 2 bậc vùng (nội miền / liên miền — bản đồ Bắc/Trung/Nam TĨNH trong code,
-- apps/checkout/src/provinces.js) + phụ phí cân (mỗi 500g vượt 500g đầu; cân đơn =
-- Σ qty × variants.weight_gram, NULL → shops.default_weight_gram). NULL ở mọi cột mới
-- = giữ nguyên hành vi phí PHẲNG hiện tại (0030) — tương thích ngược toàn bộ test cũ.
-- Đường tiền: đích KHÔNG RÕ tỉnh lúc CHỐT ĐƠN → tính LIÊN MIỀN (bảo vệ shop; Origin
-- header giả được bằng curl nên không dựa vào form bắt buộc chọn tỉnh).
--
-- GRANTS: KHÔNG cần gì mới. app_rw ghi table-level (0003:25 + default privileges);
-- app_checkout SELECT table-level trên shops + variants (0012:63) → cột mới TỰ PHỦ dưới
-- policy checkout_shop / checkout_variants sẵn có. app_expiry chỉ có SELECT THEO CỘT trên
-- variants (0050:11) — cố ý KHÔNG thêm weight_gram (worker không dùng).

ALTER TABLE variants ADD COLUMN weight_gram int
  CHECK (weight_gram IS NULL OR (weight_gram >= 1 AND weight_gram <= 50000));

ALTER TABLE shops ADD COLUMN default_weight_gram int NOT NULL DEFAULT 500
  CHECK (default_weight_gram >= 1 AND default_weight_gram <= 50000);
ALTER TABLE shops ADD COLUMN ship_fee_far_vnd        bigint CHECK (ship_fee_far_vnd >= 0);
ALTER TABLE shops ADD COLUMN ship_extra_per_500g_vnd bigint CHECK (ship_extra_per_500g_vnd >= 0);
ALTER TABLE shops ADD COLUMN ship_from_province      text
  CHECK (ship_from_province IS NULL OR char_length(ship_from_province) <= 60);

-- Đặt phí liên miền mà không khai nơi gửi → không xác định được vùng. Backstop từ DB;
-- seller validate trước và trả lỗi tiếng Việt (không để CHECK nổ thành 500).
ALTER TABLE shops ADD CONSTRAINT shops_ship_far_requires_from
  CHECK (ship_fee_far_vnd IS NULL OR ship_from_province IS NOT NULL);
