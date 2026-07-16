-- 0048 — Tìm kiếm tiếng Việt KHÔNG DẤU: "tham trai san" phải ra "Thảm trải sàn".
--
-- unaccent + pg_trgm đều là extension TRUSTED (PG13+) → app_owner tạo được, không cần
-- superuser. vn_unaccent bọc IMMUTABLE (unaccent gốc STABLE vì dictionary có thể đổi —
-- ta pin dictionary 'unaccent' nên an toàn để dùng trong index).

CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION vn_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT lower(public.unaccent('public.unaccent'::regdictionary, $1)) $$;

-- Index trigram trên tên đã bỏ dấu → LIKE '%...%' không quét toàn bảng khi catalog lớn.
CREATE INDEX products_title_unaccent_trgm_idx ON products
  USING gin (vn_unaccent(title) gin_trgm_ops);
CREATE INDEX orders_customer_unaccent_trgm_idx ON orders
  USING gin (vn_unaccent(customer_name) gin_trgm_ops);
