-- 0169 - Allow the tracking worker to record a carrier cancellation.
-- A carrier cancellation is an auditable exception; it must not mutate stock
-- or shipped quantities implicitly.

DROP POLICY order_events_expiry ON order_events;
CREATE POLICY order_events_expiry ON order_events
  FOR INSERT TO app_expiry
  WITH CHECK (
    source = 'worker'
    AND (
      (event_type IN ('order.cancelled', 'resolution.opened')
        AND actor_type = 'system' AND actor_id IS NULL)
      OR
      (event_type IN ('shipment.delivered', 'shipment.returned', 'shipment.cancelled')
        AND actor_type = 'carrier' AND actor_id IS NOT NULL)
    )
  );
