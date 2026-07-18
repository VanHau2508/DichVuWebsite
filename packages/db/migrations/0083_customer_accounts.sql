-- 0083 — TÀI KHOẢN KHÁCH HÀNG STOREFRONT v1 (per-shop, kiểu Shopify customer accounts).
--
-- Khách hàng là DỮ LIỆU TENANT: mọi bảng có shop_id, RLS FORCE + composite FK (0002/0004).
-- Cùng một email đăng ký ở shopA và shopB = HAI tài khoản độc lập (per-store). KHÁC HẲN
-- users/sessions của apps/auth (định danh TOÀN CỤC của NGƯỜI BÁN, không shop_id) — không
-- tái dùng bảng đó, chỉ mượn mã (packages/auth/{password,tokens,ratelimit}.js).
--
-- Vai trò mới app_customer host trong SERVICE MỚI apps/account (mount /account/* trên chính
-- host của shop qua Caddy). app_store GIỮ NGUYÊN CHỈ-ĐỌC; app_checkout chỉ SELECT theo-CỘT
-- (KHÔNG password_hash) để prefill + đóng dấu orders.customer_id.
--
-- ĐÃ ÁP 4 MUST-FIX từ red-team (kiểm chứng trực tiếp trên PG16):
--  #1 "nhận đơn cũ": SELECT policy gate bằng GUC app.claim_token_hash → CHỈ dòng đúng token
--     256-bit khách cầm mới hiện (không rò PII đơn vãng lai của người khác).
--  #2 customers/customer_sessions SELF-scoped sau xác thực (chống khách A ghi đè MK khách B).
--  #4 app_rw KHÔNG UPDATE password_hash (siết cột như 0075).

-- ══ (0) GUC danh tính khách + token nhận-đơn trong transaction (song song current_shop_id 0004) ══
-- Chưa set → NULL → so sánh customer_id = NULL cho NULL → 0 dòng (fail-closed, không rò chéo khách).
CREATE OR REPLACE FUNCTION current_customer_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.customer_id', true), '')::uuid $$;
-- Bằng chứng sở hữu đơn (sha256 lookup_token) — chỉ set trong transaction "nhận đơn cũ".
CREATE OR REPLACE FUNCTION current_claim_token_hash() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.claim_token_hash', true), '') $$;

-- ══ (1) Vai trò đăng nhập KHÁCH (least-priv) — service apps/account ══
CREATE ROLE app_customer LOGIN PASSWORD 'devpassword'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE app TO app_customer;
GRANT USAGE   ON SCHEMA public TO app_customer;
ALTER ROLE app_customer SET statement_timeout = '20s';
ALTER ROLE app_customer SET lock_timeout = '8s';
ALTER ROLE app_customer SET idle_in_transaction_session_timeout = '60s';

-- ══ (2) customers ══
-- email/password_hash/full_name/phone NULLABLE để ẩn danh-tại-chỗ xoá sạch (BVDLCN 91/2025).
CREATE TABLE customers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES shops (id),
  email             text,
  password_hash     text,
  full_name         text,
  phone             text,
  email_verified_at timestamptz,                      -- NULL = chưa xác minh (xác minh MỀM)
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','disabled','anonymized')),
  anonymized_at     timestamptz,
  last_login_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)                                 -- đích composite FK (quy ước 0002)
);
-- Email DUY NHẤT theo shop, không phân biệt hoa/thường; NULL (đã ẩn danh) loại → giải phóng
-- email đăng ký lại. Đăng ký bắt 23505 trên index này → trả phản hồi trung tính.
CREATE UNIQUE INDEX customers_shop_email_ci ON customers (shop_id, lower(email)) WHERE email IS NOT NULL;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE  ROW LEVEL SECURITY;

-- ══ (3) customer_sessions — lưu HASH token; token thô CHỈ trong cookie __Host-cust_session ══
CREATE TABLE customer_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL,
  customer_id  uuid NOT NULL,
  token_hash   text NOT NULL UNIQUE,                  -- sha256(token) — như sessions seller
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  ip           inet,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, customer_id) REFERENCES customers (shop_id, id) ON DELETE CASCADE
);
CREATE INDEX customer_sessions_cust_idx ON customer_sessions (shop_id, customer_id) WHERE revoked_at IS NULL;
ALTER TABLE customer_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_sessions FORCE  ROW LEVEL SECURITY;

-- ══ (4) customer_addresses — sổ điền nhanh khi checkout ══
CREATE TABLE customer_addresses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        uuid NOT NULL,
  customer_id    uuid NOT NULL,
  recipient_name text NOT NULL,
  phone          text NOT NULL,
  line1          text NOT NULL,
  ward           text, district text, province text,  -- province ∈ 34 tỉnh (validate app)
  is_default     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, customer_id) REFERENCES customers (shop_id, id) ON DELETE CASCADE
);
CREATE INDEX customer_addresses_owner_idx ON customer_addresses (shop_id, customer_id);
-- Tối đa MỘT địa chỉ mặc định / khách — cưỡng chế bằng CẤU TRÚC (không tin app).
CREATE UNIQUE INDEX customer_addresses_one_default ON customer_addresses (shop_id, customer_id) WHERE is_default;
ALTER TABLE customer_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_addresses FORCE  ROW LEVEL SECURITY;

-- ══ (5) Token đặt lại mật khẩu + xác minh email (chỉ HASH, dùng-một-lần) ══
CREATE TABLE customer_password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL, customer_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL, used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, customer_id) REFERENCES customers (shop_id, id) ON DELETE CASCADE
);
CREATE TABLE customer_email_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL, customer_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL, verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, customer_id) REFERENCES customers (shop_id, id) ON DELETE CASCADE
);
ALTER TABLE customer_password_reset_tokens ENABLE ROW LEVEL SECURITY; ALTER TABLE customer_password_reset_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE customer_email_verifications   ENABLE ROW LEVEL SECURITY; ALTER TABLE customer_email_verifications   FORCE ROW LEVEL SECURITY;

-- ══ (6) orders ← khách (NULL = đơn ẩn danh/vãng lai, tương thích ngược) ══
ALTER TABLE orders ADD COLUMN customer_id uuid;
ALTER TABLE orders ADD CONSTRAINT orders_customer_fk
  FOREIGN KEY (shop_id, customer_id) REFERENCES customers (shop_id, id) ON DELETE SET NULL (customer_id);
CREATE INDEX orders_customer_idx ON orders (shop_id, customer_id) WHERE customer_id IS NOT NULL;

-- ══ (7) POLICY + GRANT — app_customer (vai trò chính) ══
GRANT SELECT, INSERT, UPDATE, DELETE ON customers                      TO app_customer; -- auth role: CẦN đọc password_hash
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_sessions              TO app_customer;
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_addresses             TO app_customer;
GRANT SELECT, INSERT, UPDATE         ON customer_password_reset_tokens TO app_customer;
GRANT SELECT, INSERT, UPDATE         ON customer_email_verifications   TO app_customer;
GRANT SELECT                         ON orders                         TO app_customer; -- đơn CỦA MÌNH (RLS siết); full-col để policy claim tham chiếu lookup_token_hash
GRANT UPDATE (customer_id)           ON orders                         TO app_customer; -- CHỈ để "nhận đơn cũ" bằng lookup_token
GRANT SELECT (id, shop_id, order_id, variant_id, title_snapshot, sku_snapshot,
              unit_price_vnd, qty, shipped_qty, orig_unit_price_vnd, promotion_id)
                                     ON order_lines                    TO app_customer; -- LOẠI unit_cost_vnd (giá vốn 0081)
GRANT SELECT                         ON domains, shops                 TO app_customer; -- resolve host→shop + tên/brand
GRANT INSERT                         ON outbox                         TO app_customer; -- email verify/reset

CREATE POLICY customer_lookup ON domains FOR SELECT TO app_customer USING (true);       -- resolve trước context
CREATE POLICY customer_shop   ON shops   FOR SELECT TO app_customer
  USING (id = current_shop_id() AND deleted_at IS NULL AND status NOT IN ('terminated','suspended'));
-- #2 MUST-FIX: customers + sessions SELF-scoped SAU xác thực (pre-auth login: cid NULL → shop-scope
-- vẫn tra được email; post-auth: khách A KHÔNG ghi/đọc được của khách B cùng shop).
CREATE POLICY customer_self ON customers FOR ALL TO app_customer
  USING (shop_id = current_shop_id() AND (current_customer_id() IS NULL OR id = current_customer_id()))
  WITH CHECK (shop_id = current_shop_id() AND (current_customer_id() IS NULL OR id = current_customer_id()));
CREATE POLICY customer_sess ON customer_sessions FOR ALL TO app_customer
  USING (shop_id = current_shop_id() AND (current_customer_id() IS NULL OR customer_id = current_customer_id()))
  WITH CHECK (shop_id = current_shop_id() AND (current_customer_id() IS NULL OR customer_id = current_customer_id()));
CREATE POLICY customer_prt   ON customer_password_reset_tokens FOR ALL TO app_customer USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY customer_ev    ON customer_email_verifications   FOR ALL TO app_customer USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY customer_addr  ON customer_addresses             FOR ALL TO app_customer
  USING (shop_id = current_shop_id() AND customer_id = current_customer_id())
  WITH CHECK (shop_id = current_shop_id() AND customer_id = current_customer_id());
-- #1 MUST-FIX: lịch sử đơn = đơn CỦA MÌNH; HOẶC dòng đúng token khách đang "nhận" (GUC gate) →
-- chỉ 1 đơn có lookup_token_hash khớp token 256-bit mới hiện, KHÔNG rò PII đơn vãng lai khác.
CREATE POLICY customer_orders_read ON orders FOR SELECT TO app_customer
  USING (shop_id = current_shop_id()
         AND (customer_id = current_customer_id()
              OR (customer_id IS NULL AND lookup_token_hash = current_claim_token_hash())));
-- "Nhận đơn cũ": UPDATE mù CHỈ đơn CHƯA-gán → gán SANG CHÍNH MÌNH (WITH CHECK). App bắt buộc
-- kèm WHERE order_number AND lookup_token_hash + set app.claim_token_hash + rate-limit.
CREATE POLICY customer_orders_claim ON orders FOR UPDATE TO app_customer
  USING (shop_id = current_shop_id() AND customer_id IS NULL AND lookup_token_hash = current_claim_token_hash())
  WITH CHECK (shop_id = current_shop_id() AND customer_id = current_customer_id());
CREATE POLICY customer_olines_read ON order_lines FOR SELECT TO app_customer
  USING (shop_id = current_shop_id()
         AND order_id IN (SELECT id FROM orders WHERE customer_id = current_customer_id()));
CREATE POLICY customer_outbox_ins ON outbox FOR INSERT TO app_customer
  WITH CHECK (shop_id = current_shop_id());

-- ══ (8) app_rw (seller) — BẮT BUỘC có policy (bất biến); KHÔNG đọc/ghi password_hash ══
-- #4 MUST-FIX: 0003 ALTER DEFAULT PRIVILEGES cấp app_rw arwd toàn cột (kể cả password_hash).
-- Siết như 0075: thu hồi SELECT+UPDATE toàn cột, cấp lại theo cột KHÔNG-nhạy-cảm (không
-- password_hash/email_verified_at). Bỏ INSERT/DELETE (cascade khi ẩn danh). Giữ UPDATE cột PII
-- để seller eraseCustomer ẩn danh (nhưng KHÔNG chạm password_hash — worker/app_expiry xoá).
REVOKE SELECT, INSERT, UPDATE, DELETE ON customers FROM app_rw;
GRANT  SELECT (id, shop_id, email, full_name, phone, email_verified_at, status,
               anonymized_at, last_login_at, created_at, updated_at)   ON customers TO app_rw;
GRANT  UPDATE (email, full_name, phone, status, anonymized_at, updated_at) ON customers TO app_rw;
REVOKE ALL ON customer_password_reset_tokens FROM app_rw;
REVOKE ALL ON customer_email_verifications   FROM app_rw;
REVOKE INSERT ON customer_sessions FROM app_rw;   -- seller thu-hồi được (revoke/xoá) khi ẩn danh, KHÔNG mint
CREATE POLICY tenant_isolation ON customers                      FOR ALL TO app_rw USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY tenant_isolation ON customer_sessions              FOR ALL TO app_rw USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY tenant_isolation ON customer_addresses             FOR ALL TO app_rw USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY tenant_isolation ON customer_password_reset_tokens FOR ALL TO app_rw USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY tenant_isolation ON customer_email_verifications   FOR ALL TO app_rw USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- ══ (9) app_checkout — đọc THEO CỘT (KHÔNG password_hash) để validate phiên + prefill + stamp ══
GRANT SELECT (id, shop_id, email, full_name, phone, status, email_verified_at) ON customers TO app_checkout;
GRANT SELECT ON customer_sessions  TO app_checkout;   -- token_hash là hash; checkout tự tính từ cookie
GRANT SELECT ON customer_addresses TO app_checkout;   -- prefill sổ địa chỉ (radio no-JS)
CREATE POLICY checkout_customers ON customers          FOR SELECT TO app_checkout USING (shop_id = current_shop_id());
CREATE POLICY checkout_cust_sess ON customer_sessions  FOR SELECT TO app_checkout USING (shop_id = current_shop_id());
CREATE POLICY checkout_cust_addr ON customer_addresses FOR SELECT TO app_checkout USING (shop_id = current_shop_id());

-- ══ (10) app_expiry (worker) — ẩn danh khách bất hoạt + xoá phiên/địa chỉ (mẫu 0064) ══
GRANT SELECT (id, shop_id, last_login_at, created_at, status, anonymized_at) ON customers TO app_expiry;
GRANT UPDATE (email, password_hash, full_name, phone, status, anonymized_at) ON customers TO app_expiry;
GRANT DELETE ON customer_addresses TO app_expiry;
GRANT DELETE ON customer_sessions  TO app_expiry;
CREATE POLICY expiry_customers ON customers          FOR ALL TO app_expiry USING (true) WITH CHECK (true);
CREATE POLICY expiry_addresses ON customer_addresses FOR ALL TO app_expiry USING (true) WITH CHECK (true);
CREATE POLICY expiry_sessions  ON customer_sessions  FOR ALL TO app_expiry USING (true) WITH CHECK (true);

-- app_store: KHÔNG cấp gì (header chỉ có LINK TĨNH "Tài khoản" → apps/account). Giữ CHỈ-ĐỌC.
