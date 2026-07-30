-- 0114: worker vẽ banner mặc định cho shop mới → cần chạm bảng themes.
--
-- Bối cảnh: preset ngành seed `hero.slides: []`, mà theme.js chỉ render
-- hero_side/promo_banners khi có slide hợp lệ → shop vừa cấp phát hiện 3 khối
-- thay vì 12. Worker nhận outbox 'shop.banners_seed', vẽ SVG → webp → MinIO,
-- rồi ghi key vào themes.layout.
--
-- Bán kính ảnh hưởng giữ hẹp đúng tinh thần 0015: worker CHỈ đọc tokens+layout
-- và CHỈ ghi layout. Không SELECT, không UPDATE gì khác trên themes.
GRANT SELECT (shop_id, tokens, layout) ON themes TO app_worker;
GRANT UPDATE (layout)                  ON themes TO app_worker;

-- Poller chạy xuyên shop (không có current_shop_id) → USING(true), giống
-- worker_outbox. Cô lập tenant ở đây do payload outbox quyết định, không do RLS.
CREATE POLICY worker_themes ON themes FOR SELECT TO app_worker USING (true);
CREATE POLICY worker_themes_upd ON themes FOR UPDATE TO app_worker
  USING (true) WITH CHECK (true);
