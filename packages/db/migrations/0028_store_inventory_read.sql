-- 0028 — storefront đọc tồn kho để hiển thị "Còn hàng / Hết hàng".
--
-- app_store (công khai, chỉ đọc) cần thấy inventory_levels để render trạng thái tồn trên
-- trang sản phẩm/lưới — KHỚP đúng cách checkout tính available = on_hand - reserved (không
-- có dòng = 0 = hết). Least-privilege: chỉ SELECT + policy tenant-scoped (chỉ tồn của shop
-- hiện tại). Bài học: policy RLS chỉ SỐNG khi role THỰC SỰ đọc bảng (0011 cấp variants/…).

GRANT SELECT ON inventory_levels TO app_store;

CREATE POLICY store_inventory ON inventory_levels FOR SELECT TO app_store
  USING (shop_id = current_shop_id());
