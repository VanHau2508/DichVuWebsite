-- 0016 — trang nội dung/chính sách: page + revision + draft/publish/rollback + menu.
--
-- pages.blocks = bản DRAFT đang sửa (luôn sửa được). Khi publish → snapshot vào
-- page_revisions (append-only) và trỏ published_revision_id tới đó. Storefront chỉ
-- render bản PUBLISHED. Rollback = trỏ published_revision_id về revision cũ (không
-- đụng draft). Chưa làm kéo–thả; nội dung là danh sách block {type, text} (text-only,
-- storefront escape → an toàn XSS).

CREATE TABLE pages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id               uuid NOT NULL REFERENCES shops (id),
  slug                  text NOT NULL,
  title                 text NOT NULL,
  blocks                jsonb NOT NULL DEFAULT '[]'::jsonb,   -- DRAFT
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  published_revision_id uuid,                                 -- FK thêm sau (vòng)
  menu_position         int,                                  -- NULL = không ở footer menu
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  UNIQUE (shop_id, slug),
  UNIQUE (shop_id, id)
);

CREATE TABLE page_revisions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    uuid NOT NULL,
  page_id    uuid NOT NULL,
  revision   int  NOT NULL,
  title      text NOT NULL,
  blocks     jsonb NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, page_id, revision),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, page_id) REFERENCES pages (shop_id, id) ON DELETE CASCADE
);
CREATE INDEX page_revisions_page_idx ON page_revisions (shop_id, page_id, revision DESC);

-- FK vòng: pages.published_revision_id → page_revisions (thêm sau khi cả hai tồn tại).
-- Nullable → MATCH SIMPLE bỏ qua khi NULL (trang draft chưa publish).
ALTER TABLE pages ADD CONSTRAINT pages_published_revision_fk
  FOREIGN KEY (shop_id, published_revision_id) REFERENCES page_revisions (shop_id, id);

-- page_revisions là APPEND-ONLY (lịch sử xuất bản). app_rw không sửa/xoá dòng cũ.
-- (DELETE cho phép qua CASCADE khi xoá page; nhưng app_rw không UPDATE/DELETE trực tiếp.)
REVOKE UPDATE, DELETE ON page_revisions FROM app_rw;

-- ── RLS: app_rw (seller quản lý) ─────────────────────────────────────────────
ALTER TABLE pages ENABLE ROW LEVEL SECURITY; ALTER TABLE pages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pages FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
ALTER TABLE page_revisions ENABLE ROW LEVEL SECURITY; ALTER TABLE page_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON page_revisions FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- ── app_store (storefront công khai): CHỈ trang published + revision của shop ─
GRANT SELECT ON pages, page_revisions TO app_store;
CREATE POLICY store_pages ON pages FOR SELECT TO app_store
  USING (shop_id = current_shop_id() AND status = 'published' AND deleted_at IS NULL);
CREATE POLICY store_page_revisions ON page_revisions FOR SELECT TO app_store
  USING (shop_id = current_shop_id());  -- chỉ revision được trỏ tới mới được đọc thực tế
