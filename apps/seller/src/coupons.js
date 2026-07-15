/**
 * Mã giảm giá (coupon) của shop. CRUD dưới app_rw (RLS tenant). catalog.read xem, catalog.write sửa.
 * Checkout (app_checkout) validate + tăng used_count khi tạo đơn — xem apps/checkout.
 */
import { send } from './http.js';
import { withTenant, audit } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,39}$/; // 3–40 ký tự, HOA/số/gạch, đầu là chữ-số

async function listCoupons(res, ctx) {
  const rows = await withTenant(ctx.shopId, async (c) =>
    (await c.query(
      `SELECT id, code, kind, value, min_subtotal_vnd, max_uses, used_count, expires_at, active, created_at
         FROM coupons WHERE shop_id = current_shop_id() ORDER BY active DESC, created_at DESC`)).rows);
  return send(res, 200, { coupons: rows });
}

async function createCoupon(res, ctx, body) {
  const code = String(body.code ?? '').trim().toUpperCase();
  const kind = body.kind === 'fixed' ? 'fixed' : body.kind === 'percent' ? 'percent' : null;
  const value = Number(body.value);
  const minSub = body.min_subtotal_vnd != null && body.min_subtotal_vnd !== '' ? Number(body.min_subtotal_vnd) : 0;
  const maxUses = body.max_uses != null && body.max_uses !== '' ? Number(body.max_uses) : null;
  if (!CODE_RE.test(code)) return send(res, 400, { error: 'mã: 3–40 ký tự, chữ HOA/số/gạch ngang' });
  if (!kind) return send(res, 400, { error: 'loại giảm phải là percent hoặc fixed' });
  if (!Number.isInteger(value) || value <= 0) return send(res, 400, { error: 'giá trị giảm phải là số nguyên dương' });
  if (kind === 'percent' && value > 100) return send(res, 400, { error: 'phần trăm giảm tối đa 100' });
  if (kind === 'fixed' && value > 100000000) return send(res, 400, { error: 'số tiền giảm quá lớn' });
  if (!Number.isInteger(minSub) || minSub < 0 || minSub > 100000000000) return send(res, 400, { error: 'đơn tối thiểu không hợp lệ' });
  if (maxUses != null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000000)) return send(res, 400, { error: 'số lượt tối đa: 1–1.000.000' });
  let exp = null;
  if (body.expires_at) {
    const d = new Date(String(body.expires_at));
    if (Number.isNaN(d.getTime())) return send(res, 400, { error: 'ngày hết hạn không hợp lệ' });
    if (d.getTime() <= Date.now()) return send(res, 400, { error: 'ngày hết hạn phải ở tương lai' });
    exp = d.toISOString();
  }
  const out = await withTenant(ctx.shopId, async (c) => {
    try {
      const r = await c.query(
        `INSERT INTO coupons (shop_id, code, kind, value, min_subtotal_vnd, max_uses, expires_at)
         VALUES (current_shop_id(), $1, $2, $3, $4, $5, $6) RETURNING id`,
        [code, kind, value, minSub, maxUses, exp]);
      await audit(c, 'coupon.created', { actorId: ctx.user.id, ip: ctx.ip, metadata: { code, kind, value } });
      return { id: r.rows[0].id };
    } catch (e) { if (e.code === '23505') return { dup: true }; throw e; }
  });
  if (out.dup) return send(res, 409, { error: 'mã này đã tồn tại' });
  return send(res, 201, { id: out.id, code });
}

async function updateCoupon(res, ctx, body, params) {
  const id = params[1];
  if (body.active === undefined || body.active === null) return send(res, 400, { error: 'thiếu trạng thái active' }); // tránh PATCH thiếu field vô tình TẮT coupon
  const active = body.active === true || body.active === 'true' || body.active === '1';
  const out = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(`UPDATE coupons SET active = $2 WHERE id = $1 AND shop_id = current_shop_id()`, [id, active]);
    if (r.rowCount === 1) await audit(c, 'coupon.updated', { actorId: ctx.user.id, ip: ctx.ip, metadata: { id, active } });
    return r.rowCount;
  });
  return send(res, out === 1 ? 200 : 404, out === 1 ? { ok: true, active } : { error: 'không tìm thấy mã' });
}

async function deleteCoupon(res, ctx, _body, params) {
  const id = params[1];
  const out = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(`DELETE FROM coupons WHERE id = $1 AND shop_id = current_shop_id()`, [id]);
    if (r.rowCount === 1) await audit(c, 'coupon.deleted', { actorId: ctx.user.id, ip: ctx.ip, metadata: { id } });
    return r.rowCount;
  });
  return send(res, out === 1 ? 200 : 404, out === 1 ? { ok: true } : { error: 'không tìm thấy mã' });
}

export const COUPON_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/coupons$`), perm: 'catalog.read', fn: (res, ctx) => listCoupons(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/coupons$`), perm: 'catalog.write', fn: (res, ctx, b) => createCoupon(res, ctx, b) },
  { m: 'PATCH', re: new RegExp(`^/shops/${UUID}/coupons/${UUID}$`), perm: 'catalog.write', fn: (res, ctx, b, p) => updateCoupon(res, ctx, b, p) },
  { m: 'DELETE', re: new RegExp(`^/shops/${UUID}/coupons/${UUID}$`), perm: 'catalog.write', fn: (res, ctx, b, p) => deleteCoupon(res, ctx, b, p) },
];
