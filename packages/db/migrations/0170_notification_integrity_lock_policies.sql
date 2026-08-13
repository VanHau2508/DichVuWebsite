-- 0170 - Let the notification-integrity role take row locks under FORCE RLS.
--
-- SELECT ... FOR KEY SHARE evaluates UPDATE policies as well as SELECT policies.
-- Without these policies, the security-definer trigger silently sees no parent row
-- and rejects every valid delivery reference. WITH CHECK false keeps real UPDATEs
-- impossible while allowing the trigger to lock the referenced row.

CREATE POLICY notification_integrity_outbox_lock ON outbox
  FOR UPDATE TO app_notification_integrity
  USING (true)
  WITH CHECK (false);

CREATE POLICY notification_integrity_delivery_lock ON notification_deliveries
  FOR UPDATE TO app_notification_integrity
  USING (true)
  WITH CHECK (false);
