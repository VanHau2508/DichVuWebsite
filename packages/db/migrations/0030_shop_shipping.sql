-- 0030 — phí vận chuyển theo shop (bỏ hằng số env dùng chung mọi shop).
--
-- Mỗi shop tự đặt phí ship + ngưỡng miễn phí. NULL = dùng mặc định nền tảng (SHIP_FEE_VND)
-- → tương thích ngược (shop chưa cấu hình giữ nguyên hành vi cũ). Checkout tính phí SERVER-SIDE
-- từ hai cột này (đọc qua app_checkout — đã có SELECT full trên shops ở 0012). app_rw UPDATE
-- table-level tự phủ cột mới. Tiền bigint VND, >= 0 (CHECK backstop).

ALTER TABLE shops ADD COLUMN ship_fee_vnd            bigint CHECK (ship_fee_vnd >= 0);
ALTER TABLE shops ADD COLUMN free_ship_threshold_vnd bigint CHECK (free_ship_threshold_vnd >= 0);
