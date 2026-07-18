-- 0078 — ĐỔI-TRẢ (RMA) v1: khách ĐÃ NHẬN hàng trả lại → hoàn tiền + nhập lại kho.
--
-- KHÁC 'returned' (0059, bom hàng do HÃNG trả về khi khách từ chối nhận): RMA là khách
-- đã nhận rồi mới trả (đơn 'delivered'). Ghi bút toán trả từng dòng + tái dùng refunds
-- (0070) cho tiền + inventory_ledger (0009) cho restock → nhất quán với lịch sử hoàn/tồn.
--
-- returns/return_lines APPEND-ONLY (chứng từ tài chính, như refunds): REVOKE UPDATE/DELETE.
-- FK composite (shop_id, order_id/return_id) — mọi bảng có UNIQUE(shop_id, id) (quy ước 0002).

CREATE TABLE returns (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    uuid NOT NULL,
  order_id   uuid NOT NULL,
  status     text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed')), -- v1 một-bước; mở rộng requested/received sau
  reason     text,
  refund_vnd bigint NOT NULL CHECK (refund_vnd >= 0),
  restocked  boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders (shop_id, id)
);
CREATE INDEX returns_order_idx ON returns (shop_id, order_id, id);
ALTER TABLE returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE returns FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON returns FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
REVOKE UPDATE, DELETE ON returns FROM app_rw;
GRANT SELECT, INSERT ON returns TO app_rw;

CREATE TABLE return_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        uuid NOT NULL,
  return_id      uuid NOT NULL,
  variant_id     uuid NOT NULL,
  qty            int  NOT NULL CHECK (qty > 0),
  unit_price_vnd bigint NOT NULL CHECK (unit_price_vnd >= 0), -- snapshot giá dòng đơn lúc trả
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, return_id) REFERENCES returns (shop_id, id)
);
CREATE INDEX return_lines_return_idx ON return_lines (shop_id, return_id);
ALTER TABLE return_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE return_lines FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON return_lines FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
REVOKE UPDATE, DELETE ON return_lines FROM app_rw;
GRANT SELECT, INSERT ON return_lines TO app_rw;
