-- 0177 — nền tích hợp POS ngoài, bắt đầu với KiotViet.
--
-- Một shop chỉ có MỘT nơi làm chủ tồn vật lý. `external_master` không có nghĩa hai phía
-- cùng sửa tồn: KiotViet làm chủ on_hand, nền tảng chỉ giữ bản chiếu + reservation của đơn
-- website. Webhook có thể mất hoặc tới lặp nên inbox và registry định danh đều bền vững.

CREATE TABLE shop_integrations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                uuid NOT NULL REFERENCES shops(id),
  provider               text NOT NULL CHECK (provider IN ('kiotviet','sapo')),
  status                 text NOT NULL DEFAULT 'connecting'
                         CHECK (status IN ('connecting','active','degraded','disabled')),
  inventory_authority    text NOT NULL DEFAULT 'local'
                         CHECK (inventory_authority IN ('local','external_master')),
  credential_ciphertext  text NOT NULL,
  retailer               text,
  external_branch_ref    text,
  external_branch_name   text,
  webhook_public_id      uuid NOT NULL DEFAULT gen_random_uuid(),
  webhook_refs           jsonb NOT NULL DEFAULT '{}'::jsonb,
  webhook_registered_at  timestamptz,
  catalog_synced_at      timestamptz,
  inventory_synced_at    timestamptz,
  orders_synced_at       timestamptz,
  webhook_received_at    timestamptz,
  reconciled_at          timestamptz,
  last_error             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, provider),
  UNIQUE (webhook_public_id)
);

CREATE TABLE integration_webhook_inbox (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES shops(id),
  integration_id    uuid NOT NULL,
  provider_event_id text NOT NULL,
  event_type        text NOT NULL,
  payload_hash      text NOT NULL,
  payload           jsonb NOT NULL,
  occurred_at       timestamptz,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','completed','failed')),
  attempts          int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at   timestamptz,
  claimed_at        timestamptz,
  processed_at      timestamptz,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, integration_id, provider_event_id),
  FOREIGN KEY (shop_id, integration_id) REFERENCES shop_integrations(shop_id, id)
);

CREATE INDEX integration_webhook_pending_idx
  ON integration_webhook_inbox (next_attempt_at NULLS FIRST, created_at)
  WHERE status IN ('pending','failed');

CREATE TABLE integration_entity_refs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id             uuid NOT NULL REFERENCES shops(id),
  integration_id      uuid NOT NULL,
  entity_type         text NOT NULL
                      CHECK (entity_type IN ('product','variant','customer','order','invoice','payment','return')),
  external_id         text NOT NULL,
  local_id            uuid,
  mapping_status      text NOT NULL DEFAULT 'mapped'
                      CHECK (mapping_status IN ('mapped','unmapped','conflict','ignored')),
  external_updated_at timestamptz,
  payload_hash        text,
  raw_meta            jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, integration_id, entity_type, external_id),
  FOREIGN KEY (shop_id, integration_id) REFERENCES shop_integrations(shop_id, id)
);

CREATE UNIQUE INDEX integration_entity_local_unique
  ON integration_entity_refs (shop_id, integration_id, entity_type, local_id)
  WHERE local_id IS NOT NULL AND mapping_status = 'mapped' AND entity_type <> 'invoice';

CREATE TABLE integration_sync_discrepancies (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          uuid NOT NULL REFERENCES shops(id),
  integration_id   uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN (
                     'unmapped_sku','duplicate_sku','duplicate_barcode','stock_below_reserved',
                     'provider_rejected','payment_mismatch','return_mismatch','webhook_failed'
                   )),
  severity         text NOT NULL DEFAULT 'warning' CHECK (severity IN ('warning','critical')),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','ignored')),
  entity_type      text,
  external_ref     text,
  local_id         uuid,
  dedupe_key       text NOT NULL,
  message          text NOT NULL,
  details          jsonb,
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, integration_id) REFERENCES shop_integrations(shop_id, id)
);

CREATE UNIQUE INDEX integration_discrepancy_open_unique
  ON integration_sync_discrepancies (shop_id, integration_id, dedupe_key)
  WHERE status = 'open';

ALTER TABLE variants ADD COLUMN barcode text;
CREATE UNIQUE INDEX variants_shop_barcode_unique
  ON variants (shop_id, barcode) WHERE barcode IS NOT NULL AND btrim(barcode) <> '';

ALTER TABLE product_source_refs DROP CONSTRAINT product_source_refs_source_check;
ALTER TABLE product_source_refs ADD CONSTRAINT product_source_refs_source_check
  CHECK (source IN ('tiktok','shopify','haravan','sapo','shopee','kiotviet'));

ALTER TABLE orders DROP CONSTRAINT orders_source_check;
ALTER TABLE orders ADD CONSTRAINT orders_source_check
  CHECK (source IN ('web','manual','facebook','zalo','tiktok','other','kiotviet_pos','sapo_pos'));

ALTER TABLE orders DROP CONSTRAINT orders_payment_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check
  CHECK (payment_method IN ('cod','qr','cash','card','transfer','other'));

ALTER TABLE orders
  ADD COLUMN integration_id uuid,
  ADD COLUMN external_ref text,
  ADD COLUMN external_branch_ref text,
  ADD COLUMN sync_status text NOT NULL DEFAULT 'not_required'
    CHECK (sync_status IN ('not_required','pending','synced','needs_attention')),
  ADD COLUMN sync_error text,
  ADD COLUMN sync_updated_at timestamptz,
  ADD FOREIGN KEY (shop_id, integration_id) REFERENCES shop_integrations(shop_id, id);

CREATE UNIQUE INDEX orders_external_ref_unique
  ON orders (shop_id, integration_id, external_ref)
  WHERE integration_id IS NOT NULL AND external_ref IS NOT NULL;
CREATE INDEX orders_sync_queue_idx
  ON orders (shop_id, sync_status, created_at DESC)
  WHERE sync_status IN ('pending','needs_attention');

-- Một shop không được có hai POS cùng tuyên bố làm chủ tồn. Chuyển provider phải là thao tác
-- có kiểm soát; nếu không, checkout không biết độ tươi nào là nguồn quyết định.
CREATE UNIQUE INDEX shop_integrations_one_external_master
  ON shop_integrations (shop_id) WHERE inventory_authority = 'external_master';
CREATE INDEX shop_integrations_reconcile_due
  ON shop_integrations (reconciled_at NULLS FIRST)
  WHERE status = 'active' AND inventory_authority = 'external_master';

-- RLS của bốn bảng mới: app_rw vận hành trong admin; app_integration xử lý webhook/worker.
ALTER TABLE shop_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_integrations FORCE ROW LEVEL SECURITY;
ALTER TABLE integration_webhook_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_webhook_inbox FORCE ROW LEVEL SECURITY;
ALTER TABLE integration_entity_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_entity_refs FORCE ROW LEVEL SECURITY;
ALTER TABLE integration_sync_discrepancies ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_sync_discrepancies FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON shop_integrations FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY tenant_isolation ON integration_webhook_inbox FOR SELECT TO app_rw
  USING (shop_id = current_shop_id());
CREATE POLICY tenant_isolation ON integration_entity_refs FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY tenant_isolation ON integration_sync_discrepancies FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- DEFAULT PRIVILEGES của 0003 cấp CRUD app_rw cho bảng mới. Thu hẹp inbox (bằng chứng nhận
-- từ Internet) thành chỉ đọc; discrepancy cho phép đóng ca nhưng không tự bịa hoặc xoá ca.
GRANT SELECT, INSERT, UPDATE, DELETE ON shop_integrations TO app_rw;
GRANT SELECT ON integration_webhook_inbox TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON integration_entity_refs TO app_rw;
GRANT SELECT, UPDATE ON integration_sync_discrepancies TO app_rw;
REVOKE INSERT, UPDATE, DELETE ON integration_webhook_inbox FROM app_rw;
REVOKE INSERT, DELETE ON integration_sync_discrepancies FROM app_rw;

-- Checkout chỉ cần biết có external-master đang hoạt động và bản chiếu tồn còn mới không.
GRANT SELECT (id, provider, status, inventory_authority, external_branch_ref, inventory_synced_at)
  ON shop_integrations TO app_checkout;
CREATE POLICY checkout_active_integration ON shop_integrations FOR SELECT TO app_checkout
  USING (shop_id = current_shop_id() AND (status = 'active' OR inventory_authority = 'external_master'));

-- Vai hẹp dùng chung cho endpoint webhook và worker connector. Không BYPASSRLS; mọi truy vấn
-- nghiệp vụ sau khi resolve webhook đều phải đặt app.shop_id trong transaction.
CREATE ROLE app_integration LOGIN PASSWORD 'devpassword'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE app TO app_integration;
GRANT USAGE ON SCHEMA public TO app_integration;

GRANT SELECT, UPDATE ON shop_integrations TO app_integration;
GRANT SELECT, INSERT, UPDATE ON integration_webhook_inbox TO app_integration;
GRANT SELECT, INSERT, UPDATE ON integration_entity_refs TO app_integration;
GRANT SELECT, INSERT, UPDATE ON integration_sync_discrepancies TO app_integration;
GRANT SELECT ON products, variants, product_source_refs, orders, order_lines, inventory_levels TO app_integration;
GRANT INSERT, UPDATE ON product_source_refs, inventory_levels TO app_integration;
GRANT INSERT ON inventory_ledger, order_lines, orders, payment_transactions, order_events TO app_integration;
-- ON CONFLICT của payment_transactions cần đọc đúng ba cột khoá duy nhất; helper
-- record_order_event dùng RETURNING id. Không mở SELECT toàn bộ hai sổ append-only.
GRANT SELECT (shop_id, provider, provider_event_id) ON payment_transactions TO app_integration;
GRANT SELECT (id) ON order_events TO app_integration;
GRANT SELECT, INSERT, UPDATE ON shop_counters TO app_integration;
GRANT USAGE, SELECT ON SEQUENCE inventory_ledger_id_seq TO app_integration;
GRANT UPDATE (integration_id, external_ref, external_branch_ref, sync_status, sync_error, sync_updated_at)
  ON orders TO app_integration;
GRANT INSERT ON outbox TO app_integration;
GRANT USAGE, SELECT ON SEQUENCE outbox_id_seq TO app_integration;

CREATE POLICY integration_config ON shop_integrations FOR ALL TO app_integration
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY integration_inbox ON integration_webhook_inbox FOR ALL TO app_integration
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY integration_refs ON integration_entity_refs FOR ALL TO app_integration
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY integration_discrepancies ON integration_sync_discrepancies FOR ALL TO app_integration
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY integration_products ON products FOR SELECT TO app_integration
  USING (shop_id = current_shop_id());
CREATE POLICY integration_variants ON variants FOR SELECT TO app_integration
  USING (shop_id = current_shop_id());
CREATE POLICY integration_product_refs ON product_source_refs FOR ALL TO app_integration
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY integration_orders ON orders FOR ALL TO app_integration
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY integration_order_lines ON order_lines FOR SELECT TO app_integration
  USING (shop_id = current_shop_id());
CREATE POLICY integration_order_lines_write ON order_lines FOR INSERT TO app_integration
  WITH CHECK (shop_id = current_shop_id());
CREATE POLICY integration_inventory ON inventory_levels FOR ALL TO app_integration
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY integration_inventory_ledger ON inventory_ledger FOR INSERT TO app_integration
  WITH CHECK (shop_id = current_shop_id());
CREATE POLICY integration_counters ON shop_counters FOR ALL TO app_integration
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY integration_payments ON payment_transactions FOR INSERT TO app_integration
  WITH CHECK (shop_id = current_shop_id());
CREATE POLICY integration_payments_read ON payment_transactions FOR SELECT TO app_integration
  USING (shop_id = current_shop_id());
CREATE POLICY integration_order_events ON order_events FOR INSERT TO app_integration
  WITH CHECK (shop_id = current_shop_id());
CREATE POLICY integration_order_events_read ON order_events FOR SELECT TO app_integration
  USING (shop_id = current_shop_id());
GRANT EXECUTE ON FUNCTION record_order_event(uuid,text,text,text,text,jsonb,timestamptz) TO app_integration;
CREATE POLICY integration_outbox ON outbox FOR INSERT TO app_integration
  WITH CHECK (shop_id = current_shop_id());

-- Endpoint công khai chưa biết tenant. Hàm chỉ trả đúng một kết nối theo UUID public; chữ ký
-- HMAC vẫn là lớp xác thực. Không mở SELECT cross-shop trực tiếp cho app_integration.
CREATE FUNCTION resolve_integration_webhook(p_public_id uuid)
RETURNS TABLE (
  integration_id uuid,
  shop_id uuid,
  provider text,
  credential_ciphertext text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT i.id, i.shop_id, i.provider, i.credential_ciphertext
    FROM shop_integrations i
   WHERE i.webhook_public_id = p_public_id
     AND i.status IN ('active','degraded')
$$;
ALTER FUNCTION resolve_integration_webhook(uuid) OWNER TO app_owner;
REVOKE ALL ON FUNCTION resolve_integration_webhook(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_integration_webhook(uuid) TO app_integration;

-- Worker không được SELECT xuyên tenant. Hàm chỉ lộ hai UUID của các connector tới hạn;
-- mọi dữ liệu nghiệp vụ sau đó vẫn đi qua SET LOCAL + RLS của chính shop đó.
CREATE FUNCTION list_due_integrations(p_limit int DEFAULT 20)
RETURNS TABLE (shop_id uuid, integration_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT i.shop_id, i.id
    FROM shop_integrations i
   WHERE i.status = 'active' AND i.inventory_authority = 'external_master'
     AND coalesce(i.reconciled_at, '-infinity'::timestamptz) < now() - interval '5 minutes'
   ORDER BY i.reconciled_at NULLS FIRST, i.id
   LIMIT least(greatest(coalesce(p_limit, 20), 1), 100)
$$;
ALTER FUNCTION list_due_integrations(int) OWNER TO app_owner;
REVOKE ALL ON FUNCTION list_due_integrations(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_due_integrations(int) TO app_integration;

-- Inbox là nguồn phục hồi bền vững khi outbox đã đánh dấu processed nhưng job Redis bị mất,
-- hoặc worker chết giữa lúc xử lý. Chỉ lộ UUID định tuyến; payload vẫn nằm sau RLS tenant.
CREATE FUNCTION list_due_integration_webhooks(p_limit int DEFAULT 50)
RETURNS TABLE (shop_id uuid, inbox_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT w.shop_id, w.id
    FROM integration_webhook_inbox w
    JOIN shop_integrations i
      ON i.shop_id = w.shop_id AND i.id = w.integration_id
   WHERE i.status IN ('active','degraded')
     AND (
       w.status = 'pending'
       OR (w.status = 'failed' AND coalesce(w.next_attempt_at, '-infinity'::timestamptz) <= now())
       OR (w.status = 'processing' AND coalesce(w.claimed_at, '-infinity'::timestamptz) < now() - interval '10 minutes')
     )
   ORDER BY coalesce(w.next_attempt_at, w.created_at), w.id
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
$$;
ALTER FUNCTION list_due_integration_webhooks(int) OWNER TO app_owner;
REVOKE ALL ON FUNCTION list_due_integration_webhooks(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_due_integration_webhooks(int) TO app_integration;

REVOKE ALL ON shop_integrations, integration_webhook_inbox, integration_entity_refs,
  integration_sync_discrepancies FROM app_store, app_customer;
