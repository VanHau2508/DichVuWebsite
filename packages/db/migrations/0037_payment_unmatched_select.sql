-- 0037 — đảo lại tinh chỉnh 0036 (#7): app_payment CẦN lại SELECT trên unmatched_transfers.
-- Lý do: persistUnmatched dùng `INSERT ... ON CONFLICT (...) DO NOTHING`; dưới RLS FORCE,
-- Postgres cần quyền SELECT để đánh giá xung đột (nếu không → "permission denied for table").
-- Quyền vẫn bị RLS giới hạn về current_shop_id() (policy payment_unmatched), nên không rộng.
GRANT SELECT ON unmatched_transfers TO app_payment;
