-- 0053 — vá 0052: worker claim `WHERE low_stock_alerted_on IS NULL OR ...` cần SELECT cột
-- này (0050 chỉ cấp id/name/status/contact_email/low_stock_threshold). Thiếu → "permission
-- denied for table shops".
GRANT SELECT (low_stock_alerted_on) ON shops TO app_expiry;
