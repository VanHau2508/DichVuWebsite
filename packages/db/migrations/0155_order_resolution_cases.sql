-- 0155 — CA CẦN XỬ LÝ khi một đơn tách kiện có kết quả trái nhau.
--
-- Trạng thái `orders.status` hiện chưa có giá trị "giao một phần": nếu một kiện delivered
-- và một kiện returned, worker phải giữ đơn ở `shipped` để không nói dối rằng toàn bộ đơn đã
-- giao hoặc toàn bộ đơn đã hoàn. Bảng này biến tình huống đó thành một công việc có chủ,
-- có quyết định và có dấu vết thay vì để đơn treo im lặng.

CREATE TABLE order_resolution_cases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         uuid NOT NULL,
  order_id        uuid NOT NULL,
  kind            text NOT NULL DEFAULT 'mixed_shipment_outcome'
                  CHECK (kind IN ('mixed_shipment_outcome')),
  status          text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','resolved')),
  resolution      text CHECK (resolution IN (
                    'accept_partial','resent','refunded_remainder','cancelled_remainder','other'
                  )),
  resolution_note text CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 1000),
  detected_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id) REFERENCES shops(id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  CHECK (
    (status = 'open' AND resolution IS NULL AND resolved_at IS NULL)
    OR
    (status = 'resolved' AND resolution IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

-- Một đơn chỉ được có một ca cùng loại đang mở. Lịch sử ca đã xử vẫn được giữ nguyên.
CREATE UNIQUE INDEX order_resolution_one_open_idx
  ON order_resolution_cases (shop_id, order_id, kind)
  WHERE status = 'open';
CREATE INDEX order_resolution_shop_status_idx
  ON order_resolution_cases (shop_id, status, detected_at DESC);

ALTER TABLE order_resolution_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_resolution_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_resolution_cases FOR ALL TO app_rw
  USING (shop_id = current_shop_id())
  WITH CHECK (shop_id = current_shop_id());

-- Seller chỉ đọc và chốt ca; không được tự dựng/xoá bằng chứng phát hiện từ worker.
REVOKE INSERT, DELETE, UPDATE ON order_resolution_cases FROM app_rw;
GRANT SELECT ON order_resolution_cases TO app_rw;
GRANT UPDATE (status, resolution, resolution_note, resolved_at, resolved_by)
  ON order_resolution_cases TO app_rw;

-- Vòng quét tracking chạy xuyên shop bằng app_expiry. Nó chỉ cần phát hiện + tạo ca,
-- không có quyền tự kết luận thay người bán.
GRANT SELECT, INSERT ON order_resolution_cases TO app_expiry;
CREATE POLICY expiry_resolution_cases ON order_resolution_cases
  FOR SELECT TO app_expiry USING (true);
CREATE POLICY expiry_resolution_cases_insert ON order_resolution_cases
  FOR INSERT TO app_expiry WITH CHECK (true);

-- Cần đọc dòng kiện để tính số lượng delivered/returned khi hiển thị ca.
GRANT SELECT (shipment_id, order_line_id, variant_id, qty) ON shipment_lines TO app_expiry;

