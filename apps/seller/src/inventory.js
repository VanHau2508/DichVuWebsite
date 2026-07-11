/**
 * Tồn kho — mức tồn theo biến thể + sổ cái append-only. Ngày 9.
 *
 * Bất biến (mỗi cái có test + mutation):
 *   - Điều chỉnh tồn NGUYÊN TỬ: SELECT ... FOR UPDATE khoá dòng level, nên hai
 *     điều chỉnh đồng thời không mất cập nhật (không oversell/undersell).
 *   - on_hand không âm; không hạ xuống dưới mức đang reserved (CHECK ở DB backstop).
 *   - MỌI thay đổi on_hand ghi một dòng ledger trong cùng transaction → tổng delta
 *     ledger == on_hand.
 */

import { send } from './http.js';
import { withTenant, audit } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const isInt = (x) => Number.isInteger(x);

async function getLevel(res, ctx, _body, params) {
  const variantId = params[1];
  const row = await withTenant(ctx.shopId, async (c) => {
    // Biến thể phải thuộc shop (RLS + tồn tại).
    const v = await c.query(`SELECT 1 FROM variants WHERE id = $1`, [variantId]);
    if (v.rows.length === 0) return null;
    const l = await c.query(
      `SELECT on_hand, reserved FROM inventory_levels WHERE variant_id = $1`,
      [variantId],
    );
    const lvl = l.rows[0] ?? { on_hand: 0, reserved: 0 };
    return { on_hand: lvl.on_hand, reserved: lvl.reserved, available: lvl.on_hand - lvl.reserved };
  });
  if (!row) return send(res, 404, { error: 'không tìm thấy biến thể' });
  return send(res, 200, row);
}

async function adjust(res, ctx, body, params) {
  const variantId = params[1];
  const delta = body.delta;
  const reason = body.reason != null ? String(body.reason) : null;
  if (!isInt(delta) || delta === 0) return send(res, 400, { error: 'delta phải là số nguyên khác 0' });
  const kind = delta > 0 ? 'receive' : 'adjust';

  const out = await withTenant(ctx.shopId, async (c) => {
    const v = await c.query(`SELECT 1 FROM variants WHERE id = $1`, [variantId]);
    if (v.rows.length === 0) return { code: 404 };

    // Upsert dòng level rồi KHOÁ nó. FOR UPDATE tuần tự hoá các điều chỉnh đồng thời.
    await c.query(
      `INSERT INTO inventory_levels (shop_id, variant_id) VALUES (current_shop_id(), $1)
       ON CONFLICT (shop_id, variant_id) DO NOTHING`,
      [variantId],
    );
    const cur = await c.query(
      `SELECT on_hand, reserved FROM inventory_levels WHERE variant_id = $1 FOR UPDATE`,
      [variantId],
    );
    const { on_hand, reserved } = cur.rows[0];
    const next = on_hand + delta;
    if (next < 0) return { code: 422, error: 'không đủ tồn để giảm', on_hand };
    if (next < reserved) return { code: 409, error: 'không thể hạ dưới mức đang giữ chỗ', reserved };

    await c.query(
      `UPDATE inventory_levels SET on_hand = $1, updated_at = now() WHERE variant_id = $2`,
      [next, variantId],
    );
    await c.query(
      `INSERT INTO inventory_ledger (shop_id, variant_id, delta, kind, reason, actor_id)
       VALUES (current_shop_id(), $1, $2, $3, $4, $5)`,
      [variantId, delta, kind, reason, ctx.user.id],
    );
    await audit(c, 'inventory.adjusted', { actorId: ctx.user.id, ip: ctx.ip, metadata: { variantId, delta, kind } });
    return { code: 200, on_hand: next };
  });

  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy biến thể' });
  if (out.code === 422) return send(res, 422, { error: out.error, on_hand: out.on_hand });
  if (out.code === 409) return send(res, 409, { error: out.error });
  return send(res, 200, { ok: true, on_hand: out.on_hand });
}

async function getLedger(res, ctx, _body, params) {
  const variantId = params[1];
  const rows = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(
      `SELECT id, delta, kind, reason, created_at FROM inventory_ledger
        WHERE variant_id = $1 ORDER BY id DESC LIMIT 200`,
      [variantId],
    );
    return r.rows;
  });
  return send(res, 200, { entries: rows });
}

export const INVENTORY_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/variants/${UUID}/inventory$`), perm: 'catalog.read', fn: (res, ctx, b, p) => getLevel(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/variants/${UUID}/inventory/adjust$`), perm: 'catalog.write', fn: (res, ctx, b, p) => adjust(res, ctx, b, p) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/variants/${UUID}/inventory/ledger$`), perm: 'catalog.read', fn: (res, ctx, b, p) => getLedger(res, ctx, b, p) },
];
