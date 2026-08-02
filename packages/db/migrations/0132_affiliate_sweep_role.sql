-- 0132 — Vai worker `app_affiliate` để quét vòng đời hoa hồng (mirror app_loyalty 0086).
--
-- Sweep chạy CROSS-SHOP (không set current_shop_id) nên nó KHÔNG đi qua RLS per-tenant —
-- vì thế phải là vai RIÊNG, hẹp nhất có thể, chứ không mượn app_rw. app_rw mà chạy
-- cross-shop thì mọi lỗi ở worker thành lỗi rò dữ liệu giữa các shop.
--
-- Vai này ĐỌC orders (để biết đã giao/huỷ/hoàn) + shop_affiliate_config (hạn giữ), và
-- CHỈ ĐỔI TRẠNG THÁI hoa hồng. KHÔNG được INSERT hoa hồng (đó là việc của checkout, lúc
-- đặt đơn) và KHÔNG đụng phiếu chi (tiền do người bấm, không do máy quét).
CREATE ROLE app_affiliate LOGIN PASSWORD 'devpassword'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE app TO app_affiliate;
GRANT USAGE   ON SCHEMA public TO app_affiliate;
ALTER ROLE app_affiliate SET statement_timeout = '20s';
ALTER ROLE app_affiliate SET lock_timeout = '8s';
ALTER ROLE app_affiliate SET idle_in_transaction_session_timeout = '60s';

-- Chỉ SELECT trên nguồn sự thật, chỉ UPDATE trên bảng trạng thái.
GRANT SELECT ON orders, shop_affiliate_config, affiliates TO app_affiliate;
GRANT SELECT, UPDATE ON affiliate_commissions TO app_affiliate;

-- RLS: bảng có FORCE nên vai này cũng bị chặn nếu không có policy. Policy CROSS-SHOP
-- (true) là CỐ Ý và chỉ cấp cho đúng vai sweep — nó không có quyền ghi gì khác, và mọi
-- câu lệnh của nó đều tự lọc theo điều kiện nghiệp vụ chứ không theo tenant.
CREATE POLICY sweep_all ON affiliate_commissions FOR ALL TO app_affiliate USING (true) WITH CHECK (true);
CREATE POLICY sweep_all ON shop_affiliate_config FOR SELECT TO app_affiliate USING (true);
CREATE POLICY sweep_all ON affiliates FOR SELECT TO app_affiliate USING (true);
