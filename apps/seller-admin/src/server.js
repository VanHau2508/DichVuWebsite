/**
 * Admin web (BFF) cho nhà bán hàng. SSR form thuần, KHÔNG JS.
 *
 * Trình duyệt CHỈ nói chuyện với service này (Caddy: admin.nentang.vn → seller-admin).
 * Nó cầm cookie phiên của trình duyệt, gọi NỘI BỘ auth/seller/platform (forward cookie +
 * Origin admin), rồi render HTML. Không đụng DB trực tiếp — mọi RBAC/step-up do backend lo.
 *
 * Bảo mật: CSP không script; mọi POST đổi trạng thái + sameOrigin (Origin thuộc allowlist).
 */
import http from 'node:http';
import { parseCookies, readForm, sendHtml, redirect, sameOrigin, SESSION_COOKIE } from './http.js';
import { authApi, sellerApi, loadSession } from './api.js';
import * as V from './pages.js';

const PORT = Number(process.env.PORT ?? 3001);
const ALLOWED = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (ALLOWED.length === 0) throw new Error('thiếu ALLOWED_ORIGINS');
const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const log = (level, event, f = {}) => process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...f }) + '\n');

const isMember = (me, shopId) => (me.memberships ?? []).some((m) => m.shop_id === shopId);
const shopNameOf = async (shopId, cookie) => { try { return (await sellerApi('GET', `/shops/${shopId}`, { cookie })).json?.name ?? null; } catch { return null; } };
const CLEAR = `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

// ── auth handlers ─────────────────────────────────────────────────────────────
async function handleLogin(req, res) {
  const f = await readForm(req);
  const r = await authApi('POST', '/auth/login', { body: { email: String(f.email ?? '').trim(), password: String(f.password ?? '') } });
  if (r.status === 429) return sendHtml(res, 429, V.renderLogin('Quá nhiều lần thử, vui lòng thử lại sau.'));
  if (r.status !== 200) return sendHtml(res, 401, V.renderLogin('Email hoặc mật khẩu không đúng.'));
  return redirect(res, r.json?.mfa_required ? '/mfa' : '/', r.setCookie ?? []);
}
async function handleMfa(req, res, cookie) {
  const f = await readForm(req);
  const r = await authApi('POST', '/auth/mfa/verify', { cookie, body: { code: String(f.code ?? '').replace(/\s/g, '') } });
  if (r.status !== 200) return sendHtml(res, 401, V.renderMfa('Mã không đúng hoặc đã hết hạn.'));
  return redirect(res, '/', r.setCookie ?? []);
}
async function handleLogout(req, res, cookie) {
  await authApi('POST', '/auth/logout', { cookie }).catch(() => {});
  return redirect(res, '/login', [CLEAR]);
}

// ── authed handlers ───────────────────────────────────────────────────────────
async function dashboard(res, me, cookie) {
  const shops = [];
  for (const mem of me.memberships ?? []) {
    const r = await sellerApi('GET', `/shops/${mem.shop_id}`, { cookie });
    shops.push({ shop_id: mem.shop_id, role: mem.role, name: r.json?.name, status: r.json?.status });
  }
  return sendHtml(res, 200, V.renderDashboard({ user: me }, shops));
}

async function ordersList(res, me, cookie, shopId, q) {
  if (!isMember(me, shopId)) return sendHtml(res, 403, V.renderError({ user: me }, 'Bạn không có quyền với cửa hàng này.'));
  const status = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'refunded'].includes(q.get('status')) ? q.get('status') : '';
  const limit = 20, offset = Math.max(0, parseInt(q.get('offset') ?? '0', 10) || 0);
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) }); if (status) qs.set('status', status);
  const r = await sellerApi('GET', `/shops/${shopId}/orders?${qs}`, { cookie });
  const shopName = await shopNameOf(shopId, cookie);
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError({ user: me, shopName }, r.json?.error ?? 'Không tải được đơn hàng.'));
  return sendHtml(res, 200, V.renderOrders({ user: me, shopName }, shopId, r.json, { status, limit, offset }));
}

async function orderDetail(res, me, cookie, shopId, oid, err) {
  if (!isMember(me, shopId)) return sendHtml(res, 403, V.renderError({ user: me }, 'Bạn không có quyền với cửa hàng này.'));
  const r = await sellerApi('GET', `/shops/${shopId}/orders/${oid}`, { cookie });
  const shopName = await shopNameOf(shopId, cookie);
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError({ user: me, shopName }, r.json?.error ?? 'Không tìm thấy đơn.'));
  return sendHtml(res, err ? 409 : 200, V.renderOrderDetail({ user: me, shopName }, shopId, r.json, err));
}

async function orderAction(req, res, me, cookie, shopId, oid, action) {
  if (!isMember(me, shopId)) return sendHtml(res, 403, V.renderError({ user: me }, 'Bạn không có quyền với cửa hàng này.'));
  let body;
  if (action === 'ship') { const f = await readForm(req); body = { tracking_number: String(f.tracking_number ?? '').trim(), carrier: String(f.carrier ?? '').trim() }; }
  const r = await sellerApi('POST', `/shops/${shopId}/orders/${oid}/${action}`, { cookie, body });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/orders/${oid}`);
  // Lỗi (403 quyền / 409 sai trạng thái / 400) → render lại chi tiết kèm thông báo.
  return orderDetail(res, me, cookie, shopId, oid, r.json?.error ?? 'Thao tác không thực hiện được.');
}

// ── router ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://internal');
  const p = url.pathname;
  if (p === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
  try {
    if (req.method === 'POST' && !sameOrigin(req, ALLOWED)) return sendHtml(res, 403, V.renderError({}, 'Yêu cầu không hợp lệ (origin).'));
    const cookie = parseCookies(req)[SESSION_COOKIE];

    // Trang công khai (auth).
    if (p === '/login' && req.method === 'GET') return (await loadSession(cookie)).state === 'ok' ? redirect(res, '/') : sendHtml(res, 200, V.renderLogin());
    if (p === '/login' && req.method === 'POST') return handleLogin(req, res);
    if (p === '/mfa' && req.method === 'GET') return sendHtml(res, 200, V.renderMfa());
    if (p === '/mfa' && req.method === 'POST') return handleMfa(req, res, cookie);
    if (p === '/logout' && req.method === 'POST') return handleLogout(req, res, cookie);

    // Còn lại: cần phiên ĐẦY ĐỦ.
    const sess = await loadSession(cookie);
    if (sess.state === 'mfa') return redirect(res, '/mfa');
    if (sess.state !== 'ok') return redirect(res, '/login');
    const me = sess.me;

    if (p === '/' && req.method === 'GET') return dashboard(res, me, cookie);
    let m;
    if ((m = new RegExp(`^/shops/${UUID}/orders$`).exec(p)) && req.method === 'GET') return ordersList(res, me, cookie, m[1], url.searchParams);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}$`).exec(p)) && req.method === 'GET') return orderDetail(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/(confirm|ship|cancel|deliver)$`).exec(p)) && req.method === 'POST') return orderAction(req, res, me, cookie, m[1], m[2], m[3]);

    return sendHtml(res, 404, V.renderError({ user: me }, 'Không tìm thấy trang.'));
  } catch (err) {
    log('error', 'handler_error', { path: p, message: err.message });
    if (!res.headersSent) sendHtml(res, 500, V.renderError({}, 'Lỗi hệ thống, vui lòng thử lại.'));
  }
});

server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT }));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
