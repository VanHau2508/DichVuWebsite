-- 0090 — Ship theo km cho nền tảng TOÀN QUỐC: ngoài bán kính nội thành → rơi PHÍ VÙNG (không
-- per-km vô lý Cà Mau→Hà Nội, không từ chối). Km chỉ là lớp tối ưu cho khách GẦN (shipper riêng),
-- chồng lên phí vùng toàn quốc (0063). Vượt max_km:
--   • 'region' (MẶC ĐỊNH — toàn quốc): tính phí VÙNG liên miền (shop đặt = mức GHN/GHTK thu) → vẫn giao.
--   • 'reject' (shop CHỈ giao nội thành, không hãng): 'ngoài vùng giao' (422) như tieutieu.
ALTER TABLE shops ADD COLUMN ship_over_max_behavior text NOT NULL DEFAULT 'region'
  CHECK (ship_over_max_behavior IN ('region', 'reject'));
