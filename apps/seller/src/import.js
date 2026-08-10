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
import { parseAmount, parseOrderDate } from './import-parse.js';
import { adaptRows, inspectSourceColumns } from './adapters/index.js';
import { withTenant, audit } from './db.js';
import { purgeReplacedProductMedia } from './media.js';
import {
  isInt, validPrice, validTitle, validSku, validSlug, validWeight, validCompareAt, validCost,
  slugify, planMaxProducts, catalogCount, conflictMessage, syncProductPrice,
} from './catalog.js';

const IMPORT_MAX_PRODUCTS = 1000;
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

function imageLimitForRequest(body = {}) {
  if (body.image_limit === undefined) return IMG_MAX_PER_IMPORT;
  const requested = Number(body.image_limit);
  if (!Number.isFinite(requested)) return IMG_MAX_PER_IMPORT;
  return Math.min(IMG_MAX_PER_IMPORT, Math.max(0, Math.floor(requested)));
}

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

const intOf = parseAmount;   // tên cũ giữ nguyên cho các chỗ gọi hiện có

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
  // DÒNG CHỈ CÓ ẢNH: tệp xuất Shopify/Haravan đặt ảnh thứ 2, 3... của một sản phẩm ở DÒNG
  // RIÊNG chỉ có Handle + Image Src — không SKU, không giá. Đây là hình dạng BÌNH THƯỜNG của
  // tệp thật, không phải ca hiếm. Bản đầu đòi SKU+giá ở mọi dòng nên một tệp Shopify chuẩn
  // nhập được ĐÚNG KHÔNG GÌ CẢ: dòng ảnh báo "SKU trống" và cả nhóm bị bỏ theo quy tắc
  // nhóm-lỗi-bỏ-cả-nhóm. Nay tách rõ hai loại dòng.
  const isVariantRow = (r) => str(r.sku) !== '' || str(r.price_vnd) !== '';
  const variantRows = group.rows.filter(({ r }) => isVariantRow(r));
  // Thông tin cấp sản phẩm lấy từ dòng ĐẦU TIÊN CÓ TIÊU ĐỀ, không phải dòng đầu tuyệt đối:
  // nếu tệp mở nhóm bằng một dòng ảnh thì dòng đầu không có title.
  const head = group.rows.find(({ r }) => str(r.title) !== '') ?? group.rows[0];
  const h = head.r;
  const title = str(h.title);
  if (!validTitle(title)) return { ok: false, line: head.line, error: 'tiêu đề trống hoặc quá dài' };
  if (variantRows.length === 0) {
    return { ok: false, line: head.line, error: 'nhóm không có dòng nào khai SKU/giá (toàn dòng ảnh?)' };
  }

  if (variantRows.length > MAX_VARIANTS_PER_PRODUCT) {
    return { ok: false, line: head.line, error: `quá ${MAX_VARIANTS_PER_PRODUCT} biến thể trong một sản phẩm` };
  }

  // Trục: lấy tên từ dòng ĐẦU TIÊN khai trục đó. Trong một nhóm, tên trục phải nhất quán —
  // lệch thì cả nhóm bị từ chối kèm số dòng lệch (xem chú thích đầu file).
  const axisNames = [];
  for (let i = 1; i <= MAX_OPTIONS; i++) {
    for (const { r } of variantRows) {
      const n = str(r[`option${i}_name`]);
      if (n) { axisNames[i - 1] = n; break; }
    }
  }
  const axes = [];
  for (let i = 0; i < MAX_OPTIONS; i++) {
    if (!axisNames[i]) break;                              // trục phải liên tục từ 1
    axes.push({ name: axisNames[i], idx: i + 1, values: [] });
  }
  for (const { line, r } of variantRows) {
    for (const ax of axes) {
      const n = str(r[`option${ax.idx}_name`]);
      if (n && n !== ax.name) {
        return { ok: false, line, error: `tên trục ${ax.idx} lệch ("${n}" ≠ "${ax.name}") — cả nhóm bị bỏ` };
      }
    }
  }
  if (axes.length === 0 && variantRows.length > 1) {
    return { ok: false, line: head.line, error: 'nhóm nhiều dòng nhưng không khai trục biến thể (option1_name)' };
  }

  // Biến thể: mỗi dòng một biến thể, giá trị trục lấy đúng dòng đó.
  const variants = [];
  const comboSeen = new Set();
  const skuSeen = new Set();
  for (const { line, r } of variantRows) {
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

  // Thư viện ảnh = ảnh của MỌI dòng trong nhóm theo thứ tự dòng (gồm cả dòng chỉ-có-ảnh),
  // bỏ trùng URL. Gom ở đây thay vì lấy từ variants: dòng ảnh không sinh ra biến thể nào.
  const images = [];
  const seenImg = new Set();
  for (const { r } of group.rows) {
    const u = str(r.image_url);
    if (u && !seenImg.has(u)) { seenImg.add(u); images.push(u); }
  }

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
      line: head.line, title, slug, status, basePrice, catPath, axes, variants, images,
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

    const variantIds = [];
    for (let vi = 0; vi < p.variants.length; vi++) {
      const v = p.variants[vi];
      const title = v.values.length ? v.values.join(' / ') : null;
      const vr = await c.query(
        `INSERT INTO variants (shop_id, product_id, title, sku, price_vnd, compare_at_vnd, weight_gram, position)
         VALUES (current_shop_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [productId, title, v.sku, v.price, v.compareAt, v.weight, vi],
      );
      const variantId = vr.rows[0].id;
      variantIds.push(variantId);

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

    if (p.source === 'tiktok' && p.sourceProductId) {
      const productRef = await c.query(
        `INSERT INTO product_source_refs (shop_id, source, kind, external_id, product_id, raw_row)
         VALUES (current_shop_id(), 'tiktok', 'product', $1, $2, $3)
         ON CONFLICT (shop_id, source, kind, external_id) DO NOTHING RETURNING id`,
        [p.sourceProductId, productId, p.sourceRawRow ?? null],
      );
      if (productRef.rows.length === 0) {
        const old = (await c.query(
          `SELECT product_id FROM product_source_refs
           WHERE source = 'tiktok' AND kind = 'product' AND external_id = $1`, [p.sourceProductId])).rows[0];
        if (old?.product_id !== productId) throw Object.assign(new Error('product_id từ TikTok đã được nhập đồng thời'), { code: 'IMPORT_SOURCE_CONFLICT' });
      }
      for (let i = 0; i < p.variants.length; i++) {
        const externalId = p.variants[i].sourceVariantId;
        if (!externalId) continue;
        const variantRef = await c.query(
          `INSERT INTO product_source_refs (shop_id, source, kind, external_id, product_id, variant_id, raw_row)
           VALUES (current_shop_id(), 'tiktok', 'variant', $1, $2, $3, $4)
           ON CONFLICT (shop_id, source, kind, external_id) DO NOTHING RETURNING id`,
          [externalId, productId, variantIds[i], p.variants[i].sourceRawRow ?? null],
        );
        if (variantRef.rows.length === 0) {
          const old = (await c.query(
            `SELECT variant_id FROM product_source_refs
             WHERE source = 'tiktok' AND kind = 'variant' AND external_id = $1`, [externalId])).rows[0];
          if (old?.variant_id !== variantIds[i]) throw Object.assign(new Error('sku_id từ TikTok đã được nhập đồng thời'), { code: 'IMPORT_SOURCE_CONFLICT' });
        }
      }
    }

    await audit(c, 'product.imported', {
      actorId: ctx.user.id, ip: ctx.ip,
      metadata: { productId, slug: p.slug, variants: p.variants.length, axes: p.axes.length },
    });
    return { productId, variantIds };
  });
}

async function findSourceProduct(ctx, p) {
  if (p.source !== 'tiktok' || !p.sourceProductId) return null;
  return withTenant(ctx.shopId, async (c) => (await c.query(
    `SELECT id, product_id FROM product_source_refs
     WHERE source = 'tiktok' AND kind = 'product' AND external_id = $1`, [p.sourceProductId])).rows[0] ?? null);
}

function reserveImportedSku(base, reserved) {
  let sku = String(base ?? '').slice(0, 64);
  for (let n = 2; reserved.has(sku); n++) {
    const suffix = `-${n}`;
    sku = `${String(base ?? '').slice(0, 64 - suffix.length)}${suffix}`;
  }
  reserved.add(sku);
  return sku;
}

const IMPORT_MODES = new Set(['create_only', 'update_only', 'upsert']);

function importFlags(body = {}) {
  const requestedMode = String(body.import_mode ?? body.mode ?? '');
  const mode = IMPORT_MODES.has(requestedMode) ? requestedMode : 'create_only';
  return {
    mode,
    updateContent: body.update_content !== false,
    updatePrice: body.update_price === true,
    updateStock: body.update_stock === true,
    priceConfirmed: body.price_confirmed === true,
  };
}

function sourceFields(p, adapted) {
  p.source = adapted.source;
  if (adapted.source !== 'tiktok') return p;
  p.sourceProductId = p.slug;
  p.sourceRawRow = adapted.sourceRefs.products.get(p.sourceProductId)?.rawRow ?? null;
  for (const v of p.variants) {
    const ref = adapted.sourceRefs.variants.get(v.sku);
    if (ref) { v.sourceVariantId = ref.externalId; v.sourceRawRow = ref.rawRow; }
  }
  return p;
}

async function readImportTarget(c, productId, lock = false) {
  const suffix = lock ? ' FOR UPDATE' : '';
  const product = (await c.query(
    `SELECT id, title, description, price_vnd FROM products
      WHERE id = $1 AND deleted_at IS NULL${suffix}`, [productId])).rows[0];
  if (!product) return null;
  const variants = (await c.query(
    `SELECT r.external_id, r.id AS source_ref_id, r.variant_id,
            v.sku, v.price_vnd, v.compare_at_vnd,
            coalesce(il.on_hand, 0)::int AS on_hand,
            coalesce(il.reserved, 0)::int AS reserved
       FROM product_source_refs r
       JOIN variants v ON v.id = r.variant_id AND v.product_id = r.product_id
       LEFT JOIN inventory_levels il ON il.variant_id = v.id
       WHERE r.source = 'tiktok' AND r.kind = 'variant' AND r.product_id = $1
      ORDER BY v.position${lock ? ' FOR UPDATE OF r, v' : ''}`, [productId])).rows;
  const media = (await c.query(
    `SELECT id, source_url, public_key, original_key, position
       FROM media WHERE product_id = $1 AND deleted_at IS NULL ORDER BY position`, [productId])).rows;
  return { product, variants, media };
}

function importDiff(productId, p, target, flags) {
  const diffs = [], errors = [], priceChanges = [], stockChanges = [], newVariants = [];
  const currentByExternal = new Map(target.variants.map((v) => [String(v.external_id), v]));
  const incomingByExternal = new Map();
  const add = (field, from, to, action, extra = {}) => diffs.push({
    product_id: productId, product_external_id: p.sourceProductId, field,
    from: from == null ? null : from, to: to == null ? null : to, action, ...extra,
  });

  if (flags.updateContent) {
    if (target.product.title !== p.title) add('title', target.product.title, p.title, 'update');
    if ((target.product.description ?? null) !== (p.description ?? null)) add('description', target.product.description, p.description, 'update');
    if (p.images.length) {
      const oldUrls = target.media.map((m) => m.source_url).filter(Boolean);
      if (JSON.stringify(oldUrls) !== JSON.stringify(p.images)) {
        add('images', oldUrls.length, p.images.length, 'update', { sku: null });
      }
    }
  }

  for (const v of p.variants) {
    const externalId = String(v.sourceVariantId ?? '');
    if (!externalId) {
      errors.push({ line: v.line, title: p.title, error: 'TikTok thiếu sku_id — không thể cập nhật an toàn' });
      continue;
    }
    if (incomingByExternal.has(externalId)) {
      errors.push({ line: v.line, title: p.title, error: `sku_id TikTok lặp: ${externalId}` });
      continue;
    }
    incomingByExternal.set(externalId, v);
    const cur = currentByExternal.get(externalId);
    if (!cur) {
      if (flags.mode === 'upsert') {
        newVariants.push(v);
        add('variant', null, v.price, 'create', { external_id: externalId, sku: v.sku });
      } else {
        errors.push({ line: v.line, title: p.title, error: `sku_id mới ${externalId} không tồn tại trong shop (update_only không tạo mới)` });
        add('variant', null, v.price, 'reject', { external_id: externalId, sku: v.sku });
      }
      continue;
    }

    if (flags.updatePrice && Number(cur.price_vnd) !== Number(v.price)) {
      const compareAt = v.compareAt !== null ? v.compareAt : (cur.compare_at_vnd == null ? null : Number(cur.compare_at_vnd));
      if (compareAt != null && compareAt <= Number(v.price)) {
        errors.push({ line: v.line, title: p.title, error: `giá mới của ${externalId} không được cao hơn hoặc bằng giá gạch đang có` });
        add('price_vnd', Number(cur.price_vnd), v.price, 'reject', { external_id: externalId, sku: cur.sku });
      } else {
        priceChanges.push({ cur, incoming: v, compareAt });
        add('price_vnd', Number(cur.price_vnd), v.price, 'update', { external_id: externalId, sku: cur.sku });
      }
    } else if (!flags.updatePrice && Number(cur.price_vnd) !== Number(v.price)) {
      add('price_vnd', Number(cur.price_vnd), v.price, 'skip', { external_id: externalId, sku: cur.sku, reason: 'chưa bật cập nhật giá' });
    }

    if (flags.updateStock && Number(cur.on_hand) !== Number(v.stock)) {
      if (Number(v.stock) < Number(cur.reserved)) {
        errors.push({ line: v.line, title: p.title, error: `tồn mới của ${externalId} thấp hơn số đang giữ chỗ (${cur.reserved})` });
        add('stock', Number(cur.on_hand), v.stock, 'reject', { external_id: externalId, sku: cur.sku });
      } else {
        stockChanges.push({ cur, incoming: v });
        add('stock', Number(cur.on_hand), v.stock, 'update', { external_id: externalId, sku: cur.sku });
      }
    } else if (!flags.updateStock && Number(cur.on_hand) !== Number(v.stock)) {
      add('stock', Number(cur.on_hand), v.stock, 'skip', { external_id: externalId, sku: cur.sku, reason: 'chưa bật cập nhật tồn' });
    }
  }

  for (const cur of target.variants) {
    if (!incomingByExternal.has(String(cur.external_id))) {
      add('variant', cur.sku, null, 'keep', {
        external_id: cur.external_id, sku: cur.sku,
        reason: 'biến thể đang có trong shop không xuất hiện trong file — giữ nguyên',
      });
    }
  }

  return { diffs, errors, priceChanges, stockChanges, newVariants, changed: diffs.some((d) => d.action === 'update' || d.action === 'create') };
}

async function loadProductOptions(c, productId) {
  const rows = (await c.query(
    `SELECT o.id, o.name, o.position, ov.id AS value_id, ov.value, ov.position AS value_position
       FROM product_options o LEFT JOIN option_values ov ON ov.option_id = o.id
      WHERE o.product_id = $1 ORDER BY o.position, ov.position`, [productId])).rows;
  const out = [];
  for (const row of rows) {
    let option = out.find((x) => x.id === row.id);
    if (!option) { option = { id: row.id, name: row.name, position: row.position, values: new Map() }; out.push(option); }
    if (row.value_id) option.values.set(row.value, row.value_id);
  }
  return out;
}

async function ensureVariantOptions(c, productId, axes, values) {
  const options = await loadProductOptions(c, productId);
  const links = [];
  for (let i = 0; i < axes.length; i++) {
    let option = options[i];
    if (!option) {
      option = (await c.query(
        `INSERT INTO product_options (shop_id, product_id, name, position)
         VALUES (current_shop_id(), $1, $2, $3) RETURNING id`, [productId, axes[i].name.slice(0, 60), i])).rows[0];
      option.values = new Map();
      options.push(option);
    }
    const value = String(values[i] ?? '').slice(0, 60);
    let valueId = option.values.get(value);
    if (!valueId) {
      valueId = (await c.query(
        `INSERT INTO option_values (shop_id, option_id, value, position)
         VALUES (current_shop_id(), $1, $2, (SELECT coalesce(max(position), -1) + 1 FROM option_values WHERE option_id = $1))
         RETURNING id`, [option.id, value])).rows[0].id;
      option.values.set(value, valueId);
    }
    links.push([option.id, valueId]);
  }
  return links;
}

async function applyStockImport(c, ctx, variantId, desired, current) {
  const next = Number(desired);
  if (!Number.isInteger(next) || next < 0) return { error: 'tồn kho không hợp lệ' };
  await c.query(
    `INSERT INTO inventory_levels (shop_id, variant_id, on_hand)
     VALUES (current_shop_id(), $1, 0)
     ON CONFLICT (shop_id, variant_id) DO NOTHING`, [variantId]);
  const locked = (await c.query(
    `SELECT on_hand, reserved FROM inventory_levels
      WHERE variant_id = $1 AND shop_id = current_shop_id() FOR UPDATE`, [variantId])).rows[0];
  if (!locked) return { error: 'không tìm thấy dòng tồn kho của biến thể' };
  const onHand = Number(locked.on_hand), reserved = Number(locked.reserved);
  if (next < reserved) return { error: `tồn mới thấp hơn số đang giữ chỗ (${reserved})` };
  if (next === onHand) return { changed: false };
  await c.query(
    `UPDATE inventory_levels SET on_hand = $2, updated_at = now()
      WHERE variant_id = $1 AND shop_id = current_shop_id()`, [variantId, next]);
  await c.query(
    `INSERT INTO inventory_ledger (shop_id, variant_id, delta, kind, reason, actor_id)
     VALUES (current_shop_id(), $1, $2, 'adjust', 'nhập từ TikTok', $3)`,
    [variantId, next - onHand, ctx.user.id]);
  return { changed: true, from: onHand, to: next };
}

async function queueImportImages(c, ctx, productId, urls, imageState) {
  if (!urls.length) return { changed: false, replaced: [] };
  const mediaRows = (await c.query(
    `SELECT id, source_url, public_key, original_key, deleted_at
       FROM media WHERE product_id = $1 ORDER BY position FOR UPDATE`, [productId])).rows;
  const oldRows = mediaRows.filter((r) => r.deleted_at === null);
  const staleRows = mediaRows.filter((r) => r.deleted_at !== null);
  const validUrls = [];
  for (const url of urls) {
    if (!looksFetchable(url)) { imageState.invalid++; continue; }
    // Tính cả URL đã giữ chỗ trong chính sản phẩm này; nếu chỉ nhìn queued thì một sản phẩm
    // có thể đẩy tổng vượt trần trước khi vòng INSERT bắt đầu tăng bộ đếm.
    if (imageState.queued + validUrls.length >= imageState.limit) { imageState.overflow++; continue; }
    validUrls.push(String(url).slice(0, 2000));
  }
  if (!validUrls.length) return { changed: false, replaced: staleRows };
  const old = oldRows.map((r) => r.source_url).filter(Boolean);
  if (oldRows.length === old.length && JSON.stringify(old) === JSON.stringify(validUrls)) {
    return { changed: false, replaced: staleRows };
  }
  await c.query(`UPDATE media SET deleted_at = now() WHERE product_id = $1 AND deleted_at IS NULL`, [productId]);
  for (const url of validUrls) {
    const mediaId = crypto.randomUUID();
    await c.query(
      `INSERT INTO media (id, shop_id, product_id, status, source_url, original_key, position)
       VALUES ($2, current_shop_id(), $1, 'pending', $3, $4,
               (SELECT coalesce(max(position), -1) + 1 FROM media WHERE product_id = $1 AND deleted_at IS NULL))`,
       [productId, mediaId, url, `staging/${ctx.shopId}/${mediaId}`]);
    imageState.queued++;
  }
  return { changed: true, replaced: [...staleRows, ...oldRows] };
}

async function activePromotionWarnings(c, productId) {
  const rows = (await c.query(
    `SELECT p.id, p.title, p.scope
       FROM promotions p
      WHERE p.active = true AND p.starts_at <= now() AND p.ends_at > now()
        AND (p.scope = 'all' OR EXISTS (
          SELECT 1 FROM promotion_products pp
           WHERE pp.promotion_id = p.id AND pp.product_id = $1
        ))
      ORDER BY p.starts_at`, [productId])).rows;
  return rows.map((r) => ({
    type: 'active_promotion', product_id: productId, promotion_id: r.id,
    message: `Sản phẩm đang nằm trong khuyến mãi "${r.title}"; đổi giá gốc có thể ảnh hưởng giá khách thấy.`,
  }));
}

async function updateImportedProduct(ctx, p, existing, flags, imageState) {
  const result = await withTenant(ctx.shopId, async (c) => {
    const target = await readImportTarget(c, existing.product_id, true);
    if (!target) return { missing: true };
    const plan = importDiff(existing.product_id, p, target, flags);
    let changed = false, variantsUpdated = 0, variantsCreated = 0;
    const warnings = plan.priceChanges.length ? await activePromotionWarnings(c, existing.product_id) : [];

    if (flags.updateContent && (target.product.title !== p.title || (target.product.description ?? null) !== (p.description ?? null))) {
      await c.query(`UPDATE products SET title = $1, description = $2 WHERE id = $3 AND deleted_at IS NULL`, [p.title, p.description, existing.product_id]);
      changed = true;
    }
    let replacedMedia = [];
    if (flags.updateContent) {
      const images = await queueImportImages(c, ctx, existing.product_id, p.images, imageState);
      changed = images.changed || changed;
      replacedMedia = images.replaced;
    }

    for (const change of plan.priceChanges) {
      const sets = ['price_vnd = $1'];
      const args = [change.incoming.price];
      if (change.incoming.compareAt !== null && Number(change.cur.compare_at_vnd ?? -1) !== Number(change.incoming.compareAt)) {
        sets.push(`compare_at_vnd = $${args.length + 1}`); args.push(change.incoming.compareAt);
      }
      args.push(change.cur.variant_id);
      await c.query(`UPDATE variants SET ${sets.join(', ')} WHERE id = $${args.length}`, args);
      changed = true; variantsUpdated++;
    }
    for (const change of plan.stockChanges) {
      const result = await applyStockImport(c, ctx, change.cur.variant_id, change.incoming.stock, change.cur);
      if (result.error) {
        plan.errors.push({ line: change.incoming.line, title: p.title, error: result.error });
        continue;
      }
      if (result.changed) { changed = true; variantsUpdated++; }
    }

    if (flags.mode === 'upsert') {
      const reserved = new Set((await c.query(`SELECT sku FROM variants WHERE shop_id = current_shop_id()`)).rows.map((r) => r.sku));
      for (const v of plan.newVariants) {
        v.sku = reserveImportedSku(v.sku, reserved);
        const links = await ensureVariantOptions(c, existing.product_id, p.axes, v.values);
        const title = v.values.length ? v.values.join(' / ') : null;
        const inserted = (await c.query(
          `INSERT INTO variants (shop_id, product_id, title, sku, price_vnd, compare_at_vnd, weight_gram, position)
           VALUES (current_shop_id(), $1, $2, $3, $4, $5, $6,
                   (SELECT coalesce(max(position), -1) + 1 FROM variants WHERE product_id = $1)) RETURNING id`,
          [existing.product_id, title, v.sku, v.price, v.compareAt, v.weight])).rows[0];
        for (const [optionId, valueId] of links) {
          await c.query(
            `INSERT INTO variant_option_values (shop_id, variant_id, option_id, option_value_id)
             VALUES (current_shop_id(), $1, $2, $3) ON CONFLICT DO NOTHING`, [inserted.id, optionId, valueId]);
        }
        if (v.stock > 0) {
          await c.query(`INSERT INTO inventory_levels (shop_id, variant_id, on_hand) VALUES (current_shop_id(), $1, $2)`, [inserted.id, v.stock]);
          await c.query(
            `INSERT INTO inventory_ledger (shop_id, variant_id, delta, kind, reason, actor_id)
             VALUES (current_shop_id(), $1, $2, 'receive', 'nhập biến thể mới từ TikTok', $3)`, [inserted.id, v.stock, ctx.user.id]);
        }
        await c.query(
          `INSERT INTO product_source_refs (shop_id, source, kind, external_id, product_id, variant_id, raw_row)
           VALUES (current_shop_id(), 'tiktok', 'variant', $1, $2, $3, $4)`,
          [v.sourceVariantId, existing.product_id, inserted.id, v.sourceRawRow ?? null]);
        changed = true; variantsCreated++;
      }
    }
    for (const incoming of p.variants) {
      if (!incoming.sourceVariantId) continue;
      const current = target.variants.find((v) => String(v.external_id) === String(incoming.sourceVariantId));
      if (current?.source_ref_id) {
        await c.query(
          `UPDATE product_source_refs SET raw_row = $1, imported_at = now() WHERE id = $2`,
          [incoming.sourceRawRow ?? null, current.source_ref_id],
        );
      }
    }
    await c.query(
      `UPDATE product_source_refs SET raw_row = $1, imported_at = now()
        WHERE id = $2`, [p.sourceRawRow ?? null, existing.id]);
    if (changed && (plan.priceChanges.length || variantsCreated)) {
      await syncProductPrice(c, existing.product_id);
    }
    if (changed) await audit(c, 'product.updated_by_import', {
      actorId: ctx.user.id, ip: ctx.ip,
      metadata: { productId: existing.product_id, source: p.source, mode: flags.mode, changes: plan.diffs.slice(0, 100) },
    });
    return { ...plan, changed, variantsUpdated, variantsCreated, warnings, replacedMedia };
  });
  if (result.replacedMedia?.length) {
    const cleanup = await purgeReplacedProductMedia(ctx.shopId, result.replacedMedia);
    if (cleanup.failed) result.warnings.push({
      type: 'media_cleanup_failed', product_id: existing.product_id,
      message: `${cleanup.failed} ảnh cũ đã ẩn nhưng chưa dọn được khỏi kho; hệ thống sẽ thử lại khi thay ảnh lần sau.`,
    });
  }
  delete result.replacedMedia;
  return result;
}

// ── Handler ────────────────────────────────────────────────────────────────
export async function importProducts(res, ctx, body) {
  const originalRows = Array.isArray(body.rows) ? body.rows : [];
  if (originalRows.length === 0) return send(res, 400, { error: 'không có dòng nào để nhập' });
  const adapted = adaptRows(originalRows, {
    axisNames: body.axis_names ?? {},
    splitOff: new Set(Array.isArray(body.split_off) ? body.split_off.map(String) : []),
  });
  const raw = adapted.rows;

  // Có cột handle hay không quyết định chế độ gộp — xét trên TOÀN FILE, không theo từng dòng.
  const hasHandleColumn = raw.some((r) => Object.keys(r ?? {}).some((k) => COLS.handle.includes(normKey(k))));
  const rows = raw.map(mapRow);
  const groups = groupRows(rows, hasHandleColumn);
  if (groups.length > IMPORT_MAX_PRODUCTS) {
    return send(res, 413, { error: `tối đa ${IMPORT_MAX_PRODUCTS} sản phẩm mỗi lần nhập` });
  }

  const columns = inspectSourceColumns(originalRows, adapted.source) ?? inspectColumns(originalRows);
  const flags = adapted.source === 'tiktok' ? importFlags(body) : {
    mode: 'create_only', updateContent: true, updatePrice: false, updateStock: false, priceConfirmed: false,
  };
  const imageLimit = imageLimitForRequest(body);
  if (adapted.source === 'tiktok' && flags.mode !== 'create_only' && flags.updatePrice && !flags.priceConfirmed) {
    return send(res, 400, { error: 'Cập nhật giá TikTok cần bật xác nhận giá riêng trước khi thực hiện' });
  }

  // XEM TRƯỚC: kiểm + gộp rồi trả kết quả, KHÔNG ghi một dòng nào và KHÔNG tải ảnh.
  // Vì sao đáng có: file 500 dòng nhập sai một lần là 500 sản phẩm rác phải xoá tay. Mọi
  // hàm kiểm ở trên đều THUẦN nên chế độ này gần như miễn phí — chỉ là dừng trước khi ghi.
  if (body.dry_run === true) {
    const errs = [], preview = [];
    let variants = 0, imgOk = 0, imgBad = 0, imgOverflow = 0;
    const sourceIds = [];
    for (const g of groups) {
      const built = buildProduct(g);
      if (!built.ok) { errs.push({ line: built.line, title: str(g.rows[0].r.title), error: built.error }); continue; }
      const p = built.product;
      if (adapted.source === 'tiktok') sourceIds.push(p.slug);
      variants += p.variants.length;
      // Đếm ĐÚNG NHƯ lúc ghi thật: xem trước báo "10 ảnh" rồi lúc nhập ra "7 xếp hàng,
      // 3 sai định dạng" là xem trước nói dối.
      for (const u of p.images) {
        if (!looksFetchable(u)) imgBad++;
        else if (imgOk >= imageLimit) imgOverflow++;
        else imgOk++;
      }
      if (preview.length < 20) {
        preview.push({ title: p.title, slug: p.slug, variants: p.variants.length,
          axes: p.axes.map((a) => a.name), category: p.catPath.join(' > ') });
      }
    }
    let skippedExisting = 0, updated = 0, unchanged = 0, variantsUpdated = 0, variantsCreated = 0;
    const diffs = [], missingVariants = [], warnings = [];
    if (sourceIds.length) {
      skippedExisting = await withTenant(ctx.shopId, async (c) => (await c.query(
        `SELECT count(*)::int AS n FROM product_source_refs
         WHERE source = 'tiktok' AND kind = 'product' AND external_id = ANY($1::text[])`, [sourceIds])).rows[0]?.n ?? 0);
    }
    if (adapted.source === 'tiktok' && flags.mode !== 'create_only') {
      for (const g of groups) {
        const built = buildProduct(g);
        if (!built.ok) continue;
        const p = sourceFields(built.product, adapted);
        const existing = await findSourceProduct(ctx, p);
        if (!existing) {
          if (flags.mode === 'update_only') errs.push({ line: p.line, title: p.title, error: 'không tìm thấy sản phẩm TikTok đã nhập để cập nhật' });
          continue;
        }
        const plan = await withTenant(ctx.shopId, async (c) => {
          const target = await readImportTarget(c, existing.product_id, false);
          if (!target) return null;
          const result = importDiff(existing.product_id, p, target, flags);
          result.warnings = result.priceChanges.length ? await activePromotionWarnings(c, existing.product_id) : [];
          return result;
        });
        if (!plan) { errs.push({ line: p.line, title: p.title, error: 'sản phẩm nguồn không còn tồn tại' }); continue; }
        diffs.push(...plan.diffs);
        errs.push(...plan.errors);
        warnings.push(...(plan.warnings ?? []));
        missingVariants.push(...plan.diffs.filter((d) => d.action === 'keep'));
        if (plan.changed) updated++; else unchanged++;
        variantsUpdated += plan.priceChanges.length + plan.stockChanges.length;
        variantsCreated += plan.newVariants.length;
      }
    }
    const existingCount = adapted.source === 'tiktok' && flags.mode !== 'create_only' ? updated + unchanged : skippedExisting;
    const wouldCreate = groups.length - errs.length - existingCount;
    return send(res, 200, {
      dry_run: true, import_mode: flags.mode, update_content: flags.updateContent,
      update_price: flags.updatePrice, update_stock: flags.updateStock, price_confirmed: flags.priceConfirmed,
      rows: originalRows.length, groups: groups.length,
      created: Math.max(0, wouldCreate), updated, unchanged,
      skipped_existing: flags.mode === 'create_only' ? skippedExisting : 0,
      variants, variants_updated: variantsUpdated, variants_created: variantsCreated,
      images: { queued: imgOk, invalid: imgBad, skipped: imgOverflow,
        limit: imageLimit, remaining: Math.max(0, imageLimit - imgOk) },
      diffs: diffs.slice(0, 500), missing_variants: missingVariants.slice(0, 200), warnings: warnings.slice(0, 100),
      failed: errs.length, errors: errs.slice(0, 100), preview, columns,
      source: adapted.source, axisHints: adapted.axisHints,
    });
  }

  const cap = await withTenant(ctx.shopId, async (c) => ({ max: await planMaxProducts(c), count: await catalogCount(c) }));
  // TikTok không có seller_sku nên adapter phải sinh mã. Chỉ né trùng trong chính tệp là
  // chưa đủ: shop có thể đã dùng mã đó từ trước, và UNIQUE(shop_id, sku) sẽ làm cả sản phẩm
  // rollback. Chụp tập SKU hiện có một lần rồi giữ chỗ cho từng biến thể trong lô.
  const reservedSkus = adapted.source === 'tiktok'
    ? new Set(await withTenant(ctx.shopId, async (c) => (await c.query('SELECT sku FROM variants')).rows.map((r) => r.sku)))
    : null;

  const seenSlug = new Set();
  const errors = [];
  let created = 0, updated = 0, unchanged = 0, variantsCreated = 0, variantsUpdated = 0;
  const diffs = [], missingVariants = [], warnings = [];
  const imageState = { queued: 0, invalid: 0, overflow: 0, limit: imageLimit };

  for (const g of groups) {
    const built = buildProduct(g);
    if (!built.ok) { errors.push({ line: built.line, title: str(g.rows[0].r.title), error: built.error }); continue; }
    const p = built.product;
    sourceFields(p, adapted);

    const existing = await findSourceProduct(ctx, p);
    if (existing) {
      if (flags.mode === 'create_only' || adapted.source !== 'tiktok') {
        errors.push({ line: p.line, title: p.title, skipped: true, error: 'sản phẩm từ nguồn này đã nhập trước đó, bỏ qua' });
        continue;
      }
      try {
        const result = await updateImportedProduct(ctx, p, existing, flags, imageState);
        if (result.missing) {
          errors.push({ line: p.line, title: p.title, error: 'sản phẩm nguồn không còn tồn tại' });
        } else {
          diffs.push(...(result.diffs ?? []));
          errors.push(...(result.errors ?? []));
          warnings.push(...(result.warnings ?? []));
          missingVariants.push(...(result.diffs ?? []).filter((d) => d.action === 'keep'));
          if (result.changed) updated++; else unchanged++;
          variantsUpdated += Number(result.variantsUpdated ?? 0);
          variantsCreated += Number(result.variantsCreated ?? 0);
        }
      } catch (err) {
        errors.push({ line: p.line, title: p.title, error: err.code === '23505' ? conflictMessage(err) : 'lỗi khi cập nhật sản phẩm' });
      }
      continue;
    }

    if (adapted.source === 'tiktok' && flags.mode === 'update_only') {
      errors.push({ line: p.line, title: p.title, error: 'không tìm thấy sản phẩm TikTok đã nhập để cập nhật' });
      continue;
    }

    if (cap.max != null && cap.count + created >= cap.max) {
      errors.push({ line: p.line, title: p.title, error: `vượt giới hạn gói (${cap.max} sản phẩm)` });
      continue;
    }
    if (reservedSkus) {
      for (const v of p.variants) v.sku = reserveImportedSku(v.sku, reservedSkus);
    }
    // Slug trùng NGAY trong lô (DB chỉ chặn trùng với dữ liệu đã có).
    if (seenSlug.has(p.slug)) {
      let n = 2; while (seenSlug.has(`${p.slug}-${n}`)) n++;
      p.slug = `${p.slug}-${n}`.slice(0, 60);
    }
    seenSlug.add(p.slug);

    try {
      const inserted = await insertProduct(ctx, p);
      const productId = inserted.productId;
      created++;
      variantsCreated += p.variants.length;
      for (const url of p.images) {
        if (!looksFetchable(url)) { imageState.invalid++; continue; }
        if (imageState.queued >= imageState.limit) { imageState.overflow++; continue; }
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
            [productId, url.slice(0, 2000), mediaId, `staging/${ctx.shopId}/${mediaId}`],
          ));
          imageState.queued++;
        } catch { imageState.invalid++; }   // đếm ĐÚNG MỘT lần: bản đầu tăng cả hai biến
      }
    } catch (err) {
      // withTenant rollback-on-throw ⇒ không để lại sản phẩm thiếu biến thể/thiếu map trục.
      seenSlug.delete(p.slug);
      errors.push({ line: p.line, title: p.title,
        error: err.code === 'IMPORT_SOURCE_CONFLICT' ? 'nguồn TikTok vừa được nhập bởi một yêu cầu khác' : (err.code === '23505' ? conflictMessage(err) : 'lỗi khi tạo sản phẩm') });
    }
  }

  return send(res, 200, {
    import_mode: flags.mode, update_content: flags.updateContent,
    update_price: flags.updatePrice, update_stock: flags.updateStock, price_confirmed: flags.priceConfirmed,
    created,
    updated, unchanged, variants_updated: variantsUpdated, variants_created: variantsCreated,
    skipped_existing: errors.filter((e) => e.skipped).length,
    variants: variantsCreated, groups: groups.length,
    failed: errors.filter((e) => !e.skipped).length, errors: errors.slice(0, 100),
    // queued: worker sẽ tải nền · invalid: URL sai dáng, KHÔNG bao giờ tải được ·
    // skipped: vượt trần số ảnh mỗi lần nhập. Không con số nào im lặng.
    diffs: diffs.slice(0, 500), missing_variants: missingVariants.slice(0, 200), warnings: warnings.slice(0, 100),
    images: { queued: imageState.queued, invalid: imageState.invalid, skipped: imageState.overflow,
      limit: imageLimit, remaining: Math.max(0, imageLimit - imageState.queued) },
    columns,
    source: adapted.source, axisHints: adapted.axisHints,
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

const O_STATUS = { delivered: 'delivered', completed: 'delivered', done: 'delivered', 'hoàn thành': 'delivered',
  cancelled: 'cancelled', canceled: 'cancelled', 'đã huỷ': 'cancelled', 'da huy': 'cancelled',
  refunded: 'refunded', 'hoàn tiền': 'refunded' };
const O_PAY = { paid: 'paid', 'đã thanh toán': 'paid', 'da thanh toan': 'paid', unpaid: 'unpaid',
  pending: 'unpaid', refunded: 'refunded' };

// Trạng thái mà quét ẩn danh PII đụng tới — MIRROR của apps/worker/src/index.js
// (sweepPiiRetention, `o.status IN (...)`). Bản chép tay này để CẢNH BÁO, không cưỡng chế:
// hai bên lệch thì con số cảnh báo sai, KHÔNG mất tiền và không mất dữ liệu.
//
// NÓI THẲNG: HÔM NAY đây là no-op. O_STATUS ở trên chỉ ánh xạ ra delivered/cancelled/refunded
// và mọi chuỗi lạ rơi về 'delivered' (dòng 574) → mọi đơn nhập đều terminal, bộ lọc không
// loại dòng nào. Giữ lại vì nó chặn ĐÚNG hướng an toàn: nếu sau này O_STATUS nhận thêm một
// trạng thái CHƯA XONG (vd 'shipped'), cảnh báo sẽ tự động thôi đếm dòng đó thay vì doạ nhầm.
// Cố ý KHÔNG viết test cho nhánh này: qua đường nhập nó không tới được, test sẽ phải bịa
// dữ liệu và chỉ chứng minh chính nó.
const PII_TERMINAL = new Set(['delivered', 'cancelled', 'refunded', 'returned']);

/**
 * Đếm xem trong lô sắp nhập, bao nhiêu đơn sẽ bị ẩn danh NGAY nhịp quét kế.
 *
 * VÌ SAO CẦN: importOrders ghi `created_at` = NGÀY TRÊN TỆP CŨ (đúng — đó là ngày đơn phát
 * sinh thật), còn quét ẩn danh lọc theo `created_at`. Shop có bật hạn lưu mà nhập 2 năm lịch
 * sử thì tên/SĐT/địa chỉ của phần cũ hơn hạn sẽ bị xoá trong vòng 24 giờ. Việc XOÁ là ĐÚNG
 * chính sách (hạn lưu đo theo TUỔI DỮ LIỆU, không theo ngày nhập vào hệ thống) — cái sai duy
 * nhất là KHÔNG AI BÁO TRƯỚC: người bán vừa bỏ công di cư để giữ hồ sơ khách. Xem docs/56.
 *
 * Mốc cắt tính BẰNG SQL, không bằng JS: `now() - (N || ' months')::interval` là đúng biểu
 * thức quét dùng — cộng trừ tháng bằng tay trong JS sẽ lệch ở tháng 28/29/30/31 ngày.
 * Shop chưa bật hạn lưu (NULL = mặc định) → trả null, không cảnh báo gì.
 */
async function demDonSeAnDanh(shopId, ready) {
  const cfg = await withTenant(shopId, async (c) => (await c.query(
    `SELECT pii_retention_months AS thang,
            now() - (pii_retention_months || ' months')::interval AS moc
       FROM shops WHERE id = current_shop_id()`)).rows[0] ?? null);
  if (!cfg?.thang || !cfg.moc) return null;
  const moc = new Date(cfg.moc);
  const soDon = ready.filter((o) => PII_TERMINAL.has(o.status) && o.when < moc).length;
  return soDon > 0 ? { retention_months: Number(cfg.thang), rows: soDon } : null;
}

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

  // Cảnh báo ẩn danh: tính cho CẢ hai đường. Ở xem-trước nó có giá trị nhất (còn kịp đổi
  // hạn lưu trước khi ghi); ở nhập-thật vẫn phải có, vì người bán bấm thẳng "Nhập thật" được.
  const pii = await demDonSeAnDanh(ctx.shopId, ready);

  if (body.dry_run === true) {
    return send(res, 200, {
      dry_run: true, rows: raw.length, created: ready.length, failed: errors.length,
      errors: errors.slice(0, 100), columns, ...(pii ? { pii } : {}),
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
    customers: new Set(ready.map((x) => x.phone)).size, ...(pii ? { pii } : {}),
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
