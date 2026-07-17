-- 0070 — refunds: HOÀN TIỀN = BÚT TOÁN (rà soát #21/#28). Trước giờ refundOrder chỉ
-- lật status/payment_status — KHÔNG số tiền, KHÔNG hoàn một phần, KHÔNG đối chiếu được
-- "đã hoàn bao nhiêu". Mỗi lần hoàn = MỘT dòng append-only (như audit_logs/platform_invoices):
--   • hoàn TOÀN BỘ: một dòng đủ số còn lại + lật refunded như cũ (tồn kho giữ nguyên semantics).
--   • hoàn MỘT PHẦN: dòng < số còn lại, đơn GIỮ paid/status; khi luỹ kế chạm tổng → lật.
-- restock: Ý ĐỊNH nhập lại kho do người thao tác khai (v1 KHÔNG tự đụng tồn — hoàn một
-- phần theo số tiền không ánh xạ được sang dòng hàng/qty; chủ shop tự Điều chỉnh tồn).

CREATE TABLE refunds (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    uuid NOT NULL,
  order_id   uuid NOT NULL,
  amount_vnd bigint NOT NULL CHECK (amount_vnd > 0),
  reason     text,
  restock    boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders (shop_id, id)
);
CREATE INDEX refunds_order_idx ON refunds (shop_id, order_id);

ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON refunds FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- Bút toán = chứng từ: app_rw CHỈ ghi thêm + đọc. Default privileges (0003) vừa tự cấp
-- CRUD lúc CREATE → thu hồi UPDATE/DELETE tường minh (schema-invariants kiểm bằng
-- has_table_privilege — thêm 'refunds' vào danh sách append-only bên test).
REVOKE UPDATE, DELETE ON refunds FROM app_rw;
GRANT SELECT, INSERT ON refunds TO app_rw;
