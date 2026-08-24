-- 0178 — siết vòng đời và bằng chứng đồng bộ của connector KiotViet.
--
-- 0177 dựng nền connector. Lượt rà độc lập sau đó tìm ra bốn lớp xanh giả: credential mới
-- ghi đè kết nối đang chạy ngay từ bước probe; job cũ có thể bật lại connector đã ngắt; một
-- webhook tồn làm mới timestamp cho cả catalog; và timestamp hoạt động đơn bị dùng nhầm làm
-- cursor invoice. Migration này tách rõ từng khái niệm để app không thể tiếp tục trộn chúng.

ALTER TABLE shop_integrations
  ALTER COLUMN credential_ciphertext DROP NOT NULL,
  ALTER COLUMN webhook_public_id DROP NOT NULL,
  ALTER COLUMN webhook_public_id DROP DEFAULT,
  ADD COLUMN generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  ADD COLUMN pending_generation bigint,
  ADD COLUMN pending_credential_ciphertext text,
  ADD COLUMN pending_retailer text,
  ADD COLUMN pending_webhook_public_id uuid,
  ADD COLUMN order_reconcile_cursor_at timestamptz,
  ADD COLUMN invoice_reconcile_cursor_at timestamptz,
  ADD COLUMN capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT shop_integrations_pending_bundle_check CHECK (
    (pending_generation IS NULL AND pending_credential_ciphertext IS NULL
      AND pending_retailer IS NULL AND pending_webhook_public_id IS NULL)
    OR
    (pending_generation IS NOT NULL AND pending_generation = generation + 1
      AND pending_credential_ciphertext IS NOT NULL
      AND pending_retailer IS NOT NULL AND pending_webhook_public_id IS NOT NULL)
  );

-- app_owner không BYPASS FORCE RLS trong production. Mở policy UPDATE tạm đúng ba bảng cần
-- backfill, rồi đóng lại ngay sau khi dữ liệu 0177 đã được chuẩn hóa.
CREATE POLICY integration_0178_owner_config_update ON shop_integrations
  FOR ALL TO app_owner USING (true) WITH CHECK (true);
CREATE POLICY integration_0178_owner_inbox_update ON integration_webhook_inbox
  FOR ALL TO app_owner USING (true) WITH CHECK (true);
CREATE POLICY integration_0178_owner_orders_update ON orders
  FOR ALL TO app_owner USING (true) WITH CHECK (true);

-- Backfill generation trước khi siết NOT NULL. Dùng DEFAULT 0 ở đây sẽ biến một đường INSERT
-- quên đóng dấu thành event hợp lệ của connector đời 0.
ALTER TABLE integration_webhook_inbox ADD COLUMN generation bigint;
UPDATE integration_webhook_inbox w
   SET generation = i.generation
  FROM shop_integrations i
 WHERE i.shop_id = w.shop_id AND i.id = w.integration_id;
ALTER TABLE integration_webhook_inbox
  ALTER COLUMN generation SET NOT NULL,
  ADD CONSTRAINT integration_webhook_generation_check CHECK (generation >= 0);

ALTER TABLE integration_webhook_inbox DROP CONSTRAINT integration_webhook_inbox_status_check;
ALTER TABLE integration_webhook_inbox ADD CONSTRAINT integration_webhook_inbox_status_check
  CHECK (status IN ('pending','processing','completed','failed','superseded','dead_letter'));
DO $$
DECLARE v_name name;
BEGIN
  SELECT conname INTO v_name
    FROM pg_constraint
   WHERE conrelid = 'integration_webhook_inbox'::regclass
     AND contype = 'u'
     AND pg_get_constraintdef(oid) = 'UNIQUE (shop_id, integration_id, provider_event_id)';
  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE integration_webhook_inbox DROP CONSTRAINT %I', v_name);
  END IF;
END $$;
ALTER TABLE integration_webhook_inbox
  ADD CONSTRAINT integration_webhook_generation_event_unique
  UNIQUE (shop_id, integration_id, generation, event_type, provider_event_id);

ALTER TABLE integration_sync_discrepancies
  DROP CONSTRAINT integration_sync_discrepancies_kind_check;
ALTER TABLE integration_sync_discrepancies
  ADD CONSTRAINT integration_sync_discrepancies_kind_check CHECK (kind IN (
    'unmapped_sku','duplicate_sku','duplicate_barcode','inventory_unavailable',
    'stock_below_reserved','local_orders_pending','provider_rejected','payment_mismatch',
    'return_mismatch','webhook_failed','order_identity_pending'
  ));

ALTER TABLE integration_entity_refs
  ADD COLUMN inventory_synced_at timestamptz,
  ADD COLUMN inventory_generation bigint,
  ADD CONSTRAINT integration_ref_inventory_stamp_check CHECK (
    (inventory_synced_at IS NULL AND inventory_generation IS NULL)
    OR
    (entity_type = 'variant' AND mapping_status = 'mapped' AND local_id IS NOT NULL
      AND inventory_synced_at IS NOT NULL AND inventory_generation IS NOT NULL
      AND inventory_generation >= 0)
  );

ALTER TABLE orders ADD COLUMN integration_generation bigint;
UPDATE orders o
   SET integration_generation = i.generation
  FROM shop_integrations i
 WHERE i.shop_id = o.shop_id AND i.id = o.integration_id;
ALTER TABLE orders ADD CONSTRAINT orders_integration_generation_check CHECK (
    (integration_id IS NULL AND integration_generation IS NULL)
    OR (integration_id IS NOT NULL AND integration_generation IS NOT NULL AND integration_generation >= 0)
  );
DROP INDEX orders_external_ref_unique;
CREATE UNIQUE INDEX orders_external_ref_unique
  ON orders (shop_id, integration_id, source, external_ref)
  WHERE integration_id IS NOT NULL AND external_ref IS NOT NULL;

CREATE UNIQUE INDEX shop_integrations_pending_webhook_public_unique
  ON shop_integrations (pending_webhook_public_id)
  WHERE pending_webhook_public_id IS NOT NULL;
ALTER TABLE shop_integrations ADD CONSTRAINT shop_integrations_public_ids_differ_check
  CHECK (pending_webhook_public_id IS NULL OR webhook_public_id IS NULL
    OR pending_webhook_public_id <> webhook_public_id);

-- Connector bị vô hiệu từ 0177 có thể còn giữ credential/URL dù resolver không trả nó. Dọn
-- bí mật ngay trong DB; mapping và authority vẫn giữ nguyên để thao tác chuyển nguồn là riêng biệt.
UPDATE shop_integrations
   SET credential_ciphertext = NULL, webhook_public_id = NULL, webhook_refs = '{}'::jsonb
 WHERE status = 'disabled';
UPDATE shop_integrations SET webhook_public_id = NULL WHERE credential_ciphertext IS NULL;
-- 0177 cho phép trạng thái active/local dù worker bình thường không tạo ra nó. Hạ trạng thái
-- cũ về degraded để nâng cấp không làm sập, rồi khóa bất biến cho mọi đường mới.
UPDATE shop_integrations
   SET status = 'degraded',
       last_error = coalesce(last_error, 'Kết nối active nhưng chưa chuyển quyền tồn; cần đối soát lại.')
 WHERE status = 'active' AND inventory_authority = 'local';
ALTER TABLE shop_integrations ADD CONSTRAINT shop_integrations_active_bundle_check CHECK (
  ((credential_ciphertext IS NULL) = (webhook_public_id IS NULL))
  AND (status NOT IN ('active','degraded') OR credential_ciphertext IS NOT NULL)
  AND (status <> 'disabled' OR (
    credential_ciphertext IS NULL AND webhook_public_id IS NULL
  ))
);
ALTER TABLE shop_integrations ADD CONSTRAINT shop_integrations_active_authority_check
  CHECK (status <> 'active' OR inventory_authority = 'external_master');
DROP POLICY integration_0178_owner_config_update ON shop_integrations;
DROP POLICY integration_0178_owner_inbox_update ON integration_webhook_inbox;
DROP POLICY integration_0178_owner_orders_update ON orders;

-- Checkout chỉ được tin độ tươi của đúng các biến thể nằm trong giỏ. Không lộ external ID,
-- raw payload hay credential cho vai nhận request công khai.
GRANT SELECT (id, provider, status, inventory_authority, external_branch_ref,
              inventory_synced_at, generation, capabilities)
  ON shop_integrations TO app_checkout;
GRANT SELECT (integration_id, entity_type, local_id, mapping_status,
              inventory_synced_at, inventory_generation)
  ON integration_entity_refs TO app_checkout;
CREATE POLICY checkout_integration_refs ON integration_entity_refs FOR SELECT TO app_checkout
  USING (shop_id = current_shop_id() AND entity_type = 'variant'
    AND mapping_status = 'mapped' AND local_id IS NOT NULL);
CREATE POLICY checkout_transitioning_integration ON shop_integrations FOR SELECT TO app_checkout
  USING (shop_id = current_shop_id() AND external_branch_ref IS NOT NULL
    AND status IN ('connecting','degraded'));

-- POS customer chỉ nối theo CustomerId ngoài. Vai connector không được đọc password_hash hay
-- tự gộp khách theo tên/SĐT; chỉ có các cột hồ sơ tối thiểu để tạo/cập nhật bản chiếu CRM.
GRANT SELECT (id, shop_id, full_name, phone, status), INSERT (shop_id, full_name, phone),
      UPDATE (full_name, phone, updated_at)
  ON customers TO app_integration;
CREATE POLICY integration_customers_select ON customers FOR SELECT TO app_integration
  USING (shop_id = current_shop_id());
CREATE POLICY integration_customers_insert ON customers FOR INSERT TO app_integration
  WITH CHECK (shop_id = current_shop_id());
CREATE POLICY integration_customers_update ON customers FOR UPDATE TO app_integration
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

GRANT UPDATE (sku, barcode, price_vnd) ON variants TO app_integration;
CREATE POLICY integration_variants_update ON variants FOR UPDATE TO app_integration
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT SELECT ON variant_costs TO app_integration;
CREATE POLICY integration_variant_costs_select ON variant_costs FOR SELECT TO app_integration
  USING (shop_id = current_shop_id());
GRANT UPDATE (status, integration_generation) ON orders TO app_integration;

-- FORCE RLS cũng áp lên app_owner. Các hàm router/trigger SECURITY DEFINER vì thế cần một
-- chủ sở hữu NOLOGIN có policy riêng; nếu để app_owner, chúng hợp lệ về cú pháp nhưng luôn
-- nhìn thấy 0 dòng trong production. Role này không thể đăng nhập và chỉ được mượn lúc ALTER
-- OWNER trong migration.
CREATE ROLE app_integration_guard NOLOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO app_integration_guard;
GRANT SELECT, UPDATE ON shop_integrations, integration_webhook_inbox,
  integration_entity_refs, orders TO app_integration_guard;
CREATE POLICY integration_guard_config ON shop_integrations FOR ALL TO app_integration_guard
  USING (true) WITH CHECK (true);
CREATE POLICY integration_guard_inbox ON integration_webhook_inbox FOR ALL TO app_integration_guard
  USING (true) WITH CHECK (true);
CREATE POLICY integration_guard_refs ON integration_entity_refs FOR ALL TO app_integration_guard
  USING (true) WITH CHECK (true);
CREATE POLICY integration_guard_orders ON orders FOR ALL TO app_integration_guard
  USING (true) WITH CHECK (true);

-- KiotViet là nguồn tồn vật lý thì mọi vai local chỉ được đổi reservation. Thay on_hand qua
-- inventory.adjust/import/purchasing/ship/restock phải bị chặn ở DB, kể cả một route mới quên
-- tự gác. app_integration là vai duy nhất ghi bản chiếu do provider vừa xác nhận.
CREATE FUNCTION guard_external_inventory_on_hand()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_integration_id uuid;
  v_generation bigint;
  v_status text;
  v_ctx_integration uuid;
  v_ctx_generation bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.on_hand IS NOT DISTINCT FROM OLD.on_hand THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.on_hand = 0 THEN
    RETURN NEW;
  END IF;
  SELECT i.id, i.generation, i.status
    INTO v_integration_id, v_generation, v_status
    FROM shop_integrations i
   WHERE i.shop_id = NEW.shop_id AND i.inventory_authority = 'external_master'
   LIMIT 1;

  IF v_integration_id IS NULL THEN
    IF current_user = 'app_integration' THEN
      RAISE EXCEPTION USING ERRCODE = 'PIV01',
        MESSAGE = 'Worker connector không được ghi tồn trước khi chuyển quyền sang POS ngoài.';
    END IF;
    RETURN NEW;
  END IF;

  IF current_user <> 'app_integration' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'PIV01',
      MESSAGE = 'Tồn vật lý đang do POS ngoài quản lý; hãy thao tác tồn tại POS hoặc chuyển quyền tồn về nền tảng.';
  END IF;

  IF v_status NOT IN ('connecting','active','degraded') THEN
    RAISE EXCEPTION USING ERRCODE = 'PIV01',
      MESSAGE = 'Connector đang ngắt nên bản chiếu tồn bị đóng băng.';
  END IF;
  BEGIN
    v_ctx_integration := nullif(current_setting('app.integration_id', true), '')::uuid;
    v_ctx_generation := nullif(current_setting('app.integration_generation', true), '')::bigint;
  EXCEPTION WHEN invalid_text_representation THEN
    v_ctx_integration := NULL; v_ctx_generation := NULL;
  END;
  IF v_ctx_integration IS DISTINCT FROM v_integration_id
     OR v_ctx_generation IS DISTINCT FROM v_generation THEN
    RAISE EXCEPTION USING ERRCODE = 'PIV01',
      MESSAGE = 'Job connector cũ hoặc sai connector không được ghi tồn.';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION guard_external_inventory_on_hand() OWNER TO app_owner;
REVOKE ALL ON FUNCTION guard_external_inventory_on_hand() FROM PUBLIC;

CREATE TRIGGER inventory_external_master_insert_guard
BEFORE INSERT ON inventory_levels
FOR EACH ROW EXECUTE FUNCTION guard_external_inventory_on_hand();
CREATE TRIGGER inventory_external_master_update_guard
BEFORE UPDATE OF on_hand ON inventory_levels
FOR EACH ROW EXECUTE FUNCTION guard_external_inventory_on_hand();

-- Chưa có contract API sửa/hủy/giao/hoàn KiotViet đã được pilot xác minh. Sau khi provider đã
-- nhận đơn (external_ref có giá trị), mọi vai local phải fail-closed thay vì sửa riêng nền tảng
-- rồi để POS tiếp tục thực hiện bản cũ. POS transaction nhập về cũng chỉ là bản quan sát.
CREATE FUNCTION guard_external_order_local_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_integration_status text;
  v_integration_authority text;
  v_integration_generation bigint;
  v_integration_branch text;
BEGIN
  IF current_user IN ('app_integration','app_integration_guard') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  -- Nghĩa vụ ẩn danh PII vẫn áp cho bản chiếu POS. Chỉ mở đúng các cột scrub + customer_id
  -- về NULL; app_expiry không được nhân ngoại lệ này để gán lại một customer bất kỳ hoặc
  -- đổi trạng thái, tiền, nguồn hay định danh connector.
  IF TG_OP = 'UPDATE' AND current_user = 'app_expiry'
     AND (to_jsonb(NEW) - ARRAY[
            'customer_name','customer_phone','customer_email','shipping_address',
            'client_ip_hash','anonymized_at','customer_id'
          ]::text[])
         = (to_jsonb(OLD) - ARRAY[
            'customer_name','customer_phone','customer_email','shipping_address',
            'client_ip_hash','anonymized_at','customer_id'
          ]::text[])
     AND NEW.customer_name = '(đã ẩn danh)'
     AND NEW.customer_phone IS NULL AND NEW.customer_email IS NULL
     AND NEW.shipping_address IS NULL AND NEW.client_ip_hash IS NULL
     AND NEW.anonymized_at IS NOT NULL
     AND NEW.customer_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- Checkout công khai chỉ được tạo hình dạng ĐƠN WEB BAN ĐẦU. Nếu để nó tự
  -- chèn source=kiotviet_pos/paid/delivered thì một request ngoài có thể giả
  -- doanh thu POS mà không qua webhook hay bằng chứng tiền.
  IF TG_OP = 'INSERT' AND current_user = 'app_checkout' THEN
    IF NEW.source IS DISTINCT FROM 'web'
       OR NEW.status IS DISTINCT FROM 'pending'
       OR NEW.payment_status IS DISTINCT FROM 'unpaid'
       OR NEW.external_ref IS NOT NULL
       OR NEW.paid_at IS NOT NULL
       OR NEW.amount_paid_vnd IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'PIO01',
        MESSAGE = 'Checkout chỉ được tạo đơn website pending, chưa thanh toán.';
    END IF;
    IF NEW.integration_id IS NULL THEN
      IF NEW.integration_generation IS NOT NULL OR NEW.external_branch_ref IS NOT NULL
         OR NEW.sync_status IS DISTINCT FROM 'not_required' THEN
        RAISE EXCEPTION USING ERRCODE = 'PIO01',
          MESSAGE = 'Đơn local phải chưa gắn connector POS.';
      END IF;
    ELSE
      SELECT status, inventory_authority, generation, external_branch_ref
        INTO v_integration_status, v_integration_authority,
             v_integration_generation, v_integration_branch
        FROM shop_integrations
       WHERE id = NEW.integration_id AND shop_id = NEW.shop_id;
      IF NOT FOUND OR v_integration_status <> 'active'
         OR v_integration_authority <> 'external_master'
         OR NEW.integration_generation IS DISTINCT FROM v_integration_generation
         OR NEW.external_branch_ref IS DISTINCT FROM v_integration_branch
         OR NEW.payment_method IS DISTINCT FROM 'cod'
         OR NEW.sync_status IS DISTINCT FROM 'pending' THEN
        RAISE EXCEPTION USING ERRCODE = 'PIO01',
          MESSAGE = 'Đơn website external-master phải là COD pending của connector đang active.';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (TG_OP = 'INSERT' AND (
        NEW.source IN ('kiotviet_pos','sapo_pos') OR NEW.integration_id IS NOT NULL
        OR NEW.external_ref IS NOT NULL OR NEW.integration_generation IS NOT NULL
      )) OR (TG_OP = 'DELETE' AND (
        OLD.source IN ('kiotviet_pos','sapo_pos') OR OLD.external_ref IS NOT NULL
      )) OR (TG_OP = 'UPDATE' AND (
        OLD.source IN ('kiotviet_pos','sapo_pos') OR OLD.external_ref IS NOT NULL
        OR NEW.source IS DISTINCT FROM OLD.source
        OR NEW.integration_id IS DISTINCT FROM OLD.integration_id
        OR NEW.integration_generation IS DISTINCT FROM OLD.integration_generation
        OR NEW.external_ref IS DISTINCT FROM OLD.external_ref
        OR NEW.external_branch_ref IS DISTINCT FROM OLD.external_branch_ref
      )) THEN
    RAISE EXCEPTION USING ERRCODE = 'PIO01',
      MESSAGE = 'Đơn đã thuộc POS ngoài; hãy thao tác tại POS và chờ đồng bộ về nền tảng.';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
ALTER FUNCTION guard_external_order_local_update() OWNER TO app_owner;
REVOKE ALL ON FUNCTION guard_external_order_local_update() FROM PUBLIC;
CREATE TRIGGER external_order_local_update_guard
BEFORE INSERT OR UPDATE OR DELETE ON orders
FOR EACH ROW EXECUTE FUNCTION guard_external_order_local_update();

CREATE FUNCTION guard_external_order_lines_local_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_order_id uuid; v_external boolean;
BEGIN
  IF current_user IN ('app_integration','app_integration_guard') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  v_order_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.order_id ELSE NEW.order_id END;
  SELECT (o.source IN ('kiotviet_pos','sapo_pos')
          OR (o.integration_id IS NOT NULL AND o.external_ref IS NOT NULL))
    INTO v_external FROM orders o WHERE o.id = v_order_id;
  IF coalesce(v_external, false) THEN
    RAISE EXCEPTION USING ERRCODE = 'PIO01',
      MESSAGE = 'Dòng hàng đã thuộc đơn POS ngoài; không sửa riêng trên nền tảng.';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
ALTER FUNCTION guard_external_order_lines_local_write() OWNER TO app_owner;
REVOKE ALL ON FUNCTION guard_external_order_lines_local_write() FROM PUBLIC;
CREATE TRIGGER external_order_lines_local_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON order_lines
FOR EACH ROW EXECUTE FUNCTION guard_external_order_lines_local_write();

CREATE FUNCTION enforce_integration_generation_step()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_user = 'app_rw'
       AND (NEW.status IS DISTINCT FROM 'connecting'
         OR NEW.inventory_authority IS DISTINCT FROM 'local'
         OR NEW.generation IS DISTINCT FROM 0) THEN
      RAISE EXCEPTION 'connector mới phải bắt đầu connecting + local + generation=0'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.provider IS DISTINCT FROM OLD.provider THEN
    RAISE EXCEPTION 'provider của connector là bất biến; tạo connector khác để đổi nhà cung cấp'
      USING ERRCODE = '23514';
  END IF;
  IF (
       NEW.credential_ciphertext IS DISTINCT FROM OLD.credential_ciphertext
       OR NEW.retailer IS DISTINCT FROM OLD.retailer
       OR NEW.external_branch_ref IS DISTINCT FROM OLD.external_branch_ref
       OR NEW.external_branch_name IS DISTINCT FROM OLD.external_branch_name
       OR NEW.webhook_public_id IS DISTINCT FROM OLD.webhook_public_id
       OR NEW.webhook_refs IS DISTINCT FROM OLD.webhook_refs
       OR NEW.webhook_registered_at IS DISTINCT FROM OLD.webhook_registered_at
     ) AND NEW.generation <> OLD.generation + 1 THEN
    RAISE EXCEPTION 'đổi credential, chi nhánh hoặc webhook phải tăng generation đúng một bước'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.generation <> OLD.generation AND NEW.generation <> OLD.generation + 1 THEN
    RAISE EXCEPTION 'generation connector phải tăng đúng một bước'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'disabled' AND OLD.status <> 'disabled'
     AND NEW.generation <> OLD.generation + 1 THEN
    RAISE EXCEPTION 'ngắt connector phải đổi generation'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'connecting' AND OLD.status IN ('active','degraded','disabled')
     AND NEW.generation <> OLD.generation + 1 THEN
    RAISE EXCEPTION 'kết nối lại phải đổi generation'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'disabled' AND NEW.status <> 'disabled'
     AND (NEW.status <> 'connecting' OR NEW.generation <> OLD.generation + 1) THEN
    RAISE EXCEPTION 'connector đã ngắt chỉ được quay lại qua bước connecting của generation mới'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.inventory_authority IS DISTINCT FROM OLD.inventory_authority THEN
    IF OLD.inventory_authority = 'local' AND NEW.inventory_authority = 'external_master' THEN
      IF current_user <> 'app_integration' OR OLD.status NOT IN ('connecting','degraded')
         OR NEW.status <> 'active'
         OR current_setting('app.integration_id', true) IS DISTINCT FROM NEW.id::text
         OR current_setting('app.integration_generation', true) IS DISTINCT FROM NEW.generation::text THEN
        RAISE EXCEPTION 'cutover tồn ngoài cần đúng worker connector, generation và kích hoạt nguyên tử'
          USING ERRCODE = '23514';
      END IF;
      IF EXISTS (
        SELECT 1 FROM orders o
         WHERE o.shop_id = NEW.shop_id AND o.integration_id IS NULL
           AND o.status IN ('pending','confirmed','shipped')
      ) THEN
        RAISE EXCEPTION 'còn đơn local chưa hoàn tất; phải xử lý hoặc hủy trước khi POS ngoài làm chủ tồn'
          USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.inventory_authority = 'external_master' AND NEW.inventory_authority = 'local' THEN
      IF current_user <> 'app_rw' OR OLD.status <> 'disabled' OR NEW.status <> 'disabled'
         OR NEW.generation <> OLD.generation + 1 THEN
        RAISE EXCEPTION 'chuyển tồn về local cần connector disabled và generation mới'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'chuyển authority tồn không hợp lệ' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION enforce_integration_generation_step() OWNER TO app_owner;
REVOKE ALL ON FUNCTION enforce_integration_generation_step() FROM PUBLIC;
CREATE TRIGGER integration_generation_step_guard
BEFORE INSERT OR UPDATE OF provider, generation, status, inventory_authority, credential_ciphertext, retailer,
  external_branch_ref, external_branch_name, webhook_public_id, webhook_refs,
  webhook_registered_at ON shop_integrations
FOR EACH ROW EXECUTE FUNCTION enforce_integration_generation_step();

CREATE FUNCTION supersede_integration_generation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.generation = OLD.generation THEN RETURN NEW; END IF;
  UPDATE integration_webhook_inbox
     SET status = 'superseded', payload = '{}'::jsonb, processed_at = now(),
         last_error = 'Cấu hình connector đã đổi generation.', updated_at = now()
   WHERE shop_id = NEW.shop_id AND integration_id = NEW.id
     AND generation <> NEW.generation AND status IN ('pending','processing','failed');
  UPDATE integration_entity_refs
     SET inventory_synced_at = NULL, inventory_generation = NULL, updated_at = now()
   WHERE shop_id = NEW.shop_id AND integration_id = NEW.id;
  UPDATE shop_integrations
     SET catalog_synced_at = NULL, inventory_synced_at = NULL,
         order_reconcile_cursor_at = NULL, invoice_reconcile_cursor_at = NULL,
         reconciled_at = NULL
   WHERE shop_id = NEW.shop_id AND id = NEW.id;
  UPDATE orders
     SET sync_status = 'needs_attention',
         sync_error = 'Kết nối POS đã đổi cấu hình; cần xác nhận trước khi gửi lại.',
         sync_updated_at = now()
   WHERE shop_id = NEW.shop_id AND integration_id = NEW.id
     AND integration_generation IS DISTINCT FROM NEW.generation AND sync_status = 'pending';
  RETURN NEW;
END;
$$;
ALTER FUNCTION supersede_integration_generation() OWNER TO app_owner;
REVOKE ALL ON FUNCTION supersede_integration_generation() FROM PUBLIC;
CREATE TRIGGER integration_generation_supersede
AFTER UPDATE OF generation ON shop_integrations
FOR EACH ROW EXECUTE FUNCTION supersede_integration_generation();

CREATE INDEX integration_webhook_generation_pending_idx
  ON integration_webhook_inbox (shop_id, integration_id, generation,
                                next_attempt_at NULLS FIRST, created_at)
  WHERE status IN ('pending','failed','processing');
CREATE INDEX integration_ref_variant_fresh_idx
  ON integration_entity_refs
     (shop_id, integration_id, local_id, inventory_generation, inventory_synced_at)
  WHERE entity_type = 'variant' AND mapping_status = 'mapped' AND local_id IS NOT NULL;
CREATE INDEX shop_integrations_reconcile_due_v2
  ON shop_integrations (reconciled_at NULLS FIRST, id)
  WHERE status IN ('connecting','active','degraded')
    AND credential_ciphertext IS NOT NULL AND external_branch_ref IS NOT NULL;

-- Freshness là bằng chứng của provider, không phải một cột trạng thái để vai admin tự
-- điền. app_rw chỉ được xoá trọn cặp stamp khi mapping đổi/đơn đã nhả reservation;
-- chỉ app_integration, sau khi khóa đúng generation, mới được đóng dấu tươi.
CREATE FUNCTION guard_integration_inventory_stamp()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_ctx_integration uuid;
  v_ctx_generation bigint;
BEGIN
  IF NEW.inventory_synced_at IS NULL AND NEW.inventory_generation IS NULL THEN
    IF current_user IN ('app_rw', 'app_integration', 'app_integration_guard') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'chỉ vai connector hoặc admin mới được xóa cặp bằng chứng tồn'
      USING ERRCODE = 'PIV01';
  END IF;
  IF NEW.inventory_synced_at IS NULL OR NEW.inventory_generation IS NULL THEN
    RAISE EXCEPTION 'bằng chứng tồn phải có đủ timestamp và generation'
      USING ERRCODE = 'PIV01';
  END IF;
  IF current_user <> 'app_integration' THEN
    RAISE EXCEPTION 'chỉ worker connector mới được tạo hoặc làm mới bằng chứng tồn'
      USING ERRCODE = 'PIV01';
  END IF;
  BEGIN
    v_ctx_integration := nullif(current_setting('app.integration_id', true), '')::uuid;
    v_ctx_generation := nullif(current_setting('app.integration_generation', true), '')::bigint;
  EXCEPTION WHEN invalid_text_representation THEN
    v_ctx_integration := NULL; v_ctx_generation := NULL;
  END;
  IF NEW.entity_type <> 'variant' OR NEW.mapping_status <> 'mapped' OR NEW.local_id IS NULL
     OR v_ctx_integration IS DISTINCT FROM NEW.integration_id
     OR v_ctx_generation IS DISTINCT FROM NEW.inventory_generation THEN
    RAISE EXCEPTION 'bằng chứng tồn phải thuộc variant mapped của đúng connector và generation'
      USING ERRCODE = 'PIV01';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION guard_integration_inventory_stamp() OWNER TO app_owner;
REVOKE ALL ON FUNCTION guard_integration_inventory_stamp() FROM PUBLIC;
CREATE TRIGGER integration_inventory_stamp_guard
BEFORE INSERT OR UPDATE OF inventory_synced_at, inventory_generation ON integration_entity_refs
FOR EACH ROW EXECUTE FUNCTION guard_integration_inventory_stamp();

-- app_integration cần có thể dọn mapping nguồn khi provider xóa sản phẩm; không cấp
-- UPDATE/DELETE cho checkout hay các vai public.
GRANT DELETE ON product_source_refs TO app_integration;

-- Sweep PII cross-shop phải tách customer_id khỏi đơn trước khi ẩn danh customer. Nếu
-- không, FK giữ lại đường JOIN tới tên/SĐT sau khi order đã bị scrub.
GRANT SELECT (customer_id) ON orders TO app_expiry;
GRANT UPDATE (customer_id) ON orders TO app_expiry;
GRANT SELECT (shop_id, entity_type, local_id) ON integration_entity_refs TO app_expiry;
GRANT DELETE ON integration_entity_refs TO app_expiry;
CREATE POLICY expiry_customer_ref_delete ON integration_entity_refs
  FOR DELETE TO app_expiry
  USING (
    entity_type = 'customer' AND local_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM customers c
       WHERE c.id = integration_entity_refs.local_id
         AND c.shop_id = integration_entity_refs.shop_id
         AND c.status = 'anonymized' AND c.anonymized_at IS NOT NULL
    )
  );

-- Invoice KiotViet hoàn tất có thể chốt tiền cho đơn website. Đây là các cột duy nhất
-- worker được phép cập nhật; status giao hàng vẫn thuộc luồng fulfilment riêng.
GRANT UPDATE (payment_status, amount_paid_vnd, paid_at) ON orders TO app_integration;

-- Promotion online chỉ được áp khi pilot đã xác minh provider giữ nguyên giá từng dòng và
-- capability được bật có chủ ý. Hàm boolean không lộ cấu hình connector cho storefront.
CREATE FUNCTION external_master_allows_online_promotions()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM shop_integrations i
     WHERE i.shop_id = current_shop_id()
       AND i.inventory_authority = 'external_master'
       AND coalesce(i.capabilities->'preserve_line_price', 'false'::jsonb) <> 'true'::jsonb
  )
$$;
ALTER FUNCTION external_master_allows_online_promotions() OWNER TO app_owner;
REVOKE ALL ON FUNCTION external_master_allows_online_promotions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION external_master_allows_online_promotions()
  TO app_store, app_checkout, app_customer, app_customer_wishlist, app_rw;

-- PostgreSQL đòi quyền UPDATE khi SELECT ... FOR SHARE. Không cấp quyền ghi giả cho
-- app_checkout chỉ để giữ khoá: hàm hẹp này mượn vai guard, trả đúng bảy cột checkout cần
-- và giữ khoá chia sẻ tới cuối transaction để cutover/disable không đổi lifecycle giữa chừng.
CREATE FUNCTION lock_checkout_integration()
RETURNS TABLE (
  id uuid,
  provider text,
  status text,
  inventory_authority text,
  external_branch_ref text,
  generation bigint,
  capabilities jsonb
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT i.id, i.provider, i.status, i.inventory_authority,
         i.external_branch_ref, i.generation, i.capabilities
    FROM shop_integrations i
   WHERE i.shop_id = current_shop_id()
     AND (i.inventory_authority = 'external_master'
       OR (i.external_branch_ref IS NOT NULL AND i.status IN ('connecting','degraded')))
   ORDER BY (i.inventory_authority = 'external_master') DESC, i.id
   LIMIT 1
   FOR SHARE
$$;
ALTER FUNCTION lock_checkout_integration() OWNER TO app_owner;
REVOKE ALL ON FUNCTION lock_checkout_integration() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_checkout_integration() TO app_checkout;

CREATE OR REPLACE FUNCTION promo_effective(p_product_id uuid, p_base_price bigint, p_at timestamptz)
RETURNS TABLE (price_vnd bigint, promotion_id uuid, off_pct int)
LANGUAGE sql STABLE AS $func$
  SELECT p_base_price - discount, pid,
         round(discount * 100.0 / NULLIF(p_base_price, 0))::int
  FROM (
    SELECT pr.id AS pid,
           LEAST(p_base_price,
                 CASE pr.kind WHEN 'percent' THEN (p_base_price * pr.value) / 100
                              ELSE pr.value END) AS discount
      FROM promotions pr
     WHERE external_master_allows_online_promotions()
       AND pr.shop_id = current_shop_id()
       AND pr.active
       AND pr.starts_at <= p_at AND p_at < pr.ends_at
       AND (pr.scope = 'all'
            OR EXISTS (SELECT 1 FROM promotion_products pp
                        WHERE pp.promotion_id = pr.id AND pp.product_id = p_product_id))
  ) cand
  WHERE discount > 0
  ORDER BY discount DESC, pid
  LIMIT 1;
$func$;

-- Degraded external-master phải tự hồi phục sau lỗi provider thoáng qua. Generation đi cùng
-- claim để worker không chạy một job thuộc vòng đời credential/webhook cũ.
DROP FUNCTION list_due_integrations(int);
CREATE FUNCTION list_due_integrations(p_limit int DEFAULT 100)
RETURNS TABLE (shop_id uuid, integration_id uuid, generation bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT i.shop_id, i.id, i.generation
    FROM shop_integrations i
   WHERE i.status IN ('connecting','active','degraded')
     AND i.credential_ciphertext IS NOT NULL AND i.external_branch_ref IS NOT NULL
     AND coalesce(i.reconciled_at, '-infinity'::timestamptz) < now() - interval '5 minutes'
   ORDER BY i.reconciled_at NULLS FIRST, i.id
   LIMIT least(greatest(coalesce(p_limit, 100), 1), 500)
$$;
ALTER FUNCTION list_due_integrations(int) OWNER TO app_owner;
REVOKE ALL ON FUNCTION list_due_integrations(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_due_integrations(int) TO app_integration;

DROP FUNCTION list_due_integration_webhooks(int);
CREATE FUNCTION list_due_integration_webhooks(p_limit int DEFAULT 100)
RETURNS TABLE (shop_id uuid, inbox_id uuid, generation bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT w.shop_id, w.id, w.generation
    FROM integration_webhook_inbox w
    JOIN shop_integrations i
      ON i.shop_id = w.shop_id AND i.id = w.integration_id
   WHERE i.status IN ('active','degraded')
     AND w.generation = i.generation
     AND (
       w.status = 'pending'
       OR (w.status = 'failed' AND coalesce(w.next_attempt_at, '-infinity'::timestamptz) <= now())
       OR (w.status = 'processing' AND coalesce(w.claimed_at, '-infinity'::timestamptz) < now() - interval '10 minutes')
     )
   ORDER BY coalesce(w.next_attempt_at, w.created_at), w.id
   LIMIT least(greatest(coalesce(p_limit, 100), 1), 500)
$$;
ALTER FUNCTION list_due_integration_webhooks(int) OWNER TO app_owner;
REVOKE ALL ON FUNCTION list_due_integration_webhooks(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_due_integration_webhooks(int) TO app_integration;

COMMENT ON COLUMN shop_integrations.generation IS
  'CAS vòng đời connector; mọi job/provider call phải khớp generation hiện hành.';
COMMENT ON COLUMN integration_entity_refs.inventory_synced_at IS
  'Bằng chứng tồn của riêng biến thể đã được đọc từ provider; không thay bằng timestamp webhook toàn shop.';
COMMENT ON COLUMN integration_entity_refs.inventory_generation IS
  'Generation credential/branch đã tạo bằng chứng tồn; stamp cũ không được checkout tin sau reconnect.';
COMMENT ON COLUMN shop_integrations.order_reconcile_cursor_at IS
  'High-water mark chỉ tăng sau khi quét order exhaustive thành công.';
COMMENT ON COLUMN shop_integrations.invoice_reconcile_cursor_at IS
  'High-water mark chỉ tăng sau khi quét invoice exhaustive thành công.';

-- Public webhook resolver phải đóng dấu generation ngay lúc nhận. Event của URL/secret cũ
-- không được sống lại sau một lần rotate hoặc reconnect.
DROP FUNCTION resolve_integration_webhook(uuid);
CREATE FUNCTION resolve_integration_webhook(p_public_id uuid)
RETURNS TABLE (
  integration_id uuid,
  shop_id uuid,
  provider text,
  credential_ciphertext text,
  generation bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT i.id, i.shop_id, i.provider, i.credential_ciphertext, i.generation
    FROM shop_integrations i
   WHERE i.webhook_public_id = p_public_id
     AND i.status IN ('active','degraded')
     AND i.credential_ciphertext IS NOT NULL
$$;
ALTER FUNCTION resolve_integration_webhook(uuid) OWNER TO app_owner;
REVOKE ALL ON FUNCTION resolve_integration_webhook(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_integration_webhook(uuid) TO app_integration;

-- Chuyển owner SAU khi đã dựng đủ hàm; membership chỉ tồn tại trong migration. SQL trong mỗi
-- hàm vẫn tự neo shop/id/generation, còn role NOLOGIN là lớp cho phép đi xuyên FORCE RLS.
GRANT app_integration_guard TO app_owner;
ALTER FUNCTION supersede_integration_generation() OWNER TO app_integration_guard;
ALTER FUNCTION external_master_allows_online_promotions() OWNER TO app_integration_guard;
ALTER FUNCTION lock_checkout_integration() OWNER TO app_integration_guard;
ALTER FUNCTION list_due_integrations(int) OWNER TO app_integration_guard;
ALTER FUNCTION list_due_integration_webhooks(int) OWNER TO app_integration_guard;
ALTER FUNCTION resolve_integration_webhook(uuid) OWNER TO app_integration_guard;
REVOKE app_integration_guard FROM app_owner;
