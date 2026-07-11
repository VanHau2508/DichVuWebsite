-- 0001 — shops và domains.
--
-- `shops` là bảng gốc: nó KHÔNG có cột shop_id (nó chính là tenant).
-- Mọi bảng nghiệp vụ khác đều có shop_id NOT NULL. Không ngoại lệ.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- Postgres 16 chưa có uuidv7() dựng sẵn (có từ PG18).
-- Dùng gen_random_uuid() (v4) cho tới khi nâng cấp; kiểu cột không đổi.
CREATE TABLE shops (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'onboarding'
                CHECK (status IN ('onboarding','active','suspended','terminated')),
  feature_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE TABLE domains (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id            uuid NOT NULL REFERENCES shops(id),
  hostname           text NOT NULL,
  verification_token text NOT NULL,
  verified_at        timestamptz,          -- NULL = chưa xác minh = KHÔNG được cấp cert
  is_primary         boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (hostname),
  UNIQUE (shop_id, id),                    -- đích cho composite foreign key

  -- Bất biến: hostname luôn lowercase. tls-authorize chuẩn hoá trước khi query;
  -- ràng buộc này đảm bảo không ai ghi hoa vào DB bằng đường khác.
  CONSTRAINT domains_hostname_lower CHECK (hostname = lower(hostname)),
  CONSTRAINT domains_hostname_no_port CHECK (position(':' in hostname) = 0)
);

CREATE INDEX domains_verified_hostname_idx
  ON domains (hostname) WHERE verified_at IS NOT NULL;
