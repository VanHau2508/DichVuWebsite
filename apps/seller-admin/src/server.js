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
import { parseCookies, readForm, readMultipartFile, sendHtml, redirect, sendDownload, sameOrigin, SESSION_COOKIE } from './http.js';
import { authApi, sellerApi, sellerUpload, sellerDownload, loadSession } from './api.js';
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
  const [, media] = await Promise.all([loadLevels, loadMedia]);
  return sendHtml(res, err ? 409 : 200, V.renderProductDetail(ctx, shopId, r.json, levels, err, form, media));
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
    // Chấp nhận lời mời: CÔNG KHAI (người được mời chưa có phiên). POST vẫn qua sameOrigin.
    if (p === '/invite/accept' && req.method === 'GET') return inviteAcceptPage(res, url);
    if (p === '/invite/accept' && req.method === 'POST') return inviteAcceptSubmit(req, res, cookie);

    // Còn lại: cần phiên ĐẦY ĐỦ.
    const sess = await loadSession(cookie);
    if (sess.state === 'mfa') return redirect(res, '/mfa');
    if (sess.state !== 'ok') return redirect(res, '/login');
    const me = sess.me;

    if (p === '/' && req.method === 'GET') return dashboard(res, me, cookie);

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
    if ((m = new RegExp(`^/shops/${UUID}/orders$`).exec(p)) && req.method === 'GET') return ordersList(res, me, cookie, m[1], url.searchParams);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}$`).exec(p)) && req.method === 'GET') return orderDetail(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/(confirm|ship|cancel|deliver|mark-paid)$`).exec(p)) && req.method === 'POST') return orderAction(req, res, me, cookie, m[1], m[2], m[3]);

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
