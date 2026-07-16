/**
 * Storefront — trang bán hàng CÔNG KHAI (không auth, chỉ đọc).
 *
 * Luồng: Host → resolve shop (domains, CHỈ verified) → set tenant context →
 * đọc shop/theme/sản phẩm (app_store, RLS chỉ thấy active/ready) → render SSR.
 *
 * Bốn lớp phòng thủ (mỗi cái có test + mutation):
 *   1. Chỉ domain ĐÃ verified mới route (chưa verify → 404). Chống chiếm domain.
 *   2. Tenant context → RLS cô lập; storefront shop A không bao giờ thấy shop B.
 *   3. app_store CHỈ đọc sản phẩm active + media ready (RLS ở migration 0011) —
 *      draft/archived/pending vô hình về mặt cấu trúc.
 *   4. escape HTML + sanitize token → chống XSS / CSS injection từ dữ liệu shop.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import { renderHome, renderProduct, renderPage, renderSearch, renderBlogList, renderBlogPost, renderMaintenance, renderNotFound } from './theme.js';
import { renderLanding } from './landing.js';
import { renderAbout, renderSupport, renderTerms, renderBlogList as renderCoBlogList, renderBlogPost as renderCoBlogPost, findPost, companyPaths } from './company.js';
import { runReq, makeLog, health } from './obs.js';

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

const PORT = Number(process.env.PORT ?? 3050);
// Base URL ảnh public. Mặc định TƯƠNG ĐỐI (/media-public) → cùng origin với trang shop
// (Caddy proxy path này về MinIO) → CSP 'self' cho phép, trình duyệt tới được. Prod có
// thể đặt tuyệt đối (vd https://cdn.nentang.vn/media-public) qua env → MEDIA_ORIGIN vào CSP.
const MEDIA_PUBLIC_BASE = process.env.MEDIA_PUBLIC_BASE ?? '/media-public';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

// CSP cho storefront công khai (lớp phòng thủ XSS thứ hai sau escape HTML).
// - script-src KHÔNG có (default-src 'none') → chặn mọi JS. Storefront không dùng JS.
// - style-src 'unsafe-inline': theme đổ token vào <style> nội tuyến (đã sanitize).
// - img-src: self + gốc media (ảnh sản phẩm từ bucket public/CDN) + data:.
// - frame-ancestors 'none': chống clickjacking. base-uri/form-action khoá về self.
const MEDIA_ORIGIN = (() => { try { return new URL(MEDIA_PUBLIC_BASE).origin; } catch { return ''; } })();
const CSP = [
  "default-src 'none'",
  `img-src 'self' data: ${MEDIA_ORIGIN}`.trim(),
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const log = makeLog('storefront');

/** Resolve hostname → {shopId, isPrimary, primaryHost}. CHỈ domain đã verified. Kèm tên
 *  miền CHÍNH của shop để 301 host phụ về chính (A5 — tránh trùng nội dung SEO). */
async function resolveShop(hostname) {
  const { rows } = await db.query(
    `SELECT d.shop_id, d.is_primary,
            (SELECT hostname FROM domains WHERE shop_id = d.shop_id AND is_primary AND verified_at IS NOT NULL LIMIT 1) AS primary_host
       FROM domains d WHERE d.hostname = $1 AND d.verified_at IS NOT NULL`,
    [hostname],
  );
  const r = rows[0];
  return r ? { shopId: r.shop_id, isPrimary: r.is_primary, primaryHost: r.primary_host } : null;
}

/** Mở transaction có tenant context = shopId, chạy fn (app_store, RLS cô lập). */
async function withStore(shopId, fn) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

const imgUrl = (key) => (key ? `${MEDIA_PUBLIC_BASE}/${key}` : null);

function normalizeHost(raw) {
  if (typeof raw !== 'string') return null;
  return raw.split(':')[0].trim().toLowerCase(); // bỏ port
}

const CACHE_PUBLIC = 'public, s-maxage=60, stale-while-revalidate=300';
const PAGE_SIZE = 24; // sản phẩm mỗi trang (lưới trang chủ / danh mục / tìm kiếm)
// Host GỐC nền tảng → trang CÔNG TY (marketing/bảng giá), KHÔNG phải shop nào.
const ROOT_HOSTS = new Set((process.env.PLATFORM_ROOT_HOSTS ?? 'nentang.vn,www.nentang.vn')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const LANDING_CFG = {
  contactEmail: process.env.PLATFORM_CONTACT_EMAIL ?? 'lienhe@nentang.vn',
  contactPhone: process.env.PLATFORM_CONTACT_PHONE ?? '',
  brand: process.env.PLATFORM_BRAND ?? 'Nền Tảng',
};

function sendHtml(res, status, html, { shopSlug, cache, preview } = {}) {
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'content-security-policy': CSP,
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
  };
  // Preview BẢN NHÁP mang token trong URL và lộ nội dung chưa xuất bản → TUYỆT ĐỐI
  // không để CDN/công cụ tìm kiếm giữ lại: no-store + noindex. Phải kiểm trước `cache`.
  if (preview) {
    headers['cache-control'] = 'no-store';
    headers['x-robots-tag'] = 'noindex, nofollow';
  } else if (cache) {
    // CHỈ đặt Cache-Control cho trang cache được (home/product/category).
    // Trang 404/bảo trì KHÔNG đặt → để Caddy làm chủ no-store trên /cart /checkout
    // /api (không nhân đôi header). CDN cache theo host+path; mỗi host = một shop.
    headers['cache-control'] = CACHE_PUBLIC;
  }
  if (shopSlug) headers['x-shop-slug'] = shopSlug; // giúp e2e/smoke kiểm routing
  res.writeHead(status, headers);
  res.end(html);
}

const server = http.createServer((req, res) => runReq(req, res, async () => {
  const url = new URL(req.url, 'http://internal');
  if (await health(url.pathname, res, { db: () => db.query('SELECT 1') })) return;

  try {
    const host = normalizeHost(req.headers.host);
    // Host GỐC nền tảng (nentang.vn) → trang công ty, không resolve shop.
    if (host && ROOT_HOSTS.has(host)) {
      if (url.pathname === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': CACHE_PUBLIC }); return res.end(`User-agent: *\nAllow: /\nSitemap: https://${host}/sitemap.xml\n`); }
      if (url.pathname === '/sitemap.xml') {
        const base = `https://${host}`;
        const urls = ['/', ...companyPaths()].map((p) => `<url><loc>${base}${p}</loc></url>`).join('');
        res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': CACHE_PUBLIC });
        return res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
      }
      if (url.pathname === '/') return sendHtml(res, 200, renderLanding(LANDING_CFG), { cache: true });
      if (url.pathname === '/gioi-thieu') return sendHtml(res, 200, renderAbout(LANDING_CFG), { cache: true });
      if (url.pathname === '/ho-tro') return sendHtml(res, 200, renderSupport(LANDING_CFG), { cache: true });
      if (url.pathname === '/dieu-khoan') return sendHtml(res, 200, renderTerms(LANDING_CFG), { cache: true });
      if (url.pathname === '/blog') return sendHtml(res, 200, renderCoBlogList(LANDING_CFG), { cache: true });
      if (url.pathname.startsWith('/blog/')) {
        const post = findPost(decodeURIComponent(url.pathname.slice('/blog/'.length)));
        if (post) return sendHtml(res, 200, renderCoBlogPost(LANDING_CFG, post), { cache: true });
      }
      return sendHtml(res, 404, renderNotFound());
    }
    const resolved = host ? await resolveShop(host) : null;
    if (!resolved) return sendHtml(res, 404, renderNotFound());
    // A5: host phụ (không phải tên miền chính) → 301 sang tên miền chính. Một shop có thể
    // verified nhiều tên miền; phục vụ tất cả sẽ trùng nội dung → gom về chính cho SEO.
    if (!resolved.isPrimary && resolved.primaryHost && resolved.primaryHost !== host) {
      res.writeHead(301, { location: `https://${resolved.primaryHost}${req.url}`, 'cache-control': 'no-store' });
      return res.end();
    }
    const shopId = resolved.shopId;

    // robots.txt — cho phép index, chặn giỏ/checkout, trỏ sitemap của shop.
    if (url.pathname === '/robots.txt') {
      const body = `User-agent: *\nAllow: /\nDisallow: /cart\nDisallow: /checkout\nSitemap: https://${host}/sitemap.xml\n`;
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': CACHE_PUBLIC });
      return res.end(body);
    }
    // sitemap.xml — trang chủ + danh mục + sản phẩm active + trang nội dung published.
    // RLS (app_store) tự lọc active/published → chỉ URL công khai lọt vào sitemap.
    if (url.pathname === '/sitemap.xml') {
      const sm = await withStore(shopId, async (c) => {
        if (!(await c.query(`SELECT 1 FROM shops WHERE id = current_shop_id() AND status <> 'suspended'`)).rows[0]) return null;
        const prods = (await c.query(`SELECT slug FROM products ORDER BY created_at DESC LIMIT 5000`)).rows;
        const cats = (await c.query(`SELECT slug FROM categories ORDER BY position LIMIT 200`)).rows;
        const pages = (await c.query(`SELECT p.slug FROM pages p JOIN page_revisions pr ON pr.id = p.published_revision_id LIMIT 1000`)).rows;
        const blog = (await c.query(`SELECT slug FROM blog_posts WHERE status = 'published' ORDER BY published_at DESC LIMIT 2000`)).rows;
        return { prods, cats, pages, blog };
      });
      if (!sm) return sendHtml(res, 404, renderNotFound());
      const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const loc = (path) => `  <url><loc>${escXml(`https://${host}${path}`)}</loc></url>`;
      const urls = [loc('/'), ...sm.cats.map((c) => loc(`/c/${c.slug}`)), ...sm.prods.map((p) => loc(`/p/${p.slug}`)), ...sm.pages.map((p) => loc(`/pages/${p.slug}`)),
        ...(sm.blog.length ? [loc('/blog'), ...sm.blog.map((b) => loc(`/blog/${b.slug}`))] : [])];
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
      res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': CACHE_PUBLIC });
      return res.end(xml);
    }

    const data = await withStore(shopId, async (c) => {
      const shopRes = await c.query(`SELECT slug, name, status, contact_email, contact_phone, business_address, logo_key FROM shops WHERE id = current_shop_id()`);
      const shop = shopRes.rows[0];
      if (!shop) return { notFound: true }; // terminated/deleted (RLS)
      shop.logo_url = imgUrl(shop.logo_key); // header hiện logo nếu có
      if (shop.status === 'suspended') return { shop, suspended: true };

      const theme = (await c.query(`SELECT tokens, layout FROM themes WHERE shop_id = current_shop_id()`)).rows[0] ?? null;
      const categories = (await c.query(`SELECT slug, name FROM categories ORDER BY position, name LIMIT 20`)).rows;
      // Menu chân trang: chỉ trang ĐÃ published, có menu_position. Tiêu đề lấy từ
      // bản published (page_revisions), không phải draft → khớp nội dung hiển thị.
      const menu = (await c.query(
        `SELECT p.slug, pr.title
           FROM pages p JOIN page_revisions pr ON pr.id = p.published_revision_id
          WHERE p.menu_position IS NOT NULL
          ORDER BY p.menu_position, pr.title LIMIT 20`,
      )).rows;
      const hasBlog = Number((await c.query(`SELECT count(*)::int n FROM blog_posts WHERE status = 'published'`)).rows[0].n) > 0;
      const base = { shop, theme, categories, menu, hasBlog };

      const productGrid = async (whereJoin = '', args = [], offset = 0) => {
        const total = Number((await c.query(`SELECT count(*)::int n FROM products p ${whereJoin}`, args)).rows[0].n);
        const rows = (await c.query(
          `SELECT p.id, p.slug, p.title, p.price_vnd,
                  (SELECT m.public_key FROM media m WHERE m.product_id = p.id ORDER BY m.position, m.created_at LIMIT 1) AS image_key,
                  (SELECT coalesce(sum(il.on_hand - il.reserved), 0)
                     FROM variants v LEFT JOIN inventory_levels il ON il.variant_id = v.id
                    WHERE v.product_id = p.id) AS available
             FROM products p ${whereJoin} ORDER BY p.created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
          args,
        )).rows.map((p) => ({ ...p, image: imgUrl(p.image_key), available: Number(p.available) }));
        return { products: rows, total };
      };
      const pageNo = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
      const offset = (pageNo - 1) * PAGE_SIZE;

      // Trang chi tiết sản phẩm: /p/:slug (?variant= chọn biến thể — SSR đổi giá/tồn/ảnh).
      const pm = /^\/p\/([a-z0-9-]+)$/.exec(url.pathname);
      if (pm) {
        const p = (await c.query(
          `SELECT id, slug, title, description, price_vnd FROM products WHERE slug = $1`, [pm[1]],
        )).rows[0];
        if (!p) return { ...base, notFound: true };
        // available = on_hand - reserved (KHỚP checkout: không có dòng inventory = 0 = hết hàng).
        const variants = (await c.query(
          `SELECT v.id, v.title, v.sku, v.price_vnd, coalesce(il.on_hand - il.reserved, 0) AS available
             FROM variants v LEFT JOIN inventory_levels il ON il.variant_id = v.id
            WHERE v.product_id = $1 ORDER BY v.position`, [p.id])).rows;
        // Trục biến thể (Màu/Size...) — RLS store_* chỉ trả option của SP đang bán.
        p.options = (await c.query(
          `SELECT o.id, o.name, o.position,
                  coalesce(json_agg(json_build_object('id', ov.id, 'value', ov.value) ORDER BY ov.position) FILTER (WHERE ov.id IS NOT NULL), '[]') AS values
             FROM product_options o LEFT JOIN option_values ov ON ov.option_id = o.id
            WHERE o.product_id = $1 GROUP BY o.id ORDER BY o.position`, [p.id])).rows;
        // Ánh xạ biến thể → {option_id: value_id} để resolve tổ hợp khi khách đổi 1 trục.
        const vov = (await c.query(
          `SELECT vov.variant_id, vov.option_id, vov.option_value_id
             FROM variant_option_values vov JOIN variants v ON v.id = vov.variant_id WHERE v.product_id = $1`, [p.id])).rows;
        const vmap = new Map();
        for (const r of vov) { if (!vmap.has(r.variant_id)) vmap.set(r.variant_id, {}); vmap.get(r.variant_id)[r.option_id] = r.option_value_id; }
        p.variants = variants.map((v) => ({ ...v, values: vmap.get(v.id) ?? {} }));
        // Ảnh: kèm variant_id → storefront đổi ảnh theo biến thể (NULL = ảnh chung sản phẩm).
        p.media = (await c.query(`SELECT public_key, variant_id FROM media WHERE product_id = $1 ORDER BY position, created_at`, [p.id]))
          .rows.map((m) => ({ url: imgUrl(m.public_key), variant_id: m.variant_id }));
        p.specs = (await c.query(`SELECT name, value FROM product_specs WHERE product_id = $1 ORDER BY position`, [p.id])).rows;
        p.category = (await c.query(
          `SELECT c.slug, c.name FROM product_categories pc JOIN categories c ON c.id = pc.category_id
            WHERE pc.product_id = $1 ORDER BY c.position LIMIT 1`, [p.id])).rows[0] ?? null;
        // Sản phẩm liên quan: cùng danh mục, đang bán, khác chính nó (RLS store_products lọc active).
        p.related = (await c.query(
          `SELECT DISTINCT p2.id, p2.slug, p2.title, p2.price_vnd,
                  (SELECT m.public_key FROM media m WHERE m.product_id = p2.id ORDER BY m.position, m.created_at LIMIT 1) AS image_key,
                  (SELECT coalesce(sum(il.on_hand - il.reserved), 0) FROM variants v LEFT JOIN inventory_levels il ON il.variant_id = v.id WHERE v.product_id = p2.id) AS available
             FROM products p2 JOIN product_categories pc2 ON pc2.product_id = p2.id
            WHERE pc2.category_id IN (SELECT category_id FROM product_categories WHERE product_id = $1) AND p2.id <> $1
            LIMIT 8`, [p.id])).rows.map((r) => ({ ...r, image: imgUrl(r.image_key), available: Number(r.available) }));
        // Đánh giá: RLS store_reviews chỉ trả APPROVED của SP đang hiện.
        p.reviewStats = (await c.query(
          `SELECT count(*)::int AS n, coalesce(round(avg(rating)::numeric, 1), 0) AS avg FROM product_reviews WHERE product_id = $1`, [p.id])).rows[0];
        p.reviews = (await c.query(
          `SELECT rating, author_name, content, verified, created_at FROM product_reviews
            WHERE product_id = $1 ORDER BY created_at DESC LIMIT 10`, [p.id])).rows;
        p.reviewFlag = url.searchParams.get('review'); // 'sent' | 'invalid' (PRG từ checkout)
        p.selectedId = url.searchParams.get('variant');
        return { ...base, product: p };
      }

      // Trang danh mục: /c/:slug
      const cm = /^\/c\/([a-z0-9-]+)$/.exec(url.pathname);
      if (cm) {
        const cat = (await c.query(`SELECT id, name FROM categories WHERE slug = $1`, [cm[1]])).rows[0];
        if (!cat) return { ...base, notFound: true };
        const { products, total } = await productGrid(
          `JOIN product_categories pc ON pc.product_id = p.id WHERE pc.category_id = $1`, [cat.id], offset,
        );
        return { ...base, products, home: true, heroTitle: cat.name, pageInfo: { total, offset, pageSize: PAGE_SIZE, basePath: `/c/${cm[1]}` } };
      }

      // Tìm kiếm: /search?q=... (ILIKE theo tên; RLS store_products lọc active).
      if (url.pathname === '/search') {
        const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
        let products = [], total = 0;
        if (q) {
          // KHÔNG DẤU (0048): "tham trai san" khớp "Thảm trải sàn" — vn_unaccent 2 vế + index trigram.
          const like = '%' + q.replace(/[%_\\]/g, '\\$&') + '%';
          ({ products, total } = await productGrid(`WHERE vn_unaccent(p.title) LIKE vn_unaccent($1)`, [like], offset));
        }
        return { ...base, products, search: true, query: q, pageInfo: { total, offset, pageSize: PAGE_SIZE, basePath: `/search?q=${encodeURIComponent(q)}` } };
      }

      // Trang nội dung/chính sách: /pages/:slug. CHỈ bản published (RLS store_pages
      // che draft/đã xoá). Nội dung lấy từ page_revisions được published_revision_id trỏ.
      const gm = /^\/pages\/([a-z0-9-]+)$/.exec(url.pathname);
      if (gm) {
        // Preview BẢN NHÁP: seller cấp token → đọc SNAPSHOT trong page_previews (KHÔNG
        // đọc pages.blocks). RLS store_preview lo cô lập tenant + hết hạn; ràng slug để
        // token chỉ dùng đúng trang của nó. Không token → luồng published bình thường.
        const previewToken = url.searchParams.get('preview');
        if (previewToken) {
          const pv = (await c.query(
            `SELECT title, blocks, seo_title, seo_description FROM page_previews
              WHERE token_hash = $1 AND slug = $2 AND expires_at > now()`,
            [hashToken(previewToken), gm[1]],
          )).rows[0];
          if (!pv) return { ...base, notFound: true };
          return { ...base, page: pv, preview: true };
        }
        const doc = (await c.query(
          `SELECT pr.title, pr.blocks, pr.seo_title, pr.seo_description
             FROM pages p JOIN page_revisions pr ON pr.id = p.published_revision_id
            WHERE p.slug = $1`, [gm[1]],
        )).rows[0];
        if (!doc) return { ...base, notFound: true };
        return { ...base, page: doc };
      }

      // Blog: /blog (danh sách bài published) + /blog/:slug (bài). RLS store_blog lọc published.
      if (url.pathname === '/blog') {
        const posts = (await c.query(`SELECT slug, title, excerpt, published_at FROM blog_posts WHERE status = 'published' ORDER BY published_at DESC LIMIT 50`)).rows;
        return { ...base, blog: 'list', posts };
      }
      const bm = /^\/blog\/([a-z0-9-]+)$/.exec(url.pathname);
      if (bm) {
        const post = (await c.query(`SELECT slug, title, excerpt, body, published_at FROM blog_posts WHERE slug = $1 AND status = 'published'`, [bm[1]])).rows[0];
        if (!post) return { ...base, notFound: true };
        return { ...base, blog: 'post', post };
      }

      // Trang chủ: CHỈ path '/'. Path lạ → 404 (không render home cho mọi thứ).
      if (url.pathname !== '/') return { ...base, notFound: true };
      const { products, total } = await productGrid('', [], offset);
      return { ...base, products, home: true, pageInfo: { total, offset, pageSize: PAGE_SIZE, basePath: '/' } };
    });

    if (data.notFound) return sendHtml(res, 404, renderNotFound(), { shopSlug: data.shop?.slug });
    if (data.suspended) return sendHtml(res, 503, renderMaintenance(data.shop.name), { shopSlug: data.shop.slug });

    // origin tuyệt đối của shop (từ host request) → dựng URL tuyệt đối cho og:image,
    // vì bộ quét mạng xã hội KHÔNG hiểu ảnh đường-dẫn-tương-đối (/media-public/...).
    const origin = host ? `https://${host}` : '';
    const ctx = { shop: data.shop, theme: data.theme, categories: data.categories, products: data.products ?? [], menu: data.menu ?? [], pageInfo: data.pageInfo ?? null, query: data.query ?? '', hasBlog: data.hasBlog, origin };
    const canonical = host ? `https://${host}${url.pathname}` : null; // URL sạch (không kèm query)
    if (data.page) {
      // Preview → banner cảnh báo + no-store/noindex; published → cache CDN như thường.
      if (data.preview) return sendHtml(res, 200, renderPage(ctx, data.page, { preview: true, canonical }), { shopSlug: data.shop.slug, preview: true });
      return sendHtml(res, 200, renderPage(ctx, data.page, { canonical }), { shopSlug: data.shop.slug, cache: true });
    }
    if (data.product) return sendHtml(res, 200, renderProduct(ctx, data.product, { canonical }), { shopSlug: data.shop.slug, cache: true });
    if (data.blog === 'list') return sendHtml(res, 200, renderBlogList(ctx, data.posts ?? [], { canonical }), { shopSlug: data.shop.slug, cache: true });
    if (data.blog === 'post') return sendHtml(res, 200, renderBlogPost(ctx, data.post, { canonical }), { shopSlug: data.shop.slug, cache: true });
    if (data.search) return sendHtml(res, 200, renderSearch(ctx, { canonical }), { shopSlug: data.shop.slug });
    return sendHtml(res, 200, renderHome(ctx, { canonical }), { shopSlug: data.shop.slug, cache: true });
  } catch (err) {
    log('error', 'render_error', { path: url.pathname, message: err.message, stack: err.stack });
    if (!res.headersSent) sendHtml(res, 500, renderNotFound());
  }
}));

server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT }));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(async () => { await db.end().catch(() => {}); process.exit(0); }));
}
