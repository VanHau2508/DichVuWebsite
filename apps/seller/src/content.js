/**
 * Nội dung/trang (seller). Ngày 11.
 *
 * pages.blocks = DRAFT (sửa tự do). Publish → snapshot vào page_revisions +
 * trỏ published_revision_id. Storefront chỉ render bản published. Rollback = trỏ
 * published về revision cũ (không đụng draft). Block là text-only (storefront escape).
 */
import crypto from 'node:crypto';
import { send } from './http.js';
import { withTenant, audit } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const BLOCK_TYPES = new Set(['heading', 'paragraph', 'list', 'quote', 'divider']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isInt = (x) => Number.isInteger(x);
const PREVIEW_TTL_MIN = 30; // link preview sống ngắn — nó lộ nội dung chưa xuất bản
const genToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

/** Validate MỘT block/section theo type. Trả null nếu OK, hoặc chuỗi lỗi. */
function badBlock(b) {
  if (!b || typeof b !== 'object') return 'block không hợp lệ';
  if (!BLOCK_TYPES.has(b.type)) return `type block không hợp lệ: ${b.type}`;
  if (b.type === 'heading' || b.type === 'paragraph' || b.type === 'quote') {
    if (typeof b.text !== 'string' || b.text.length > 5000) return 'text block không hợp lệ';
    if (b.type === 'quote' && b.cite != null && b.cite !== '' && (typeof b.cite !== 'string' || b.cite.length > 200)) return 'cite không hợp lệ';
  } else if (b.type === 'list') {
    if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 50) return 'list không hợp lệ';
    for (const it of b.items) if (typeof it !== 'string' || it.length > 500) return 'mục list không hợp lệ';
  }
  return null; // divider: không có field bắt buộc
}

/** Validate cả mảng blocks. */
function badBlocks(blocks) {
  if (!Array.isArray(blocks)) return 'blocks phải là mảng';
  if (blocks.length > 100) return 'tối đa 100 block';
  for (const b of blocks) { const e = badBlock(b); if (e) return e; }
  return null;
}

/**
 * Chuẩn hoá block: gán id ỔN ĐỊNH (kéo–thả cần id để tham chiếu), CHỈ giữ field hợp lệ
 * theo type (bỏ mọi key lạ → không lưu rác/độc), id trùng/không hợp lệ thì cấp mới.
 * Gọi SAU badBlocks nên field đã hợp lệ.
 */
function normalizeBlocks(blocks) {
  const seen = new Set();
  return blocks.map((b) => {
    let id = typeof b.id === 'string' && UUID_RE.test(b.id) && !seen.has(b.id) ? b.id : crypto.randomUUID();
    seen.add(id);
    if (b.type === 'list') return { id, type: 'list', items: b.items.map((x) => String(x)) };
    if (b.type === 'divider') return { id, type: 'divider' };
    if (b.type === 'quote') return b.cite != null && b.cite !== '' ? { id, type: 'quote', text: b.text, cite: b.cite } : { id, type: 'quote', text: b.text };
    return { id, type: b.type, text: b.text }; // heading | paragraph
  });
}
const validTitle = (x) => typeof x === 'string' && x.trim().length >= 1 && x.length <= 200;

// SEO tuỳ chọn: chuỗi (rỗng/không có → null để "xoá"). Giới hạn theo thực dụng SEO.
const SEO_MAX = { seo_title: 120, seo_description: 320 };
const validSeo = (x, max) => x === null || x === undefined || (typeof x === 'string' && x.length <= max);
const normSeo = (x) => { const s = String(x ?? '').trim(); return s === '' ? null : s; };

async function listPages(res, ctx) {
  const rows = await withTenant(ctx.shopId, async (c) => (await c.query(
    `SELECT id, slug, title, status, menu_position, published_revision_id, updated_at
       FROM pages WHERE deleted_at IS NULL ORDER BY menu_position NULLS LAST, title`,
  )).rows);
  return send(res, 200, { pages: rows });
}

async function createPage(res, ctx, body) {
  const slug = String(body.slug ?? '').toLowerCase().trim();
  const title = String(body.title ?? '').trim();
  const blocks = body.blocks ?? [];
  if (!SLUG_RE.test(slug)) return send(res, 400, { error: 'slug không hợp lệ' });
  if (!validTitle(title)) return send(res, 400, { error: 'tiêu đề không hợp lệ' });
  const bb = badBlocks(blocks);
  if (bb) return send(res, 400, { error: bb });
  if (!validSeo(body.seo_title, SEO_MAX.seo_title)) return send(res, 400, { error: 'seo_title quá dài' });
  if (!validSeo(body.seo_description, SEO_MAX.seo_description)) return send(res, 400, { error: 'seo_description quá dài' });
  try {
    const id = await withTenant(ctx.shopId, async (c) => {
      const r = await c.query(
        `INSERT INTO pages (shop_id, slug, title, blocks, seo_title, seo_description)
         VALUES (current_shop_id(), $1, $2, $3, $4, $5) RETURNING id`,
        [slug, title, JSON.stringify(normalizeBlocks(blocks)), normSeo(body.seo_title), normSeo(body.seo_description)],
      );
      await audit(c, 'page.created', { actorId: ctx.user.id, ip: ctx.ip, metadata: { slug } });
      return r.rows[0].id;
    });
    return send(res, 201, { id, slug, status: 'draft' });
  } catch (err) {
    if (err.code === '23505') return send(res, 409, { error: 'slug trang đã tồn tại' });
    throw err;
  }
}

async function getPage(res, ctx, _b, params) {
  const pageId = params[1];
  const data = await withTenant(ctx.shopId, async (c) => {
    const p = (await c.query(
      `SELECT p.id, p.slug, p.title, p.blocks, p.status, p.menu_position, p.updated_at,
              p.seo_title, p.seo_description, pr.revision AS published_revision
         FROM pages p LEFT JOIN page_revisions pr ON pr.id = p.published_revision_id
        WHERE p.id = $1 AND p.deleted_at IS NULL`, [pageId],
    )).rows[0];
    if (!p) return null;
    p.revisions = (await c.query(`SELECT revision, title, created_at FROM page_revisions WHERE page_id = $1 ORDER BY revision DESC`, [pageId])).rows;
    return p;
  });
  if (!data) return send(res, 404, { error: 'không tìm thấy trang' });
  return send(res, 200, data);
}

async function updatePage(res, ctx, body, params) {
  const pageId = params[1];
  const sets = [];
  const args = [];
  const add = (col, val) => { args.push(val); sets.push(`${col} = $${args.length}`); };
  if (body.title !== undefined) { if (!validTitle(body.title)) return send(res, 400, { error: 'tiêu đề không hợp lệ' }); add('title', String(body.title).trim()); }
  if (body.blocks !== undefined) { const bb = badBlocks(body.blocks); if (bb) return send(res, 400, { error: bb }); add('blocks', JSON.stringify(normalizeBlocks(body.blocks))); }
  if (body.menu_position !== undefined) {
    if (body.menu_position !== null && !isInt(body.menu_position)) return send(res, 400, { error: 'menu_position không hợp lệ' });
    add('menu_position', body.menu_position);
  }
  if (body.seo_title !== undefined) { if (!validSeo(body.seo_title, SEO_MAX.seo_title)) return send(res, 400, { error: 'seo_title quá dài' }); add('seo_title', normSeo(body.seo_title)); }
  if (body.seo_description !== undefined) { if (!validSeo(body.seo_description, SEO_MAX.seo_description)) return send(res, 400, { error: 'seo_description quá dài' }); add('seo_description', normSeo(body.seo_description)); }
  if (sets.length === 0) return send(res, 400, { error: 'không có trường nào để cập nhật' });
  const n = await withTenant(ctx.shopId, async (c) => {
    args.push(pageId);
    const r = await c.query(`UPDATE pages SET ${sets.join(', ')}, updated_at = now() WHERE id = $${args.length} AND deleted_at IS NULL`, args);
    if (r.rowCount === 1) await audit(c, 'page.updated', { actorId: ctx.user.id, ip: ctx.ip, metadata: { pageId } });
    return r.rowCount;
  });
  if (n !== 1) return send(res, 404, { error: 'không tìm thấy trang' });
  return send(res, 200, { ok: true });
}

async function publishPage(res, ctx, _b, params) {
  const pageId = params[1];
  const out = await withTenant(ctx.shopId, async (c) => {
    const p = (await c.query(`SELECT id, title, blocks, seo_title, seo_description FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [pageId])).rows[0];
    if (!p) return { code: 404 };
    const maxRev = (await c.query(`SELECT coalesce(max(revision), 0) AS m FROM page_revisions WHERE page_id = $1`, [pageId])).rows[0].m;
    const rev = (await c.query(
      `INSERT INTO page_revisions (shop_id, page_id, revision, title, blocks, seo_title, seo_description, created_by)
       VALUES (current_shop_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING id, revision`,
      [pageId, maxRev + 1, p.title, JSON.stringify(p.blocks), p.seo_title, p.seo_description, ctx.user.id],
    )).rows[0];
    await c.query(`UPDATE pages SET status = 'published', published_revision_id = $1, updated_at = now() WHERE id = $2`, [rev.id, pageId]);
    await audit(c, 'page.published', { actorId: ctx.user.id, ip: ctx.ip, metadata: { pageId, revision: rev.revision } });
    return { code: 200, revision: rev.revision };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy trang' });
  return send(res, 200, { ok: true, status: 'published', revision: out.revision });
}

async function rollbackPage(res, ctx, body, params) {
  const pageId = params[1];
  const revision = body.revision;
  if (!isInt(revision) || revision < 1) return send(res, 400, { error: 'revision không hợp lệ' });
  const out = await withTenant(ctx.shopId, async (c) => {
    const p = (await c.query(`SELECT id FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [pageId])).rows[0];
    if (!p) return { code: 404 };
    const target = (await c.query(`SELECT id, revision FROM page_revisions WHERE page_id = $1 AND revision = $2`, [pageId, revision])).rows[0];
    if (!target) return { code: 409 };
    // Rollback: trỏ published về revision cũ. KHÔNG đụng draft (pages.blocks).
    await c.query(`UPDATE pages SET published_revision_id = $1, status = 'published', updated_at = now() WHERE id = $2`, [target.id, pageId]);
    await audit(c, 'page.rolled_back', { actorId: ctx.user.id, ip: ctx.ip, metadata: { pageId, revision } });
    return { code: 200, revision: target.revision };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy trang' });
  if (out.code === 409) return send(res, 409, { error: 'không có revision đó' });
  return send(res, 200, { ok: true, published_revision: out.revision });
}

async function deletePage(res, ctx, _b, params) {
  const pageId = params[1];
  const n = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(`UPDATE pages SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [pageId]);
    if (r.rowCount === 1) {
      // Dọn preview còn treo: trang đã xoá thì link preview cũng phải chết ngay.
      await c.query(`DELETE FROM page_previews WHERE page_id = $1`, [pageId]);
      await audit(c, 'page.deleted', { actorId: ctx.user.id, ip: ctx.ip, metadata: { pageId } });
    }
    return r.rowCount;
  });
  if (n !== 1) return send(res, 404, { error: 'không tìm thấy trang' });
  return send(res, 200, { ok: true });
}

// Chụp draft hiện tại thành snapshot + token ngắn hạn → link xem trước trên storefront.
// content.read: xem trước là hành vi ĐỌC draft của chính shop (owner/admin đều có).
async function previewPage(res, ctx, _b, params) {
  const pageId = params[1];
  const token = genToken();
  const out = await withTenant(ctx.shopId, async (c) => {
    const p = (await c.query(`SELECT slug, title, blocks, seo_title, seo_description FROM pages WHERE id = $1 AND deleted_at IS NULL`, [pageId])).rows[0];
    if (!p) return null;
    await c.query(
      `INSERT INTO page_previews (shop_id, page_id, token_hash, slug, title, blocks, seo_title, seo_description, expires_at)
       VALUES (current_shop_id(), $1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' minutes')::interval)
       ON CONFLICT (shop_id, page_id) DO UPDATE SET
         token_hash = EXCLUDED.token_hash, slug = EXCLUDED.slug, title = EXCLUDED.title,
         blocks = EXCLUDED.blocks, seo_title = EXCLUDED.seo_title, seo_description = EXCLUDED.seo_description,
         created_at = now(), expires_at = EXCLUDED.expires_at`,
      [pageId, hashToken(token), p.slug, p.title, JSON.stringify(p.blocks), p.seo_title, p.seo_description, String(PREVIEW_TTL_MIN)],
    );
    // Host chính của shop (để dựng URL đầy đủ). app_rw đọc được domains của shop mình (RLS).
    const host = (await c.query(`SELECT hostname FROM domains WHERE is_primary`)).rows[0]?.hostname ?? null;
    await audit(c, 'page.previewed', { actorId: ctx.user.id, ip: ctx.ip, metadata: { pageId } });
    return { slug: p.slug, host };
  });
  if (!out) return send(res, 404, { error: 'không tìm thấy trang' });
  const path = `/pages/${out.slug}?preview=${token}`;
  return send(res, 201, {
    preview_url: out.host ? `https://${out.host}${path}` : null,
    path,
    token,
    expires_in: PREVIEW_TTL_MIN * 60,
  });
}

// ── Thao tác section trên DRAFT (kéo–thả) ────────────────────────────────────
// Tất cả đọc–sửa–ghi pages.blocks dưới FOR UPDATE để hai thao tác đồng thời không
// giẫm nhau (mất block). Đều là content.write; chỉ đụng DRAFT — muốn lên live phải publish.
const readBlocks = (p) => normalizeBlocks(Array.isArray(p.blocks) ? p.blocks : []);
const lockPage = (c, pageId) => c.query(`SELECT blocks FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [pageId]);
const saveBlocks = (c, pageId, blocks) => c.query(`UPDATE pages SET blocks = $1, updated_at = now() WHERE id = $2`, [JSON.stringify(blocks), pageId]);

async function addBlock(res, ctx, body, params) {
  const pageId = params[1];
  const nb = { type: body.type, text: body.text, items: body.items, cite: body.cite };
  const e = badBlock(nb);
  if (e) return send(res, 400, { error: e });
  if (body.index != null && (!isInt(body.index) || body.index < 0)) return send(res, 400, { error: 'index không hợp lệ' });
  const out = await withTenant(ctx.shopId, async (c) => {
    const p = (await lockPage(c, pageId)).rows[0];
    if (!p) return { code: 404 };
    const blocks = readBlocks(p);
    if (blocks.length >= 100) return { code: 400 };
    const [nblk] = normalizeBlocks([nb]);
    const at = body.index == null ? blocks.length : Math.min(body.index, blocks.length);
    blocks.splice(at, 0, nblk);
    await saveBlocks(c, pageId, blocks);
    await audit(c, 'page.block_added', { actorId: ctx.user.id, ip: ctx.ip, metadata: { pageId, blockId: nblk.id } });
    return { code: 201, id: nblk.id };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy trang' });
  if (out.code === 400) return send(res, 400, { error: 'tối đa 100 block' });
  return send(res, 201, { id: out.id });
}

async function updateBlock(res, ctx, body, params) {
  const pageId = params[1], blockId = params[2];
  const nb = { type: body.type, text: body.text, items: body.items, cite: body.cite };
  const e = badBlock(nb);
  if (e) return send(res, 400, { error: e });
  const out = await withTenant(ctx.shopId, async (c) => {
    const p = (await lockPage(c, pageId)).rows[0];
    if (!p) return { code: 404 };
    const blocks = readBlocks(p);
    const i = blocks.findIndex((b) => b.id === blockId);
    if (i === -1) return { code: 410 };
    [blocks[i]] = normalizeBlocks([{ ...nb, id: blockId }]); // giữ id + vị trí, thay nội dung
    await saveBlocks(c, pageId, blocks);
    await audit(c, 'page.block_updated', { actorId: ctx.user.id, ip: ctx.ip, metadata: { pageId, blockId } });
    return { code: 200 };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy trang' });
  if (out.code === 410) return send(res, 404, { error: 'không tìm thấy block' });
  return send(res, 200, { ok: true });
}

async function deleteBlock(res, ctx, _b, params) {
  const pageId = params[1], blockId = params[2];
  const out = await withTenant(ctx.shopId, async (c) => {
    const p = (await lockPage(c, pageId)).rows[0];
    if (!p) return { code: 404 };
    const blocks = readBlocks(p);
    const next = blocks.filter((b) => b.id !== blockId);
    if (next.length === blocks.length) return { code: 410 };
    await saveBlocks(c, pageId, next);
    await audit(c, 'page.block_deleted', { actorId: ctx.user.id, ip: ctx.ip, metadata: { pageId, blockId } });
    return { code: 200 };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy trang' });
  if (out.code === 410) return send(res, 404, { error: 'không tìm thấy block' });
  return send(res, 200, { ok: true });
}

// Kết quả KÉO–THẢ: client gửi thứ tự id mới. order PHẢI là hoán vị đúng của tập id
// hiện có (đủ số, đủ tập, không lặp) → không thể lén thêm/bớt/nhân bản block qua reorder.
async function reorderBlocks(res, ctx, body, params) {
  const pageId = params[1];
  const order = body.order;
  if (!Array.isArray(order) || order.some((x) => typeof x !== 'string')) return send(res, 400, { error: 'order phải là mảng id' });
  const out = await withTenant(ctx.shopId, async (c) => {
    const p = (await lockPage(c, pageId)).rows[0];
    if (!p) return { code: 404 };
    const blocks = readBlocks(p);
    const byId = new Map(blocks.map((b) => [b.id, b]));
    if (order.length !== blocks.length || new Set(order).size !== order.length || order.some((id) => !byId.has(id))) {
      return { code: 422 };
    }
    await saveBlocks(c, pageId, order.map((id) => byId.get(id)));
    await audit(c, 'page.blocks_reordered', { actorId: ctx.user.id, ip: ctx.ip, metadata: { pageId } });
    return { code: 200 };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy trang' });
  if (out.code === 422) return send(res, 422, { error: 'order phải là hoán vị đúng của các block hiện có' });
  return send(res, 200, { ok: true });
}

export const CONTENT_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/pages$`), perm: 'content.read', fn: (res, ctx) => listPages(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/pages$`), perm: 'content.write', fn: (res, ctx, b) => createPage(res, ctx, b) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/pages/${UUID}$`), perm: 'content.read', fn: (res, ctx, b, p) => getPage(res, ctx, b, p) },
  { m: 'PATCH', re: new RegExp(`^/shops/${UUID}/pages/${UUID}$`), perm: 'content.write', fn: (res, ctx, b, p) => updatePage(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/pages/${UUID}/publish$`), perm: 'content.write', fn: (res, ctx, b, p) => publishPage(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/pages/${UUID}/rollback$`), perm: 'content.write', fn: (res, ctx, b, p) => rollbackPage(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/pages/${UUID}/preview$`), perm: 'content.read', fn: (res, ctx, b, p) => previewPage(res, ctx, b, p) },
  // Kéo–thả section (thao tác trên draft): thêm / sửa / xoá / sắp lại thứ tự.
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/pages/${UUID}/blocks$`), perm: 'content.write', fn: (res, ctx, b, p) => addBlock(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/pages/${UUID}/blocks/reorder$`), perm: 'content.write', fn: (res, ctx, b, p) => reorderBlocks(res, ctx, b, p) },
  { m: 'PATCH', re: new RegExp(`^/shops/${UUID}/pages/${UUID}/blocks/${UUID}$`), perm: 'content.write', fn: (res, ctx, b, p) => updateBlock(res, ctx, b, p) },
  { m: 'DELETE', re: new RegExp(`^/shops/${UUID}/pages/${UUID}/blocks/${UUID}$`), perm: 'content.write', fn: (res, ctx, b, p) => deleteBlock(res, ctx, b, p) },
  { m: 'DELETE', re: new RegExp(`^/shops/${UUID}/pages/${UUID}$`), perm: 'content.write', fn: (res, ctx, b, p) => deletePage(res, ctx, b, p) },
];
