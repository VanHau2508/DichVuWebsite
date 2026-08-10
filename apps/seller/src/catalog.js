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
import { send, parseOffset } from './http.js';
import { withTenant, audit } from './db.js';

// Base URL ảnh public (giống storefront) — dựng URL thumbnail cho danh sách SP trong admin.
const MEDIA_PUBLIC_BASE = process.env.MEDIA_PUBLIC_BASE ?? '/media-public';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
// Biến thể MỒ CÔI = thiếu ánh xạ variant_option_values cho một trục (xảy ra khi shop thu hẹp
// trục sau khi đã sinh ma trận). Storefront/checkout ẨN nó → tồn của nó KHÔNG bán được.
// Bản sao y hệt orders.js:28 / purchasing.js:29 (mỗi service tự chứa, không import chéo app).
// YÊU CẦU: query bao ngoài phải đặt alias biến thể đúng tên `v`.
const VARIANT_NOT_ORPHAN_SQL = `NOT EXISTS (
  SELECT 1 FROM product_options po WHERE po.product_id = v.product_id
    AND NOT EXISTS (SELECT 1 FROM variant_option_values vov
                     WHERE vov.variant_id = v.id AND vov.option_id = po.id))`;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const MAX_PRICE = 100_000_000_000; // 100 tỷ VND — chặn tràn/nhập nhầm

export const isInt = (x) => Number.isInteger(x);
export const validPrice = (x) => isInt(x) && x >= 0 && x <= MAX_PRICE;
// Cân biến thể (gram): null = xoá (dùng mặc định shop khi tính phí ship theo cân).
export const validWeight = (w) => w === null || (isInt(w) && w >= 1 && w <= 50000);
// Giá GẠCH NGANG (compare-at, 0067): CHỈ hiển thị — checkout luôn tính price_vnd.
// null = xoá. Khi đặt phải > giá bán (kiểm ở từng handler, cần biết giá hiệu lực).
export const validCompareAt = (x) => x === null || (isInt(x) && x >= 0 && x <= MAX_PRICE);
// Giá VỐN (0081): bảng riêng variant_costs — null = xoá. KHÔNG validate cost<giá bán
// (bán lỗ chủ đích là hợp lệ — flash sale/xả kho; UI chỉ cảnh báo mềm).
export const validCost = (x) => x === null || (isInt(x) && x >= 0 && x <= MAX_PRICE);
export const validTitle = (x) => typeof x === 'string' && x.trim().length >= 1 && x.length <= 200;
export const validSku = (x) => typeof x === 'string' && x.trim().length >= 1 && x.length <= 64;
export const validSlug = (x) => typeof x === 'string' && SLUG_RE.test(x);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// parent_id (danh mục 2 cấp, 0095): '' / null / undefined → null (cấp trên cùng); chuỗi
// UUID hợp lệ → giữ; giá trị lạ → false (handler trả 400). Ràng buộc "cha phải cấp-1" +
// "danh mục có con không được làm con" kiểm TRONG transaction (cần đọc DB).
const normParentId = (x) => (x == null || x === '') ? null : (typeof x === 'string' && UUID_RE.test(x) ? x : false);

// Escape ký tự wildcard để q được so khớp NGUYÊN VĂN trong ILIKE.
const likeEscape = (s) => s.replace(/[%_\\]/g, '\\$&');

// ── audit diff TRƯỚC/SAU (rà soát #9): 'nhân viên hạ giá 500k→50k' phải chứng
// minh được từ nhật ký. Chỉ ALLOWLIST trường NGHIỆP VỤ (giá, SKU, tiêu đề, trạng
// thái, cân, giá gạch) — không PII, không mô tả dài. Chỉ ghi trường THAY ĐỔI thật.
const NUMERIC_AUDIT_FIELDS = ['price_vnd', 'compare_at_vnd', 'weight_gram', 'cost_vnd'];
function diffChanged(oldRow, want) {
  const changed = {};
  for (const [k, v] of Object.entries(want)) {
    const num = NUMERIC_AUDIT_FIELDS.includes(k);
    const from = num ? (oldRow[k] == null ? null : Number(oldRow[k])) : oldRow[k];
    const to = num ? (v == null ? null : Number(v)) : v;
    if (from !== to) changed[k] = { from, to };
  }
  return changed;
}
// Trần ~2KB cho metadata audit — vượt thì bỏ phần diff, đánh dấu truncated.
function capMeta(meta) {
  if (JSON.stringify(meta).length <= 2048) return meta;
  const { changed, ...rest } = meta;
  return { ...rest, truncated: true };
}
const withChanged = (meta, changed) => capMeta({ ...meta, ...(Object.keys(changed).length ? { changed } : {}) });

/** Ánh xạ lỗi unique về thông báo đúng cột. */
export function conflictMessage(err) {
  const c = err.constraint ?? '';
  if (c.includes('slug')) return 'slug đã tồn tại trong shop';
  if (c.includes('sku')) return 'SKU đã tồn tại trong shop';
  return 'trùng dữ liệu';
}

// ── ép giới hạn gói (max_products) ───────────────────────────────────────────
// Đọc gói của shop (subscriptions → plans) trong tenant context. NULL = không giới hạn.
export async function planMaxProducts(c) {
  const r = await c.query(`SELECT pl.max_products FROM subscriptions s JOIN plans pl ON pl.code = s.plan_code WHERE s.shop_id = current_shop_id()`);
  return r.rows[0]?.max_products ?? null;
}
export const catalogCount = async (c) => (await c.query(`SELECT count(*)::int n FROM products WHERE deleted_at IS NULL`)).rows[0].n;

// Sản phẩm KHÁCH THẬT SỰ MUA ĐƯỢC = đang bán + còn hàng bán. Khác hẳn catalogCount:
// checklist onboarding từng tick ✓ "đã thêm sản phẩm" chỉ vì có 1 dòng products, trong khi
// tồn = 0 nên storefront hiện "Hết hàng". Khen dối làm chủ shop tưởng xong rồi.
export const sellableCount = async (c) => (await c.query(
  // `variants` KHÔNG có deleted_at (xoá cứng) — chỉ `products` xoá mềm. Bản đầu lọc
  // v.deleted_at IS NULL: câu lệnh ném lỗi → endpoint 500 → overview NUỐT lỗi thành
  // "mục chưa xong", im lặng hoàn toàn. e2e bắt được, đọc code thì không.
  `SELECT count(DISTINCT p.id)::int n
     FROM products p
     JOIN variants v ON v.product_id = p.id
     JOIN inventory_levels il ON il.variant_id = v.id
    WHERE p.deleted_at IS NULL AND p.status = 'active'
      AND il.on_hand - il.reserved > 0`,
)).rows[0].n;

// Đồng bộ giá "TỪ" của sản phẩm = min(giá biến thể) — thẻ lưới/sort/lọc storefront đọc
// products.price_vnd (0093). Gọi trong CÙNG transaction ở MỌI điểm ghi làm đổi giá hoặc
// tập biến thể (tạo SP, thêm/sửa/xoá biến thể, sinh ma trận) — sót một điểm là giá thẻ
// lệch lại. Checkout KHÔNG đụng (luôn tính trên variants.price_vnd).
// LOẠI biến thể MỒ CÔI (thiếu ánh xạ trục — storefront đã ẩn, không bán được): tính cả
// chúng thì giá cũ của tổ hợp bỏ đi kéo giá "từ" sai + pool-reuse (basePrice đọc từ
// products.price_vnd) lây giá khuyến mãi cũ sang tổ hợp mới.
export const syncProductPrice = async (c, productId) => {
  await c.query(
    `UPDATE products p SET price_vnd = sub.min_price
       FROM (SELECT min(v.price_vnd) AS min_price FROM variants v
              WHERE v.product_id = $1
                AND NOT EXISTS (SELECT 1 FROM product_options po WHERE po.product_id = v.product_id
                  AND NOT EXISTS (SELECT 1 FROM variant_option_values vov
                                   WHERE vov.variant_id = v.id AND vov.option_id = po.id))) sub
      WHERE p.id = $1 AND sub.min_price IS NOT NULL AND p.price_vnd IS DISTINCT FROM sub.min_price`,
    [productId],
  );
};

// ── products ─────────────────────────────────────────────────────────────────

async function createProduct(res, ctx, body) {
  const title = String(body.title ?? '').trim();
  const typedSlug = String(body.slug ?? '').toLowerCase().trim();
  const description = body.description != null ? String(body.description) : null;
  const status = body.status === 'active' ? 'active' : 'draft';
  const priceVnd = body.price_vnd;
  const variants = Array.isArray(body.variants) ? body.variants : [];
  const categoryIds = Array.isArray(body.category_ids) ? body.category_ids : [];

  if (!validTitle(title)) return send(res, 400, { error: 'tiêu đề không hợp lệ' });
  // Slug BỎ TRỐNG → tự sinh từ tên (bỏ dấu). Chủ shop gõ "Cà phê sữa đá" không phải tự
  // nghĩ ra "ca-phe-sua-da" — ô khó nhất form, và là ô duy nhất bắt hiểu luật kỹ thuật.
  // Tên toàn ký tự lạ (emoji…) slugify ra rỗng → 'sp' + hậu tố, để không chặn người dùng.
  const derived = !typedSlug;
  const slug = derived ? (slugify(title) || `sp-${crypto.randomBytes(3).toString('hex')}`) : typedSlug;
  if (!validSlug(slug)) return send(res, 400, { error: 'slug không hợp lệ (a-z, 0-9, gạch ngang)' });
  if (!validPrice(priceVnd)) return send(res, 400, { error: 'giá không hợp lệ' });
  if (variants.length < 1 || variants.length > 100) return send(res, 400, { error: 'cần 1–100 biến thể' });
  // SKU BỎ TRỐNG → tự sinh. Quán cà phê bán 1 món không có khái niệm SKU; bắt buộc ô này
  // là chặn thẳng người mới. CHỈ ĐÁNH DẤU ở đây, điền THẬT trong transaction — SKU lấy gốc
  // từ slug, mà slug tự sinh có thể bị nối "-2" khi trùng; sinh sớm thì hai sản phẩm cùng
  // tên đụng SKU nhau (đã vấp thật: SP thứ hai trả 409 "SKU đã tồn tại").
  const autoSku = variants.map((v) => !v || v.sku == null || String(v.sku).trim() === '');
  for (const [i, v] of variants.entries()) {
    if (!autoSku[i] && !validSku(v.sku)) return send(res, 400, { error: 'SKU biến thể không hợp lệ' });
    if (!validPrice(v.price_vnd)) return send(res, 400, { error: 'giá biến thể không hợp lệ' });
    if (v.weight_gram !== undefined && !validWeight(v.weight_gram)) return send(res, 400, { error: 'khối lượng biến thể không hợp lệ (1–50000g)' });
    if (v.compare_at_vnd !== undefined && !validCompareAt(v.compare_at_vnd)) return send(res, 400, { error: 'giá gạch biến thể không hợp lệ' });
    if (v.compare_at_vnd != null && v.compare_at_vnd <= v.price_vnd) return send(res, 400, { error: 'giá gạch phải lớn hơn giá bán' });
    // Tồn ban đầu ngay lúc tạo. Trước đây tồn LUÔN = 0 → shop mới thêm SP, chọn "Đăng bán
    // ngay", mở storefront ra thấy "Hết hàng" mà không hiểu vì sao. Tuỳ chọn (bỏ qua = 0).
    if (v.stock !== undefined && v.stock !== null && !(Number.isInteger(v.stock) && v.stock >= 0 && v.stock <= 1_000_000)) {
      return send(res, 400, { error: 'tồn kho ban đầu không hợp lệ (0–1000000)' });
    }
  }
  // SKU trùng nhau NGAY trong payload → chặn sớm (DB cũng chặn nhưng báo rõ hơn).
  // Chỉ soi SKU NGƯỜI GÕ: cái tự sinh chưa tồn tại ở bước này và được đảm bảo duy nhất dưới.
  const skus = variants.filter((_, i) => !autoSku[i]).map((v) => v.sku.trim());
  if (new Set(skus).size !== skus.length) return send(res, 400, { error: 'SKU trùng trong danh sách biến thể' });

  try {
    const out = await withTenant(ctx.shopId, async (c) => {
      // Ép giới hạn gói: đã đạt max_products → chặn (nâng gói để thêm).
      const max = await planMaxProducts(c);
      if (max != null && (await catalogCount(c)) >= max) return { over: max };
      // Slug TỰ SINH mà trùng → tự nối "-2", "-3"… Người dùng không gõ ô đó thì báo lỗi
      // "slug đã tồn tại" là vô nghĩa với họ. Slug họ GÕ TAY vẫn báo lỗi như cũ (409) —
      // họ chọn địa chỉ đó có chủ đích, đổi ngầm sau lưng là sai.
      // (UNIQUE chỉ tính hàng còn sống — 0116 — nên lọc deleted_at IS NULL cho khớp.)
      let finalSlug = slug;
      if (derived) {
        for (let n = 2; n <= 50; n++) {
          const taken = await c.query(`SELECT 1 FROM products WHERE slug = $1 AND deleted_at IS NULL LIMIT 1`, [finalSlug]);
          if (taken.rowCount === 0) break;
          finalSlug = `${slug.slice(0, 56)}-${n}`;
        }
      }
      // SKU tự sinh: gốc là slug ĐÃ CHỐT (sau khi né trùng), rồi tự né tiếp nếu SKU đó đã
      // có. SKU của SP xoá-mềm VẪN nằm trong bảng variants nên vẫn đụng được.
      for (let i = 0; i < variants.length; i++) {
        if (!autoSku[i]) continue;
        const base = variants.length > 1 ? `${finalSlug.slice(0, 52)}-${i + 1}` : finalSlug.slice(0, 58);
        let s = base;
        for (let n = 2; n <= 50; n++) {
          const taken = await c.query(`SELECT 1 FROM variants WHERE sku = $1 LIMIT 1`, [s]);
          if (taken.rowCount === 0) break;
          s = `${base.slice(0, 55)}-${n}`;
        }
        variants[i].sku = s;
      }
      const p = await c.query(
        `INSERT INTO products (shop_id, slug, title, description, price_vnd, status)
         VALUES (current_shop_id(), $1, $2, $3, $4, $5) RETURNING id`,
        [finalSlug, title, description, priceVnd, status],
      );
      const productId = p.rows[0].id;

      for (let i = 0; i < variants.length; i++) {
        const v = variants[i];
        const vid = (await c.query(
          `INSERT INTO variants (shop_id, product_id, title, sku, price_vnd, position, weight_gram, compare_at_vnd)
           VALUES (current_shop_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [productId, v.title != null ? String(v.title) : null, v.sku.trim(), v.price_vnd, i, v.weight_gram ?? null, v.compare_at_vnd ?? null],
        )).rows[0].id;
        // Tồn ban đầu — CÙNG transaction (cùng lối import.js): giữ bất biến tổng delta
        // sổ cái == on_hand. Bỏ qua khi 0 để không đẻ dòng sổ cái rỗng.
        if (v.stock > 0) {
          await c.query(`INSERT INTO inventory_levels (shop_id, variant_id, on_hand) VALUES (current_shop_id(), $1, $2)`, [vid, v.stock]);
          await c.query(
            `INSERT INTO inventory_ledger (shop_id, variant_id, delta, kind, reason, actor_id)
             VALUES (current_shop_id(), $1, $2, 'receive', 'tồn ban đầu khi tạo sản phẩm', $3)`,
            [vid, v.stock, ctx.user.id],
          );
        }
      }

      for (const catId of categoryIds) {
        // Composite FK (shop_id, category_id) → danh mục shop khác gây 23503.
        await c.query(
          `INSERT INTO product_categories (shop_id, product_id, category_id)
           VALUES (current_shop_id(), $1, $2)`,
          [productId, catId],
        );
      }

      // Giá "từ" của SP = min giá biến thể (0093) — payload có thể gửi price_vnd lệch min.
      await syncProductPrice(c, productId);

      await audit(c, 'product.created', { actorId: ctx.user.id, ip: ctx.ip, metadata: { productId, slug: finalSlug } });
      return { productId, slug: finalSlug };
    });
    if (out.over != null) return send(res, 403, { error: `đã đạt giới hạn gói (${out.over} sản phẩm). Nâng gói để thêm sản phẩm.` });
    return send(res, 201, { id: out.productId, slug: out.slug, status });
  } catch (err) {
    if (err.code === '23505') return send(res, 409, { error: conflictMessage(err) });
    if (err.code === '23503') return send(res, 400, { error: 'danh mục không hợp lệ' });
    throw err;
  }
}

async function listProducts(res, ctx, _body, _params, query) {
  const limit = Math.min(Math.max(parseInt(query.get('limit') ?? '20', 10) || 20, 1), 100);
  const offset = parseOffset(query);
  const q = (query.get('q') ?? '').trim();
  const status = query.get('status');

  const where = ['p.deleted_at IS NULL'];
  const args = [];
  if (q) {
    // Tìm KHÔNG DẤU (0048): vn_unaccent 2 vế — "ghe sofa" khớp "Ghế sofa".
    // Kèm tìm theo SKU biến thể (rà soát #16): seller dán mã SKU vào ô tìm là ra
    // sản phẩm — SKU không dấu nên ILIKE thường là đủ, không cần vn_unaccent.
    args.push('%' + likeEscape(q) + '%');
    where.push(`(vn_unaccent(p.title) LIKE vn_unaccent($${args.length})
      OR EXISTS (SELECT 1 FROM variants sv WHERE sv.product_id = p.id AND sv.sku ILIKE $${args.length}))`);
  }
  // Chốt bản KHÔNG-kể-trạng-thái TRƯỚC khi thêm mệnh đề status → dùng để đếm cho TAB
  // (mỗi tab hiện "trong kết quả tìm hiện tại, trạng thái này có bao nhiêu SP"). Thêm status
  // SAU CÙNG nên tham số status luôn là $cuối, khỏi phải đánh số lại (cùng cách orders.js).
  // Lọc SẮP HẾT HÀNG. Ô "Sắp hết hàng" ở Tổng quan bấm vào đây (docs/44 §7).
  // Dùng ĐÚNG ngưỡng per-shop mà worker cảnh báo tồn đang dùng (low_stock_threshold, mặc
  // định 5) — nếu hai nơi lệch ngưỡng thì con số ở Tổng quan và danh sách sẽ đá nhau, và
  // người bán không có cách nào biết bên nào đúng.
  // VARIANT_NOT_ORPHAN_SQL: biến thể mồ côi (thiếu giá trị cho một trục) KHÔNG bán được nên
  // không tính là sắp hết — nếu tính, danh sách đầy sản phẩm không ai mua được.
  if (query.get('stock') === 'low') {
    where.push(`EXISTS (SELECT 1 FROM variants v
                          JOIN inventory_levels il ON il.variant_id = v.id
                         WHERE v.product_id = p.id AND ${VARIANT_NOT_ORPHAN_SQL}
                           AND (il.on_hand - il.reserved) <= coalesce(
                                 (SELECT low_stock_threshold FROM shops WHERE id = current_shop_id()), 5))`);
  }
  const countArgs = [...args];
  const whereNoStatusSql = where.join(' AND ');
  if (['draft', 'active', 'archived'].includes(status)) {
    args.push(status);
    where.push(`p.status = $${args.length}`);
  }
  const whereSql = where.join(' AND ');

  const data = await withTenant(ctx.shopId, async (c) => {
    const total = await c.query(`SELECT count(*)::int AS n FROM products p WHERE ${whereSql}`, args);
    // Số đếm theo trạng thái cho TAB — 1 lần quét, FILTER theo status.
    const cnt = (await c.query(`
      SELECT count(*)::int AS all_n,
             count(*) FILTER (WHERE p.status = 'active')   AS active,
             count(*) FILTER (WHERE p.status = 'draft')    AS draft,
             count(*) FILTER (WHERE p.status = 'archived') AS archived
        FROM products p WHERE ${whereNoStatusSql}`, countArgs)).rows[0];
    const rows = await c.query(
      `SELECT p.id, p.slug, p.title, p.price_vnd, p.status, p.created_at,
              -- "Đã bán" đọc CỘT CACHE 0096 (worker tính lại mỗi 15 phút), KHÔNG aggregate.
              p.sold_count,
              -- Lượt xem 30 ngày (0098). Bảng đã GỘP THEO NGÀY nên mỗi SP tối đa 30 dòng —
              -- quét dải trên PK (shop_id, product_id, day), rẻ ở limit ≤ 100 SP/trang.
              (SELECT coalesce(sum(pv.views), 0)::int FROM product_view_daily pv
                WHERE pv.shop_id = p.shop_id AND pv.product_id = p.id
                  AND pv.day > current_date - 30) AS views_30d,
              -- Số khách đã bấm Yêu thích (0100). Tín hiệu thật: nhiều người thích mà không
              -- mua ⇒ giá cao? hết size? Quét dải trên PK (customer_id, product_id) — rẻ.
              (SELECT count(*)::int FROM wishlist_items w
                WHERE w.shop_id = p.shop_id AND w.product_id = p.id) AS wish_count,
              (SELECT count(*)::int FROM variants v WHERE v.product_id = p.id) AS variant_count,
              -- TỒN "còn bán được" = on_hand - reserved, LOẠI biến thể MỒ CÔI y hệt storefront
              -- (server.js:538) và checkout — nếu không, admin thấy còn hàng mà khách mua không được.
              (SELECT coalesce(sum(il.on_hand - il.reserved), 0)::int
                 FROM variants v LEFT JOIN inventory_levels il ON il.variant_id = v.id
                WHERE v.product_id = p.id AND ${VARIANT_NOT_ORPHAN_SQL}) AS stock,
              -- SỐ BIẾN THỂ ĐÃ HẾT. Con số "stock" ở trên là TỔNG — mà khách không mua "tổng",
              -- khách mua đúng MỘT size. Trên một shop thật 60 ngày, 14/15 biến thể hết hàng nằm
              -- trong những sản phẩm hiện tồn 204, 172, 148 — nhìn là yên tâm bỏ qua, còn khách
              -- chọn đúng size đó thì mất đơn. Đếm ở đây để danh sách nói ra được điều đó.
              (SELECT count(*)::int
                 FROM variants v LEFT JOIN inventory_levels il ON il.variant_id = v.id
                WHERE v.product_id = p.id AND ${VARIANT_NOT_ORPHAN_SQL}
                  AND coalesce(il.on_hand - il.reserved, 0) <= 0) AS oos_variants,
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
    const n = (x) => Number(x ?? 0);
    return {
      total: total.rows[0].n, products,
      counts: { '': n(cnt.all_n), active: n(cnt.active), draft: n(cnt.draft), archived: n(cnt.archived) },
      catalog_count: await catalogCount(c), max_products: await planMaxProducts(c),
      sellable_count: await sellableCount(c),
    };
  });
  return send(res, 200, { ...data, limit, offset });
}

async function getProduct(res, ctx, _body, params) {
  const productId = params[1];
  const row = await withTenant(ctx.shopId, async (c) => {
    const p = await c.query(
      `SELECT id, slug, title, description, price_vnd, status, created_at, seo_title, seo_description
         FROM products WHERE id = $1 AND deleted_at IS NULL`,
      [productId],
    );
    if (p.rows.length === 0) return null;
    const variants = await c.query(
      `SELECT v.id, v.title, v.sku, v.price_vnd, v.position, v.weight_gram, v.compare_at_vnd, vc.cost_vnd
         FROM variants v LEFT JOIN variant_costs vc ON vc.shop_id = v.shop_id AND vc.variant_id = v.id
        WHERE v.product_id = $1 ORDER BY v.position`,
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
  const want = {}; // giá trị MỚI của trường ALLOWLIST — cho audit diff from/to
  const add = (col, val) => {
    args.push(val); sets.push(`${col} = $${args.length}`);
    if (col === 'title' || col === 'status' || col === 'price_vnd') want[col] = val;
  };

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
  // SEO riêng cho SP (0098). Bỏ TRỐNG = NULL → storefront tự suy từ tên/mô tả như cũ.
  // Cắt đúng trần của CHECK ở DB thay vì trả 400: người bán dán mô tả dài là chuyện thường,
  // đừng bắt họ tự đếm ký tự.
  if (body.seo_title !== undefined) {
    const v = body.seo_title == null ? '' : String(body.seo_title).trim();
    add('seo_title', v ? v.slice(0, 200) : null);
  }
  if (body.seo_description !== undefined) {
    const v = body.seo_description == null ? '' : String(body.seo_description).trim();
    add('seo_description', v ? v.slice(0, 500) : null);
  }
  if (body.price_vnd !== undefined) {
    if (!validPrice(body.price_vnd)) return send(res, 400, { error: 'giá không hợp lệ' });
    add('price_vnd', body.price_vnd);
  }
  if (sets.length === 0) return send(res, 400, { error: 'không có trường nào để cập nhật' });

  try {
    const n = await withTenant(ctx.shopId, async (c) => {
      // Đọc bản ghi TRƯỚC UPDATE trong CÙNG transaction (FOR UPDATE khoá dòng) —
      // audit ghi from/to chứng minh được ai đổi giá từ bao nhiêu (rà soát #9).
      const cur = await c.query(
        `SELECT title, status, price_vnd FROM products WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [productId],
      );
      if (cur.rows.length === 0) return 0;
      args.push(productId);
      const r = await c.query(
        `UPDATE products SET ${sets.join(', ')} WHERE id = $${args.length} AND deleted_at IS NULL`,
        args,
      );
      if (r.rowCount === 1) {
        await audit(c, 'product.updated', { actorId: ctx.user.id, ip: ctx.ip, metadata: withChanged({ productId }, diffChanged(cur.rows[0], want)) });
      }
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

// ĐỔI TRẠNG THÁI HÀNG LOẠT — chủ shop tick nhiều SP rồi đăng bán / ẩn / lưu trữ một lượt.
// Mirror bulkConfirm của đơn hàng (orders.js:180): mỗi SP MỘT transaction riêng → THÀNH CÔNG
// MỘT PHẦN (SP hỏng không kéo cả lô rollback), trần 100, dedupe bằng Set, lọc lại id ở phía
// seller vì BFF KHÔNG phải biên tin cậy.
//
// Lưu ý: trước đây chỉ có publish(→active) và archive(→archived); KHÔNG có đường đưa SP về
// 'draft' (updateProduct bỏ qua body.status). Ở đây mở cả 3 đích để chủ shop "ẩn tạm" được.
const BULK_STATUS = {
  active: 'product.published',
  draft: 'product.unpublished',
  archived: 'product.archived',
};
async function bulkStatus(res, ctx, body) {
  const status = String(body?.status ?? '');
  // Allowlist Ở CẢ 3 TẦNG (BFF, đây, và CHECK của DB) — status là CHECK constraint chứ
  // không phải enum type nên không được nhét thẳng giá trị người dùng vào UPDATE.
  if (!Object.hasOwn(BULK_STATUS, status)) return send(res, 400, { error: 'trạng thái không hợp lệ' });
  const ids = Array.isArray(body?.product_ids)
    ? [...new Set(body.product_ids.filter((x) => typeof x === 'string' && /^[0-9a-f-]{36}$/.test(x)))] : [];
  if (!ids.length) return send(res, 400, { error: 'không có sản phẩm nào được chọn' });
  if (ids.length > 100) return send(res, 400, { error: 'tối đa 100 sản phẩm mỗi lần' });
  let changed = 0, skipped = 0;
  for (const productId of ids) {
    try {
      const ok = await withTenant(ctx.shopId, async (c) => {
        // deleted_at IS NULL: SP đã xoá mềm không được hồi sinh qua đường bulk.
        const r = await c.query(
          `UPDATE products SET status = $1 WHERE id = $2 AND deleted_at IS NULL AND status <> $1`,
          [status, productId]);
        if (r.rowCount === 1) {
          await audit(c, BULK_STATUS[status], { actorId: ctx.user.id, ip: ctx.ip, metadata: { productId, bulk: true } });
        }
        return r.rowCount === 1;
      });
      ok ? changed++ : skipped++;   // SP vốn đã ở trạng thái đích → tính skipped, không phải lỗi
    } catch { skipped++; }
  }
  return send(res, 200, { ok: true, changed, skipped, status });
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
  if (body.weight_gram !== undefined && !validWeight(body.weight_gram)) return send(res, 400, { error: 'khối lượng không hợp lệ (1–50000g, để trống = mặc định shop)' });
  if (body.compare_at_vnd !== undefined && !validCompareAt(body.compare_at_vnd)) return send(res, 400, { error: 'giá gạch không hợp lệ' });
  if (body.compare_at_vnd != null && body.compare_at_vnd <= body.price_vnd) return send(res, 400, { error: 'giá gạch phải lớn hơn giá bán' });
  try {
    const out = await withTenant(ctx.shopId, async (c) => {
      // Sản phẩm phải tồn tại (composite FK cũng chặn, nhưng báo 404 rõ hơn).
      const p = await c.query(`SELECT 1 FROM products WHERE id = $1 AND deleted_at IS NULL`, [productId]);
      if (p.rows.length === 0) return { code: 404 };
      const pos = await c.query(`SELECT coalesce(max(position), -1) + 1 AS p FROM variants WHERE product_id = $1`, [productId]);
      const v = await c.query(
        `INSERT INTO variants (shop_id, product_id, title, sku, price_vnd, position, weight_gram, compare_at_vnd)
         VALUES (current_shop_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [productId, body.title != null ? String(body.title) : null, body.sku.trim(), body.price_vnd, pos.rows[0].p, body.weight_gram ?? null, body.compare_at_vnd ?? null],
      );
      await syncProductPrice(c, productId); // biến thể mới có thể rẻ hơn → hạ giá "từ" (0093)
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
  const sets = [], args = [], want = {}; // want: giá trị MỚI cho audit diff from/to
  if (body.price_vnd !== undefined) {
    if (!validPrice(body.price_vnd)) return send(res, 400, { error: 'giá không hợp lệ' });
    args.push(body.price_vnd); sets.push(`price_vnd = $${args.length}`); want.price_vnd = body.price_vnd;
  }
  if (body.sku !== undefined) {
    if (!validSku(body.sku)) return send(res, 400, { error: 'SKU không hợp lệ' });
    args.push(String(body.sku).trim()); sets.push(`sku = $${args.length}`); want.sku = String(body.sku).trim();
  }
  // Cân (gram) cho phí ship theo cân: null = xoá (dùng mặc định shop).
  if (body.weight_gram !== undefined) {
    if (!validWeight(body.weight_gram)) return send(res, 400, { error: 'khối lượng không hợp lệ (1–50000g, để trống = mặc định shop)' });
    args.push(body.weight_gram); sets.push(`weight_gram = $${args.length}`); want.weight_gram = body.weight_gram;
  }
  // Giá gạch ngang (compare-at, CHỈ hiển thị — checkout luôn tính price_vnd): null = xoá.
  if (body.compare_at_vnd !== undefined) {
    if (!validCompareAt(body.compare_at_vnd)) return send(res, 400, { error: 'giá gạch không hợp lệ' });
    args.push(body.compare_at_vnd); sets.push(`compare_at_vnd = $${args.length}`); want.compare_at_vnd = body.compare_at_vnd;
  }
  // Giá VỐN (0081): sống ở bảng RIÊNG variant_costs (không phải cột variants) — xử lý
  // ngoài mảng sets. null = xoá dòng. Request CHỈ có cost_vnd vẫn hợp lệ.
  const hasCost = body.cost_vnd !== undefined;
  if (hasCost && !validCost(body.cost_vnd)) return send(res, 400, { error: 'giá vốn không hợp lệ (số nguyên ≥ 0, để trống = xoá)' });
  if (hasCost) want.cost_vnd = body.cost_vnd;
  if (!sets.length && !hasCost) return send(res, 400, { error: 'không có trường nào để cập nhật' });
  try {
    const out = await withTenant(ctx.shopId, async (c) => {
      // Đọc bản ghi TRƯỚC UPDATE (FOR UPDATE, cùng transaction): audit ghi from/to
      // (rà soát #9) + dùng luôn cho check giá gạch bên dưới. cost cũ từ variant_costs.
      const cur = await c.query(
        `SELECT v.sku, v.price_vnd, v.weight_gram, v.compare_at_vnd, vc.cost_vnd
           FROM variants v LEFT JOIN variant_costs vc ON vc.shop_id = v.shop_id AND vc.variant_id = v.id
          WHERE v.id = $1 AND v.product_id = $2 FOR UPDATE OF v`,
        [variantId, productId],
      );
      if (!cur.rows.length) return { code: 404 };
      // compare_at phải > giá bán HIỆU LỰC (giá mới nếu đổi cùng request, giá hiện tại nếu không).
      if (body.compare_at_vnd != null) {
        const effPrice = body.price_vnd !== undefined ? body.price_vnd : Number(cur.rows[0].price_vnd);
        if (body.compare_at_vnd <= effPrice) return { code: 400 };
      }
      if (sets.length) {
        args.push(variantId, productId);
        const r = await c.query(`UPDATE variants SET ${sets.join(', ')} WHERE id = $${args.length - 1} AND product_id = $${args.length}`, args);
        if (r.rowCount !== 1) return { code: 404 };
      }
      if (hasCost) {
        // KHÔNG hồi tố: đơn đã đặt giữ snapshot cũ (order_lines.unit_cost_vnd).
        if (body.cost_vnd === null) await c.query(`DELETE FROM variant_costs WHERE variant_id = $1`, [variantId]);
        else await c.query(
          `INSERT INTO variant_costs (shop_id, variant_id, cost_vnd, updated_by)
           VALUES (current_shop_id(), $1, $2, $3)
           ON CONFLICT (shop_id, variant_id) DO UPDATE SET cost_vnd = $2, updated_by = $3, updated_at = now()`,
          [variantId, body.cost_vnd, ctx.user.id],
        );
      }
      // Đổi giá biến thể → đồng bộ lại giá "từ" của SP (0093, chính là bug 99đ trên thẻ).
      if (want.price_vnd !== undefined) await syncProductPrice(c, productId);
      await audit(c, 'variant.updated', { actorId: ctx.user.id, ip: ctx.ip, metadata: withChanged({ productId, variantId }, diffChanged(cur.rows[0], want)) });
      return { code: 200 };
    });
    if (out.code === 400) return send(res, 400, { error: 'giá gạch phải lớn hơn giá bán' });
    if (out.code === 404) return send(res, 404, { error: 'không tìm thấy biến thể' });
    return send(res, 200, { ok: true });
  } catch (err) {
    if (err.code === '23505') return send(res, 409, { error: conflictMessage(err) });
    throw err;
  }
}

async function deleteVariant(res, ctx, _body, params) {
  const productId = params[1];
  const variantId = params[2];
  try {
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
      await syncProductPrice(c, productId); // xoá biến thể rẻ nhất → giá "từ" phải nhích lên (0093)
      await audit(c, 'variant.deleted', { actorId: ctx.user.id, ip: ctx.ip, metadata: { productId, variantId } });
      return { code: 200 };
    });
    if (out.code === 404) return send(res, 404, { error: 'không tìm thấy biến thể' });
    if (out.code === 409) return send(res, 409, { error: 'không thể xoá biến thể cuối cùng' });
    return send(res, 200, { ok: true });
  } catch (err) {
    // inventory_ledger / order_lines / cart_items FK RESTRICT tới variants: biến thể
    // đã có lịch sử thì không xoá được — trước đây 23503 lọt ra ngoài thành 500
    // "lỗi hệ thống". Trả 409 kèm hướng xử lý thay vì để seller tưởng hệ thống hỏng.
    if (err.code === '23503') {
      const why = err.table === 'order_lines' ? 'đơn hàng' : err.table === 'cart_items' ? 'giỏ hàng của khách' : 'lịch sử kho';
      return send(res, 409, { error: `biến thể đã có ${why} — lưu trữ sản phẩm thay vì xoá` });
    }
    throw err;
  }
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
    // LOẠI biến thể ĐANG GIỮ CHỖ cho đơn còn sống (reserved > 0). Hai lý do, cùng một gốc:
    //  a) TỒN SỐNG LẠI. Nhánh tái dùng hạ `on_hand = reserved` (phần bán được về 0, vẫn giữ
    //     chỗ — đúng khi đọc riêng). Nhưng đường nhả chỗ lúc huỷ/hết hạn CHỈ hạ `reserved`,
    //     không đụng `on_hand` → available bật lại thành số cũ. Tổ hợp mới tự nhiên có hàng
    //     bán được bằng đúng số của tổ hợp CŨ → oversell. Dựng lại được ở a11: nhập 10 màu
    //     Đỏ, khách đặt 3, đổi trục hai lần → "Cotton" tự có 3 cái bán được.
    //  b) ĐƠN ĐANG CHỜ BỊ ĐỔI RUỘT. order_lines trỏ theo variant_id; tái dùng chính id đó
    //     cho tổ hợp khác nghĩa là kiện hàng khách đang đợi âm thầm thành mặt hàng khác.
    // Tạo biến thể MỚI thay vì tái dùng là rẻ (một dòng) và không có mặt trái nào.
    //
    // CÙNG LÝ LẼ (b) cho MỌI CHỨNG TỪ ĐANG CHỜ khác, không riêng đơn hàng:
    //  · PHIẾU NHẬP draft/ordered — receive() cộng tồn + ghi giá vốn bình quân THEO variant_id
    //    và KHÔNG kiểm lại danh tính (purchasing.js:291-321). Phiếu nhập KHÔNG ghi `reserved`
    //    nên mệnh đề reserved>0 ở trên KHÔNG che nó. Hậu quả: 50 cái "Đỏ / M" đã đặt NCC về
    //    kho thành "Đỏ / XL", giá vốn cũng chạy theo — mà màn xác nhận nhận hàng vẫn in tên
    //    CŨ (title_snapshot) nên người bán không thấy gì bất thường.
    //  · KIỂM KÊ đang đếm — stocktake_lines cũng trỏ theo variant_id, chốt phiên sẽ điều chỉnh
    //    tồn của mặt hàng đã bị đổi ruột.
    // KHÔNG vá bằng cách cho receive() so title_snapshot: snapshot là tên HIỂN THỊ, không phải
    // danh tính. Shop đổi tên sản phẩm là việc hợp lệ và hay xảy ra → so tên sẽ chặn oan mọi
    // phiếu đang chờ, tức chặn nhận hàng đã về. Chặn ở GỐC (không tái dùng) mới đúng.
    const pool = (await c.query(
      `SELECT id FROM variants v WHERE v.product_id = $1
         AND NOT EXISTS (SELECT 1 FROM variant_option_values x WHERE x.variant_id = v.id)
         AND NOT EXISTS (SELECT 1 FROM inventory_levels il WHERE il.variant_id = v.id AND il.reserved > 0)
         AND NOT EXISTS (SELECT 1 FROM purchase_order_lines pl JOIN purchase_orders po ON po.id = pl.po_id
                          WHERE pl.variant_id = v.id AND po.status IN ('draft', 'ordered'))
         AND NOT EXISTS (SELECT 1 FROM stocktake_lines sl JOIN stocktakes st ON st.id = sl.stocktake_id
                          WHERE sl.variant_id = v.id AND st.status = 'counting')
        ORDER BY position`, [productId])).rows.map((r) => r.id);
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
        // weight_gram cùng lớp bug: reset NULL, không kế thừa cân cũ → tính sai phí ship.
        // compare_at_vnd cùng lớp bug: reset NULL, không kế thừa giá gạch cũ → badge % sai.
        // cost_vnd (0081) cùng lớp bug: XOÁ dòng variant_costs — tổ hợp mới không kế thừa
        // giá vốn của biến thể cũ → báo cáo lãi không bịa COGS sai hàng.
        variantId = pool.shift();
        await c.query(`UPDATE variants SET title = $2, position = $3, price_vnd = $4, weight_gram = NULL, compare_at_vnd = NULL WHERE id = $1`, [variantId, title, ci, basePrice]);
        await c.query(`DELETE FROM variant_costs WHERE variant_id = $1`, [variantId]);
        // Tồn về 0: tổ hợp MỚI chưa có hàng nào. Pool đã loại biến thể còn giữ chỗ (xem (2))
        // nên reserved ở đây luôn 0 — vẫn viết `on_hand = reserved` để CHECK reserved<=on_hand
        // không bao giờ vỡ dù pool có đổi luật sau này.
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
    // Ma trận đổi tập biến thể (tạo mới/reset giá pool-reuse) → đồng bộ giá "từ" (0093).
    await syncProductPrice(c, productId);
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
      `SELECT id, slug, name, position, parent_id, image_key FROM categories WHERE deleted_at IS NULL ORDER BY position, name`,
    );
    return r.rows;
  });
  return send(res, 200, { categories: rows });
}

async function createCategory(res, ctx, body) {
  const slug = String(body.slug ?? '').toLowerCase().trim();
  const name = String(body.name ?? '').trim();
  const position = isInt(body.position) ? body.position : 0;
  const parentId = normParentId(body.parent_id);
  if (parentId === false) return send(res, 400, { error: 'danh mục cha không hợp lệ' });
  if (!validSlug(slug)) return send(res, 400, { error: 'slug không hợp lệ' });
  if (name.length < 1 || name.length > 200) return send(res, 400, { error: 'tên danh mục không hợp lệ' });
  try {
    const out = await withTenant(ctx.shopId, async (c) => {
      // Cha (nếu có) phải tồn tại + là CẤP-1 (parent_id IS NULL) → giữ cây tối đa 2 tầng.
      if (parentId) {
        const pr = await c.query(`SELECT parent_id FROM categories WHERE id = $1 AND deleted_at IS NULL`, [parentId]);
        if (!pr.rows.length) return { code: 400, error: 'danh mục cha không tồn tại' };
        if (pr.rows[0].parent_id != null) return { code: 400, error: 'chỉ hỗ trợ 2 cấp: danh mục cha phải ở cấp trên cùng' };
      }
      const r = await c.query(
        `INSERT INTO categories (shop_id, slug, name, position, parent_id) VALUES (current_shop_id(), $1, $2, $3, $4) RETURNING id`,
        [slug, name, position, parentId],
      );
      await audit(c, 'category.created', { actorId: ctx.user.id, ip: ctx.ip, metadata: { slug, parentId } });
      return { code: 201, id: r.rows[0].id };
    });
    if (out.code === 400) return send(res, 400, { error: out.error });
    return send(res, 201, { id: out.id, slug, name });
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
  // parent_id: chỉ đụng khi field có mặt (kể cả '' để GỠ cha về cấp-1).
  let parentId, hasParent = false;
  if (body.parent_id !== undefined) {
    parentId = normParentId(body.parent_id);
    if (parentId === false) return send(res, 400, { error: 'danh mục cha không hợp lệ' });
    hasParent = true;
  }
  if (!sets.length && !hasParent) return send(res, 400, { error: 'không có gì để cập nhật' });
  const out = await withTenant(ctx.shopId, async (c) => {
    if (hasParent && parentId) {
      if (parentId === catId) return { code: 400, error: 'danh mục không thể là cha của chính nó' };
      const pr = await c.query(`SELECT parent_id FROM categories WHERE id = $1 AND deleted_at IS NULL`, [parentId]);
      if (!pr.rows.length) return { code: 400, error: 'danh mục cha không tồn tại' };
      if (pr.rows[0].parent_id != null) return { code: 400, error: 'chỉ hỗ trợ 2 cấp: danh mục cha phải ở cấp trên cùng' };
      // Danh mục ĐANG có con thì không thể tự làm con (sẽ thành 3 cấp).
      const kids = await c.query(`SELECT 1 FROM categories WHERE parent_id = $1 AND deleted_at IS NULL LIMIT 1`, [catId]);
      if (kids.rows.length) return { code: 400, error: 'danh mục này đang có danh mục con — không thể đặt làm cấp con' };
    }
    if (hasParent) { args.push(parentId); sets.push(`parent_id = $${args.length}`); }
    args.push(catId);
    const r = await c.query(`UPDATE categories SET ${sets.join(', ')} WHERE id = $${args.length} AND deleted_at IS NULL`, args);
    if (r.rowCount === 0) return { code: 404 };
    await audit(c, 'category.updated', { actorId: ctx.user.id, ip: ctx.ip, metadata: { catId } });
    return { code: 200 };
  });
  if (out.code === 400) return send(res, 400, { error: out.error });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy danh mục' });
  return send(res, 200, { ok: true });
}

async function deleteCategory(res, ctx, _body, params) {
  const catId = params[1];
  const out = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(`UPDATE categories SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [catId]);
    if (r.rowCount === 0) return { code: 404 };
    await c.query(`DELETE FROM product_categories WHERE category_id = $1`, [catId]); // gỡ gán (giữ sản phẩm)
    // Xoá là SOFT-delete (giữ hàng) → FK ON DELETE SET NULL KHÔNG bắn. Tự nhấc danh mục con
    // lên cấp-1 để không còn trỏ vào cha đã ẩn (tránh con "mồ côi" treo parent_id chết).
    await c.query(`UPDATE categories SET parent_id = NULL WHERE parent_id = $1`, [catId]);
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
// Bỏ dấu tiếng Việt → slug a-z0-9-. (Chỉ tạo khi cột slug trống/không hợp lệ.)
export function slugify(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '')
    .slice(0, 58);
}
// ── routes (perm gác ở router server.js) ─────────────────────────────────────
export const CATALOG_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/products$`), perm: 'catalog.read', fn: (res, ctx, b, p, q) => listProducts(res, ctx, b, p, q) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/products$`), perm: 'catalog.write', fn: (res, ctx, b) => createProduct(res, ctx, b) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/products/${UUID}$`), perm: 'catalog.read', fn: (res, ctx, b, p) => getProduct(res, ctx, b, p) },
  { m: 'PATCH', re: new RegExp(`^/shops/${UUID}/products/${UUID}$`), perm: 'catalog.write', fn: (res, ctx, b, p) => updateProduct(res, ctx, b, p) },
  // Bulk PHẢI đứng TRƯỚC route /products/:uuid/... — thực ra UUID regex chặt nên không va,
  // nhưng giữ thứ tự này cho rõ ý và an toàn nếu sau này regex nới.
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/products/bulk/status$`), perm: 'catalog.write', fn: (res, ctx, b) => bulkStatus(res, ctx, b) },
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
