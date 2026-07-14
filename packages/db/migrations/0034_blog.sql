-- 0034 — blog / tin tức cho shop (SEO nội dung + marketing).
--
-- Bảng riêng blog_posts (KHÔNG dùng lại versioning nặng của pages). Chủ shop (content.write)
-- viết bài; storefront hiện /blog + /blog/:slug (chỉ bài published). Body là TEXT thuần —
-- storefront render thành <p> có esc (an toàn, no-JS, không HTML tuỳ ý theo ADR-008).

CREATE TABLE blog_posts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL REFERENCES shops(id),
  slug         text NOT NULL,
  title        text NOT NULL,
  excerpt      text,
  body         text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, slug)
);
CREATE INDEX blog_posts_shop_idx ON blog_posts (shop_id, status, published_at DESC);

ALTER TABLE blog_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE blog_posts FORCE  ROW LEVEL SECURITY;

-- app_rw (seller): tenant-scoped toàn quyền. Grant tường minh (bảng tạo sau 0003).
GRANT SELECT, INSERT, UPDATE, DELETE ON blog_posts TO app_rw;
CREATE POLICY tenant_isolation ON blog_posts FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- app_store (storefront công khai): CHỈ bài đã published của shop hiện tại.
GRANT SELECT ON blog_posts TO app_store;
CREATE POLICY store_blog ON blog_posts FOR SELECT TO app_store
  USING (shop_id = current_shop_id() AND status = 'published');
