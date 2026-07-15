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
import { parseCookies, readForm, readFormAll, readMultipartFile, sendHtml, redirect, sendDownload, sameOrigin, SESSION_COOKIE } from './http.js';
import { authApi, sellerApi, platformApi, sellerUpload, sellerDownload, loadSession } from './api.js';
import * as V from './pages.js';
import { runReq, makeLog, health } from './obs.js';

const PORT = Number(process.env.PORT ?? 3001);
const ALLOWED = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (ALLOWED.length === 0) throw new Error('thiếu ALLOWED_ORIGINS');
// Origin công khai của admin (để dựng link chấp nhận lời mời gửi cho người được mời).
const ADMIN_ORIGIN = process.env.ADMIN_ORIGIN ?? 'https://admin.nentang.vn';
const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const log = makeLog('seller-admin');

const isMember = (me, shopId) => (me.memberships ?? []).some((m) => m.shop_id === shopId);
const roleFor = (me, shopId) => (me.memberships ?? []).find((m) => m.shop_id === shopId)?.role ?? null;
const shopNameOf = async (shopId, cookie) => { try { return (await sellerApi('GET', `/shops/${shopId}`, { cookie })).json?.name ?? null; } catch { return null; } };
// ctx cho trang trong 1 shop: kèm role + tab active để layout vẽ nav.
const shopCtx = (me, shopId, shopName, active) => ({ user: me, shopName, shopId, role: roleFor(me, shopId), active });
// VND từ form: '' → null (backend báo 400), còn lại → số (âm cũng để backend chặn).
const parseVnd = (s) => { const t = String(s ?? '').replace(/[^\d-]/g, ''); return t === '' ? null : Number(t); };
// Parser CSV tối giản (RFC-4180): ô có ngoặc kép, phẩy/xuống-dòng trong ô, "" thoát,
// CRLF/LF, bỏ BOM. Trả mảng object theo hàng tiêu đề (tên cột chuẩn hoá thường).
function parseCsv(text) {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r') { /* bỏ */ }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    if (rows[r].length === 1 && rows[r][0].trim() === '') continue; // dòng trống
    const obj = {}; headers.forEach((h, idx) => { obj[h] = rows[r][idx] ?? ''; });
    out.push(obj);
  }
  return out;
}
const denyShop = (res, me) => sendHtml(res, 403, V.renderError({ user: me }, 'Bạn không có quyền với cửa hàng này.'));
// Step-up: thao tác nhân sự cần xác thực lại (mật khẩu) gần đây. Khớp cửa sổ 5' của seller.
const STEP_UP_MS = 5 * 60 * 1000;
const steppedUp = (me) => !!me.stepped_up_at && (Date.now() - new Date(me.stepped_up_at).getTime() < STEP_UP_MS);
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
  // Phát hiện nhân viên nền tảng: platform requireStaff trả 403 cho người thường (rẻ),
  // 200 cho staff → hiện link Console. Một lượt gọi nội bộ/lần vào dashboard.
  const staff = await platformApi('GET', '/ops/shops', { cookie }).catch(() => ({ status: 0 }));
  return sendHtml(res, 200, V.renderDashboard({ user: me }, shops, staff.status === 200));
}

// ── Console nền tảng (super-admin) — gate ẩn qua platform requireStaff ────────
const platCtx = (me) => ({ user: me }); // không shopId → layout đơn (không sidebar shop)
const platDenied = (res, me) => sendHtml(res, 403, V.renderPlatformDenied(platCtx(me)));
const isDenied = (st) => st === 401 || st === 403;
async function platformShops(res, me, cookie) {
  const r = await platformApi('GET', '/ops/shops', { cookie });
  if (r.status !== 200) return platDenied(res, me);
  return sendHtml(res, 200, V.renderPlatformShops(platCtx(me), r.json?.shops ?? []));
}
function platformShopNew(res, me, err, form) {
  return sendHtml(res, err ? 400 : 200, V.renderPlatformShopNew(platCtx(me), err, form));
}
async function platformCreate(req, res, me, cookie) {
  const f = await readForm(req);
  const body = { name: String(f.name ?? '').trim(), slug: String(f.slug ?? '').toLowerCase().trim(), plan_code: String(f.plan_code ?? '').trim() };
  const r = await platformApi('POST', '/ops/shops', { cookie, body });
  if (r.status === 201) return redirect(res, `/platform/shops/${r.json.id}`);
  if (isDenied(r.status)) return platDenied(res, me);
  return platformShopNew(res, me, r.json?.error ?? 'Không tạo được cửa hàng.', f);
}
async function platformShopDetail(res, me, cookie, shopId, opts = {}) {
  const r = await platformApi('GET', `/ops/shops/${shopId}`, { cookie });
  if (isDenied(r.status)) return platDenied(res, me);
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError({ user: me }, r.json?.error ?? 'Không tìm thấy cửa hàng.'));
  return sendHtml(res, 200, V.renderPlatformShopDetail(platCtx(me), r.json, opts));
}
async function platformInvite(req, res, me, cookie, shopId) {
  const f = await readForm(req);
  const r = await platformApi('POST', `/ops/shops/${shopId}/invitations`, { cookie, body: { email: String(f.email ?? '').trim(), role: 'owner' } });
  if (isDenied(r.status)) return platDenied(res, me);
  if (r.status !== 201) return platformShopDetail(res, me, cookie, shopId, { err: r.json?.error ?? 'Không tạo được lời mời.' });
  const invite = { email: String(f.email ?? '').trim(), url: `${ADMIN_ORIGIN}/invite/accept?token=${encodeURIComponent(r.json.token)}`, expires_at: r.json.expires_at };
  return platformShopDetail(res, me, cookie, shopId, { invite, notice: 'Đã tạo link mời — sao chép gửi cho chủ shop.' });
}
async function platformStatus(res, me, cookie, shopId, action) {
  const r = await platformApi('POST', `/ops/shops/${shopId}/${action}`, { cookie, body: {} });
  if (isDenied(r.status)) return platDenied(res, me);
  const okMsg = action === 'suspend' ? 'Đã tạm khoá cửa hàng.' : 'Đã mở lại cửa hàng.';
  return platformShopDetail(res, me, cookie, shopId, r.status === 200 ? { notice: okMsg } : { err: r.json?.error ?? 'Thao tác không thực hiện được.' });
}
async function platformRenew(req, res, me, cookie, shopId) {
  const f = await readForm(req);
  const body = { months: String(f.months ?? '1') };
  if (f.plan_code) body.plan_code = String(f.plan_code);
  const r = await platformApi('POST', `/ops/shops/${shopId}/subscription/renew`, { cookie, body });
  if (isDenied(r.status)) return platDenied(res, me);
  return platformShopDetail(res, me, cookie, shopId, r.status === 200
    ? { notice: `Đã ghi nhận thu — gia hạn ${body.months} tháng${body.plan_code ? ` (gói ${body.plan_code})` : ''}, mở lại shop nếu đang khoá.` }
    : { err: r.json?.error ?? 'Không gia hạn được.' });
}

async function overviewPage(res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'overview');
  const r = await sellerApi('GET', `/shops/${shopId}/stats`, { cookie });
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tải được số liệu tổng quan.'));
  return sendHtml(res, 200, V.renderOverview(ctx, shopId, r.json));
}

async function ordersList(res, me, cookie, shopId, q) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const status = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'refunded'].includes(q.get('status')) ? q.get('status') : '';
  const search = (q.get('q') ?? '').trim().slice(0, 100);
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const from = DATE_RE.test((q.get('from') ?? '').trim()) ? q.get('from').trim() : '';
  const to = DATE_RE.test((q.get('to') ?? '').trim()) ? q.get('to').trim() : '';
  const limit = 20, offset = Math.max(0, parseInt(q.get('offset') ?? '0', 10) || 0);
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (status) qs.set('status', status);
  if (search) qs.set('q', search);
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const r = await sellerApi('GET', `/shops/${shopId}/orders?${qs}`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tải được đơn hàng.'));
  return sendHtml(res, 200, V.renderOrders(ctx, shopId, r.json, { status, q: search, from, to, limit, offset }));
}

async function orderDetail(res, me, cookie, shopId, oid, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('GET', `/shops/${shopId}/orders/${oid}`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tìm thấy đơn.'));
  return sendHtml(res, err ? 409 : 200, V.renderOrderDetail(ctx, shopId, r.json, err));
}

async function orderPrint(res, me, cookie, shopId, oid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const [ro, rs] = await Promise.all([
    sellerApi('GET', `/shops/${shopId}/orders/${oid}`, { cookie }),
    sellerApi('GET', `/shops/${shopId}`, { cookie }),
  ]);
  if (ro.status !== 200) {
    const ctx = shopCtx(me, shopId, rs.json?.name ?? null, 'orders');
    return sendHtml(res, ro.status, V.renderError(ctx, ro.json?.error ?? 'Không tìm thấy đơn.'));
  }
  return sendHtml(res, 200, V.renderOrderPrint(shopId, rs.status === 200 ? rs.json : {}, ro.json));
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

// Nhập sản phẩm hàng loạt từ CSV: đọc file (multipart) → parse → forward mảng rows tới
// seller (validate + tạo từng dòng, thành công một phần) → render kết quả.
async function productImportPage(res, me, cookie, shopId, result, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'products');
  return sendHtml(res, err ? 400 : 200, V.renderProductImport(ctx, shopId, result, err));
}
async function productImport(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  let file, tooBig = false;
  try { file = await readMultipartFile(req); } catch (e) { tooBig = e.statusCode === 413; }
  if (tooBig) return productImportPage(res, me, cookie, shopId, null, 'Tệp quá lớn (tối đa 10MB).');
  if (!file?.bytes?.length) return productImportPage(res, me, cookie, shopId, null, 'Chưa chọn tệp CSV hợp lệ.');
  const rows = parseCsv(file.bytes.toString('utf8'));
  if (rows.length === 0) return productImportPage(res, me, cookie, shopId, null, 'Tệp không có dòng dữ liệu (cần hàng tiêu đề + ít nhất 1 dòng).');
  if (rows.length > 1000) return productImportPage(res, me, cookie, shopId, null, 'Tối đa 1000 dòng mỗi lần nhập.');
  const r = await sellerApi('POST', `/shops/${shopId}/products/import`, { cookie, body: { rows } });
  if (r.status !== 200) return productImportPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không nhập được — kiểm tra quyền hoặc định dạng tệp.');
  return productImportPage(res, me, cookie, shopId, { ...r.json, total: rows.length }, null);
}

// ── Blog ─────────────────────────────────────────────────────────────────────
async function blogList(res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('GET', `/shops/${shopId}/blog`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'blog');
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tải được blog.'));
  return sendHtml(res, 200, V.renderBlogList(ctx, shopId, r.json));
}
async function blogNew(res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'blog');
  return sendHtml(res, 200, V.renderBlogEditor(ctx, shopId, null, null));
}
async function blogEditor(res, me, cookie, shopId, id, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('GET', `/shops/${shopId}/blog/${id}`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'blog');
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tìm thấy bài viết.'));
  return sendHtml(res, err ? 400 : 200, V.renderBlogEditor(ctx, shopId, r.json, err));
}
const blogForm = (f) => ({ title: String(f.title ?? '').trim(), slug: String(f.slug ?? '').toLowerCase().trim(), excerpt: String(f.excerpt ?? ''), body: String(f.body ?? '') });
async function blogCreate(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const body = blogForm(await readForm(req));
  const r = await sellerApi('POST', `/shops/${shopId}/blog`, { cookie, body });
  if (r.status === 201) return redirect(res, `/shops/${shopId}/blog/${r.json.id}`);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'blog');
  return sendHtml(res, 400, V.renderBlogEditor(ctx, shopId, body, r.json?.error ?? 'Không tạo được bài.')); // body không có id → form "mới" giữ giá trị
}
async function blogUpdate(req, res, me, cookie, shopId, id) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const body = blogForm(await readForm(req));
  const r = await sellerApi('PATCH', `/shops/${shopId}/blog/${id}`, { cookie, body });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/blog/${id}`);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'blog');
  return sendHtml(res, 400, V.renderBlogEditor(ctx, shopId, { ...body, id, status: 'draft' }, r.json?.error ?? 'Không lưu được bài.'));
}
async function blogStatus(res, me, cookie, shopId, id, action) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  await sellerApi('POST', `/shops/${shopId}/blog/${id}/${action}`, { cookie, body: {} });
  return redirect(res, `/shops/${shopId}/blog/${id}`);
}
async function blogDelete(res, me, cookie, shopId, id) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  await sellerApi('DELETE', `/shops/${shopId}/blog/${id}`, { cookie });
  return redirect(res, `/shops/${shopId}/blog`);
}

// ── Danh mục ─────────────────────────────────────────────────────────────────
async function categoriesPage(res, me, cookie, shopId, notice, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('GET', `/shops/${shopId}/categories`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'categories');
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tải được danh mục.'));
  return sendHtml(res, err ? 400 : 200, V.renderCategories(ctx, shopId, r.json, notice, err));
}
async function categoryCreate(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const r = await sellerApi('POST', `/shops/${shopId}/categories`, { cookie, body: { name: String(f.name ?? '').trim(), slug: String(f.slug ?? '').toLowerCase().trim() } });
  return categoriesPage(res, me, cookie, shopId, r.status === 201 ? 'Đã thêm danh mục.' : null, r.status === 201 ? null : (r.json?.error ?? 'Không thêm được danh mục.'));
}
async function categoryUpdate(req, res, me, cookie, shopId, cid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const body = { name: String(f.name ?? '').trim() };
  const pos = parseInt(f.position ?? '', 10); if (Number.isInteger(pos)) body.position = pos;
  const r = await sellerApi('PATCH', `/shops/${shopId}/categories/${cid}`, { cookie, body });
  return categoriesPage(res, me, cookie, shopId, r.status === 200 ? 'Đã lưu danh mục.' : null, r.status === 200 ? null : (r.json?.error ?? 'Không lưu được danh mục.'));
}
async function categoryDelete(res, me, cookie, shopId, cid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('DELETE', `/shops/${shopId}/categories/${cid}`, { cookie });
  return categoriesPage(res, me, cookie, shopId, r.status === 200 ? 'Đã xoá danh mục.' : null, r.status === 200 ? null : (r.json?.error ?? 'Không xoá được danh mục.'));
}

// ── Khuyến mãi (mã giảm giá; catalog.write) ──────────────────────────────────
async function couponsPage(res, me, cookie, shopId, notice, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'coupons');
  const r = await sellerApi('GET', `/shops/${shopId}/coupons`, { cookie });
  if (r.status !== 200 && r.status !== 400) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tải được khuyến mãi.'));
  return sendHtml(res, err ? 400 : 200, V.renderCoupons(ctx, shopId, r.status === 200 ? r.json : {}, notice, err));
}
async function couponCreate(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const body = { code: f.code, kind: f.kind, value: f.value, min_subtotal_vnd: f.min_subtotal_vnd, max_uses: f.max_uses, expires_at: f.expires_at };
  const r = await sellerApi('POST', `/shops/${shopId}/coupons`, { cookie, body });
  return couponsPage(res, me, cookie, shopId, r.status === 201 ? 'Đã tạo mã giảm giá.' : null, r.status === 201 ? null : (r.json?.error ?? 'Không tạo được mã.'));
}
async function couponToggle(req, res, me, cookie, shopId, id) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  await sellerApi('PATCH', `/shops/${shopId}/coupons/${id}`, { cookie, body: { active: f.active === '1' } });
  return redirect(res, `/shops/${shopId}/coupons`);
}
async function couponDelete(req, res, me, cookie, shopId, id) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  await sellerApi('DELETE', `/shops/${shopId}/coupons/${id}`, { cookie });
  return redirect(res, `/shops/${shopId}/coupons`);
}
async function productCategoriesSave(req, res, me, cookie, shopId, pid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const params = await readFormAll(req);
  const r = await sellerApi('PUT', `/shops/${shopId}/products/${pid}/categories`, { cookie, body: { category_ids: params.getAll('category_ids') } });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/products/${pid}`);
  return productDetail(res, me, cookie, shopId, pid, r.json?.error ?? 'Không lưu được danh mục.');
}

async function productDetail(res, me, cookie, shopId, pid, err, form) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('GET', `/shops/${shopId}/products/${pid}`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'products');
  if (r.status !== 200 || !r.json) return sendHtml(res, r.status === 200 ? 502 : r.status, V.renderError(ctx, r.json?.error ?? 'Không tìm thấy sản phẩm.'));
  // Tồn kho + ảnh tách riêng khỏi payload SP → lấy song song. MỘT lần lỗi/timeout
  // KHÔNG được làm sập cả trang → nuốt lỗi; tồn hiện "—" (chưa biết), ảnh coi như rỗng.
  const levels = {};
  const loadLevels = Promise.all((r.json.variants ?? []).map(async (v) => {
    try {
      const lr = await sellerApi('GET', `/shops/${shopId}/variants/${v.id}/inventory`, { cookie });
      if (lr.status === 200) levels[v.id] = lr.json;
    } catch { /* mức tồn không tải được → để trống */ }
  }));
  const loadMedia = sellerApi('GET', `/shops/${shopId}/products/${pid}/media`, { cookie })
    .then((mr) => (mr.status === 200 ? (mr.json?.media ?? []) : [])).catch(() => []);
  const loadCats = sellerApi('GET', `/shops/${shopId}/categories`, { cookie })
    .then((cr) => (cr.status === 200 ? (cr.json?.categories ?? []) : [])).catch(() => []);
  const [, media, cats] = await Promise.all([loadLevels, loadMedia, loadCats]);
  return sendHtml(res, err ? 409 : 200, V.renderProductDetail(ctx, shopId, r.json, levels, err, form, media, cats));
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

async function mediaUpload(req, res, me, cookie, shopId, pid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  let file, tooBig = false;
  try { file = await readMultipartFile(req); } catch (e) { tooBig = e.statusCode === 413; }
  if (tooBig) return productDetail(res, me, cookie, shopId, pid, 'Ảnh quá lớn (tối đa 10MB).');
  if (!file?.bytes?.length) return productDetail(res, me, cookie, shopId, pid, 'Chưa chọn ảnh hợp lệ.');
  // Forward BYTE THÔ tới seller (seller sniff magic byte + re-encode WebP).
  const r = await sellerUpload(`/shops/${shopId}/products/${pid}/media`, { cookie, bytes: file.bytes });
  if (r.status === 201) return redirect(res, `/shops/${shopId}/products/${pid}`);
  return productDetail(res, me, cookie, shopId, pid, r.json?.error ?? 'Tải ảnh thất bại.');
}

async function mediaDelete(res, me, cookie, shopId, pid, mediaId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('DELETE', `/shops/${shopId}/media/${mediaId}`, { cookie });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/products/${pid}`);
  return productDetail(res, me, cookie, shopId, pid, r.json?.error ?? 'Không xoá được ảnh.');
}

// Sắp thứ tự ảnh (← → / ★ đại diện) — không JS: lấy thứ tự hiện tại, tính order mới,
// gọi endpoint reorder (backend đòi hoán vị đúng). ★ primary = đưa ảnh lên đầu.
async function mediaMove(res, me, cookie, shopId, pid, mediaId, action) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const editor = `/shops/${shopId}/products/${pid}`;
  const mr = await sellerApi('GET', `/shops/${shopId}/products/${pid}/media`, { cookie });
  if (mr.status !== 200) return productDetail(res, me, cookie, shopId, pid, 'Không tải được ảnh.');
  const ids = (mr.json?.media ?? []).map((m) => m.id);
  const i = ids.indexOf(mediaId);
  if (i === -1) return redirect(res, editor);
  let order;
  if (action === 'primary') order = [mediaId, ...ids.filter((x) => x !== mediaId)];
  else { const j = action === 'moveup' ? i - 1 : i + 1; if (j < 0 || j >= ids.length) return redirect(res, editor); order = ids.slice(); [order[i], order[j]] = [order[j], order[i]]; }
  const r = await sellerApi('POST', `/shops/${shopId}/products/${pid}/media/reorder`, { cookie, body: { order } });
  if (r.status === 200) return redirect(res, editor);
  return productDetail(res, me, cookie, shopId, pid, r.json?.error ?? 'Không đổi được thứ tự ảnh.');
}

// ── content page handlers ─────────────────────────────────────────────────────
// Trang có phiên bản: pages.blocks = DRAFT; publish snapshot vào page_revisions.
// Section text-only, đã typed; `seller` validate + cưỡng chế content.read/write.
// Gộp form thành block body theo type (list: mỗi dòng 1 mục; divider: không field).
function blockBody(f) {
  const type = f.type;
  if (type === 'list') return { type: 'list', items: String(f.text ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean) };
  if (type === 'divider') return { type: 'divider' };
  if (type === 'quote') { const b = { type: 'quote', text: String(f.text ?? '') }; const cite = String(f.cite ?? '').trim(); if (cite) b.cite = cite; return b; }
  return { type, text: String(f.text ?? '') }; // heading | paragraph
}

async function pagesList(res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('GET', `/shops/${shopId}/pages`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'pages');
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tải được danh sách trang.'));
  return sendHtml(res, 200, V.renderContentPages(ctx, shopId, r.json));
}

async function pageNew(res, me, cookie, shopId, err, form) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'pages');
  return sendHtml(res, err ? 400 : 200, V.renderPageNew(ctx, shopId, err, form));
}

async function pageCreate(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const body = { title: String(f.title ?? '').trim(), slug: String(f.slug ?? '').trim().toLowerCase(), seo_title: String(f.seo_title ?? '').trim() || null, seo_description: String(f.seo_description ?? '').trim() || null };
  const r = await sellerApi('POST', `/shops/${shopId}/pages`, { cookie, body });
  if (r.status === 201) return redirect(res, `/shops/${shopId}/pages/${r.json.id}`);
  return pageNew(res, me, cookie, shopId, r.json?.error ?? 'Không tạo được trang.', f);
}

async function pageEditor(res, me, cookie, shopId, pid, err, notice, form) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('GET', `/shops/${shopId}/pages/${pid}`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'pages');
  if (r.status !== 200 || !r.json) return sendHtml(res, r.status === 200 ? 502 : r.status, V.renderError(ctx, r.json?.error ?? 'Không tìm thấy trang.'));
  return sendHtml(res, err ? 409 : 200, V.renderPageEditor(ctx, shopId, r.json, err, notice, form));
}

async function pageUpdate(req, res, me, cookie, shopId, pid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const mp = String(f.menu_position ?? '').trim();
  // menu_position: '' → null (ẩn); còn lại PHẢI là số nguyên — không để NaN lẳng lặng
  // hoá null (JSON.stringify(NaN)=null) rồi lưu 200 câm. Giữ form khi lỗi (không revert DB).
  if (mp !== '' && !Number.isInteger(Number(mp))) return pageEditor(res, me, cookie, shopId, pid, 'Vị trí menu phải là số nguyên.', null, f);
  const body = { title: String(f.title ?? '').trim(), seo_title: String(f.seo_title ?? '').trim() || null, seo_description: String(f.seo_description ?? '').trim() || null, menu_position: mp === '' ? null : Number(mp) };
  const r = await sellerApi('PATCH', `/shops/${shopId}/pages/${pid}`, { cookie, body });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/pages/${pid}`);
  return pageEditor(res, me, cookie, shopId, pid, r.json?.error ?? 'Không lưu được thông tin.', null, f);
}

async function pagePublish(res, me, cookie, shopId, pid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('POST', `/shops/${shopId}/pages/${pid}/publish`, { cookie });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/pages/${pid}`);
  return pageEditor(res, me, cookie, shopId, pid, r.json?.error ?? 'Không đăng được trang.');
}

async function pagePreview(res, me, cookie, shopId, pid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('POST', `/shops/${shopId}/pages/${pid}/preview`, { cookie });
  // Render TRỰC TIẾP (không redirect) để show link chứa token — trang admin no-referrer.
  if (r.status === 201) return pageEditor(res, me, cookie, shopId, pid, null, { preview: r.json });
  return pageEditor(res, me, cookie, shopId, pid, r.json?.error ?? 'Không tạo được link xem trước.');
}

async function pageRollback(req, res, me, cookie, shopId, pid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const rev = parseInt(String(f.revision ?? ''), 10);
  const r = await sellerApi('POST', `/shops/${shopId}/pages/${pid}/rollback`, { cookie, body: { revision: Number.isFinite(rev) ? rev : 0 } });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/pages/${pid}`);
  return pageEditor(res, me, cookie, shopId, pid, r.json?.error ?? 'Không khôi phục được.');
}

async function pageDelete(res, me, cookie, shopId, pid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('DELETE', `/shops/${shopId}/pages/${pid}`, { cookie });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/pages`);
  return pageEditor(res, me, cookie, shopId, pid, r.json?.error ?? 'Không xoá được trang.');
}

async function blockAdd(req, res, me, cookie, shopId, pid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('POST', `/shops/${shopId}/pages/${pid}/blocks`, { cookie, body: blockBody(await readForm(req)) });
  if (r.status === 201) return redirect(res, `/shops/${shopId}/pages/${pid}`);
  return pageEditor(res, me, cookie, shopId, pid, r.json?.error ?? 'Không thêm được section.');
}

async function blockEdit(req, res, me, cookie, shopId, pid, bid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('PATCH', `/shops/${shopId}/pages/${pid}/blocks/${bid}`, { cookie, body: blockBody(await readForm(req)) });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/pages/${pid}`);
  return pageEditor(res, me, cookie, shopId, pid, r.json?.error ?? 'Không lưu được section.');
}

async function blockDelete(res, me, cookie, shopId, pid, bid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('DELETE', `/shops/${shopId}/pages/${pid}/blocks/${bid}`, { cookie });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/pages/${pid}`);
  return pageEditor(res, me, cookie, shopId, pid, r.json?.error ?? 'Không xoá được section.');
}

// Kéo–thả (no-JS): ↑/↓ → tính order mới (hoán vị 2 phần tử) rồi gọi reorder của seller.
async function blockMove(res, me, cookie, shopId, pid, bid, dir) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const editor = `/shops/${shopId}/pages/${pid}`;
  const pr = await sellerApi('GET', `/shops/${shopId}/pages/${pid}`, { cookie });
  if (pr.status !== 200 || !pr.json) return pageEditor(res, me, cookie, shopId, pid, 'Không tải được trang.');
  const blocks = pr.json.blocks ?? [];
  const i = blocks.findIndex((b) => b.id === bid);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (i === -1 || j < 0 || j >= blocks.length) return redirect(res, editor); // ở mép / không thấy → no-op
  const order = blocks.map((b) => b.id);
  [order[i], order[j]] = [order[j], order[i]];
  const r = await sellerApi('POST', `/shops/${shopId}/pages/${pid}/blocks/reorder`, { cookie, body: { order } });
  if (r.status === 200) return redirect(res, editor);
  return pageEditor(res, me, cookie, shopId, pid, r.json?.error ?? 'Không đổi được thứ tự.');
}

// ── account (bảo mật cá nhân) ─────────────────────────────────────────────────
async function accountPage(res, me, cookie, extra = {}) {
  // Nạp danh sách phiên đang sống (best-effort — lỗi thì trang vẫn hiện phần còn lại).
  let sessions = [];
  if (cookie) { try { const r = await authApi('GET', '/auth/sessions', { cookie }); if (r.status === 200) sessions = r.json?.sessions ?? []; } catch { /* ignore */ } }
  return sendHtml(res, extra.err ? 400 : 200, V.renderAccount({ email: me.email, mfa_enabled: me.mfa_enabled, sessions, ...extra }));
}

async function mfaEnrollStart(res, me, cookie) {
  const r = await authApi('POST', '/auth/mfa/enroll', { cookie });
  if (r.status === 200) return accountPage(res, me, cookie, { enroll: r.json });
  return accountPage(res, me, cookie, { err: r.status === 409 ? 'MFA đã bật rồi.' : (r.json?.error ?? 'Không bật được MFA.') });
}
async function mfaActivate(req, res, me, cookie) {
  const f = await readForm(req);
  const r = await authApi('POST', '/auth/mfa/activate', { cookie, body: { code: String(f.code ?? '').replace(/\s/g, '') } });
  // A6: activate ROTATE token → auth trả cookie phiên mới; relay để trình duyệt theo phiên mới.
  const setC = r.status === 200 ? (r.setCookie ?? []) : [];
  if (r.status === 200) return sendHtml(res, 200, V.renderAccount({ email: me.email, mfa_enabled: me.mfa_enabled, sessions: [], recovery_codes: r.json?.recovery_codes ?? [], notice: 'Đã bật MFA thành công.' }), setC);
  // Sai mã: giữ nguyên bước 2 (secret còn nguyên, chưa xác nhận) để thử lại — không phải enroll lại.
  return accountPage(res, me, cookie, { enroll: { secret: f.secret, otpauth_url: f.otpauth }, err: r.json?.error ?? 'Mã không đúng, thử lại.' });
}
async function passwordForgot(res, me, cookie) {
  // Không cần cookie; luôn trả thông điệp mờ (không lộ email có tồn tại hay không).
  await authApi('POST', '/auth/password/forgot', { body: { email: me.email } }).catch(() => {});
  return accountPage(res, me, cookie, { notice: 'Đã gửi link đặt lại mật khẩu về email của bạn (nếu email hợp lệ).' });
}
async function passwordChange(req, res, me, cookie) {
  const f = await readForm(req);
  const r = await authApi('POST', '/auth/password/change', { cookie, body: { current_password: String(f.current_password ?? ''), new_password: String(f.new_password ?? '') } });
  if (r.status === 200) return accountPage(res, me, cookie, { notice: 'Đã đổi mật khẩu. Các thiết bị khác đã bị đăng xuất.' });
  return accountPage(res, me, cookie, { err: r.json?.error ?? 'Không đổi được mật khẩu.' });
}
// Thu hồi một phiên (form gửi session_id) / mọi phiên khác.
async function sessionRevoke(req, res, me, cookie) {
  const f = await readForm(req);
  await authApi('POST', '/auth/sessions/revoke', { cookie, body: { session_id: String(f.session_id ?? '') } });
  return accountPage(res, me, cookie, { notice: 'Đã thu hồi phiên.' });
}
async function sessionRevokeOthers(res, me, cookie) {
  await authApi('POST', '/auth/sessions/revoke-others', { cookie });
  return accountPage(res, me, cookie, { notice: 'Đã đăng xuất mọi thiết bị khác.' });
}
async function mfaDisableSubmit(req, res, me, cookie) {
  const f = await readForm(req);
  const r = await authApi('POST', '/auth/mfa/disable', { cookie, body: { code: String(f.code ?? '').replace(/\s/g, '') } });
  if (r.status === 200) return accountPage(res, me, cookie, { mfa_enabled: false, notice: 'Đã tắt MFA.' });
  return accountPage(res, me, cookie, { err: r.json?.error ?? 'Không tắt được MFA.' });
}

// ── chấp nhận lời mời (CÔNG KHAI: người được mời chưa đăng nhập) ───────────────
function inviteAcceptPage(res, url) {
  const token = url.searchParams.get('token') ?? '';
  if (!token) return sendHtml(res, 400, V.renderError({}, 'Thiếu mã lời mời trong link.'));
  return sendHtml(res, 200, V.renderInviteAccept(token));
}
async function inviteAcceptSubmit(req, res, cookie) {
  const f = await readForm(req);
  const token = String(f.token ?? '');
  // Forward cookie NẾU có (nhánh (c): email đã có tài khoản đã xác minh cần đang đăng nhập).
  const r = await authApi('POST', '/auth/invitations/accept', { cookie, body: { token, password: String(f.password ?? '') } });
  if (r.status === 200) return sendHtml(res, 200, V.renderInviteDone(r.json?.account_created ? 'created' : 'joined'));
  if (r.status === 403 && r.json?.login_required) return sendHtml(res, 200, V.renderInviteDone('login_required'));
  return sendHtml(res, r.status, V.renderInviteAccept(token, r.json?.error ?? 'Không chấp nhận được lời mời.'));
}

// ── nhân sự (member management) — SỬA cần step-up; seller cưỡng chế members.write ─
async function membersList(res, me, cookie, shopId, notice, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('GET', `/shops/${shopId}/members`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'members');
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tải được nhân sự.'));
  return sendHtml(res, err ? 409 : 200, V.renderMembers(ctx, shopId, r.json, roleFor(me, shopId) === 'owner', notice, err));
}
// Lõi thao tác (giả định đã step-up; seller vẫn kiểm lại phía nó).
async function doInvite(res, me, cookie, shopId, p) {
  const r = await sellerApi('POST', `/shops/${shopId}/members/invite`, { cookie, body: { email: p.email, role: p.role } });
  if (r.status === 201) {
    const token = r.json?.token;
    const acceptUrl = token ? `${ADMIN_ORIGIN}/invite/accept?token=${encodeURIComponent(token)}` : null;
    return membersList(res, me, cookie, shopId, { invited: p.email, token, acceptUrl });
  }
  return membersList(res, me, cookie, shopId, null, r.json?.error ?? 'Không mời được.');
}
// encodeURIComponent(uid): uid từ form step-up chưa qua regex UUID như route trực tiếp;
// mã hoá để mảnh "../" (nếu có) không thoát khỏi vị trí path (không traversal sang shop khác).
async function doRole(res, me, cookie, shopId, p) {
  const r = await sellerApi('PATCH', `/shops/${shopId}/members/${encodeURIComponent(p.uid)}/role`, { cookie, body: { role: p.role } });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/members`);
  return membersList(res, me, cookie, shopId, null, r.json?.error ?? 'Không đổi được vai trò.');
}
async function doRemove(res, me, cookie, shopId, p) {
  const r = await sellerApi('DELETE', `/shops/${shopId}/members/${encodeURIComponent(p.uid)}`, { cookie });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/members`);
  return membersList(res, me, cookie, shopId, null, r.json?.error ?? 'Không gỡ được thành viên.');
}
async function stepUpPage(res, me, cookie, shopId, action, params, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'members');
  return sendHtml(res, err ? 401 : 200, V.renderStepUp(ctx, shopId, action, params, err));
}
// POST thao tác nhân sự → chưa step-up thì hiện interstitial mang hành động chờ.
async function memberInvite(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const p = { email: String(f.email ?? '').trim(), role: String(f.role ?? '') };
  return steppedUp(me) ? doInvite(res, me, cookie, shopId, p) : stepUpPage(res, me, cookie, shopId, 'invite', p);
}
async function memberRole(req, res, me, cookie, shopId, uid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const p = { uid, role: String(f.role ?? '') };
  return steppedUp(me) ? doRole(res, me, cookie, shopId, p) : stepUpPage(res, me, cookie, shopId, 'role', p);
}
async function memberRemove(res, me, cookie, shopId, uid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  return steppedUp(me) ? doRemove(res, me, cookie, shopId, { uid }) : stepUpPage(res, me, cookie, shopId, 'remove', { uid });
}
// Nộp step-up: xác thực lại mật khẩu rồi CHẠY hành động đang chờ.
async function memberStepUp(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const action = String(f.__action ?? '');
  const params = { email: f.email, role: f.role, uid: f.uid };
  const r = await authApi('POST', '/auth/step-up', { cookie, body: { password: String(f.password ?? '') } });
  if (r.status !== 200) return stepUpPage(res, me, cookie, shopId, action, params, r.status === 429 ? 'Quá nhiều lần thử, đợi chút.' : 'Mật khẩu không đúng.');
  if (action === 'invite') return doInvite(res, me, cookie, shopId, { email: f.email, role: f.role });
  if (action === 'role') return doRole(res, me, cookie, shopId, { uid: f.uid, role: f.role });
  if (action === 'remove') return doRemove(res, me, cookie, shopId, { uid: f.uid });
  return redirect(res, `/shops/${shopId}/members`);
}

// ── Xuất dữ liệu (owner + step-up) ───────────────────────────────────────────
async function exportPage(res, me, cookie, shopId, notice, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'export');
  return sendHtml(res, err ? 400 : 200, V.renderExport(ctx, shopId, notice, err));
}
async function doExport(res, me, cookie, shopId) {
  // Timeout dài (dựng ZIP + nén + putObject) — mặc định 8s có thể ngắt sớm shop lớn.
  const r = await sellerApi('POST', `/shops/${shopId}/export`, { cookie, body: {}, timeoutMs: 30000 });
  if (r.status !== 200) return exportPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không tạo được bản xuất.');
  return exportPage(res, me, cookie, shopId, { token: r.json.token, expires_in: r.json.expires_in, counts: r.json.counts, bytes: r.json.bytes }, null);
}
async function exportStepUpPage(res, me, cookie, shopId, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'export');
  return sendHtml(res, err ? 401 : 200, V.renderExportStepUp(ctx, shopId, err));
}
// POST tạo bản xuất → chưa step-up thì hiện interstitial mật khẩu.
async function exportCreate(res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  return steppedUp(me) ? doExport(res, me, cookie, shopId) : exportStepUpPage(res, me, cookie, shopId, null);
}
async function exportStepUp(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const r = await authApi('POST', '/auth/step-up', { cookie, body: { password: String(f.password ?? '') } });
  if (r.status !== 200) return exportStepUpPage(res, me, cookie, shopId, r.status === 429 ? 'Quá nhiều lần thử, đợi chút.' : 'Mật khẩu không đúng.');
  return doExport(res, me, cookie, shopId);
}
async function exportDownload(res, me, cookie, shopId, token) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerDownload(`/shops/${shopId}/export/download?token=${encodeURIComponent(token)}`, { cookie });
  if (r.status === 200) return sendDownload(res, r.bytes, { filename: 'nentang-export.zip', contentType: r.contentType });
  // Lỗi (hết hạn / sai token / 403) → về trang xuất kèm thông báo (giải mã JSON lỗi từ bytes).
  let msg = 'Không tải được — link có thể đã hết hạn.';
  try { const j = JSON.parse(r.bytes.toString('utf8')); if (j?.error) msg = j.error; } catch {}
  return exportPage(res, me, cookie, shopId, null, msg);
}

// ── Tên miền tùy chỉnh (owner + step-up) ─────────────────────────────────────
async function domainsPage(res, me, cookie, shopId, notice, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'domains');
  if (roleFor(me, shopId) !== 'owner') return sendHtml(res, 200, V.renderDomains(ctx, shopId, [], null, null));
  const r = await sellerApi('GET', `/shops/${shopId}/domains`, { cookie });
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tải được tên miền.'));
  return sendHtml(res, err ? 400 : 200, V.renderDomains(ctx, shopId, r.json?.domains ?? [], notice, err));
}
async function doDomainAdd(res, me, cookie, shopId, p) {
  const r = await sellerApi('POST', `/shops/${shopId}/domains`, { cookie, body: { hostname: p.hostname } });
  if (r.status === 201) return domainsPage(res, me, cookie, shopId, 'Đã thêm tên miền — thêm bản ghi TXT bên dưới rồi chờ xác minh (tự động ~1 phút).', null);
  return domainsPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không thêm được tên miền.');
}
async function doDomainAction(res, me, cookie, shopId, action, p) {
  const r = action === 'revoke'
    ? await sellerApi('DELETE', `/shops/${shopId}/domains/${encodeURIComponent(p.did)}`, { cookie })
    : await sellerApi('POST', `/shops/${shopId}/domains/${encodeURIComponent(p.did)}/primary`, { cookie });
  if (r.status === 200) return domainsPage(res, me, cookie, shopId, action === 'revoke' ? 'Đã gỡ tên miền.' : 'Đã đặt tên miền chính.', null);
  return domainsPage(res, me, cookie, shopId, null, r.json?.error ?? 'Thao tác không thực hiện được.');
}
async function domainStepUpPage(res, me, cookie, shopId, action, params, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'domains');
  return sendHtml(res, err ? 401 : 200, V.renderDomainStepUp(ctx, shopId, action, params, err));
}
async function domainAdd(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const p = { hostname: String(f.hostname ?? '').trim() };
  return steppedUp(me) ? doDomainAdd(res, me, cookie, shopId, p) : domainStepUpPage(res, me, cookie, shopId, 'add', p);
}
async function domainAction(res, me, cookie, shopId, did, action) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  return steppedUp(me) ? doDomainAction(res, me, cookie, shopId, action, { did }) : domainStepUpPage(res, me, cookie, shopId, action, { did });
}
async function domainStepUp(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const action = String(f.__action ?? '');
  const r = await authApi('POST', '/auth/step-up', { cookie, body: { password: String(f.password ?? '') } });
  if (r.status !== 200) return domainStepUpPage(res, me, cookie, shopId, action, { hostname: f.hostname, did: f.did }, r.status === 429 ? 'Quá nhiều lần thử, đợi chút.' : 'Mật khẩu không đúng.');
  if (action === 'add') return doDomainAdd(res, me, cookie, shopId, { hostname: f.hostname });
  return doDomainAction(res, me, cookie, shopId, action, { did: f.did });
}

// ── router ───────────────────────────────────────────────────────────────────
// Dispatch tách riêng và được AWAIT ở dưới: nếu handler async reject (throw/timeout),
// `return handler(...)` trần sẽ THOÁT try/catch (rejection nằm ngoài scope) → treo
// request / unhandledRejection. Bọc `await handle(...)` để catch bắt được mọi lỗi.
// ── Giao diện (theme.write = owner/admin; storefront sanitize khi render) ─────
async function themePage(res, me, cookie, shopId, ok) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'theme');
  const r = await sellerApi('GET', `/shops/${shopId}/theme`, { cookie });
  const theme = r.status === 200 ? r.json : { tokens: {} };
  return sendHtml(res, 200, V.renderTheme(ctx, theme, ok === '1' ? 'Đã lưu — mở trang bán hàng để xem thay đổi.' : null));
}
async function themeSave(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  // reset → tokens/layout rỗng (storefront dùng mặc định). Storefront sanitize khi render nên
  // PUT chỉ cần dựng đúng cấu trúc; giá trị lạ sẽ bị bỏ lúc render.
  let tokens = {}, layout = [];
  if (!f.reset) {
    const HEX = /^#[0-9a-fA-F]{6}$/;
    for (const k of ['color.primary', 'color.accent', 'color.hero-bg', 'color.text', 'color.surface']) {
      const v = String(f[k] ?? ''); if (HEX.test(v)) tokens[k] = v;
    }
    if (tokens['color.primary']) tokens['color.primary-dark'] = tokens['color.primary']; // màu hover nút
    const font = String(f.font ?? '').trim();
    if (font) { tokens['font.body'] = font; tokens['font.heading'] = font; }
    const radius = String(f.radius ?? '').trim();
    if (/^\d{1,4}px$/.test(radius)) tokens['radius'] = radius;
    // layout: giữ cấu trúc chuẩn, chỉ nạp props hero + tiêu đề khu sản phẩm.
    const heroProps = {};
    const eb = String(f.hero_eyebrow ?? '').trim(); if (eb) heroProps.eyebrow = eb.slice(0, 60);
    const ht = String(f.hero_title ?? '').trim(); if (ht) heroProps.title = ht.slice(0, 120);
    const hs = String(f.hero_subtitle ?? '').trim(); if (hs) heroProps.subtitle = hs.slice(0, 300);
    const gt = String(f.grid_title ?? '').trim();
    layout = [
      { section: 'header', props: {} },
      { section: 'hero', props: heroProps },
      { section: 'product_grid', props: gt ? { title: gt.slice(0, 80) } : {} },
      { section: 'footer', props: {} },
    ];
  }
  const r = await sellerApi('PUT', `/shops/${shopId}/theme`, { cookie, body: { tokens, layout } });
  return redirect(res, `/shops/${shopId}/theme?ok=${r.status === 200 ? 1 : 0}`);
}

// ── Thanh toán (payment.write = owner; PUT payment-config đòi step-up) ────────
async function paymentPage(res, me, cookie, shopId, notice, err, tokenInfo = null) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'payment');
  if (roleFor(me, shopId) !== 'owner') return sendHtml(res, 200, V.renderPayment(ctx, shopId, null, null, null));
  const [cfgR, sepayR, recR] = await Promise.all([
    sellerApi('GET', `/shops/${shopId}/payment-config`, { cookie }),
    sellerApi('GET', `/shops/${shopId}/payment/sepay`, { cookie }),
    sellerApi('GET', `/shops/${shopId}/payment/reconcile`, { cookie }),
  ]);
  const cfg = cfgR.status === 200 ? cfgR.json : {};
  const sepay = sepayR.status === 200 ? sepayR.json : null;
  const reconcile = recR.status === 200 ? (recR.json?.transfers ?? []) : [];
  return sendHtml(res, err ? 400 : 200, V.renderPayment(ctx, shopId, cfg, notice, err, sepay, reconcile, tokenInfo));
}
// SePay per-shop: bật/tắt token (step-up) + đối soát tay giao dịch chưa khớp (step-up).
async function doSepayOp(res, me, cookie, shopId, op) {
  if (op === 'disable') {
    const r = await sellerApi('POST', `/shops/${shopId}/payment/sepay/disable`, { cookie, body: {} });
    return paymentPage(res, me, cookie, shopId, r.status === 200 ? 'Đã tắt SePay.' : null, r.status === 200 ? null : (r.json?.error ?? 'Không tắt được SePay.'));
  }
  const r = await sellerApi('POST', `/shops/${shopId}/payment/sepay/enable`, { cookie, body: {} });
  if (r.status === 200) return paymentPage(res, me, cookie, shopId, null, null, { webhook_url: r.json.webhook_url, api_key: r.json.api_key });
  return paymentPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không bật được SePay.');
}
async function sepayOp(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  if (roleFor(me, shopId) !== 'owner') return paymentPage(res, me, cookie, shopId, null, 'Chỉ chủ cửa hàng.');
  const f = await readForm(req);
  const op = f.__op === 'disable' ? 'disable' : 'enable';
  if (steppedUp(me)) return doSepayOp(res, me, cookie, shopId, op);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'payment');
  return sendHtml(res, 200, V.renderSepayStepUp(ctx, shopId, op, null, null));
}
async function sepayStepUp(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const op = f.__op === 'disable' ? 'disable' : 'enable';
  const r = await authApi('POST', '/auth/step-up', { cookie, body: { password: String(f.password ?? '') } });
  if (r.status !== 200) {
    const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'payment');
    return sendHtml(res, 401, V.renderSepayStepUp(ctx, shopId, op, null, r.status === 429 ? 'Quá nhiều lần thử, đợi chút.' : 'Mật khẩu không đúng.'));
  }
  return doSepayOp(res, me, cookie, shopId, op);
}
async function doReconcileResolve(res, me, cookie, shopId, txnId) {
  const r = await sellerApi('POST', `/shops/${shopId}/payment/reconcile/${txnId}/resolve`, { cookie, body: {} });
  return paymentPage(res, me, cookie, shopId, r.status === 200 ? 'Đã đánh dấu giao dịch đã xử lý.' : null, r.status === 200 ? null : (r.json?.error ?? 'Không xử lý được.'));
}
async function reconcileResolve(req, res, me, cookie, shopId, txnId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  if (roleFor(me, shopId) !== 'owner') return paymentPage(res, me, cookie, shopId, null, 'Chỉ chủ cửa hàng.');
  if (steppedUp(me)) return doReconcileResolve(res, me, cookie, shopId, txnId);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'payment');
  return sendHtml(res, 200, V.renderSepayStepUp(ctx, shopId, 'resolve', txnId, null));
}
async function reconcileResolveStepUp(req, res, me, cookie, shopId, txnId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const r = await authApi('POST', '/auth/step-up', { cookie, body: { password: String(f.password ?? '') } });
  if (r.status !== 200) {
    const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'payment');
    return sendHtml(res, 401, V.renderSepayStepUp(ctx, shopId, 'resolve', txnId, r.status === 429 ? 'Quá nhiều lần thử, đợi chút.' : 'Mật khẩu không đúng.'));
  }
  return doReconcileResolve(res, me, cookie, shopId, txnId);
}
// Chuẩn hoá form (giữ nguyên qua interstitial step-up): chỉ số cho bin/account.
function paymentForm(f) {
  return {
    bank_bin: String(f.bank_bin ?? '').replace(/\D/g, '').slice(0, 6),
    account_number: String(f.account_number ?? '').replace(/\D/g, '').slice(0, 19),
    account_name: String(f.account_name ?? '').trim().slice(0, 100),
    qr_enabled: (f.qr_enabled === '1' || f.qr_enabled === 'on') ? '1' : '',
  };
}
async function doPaymentSave(res, me, cookie, shopId, form) {
  const body = { bank_bin: form.bank_bin, account_number: form.account_number, account_name: form.account_name, qr_enabled: form.qr_enabled === '1' };
  const r = await sellerApi('PUT', `/shops/${shopId}/payment-config`, { cookie, body });
  if (r.status === 200) return paymentPage(res, me, cookie, shopId, 'Đã lưu cấu hình thanh toán.', null);
  return paymentPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không lưu được cấu hình.');
}
async function paymentStepUpPage(res, me, cookie, shopId, form, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'payment');
  return sendHtml(res, err ? 401 : 200, V.renderPaymentStepUp(ctx, shopId, form, err));
}
async function paymentSave(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const form = paymentForm(await readForm(req));
  return steppedUp(me) ? doPaymentSave(res, me, cookie, shopId, form) : paymentStepUpPage(res, me, cookie, shopId, form, null);
}
async function paymentStepUp(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const form = paymentForm(f);
  const r = await authApi('POST', '/auth/step-up', { cookie, body: { password: String(f.password ?? '') } });
  if (r.status !== 200) return paymentStepUpPage(res, me, cookie, shopId, form, r.status === 429 ? 'Quá nhiều lần thử, đợi chút.' : 'Mật khẩu không đúng.');
  return doPaymentSave(res, me, cookie, shopId, form);
}

// ── Xác nhận TAY đơn QR đã nhận tiền (payment.write = owner; step-up) ─────────
async function doMarkPaidQr(res, me, cookie, shopId, oid) {
  const r = await sellerApi('POST', `/shops/${shopId}/orders/${oid}/mark-paid-qr`, { cookie, body: {} });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/orders/${oid}`);
  return orderDetail(res, me, cookie, shopId, oid, r.json?.error ?? 'Không xác nhận được thanh toán.');
}
async function markPaidQrConfirm(res, me, cookie, shopId, oid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  if (roleFor(me, shopId) !== 'owner') return orderDetail(res, me, cookie, shopId, oid, 'Chỉ chủ cửa hàng mới xác nhận thanh toán QR thủ công.');
  if (steppedUp(me)) return doMarkPaidQr(res, me, cookie, shopId, oid);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
  return sendHtml(res, 200, V.renderOrderPayStepUp(ctx, shopId, oid, null));
}
async function markPaidQrStepUp(req, res, me, cookie, shopId, oid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const r = await authApi('POST', '/auth/step-up', { cookie, body: { password: String(f.password ?? '') } });
  if (r.status !== 200) {
    const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
    return sendHtml(res, 401, V.renderOrderPayStepUp(ctx, shopId, oid, r.status === 429 ? 'Quá nhiều lần thử, đợi chút.' : 'Mật khẩu không đúng.'));
  }
  return doMarkPaidQr(res, me, cookie, shopId, oid);
}

// ── Cài đặt / Hồ sơ cửa hàng (shop.write = owner/admin) ──────────────────────
async function settingsPage(res, me, cookie, shopId, notice, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'settings');
  const r = await sellerApi('GET', `/shops/${shopId}`, { cookie });
  const shop = r.status === 200 ? r.json : {};
  return sendHtml(res, err ? 400 : 200, V.renderShopSettings(ctx, shopId, shop, notice, err));
}
async function logoUpload(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  let file, tooBig = false;
  try { file = await readMultipartFile(req); } catch (e) { tooBig = e.statusCode === 413; }
  if (tooBig) return settingsPage(res, me, cookie, shopId, null, 'Ảnh quá lớn (tối đa 10MB).');
  if (!file?.bytes?.length) return settingsPage(res, me, cookie, shopId, null, 'Chưa chọn ảnh logo hợp lệ.');
  const r = await sellerUpload(`/shops/${shopId}/logo`, { cookie, bytes: file.bytes });
  if (r.status !== 200) return settingsPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không tải được logo.');
  return settingsPage(res, me, cookie, shopId, 'Đã cập nhật logo cửa hàng.', null);
}
async function logoRemove(res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('DELETE', `/shops/${shopId}/logo`, { cookie });
  if (r.status !== 200) return settingsPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không gỡ được logo.');
  return settingsPage(res, me, cookie, shopId, 'Đã gỡ logo.', null);
}
async function settingsSave(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const body = {
    name: String(f.name ?? '').trim(),
    contact_email: String(f.contact_email ?? '').trim(),
    contact_phone: String(f.contact_phone ?? '').trim(),
    business_address: String(f.business_address ?? '').trim(),
    ship_fee_vnd: String(f.ship_fee_vnd ?? '').trim(),
    free_ship_threshold_vnd: String(f.free_ship_threshold_vnd ?? '').trim(),
  };
  const r = await sellerApi('PATCH', `/shops/${shopId}`, { cookie, body });
  if (r.status === 200) return settingsPage(res, me, cookie, shopId, 'Đã lưu hồ sơ cửa hàng.', null);
  return settingsPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không lưu được hồ sơ.');
}

// ── Hoàn tiền (refund = owner/admin; step-up) ────────────────────────────────
async function doRefund(res, me, cookie, shopId, oid) {
  const r = await sellerApi('POST', `/shops/${shopId}/orders/${oid}/refund`, { cookie, body: {} });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/orders/${oid}`);
  return orderDetail(res, me, cookie, shopId, oid, r.json?.error ?? 'Không hoàn tiền được.');
}
async function refundConfirm(res, me, cookie, shopId, oid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  if (!['owner', 'admin'].includes(roleFor(me, shopId))) return orderDetail(res, me, cookie, shopId, oid, 'Chỉ chủ cửa hàng hoặc quản trị mới hoàn tiền.');
  if (steppedUp(me)) return doRefund(res, me, cookie, shopId, oid);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
  return sendHtml(res, 200, V.renderRefundStepUp(ctx, shopId, oid, null));
}
async function refundStepUp(req, res, me, cookie, shopId, oid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const r = await authApi('POST', '/auth/step-up', { cookie, body: { password: String(f.password ?? '') } });
  if (r.status !== 200) {
    const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
    return sendHtml(res, 401, V.renderRefundStepUp(ctx, shopId, oid, r.status === 429 ? 'Quá nhiều lần thử, đợi chút.' : 'Mật khẩu không đúng.'));
  }
  return doRefund(res, me, cookie, shopId, oid);
}

async function handle(req, res, url, p) {
    if (req.method === 'POST' && !sameOrigin(req, ALLOWED)) return sendHtml(res, 403, V.renderError({}, 'Yêu cầu không hợp lệ (origin).'));
    const cookie = parseCookies(req)[SESSION_COOKIE];

    // Trang công khai (auth).
    if (p === '/login' && req.method === 'GET') return (await loadSession(cookie)).state === 'ok' ? redirect(res, '/') : sendHtml(res, 200, V.renderLogin());
    if (p === '/login' && req.method === 'POST') return handleLogin(req, res);
    if (p === '/mfa' && req.method === 'GET') return sendHtml(res, 200, V.renderMfa());
    if (p === '/mfa' && req.method === 'POST') return handleMfa(req, res, cookie);
    if (p === '/logout' && req.method === 'POST') return handleLogout(req, res, cookie);
    // Chấp nhận lời mời: CÔNG KHAI (người được mời chưa có phiên). POST vẫn qua sameOrigin.
    if (p === '/invite/accept' && req.method === 'GET') return inviteAcceptPage(res, url);
    if (p === '/invite/accept' && req.method === 'POST') return inviteAcceptSubmit(req, res, cookie);

    // Còn lại: cần phiên ĐẦY ĐỦ.
    const sess = await loadSession(cookie);
    if (sess.state === 'mfa') return redirect(res, '/mfa');
    if (sess.state !== 'ok') return redirect(res, '/login');
    const me = sess.me;

    if (p === '/' && req.method === 'GET') return dashboard(res, me, cookie);

    // Console nền tảng (chỉ platform_staff — gate ẩn qua platform requireStaff).
    let pm;
    if (p === '/platform' && req.method === 'GET') return platformShops(res, me, cookie);
    if (p === '/platform/new' && req.method === 'GET') return platformShopNew(res, me, null, {});
    if (p === '/platform' && req.method === 'POST') return platformCreate(req, res, me, cookie);
    if ((pm = new RegExp(`^/platform/shops/${UUID}$`).exec(p)) && req.method === 'GET') return platformShopDetail(res, me, cookie, pm[1]);
    if ((pm = new RegExp(`^/platform/shops/${UUID}/invite$`).exec(p)) && req.method === 'POST') return platformInvite(req, res, me, cookie, pm[1]);
    if ((pm = new RegExp(`^/platform/shops/${UUID}/(suspend|restore)$`).exec(p)) && req.method === 'POST') return platformStatus(res, me, cookie, pm[1], pm[2]);
    if ((pm = new RegExp(`^/platform/shops/${UUID}/renew$`).exec(p)) && req.method === 'POST') return platformRenew(req, res, me, cookie, pm[1]);

    // Tài khoản (cá nhân, không theo shop).
    if (p === '/account' && req.method === 'GET') return accountPage(res, me, cookie);
    if (p === '/account/mfa/enroll' && req.method === 'POST') return mfaEnrollStart(res, me, cookie);
    if (p === '/account/mfa/activate' && req.method === 'POST') return mfaActivate(req, res, me, cookie);
    if (p === '/account/mfa/disable' && req.method === 'POST') return mfaDisableSubmit(req, res, me, cookie);
    if (p === '/account/password/forgot' && req.method === 'POST') return passwordForgot(res, me, cookie);
    if (p === '/account/password/change' && req.method === 'POST') return passwordChange(req, res, me, cookie);
    if (p === '/account/sessions/revoke' && req.method === 'POST') return sessionRevoke(req, res, me, cookie);
    if (p === '/account/sessions/revoke-others' && req.method === 'POST') return sessionRevokeOthers(res, me, cookie);

    let m;
    if ((m = new RegExp(`^/shops/${UUID}/overview$`).exec(p)) && req.method === 'GET') return overviewPage(res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/orders$`).exec(p)) && req.method === 'GET') return ordersList(res, me, cookie, m[1], url.searchParams);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}$`).exec(p)) && req.method === 'GET') return orderDetail(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/print$`).exec(p)) && req.method === 'GET') return orderPrint(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/(confirm|ship|cancel|deliver|mark-paid)$`).exec(p)) && req.method === 'POST') return orderAction(req, res, me, cookie, m[1], m[2], m[3]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/mark-paid-qr$`).exec(p)) && req.method === 'POST') return markPaidQrConfirm(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/mark-paid-qr/step-up$`).exec(p)) && req.method === 'POST') return markPaidQrStepUp(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/refund$`).exec(p)) && req.method === 'POST') return refundConfirm(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/refund/step-up$`).exec(p)) && req.method === 'POST') return refundStepUp(req, res, me, cookie, m[1], m[2]);

    // Sản phẩm & tồn kho.
    if ((m = new RegExp(`^/shops/${UUID}/products$`).exec(p)) && req.method === 'GET') return productsList(res, me, cookie, m[1], url.searchParams);
    if ((m = new RegExp(`^/shops/${UUID}/products$`).exec(p)) && req.method === 'POST') return productCreate(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/products/new$`).exec(p)) && req.method === 'GET') return productNew(res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/products/import$`).exec(p)) && req.method === 'GET') return productImportPage(res, me, cookie, m[1], null, null);
    if ((m = new RegExp(`^/shops/${UUID}/products/import$`).exec(p)) && req.method === 'POST') return productImport(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/categories$`).exec(p)) && req.method === 'POST') return productCategoriesSave(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/blog$`).exec(p)) && req.method === 'GET') return blogList(res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/blog/new$`).exec(p)) && req.method === 'GET') return blogNew(res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/blog$`).exec(p)) && req.method === 'POST') return blogCreate(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/blog/${UUID}/publish$`).exec(p)) && req.method === 'POST') return blogStatus(res, me, cookie, m[1], m[2], 'publish');
    if ((m = new RegExp(`^/shops/${UUID}/blog/${UUID}/unpublish$`).exec(p)) && req.method === 'POST') return blogStatus(res, me, cookie, m[1], m[2], 'unpublish');
    if ((m = new RegExp(`^/shops/${UUID}/blog/${UUID}/delete$`).exec(p)) && req.method === 'POST') return blogDelete(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/blog/${UUID}$`).exec(p)) && req.method === 'GET') return blogEditor(res, me, cookie, m[1], m[2], null);
    if ((m = new RegExp(`^/shops/${UUID}/blog/${UUID}$`).exec(p)) && req.method === 'POST') return blogUpdate(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/categories$`).exec(p)) && req.method === 'GET') return categoriesPage(res, me, cookie, m[1], null, null);
    if ((m = new RegExp(`^/shops/${UUID}/categories$`).exec(p)) && req.method === 'POST') return categoryCreate(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/categories/${UUID}/delete$`).exec(p)) && req.method === 'POST') return categoryDelete(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/categories/${UUID}$`).exec(p)) && req.method === 'POST') return categoryUpdate(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/coupons$`).exec(p)) && req.method === 'GET') return couponsPage(res, me, cookie, m[1], null, null);
    if ((m = new RegExp(`^/shops/${UUID}/coupons$`).exec(p)) && req.method === 'POST') return couponCreate(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/coupons/${UUID}/toggle$`).exec(p)) && req.method === 'POST') return couponToggle(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/coupons/${UUID}/delete$`).exec(p)) && req.method === 'POST') return couponDelete(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}$`).exec(p)) && req.method === 'GET') return productDetail(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}$`).exec(p)) && req.method === 'POST') return productUpdate(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/(publish|archive)$`).exec(p)) && req.method === 'POST') return productStatus(res, me, cookie, m[1], m[2], m[3]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/delete$`).exec(p)) && req.method === 'POST') return productDelete(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/variants$`).exec(p)) && req.method === 'POST') return variantAdd(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/variants/${UUID}/delete$`).exec(p)) && req.method === 'POST') return variantDelete(res, me, cookie, m[1], m[2], m[3]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/variants/${UUID}/inventory$`).exec(p)) && req.method === 'POST') return inventoryAdjust(req, res, me, cookie, m[1], m[2], m[3]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/media$`).exec(p)) && req.method === 'POST') return mediaUpload(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/media/${UUID}/delete$`).exec(p)) && req.method === 'POST') return mediaDelete(res, me, cookie, m[1], m[2], m[3]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/media/${UUID}/(moveup|movedown|primary)$`).exec(p)) && req.method === 'POST') return mediaMove(res, me, cookie, m[1], m[2], m[3], m[4]);

    // Trang nội dung.
    if ((m = new RegExp(`^/shops/${UUID}/pages$`).exec(p)) && req.method === 'GET') return pagesList(res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/pages$`).exec(p)) && req.method === 'POST') return pageCreate(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/pages/new$`).exec(p)) && req.method === 'GET') return pageNew(res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/pages/${UUID}$`).exec(p)) && req.method === 'GET') return pageEditor(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/pages/${UUID}$`).exec(p)) && req.method === 'POST') return pageUpdate(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/pages/${UUID}/publish$`).exec(p)) && req.method === 'POST') return pagePublish(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/pages/${UUID}/preview$`).exec(p)) && req.method === 'POST') return pagePreview(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/pages/${UUID}/rollback$`).exec(p)) && req.method === 'POST') return pageRollback(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/pages/${UUID}/delete$`).exec(p)) && req.method === 'POST') return pageDelete(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/pages/${UUID}/blocks$`).exec(p)) && req.method === 'POST') return blockAdd(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/pages/${UUID}/blocks/${UUID}/(edit|delete|moveup|movedown)$`).exec(p)) && req.method === 'POST') {
      if (m[4] === 'edit') return blockEdit(req, res, me, cookie, m[1], m[2], m[3]);
      if (m[4] === 'delete') return blockDelete(res, me, cookie, m[1], m[2], m[3]);
      return blockMove(res, me, cookie, m[1], m[2], m[3], m[4] === 'moveup' ? 'up' : 'down');
    }

    // Nhân sự.
    if ((m = new RegExp(`^/shops/${UUID}/members$`).exec(p)) && req.method === 'GET') return membersList(res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/members/invite$`).exec(p)) && req.method === 'POST') return memberInvite(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/members/step-up$`).exec(p)) && req.method === 'POST') return memberStepUp(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/members/${UUID}/role$`).exec(p)) && req.method === 'POST') return memberRole(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/members/${UUID}/remove$`).exec(p)) && req.method === 'POST') return memberRemove(res, me, cookie, m[1], m[2]);

    // Xuất dữ liệu (owner).
    if ((m = new RegExp(`^/shops/${UUID}/export$`).exec(p)) && req.method === 'GET') return exportPage(res, me, cookie, m[1], null, null);
    if ((m = new RegExp(`^/shops/${UUID}/export$`).exec(p)) && req.method === 'POST') return exportCreate(res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/export/step-up$`).exec(p)) && req.method === 'POST') return exportStepUp(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/export/download$`).exec(p)) && req.method === 'GET') return exportDownload(res, me, cookie, m[1], url.searchParams.get('token') ?? '');

    // Tên miền (owner).
    if ((m = new RegExp(`^/shops/${UUID}/domains$`).exec(p)) && req.method === 'GET') return domainsPage(res, me, cookie, m[1], null, null);
    if ((m = new RegExp(`^/shops/${UUID}/domains$`).exec(p)) && req.method === 'POST') return domainAdd(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/domains/step-up$`).exec(p)) && req.method === 'POST') return domainStepUp(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/domains/${UUID}/(primary|revoke)$`).exec(p)) && req.method === 'POST') return domainAction(res, me, cookie, m[1], m[2], m[3]);

    // Thanh toán (payment.write = owner + step-up).
    if ((m = new RegExp(`^/shops/${UUID}/payment$`).exec(p)) && req.method === 'GET') return paymentPage(res, me, cookie, m[1], null, null);
    if ((m = new RegExp(`^/shops/${UUID}/payment$`).exec(p)) && req.method === 'POST') return paymentSave(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/payment/step-up$`).exec(p)) && req.method === 'POST') return paymentStepUp(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/payment/sepay$`).exec(p)) && req.method === 'POST') return sepayOp(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/payment/sepay/step-up$`).exec(p)) && req.method === 'POST') return sepayStepUp(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/payment/reconcile/${UUID}/resolve$`).exec(p)) && req.method === 'POST') return reconcileResolve(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/payment/reconcile/${UUID}/resolve/step-up$`).exec(p)) && req.method === 'POST') return reconcileResolveStepUp(req, res, me, cookie, m[1], m[2]);

    // Cài đặt / hồ sơ cửa hàng (shop.write = owner/admin).
    if ((m = new RegExp(`^/shops/${UUID}/settings$`).exec(p)) && req.method === 'GET') return settingsPage(res, me, cookie, m[1], null, null);
    if ((m = new RegExp(`^/shops/${UUID}/settings$`).exec(p)) && req.method === 'POST') return settingsSave(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/logo$`).exec(p)) && req.method === 'POST') return logoUpload(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/logo/remove$`).exec(p)) && req.method === 'POST') return logoRemove(res, me, cookie, m[1]);

    // Giao diện (theme.write = owner/admin).
    if ((m = new RegExp(`^/shops/${UUID}/theme$`).exec(p)) && req.method === 'GET') return themePage(res, me, cookie, m[1], url.searchParams.get('ok'));
    if ((m = new RegExp(`^/shops/${UUID}/theme$`).exec(p)) && req.method === 'POST') return themeSave(req, res, me, cookie, m[1]);

    return sendHtml(res, 404, V.renderError({ user: me }, 'Không tìm thấy trang.'));
}

const server = http.createServer((req, res) => runReq(req, res, async () => {
  const url = new URL(req.url, 'http://internal');
  const p = url.pathname;
  if (await health(url.pathname, res, {})) return;
  try {
    await handle(req, res, url, p);
  } catch (err) {
    log('error', 'handler_error', { path: p, message: err.message });
    if (!res.headersSent) sendHtml(res, 500, V.renderError({}, 'Lỗi hệ thống, vui lòng thử lại.'));
  }
}));

server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT }));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
