-- 0091 — SELF-SERVE SIGNUP + TỰ ĐỘNG CẤP PHÁT SHOP (signup-1: nền DB).
--
-- Người dùng TỰ đăng ký công khai (không cần platform_staff gọi POST /ops/shops). Service MỚI
-- apps/signup (SSR no-JS, mẫu apps/account) chạy vai trò MỚI app_signup (least-priv). Luồng:
--   POST /signup  → CHỈ ghi 1 bản NHÁP shop_signups(status='pending') + token_hash + outbox verify
--                   (shop_id NULL). KHÔNG tạo user/shop/subscription THẬT → bot spam KHÔNG đẻ shop.
--   POST /verify  → 1 TRANSACTION nguyên tử: claim nháp + mint/claim user (khuôn acceptInvitation
--                   3-nhánh 0020) + provisionShop (shop+domain+subscription+audit) + membership owner.
--
-- MUST-FIX red-team GẮN vào migration này:
--  • Blast-radius vai công khai: app_signup CHỈ 8 bảng cần, KHÔNG orders/products/customers/payments;
--    users column-scope (KHÔNG đọc được password_hash — chỉ id/email/verified để rẽ nhánh); sessions
--    column-scope (KHÔNG đọc token_hash). statement/lock_timeout như app_customer.
--  • Membership hijack: policy memberships CHECK(role='owner') → app_signup KHÔNG tạo admin/…; shop_id
--    lấy từ RETURNING (server-derived) chứ không từ body (siết ở signup-4).
--  • Audit self-lock (bẫy 0073 grant-thiếu-policy = INSERT câm): policy signup_audit + GRANT seq.
--  • Nguỵ tạo audit shop khác: CHECK(actor_type='system') → KHÔNG mượn danh platform_staff.
--  • Outbox verify TRƯỚC khi có shop: CHECK(shop_id IS NULL) (mẫu auth_outbox 0058) + GRANT seq (bẫy 0084).
--  • Đua slug xuyên draft: UNIQUE partial index shop_signups(lower(slug)) WHERE pending = chốt DB cuối
--    cho advisory-lock (signup-3/4). Denylist slug áp app-layer (không ở DB).
--  • Trial free vĩnh viễn (tái lỗi 0056): CHECK subscriptions trial phải có current_period_end (NOT VALID
--    → chỉ chặn ghi MỚI, không quét legacy — provisionShop signup-2 luôn set now()+TRIAL_DAYS).

-- ══ (1) Vai trò đăng nhập SIGNUP (least-priv) — service apps/signup ══
CREATE ROLE app_signup LOGIN PASSWORD 'devpassword'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE app TO app_signup;
GRANT USAGE   ON SCHEMA public TO app_signup;
ALTER ROLE app_signup SET statement_timeout = '20s';
ALTER ROLE app_signup SET lock_timeout = '8s';
ALTER ROLE app_signup SET idle_in_transaction_session_timeout = '60s';

-- ══ (2) shop_signups — NHÁP đăng ký chưa-verify (user/shop THẬT chỉ sinh lúc provision) ══
-- KHÔNG shop_id (chưa có shop). password_hash băm Argon2 tại POST NGOÀI tx (tránh statement_timeout).
-- token thô CHỈ đi qua email; DB chỉ giữ sha256. expires_at ngắn (30') chống squat slug/subdomain.
CREATE TABLE shop_signups (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL,                     -- lowercased ở app; users.email UNIQUE toàn cục resolve lúc provision
  password_hash       text NOT NULL,                     -- Argon2id PHC (băm ngoài tx tại POST)
  slug                text NOT NULL,                     -- validate SLUG_RE + denylist ở app TRƯỚC INSERT
  name                text NOT NULL,
  plan_code           text NOT NULL REFERENCES plans (code),  -- FK: gói phải tồn tại (active check ở app)
  locale              text NOT NULL DEFAULT 'vi-VN',
  currency            text NOT NULL DEFAULT 'VND',
  timezone            text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  token_hash          text NOT NULL UNIQUE,              -- sha256(genToken); consume 1-lần atomic lúc provision
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','provisioned','expired')),
  ip_hash             text,                              -- HMAC(IP_PEPPER) — KHÔNG lưu IP thô (mẫu chống đơn-ảo)
  provisioned_shop_id uuid REFERENCES shops (id),        -- set lúc provision (idempotent/audit)
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL               -- now()+30' (TTL ngắn)
);
-- Reserve slug: TỐI ĐA 1 nháp pending / slug → chốt DB cho advisory-lock (2 người claim → 1 thắng).
CREATE UNIQUE INDEX shop_signups_slug_pending_uq ON shop_signups (lower(slug)) WHERE status = 'pending';
-- Worker sweep GC nháp treo (giải phóng slug đã reserve).
CREATE INDEX shop_signups_sweep_idx ON shop_signups (expires_at) WHERE status = 'pending';
ALTER TABLE shop_signups ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_signups FORCE  ROW LEVEL SECURITY;
-- shop_signups là bảng GLOBAL (không shop_id). ALTER DEFAULT PRIVILEGES (0003) tự cấp app_rw arwd
-- trên MỌI bảng tương lai → REVOKE tường minh (chống leo thang: role nghiệp vụ không đụng nháp đăng ký;
-- mẫu 0005 users/sessions). Chỉ app_signup chạm bảng này.
REVOKE ALL ON shop_signups FROM app_rw;

-- ══ (3) shops.created_via — cờ nguồn tạo shop (giám sát/analytics abuse self-serve) ══
ALTER TABLE shops ADD COLUMN created_via text NOT NULL DEFAULT 'staff'
  CHECK (created_via IN ('staff','self_serve'));

-- ══ (4) GRANT + POLICY — app_signup ══
-- Bảng CỦA MÌNH: toàn quyền (chỉ app_signup ghi; service luôn lọc theo token_hash).
GRANT SELECT, INSERT, UPDATE, DELETE ON shop_signups TO app_signup;
CREATE POLICY signup_own ON shop_signups FOR ALL TO app_signup USING (true) WITH CHECK (true);

-- users (KHÔNG RLS — định danh toàn cục; ranh giới = role có grant). COLUMN-SCOPE: app_signup
-- KHÔNG bao giờ đọc password_hash (chống rò băm MK của MỌI seller nếu service thủng). Đủ để rẽ
-- 3-nhánh acceptInvitation (email mới / chưa-verify claim / đã-verify → 403 login_required).
GRANT SELECT (id, email, email_verified_at, status, deleted_at) ON users TO app_signup;
GRANT INSERT (email, password_hash, email_verified_at)          ON users TO app_signup; -- (a) mint
GRANT UPDATE (password_hash, email_verified_at, mfa_enabled)    ON users TO app_signup; -- (b) claim nháp chưa-verify
-- users BẬT RLS FORCE (sau 0005) → app_signup CẦN policy mới ghi/đọc được. USING(true): resolve
-- email TOÀN CỤC (không có chiều shop) như auth_all; enum-safe cưỡng chế ở APP-layer (phản hồi trung tính).
CREATE POLICY signup_users_sel ON users FOR SELECT TO app_signup USING (true);
CREATE POLICY signup_users_ins ON users FOR INSERT TO app_signup WITH CHECK (true);
CREATE POLICY signup_users_upd ON users FOR UPDATE TO app_signup USING (true) WITH CHECK (true);
-- sessions (KHÔNG RLS): CHỈ để thu hồi phiên khi claim (b). COLUMN-SCOPE: KHÔNG đọc token_hash.
GRANT SELECT (user_id, revoked_at) ON sessions TO app_signup;
GRANT UPDATE (revoked_at)          ON sessions TO app_signup;

-- shops: SELECT (kiểm khả-dụng slug + RETURNING id) + INSERT (provision). current_shop_id() CHƯA
-- set lúc tạo shop mới → policy USING/CHECK(true) như platform_all (0006). COLUMN-SCOPE SELECT.
GRANT SELECT (id, slug, status) ON shops TO app_signup;
GRANT INSERT                    ON shops TO app_signup;
CREATE POLICY signup_shops_read ON shops FOR SELECT TO app_signup USING (true);
CREATE POLICY signup_shops_ins  ON shops FOR INSERT TO app_signup WITH CHECK (true);
-- domains: SELECT hostname (kiểm khả-dụng) + INSERT (subdomain nền tảng verified ngay).
GRANT SELECT (id, shop_id, hostname, verified_at) ON domains TO app_signup;
GRANT INSERT                                      ON domains TO app_signup;
CREATE POLICY signup_domains_read ON domains FOR SELECT TO app_signup USING (true);
CREATE POLICY signup_domains_ins  ON domains FOR INSERT TO app_signup WITH CHECK (true);
-- subscriptions: chỉ INSERT trial (provisionShop luôn set current_period_end).
GRANT INSERT ON subscriptions TO app_signup;
CREATE POLICY signup_subs_ins ON subscriptions FOR INSERT TO app_signup WITH CHECK (true);
-- memberships: chỉ INSERT + CHECK(role='owner') → self-serve KHÔNG tạo được admin/order_manager.
GRANT INSERT ON memberships TO app_signup;
CREATE POLICY signup_membership_ins ON memberships FOR INSERT TO app_signup WITH CHECK (role = 'owner');
-- plans: đọc để validate gói active (giống app_platform 0006).
GRANT SELECT ON plans TO app_signup;
-- audit_logs: ghi 'shop.created' actor_type='system' (KHÔNG mượn platform_staff). Bẫy 0073: cần CẢ grant seq.
GRANT INSERT ON audit_logs TO app_signup;
GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq TO app_signup;
CREATE POLICY signup_audit_ins ON audit_logs FOR INSERT TO app_signup WITH CHECK (actor_type = 'system');
-- outbox: email verify TRƯỚC khi có shop → CHECK(shop_id IS NULL) (mẫu auth_outbox 0058). Bẫy 0084: seq.
GRANT INSERT ON outbox TO app_signup;
GRANT USAGE, SELECT ON SEQUENCE outbox_id_seq TO app_signup;
CREATE POLICY signup_outbox_ins ON outbox FOR INSERT TO app_signup WITH CHECK (shop_id IS NULL);

-- ══ (5) Guard chống trial FREE vĩnh viễn (tái lỗi 0056) ══
-- Trial phải có current_period_end (worker mới hạ past_due được). NOT VALID: chặn MỌI ghi MỚI/UPDATE
-- (đúng mục tiêu — self-serve/admin không đẻ trial vô-hạn) mà KHÔNG quét legacy (an toàn migrate).
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_trial_needs_period_end
  CHECK (status <> 'trial' OR current_period_end IS NOT NULL) NOT VALID;
