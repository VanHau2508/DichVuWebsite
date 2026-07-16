-- 0054 — Cảnh báo ĐƯỜNG TIỀN: worker (pool app_expiry) đọc COUNT giao dịch CHƯA KHỚP
-- (tiền về tài khoản shop nhưng webhook không map được vào đơn) để cảnh báo ops. Chỉ SELECT,
-- xuyên shop (job hệ thống), không PII nặng.

GRANT SELECT (id, shop_id, amount_vnd, reason, resolved_at, created_at) ON unmatched_transfers TO app_expiry;
CREATE POLICY expiry_unmatched ON unmatched_transfers FOR SELECT TO app_expiry USING (true);
