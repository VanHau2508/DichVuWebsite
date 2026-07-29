-- 0106 — Hàng đợi TẢI ẢNH THEO URL cho worker (docs/45 §5).
--
-- VÌ SAO. Bản đầu tải ảnh ĐỒNG BỘ ngay trong request nhập, nên phải sống dưới thời gian chờ
-- của BFF: trần 200 ảnh / 45 giây mỗi lần nhập. Shop 300 sản phẩm × 3 ảnh phải nhập 5 lần —
-- đúng thứ ma sát mà cả tính năng di cư sinh ra để xoá bỏ.
--
-- Nay dòng `media` ở trạng thái 'pending' kèm `source_url` CHÍNH LÀ đơn vị công việc: bộ nhập
-- chỉ ghi hàng đợi (nhanh, không chạm mạng), worker tải nền. Không cần bảng hàng đợi riêng —
-- dòng media đã có đủ shop_id/product_id/position và đã nằm trong mọi truy vấn hiển thị.

ALTER TABLE media ADD COLUMN source_url text;
-- Đếm lần thử + mốc thử lại: URL chết vĩnh viễn không được quay vòng mãi mãi, và lỗi tạm
-- thời (đích quá tải) phải được lùi giờ chứ không đập liên tục.
ALTER TABLE media ADD COLUMN fetch_attempts int NOT NULL DEFAULT 0;
ALTER TABLE media ADD COLUMN next_attempt_at timestamptz;

-- Chỉ mục PHẦN cho đúng tập việc: dòng pending CÓ url. Không đánh chỉ mục cả bảng media —
-- tuyệt đại đa số dòng là 'ready' và không liên quan.
CREATE INDEX media_fetch_queue_idx ON media (next_attempt_at NULLS FIRST, created_at)
  WHERE status = 'pending' AND source_url IS NOT NULL;

COMMENT ON COLUMN media.source_url IS
  'URL nguồn khi ảnh được nhập từ CSV di cư (docs/45). Worker tải nền; NULL với ảnh tự tải lên.';

-- ── Quyền cho worker ───────────────────────────────────────────────────────
-- Dùng lại vai app_expiry (worker đã có pool riêng cho nó) thay vì đẻ thêm một vai mới:
-- vai này đã là "vai quét nền chéo shop" của hệ, và nguyên tắc ít-quyền được giữ bằng
-- GRANT THEO CỘT — app_expiry KHÔNG thấy cột nào ngoài những cột nó cần.
--
-- KHÔNG có role nào bypass RLS (trừ app_owner), nên phải có POLICY riêng cho vai này —
-- giống hệt cách 0101 mở review_images cho app_expiry.
GRANT SELECT (id, shop_id, product_id, status, source_url, original_key, public_key,
              content_type, position, fetch_attempts, next_attempt_at, created_at, deleted_at)
  ON media TO app_expiry;
GRANT UPDATE (status, original_key, public_key, content_type, size_bytes, width, height,
              fetch_attempts, next_attempt_at)
  ON media TO app_expiry;

CREATE POLICY expiry_media ON media FOR ALL TO app_expiry
  USING (true) WITH CHECK (true);
