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
import { withTenant, audit } from './db.js';
import { shopShipFee, cancelOrderTx } from './orders.js';

const MEDIA_PUBLIC_BASE = process.env.MEDIA_PUBLIC_BASE ?? '/media-public';
const imgUrl = (k) => (k ? `${MEDIA_PUBLIC_BASE}/${k}` : null);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ẢNH HIỆN ĐƯỢC — bản chép có chủ ý của điều kiện mà POLICY `store_media`/`checkout_media`
// (0011/0024) đã cưỡng chế cho storefront và checkout ở mức DÒNG.
//
// VÌ SAO PHẢI VIẾT LẠI Ở ĐÂY. Route này chạy dưới `app_rw`, mà policy `tenant_isolation` của
// vai đó chỉ lọc `shop_id` — không lọc `status`. Nghĩa là điều kiện storefront được TẶNG
// KHÔNG thì bot phải tự viết. Đo được ngày 06/09: sản phẩm có ảnh vị-trí-0 'failed' và
// vị-trí-1 'ready' cho storefront một tấm ảnh, còn `/ingest/catalog` trả `image=NULL` —
// `LIMIT 1` nhặt trúng dòng hỏng. Khách xem web thấy ảnh, khách chat với bot thấy ô trống,
// và đó đúng là hình dạng mà bộ nhập từ sàn sinh ra nhiều nhất (CDN sàn cũ chặn hotlink).
// Chú thích đầu tệp đã tự khai "CHỈ trả thứ storefront vốn đã công khai" — đây là câu đó
// viết thành SQL.
const MEDIA_HIEN_SQL = `m.status = 'ready' AND m.deleted_at IS NULL`;

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
              (SELECT m.public_key FROM media m WHERE m.product_id = p.id AND ${MEDIA_HIEN_SQL} ORDER BY m.position, m.created_at LIMIT 1) AS image_key,
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
              (SELECT m.public_key FROM media m WHERE m.product_id = p.id AND ${MEDIA_HIEN_SQL} ORDER BY m.position, m.created_at LIMIT 1) AS image_key
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

/**
 * GET /ingest/shipping-quote?subtotal=<vnd>&items=<vid>:<qty>,<vid>:<qty>
 *
 * Bot phải BÁO TRƯỚC tổng tiền trong tóm tắt, mà phí ship lại tính lúc tạo đơn. Endpoint
 * này gọi ĐÚNG hàm mà createManualOrder gọi (shopShipFee), nên con số bot hứa và con số
 * hệ thống thu là MỘT. Tự tính lại ở phía bot là tự chuốc lấy sai lệch.
 *
 * `items` là TUỲ CHỌN và chỉ dùng để tính PHỤ PHÍ CÂN. Thiếu nó thì hàm rơi về phí phẳng —
 * đúng như hành vi cũ, nên bot bản cũ không vỡ; nhưng bot bản mới gửi giỏ hàng thì báo giá
 * và số thu vẫn là MỘT vì cả hai đi qua cùng một hàm với cùng dữ liệu.
 */
function parseQuoteItems(raw) {
  return String(raw ?? '').split(',').map((s) => {
    const [vid, q] = s.split(':');
    const qty = Number(q);
    return UUID_RE.test(String(vid ?? '')) && Number.isInteger(qty) && qty >= 1 && qty <= 1000
      ? { variant_id: vid, qty } : null;
  }).filter(Boolean).slice(0, 50);
}
async function shippingQuote(res, shopId, query) {
  const subtotal = Math.max(0, Math.min(Number(query.get('subtotal') ?? 0) || 0, 100_000_000_000));
  const items = parseQuoteItems(query.get('items'));
  const fee = await withTenant(shopId, (c) => shopShipFee(c, subtotal, items));
  return send(res, 200, { subtotal_vnd: subtotal, shipping_vnd: Number(fee), total_vnd: subtotal + Number(fee) });
}

/**
 * GET /ingest/orders/lookup?psid=<psid>&limit=5 — đơn GẦN ĐÂY của đúng người chat này.
 *
 * "Đơn tôi tới đâu rồi?" là câu shop phải trả lời nhiều nhất. Để bot tự trả là bớt việc
 * thật cho nhân viên, và khách không phải chờ.
 *
 * LỌC THEO PSID, không phải trả cả sổ đơn: khoá kết nối vốn đọc được mọi đơn của shop, nên
 * nếu ở đây lỡ trả nhầm người thì bot sẽ đưa SĐT/địa chỉ khách A cho khách B. Khớp CUỐI
 * chuỗi source_ref (`…?psid=<psid>`) và escape ký tự đại diện của LIKE.
 */
async function lookupOrders(res, shopId, query) {
  const psid = String(query.get('psid') ?? '').trim().slice(0, 80);
  if (!psid) return send(res, 400, { error: 'thiếu psid' });
  const limit = Math.min(Math.max(parseInt(query.get('limit') ?? '5', 10) || 5, 1), 10);
  const like = '%psid=' + psid.replace(/[%_\\]/g, '\\$&');
  const rows = await withTenant(shopId, async (c) =>
    (await c.query(
      `SELECT o.order_number, o.status, o.payment_status, o.total_vnd, o.created_at,
              -- BỎ vận đơn đã huỷ: đây là câu trả lời bot nhắn thẳng cho khách khi họ hỏi
              -- "đơn tôi tới đâu rồi". Mã của vận đơn đã huỷ tra trên trang hãng ra số 0 —
              -- khách tưởng shop lừa rồi gọi điện, tức là còn tệ hơn trả lời "chưa có mã".
              (SELECT s.tracking_number FROM shipments s
                WHERE s.order_id = o.id AND s.tracking_number IS NOT NULL AND s.status <> 'cancelled'
                ORDER BY s.created_at DESC LIMIT 1) AS tracking_number
         FROM orders o
        WHERE o.source = 'facebook' AND o.source_ref LIKE $1
        ORDER BY o.order_number DESC LIMIT ${limit}`, [like],
    )).rows);
  return send(res, 200, { orders: rows.map((r) => ({ ...r, total_vnd: Number(r.total_vnd) })) });
}

/** Điều hướng các route ĐỌC của /ingest. Trả false nếu không khớp → nơi gọi trả 404. */
export async function routeIngestCatalog(res, shopId, pathname, query) {
  if (pathname === '/ingest/catalog') { await listCatalog(res, shopId, query); return true; }
  if (pathname === '/ingest/shipping-quote') { await shippingQuote(res, shopId, query); return true; }
  if (pathname === '/ingest/orders/lookup') { await lookupOrders(res, shopId, query); return true; }
  const m = /^\/ingest\/catalog\/products\/([0-9a-f-]{36})$/.exec(pathname);
  if (m) { await getCatalogProduct(res, shopId, m[1]); return true; }
  return false;
}

/**
 * GHI qua /ingest — hai việc khách tự làm được trong chat (docs/48 "còn nợ").
 *
 * HÀNG RÀO CHUNG, quan trọng hơn mọi thứ khác ở đây: khoá kết nối đọc/ghi được MỌI đơn của
 * shop. Khách trong chat chỉ được đụng ĐƠN CỦA CHÍNH HỌ. Nên mọi hàm dưới đây tra đơn bằng
 * (order_number + source_ref khớp psid), KHÔNG bằng order_number đơn thuần — thiếu vế psid
 * thì bất kỳ ai đoán được số đơn cũng huỷ được đơn người khác.
 */
const psidWhere = (psid) => '%psid=' + String(psid).replace(/[%_\\]/g, '\\$&');

// POST /ingest/orders/cancel — khách tự huỷ đơn trong chat.
// Dùng CHUNG cancelOrderTx với đường admin: nhả reserve, hoàn lượt coupon, phát sự kiện báo
// khách. Không viết lại — hai bản của chuỗi đó sẽ lệch, và lệch ở đây là tồn kho sai.
async function cancelByPsid(res, shopId, body, ip) {
  const psid = String(body?.psid ?? '').trim().slice(0, 80);
  const num = parseInt(body?.order_number, 10);
  if (!psid || !Number.isInteger(num)) return send(res, 400, { error: 'thiếu psid hoặc order_number' });
  const out = await withTenant(shopId, async (c) => {
    // Khoá dòng NGAY khi tra: giữa lúc kiểm và lúc huỷ, nhân viên có thể đang chuyển đơn
    // sang 'shipped'. Không khoá thì khách huỷ được đơn vừa lên xe.
    const o = (await c.query(
      `SELECT id FROM orders
        WHERE order_number = $1 AND source = 'facebook' AND source_ref LIKE $2 FOR UPDATE`,
      [num, psidWhere(psid)])).rows[0];
    if (!o) return { code: 404 };
    // Khách tự huỷ KHÔNG cần nêu lý do khi đơn chưa trả tiền; đơn ĐÃ trả thì cancelOrderTx
    // bắt buộc có lý do → đặt sẵn lý do nói đúng sự thật ai là người huỷ.
    return cancelOrderTx(c, o.id, { reason: 'Khách tự huỷ trong chat Messenger', actorId: null, ip, source: 'messenger' });
  });
  if (out.code === 404) return send(res, 404, { error: 'không tìm thấy đơn của bạn' });
  if (out.code === 409) return send(res, 409, { error: `đơn đang ở trạng thái "${out.cur}" nên không huỷ được` });
  if (out.code === 400) return send(res, 400, { error: out.msg });
  return send(res, 200, { ok: true, status: 'cancelled' });
}

// POST /ingest/orders/email — khách đưa email SAU khi đã đặt xong (docs/48).
// Cố ý KHÔNG hỏi trước lúc đặt: thêm một ô bắt gõ giữa luồng mua là thêm một chỗ để khách
// bỏ ngang. Hỏi sau thì đơn đã nằm trong sổ rồi, khách không đưa cũng không mất gì.
async function setEmailByPsid(res, shopId, body) {
  const psid = String(body?.psid ?? '').trim().slice(0, 80);
  const num = parseInt(body?.order_number, 10);
  const email = String(body?.email ?? '').trim().toLowerCase().slice(0, 254);
  if (!psid || !Number.isInteger(num)) return send(res, 400, { error: 'thiếu psid hoặc order_number' });
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: 'email không hợp lệ' });
  const out = await withTenant(shopId, async (c) => {
    // CHỈ điền khi đang trống. Đơn đã có email (khách khai lúc khác) thì không cho ghi đè:
    // đổi email của một đơn đã có nghĩa là chuyển hoá đơn sang hộp thư khác — nếu ai đó
    // đoán được số đơn thì đó thành đường lấy thông tin. Đã chặn bằng psid, nhưng hai lớp.
    const r = await c.query(
      `UPDATE orders SET customer_email = $3
        WHERE order_number = $1 AND source = 'facebook' AND source_ref LIKE $2
          AND customer_email IS NULL
        RETURNING id`, [num, psidWhere(psid), email]);
    if (r.rowCount) await audit(c, 'order.email_added', { actorId: null, ip: null, metadata: { order_number: num, source: 'messenger' } });
    return r.rowCount;
  });
  if (!out) return send(res, 404, { error: 'không tìm thấy đơn của bạn, hoặc đơn đã có email' });
  return send(res, 200, { ok: true });
}

/** Điều hướng route GHI của /ingest (POST). Trả false nếu không khớp. */
export async function routeIngestWrite(res, shopId, pathname, body, ip) {
  if (pathname === '/ingest/orders/cancel') { await cancelByPsid(res, shopId, body, ip); return true; }
  if (pathname === '/ingest/orders/email') { await setEmailByPsid(res, shopId, body); return true; }
  return false;
}
