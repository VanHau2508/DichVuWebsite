-- 0005 — identity & auth.
--
-- Phân tách vai trò (nối tiếp mô hình app_rw / app_tls ở 0003):
--
--   app_auth  — dịch vụ auth. Đụng users/sessions/mfa/reset. app_rw KHÔNG đụng.
--
-- Vì sao tách app_auth khỏi app_rw:
--   users, sessions, mfa_totp, password_reset_tokens chứa password hash, secret
--   MFA, token phiên. Nếu app_rw (role của mọi request storefront/seller) đọc
--   được chúng, một lỗ hổng SQL ở bất kỳ đâu trong ứng dụng nghiệp vụ là lộ toàn
--   bộ thông tin xác thực. Chỉ dịch vụ auth mới chạm được các bảng này.
--
-- Bảng identity KHÔNG có shop_id: người dùng là toàn cục (một email có thể là
-- Owner shop A và Order Manager shop B). Chúng không cần RLS; ranh giới bảo mật
-- là "role nào được cấp quyền", giống app_tls với domains.
-- Chỉ `memberships` có shop_id → là bảng tenant, có RLS.

CREATE ROLE app_auth LOGIN PASSWORD 'devpassword'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE app TO app_auth;
GRANT USAGE   ON SCHEMA public TO app_auth;

-- ── users ────────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash text NOT NULL,           -- Argon2id PHC string
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  mfa_enabled   boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

-- ── MFA TOTP ─────────────────────────────────────────────────────────────────
-- Bảng riêng: secret không bị nạp kèm mỗi lần đọc user.
-- secret_enc là base32 secret ĐÃ MÃ HOÁ (AES-256-GCM) bằng khoá ứng dụng.
-- Lưu plaintext ở đây = rò DB thì bypass được MFA của mọi người.
CREATE TABLE mfa_totp (
  user_id       uuid PRIMARY KEY REFERENCES users(id),
  secret_enc    text NOT NULL,
  confirmed_at  timestamptz,             -- NULL cho tới lần verify thành công đầu tiên
  last_counter  bigint,                  -- bước thời gian đã dùng gần nhất — chống replay
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Mã khôi phục MFA — lưu HASH (sha256), dùng một lần.
CREATE TABLE mfa_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mfa_recovery_user_idx ON mfa_recovery_codes (user_id);

-- ── sessions ─────────────────────────────────────────────────────────────────
-- Nguồn sự thật là Postgres. Token lưu HASH (sha256), không bao giờ lưu token thô:
-- rò DB thì không mạo danh phiên được.
-- mfa_satisfied: phiên đã qua bước MFA chưa (khác với "user có bật MFA").
CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  token_hash    text NOT NULL UNIQUE,
  mfa_satisfied boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  ip            inet,
  user_agent    text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

-- ── password reset ───────────────────────────────────────────────────────────
-- Token lưu hash, dùng một lần (used_at), hết hạn ngắn.
CREATE TABLE password_reset_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── memberships — bảng TENANT (có shop_id) ──────────────────────────────────
CREATE TABLE memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    uuid NOT NULL REFERENCES shops(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  role       text NOT NULL CHECK (role IN ('owner','admin','catalog_manager','order_manager')),
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (shop_id, user_id),   -- một người, một vai trò trong một shop
  UNIQUE (shop_id, id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

-- ── Quyền ────────────────────────────────────────────────────────────────────

-- app_auth: toàn quyền trên identity tables (nhưng vẫn không được xoá session
-- vĩnh viễn của người khác một cách tuỳ tiện — DELETE cho phép dọn phiên hết hạn).
GRANT SELECT, INSERT, UPDATE         ON users                 TO app_auth;
GRANT SELECT, INSERT, UPDATE         ON mfa_totp              TO app_auth;
GRANT SELECT, INSERT, UPDATE         ON mfa_recovery_codes    TO app_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions              TO app_auth;
GRANT SELECT, INSERT, UPDATE         ON password_reset_tokens TO app_auth;
GRANT SELECT                         ON memberships           TO app_auth;
GRANT SELECT                         ON shops                 TO app_auth;

-- app_rw: identity tables NGOÀI TẦM VỚI.
-- ALTER DEFAULT PRIVILEGES ở 0003 đã tự cấp app_rw quyền trên MỌI bảng tương lai
-- do app_owner tạo — kể cả các bảng nhạy cảm này. Thu hồi tường minh.
REVOKE ALL ON users                 FROM app_rw;
REVOKE ALL ON mfa_totp              FROM app_rw;
REVOKE ALL ON mfa_recovery_codes    FROM app_rw;
REVOKE ALL ON sessions              FROM app_rw;
REVOKE ALL ON password_reset_tokens FROM app_rw;

-- Nhưng app_rw QUẢN LÝ nhân sự (memberships) trong phạm vi shop của mình.
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships TO app_rw;

-- ── RLS cho memberships ──────────────────────────────────────────────────────
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON memberships FOR ALL TO app_rw
  USING      (shop_id = current_shop_id())
  WITH CHECK (shop_id = current_shop_id());

-- app_auth đọc memberships XUYÊN shop tại thời điểm đăng nhập: lúc đó chưa có
-- shop context (chưa biết user chọn shop nào). Ranh giới bảo mật nằm ở code
-- dịch vụ auth (luôn lọc WHERE user_id = <đã xác thực>), giống app_tls với domains.
CREATE POLICY auth_lookup ON memberships FOR SELECT TO app_auth USING (true);

-- ── Audit cấp identity ───────────────────────────────────────────────────────
-- Đăng nhập, thất bại đăng nhập, đổi mật khẩu, bật MFA... là sự kiện cấp nền
-- tảng (shop_id NULL). app_auth chỉ được ghi audit KHÔNG gắn shop — không thể
-- nguỵ tạo audit cho một shop cụ thể.
GRANT INSERT ON audit_logs TO app_auth;
GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq TO app_auth;
CREATE POLICY auth_audit ON audit_logs FOR INSERT TO app_auth WITH CHECK (shop_id IS NULL);
