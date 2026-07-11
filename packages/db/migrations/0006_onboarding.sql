-- 0006 — onboarding shop: platform staff, gói dịch vụ, thuê bao, lời mời.
--
-- Vai trò mới: app_platform (dịch vụ vận hành nền tảng).
--
-- Nguyên tắc bảo mật cốt lõi của vai trò này (theo docs/03):
--   "Platform Admin KHÔNG mặc định xem dữ liệu khách mua của shop."
-- Vì vậy app_platform được cấp quyền trên bảng QUẢN LÝ (shops, domains,
-- subscriptions, invitations, plans, platform_staff, audit) nhưng TUYỆT ĐỐI
-- không có quyền nào trên bảng nghiệp vụ (products, orders, carts, order_lines...).
-- Kiểm chứng bằng test: app_platform không SELECT được orders.

-- ── Cấu hình shop ────────────────────────────────────────────────────────────
ALTER TABLE shops ADD COLUMN locale   text NOT NULL DEFAULT 'vi-VN';
ALTER TABLE shops ADD COLUMN currency text NOT NULL DEFAULT 'VND' CHECK (currency = upper(currency));
ALTER TABLE shops ADD COLUMN timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh';

-- ── platform_staff — nhân viên vận hành nền tảng (KHÁC memberships của shop) ──
CREATE TABLE platform_staff (
  user_id    uuid PRIMARY KEY REFERENCES users(id),
  role       text NOT NULL DEFAULT 'operator' CHECK (role IN ('operator','admin')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── plans — gói dịch vụ (dữ liệu tham chiếu, giống nhau mọi môi trường) ───────
CREATE TABLE plans (
  code            text PRIMARY KEY,
  name            text NOT NULL,
  price_vnd_month bigint NOT NULL CHECK (price_vnd_month >= 0),
  max_products    int NOT NULL CHECK (max_products > 0),
  active          boolean NOT NULL DEFAULT true
);

INSERT INTO plans (code, name, price_vnd_month, max_products) VALUES
  ('platform', 'Platform', 990000, 100),
  ('care',     'Care',     2490000, 100),
  ('growth',   'Growth',   5900000, 500);

-- ── subscriptions — thuê bao của shop (MVP ghi nhận thủ công) ────────────────
CREATE TABLE subscriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id            uuid NOT NULL REFERENCES shops(id),
  plan_code          text NOT NULL REFERENCES plans(code),
  status             text NOT NULL DEFAULT 'trial'
                     CHECK (status IN ('trial','active','past_due','cancelled')),
  started_at         timestamptz NOT NULL DEFAULT now(),
  current_period_end timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);
CREATE INDEX subscriptions_shop_idx ON subscriptions (shop_id);

-- ── invitations — mời người dùng vào shop với một vai trò; token dùng một lần ─
CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id),
  email       text NOT NULL CHECK (email = lower(email)),
  role        text NOT NULL CHECK (role IN ('owner','admin','catalog_manager','order_manager')),
  token_hash  text NOT NULL UNIQUE,
  invited_by  uuid REFERENCES users(id),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);
CREATE INDEX invitations_pending_email_idx ON invitations (email) WHERE accepted_at IS NULL;

-- ── RLS cho các bảng tenant mới ──────────────────────────────────────────────
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subscriptions FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invitations FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- ── Vai trò app_platform ─────────────────────────────────────────────────────
CREATE ROLE app_platform LOGIN PASSWORD 'devpassword'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE app TO app_platform;
GRANT USAGE   ON SCHEMA public TO app_platform;

-- Bảng quản lý: toàn quyền cần thiết.
GRANT SELECT, INSERT, UPDATE ON shops         TO app_platform;
GRANT SELECT, INSERT, UPDATE ON domains       TO app_platform;
GRANT SELECT                 ON plans         TO app_platform;
GRANT SELECT, INSERT, UPDATE ON subscriptions TO app_platform;
GRANT SELECT, INSERT, UPDATE ON invitations   TO app_platform;
GRANT SELECT                 ON platform_staff TO app_platform;
GRANT SELECT                 ON memberships   TO app_platform; -- liệt kê nhân sự
GRANT SELECT, INSERT         ON audit_logs    TO app_platform;
GRANT USAGE, SELECT          ON SEQUENCE audit_logs_id_seq TO app_platform;

-- app_platform thao tác XUYÊN shop (tạo/khoá shop) nên cần policy USING(true)
-- trên các bảng quản lý. An toàn vì đây KHÔNG phải dữ liệu khách mua, và ranh
-- giới là "role được cấp quyền" — app_platform không hề có quyền trên
-- products/orders/... nên không thể chạm dữ liệu nghiệp vụ dù muốn.
CREATE POLICY platform_all ON shops         FOR ALL TO app_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_all ON domains       FOR ALL TO app_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_all ON subscriptions FOR ALL TO app_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_all ON invitations   FOR ALL TO app_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_read  ON audit_logs  FOR SELECT TO app_platform USING (true);
CREATE POLICY platform_audit ON audit_logs  FOR INSERT TO app_platform WITH CHECK (actor_type = 'platform_staff');

-- ── Mở rộng app_auth cho luồng CHẤP NHẬN lời mời ─────────────────────────────
-- Auth service xác thực token lời mời → tạo user → tạo membership → đánh dấu accepted.
GRANT SELECT, UPDATE ON invitations TO app_auth;
GRANT INSERT         ON memberships TO app_auth;

-- app_auth đọc/cập nhật lời mời (chưa có shop context lúc chấp nhận) và tạo
-- membership owner. Ranh giới bảo mật ở code auth (khớp token → shop_id từ chính
-- lời mời). memberships đã có auth_lookup (SELECT) ở 0005; thêm INSERT ở đây.
CREATE POLICY auth_invite_read   ON invitations FOR SELECT TO app_auth USING (true);
CREATE POLICY auth_invite_accept ON invitations FOR UPDATE TO app_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_membership_write ON memberships FOR INSERT TO app_auth WITH CHECK (true);
