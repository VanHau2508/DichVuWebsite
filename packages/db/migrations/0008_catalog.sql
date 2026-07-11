-- 0008 — catalog: danh mục, quan hệ sản phẩm–danh mục, bổ sung trường.
--
-- products, variants đã có từ 0002 (kèm RLS ở 0004 và composite FK). Migration này
-- thêm categories + product_categories, và vài cột cho catalog thực tế.

-- ── Bổ sung cột ──────────────────────────────────────────────────────────────
ALTER TABLE products ADD COLUMN description text;

ALTER TABLE variants ADD COLUMN title    text;              -- "Đỏ / M"; NULL = biến thể mặc định
ALTER TABLE variants ADD COLUMN position int NOT NULL DEFAULT 0;

-- ── categories ───────────────────────────────────────────────────────────────
CREATE TABLE categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    uuid NOT NULL REFERENCES shops(id),
  slug       text NOT NULL,
  name       text NOT NULL,
  position   int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,

  UNIQUE (shop_id, id),          -- đích cho composite FK
  UNIQUE (shop_id, slug)         -- slug duy nhất TRONG shop
);

-- ── product_categories (n:n) ─────────────────────────────────────────────────
-- Composite FK gồm shop_id: một sản phẩm KHÔNG thể gắn vào danh mục của shop khác,
-- database từ chối ở tầng ràng buộc kể cả khi RLS/code lỗi.
CREATE TABLE product_categories (
  shop_id     uuid NOT NULL,
  product_id  uuid NOT NULL,
  category_id uuid NOT NULL,

  PRIMARY KEY (shop_id, product_id, category_id),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, product_id)  REFERENCES products   (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, category_id) REFERENCES categories (shop_id, id) ON DELETE CASCADE
);
CREATE INDEX product_categories_category_idx ON product_categories (shop_id, category_id);

-- ── Chỉ mục phục vụ list/lọc/tìm ─────────────────────────────────────────────
-- Lọc theo trạng thái trong một shop. Tìm theo title dùng ILIKE seq-scan: ở quy
-- mô pilot (≤ vài trăm sản phẩm/shop, đã bị RLS thu về một shop) là tức thì.
-- Chỉ mục trigram (pg_trgm) là tối ưu tương lai, không cần bây giờ.
CREATE INDEX products_shop_status_idx  ON products (shop_id, status) WHERE deleted_at IS NULL;
CREATE INDEX variants_product_idx      ON variants (shop_id, product_id);

-- ── RLS cho bảng tenant mới ──────────────────────────────────────────────────
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON categories FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

ALTER TABLE product_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_categories FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON product_categories FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
