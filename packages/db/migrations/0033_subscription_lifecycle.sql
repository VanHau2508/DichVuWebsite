-- 0033 — vòng đời thuê bao: role app_billing cho worker tự chuyển trạng thái sub.
--
-- Worker quét CROSS-SHOP: trial/active hết current_period_end → past_due; past_due quá ân hạn
-- → cancelled + treo shop (tái dùng chốt storefront status='suspended'). KHÔNG dùng app_rw
-- (tenant-scoped) hay app_worker (chỉ outbox). Role riêng CỰC HẸP: chỉ đọc/đổi STATUS của
-- subscriptions + shops (không đụng PII, tiền, plan, sản phẩm, đơn). Không gửi email dunning
-- (tránh cấp quyền đọc email owner — Console đã hiện sub_status cho staff đòi nợ theo concierge).

CREATE ROLE app_billing LOGIN PASSWORD 'devpassword'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE app TO app_billing;
GRANT USAGE   ON SCHEMA public TO app_billing;

-- Quyền theo CỘT: chỉ trạng thái (+ mốc kỳ để so). Không plan/tiền/PII.
GRANT SELECT (id, shop_id, status, current_period_end), UPDATE (status) ON subscriptions TO app_billing;
GRANT SELECT (id, status),                              UPDATE (status) ON shops         TO app_billing;

-- Job nền hệ thống (không theo tenant) → policy cross-shop. RLS vẫn FORCE; quyền cột ở trên
-- mới giới hạn thực sự (chỉ status).
CREATE POLICY billing_subs  ON subscriptions FOR ALL TO app_billing USING (true) WITH CHECK (true);
CREATE POLICY billing_shops ON shops         FOR ALL TO app_billing USING (true) WITH CHECK (true);
