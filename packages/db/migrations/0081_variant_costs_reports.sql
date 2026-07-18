-- 0081 — GIÁ VỐN (COGS) + nền BÁO CÁO LỢI NHUẬN v1.
--
-- (1) variant_costs: giá vốn HIỆN HÀNH per biến thể — BẢNG RIÊNG, cố ý KHÔNG ALTER variants.
--     Lý do: app_store (0011:31) và app_checkout (0012:63) GRANT SELECT TABLE-LEVEL trên
--     variants → cột mới TỰ PHỦ; RLS chỉ lọc DÒNG, không lọc CỘT → thêm cột cost vào variants
--     là vai storefront đọc được giá vốn (bí mật kinh doanh nhất của shop) qua bất kỳ SQLi
--     nào ở storefront/checkout. Bảng riêng = zero regression grant cũ; app_store KHÔNG được
--     cấp gì. KHÔNG lưu lịch sử ở đây: CHỨNG TỪ là snapshot trên order_lines/return_lines.
CREATE TABLE variant_costs (
  shop_id    uuid NOT NULL,
  variant_id uuid NOT NULL,
  cost_vnd   bigint NOT NULL CHECK (cost_vnd >= 0),
  updated_by uuid REFERENCES users (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, variant_id),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  -- Composite FK (quy ước 0002): xoá biến thể → dòng giá vốn đi theo.
  FOREIGN KEY (shop_id, variant_id) REFERENCES variants (shop_id, id) ON DELETE CASCADE
);
ALTER TABLE variant_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE variant_costs FORCE  ROW LEVEL SECURITY;

-- app_rw: giá vốn là dữ liệu HIỆN HÀNH sửa được (KHÔNG append-only — chứng từ nằm ở
-- snapshot). Grant tường minh để schema-invariants đọc được ý định.
GRANT SELECT, INSERT, UPDATE, DELETE ON variant_costs TO app_rw;
CREATE POLICY tenant_isolation ON variant_costs FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- app_checkout: CHỈ ĐỌC để snapshot giá vốn vào order_lines lúc đặt (mẫu policy 0012).
-- KHÔNG BAO GIỜ render ra khách — code checkout chỉ dùng trong subquery INSERT.
GRANT SELECT ON variant_costs TO app_checkout;
CREATE POLICY checkout_vcosts ON variant_costs FOR SELECT TO app_checkout
  USING (shop_id = current_shop_id());
-- app_store / app_expiry / app_payment / app_billing / app_platform: KHÔNG grant gì.

-- (2) SNAPSHOT giá vốn vào dòng đơn lúc TẠO — mirror unit_price_vnd, cùng bất biến 0002
--     ("sửa sản phẩm sau đó KHÔNG được đổi đơn cũ" — yêu cầu kế toán). NULL = shop CHƯA
--     khai giá vốn tại thời điểm đặt → báo cáo hiển thị THIẾU, tuyệt đối không coi là 0.
--     Grants tự phủ: app_rw 0003 table-level; app_checkout 0012:66 SELECT,INSERT table-level;
--     app_expiry 0022 SELECT THEO CỘT trên order_lines → cột mới VÔ HÌNH với worker (tốt).
ALTER TABLE order_lines ADD COLUMN unit_cost_vnd bigint
  CHECK (unit_cost_vnd IS NULL OR unit_cost_vnd >= 0);

-- (3) SNAPSHOT giá vốn vào dòng trả (RMA 0078) — copy từ dòng đơn cùng biến thể lúc tạo
--     phiếu → SQL đảo COGS đọc thẳng return_lines. Bảng vẫn append-only (REVOKE 0078 nguyên).
ALTER TABLE return_lines ADD COLUMN unit_cost_vnd bigint
  CHECK (unit_cost_vnd IS NULL OR unit_cost_vnd >= 0);

-- (4) PHÂN LOẠI phiếu hoàn — vá TRỪ ĐÚP của sửa-đơn-đã-trả (red-team 3/3 lăng kính):
--     editPaidOrder vừa GIẢM header đơn (subtotal/total mới) vừa GHI phiếu hoàn phần chênh
--     → báo cáo lấy doanh thu từ header hiện hành RỒI trừ phiếu = trừ 2 lần cùng khoản.
--     kind='edit_adjustment' bị LOẠI khỏi phép trừ doanh thu (khoản đã phản ánh qua header).
--     Bảng vẫn append-only; backfill 1 lần bằng reason cố định duy nhất edit-paid dùng
--     (chuỗi literal trong code, user không nhập được ở đường đó).
ALTER TABLE refunds ADD COLUMN kind text NOT NULL DEFAULT 'refund'
  CHECK (kind IN ('refund', 'edit_adjustment', 'rma'));
UPDATE refunds SET kind = 'edit_adjustment' WHERE reason = 'điều chỉnh đơn (sửa giảm)';
UPDATE refunds SET kind = 'rma' WHERE reason = 'Đổi-trả hàng' OR reason LIKE 'Đổi-trả: %';

-- (5) INDEX cho báo cáo theo khoảng thời gian per-shop. Điều kiện khoảng phải SARGABLE
--     trên CỘT thời gian thuần — phép đổi múi giờ đặt ở THAM SỐ, KHÔNG áp lên cột:
--       WHERE o.paid_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
--         AND o.paid_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
CREATE INDEX orders_shop_paid_at_idx    ON orders    (shop_id, paid_at) WHERE paid_at IS NOT NULL;
CREATE INDEX refunds_shop_created_idx   ON refunds   (shop_id, created_at);
CREATE INDEX returns_shop_created_idx   ON returns   (shop_id, created_at);
CREATE INDEX shipments_shop_fee_idx     ON shipments (shop_id, created_at) WHERE carrier_fee_vnd IS NOT NULL;
-- order_lines chưa có index theo order_id — mọi join "lines theo đơn" đều hưởng lợi:
CREATE INDEX order_lines_shop_order_idx ON order_lines (shop_id, order_id);
