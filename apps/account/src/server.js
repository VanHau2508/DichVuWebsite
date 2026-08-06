/**
 * Dịch vụ TÀI KHOẢN KHÁCH HÀNG storefront (0083) — per-shop, no-framework, no-JS SSR.
 * Mount /account/* trên CHÍNH host của shop (Caddy) → cookie __Host-cust_session chia sẻ với
 * storefront + checkout. Vai DB app_customer (least-priv). Mượn mã packages/auth.
 *
 * BẢO MẬT (đã áp must-fix red-team):
 *  - Đăng ký ENUM-SAFE + KHÔNG auto-login (must-fix #3): cả email mới/đã-tồn-tại → cùng trang
 *    trung tính, không set cookie → không rò email nào đã có tài khoản. Đăng nhập ở /account/login.
 *  - Login: verifyPassword LUÔN chạy (DUMMY_HASH) → chống enumeration qua timing; lỗi chung.
 *  - Phiên tách hoàn toàn seller (cookie/bảng/role khác); status='active' mới nhận phiên.
 *  - resolveShop CHỈ domain đã verify → chống Host giả (link poisoning ở commit sau).
 */
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import Redis from 'ioredis';
import { hashPassword, verifyPassword } from '../../../packages/auth/src/password.js';
import { generateToken, hashToken } from '../../../packages/auth/src/tokens.js';
import { hit, reset as resetRate } from '../../../packages/auth/src/ratelimit.js';
import { passwordError } from '../../../packages/auth/src/password-policy.js';
import { send, sendHtml, redirect, readForm, parseCookies, sameOrigin, clientIp,
  CUSTOMER_COOKIE, setCustomerCookie, clearCustomerCookie } from './http.js';
import * as V from './views.js';
// Công thức CÒN NỢ KHÁCH dùng chung (bind-mount /app/owed.js) — xem packages/orders/src/owed.js.
import { OWED_SQL, OWED_PAID_SQL, OWED_REFUNDED_SQL } from '../owed.js';
import { PROVINCES, isProvince } from './provinces.js';

const PORT = Number(process.env.PORT ?? 3062);
const SESSION_TTL_MS = Number(process.env.CUST_SESSION_TTL_HOURS ?? 720) * 3600_000; // 30 ngày
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379', { maxRetriesPerRequest: 2, lazyConnect: false });
redis.on('error', () => {}); // fail-open rate-limit (Argon2 là sàn tự nhiên) — log nơi khác

const log = (level, event, extra = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level, service: 'account', event, ...extra }));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// UUID CHẶT (không phải /^[0-9a-f-]{36}$/ lỏng): chuỗi 36 gạch nối lọt regex lỏng rồi rơi
// xuống Postgres thành 22P02 → 500. Yêu thích (0100) nhận product_id từ form công khai.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Base URL ảnh public (giống storefront/seller) — thumbnail trong trang Yêu thích.
const MEDIA_PUBLIC_BASE = process.env.MEDIA_PUBLIC_BASE ?? '/media-public';
// Hash "mồi" để login LUÔN tốn ~1 Argon2 dù không có khách (chống enumeration qua timing).
let DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$ZmFrZXNhbHRmYWtlc2FsdA$3v8Iih6q6z0Yk3wKQ0Xw0aQ0aQ0aQ0aQ0aQ0aQ0aQ0';
hashPassword('dummy-' + generateToken()).then((h) => { DUMMY_HASH = h; }).catch(() => {});

// ── tenant + phiên ───────────────────────────────────────────────────────────
async function resolveShop(hostname) {
  if (!hostname) return null;
  const { rows } = await db.query(`SELECT shop_id FROM domains WHERE hostname = $1 AND verified_at IS NOT NULL`, [hostname]);
  return rows[0]?.shop_id ?? null;
}
async function withShop(shopId, fn) {
  const c = await db.connect();
  try { await c.query('BEGIN'); await c.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
async function withCustomer(shopId, customerId, fn, { claimToken } = {}) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);
    await c.query(`SELECT set_config('app.customer_id', $1, true)`, [customerId]);
    if (claimToken) await c.query(`SELECT set_config('app.claim_token_hash', $1, true)`, [claimToken]);
    const r = await fn(c); await c.query('COMMIT'); return r;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
const shopName = (shopId) => withShop(shopId, async (c) => (await c.query(`SELECT name FROM shops WHERE id = current_shop_id()`)).rows[0]?.name ?? null).catch(() => null);

// Phiên hợp lệ + khách status='active' (nice-to-have red-team: khách bị vô hiệu/ẩn danh → phiên chết).
async function loadCustomer(shopId, token) {
  if (!token) return null;
  return withShop(shopId, async (c) => (await c.query(
    `SELECT cu.id, cu.email, cu.full_name, cu.phone, cu.email_verified_at, cu.status, s.id AS session_id
       FROM customer_sessions s JOIN customers cu ON cu.id = s.customer_id
      WHERE s.token_hash = $1 AND s.shop_id = current_shop_id() AND s.revoked_at IS NULL AND s.expires_at > now() AND cu.status = 'active'`,
    [sha256(token)])).rows[0] ?? null).catch(() => null);
}
async function mintSession(c, customerId, ip, ua) {
  const token = generateToken();
  await c.query(
    `INSERT INTO customer_sessions (shop_id, customer_id, token_hash, expires_at, ip, user_agent)
     VALUES (current_shop_id(), $1, $2, now() + ($3 || ' milliseconds')::interval, $4, $5)`,
    [customerId, sha256(token), String(SESSION_TTL_MS), ip, (ua ?? '').slice(0, 300)]);
  return token;
}

// ── handlers ─────────────────────────────────────────────────────────────────
async function pageLogin(req, res, ctx, q) {
  return sendHtml(res, 200, V.renderLogin(ctx.shopName, { error: q.get('e') ? 'Email hoặc mật khẩu không đúng.' : null, notice: q.get('bye') ? 'Bạn đã đăng xuất.' : null }));
}
async function pageRegister(req, res, ctx) {
  return sendHtml(res, 200, V.renderRegister(ctx.shopName));
}

async function doRegister(req, res, ctx) {
  if (!sameOrigin(req)) return send(res, 403, { error: 'origin' });
  const f = await readForm(req);
  const email = String(f.email ?? '').trim().toLowerCase();
  const password = String(f.password ?? '');
  const fullName = String(f.full_name ?? '').trim().slice(0, 120) || null;
  // Rate-limit theo IP TRƯỚC Argon2 (chống nhồi đăng ký). Key có shop.
  const rl = await hit(redis, `rl:cust:register:ip:${ctx.shopId}:${ctx.ip}`, { limit: 10, windowSec: 3600 }).catch(() => ({ allowed: true }));
  if (!rl.allowed) return sendHtml(res, 429, V.renderRegister(ctx.shopName, { error: 'Quá nhiều lần thử, vui lòng đợi ít phút.', form: f }));
  if (!EMAIL_RE.test(email)) return sendHtml(res, 400, V.renderRegister(ctx.shopName, { error: 'Email không hợp lệ.', form: f }));
  const pwErr = passwordError(password, { shopName: ctx.shopName });
  if (pwErr) return sendHtml(res, 400, V.renderRegister(ctx.shopName, { error: pwErr[0].toUpperCase() + pwErr.slice(1) + '.', form: f }));
  // Hash TRƯỚC (cả nhánh trùng email cũng trả cùng thời gian ~1 Argon2). INSERT; 23505 (email đã
  // có) → NUỐT, trả trang trung tính Y HỆT (must-fix #3: không rò email nào đã đăng ký, KHÔNG auto-login).
  const hash = await hashPassword(password);
  try {
    await withShop(ctx.shopId, async (c) => {
      const cu = (await c.query(
        `INSERT INTO customers (shop_id, email, password_hash, full_name) VALUES (current_shop_id(), $1, $2, $3) RETURNING id`,
        [email, hash, fullName])).rows[0];
      await issueVerify(c, ctx, cu.id, email); // token verify + outbox — cùng tx (ADR-006)
    });
    log('info', 'customer_registered', { shop: ctx.shopId });
  } catch (e) { if (e.code !== '23505') throw e; /* email đã tồn tại → trang trung tính, không gửi gì */ }
  return sendHtml(res, 200, V.renderRegisterDone(ctx.shopName));
}

// ── quên / đặt lại mật khẩu + xác minh email ─────────────────────────────────
const RESET_TTL_MS = 30 * 60_000, VERIFY_TTL_MS = 24 * 3600_000, FORGOT_FLOOR_MS = 500;
const linkOf = (ctx, path) => `https://${ctx.host}${path}`;
// Tạo token verify email + đẩy outbox (worker gửi). Dùng lúc đăng ký + gửi-lại.
async function issueVerify(c, ctx, customerId, email) {
  const token = generateToken();
  await c.query(`INSERT INTO customer_email_verifications (shop_id, customer_id, token_hash, expires_at) VALUES (current_shop_id(), $1, $2, now() + ($3||' ms')::interval)`, [customerId, sha256(token), String(VERIFY_TTL_MS)]);
  await c.query(`INSERT INTO outbox (shop_id, topic, payload) VALUES (current_shop_id(), 'customer.email_verify', $1)`,
    [{ to: email, shop_name: ctx.shopName, link: linkOf(ctx, `/account/verify?token=${token}`) }]);
}

async function pageForgot(req, res, ctx) { return sendHtml(res, 200, V.renderForgot(ctx.shopName)); }
async function doForgot(req, res, ctx) {
  if (!sameOrigin(req)) return send(res, 403, { error: 'origin' });
  const t0 = Date.now();
  const f = await readForm(req);
  const email = String(f.email ?? '').trim().toLowerCase();
  const rl = await hit(redis, `rl:cust:forgot:ip:${ctx.shopId}:${ctx.ip}`, { limit: 10, windowSec: 3600 }).catch(() => ({ allowed: true }));
  if (rl.allowed && EMAIL_RE.test(email)) {
    await withShop(ctx.shopId, async (c) => {
      const cu = (await c.query(`SELECT id FROM customers WHERE shop_id = current_shop_id() AND lower(email) = $1 AND status = 'active'`, [email])).rows[0];
      if (!cu) return;
      const token = generateToken();
      await c.query(`INSERT INTO customer_password_reset_tokens (shop_id, customer_id, token_hash, expires_at) VALUES (current_shop_id(), $1, $2, now() + ($3||' ms')::interval)`, [cu.id, sha256(token), String(RESET_TTL_MS)]);
      await c.query(`INSERT INTO outbox (shop_id, topic, payload) VALUES (current_shop_id(), 'customer.password_reset', $1)`,
        [{ to: email, shop_name: ctx.shopName, link: linkOf(ctx, `/account/reset?token=${token}`) }]);
    }).catch(() => {});
  }
  const wait = FORGOT_FLOOR_MS - (Date.now() - t0);       // sàn thời gian → chống enumeration qua timing
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  return sendHtml(res, 200, V.renderForgot(ctx.shopName, { sent: true }));
}
async function pageReset(req, res, ctx, q) {
  const token = String(q.get('token') ?? '');
  const valid = token && await withShop(ctx.shopId, (c) => c.query(
    `SELECT 1 FROM customer_password_reset_tokens WHERE shop_id = current_shop_id() AND token_hash = $1 AND used_at IS NULL AND expires_at > now()`, [sha256(token)]).then((r) => r.rowCount === 1)).catch(() => false);
  return sendHtml(res, valid ? 200 : 400, V.renderReset(ctx.shopName, token, { invalid: !valid }));
}
async function doReset(req, res, ctx) {
  if (!sameOrigin(req)) return send(res, 403, { error: 'origin' });
  const f = await readForm(req);
  const token = String(f.token ?? ''), password = String(f.password ?? '');
  const pwErr = passwordError(password, { shopName: ctx.shopName });
  if (pwErr) return sendHtml(res, 400, V.renderReset(ctx.shopName, token, { error: pwErr[0].toUpperCase() + pwErr.slice(1) + '.' }));
  const hash = await hashPassword(password);
  const custId = await withShop(ctx.shopId, async (c) => {
    // Token DÙNG-MỘT-LẦN atomic (UPDATE ... WHERE used_at IS NULL RETURNING) → chống đua/replay.
    const r = await c.query(`UPDATE customer_password_reset_tokens SET used_at = now() WHERE shop_id = current_shop_id() AND token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING customer_id`, [sha256(token)]);
    return r.rows[0]?.customer_id ?? null;
  });
  if (!custId) return sendHtml(res, 400, V.renderReset(ctx.shopName, token, { invalid: true }));
  await withCustomer(ctx.shopId, custId, async (c) => {
    // Đổi MK + đánh dấu email đã xác minh (token email = bằng chứng sở hữu) + THU HỒI MỌI phiên.
    await c.query(`UPDATE customers SET password_hash = $1, email_verified_at = coalesce(email_verified_at, now()), updated_at = now() WHERE id = current_customer_id()`, [hash]);
    await c.query(`UPDATE customer_sessions SET revoked_at = now() WHERE customer_id = current_customer_id() AND revoked_at IS NULL`);
  });
  return sendHtml(res, 200, V.renderLogin(ctx.shopName, { notice: 'Đã đổi mật khẩu. Vui lòng đăng nhập lại.' }));
}
async function pageVerify(req, res, ctx, q) {
  const token = String(q.get('token') ?? '');
  const custId = token && await withShop(ctx.shopId, (c) => c.query(
    `UPDATE customer_email_verifications SET verified_at = now() WHERE shop_id = current_shop_id() AND token_hash = $1 AND verified_at IS NULL AND expires_at > now() RETURNING customer_id`, [sha256(token)]).then((r) => r.rows[0]?.customer_id ?? null)).catch(() => null);
  if (custId) await withCustomer(ctx.shopId, custId, (c) => c.query(`UPDATE customers SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = current_customer_id()`)).catch(() => {});
  return sendHtml(res, custId ? 200 : 400, V.renderVerified(ctx.shopName, { ok: !!custId }));
}
async function doResendVerify(req, res, ctx) {
  if (!sameOrigin(req)) return send(res, 403, { error: 'origin' });
  if (!ctx.customer) return redirect(res, '/account/login');
  if (!ctx.customer.email_verified_at && ctx.customer.email) {
    const rl = await hit(redis, `rl:cust:verify:${ctx.shopId}:${ctx.customer.id}`, { limit: 5, windowSec: 3600 }).catch(() => ({ allowed: true }));
    if (rl.allowed) await withShop(ctx.shopId, (c) => issueVerify(c, ctx, ctx.customer.id, ctx.customer.email)).catch(() => {});
  }
  return redirect(res, '/account?sent=1');
}

async function doLogin(req, res, ctx) {
  if (!sameOrigin(req)) return send(res, 403, { error: 'origin' });
  const f = await readForm(req);
  const email = String(f.email ?? '').trim().toLowerCase();
  const password = String(f.password ?? '');
  const ipRl = await hit(redis, `rl:cust:login:ip:${ctx.shopId}:${ctx.ip}`, { limit: 20, windowSec: 900 }).catch(() => ({ allowed: true }));
  if (!ipRl.allowed) return sendHtml(res, 429, V.renderLogin(ctx.shopName, { error: 'Quá nhiều lần thử, vui lòng đợi.' }));
  const acctKey = `rl:cust:login:acctfail:${ctx.shopId}:${email}`;
  const acctRl = await hit(redis, acctKey, { limit: 10, windowSec: 900 }).catch(() => ({ allowed: true }));
  // Tra khách (pre-auth: cid NULL → shop-scoped). verifyPassword LUÔN chạy (DUMMY_HASH nếu vắng).
  const cust = await withShop(ctx.shopId, async (c) => (await c.query(
    `SELECT id, password_hash, status FROM customers WHERE shop_id = current_shop_id() AND lower(email) = $1 AND email IS NOT NULL`, [email])).rows[0] ?? null);
  const okPw = await verifyPassword(cust?.password_hash ?? DUMMY_HASH, password);
  if (!cust || !okPw || cust.status !== 'active' || !acctRl.allowed) {
    return sendHtml(res, 401, V.renderLogin(ctx.shopName, { error: 'Email hoặc mật khẩu không đúng.' }));
  }
  await resetRate(redis, acctKey).catch(() => {});
  const token = await withCustomer(ctx.shopId, cust.id, async (c) => {
    await c.query(`UPDATE customers SET last_login_at = now() WHERE id = current_customer_id()`);
    return mintSession(c, cust.id, ctx.ip, req.headers['user-agent']);
  });
  setCustomerCookie(res, token, Math.floor(SESSION_TTL_MS / 1000));
  return redirect(res, '/account');
}

async function doLogout(req, res, ctx) {
  if (!sameOrigin(req)) return send(res, 403, { error: 'origin' });
  if (ctx.customer) await withCustomer(ctx.shopId, ctx.customer.id, (c) =>
    c.query(`UPDATE customer_sessions SET revoked_at = now() WHERE id = $1 AND customer_id = current_customer_id()`, [ctx.customer.session_id])).catch(() => {});
  clearCustomerCookie(res);
  return redirect(res, '/account/login?bye=1');
}

async function pageDashboard(req, res, ctx, q) {
  if (!ctx.customer) return redirect(res, '/account/login');
  // Điểm thưởng (0086): chỉ hiện thẻ khi shop BẬT chương trình. Lỗi đọc → nuốt (không sập dashboard).
  const loyalty = await withCustomer(ctx.shopId, ctx.customer.id, async (c) => {
    const cfg = (await c.query(`SELECT enabled FROM shop_loyalty_config WHERE shop_id = current_shop_id()`)).rows[0];
    if (!cfg?.enabled) return null;
    const bal = (await c.query(`SELECT balance_points FROM loyalty_balances WHERE customer_id = current_customer_id()`)).rows[0];
    return { balance: Math.max(0, bal ? Number(bal.balance_points) : 0) };
  }).catch(() => null);
  return sendHtml(res, 200, V.renderDashboard(ctx.shopName, ctx.customer, { notice: q.get('sent') === '1' ? 'Đã gửi lại email xác minh.' : null, loyalty }));
}

// ── lịch sử đơn (RLS customer_orders_read: CHỈ đơn của mình) ──────────────────
const PAGE = 15;
async function pageOrders(req, res, ctx, q) {
  if (!ctx.customer) return redirect(res, '/account/login');
  const page = Math.min(200, Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1));
  const rows = await withCustomer(ctx.shopId, ctx.customer.id, (c) => c.query(
    `SELECT order_number, status, total_vnd, created_at FROM orders
      WHERE customer_id = current_customer_id() ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [PAGE + 1, (page - 1) * PAGE]).then((r) => r.rows));
  const notice = q.get('claimed') === '1' ? 'Đã nhận đơn vào tài khoản.' : null;
  return sendHtml(res, 200, V.renderOrders(ctx.shopName, rows.slice(0, PAGE), { page, hasMore: rows.length > PAGE, notice }));
}
// ── Điểm thưởng (0086): số dư + lịch sử (RLS 2 trục self-scoped) ──────────────
async function pagePoints(req, res, ctx, q) {
  if (!ctx.customer) return redirect(res, '/account/login');
  const page = Math.min(200, Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1));
  const out = await withCustomer(ctx.shopId, ctx.customer.id, async (c) => {
    const cfg = (await c.query(`SELECT enabled, redeem_vnd_per_point FROM shop_loyalty_config WHERE shop_id = current_shop_id()`)).rows[0];
    const bal = (await c.query(`SELECT balance_points FROM loyalty_balances WHERE customer_id = current_customer_id()`)).rows[0];
    const rows = (await c.query(
      `SELECT kind, delta, created_at FROM loyalty_ledger WHERE customer_id = current_customer_id()
        ORDER BY id DESC LIMIT $1 OFFSET $2`, [PAGE + 1, (page - 1) * PAGE])).rows;
    return { cfg, balance: bal ? Number(bal.balance_points) : 0, rows };
  });
  if (!out.cfg?.enabled && out.balance === 0 && out.rows.length === 0) return redirect(res, '/account'); // shop không dùng điểm
  return sendHtml(res, 200, V.renderPoints(ctx.shopName, {
    balance: Math.max(0, out.balance), // hiển thị clamp ≥0 (nợ điểm không hiện âm)
    perPoint: Number(out.cfg?.redeem_vnd_per_point ?? 0),
    rows: out.rows.slice(0, PAGE), page, hasMore: out.rows.length > PAGE,
  }));
}
async function pageOrderDetail(req, res, ctx, q, params) {
  if (!ctx.customer) return redirect(res, '/account/login');
  const num = parseInt(params[0], 10);
  const out = await withCustomer(ctx.shopId, ctx.customer.id, async (c) => {
    const o = (await c.query(
      // TIỀN (0146): đã thu / đã hoàn / còn phải hoàn. `owed_vnd` dùng CHUNG biểu thức với
      // trang quản trị và trang tra cứu (packages/orders owed.js) — khách và shop phải đọc
      // cùng một con số, nếu không cuộc gọi khiếu nại bắt đầu bằng hai màn hình cãi nhau.
      `SELECT o.id, o.order_number, o.status, o.payment_status, o.subtotal_vnd, o.shipping_vnd,
              o.discount_vnd, o.total_vnd, ${OWED_PAID_SQL} AS amount_paid_vnd,
              o.customer_name, o.customer_phone, o.shipping_address, o.created_at,
              ${OWED_REFUNDED_SQL} AS refunded_vnd, ${OWED_SQL} AS owed_vnd,
              (SELECT max(r.created_at) FROM refunds r WHERE r.order_id = o.id) AS last_refund_at
         FROM orders o WHERE o.customer_id = current_customer_id() AND o.order_number = $1`, [num])).rows[0];
    if (!o) return null;
    o.amount_paid_vnd = Number(o.amount_paid_vnd); o.refunded_vnd = Number(o.refunded_vnd); o.owed_vnd = Number(o.owed_vnd);
    const lines = (await c.query(`SELECT title_snapshot, sku_snapshot, unit_price_vnd, qty FROM order_lines WHERE order_id = $1`, [o.id])).rows;
    // Mã vận đơn (0092) → khách tự tra GHN/GHTK ngay trong tài khoản. BỎ vận đơn đã huỷ:
    // nút "Tra cứu vận đơn →" trỏ thẳng sang trang hãng, mã đã huỷ thì ra trang trống.
    // Mirror apps/checkout/src/server.js (trang tra cứu đơn) — cùng một lời hứa với khách.
    const shipments = (await c.query(`SELECT carrier, tracking_number, status FROM shipments WHERE order_id = $1 AND tracking_number IS NOT NULL AND status <> 'cancelled' ORDER BY created_at`, [o.id])).rows;
    return { o, lines, shipments };
  });
  if (!out) return sendHtml(res, 404, '<!doctype html><meta charset=utf-8><title>404</title><p>Không tìm thấy đơn.</p>');
  return sendHtml(res, 200, V.renderOrderDetail(ctx.shopName, out.o, out.lines, out.shipments));
}
// "Nhận đơn cũ": UPDATE mù gate bằng GUC claim_token_hash (RLS chỉ hiện dòng đúng token).
async function doClaim(req, res, ctx) {
  if (!sameOrigin(req)) return send(res, 403, { error: 'origin' });
  if (!ctx.customer) return redirect(res, '/account/login');
  const f = await readForm(req);
  const num = parseInt(String(f.order_number ?? '').replace(/\D/g, ''), 10);
  const token = String(f.token ?? '').trim();
  const rl = await hit(redis, `rl:cust:claim:${ctx.shopId}:${ctx.customer.id}`, { limit: 20, windowSec: 900 }).catch(() => ({ allowed: true }));
  if (!rl.allowed || !Number.isInteger(num) || !token) return redirect(res, '/account/orders');
  await withCustomer(ctx.shopId, ctx.customer.id, (c) => c.query(
    `UPDATE orders SET customer_id = current_customer_id()
      WHERE order_number = $1 AND customer_id IS NULL AND lookup_token_hash = current_claim_token_hash()`, [num]),
    { claimToken: sha256(token) }).catch(() => {});
  return redirect(res, '/account/orders?claimed=1'); // KHÔNG lộ thành/bại (chống dò)
}

// ── sổ địa chỉ (RLS customer_addr: customer-scoped) ──────────────────────────
async function pageAddresses(req, res, ctx, q) {
  if (!ctx.customer) return redirect(res, '/account/login');
  const editId = q.get('edit');
  const out = await withCustomer(ctx.shopId, ctx.customer.id, async (c) => {
    const list = (await c.query(`SELECT id, recipient_name, phone, line1, ward, district, province, is_default FROM customer_addresses WHERE customer_id = current_customer_id() ORDER BY is_default DESC, created_at`)).rows;
    const editing = editId ? list.find((a) => a.id === editId) ?? null : null;
    return { list, editing };
  });
  return sendHtml(res, 200, V.renderAddresses(ctx.shopName, out.list, PROVINCES, { editing: out.editing }));
}
// ── YÊU THÍCH (0100) ─────────────────────────────────────────────────────────
// Gắn với TÀI KHOẢN, không phải cookie: yêu thích mà mất khi đổi máy thì vô nghĩa.
// TOGGLE: đã thích → bỏ thích. Một endpoint, không cần nút "bỏ thích" riêng.
//
// Chưa đăng nhập → nhớ SP rồi đẩy sang đăng nhập; đăng nhập xong quay lại đúng trang SP
// (không thì khách mất dấu và phải tự tìm lại sản phẩm).
async function wishlistToggle(req, res, ctx) {
  if (!sameOrigin(req)) return send(res, 403, { error: 'origin' });
  const f = await readForm(req);
  const productId = String(f.product_id ?? '');
  const slug = String(f.slug ?? '').slice(0, 80);
  const backTo = /^[a-z0-9-]+$/.test(slug) ? `/p/${slug}` : '/account/wishlist';
  if (!UUID_RE.test(productId)) return redirect(res, backTo);
  if (!ctx.customer) return redirect(res, `/account/login?next=${encodeURIComponent(backTo)}`);
  const added = await withCustomer(ctx.shopId, ctx.customer.id, async (c) => {
    // Xoá trước; xoá được 0 dòng nghĩa là CHƯA thích → thêm vào. Hai lệnh trong CÙNG
    // transaction của withCustomer nên không có khe hở đua giữa xoá và thêm.
    const del = await c.query(
      `DELETE FROM wishlist_items WHERE customer_id = current_customer_id() AND product_id = $1`, [productId]);
    if (del.rowCount > 0) return false;
    // SELECT từ products: SP không tồn tại/khác shop thì INSERT không sinh dòng nào (FK an
    // toàn + không cần bắt lỗi 23503).
    await c.query(
      `INSERT INTO wishlist_items (shop_id, customer_id, product_id)
       SELECT current_shop_id(), current_customer_id(), p.id FROM products p
        WHERE p.id = $1 AND p.deleted_at IS NULL
       ON CONFLICT DO NOTHING`, [productId]);
    return true;
  });
  return redirect(res, `${backTo}?wish=${added ? 'added' : 'removed'}`);
}

async function pageWishlist(req, res, ctx) {
  if (!ctx.customer) return redirect(res, '/account/login?next=%2Faccount%2Fwishlist');
  const rows = await withCustomer(ctx.shopId, ctx.customer.id, async (c) => (await c.query(
    // JOIN products: SP bị ẩn/xoá mềm thì KHÔNG hiện (khách bấm vào sẽ 404). Ảnh lấy như
    // mọi nơi khác: media 'ready' đầu tiên theo position.
    `SELECT p.id, p.slug, p.title, p.price_vnd, w.created_at,
            (SELECT m.public_key FROM media m
              WHERE m.product_id = p.id AND m.status = 'ready' AND m.deleted_at IS NULL
              ORDER BY m.position, m.created_at LIMIT 1) AS image_key
       FROM wishlist_items w JOIN products p ON p.id = w.product_id
      WHERE w.customer_id = current_customer_id() AND p.deleted_at IS NULL AND p.status = 'active'
      ORDER BY w.created_at DESC LIMIT 100`)).rows);
  const items = rows.map((r) => ({ ...r, image_url: r.image_key ? `${MEDIA_PUBLIC_BASE}/${r.image_key}` : null }));
  return sendHtml(res, 200, V.renderWishlist(ctx.shopName, items));
}

function parseAddr(f) {
  const a = {
    recipient_name: String(f.recipient_name ?? '').trim().slice(0, 120),
    phone: String(f.phone ?? '').trim().slice(0, 20),
    line1: String(f.line1 ?? '').trim().slice(0, 200),
    ward: String(f.ward ?? '').trim().slice(0, 100) || null,
    district: String(f.district ?? '').trim().slice(0, 100) || null,
    province: String(f.province ?? '').trim() || null,
    is_default: f.is_default === '1' || f.is_default === 'on',
  };
  if (!a.recipient_name || !a.phone || !a.line1) return { error: 'Vui lòng nhập người nhận, số điện thoại và địa chỉ.' };
  if (a.province && !isProvince(a.province)) return { error: 'Tỉnh/thành không hợp lệ.' };
  return { a };
}
// Đặt is_default: bỏ default cũ TRƯỚC rồi set mới (unique index one_default bảo vệ) — trong tx.
async function setDefaultTx(c, addrId) {
  await c.query(`UPDATE customer_addresses SET is_default = false WHERE customer_id = current_customer_id() AND is_default AND id <> $1`, [addrId]);
  await c.query(`UPDATE customer_addresses SET is_default = true WHERE id = $1 AND customer_id = current_customer_id()`, [addrId]);
}
async function addressAdd(req, res, ctx) {
  if (!sameOrigin(req)) return send(res, 403, { error: 'origin' });
  if (!ctx.customer) return redirect(res, '/account/login');
  const f = await readForm(req);
  const p = parseAddr(f);
  if (p.error) return withAddrList(res, ctx, { error: p.error, form: f });
  await withCustomer(ctx.shopId, ctx.customer.id, async (c) => {
    const r = await c.query(
      `INSERT INTO customer_addresses (shop_id, customer_id, recipient_name, phone, line1, ward, district, province)
       VALUES (current_shop_id(), current_customer_id(), $1,$2,$3,$4,$5,$6) RETURNING id`,
      [p.a.recipient_name, p.a.phone, p.a.line1, p.a.ward, p.a.district, p.a.province]);
    if (p.a.is_default) await setDefaultTx(c, r.rows[0].id);
  });
  return redirect(res, '/account/addresses');
}
async function addressEdit(req, res, ctx) {
  if (!sameOrigin(req)) return send(res, 403, { error: 'origin' });
  if (!ctx.customer) return redirect(res, '/account/login');
  const f = await readForm(req);
  const id = String(f.id ?? '');
  const p = parseAddr(f);
  if (p.error) return withAddrList(res, ctx, { error: p.error, form: f, editId: id });
  await withCustomer(ctx.shopId, ctx.customer.id, async (c) => {
    const r = await c.query(
      `UPDATE customer_addresses SET recipient_name=$2, phone=$3, line1=$4, ward=$5, district=$6, province=$7, updated_at=now()
        WHERE id=$1 AND customer_id = current_customer_id()`,
      [id, p.a.recipient_name, p.a.phone, p.a.line1, p.a.ward, p.a.district, p.a.province]);
    if (r.rowCount === 1 && p.a.is_default) await setDefaultTx(c, id);
  });
  return redirect(res, '/account/addresses');
}
async function addressDelete(req, res, ctx) {
  if (!sameOrigin(req)) return send(res, 403, { error: 'origin' });
  if (!ctx.customer) return redirect(res, '/account/login');
  const f = await readForm(req);
  await withCustomer(ctx.shopId, ctx.customer.id, (c) => c.query(`DELETE FROM customer_addresses WHERE id=$1 AND customer_id = current_customer_id()`, [String(f.id ?? '')])).catch(() => {});
  return redirect(res, '/account/addresses');
}
async function addressDefault(req, res, ctx) {
  if (!sameOrigin(req)) return send(res, 403, { error: 'origin' });
  if (!ctx.customer) return redirect(res, '/account/login');
  const f = await readForm(req);
  await withCustomer(ctx.shopId, ctx.customer.id, (c) => setDefaultTx(c, String(f.id ?? ''))).catch(() => {});
  return redirect(res, '/account/addresses');
}
// Dựng lại trang địa chỉ kèm lỗi form (không mất dữ liệu đã nhập).
async function withAddrList(res, ctx, { error, form, editId } = {}) {
  const out = await withCustomer(ctx.shopId, ctx.customer.id, (c) => c.query(`SELECT id, recipient_name, phone, line1, ward, district, province, is_default FROM customer_addresses WHERE customer_id = current_customer_id() ORDER BY is_default DESC, created_at`).then((r) => r.rows));
  const editing = editId ? { id: editId, ...form } : null;
  return sendHtml(res, 400, V.renderAddresses(ctx.shopName, out, PROVINCES, { editing, form, error }));
}

// ── router ───────────────────────────────────────────────────────────────────
const ROUTES = [
  { m: 'GET', re: /^\/account\/login$/, fn: pageLogin, auth: false },
  { m: 'POST', re: /^\/account\/login$/, fn: doLogin, auth: false },
  { m: 'GET', re: /^\/account\/register$/, fn: pageRegister, auth: false },
  { m: 'POST', re: /^\/account\/register$/, fn: doRegister, auth: false },
  { m: 'POST', re: /^\/account\/logout$/, fn: doLogout, auth: false },
  { m: 'GET', re: /^\/account\/forgot$/, fn: pageForgot, auth: false },
  { m: 'POST', re: /^\/account\/forgot$/, fn: doForgot, auth: false },
  { m: 'GET', re: /^\/account\/reset$/, fn: pageReset, auth: false },
  { m: 'POST', re: /^\/account\/reset$/, fn: doReset, auth: false },
  { m: 'GET', re: /^\/account\/verify$/, fn: pageVerify, auth: false },
  { m: 'POST', re: /^\/account\/resend-verify$/, fn: doResendVerify, auth: false },
  { m: 'GET', re: /^\/account\/orders$/, fn: pageOrders },
  { m: 'GET', re: /^\/account\/points$/, fn: pagePoints },
  { m: 'GET', re: /^\/account\/orders\/(\d+)$/, fn: pageOrderDetail },
  { m: 'POST', re: /^\/account\/claim$/, fn: doClaim },
  { m: 'GET', re: /^\/account\/wishlist$/, fn: pageWishlist },
  { m: 'POST', re: /^\/account\/wishlist\/toggle$/, fn: wishlistToggle, auth: false },
  { m: 'GET', re: /^\/account\/addresses$/, fn: pageAddresses },
  { m: 'POST', re: /^\/account\/addresses\/add$/, fn: addressAdd },
  { m: 'POST', re: /^\/account\/addresses\/edit$/, fn: addressEdit },
  { m: 'POST', re: /^\/account\/addresses\/delete$/, fn: addressDelete },
  { m: 'POST', re: /^\/account\/addresses\/default$/, fn: addressDefault },
  { m: 'GET', re: /^\/account\/?$/, fn: pageDashboard, auth: false },
];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    if (path === '/healthz') return send(res, 200, { ok: true });
    const host = (req.headers.host ?? '').split(':')[0];
    const shopId = await resolveShop(host);
    if (!shopId) return sendHtml(res, 404, '<!doctype html><meta charset=utf-8><title>Không tìm thấy</title><p>Cửa hàng không tồn tại.</p>');
    let route, m;
    for (const r of ROUTES) { if (r.m === req.method && (m = r.re.exec(path))) { route = r; break; } }
    if (!route) return sendHtml(res, 404, '<!doctype html><meta charset=utf-8><title>404</title><p>Không tìm thấy trang.</p>');
    const cookies = parseCookies(req);
    const customer = await loadCustomer(shopId, cookies[CUSTOMER_COOKIE]);
    const ctx = { shopId, host, ip: clientIp(req), customer, shopName: await shopName(shopId) };
    return await route.fn(req, res, ctx, url.searchParams, m.slice(1));
  } catch (e) {
    log('error', 'handler_error', { message: e.message, path: req.url });
    if (!res.headersSent) return send(res, 500, { error: 'lỗi hệ thống' });
    res.end();
  }
});
server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT }));
