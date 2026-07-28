/**
 * Di cư danh mục từ sàn khác — docs/45.
 *
 * Khác bộ nhập cũ ở một điểm cốt lõi: nhiều dòng CSV cùng `handle` gộp thành MỘT sản phẩm
 * nhiều biến thể, thay vì mỗi dòng một sản phẩm rời. Sản phẩm 3 màu × 4 size của shop đang
 * bán ở sàn khác phải sang đây vẫn là 1 sản phẩm 12 biến thể, không phải 12 sản phẩm.
 *
 * Sinh biến thể ở đây là THƯA, cố ý khác setOptions() của catalog.js vốn sinh MA TRẬN đầy
 * đủ: file nhập chỉ liệt kê tổ hợp shop THẬT SỰ bán (Đỏ/S, Đỏ/M, Xanh/L). Sinh ma trận sẽ
 * đẻ ra biến thể họ không có hàng, kèm SKU bịa — người bán thấy tồn kho sai ngay ngày đầu.
 *
 * Đơn vị thành-công-một-phần là SẢN PHẨM, không phải dòng: nhóm lỗi thì bỏ cả nhóm. Nhập
 * nửa vời một sản phẩm (thiếu vài biến thể) tệ hơn không nhập, vì người bán không nhìn ra.
 */

import crypto from 'node:crypto';
import { send } from './http.js';
import { withTenant, audit } from './db.js';
import {
  isInt, validPrice, validTitle, validSku, validSlug, validWeight, validCompareAt, validCost,
  slugify, planMaxProducts, catalogCount, conflictMessage,
} from './catalog.js';

const IMPORT_MAX_ROWS = 1000;
const MAX_VARIANTS_PER_PRODUCT = 100;   // cùng trần với ma trận biến thể (0041-0043)
const MAX_OPTIONS = 3;
const MAX_CATEGORY_DEPTH = 2;           // 0095: chỉ 2 cấp

// ── Bí danh cột ────────────────────────────────────────────────────────────
// Chuẩn hoá tên cột trước khi so: bỏ dấu cách/gạch/ngoặc, hạ hoa thường. Nhờ vậy
// "Variant SKU", "variant_sku", "VariantSKU" là một.
const normKey = (k) => String(k ?? '').trim().toLowerCase().replace(/[\s_\-().]+/g, '');

// Bí danh cho định dạng Shopify (Haravan/Sapo là dòng dõi Shopify nên trùng phần lớn).
// CƠ CHẾ LÀ DỮ LIỆU: có file xuất thật của sàn khác thì thêm một chuỗi vào mảng, không sửa
// logic. docs/45 ghi rõ Shopee/Sapo CHƯA được đối chiếu bằng file thật.
const COLS = {
  handle: ['handle'],
  title: ['title', 'name', 'productname', 'tensanpham'],
  description: ['description', 'bodyhtml', 'body', 'mota'],
  status: ['status', 'published'],
  slug: ['slug'],
  category: ['category', 'type', 'producttype', 'productcategory', 'danhmuc'],
  sku: ['sku', 'variantsku', 'masku'],
  price_vnd: ['pricevnd', 'price', 'variantprice', 'giaban'],
  compare_at_price_vnd: ['compareatpricevnd', 'compareatprice', 'variantcompareatprice', 'giagach'],
  cost_vnd: ['costvnd', 'cost', 'costperitem', 'giavon'],
  stock: ['stock', 'qty', 'quantity', 'variantinventoryqty', 'inventoryqty', 'tonkho'],
  // CỐ Ý KHÔNG nhận cột "weight" trần: Shopify có "Variant Weight Unit" riêng (g/kg/lb), nên
  // một cột "Weight: 1.5" có thể là 1.5kg. Đoán nhầm đơn vị = sai cân 1000 lần = SAI PHÍ SHIP,
  // tức sai tiền. Chỉ nhận cột đã nói rõ là gram.
  weight_gram: ['weightgram', 'grams', 'variantgrams', 'weightgrams', 'cannang gram'],
  image_url: ['imageurl', 'imagesrc', 'image', 'anh'],
};
for (let i = 1; i <= MAX_OPTIONS; i++) {
  COLS[`option${i}_name`] = [`option${i}name`, `tentruc${i}`];
  COLS[`option${i}_value`] = [`option${i}value`, `giatritruc${i}`];
}

/** Đổi một dòng thô (khoá = tiêu đề cột trong file) sang khoá chuẩn. */
function mapRow(raw) {
  const byNorm = new Map();
  for (const k of Object.keys(raw ?? {})) byNorm.set(normKey(k), raw[k]);
  const out = {};
  for (const [canon, aliases] of Object.entries(COLS)) {
    for (const a of aliases) {
      if (byNorm.has(a)) { out[canon] = byNorm.get(a); break; }
    }
  }
  return out;
}

const str = (v) => String(v ?? '').trim();
/** Số nguyên từ chuỗi người dùng: bỏ mọi ký tự không phải số (dấu chấm phân nhóm, "₫", "đ"). */
const intOf = (v, dflt = null) => {
  const s = String(v ?? '').replace(/[^\d-]/g, '');
  if (s === '') return dflt;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? dflt : n;
};

// ── Gộp dòng thành nhóm sản phẩm ───────────────────────────────────────────
/**
 * File KHÔNG có cột handle ⇒ mỗi dòng một sản phẩm (nguyên hành vi bộ nhập cũ, kể cả khi
 * trùng tên). Có cột nhưng ô trống ⇒ dòng đó vẫn đứng riêng.
 * CỐ Ý không gộp theo `title`: hai sản phẩm khác nhau trùng tên là chuyện thường ở danh mục
 * thật; gộp nhầm thì người bán mất hàng mà không hề thấy báo lỗi.
 */
function groupRows(rows, hasHandleColumn) {
  const groups = [];
  const byKey = new Map();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 2;                                   // dòng 1 là tiêu đề trong file
    const h = hasHandleColumn ? slugify(str(r.handle)) : '';
    if (!h) { groups.push({ key: null, rows: [{ line, r }] }); continue; }
    let g = byKey.get(h);
    if (!g) { g = { key: h, rows: [] }; byKey.set(h, g); groups.push(g); }
    g.rows.push({ line, r });
  }
  return groups;
}

// ── Kiểm một nhóm → mô tả sản phẩm, hoặc lỗi ───────────────────────────────
/**
 * Trả { ok: true, product } hoặc { ok: false, error, line }.
 * Mọi lỗi đều kèm SỐ DÒNG trong file gốc — người bán sửa file chứ không sửa cơ sở dữ liệu.
 */
function buildProduct(group) {
  const head = group.rows[0];
  const h = head.r;
  const title = str(h.title);
  if (!validTitle(title)) return { ok: false, line: head.line, error: 'tiêu đề trống hoặc quá dài' };

  if (group.rows.length > MAX_VARIANTS_PER_PRODUCT) {
    return { ok: false, line: head.line, error: `quá ${MAX_VARIANTS_PER_PRODUCT} biến thể trong một sản phẩm` };
  }

  // Trục: lấy tên từ dòng ĐẦU TIÊN khai trục đó. Trong một nhóm, tên trục phải nhất quán —
  // lệch thì cả nhóm bị từ chối kèm số dòng lệch (xem chú thích đầu file).
  const axisNames = [];
  for (let i = 1; i <= MAX_OPTIONS; i++) {
    for (const { r } of group.rows) {
      const n = str(r[`option${i}_name`]);
      if (n) { axisNames[i - 1] = n; break; }
    }
  }
  const axes = [];
  for (let i = 0; i < MAX_OPTIONS; i++) {
    if (!axisNames[i]) break;                              // trục phải liên tục từ 1
    axes.push({ name: axisNames[i], idx: i + 1, values: [] });
  }
  for (const { line, r } of group.rows) {
    for (const ax of axes) {
      const n = str(r[`option${ax.idx}_name`]);
      if (n && n !== ax.name) {
        return { ok: false, line, error: `tên trục ${ax.idx} lệch ("${n}" ≠ "${ax.name}") — cả nhóm bị bỏ` };
      }
    }
  }
  if (axes.length === 0 && group.rows.length > 1) {
    return { ok: false, line: head.line, error: 'nhóm nhiều dòng nhưng không khai trục biến thể (option1_name)' };
  }

  // Biến thể: mỗi dòng một biến thể, giá trị trục lấy đúng dòng đó.
  const variants = [];
  const comboSeen = new Set();
  const skuSeen = new Set();
  for (const { line, r } of group.rows) {
    const sku = str(r.sku);
    if (!validSku(sku)) return { ok: false, line, error: 'SKU trống hoặc quá dài' };
    if (skuSeen.has(sku)) return { ok: false, line, error: `SKU "${sku}" lặp trong cùng sản phẩm` };
    skuSeen.add(sku);

    const price = intOf(r.price_vnd);
    if (!validPrice(price)) return { ok: false, line, error: 'giá không hợp lệ' };

    const compareAt = r.compare_at_price_vnd === undefined || str(r.compare_at_price_vnd) === '' ? null : intOf(r.compare_at_price_vnd);
    if (!validCompareAt(compareAt)) return { ok: false, line, error: 'giá gạch ngang không hợp lệ' };
    // Giá gạch phải CAO HƠN giá bán, nếu không badge giảm giá ra số âm.
    if (compareAt !== null && compareAt <= price) return { ok: false, line, error: 'giá gạch ngang phải lớn hơn giá bán' };

    const cost = r.cost_vnd === undefined || str(r.cost_vnd) === '' ? null : intOf(r.cost_vnd);
    if (!validCost(cost)) return { ok: false, line, error: 'giá vốn không hợp lệ' };

    const weight = r.weight_gram === undefined || str(r.weight_gram) === '' ? null : intOf(r.weight_gram);
    if (!validWeight(weight)) return { ok: false, line, error: 'cân nặng (gram) không hợp lệ' };

    const stock = intOf(r.stock, 0);
    if (!isInt(stock) || stock < 0) return { ok: false, line, error: 'tồn kho không hợp lệ' };

    const values = [];
    for (const ax of axes) {
      const v = str(r[`option${ax.idx}_value`]);
      if (!v) return { ok: false, line, error: `thiếu giá trị trục "${ax.name}"` };
      values.push(v);
      if (!ax.values.includes(v)) ax.values.push(v);
    }
    const combo = values.join(' ');
    if (comboSeen.has(combo)) {
      return { ok: false, line, error: `tổ hợp "${values.join(' / ')}" lặp trong cùng sản phẩm` };
    }
    comboSeen.add(combo);

    variants.push({ sku, price, compareAt, cost, weight, stock, values, imageUrl: str(r.image_url), line });
  }

  // Giá CẤP SẢN PHẨM = nhỏ nhất trong nhóm — khớp cách storefront hiện "từ ...₫".
  const basePrice = Math.min(...variants.map((v) => v.price));

  const statusRaw = str(h.status).toLowerCase();
  // Mặc định `draft` là CỐ Ý: nhập xong không tự bày bán. Người bán soát giá/ảnh rồi mới đăng.
  const status = (statusRaw === 'active' || statusRaw === 'true' || statusRaw === 'published') ? 'active' : 'draft';

  let slug = str(h.slug).toLowerCase();
  if (!validSlug(slug)) slug = group.key || slugify(title);
  if (!slug) return { ok: false, line: head.line, error: 'không tạo được slug từ tiêu đề' };

  // Danh mục: "Thịt > Thịt heo". Cắt khoảng trắng, bỏ đoạn rỗng.
  const catPath = str(h.category).split('>').map((s) => s.trim()).filter(Boolean);
  if (catPath.length > MAX_CATEGORY_DEPTH) {
    return { ok: false, line: head.line, error: `danh mục quá ${MAX_CATEGORY_DEPTH} cấp` };
  }

  return {
    ok: true,
    product: {
      line: head.line, title, slug, status, basePrice, catPath, axes, variants,
      description: str(h.description) === '' ? null : String(h.description),
    },
  };
}

// ── Danh mục: tìm-hoặc-tạo theo đường dẫn ──────────────────────────────────
/** Trả category_id lá, hoặc null nếu không có đường dẫn. Tôn trọng cây 2 cấp của 0095. */
async function ensureCategory(c, path) {
  let parentId = null;
  let catId = null;
  for (let depth = 0; depth < path.length; depth++) {
    const name = path[depth].slice(0, 120);
    const slug = slugify(name) || `dm-${crypto.randomBytes(3).toString('hex')}`;
    const found = await c.query(
      `SELECT id, parent_id FROM categories WHERE slug = $1 AND deleted_at IS NULL`, [slug],
    );
    if (found.rows.length) {
      // Danh mục đã có nhưng nằm ở nhánh khác: DÙNG LẠI chứ không tạo bản sao. Tạo trùng tên
      // khác nhánh sẽ làm menu storefront có hai mục giống hệt nhau.
      catId = found.rows[0].id;
    } else {
      const ins = await c.query(
        `INSERT INTO categories (shop_id, slug, name, parent_id, position)
         VALUES (current_shop_id(), $1, $2, $3, 0) RETURNING id`,
        [slug, name, parentId],
      );
      catId = ins.rows[0].id;
    }
    parentId = catId;
  }
  return catId;
}

// ── Ghi một sản phẩm (một transaction cho cả nhóm) ─────────────────────────
async function insertProduct(ctx, p) {
  return withTenant(ctx.shopId, async (c) => {
    const pr = await c.query(
      `INSERT INTO products (shop_id, slug, title, description, price_vnd, status)
       VALUES (current_shop_id(), $1, $2, $3, $4, $5) RETURNING id`,
      [p.slug, p.title, p.description, p.basePrice, p.status],
    );
    const productId = pr.rows[0].id;

    if (p.catPath.length) {
      const catId = await ensureCategory(c, p.catPath);
      if (catId) {
        await c.query(
          `INSERT INTO product_categories (shop_id, product_id, category_id) VALUES (current_shop_id(), $1, $2)
           ON CONFLICT DO NOTHING`, [productId, catId],
        );
      }
    }

    // Trục + giá trị. Thứ tự giá trị theo thứ tự XUẤT HIỆN trong file, không sắp lại —
    // người bán đã xếp "S, M, L" theo ý họ; sắp theo bảng chữ cái sẽ thành "L, M, S".
    const optIds = [];
    for (let ai = 0; ai < p.axes.length; ai++) {
      const ax = p.axes[ai];
      const or = await c.query(
        `INSERT INTO product_options (shop_id, product_id, name, position) VALUES (current_shop_id(), $1, $2, $3) RETURNING id`,
        [productId, ax.name.slice(0, 60), ai],
      );
      const valueIds = new Map();
      for (let vi = 0; vi < ax.values.length; vi++) {
        const vr = await c.query(
          `INSERT INTO option_values (shop_id, option_id, value, position) VALUES (current_shop_id(), $1, $2, $3) RETURNING id`,
          [or.rows[0].id, ax.values[vi].slice(0, 60), vi],
        );
        valueIds.set(ax.values[vi], vr.rows[0].id);
      }
      optIds.push({ id: or.rows[0].id, valueIds });
    }

    for (let vi = 0; vi < p.variants.length; vi++) {
      const v = p.variants[vi];
      const title = v.values.length ? v.values.join(' / ') : null;
      const vr = await c.query(
        `INSERT INTO variants (shop_id, product_id, title, sku, price_vnd, compare_at_vnd, weight_gram, position)
         VALUES (current_shop_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [productId, title, v.sku, v.price, v.compareAt, v.weight, vi],
      );
      const variantId = vr.rows[0].id;

      for (let ai = 0; ai < p.axes.length; ai++) {
        await c.query(
          `INSERT INTO variant_option_values (shop_id, variant_id, option_id, option_value_id)
           VALUES (current_shop_id(), $1, $2, $3)`,
          [variantId, optIds[ai].id, optIds[ai].valueIds.get(v.values[ai])],
        );
      }

      if (v.cost !== null) {
        await c.query(
          `INSERT INTO variant_costs (shop_id, variant_id, cost_vnd, updated_by) VALUES (current_shop_id(), $1, $2, $3)`,
          [variantId, v.cost, ctx.user.id],
        );
      }

      if (v.stock > 0) {
        // Đặt tồn ban đầu + ghi sổ cái, giữ bất biến tổng delta ledger == on_hand.
        await c.query(`INSERT INTO inventory_levels (shop_id, variant_id, on_hand) VALUES (current_shop_id(), $1, $2)`, [variantId, v.stock]);
        await c.query(
          `INSERT INTO inventory_ledger (shop_id, variant_id, delta, kind, reason, actor_id)
           VALUES (current_shop_id(), $1, $2, 'receive', 'nhập từ CSV', $3)`,
          [variantId, v.stock, ctx.user.id],
        );
      }
    }

    await audit(c, 'product.imported', {
      actorId: ctx.user.id, ip: ctx.ip,
      metadata: { productId, slug: p.slug, variants: p.variants.length, axes: p.axes.length },
    });
    return productId;
  });
}

// ── Handler ────────────────────────────────────────────────────────────────
export async function importProducts(res, ctx, body) {
  const raw = Array.isArray(body.rows) ? body.rows : [];
  if (raw.length === 0) return send(res, 400, { error: 'không có dòng nào để nhập' });
  if (raw.length > IMPORT_MAX_ROWS) return send(res, 413, { error: `tối đa ${IMPORT_MAX_ROWS} dòng mỗi lần nhập` });

  // Có cột handle hay không quyết định chế độ gộp — xét trên TOÀN FILE, không theo từng dòng.
  const hasHandleColumn = raw.some((r) => Object.keys(r ?? {}).some((k) => COLS.handle.includes(normKey(k))));
  const rows = raw.map(mapRow);
  const groups = groupRows(rows, hasHandleColumn);

  const cap = await withTenant(ctx.shopId, async (c) => ({ max: await planMaxProducts(c), count: await catalogCount(c) }));

  const seenSlug = new Set();
  const errors = [];
  let created = 0, variantsCreated = 0;

  for (const g of groups) {
    const built = buildProduct(g);
    if (!built.ok) { errors.push({ line: built.line, title: str(g.rows[0].r.title), error: built.error }); continue; }
    const p = built.product;

    if (cap.max != null && cap.count + created >= cap.max) {
      errors.push({ line: p.line, title: p.title, error: `vượt giới hạn gói (${cap.max} sản phẩm)` });
      continue;
    }
    // Slug trùng NGAY trong lô (DB chỉ chặn trùng với dữ liệu đã có).
    if (seenSlug.has(p.slug)) {
      let n = 2; while (seenSlug.has(`${p.slug}-${n}`)) n++;
      p.slug = `${p.slug}-${n}`.slice(0, 60);
    }
    seenSlug.add(p.slug);

    try {
      await insertProduct(ctx, p);
      created++;
      variantsCreated += p.variants.length;
    } catch (err) {
      // withTenant rollback-on-throw ⇒ không để lại sản phẩm thiếu biến thể/thiếu map trục.
      seenSlug.delete(p.slug);
      errors.push({ line: p.line, title: p.title, error: err.code === '23505' ? conflictMessage(err) : 'lỗi khi tạo sản phẩm' });
    }
  }

  return send(res, 200, {
    created, variants: variantsCreated, groups: groups.length,
    failed: errors.length, errors: errors.slice(0, 100),
  });
}

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
export const IMPORT_ROUTES = [
  // maxBody 2MB (mặc định toàn cục 32KB). 1000 dòng CSV hoá JSON ≈ 200-400KB, nên trần
  // 32KB làm bộ nhập VỠ với mọi file cỡ thật — quá ~150 dòng là hỏng. Lỗi này có từ trước và
  // không bộ test nào bắt được vì bộ nhập chưa từng có test. Nới ĐÚNG route này, không nới
  // toàn cục: mọi endpoint khác giữ 32KB.
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/products/import$`), perm: 'catalog.write', maxBody: 2 * 1024 * 1024, fn: (res, ctx, b) => importProducts(res, ctx, b) },
];
