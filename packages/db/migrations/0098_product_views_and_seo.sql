-- 0098 — LƯỢT XEM SẢN PHẨM (analytics cơ bản) + SEO riêng cho sản phẩm.
--
-- Hai thứ chủ shop hỏi nhiều nhất mà nền tảng chưa trả lời được:
--   "Sản phẩm này có ai xem không, hay xem nhiều mà không mua?" — 97 migration trước
--   KHÔNG có bảng sự kiện nào, không suy ra được từ đơn hàng.
--   "Làm sao lên Google?" — products chưa có meta title/description riêng (chỉ CMS pages
--   có, 0019); storefront đang suy tạm từ tên + mô tả.

-- ── 1. Lượt xem: GỘP THEO NGÀY, không phải mỗi lượt một dòng ─────────────────
-- Một dòng / (shop, sản phẩm, ngày). 1000 shop × 1000 SP × 365 ngày là cỡ tối đa lý
-- thuyết, nhưng thực tế chỉ SP CÓ người xem mới sinh dòng → tăng trưởng bị chặn bởi
-- lượng truy cập thật, không bởi lượng truy cập × chi tiết. Dòng-mỗi-lượt sẽ phình vô hạn
-- và không dùng được cho câu hỏi "30 ngày qua bao nhiêu lượt".
--
-- KHÔNG chứa gì nhận dạng người xem (không IP, không session) → không phải dữ liệu cá
-- nhân, không cần vòng đời PII như orders (0064).
CREATE TABLE product_view_daily (
  shop_id    uuid NOT NULL,
  product_id uuid NOT NULL,
  day        date NOT NULL,
  views      integer NOT NULL DEFAULT 0 CHECK (views >= 0),
  PRIMARY KEY (shop_id, product_id, day),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  -- Composite FK: đếm không thể trỏ sang SP của shop khác. Xoá SP → xoá luôn số đếm.
  FOREIGN KEY (shop_id, product_id) REFERENCES products (shop_id, id) ON DELETE CASCADE
);
-- Dọn số cũ (worker quét): quét theo NGÀY trên toàn bảng.
CREATE INDEX product_view_daily_day_idx ON product_view_daily (day);

ALTER TABLE product_view_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_view_daily FORCE  ROW LEVEL SECURITY;

-- app_rw (seller API): đọc để hiện cột "Lượt xem". CHỈ ĐỌC — số đếm do worker ghi, người
-- bán không được tự sửa (sửa được thì con số mất hết ý nghĩa).
GRANT SELECT ON product_view_daily TO app_rw;
CREATE POLICY tenant_isolation ON product_view_daily FOR SELECT TO app_rw
  USING (shop_id = current_shop_id());

-- app_expiry (worker): GHI số đếm gộp từ Redis + dọn dòng quá cũ. Cross-shop nên
-- USING(true), y hệt expiry_orders/expiry_levels (0022).
GRANT SELECT, INSERT, UPDATE, DELETE ON product_view_daily TO app_expiry;
CREATE POLICY expiry_views ON product_view_daily FOR ALL TO app_expiry
  USING (true) WITH CHECK (true);

-- CỐ Ý KHÔNG cấp quyền cho app_store. Vai storefront là vai CÔNG KHAI, CHỈ ĐỌC (0011) —
-- đó là bất biến an ninh, không đánh đổi lấy một con số trưng bày. Storefront đếm vào
-- REDIS (fire-and-forget, không chặn trang), worker gộp vào bảng này theo chu kỳ. Đổi lại
-- còn được lợi: không có ghi DB nào trên đường nóng công khai.

-- ── 2. SEO riêng cho sản phẩm ────────────────────────────────────────────────
-- Bỏ trống → storefront tự suy từ tên/mô tả như hiện nay (không bắt shop phải nhập).
ALTER TABLE products ADD COLUMN seo_title text
  CONSTRAINT products_seo_title_len CHECK (seo_title IS NULL OR length(seo_title) <= 200);
ALTER TABLE products ADD COLUMN seo_description text
  CONSTRAINT products_seo_desc_len CHECK (seo_description IS NULL OR length(seo_description) <= 500);

-- app_store/app_checkout đã GRANT SELECT mức BẢNG trên products (0011, 0012) → 2 cột mới
-- tự được phủ. app_rw có GRANT mức bảng từ 0003. app_expiry bị cấp theo CỘT (0050) nhưng
-- KHÔNG cần đọc cột SEO → không mở thêm.
