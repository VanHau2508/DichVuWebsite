-- 0181 — khóa claim catalog và bằng chứng gửi đơn KiotViet.
--
-- Hai lớp này không làm provider có idempotency. Chúng chỉ bảo đảm nền tảng không tự
-- biến một lần retry mơ hồ thành lần POST thứ hai, và không để hai external product
-- cùng cướp một variant local.

CREATE FUNCTION kiotviet_entity_claim_lock_key(
  p_integration_id uuid,
  p_entity_type text,
  p_local_id uuid
)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT hashtextextended(
    'kiotviet:entity-claim:' || p_integration_id::text || ':'
      || p_entity_type || ':' || p_local_id::text, 0
  )
$$;
REVOKE ALL ON FUNCTION kiotviet_entity_claim_lock_key(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kiotviet_entity_claim_lock_key(uuid, text, uuid)
  TO app_rw, app_integration;

CREATE TABLE integration_order_send_intents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL,
  integration_id    uuid NOT NULL,
  generation        bigint NOT NULL CHECK (generation >= 0),
  order_id          uuid NOT NULL,
  marker            text NOT NULL,
  request_hash      text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  state             text NOT NULL DEFAULT 'prepared'
                    CHECK (state IN ('prepared','attempted','sent','needs_attention')),
  attempt_started_at timestamptz,
  provider_external_id text,
  provider_code     text,
  lookup_state      text NOT NULL DEFAULT 'unknown'
                    CHECK (lookup_state IN ('unknown','found','proven_absent','inconclusive')),
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, integration_id, generation, order_id),
  UNIQUE (shop_id, integration_id, generation, marker),
  FOREIGN KEY (shop_id, integration_id) REFERENCES shop_integrations(shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  CHECK ((state = 'prepared' AND attempt_started_at IS NULL)
      OR state <> 'prepared'),
  CHECK ((state = 'sent' AND provider_external_id IS NOT NULL)
      OR state <> 'sent')
);

ALTER TABLE integration_order_send_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_order_send_intents FORCE ROW LEVEL SECURITY;

GRANT SELECT ON integration_order_send_intents TO app_rw;
REVOKE INSERT, UPDATE, DELETE ON integration_order_send_intents FROM app_rw;
CREATE POLICY send_intent_rw_select ON integration_order_send_intents
  FOR SELECT TO app_rw USING (shop_id = current_shop_id());

GRANT SELECT, INSERT, UPDATE ON integration_order_send_intents TO app_integration;
CREATE POLICY send_intent_integration ON integration_order_send_intents
  FOR ALL TO app_integration
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- Trigger functions that need an unrestricted cross-table read run as the existing
-- NOLOGIN guard role, not as the public checkout role.
GRANT SELECT ON integration_order_send_intents TO app_integration_guard;
CREATE POLICY send_intent_guard ON integration_order_send_intents
  FOR SELECT TO app_integration_guard USING (true);

-- F3: the inventory guard only needs to resolve the tenant of a matching integration.
-- Without this column grant app_checkout gets a raw 42501 instead of the contract PIV01.
GRANT SELECT (shop_id) ON shop_integrations TO app_checkout;

COMMENT ON TABLE integration_order_send_intents IS
  'Committed before network I/O; an attempted intent is never retried by blind POST.';
COMMENT ON FUNCTION kiotviet_entity_claim_lock_key(uuid, text, uuid) IS
  'Canonical advisory key shared by automatic catalog sync and manual mapping.';
