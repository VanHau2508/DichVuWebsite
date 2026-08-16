/**
 * Readiness/go-live của shop. Mọi tín hiệu được đọc trực tiếp trong một transaction
 * tenant; client không gửi checklist và không thể tự khai "đã sẵn sàng".
 */

import crypto from 'node:crypto';
import { AVAIL_SQL } from '../safety-stock.js';
import { send } from './http.js';
import { withTenant, audit } from './db.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const PREVIEW_TTL_MIN = 15;
const PURCHASE_POLICY_SLUGS = ['chinh-sach-mua-hang', 'dieu-khoan-mua-hang', 'chinh-sach-doi-tra', 'dieu-khoan'];
const PRIVACY_POLICY_SLUGS = ['chinh-sach-bao-mat', 'bao-mat', 'quyen-rieng-tu'];
const VARIANT_NOT_ORPHAN_SQL = `NOT EXISTS (
  SELECT 1 FROM product_options po WHERE po.product_id = v.product_id
    AND NOT EXISTS (SELECT 1 FROM variant_option_values vov
                     WHERE vov.variant_id = v.id AND vov.option_id = po.id))`;

const genToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function check(code, ok, label, actionUrl, detail = null, blocking = true) {
  return {
    code,
    status: ok ? 'ready' : (blocking ? 'missing' : 'warning'),
    blocking,
    label,
    action_url: actionUrl,
    ...(detail == null ? {} : { detail }),
  };
}

function shippingReady(shop) {
  if (shop.ship_mode === 'distance') {
    return shop.ship_origin_lat != null && shop.ship_origin_lng != null
      && shop.ship_base_vnd != null && shop.ship_per_km_vnd != null && shop.ship_max_km != null
      && shop.ship_from_province != null && shop.ship_fee_far_vnd != null;
  }
  return shop.ship_fee_vnd != null;
}

async function computeReadiness(c, ctx) {
  const shop = (await c.query(
    `SELECT id, name, status, contact_email, contact_phone, business_address,
            ship_fee_vnd, ship_fee_far_vnd, ship_from_province, ship_mode,
            ship_origin_lat, ship_origin_lng, ship_base_vnd, ship_per_km_vnd, ship_max_km,
            require_mfa, went_live_at
       FROM shops WHERE id = current_shop_id()`,
  )).rows[0];
  if (!shop) return null;

  // Đây là dry-run chỉ đọc: chọn đúng một biến thể mà checkout thật có thể bán, dùng cùng
  // công thức ATS và cùng chốt biến thể mồ côi. Không tạo cart/order/idempotency, không
  // reserve tồn và không ghi outbox.
  const sample = (await c.query(
    `SELECT v.id AS variant_id, v.price_vnd, coalesce(${AVAIL_SQL}, 0)::int AS available
       FROM products p
       JOIN variants v ON v.product_id = p.id
       JOIN inventory_levels il ON il.variant_id = v.id
      WHERE p.status = 'active' AND p.deleted_at IS NULL
        AND v.price_vnd >= 0 AND ${VARIANT_NOT_ORPHAN_SQL}
        AND ${AVAIL_SQL} > 0
      ORDER BY p.created_at, v.position, v.id
      LIMIT 1`,
  )).rows[0] ?? null;

  const payment = (await c.query(
    `SELECT qr_enabled, bank_bin, account_number FROM shop_payment_config
      WHERE shop_id = current_shop_id()`,
  )).rows[0] ?? null;
  const qrReady = !!(payment?.qr_enabled && payment.bank_bin && payment.account_number);

  const domain = (await c.query(
    `SELECT hostname, is_primary FROM domains
      WHERE verified_at IS NOT NULL ORDER BY is_primary DESC, created_at LIMIT 1`,
  )).rows[0] ?? null;

  const pages = (await c.query(
    `SELECT slug FROM pages
      WHERE status = 'published' AND published_revision_id IS NOT NULL AND deleted_at IS NULL
        AND slug = ANY($1::text[])`,
    [[...new Set([...PURCHASE_POLICY_SLUGS, ...PRIVACY_POLICY_SLUGS])]],
  )).rows.map((row) => row.slug);
  const purchasePolicy = PURCHASE_POLICY_SLUGS.some((slug) => pages.includes(slug));
  const privacyPolicy = PRIVACY_POLICY_SLUGS.some((slug) => pages.includes(slug));

  const shipping = shippingReady(shop);
  const contact = !!(String(shop.contact_email ?? '').trim() || String(shop.contact_phone ?? '').trim());
  // COD luôn là phương thức nền tảng hỗ trợ; QR chỉ được công bố khi đủ cả ba trường.
  const methods = qrReady ? ['cod', 'qr'] : ['cod'];
  const shippingForDryRun = shop.ship_mode === 'distance'
    ? Number(shop.ship_fee_far_vnd ?? 0)
    : Number(shop.ship_fee_vnd ?? 0);
  const dryTotal = sample ? Number(sample.price_vnd) + shippingForDryRun : null;
  const dryRun = !!(sample && shipping && methods.length && Number.isSafeInteger(dryTotal) && dryTotal >= 0);

  const base = `/shops/${ctx.shopId}`;
  const checks = [
    check('catalog', !!sample, 'Cần ít nhất một sản phẩm đang bán và còn tồn khả dụng', `${base}/products/new`,
      sample ? { variant_id: sample.variant_id, available_qty: Number(sample.available) } : null),
    check('payment', methods.length > 0, 'Cần ít nhất một phương thức nhận tiền', `${base}/payment`, { methods, qr_ready: qrReady }),
    check('shipping', shipping, 'Chưa cấu hình phí/phương thức vận chuyển', `${base}/settings#phi-ship`),
    check('contact', contact, 'Chưa có email hoặc số điện thoại liên hệ', `${base}/settings`),
    check('purchase_policy', purchasePolicy, 'Chưa xuất bản chính sách mua hàng/đổi trả', `${base}/pages`),
    check('privacy_policy', privacyPolicy, 'Chưa xuất bản chính sách quyền riêng tư', `${base}/pages`),
    check('domain', !!domain, 'Chưa có tên miền đã xác minh', `${base}/domains`, domain ? { hostname: domain.hostname } : null),
    // action_url = null CỐ Ý: đây là KẾT QUẢ của các mục kia, không phải việc người dùng tự
    // sửa được. Trỏ vòng về /overview là đưa người ta đúng chỗ họ đang đứng.
    // VẪN blocking — computeReadiness và activate_current_shop_after_readiness() không đổi.
    check('checkout_dry_run', dryRun, 'Kiểm tra thử checkout phía server chưa đạt', null,
      dryRun ? { variant_id: sample.variant_id, total_vnd: dryTotal, wrote_data: false } : { wrote_data: false }),
    check('mfa', ctx.user.mfa_enabled === true, 'Chủ shop nên bật xác thực 2 lớp trước khi mở bán', '/account', null, false),
  ];

  // TRẠNG THÁI LINK XEM TRƯỚC, đủ để giao diện nói đúng SAU KHI TẢI LẠI TRANG.
  // Trước đây trạng thái này chỉ sống trong response của POST /preview, nên F5 một cái là
  // màn hình quên sạch: link đang chạy cũng như chưa từng có, và người dùng bấm lại — đúng
  // cái thao tác từng giết token cũ.
  //
  // CHỈ metadata. Không `token_hash`, không token thô, không `created_by`. `expires_at` là
  // thời điểm hết hạn của chính shop này, người gọi đã qua RBAC của shop đó nên không phải
  // là kênh dò gì thêm.
  const prev = (await c.query(
    `SELECT expires_at, expires_at > now() AS active
       FROM shop_previews WHERE shop_id = current_shop_id()`,
  )).rows[0] ?? null;

  return {
    ready: checks.every((item) => !item.blocking || item.status === 'ready'),
    status: shop.status,
    went_live_at: shop.went_live_at,
    preview_host: domain?.hostname ?? null,
    preview: prev
      ? { state: prev.active ? 'active' : 'expired', expires_at: prev.expires_at }
      : { state: 'none', expires_at: null },
    checks,
  };
}

async function getReadiness(res, ctx) {
  const out = await withTenant(ctx.shopId, (c) => computeReadiness(c, ctx));
  if (!out) return send(res, 404, { error: 'không tìm thấy' });
  return send(res, 200, out);
}

async function goLive(res, ctx) {
  const out = await withTenant(ctx.shopId, async (c) => {
    const readiness = await computeReadiness(c, ctx);
    if (!readiness) return { code: 404, body: { error: 'không tìm thấy' } };
    if (readiness.status === 'active') return { code: 200, body: { ...readiness, status: 'active' } };
    if (readiness.status !== 'onboarding') {
      return { code: 409, body: { error: 'shop_not_activatable', status: readiness.status, checks: readiness.checks } };
    }
    if (!readiness.ready) {
      return { code: 409, body: { error: 'shop_not_ready', ready: false, status: readiness.status, checks: readiness.checks } };
    }

    // app_rw không còn quyền đổi trực tiếp lifecycle của tenant. Hàm DB không nhận
    // shop_id và chỉ chuyển current_shop_id() onboarding -> active, sau khi checklist
    // server-side ngay phía trên đã đạt trong cùng transaction.
    const changed = await c.query(
      `SELECT status, went_live_at FROM activate_current_shop_after_readiness()`,
    );
    if (changed.rowCount !== 1) {
      // Hàm DB tự kiểm lại toàn bộ blocker DB-expressible. Nếu dữ liệu đổi giữa hai câu
      // lệnh (ví dụ sản phẩm vừa bị archive), dựng lại checklist để trả đúng hành động thay
      // vì biến một chốt an toàn thành lỗi 500 hoặc thông báo "trạng thái đổi" mơ hồ.
      const latest = await computeReadiness(c, ctx);
      if (latest?.status === 'active') {
        return { code: 200, body: { ...latest, status: 'active' } };
      }
      if (latest?.status === 'onboarding' && !latest.ready) {
        return { code: 409, body: { error: 'shop_not_ready', ...latest } };
      }
      return {
        code: 409,
        body: {
          error: latest?.status === 'onboarding' ? 'shop_readiness_guard_rejected' : 'shop_status_changed',
          status: latest?.status ?? null,
          checks: latest?.checks ?? [],
        },
      };
    }
    await audit(c, 'shop.went_live', {
      actorId: ctx.user.id,
      ip: ctx.ip,
      metadata: { checks: readiness.checks.map((item) => ({ code: item.code, status: item.status })) },
    });
    return { code: 200, body: { ...readiness, ready: true, status: 'active', went_live_at: changed.rows[0].went_live_at } };
  });
  return send(res, out.code, out.body);
}

async function createPreview(res, ctx, body) {
  // Xoay token là hành động TƯỜNG MINH của người dùng, không phải hệ quả của việc bấm lại.
  const rotate = body?.rotate === true || String(body?.rotate ?? '') === '1';
  const token = genToken();
  const out = await withTenant(ctx.shopId, async (c) => {
    const shop = (await c.query(`SELECT status FROM shops WHERE id = current_shop_id()`)).rows[0];
    if (!shop) return { code: 404, body: { error: 'không tìm thấy' } };
    if (shop.status !== 'onboarding') {
      return { code: 409, body: { error: 'preview_not_available', status: shop.status } };
    }
    const host = (await c.query(
      `SELECT hostname FROM domains WHERE verified_at IS NOT NULL
        ORDER BY is_primary DESC, created_at LIMIT 1`,
    )).rows[0]?.hostname;
    if (!host) return { code: 409, body: { error: 'domain_not_ready' } };

    // KHÔNG xoay token khi link cũ CÒN HIỆU LỰC — trừ khi người dùng bấm "Tạo link mới".
    //
    // Bản trước upsert vô điều kiện, nên mỗi POST đều sinh token mới và GIẾT token cũ. Hệ quả
    // thật: chủ shop bấm "Xem trước", copy link gửi cho đồng nghiệp, rồi bấm lại lần nữa (hoặc
    // trình duyệt gửi lại form, hoặc double-click, hoặc mạng chậm nên bấm thêm) → link vừa gửi
    // chết ngay, và không có gì báo cho biết vì sao.
    //
    // `WHERE shop_previews.expires_at <= now() OR $4` nằm TRÊN nhánh DO UPDATE nên cả ba ca
    // đều an toàn mà không cần JavaScript:
    //   · gửi lặp     → WHERE sai → không ghi → link cũ sống;
    //   · hai request đồng thời → một câu INSERT..ON CONFLICT là NGUYÊN TỬ, không phải
    //     check-then-act, nên không có cửa sổ đua;
    //   · hết hạn thật hoặc bấm "Tạo link mới" → xoay.
    // Không ghi được thì rowCount = 0 và ta biết đang ở ca "link cũ còn sống".
    const ins = await c.query(
      `INSERT INTO shop_previews (shop_id, token_hash, created_by, expires_at)
       VALUES (current_shop_id(), $1, $2, now() + ($3 || ' minutes')::interval)
       ON CONFLICT (shop_id) DO UPDATE SET
         token_hash = EXCLUDED.token_hash, created_by = EXCLUDED.created_by,
         created_at = now(), expires_at = EXCLUDED.expires_at
       WHERE shop_previews.expires_at <= now() OR $4
       RETURNING expires_at`,
      [hashToken(token), ctx.user.id, String(PREVIEW_TTL_MIN), rotate],
    );
    if (ins.rowCount === 0) {
      // Link cũ còn hiệu lực. KHÔNG trả token thô — ta chỉ lưu hash nên không dựng lại được,
      // và cũng không nên: người bấm lặp đã có link trong tay rồi.
      const cur = (await c.query(
        `SELECT expires_at FROM shop_previews WHERE shop_id = current_shop_id()`,
      )).rows[0];
      return { code: 200, body: {
        reused: true, expires_at: cur?.expires_at ?? null,
        expires_in: cur ? Math.max(0, Math.round((new Date(cur.expires_at) - Date.now()) / 1000)) : 0,
      } };
    }
    const row = ins.rows[0];
    await audit(c, 'shop.preview_created', {
      actorId: ctx.user.id, ip: ctx.ip, metadata: { expires_at: row.expires_at },
    });
    return {
      code: 201,
      body: {
        preview_url: `https://${host}/?shop_preview=${encodeURIComponent(token)}`,
        token,
        expires_in: PREVIEW_TTL_MIN * 60,
      },
    };
  });
  return send(res, out.code, out.body);
}

export const READINESS_ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/readiness$`), perm: null, fn: (res, ctx) => getReadiness(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/go-live$`), perm: 'shop.write', fn: (res, ctx) => goLive(res, ctx) },
  // Tương thích BFF hiện tại. Cùng handler nên đường cũ không thể bỏ qua readiness.
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/activate$`), perm: 'shop.write', fn: (res, ctx) => goLive(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/preview$`), perm: 'shop.write', fn: (res, ctx, b) => createPreview(res, ctx, b) },
];
