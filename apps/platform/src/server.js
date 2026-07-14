/**
 * Dịch vụ platform (ops) — nghiệp vụ vận hành nền tảng cho NHÂN VIÊN NỀN TẢNG.
 *
 * Tạo shop, sinh subdomain, chọn gói, mời owner, khoá/mở shop.
 *
 * Hai nguyên tắc bảo mật (docs/03), mỗi cái có test:
 *   1. Role DB app_platform KHÔNG có quyền trên bảng nghiệp vụ (products, orders,
 *      carts...). "Platform không mặc định xem dữ liệu khách mua." Kiểm bằng test:
 *      app_platform SELECT orders → lỗi quyền.
 *   2. Mọi endpoint /ops đòi: (a) phiên hợp lệ, (b) là platform_staff, (c) đã bật MFA.
 *      MFA bắt buộc cho nhân viên nền tảng.
 *
 * Xác thực phiên qua INTROSPECTION: gọi auth /auth/me với cookie được chuyển tiếp.
 * app_platform cố tình KHÔNG đọc được bảng sessions (chỉ auth service đọc) — giữ
 * bán kính ảnh hưởng hẹp. Đánh đổi: một lượt gọi nội bộ mỗi request (chấp nhận ở
 * quy mô pilot). Trong monolith đích, đây chỉ là một lời gọi hàm.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import { readJson, send, originAllowed, clientIp } from './http.js';
import { runReq, makeLog, health } from './obs.js';

const PORT = Number(process.env.PORT ?? 3030);
const AUTH_URL = process.env.AUTH_URL ?? 'http://auth:3020';
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? 'nentang.vn';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const INVITE_TTL_DAYS = 7;

if (ALLOWED_ORIGINS.length === 0) {
  throw new Error('thiếu ALLOWED_ORIGINS — mọi mutation sẽ bị từ chối');
}

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

const log = makeLog('platform');

const genToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

async function audit(action, { shopId = null, actorId = null, ip = null, metadata = null } = {}) {
  await db
    .query(
      `INSERT INTO audit_logs (shop_id, actor_type, actor_id, action, ip, metadata)
       VALUES ($1, 'platform_staff', $2, $3, $4, $5)`,
      [shopId, actorId, action, ip, metadata],
    )
    .catch((err) => log('error', 'audit_failed', { action, message: err.message }));
}

/**
 * Xác thực phiên bằng cách hỏi auth service. Trả về user (đã qua MFA) hoặc null.
 * Chuyển tiếp nguyên cookie của request tới auth /auth/me.
 */
async function introspect(cookieHeader) {
  if (!cookieHeader) return null;
  try {
    const res = await fetch(`${AUTH_URL}/auth/me`, {
      headers: { cookie: cookieHeader },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null; // 401 (chưa đăng nhập / phiên nửa vời) → null
    return await res.json(); // {id, email, mfa_enabled, memberships}
  } catch (err) {
    log('error', 'introspect_failed', { message: err.message });
    return null; // fail-closed
  }
}

/**
 * Yêu cầu: phiên hợp lệ + là platform_staff + đã bật MFA.
 * Trả về {user, staffRole} hoặc gửi lỗi và trả null.
 */
async function requireStaff(req, res) {
  const me = await introspect(req.headers.cookie);
  if (!me) {
    send(res, 401, { error: 'chưa đăng nhập hoặc chưa qua MFA' });
    return null;
  }
  // MFA bắt buộc cho nhân viên nền tảng — không thoả hiệp.
  if (!me.mfa_enabled) {
    send(res, 403, { error: 'nhân viên nền tảng phải bật MFA' });
    return null;
  }
  const { rows } = await db.query('SELECT role FROM platform_staff WHERE user_id = $1', [me.id]);
  if (rows.length === 0) {
    send(res, 403, { error: 'không phải nhân viên nền tảng' });
    return null;
  }
  return { user: me, staffRole: rows[0].role };
}

// ── validation ───────────────────────────────────────────────────────────────
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/; // dns-safe, <= 40 ký tự
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ['owner', 'admin', 'catalog_manager', 'order_manager'];

// ── handlers ─────────────────────────────────────────────────────────────────

async function createShop(req, res, body, staff, ip) {
  const name = String(body.name ?? '').trim();
  const slug = String(body.slug ?? '').toLowerCase().trim();
  const planCode = String(body.plan_code ?? '').trim();
  const locale = String(body.locale ?? 'vi-VN').trim();
  const currency = String(body.currency ?? 'VND').toUpperCase().trim();
  const timezone = String(body.timezone ?? 'Asia/Ho_Chi_Minh').trim();

  if (!name || name.length > 200) return send(res, 400, { error: 'tên shop không hợp lệ' });
  if (!SLUG_RE.test(slug)) return send(res, 400, { error: 'slug không hợp lệ (a-z, 0-9, gạch ngang)' });

  const plan = await db.query('SELECT code FROM plans WHERE code = $1 AND active', [planCode]);
  if (plan.rows.length === 0) return send(res, 400, { error: 'gói dịch vụ không hợp lệ' });

  const subdomain = `${slug}.${PLATFORM_DOMAIN}`;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const shop = await client.query(
      `INSERT INTO shops (slug, name, status, locale, currency, timezone)
       VALUES ($1, $2, 'onboarding', $3, $4, $5) RETURNING id`,
      [slug, name, locale, currency, timezone],
    );
    const shopId = shop.rows[0].id;

    // Subdomain nền tảng: tự sở hữu nên verified ngay (khác custom domain của khách).
    await client.query(
      `INSERT INTO domains (shop_id, hostname, verification_token, verified_at, is_primary)
       VALUES ($1, $2, $3, now(), true)`,
      [shopId, subdomain, genToken()],
    );

    await client.query(
      `INSERT INTO subscriptions (shop_id, plan_code, status) VALUES ($1, $2, 'trial')`,
      [shopId, planCode],
    );

    await client.query(
      `INSERT INTO audit_logs (shop_id, actor_type, actor_id, action, ip, metadata)
       VALUES ($1, 'platform_staff', $2, 'shop.created', $3, $4)`,
      [shopId, staff.user.id, ip, { slug, plan_code: planCode }],
    );
    await client.query('COMMIT');

    log('info', 'shop_created', { shopId, slug });
    return send(res, 201, { id: shopId, slug, subdomain, status: 'onboarding' });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return send(res, 409, { error: 'slug hoặc subdomain đã tồn tại' });
    throw err;
  } finally {
    client.release();
  }
}

async function listShops(req, res) {
  const { rows } = await db.query(
    `SELECT s.id, s.slug, s.name, s.status, s.created_at,
            d.hostname AS subdomain, sub.plan_code, sub.status AS sub_status
       FROM shops s
       LEFT JOIN domains d ON d.shop_id = s.id AND d.is_primary
       LEFT JOIN subscriptions sub ON sub.shop_id = s.id
      WHERE s.deleted_at IS NULL
      ORDER BY s.created_at DESC LIMIT 200`,
  );
  return send(res, 200, { shops: rows });
}

async function getShop(req, res, shopId) {
  const { rows } = await db.query(
    `SELECT s.id, s.slug, s.name, s.status, s.locale, s.currency, s.timezone, s.created_at,
            d.hostname AS subdomain, sub.plan_code, sub.status AS sub_status, sub.current_period_end
       FROM shops s
       LEFT JOIN domains d ON d.shop_id = s.id AND d.is_primary
       LEFT JOIN subscriptions sub ON sub.shop_id = s.id
      WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [shopId],
  );
  if (rows.length === 0) return send(res, 404, { error: 'không tìm thấy shop' });
  return send(res, 200, rows[0]);
}

// Ghi nhận đã THU thuê bao: sub → active + gia hạn kỳ (từ mốc lớn hơn giữa now và kỳ cũ,
// cộng dồn), đổi gói nếu chọn, và MỞ LẠI shop nếu đang suspended (guard: chỉ suspended→active,
// KHÔNG un-terminate). Thu tiền THỦ CÔNG (chưa cổng recurring) — đúng mô hình concierge.
async function renewSubscription(req, res, shopId, staff, ip, body) {
  const months = Math.min(Math.max(parseInt(body.months ?? '1', 10) || 1, 1), 24);
  const planCode = body.plan_code ? String(body.plan_code).trim() : null;
  if (planCode) {
    const p = await db.query('SELECT code FROM plans WHERE code = $1 AND active', [planCode]);
    if (p.rows.length === 0) return send(res, 400, { error: 'gói dịch vụ không hợp lệ' });
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const sub = await client.query(`SELECT 1 FROM subscriptions WHERE shop_id = $1`, [shopId]);
    if (sub.rows.length === 0) { await client.query('ROLLBACK'); return send(res, 404, { error: 'không tìm thấy thuê bao của shop' }); }
    await client.query(
      `UPDATE subscriptions SET status = 'active',
              plan_code = COALESCE($2, plan_code),
              current_period_end = GREATEST(COALESCE(current_period_end, now()), now()) + ($3 || ' months')::interval
        WHERE shop_id = $1`,
      [shopId, planCode, String(months)],
    );
    await client.query(`UPDATE shops SET status = 'active' WHERE id = $1 AND status = 'suspended'`, [shopId]);
    await client.query(
      `INSERT INTO audit_logs (shop_id, actor_type, actor_id, action, ip, metadata)
       VALUES ($1, 'platform_staff', $2, 'subscription.renewed', $3, $4)`,
      [shopId, staff.user.id, ip, { months, plan_code: planCode }],
    );
    await client.query('COMMIT');
    return send(res, 200, { ok: true, months });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function inviteOwner(req, res, body, staff, shopId, ip) {
  const email = String(body.email ?? '').toLowerCase().trim();
  const role = String(body.role ?? 'owner').trim();
  if (!EMAIL_RE.test(email)) return send(res, 400, { error: 'email không hợp lệ' });
  if (!ROLES.includes(role)) return send(res, 400, { error: 'vai trò không hợp lệ' });

  const shop = await db.query(`SELECT id FROM shops WHERE id = $1 AND deleted_at IS NULL`, [shopId]);
  if (shop.rows.length === 0) return send(res, 404, { error: 'không tìm thấy shop' });

  const token = genToken();
  const { rows } = await db.query(
    `INSERT INTO invitations (shop_id, email, role, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval) RETURNING id, expires_at`,
    [shopId, email, role, hashToken(token), staff.user.id, String(INVITE_TTL_DAYS)],
  );
  await audit('invitation.created', { shopId, actorId: staff.user.id, ip, metadata: { email, role } });

  // Trả token cho NHÂN VIÊN đã xác thực — hợp lệ: họ chính là người gửi link cho
  // owner (qua email/tin nhắn). Đây không phải rò rỉ; đây là kết quả thao tác.
  return send(res, 201, {
    invitation_id: rows[0].id,
    token,
    accept_path: `/auth/invitations/accept`,
    expires_at: rows[0].expires_at,
  });
}

async function setShopStatus(req, res, shopId, action, staff, ip, body) {
  // suspend: onboarding/active → suspended. restore: suspended → active.
  // KHÔNG bao giờ xoá dữ liệu (cam kết hợp đồng).
  let sql;
  let auditAction;
  if (action === 'suspend') {
    sql = `UPDATE shops SET status = 'suspended'
            WHERE id = $1 AND status IN ('onboarding','active') AND deleted_at IS NULL`;
    auditAction = 'shop.suspended';
  } else {
    sql = `UPDATE shops SET status = 'active'
            WHERE id = $1 AND status = 'suspended' AND deleted_at IS NULL`;
    auditAction = 'shop.restored';
  }
  const r = await db.query(sql, [shopId]);
  if (r.rowCount === 0) {
    return send(res, 409, { error: 'shop không ở trạng thái cho phép thao tác này' });
  }
  await audit(auditAction, { shopId, actorId: staff.user.id, ip, metadata: { reason: body?.reason ?? null } });
  return send(res, 200, { ok: true, status: action === 'suspend' ? 'suspended' : 'active' });
}

// ── router ───────────────────────────────────────────────────────────────────
const SHOP_ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const ROUTES = [
  { m: 'POST', re: /^\/ops\/shops$/, fn: (req, res, b, s, ip) => createShop(req, res, b, s, ip) },
  { m: 'GET', re: /^\/ops\/shops$/, fn: (req, res) => listShops(req, res) },
  { m: 'GET', re: new RegExp(`^/ops/shops/${SHOP_ID}$`), fn: (req, res, b, s, ip, p) => getShop(req, res, p[0]) },
  { m: 'POST', re: new RegExp(`^/ops/shops/${SHOP_ID}/invitations$`), fn: (req, res, b, s, ip, p) => inviteOwner(req, res, b, s, p[0], ip) },
  { m: 'POST', re: new RegExp(`^/ops/shops/${SHOP_ID}/suspend$`), fn: (req, res, b, s, ip, p) => setShopStatus(req, res, p[0], 'suspend', s, ip, b) },
  { m: 'POST', re: new RegExp(`^/ops/shops/${SHOP_ID}/restore$`), fn: (req, res, b, s, ip, p) => setShopStatus(req, res, p[0], 'restore', s, ip, b) },
  { m: 'POST', re: new RegExp(`^/ops/shops/${SHOP_ID}/subscription/renew$`), fn: (req, res, b, s, ip, p) => renewSubscription(req, res, p[0], s, ip, b) },
];

const server = http.createServer((req, res) => runReq(req, res, async () => {
  const url = new URL(req.url, 'http://internal');
  if (await health(url.pathname, res, { db: () => db.query('SELECT 1') })) return;

  const route = ROUTES.find((r) => r.m === req.method && r.re.test(url.pathname));
  if (!route) return send(res, 404, { error: 'không tìm thấy' });

  if (!originAllowed(req, ALLOWED_ORIGINS)) return send(res, 403, { error: 'origin không được phép' });

  try {
    const staff = await requireStaff(req, res);
    if (!staff) return; // requireStaff đã gửi lỗi

    const params = route.re.exec(url.pathname).slice(1);
    const body = req.method === 'GET' ? {} : await readJson(req);
    await route.fn(req, res, body, staff, clientIp(req), params);
  } catch (err) {
    const status = err.statusCode ?? 500;
    if (status >= 500) log('error', 'handler_error', { path: url.pathname, message: err.message, stack: err.stack });
    if (!res.headersSent) send(res, status, { error: status >= 500 ? 'lỗi hệ thống' : err.message });
  }
}));

server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT }));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(async () => {
      await db.end().catch(() => {});
      process.exit(0);
    });
  });
}
