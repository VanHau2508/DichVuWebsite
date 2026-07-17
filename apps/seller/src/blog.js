/**
 * Blog / tin tức của shop. Ngày 15/07. Bảng riêng blog_posts (không versioning).
 *
 * Chủ shop (content.write) viết bài; storefront hiện /blog + /blog/:slug (chỉ published,
 * lọc bởi RLS store_blog). Body TEXT thuần — storefront esc + render thành <p> (an toàn).
 */
import { send } from './http.js';
import { withTenant, audit } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const validSlug = (x) => typeof x === 'string' && SLUG_RE.test(x);
const validTitle = (x) => typeof x === 'string' && x.trim().length >= 1 && x.length <= 200;
// Ảnh bìa (0071): key media PUBLIC như ảnh sản phẩm/logo (media.js sinh
// "<shop_id>/<media_id>.webp"). Chỉ nhận key ĐÚNG ĐỊNH DẠNG + thuộc CHÍNH shop
// (tiền tố shop_id) — không upload mới, dán key ảnh đã upload.
const U36 = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MEDIA_KEY_RE = new RegExp(`^${U36}/(?:logo-)?${U36}\\.webp$`);
// Trả {ok, val} — chuỗi rỗng/null → null (xoá ảnh bìa); key sai định dạng/chéo shop → lỗi.
function parseCover(x, shopId) {
  const s = String(x ?? '').trim();
  if (s === '') return { ok: true, val: null };
  if (!MEDIA_KEY_RE.test(s) || !s.startsWith(`${shopId}/`)) return { ok: false };
  return { ok: true, val: s };
}

async function listPosts(res, ctx) {
  const rows = await withTenant(ctx.shopId, async (c) =>
    (await c.query(`SELECT id, slug, title, status, published_at, updated_at FROM blog_posts
                     ORDER BY coalesce(published_at, updated_at) DESC LIMIT 200`)).rows);
  return send(res, 200, { posts: rows });
}

async function getPost(res, ctx, _b, params) {
  const row = await withTenant(ctx.shopId, async (c) =>
    (await c.query(`SELECT id, slug, title, excerpt, body, status, published_at, cover_image_key FROM blog_posts WHERE id = $1`, [params[1]])).rows[0]);
  if (!row) return send(res, 404, { error: 'không tìm thấy bài viết' });
  return send(res, 200, row);
}

async function createPost(res, ctx, body) {
  const title = String(body.title ?? '').trim();
  const slug = String(body.slug ?? '').toLowerCase().trim();
  const excerpt = body.excerpt != null && String(body.excerpt).trim() !== '' ? String(body.excerpt).slice(0, 500) : null;
  const content = body.body != null ? String(body.body).slice(0, 50000) : '';
  if (!validTitle(title)) return send(res, 400, { error: 'tiêu đề không hợp lệ' });
  if (!validSlug(slug)) return send(res, 400, { error: 'slug không hợp lệ (a-z, 0-9, gạch ngang)' });
  const cover = parseCover(body.cover_image_key, ctx.shopId);
  if (!cover.ok) return send(res, 400, { error: 'ảnh bìa không hợp lệ (key media dạng <shop-id>/<media-id>.webp của chính shop)' });
  try {
    const id = await withTenant(ctx.shopId, async (c) => {
      const r = await c.query(
        `INSERT INTO blog_posts (shop_id, slug, title, excerpt, body, cover_image_key) VALUES (current_shop_id(), $1, $2, $3, $4, $5) RETURNING id`,
        [slug, title, excerpt, content, cover.val]);
      await audit(c, 'blog.created', { actorId: ctx.user.id, ip: ctx.ip, metadata: { slug } });
      return r.rows[0].id;
    });
    return send(res, 201, { id });
  } catch (err) {
    if (err.code === '23505') return send(res, 409, { error: 'slug bài viết đã tồn tại' });
    throw err;
  }
}

async function updatePost(res, ctx, body, params) {
  const sets = [], args = [];
  const add = (col, v) => { args.push(v); sets.push(`${col} = $${args.length}`); };
  if (body.title !== undefined) { if (!validTitle(body.title)) return send(res, 400, { error: 'tiêu đề không hợp lệ' }); add('title', String(body.title).trim()); }
  if (body.slug !== undefined) { const s = String(body.slug).toLowerCase().trim(); if (!validSlug(s)) return send(res, 400, { error: 'slug không hợp lệ' }); add('slug', s); }
  if (body.excerpt !== undefined) add('excerpt', String(body.excerpt ?? '').trim() !== '' ? String(body.excerpt).slice(0, 500) : null);
  if (body.body !== undefined) add('body', String(body.body ?? '').slice(0, 50000));
  if (body.cover_image_key !== undefined) {
    const cover = parseCover(body.cover_image_key, ctx.shopId);
    if (!cover.ok) return send(res, 400, { error: 'ảnh bìa không hợp lệ (key media dạng <shop-id>/<media-id>.webp của chính shop)' });
    add('cover_image_key', cover.val);
  }
  if (!sets.length) return send(res, 400, { error: 'không có gì để cập nhật' });
  sets.push('updated_at = now()');
  args.push(params[1]);
  try {
    const out = await withTenant(ctx.shopId, async (c) => {
      const r = await c.query(`UPDATE blog_posts SET ${sets.join(', ')} WHERE id = $${args.length}`, args);
      if (r.rowCount === 0) return { code: 404 };
      await audit(c, 'blog.updated', { actorId: ctx.user.id, ip: ctx.ip, metadata: { id: params[1] } });
      return { code: 200 };
    });
    if (out.code === 404) return send(res, 404, { error: 'không tìm thấy bài viết' });
    return send(res, 200, { ok: true });
  } catch (err) {
    if (err.code === '23505') return send(res, 409, { error: 'slug bài viết đã tồn tại' });
    throw err;
  }
}

function setStatus(status, action) {
  return async (res, ctx, _b, params) => {
    const out = await withTenant(ctx.shopId, async (c) => {
      const r = await c.query(
        `UPDATE blog_posts SET status = $2,
                published_at = CASE WHEN $2 = 'published' AND published_at IS NULL THEN now() ELSE published_at END,
                updated_at = now()
          WHERE id = $1`, [params[1], status]);
      if (r.rowCount === 0) return { code: 404 };
      await audit(c, action, { actorId: ctx.user.id, ip: ctx.ip, metadata: { id: params[1] } });
      return { code: 200 };
    });
    if (out.code === 404) return send(res, 404, { error: 'không tìm thấy bài viết' });
    return send(res, 200, { ok: true, status });
  };
}

async function deletePost(res, ctx, _b, params) {
  const out = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(`DELETE FROM blog_posts WHERE id = $1`, [params[1]]);
    if (r.rowCount === 0) return { code: 404 };
    await audit(c, 'blog.deleted', { actorId: ctx.user.id, ip: ctx.ip, metadata: { id: params[1] } });
    return { code: 200 };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy bài viết' });
  return send(res, 200, { ok: true });
}

export const BLOG_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/blog$`), perm: 'content.read', fn: (res, ctx) => listPosts(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/blog$`), perm: 'content.write', fn: (res, ctx, b) => createPost(res, ctx, b) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/blog/${UUID}$`), perm: 'content.read', fn: (res, ctx, b, p) => getPost(res, ctx, b, p) },
  { m: 'PATCH', re: new RegExp(`^/shops/${UUID}/blog/${UUID}$`), perm: 'content.write', fn: (res, ctx, b, p) => updatePost(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/blog/${UUID}/publish$`), perm: 'content.write', fn: (res, ctx, b, p) => setStatus('published', 'blog.published')(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/blog/${UUID}/unpublish$`), perm: 'content.write', fn: (res, ctx, b, p) => setStatus('draft', 'blog.unpublished')(res, ctx, b, p) },
  { m: 'DELETE', re: new RegExp(`^/shops/${UUID}/blog/${UUID}$`), perm: 'content.write', fn: (res, ctx, b, p) => deletePost(res, ctx, b, p) },
];
