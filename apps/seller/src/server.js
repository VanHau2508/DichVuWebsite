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
import { DASHBOARD_ROUTES } from './dashboard.js';
import { CONTENT_ROUTES } from './content.js';
import { BLOG_ROUTES } from './blog.js';
import { EXPORT_ROUTES } from './export.js';
import { DOMAIN_ROUTES } from './domains.js';
import { runReq, makeLog, health } from './obs.js';

const MAX_UPLOAD = 10 * 1024 * 1024;

const PORT = Number(process.env.PORT ?? 3040);
const AUTH_URL = process.env.AUTH_URL ?? 'http://auth:3020';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const STEP_UP_WINDOW_MS = 5 * 60_000;

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
              ship_fee_vnd, free_ship_threshold_vnd, logo_key
         FROM shops WHERE id = $1`,
      [ctx.shopId],
    );
    return rows[0];
  });
  if (!row) return send(res, 404, { error: 'không tìm thấy' }); // RLS che shop khác
  row.logo_url = mediaPublicUrl(row.logo_key); // BFF hiển thị khỏi phụ thuộc env
  return send(res, 200, row);
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

  await withTenant(ctx.shopId, async (c) => {
    await c.query(
      `UPDATE shops SET name = $1, contact_email = $2, contact_phone = $3, business_address = $4,
              ship_fee_vnd = $5, free_ship_threshold_vnd = $6
        WHERE id = current_shop_id()`,
      [name, email || null, phone || null, address || null, shipFee, freeThreshold],
    );
    await audit(c, 'shop.profile_updated', { actorId: ctx.user.id, ip: ctx.ip, metadata: {} });
  });
  return send(res, 200, { ok: true });
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
    await audit(c, 'member.invited', { actorId: ctx.user.id, ip: ctx.ip, metadata: { email, role } });
  });
  return send(res, 201, { token, accept_path: '/auth/invitations/accept' });
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
  ...DASHBOARD_ROUTES,
  ...CONTENT_ROUTES,
  ...BLOG_ROUTES,
  ...EXPORT_ROUTES,
  ...DOMAIN_ROUTES,
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
