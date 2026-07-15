-- 0036 — vá đường tiền SePay per-shop sau rà soát đối kháng.
--   #2 idempotency theo SHOP (không phải toàn cục) — event-id trùng chéo shop KHÔNG nuốt tiền.
--   #1 webhook đọc được orders.status → KHÔNG "sống lại" đơn đã huỷ/hết hạn (chống oversell).
--   #5/#7/#8 siết least-privilege trên bảng tiền cho app_payment / app_rw.

-- #2: idempotency theo (shop_id, provider, event_id) — khớp trust boundary per-shop
-- (mỗi shop dùng tài khoản SePay riêng; id giao dịch có thể trùng chéo shop).
ALTER TABLE payment_transactions DROP CONSTRAINT payment_transactions_provider_provider_event_id_key;
ALTER TABLE payment_transactions ADD  CONSTRAINT payment_transactions_shop_provider_event_key UNIQUE (shop_id, provider, provider_event_id);

-- #1: webhook cần ĐỌC trạng thái đơn để không tự xác nhận lại đơn đã huỷ (tồn kho đã trả).
GRANT SELECT (status) ON orders TO app_payment;
-- Lý do mới: tiền vào đơn KHÔNG còn sống (đã huỷ/hết hạn) → hàng đợi đối soát (owner hoàn tiền).
ALTER TABLE unmatched_transfers DROP CONSTRAINT unmatched_transfers_reason_check;
ALTER TABLE unmatched_transfers ADD  CONSTRAINT unmatched_transfers_reason_check
  CHECK (reason IN ('no_ref','order_not_found','account_mismatch','order_not_live'));

-- #5: app_payment KHÔNG cần đọc số tài khoản mọi shop (webhook chỉ resolve theo token + đối
-- chiếu order.qr_account). Bỏ để tránh lộ tài khoản chi trả toàn nền tảng nếu role bị lộ.
REVOKE SELECT (account_number) ON shop_payment_config FROM app_payment;

-- #7: webhook chỉ INSERT hàng đợi (ON CONFLICT DO NOTHING) — không cần SELECT.
REVOKE SELECT ON unmatched_transfers FROM app_payment;

-- #8: seller chỉ được đánh dấu ĐÃ XỬ LÝ, không được sửa lại dữ kiện giao dịch đã ghi.
REVOKE UPDATE ON unmatched_transfers FROM app_rw;
GRANT  UPDATE (resolved_at, resolved_order_id) ON unmatched_transfers TO app_rw;
