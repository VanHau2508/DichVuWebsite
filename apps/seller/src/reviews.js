/**
 * Duyệt đánh giá sản phẩm (moderation). Khách gửi qua checkout → PENDING; chỉ shop
 * duyệt (approved) mới hiện trên storefront. Perm content.write (owner/admin).
 */
import { send } from './http.js';
import { withTenant, audit } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

async function listReviews(res, ctx, _b, _p, query) {
  const status = ['pending', 'approved', 'rejected'].includes(query.get('status')) ? query.get('status') : 'pending';
  const limit = Math.min(Math.max(parseInt(query.get('limit') ?? '50', 10) || 50, 1), 100);
  const data = await withTenant(ctx.shopId, async (c) => {
    const rows = (await c.query(
      `SELECT r.id, r.product_id, r.rating, r.author_name, r.content, r.verified, r.status, r.created_at,
              p.title AS product_title, p.slug AS product_slug,
              (SELECT count(*)::int FROM product_reviews WHERE status = 'pending') AS pending_count
         FROM product_reviews r JOIN products p ON p.id = r.product_id
        WHERE r.status = $1 ORDER BY r.created_at DESC LIMIT ${limit}`, [status])).rows;
    return { reviews: rows, pending_count: rows[0]?.pending_count ?? Number((await c.query(`SELECT count(*)::int n FROM product_reviews WHERE status = 'pending'`)).rows[0].n) };
  });
  return send(res, 200, { ...data, status });
}

function setStatus(newStatus, action) {
  return async (res, ctx, _b, params) => {
    const rid = params[1];
    const n = await withTenant(ctx.shopId, async (c) => {
      const r = await c.query(`UPDATE product_reviews SET status = $2 WHERE id = $1`, [rid, newStatus]);
      if (r.rowCount === 1) await audit(c, action, { actorId: ctx.user.id, ip: ctx.ip, metadata: { reviewId: rid } });
      return r.rowCount;
    });
    if (n !== 1) return send(res, 404, { error: 'không tìm thấy đánh giá' });
    return send(res, 200, { ok: true, status: newStatus });
  };
}

async function deleteReview(res, ctx, _b, params) {
  const rid = params[1];
  const n = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(`DELETE FROM product_reviews WHERE id = $1`, [rid]);
    if (r.rowCount === 1) await audit(c, 'review.deleted', { actorId: ctx.user.id, ip: ctx.ip, metadata: { reviewId: rid } });
    return r.rowCount;
  });
  if (n !== 1) return send(res, 404, { error: 'không tìm thấy đánh giá' });
  return send(res, 200, { ok: true });
}

export const REVIEW_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/reviews$`), perm: 'content.write', fn: (res, ctx, b, p, q) => listReviews(res, ctx, b, p, q) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/reviews/${UUID}/approve$`), perm: 'content.write', fn: setStatus('approved', 'review.approved') },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/reviews/${UUID}/reject$`), perm: 'content.write', fn: setStatus('rejected', 'review.rejected') },
  { m: 'DELETE', re: new RegExp(`^/shops/${UUID}/reviews/${UUID}$`), perm: 'content.write', fn: (res, ctx, b, p) => deleteReview(res, ctx, b, p) },
];
