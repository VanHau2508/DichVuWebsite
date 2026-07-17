-- 0056 — vá "trial không bao giờ hết hạn".
--
-- Bối cảnh: mọi subscription 'trial' cũ được tạo với current_period_end = NULL
-- (createShop trước đây chỉ ghi shop_id/plan_code/status). Worker sweepSubscriptions
-- lọc `current_period_end IS NOT NULL` nên BỎ QUA vĩnh viễn các hàng này → shop
-- miễn phí mãi mãi. Từ nay createShop đặt current_period_end = now() + TRIAL_DAYS
-- lúc tạo; migration này BACKFILL các hàng cũ còn NULL.
--
-- Chọn now() + 14 ngày (KHÔNG phải started_at + 14) để shop pilot đang chạy được
-- một cửa sổ trial MỚI kể từ lúc deploy — tránh bị đình chỉ đột ngột ngay nhịp
-- sweep kế tiếp. Con số 14 khớp mặc định TRIAL_DAYS trong app — đổi thì đổi cả hai.
--
-- Chỉ chạm status='trial' còn NULL: active/past_due/cancelled đã có mốc kỳ do
-- renewSubscription luôn ghi current_period_end. Idempotent (điều kiện IS NULL);
-- migrate.js forward-only chỉ chạy một lần.
UPDATE subscriptions
   SET current_period_end = now() + interval '14 days'
 WHERE status = 'trial'
   AND current_period_end IS NULL;
