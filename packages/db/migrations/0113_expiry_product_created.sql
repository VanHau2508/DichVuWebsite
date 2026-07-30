-- 0113 — app_expiry cần đọc products.created_at cho cờ first_product_at (0112).
--
-- 0050 cấp SELECT (id, shop_id, title, status, deleted_at) ON products. Sweep 0112 lấy
-- min(created_at) nên thiếu đúng một cột là cả câu bị từ chối: "permission denied for table
-- products", nuốt vào try/catch và cờ không bao giờ được đặt — shop đang bán vẫn bị nhắc.
--
-- Đây là lần THỨ HAI trong cùng một đợt (0111 là lần đầu, thiếu shops.deleted_at). Cả hai đều
-- do e2e bắt chứ không do đọc code, và cả hai đều là quyền theo CỘT làm đúng việc của nó: mọi
-- cột chạm tới đều phải xin, kể cả cột chỉ nằm trong hàm gộp.
--
-- Chỉ created_at, không nới rộng: sweep không cần biết gì thêm về hàng hoá của người bán.

GRANT SELECT (created_at) ON products TO app_expiry;
