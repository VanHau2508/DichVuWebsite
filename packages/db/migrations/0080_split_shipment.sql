-- 0080 — GIAO MỘT PHẦN / TÁCH VẬN ĐƠN (split shipment) v1.
--
-- Cho phép shop gửi MỘT PHẦN số lượng của đơn trước, phần còn lại sau (nhiều vận đơn
-- mỗi đơn). Trước đây khoá cứng bằng shipments_one_live_per_order_uq (0046) + consumeAndShip
-- tiêu TOÀN BỘ dòng đơn rồi đặt status='shipped'.
--
-- Bất biến giữ nguyên:
--   • Tồn (0009): mỗi thay đổi on_hand kèm ĐÚNG 1 dòng ledger; reserved nhả DẦN theo subset gửi.
--   • Không gửi quá số đặt: CHECK(shipped_qty <= qty) là BACKSTOP DB (song song reserved_le_on_hand).
--   • Đường tiền COD: đơn COD giao QUA HÃNG KHÔNG tách trong v1 → 0066/0079 chạy y nguyên.

-- 1) order_lines: luỹ kế đã gửi + backstop chống gửi vượt số đặt.
ALTER TABLE order_lines ADD COLUMN shipped_qty int NOT NULL DEFAULT 0;
ALTER TABLE order_lines ADD CONSTRAINT order_lines_shipped_le_qty
  CHECK (shipped_qty >= 0 AND shipped_qty <= qty);

-- 2) orders: fulfillment_status — TRỤC ĐỘC LẬP với status/payment_status (mô hình 0002).
ALTER TABLE orders ADD COLUMN fulfillment_status text NOT NULL DEFAULT 'unfulfilled'
  CHECK (fulfillment_status IN ('unfulfilled','partial','fulfilled'));

-- Backfill đơn cũ (mô hình 1 vận đơn = toàn bộ): đã shipped/delivered/returned = gửi đủ.
UPDATE order_lines ol SET shipped_qty = ol.qty
  FROM orders o
 WHERE o.id = ol.order_id AND o.status IN ('shipped','delivered','returned');
UPDATE orders SET fulfillment_status = 'fulfilled'
 WHERE status IN ('shipped','delivered','returned');

-- 3) shipment_lines: DÒNG HÀNG trong từng vận đơn (subset đã/đang gửi). Chứng từ giao hàng
--    (như return_lines 0078), snapshot giá. Ghi lúc TẠO vận đơn (claim carrier / giao tay) →
--    phục vụ guard luỹ kế + tiêu tồn lúc chốt (consumeAndShip đọc lại subset).
CREATE TABLE shipment_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        uuid NOT NULL,
  shipment_id    uuid NOT NULL,
  order_line_id  uuid NOT NULL,
  variant_id     uuid NOT NULL,
  qty            int  NOT NULL CHECK (qty > 0),
  unit_price_vnd bigint NOT NULL CHECK (unit_price_vnd >= 0),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, shipment_id, order_line_id),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, shipment_id)   REFERENCES shipments   (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, order_line_id) REFERENCES order_lines (shop_id, id),
  FOREIGN KEY (shop_id, variant_id)    REFERENCES variants    (shop_id, id)
);
CREATE INDEX shipment_lines_shipment_idx  ON shipment_lines (shop_id, shipment_id);
CREATE INDEX shipment_lines_orderline_idx ON shipment_lines (shop_id, order_line_id);

ALTER TABLE shipment_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_lines FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shipment_lines FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
-- Chứng từ giao hàng: app KHÔNG sửa/xoá. Dọn claim bị hãng từ chối bằng ON DELETE CASCADE
-- từ shipments (cascade + kiểm RI chạy bằng quyền CHỦ BẢNG, bỏ qua RLS + không cần DELETE grant).
REVOKE UPDATE, DELETE ON shipment_lines FROM app_rw;
GRANT  SELECT, INSERT  ON shipment_lines TO app_rw;

-- 4) BỎ khoá "một vận đơn sống mỗi đơn" (0046) — nay cho phép NHIỀU vận đơn sống mỗi đơn.
--    Có thể tách MỘT dòng qua nhiều kiện nên không khoá UNIQUE nào diễn đạt được "không trùng".
--    Thay bằng guard luỹ kế tính DƯỚI khoá orders FOR UPDATE (claim carrier & giao tay đều đã
--    SELECT orders FOR UPDATE): đã_gửi(shipped_qty) + đang_claim('created') ≤ qty đặt.
--    CHECK(shipped_qty<=qty) là backstop DB lúc tiêu tồn nếu guard bị bỏ qua.
DROP INDEX shipments_one_live_per_order_uq;

-- 5) Worker (app_expiry): đọc fulfillment_status để CHỈ chốt 'delivered' khi MỌI kiện đã giao.
GRANT SELECT (fulfillment_status) ON orders TO app_expiry;
