-- 0089 — Phí ship THEO KHOẢNG CÁCH (km) — per-shop, coexist với chế độ vùng (0063).
--
-- Mô hình: shops.ship_mode ('region' mặc định = hành vi 0063 y nguyên; 'distance' = tính km).
-- Khoảng cách = HAVERSINE(gốc shop → toạ độ khách) × ship_road_factor (chim-bay × hệ số đường
-- bộ). Toạ độ khách do JS gửi (0090) là INPUT; phí LUÔN tính SERVER trong computeShipping.
--
-- BẤT BIẾN TIỀN (red-team): SÀN PHÍ = max(phí_km, phí_vùng) → distance KHÔNG BAO GIỜ rẻ hơn
-- bậc vùng hôm nay (vô hiệu hoá toạ-độ-giả-sát-shop). Vượt trần km → 'ngoài vùng giao' (422,
-- KHÔNG về 0). Không toạ độ (no-JS/từ chối GPS) → rơi path vùng như cũ → BẬT distance BẮT BUỘC
-- khai đủ bậc vùng fallback (ship_from_province + ship_fee_far_vnd) + gốc + base/per_km/max_km.
--
-- GRANTS: KHÔNG cần gì mới (app_rw table-level UPDATE, app_checkout SELECT table-level — cột tự phủ).

ALTER TABLE shops ADD COLUMN ship_mode text NOT NULL DEFAULT 'region'
  CHECK (ship_mode IN ('region', 'distance'));
ALTER TABLE shops ADD COLUMN ship_origin_lat double precision
  CHECK (ship_origin_lat IS NULL OR (ship_origin_lat BETWEEN -90 AND 90));
ALTER TABLE shops ADD COLUMN ship_origin_lng double precision
  CHECK (ship_origin_lng IS NULL OR (ship_origin_lng BETWEEN -180 AND 180));
ALTER TABLE shops ADD COLUMN ship_base_vnd   bigint CHECK (ship_base_vnd   IS NULL OR ship_base_vnd   >= 0);
ALTER TABLE shops ADD COLUMN ship_per_km_vnd bigint CHECK (ship_per_km_vnd IS NULL OR ship_per_km_vnd >= 0);
ALTER TABLE shops ADD COLUMN ship_max_km     int    CHECK (ship_max_km     IS NULL OR (ship_max_km >= 1 AND ship_max_km <= 500));
-- road_factor: chim-bay × hệ số ≈ đường bộ. CHECK 1.0–3.0 (red-team: =0/âm → mọi đơn near-free).
ALTER TABLE shops ADD COLUMN ship_road_factor numeric NOT NULL DEFAULT 1.3
  CHECK (ship_road_factor >= 1.0 AND ship_road_factor <= 3.0);

-- Bật distance BẮT BUỘC khai đủ: gốc + base + per_km + max_km + bậc-vùng-fallback (from_province +
-- fee_far). Thiếu 1 = có ca no-JS/từ-chối-GPS không tính được phí → chặn ngay ở DB (seller validate
-- trước, trả lỗi tiếng Việt, không để CHECK nổ 500).
ALTER TABLE shops ADD CONSTRAINT shops_distance_requires_config CHECK (
  ship_mode <> 'distance' OR (
    ship_origin_lat IS NOT NULL AND ship_origin_lng IS NOT NULL
    AND ship_base_vnd IS NOT NULL AND ship_per_km_vnd IS NOT NULL AND ship_max_km IS NOT NULL
    AND ship_from_province IS NOT NULL AND ship_fee_far_vnd IS NOT NULL));
