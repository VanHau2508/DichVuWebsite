-- 0003 — vai trò database và quyền tối thiểu.
--
--   app_owner  — sở hữu schema, CHỈ chạy migration.
--   app_rw     — ứng dụng dùng hằng ngày. Không sở hữu bảng. Không BYPASSRLS.
--   app_tls    — tls-authorize. CHỈ SELECT trên shops + domains.
--
-- Vì sao tách: chủ sở hữu bảng bỏ qua RLS trừ khi bảng bật FORCE, và superuser
-- thì bỏ qua RLS trong MỌI trường hợp. Nếu ứng dụng kết nối bằng app_owner,
-- RLS chỉ là trang trí.
--
-- Trong dev, app_owner chính là POSTGRES_USER nên nó là superuser — điều này
-- cần thiết để seed dữ liệu sau khi RLS đã bật. Ở production, app_owner phải là
-- role thường (không superuser) và không được dùng để chạy ứng dụng.

CREATE ROLE app_rw LOGIN PASSWORD 'devpassword'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

CREATE ROLE app_tls LOGIN PASSWORD 'devpassword'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

-- ── app_rw ───────────────────────────────────────────────────────────────────
GRANT CONNECT ON DATABASE app TO app_rw;
GRANT USAGE   ON SCHEMA public TO app_rw;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO app_rw;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO app_rw;

-- Audit log là bằng chứng. Ứng dụng chỉ được ghi thêm, không sửa, không xoá.
REVOKE UPDATE, DELETE ON audit_logs FROM app_rw;

ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_rw;

-- ── app_tls ──────────────────────────────────────────────────────────────────
-- Endpoint public-facing nhất của hệ thống → quyền hẹp nhất có thể.
GRANT CONNECT ON DATABASE app TO app_tls;
GRANT USAGE   ON SCHEMA public TO app_tls;
GRANT SELECT  ON shops, domains TO app_tls;

-- ── Không ai được tạo bảng trong public ngoài app_owner ──────────────────────
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM app_rw, app_tls;
