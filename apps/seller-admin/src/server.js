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
const roleFor = (me, shopId) => (me.memberships ?? []).find((m) => m.shop_id === shopId)?.role ?? null;
const shopNameOf = async (shopId, cookie) => { try { return (await sellerApi('GET', `/shops/${shopId}`, { cookie })).json?.name ?? null; } catch { return null; } };
// ctx cho trang trong 1 shop: kèm role + tab active để layout vẽ nav.
const shopCtx = (me, shopId, shopName, active) => ({ user: me, shopName, shopId, role: roleFor(me, shopId), active });
// VND từ form: '' → null (backend báo 400), còn lại → số (âm cũng để backend chặn).
const parseVnd = (s) => { const t = String(s ?? '').replace(/[^\d-]/g, ''); return t === '' ? null : Number(t); };
const denyShop = (res, me) => sendHtml(res, 403, V.renderError({ user: me }, 'Bạn không có quyền với cửa hàng này.'));
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
  if (!isMember(me, shopId)) return denyShop(res, me);
  const status = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'refunded'].includes(q.get('status')) ? q.get('status') : '';
  const limit = 20, offset = Math.max(0, parseInt(q.get('offset') ?? '0', 10) || 0);
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) }); if (status) qs.set('status', status);
  const r = await sellerApi('GET', `/shops/${shopId}/orders?${qs}`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tải được đơn hàng.'));
  return sendHtml(res, 200, V.renderOrders(ctx, shopId, r.json, { status, limit, offset }));
}

async function orderDetail(res, me, cookie, shopId, oid, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('GET', `/shops/${shopId}/orders/${oid}`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tìm thấy đơn.'));
  return sendHtml(res, err ? 409 : 200, V.renderOrderDetail(ctx, shopId, r.json, err));
}

async function orderAction(req, res, me, cookie, shopId, oid, action) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  let body;
  if (action === 'ship') { const f = await readForm(req); body = { tracking_number: String(f.tracking_number ?? '').trim(), carrier: String(f.carrier ?? '').trim() }; }
  const r = await sellerApi('POST', `/shops/${shopId}/orders/${oid}/${action}`, { cookie, body });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/orders/${oid}`);
  // Lỗi (403 quyền / 409 sai trạng thái / 400) → render lại chi tiết kèm thông báo.
  return orderDetail(res, me, cookie, shopId, oid, r.json?.error ?? 'Thao tác không thực hiện được.');
}

// ── product/inventory handlers ────────────────────────────────────────────────
// Quyền catalog do `seller` cưỡng chế (catalog.read/write); BFF chỉ forward + hiện lỗi.
async function productsList(res, me, cookie, shopId, q) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const status = ['draft', 'active', 'archived'].includes(q.get('status')) ? q.get('status') : '';
  const query = (q.get('q') ?? '').trim().slice(0, 100);
  const limit = 20, offset = Math.max(0, parseInt(q.get('offset') ?? '0', 10) || 0);
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (status) qs.set('status', status);
  if (query) qs.set('q', query);
  const r = await sellerApi('GET', `/shops/${shopId}/products?${qs}`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'products');
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tải được sản phẩm.'));
  return sendHtml(res, 200, V.renderProducts(ctx, shopId, r.json, { status, q: query, limit, offset }));
}

async function productNew(res, me, cookie, shopId, err, form) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'products');
  return sendHtml(res, err ? 400 : 200, V.renderProductNew(ctx, shopId, err, form));
}

async function productCreate(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const body = {
    title: String(f.title ?? '').trim(),
    slug: String(f.slug ?? '').trim().toLowerCase(),
    price_vnd: parseVnd(f.price_vnd),
    status: f.status === 'active' ? 'active' : 'draft',
    description: String(f.description ?? '').trim() || null,
    variants: [{ sku: String(f.sku ?? '').trim(), price_vnd: parseVnd(f.variant_price_vnd) }],
  };
  const r = await sellerApi('POST', `/shops/${shopId}/products`, { cookie, body });
  if (r.status === 201) return redirect(res, `/shops/${shopId}/products/${r.json.id}`);
  return productNew(res, me, cookie, shopId, r.json?.error ?? 'Không tạo được sản phẩm.', f);
}

async function productDetail(res, me, cookie, shopId, pid, err, form) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('GET', `/shops/${shopId}/products/${pid}`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'products');
  if (r.status !== 200 || !r.json) return sendHtml(res, r.status === 200 ? 502 : r.status, V.renderError(ctx, r.json?.error ?? 'Không tìm thấy sản phẩm.'));
  // Tồn kho tách riêng khỏi payload SP → lấy song song. MỘT lần lỗi/timeout KHÔNG được
  // làm sập cả trang → nuốt lỗi; biến thể đó hiện "—" (chưa biết) thay vì giả định tồn 0.
  const levels = {};
  await Promise.all((r.json.variants ?? []).map(async (v) => {
    try {
      const lr = await sellerApi('GET', `/shops/${shopId}/variants/${v.id}/inventory`, { cookie });
      if (lr.status === 200) levels[v.id] = lr.json;
    } catch { /* mức tồn không tải được → để trống */ }
  }));
  return sendHtml(res, err ? 409 : 200, V.renderProductDetail(ctx, shopId, r.json, levels, err, form));
}

async function productUpdate(req, res, me, cookie, shopId, pid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const body = { title: String(f.title ?? '').trim(), slug: String(f.slug ?? '').trim().toLowerCase(), price_vnd: parseVnd(f.price_vnd), description: String(f.description ?? '').trim() || null };
  const r = await sellerApi('PATCH', `/shops/${shopId}/products/${pid}`, { cookie, body });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/products/${pid}`);
  // Giữ nguyên giá trị vừa nhập khi lưu lỗi (slug trùng…) — không revert về DB.
  return productDetail(res, me, cookie, shopId, pid, r.json?.error ?? 'Không lưu được thay đổi.', f);
}

async function productStatus(res, me, cookie, shopId, pid, action) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('POST', `/shops/${shopId}/products/${pid}/${action}`, { cookie });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/products/${pid}`);
  return productDetail(res, me, cookie, shopId, pid, r.json?.error ?? 'Không đổi được trạng thái.');
}

async function productDelete(res, me, cookie, shopId, pid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('DELETE', `/shops/${shopId}/products/${pid}`, { cookie });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/products`);
  return productDetail(res, me, cookie, shopId, pid, r.json?.error ?? 'Không xoá được sản phẩm.');
}

async function variantAdd(req, res, me, cookie, shopId, pid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const body = { sku: String(f.sku ?? '').trim(), price_vnd: parseVnd(f.price_vnd) };
  const r = await sellerApi('POST', `/shops/${shopId}/products/${pid}/variants`, { cookie, body });
  if (r.status === 201) return redirect(res, `/shops/${shopId}/products/${pid}`);
  return productDetail(res, me, cookie, shopId, pid, r.json?.error ?? 'Không thêm được biến thể.');
}

async function variantDelete(res, me, cookie, shopId, pid, vid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('DELETE', `/shops/${shopId}/products/${pid}/variants/${vid}`, { cookie });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/products/${pid}`);
  return productDetail(res, me, cookie, shopId, pid, r.json?.error ?? 'Không xoá được biến thể.');
}

async function inventoryAdjust(req, res, me, cookie, shopId, pid, vid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const delta = parseInt(String(f.delta ?? '').replace(/[^\d-]/g, ''), 10);
  const body = { delta: Number.isFinite(delta) ? delta : 0, reason: String(f.reason ?? '').trim() || null };
  const r = await sellerApi('POST', `/shops/${shopId}/variants/${vid}/inventory/adjust`, { cookie, body });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/products/${pid}`);
  return productDetail(res, me, cookie, shopId, pid, r.json?.error ?? 'Không cập nhật được tồn.');
}

// ── router ───────────────────────────────────────────────────────────────────
// Dispatch tách riêng và được AWAIT ở dưới: nếu handler async reject (throw/timeout),
// `return handler(...)` trần sẽ THOÁT try/catch (rejection nằm ngoài scope) → treo
// request / unhandledRejection. Bọc `await handle(...)` để catch bắt được mọi lỗi.
async function handle(req, res, url, p) {
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

    // Sản phẩm & tồn kho.
    if ((m = new RegExp(`^/shops/${UUID}/products$`).exec(p)) && req.method === 'GET') return productsList(res, me, cookie, m[1], url.searchParams);
    if ((m = new RegExp(`^/shops/${UUID}/products$`).exec(p)) && req.method === 'POST') return productCreate(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/products/new$`).exec(p)) && req.method === 'GET') return productNew(res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}$`).exec(p)) && req.method === 'GET') return productDetail(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}$`).exec(p)) && req.method === 'POST') return productUpdate(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/(publish|archive)$`).exec(p)) && req.method === 'POST') return productStatus(res, me, cookie, m[1], m[2], m[3]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/delete$`).exec(p)) && req.method === 'POST') return productDelete(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/variants$`).exec(p)) && req.method === 'POST') return variantAdd(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/variants/${UUID}/delete$`).exec(p)) && req.method === 'POST') return variantDelete(res, me, cookie, m[1], m[2], m[3]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/variants/${UUID}/inventory$`).exec(p)) && req.method === 'POST') return inventoryAdjust(req, res, me, cookie, m[1], m[2], m[3]);

    return sendHtml(res, 404, V.renderError({ user: me }, 'Không tìm thấy trang.'));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://internal');
  const p = url.pathname;
  if (p === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
  try {
    await handle(req, res, url, p);
  } catch (err) {
    log('error', 'handler_error', { path: p, message: err.message });
    if (!res.headersSent) sendHtml(res, 500, V.renderError({}, 'Lỗi hệ thống, vui lòng thử lại.'));
  }
});

server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT }));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
