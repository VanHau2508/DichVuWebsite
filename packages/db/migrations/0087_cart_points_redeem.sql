-- 0087 — ĐỔI ĐIỂM khi checkout (0086 commit 2): ô stamp số điểm khách chọn đổi trên giỏ.
-- Giá trị khách MUỐN đổi; checkout RE-VALIDATE + cắt theo 3 trần (số dư / tiền hàng / %tiền hàng)
-- dưới khoá số dư FOR UPDATE (chân lý), rồi mới trừ. app_checkout đã có CRUD carts (0012) —
-- grant bảng phủ cột mới, không cần cấp thêm.
ALTER TABLE carts ADD COLUMN points_redeem int NOT NULL DEFAULT 0 CHECK (points_redeem >= 0);
