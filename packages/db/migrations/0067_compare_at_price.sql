-- 0067 — Giá GẠCH NGANG (compare-at) per biến thể. Shop chạy khuyến mãi cần hiện
-- "500.000₫ gạch ngang → 350.000₫ (-30%)" trên storefront (rà soát #13/#36).
--
-- CHỈ HIỂN THỊ — đường tiền KHÔNG đổi: checkout/order_lines luôn tính theo
-- variants.price_vnd (0012: giá tra tươi từ variants; snapshot vào order_lines).
-- compare_at_vnd không bao giờ được cộng/trừ vào bất kỳ số tiền nào.
--
-- GRANTS: KHÔNG cần gì mới (đã đối chiếu file gốc):
--   app_rw       — 0003:25 GRANT ... ON ALL TABLES + default privileges → cột mới tự phủ.
--   app_store    — 0011:31 GRANT SELECT table-level trên variants → tự phủ (storefront đọc để render).
--   app_checkout — 0012:63 GRANT SELECT table-level trên variants → tự phủ (không dùng, nhưng vô hại).
--   app_expiry   — 0050:11 SELECT THEO CỘT trên variants — cố ý KHÔNG thêm (worker không dùng).
--
-- Ràng buộc "compare_at > price_vnd" ép ở tầng app (seller trả 400 tiếng Việt
-- 'giá gạch phải lớn hơn giá bán'); DB chỉ backstop >= 0. Không CHECK chéo cột vì
-- đổi price_vnd riêng lẻ có thể làm compare_at cũ <= giá mới — hiển thị tự ẩn
-- (storefront chỉ render khi compare > giá), không cần chặn cứng.

ALTER TABLE variants ADD COLUMN compare_at_vnd bigint
  CHECK (compare_at_vnd IS NULL OR compare_at_vnd >= 0);
