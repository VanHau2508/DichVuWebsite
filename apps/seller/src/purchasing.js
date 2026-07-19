/**
 * NHẬP HÀNG (0085) — nhà cung cấp + phiếu nhập + NHẬN HÀNG nguyên tử. Toàn bộ route
 * perm 'inventory.manage' (CHỈ owner/admin: giá nhập + thông tin NCC là bí mật kinh doanh,
 * y như reports.read — catalog_manager/order_manager bị 403 ở dispatcher).
 *
 * NỐI 2 BẤT BIẾN CỐT LÕI (KHÔNG mở đường mới):
 *  • TỒN (0009): receive() đổi on_hand ⇒ ĐÚNG 1 dòng inventory_ledger kind='receive' cùng tx
 *    → Σdelta == on_hand giữ nguyên. Mirror restock-RMA (orders.js): INSERT levels ON CONFLICT
 *    DO NOTHING → FOR UPDATE khoá → on_hand += → ledger. Khoá theo THỨ TỰ variant_id (deadlock).
 *  • GIÁ VỐN (0081): receive() UPSERT variant_costs BÌNH QUÂN GIA QUYỀN DI ĐỘNG. Khoá variants
 *    FOR UPDATE trước khi đọc cost cũ → chống lost-update với catalog.updateVariant (cùng khoá).
 *    NULL cost cũ = KHÔNG BIẾT → lấy thẳng giá nhập (không coi 0). KHÔNG hồi tố đơn cũ.
 *
 * CHỨNG TỪ: phiếu 'received' = TERMINAL. Mọi mutation (sửa header/dòng, order, receive, cancel)
 * SELECT ... FOR UPDATE rồi guard status DƯỚI khoá (TOCTOU) — như shipOrder "đơn đã giao".
 */
import { send } from './http.js';
import { withTenant, audit } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MAX_QTY = 100_000;             // trần SL/dòng — chặn nhập nhầm/tràn
const MAX_COST = 100_000_000_000;    // 100 tỷ/đơn vị — khớp MAX_PRICE catalog; subtotal tính ở SQL (bigint)
const MAX_LINES = 200;               // trần dòng/phiếu
const isInt = (x) => Number.isInteger(x);

// Biến thể KHÔNG mồ côi (mirror orders/checkout 0057): phải có ánh xạ cho MỌI trục option.
const VARIANT_NOT_ORPHAN_SQL = `NOT EXISTS (
  SELECT 1 FROM product_options po WHERE po.product_id = v.product_id
    AND NOT EXISTS (SELECT 1 FROM variant_option_values vov
                     WHERE vov.variant_id = v.id AND vov.option_id = po.id))`;

const fail = (statusCode, msg) => { throw Object.assign(new Error(msg), { statusCode }); };

// ─────────────────────────── NHÀ CUNG CẤP ────────────────────────────────────
const str = (x, max) => { const s = String(x ?? '').trim(); return s.length ? s.slice(0, max) : null; };

function supplierFields(body) {
  const name = String(body?.name ?? '').trim();
  if (!name || name.length > 200) fail(400, 'tên NCC bắt buộc (1-200 ký tự)');
  const email = str(body?.email, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'email NCC không hợp lệ');
  return {
    name,
    contact: str(body?.contact, 200),
    phone: str(body?.phone, 40),
    email,
    address: str(body?.address, 500),
    note: str(body?.note, 1000),
  };
}

async function createSupplier(res, ctx, body) {
  const f = supplierFields(body);
  const row = await withTenant(ctx.shopId, async (c) => {
    const r = (await c.query(
      `INSERT INTO suppliers (shop_id, name, contact, phone, email, address, note, created_by)
       VALUES (current_shop_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [f.name, f.contact, f.phone, f.email, f.address, f.note, ctx.user.id],
    )).rows[0];
    await audit(c, 'supplier.created', { actorId: ctx.user.id, ip: ctx.ip, metadata: { supplierId: r.id, name: f.name } });
    return r;
  });
  return send(res, 201, { id: row.id });
}

async function listSuppliers(res, ctx, query) {
  const q = (query?.get('q') ?? '').trim().slice(0, 100);
  const includeInactive = query?.get('all') === '1';
  const args = [];
  let where = '';
  if (!includeInactive) where += ` AND is_active = true`;
  if (q) { args.push('%' + q.replace(/[%_\\]/g, '\\$&') + '%'); where += ` AND (vn_unaccent(name) LIKE vn_unaccent($${args.length}) OR phone ILIKE $${args.length})`; }
  const rows = await withTenant(ctx.shopId, async (c) =>
    (await c.query(
      `SELECT id, name, contact, phone, email, address, note, is_active, created_at
         FROM suppliers WHERE true${where} ORDER BY is_active DESC, name LIMIT 500`, args,
    )).rows);
  return send(res, 200, { suppliers: rows, ...(rows.length === 500 ? { truncated: true } : {}) });
}

async function getSupplier(res, ctx, supplierId) {
  const out = await withTenant(ctx.shopId, async (c) => {
    const s = (await c.query(`SELECT id, name, contact, phone, email, address, note, is_active, created_at FROM suppliers WHERE id = $1`, [supplierId])).rows[0];
    if (!s) return null;
    // Vài phiếu gần nhất của NCC này (ngữ cảnh nhanh, không phân trang).
    const pos = (await c.query(
      `SELECT id, po_number, status, subtotal_vnd, received_at, created_at
         FROM purchase_orders WHERE supplier_id = $1 ORDER BY po_number DESC LIMIT 20`, [supplierId])).rows;
    return { supplier: s, purchase_orders: pos.map((p) => ({ ...p, subtotal_vnd: Number(p.subtotal_vnd) })) };
  });
  if (!out) return send(res, 404, { error: 'không tìm thấy nhà cung cấp' });
  return send(res, 200, out);
}

async function updateSupplier(res, ctx, supplierId, body) {
  const f = supplierFields(body);
  const isActive = body?.is_active === undefined ? null : body.is_active === true;
  const ok = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(
      `UPDATE suppliers SET name = $2, contact = $3, phone = $4, email = $5, address = $6, note = $7,
              is_active = COALESCE($8, is_active), updated_at = now() WHERE id = $1`,
      [supplierId, f.name, f.contact, f.phone, f.email, f.address, f.note, isActive],
    );
    if (r.rowCount !== 1) return false;
    await audit(c, 'supplier.updated', { actorId: ctx.user.id, ip: ctx.ip, metadata: { supplierId, name: f.name } });
    return true;
  });
  if (!ok) return send(res, 404, { error: 'không tìm thấy nhà cung cấp' });
  return send(res, 200, { ok: true });
}

// ─────────────────────────── PHIẾU NHẬP ──────────────────────────────────────
// Validate + chuẩn hoá mảng dòng đầu vào. Ném fail(400) nếu sai. Trả [{variant_id, qty, unit_cost_vnd}].
function cleanLines(rawLines) {
  if (!Array.isArray(rawLines)) fail(400, 'lines phải là mảng');
  if (rawLines.length > MAX_LINES) fail(400, `tối đa ${MAX_LINES} dòng/phiếu`);
  const seen = new Set();
  const out = [];
  for (const l of rawLines) {
    const vid = String(l?.variant_id ?? '');
    const qty = Number(l?.qty);
    const cost = Number(l?.unit_cost_vnd);
    if (!UUID_RE.test(vid)) fail(400, 'variant_id không hợp lệ');
    if (!(isInt(qty) && qty >= 1 && qty <= MAX_QTY)) fail(400, `số lượng phải là số nguyên 1-${MAX_QTY}`);
    if (!(isInt(cost) && cost >= 0 && cost <= MAX_COST)) fail(400, 'giá nhập phải là số nguyên ≥ 0');
    if (seen.has(vid)) fail(400, 'biến thể trùng trong phiếu (gộp số lượng vào 1 dòng)');
    seen.add(vid);
    out.push({ variant_id: vid, qty, unit_cost_vnd: cost });
  }
  return out;
}

// Chèn các dòng cho 1 phiếu + snapshot title/sku (chống pool-reuse 0041). Mỗi biến thể phải
// tồn tại, thuộc shop (RLS), không mồ côi — KHÔNG đòi product active (nhập được cả SP nháp/ẩn).
async function insertLines(c, poId, lines) {
  for (const l of lines) {
    const r = await c.query(
      `INSERT INTO purchase_order_lines (shop_id, po_id, variant_id, qty, unit_cost_vnd, title_snapshot, sku_snapshot)
       SELECT current_shop_id(), $1, v.id, $3, $4,
              p.title || CASE WHEN v.title IS NOT NULL AND v.title <> '' THEN ' / ' || v.title ELSE '' END, v.sku
         FROM variants v JOIN products p ON p.id = v.product_id
        WHERE v.id = $2 AND ${VARIANT_NOT_ORPHAN_SQL}`,
      [poId, l.variant_id, l.qty, l.unit_cost_vnd],
    );
    if (r.rowCount !== 1) fail(400, 'biến thể không hợp lệ hoặc không thuộc cửa hàng');
  }
}

// Cache subtotal = Σ(qty × giá nhập) — tính ở SQL (bigint, tránh tràn Number JS).
async function recomputeSubtotal(c, poId) {
  await c.query(
    `UPDATE purchase_orders SET subtotal_vnd =
       (SELECT coalesce(sum(qty::bigint * unit_cost_vnd), 0) FROM purchase_order_lines WHERE po_id = $1),
       updated_at = now() WHERE id = $1`, [poId]);
}

async function createPurchaseOrder(res, ctx, body) {
  const supplierId = String(body?.supplier_id ?? '');
  if (!UUID_RE.test(supplierId)) return send(res, 400, { error: 'thiếu nhà cung cấp hợp lệ' });
  const note = str(body?.note, 1000);
  const lines = cleanLines(Array.isArray(body?.lines) ? body.lines : []);
  const out = await withTenant(ctx.shopId, async (c) => {
    // NCC phải tồn tại + đang hoạt động (FK composite chặn chéo-shop; đây chặn NCC đã ẩn).
    const sup = (await c.query(`SELECT is_active FROM suppliers WHERE id = $1`, [supplierId])).rows[0];
    if (!sup) fail(404, 'không tìm thấy nhà cung cấp');
    if (!sup.is_active) fail(400, 'nhà cung cấp đã ngừng hoạt động');
    // po_number: upsert counter (bẫy 0-rows phiếu đầu tiên của shop).
    const num = (await c.query(
      `INSERT INTO shop_counters (shop_id, name, value) VALUES (current_shop_id(), 'po_number', 1)
       ON CONFLICT (shop_id, name) DO UPDATE SET value = shop_counters.value + 1 RETURNING value`)).rows[0].value;
    const po = (await c.query(
      `INSERT INTO purchase_orders (shop_id, po_number, supplier_id, status, note, created_by)
       VALUES (current_shop_id(), $1, $2, 'draft', $3, $4) RETURNING id`,
      [num, supplierId, note, ctx.user.id],
    )).rows[0];
    await insertLines(c, po.id, lines);
    await recomputeSubtotal(c, po.id);
    await audit(c, 'purchase_order.created', { actorId: ctx.user.id, ip: ctx.ip, metadata: { poId: po.id, poNumber: Number(num), lines: lines.length } });
    return { id: po.id, po_number: Number(num) };
  });
  return send(res, 201, out);
}

async function listPurchaseOrders(res, ctx, query) {
  const status = query?.get('status');
  const args = [];
  let where = '';
  if (['draft', 'ordered', 'received', 'cancelled'].includes(status)) { args.push(status); where = ` AND po.status = $${args.length}`; }
  const rows = await withTenant(ctx.shopId, async (c) =>
    (await c.query(
      `SELECT po.id, po.po_number, po.status, po.subtotal_vnd, po.received_at, po.created_at,
              s.name AS supplier_name,
              (SELECT count(*)::int FROM purchase_order_lines l WHERE l.po_id = po.id) AS line_count
         FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
        WHERE true${where} ORDER BY po.po_number DESC LIMIT 200`, args,
    )).rows);
  return send(res, 200, {
    purchase_orders: rows.map((r) => ({ ...r, subtotal_vnd: Number(r.subtotal_vnd) })),
    ...(rows.length === 200 ? { truncated: true } : {}),
  });
}

async function getPurchaseOrder(res, ctx, poId) {
  const out = await withTenant(ctx.shopId, async (c) => {
    const po = (await c.query(
      `SELECT po.id, po.po_number, po.status, po.subtotal_vnd, po.note, po.supplier_id,
              po.ordered_at, po.received_at, po.created_at, s.name AS supplier_name, s.is_active AS supplier_active
         FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1`, [poId])).rows[0];
    if (!po) return null;
    const lines = (await c.query(
      `SELECT l.id, l.variant_id, l.qty, l.unit_cost_vnd, l.title_snapshot, l.sku_snapshot,
              coalesce(il.on_hand, 0)::int AS on_hand
         FROM purchase_order_lines l LEFT JOIN inventory_levels il ON il.variant_id = l.variant_id
        WHERE l.po_id = $1 ORDER BY l.title_snapshot, l.sku_snapshot`, [poId])).rows;
    return { ...po, subtotal_vnd: Number(po.subtotal_vnd), lines: lines.map((l) => ({ ...l, unit_cost_vnd: Number(l.unit_cost_vnd) })) };
  });
  if (!out) return send(res, 404, { error: 'không tìm thấy phiếu nhập' });
  return send(res, 200, out);
}

// PATCH — sửa header + (tuỳ chọn) thay TOÀN BỘ dòng. CHỈ khi draft/ordered (guard dưới FOR UPDATE).
async function updatePurchaseOrder(res, ctx, poId, body) {
  const wantSupplier = body?.supplier_id !== undefined;
  const supplierId = wantSupplier ? String(body.supplier_id) : null;
  if (wantSupplier && !UUID_RE.test(supplierId)) return send(res, 400, { error: 'nhà cung cấp không hợp lệ' });
  const wantNote = body?.note !== undefined;
  const note = wantNote ? str(body.note, 1000) : null;
  const wantLines = body?.lines !== undefined;
  const lines = wantLines ? cleanLines(Array.isArray(body.lines) ? body.lines : []) : null;

  await withTenant(ctx.shopId, async (c) => {
    const po = (await c.query(`SELECT status FROM purchase_orders WHERE id = $1 FOR UPDATE`, [poId])).rows[0];
    if (!po) fail(404, 'không tìm thấy phiếu nhập');
    if (!['draft', 'ordered'].includes(po.status)) fail(409, 'phiếu đã chốt/huỷ, không sửa được');
    if (wantSupplier) {
      const sup = (await c.query(`SELECT is_active FROM suppliers WHERE id = $1`, [supplierId])).rows[0];
      if (!sup) fail(404, 'không tìm thấy nhà cung cấp');
      if (!sup.is_active) fail(400, 'nhà cung cấp đã ngừng hoạt động');
      await c.query(`UPDATE purchase_orders SET supplier_id = $2, updated_at = now() WHERE id = $1`, [poId, supplierId]);
    }
    if (wantNote) await c.query(`UPDATE purchase_orders SET note = $2, updated_at = now() WHERE id = $1`, [poId, note]);
    if (wantLines) {
      await c.query(`DELETE FROM purchase_order_lines WHERE po_id = $1`, [poId]);
      await insertLines(c, poId, lines);
      await recomputeSubtotal(c, poId);
    }
    await audit(c, 'purchase_order.updated', { actorId: ctx.user.id, ip: ctx.ip, metadata: { poId, changedLines: wantLines } });
  });
  return send(res, 200, { ok: true });
}

// draft → ordered (đánh dấu đã đặt hàng NCC). Guard dưới FOR UPDATE.
async function markOrdered(res, ctx, poId) {
  await withTenant(ctx.shopId, async (c) => {
    const po = (await c.query(`SELECT status FROM purchase_orders WHERE id = $1 FOR UPDATE`, [poId])).rows[0];
    if (!po) fail(404, 'không tìm thấy phiếu nhập');
    if (po.status !== 'draft') fail(409, 'chỉ phiếu nháp mới chuyển sang "đã đặt"');
    await c.query(`UPDATE purchase_orders SET status = 'ordered', ordered_at = now(), updated_at = now() WHERE id = $1`, [poId]);
    await audit(c, 'purchase_order.ordered', { actorId: ctx.user.id, ip: ctx.ip, metadata: { poId } });
  });
  return send(res, 200, { ok: true });
}

// draft/ordered → cancelled. KHÔNG đụng tồn (chưa nhận). Guard dưới FOR UPDATE.
async function cancelPurchaseOrder(res, ctx, poId) {
  await withTenant(ctx.shopId, async (c) => {
    const po = (await c.query(`SELECT status FROM purchase_orders WHERE id = $1 FOR UPDATE`, [poId])).rows[0];
    if (!po) fail(404, 'không tìm thấy phiếu nhập');
    if (!['draft', 'ordered'].includes(po.status)) fail(409, 'phiếu đã chốt/huỷ');
    await c.query(`UPDATE purchase_orders SET status = 'cancelled', updated_at = now() WHERE id = $1`, [poId]);
    await audit(c, 'purchase_order.cancelled', { actorId: ctx.user.id, ip: ctx.ip, metadata: { poId } });
  });
  return send(res, 200, { ok: true });
}

/**
 * NHẬN HÀNG — draft/ordered → received. NGUYÊN TỬ, điểm nóng đường tồn + giá vốn:
 *  1. Khoá phiếu FOR UPDATE, guard status (TOCTOU) → không nhận 2 lần.
 *  2. Với MỖI dòng (thứ tự variant_id — chống deadlock): khoá inventory_levels + variants
 *     FOR UPDATE; on_hand += qty; 1 dòng ledger 'receive'; UPSERT variant_costs bình quân
 *     gia quyền di động. Giá vốn cũ NULL / on_hand cũ ≤ 0 → lấy thẳng giá nhập (không coi 0).
 *  3. status='received', received_at/by. subtotal đã cache lúc tạo/sửa.
 */
async function receivePurchaseOrder(res, ctx, poId) {
  const summary = await withTenant(ctx.shopId, async (c) => {
    const po = (await c.query(`SELECT status, po_number FROM purchase_orders WHERE id = $1 FOR UPDATE`, [poId])).rows[0];
    if (!po) fail(404, 'không tìm thấy phiếu nhập');
    if (!['draft', 'ordered'].includes(po.status)) fail(409, 'phiếu đã chốt hoặc đã huỷ');
    const lines = (await c.query(
      `SELECT variant_id, qty, unit_cost_vnd FROM purchase_order_lines WHERE po_id = $1
        ORDER BY variant_id`, [poId])).rows; // thứ tự variant_id = thứ tự khoá cố định
    if (lines.length === 0) fail(400, 'phiếu chưa có dòng hàng nào để nhận');
    const poNum = Number(po.po_number);
    let received = 0;
    for (const ln of lines) {
      const qty = ln.qty, buy = Number(ln.unit_cost_vnd);
      // Khoá tồn + variants (variants: chống lost-update giá vốn với catalog.updateVariant).
      await c.query(`INSERT INTO inventory_levels (shop_id, variant_id) VALUES (current_shop_id(), $1) ON CONFLICT (shop_id, variant_id) DO NOTHING`, [ln.variant_id]);
      const lvl = (await c.query(`SELECT on_hand FROM inventory_levels WHERE variant_id = $1 FOR UPDATE`, [ln.variant_id])).rows[0];
      const costRow = (await c.query(
        `SELECT vc.cost_vnd FROM variants v LEFT JOIN variant_costs vc ON vc.shop_id = v.shop_id AND vc.variant_id = v.id
          WHERE v.id = $1 FOR UPDATE OF v`, [ln.variant_id])).rows[0];
      const onHandOld = lvl ? Number(lvl.on_hand) : 0;
      const costOld = costRow && costRow.cost_vnd != null ? Number(costRow.cost_vnd) : null;
      // Bình quân gia quyền di động. NULL / on_hand cũ ≤ 0 = không có cơ sở → lấy giá nhập.
      const newCost = (costOld == null || onHandOld <= 0)
        ? buy
        : Math.round((onHandOld * costOld + qty * buy) / (onHandOld + qty));
      // (1) on_hand += qty  (2) đúng 1 dòng ledger 'receive'
      await c.query(`UPDATE inventory_levels SET on_hand = on_hand + $2, updated_at = now() WHERE variant_id = $1`, [ln.variant_id, qty]);
      await c.query(
        `INSERT INTO inventory_ledger (shop_id, variant_id, delta, kind, reason, actor_id)
         VALUES (current_shop_id(), $1, $2, 'receive', $3, $4)`, [ln.variant_id, qty, `Nhập phiếu #${poNum}`, ctx.user.id]);
      // (3) UPSERT giá vốn hiện hành (bảng riêng 0081) — nguồn snapshot cho đơn TƯƠNG LAI.
      await c.query(
        `INSERT INTO variant_costs (shop_id, variant_id, cost_vnd, updated_by)
         VALUES (current_shop_id(), $1, $2, $3)
         ON CONFLICT (shop_id, variant_id) DO UPDATE SET cost_vnd = $2, updated_by = $3, updated_at = now()`,
        [ln.variant_id, newCost, ctx.user.id]);
      received += qty;
    }
    await c.query(`UPDATE purchase_orders SET status = 'received', received_at = now(), received_by = $2, updated_at = now() WHERE id = $1`, [poId, ctx.user.id]);
    await audit(c, 'purchase_order.received', { actorId: ctx.user.id, ip: ctx.ip, metadata: { poId, poNumber: poNum, lines: lines.length, unitsReceived: received } });
    return { po_number: poNum, lines: lines.length, units_received: received };
  });
  return send(res, 200, { ok: true, ...summary });
}

export const PURCHASING_ROUTES = [
  // Nhà cung cấp
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/suppliers$`), perm: 'inventory.manage', fn: (res, ctx, b) => createSupplier(res, ctx, b) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/suppliers$`), perm: 'inventory.manage', fn: (res, ctx, b, p, q) => listSuppliers(res, ctx, q) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/suppliers/${UUID}$`), perm: 'inventory.manage', fn: (res, ctx, b, p) => getSupplier(res, ctx, p[1]) },
  { m: 'PATCH', re: new RegExp(`^/shops/${UUID}/suppliers/${UUID}$`), perm: 'inventory.manage', fn: (res, ctx, b, p) => updateSupplier(res, ctx, p[1], b) },
  // Phiếu nhập
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/purchase-orders$`), perm: 'inventory.manage', fn: (res, ctx, b) => createPurchaseOrder(res, ctx, b) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/purchase-orders$`), perm: 'inventory.manage', fn: (res, ctx, b, p, q) => listPurchaseOrders(res, ctx, q) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/purchase-orders/${UUID}$`), perm: 'inventory.manage', fn: (res, ctx, b, p) => getPurchaseOrder(res, ctx, p[1]) },
  { m: 'PATCH', re: new RegExp(`^/shops/${UUID}/purchase-orders/${UUID}$`), perm: 'inventory.manage', fn: (res, ctx, b, p) => updatePurchaseOrder(res, ctx, p[1], b) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/purchase-orders/${UUID}/order$`), perm: 'inventory.manage', fn: (res, ctx, b, p) => markOrdered(res, ctx, p[1]) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/purchase-orders/${UUID}/receive$`), perm: 'inventory.manage', fn: (res, ctx, b, p) => receivePurchaseOrder(res, ctx, p[1]) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/purchase-orders/${UUID}/cancel$`), perm: 'inventory.manage', fn: (res, ctx, b, p) => cancelPurchaseOrder(res, ctx, p[1]) },
];
