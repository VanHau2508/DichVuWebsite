/**
 * Catalog — sản phẩm, biến thể, danh mục. Ngày 8.
 *
 * Mọi handler chạy qua withTenant(ctx.shopId) → RLS cô lập theo shop. Route khai
 * báo perm (catalog.read / catalog.write) — RBAC gác ở tầng router của server.js.
 *
 * Bất biến được cưỡng chế (mỗi cái có test):
 *   - SKU duy nhất TRONG shop, nhưng LẶP được across shop (tenant-scoped).
 *   - slug sản phẩm/danh mục duy nhất trong shop.
 *   - Tiền là bigint VND, >= 0 (chặn ở app + CHECK ở DB).
 *   - Biến thể không trỏ được sang sản phẩm/danh mục shop khác (composite FK).
 *   - Sản phẩm có ≥ 1 biến thể; không xoá được biến thể cuối.
 *   - Trạng thái draft → active → archived; soft delete.
 */

import crypto from 'node:crypto';
import { send } from './http.js';
import { withTenant, audit } from './db.js';

// Base URL ảnh public (giống storefront) — dựng URL thumbnail cho danh sách SP trong admin.
const MEDIA_PUBLIC_BASE = process.env.MEDIA_PUBLIC_BASE ?? '/media-public';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const MAX_PRICE = 100_000_000_000; // 100 tỷ VND — chặn tràn/nhập nhầm

const isInt = (x) => Number.isInteger(x);
const validPrice = (x) => isInt(x) && x >= 0 && x <= MAX_PRICE;
const validTitle = (x) => typeof x === 'string' && x.trim().length >= 1 && x.length <= 200;
const validSku = (x) => typeof x === 'string' && x.trim().length >= 1 && x.length <= 64;
const validSlug = (x) => typeof x === 'string' && SLUG_RE.test(x);

// Escape ký tự wildcard để q được so khớp NGUYÊN VĂN trong ILIKE.
const likeEscape = (s) => s.replace(/[%_\\]/g, '\\$&');

/** Ánh xạ lỗi unique về thông báo đúng cột. */
function conflictMessage(err) {
  const c = err.constraint ?? '';
  if (c.includes('slug')) return 'slug đã tồn tại trong shop';
  if (c.includes('sku')) return 'SKU đã tồn tại trong shop';
  return 'trùng dữ liệu';
}

// ── ép giới hạn gói (max_products) ───────────────────────────────────────────
// Đọc gói của shop (subscriptions → plans) trong tenant context. NULL = không giới hạn.
async function planMaxProducts(c) {
  const r = await c.query(`SELECT pl.max_products FROM subscriptions s JOIN plans pl ON pl.code = s.plan_code WHERE s.shop_id = current_shop_id()`);
  return r.rows[0]?.max_products ?? null;
}
const catalogCount = async (c) => (await c.query(`SELECT count(*)::int n FROM products WHERE deleted_at IS NULL`)).rows[0].n;

// ── products ─────────────────────────────────────────────────────────────────

async function createProduct(res, ctx, body) {
  const title = String(body.title ?? '').trim();
  const slug = String(body.slug ?? '').toLowerCase().trim();
  const description = body.description != null ? String(body.description) : null;
  const status = body.status === 'active' ? 'active' : 'draft';
  const priceVnd = body.price_vnd;
  const variants = Array.isArray(body.variants) ? body.variants : [];
  const categoryIds = Array.isArray(body.category_ids) ? body.category_ids : [];

  if (!validTitle(title)) return send(res, 400, { error: 'tiêu đề không hợp lệ' });
  if (!validSlug(slug)) return send(res, 400, { error: 'slug không hợp lệ (a-z, 0-9, gạch ngang)' });
  if (!validPrice(priceVnd)) return send(res, 400, { error: 'giá không hợp lệ' });
  if (variants.length < 1 || variants.length > 100) return send(res, 400, { error: 'cần 1–100 biến thể' });
  for (const v of variants) {
    if (!validSku(v.sku)) return send(res, 400, { error: 'SKU biến thể không hợp lệ' });
    if (!validPrice(v.price_vnd)) return send(res, 400, { error: 'giá biến thể không hợp lệ' });
  }
  // SKU trùng nhau NGAY trong payload → chặn sớm (DB cũng chặn nhưng báo rõ hơn).
  const skus = variants.map((v) => v.sku.trim());
  if (new Set(skus).size !== skus.length) return send(res, 400, { error: 'SKU trùng trong danh sách biến thể' });

  try {
    const out = await withTenant(ctx.shopId, async (c) => {
      // Ép giới hạn gói: đã đạt max_products → chặn (nâng gói để thêm).
      const max = await planMaxProducts(c);
      if (max != null && (await catalogCount(c)) >= max) return { over: max };
      const p = await c.query(
        `INSERT INTO products (shop_id, slug, title, description, price_vnd, status)
         VALUES (current_shop_id(), $1, $2, $3, $4, $5) RETURNING id`,
        [slug, title, description, priceVnd, status],
      );
      const productId = p.rows[0].id;

      for (let i = 0; i < variants.length; i++) {
        const v = variants[i];
        await c.query(
          `INSERT INTO variants (shop_id, product_id, title, sku, price_vnd, position)
           VALUES (current_shop_id(), $1, $2, $3, $4, $5)`,
          [productId, v.title != null ? String(v.title) : null, v.sku.trim(), v.price_vnd, i],
        );
      }

      for (const catId of categoryIds) {
        // Composite FK (shop_id, category_id) → danh mục shop khác gây 23503.
        await c.query(
          `INSERT INTO product_categories (shop_id, product_id, category_id)
           VALUES (current_shop_id(), $1, $2)`,
          [productId, catId],
        );
      }

      await audit(c, 'product.created', { actorId: ctx.user.id, ip: ctx.ip, metadata: { productId, slug } });
      return { productId };
    });
    if (out.over != null) return send(res, 403, { error: `đã đạt giới hạn gói (${out.over} sản phẩm). Nâng gói để thêm sản phẩm.` });
    return send(res, 201, { id: out.productId, slug, status });
  } catch (err) {
    if (err.code === '23505') return send(res, 409, { error: conflictMessage(err) });
    if (err.code === '23503') return send(res, 400, { error: 'danh mục không hợp lệ' });
    throw err;
  }
}

async function listProducts(res, ctx, _body, _params, query) {
  const limit = Math.min(Math.max(parseInt(query.get('limit') ?? '20', 10) || 20, 1), 100);
  const offset = Math.max(parseInt(query.get('offset') ?? '0', 10) || 0, 0);
  const q = (query.get('q') ?? '').trim();
  const status = query.get('status');

  const where = ['p.deleted_at IS NULL'];
  const args = [];
  if (q) {
    // Tìm KHÔNG DẤU (0048): vn_unaccent 2 vế — "ghe sofa" khớp "Ghế sofa".
    args.push('%' + likeEscape(q) + '%');
    where.push(`vn_unaccent(p.title) LIKE vn_unaccent($${args.length})`);
  }
  if (['draft', 'active', 'archived'].includes(status)) {
    args.push(status);
    where.push(`p.status = $${args.length}`);
  }
  const whereSql = where.join(' AND ');

  const data = await withTenant(ctx.shopId, async (c) => {
    const total = await c.query(`SELECT count(*)::int AS n FROM products p WHERE ${whereSql}`, args);
    const rows = await c.query(
      `SELECT p.id, p.slug, p.title, p.price_vnd, p.status, p.created_at,
              (SELECT count(*)::int FROM variants v WHERE v.product_id = p.id) AS variant_count,
              (SELECT m.public_key FROM media m
                 WHERE m.product_id = p.id AND m.status = 'ready' AND m.deleted_at IS NULL
                 ORDER BY m.position, m.created_at LIMIT 1) AS image_key
         FROM products p
        WHERE ${whereSql}
        ORDER BY p.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      args,
    );
    // image_key → image_url (ảnh chính) để admin hiện thumbnail; bỏ image_key khỏi payload.
    const products = rows.rows.map(({ image_key, ...p }) => ({
      ...p, image_url: image_key ? `${MEDIA_PUBLIC_BASE}/${image_key}` : null,
    }));
    return { total: total.rows[0].n, products, catalog_count: await catalogCount(c), max_products: await planMaxProducts(c) };
  });
  return send(res, 200, { ...data, limit, offset });
}

async function getProduct(res, ctx, _body, params) {
  const productId = params[1];
  const row = await withTenant(ctx.shopId, async (c) => {
    const p = await c.query(
      `SELECT id, slug, title, description, price_vnd, status, created_at
         FROM products WHERE id = $1 AND deleted_at IS NULL`,
      [productId],
    );
    if (p.rows.length === 0) return null;
    const variants = await c.query(
      `SELECT id, title, sku, price_vnd, position FROM variants WHERE product_id = $1 ORDER BY position`,
      [productId],
    );
    const cats = await c.query(`SELECT category_id FROM product_categories WHERE product_id = $1`, [productId]);
    // Trục biến thể (options + values) để UI dựng lại bộ thiết lập; specs = bảng thông số.
    const options = await c.query(
      `SELECT o.id, o.name, o.position,
              coalesce(json_agg(json_build_object('id', ov.id, 'value', ov.value, 'position', ov.position)
                       ORDER BY ov.position) FILTER (WHERE ov.id IS NOT NULL), '[]') AS values
         FROM product_options o LEFT JOIN option_values ov ON ov.option_id = o.id
        WHERE o.product_id = $1 GROUP BY o.id, o.name, o.position ORDER BY o.position`,
      [productId],
    );
    const specs = await c.query(`SELECT id, name, value, position FROM product_specs WHERE product_id = $1 ORDER BY position`, [productId]);
    return { ...p.rows[0], variants: variants.rows, category_ids: cats.rows.map((r) => r.category_id), options: options.rows, specs: specs.rows };
  });
  if (!row) return send(res, 404, { error: 'không tìm thấy sản phẩm' });
  return send(res, 200, row);
}

async function updateProduct(res, ctx, body, params) {
  const productId = params[1];
  const sets = [];
  const args = [];
  const add = (col, val) => { args.push(val); sets.push(`${col} = $${args.length}`); };

  if (body.title !== undefined) {
    if (!validTitle(body.title)) return send(res, 400, { error: 'tiêu đề không hợp lệ' });
    add('title', String(body.title).trim());
  }
  if (body.slug !== undefined) {
    const slug = String(body.slug).toLowerCase().trim();
    if (!validSlug(slug)) return send(res, 400, { error: 'slug không hợp lệ' });
    add('slug', slug);
  }
  if (body.description !== undefined) add('description', body.description != null ? String(body.description) : null);
  if (body.price_vnd !== undefined) {
    if (!validPrice(body.price_vnd)) return send(res, 400, { error: 'giá không hợp lệ' });
    add('price_vnd', body.price_vnd);
  }
  if (sets.length === 0) return send(res, 400, { error: 'không có trường nào để cập nhật' });

  try {
    const n = await withTenant(ctx.shopId, async (c) => {
      args.push(productId);
      const r = await c.query(
        `UPDATE products SET ${sets.join(', ')} WHERE id = $${args.length} AND deleted_at IS NULL`,
        args,
      );
      if (r.rowCount === 1) await audit(c, 'product.updated', { actorId: ctx.user.id, ip: ctx.ip, metadata: { productId } });
      return r.rowCount;
    });
    if (n !== 1) return send(res, 404, { error: 'không tìm thấy sản phẩm' });
    return send(res, 200, { ok: true });
  } catch (err) {
    if (err.code === '23505') return send(res, 409, { error: conflictMessage(err) });
    throw err;
  }
}

async function setStatus(res, ctx, productId, newStatus, action) {
  const n = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(
      `UPDATE products SET status = $1 WHERE id = $2 AND deleted_at IS NULL`,
      [newStatus, productId],
    );
    if (r.rowCount === 1) await audit(c, action, { actorId: ctx.user.id, ip: ctx.ip, metadata: { productId } });
    return r.rowCount;
  });
  if (n !== 1) return send(res, 404, { error: 'không tìm thấy sản phẩm' });
  return send(res, 200, { ok: true, status: newStatus });
}

async function deleteProduct(res, ctx, _body, params) {
  const productId = params[1];
  const n = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(
      `UPDATE products SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
      [productId],
    );
    if (r.rowCount === 1) await audit(c, 'product.deleted', { actorId: ctx.user.id, ip: ctx.ip, metadata: { productId } });
    return r.rowCount;
  });
  if (n !== 1) return send(res, 404, { error: 'không tìm thấy sản phẩm' });
  return send(res, 200, { ok: true });
}

// ── variants ─────────────────────────────────────────────────────────────────

async function addVariant(res, ctx, body, params) {
  const productId = params[1];
  if (!validSku(body.sku)) return send(res, 400, { error: 'SKU không hợp lệ' });
  if (!validPrice(body.price_vnd)) return send(res, 400, { error: 'giá không hợp lệ' });
  try {
    const out = await withTenant(ctx.shopId, async (c) => {
      // Sản phẩm phải tồn tại (composite FK cũng chặn, nhưng báo 404 rõ hơn).
      const p = await c.query(`SELECT 1 FROM products WHERE id = $1 AND deleted_at IS NULL`, [productId]);
      if (p.rows.length === 0) return { code: 404 };
      const pos = await c.query(`SELECT coalesce(max(position), -1) + 1 AS p FROM variants WHERE product_id = $1`, [productId]);
      const v = await c.query(
        `INSERT INTO variants (shop_id, product_id, title, sku, price_vnd, position)
         VALUES (current_shop_id(), $1, $2, $3, $4, $5) RETURNING id`,
        [productId, body.title != null ? String(body.title) : null, body.sku.trim(), body.price_vnd, pos.rows[0].p],
      );
      await audit(c, 'variant.added', { actorId: ctx.user.id, ip: ctx.ip, metadata: { productId, variantId: v.rows[0].id } });
      return { code: 201, id: v.rows[0].id };
    });
    if (out.code === 404) return send(res, 404, { error: 'không tìm thấy sản phẩm' });
    return send(res, 201, { id: out.id });
  } catch (err) {
    if (err.code === '23505') return send(res, 409, { error: conflictMessage(err) });
    throw err;
  }
}

// Sửa GIÁ / SKU một biến thể (ma trận sinh ra lấy giá sản phẩm — chủ shop chỉnh từng tổ hợp ở đây).
async function updateVariant(res, ctx, body, params) {
  const productId = params[1], variantId = params[2];
  const sets = [], args = [];
  if (body.price_vnd !== undefined) {
    if (!validPrice(body.price_vnd)) return send(res, 400, { error: 'giá không hợp lệ' });
    args.push(body.price_vnd); sets.push(`price_vnd = $${args.length}`);
  }
  if (body.sku !== undefined) {
    if (!validSku(body.sku)) return send(res, 400, { error: 'SKU không hợp lệ' });
    args.push(String(body.sku).trim()); sets.push(`sku = $${args.length}`);
  }
  if (!sets.length) return send(res, 400, { error: 'không có trường nào để cập nhật' });
  try {
    const n = await withTenant(ctx.shopId, async (c) => {
      args.push(variantId, productId);
      const r = await c.query(`UPDATE variants SET ${sets.join(', ')} WHERE id = $${args.length - 1} AND product_id = $${args.length}`, args);
      if (r.rowCount === 1) await audit(c, 'variant.updated', { actorId: ctx.user.id, ip: ctx.ip, metadata: { productId, variantId } });
      return r.rowCount;
    });
    if (n !== 1) return send(res, 404, { error: 'không tìm thấy biến thể' });
    return send(res, 200, { ok: true });
  } catch (err) {
    if (err.code === '23505') return send(res, 409, { error: conflictMessage(err) });
    throw err;
  }
}

async function deleteVariant(res, ctx, _body, params) {
  const productId = params[1];
  const variantId = params[2];
  const out = await withTenant(ctx.shopId, async (c) => {
    const cnt = await c.query(`SELECT count(*)::int AS n FROM variants WHERE product_id = $1`, [productId]);
    if (cnt.rows[0].n <= 1) {
      // Sản phẩm phải luôn còn ≥ 1 biến thể.
      const exists = await c.query(`SELECT 1 FROM variants WHERE id = $1 AND product_id = $2`, [variantId, productId]);
      if (exists.rows.length === 0) return { code: 404 };
      return { code: 409 };
    }
    const r = await c.query(`DELETE FROM variants WHERE id = $1 AND product_id = $2`, [variantId, productId]);
    if (r.rowCount === 0) return { code: 404 };
    await audit(c, 'variant.deleted', { actorId: ctx.user.id, ip: ctx.ip, metadata: { productId, variantId } });
    return { code: 200 };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy biến thể' });
  if (out.code === 409) return send(res, 409, { error: 'không thể xoá biến thể cuối cùng' });
  return send(res, 200, { ok: true });
}

// ── biến thể ĐA TRỤC (options/values → sinh ma trận) + thông số ────────────────
const MAX_OPTIONS = 3;
const MAX_VALUES = 30;
const MAX_COMBOS = 100;
const MAX_SPECS = 40;
const CTRL_RE = /[\u0000-\u001f]/; // cam ky tu dieu khien (chr(1)/chr(2) lam dau phan cach)
const validOptName = (x) => typeof x === 'string' && x.trim().length >= 1 && x.trim().length <= 40 && !CTRL_RE.test(x);
const validOptVal = (x) => typeof x === 'string' && x.trim().length >= 1 && x.trim().length <= 60 && !CTRL_RE.test(x);
const SEP1 = String.fromCharCode(1), SEP2 = String.fromCharCode(2); // khop chr(1)/chr(2) trong string_agg

const cartesian = (lists) => lists.reduce((acc, list) => acc.flatMap((c) => list.map((v) => [...c, v])), [[]]);
// Khoá tổ hợp bất biến theo (tên trục→giá trị), SORT theo tên (khớp string_agg SQL) → bền
// với đổi thứ tự trục; chỉ "trượt" khi ĐỔI TÊN trục/giá trị (khi đó tạo biến thể mới, biến
// thể cũ thành mồ côi = ẩn ở storefront, KHÔNG mất lịch sử đơn). / = dấu phân cách.
const comboKey = (pairs) => pairs.slice()
  .sort((a, b) => (a[0].toLowerCase() < b[0].toLowerCase() ? -1 : 1))
  .map(([n, v]) => `${n}${SEP1}${v}`).join(SEP2);

// Đặt/đổi TRỤC biến thể của 1 sản phẩm rồi SINH MA TRẬN (cartesian). Giữ giá/tồn/sku của
// tổ hợp không đổi; tổ hợp mới → tạo biến thể (giá = giá sản phẩm, tồn 0). variants vẫn là
// nguồn sự thật cho checkout — hàm này chỉ thêm lớp option + map biến thể ↔ tổ hợp.
async function saveProductOptions(res, ctx, body, params) {
  const productId = params[1];
  const raw = Array.isArray(body.options) ? body.options : [];
  if (raw.length > MAX_OPTIONS) return send(res, 400, { error: `tối đa ${MAX_OPTIONS} trục biến thể` });
  const options = [];
  for (const o of raw) {
    const name = String(o?.name ?? '').trim();
    if (!validOptName(name)) return send(res, 400, { error: 'tên trục không hợp lệ (1–40 ký tự)' });
    const vals = [...new Set((Array.isArray(o?.values) ? o.values : []).map((v) => String(v ?? '').trim()).filter((v) => v.length))];
    if (vals.length < 1) return send(res, 400, { error: `trục "${name}" cần ít nhất 1 giá trị` });
    if (vals.length > MAX_VALUES) return send(res, 400, { error: `trục "${name}" tối đa ${MAX_VALUES} giá trị` });
    for (const v of vals) if (!validOptVal(v)) return send(res, 400, { error: 'giá trị trục không hợp lệ (1–60 ký tự)' });
    options.push({ name, values: vals });
  }
  const onames = options.map((o) => o.name.toLowerCase());
  if (new Set(onames).size !== onames.length) return send(res, 400, { error: 'tên trục trùng nhau' });
  const comboCount = options.length ? options.reduce((n, o) => n * o.values.length, 1) : 0;
  if (comboCount > MAX_COMBOS) return send(res, 400, { error: `tổ hợp biến thể (${comboCount}) vượt ${MAX_COMBOS} — giảm bớt giá trị` });

  const out = await withTenant(ctx.shopId, async (c) => {
    const p = await c.query(`SELECT slug, price_vnd FROM products WHERE id = $1 AND deleted_at IS NULL`, [productId]);
    if (!p.rows.length) return { code: 404 };
    const slug = p.rows[0].slug, basePrice = Number(p.rows[0].price_vnd);

    // (1) Snapshot tổ hợp đang MAP (giữ giá/tồn/sku khi sửa) — TRƯỚC khi xoá options.
    const cur = await c.query(
      `SELECT v.id, string_agg(o.name || chr(1) || ov.value, chr(2) ORDER BY lower(o.name)) AS ckey
         FROM variants v
         JOIN variant_option_values vov ON vov.variant_id = v.id
         JOIN option_values ov ON ov.id = vov.option_value_id
         JOIN product_options o ON o.id = vov.option_id
        WHERE v.product_id = $1 GROUP BY v.id`, [productId]);
    const byCombo = new Map(cur.rows.map((r) => [r.ckey, r.id]));
    // (2) Pool biến thể CHƯA map (gồm biến thể phẳng gốc) — tái dùng trước khi tạo mới.
    const pool = (await c.query(
      `SELECT id FROM variants v WHERE v.product_id = $1
         AND NOT EXISTS (SELECT 1 FROM variant_option_values x WHERE x.variant_id = v.id) ORDER BY position`, [productId])).rows.map((r) => r.id);
    // SKU đang dùng trong shop → sinh SKU mới KHÔNG đụng (INSERT lỗi 23505 sẽ hỏng cả tx).
    const skuSet = new Set((await c.query(`SELECT sku FROM variants`)).rows.map((r) => r.sku));
    const genSku = (base) => {
      let s = String(base).slice(0, 58) || 'sku';
      while (skuSet.has(s)) s = String(base).slice(0, 52) + '-' + crypto.randomBytes(2).toString('hex');
      skuSet.add(s); return s;
    };

    // (3) Xoá options cũ (cascade values + vov). Biến thể GIỮ NGUYÊN (mất map → map lại/ẩn).
    await c.query(`DELETE FROM product_options WHERE product_id = $1`, [productId]);
    if (options.length === 0) {
      await audit(c, 'product.options_cleared', { actorId: ctx.user.id, ip: ctx.ip, metadata: { productId } });
      return { code: 200, combos: 0, created: 0, reused: 0 };
    }

    // (4) Chèn options + values, ghi lại id để map.
    const optRows = [];
    for (let oi = 0; oi < options.length; oi++) {
      const or = await c.query(`INSERT INTO product_options (shop_id, product_id, name, position) VALUES (current_shop_id(), $1, $2, $3) RETURNING id`, [productId, options[oi].name, oi]);
      const valueIds = new Map();
      for (let vi = 0; vi < options[oi].values.length; vi++) {
        const vr = await c.query(`INSERT INTO option_values (shop_id, option_id, value, position) VALUES (current_shop_id(), $1, $2, $3) RETURNING id`, [or.rows[0].id, options[oi].values[vi], vi]);
        valueIds.set(options[oi].values[vi], vr.rows[0].id);
      }
      optRows.push({ id: or.rows[0].id, valueIds });
    }

    // (5) Cartesian → tái dùng theo combo → pool → tạo mới; luôn map lại vov.
    const combos = cartesian(options.map((o) => o.values));
    let created = 0, reused = 0;
    for (let ci = 0; ci < combos.length; ci++) {
      const values = combos[ci];
      const key = comboKey(options.map((o, i) => [o.name, values[i]]));
      const title = values.join(' / ');
      let variantId = byCombo.get(key);
      if (variantId) { await c.query(`UPDATE variants SET title = $2, position = $3 WHERE id = $1`, [variantId, title, ci]); reused++; }
      else if (pool.length) {
        // Tái dùng id/sku của biến thể CHƯA MAP (gồm mồ côi lần sửa trước) cho tổ hợp MỚI —
        // nhưng tổ hợp mới PHẢI về giá sản phẩm + phần bán được = 0 (như nhánh tạo mới),
        // nếu không nó KẾ THỪA giá khuyến mãi/tồn của biến thể cũ → bán sai giá + oversell.
        variantId = pool.shift();
        await c.query(`UPDATE variants SET title = $2, position = $3, price_vnd = $4 WHERE id = $1`, [variantId, title, ci, basePrice]);
        // Hạ on_hand = reserved (available về 0; GIỮ reserve của đơn đang chờ — CHECK reserved<=on_hand).
        const lvl = (await c.query(`SELECT on_hand, reserved FROM inventory_levels WHERE variant_id = $1`, [variantId])).rows[0];
        if (lvl && Number(lvl.on_hand) > Number(lvl.reserved)) {
          await c.query(`UPDATE inventory_levels SET on_hand = reserved, updated_at = now() WHERE variant_id = $1`, [variantId]);
          await c.query(
            `INSERT INTO inventory_ledger (shop_id, variant_id, delta, kind, reason, actor_id)
             VALUES (current_shop_id(), $1, $2, 'adjust', 'tái dùng biến thể cho tổ hợp mới (reset tồn)', $3)`,
            [variantId, Number(lvl.reserved) - Number(lvl.on_hand), ctx.user.id],
          );
        }
        reused++;
      }
      else {
        const sku = genSku(`${slug}-${slugify(values.join('-'))}`);
        variantId = (await c.query(`INSERT INTO variants (shop_id, product_id, title, sku, price_vnd, position) VALUES (current_shop_id(), $1, $2, $3, $4, $5) RETURNING id`, [productId, title, sku, basePrice, ci])).rows[0].id;
        created++;
      }
      for (let i = 0; i < options.length; i++) {
        await c.query(`INSERT INTO variant_option_values (shop_id, variant_id, option_id, option_value_id) VALUES (current_shop_id(), $1, $2, $3)`,
          [variantId, optRows[i].id, optRows[i].valueIds.get(values[i])]);
      }
    }
    await audit(c, 'product.options_saved', { actorId: ctx.user.id, ip: ctx.ip, metadata: { productId, combos: combos.length, created, reused } });
    return { code: 200, combos: combos.length, created, reused };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy sản phẩm' });
  return send(res, 200, { ok: true, combos: out.combos, generated: out.created, reused: out.reused });
}

// Đặt LẠI toàn bộ thông số kỹ thuật của sản phẩm (thay cả tập; dòng trống bị bỏ qua).
async function setProductSpecs(res, ctx, body, params) {
  const productId = params[1];
  const raw = Array.isArray(body.specs) ? body.specs : [];
  if (raw.length > MAX_SPECS) return send(res, 400, { error: `tối đa ${MAX_SPECS} thông số` });
  const specs = [];
  for (const s of raw) {
    const name = String(s?.name ?? '').trim();
    const value = String(s?.value ?? '').trim();
    if (!name && !value) continue;
    if (name.length < 1 || name.length > 60) return send(res, 400, { error: 'tên thông số không hợp lệ (1–60 ký tự)' });
    if (value.length < 1 || value.length > 200) return send(res, 400, { error: 'giá trị thông số không hợp lệ (1–200 ký tự)' });
    specs.push({ name, value });
  }
  const out = await withTenant(ctx.shopId, async (c) => {
    const p = await c.query(`SELECT 1 FROM products WHERE id = $1 AND deleted_at IS NULL`, [productId]);
    if (!p.rows.length) return { code: 404 };
    await c.query(`DELETE FROM product_specs WHERE product_id = $1`, [productId]);
    for (let i = 0; i < specs.length; i++) {
      await c.query(`INSERT INTO product_specs (shop_id, product_id, name, value, position) VALUES (current_shop_id(), $1, $2, $3, $4)`, [productId, specs[i].name, specs[i].value, i]);
    }
    await audit(c, 'product.specs_set', { actorId: ctx.user.id, ip: ctx.ip, metadata: { productId, n: specs.length } });
    return { code: 200, n: specs.length };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy sản phẩm' });
  return send(res, 200, { ok: true, count: out.n });
}

// ── categories ───────────────────────────────────────────────────────────────

async function listCategories(res, ctx) {
  const rows = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(
      `SELECT id, slug, name, position FROM categories WHERE deleted_at IS NULL ORDER BY position, name`,
    );
    return r.rows;
  });
  return send(res, 200, { categories: rows });
}

async function createCategory(res, ctx, body) {
  const slug = String(body.slug ?? '').toLowerCase().trim();
  const name = String(body.name ?? '').trim();
  const position = isInt(body.position) ? body.position : 0;
  if (!validSlug(slug)) return send(res, 400, { error: 'slug không hợp lệ' });
  if (name.length < 1 || name.length > 200) return send(res, 400, { error: 'tên danh mục không hợp lệ' });
  try {
    const id = await withTenant(ctx.shopId, async (c) => {
      const r = await c.query(
        `INSERT INTO categories (shop_id, slug, name, position) VALUES (current_shop_id(), $1, $2, $3) RETURNING id`,
        [slug, name, position],
      );
      await audit(c, 'category.created', { actorId: ctx.user.id, ip: ctx.ip, metadata: { slug } });
      return r.rows[0].id;
    });
    return send(res, 201, { id, slug, name });
  } catch (err) {
    if (err.code === '23505') return send(res, 409, { error: 'slug danh mục đã tồn tại' });
    throw err;
  }
}

async function updateCategory(res, ctx, body, params) {
  const catId = params[1];
  const sets = [], args = [];
  if (body.name !== undefined) { const n = String(body.name).trim(); if (n.length < 1 || n.length > 200) return send(res, 400, { error: 'tên danh mục không hợp lệ' }); args.push(n); sets.push(`name = $${args.length}`); }
  if (body.position !== undefined && isInt(body.position)) { args.push(body.position); sets.push(`position = $${args.length}`); }
  if (!sets.length) return send(res, 400, { error: 'không có gì để cập nhật' });
  args.push(catId);
  const out = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(`UPDATE categories SET ${sets.join(', ')} WHERE id = $${args.length} AND deleted_at IS NULL`, args);
    if (r.rowCount === 0) return { code: 404 };
    await audit(c, 'category.updated', { actorId: ctx.user.id, ip: ctx.ip, metadata: { catId } });
    return { code: 200 };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy danh mục' });
  return send(res, 200, { ok: true });
}

async function deleteCategory(res, ctx, _body, params) {
  const catId = params[1];
  const out = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(`UPDATE categories SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [catId]);
    if (r.rowCount === 0) return { code: 404 };
    await c.query(`DELETE FROM product_categories WHERE category_id = $1`, [catId]); // gỡ gán (giữ sản phẩm)
    await audit(c, 'category.deleted', { actorId: ctx.user.id, ip: ctx.ip, metadata: { catId } });
    return { code: 200 };
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy danh mục' });
  return send(res, 200, { ok: true });
}

// Đặt LẠI toàn bộ danh mục của một sản phẩm (thay thế tập). Composite FK (shop_id,
// category_id) chặn gán danh mục shop khác → 23503.
async function setProductCategories(res, ctx, body, params) {
  const productId = params[1];
  const ids = Array.isArray(body.category_ids) ? [...new Set(body.category_ids.filter((x) => typeof x === 'string'))] : [];
  try {
    const out = await withTenant(ctx.shopId, async (c) => {
      const p = await c.query(`SELECT 1 FROM products WHERE id = $1 AND deleted_at IS NULL`, [productId]);
      if (p.rows.length === 0) return { code: 404 };
      await c.query(`DELETE FROM product_categories WHERE product_id = $1`, [productId]);
      for (const catId of ids) {
        await c.query(
          `INSERT INTO product_categories (shop_id, product_id, category_id) VALUES (current_shop_id(), $1, $2) ON CONFLICT DO NOTHING`,
          [productId, catId],
        );
      }
      await audit(c, 'product.categories_set', { actorId: ctx.user.id, ip: ctx.ip, metadata: { productId, n: ids.length } });
      return { code: 200 };
    });
    if (out.code === 404) return send(res, 404, { error: 'không tìm thấy sản phẩm' });
    return send(res, 200, { ok: true });
  } catch (err) {
    if (err.code === '23503') return send(res, 400, { error: 'danh mục không hợp lệ' });
    throw err;
  }
}

// ── Nhập sản phẩm hàng loạt (BFF đã parse CSV → mảng rows). Mỗi dòng = 1 sản phẩm
// + 1 biến thể + tồn ban đầu, trong MỘT transaction RIÊNG → thành công một phần +
// báo lỗi từng dòng. Dùng để onboard concierge nhanh (khỏi gõ tay từng SKU). ──
const IMPORT_MAX_ROWS = 1000;
// Bỏ dấu tiếng Việt → slug a-z0-9-. (Chỉ tạo khi cột slug trống/không hợp lệ.)
function slugify(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '')
    .slice(0, 58);
}
async function importProducts(res, ctx, body) {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) return send(res, 400, { error: 'không có dòng nào để nhập' });
  if (rows.length > IMPORT_MAX_ROWS) return send(res, 413, { error: `tối đa ${IMPORT_MAX_ROWS} dòng mỗi lần nhập` });

  // Ép giới hạn gói: đọc max + số SP hiện có một lần; chặn khi chạm trần trong lúc nhập.
  const cap = await withTenant(ctx.shopId, async (c) => ({ max: await planMaxProducts(c), count: await catalogCount(c) }));
  const seen = new Set(); // tránh slug trùng NGAY trong batch
  let created = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] ?? {};
    const line = i + 2; // dòng 1 là tiêu đề trong file người dùng
    const title = String(r.title ?? '').trim();
    const priceStr = String(r.price_vnd ?? '').replace(/[^\d-]/g, '');
    const priceVnd = priceStr === '' ? NaN : Number.parseInt(priceStr, 10);
    const sku = String(r.sku ?? '').trim();
    const status = String(r.status ?? '').trim().toLowerCase() === 'active' ? 'active' : 'draft';
    const description = (r.description != null && String(r.description).trim() !== '') ? String(r.description) : null;
    const stockStr = String(r.stock ?? '').replace(/[^\d-]/g, '');
    const stock = stockStr === '' ? 0 : Number.parseInt(stockStr, 10);

    if (!validTitle(title)) { errors.push({ line, title, error: 'tiêu đề trống hoặc quá dài' }); continue; }
    if (!validPrice(priceVnd)) { errors.push({ line, title, error: 'giá không hợp lệ' }); continue; }
    if (!validSku(sku)) { errors.push({ line, title, error: 'SKU trống hoặc quá dài' }); continue; }
    if (!isInt(stock) || stock < 0) { errors.push({ line, title, error: 'tồn kho không hợp lệ' }); continue; }

    if (cap.max != null && cap.count + created >= cap.max) { errors.push({ line, title, error: `vượt giới hạn gói (${cap.max} sản phẩm)` }); continue; }

    let slug = String(r.slug ?? '').toLowerCase().trim();
    if (!validSlug(slug)) slug = slugify(title);
    if (!slug) { errors.push({ line, title, error: 'không tạo được slug từ tiêu đề' }); continue; }
    if (seen.has(slug)) { let n = 2; while (seen.has(`${slug}-${n}`)) n++; slug = `${slug}-${n}`.slice(0, 60); }
    seen.add(slug);

    try {
      await withTenant(ctx.shopId, async (c) => {
        const p = await c.query(
          `INSERT INTO products (shop_id, slug, title, description, price_vnd, status)
           VALUES (current_shop_id(), $1, $2, $3, $4, $5) RETURNING id`,
          [slug, title, description, priceVnd, status],
        );
        const productId = p.rows[0].id;
        const vr = await c.query(
          `INSERT INTO variants (shop_id, product_id, title, sku, price_vnd, position)
           VALUES (current_shop_id(), $1, NULL, $2, $3, 0) RETURNING id`,
          [productId, sku, priceVnd],
        );
        if (stock > 0) {
          // Đặt tồn ban đầu + ghi ledger (giữ bất biến tổng delta ledger == on_hand).
          await c.query(`INSERT INTO inventory_levels (shop_id, variant_id, on_hand) VALUES (current_shop_id(), $1, $2)`, [vr.rows[0].id, stock]);
          await c.query(
            `INSERT INTO inventory_ledger (shop_id, variant_id, delta, kind, reason, actor_id)
             VALUES (current_shop_id(), $1, $2, 'receive', 'nhập từ CSV', $3)`,
            [vr.rows[0].id, stock, ctx.user.id],
          );
        }
        await audit(c, 'product.imported', { actorId: ctx.user.id, ip: ctx.ip, metadata: { productId, slug } });
      });
      created++;
    } catch (err) {
      // withTenant rollback-on-throw → không để lại sản phẩm thiếu biến thể. Ghi lỗi
      // dòng và ĐI TIẾP (import phải thành công một phần), không throw ra 500.
      seen.delete(slug); // dòng lỗi không chiếm slug
      errors.push({ line, title, error: err.code === '23505' ? conflictMessage(err) : 'lỗi khi tạo sản phẩm' });
    }
  }
  return send(res, 200, { created, failed: errors.length, errors: errors.slice(0, 100) });
}

// ── routes (perm gác ở router server.js) ─────────────────────────────────────
export const CATALOG_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/products$`), perm: 'catalog.read', fn: (res, ctx, b, p, q) => listProducts(res, ctx, b, p, q) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/products$`), perm: 'catalog.write', fn: (res, ctx, b) => createProduct(res, ctx, b) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/products/import$`), perm: 'catalog.write', fn: (res, ctx, b) => importProducts(res, ctx, b) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/products/${UUID}$`), perm: 'catalog.read', fn: (res, ctx, b, p) => getProduct(res, ctx, b, p) },
  { m: 'PATCH', re: new RegExp(`^/shops/${UUID}/products/${UUID}$`), perm: 'catalog.write', fn: (res, ctx, b, p) => updateProduct(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/products/${UUID}/publish$`), perm: 'catalog.write', fn: (res, ctx, b, p) => setStatus(res, ctx, p[1], 'active', 'product.published') },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/products/${UUID}/archive$`), perm: 'catalog.write', fn: (res, ctx, b, p) => setStatus(res, ctx, p[1], 'archived', 'product.archived') },
  { m: 'DELETE', re: new RegExp(`^/shops/${UUID}/products/${UUID}$`), perm: 'catalog.write', fn: (res, ctx, b, p) => deleteProduct(res, ctx, b, p) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/products/${UUID}/variants$`), perm: 'catalog.write', fn: (res, ctx, b, p) => addVariant(res, ctx, b, p) },
  { m: 'PATCH', re: new RegExp(`^/shops/${UUID}/products/${UUID}/variants/${UUID}$`), perm: 'catalog.write', fn: (res, ctx, b, p) => updateVariant(res, ctx, b, p) },
  { m: 'DELETE', re: new RegExp(`^/shops/${UUID}/products/${UUID}/variants/${UUID}$`), perm: 'catalog.write', fn: (res, ctx, b, p) => deleteVariant(res, ctx, b, p) },
  { m: 'PUT', re: new RegExp(`^/shops/${UUID}/products/${UUID}/options$`), perm: 'catalog.write', fn: (res, ctx, b, p) => saveProductOptions(res, ctx, b, p) },
  { m: 'PUT', re: new RegExp(`^/shops/${UUID}/products/${UUID}/specs$`), perm: 'catalog.write', fn: (res, ctx, b, p) => setProductSpecs(res, ctx, b, p) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/categories$`), perm: 'catalog.read', fn: (res, ctx) => listCategories(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/categories$`), perm: 'catalog.write', fn: (res, ctx, b) => createCategory(res, ctx, b) },
  { m: 'PATCH', re: new RegExp(`^/shops/${UUID}/categories/${UUID}$`), perm: 'catalog.write', fn: (res, ctx, b, p) => updateCategory(res, ctx, b, p) },
  { m: 'DELETE', re: new RegExp(`^/shops/${UUID}/categories/${UUID}$`), perm: 'catalog.write', fn: (res, ctx, b, p) => deleteCategory(res, ctx, b, p) },
  { m: 'PUT', re: new RegExp(`^/shops/${UUID}/products/${UUID}/categories$`), perm: 'catalog.write', fn: (res, ctx, b, p) => setProductCategories(res, ctx, b, p) },
];
