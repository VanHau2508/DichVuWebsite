-- 0174 - Let the narrow resolution function price returned order lines.

GRANT SELECT ON order_lines TO app_resolution;

CREATE POLICY resolution_service_order_lines_read ON order_lines
  FOR SELECT TO app_resolution USING (shop_id = current_shop_id());

COMMENT ON POLICY resolution_service_order_lines_read ON order_lines IS
  'Required by set_order_partial_fulfillment_adjustment; tenant-bound through current_shop_id().';
