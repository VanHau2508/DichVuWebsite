-- 0011 — theme + vai trò storefront công khai (app_store).
--
-- Storefront là dịch vụ CÔNG KHAI (Internet-facing), chỉ ĐỌC. Nó phải có quyền
-- HẸP NHẤT: giống app_tls, nhưng đọc được sản phẩm/theme để render.
--
-- Điểm mấu chốt: RLS của app_store làm nó KHÔNG THỂ (về mặt cấu trúc) nhìn thấy
-- sản phẩm draft/archived, media chưa xử lý, hay dữ liệu shop khác. Đây là lá chắn
-- MẠNH HƠN việc lọc trong câu query — code storefront có quên WHERE status='active'
-- thì DB vẫn giấu draft.

-- ── themes ───────────────────────────────────────────────────────────────────
CREATE TABLE themes (
  shop_id    uuid PRIMARY KEY REFERENCES shops (id),
  tokens     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- màu, font, radius, spacing
  layout     jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{section, props}]
  version    int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE themes ENABLE ROW LEVEL SECURITY;
ALTER TABLE themes FORCE  ROW LEVEL SECURITY;
-- Seller (app_rw) quản lý theme của shop mình.
CREATE POLICY tenant_isolation ON themes FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- ── Vai trò app_store (công khai, chỉ đọc) ───────────────────────────────────
CREATE ROLE app_store LOGIN PASSWORD 'devpassword'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE app TO app_store;
GRANT USAGE   ON SCHEMA public TO app_store;

GRANT SELECT ON domains, shops, themes, products, variants, categories, product_categories, media TO app_store;

-- Resolve domain→shop (chưa có context) — giống app_tls với domains.
CREATE POLICY store_lookup ON domains FOR SELECT TO app_store USING (true);

-- Sau khi có context: chỉ thấy shop CỦA MÌNH, còn hoạt động (không terminated/deleted).
CREATE POLICY store_shop ON shops FOR SELECT TO app_store
  USING (id = current_shop_id() AND deleted_at IS NULL AND status <> 'terminated');

CREATE POLICY store_theme ON themes FOR SELECT TO app_store
  USING (shop_id = current_shop_id());

-- CHỈ sản phẩm ĐANG BÁN (active, chưa xoá). Draft/archived vô hình về mặt cấu trúc.
CREATE POLICY store_products ON products FOR SELECT TO app_store
  USING (shop_id = current_shop_id() AND status = 'active' AND deleted_at IS NULL);

-- Biến thể chỉ hiện nếu sản phẩm của nó hiện (subquery chạy dưới chính policy trên).
CREATE POLICY store_variants ON variants FOR SELECT TO app_store
  USING (shop_id = current_shop_id()
         AND EXISTS (SELECT 1 FROM products p WHERE p.id = variants.product_id));

CREATE POLICY store_categories ON categories FOR SELECT TO app_store
  USING (shop_id = current_shop_id() AND deleted_at IS NULL);

CREATE POLICY store_product_categories ON product_categories FOR SELECT TO app_store
  USING (shop_id = current_shop_id());

-- CHỈ media đã re-encode xong (ready). Bản pending/failed vô hình.
CREATE POLICY store_media ON media FOR SELECT TO app_store
  USING (shop_id = current_shop_id() AND status = 'ready' AND deleted_at IS NULL);
