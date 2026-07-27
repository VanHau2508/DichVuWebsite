-- 0097 — index cho SỔ CÁI KHO cấp shop (trang "Sổ cái kho" trong seller-admin).
--
-- inventory_ledger (0009) chỉ có MỘT index: (shop_id, variant_id, id) — phục vụ "lịch sử của
-- MỘT biến thể". Trang mới liệt kê TOÀN SHOP theo thời gian giảm dần:
--     WHERE shop_id = current_shop_id() ORDER BY id DESC LIMIT 50
-- Index cũ KHÔNG dùng được cho thứ tự này (variant_id nằm giữa prefix và khoá sắp xếp) →
-- planner phải quét toàn bộ nhánh shop rồi sort, hoặc quét ngược PK rồi lọc shop_id. Shop
-- nhiều giao dịch sẽ đụng statement_timeout 20s (0075) và làm trang admin 502 (BFF chờ 8s).
--
-- Sắp theo id DESC chứ KHÔNG phải created_at: id là bigserial nên đơn điệu tăng theo thời
-- gian ghi, lại DUY NHẤT — hai dòng cùng created_at (ghi trong cùng transaction, now() cố
-- định trong transaction!) vẫn có thứ tự ổn định, phân trang offset không bị nhảy/lặp dòng.
CREATE INDEX inventory_ledger_shop_idx ON inventory_ledger (shop_id, id DESC);

-- Không cần GRANT/RLS mới: 0009 đã cấp app_rw SELECT+INSERT (đã REVOKE UPDATE/DELETE để
-- giữ tính chỉ-ghi-thêm) kèm policy tenant_isolation theo current_shop_id().
