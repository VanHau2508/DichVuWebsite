/**
 * ĐƠN CHỜ TẠO (0186) — đơn phần mềm ngoài đẩy vào lúc cửa hàng bị TẠM NGƯNG.
 *
 * Bối cảnh đo được (07/09): cửa Bearer `/ingest/*` không biết cửa hàng đã đóng. Storefront
 * trả 503 khi `suspended` và 404 khi `terminated`, còn `POST /ingest/orders` vẫn 201 và vẫn
 * GIỮ CHỖ TỒN ở cả ba trạng thái — nên bot Facebook của một shop đã chấm dứt hợp đồng vẫn
 * chào hàng và vẫn chốt đơn. Chi tiết + vì sao cổng cũ không thấy: 0186 và CLAUDE.md §9.3b.
 *
 * Chủ dự án chốt: `terminated` từ chối hẳn; `suspended` VẪN NHẬN nhưng KHÔNG giữ chỗ tồn.
 *
 * ĐIỂM DỄ LÀM SAI NHẤT, chép lại vì nó là lý do có cả một bảng riêng: một đơn KHÔNG giữ chỗ
 * mà nằm trong `orders` sẽ, lúc được gửi hay bị huỷ, NHẢ CHỖ CỦA ĐƠN KHÁC — `consumeAndShip`
 * và đường huỷ đều `reserved -= qty` với kẹp `GREATEST(0, …)`, mà kẹp đó chỉ chặn số âm chứ
 * không chặn trừ nhầm người. Nên đơn nhận trong lúc tạm ngưng KHÔNG phải một dòng `orders`.
 *
 * Nó thành đơn thật khi người bán CHỐT, và chỉ chốt được khi cửa hàng đã hoạt động lại —
 * đi qua đúng `createOrderCore`, tức giá và tồn tính tại thời điểm tạo thật. Hứa lại giá của
 * hai tuần trước là hứa một con số không còn thật.
 */
import { send } from './http.js';
import { withTenant, audit } from './db.js';
import { createOrderCore } from './orders.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

// Câu trả lời cho phần mềm ngoài. Nói ĐỦ ba việc §9.2 đòi: chuyện gì xảy ra (đã nhận, CHƯA
// thành đơn) · làm gì tiếp (cửa hàng sẽ xác nhận lại) · thử lại được không (gửi lại cùng
// idempotency_key thì vẫn là một dòng). Không nói "lỗi" — không có lỗi nào ở phía họ.
const HELD_MSG = 'cửa hàng đang tạm ngưng — đơn đã được ghi nhận và chờ cửa hàng xác nhận lại, chưa trừ hàng';

/**
 * Ghi đơn vào hàng chờ thay vì tạo đơn. KHÔNG validate nội dung ở đây: validate là việc của
 * `createOrderCore` lúc chốt, và chạy nó hai lần ở hai thời điểm khác nhau là mở đúng khe
 * cho hai câu trả lời khác nhau về cùng một tệp dữ liệu. Chỉ đòi `idempotency_key` — nó là
 * khoá chống trùng, thiếu nó thì mỗi lần tích hợp gửi lại là thêm một dòng chờ.
 */
export async function holdIngestOrder(res, key, body, ip) {
  const idemKey = String(body?.idempotency_key ?? '');
  if (idemKey.length < 8 || idemKey.length > 200) return send(res, 400, { error: 'thiếu idempotency_key' });
  const row = await withTenant(key.shop_id, async (c) => {
    const ins = (await c.query(
      `INSERT INTO held_ingest_orders (shop_id, api_key_id, idempotency_key, payload, reason)
       VALUES (current_shop_id(), $1, $2, $3, 'suspended')
       ON CONFLICT (shop_id, idempotency_key) DO NOTHING
       RETURNING id, received_at`, [key.id, idemKey, body],
    )).rows[0];
    if (!ins) {
      // Gửi lại cùng khoá → trả ĐÚNG dòng cũ. Không audit lần hai: tích hợp retry là chuyện
      // thường, ghi mỗi lần retry một dòng nhật ký là làm ngập chính nhật ký cần đọc.
      return (await c.query(
        `SELECT id, received_at FROM held_ingest_orders
          WHERE shop_id = current_shop_id() AND idempotency_key = $1`, [idemKey],
      )).rows[0];
    }
    await audit(c, 'ingest_order.held', {
      actorType: 'system', actorId: null, ip,
      metadata: { held_id: ins.id, api_key_id: key.id, reason: 'suspended' },
    });
    return ins;
  });
  return send(res, 202, { held: true, held_id: row.id, received_at: row.received_at, message: HELD_MSG });
}

async function listHeldOrders(res, ctx, query) {
  const chuaChot = query?.get('resolved') !== '1';
  const rows = await withTenant(ctx.shopId, async (c) => (await c.query(
    `SELECT h.id, h.received_at, h.resolved_at, h.resolution, h.order_id, h.payload,
            k.name AS api_key_name, o.order_number
       FROM held_ingest_orders h
       LEFT JOIN shop_api_keys k ON k.shop_id = h.shop_id AND k.id = h.api_key_id
       LEFT JOIN orders o ON o.shop_id = h.shop_id AND o.id = h.order_id
      WHERE h.shop_id = current_shop_id() AND ($1::bool OR h.resolved_at IS NULL)
      ORDER BY h.received_at DESC LIMIT 200`, [!chuaChot],
  )).rows);
  return send(res, 200, {
    held: rows.map((r) => ({
      id: r.id,
      received_at: r.received_at,
      resolved_at: r.resolved_at,
      resolution: r.resolution,
      order_id: r.order_id,
      order_number: r.order_number == null ? null : Number(r.order_number),
      api_key_name: r.api_key_name,
      // Chỉ trả phần người bán CẦN để quyết định — không dội nguyên payload thô ra giao
      // diện (§9.2: không đưa payload webhook thô ra ngoài).
      customer_name: r.payload?.customer?.name ?? null,
      customer_phone: r.payload?.customer?.phone ?? null,
      source: r.payload?.source ?? null,
      line_count: Array.isArray(r.payload?.lines) ? r.payload.lines.length : 0,
      qty_total: Array.isArray(r.payload?.lines) ? r.payload.lines.reduce((s, l) => s + (Number(l?.qty) || 0), 0) : 0,
    })),
  });
}

/**
 * CHỐT một đơn chờ → đơn thật.
 *
 * Hai chốt, cả hai đều là điều kiện của quyết định (b) chứ không phải trang trí:
 *  ① cửa hàng phải ĐANG HOẠT ĐỘNG. Chốt trong lúc còn tạm ngưng là giữ chỗ tồn cho một shop
 *    đang bị khoá — đúng thứ quyết định này nói là không.
 *  ② dòng chờ phải CHƯA giải quyết, và khoá dòng bằng `FOR UPDATE` trước khi tạo đơn: hai
 *    tab cùng bấm "Tạo đơn" mà không khoá thì `createOrderCore` chạy hai lần. Idempotency
 *    của chính nó sẽ đỡ (cùng `idempotency_key` → trả lại đơn cũ), nhưng dựa vào lớp đỡ
 *    thay vì khoá là để dành một cách hỏng cho lần sau ai đó đổi khoá.
 */
async function acceptHeldOrder(res, ctx, heldId) {
  const out = await withTenant(ctx.shopId, async (c) => {
    const live = (await c.query(
      `SELECT status, deleted_at FROM shops WHERE id = current_shop_id() FOR SHARE`)).rows[0];
    if (!live || live.status !== 'active' || live.deleted_at) {
      return { code: 409, body: { error: 'cửa hàng chưa hoạt động lại — đơn chờ chỉ tạo được khi cửa hàng đang bán, vì tạo đơn là giữ chỗ hàng' } };
    }
    const row = (await c.query(
      `SELECT id, payload, api_key_id, resolved_at FROM held_ingest_orders
        WHERE id = $1 AND shop_id = current_shop_id() FOR UPDATE`, [heldId])).rows[0];
    if (!row) return { code: 404, body: { error: 'không tìm thấy đơn chờ' } };
    if (row.resolved_at) return { code: 409, body: { error: 'đơn chờ này đã được xử lý' } };
    // Đo trên f663bf9: nhả khoá trước createOrderCore cho phép accept=201, drop=200,
    // dòng chờ=dropped dù đơn thật đã giữ tồn. Dùng cùng client để cả chuỗi cùng commit
    // hoặc rollback; khoá shop cũng giữ tới cuối để tạm ngưng không chen giữa lượt chốt.
    const created = await createOrderCore({ ...ctx, apiKeyId: row.api_key_id }, row.payload, c);
    if (created.code !== 201) return created;
    await c.query(
      `UPDATE held_ingest_orders SET resolved_at = now(), resolution = 'accepted', order_id = $2
        WHERE id = $1 AND shop_id = current_shop_id() AND resolved_at IS NULL`, [heldId, created.body.id]);
    await audit(c, 'ingest_order.accepted', {
      actorId: ctx.user?.id ?? null, ip: ctx.ip,
      metadata: { held_id: heldId, order_id: created.body.id, order_number: created.body.order_number },
    });
    return created;
  });
  return send(res, out.code, out.body);
}

// BỎ một đơn chờ: khách đã mua chỗ khác, hoặc hàng đã hết. KHÔNG xoá dòng — người bán cần
// đọc lại được đơn nào đã bỏ khi khách gọi hỏi ("shop có nhận đơn của em không?").
async function dropHeldOrder(res, ctx, heldId) {
  const out = await withTenant(ctx.shopId, async (c) => {
    const r = await c.query(
      `UPDATE held_ingest_orders SET resolved_at = now(), resolution = 'dropped'
        WHERE id = $1 AND shop_id = current_shop_id() AND resolved_at IS NULL RETURNING id`, [heldId]);
    if (!r.rowCount) return { code: 404, body: { error: 'không tìm thấy đơn chờ (hoặc đã xử lý)' } };
    await audit(c, 'ingest_order.dropped', { actorId: ctx.user?.id ?? null, ip: ctx.ip, metadata: { held_id: heldId } });
    return { code: 200, body: { ok: true } };
  });
  return send(res, out.code, out.body);
}

export const HELD_ORDER_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/held-orders$`), perm: 'orders.read', fn: (res, ctx, b, p, q) => listHeldOrders(res, ctx, q) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/held-orders/${UUID}/accept$`), perm: 'orders.write', fn: (res, ctx, b, p) => acceptHeldOrder(res, ctx, p[1]) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/held-orders/${UUID}/drop$`), perm: 'orders.write', fn: (res, ctx, b, p) => dropHeldOrder(res, ctx, p[1]) },
];
