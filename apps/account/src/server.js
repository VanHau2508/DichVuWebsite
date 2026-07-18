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

const PORT = Number(process.env.PORT ?? 3062);
const SESSION_TTL_MS = Number(process.env.CUST_SESSION_TTL_HOURS ?? 720) * 3600_000; // 30 ngày
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379', { maxRetriesPerRequest: 2, lazyConnect: false });
redis.on('error', () => {}); // fail-open rate-limit (Argon2 là sàn tự nhiên) — log nơi khác

const log = (level, event, extra = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level, service: 'account', event, ...extra }));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
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
    await withShop(ctx.shopId, (c) => c.query(
      `INSERT INTO customers (shop_id, email, password_hash, full_name) VALUES (current_shop_id(), $1, $2, $3)`,
      [email, hash, fullName]));
    log('info', 'customer_registered', { shop: ctx.shopId });
  } catch (e) { if (e.code !== '23505') throw e; /* email đã tồn tại → trang trung tính */ }
  // TODO commit 3: gửi email verify (mới) / nhắc đăng nhập (đã có). Trang trung tính cho cả hai.
  return sendHtml(res, 200, V.renderRegisterDone(ctx.shopName));
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

async function pageDashboard(req, res, ctx) {
  if (!ctx.customer) return redirect(res, '/account/login');
  return sendHtml(res, 200, V.renderDashboard(ctx.shopName, ctx.customer));
}

// ── router ───────────────────────────────────────────────────────────────────
const ROUTES = [
  { m: 'GET', re: /^\/account\/login$/, fn: pageLogin, auth: false },
  { m: 'POST', re: /^\/account\/login$/, fn: doLogin, auth: false },
  { m: 'GET', re: /^\/account\/register$/, fn: pageRegister, auth: false },
  { m: 'POST', re: /^\/account\/register$/, fn: doRegister, auth: false },
  { m: 'POST', re: /^\/account\/logout$/, fn: doLogout, auth: false },
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
    const route = ROUTES.find((r) => r.m === req.method && r.re.test(path));
    if (!route) return sendHtml(res, 404, '<!doctype html><meta charset=utf-8><title>404</title><p>Không tìm thấy trang.</p>');
    const cookies = parseCookies(req);
    const customer = await loadCustomer(shopId, cookies[CUSTOMER_COOKIE]);
    const ctx = { shopId, ip: clientIp(req), customer, shopName: await shopName(shopId) };
    return await route.fn(req, res, ctx, url.searchParams);
  } catch (e) {
    log('error', 'handler_error', { message: e.message, path: req.url });
    if (!res.headersSent) return send(res, 500, { error: 'lỗi hệ thống' });
    res.end();
  }
});
server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT }));
