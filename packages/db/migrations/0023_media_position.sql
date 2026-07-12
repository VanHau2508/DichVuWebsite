-- 0023 — thứ tự ảnh sản phẩm (media.position).
--
-- position nhỏ nhất = ảnh ĐẠI DIỆN (storefront lấy ảnh đầu cho lưới; trang SP theo
-- thứ tự position). Reorder do seller cưỡng chế bằng hoán vị đúng tập id (không lén
-- thêm/bớt). Không cần grant mới: media đã GRANT SELECT cho app_store, ALL cho app_rw.

ALTER TABLE media ADD COLUMN position int NOT NULL DEFAULT 0;

-- Backfill: đánh số theo created_at trong từng sản phẩm (ảnh cũ nhất = 0 = đại diện).
UPDATE media m SET position = s.rn
  FROM (SELECT id, row_number() OVER (PARTITION BY product_id ORDER BY created_at, id) - 1 AS rn FROM media) s
 WHERE m.id = s.id;
