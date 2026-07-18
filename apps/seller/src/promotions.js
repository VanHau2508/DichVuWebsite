/**
 * Khuyến mãi tự động / Flash sale (0082). CRUD dưới app_rw (RLS tenant). catalog.read xem,
 * catalog.write sửa. Storefront/checkout (app_store/app_checkout) tính giá qua hàm
 * promo_effective — xem apps/storefront + apps/checkout. Live-ness = active AND now()∈khung
 * giờ (không worker/cron). ĐƠN TAY/SỬA ĐƠN KHÔNG áp promo (khác storefront — tránh lệch tiền COD).
 */
import { send } from './http.js';
import { withTenant, audit } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_ACTIVE = 50;               // trần promo active/shop — bound chi phí LATERAL + chống lạm dụng
const MAX_FIXED = 100000000;         // 100 triệu

// Parse datetime-local (giờ VN wall-clock) → Date instant. Gắn offset +07:00 TƯỜNG MINH —
// KHÔNG dùng new Date(naive) như coupons.js (Node TZ=UTC → lệch 7h, sai cả khung giờ).
// Kiểm ngày THẬT: format lại theo VN phải khớp input (chặn 2026-02-31 rollover).
function parseVN(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+07:00`);
  if (Number.isNaN(d.getTime())) return null;
  // Roundtrip qua giờ VN → chặn ngày không tồn tại (JS cuộn 02-31 → 03-03).
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
  const back = `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
  return back === `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` ? d : null;
}
// Trạng thái hiển thị (server-side): tắt tay / sắp diễn ra / đang chạy / đã kết thúc.
function statusOf(row, nowMs) {
  if (!row.active) return 'off';
  const s = new Date(row.starts_at).getTime(), e = new Date(row.ends_at).getTime();
  return nowMs < s ? 'upcoming' : nowMs < e ? 'running' : 'ended';
}

async function listPromotions(res, ctx) {
  const now = Date.now();
  const rows = await withTenant(ctx.shopId, async (c) =>
    (await c.query(
      `SELECT p.id, p.title, p.kind, p.value, p.scope, p.starts_at, p.ends_at, p.active, p.created_at,
              (SELECT count(*)::int FROM promotion_products pp WHERE pp.promotion_id = p.id) AS product_count
         FROM promotions p WHERE p.shop_id = current_shop_id()
        ORDER BY p.active DESC, p.starts_at DESC`)).rows);
  return send(res, 200, { promotions: rows.map((r) => ({ ...r, status: statusOf(r, now) })) });
}

async function getPromotion(res, ctx, _body, params) {
  const id = params[1];
  const out = await withTenant(ctx.shopId, async (c) => {
    const p = (await c.query(
      `SELECT id, title, kind, value, scope, starts_at, ends_at, active, created_at
         FROM promotions WHERE id = $1 AND shop_id = current_shop_id()`, [id])).rows[0];
    if (!p) return null;
    // SP trong phạm vi (scope='products') — kèm giá để cảnh báo fixed ≥ giá.
    const products = p.scope === 'products'
      ? (await c.query(
          `SELECT pp.product_id, pr.title, pr.price_vnd
             FROM promotion_products pp JOIN products pr ON pr.id = pp.product_id
            WHERE pp.promotion_id = $1 ORDER BY pr.title`, [id])).rows
      : [];
    return { ...p, status: statusOf(p, Date.now()), products };
  });
  return out ? send(res, 200, out) : send(res, 404, { error: 'không tìm thấy chương trình' });
}

// Cảnh báo (không chặn) khi giảm CỐ ĐỊNH ≥ giá SP rẻ nhất trong phạm vi → có SP về 0đ.
async function fixedWarning(c, kind, value, scope) {
  if (kind !== 'fixed') return null;
  const q = scope === 'all'
    ? `SELECT min(price_vnd)::bigint AS m FROM products WHERE deleted_at IS NULL AND status = 'active'`
    : null; // scope='products' chưa có SP lúc tạo (thêm sau) → cảnh báo khi thêm
  if (!q) return null;
  const min = (await c.query(q)).rows[0]?.m;
  return (min != null && Number(value) >= Number(min)) ? `Giảm ${value}đ ≥ giá sản phẩm rẻ nhất (${min}đ) — một số sản phẩm sẽ về 0đ.` : null;
}

async function createPromotion(res, ctx, body) {
  const title = String(body.title ?? '').trim().slice(0, 120);
  const kind = body.kind === 'fixed' ? 'fixed' : body.kind === 'percent' ? 'percent' : null;
  const value = Number(body.value);
  const scope = body.scope === 'products' ? 'products' : body.scope === 'all' ? 'all' : null;
  if (!title) return send(res, 400, { error: 'thiếu tên chương trình' });
  if (!kind) return send(res, 400, { error: 'loại giảm phải là percent hoặc fixed' });
  if (!scope) return send(res, 400, { error: 'phạm vi phải là all hoặc products' });
  if (!Number.isInteger(value) || value <= 0) return send(res, 400, { error: 'giá trị giảm phải là số nguyên dương' });
  if (kind === 'percent' && value > 100) return send(res, 400, { error: 'phần trăm giảm tối đa 100' });
  if (kind === 'fixed' && value > MAX_FIXED) return send(res, 400, { error: 'số tiền giảm quá lớn' });
  const starts = parseVN(body.starts_at), ends = parseVN(body.ends_at);
  if (!starts) return send(res, 400, { error: 'thời gian bắt đầu không hợp lệ' });
  if (!ends) return send(res, 400, { error: 'thời gian kết thúc không hợp lệ' });
  if (ends.getTime() <= starts.getTime()) return send(res, 400, { error: 'kết thúc phải sau bắt đầu' });
  if (ends.getTime() <= Date.now()) return send(res, 400, { error: 'thời gian kết thúc phải ở tương lai' });

  const out = await withTenant(ctx.shopId, async (c) => {
    // Cap 50 promo ĐANG active (kể cả sắp/đang/hết-nhưng-chưa-tắt). Khoá đọc → chống đua thô.
    const nActive = Number((await c.query(`SELECT count(*)::int n FROM promotions WHERE shop_id = current_shop_id() AND active`)).rows[0].n);
    if (nActive >= MAX_ACTIVE) return { capped: true };
    const warn = await fixedWarning(c, kind, value, scope);
    const r = await c.query(
      `INSERT INTO promotions (shop_id, title, kind, value, scope, starts_at, ends_at)
       VALUES (current_shop_id(), $1, $2, $3, $4, $5, $6) RETURNING id`,
      [title, kind, value, scope, starts.toISOString(), ends.toISOString()]);
    await audit(c, 'promotion.created', { actorId: ctx.user.id, ip: ctx.ip, metadata: { id: r.rows[0].id, title, kind, value, scope } });
    return { id: r.rows[0].id, warn };
  });
  if (out.capped) return send(res, 409, { error: `Đã đạt trần ${MAX_ACTIVE} chương trình đang bật — tắt bớt trước khi tạo mới.` });
  return send(res, 201, { id: out.id, ...(out.warn ? { warning: out.warn } : {}) });
}

async function updatePromotion(res, ctx, body, params) {
  const id = params[1];
  // Chỉ nhận các trường gửi lên; "kết thúc sớm" = active:false. Audit from→to.
  const sets = [], args = [], changed = {};
  const cur0 = {};
  const out = await withTenant(ctx.shopId, async (c) => {
    const cur = (await c.query(`SELECT title, kind, value, scope, starts_at, ends_at, active FROM promotions WHERE id = $1 AND shop_id = current_shop_id() FOR UPDATE`, [id])).rows[0];
    if (!cur) return { code: 404 };
    Object.assign(cur0, cur);
    if (body.title !== undefined) { const t = String(body.title).trim().slice(0, 120); if (!t) return { code: 400, msg: 'tên rỗng' }; args.push(t); sets.push(`title = $${args.length}`); if (t !== cur.title) changed.title = { from: cur.title, to: t }; }
    if (body.value !== undefined) {
      const v = Number(body.value);
      const kind = cur.kind;
      if (!Number.isInteger(v) || v <= 0 || (kind === 'percent' && v > 100) || (kind === 'fixed' && v > MAX_FIXED)) return { code: 400, msg: 'giá trị giảm không hợp lệ' };
      args.push(v); sets.push(`value = $${args.length}`); if (v !== Number(cur.value)) changed.value = { from: Number(cur.value), to: v };
    }
    if (body.starts_at !== undefined) { const d = parseVN(body.starts_at); if (!d) return { code: 400, msg: 'thời gian bắt đầu không hợp lệ' }; args.push(d.toISOString()); sets.push(`starts_at = $${args.length}`); changed.starts_at = { from: cur.starts_at, to: d.toISOString() }; }
    if (body.ends_at !== undefined) { const d = parseVN(body.ends_at); if (!d) return { code: 400, msg: 'thời gian kết thúc không hợp lệ' }; args.push(d.toISOString()); sets.push(`ends_at = $${args.length}`); changed.ends_at = { from: cur.ends_at, to: d.toISOString() }; }
    if (body.active !== undefined) { const a = body.active === true || body.active === 'true' || body.active === '1'; args.push(a); sets.push(`active = $${args.length}`); if (a !== cur.active) changed.active = { from: cur.active, to: a }; }
    if (!sets.length) return { code: 400, msg: 'không có trường nào để cập nhật' };
    // Ràng buộc khung giờ sau khi gộp giá trị mới (DB CHECK ends>starts cũng chặn, nhưng báo lỗi thân thiện).
    const newStarts = new Date(changed.starts_at?.to ?? cur.starts_at).getTime();
    const newEnds = new Date(changed.ends_at?.to ?? cur.ends_at).getTime();
    if (newEnds <= newStarts) return { code: 400, msg: 'kết thúc phải sau bắt đầu' };
    args.push(id);
    const r = await c.query(`UPDATE promotions SET ${sets.join(', ')} WHERE id = $${args.length} AND shop_id = current_shop_id()`, args);
    if (r.rowCount === 1 && Object.keys(changed).length) await audit(c, 'promotion.updated', { actorId: ctx.user.id, ip: ctx.ip, metadata: { id, title: cur.title, changed } });
    return { code: r.rowCount === 1 ? 200 : 404 };
  });
  if (out.code === 400) return send(res, 400, { error: out.msg });
  return send(res, out.code, out.code === 200 ? { ok: true } : { error: 'không tìm thấy chương trình' });
}

async function deletePromotion(res, ctx, _body, params) {
  const id = params[1];
  const out = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(`DELETE FROM promotions WHERE id = $1 AND shop_id = current_shop_id()`, [id]); // CASCADE promotion_products
    if (r.rowCount === 1) await audit(c, 'promotion.deleted', { actorId: ctx.user.id, ip: ctx.ip, metadata: { id } });
    return r.rowCount;
  });
  return send(res, out === 1 ? 200 : 404, out === 1 ? { ok: true } : { error: 'không tìm thấy chương trình' });
}

async function addProduct(res, ctx, body, params) {
  const id = params[1];
  const productId = String(body.product_id ?? '');
  if (!UUID_RE.test(productId)) return send(res, 400, { error: 'product_id không hợp lệ' });
  const out = await withTenant(ctx.shopId, async (c) => {
    const p = (await c.query(`SELECT scope FROM promotions WHERE id = $1 AND shop_id = current_shop_id()`, [id])).rows[0];
    if (!p) return { code: 404 };
    if (p.scope !== 'products') return { code: 400, msg: 'chương trình phạm vi TOÀN SHOP — không chọn từng sản phẩm' };
    // FK composite chặn SP không thuộc shop; ON CONFLICT né trùng.
    try {
      await c.query(
        `INSERT INTO promotion_products (shop_id, promotion_id, product_id) VALUES (current_shop_id(), $1, $2) ON CONFLICT DO NOTHING`, [id, productId]);
    } catch (e) { if (e.code === '23503') return { code: 400, msg: 'sản phẩm không tồn tại trong shop' }; throw e; }
    await audit(c, 'promotion.product_added', { actorId: ctx.user.id, ip: ctx.ip, metadata: { id, product_id: productId } });
    return { code: 200 };
  });
  if (out.code === 400) return send(res, 400, { error: out.msg });
  return send(res, out.code, out.code === 200 ? { ok: true } : { error: 'không tìm thấy chương trình' });
}

async function removeProduct(res, ctx, _body, params) {
  const id = params[1], productId = params[2];
  const out = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(`DELETE FROM promotion_products WHERE promotion_id = $1 AND product_id = $2 AND shop_id = current_shop_id()`, [id, productId]);
    if (r.rowCount === 1) await audit(c, 'promotion.product_removed', { actorId: ctx.user.id, ip: ctx.ip, metadata: { id, product_id: productId } });
    return r.rowCount;
  });
  return send(res, out === 1 ? 200 : 404, out === 1 ? { ok: true } : { error: 'không tìm thấy dòng' });
}

export const PROMOTION_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/promotions$`), perm: 'catalog.read', fn: (res, ctx) => listPromotions(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/promotions$`), perm: 'catalog.write', fn: (res, ctx, b) => createPromotion(res, ctx, b) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/promotions/${UUID}$`), perm: 'catalog.read', fn: (res, ctx, b, p) => getPromotion(res, ctx, b, p) },
  { m: 'PATCH', re: new RegExp(`^/shops/${UUID}/promotions/${UUID}$`), perm: 'catalog.write', fn: (res, ctx, b, p) => updatePromotion(res, ctx, b, p) },
  { m: 'DELETE', re: new RegExp(`^/shops/${UUID}/promotions/${UUID}$`), perm: 'catalog.write', fn: (res, ctx, b, p) => deletePromotion(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/promotions/${UUID}/products$`), perm: 'catalog.write', fn: (res, ctx, b, p) => addProduct(res, ctx, b, p) },
  { m: 'DELETE', re: new RegExp(`^/shops/${UUID}/promotions/${UUID}/products/${UUID}$`), perm: 'catalog.write', fn: (res, ctx, b, p) => removeProduct(res, ctx, b, p) },
];
