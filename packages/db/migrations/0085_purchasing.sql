-- 0085 — NHẬP HÀNG v1: nhà cung cấp + phiếu nhập + kiểm kê. MỘT KHO.
--
-- Nối vào 2 BẤT BIẾN CỐT LÕI đã có, KHÔNG mở đường mới:
--   • TỒN (0009): nhận hàng / kiểm kê đổi on_hand ⇒ ĐÚNG 1 dòng inventory_ledger cùng tx
--     (kind='receive' khi nhận, 'adjust' khi kiểm kê) → bất biến Σdelta ledger == on_hand
--     giữ nguyên. KHÔNG thêm kind mới, KHÔNG đụng inventory_ledger (append-only 0009).
--   • GIÁ VỐN (0081): nhận hàng UPSERT variant_costs (bình quân gia quyền di động). variant_costs
--     là NGUỒN GIÁ VỐN HIỆN HÀNH DUY NHẤT; checkout + đơn tay ĐÃ snapshot nó vào
--     order_lines.unit_cost_vnd lúc đặt → reports.js TỰ hưởng giá vốn mới cho đơn TƯƠNG LAI.
--     KHÔNG hồi tố đơn cũ, KHÔNG sửa reports.js.
--
-- BÍ MẬT KD: giá nhập + thông tin NCC nhạy như variant_costs (0081) → 5 bảng CHỈ app_rw thấy;
-- app_store/app_checkout/app_customer/app_expiry/... KHÔNG grant gì. RLS lọc DÒNG không lọc CỘT.
--
-- CHỨNG TỪ: phiếu 'received' / phiên 'completed' = TERMINAL — cưỡng chế "không sửa sau khi chốt"
-- ở TẦNG APP bằng status-guard DƯỚI SELECT ... FOR UPDATE (như shipOrder "đơn đã giao").
-- inventory_ledger append-only là backstop DB cho bất biến tồn; phiếu KHÔNG cần REVOKE (sửa
-- được trước khi nhận). Không trigger.

-- ── (1) NHÀ CUNG CẤP — master data, LƯU TRỮ (is_active) thay vì XOÁ ─────────────
CREATE TABLE suppliers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    uuid NOT NULL,
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  contact    text, phone text, email text, address text, note text,
  is_active  boolean NOT NULL DEFAULT true,   -- ẩn NCC ngừng dùng; FK phiếu RESTRICT chặn xoá cứng
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id) REFERENCES shops (id)
);
CREATE INDEX suppliers_shop_active_idx ON suppliers (shop_id, is_active, name);
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON suppliers FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON suppliers TO app_rw;

-- ── (2) PHIẾU NHẬP — hybrid: sửa được (draft/ordered) → đóng băng (received) ─────
CREATE TABLE purchase_orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL,
  po_number    bigint NOT NULL,               -- shop_counters name='po_number'
  supplier_id  uuid NOT NULL,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ordered','received','cancelled')),
  note         text,
  subtotal_vnd bigint NOT NULL DEFAULT 0 CHECK (subtotal_vnd >= 0), -- CACHE Σ(qty×giá nhập); dòng là nguồn sự thật
  ordered_at   timestamptz, received_at timestamptz, received_by uuid REFERENCES users (id),
  created_by   uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, po_number),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, supplier_id) REFERENCES suppliers (shop_id, id)  -- RESTRICT: NCC có phiếu không xoá cứng
);
CREATE INDEX purchase_orders_shop_status_idx ON purchase_orders (shop_id, status, po_number DESC);
CREATE INDEX purchase_orders_supplier_idx    ON purchase_orders (shop_id, supplier_id);
CREATE INDEX purchase_orders_received_idx    ON purchase_orders (shop_id, received_at) WHERE received_at IS NOT NULL;
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON purchase_orders FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_orders TO app_rw;

CREATE TABLE purchase_order_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        uuid NOT NULL,
  po_id          uuid NOT NULL,
  variant_id     uuid NOT NULL,
  qty            int    NOT NULL CHECK (qty > 0),
  unit_cost_vnd  bigint NOT NULL CHECK (unit_cost_vnd >= 0),  -- GIÁ NHẬP/đơn vị của RIÊNG phiếu này; 0 = hàng tặng
  title_snapshot text, sku_snapshot text,   -- ghi LÚC nhận: chống pool-reuse (0041) map lại variant_id
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, po_id, variant_id),       -- 1 biến thể = 1 dòng/phiếu (gộp qty)
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, po_id)      REFERENCES purchase_orders (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, variant_id) REFERENCES variants (shop_id, id)
);
CREATE INDEX purchase_order_lines_po_idx      ON purchase_order_lines (shop_id, po_id);
CREATE INDEX purchase_order_lines_variant_idx ON purchase_order_lines (shop_id, variant_id);
ALTER TABLE purchase_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_lines FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON purchase_order_lines FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_order_lines TO app_rw;

-- ── (3) KIỂM KÊ — đếm → chênh → adjust ledger; KHÔNG đổi giá vốn ─────────────────
CREATE TABLE stocktakes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          uuid NOT NULL,
  stocktake_number bigint NOT NULL,           -- shop_counters name='stocktake_number'
  status           text NOT NULL DEFAULT 'counting' CHECK (status IN ('counting','completed','cancelled')),
  note             text, completed_at timestamptz, completed_by uuid REFERENCES users (id),
  created_by       uuid REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, stocktake_number),
  FOREIGN KEY (shop_id) REFERENCES shops (id)
);
CREATE INDEX stocktakes_shop_idx ON stocktakes (shop_id, stocktake_number DESC);
ALTER TABLE stocktakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE stocktakes FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stocktakes FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON stocktakes TO app_rw;

CREATE TABLE stocktake_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL,
  stocktake_id uuid NOT NULL,
  variant_id   uuid NOT NULL,
  system_qty   int NOT NULL,   -- lúc TẠO = on_hand snapshot; lúc CHỐT bị GHI ĐÈ = on_hand SỐNG đã dùng
  counted_qty  int CHECK (counted_qty IS NULL OR counted_qty >= 0),  -- NULL = chưa đếm
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, stocktake_id, variant_id),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, stocktake_id) REFERENCES stocktakes (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, variant_id)   REFERENCES variants   (shop_id, id)
);
CREATE INDEX stocktake_lines_st_idx ON stocktake_lines (shop_id, stocktake_id);
ALTER TABLE stocktake_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE stocktake_lines FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stocktake_lines FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON stocktake_lines TO app_rw;

-- Ledger: nhận='receive', kiểm kê='adjust' — cả hai đã có trong CHECK 0009; nguồn phân biệt
-- qua reason ('Nhập phiếu #<n>' / 'Kiểm kê #<n>'). KHÔNG grant cho vai storefront/checkout/khách.
