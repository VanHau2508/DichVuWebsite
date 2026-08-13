-- Durable per-channel delivery state for side effects without provider idempotency.
--
-- Messenger must claim an outbox event BEFORE calling Meta. A row left in `claimed`
-- is intentionally ambiguous: the process may have crashed before or after Meta accepted
-- the request. The worker never auto-sends that event again; operations must verify it and
-- either mark it sent or delete the claim before retrying the dead-letter job.

CREATE TABLE outbox_channel_deliveries (
  outbox_id  bigint NOT NULL REFERENCES outbox(id) ON DELETE CASCADE,
  channel    text NOT NULL,
  state      text NOT NULL DEFAULT 'claimed' CHECK (state IN ('claimed', 'sent', 'skipped')),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz,
  PRIMARY KEY (outbox_id, channel),
  CONSTRAINT outbox_channel_delivery_state_chk CHECK (
    (state = 'claimed' AND sent_at IS NULL)
    OR (state = 'sent' AND sent_at IS NOT NULL)
    OR (state = 'skipped' AND sent_at IS NULL)
  )
);

CREATE INDEX outbox_channel_delivery_ambiguous_idx
  ON outbox_channel_deliveries (claimed_at, outbox_id)
  WHERE state = 'claimed';

ALTER TABLE outbox_channel_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_channel_deliveries FORCE ROW LEVEL SECURITY;

-- 0003 grants CRUD on every future app_owner table to app_rw. This state is global
-- worker bookkeeping, not tenant data, so revoke that default grant explicitly.
REVOKE ALL ON outbox_channel_deliveries FROM app_rw;
REVOKE ALL ON outbox_channel_deliveries FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON outbox_channel_deliveries TO app_worker;
CREATE POLICY worker_channel_delivery ON outbox_channel_deliveries FOR ALL TO app_worker
  USING (true) WITH CHECK (true);

COMMENT ON TABLE outbox_channel_deliveries IS
  'Durable at-most-once claims for external notification channels keyed by outbox event.';
COMMENT ON COLUMN outbox_channel_deliveries.state IS
  'claimed without sent_at is ambiguous and must never be retried automatically.';
