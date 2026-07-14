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
      return productId;
    });
    return send(res, 201, { id: out, slug, status });
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
    args.push('%' + likeEscape(q) + '%');
    where.push(`p.title ILIKE $${args.length}`);
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
              (SELECT count(*)::int FROM variants v WHERE v.product_id = p.id) AS variant_count
         FROM products p
        WHERE ${whereSql}
        ORDER BY p.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      args,
    );
    return { total: total.rows[0].n, products: rows.rows };
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
    return { ...p.rows[0], variants: variants.rows, category_ids: cats.rows.map((r) => r.category_id) };
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
  { m: 'DELETE', re: new RegExp(`^/shops/${UUID}/products/${UUID}/variants/${UUID}$`), perm: 'catalog.write', fn: (res, ctx, b, p) => deleteVariant(res, ctx, b, p) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/categories$`), perm: 'catalog.read', fn: (res, ctx) => listCategories(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/categories$`), perm: 'catalog.write', fn: (res, ctx, b) => createCategory(res, ctx, b) },
];
