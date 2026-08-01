-- 0119: đơn đến TỪ ĐÂU.
--
-- Hôm nay mọi đơn nằm chung một rổ. Shop chạy quảng cáo Facebook, khách nhắn tin, nhân
-- viên gõ đơn vào — xong không ai trả lời được câu đơn giản nhất của người bán tiền:
-- "tháng này Facebook mang về bao nhiêu đơn?". Và khi bot Messenger đổ đơn vào (chặng 2),
-- đơn của bot sẽ lẫn hoàn toàn với đơn nhân viên gõ tay, không cách nào tách.
--
-- `source` có CHECK chứ không để text tự do. Cố ý: nguồn đơn là thứ để ĐẾM, mà đếm thì
-- 'facebook' lẫn 'fb' lẫn 'Facebook' là hỏng báo cáo mà không ai thấy sai. Thêm kênh mới
-- = thêm một migration, đổi lại người review nhìn thấy tập giá trị ngay trong diff.
--
-- `source_ref`: mã/đường dẫn quay lại cuộc hội thoại (vd m.me/<page>?psid=..., hoặc PSID
-- thô). Người bán mở đơn là bấm về đúng đoạn chat đã chốt — thứ quyết định họ có dùng
-- màn "tạo đơn từ chat" hay lại quay về gõ tay.
--
-- KHÔNG backfill đơn cũ. Có thể đoán được (`client_ip_hash IS NULL` gần như chắc là đơn
-- gõ tay, vì createManualOrder ghi NULL còn checkout luôn ghi hash) — nhưng "gần như
-- chắc" ghi vào cột dùng để đếm doanh thu theo kênh là biến phỏng đoán thành sự thật
-- vĩnh viễn. Đơn cũ để NULL và hiện là "không rõ".
--
-- Không cần GRANT: app_rw có quyền mức ALL TABLES (0003), app_checkout có quyền mức BẢNG
-- trên orders (0003:66) → cột mới tự nằm trong quyền. Đã kiểm trước khi viết file này.
ALTER TABLE orders ADD COLUMN source text
  CHECK (source IN ('web', 'manual', 'facebook', 'zalo', 'tiktok', 'other'));
ALTER TABLE orders ADD COLUMN source_ref text;

-- Lọc "chỉ đơn từ Facebook" trên trang Đơn hàng + gom nhóm ở báo cáo. Partial: đơn cũ
-- source NULL không cần nằm trong index.
CREATE INDEX orders_shop_source_idx ON orders (shop_id, source, created_at DESC)
  WHERE source IS NOT NULL;
