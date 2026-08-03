/**
 * Vận chuyển qua HÃNG (GHN/GHTK) — kết nối per-shop + tạo vận đơn.
 *
 * Kết nối: shop dán token API của CHÍNH HỌ (per-shop, như SePay). Token lưu MÃ HOÁ
 * AES-256-GCM (secretbox, khoá env SHIPPING_ENC_KEY) vì phải đọc lại để gọi API hãng.
 * Kết nối/ngắt = thao tác credential → perm shop.write + STEP-UP.
 *
 * Tạo vận đơn (POST /orders/:oid/carrier-shipment) — gọi API NGOÀI nên chống double-create
 * bằng luồng CLAIM 3 pha:
 *   (1) tx claim: khoá đơn, guard status='confirmed' + chưa có vận đơn sống → INSERT
 *       shipments status='created' (giành chỗ) → COMMIT.
 *   (2) gọi hãng NGOÀI transaction. Lỗi → xoá dòng claim, trả 502.
 *   (3) tx chốt: khoá đơn lại; vẫn 'confirmed' → consumeAndShip (tồn + shipped + outbox
 *       email, DÙNG CHUNG code với giao tay). Đơn đã đổi trạng thái giữa chừng (hiếm) →
 *       đánh dấu vận đơn 'cancelled' + báo shop huỷ trên portal hãng (không rollback được
 *       side-effect ngoài).
 */

import { send } from './http.js';
import { withTenant, audit } from './db.js';
import { seal, open } from './secretbox.js';
import { carrierCreate, carrierTest, CarrierError } from './carriers.js';
import { consumeAndShip } from './orders.js';
import { can } from './rbac.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const ENC_KEY = process.env.SHIPPING_ENC_KEY ?? '';
const KEY_OK = /^[0-9a-f]{64}$/i.test(ENC_KEY); // thiếu/sai khoá → tính năng TẮT, seller vẫn chạy
const PROVIDERS = { ghn: 'GHN (Giao Hàng Nhanh)', ghtk: 'GHTK (Giao Hàng Tiết Kiệm)' };

const trimStr = (x, max) => String(x ?? '').trim().slice(0, max);

// ── Cấu hình kết nối ──────────────────────────────────────────────────────────
async function getShipping(res, ctx) {
  if (!KEY_OK) return send(res, 200, { available: false });
  const row = await withTenant(ctx.shopId, async (c) =>
    (await c.query(`SELECT provider, token_prefix, ghn_shop_id, pickup, enabled FROM shop_shipping_config WHERE shop_id = current_shop_id()`)).rows[0] ?? null);
  // orders.read (nhân viên đơn hàng) chỉ cần biết ĐÃ KẾT NỐI + hãng + điểm lấy hàng;
  // token_prefix/ghn_shop_id chỉ trả cho vai trò quản cấu hình (shop.write).
  const base = { available: true, connected: !!row?.enabled, provider: row?.provider, pickup: row?.pickup, enabled: row?.enabled };
  if (can(ctx.role, 'shop.write')) { base.token_prefix = row?.token_prefix; base.ghn_shop_id = row?.ghn_shop_id; }
  return send(res, 200, base);
}

async function connectShipping(res, ctx, body) {
  if (!KEY_OK) return send(res, 503, { error: 'nền tảng chưa bật tích hợp vận chuyển (thiếu SHIPPING_ENC_KEY)' });
  const provider = String(body.provider ?? '');
  const token = String(body.token ?? '').trim();
  const ghnShopId = trimStr(body.ghn_shop_id, 20);
  const p = body.pickup ?? {};
  const pickup = {
    name: trimStr(p.name, 100), phone: trimStr(p.phone, 20), address: trimStr(p.address, 300),
    province: trimStr(p.province, 60), district: trimStr(p.district, 60), ward: trimStr(p.ward, 60),
  };
  if (!PROVIDERS[provider]) return send(res, 400, { error: 'hãng không được hỗ trợ (ghn/ghtk)' });
  if (token.length < 10 || token.length > 300 || /[\r\n]/.test(token)) return send(res, 400, { error: 'token không hợp lệ' });
  if (provider === 'ghn' && !/^\d{1,20}$/.test(ghnShopId)) return send(res, 400, { error: 'GHN cần ShopId (dãy số trong trang quản trị GHN)' });
  for (const f of ['name', 'phone', 'address', 'province', 'district']) {
    if (!pickup[f]) return send(res, 400, { error: `thiếu thông tin điểm lấy hàng: ${f}` });
  }
  const prefix = token.slice(0, 6);
  const out = await withTenant(ctx.shopId, async (c) => {
    // ĐỔI HÃNG = MẤT THEO DÕI vận đơn của hãng cũ, y hệt NGẮT KẾT NỐI. Bảng cấu hình có PK
    // shop_id (0044) — MỘT dòng/shop — nên UPSERT dưới đây GHI ĐÈ token cũ, và token hãng cũ
    // biến mất vĩnh viễn: không còn đường nào hỏi hãng cũ về những kiện đang trên đường.
    //
    // disconnectShipping ngay dưới đã xử đúng ca này từ lâu (đánh dấu 'orphan' + trả cảnh
    // báo để shop tự chốt giao tay). Đường ĐỔI hãng gây đúng hậu quả đó mà KHÔNG có dòng nào
    // tương ứng — nên vận đơn cũ chết ÂM THẦM: worker im lặng bỏ qua (0044 join theo
    // provider), đơn COD nằm 'shipped'/'unpaid' mãi, mà trang Vận chuyển vẫn hứa
    // "hệ thống tự theo dõi trạng thái tới khi giao xong".
    const cu = (await c.query(`SELECT provider FROM shop_shipping_config WHERE shop_id = current_shop_id()`, [])).rows[0];
    const doiHang = cu?.provider && cu.provider !== provider;
    let mocCoi = 0;
    if (doiHang) {
      mocCoi = (await c.query(
        `UPDATE shipments SET provider_status = 'orphan'
          WHERE status IN ('created','in_transit') AND provider = $1 RETURNING id`, [cu.provider])).rowCount;
    }
    await c.query(
      `INSERT INTO shop_shipping_config (shop_id, provider, token_enc, token_prefix, ghn_shop_id, pickup, enabled, updated_at)
       VALUES (current_shop_id(), $1, $2, $3, $4, $5, true, now())
       ON CONFLICT (shop_id) DO UPDATE SET provider = $1, token_enc = $2, token_prefix = $3, ghn_shop_id = $4, pickup = $5, enabled = true, updated_at = now()`,
      [provider, seal(token, ENC_KEY), prefix, provider === 'ghn' ? ghnShopId : null, JSON.stringify(pickup)],
    );
    await audit(c, 'shipping.connected', { actorId: ctx.user.id, ip: ctx.ip, metadata: { provider, ...(doiHang ? { tu_hang: cu.provider, van_don_mo_coi: mocCoi } : {}) } });
    return { doiHang, mocCoi, hangCu: cu?.provider ?? null };
  });
  return send(res, 200, {
    ok: true, provider, token_prefix: prefix, live_shipments: out.mocCoi,
    ...(out.mocCoi ? { warning: `${out.mocCoi} vận đơn ${String(out.hangCu).toUpperCase()} đang chạy sẽ KHÔNG còn được theo dõi tự động (token hãng cũ đã bị thay) — hãy tự đánh dấu "Đã giao xong" và "Đã nhận tiền" khi hàng tới.` } : {}),
  });
}

// KIỂM TRA KẾT NỐI: dùng token ĐÃ lưu, gọi API tính phí (GHTK) / danh mục (GHN) — 0đ, KHÔNG
// tạo đơn. Xác nhận token hợp lệ + tích hợp chạy thật trước khi tạo vận đơn thật đầu tiên.
async function testShipping(res, ctx) {
  if (!KEY_OK) return send(res, 503, { error: 'nền tảng chưa bật tích hợp vận chuyển' });
  const cfg = await withTenant(ctx.shopId, async (c) =>
    (await c.query(`SELECT provider, token_enc, ghn_shop_id, pickup, enabled FROM shop_shipping_config WHERE shop_id = current_shop_id()`)).rows[0]);
  if (!cfg?.enabled) return send(res, 400, { error: 'shop chưa kết nối hãng vận chuyển' });
  const p = cfg.pickup ?? {};
  if (!p.province || !p.district) return send(res, 400, { error: 'thiếu tỉnh/quận điểm lấy hàng — cập nhật lại kết nối' });
  try {
    const token = open(cfg.token_enc, ENC_KEY);
    // Mẫu: giao NỘI QUẬN (đích = chính điểm lấy hàng) → tên tỉnh/quận chắc chắn hợp lệ.
    const r = await carrierTest(cfg.provider, { token, ghnShopId: cfg.ghn_shop_id }, {
      pickup: p, toProvince: p.province, toDistrict: p.district, weightGram: 500, value: 0,
    });
    return send(res, 200, { ok: true, provider: cfg.provider, fee: r.fee });
  } catch (e) {
    if (e instanceof CarrierError) return send(res, 502, { ok: false, error: e.message });
    throw e;
  }
}

async function disconnectShipping(res, ctx) {
  // Ngắt luôn thành công (xoá credential không được chặn), nhưng vận đơn ĐANG CHẠY sẽ
  // mất theo dõi tự động → đánh dấu orphan + trả cảnh báo để shop tự đánh dấu giao tay.
  const live = await withTenant(ctx.shopId, async (c) => {
    const n = (await c.query(`UPDATE shipments SET provider_status = 'orphan'
       WHERE status IN ('created','in_transit') AND provider IS NOT NULL RETURNING id`)).rowCount;
    await c.query(`DELETE FROM shop_shipping_config WHERE shop_id = current_shop_id()`);
    await audit(c, 'shipping.disconnected', { actorId: ctx.user.id, ip: ctx.ip, metadata: { live_shipments: n } });
    return n;
  });
  return send(res, 200, {
    ok: true, live_shipments: live,
    ...(live ? { warning: `${live} vận đơn đang chạy sẽ không còn được theo dõi tự động — hãy tự đánh dấu "Đã giao xong" khi hàng tới.` } : {}),
  });
}

// ── Tạo vận đơn qua hãng ──────────────────────────────────────────────────────
async function createCarrierShipment(res, ctx, body, params) {
  if (!KEY_OK) return send(res, 503, { error: 'nền tảng chưa bật tích hợp vận chuyển' });
  const orderId = params[1];
  const toName = trimStr(body.to_name, 100), toPhone = trimStr(body.to_phone, 20);
  const toAddress = trimStr(body.to_address, 300), toProvince = trimStr(body.to_province, 60);
  const toDistrict = trimStr(body.to_district, 60), toWard = trimStr(body.to_ward, 60);
  const note = trimStr(body.note, 200);
  const weightGram = Number.isInteger(body.weight_gram) ? body.weight_gram : 500;
  if (!toName || !toPhone || !toAddress || !toProvince || !toDistrict) {
    return send(res, 400, { error: 'thiếu thông tin người nhận (tên/SĐT/địa chỉ/tỉnh/quận-huyện)' });
  }
  if (weightGram < 50 || weightGram > 50000) return send(res, 400, { error: 'khối lượng 50g–50kg' });

  // (1) CLAIM: khoá đơn + giành chỗ vận đơn trong 1 transaction. Kiểm ĐƠN trước config
  // (đơn shop khác → 404 nhờ RLS, không lộ trạng thái kết nối qua mã lỗi).
  const claim = await withTenant(ctx.shopId, async (c) => {
    const o = (await c.query(
      `SELECT id, status, order_number, customer_email, customer_name, customer_phone,
              total_vnd, payment_method, payment_status FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
    if (!o) return { code: 404 };
    const cfg = (await c.query(`SELECT provider, token_enc, ghn_shop_id, pickup, enabled FROM shop_shipping_config WHERE shop_id = current_shop_id()`)).rows[0];
    if (!cfg?.enabled) return { code: 400, error: 'shop chưa kết nối hãng vận chuyển' };
    // SPLIT (0080): tạo vận đơn hãng cho đơn 'confirmed' HOẶC 'shipped'+còn hàng (gửi tiếp
    // phần chưa gửi bằng hãng). Carrier v1 gửi TRỌN phần CÒN LẠI (không tách tuỳ ý qua hãng).
    if (!['confirmed', 'shipped'].includes(o.status)) return { code: 409, error: `không thể tạo vận đơn từ trạng thái ${o.status} (cần xác nhận đơn trước)` };
    // Claim 'created' đang KẸT (finalize_failed) → hướng dẫn đối soát vận đơn (không tạo mới đè).
    const stuck = (await c.query(`SELECT tracking_number FROM shipments WHERE order_id = $1 AND status = 'created' AND provider_status = 'finalize_failed' LIMIT 1`, [orderId])).rows[0];
    if (stuck) return { code: 409, error: `vận đơn ${stuck.tracking_number} ĐÃ tạo trên hãng nhưng chưa chốt được — kiểm tra portal hãng / đối soát vận đơn trước khi thử lại` };
    // Dòng CÒN LẠI = qty − đã gửi − đang claim('created'). Guard luỹ kế DƯỚI orders FOR UPDATE
    // (thay index 0046): claim đua thứ 2 thấy planned của claim 1 → remaining 0 → chặn.
    const ol = (await c.query(
      `SELECT ol.id, ol.variant_id, ol.qty, ol.unit_price_vnd, ol.title_snapshot, ol.shipped_qty,
              coalesce((SELECT sum(sl.qty)::int FROM shipment_lines sl JOIN shipments s ON s.id = sl.shipment_id
                         WHERE sl.order_line_id = ol.id AND s.status = 'created'), 0) AS planned
         FROM order_lines ol WHERE ol.order_id = $1`, [orderId])).rows;
    const remaining = ol.map((l) => ({ order_line_id: l.id, variant_id: l.variant_id, qty: l.qty - l.shipped_qty - l.planned, unit: Number(l.unit_price_vnd), title: l.title_snapshot }))
      .filter((x) => x.qty > 0);
    if (remaining.length === 0) return { code: 409, error: 'đơn đã gửi đủ — không còn hàng để tạo vận đơn' };
    // COD giao qua hãng KHÔNG tách trong v1: phải là đơn CHƯA gửi gì (codAmount=total_vnd đúng).
    const anyShipped = ol.some((l) => l.shipped_qty > 0 || l.planned > 0);
    if (o.payment_method === 'cod' && o.payment_status === 'unpaid' && anyShipped) {
      return { code: 409, error: 'đơn COD giao qua hãng phải gửi TRỌN một lần — đã gửi một phần rồi, không tạo vận đơn hãng thu hộ được (giao tay phần còn lại)' };
    }
    const sid = (await c.query(
      `INSERT INTO shipments (shop_id, order_id, carrier, status, provider) VALUES (current_shop_id(), $1, $2, 'created', $2) RETURNING id`,
      [orderId, cfg.provider])).rows[0].id;
    for (const s of remaining) {
      await c.query(`INSERT INTO shipment_lines (shop_id, shipment_id, order_line_id, variant_id, qty, unit_price_vnd) VALUES (current_shop_id(), $1, $2, $3, $4, $5)`, [sid, s.order_line_id, s.variant_id, s.qty, s.unit]);
    }
    return { code: 200, cfg, o, lines: remaining.map((s) => ({ title_snapshot: s.title, qty: s.qty, unit_price_vnd: s.unit })), sid };
  });
  if (claim.code !== 200) return send(res, claim.code, { error: claim.error ?? 'không tìm thấy đơn' });
  const { cfg, o, lines, sid } = claim;

  // (2) Gọi hãng NGOÀI transaction (side-effect ngoài, không rollback được).
  const codAmount = o.payment_method === 'cod' && o.payment_status === 'unpaid' ? Number(o.total_vnd) : 0;
  let created;
  try {
    const token = open(cfg.token_enc, ENC_KEY);
    created = await carrierCreate(cfg.provider, { token, ghnShopId: cfg.ghn_shop_id }, {
      // ref ỔN ĐỊNH THEO ĐƠN (không theo lần thử): hãng từ chối mã trùng → retry sau
      // timeout không bao giờ tạo VẬN ĐƠN THẬT thứ hai (idempotency phía hãng).
      ref: `NTG${o.order_number}`,
      pickup: cfg.pickup,
      toName, toPhone, toAddress, toProvince, toDistrict, toWard: toWard || undefined,
      weightGram, note,
      codAmount, // COD: hãng thu hộ đúng tổng đơn khi khách CHƯA trả; đơn đã trả → 0.
      value: Number(o.total_vnd),
      items: lines.map((l) => ({ name: l.title_snapshot, qty: l.qty, price: Number(l.unit_price_vnd) })),
    });
  } catch (e) {
    if (e instanceof CarrierError && e.ambiguous) {
      // Timeout/đứt mạng: KHÔNG BIẾT hãng đã tạo chưa → GIỮ claim (chống retry mù tạo
      // vận đơn thật thứ 2); worker sweep sẽ tự mở khoá sau 15' nếu hãng không tạo.
      return send(res, 502, { error: `${e.message} — chưa rõ hãng đã nhận lệnh chưa, hệ thống giữ chỗ và tự kiểm tra lại; thử lại sau ít phút` });
    }
    // Hãng TỪ CHỐI rõ ràng → nhả chỗ claim (chỉ khi còn 'created') rồi báo lỗi.
    await withTenant(ctx.shopId, (c) => c.query(`DELETE FROM shipments WHERE id = $1 AND status = 'created'`, [sid])).catch(() => {});
    if (e instanceof CarrierError) return send(res, 502, { error: e.message });
    throw e;
  }

  // (3) CHỐT: tồn + shipped + email — cùng code với giao tay (consumeAndShip).
  let fin;
  try {
    fin = await withTenant(ctx.shopId, async (c) => {
      const cur = (await c.query(`SELECT id, status, order_number, customer_email, payment_status FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
      if (!['confirmed', 'shipped'].includes(cur.status)) {
        // Đơn đổi trạng thái trong lúc gọi hãng (hiếm): vận đơn ĐÃ tồn tại phía hãng.
        await c.query(`UPDATE shipments SET status = 'cancelled', tracking_number = $2, provider_status = 'orphan' WHERE id = $1`, [sid, created.tracking]);
        return { code: 409, error: `đơn đã đổi trạng thái (${cur.status}) trong lúc tạo — vận đơn ${created.tracking} ĐÃ tạo trên ${cfg.provider.toUpperCase()}, vui lòng huỷ trên trang hãng` };
      }
      // TOCTOU: đơn được thanh toán TRONG LÚC gọi hãng mà vận đơn đã cài thu hộ COD →
      // vẫn chốt shipped nhưng CẢNH BÁO để shop sửa/huỷ thu hộ trên portal hãng.
      const codMismatch = codAmount > 0 && cur.payment_status === 'paid';
      await consumeAndShip(c, ctx, cur, {
        tracking: created.tracking, carrier: cfg.provider.toUpperCase(), shipmentId: sid,
        provider: cfg.provider, fee: created.fee, providerStatus: codMismatch ? 'cod_mismatch' : 'created',
      });
      if (codMismatch) await audit(c, 'shipping.cod_mismatch', { actorId: ctx.user.id, ip: ctx.ip, metadata: { orderId, tracking: created.tracking, codAmount } });
      return { code: 200, codMismatch };
    });
  } catch (e) {
    // Chốt THẤT BẠI sau khi hãng ĐÃ tạo → không được mất dấu tracking: ghi bù vào dòng
    // claim (finalize_failed) để shop thấy mã + worker/không ai mở khoá nhầm, rồi ném lỗi.
    await withTenant(ctx.shopId, (c) => c.query(
      `UPDATE shipments SET tracking_number = $2, provider_status = 'finalize_failed' WHERE id = $1 AND status = 'created'`,
      [sid, created.tracking])).catch(() => {});
    throw e;
  }
  if (fin.code !== 200) return send(res, fin.code, { error: fin.error });
  return send(res, 200, {
    ok: true, status: 'shipped', tracking_number: created.tracking, carrier_fee_vnd: created.fee, provider: cfg.provider,
    ...(fin.codMismatch ? { warning: `đơn đã được thanh toán trong lúc tạo vận đơn — vận đơn ${created.tracking} đang cài thu hộ ${codAmount.toLocaleString('vi-VN')}đ, hãy sửa/huỷ thu hộ trên portal hãng trước khi giao` } : {}),
  });
}

// PHỤC HỒI vận đơn 'finalize_failed' (hãng ĐÃ tạo nhưng tx chốt hỏng → đơn kẹt 'confirmed',
// tồn chưa trừ). Shop chọn: 'shipped' (xác nhận vận đơn thật trên portal → trừ tồn + giao) hoặc
// 'cancel' (đã huỷ vận đơn trên portal hãng → bỏ dòng, đặt lại được).
async function reconcileShipment(res, ctx, body, params) {
  const orderId = params[1];
  const action = body.action === 'cancel' ? 'cancel' : 'shipped';
  const out = await withTenant(ctx.shopId, async (c) => {
    const sh = (await c.query(
      `SELECT id, tracking_number, provider FROM shipments
        WHERE order_id = $1 AND provider_status = 'finalize_failed' AND status = 'created' FOR UPDATE`, [orderId])).rows[0];
    if (!sh) return { code: 404 };
    const o = (await c.query(`SELECT id, status, order_number, customer_email FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
    if (action === 'cancel') {
      await c.query(`UPDATE shipments SET status = 'cancelled', provider_status = 'reconciled_cancel' WHERE id = $1`, [sh.id]);
      await audit(c, 'shipping.reconcile_cancel', { actorId: ctx.user.id, ip: ctx.ip, metadata: { orderId, tracking: sh.tracking_number } });
      return { code: 200, action };
    }
    if (!['confirmed', 'shipped'].includes(o.status)) {
      await c.query(`UPDATE shipments SET status = 'cancelled', provider_status = 'orphan' WHERE id = $1`, [sh.id]);
      return { code: 409, error: `đơn không còn ở trạng thái giao được (${o.status})` };
    }
    await consumeAndShip(c, ctx, o, {
      tracking: sh.tracking_number, carrier: (sh.provider ?? '').toUpperCase(), shipmentId: sh.id,
      provider: sh.provider, providerStatus: 'reconciled',
    });
    return { code: 200, action };
  });
  if (out.code === 404) return send(res, 404, { error: 'không có vận đơn cần phục hồi' });
  if (out.code === 409) return send(res, 409, { error: out.error });
  return send(res, 200, { ok: true, action: out.action });
}

export const SHIPPING_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/shipping$`), perm: 'orders.read', fn: (res, ctx) => getShipping(res, ctx) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/shipping/test$`), perm: 'orders.read', fn: (res, ctx) => testShipping(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/carrier-reconcile$`), perm: 'orders.write', fn: (res, ctx, b, p) => reconcileShipment(res, ctx, b, p) },
  { m: 'PUT', re: new RegExp(`^/shops/${UUID}/shipping$`), perm: 'shop.write', stepUp: true, fn: (res, ctx, b) => connectShipping(res, ctx, b) },
  { m: 'DELETE', re: new RegExp(`^/shops/${UUID}/shipping$`), perm: 'shop.write', stepUp: true, fn: (res, ctx) => disconnectShipping(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/orders/${UUID}/carrier-shipment$`), perm: 'orders.write', fn: (res, ctx, b, p) => createCarrierShipment(res, ctx, b, p) },
];
