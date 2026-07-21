-- 0094 — Ngành hàng khi đăng ký + seed theme preset lúc provision (HỆ PRESET NGÀNH).
--
-- Self-serve signup (0091) cho chọn NGÀNH lúc đăng ký; lúc provision, seed sẵn 1 row `themes`
-- từ preset ngành (packages/presets) → shop MỚI có ngay giao diện hợp ngành (chỉ việc thay ảnh).
--
-- ENUM-SAFE: industry = text + CHECK IN(...) (KHÔNG native enum — đồng nhất lối codebase:
--   created_via/status/ship_over_max_behavior đều text+CHECK; thêm ngành sau chỉ sửa CHECK,
--   không ALTER TYPE khoá bảng). Nullable + CHECK cho phép NULL → legacy (đều NULL) hợp lệ NGAY,
--   KHÔNG cần NOT VALID, không khoá bảng. App chuẩn hoá 'other'/rỗng/giá-trị-lạ → NULL TRƯỚC insert
--   (industry=NULL → KHÔNG seed → storefront rơi về DEFAULT_LAYOUT 'MAISON', hành vi hiện tại).
--
-- RLS (bẫy 0073 grant-thiếu-policy = INSERT CÂM): themes FORCE RLS (0011) + current_shop_id() CHƯA
--   set khi tạo shop mới → GRANT INSERT PHẢI kèm POLICY WITH CHECK(true) (mirror signup_shops_ins
--   0091). themes PK = shop_id (uuid, KHÔNG sequence) → KHÔNG grant sequence (khác audit/outbox).
--   shops.industry KHÔNG cần grant thêm: 0091 đã GRANT INSERT ON shops full-table (phủ cột mới).

-- ══ (1) Cột ngành hàng (tuỳ chọn) — draft đăng ký + shop thật ══
ALTER TABLE shop_signups ADD COLUMN industry text
  CHECK (industry IS NULL OR industry IN ('fashion','food','furniture','cosmetics'));
ALTER TABLE shops ADD COLUMN industry text
  CHECK (industry IS NULL OR industry IN ('fashion','food','furniture','cosmetics'));

-- ══ (2) app_signup seed theme lúc provision (cùng tx) ══
GRANT INSERT ON themes TO app_signup;
CREATE POLICY signup_theme_ins ON themes FOR INSERT TO app_signup WITH CHECK (true);
