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

// ─────────────────── BIẾN THỂ CÓ THỂ NHẬP (chọn khi lập phiếu/kiểm kê) ────────
// Như listSellableVariants (orders.js) NHƯNG KHÔNG lọc product.status='active' — nhập kho
// được cho cả SP nháp/ẩn (nhập trước, bán sau). Kèm giá vốn hiện hành để UI tham chiếu.
async function listPurchasableVariants(res, ctx, query) {
  const q = (query?.get('q') ?? '').trim().slice(0, 100);
  const args = [];
  let filterSql = '';
  if (q) { args.push('%' + q.replace(/[%_\\]/g, '\\$&') + '%'); filterSql = ` AND (vn_unaccent(p.title) LIKE vn_unaccent($${args.length}) OR v.sku ILIKE $${args.length})`; }
  const rows = await withTenant(ctx.shopId, async (c) =>
    (await c.query(
      `SELECT v.id, p.title AS product_title, v.title AS variant_title, v.sku, v.price_vnd,
              coalesce(il.on_hand, 0)::int AS on_hand, vc.cost_vnd
         FROM variants v
         JOIN products p ON p.id = v.product_id AND p.deleted_at IS NULL
         LEFT JOIN inventory_levels il ON il.variant_id = v.id
         LEFT JOIN variant_costs vc ON vc.shop_id = v.shop_id AND vc.variant_id = v.id
        WHERE ${VARIANT_NOT_ORPHAN_SQL}${filterSql}
        ORDER BY p.title, v.title NULLS FIRST, v.sku LIMIT 500`, args)).rows);
  return send(res, 200, {
    variants: rows.map((r) => ({ ...r, price_vnd: Number(r.price_vnd), cost_vnd: r.cost_vnd == null ? null : Number(r.cost_vnd) })),
    ...(rows.length === 500 ? { truncated: true } : {}),
  });
}

// ─────────────────────────── BÁO CÁO NHẬP HÀNG ───────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TZ = 'Asia/Ho_Chi_Minh';
const todayVN = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const realDate = (s) => { const d = new Date(s + 'T00:00:00Z'); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };
const addDays = (s, k) => new Date(Date.parse(s + 'T00:00:00Z') + k * 86400e3).toISOString().slice(0, 10);
// Khoảng sargable theo received_at, giờ VN (như reports.js): [00:00 from VN, 00:00 to+1 VN).
const rangeSql = (col, i) => `${col} >= ($${i}::date::timestamp AT TIME ZONE '${TZ}') AND ${col} < (($${i + 1}::date + 1)::timestamp AT TIME ZONE '${TZ}')`;

// GET /shops/:id/purchasing/report?from&to — tổng nhập theo kỳ (phiếu ĐÃ nhận, theo received_at).
async function purchasingReport(res, ctx, query) {
  const to = query.get('to') ?? todayVN();
  const from = query.get('from') ?? addDays(to, -29);
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || !realDate(from) || !realDate(to)) return send(res, 400, { error: 'ngày không hợp lệ (YYYY-MM-DD)' });
  if (from > to) return send(res, 400, { error: 'từ-ngày phải ≤ đến-ngày' });
  if (Math.round((Date.parse(to) - Date.parse(from)) / 86400e3) + 1 > 366) return send(res, 400, { error: 'khoảng tối đa 366 ngày' });
  const data = await withTenant(ctx.shopId, async (c) => {
    const totals = (await c.query(
      `SELECT count(*)::int AS po_count, coalesce(sum(subtotal_vnd), 0)::bigint AS value
         FROM purchase_orders WHERE status = 'received' AND ${rangeSql('received_at', 1)}`, [from, to])).rows[0];
    const bySupplier = (await c.query(
      `SELECT s.name AS supplier_name, count(*)::int AS po_count, coalesce(sum(po.subtotal_vnd), 0)::bigint AS value
         FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
        WHERE po.status = 'received' AND ${rangeSql('po.received_at', 1)}
        GROUP BY s.name ORDER BY value DESC LIMIT 100`, [from, to])).rows;
    const byProduct = (await c.query(
      `SELECT l.title_snapshot AS title, l.sku_snapshot AS sku, sum(l.qty)::bigint AS qty,
              coalesce(sum(l.qty::bigint * l.unit_cost_vnd), 0)::bigint AS value
         FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.po_id
        WHERE po.status = 'received' AND ${rangeSql('po.received_at', 1)}
        GROUP BY l.title_snapshot, l.sku_snapshot ORDER BY value DESC LIMIT 101`, [from, to])).rows;
    return { totals, bySupplier, byProduct };
  });
  return send(res, 200, {
    range: { from, to },
    totals: { po_count: data.totals.po_count, value_vnd: Number(data.totals.value) },
    by_supplier: data.bySupplier.map((r) => ({ supplier_name: r.supplier_name, po_count: r.po_count, value_vnd: Number(r.value) })),
    by_product: data.byProduct.slice(0, 100).map((r) => ({ title: r.title, sku: r.sku, qty: Number(r.qty), value_vnd: Number(r.value) })),
    products_truncated: data.byProduct.length > 100,
  });
}

// ─────────────────────────── KIỂM KÊ (stocktake) ─────────────────────────────
const MAX_COUNTED = 1_000_000_000; // < int4 max — on_hand là int4

// POST — tạo phiên đếm. scope 'all' (mọi biến thể không mồ côi) hoặc 'list' (variant_ids).
// system_qty snapshot on_hand LÚC TẠO (tham chiếu); on_hand SỐNG mới là cơ sở tính chênh lúc chốt.
async function createStocktake(res, ctx, body) {
  const scope = body?.scope === 'all' ? 'all' : 'list';
  const note = str(body?.note, 1000);
  let ids = null;
  if (scope === 'list') {
    const raw = Array.isArray(body?.variant_ids) ? body.variant_ids : [];
    const seen = new Set();
    ids = [];
    for (const x of raw) { const v = String(x); if (!UUID_RE.test(v)) fail(400, 'variant_id không hợp lệ'); if (!seen.has(v)) { seen.add(v); ids.push(v); } }
    if (ids.length === 0) fail(400, 'chọn ít nhất 1 biến thể để kiểm kê');
    if (ids.length > 500) fail(400, 'tối đa 500 biến thể/phiên (chia nhỏ phiên)');
  }
  const out = await withTenant(ctx.shopId, async (c) => {
    // Tập biến thể mục tiêu (không mồ côi). scope 'all' đếm trước — chặn phiên khổng lồ.
    const targets = (await c.query(
      scope === 'all'
        ? `SELECT v.id, coalesce(il.on_hand, 0)::int AS on_hand FROM variants v
             LEFT JOIN inventory_levels il ON il.variant_id = v.id
            WHERE ${VARIANT_NOT_ORPHAN_SQL} ORDER BY v.id`
        : `SELECT v.id, coalesce(il.on_hand, 0)::int AS on_hand FROM variants v
             LEFT JOIN inventory_levels il ON il.variant_id = v.id
            WHERE v.id = ANY($1) AND ${VARIANT_NOT_ORPHAN_SQL} ORDER BY v.id`,
      scope === 'all' ? [] : [ids])).rows;
    if (scope === 'all' && targets.length > 500) fail(422, `shop có ${targets.length} biến thể (>500) — kiểm kê theo danh sách/lô thay vì toàn bộ`);
    if (targets.length === 0) fail(400, 'không có biến thể hợp lệ để kiểm kê');
    const num = (await c.query(
      `INSERT INTO shop_counters (shop_id, name, value) VALUES (current_shop_id(), 'stocktake_number', 1)
       ON CONFLICT (shop_id, name) DO UPDATE SET value = shop_counters.value + 1 RETURNING value`)).rows[0].value;
    const st = (await c.query(
      `INSERT INTO stocktakes (shop_id, stocktake_number, status, note, created_by)
       VALUES (current_shop_id(), $1, 'counting', $2, $3) RETURNING id`, [num, note, ctx.user.id])).rows[0];
    for (const t of targets) {
      await c.query(
        `INSERT INTO stocktake_lines (shop_id, stocktake_id, variant_id, system_qty)
         VALUES (current_shop_id(), $1, $2, $3)`, [st.id, t.id, t.on_hand]);
    }
    await audit(c, 'stocktake.created', { actorId: ctx.user.id, ip: ctx.ip, metadata: { stocktakeId: st.id, number: Number(num), lines: targets.length, scope } });
    return { id: st.id, stocktake_number: Number(num), lines: targets.length };
  });
  return send(res, 201, out);
}

async function listStocktakes(res, ctx) {
  const rows = await withTenant(ctx.shopId, async (c) =>
    (await c.query(
      `SELECT st.id, st.stocktake_number, st.status, st.note, st.completed_at, st.created_at,
              (SELECT count(*)::int FROM stocktake_lines l WHERE l.stocktake_id = st.id) AS line_count,
              (SELECT count(*)::int FROM stocktake_lines l WHERE l.stocktake_id = st.id AND l.counted_qty IS NOT NULL) AS counted_count
         FROM stocktakes st ORDER BY st.stocktake_number DESC LIMIT 200`)).rows);
  return send(res, 200, { stocktakes: rows, ...(rows.length === 200 ? { truncated: true } : {}) });
}

async function getStocktake(res, ctx, stId) {
  const out = await withTenant(ctx.shopId, async (c) => {
    const st = (await c.query(`SELECT id, stocktake_number, status, note, completed_at, created_at FROM stocktakes WHERE id = $1`, [stId])).rows[0];
    if (!st) return null;
    const lines = (await c.query(
      `SELECT l.id, l.variant_id, l.system_qty, l.counted_qty,
              coalesce(il.on_hand, 0)::int AS on_hand_now, p.title AS product_title, v.title AS variant_title, v.sku
         FROM stocktake_lines l
         JOIN variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id
         LEFT JOIN inventory_levels il ON il.variant_id = l.variant_id
        WHERE l.stocktake_id = $1 ORDER BY p.title, v.title NULLS FIRST, v.sku`, [stId])).rows;
    return { ...st, lines };
  });
  if (!out) return send(res, 404, { error: 'không tìm thấy phiên kiểm kê' });
  return send(res, 200, out);
}

// PATCH — ghi số ĐẾM cho các dòng (chỉ khi 'counting'). counts:[{variant_id, counted_qty|null}].
async function countStocktake(res, ctx, stId, body) {
  const raw = Array.isArray(body?.counts) ? body.counts : [];
  if (raw.length === 0 || raw.length > 500) return send(res, 400, { error: 'cần 1-500 dòng đếm' });
  const counts = [];
  const seen = new Set();
  for (const x of raw) {
    const vid = String(x?.variant_id ?? '');
    if (!UUID_RE.test(vid)) return send(res, 400, { error: 'variant_id không hợp lệ' });
    if (seen.has(vid)) return send(res, 400, { error: 'variant_id trùng trong lô đếm' });
    seen.add(vid);
    let cq = x?.counted_qty;
    if (cq === null || cq === undefined || cq === '') cq = null;
    else { cq = Number(cq); if (!(isInt(cq) && cq >= 0 && cq <= MAX_COUNTED)) return send(res, 400, { error: `số đếm phải là số nguyên 0-${MAX_COUNTED} (để trống = chưa đếm)` }); }
    counts.push({ variant_id: vid, counted_qty: cq });
  }
  const updated = await withTenant(ctx.shopId, async (c) => {
    const st = (await c.query(`SELECT status FROM stocktakes WHERE id = $1 FOR UPDATE`, [stId])).rows[0];
    if (!st) fail(404, 'không tìm thấy phiên kiểm kê');
    if (st.status !== 'counting') fail(409, 'phiên đã chốt/huỷ, không ghi đếm được');
    let n = 0;
    for (const cnt of counts) {
      const r = await c.query(`UPDATE stocktake_lines SET counted_qty = $3 WHERE stocktake_id = $1 AND variant_id = $2`, [stId, cnt.variant_id, cnt.counted_qty]);
      n += r.rowCount;
    }
    return n;
  });
  return send(res, 200, { ok: true, updated });
}

/**
 * POST complete — chốt kiểm kê: điều chỉnh on_hand về số ĐẾM, ghi ledger 'adjust' cho chênh lệch.
 * 2 LƯỢT dưới FOR UPDATE (chỉ dòng ĐÃ đếm; dòng chưa đếm bỏ qua):
 *  Lượt 1 (thứ tự variant_id, chống deadlock): khoá inventory_levels, đọc on_hand SỐNG + reserved.
 *          CHẶN nếu counted_qty < reserved (đặt on_hand < reserved vi phạm CHECK 0009) → 409.
 *  Lượt 2: on_hand = counted_qty; ghi ĐÚNG 1 ledger 'adjust' delta=counted−live (nếu ≠0);
 *          GHI ĐÈ system_qty = on_hand SỐNG đã dùng (chứng từ phản ánh cơ sở chênh thực).
 */
async function completeStocktake(res, ctx, stId) {
  const summary = await withTenant(ctx.shopId, async (c) => {
    const st = (await c.query(`SELECT status, stocktake_number FROM stocktakes WHERE id = $1 FOR UPDATE`, [stId])).rows[0];
    if (!st) fail(404, 'không tìm thấy phiên kiểm kê');
    if (st.status !== 'counting') fail(409, 'phiên đã chốt hoặc đã huỷ');
    const num = Number(st.stocktake_number);
    const lines = (await c.query(
      `SELECT id, variant_id, counted_qty FROM stocktake_lines
        WHERE stocktake_id = $1 AND counted_qty IS NOT NULL ORDER BY variant_id`, [stId])).rows;
    if (lines.length === 0) fail(400, 'chưa đếm dòng nào — không có gì để chốt');
    // Lượt 1: khoá + đọc on_hand sống + reserved; chặn counted < reserved.
    for (const ln of lines) {
      await c.query(`INSERT INTO inventory_levels (shop_id, variant_id) VALUES (current_shop_id(), $1) ON CONFLICT (shop_id, variant_id) DO NOTHING`, [ln.variant_id]);
      const lvl = (await c.query(`SELECT on_hand, reserved FROM inventory_levels WHERE variant_id = $1 FOR UPDATE`, [ln.variant_id])).rows[0];
      ln._live = Number(lvl.on_hand);
      ln._reserved = Number(lvl.reserved);
      if (ln.counted_qty < ln._reserved) fail(409, `biến thể đang giữ ${ln._reserved} cho đơn — không thể đặt tồn về ${ln.counted_qty} (huỷ/giao đơn giữ hàng trước)`);
    }
    // Lượt 2: áp dụng.
    let adjusted = 0, deltaSum = 0;
    for (const ln of lines) {
      const delta = ln.counted_qty - ln._live;
      await c.query(`UPDATE stocktake_lines SET system_qty = $2 WHERE id = $1`, [ln.id, ln._live]); // chứng từ = cơ sở thực
      if (delta !== 0) {
        await c.query(`UPDATE inventory_levels SET on_hand = $2, updated_at = now() WHERE variant_id = $1`, [ln.variant_id, ln.counted_qty]);
        await c.query(
          `INSERT INTO inventory_ledger (shop_id, variant_id, delta, kind, reason, actor_id)
           VALUES (current_shop_id(), $1, $2, 'adjust', $3, $4)`, [ln.variant_id, delta, `Kiểm kê #${num}`, ctx.user.id]);
        adjusted++; deltaSum += delta;
      }
    }
    await c.query(`UPDATE stocktakes SET status = 'completed', completed_at = now(), completed_by = $2 WHERE id = $1`, [stId, ctx.user.id]);
    await audit(c, 'stocktake.completed', { actorId: ctx.user.id, ip: ctx.ip, metadata: { stocktakeId: stId, number: num, countedLines: lines.length, adjustedLines: adjusted, netDelta: deltaSum } });
    return { stocktake_number: num, counted_lines: lines.length, adjusted_lines: adjusted, net_delta: deltaSum };
  });
  return send(res, 200, { ok: true, ...summary });
}

async function cancelStocktake(res, ctx, stId) {
  await withTenant(ctx.shopId, async (c) => {
    const st = (await c.query(`SELECT status FROM stocktakes WHERE id = $1 FOR UPDATE`, [stId])).rows[0];
    if (!st) fail(404, 'không tìm thấy phiên kiểm kê');
    if (st.status !== 'counting') fail(409, 'phiên đã chốt/huỷ');
    await c.query(`UPDATE stocktakes SET status = 'cancelled' WHERE id = $1`, [stId]);
    await audit(c, 'stocktake.cancelled', { actorId: ctx.user.id, ip: ctx.ip, metadata: { stocktakeId: stId } });
  });
  return send(res, 200, { ok: true });
}

export const PURCHASING_ROUTES = [
  // Biến thể có thể nhập + báo cáo
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/purchasable-variants$`), perm: 'inventory.manage', fn: (res, ctx, b, p, q) => listPurchasableVariants(res, ctx, q) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/purchasing/report$`), perm: 'inventory.manage', fn: (res, ctx, b, p, q) => purchasingReport(res, ctx, q) },
  // Kiểm kê
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/stocktakes$`), perm: 'inventory.manage', fn: (res, ctx, b) => createStocktake(res, ctx, b) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/stocktakes$`), perm: 'inventory.manage', fn: (res, ctx) => listStocktakes(res, ctx) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/stocktakes/${UUID}$`), perm: 'inventory.manage', fn: (res, ctx, b, p) => getStocktake(res, ctx, p[1]) },
  { m: 'PATCH', re: new RegExp(`^/shops/${UUID}/stocktakes/${UUID}$`), perm: 'inventory.manage', fn: (res, ctx, b, p) => countStocktake(res, ctx, p[1], b) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/stocktakes/${UUID}/complete$`), perm: 'inventory.manage', fn: (res, ctx, b, p) => completeStocktake(res, ctx, p[1]) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/stocktakes/${UUID}/cancel$`), perm: 'inventory.manage', fn: (res, ctx, b, p) => cancelStocktake(res, ctx, p[1]) },
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
