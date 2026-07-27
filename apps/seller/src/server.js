/**
 * Seller-admin — nhà bán hàng quản trị shop CỦA MÌNH.
 *
 * Dịch vụ ĐẦU TIÊN dùng thật app_rw + withTenant + RLS (tới nay chỉ có trong test).
 *
 * Ba lớp phòng thủ, mỗi cái có test + mutation:
 *   1. TENANT: mọi truy vấn chạy trong withTenant(shopId) → RLS cô lập. Thành viên
 *      shop A tuyệt đối không chạm dữ liệu shop B (trả 404, không xác nhận tồn tại).
 *   2. RBAC: vai trò trong shop (từ introspection) quyết định quyền theo ma trận
 *      docs/01 §11. Catalog Manager không đụng đơn hàng; chỉ Owner đổi quyền/xoá nhân sự.
 *   3. STEP-UP: thao tác nhạy cảm (đổi quyền, xoá thành viên) đòi xác thực lại
 *      gần đây (sessions.stepped_up_at < 5 phút).
 *
 * Xác thực phiên qua introspection tới auth /auth/me (giống platform).
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { readJson, readBuffer, send, originAllowed, clientIp } from './http.js';
import { can, permsFor, ROLES } from './rbac.js';
import { db, withTenant, audit } from './db.js';
import { CATALOG_ROUTES } from './catalog.js';
import { INVENTORY_ROUTES } from './inventory.js';
import { MEDIA_ROUTES, initMedia, mediaPublicUrl } from './media.js';
import { THEME_ADMIN_ROUTES } from './theme.js';
import { PAYMENT_CONFIG_ROUTES } from './payment-config.js';
import { ORDER_ROUTES } from './orders.js';
import { COD_ROUTES } from './cod.js';
import { DASHBOARD_ROUTES } from './dashboard.js';
import { REPORT_ROUTES } from './reports.js';
import { CONTENT_ROUTES } from './content.js';
import { BLOG_ROUTES } from './blog.js';
import { EXPORT_ROUTES } from './export.js';
import { DOMAIN_ROUTES } from './domains.js';
import { COUPON_ROUTES } from './coupons.js';
import { PROMOTION_ROUTES } from './promotions.js';
import { SHIPPING_ROUTES } from './shipping.js';
import { REVIEW_ROUTES } from './reviews.js';
import { QUESTION_ROUTES } from './questions.js';
import { CUSTOMER_ROUTES } from './customers.js';
import { NOTIFY_ROUTES } from './notify.js';
import { AUDIT_ROUTES } from './audit-log.js';
import { PURCHASING_ROUTES } from './purchasing.js';
import { LOYALTY_CONFIG_ROUTES } from './loyalty-config.js';
import { isProvince } from './provinces.js';
import { runReq, makeLog, health } from './obs.js';

const MAX_UPLOAD = 10 * 1024 * 1024;

const PORT = Number(process.env.PORT ?? 3040);
const AUTH_URL = process.env.AUTH_URL ?? 'http://auth:3020';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const STEP_UP_WINDOW_MS = 5 * 60_000;
// Base URL trang CHẤP NHẬN LỜI MỜI công khai (seller-admin /invite/accept) — mirror
// RESET_LINK_BASE của auth: dịch vụ giữ token thô dựng link đầy đủ cho email.
const INVITE_LINK_BASE = process.env.INVITE_LINK_BASE ?? 'https://admin.nentang.vn/invite/accept';

if (ALLOWED_ORIGINS.length === 0) throw new Error('thiếu ALLOWED_ORIGINS');

const log = makeLog('seller');

async function introspect(cookieHeader) {
  if (!cookieHeader) return null;
  try {
    const res = await fetch(`${AUTH_URL}/auth/me`, {
      headers: { cookie: cookieHeader },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    log('error', 'introspect_failed', { message: err.message });
    return null;
  }
}

function steppedUpRecently(user) {
  if (!user.stepped_up_at) return false;
  return Date.now() - new Date(user.stepped_up_at).getTime() < STEP_UP_WINDOW_MS;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const genToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

// ── handlers (nhận ctx = {user, role, shopId, ip}) ───────────────────────────

async function whoami(res, ctx) {
  return send(res, 200, {
    shop_id: ctx.shopId,
    role: ctx.role,
    permissions: permsFor(ctx.role),
    stepped_up: steppedUpRecently(ctx.user),
  });
}

async function getShop(res, ctx) {
  const row = await withTenant(ctx.shopId, async (c) => {
    const { rows } = await c.query(
      `SELECT id, slug, name, status, locale, currency, timezone,
              contact_email, contact_phone, business_address,
              ship_fee_vnd, free_ship_threshold_vnd, low_stock_threshold,
              ship_fee_far_vnd, ship_extra_per_500g_vnd, default_weight_gram, ship_from_province,
              ship_mode, ship_origin_lat, ship_origin_lng, ship_base_vnd, ship_per_km_vnd,
              ship_max_km, ship_road_factor, ship_over_max_behavior,
              max_pending_per_ip, max_pending_per_phone, pii_retention_months, logo_key, require_mfa
         FROM shops WHERE id = $1`,
      [ctx.shopId],
    );
    return rows[0];
  });
  if (!row) return send(res, 404, { error: 'không tìm thấy' }); // RLS che shop khác
  row.logo_url = mediaPublicUrl(row.logo_key); // BFF hiển thị khỏi phụ thuộc env
  return send(res, 200, row);
}

// Mở bán (onboarding → active): cột mốc "hoàn tất thiết lập". Shop onboarding VỐN đã bán được
// (storefront/checkout không chặn) — đây là mốc chủ shop tự đánh dấu + để nền tảng đếm shop active,
// và vá chuyện self-serve shop kẹt 'onboarding' mãi. Idempotent: chỉ lật khi ĐANG onboarding
// (không đụng suspended/terminated); gọi lại lúc đã active → trả status hiện tại, không đổi.
// app_rw UPDATE table-level trên shops (0029/0031) + policy tenant_isolation → tự-shop mới lật được.
async function activateShop(res, ctx) {
  const row = await withTenant(ctx.shopId, async (c) => {
    const upd = await c.query(`UPDATE shops SET status='active' WHERE id=$1 AND status='onboarding' RETURNING status`, [ctx.shopId]);
    if (upd.rows[0]) return upd.rows[0];
    const cur = await c.query(`SELECT status FROM shops WHERE id=$1`, [ctx.shopId]);
    return cur.rows[0];
  });
  if (!row) return send(res, 404, { error: 'không tìm thấy' });
  return send(res, 200, { status: row.status });
}

// Sửa hồ sơ cửa hàng (shop.write = owner/admin). Tên + liên hệ + địa chỉ hiển thị storefront.
async function updateShopProfile(res, ctx, body) {
  const name = String(body.name ?? '').trim();
  if (name.length < 1 || name.length > 200) return send(res, 400, { error: 'tên cửa hàng không hợp lệ (1–200 ký tự)' });
  const email = body.contact_email != null ? String(body.contact_email).trim() : '';
  if (email && !EMAIL_RE.test(email)) return send(res, 400, { error: 'email liên hệ không hợp lệ' });
  if (email.length > 200) return send(res, 400, { error: 'email quá dài' });
  const phone = String(body.contact_phone ?? '').trim();
  if (phone.length > 40) return send(res, 400, { error: 'số điện thoại quá dài' });
  const address = String(body.business_address ?? '').trim();
  if (address.length > 500) return send(res, 400, { error: 'địa chỉ quá dài' });

  // Phí vận chuyển (VND): '' → null (dùng mặc định nền tảng). Số nguyên >= 0, có trần.
  const MAX_SHIP = 10_000_000, MAX_THRESH = 1_000_000_000;
  const parseMoney = (v) => { const t = String(v ?? '').replace(/[^\d]/g, ''); return t === '' ? null : Number.parseInt(t, 10); };
  const shipFee = parseMoney(body.ship_fee_vnd);
  if (shipFee != null && (!Number.isInteger(shipFee) || shipFee < 0 || shipFee > MAX_SHIP)) return send(res, 400, { error: 'phí ship không hợp lệ' });
  const freeThreshold = parseMoney(body.free_ship_threshold_vnd);
  if (freeThreshold != null && (!Number.isInteger(freeThreshold) || freeThreshold < 0 || freeThreshold > MAX_THRESH)) return send(res, 400, { error: 'ngưỡng miễn phí ship không hợp lệ' });
  // Ngưỡng cảnh báo sắp hết hàng (0050): '' → NULL (dùng mặc định 5); 0..10000.
  const lowStock = parseMoney(body.low_stock_threshold);
  if (lowStock != null && (!Number.isInteger(lowStock) || lowStock < 0 || lowStock > 10000)) return send(res, 400, { error: 'ngưỡng sắp hết hàng không hợp lệ (0–10000)' });
  // Ngưỡng chống đơn ảo (0051): '' → NULL (mặc định nền tảng). Có TRẦN cứng để shop không mở toang.
  const maxIp = parseMoney(body.max_pending_per_ip);
  if (maxIp != null && (!Number.isInteger(maxIp) || maxIp < 1 || maxIp > 200)) return send(res, 400, { error: 'trần đơn chờ / nguồn không hợp lệ (1–200)' });
  const maxPhone = parseMoney(body.max_pending_per_phone);
  if (maxPhone != null && (!Number.isInteger(maxPhone) || maxPhone < 1 || maxPhone > 50)) return send(res, 400, { error: 'trần đơn chờ / SĐT không hợp lệ (1–50)' });
  // Phí ship theo VÙNG + CÂN (0063): '' → NULL (không phân vùng / không phụ phí — như cũ).
  const shipFar = parseMoney(body.ship_fee_far_vnd);
  if (shipFar != null && (!Number.isInteger(shipFar) || shipFar < 0 || shipFar > MAX_SHIP)) return send(res, 400, { error: 'phí ship liên miền không hợp lệ' });
  const extra500 = parseMoney(body.ship_extra_per_500g_vnd);
  if (extra500 != null && (!Number.isInteger(extra500) || extra500 < 0 || extra500 > MAX_SHIP)) return send(res, 400, { error: 'phụ phí theo cân không hợp lệ' });
  // Cột NOT NULL DEFAULT 500 (LỆCH pattern NULL-=-mặc-định của các cột khác): '' → reset về 500.
  const defWeight = parseMoney(body.default_weight_gram) ?? 500;
  if (!Number.isInteger(defWeight) || defWeight < 1 || defWeight > 50000) return send(res, 400, { error: 'khối lượng mặc định không hợp lệ (1–50000g)' });
  const fromProv = String(body.ship_from_province ?? '').trim() || null;
  if (fromProv && !isProvince(fromProv)) return send(res, 400, { error: 'tỉnh/thành gửi hàng không hợp lệ' });
  // Mirror CHECK shops_ship_far_requires_from — lỗi tiếng Việt thay vì để DB nổ thành 500.
  if (shipFar != null && !fromProv) return send(res, 400, { error: 'cần chọn "Giao hàng từ tỉnh/thành" khi đặt phí liên miền' });
  // Ship THEO KM (0089): mode + toạ độ gốc + đơn giá. '' → NULL. Mirror CHECK distance-requires-config.
  const parseNum = (v) => { const t = String(v ?? '').trim(); return t === '' ? null : Number(t); };
  const shipMode = String(body.ship_mode ?? '').trim() || 'region';
  if (!['region', 'distance'].includes(shipMode)) return send(res, 400, { error: 'chế độ phí ship không hợp lệ' });
  const originLat = parseNum(body.ship_origin_lat), originLng = parseNum(body.ship_origin_lng);
  if (originLat != null && (!Number.isFinite(originLat) || originLat < -90 || originLat > 90)) return send(res, 400, { error: 'vĩ độ gốc không hợp lệ' });
  if (originLng != null && (!Number.isFinite(originLng) || originLng < -180 || originLng > 180)) return send(res, 400, { error: 'kinh độ gốc không hợp lệ' });
  // Toạ độ gốc phải trong lãnh thổ VN (red-team: gốc sai → mọi phí sai). Bbox 34 tỉnh chi tiết ở commit sau.
  if (originLat != null && originLng != null && !(originLat >= 8.0 && originLat <= 23.6 && originLng >= 102.0 && originLng <= 109.6))
    return send(res, 400, { error: 'toạ độ gốc không nằm trong lãnh thổ Việt Nam' });
  const shipBase = parseMoney(body.ship_base_vnd);
  if (shipBase != null && (!Number.isInteger(shipBase) || shipBase < 0 || shipBase > MAX_SHIP)) return send(res, 400, { error: 'phí cơ bản không hợp lệ' });
  const shipPerKm = parseMoney(body.ship_per_km_vnd);
  if (shipPerKm != null && (!Number.isInteger(shipPerKm) || shipPerKm < 0 || shipPerKm > MAX_SHIP)) return send(res, 400, { error: 'phí mỗi km không hợp lệ' });
  const shipMaxKm = parseMoney(body.ship_max_km);
  if (shipMaxKm != null && (!Number.isInteger(shipMaxKm) || shipMaxKm < 1 || shipMaxKm > 500)) return send(res, 400, { error: 'trần km không hợp lệ (1–500)' });
  const roadFactor = parseNum(body.ship_road_factor);
  if (roadFactor != null && (!Number.isFinite(roadFactor) || roadFactor < 1.0 || roadFactor > 3.0)) return send(res, 400, { error: 'hệ số đường bộ không hợp lệ (1.0–3.0)' });
  // Ngoài bán kính nội thành: 'region' (toàn quốc — rơi phí vùng qua hãng) | 'reject' (chỉ giao nội thành).
  const overMax = String(body.ship_over_max_behavior ?? '').trim() || 'region';
  if (!['region', 'reject'].includes(overMax)) return send(res, 400, { error: 'hành vi ngoài bán kính không hợp lệ' });
  if (shipMode === 'distance') {
    if (originLat == null || originLng == null) return send(res, 400, { error: 'bật ship theo km cần toạ độ gốc cửa hàng' });
    if (shipBase == null || shipPerKm == null || shipMaxKm == null) return send(res, 400, { error: 'bật ship theo km cần phí cơ bản, phí/km và trần km' });
    if (!fromProv || shipFar == null) return send(res, 400, { error: 'bật ship theo km cần khai tỉnh gửi + phí liên miền (dự phòng khi khách không bật định vị)' });
  }
  // Hạn ẩn danh PII (0064): '' → NULL = giữ vĩnh viễn (mặc định). Sàn 6 tháng (đơn còn
  // trong vòng đời khiếu nại/đối soát COD). Bật là MẤT DỮ LIỆU dần → chỉ OWNER đổi được.
  const piiMonths = parseMoney(body.pii_retention_months);
  if (piiMonths != null && (!Number.isInteger(piiMonths) || piiMonths < 6 || piiMonths > 120)) return send(res, 400, { error: 'hạn ẩn danh dữ liệu khách không hợp lệ (6–120 tháng)' });

  const out = await withTenant(ctx.shopId, async (c) => {
    const cur = (await c.query(`SELECT pii_retention_months FROM shops WHERE id = current_shop_id()`)).rows[0];
    if ((cur?.pii_retention_months ?? null) !== piiMonths && ctx.role !== 'owner') {
      return { code: 403, body: { error: 'chỉ chủ cửa hàng được đổi hạn lưu dữ liệu khách' } };
    }
    await c.query(
      `UPDATE shops SET name = $1, contact_email = $2, contact_phone = $3, business_address = $4,
              ship_fee_vnd = $5, free_ship_threshold_vnd = $6, low_stock_threshold = $7,
              max_pending_per_ip = $8, max_pending_per_phone = $9,
              ship_fee_far_vnd = $10, ship_extra_per_500g_vnd = $11, default_weight_gram = $12, ship_from_province = $13,
              pii_retention_months = $14,
              ship_mode = $15, ship_origin_lat = $16, ship_origin_lng = $17, ship_base_vnd = $18,
              ship_per_km_vnd = $19, ship_max_km = $20, ship_road_factor = COALESCE($21, ship_road_factor),
              ship_over_max_behavior = $22
        WHERE id = current_shop_id()`,
      [name, email || null, phone || null, address || null, shipFee, freeThreshold, lowStock, maxIp, maxPhone, shipFar, extra500, defWeight, fromProv, piiMonths,
       shipMode, originLat, originLng, shipBase, shipPerKm, shipMaxKm, roadFactor, overMax],
    );
    await audit(c, 'shop.profile_updated', { actorId: ctx.user.id, ip: ctx.ip, metadata: {} });
    return { code: 200, body: { ok: true } };
  });
  return send(res, out.code, out.body);
}

async function listMembers(res, ctx) {
  const rows = await withTenant(ctx.shopId, async (c) => {
    const { rows } = await c.query(
      `SELECT m.user_id, m.role, u.email, m.created_at
         FROM memberships m JOIN users u ON u.id = m.user_id
        ORDER BY m.created_at`,
    );
    return rows;
  });
  return send(res, 200, { members: rows });
}

async function inviteMember(res, ctx, body) {
  const email = String(body.email ?? '').toLowerCase().trim();
  const role = String(body.role ?? '').trim();
  if (!EMAIL_RE.test(email)) return send(res, 400, { error: 'email không hợp lệ' });
  if (!ROLES.includes(role) || role === 'owner') {
    return send(res, 400, { error: 'vai trò mời không hợp lệ' }); // không mời owner qua đây
  }
  const token = genToken();
  await withTenant(ctx.shopId, async (c) => {
    // WITH CHECK của RLS đảm bảo shop_id = shop hiện tại — không mời hộ shop khác.
    await c.query(
      `INSERT INTO invitations (shop_id, email, role, token_hash, invited_by, expires_at)
       VALUES (current_shop_id(), $1, $2, $3, $4, now() + interval '7 days')`,
      [email, role, hashToken(token), ctx.user.id],
    );
    // ADR-006 (mirror auth forgot 0058): outbox CÙNG transaction (withTenant = 1 tx).
    // Token thô CHỈ đi qua email người ĐƯỢC MỜI — API không trả token cho người mời
    // (token = bằng chứng sở hữu email). app_rw ghi outbox qua tenant_isolation (0004).
    const shopName = (await c.query(`SELECT name FROM shops WHERE id = current_shop_id()`)).rows[0]?.name ?? '';
    await c.query(
      `INSERT INTO outbox (shop_id, topic, payload) VALUES (current_shop_id(), 'user.invited', $1)`,
      [{ to: email, shop_name: shopName, role, accept_url: `${INVITE_LINK_BASE}?token=${token}`, expires_days: 7 }],
    );
    await audit(c, 'member.invited', { actorId: ctx.user.id, ip: ctx.ip, metadata: { email, role } });
  });
  return send(res, 201, { ok: true, email, email_sent: true });
}

// ── Ép MFA per-shop (0074) — CHỈ owner, có guard chống tự khoá ────────────────
async function setRequireMfa(res, ctx, body) {
  if (ctx.role !== 'owner') return send(res, 403, { error: 'chỉ chủ cửa hàng được bật/tắt yêu cầu xác thực 2 lớp' });
  const on = body.require_mfa === true || body.require_mfa === '1';
  // Chống TỰ KHOÁ: owner chưa bật MFA mà bật cờ này là tự chặn mình khỏi mọi
  // route của shop ngay request kế tiếp. Bắt owner bật MFA cho tài khoản trước.
  if (on && !ctx.user.mfa_enabled) {
    return send(res, 422, { error: 'bạn cần bật xác thực 2 lớp cho tài khoản của mình trước khi bắt buộc cho cửa hàng' });
  }
  await withTenant(ctx.shopId, async (c) => {
    await c.query(`UPDATE shops SET require_mfa = $1 WHERE id = current_shop_id()`, [on]);
    await audit(c, 'shop.require_mfa_changed', { actorId: ctx.user.id, ip: ctx.ip, metadata: { require_mfa: on } });
  });
  return send(res, 200, { ok: true, require_mfa: on });
}

async function changeRole(res, ctx, targetUserId, body) {
  const role = String(body.role ?? '').trim();
  if (!ROLES.includes(role)) return send(res, 400, { error: 'vai trò không hợp lệ' });

  try {
    const result = await withTenant(ctx.shopId, async (c) => {
      const cur = await c.query(`SELECT role FROM memberships WHERE user_id = $1`, [targetUserId]);
      if (cur.rows.length === 0) return { code: 404 };
      const oldRole = cur.rows[0].role;

      // Không được để shop không còn owner nào.
      if (oldRole === 'owner' && role !== 'owner') {
        const { rows } = await c.query(`SELECT count(*)::int AS n FROM memberships WHERE role = 'owner'`);
        if (rows[0].n <= 1) return { code: 409 };
      }
      await c.query(`UPDATE memberships SET role = $1 WHERE user_id = $2`, [role, targetUserId]);
      await audit(c, 'member.role_changed', {
        actorId: ctx.user.id, ip: ctx.ip, metadata: { target: targetUserId, from: oldRole, to: role },
      });
      return { code: 200 };
    });
    if (result.code === 404) return send(res, 404, { error: 'không tìm thấy thành viên' });
    if (result.code === 409) return send(res, 409, { error: 'không thể bỏ owner cuối cùng' });
    return send(res, 200, { ok: true, role });
  } catch (err) {
    throw err;
  }
}

async function removeMember(res, ctx, targetUserId) {
  const result = await withTenant(ctx.shopId, async (c) => {
    const cur = await c.query(`SELECT role FROM memberships WHERE user_id = $1`, [targetUserId]);
    if (cur.rows.length === 0) return { code: 404 };
    if (cur.rows[0].role === 'owner') {
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM memberships WHERE role = 'owner'`);
      if (rows[0].n <= 1) return { code: 409 };
    }
    await c.query(`DELETE FROM memberships WHERE user_id = $1`, [targetUserId]);
    await audit(c, 'member.removed', { actorId: ctx.user.id, ip: ctx.ip, metadata: { target: targetUserId } });
    return { code: 200 };
  });
  if (result.code === 404) return send(res, 404, { error: 'không tìm thấy thành viên' });
  if (result.code === 409) return send(res, 409, { error: 'không thể xoá owner cuối cùng' });
  return send(res, 200, { ok: true });
}

// ── router ───────────────────────────────────────────────────────────────────
const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

// Mỗi route khai báo perm cần có và có đòi step-up không.
const ROUTES = [
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/whoami$`), perm: null, fn: (res, ctx) => whoami(res, ctx) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}$`), perm: null, fn: (res, ctx) => getShop(res, ctx) },
  { m: 'PATCH', re: new RegExp(`^/shops/${UUID}$`), perm: 'shop.write', fn: (res, ctx, b) => updateShopProfile(res, ctx, b) },
  { m: 'PATCH', re: new RegExp(`^/shops/${UUID}/require-mfa$`), perm: 'shop.write', fn: (res, ctx, b) => setRequireMfa(res, ctx, b) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/activate$`), perm: 'shop.write', fn: (res, ctx) => activateShop(res, ctx) },
  { m: 'GET', re: new RegExp(`^/shops/${UUID}/members$`), perm: 'members.read', fn: (res, ctx) => listMembers(res, ctx) },
  { m: 'POST', re: new RegExp(`^/shops/${UUID}/members/invite$`), perm: 'members.write', stepUp: true, fn: (res, ctx, b) => inviteMember(res, ctx, b) },
  { m: 'PATCH', re: new RegExp(`^/shops/${UUID}/members/${UUID}/role$`), perm: 'members.write', stepUp: true, fn: (res, ctx, b, p) => changeRole(res, ctx, p[1], b) },
  { m: 'DELETE', re: new RegExp(`^/shops/${UUID}/members/${UUID}$`), perm: 'members.write', stepUp: true, fn: (res, ctx, b, p) => removeMember(res, ctx, p[1]) },
  ...CATALOG_ROUTES,
  ...INVENTORY_ROUTES,
  ...MEDIA_ROUTES,
  ...THEME_ADMIN_ROUTES,
  ...PAYMENT_CONFIG_ROUTES,
  ...ORDER_ROUTES,
  ...COD_ROUTES,
  ...DASHBOARD_ROUTES,
  ...REPORT_ROUTES,
  ...CONTENT_ROUTES,
  ...BLOG_ROUTES,
  ...EXPORT_ROUTES,
  ...DOMAIN_ROUTES,
  ...COUPON_ROUTES,
  ...PROMOTION_ROUTES,
  ...SHIPPING_ROUTES,
  ...REVIEW_ROUTES,
  ...QUESTION_ROUTES,
  ...CUSTOMER_ROUTES,
  ...NOTIFY_ROUTES,
  ...AUDIT_ROUTES,
  ...PURCHASING_ROUTES,
  ...LOYALTY_CONFIG_ROUTES,
];

const server = http.createServer((req, res) => runReq(req, res, async () => {
  const url = new URL(req.url, 'http://internal');
  if (await health(url.pathname, res, { db: () => db.query('SELECT 1') })) return;

  if (!originAllowed(req, ALLOWED_ORIGINS)) return send(res, 403, { error: 'origin không được phép' });

  try {
    const user = await introspect(req.headers.cookie);
    if (!user) return send(res, 401, { error: 'chưa đăng nhập hoặc chưa qua MFA' });

    // GET /shops — danh sách shop của chính người dùng (từ introspection).
    if (req.method === 'GET' && url.pathname === '/shops') {
      return send(res, 200, { shops: user.memberships });
    }

    const route = ROUTES.find((r) => r.m === req.method && r.re.test(url.pathname));
    if (!route) return send(res, 404, { error: 'không tìm thấy' });

    const params = route.re.exec(url.pathname).slice(1);
    const shopId = params[0];

    // Phải là THÀNH VIÊN của shop này. Không phải → 404 (không xác nhận tồn tại).
    const membership = user.memberships.find((mm) => mm.shop_id === shopId);
    if (!membership) return send(res, 404, { error: 'không tìm thấy' });
    const role = membership.role;

    // Ép MFA per-shop (0074): shop bật require_mfa → MỌI route của shop (kể cả
    // đọc — nghiêm ngặt) đòi tài khoản đã bật MFA. Chỉ tốn 1 query khi user CHƯA
    // bật MFA; user đã bật thì đi thẳng. BFF nhận cờ mfa_required_by_shop để
    // hiện trang hướng dẫn bật 2FA (link /account).
    if (!user.mfa_enabled) {
      const requireMfa = await withTenant(shopId, async (c) =>
        (await c.query(`SELECT require_mfa FROM shops WHERE id = current_shop_id()`)).rows[0]?.require_mfa === true);
      if (requireMfa) {
        return send(res, 403, { error: 'cửa hàng yêu cầu bật xác thực 2 lớp', mfa_required_by_shop: true });
      }
    }

    // RBAC: đủ quyền?
    if (route.perm && !can(role, route.perm)) {
      return send(res, 403, { error: 'không đủ quyền', required: route.perm });
    }

    // Step-up: thao tác nhạy cảm đòi xác thực lại gần đây.
    if (route.stepUp && !steppedUpRecently(user)) {
      return send(res, 403, { error: 'step_up_required', step_up_required: true });
    }

    let body;
    if (['GET', 'DELETE'].includes(req.method)) body = {};
    else if (route.raw) body = await readBuffer(req, MAX_UPLOAD); // upload nhị phân
    else body = await readJson(req);
    const ctx = { user, role, shopId, ip: clientIp(req) };
    await route.fn(res, ctx, body, params, url.searchParams);
  } catch (err) {
    const status = err.statusCode ?? 500;
    if (status >= 500) log('error', 'handler_error', { path: url.pathname, message: err.message, stack: err.stack });
    // 413: có thể còn body đang tới mà ta không đọc hết → đóng kết nối sau phản hồi
    // để client nhận được 413 thay vì reset.
    const extra = status === 413 ? { connection: 'close' } : {};
    if (!res.headersSent) send(res, status, { error: status >= 500 ? 'lỗi hệ thống' : err.message }, extra);
  }
}));

// Tạo bucket + đặt policy public trước khi nhận request. Thử lại vài lần phòng
// khi MinIO chưa sẵn sàng (depends_on healthy đã bảo đảm, đây là phòng thủ thêm).
async function boot() {
  for (let i = 0; i < 10; i++) {
    try {
      await initMedia();
      log('info', 'media_ready', {});
      return;
    } catch (err) {
      log('warn', 'media_init_retry', { attempt: i + 1, message: err.message });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  log('error', 'media_init_failed', {}); // vẫn listen; endpoint media sẽ báo lỗi
}
boot();

server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT }));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(async () => {
      await db.end().catch(() => {});
      process.exit(0);
    });
  });
}
