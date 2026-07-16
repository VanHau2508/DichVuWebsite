-- 0045 — vá 0044: worker poll tracking ORDER BY shipments.synced_at nhưng grant theo-cột
-- cho app_expiry thiếu SELECT(synced_at) → "permission denied for table shipments".
GRANT SELECT (synced_at) ON shipments TO app_expiry;
