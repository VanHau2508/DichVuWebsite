-- Keep the durable delivery ledger inside the same composite-FK tenant boundary as
-- every other table that references tenant-owned data.
--
-- outbox.id is globally unique, but the repository invariant deliberately requires
-- shop_id on both sides of every FK to a table that carries shop_id. That second key is
-- defense in depth if an id is ever copied or a future schema stops using a global id.

ALTER TABLE outbox
  ADD CONSTRAINT outbox_shop_id_id_uniq UNIQUE (shop_id, id);

ALTER TABLE outbox_channel_deliveries ADD COLUMN shop_id uuid;

UPDATE outbox_channel_deliveries d
   SET shop_id = o.shop_id
  FROM outbox o
 WHERE o.id = d.outbox_id;

ALTER TABLE outbox_channel_deliveries ALTER COLUMN shop_id SET NOT NULL;

ALTER TABLE outbox_channel_deliveries
  DROP CONSTRAINT outbox_channel_deliveries_outbox_id_fkey;
ALTER TABLE outbox_channel_deliveries
  ADD CONSTRAINT outbox_channel_deliveries_outbox_fk
  FOREIGN KEY (shop_id, outbox_id) REFERENCES outbox (shop_id, id) ON DELETE CASCADE;

-- Tables with shop_id must have an explicit app_rw policy even when the role has no
-- grants. Keep the policy deny-only so default privileges can never reopen this ledger.
CREATE POLICY rw_no_access ON outbox_channel_deliveries FOR ALL TO app_rw
  USING (false) WITH CHECK (false);

COMMENT ON TABLE outbox_channel_deliveries IS
  'Tenant-keyed durable at-most-once claims for external notification channels.';
