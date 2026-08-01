/**
 * Tra hàng cho phần mềm ngoài / bot (0122) — đọc dưới CÙNG khoá kết nối của /ingest/orders.
 *
 * Vì sao phải có: bot nói chuyện với khách chỉ biết "áo trắng size L", còn /ingest/orders
 * đòi `variant_id` là UUID nội bộ. Thiếu cái cầu này thì không tích hợp nào chốt đơn tự
 * động được — đó là lỗ hổng thật của chặng 1, phát hiện khi thiết kế bot.
 *
 * CHỈ trả thứ storefront vốn đã công khai cho mọi người qua Internet: tên, ảnh, giá bán,
 * còn-hàng-hay-không. KHÔNG giá vốn, KHÔNG PII khách, KHÔNG doanh thu. Nên khoá scope
 * 'orders.ingest' đọc được chỗ này KHÔNG nới thêm quyền gì trên thực tế.
 *
 * GIÁ trả về ĐÃ tính flash sale (promo_effective) — đúng bằng giá mà createManualOrder sẽ
 * tính cho đơn qua khoá kết nối. Hai chỗ lệch nhau nghĩa là bot báo một đằng thu một nẻo.
 */
import { send } from './http.js';
import { withTenant } from './db.js';

const MEDIA_PUBLIC_BASE = process.env.MEDIA_PUBLIC_BASE ?? '/media-public';
const imgUrl = (k) => (k ? `${MEDIA_PUBLIC_BASE}/${k}` : null);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Biến thể mồ côi (thiếu giá trị cho một trục) KHÔNG bán được. Bản sao Y HỆT
// catalog.js:28 / orders.js:28 / purchasing.js:29 — mỗi module tự chứa theo lệ của repo
// (không import chéo), nhưng phải là CÙNG một biểu thức: lệch nhau nghĩa là bot chào bán
// thứ mà checkout từ chối. YÊU CẦU: query bao ngoài đặt alias biến thể đúng tên `v`.
const NOT_ORPHAN = `NOT EXISTS (
  SELECT 1 FROM product_options po WHERE po.product_id = v.product_id
    AND NOT EXISTS (SELECT 1 FROM variant_option_values vov
                     WHERE vov.variant_id = v.id AND vov.option_id = po.id))`;

/**
 * GET /ingest/catalog?cat=&q=&limit=
 * Danh mục + sản phẩm đang bán. Bot dùng để dựng băng chuyền chọn hàng.
 */
async function listCatalog(res, shopId, query) {
  const limit = Math.min(Math.max(parseInt(query.get('limit') ?? '10', 10) || 10, 1), 30);
  const cat = (query.get('cat') ?? '').trim();
  const q = (query.get('q') ?? '').trim().slice(0, 60);
  const out = await withTenant(shopId, async (c) => {
    const cats = (await c.query(
      `SELECT id, slug, name FROM categories
        WHERE parent_id IS NULL AND deleted_at IS NULL ORDER BY position, name LIMIT 30`,
    )).rows;
    const args = [];
    let where = `p.status = 'active' AND p.deleted_at IS NULL`;
    if (UUID_RE.test(cat)) {
      // Gộp danh mục CHA + con (0095) — bấm "Thịt" phải ra cả "Thịt heo", như storefront.
      args.push(cat);
      where += ` AND EXISTS (SELECT 1 FROM product_categories pc JOIN categories cc ON cc.id = pc.category_id
                              WHERE pc.product_id = p.id AND cc.deleted_at IS NULL
                                AND (cc.id = $${args.length} OR cc.parent_id = $${args.length}))`;
    }
    if (q) {
      // Tìm KHÔNG DẤU (0048): khách gõ "ao thun" phải ra "Áo thun".
      args.push('%' + q.replace(/[%_\\]/g, '\\$&') + '%');
      where += ` AND vn_unaccent(p.title) LIKE vn_unaccent($${args.length})`;
    }
    const products = (await c.query(
      `SELECT p.id, p.slug, p.title, p.price_vnd,
              pe.price_vnd AS sale_price_vnd,
              (SELECT m.public_key FROM media m WHERE m.product_id = p.id ORDER BY m.position, m.created_at LIMIT 1) AS image_key,
              (SELECT count(*)::int FROM variants v WHERE v.product_id = p.id AND ${NOT_ORPHAN}) AS variant_count,
              (SELECT v.id FROM variants v WHERE v.product_id = p.id AND ${NOT_ORPHAN} ORDER BY v.position LIMIT 1) AS first_variant_id,
              (SELECT coalesce(sum(il.on_hand - il.reserved), 0)
                 FROM variants v LEFT JOIN inventory_levels il ON il.variant_id = v.id
                WHERE v.product_id = p.id AND ${NOT_ORPHAN}) AS available
         FROM products p
         LEFT JOIN LATERAL promo_effective(p.id, p.price_vnd, now()) pe ON true
        WHERE ${where}
        ORDER BY p.sold_count DESC NULLS LAST, p.created_at DESC
        LIMIT ${limit}`, args,
    )).rows;
    return { cats, products };
  });
  return send(res, 200, {
    categories: out.cats,
    products: out.products.map((p) => ({
      id: p.id, slug: p.slug, title: p.title,
      price_vnd: p.sale_price_vnd != null ? Number(p.sale_price_vnd) : Number(p.price_vnd),
      ...(p.sale_price_vnd != null ? { orig_price_vnd: Number(p.price_vnd) } : {}),
      image: imgUrl(p.image_key),
      available: Number(p.available),
      // Bot cần biết có phải hỏi thêm một bước không. SP đúng 1 biến thể → [Mua ngay] luôn,
      // bớt được một chạm — đó là cả điểm của thiết kế "ít thao tác".
      needs_choice: Number(p.variant_count) > 1,
      default_variant_id: Number(p.variant_count) === 1 ? p.first_variant_id : null,
    })),
  });
}

/** GET /ingest/catalog/products/:id — biến thể + tồn, để bot dựng nút chọn size/màu. */
async function getCatalogProduct(res, shopId, productId) {
  const out = await withTenant(shopId, async (c) => {
    const p = (await c.query(
      `SELECT p.id, p.slug, p.title, p.description,
              (SELECT m.public_key FROM media m WHERE m.product_id = p.id ORDER BY m.position, m.created_at LIMIT 1) AS image_key
         FROM products p
        WHERE p.id = $1 AND p.status = 'active' AND p.deleted_at IS NULL`, [productId],
    )).rows[0];
    if (!p) return null;
    const variants = (await c.query(
      `SELECT v.id, v.title, v.sku, v.price_vnd, pe.price_vnd AS sale_price_vnd,
              coalesce(il.on_hand - il.reserved, 0)::int AS available
         FROM variants v
         LEFT JOIN inventory_levels il ON il.variant_id = v.id
         LEFT JOIN LATERAL promo_effective(v.product_id, v.price_vnd, now()) pe ON true
        WHERE v.product_id = $1 AND ${NOT_ORPHAN}
        ORDER BY v.position, v.title NULLS FIRST`, [productId],
    )).rows;
    return { p, variants };
  });
  if (!out) return send(res, 404, { error: 'không tìm thấy sản phẩm' });
  return send(res, 200, {
    id: out.p.id, slug: out.p.slug, title: out.p.title,
    description: out.p.description, image: imgUrl(out.p.image_key),
    variants: out.variants.map((v) => ({
      id: v.id, title: v.title, sku: v.sku,
      price_vnd: v.sale_price_vnd != null ? Number(v.sale_price_vnd) : Number(v.price_vnd),
      ...(v.sale_price_vnd != null ? { orig_price_vnd: Number(v.price_vnd) } : {}),
      available: Number(v.available),
    })),
  });
}

/** Điều hướng các route ĐỌC của /ingest. Trả false nếu không khớp → nơi gọi trả 404. */
export async function routeIngestCatalog(res, shopId, pathname, query) {
  if (pathname === '/ingest/catalog') { await listCatalog(res, shopId, query); return true; }
  const m = /^\/ingest\/catalog\/products\/([0-9a-f-]{36})$/.exec(pathname);
  if (m) { await getCatalogProduct(res, shopId, m[1]); return true; }
  return false;
}
