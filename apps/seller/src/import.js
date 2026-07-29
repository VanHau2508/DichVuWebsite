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

// ── Ảnh: XẾP HÀNG cho worker, không tải trong request (docs/45 §5, 0106) ──
// Bản đầu tải đồng bộ ngay tại đây nên phải sống dưới thời gian chờ của BFF: trần 200 ảnh /
// 45 giây mỗi lần nhập. Shop 300 sản phẩm × 3 ảnh phải nhập 5 lần — đúng thứ ma sát mà cả
// tính năng di cư sinh ra để xoá bỏ. Nay chỉ GHI HÀNG ĐỢI (dòng media 'pending' kèm
// source_url), worker tải nền: hết trần thời gian, hết trần số lượng, request lại nhanh.
//
// VẪN kiểm URL NGAY TẠI ĐÂY (rẻ, không chạm mạng): người bán phải biết LIỀN nếu tệp dùng
// đường dẫn tương đối hay sai scheme, chứ không phải mười phút sau mới thấy 300 ảnh hỏng.
const IMG_MAX_PER_IMPORT = Number(process.env.IMPORT_IMG_MAX ?? 2000);

/** URL có DÁNG hợp lệ để xếp hàng? Chỉ kiểm cú pháp — hàng rào SSRF thật chạy ở worker. */
function looksFetchable(u) {
  let x;
  try { x = new URL(String(u)); } catch { return false; }
  if (x.protocol !== 'http:' && x.protocol !== 'https:') return false;
  if (x.username || x.password) return false;
  const port = x.port ? Number(x.port) : (x.protocol === 'https:' ? 443 : 80);
  return port === 80 || port === 443;
}

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

/**
 * Soi tiêu đề cột của file: cột nào được nhận (kèm tên chuẩn), cột nào BỊ BỎ QUA.
 * Người bán cần biết "cột Giá của tôi không được nhận" — nếu không, họ nhập xong mới phát
 * hiện toàn bộ giá về 0 và không hiểu vì sao.
 */
export function inspectColumns(rawRows) {
  const headers = new Set();
  for (const r of rawRows) for (const k of Object.keys(r ?? {})) headers.add(String(k));
  const recognised = [], ignored = [];
  for (const h of headers) {
    const n = normKey(h);
    const hit = Object.entries(COLS).find(([, aliases]) => aliases.includes(n));
    if (hit) recognised.push({ header: h, field: hit[0] });
    else ignored.push(h);
  }
  return { recognised, ignored };
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
    // Ngăn cách bằng ký tự NUL viết dưới dạng CHUỖI THOÁT (không nhúng byte NUL vào source:
    // grep sẽ coi tệp là nhị phân và im lặng bỏ qua). Không dùng dấu cách vì ["A B","C"] và
    // ["A","B C"] sẽ ra cùng một khoá ⇒ báo trùng tổ hợp oan.
    const combo = values.join('\u0000');
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

  const columns = inspectColumns(raw);

  // XEM TRƯỚC: kiểm + gộp rồi trả kết quả, KHÔNG ghi một dòng nào và KHÔNG tải ảnh.
  // Vì sao đáng có: file 500 dòng nhập sai một lần là 500 sản phẩm rác phải xoá tay. Mọi
  // hàm kiểm ở trên đều THUẦN nên chế độ này gần như miễn phí — chỉ là dừng trước khi ghi.
  if (body.dry_run === true) {
    const errs = [], preview = [];
    let variants = 0, images = 0;
    for (const g of groups) {
      const built = buildProduct(g);
      if (!built.ok) { errs.push({ line: built.line, title: str(g.rows[0].r.title), error: built.error }); continue; }
      const p = built.product;
      variants += p.variants.length;
      images += new Set(p.variants.map((v) => v.imageUrl).filter(Boolean)).size;
      if (preview.length < 20) {
        preview.push({ title: p.title, slug: p.slug, variants: p.variants.length,
          axes: p.axes.map((a) => a.name), category: p.catPath.join(' > ') });
      }
    }
    return send(res, 200, {
      dry_run: true, rows: raw.length, groups: groups.length,
      created: groups.length - errs.length, variants, images,
      failed: errs.length, errors: errs.slice(0, 100), preview, columns,
    });
  }

  const cap = await withTenant(ctx.shopId, async (c) => ({ max: await planMaxProducts(c), count: await catalogCount(c) }));

  const seenSlug = new Set();
  const errors = [];
  let created = 0, variantsCreated = 0;
  let imgQueued = 0, imgInvalid = 0, imgOverflow = 0;

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
      const productId = await insertProduct(ctx, p);
      created++;
      variantsCreated += p.variants.length;
      // Ảnh của SP = ảnh của mọi dòng trong nhóm, theo thứ tự dòng, bỏ trùng URL.
      const seenUrl = new Set();
      for (const v of p.variants) {
        if (!v.imageUrl || seenUrl.has(v.imageUrl)) continue;
        seenUrl.add(v.imageUrl);
        if (!looksFetchable(v.imageUrl)) { imgInvalid++; continue; }
        if (imgQueued >= IMG_MAX_PER_IMPORT) { imgOverflow++; continue; }
        // Dòng media 'pending' + source_url CHÍNH LÀ đơn vị công việc của worker — không cần
        // bảng hàng đợi riêng: dòng này đã có shop_id/product_id/position và đã nằm sẵn trong
        // mọi truy vấn hiển thị, nên ảnh hiện ra ngay khi worker chuyển nó sang 'ready'.
        // Sinh id Ở TẦNG ỨNG DỤNG để đặt sẵn original_key (cột NOT NULL, không mặc định) —
        // đúng khuôn uploadMedia: ghi dòng trước, đẩy object sau. Worker chỉ việc dùng lại key
        // này chứ không tự dựng, nên tên object không thể lệch giữa hai đường.
        const mediaId = crypto.randomUUID();
        try {
          await withTenant(ctx.shopId, (c) => c.query(
            `INSERT INTO media (id, shop_id, product_id, status, source_url, original_key, position)
             VALUES ($3, current_shop_id(), $1, 'pending', $2, $4,
                     (SELECT coalesce(max(position), -1) + 1 FROM media WHERE product_id = $1 AND deleted_at IS NULL))`,
            [productId, v.imageUrl.slice(0, 2000), mediaId, `staging/${ctx.shopId}/${mediaId}`],
          ));
          imgQueued++;
        } catch { imgInvalid++; }   // đếm ĐÚNG MỘT lần: bản đầu tăng cả hai biến
      }
    } catch (err) {
      // withTenant rollback-on-throw ⇒ không để lại sản phẩm thiếu biến thể/thiếu map trục.
      seenSlug.delete(p.slug);
      errors.push({ line: p.line, title: p.title, error: err.code === '23505' ? conflictMessage(err) : 'lỗi khi tạo sản phẩm' });
    }
  }

  return send(res, 200, {
    created, variants: variantsCreated, groups: groups.length,
    failed: errors.length, errors: errors.slice(0, 100),
    // queued: worker sẽ tải nền · invalid: URL sai dáng, KHÔNG bao giờ tải được ·
    // skipped: vượt trần số ảnh mỗi lần nhập. Không con số nào im lặng.
    images: { queued: imgQueued, invalid: imgInvalid, skipped: imgOverflow },
    columns,
  });
}


// ══ NHẬP ĐƠN CŨ (di cư) — docs/45 ══════════════════════════════════════════
// Chủ nền tảng đã chốt: đơn di cư KHÔNG tính doanh thu/P&L/COD/điểm thưởng (cờ is_migrated,
// migration 0104). Ở đây chỉ lo GHI ĐÚNG; phần loại trừ do các truy vấn tiền tự lọc, và có
// bộ migrated-orders.e2e canh bất biến đó.
//
// CHỈ NHẬP PHẦN ĐẦU ĐƠN, KHÔNG nhập dòng hàng. Lý do là ràng buộc thật của lược đồ:
// order_lines.variant_id là NOT NULL, nên mỗi dòng hàng phải khớp một biến thể ĐANG TỒN TẠI.
// Danh mục cũ luôn có hàng đã ngừng kinh doanh — chúng sẽ không khớp, và cách duy nhất để
// "nhập được" là nới NOT NULL, tức phá một bất biến kế toán đang bảo vệ toàn hệ. Phần đầu
// đơn (khách, ngày, tổng tiền) đã đủ cho mục đích đã chọn: HỒ SƠ KHÁCH HÀNG.
//
// KHÔNG đụng tồn kho: hàng đã giao ở sàn cũ từ lâu, tồn hiện tại đã phản ánh thực tế rồi.
// Trừ kho lần nữa là tự tay tạo ra âm kho.
const ORDER_IMPORT_MAX_ROWS = 2000;

const OCOLS = {
  order_code: ['ordercode', 'orderid', 'ordernumber', 'madon', 'masodon', 'orderno', 'name'],
  date: ['date', 'createdat', 'orderdate', 'ngaydat', 'ngay', 'paidat'],
  customer_name: ['customername', 'name', 'tenkhach', 'khachhang', 'billingname', 'shippingname'],
  customer_phone: ['customerphone', 'phone', 'sdt', 'sodienthoai', 'billingphone', 'shippingphone'],
  customer_email: ['customeremail', 'email', 'billingemail'],
  total_vnd: ['totalvnd', 'total', 'tongtien', 'thanhtien', 'grandtotal'],
  status: ['status', 'trangthai', 'fulfillmentstatus'],
  payment_status: ['paymentstatus', 'financialstatus', 'trangthaithanhtoan'],
  address: ['address', 'diachi', 'shippingaddress', 'billingaddress', 'shippingstreet'],
  province: ['province', 'tinhthanh', 'shippingprovince', 'city'],
  note: ['note', 'ghichu', 'notes'],
};
// `name` xuất hiện ở CẢ order_code lẫn customer_name (Shopify dùng "Name" cho mã đơn).
// Thứ tự duyệt trong mapRowBy quyết định: order_code đứng trước nên "Name" về mã đơn —
// đúng với Shopify. Ai có tệp mà "Name" là tên khách thì đổi tiêu đề cột, và UI nói rõ
// cột nào được hiểu thành gì nên họ thấy ngay chứ không đoán.

const mapOrderRow = (raw) => {
  const byNorm = new Map();
  for (const k of Object.keys(raw ?? {})) byNorm.set(normKey(k), raw[k]);
  const out = {};
  for (const [canon, aliases] of Object.entries(OCOLS)) {
    for (const a of aliases) if (byNorm.has(a)) { out[canon] = byNorm.get(a); break; }
  }
  return out;
};

/**
 * Ngày từ chuỗi người dùng. Nhận ISO (2026-07-28, kèm giờ) và kiểu Việt Nam 28/07/2026.
 * Trả Date hoặc null. TỪ CHỐI ngày TƯƠNG LAI: đơn "cũ" mà nằm ở tương lai thì hoặc tệp sai
 * hoặc đọc nhầm định dạng — cả hai đều làm hỏng hồ sơ khách nếu cứ nhập.
 */
function parseOrderDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let d = null;
  const vn = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s);
  if (vn) d = new Date(Date.UTC(Number(vn[3]), Number(vn[2]) - 1, Number(vn[1]), 5));  // ~12h giờ VN
  else if (/^\d{4}-\d{2}-\d{2}/.test(s)) d = new Date(s.length === 10 ? `${s}T05:00:00Z` : s);
  if (!d || Number.isNaN(d.getTime())) return null;
  if (d.getTime() > Date.now() + 86400000) return null;
  return d;
}

const O_STATUS = { delivered: 'delivered', completed: 'delivered', done: 'delivered', 'hoàn thành': 'delivered',
  cancelled: 'cancelled', canceled: 'cancelled', 'đã huỷ': 'cancelled', 'da huy': 'cancelled',
  refunded: 'refunded', 'hoàn tiền': 'refunded' };
const O_PAY = { paid: 'paid', 'đã thanh toán': 'paid', 'da thanh toan': 'paid', unpaid: 'unpaid',
  pending: 'unpaid', refunded: 'refunded' };

export async function importOrders(res, ctx, body) {
  const raw = Array.isArray(body.rows) ? body.rows : [];
  if (raw.length === 0) return send(res, 400, { error: 'không có dòng nào để nhập' });
  if (raw.length > ORDER_IMPORT_MAX_ROWS) return send(res, 413, { error: `tối đa ${ORDER_IMPORT_MAX_ROWS} dòng mỗi lần nhập` });

  const columns = (() => {
    const headers = new Set();
    for (const r of raw) for (const k of Object.keys(r ?? {})) headers.add(String(k));
    const recognised = [], ignored = [];
    for (const h of headers) {
      const n = normKey(h);
      const hit = Object.entries(OCOLS).find(([, al]) => al.includes(n));
      if (hit) recognised.push({ header: h, field: hit[0] }); else ignored.push(h);
    }
    return { recognised, ignored };
  })();

  const rows = raw.map(mapOrderRow);
  const errors = [];
  const ready = [];
  const seenRef = new Set();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], line = i + 2;
    const phone = str(r.customer_phone).replace(/[^\d+]/g, '');
    // SĐT là KHOÁ GỘP hồ sơ khách (customers.js gom theo customer_phone). Không có nó thì
    // đơn vào hệ thống mà chẳng gắn với ai — tức là rác, không phải lịch sử.
    if (phone.length < 8 || phone.length > 15) { errors.push({ line, title: str(r.order_code), error: 'thiếu hoặc sai số điện thoại (khoá gộp hồ sơ khách)' }); continue; }
    const when = parseOrderDate(r.date);
    if (!when) { errors.push({ line, title: str(r.order_code), error: 'ngày đặt trống, sai định dạng, hoặc ở tương lai' }); continue; }
    const total = intOf(r.total_vnd);
    if (!isInt(total) || total < 0 || total > 100_000_000_000) { errors.push({ line, title: str(r.order_code), error: 'tổng tiền không hợp lệ' }); continue; }

    const ref = str(r.order_code).slice(0, 120) || null;
    if (ref && seenRef.has(ref)) { errors.push({ line, title: ref, error: `mã đơn "${ref}" lặp trong cùng tệp` }); continue; }
    if (ref) seenRef.add(ref);

    const st = O_STATUS[str(r.status).toLowerCase()] ?? 'delivered';
    const pay = O_PAY[str(r.payment_status).toLowerCase()] ?? (st === 'cancelled' ? 'unpaid' : 'paid');
    const addrLine = str(r.address), prov = str(r.province);
    ready.push({
      line, ref, when, total, phone,
      name: str(r.customer_name).slice(0, 120) || null,
      email: str(r.customer_email).slice(0, 200) || null,
      status: st, pay,
      address: (addrLine || prov) ? { ...(addrLine ? { line: addrLine.slice(0, 300) } : {}), ...(prov ? { province: prov.slice(0, 100) } : {}) } : null,
      note: str(r.note).slice(0, 500) || null,
    });
  }

  if (body.dry_run === true) {
    return send(res, 200, {
      dry_run: true, rows: raw.length, created: ready.length, failed: errors.length,
      errors: errors.slice(0, 100), columns,
      preview: ready.slice(0, 20).map((o) => ({
        ref: o.ref, date: o.when.toISOString().slice(0, 10), name: o.name, phone: o.phone,
        total_vnd: o.total, status: o.status,
      })),
      customers: new Set(ready.map((o) => o.phone)).size,
    });
  }

  let created = 0, duplicate = 0;
  for (const o of ready) {
    try {
      await withTenant(ctx.shopId, async (c) => {
        // Số đơn cấp từ CÙNG bộ đếm với đơn thường: không tái dùng dãy số của sàn cũ (mã sàn
        // thường có chữ, và trộn dãy sẽ đụng đơn tương lai). Mã gốc giữ ở migrated_ref.
        // Bộ đếm TỰ CHỮA LÀNH: nâng lên max(order_number)+1 nếu nó đang tụt lại sau dữ liệu
        // thật. Vì sao cần: bộ đếm và lệnh chèn nằm CÙNG transaction, nên chèn lỗi thì bộ đếm
        // cũng rollback — nó không bao giờ tiến lên và mọi dòng sau đụng lại y hệt. Đó là
        // vòng lặp chết, và nó xảy ra thật ngay lần chạy test đầu tiên.
        const num = (await c.query(
          `INSERT INTO shop_counters (shop_id, name, value)
           VALUES (current_shop_id(), 'order_number',
                   (SELECT coalesce(max(order_number), 0) + 1 FROM orders WHERE shop_id = current_shop_id()))
           ON CONFLICT (shop_id, name) DO UPDATE
             SET value = GREATEST(shop_counters.value + 1,
                   (SELECT coalesce(max(order_number), 0) + 1 FROM orders WHERE shop_id = current_shop_id()))
           RETURNING value`,
        )).rows[0].value;
        await c.query(
          `INSERT INTO orders (shop_id, order_number, status, payment_status, payment_method,
             customer_name, customer_phone, customer_email, shipping_address,
             subtotal_vnd, shipping_vnd, discount_vnd, total_vnd, amount_paid_vnd,
             created_at, paid_at, delivered_at, cancelled_at, fulfillment_status,
             note, is_migrated, migrated_ref)
           VALUES (current_shop_id(), $1, $2, $3, NULL, $4, $5, $6, $7,
                   $8, 0, 0, $8, $9,
                   $10, $11, $12, $13, $14,
                   $15, true, $16)`,
          [num, o.status, o.pay, o.name, o.phone, o.email, o.address,
           o.total, o.pay === 'paid' ? o.total : 0,
           o.when, o.pay === 'paid' ? o.when : null,
           o.status === 'delivered' ? o.when : null,
           o.status === 'cancelled' ? o.when : null,
           o.status === 'delivered' ? 'fulfilled' : 'unfulfilled',
           o.note, o.ref],
        );
      });
      created++;
    } catch (err) {
      // Phân biệt theo TÊN RÀNG BUỘC, không gộp mọi 23505 thành "trùng". Bản đầu gộp hết và
      // nó BÁO NHẦM: đụng orders_shop_id_order_number_key (bộ đếm tụt) bị đếm thành "đã nhập
      // rồi", nên người bán thấy "3 đơn bỏ qua vì trùng" trong khi thật ra KHÔNG đơn nào vào.
      if (err.code === '23505' && err.constraint === 'orders_migrated_ref_uq') { duplicate++; continue; }
      errors.push({ line: o.line, title: o.ref ?? '', error: err.code === '23505' ? 'trùng dữ liệu đã có' : 'lỗi khi tạo đơn' });
    }
  }

  return send(res, 200, {
    created, duplicate, failed: errors.length, errors: errors.slice(0, 100), columns,
    customers: new Set(ready.map((x) => x.phone)).size,
  });
}

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
export const IMPORT_ROUTES = [
  // maxBody 4MB: 2000 dòng đơn hoá JSON lớn hơn nhập sản phẩm (mỗi dòng có địa chỉ + ghi chú).
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/import$`), perm: 'orders.write', maxBody: 4 * 1024 * 1024, fn: (res, ctx, b) => importOrders(res, ctx, b) },
  // maxBody 2MB (mặc định toàn cục 32KB). 1000 dòng CSV hoá JSON ≈ 200-400KB, nên trần
  // 32KB làm bộ nhập VỠ với mọi file cỡ thật — quá ~150 dòng là hỏng. Lỗi này có từ trước và
  // không bộ test nào bắt được vì bộ nhập chưa từng có test. Nới ĐÚNG route này, không nới
  // toàn cục: mọi endpoint khác giữ 32KB.
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/products/import$`), perm: 'catalog.write', maxBody: 2 * 1024 * 1024, fn: (res, ctx, b) => importProducts(res, ctx, b) },
];
