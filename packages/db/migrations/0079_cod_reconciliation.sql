-- 0079 — ĐỐI SOÁT COD với hãng (kiểm toán #20): ghi hãng đã thu/chuyển về bao nhiêu, còn nợ.
--
-- Đơn COD giao QUA HÃNG: hãng thu total_vnd của khách rồi chuyển về shop (thường trừ phí
-- hãng). Trước đây 0066 đặt payment_status='paid' khi giao xong (khách đã trả hãng) nhưng
-- KHÔNG theo dõi tiền hãng đã chuyển về shop CHƯA → shop không biết đơn nào hãng còn nợ.
--
-- SỔ THỦ CÔNG (không cần API hãng — đó là việc user cắm): shop nhập phiếu chuyển tiền từ
-- sao kê hãng, chọn các đơn nó bao gồm → đánh dấu đã đối soát + ghi chênh lệch kỳ-vọng/thực.
--
-- cod_remittances APPEND-ONLY (chứng từ tài chính, như refunds/returns): REVOKE UPDATE/DELETE.
-- app_rw table-level trên orders → 2 cột mới tự phủ. Đối soát chỉ đơn giao QUA HÃNG
-- (shipments.provider NOT NULL) — giao tay thì shop đã cầm tiền, không cần đối soát.

CREATE TABLE cod_remittances (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL,
  carrier      text,                                     -- 'ghn'|'ghtk'|... (NULL = trộn/không rõ)
  amount_vnd   bigint NOT NULL CHECK (amount_vnd >= 0),  -- tiền hãng THỰC chuyển về (shop nhập)
  expected_vnd bigint NOT NULL CHECK (expected_vnd >= 0),-- tổng COD-net KỲ VỌNG các đơn (snapshot)
  order_count  int    NOT NULL CHECK (order_count > 0),
  remitted_at  date   NOT NULL DEFAULT current_date,
  note         text,
  created_by   uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id) REFERENCES shops (id)
);
CREATE INDEX cod_remittances_shop_idx ON cod_remittances (shop_id, id);
ALTER TABLE cod_remittances ENABLE ROW LEVEL SECURITY;
ALTER TABLE cod_remittances FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cod_remittances FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
REVOKE UPDATE, DELETE ON cod_remittances FROM app_rw;
GRANT SELECT, INSERT ON cod_remittances TO app_rw;

-- Đơn: mốc đối soát + phiếu chuyển tiền gắn với đơn (NULL = chưa đối soát).
ALTER TABLE orders ADD COLUMN cod_settled_at    timestamptz;
ALTER TABLE orders ADD COLUMN cod_remittance_id uuid;
-- FK composite (NULL không bị cưỡng chế — đơn chưa đối soát thì cột NULL).
ALTER TABLE orders ADD FOREIGN KEY (shop_id, cod_remittance_id) REFERENCES cod_remittances (shop_id, id);
