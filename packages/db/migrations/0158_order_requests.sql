-- 0158 — Yêu cầu hậu mãi từ khách: chỉ GỬI YÊU CẦU, không tự đổi đơn.
--
-- Ba loại yêu cầu dùng chung một sổ trạng thái:
--   cancel         — shop duyệt rồi mới gọi transaction huỷ đơn hiện có.
--   address_change — shop duyệt rồi mới đổi snapshot người nhận/địa chỉ.
--   return         — shop duyệt trước; chỉ hoàn tất khi thực sự nhận hàng qua RMA.
--
-- Khách đăng nhập được nhận diện bằng current_customer_id(). Khách vãng lai sẽ được
-- checkout đặt app.claim_token_hash khi nối UI tra cứu; policy đã chuẩn bị sẵn nhưng
-- vẫn fail-closed khi GUC này chưa được đặt.

CREATE TABLE order_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id             uuid NOT NULL,
  order_id            uuid NOT NULL,
  customer_id         uuid,
  request_type        text NOT NULL CHECK (request_type IN ('cancel','address_change','return')),
  requester_type      text NOT NULL CHECK (requester_type IN ('customer','guest','messenger')),
  status              text NOT NULL DEFAULT 'requested'
                      CHECK (status IN ('requested','approved','completed','rejected')),
  reason              text,
  request_payload     jsonb NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(request_payload) = 'object'),
  decision_note       text,
  resolution_payload  jsonb NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(resolution_payload) = 'object'),
  decided_by          uuid REFERENCES users (id),
  result_return_id    uuid,
  decided_at          timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders (shop_id, id),
  FOREIGN KEY (shop_id, customer_id) REFERENCES customers (shop_id, id),
  FOREIGN KEY (shop_id, result_return_id) REFERENCES returns (shop_id, id),

  CHECK ((requester_type = 'customer' AND customer_id IS NOT NULL)
      OR (requester_type IN ('guest','messenger') AND customer_id IS NULL)),
  CHECK (result_return_id IS NULL OR (request_type = 'return' AND status = 'completed')),
  CHECK (
       (status = 'requested' AND decided_by IS NULL AND decided_at IS NULL AND completed_at IS NULL)
    OR (status = 'approved'  AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND completed_at IS NULL)
    OR (status = 'rejected'  AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND completed_at IS NULL)
    OR (status = 'completed' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX order_requests_order_idx
  ON order_requests (shop_id, order_id, created_at DESC);
CREATE INDEX order_requests_work_idx
  ON order_requests (shop_id, status, created_at)
  WHERE status IN ('requested','approved');
-- Hai lần bấm hoặc hai request đồng thời phải trả về cùng một việc đang mở, không tạo đôi.
CREATE UNIQUE INDEX order_requests_one_open_type
  ON order_requests (shop_id, order_id, request_type)
  WHERE status IN ('requested','approved');

ALTER TABLE order_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_requests FORCE ROW LEVEL SECURITY;

-- Default privileges của 0003 cấp CRUD cho app_rw: thu hồi rồi cấp đúng các cột seller cần.
REVOKE ALL ON order_requests FROM PUBLIC, app_rw, app_customer, app_checkout;
GRANT SELECT ON order_requests TO app_rw;
GRANT UPDATE (status, decision_note, resolution_payload, decided_by, result_return_id,
              decided_at, completed_at, updated_at)
  ON order_requests TO app_rw;

GRANT SELECT (id, shop_id, order_id, customer_id, request_type, requester_type, status,
              reason, request_payload, decision_note, resolution_payload, result_return_id,
              decided_at, completed_at, created_at, updated_at)
  ON order_requests TO app_customer;
GRANT INSERT (shop_id, order_id, customer_id, request_type, requester_type, reason, request_payload)
  ON order_requests TO app_customer;

-- Chuẩn bị cho form guest ở trang tra cứu. Không app.claim_token_hash => policy trả rỗng.
GRANT SELECT (id, shop_id, order_id, request_type, requester_type, status, reason,
              request_payload, decision_note, resolution_payload, result_return_id,
              decided_at, completed_at, created_at, updated_at)
  ON order_requests TO app_checkout;
GRANT INSERT (shop_id, order_id, customer_id, request_type, requester_type, reason, request_payload)
  ON order_requests TO app_checkout;

CREATE POLICY seller_order_requests ON order_requests FOR ALL TO app_rw
  USING (shop_id = current_shop_id())
  WITH CHECK (shop_id = current_shop_id());

CREATE POLICY customer_order_requests_read ON order_requests FOR SELECT TO app_customer
  USING (shop_id = current_shop_id()
         AND EXISTS (
           SELECT 1 FROM orders o
            WHERE o.id = order_requests.order_id
              AND o.shop_id = current_shop_id()
              AND o.customer_id = current_customer_id()));
CREATE POLICY customer_order_requests_insert ON order_requests FOR INSERT TO app_customer
  WITH CHECK (shop_id = current_shop_id()
              AND requester_type = 'customer'
              AND customer_id = current_customer_id()
              AND status = 'requested'
              AND EXISTS (
                SELECT 1 FROM orders o
                 WHERE o.id = order_requests.order_id
                   AND o.shop_id = current_shop_id()
                   AND o.customer_id = current_customer_id()));

CREATE POLICY checkout_order_requests_read ON order_requests FOR SELECT TO app_checkout
  USING (shop_id = current_shop_id()
         AND requester_type = 'guest'
         AND EXISTS (
           SELECT 1 FROM orders o
            WHERE o.id = order_requests.order_id
              AND o.shop_id = current_shop_id()
              AND o.lookup_token_hash = current_claim_token_hash()));
CREATE POLICY checkout_order_requests_insert ON order_requests FOR INSERT TO app_checkout
  WITH CHECK (shop_id = current_shop_id()
              AND requester_type = 'guest'
              AND customer_id IS NULL
              AND status = 'requested'
              AND EXISTS (
                SELECT 1 FROM orders o
                 WHERE o.id = order_requests.order_id
                   AND o.shop_id = current_shop_id()
                   AND o.lookup_token_hash = current_claim_token_hash()));

COMMENT ON TABLE order_requests IS
  'Yêu cầu hậu mãi request-only; seller duyệt trước khi đổi trạng thái, địa chỉ, tiền hoặc tồn.';
