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

import { send, parseOffset } from './http.js';
import { withTenant, audit } from './db.js';
import { SAFETY_SQL, AVAIL_SQL } from '../safety-stock.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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

// SỔ CÁI KHO CẤP SHOP — mọi chuyển động tồn của cả cửa hàng, mới nhất trước.
// Trước đây chỉ tra được lịch sử TỪNG biến thể (getLedger ở trên), nên chủ shop chỉnh tồn
// xong không truy vết được "ai sửa, khi nào, vì sao" trên toàn kho.
//
// Perm 'inventory.manage' (owner+admin) — KHÔNG dùng 'catalog.read' như route per-variant:
// sổ cái toàn shop lộ nhịp bán/nhập của cả cửa hàng (bí mật kinh doanh), cùng nhóm với
// Nhập hàng/Kiểm kê. Nav trong admin cũng gác bằng INVENTORY_ROLES nên hai bên khớp nhau.
//
// Không tính LUỸ KẾ tồn ở đây: bảng trộn nhiều biến thể + phân trang → cộng dồn trong trang
// sẽ ra số sai. Sổ cái chỉ có `delta`, không có cột tồn-trước/tồn-sau.
async function getShopLedger(res, ctx, _body, _params, query) {
  const limit = Math.min(Math.max(parseInt(query.get('limit') ?? '50', 10) || 50, 1), 100);
  const offset = parseOffset(query);
  const kind = query.get('kind');
  const variantId = query.get('variant_id');
  // 'reserve'/'release' có trong CHECK của 0009 nhưng KHÔNG chỗ nào ghi (giữ chỗ chỉ đụng
  // inventory_levels.reserved, không đụng on_hand) → chỉ cho lọc 3 loại có thật.
  const where = ['l.shop_id = current_shop_id()'];
  const args = [];
  if (['receive', 'ship', 'adjust'].includes(kind)) { args.push(kind); where.push(`l.kind = $${args.length}`); }
  // UUID CHẶT, không phải /^[0-9a-f-]{36}$/ (lỏng): chuỗi 36 gạch nối lọt regex lỏng rồi
  // rơi xuống Postgres thành 22P02 (invalid input syntax for type uuid) → 500, tức là ai gõ
  // tay ?variant_id=--- … là làm chết trang Sổ cái kho.
  if (typeof variantId === 'string' && UUID_RE.test(variantId)) {
    args.push(variantId); where.push(`l.variant_id = $${args.length}`);
  }
  const whereSql = where.join(' AND ');
  const rows = await withTenant(ctx.shopId, async (c) => (await c.query(
    // LEFT JOIN products/variants: KHÔNG lọc deleted_at — lịch sử kho của SP đã xoá mềm vẫn
    // phải hiện, nếu không sổ cái thủng lỗ. LEFT JOIN users: policy member_visibility (0007)
    // chỉ cho thấy thành viên HIỆN TẠI → người đã nghỉ việc cho email NULL; INNER JOIN sẽ
    // NUỐT MẤT dòng đó (mất toàn vẹn sổ cái). app_rw chỉ được SELECT (id, email) của users.
    `SELECT l.id, l.delta, l.kind, l.reason, l.created_at, l.variant_id,
            p.title AS product_title, v.title AS variant_title, v.sku,
            u.email AS actor_email
       FROM inventory_ledger l
       LEFT JOIN variants v ON v.id = l.variant_id
       LEFT JOIN products p ON p.id = v.product_id
       LEFT JOIN users u    ON u.id = l.actor_id
      WHERE ${whereSql}
      ORDER BY l.id DESC
      LIMIT ${limit + 1} OFFSET ${offset}`, args)).rows);
  // Lấy dư 1 dòng để biết còn trang sau mà không phải count(*) toàn bảng.
  const has_more = rows.length > limit;
  return send(res, 200, { entries: rows.slice(0, limit), has_more, limit, offset });
}

// ── TỒN AN TOÀN (0140) ───────────────────────────────────────────────────────────────────
//
// BA CON SỐ, và người bán phải đọc được cả ba cùng lúc, nếu không họ sẽ tưởng hệ thống đếm sai:
//   tồn thực (on_hand)  ·  giữ an toàn (đệm)  ·  còn bán được online
// Cộng thêm `reserved` (đang giữ chỗ cho đơn chưa chốt) thì đẳng thức mới khép kín:
//   còn bán được online = max(0, tồn thực − đang giữ chỗ − giữ an toàn)
// Đây cũng là số ĐỐI CHIẾU ĐƯỢC với Sổ cái kho: `tồn thực` chính là cột mà sổ cái cộng dồn ra.
//
// Ai được xem: `inventory.manage` — cùng quyền với Nhập hàng/Kiểm kê/Sổ cái, vì đây là cấu hình
// vận hành kho chứ không phải sửa sản phẩm.
async function getSafety(res, ctx, _body, _params, query) {
  const limit = Math.min(Math.max(parseInt(query.get('limit') ?? '50', 10) || 50, 1), 100);
  const offset = parseOffset(query);
  const out = await withTenant(ctx.shopId, async (c) => {
    const pct = (await c.query(`SELECT safety_stock_pct FROM shops WHERE id = current_shop_id()`)).rows[0];
    // Sắp xếp theo SỐ LẦN BỊ CHẶN giảm dần: câu hỏi hữu ích nhất của trang này là "đệm đang
    // ăn doanh thu ở SKU nào" — chứ không phải "SKU nào tên vần A".
    const rows = (await c.query(
      `SELECT v.id AS variant_id, v.sku, v.title AS variant_title, p.title AS product_title,
              coalesce(il.on_hand, 0) AS on_hand, coalesce(il.reserved, 0) AS reserved,
              il.safety_stock_qty AS safety_override,
              coalesce(${SAFETY_SQL}, 0) AS safety_effective,
              coalesce(${AVAIL_SQL}, 0) AS available_online,
              coalesce(il.safety_blocked_count, 0) AS blocked_count
         FROM variants v
         JOIN products p ON p.id = v.product_id AND p.deleted_at IS NULL
         LEFT JOIN inventory_levels il ON il.variant_id = v.id
        WHERE v.shop_id = current_shop_id()
        ORDER BY coalesce(il.safety_blocked_count, 0) DESC, p.title, v.position
        LIMIT ${limit + 1} OFFSET ${offset}`)).rows;
    return { pct: pct?.safety_stock_pct ?? 0, rows };
  });
  const has_more = out.rows.length > limit;
  return send(res, 200, { safety_stock_pct: out.pct, rows: out.rows.slice(0, limit), has_more, limit, offset });
}

// Mức chung TOÀN SHOP. Trần 90 khớp CHECK của 0140 — chặn ở đây để trả 400 nói tiếng người,
// thay vì để Postgres ném 23514 thành 500.
async function putSafetyShop(res, ctx, body) {
  const pct = body.safety_stock_pct;
  if (!isInt(pct) || pct < 0 || pct > 90) return send(res, 400, { error: 'tỉ lệ phải là số nguyên 0–90' });
  await withTenant(ctx.shopId, async (c) => {
    await c.query(`UPDATE shops SET safety_stock_pct = $1 WHERE id = current_shop_id()`, [pct]);
    await audit(c, 'inventory.safety_pct', { actorId: ctx.user.id, ip: ctx.ip, metadata: { safety_stock_pct: pct } });
  });
  return send(res, 200, { safety_stock_pct: pct });
}

// Ghi đè theo BIẾN THỂ, đơn vị là SỐ CÁI (xem chú thích 0140). null = bỏ ngoại lệ, về dùng tỉ lệ.
async function putSafetyVariant(res, ctx, body, params) {
  const variantId = params[1];
  const qty = body.safety_stock_qty;
  if (qty !== null && (!isInt(qty) || qty < 0)) return send(res, 400, { error: 'số lượng phải là số nguyên ≥ 0, hoặc null để bỏ ngoại lệ' });
  const ok = await withTenant(ctx.shopId, async (c) => {
    const v = await c.query(`SELECT 1 FROM variants WHERE id = $1`, [variantId]);
    if (v.rows.length === 0) return false;
    // Biến thể CHƯA có dòng inventory_levels (chưa từng nhập hàng) vẫn phải đặt ghi đè được —
    // nếu không thì "chừa 2 cái cho khách quen" chỉ làm được SAU khi hàng đã về, tức là muộn.
    await c.query(
      `INSERT INTO inventory_levels (shop_id, variant_id, on_hand, reserved, safety_stock_qty)
            VALUES (current_shop_id(), $1, 0, 0, $2)
       ON CONFLICT (shop_id, variant_id) DO UPDATE SET safety_stock_qty = EXCLUDED.safety_stock_qty, updated_at = now()`,
      [variantId, qty]);
    await audit(c, 'inventory.safety_override', { actorId: ctx.user.id, ip: ctx.ip, metadata: { variantId, safety_stock_qty: qty } });
    return true;
  });
  if (!ok) return send(res, 404, { error: 'không tìm thấy biến thể' });
  return send(res, 200, { variant_id: variantId, safety_stock_qty: qty });
}

export const INVENTORY_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/inventory/safety$`), perm: 'inventory.manage', fn: (res, ctx, b, p, q) => getSafety(res, ctx, b, p, q) },
  { m: 'PUT', re: new RegExp(`^/shops/${UUID}/inventory/safety$`), perm: 'inventory.manage', fn: (res, ctx, b) => putSafetyShop(res, ctx, b) },
  { m: 'PUT', re: new RegExp(`^/shops/${UUID}/variants/${UUID}/inventory/safety$`), perm: 'inventory.manage', fn: (res, ctx, b, p) => putSafetyVariant(res, ctx, b, p) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/inventory/ledger$`), perm: 'inventory.manage', fn: (res, ctx, b, p, q) => getShopLedger(res, ctx, b, p, q) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/variants/${UUID}/inventory$`), perm: 'catalog.read', fn: (res, ctx, b, p) => getLevel(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/variants/${UUID}/inventory/adjust$`), perm: 'catalog.write', fn: (res, ctx, b, p) => adjust(res, ctx, b, p) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/variants/${UUID}/inventory/ledger$`), perm: 'catalog.read', fn: (res, ctx, b, p) => getLedger(res, ctx, b, p) },
];
