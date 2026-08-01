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
import fs from 'node:fs';
import crypto from 'node:crypto';
import { parseCookies, readForm, readFormAll, readMultipartFile, readMultipartFiles, readMultipartAll, sendHtml, sendHtmlJs, redirect, sendDownload, sameOrigin, SESSION_COOKIE } from './http.js';
import { authApi, sellerApi, platformApi, sellerUpload, sellerDownload, loadSession } from './api.js';
import * as V from './pages.js';
import { getPreset } from '../presets.js';
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
async function platformShops(res, me, cookie, sp) {
  // Danh sách shop + số liệu điều hành — song song. Tìm/lọc/phân trang no-JS:
  // ?q/?sub_status/?page forward nguyên sang /ops/shops (platform tự validate).
  // /ops/metrics lỗi lẻ → vẫn render danh sách (khối Tổng quan tự ẩn), KHÔNG sập trang.
  const filters = {
    q: String(sp?.get('q') ?? '').trim().slice(0, 100),
    sub_status: String(sp?.get('sub_status') ?? '').trim(),
    activity: String(sp?.get('activity') ?? '').trim(),
    page: Math.max(1, parseInt(sp?.get('page') ?? '1', 10) || 1),
  };
  const qs = new URLSearchParams();
  if (filters.q) qs.set('q', filters.q);
  if (filters.sub_status) qs.set('sub_status', filters.sub_status);
  if (filters.activity) qs.set('activity', filters.activity);
  if (filters.page > 1) qs.set('page', String(filters.page));
  const qstr = qs.toString();
  const [r, mr] = await Promise.all([
    platformApi('GET', `/ops/shops${qstr ? `?${qstr}` : ''}`, { cookie }),
    platformApi('GET', '/ops/metrics', { cookie }).catch(() => ({ status: 0, json: null })),
  ]);
  if (r.status !== 200) return platDenied(res, me);
  return sendHtml(res, 200, V.renderPlatformShops(platCtx(me), r.json ?? {}, mr.status === 200 ? mr.json : null, filters));
}
async function platformShopNew(res, me, cookie, err, form) {
  // Select gói render từ DB qua /ops/plans (đã giết giá hardcode trong pages.js).
  const pr = await platformApi('GET', '/ops/plans', { cookie });
  if (isDenied(pr.status)) return platDenied(res, me);
  return sendHtml(res, err ? 400 : 200, V.renderPlatformShopNew(platCtx(me), err, form, pr.json?.plans ?? []));
}
async function platformCreate(req, res, me, cookie) {
  const f = await readForm(req);
  const body = { name: String(f.name ?? '').trim(), slug: String(f.slug ?? '').toLowerCase().trim(), plan_code: String(f.plan_code ?? '').trim() };
  const r = await platformApi('POST', '/ops/shops', { cookie, body });
  if (r.status === 201) return redirect(res, `/platform/shops/${r.json.id}`);
  if (isDenied(r.status)) return platDenied(res, me);
  return platformShopNew(res, me, cookie, r.json?.error ?? 'Không tạo được cửa hàng.', f);
}
// ── hàng đợi phiếu hỗ trợ (0108) ─────────────────────────────────────────────
async function platformSupport(res, me, cookie, sp, opts = {}) {
  const status = sp?.get('status') === 'resolved' ? 'resolved' : 'open';
  const page = Math.max(1, parseInt(sp?.get('page') ?? '1', 10) || 1);
  const q = (sp?.get('q') ?? '').trim().slice(0, 100);
  const r = await platformApi('GET',
    `/ops/support?status=${status}${page > 1 ? `&page=${page}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`, { cookie });
  if (r.status !== 200) return platDenied(res, me);
  const done = sp?.get('done');
  const notice = done === 'resolve'
    ? (sp?.get('already') ? 'Phiếu này đã được xử lý trước đó.' : 'Đã đánh dấu xử lý xong — người bán nhận được thông báo.')
    : done === 'reopen' ? 'Đã mở lại phiếu.' : null;
  return sendHtml(res, 200, V.renderPlatformSupport(platCtx(me), r.json ?? {}, { notice, ...opts }));
}
// PRG: xử lý xong thì REDIRECT về đúng tab đang đứng. F5 sau khi bấm "đã xử lý" mà POST lại
// thì cũng vô hại (endpoint idempotent theo guard status), nhưng để trình duyệt hỏi
// "gửi lại biểu mẫu?" là bắt người ta đoán — cứ redirect cho hết chuyện.
async function platformSupportAction(req, res, me, cookie, ticketId, action) {
  const f = await readForm(req);
  const back = f.status === 'resolved' ? 'resolved' : 'open';
  const r = await platformApi('POST', `/ops/support/${ticketId}/${action}`, { cookie, body: { note: String(f.note ?? '') } });
  if (isDenied(r.status)) return platDenied(res, me);
  if (r.status !== 200) {
    return platformSupport(res, me, cookie, new URLSearchParams({ status: back }), { err: r.json?.error ?? 'Thao tác không thực hiện được.' });
  }
  const done = action === 'resolve' ? 'resolved' : 'open';
  return redirect(res, `/platform/support?status=${done}&done=${action}${r.json?.already ? '&already=1' : ''}`);
}

async function platformShopDetail(res, me, cookie, shopId, opts = {}) {
  const [r, pr] = await Promise.all([
    platformApi('GET', `/ops/shops/${shopId}`, { cookie }),
    platformApi('GET', '/ops/plans', { cookie }),
  ]);
  if (isDenied(r.status)) return platDenied(res, me);
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError({ user: me }, r.json?.error ?? 'Không tìm thấy cửa hàng.'));
  return sendHtml(res, 200, V.renderPlatformShopDetail(platCtx(me), r.json, { ...opts, plans: pr.json?.plans ?? [] }));
}
async function platformInvite(req, res, me, cookie, shopId) {
  const f = await readForm(req);
  const r = await platformApi('POST', `/ops/shops/${shopId}/invitations`, { cookie, body: { email: String(f.email ?? '').trim(), role: 'owner' } });
  if (isDenied(r.status)) return platDenied(res, me);
  if (r.status !== 201) return platformShopDetail(res, me, cookie, shopId, { err: r.json?.error ?? 'Không tạo được lời mời.' });
  // Token KHÔNG còn trong response (email hoá lời mời, 0073) — chỉ báo đã gửi email.
  const invite = { email: String(f.email ?? '').trim(), expires_at: r.json.expires_at };
  return platformShopDetail(res, me, cookie, shopId, { invite, notice: `Đã gửi email lời mời tới ${invite.email}.` });
}
// Step-up PHẢN ỨNG (khác phía shop chủ động): platform trả 403 step_up_required
// → mới hiện form mật khẩu. Cố ý: non-staff nhận 403 THƯỜNG từ requireStaff →
// platDenied như cũ, không bị lộ một form mật khẩu vô nghĩa.
async function platformStatus(res, me, cookie, shopId, action) {
  const r = await platformApi('POST', `/ops/shops/${shopId}/${action}`, { cookie, body: {} });
  if (r.json?.step_up_required) return platformStepUpPage(res, me, shopId, action, {});
  if (isDenied(r.status)) return platDenied(res, me);
  const okMsg = action === 'suspend' ? 'Đã tạm khoá cửa hàng.' : 'Đã mở lại cửa hàng.';
  return platformShopDetail(res, me, cookie, shopId, r.status === 200 ? { notice: okMsg } : { err: r.json?.error ?? 'Thao tác không thực hiện được.' });
}
// Tách gate (đọc form) khỏi core: nhánh retry sau step-up không còn req gốc,
// chỉ còn tham số đã parse (mirror domainStepUp/doDomainAdd).
async function platformRenew(req, res, me, cookie, shopId) {
  const f = await readForm(req);
  const p = { months: String(f.months ?? '1'), plan_code: f.plan_code ? String(f.plan_code) : '', amount_vnd: String(f.amount_vnd ?? '').trim(), note: String(f.note ?? '').trim() };
  return doPlatformRenew(res, me, cookie, shopId, p);
}
async function doPlatformRenew(res, me, cookie, shopId, p) {
  const body = { months: p.months };
  if (p.plan_code) body.plan_code = p.plan_code;
  // Số tiền ghi đè (deal thương lượng) + ghi chú — để trống = server tự tính giá gói × tháng.
  if (p.amount_vnd !== '') body.amount_vnd = Number(p.amount_vnd);
  if (p.note !== '') body.note = p.note;
  const r = await platformApi('POST', `/ops/shops/${shopId}/subscription/renew`, { cookie, body });
  if (r.json?.step_up_required) return platformStepUpPage(res, me, shopId, 'renew', p);
  if (isDenied(r.status)) return platDenied(res, me);
  return platformShopDetail(res, me, cookie, shopId, r.status === 200
    ? { notice: `Đã ghi nhận thu ${new Intl.NumberFormat('vi-VN').format(r.json?.amount_vnd ?? 0)}₫ — gia hạn ${r.json?.months} tháng${body.plan_code ? ` (gói ${body.plan_code})` : ''}, mở lại shop nếu đang khoá.` }
    : { err: r.json?.error ?? 'Không gia hạn được.' });
}
// Chấm dứt hợp đồng (terminate — admin + step-up + gõ đúng slug). Sau khi đóng,
// trang chi tiết 404 (platform set deleted_at) → quay về danh sách Console.
// Tham số confirm_slug SỐNG SÓT qua màn step-up (hidden — mirror renew).
async function platformTerminate(req, res, me, cookie, shopId) {
  const f = await readForm(req);
  return doPlatformTerminate(res, me, cookie, shopId, { confirm_slug: String(f.confirm_slug ?? '').trim() });
}
async function doPlatformTerminate(res, me, cookie, shopId, p) {
  const r = await platformApi('POST', `/ops/shops/${shopId}/terminate`, { cookie, body: { confirm_slug: p.confirm_slug } });
  if (r.json?.step_up_required) return platformStepUpPage(res, me, shopId, 'terminate', p);
  if (r.status === 200) return redirect(res, '/platform');
  // Lỗi nghiệp vụ (409 chưa suspended / 422 sai slug / 403 thiếu quyền admin) →
  // hiện ngay trên trang chi tiết; non-staff bị chính GET chi tiết platDenied.
  return platformShopDetail(res, me, cookie, shopId, { err: r.json?.error ?? 'Không chấm dứt được cửa hàng.' });
}
// Tải bản xuất dữ liệu QUẢN LÝ (nghĩa vụ "xuất dữ liệu rồi đóng" — Luật 91/2025).
// Chỉ dữ liệu quản lý nền tảng; dữ liệu nghiệp vụ do chủ shop tự xuất (ghi trong file).
async function platformExport(res, me, cookie, shopId) {
  const r = await platformApi('GET', `/ops/shops/${shopId}/export`, { cookie });
  if (isDenied(r.status)) return platDenied(res, me);
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError({ user: me }, r.json?.error ?? 'Không xuất được dữ liệu.'));
  const buf = Buffer.from(JSON.stringify(r.json, null, 2), 'utf8');
  return sendDownload(res, buf, { filename: `xuat-du-lieu-shop-${r.json?.shop?.slug ?? shopId}.json`, contentType: 'application/json; charset=utf-8' });
}
async function platformStepUpPage(res, me, shopId, action, params, err) {
  return sendHtml(res, err ? 401 : 200, V.renderPlatformStepUp(platCtx(me), shopId, action, params, err));
}
async function platformStepUp(req, res, me, cookie, shopId) {
  const f = await readForm(req);
  const action = String(f.__action ?? '');
  // Tham số theo action — terminate mang confirm_slug (phải sống sót cả khi gõ SAI
  // mật khẩu: form step-up render lại vẫn giữ hidden confirm_slug).
  const p = action === 'terminate'
    ? { confirm_slug: String(f.confirm_slug ?? '').trim() }
    : { months: String(f.months ?? '1'), plan_code: f.plan_code ? String(f.plan_code) : '', amount_vnd: String(f.amount_vnd ?? '').trim(), note: String(f.note ?? '').trim() };
  const r = await authApi('POST', '/auth/step-up', { cookie, body: { password: String(f.password ?? '') } });
  if (r.status !== 200) return platformStepUpPage(res, me, shopId, action, p, r.status === 429 ? 'Quá nhiều lần thử, đợi chút.' : 'Mật khẩu không đúng.');
  if (action === 'renew') return doPlatformRenew(res, me, cookie, shopId, p);
  if (action === 'terminate') return doPlatformTerminate(res, me, cookie, shopId, p);
  return platformStatus(res, me, cookie, shopId, action === 'restore' ? 'restore' : 'suspend');
}

async function overviewPage(res, me, cookie, shopId, live) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'overview');
  const r = await sellerApi('GET', `/shops/${shopId}/stats`, { cookie });
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tải được số liệu tổng quan.'));
  // Checklist onboarding — CHỈ dựng khi shop đang 'onboarding' (tránh gọi thừa cho shop đã active).
  // Gom tín hiệu THẬT song song; lỗi phụ (perm/timeout) → coi như chưa xong, không chặn trang.
  const shopR = await sellerApi('GET', `/shops/${shopId}`, { cookie }).catch(() => ({ status: 0 }));
  const shop = shopR.status === 200 ? shopR.json : null;
  let setup = null;
  if (shop && shop.status === 'onboarding') {
    const [payR, prodR] = await Promise.all([
      sellerApi('GET', `/shops/${shopId}/payment-config`, { cookie }).catch(() => ({ status: 0 })),
      sellerApi('GET', `/shops/${shopId}/products?limit=1`, { cookie }).catch(() => ({ status: 0 })),
    ]);
    const pay = payR.status === 200 && payR.json ? payR.json : {};
    setup = {
      payment: !!(pay.qr_enabled && pay.bank_bin && pay.account_number),
      products: prodR.status === 200 && Number(prodR.json?.catalog_count ?? 0) > 0,
      branding: !!shop.logo_url,                                    // logo_key → logo_url (seller build)
      shipping: shop.ship_fee_vnd != null || shop.ship_mode === 'distance',
      canManage: ctx.role === 'owner' || ctx.role === 'admin',     // shop.write (mở bán / cấu hình)
    };
  }
  const notice = live === '1' ? '🎉 Cửa hàng đã mở bán chính thức! Chúc bạn nhiều đơn hàng.' : null;
  return sendHtml(res, 200, V.renderOverview(ctx, shopId, r.json, setup, notice, shop?.status ?? null));
}

// Mở bán (BFF): onboarding → active qua seller, rồi về overview kèm chúc mừng. RBAC ở đây;
// sameOrigin ở cổng POST chung; seller cưỡng chế perm shop.write + chỉ lật khi đang onboarding.
async function activateShop(res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('POST', `/shops/${shopId}/activate`, { cookie });
  return redirect(res, `/shops/${shopId}/overview?live=${r.status === 200 ? 1 : 0}`);
}

async function ordersList(res, me, cookie, shopId, q) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const status = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'refunded', 'returned'].includes(q.get('status')) ? q.get('status') : '';
  const search = (q.get('q') ?? '').trim().slice(0, 100);
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const from = DATE_RE.test((q.get('from') ?? '').trim()) ? q.get('from').trim() : '';
  const to = DATE_RE.test((q.get('to') ?? '').trim()) ? q.get('to').trim() : '';
  const limit = 20, offset = Math.max(0, parseInt(q.get('offset') ?? '0', 10) || 0);
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const payment = ['unpaid', 'pending', 'paid', 'refunded'].includes(q.get('payment')) ? q.get('payment') : '';
  const source = ['web', 'manual', 'facebook', 'zalo', 'tiktok', 'other'].includes(q.get('source')) ? q.get('source') : '';
  if (status) qs.set('status', status);
  if (source) qs.set('source', source);
  if (payment) qs.set('payment', payment);
  if (search) qs.set('q', search);
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const r = await sellerApi('GET', `/shops/${shopId}/orders?${qs}`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tải được đơn hàng.'));
  return sendHtmlJs(res, 200, (nonce) => V.renderOrders({ ...ctx, nonce }, shopId, r.json, { status, payment, source, q: search, from, to, limit, offset }));
}

// ── Tạo đơn thủ công (nhân viên chốt đơn Facebook/Zalo rồi gõ vào) ─────────────
async function orderNewPage(res, me, cookie, shopId, err, form, q) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  // ?q= lọc picker phía seller (tên không dấu / SKU) — shop >500 biến thể vẫn chọn đúng hàng.
  const pq = (q ?? '').trim().slice(0, 100);
  const r = await sellerApi('GET', `/shops/${shopId}/sellable-variants${pq ? `?q=${encodeURIComponent(pq)}` : ''}`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tải được danh sách sản phẩm.'));
  // idem token chống double-submit: sinh MỚI mỗi lần render form (nhét hidden input).
  const idem = `manual-${crypto.randomUUID()}`;
  return sendHtml(res, err ? 400 : 200, V.renderOrderNew(ctx, shopId, r.json.variants ?? [], idem, err, form ?? {}, { q: pq, truncated: r.json.truncated === true }));
}
async function orderNewSubmit(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readFormAll(req); // getAll: 5 slot variant_id[]/qty[] trùng tên
  const vids = f.getAll('variant_id'), qtys = f.getAll('qty');
  const lines = [];
  for (let i = 0; i < vids.length; i++) {
    if (!vids[i]) continue; // slot bỏ trống
    lines.push({ variant_id: vids[i], qty: Number(qtys[i] ?? 0) });
  }
  const body = {
    lines,
    customer: {
      name: (f.get('name') ?? '').trim(), phone: (f.get('phone') ?? '').trim(),
      email: (f.get('email') ?? '').trim(), address_line: (f.get('address_line') ?? '').trim(),
      province: (f.get('province') ?? '').trim(),
    },
    payment_method: f.get('payment_method') === 'qr' ? 'qr' : 'cod',
    ship_fee_vnd: (f.get('ship_fee_vnd') ?? '').trim(),
    note: (f.get('note') ?? '').trim(),
    source: (f.get('source') ?? '').trim(),
    source_ref: (f.get('source_ref') ?? '').trim(),
    idempotency_key: String(f.get('idem') ?? ''),
  };
  const r = await sellerApi('POST', `/shops/${shopId}/orders`, { cookie, body });
  if (r.status === 201) return redirect(res, `/shops/${shopId}/orders/${r.json.id}`);
  // Lỗi → render lại form GIỮ giá trị đã gõ (idem mới — claim cũ đã rollback). Giữ cả
  // ?q= (hidden input) để picker vẫn lọc như lúc nhân viên đang chọn.
  const form = { ...Object.fromEntries(['name', 'phone', 'email', 'address_line', 'province', 'ship_fee_vnd', 'note', 'source', 'source_ref'].map((k) => [k, f.get(k) ?? ''])), payment_method: body.payment_method, lines };
  return orderNewPage(res, me, cookie, shopId, r.json?.error ?? 'Không tạo được đơn.', form, f.get('picker_q') ?? '');
}

async function orderDetail(res, me, cookie, shopId, oid, err, edited, returned) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('GET', `/shops/${shopId}/orders/${oid}`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tìm thấy đơn.'));
  // Kết nối hãng VC (nếu có) → hiện card "Tạo vận đơn qua hãng" khi đơn còn hàng chưa gửi
  // (confirmed, hoặc shipped mà mới giao MỘT PHẦN — 0080). Lỗi tải config KHÔNG được làm
  // sập trang đơn → nuốt, coi như chưa kết nối.
  const needShipping = r.json.status === 'confirmed'
    || (r.json.status === 'shipped' && r.json.fulfillment_status !== 'fulfilled');
  const shipping = needShipping
    ? await sellerApi('GET', `/shops/${shopId}/shipping`, { cookie }).then((sr) => (sr.status === 200 ? sr.json : null)).catch(() => null)
    : null;
  return sendHtmlJs(res, err ? 409 : 200, (nonce) => V.renderOrderDetail({ ...ctx, nonce }, shopId, r.json, err, shipping, edited, returned));
}

// ── SỬA ĐƠN (BFF forward → seller POST .../edit) ──────────────────────────────
// GET: nạp đơn + prefill form. Chỉ mở khi đơn còn sửa được (pending/confirmed + chưa trả);
// nếu không → render lại chi tiết đơn kèm lý do (không dẫn user vào form chết).
async function orderEditPage(res, me, cookie, shopId, oid, err, form, q) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const or = await sellerApi('GET', `/shops/${shopId}/orders/${oid}`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
  if (or.status !== 200) return sendHtml(res, or.status, V.renderError(ctx, or.json?.error ?? 'Không tìm thấy đơn.'));
  const o = or.json;
  const editable = ['pending', 'confirmed'].includes(o.status) && o.payment_status === 'unpaid';
  if (!editable) {
    const why = o.payment_status !== 'unpaid'
      ? 'Chỉ sửa được đơn CHƯA thanh toán — đơn đã trả cần hoàn/thu bù (chưa hỗ trợ).'
      : 'Chỉ sửa được đơn chưa gửi hãng (Chờ xử lý / Đã xác nhận).';
    return orderDetail(res, me, cookie, shopId, oid, why);
  }
  // Danh sách biến thể để THÊM dòng (?q= lọc, mirror orderNewPage).
  const pq = (q ?? '').trim().slice(0, 100);
  const sv = await sellerApi('GET', `/shops/${shopId}/sellable-variants${pq ? `?q=${encodeURIComponent(pq)}` : ''}`, { cookie });
  if (sv.status !== 200) return sendHtml(res, sv.status, V.renderError(ctx, sv.json?.error ?? 'Không tải được danh sách sản phẩm.'));
  return sendHtml(res, err ? 400 : 200, V.renderOrderEdit(ctx, shopId, o, sv.json.variants ?? [], err, form, { q: pq, truncated: sv.json.truncated === true }));
}

async function orderEditSubmit(req, res, me, cookie, shopId, oid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readFormAll(req); // getAll: dòng hiện có + slot thêm dùng chung tên variant_id[]/qty[]
  const vids = f.getAll('variant_id'), qtys = f.getAll('qty');
  // "Xoá dòng" = SL 0/để trống → lọc bỏ trước khi POST (biến thể vắng khỏi lines = seller coi như bỏ).
  const lines = [];
  for (let i = 0; i < vids.length; i++) {
    if (!vids[i]) continue; // slot thêm để trống
    const qty = Number(qtys[i] ?? 0);
    if (!Number.isFinite(qty) || qty < 1) continue; // SL 0 → xoá dòng
    lines.push({ variant_id: vids[i], qty });
  }
  const body = {
    lines,
    customer: {
      name: (f.get('name') ?? '').trim(), phone: (f.get('phone') ?? '').trim(),
      email: (f.get('email') ?? '').trim(), address_line: (f.get('address_line') ?? '').trim(),
      province: (f.get('province') ?? '').trim(),
    },
    ship_fee_vnd: (f.get('ship_fee_vnd') ?? '').trim(),
    note: (f.get('note') ?? '').trim(),
  };
  const r = await sellerApi('POST', `/shops/${shopId}/orders/${oid}/edit`, { cookie, body });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/orders/${oid}?edited=1`);
  // Lỗi (400/409/422) → render lại form GIỮ đúng giá trị đã gõ (dòng + khách + phí).
  const form = { ...Object.fromEntries(['name', 'phone', 'email', 'address_line', 'province', 'ship_fee_vnd', 'note'].map((k) => [k, f.get(k) ?? ''])), lines };
  return orderEditPage(res, me, cookie, shopId, oid, r.json?.error ?? 'Không lưu được sửa đơn.', form, f.get('picker_q') ?? '');
}

// ── SỬA ĐƠN ĐÃ TRẢ v2 (BFF → seller POST .../edit-paid; perm refund + STEP-UP) ────
// GET: mở form chế độ 'paid' (chỉ đơn paid + pending/confirmed + owner/admin). Step-up
// KHÔNG cần để XEM (GET seller không đòi) — chỉ POST /edit-paid mới đòi; ta xử ở submit.
async function orderEditPaidPage(res, me, cookie, shopId, oid, err, form, q) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const or = await sellerApi('GET', `/shops/${shopId}/orders/${oid}`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
  if (or.status !== 200) return sendHtml(res, or.status, V.renderError(ctx, or.json?.error ?? 'Không tìm thấy đơn.'));
  const o = or.json;
  const canPaidEdit = o.payment_status === 'paid' && ['pending', 'confirmed'].includes(o.status) && ['owner', 'admin'].includes(roleFor(me, shopId));
  if (!canPaidEdit) {
    const why = o.payment_status !== 'paid' ? 'Đơn chưa thanh toán — dùng "Sửa đơn" thường.'
      : !['pending', 'confirmed'].includes(o.status) ? 'Chỉ sửa được đơn chưa gửi hãng (Chờ xử lý / Đã xác nhận).'
        : 'Chỉ chủ cửa hàng hoặc quản trị mới sửa đơn đã trả.';
    return orderDetail(res, me, cookie, shopId, oid, why);
  }
  const pq = (q ?? '').trim().slice(0, 100);
  const sv = await sellerApi('GET', `/shops/${shopId}/sellable-variants${pq ? `?q=${encodeURIComponent(pq)}` : ''}`, { cookie });
  if (sv.status !== 200) return sendHtml(res, sv.status, V.renderError(ctx, sv.json?.error ?? 'Không tải được danh sách sản phẩm.'));
  return sendHtml(res, err ? 400 : 200, V.renderOrderEdit(ctx, shopId, o, sv.json.variants ?? [], err, form, { q: pq, truncated: sv.json.truncated === true, mode: 'paid' }));
}

// Đọc form sửa (chung v1) → dựng body {lines, customer, ship_fee_vnd, note}.
function readEditBody(f) {
  const vids = f.getAll('variant_id'), qtys = f.getAll('qty');
  const lines = [];
  for (let i = 0; i < vids.length; i++) {
    if (!vids[i]) continue;
    const qty = Number(qtys[i] ?? 0);
    if (!Number.isFinite(qty) || qty < 1) continue;
    lines.push({ variant_id: vids[i], qty });
  }
  return {
    lines,
    customer: { name: (f.get('name') ?? '').trim(), phone: (f.get('phone') ?? '').trim(), email: (f.get('email') ?? '').trim(), address_line: (f.get('address_line') ?? '').trim(), province: (f.get('province') ?? '').trim() },
    ship_fee_vnd: (f.get('ship_fee_vnd') ?? '').trim(),
    note: (f.get('note') ?? '').trim(),
  };
}
// Lõi: forward tới seller /edit-paid (giả định đã step-up; seller kiểm lại). 200 → banner
// kèm số hoàn; 403 step_up_required (cửa sổ hết giữa chừng) → interstitial lại; lỗi khác → form.
async function doEditPaid(res, me, cookie, shopId, oid, body) {
  const r = await sellerApi('POST', `/shops/${shopId}/orders/${oid}/edit-paid`, { cookie, body });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/orders/${oid}?edited=1${Number(r.json?.refund_vnd) > 0 ? `&refund=${Number(r.json.refund_vnd)}` : ''}`);
  if (r.json?.step_up_required) {
    const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
    return sendHtml(res, 200, V.renderEditPaidStepUp(ctx, shopId, oid, null, body));
  }
  const form = { ...body.customer, ship_fee_vnd: body.ship_fee_vnd, note: body.note, lines: body.lines };
  return orderEditPaidPage(res, me, cookie, shopId, oid, r.json?.error ?? 'Không lưu được sửa đơn.', form, '');
}
async function orderEditPaidSubmit(req, res, me, cookie, shopId, oid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const body = readEditBody(await readFormAll(req));
  // Chưa step-up → interstitial mang toàn bộ body (retry không mất dữ liệu). Đã step-up → làm luôn.
  if (steppedUp(me)) return doEditPaid(res, me, cookie, shopId, oid, body);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
  return sendHtml(res, 200, V.renderEditPaidStepUp(ctx, shopId, oid, null, body));
}
async function orderEditPaidStepUp(req, res, me, cookie, shopId, oid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readFormAll(req);
  const body = readEditBody(f);
  const r = await authApi('POST', '/auth/step-up', { cookie, body: { password: String(f.get('password') ?? '') } });
  if (r.status !== 200) {
    const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
    return sendHtml(res, 401, V.renderEditPaidStepUp(ctx, shopId, oid, r.status === 429 ? 'Quá nhiều lần thử, đợi chút.' : 'Mật khẩu không đúng.', body));
  }
  return doEditPaid(res, me, cookie, shopId, oid, body);
}

// Tạo vận đơn QUA HÃNG từ chi tiết đơn (form prefill) → seller gọi API hãng.
async function carrierShipment(req, res, me, cookie, shopId, oid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const body = {
    to_name: String(f.to_name ?? '').trim(), to_phone: String(f.to_phone ?? '').trim(),
    to_address: String(f.to_address ?? '').trim(), to_province: String(f.to_province ?? '').trim(),
    to_district: String(f.to_district ?? '').trim(), to_ward: String(f.to_ward ?? '').trim(),
    note: String(f.note ?? '').trim(),
    // Parse SỐ thật (không strip ký tự — '5e3' phải ra 5000, không phải 53); seller chặn 50–50000.
    weight_gram: (() => { const raw = String(f.weight_gram ?? '').trim(); const n = raw === '' ? 500 : Number(raw); return Number.isFinite(n) ? Math.round(n) : 500; })(),
  };
  const r = await sellerApi('POST', `/shops/${shopId}/orders/${oid}/carrier-shipment`, { cookie, body });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/orders/${oid}`);
  return orderDetail(res, me, cookie, shopId, oid, r.json?.error ?? 'Không tạo được vận đơn.');
}

// ── CRM-lite: khách hàng + ghi chú (orders.read/write ở seller) ───────────────
async function customersPage(res, me, cookie, shopId, sp) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'customers');
  const q = (sp.get('q') ?? '').trim(), minOrders = sp.get('min_orders') ?? '1';
  const offset = Math.max(parseInt(sp.get('offset') ?? '0', 10) || 0, 0), limit = 20;
  const r = await sellerApi('GET', `/shops/${shopId}/customers?q=${encodeURIComponent(q)}&min_orders=${encodeURIComponent(minOrders)}&limit=${limit}&offset=${offset}`, { cookie });
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tải được khách hàng.'));
  return sendHtmlJs(res, 200, (nonce) => V.renderCustomers({ ...ctx, nonce }, shopId, r.json, { q, min_orders: Number(minOrders) || 1, offset, limit }, sp.get('erased') === '1'));
}
async function customerDetail(res, me, cookie, shopId, phone, saved, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'customers');
  const r = await sellerApi('GET', `/shops/${shopId}/customers/${phone}`, { cookie });
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tìm thấy khách.'));
  return sendHtmlJs(res, err ? 409 : 200, (nonce) => V.renderCustomerDetail({ ...ctx, nonce }, shopId, r.json, saved, err));
}
// ── Ẩn danh khách (Luật BVDLCN 91/2025) — owner-only + step-up (mirror export) ─
async function doCustomerErase(res, me, cookie, shopId, phone) {
  const r = await sellerApi('POST', `/shops/${shopId}/customers/${phone}/erase`, { cookie, body: {} });
  // Thành công → chi tiết khách sẽ 404 (SĐT đã NULL) — PHẢI về danh sách, không re-render detail.
  if (r.status === 200) return redirect(res, `/shops/${shopId}/customers?erased=1`);
  return customerDetail(res, me, cookie, shopId, phone, false, r.json?.error ?? 'Không ẩn danh được.');
}
async function customerErase(req, res, me, cookie, shopId, phone) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  if (roleFor(me, shopId) !== 'owner') return customerDetail(res, me, cookie, shopId, phone, false, 'Chỉ chủ cửa hàng được ẩn danh dữ liệu khách.');
  if (steppedUp(me)) return doCustomerErase(res, me, cookie, shopId, phone);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'customers');
  return sendHtml(res, 200, V.renderCustomerEraseStepUp(ctx, shopId, phone, null));
}
async function customerEraseStepUp(req, res, me, cookie, shopId, phone) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  if (roleFor(me, shopId) !== 'owner') return customerDetail(res, me, cookie, shopId, phone, false, 'Chỉ chủ cửa hàng được ẩn danh dữ liệu khách.');
  const f = await readForm(req);
  const r = await authApi('POST', '/auth/step-up', { cookie, body: { password: String(f.password ?? '') } });
  if (r.status !== 200) {
    const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'customers');
    return sendHtml(res, 401, V.renderCustomerEraseStepUp(ctx, shopId, phone, r.status === 429 ? 'Quá nhiều lần thử, đợi chút.' : 'Mật khẩu không đúng.'));
  }
  return doCustomerErase(res, me, cookie, shopId, phone);
}
async function customerNoteSave(req, res, me, cookie, shopId, phone) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const r = await sellerApi('PUT', `/shops/${shopId}/customers/${phone}/note`, { cookie, body: { note: String(f.note ?? '') } });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/customers/${phone}?saved=1`);
  return customerDetail(res, me, cookie, shopId, phone, false);
}

// ── Đánh giá sản phẩm: duyệt/từ chối/xoá (content.write ở seller) ─────────────
async function reviewsPage(res, me, cookie, shopId, status) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const st = ['pending', 'approved', 'rejected'].includes(status) ? status : 'pending';
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'reviews');
  const r = await sellerApi('GET', `/shops/${shopId}/reviews?status=${st}`, { cookie });
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tải được đánh giá.'));
  return sendHtml(res, 200, V.renderReviews(ctx, shopId, r.json, st));
}
async function reviewAction(res, me, cookie, shopId, rid, action) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = action === 'delete'
    ? await sellerApi('DELETE', `/shops/${shopId}/reviews/${rid}`, { cookie })
    : await sellerApi('POST', `/shops/${shopId}/reviews/${rid}/${action}`, { cookie, body: {} });
  return redirect(res, `/shops/${shopId}/reviews${r.status !== 200 ? '' : action === 'approve' ? '?status=pending' : '?status=pending'}`);
}

// Ảnh đánh giá CHƯA DUYỆT (0101): proxy từ seller (bucket riêng tư) để chủ shop NHÌN THẤY
// trước khi bấm duyệt. Không có URL công khai nào cho ảnh này.
async function reviewImage(res, me, cookie, shopId, rid, mid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerDownload(`/shops/${shopId}/reviews/${rid}/images/${mid}`, { cookie });
  if (r.status !== 200) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
  // no-store + nosniff: ảnh chưa kiểm duyệt không được nằm lại cache trung gian.
  res.writeHead(200, { 'content-type': r.contentType ?? 'image/webp', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  return res.end(r.bytes);
}

// ── Hỏi đáp sản phẩm (0100) ─────────────────────────────────────────────────
async function questionsPage(res, me, cookie, shopId, status) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const st = ['pending', 'approved', 'rejected'].includes(status) ? status : 'pending';
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'questions');
  const r = await sellerApi('GET', `/shops/${shopId}/questions?status=${st}`, { cookie });
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tải được hỏi đáp.'));
  return sendHtml(res, 200, V.renderQuestions(ctx, shopId, r.json, st));
}
// Trả lời (mặc định ĐĂNG LUÔN) / từ chối / xoá. Quay lại ĐÚNG tab đang xem.
async function questionAction(req, res, me, cookie, shopId, qid, action) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = action === 'answer' ? await readForm(req) : {};
  const st = ['pending', 'approved', 'rejected'].includes(f.status) ? f.status : 'pending';
  const r = action === 'delete'
    ? await sellerApi('DELETE', `/shops/${shopId}/questions/${qid}`, { cookie })
    : action === 'answer'
      ? await sellerApi('POST', `/shops/${shopId}/questions/${qid}/answer`, { cookie, body: { answer: String(f.answer ?? '') } })
      : await sellerApi('POST', `/shops/${shopId}/questions/${qid}/reject`, { cookie, body: {} });
  if (r.status !== 200) {
    const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'questions');
    return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không thực hiện được.'));
  }
  return redirect(res, `/shops/${shopId}/questions?status=${st}`);
}

// SHOP TRẢ LỜI ĐÁNH GIÁ (0099). Ô rỗng = GỠ phản hồi. Quay lại ĐÚNG tab đang xem, nếu
// không chủ shop trả lời một đánh giá đã duyệt lại bị ném về tab "chờ duyệt".
async function reviewReply(req, res, me, cookie, shopId, rid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const st = ['pending', 'approved', 'rejected'].includes(f.status) ? f.status : 'pending';
  const r = await sellerApi('POST', `/shops/${shopId}/reviews/${rid}/reply`, { cookie, body: { reply: String(f.reply ?? '') } });
  if (r.status !== 200) {
    const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'reviews');
    return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không lưu được phản hồi.'));
  }
  return redirect(res, `/shops/${shopId}/reviews?status=${st}`);
}

// ── Đối soát COD với hãng (orders.read xem; ghi phiếu = payment.write = CHỦ SHOP) ──
// GET: nạp reconciliation (đơn chờ + per-hãng + lịch sử) → render. POST: gom order_ids đã tick
// (no-JS multi-select) + số THỰC nhận → forward seller POST /cod/remittances. 200 → redirect
// kèm kỳ vọng/thực nhận/chênh để hiện banner; lỗi seller (400/409/422/403) → render lại kèm lỗi.
async function codPage(res, me, cookie, shopId, done, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'cod');
  const r = await sellerApi('GET', `/shops/${shopId}/cod/reconciliation`, { cookie });
  if (r.status !== 200) return sendHtml(res, r.status === 403 ? 403 : r.status, V.renderError(ctx, r.json?.error ?? 'Không tải được đối soát COD.'));
  return sendHtmlJs(res, err ? 400 : 200, (nonce) => V.renderCodReconcile({ ...ctx, nonce }, shopId, r.json, roleFor(me, shopId) === 'owner', done, err));
}
async function codRemittanceSubmit(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  // Ghi phiếu = payment.write (seller cưỡng chế OWNER). Chặn sớm ở BFF cho vai trò khác.
  if (roleFor(me, shopId) !== 'owner') {
    const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'cod');
    return sendHtml(res, 403, V.renderError(ctx, 'Chỉ chủ cửa hàng mới ghi được phiếu chuyển tiền COD.'));
  }
  const f = await readFormAll(req); // getAll: ô tick order_ids trùng tên
  const orderIds = f.getAll('order_ids').filter((x) => /^[0-9a-f-]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x));
  // Không tick đơn nào → báo thân thiện, KHÔNG gọi API.
  if (orderIds.length === 0) return codPage(res, me, cookie, shopId, null, 'Hãy tick ít nhất một đơn để đối soát.');
  const body = { amount_vnd: parseVnd(f.get('amount_vnd')), order_ids: orderIds };
  const carrier = String(f.get('carrier') ?? '').trim();
  if (carrier) body.carrier = carrier;
  const remittedAt = String(f.get('remitted_at') ?? '').trim();
  if (remittedAt) body.remitted_at = remittedAt;
  const note = String(f.get('note') ?? '').trim();
  if (note) body.note = note.slice(0, 500);
  const r = await sellerApi('POST', `/shops/${shopId}/cod/remittances`, { cookie, body });
  if (r.status === 200) {
    const q = new URLSearchParams({ done: '1', expected: String(r.json.expected_vnd), received: String(r.json.amount_vnd), disc: String(r.json.discrepancy_vnd), count: String(r.json.order_count) });
    return redirect(res, `/shops/${shopId}/cod?${q.toString()}`);
  }
  return codPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không ghi được phiếu chuyển tiền.');
}

// Phục hồi vận đơn finalize_failed (đã tạo trên hãng nhưng chốt hỏng).
async function carrierReconcile(req, res, me, cookie, shopId, oid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const r = await sellerApi('POST', `/shops/${shopId}/orders/${oid}/carrier-reconcile`, { cookie, body: { action: f.action === 'cancel' ? 'cancel' : 'shipped' } });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/orders/${oid}`);
  return orderDetail(res, me, cookie, shopId, oid, r.json?.error ?? 'Không phục hồi được vận đơn.');
}

// ── Thông báo Telegram per-shop ───────────────────────────────────────────────
async function notifyPage(res, me, cookie, shopId, ok, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'notify');
  const r = await sellerApi('GET', `/shops/${shopId}/telegram`, { cookie });
  if (r.status !== 200) return sendHtml(res, 502, V.renderError(ctx, r.json?.error ?? 'Không tải được cấu hình thông báo.'));
  return sendHtml(res, err ? 400 : 200, V.renderNotify(ctx, shopId, r.json, err, ok));
}
async function notifyLink(res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('POST', `/shops/${shopId}/telegram/link`, { cookie, body: {} });
  return r.status === 200 ? redirect(res, `/shops/${shopId}/notify`) : notifyPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không tạo được liên kết.');
}
async function notifyUnlink(res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('DELETE', `/shops/${shopId}/telegram`, { cookie });
  return r.status === 200 ? notifyPage(res, me, cookie, shopId, 'Đã ngắt kết nối Telegram.', null) : notifyPage(res, me, cookie, shopId, null, 'Không ngắt được.');
}

// ── Vận chuyển: trang kết nối hãng (shop.write + step-up ở seller) ────────────
function shippingForm(f) {
  return {
    __op: f.__op === 'disconnect' ? 'disconnect' : 'connect',
    provider: f.provider === 'ghn' ? 'ghn' : 'ghtk',
    token: String(f.token ?? ''),
    ghn_shop_id: String(f.ghn_shop_id ?? '').replace(/\D/g, '').slice(0, 20),
    pick_name: String(f.pick_name ?? '').trim(), pick_phone: String(f.pick_phone ?? '').trim(),
    pick_address: String(f.pick_address ?? '').trim(), pick_province: String(f.pick_province ?? '').trim(),
    pick_district: String(f.pick_district ?? '').trim(), pick_ward: String(f.pick_ward ?? '').trim(),
  };
}
async function shippingPage(res, me, cookie, shopId, ok, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'shipping');
  const r = await sellerApi('GET', `/shops/${shopId}/shipping`, { cookie });
  if (r.status !== 200) return sendHtml(res, 502, V.renderError(ctx, r.json?.error ?? 'Không tải được cấu hình vận chuyển.'));
  return sendHtml(res, err ? 400 : 200, V.renderShipping(ctx, shopId, r.json, err, ok));
}
// Kiểm tra kết nối hãng (gọi API tính phí — 0đ, không tạo đơn).
async function shippingTest(res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('GET', `/shops/${shopId}/shipping/test`, { cookie });
  if (r.status === 200) {
    const fee = r.json.fee != null ? ` — phí thử nội quận (500g): ${new Intl.NumberFormat('vi-VN').format(r.json.fee)}đ` : ' — token hợp lệ';
    return shippingPage(res, me, cookie, shopId, `✓ Kết nối ${String(r.json.provider ?? '').toUpperCase()} thành công${fee}. Tích hợp đã chạy thật.`, null);
  }
  return shippingPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không kết nối được hãng.');
}
async function doShippingOp(res, me, cookie, shopId, form) {
  if (form.__op === 'disconnect') {
    const r = await sellerApi('DELETE', `/shops/${shopId}/shipping`, { cookie });
    return r.status === 200 ? shippingPage(res, me, cookie, shopId, 'Đã ngắt kết nối hãng vận chuyển.', null)
      : shippingPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không ngắt được kết nối.');
  }
  const body = {
    provider: form.provider, token: form.token, ghn_shop_id: form.ghn_shop_id,
    pickup: { name: form.pick_name, phone: form.pick_phone, address: form.pick_address, province: form.pick_province, district: form.pick_district, ward: form.pick_ward },
  };
  const r = await sellerApi('PUT', `/shops/${shopId}/shipping`, { cookie, body });
  return r.status === 200 ? shippingPage(res, me, cookie, shopId, `Đã kết nối ${form.provider.toUpperCase()}.`, null)
    : shippingPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không kết nối được.');
}
async function shippingOp(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const form = shippingForm(await readForm(req));
  if (steppedUp(me)) return doShippingOp(res, me, cookie, shopId, form);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'shipping');
  return sendHtml(res, 200, V.renderShippingStepUp(ctx, shopId, form, null));
}
async function shippingStepUp(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const form = shippingForm(f);
  const r = await authApi('POST', '/auth/step-up', { cookie, body: { password: String(f.password ?? '') } });
  if (r.status !== 200) {
    const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'shipping');
    return sendHtml(res, 401, V.renderShippingStepUp(ctx, shopId, form, r.status === 429 ? 'Quá nhiều lần thử, đợi chút.' : 'Mật khẩu không đúng.'));
  }
  return doShippingOp(res, me, cookie, shopId, form);
}

// ── KẾT NỐI: khoá cho phần mềm ngoài đẩy đơn vào (0120) ──────────────────────
// Địa chỉ nhận đơn KHÔNG suy ra từ host của admin: host webhook là host riêng
// (hooks.*) đúng như SePay. Đặt sai biến này thì chủ shop dán nhầm địa chỉ và tích
// hợp im lặng không chạy — nên mặc định là địa chỉ prod thật, không phải localhost.
const INGEST_URL = process.env.INGEST_URL ?? 'https://hooks.nentang.vn/ingest/orders';
async function apiKeysPage(res, me, cookie, shopId, ok, err, freshToken) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'apikeys');
  const r = await sellerApi('GET', `/shops/${shopId}/api-keys`, { cookie });
  if (r.status !== 200) return sendHtml(res, r.status === 403 ? 403 : 502, V.renderError(ctx, r.json?.error ?? 'Không tải được danh sách khoá.'));
  return sendHtmlJs(res, err ? 400 : 200, (nonce) =>
    V.renderApiKeys({ ...ctx, nonce }, shopId, { ...r.json, ingest_url: INGEST_URL }, err, ok, freshToken));
}
async function doApiKeyCreate(res, me, cookie, shopId, form) {
  const r = await sellerApi('POST', `/shops/${shopId}/api-keys`, { cookie, body: { name: form.name } });
  if (r.status !== 201) return apiKeysPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không tạo được khoá.', null);
  // Token đi thẳng vào HTML lần này rồi thôi — KHÔNG redirect kèm token trên URL:
  // URL nằm lại trong lịch sử trình duyệt, log proxy và Referer của trang kế tiếp.
  return apiKeysPage(res, me, cookie, shopId, `Đã tạo khoá "${form.name}".`, null, r.json.token);
}
async function apiKeyCreate(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const form = { name: String(f.name ?? '').trim().slice(0, 80) };
  if (steppedUp(me)) return doApiKeyCreate(res, me, cookie, shopId, form);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'apikeys');
  return sendHtml(res, 200, V.renderReportsStepUp(ctx, shopId, form, null, {
    section: 'api-keys',
    action: `/shops/${shopId}/api-keys/step-up`,
    submitLabel: 'Xác nhận & tạo khoá',
    why: 'Khoá này cho phép phần mềm ngoài tạo đơn thay cửa hàng — nhập mật khẩu của bạn để tiếp tục.',
  }));
}
async function apiKeyStepUp(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const form = { name: String(f.name ?? '').trim().slice(0, 80) };
  const r = await authApi('POST', '/auth/step-up', { cookie, body: { password: String(f.password ?? '') } });
  if (r.status !== 200) {
    const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'apikeys');
    return sendHtml(res, 401, V.renderReportsStepUp(ctx, shopId, form, r.status === 429 ? 'Quá nhiều lần thử, đợi chút.' : 'Mật khẩu không đúng.', {
      section: 'api-keys',
      action: `/shops/${shopId}/api-keys/step-up`,
      submitLabel: 'Xác nhận & tạo khoá',
    }));
  }
  return doApiKeyCreate(res, me, cookie, shopId, form);
}
async function apiKeyRevoke(res, me, cookie, shopId, keyId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('POST', `/shops/${shopId}/api-keys/${keyId}/revoke`, { cookie });
  return apiKeysPage(res, me, cookie, shopId,
    r.status === 200 ? 'Đã thu hồi khoá. Phần mềm dùng khoá đó sẽ không đẩy đơn về được nữa.' : null,
    r.status === 200 ? null : (r.json?.error ?? 'Không thu hồi được khoá.'), null);
}

// Xác nhận HÀNG LOẠT: forward danh sách id (checkbox) → seller (thành công một phần).
async function ordersBulkConfirm(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const params = await readFormAll(req);
  const ids = params.getAll('order_ids').filter((x) => /^[0-9a-f-]{36}$/.test(x));
  if (!ids.length) return redirect(res, `/shops/${shopId}/orders`);
  const r = await sellerApi('POST', `/shops/${shopId}/orders/bulk/confirm`, { cookie, body: { order_ids: ids } });
  return redirect(res, `/shops/${shopId}/orders${r.status === 200 ? `?bulk_ok=${r.json.confirmed}&bulk_skip=${r.json.skipped}` : ''}`);
}

// ĐÃ NHẬN TIỀN HÀNG LOẠT (COD): mirror bulk-confirm — seller tự bỏ qua đơn không hợp
// lệ (QR/đã trả/terminal), thành công một phần.
async function ordersBulkMarkPaid(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const params = await readFormAll(req);
  const ids = params.getAll('order_ids').filter((x) => /^[0-9a-f-]{36}$/.test(x));
  if (!ids.length) return redirect(res, `/shops/${shopId}/orders`);
  const r = await sellerApi('POST', `/shops/${shopId}/orders/bulk/mark-paid`, { cookie, body: { order_ids: ids } });
  return redirect(res, `/shops/${shopId}/orders${r.status === 200 ? `?bulkpay_ok=${r.json.paid}&bulkpay_skip=${r.json.skipped}` : ''}`);
}

// In HÀNG LOẠT (GET từ nút formaction, target _blank): mỗi đơn 1 trang.
async function ordersPrintBatch(res, me, cookie, shopId, sp) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ids = sp.getAll('order_ids').filter((x) => /^[0-9a-f-]{36}$/.test(x)).slice(0, 50);
  if (!ids.length) return redirect(res, `/shops/${shopId}/orders`);
  const [shopR, ...orderRs] = await Promise.all([
    sellerApi('GET', `/shops/${shopId}`, { cookie }),
    ...ids.map((id) => sellerApi('GET', `/shops/${shopId}/orders/${id}`, { cookie })),
  ]);
  const orders = orderRs.filter((r) => r.status === 200 && r.json).map((r) => r.json);
  if (!orders.length) return redirect(res, `/shops/${shopId}/orders`);
  return sendHtml(res, 200, V.renderOrderPrintBatch(shopId, shopR.json, orders));
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
  if (action === 'ship') {
    const f = await readFormAll(req); // getAll: order_line_id[]/ship_qty[] song song (giao MỘT PHẦN 0080)
    body = { tracking_number: String(f.get('tracking_number') ?? '').trim(), carrier: String(f.get('carrier') ?? '').trim() };
    const ids = f.getAll('order_line_id'), qtys = f.getAll('ship_qty');
    const lines = [];
    for (let i = 0; i < ids.length; i++) {
      const q = Number(String(qtys[i] ?? '').trim());
      if (ids[i] && Number.isFinite(q) && q > 0) lines.push({ order_line_id: ids[i], qty: Math.round(q) });
    }
    // Có chọn dòng → gửi subset; không dòng nào (form cũ) → bỏ lines = seller gửi TRỌN còn lại.
    if (lines.length) body.lines = lines;
  } else if (action === 'mark-returned') {
    // Bom hàng: checkbox "Nhập lại kho" (checked → restock; bỏ → hàng hỏng không nhập lại).
    const f = await readFormAll(req);
    body = { restock: f.get('restock') != null, reason: String(f.get('reason') ?? '').trim() };
  } else if (action === 'cancel') {
    // Lý do huỷ (0117) — seller BẮT BUỘC có khi đơn đã thanh toán, và gửi nó cho khách.
    const f = await readFormAll(req);
    body = { reason: String(f.get('reason') ?? '').trim() };
  }
  const r = await sellerApi('POST', `/shops/${shopId}/orders/${oid}/${action}`, { cookie, body });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/orders/${oid}`);
  // Lỗi (403 quyền / 409 sai trạng thái / 400) → render lại chi tiết kèm thông báo.
  return orderDetail(res, me, cookie, shopId, oid, r.json?.error ?? 'Thao tác không thực hiện được.');
}

// ── product/inventory handlers ────────────────────────────────────────────────
// Quyền catalog do `seller` cưỡng chế (catalog.read/write); BFF chỉ forward + hiện lỗi.
async function productsList(res, me, cookie, shopId, q, notice = null) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const status = ['draft', 'active', 'archived'].includes(q.get('status')) ? q.get('status') : '';
  const query = (q.get('q') ?? '').trim().slice(0, 100);
  // Ô "Sắp hết hàng" ở Tổng quan bấm sang đây (docs/44 §7). Allowlist một giá trị: tham số
  // này đi thẳng vào WHERE của API, không nhận gì ngoài 'low'.
  const stock = q.get('stock') === 'low' ? 'low' : '';
  const limit = 20, offset = Math.max(0, parseInt(q.get('offset') ?? '0', 10) || 0);
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (status) qs.set('status', status);
  if (stock) qs.set('stock', stock);
  if (query) qs.set('q', query);
  const r = await sellerApi('GET', `/shops/${shopId}/products?${qs}`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'products');
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tải được sản phẩm.'));
  // Trang DUY NHẤT hiện dùng JS (ADR-011 danh sách trắng: chọn hàng loạt + xác nhận xoá).
  // sendHtmlJs sinh nonce MỘT LẦN cho cả header CSP lẫn thẻ <script> → không thể lệch.
  return sendHtmlJs(res, 200, (nonce) => V.renderProducts({ ...ctx, nonce }, shopId, r.json, { status, stock, q: query, limit, offset }, notice));
}

// ĐỔI TRẠNG THÁI HÀNG LOẠT: forward danh sách id (checkbox) → seller (thành công một phần).
// readFormAll (KHÔNG phải readForm) — readForm gom vào object nên nhiều checkbox trùng tên
// chỉ còn 1 giá trị cuối. PRG quay lại ĐÚNG trang đang xem (giữ status/q/offset) và mang
// theo số kết quả để trang sau hiện thông báo — khác mẫu đơn hàng vốn làm rơi bộ lọc và
// đặt bulk_ok lên URL mà không nơi nào đọc.
async function productsBulkStatus(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const params = await readFormAll(req);
  const ids = params.getAll('product_ids').filter((x) => /^[0-9a-f-]{36}$/.test(x));
  const to = params.get('to');
  const back = new URLSearchParams();
  if (params.get('status_filter')) back.set('status', params.get('status_filter'));
  if (params.get('q')) back.set('q', params.get('q'));
  if (params.get('offset')) back.set('offset', params.get('offset'));
  const dest = (extra) => `/shops/${shopId}/products?${new URLSearchParams({ ...Object.fromEntries(back), ...extra })}`;
  if (!ids.length) return redirect(res, dest({ bulk_none: '1' }));
  if (!['active', 'draft', 'archived'].includes(to)) return redirect(res, dest({}));
  const r = await sellerApi('POST', `/shops/${shopId}/products/bulk/status`, { cookie, body: { product_ids: ids, status: to } });
  if (r.status !== 200) {
    const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'products');
    return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không đổi được trạng thái hàng loạt.'));
  }
  return redirect(res, dest({ bulk_to: to, bulk_ok: String(r.json.changed), bulk_skip: String(r.json.skipped) }));
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
  // Trang này có bảng data-cards + nút data-confirm ⇒ PHẢI đi qua sendHtmlJs, nếu không thì
  // thuộc tính nằm im: bảng vẫn cuộn ngang trên điện thoại và nút Nhập-thật không hỏi lại.
  return sendHtmlJs(res, err ? 400 : 200, (nonce) => V.renderProductImport({ ...ctx, nonce }, shopId, result, err));
}
async function productImport(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  // readMultipartAll (không phải readMultipartFile): form có CẢ tệp lẫn trường `mode`, vì
  // hai nút "Xem trước"/"Nhập thật" là hai submit trên CÙNG một form.
  let parsed, tooBig = false;
  try { parsed = await readMultipartAll(req, 10 * 1024 * 1024); } catch (e) { tooBig = e.statusCode === 413; }
  if (tooBig) return productImportPage(res, me, cookie, shopId, null, 'Tệp quá lớn (tối đa 10MB).');
  const file = (parsed?.files ?? [])[0];
  const dryRun = String(parsed?.fields?.mode ?? '') !== 'commit';   // MẶC ĐỊNH là xem trước
  if (!file?.bytes?.length) return productImportPage(res, me, cookie, shopId, null, 'Chưa chọn tệp CSV hợp lệ.');
  const rows = parseCsv(file.bytes.toString('utf8'));
  if (rows.length === 0) return productImportPage(res, me, cookie, shopId, null, 'Tệp không có dòng dữ liệu (cần hàng tiêu đề + ít nhất 1 dòng).');
  if (rows.length > 1000) return productImportPage(res, me, cookie, shopId, null, 'Tối đa 1000 dòng mỗi lần nhập.');
  // timeoutMs 70s (mặc định 8s): seller tạo sản phẩm rồi TẢI ẢNH theo URL với ngân sách 45s.
  // Để 8s thì người bán thấy "không nhập được" trong khi hàng ĐÃ vào — họ bấm lại, nhân đôi.
  const r = await sellerApi('POST', `/shops/${shopId}/products/import`,
    { cookie, body: { rows, dry_run: dryRun }, timeoutMs: dryRun ? 15000 : 70000 });
  if (r.status !== 200) return productImportPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không nhập được — kiểm tra quyền hoặc định dạng tệp.');
  return productImportPage(res, me, cookie, shopId, { ...r.json, total: rows.length }, null);
}

async function orderImportPage(res, me, cookie, shopId, result, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
  return sendHtmlJs(res, err ? 400 : 200, (nonce) => V.renderOrderImport({ ...ctx, nonce }, shopId, result, err));
}
async function orderImport(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  let parsed, tooBig = false;
  try { parsed = await readMultipartAll(req, 10 * 1024 * 1024); } catch (e) { tooBig = e.statusCode === 413; }
  if (tooBig) return orderImportPage(res, me, cookie, shopId, null, 'Tệp quá lớn (tối đa 10MB).');
  const file = (parsed?.files ?? [])[0];
  const dryRun = String(parsed?.fields?.mode ?? '') !== 'commit';
  if (!file?.bytes?.length) return orderImportPage(res, me, cookie, shopId, null, 'Chưa chọn tệp CSV hợp lệ.');
  const rows = parseCsv(file.bytes.toString('utf8'));
  if (rows.length === 0) return orderImportPage(res, me, cookie, shopId, null, 'Tệp không có dòng dữ liệu.');
  if (rows.length > 2000) return orderImportPage(res, me, cookie, shopId, null, 'Tối đa 2000 dòng mỗi lần nhập.');
  const r = await sellerApi('POST', `/shops/${shopId}/orders/import`, { cookie, body: { rows, dry_run: dryRun }, timeoutMs: 60000 });
  if (r.status !== 200) return orderImportPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không nhập được — kiểm tra quyền hoặc định dạng tệp.');
  return orderImportPage(res, me, cookie, shopId, { ...r.json, total: rows.length }, null);
}
function orderImportSample(res) {
  return sendDownload(res, Buffer.from('﻿' + V.ORDER_IMPORT_SAMPLE_CSV, 'utf8'),
    { filename: 'mau-nhap-don-cu.csv', contentType: 'text/csv; charset=utf-8' });
}

async function helpPage(res, me, cookie, shopId, notice, err, form) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'help');
  const r = await sellerApi('GET', `/shops/${shopId}/support`, { cookie });
  return sendHtmlJs(res, err ? 400 : 200,
    (nonce) => V.renderHelp({ ...ctx, nonce }, shopId, r.json?.tickets ?? [], notice, err, form));
}
async function helpSubmit(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const r = await sellerApi('POST', `/shops/${shopId}/support`,
    { cookie, body: { subject: f.subject, body: f.body, context_url: f.context_url || null,
      // UA của TRÌNH DUYỆT phải đi từ đây: seller chỉ thấy UA của chính BFF này.
      ua: req.headers['user-agent'] ?? null } });
  if (r.status !== 201) return helpPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không gửi được yêu cầu.', f);
  // PRG: gửi xong thì chuyển hướng, không để F5 gửi lại phiếu y hệt.
  return redirect(res, `/shops/${shopId}/help?sent=1`);
}

// Tệp mẫu TẢI VỀ (thay vì chỉ hiện chữ để copy): người bán mở thẳng bằng Excel, sửa dữ liệu
// rồi tải lên — không phải tự đoán cách tạo tệp CSV UTF-8.
function productImportSample(res) {
  const csv = V.IMPORT_SAMPLE_CSV;
  // BOM UTF-8: thiếu nó là Excel trên Windows hiện tiếng Việt thành ký tự rác.
  return sendDownload(res, Buffer.from('﻿' + csv, 'utf8'),
    { filename: 'mau-nhap-san-pham.csv', contentType: 'text/csv; charset=utf-8' });
}

// ── Blog ─────────────────────────────────────────────────────────────────────
async function blogList(res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('GET', `/shops/${shopId}/blog`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'blog');
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tải được blog.'));
  return sendHtml(res, 200, V.renderBlogList(ctx, shopId, r.json));
}
// Ảnh sẵn có của shop — để người viết bài CHỌN thay vì phải dán "key media" bằng tay.
// Lỗi thì trả mảng rỗng: thiếu ảnh gợi ý không đáng làm hỏng cả trang soạn bài.
const shopMedia = async (shopId, cookie) => {
  const r = await sellerApi('GET', `/shops/${shopId}/media`, { cookie });
  return r.status === 200 ? (r.json?.media ?? []) : [];
};
async function blogNew(res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'blog');
  return sendHtml(res, 200, V.renderBlogEditor(ctx, shopId, null, null, await shopMedia(shopId, cookie)));
}
async function blogEditor(res, me, cookie, shopId, id, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('GET', `/shops/${shopId}/blog/${id}`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'blog');
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tìm thấy bài viết.'));
  return sendHtml(res, err ? 400 : 200, V.renderBlogEditor(ctx, shopId, r.json, err, await shopMedia(shopId, cookie)));
}
const blogForm = (f) => ({ title: String(f.title ?? '').trim(), slug: String(f.slug ?? '').toLowerCase().trim(), excerpt: String(f.excerpt ?? ''), body: String(f.body ?? ''), cover_image_key: String(f.cover_image_key ?? '').trim() });
async function blogCreate(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const body = blogForm(await readForm(req));
  const r = await sellerApi('POST', `/shops/${shopId}/blog`, { cookie, body });
  if (r.status === 201) return redirect(res, `/shops/${shopId}/blog/${r.json.id}`);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'blog');
  return sendHtml(res, 400, V.renderBlogEditor(ctx, shopId, body, r.json?.error ?? 'Không tạo được bài.', await shopMedia(shopId, cookie))); // body không có id → form "mới" giữ giá trị
}
async function blogUpdate(req, res, me, cookie, shopId, id) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const body = blogForm(await readForm(req));
  const r = await sellerApi('PATCH', `/shops/${shopId}/blog/${id}`, { cookie, body });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/blog/${id}`);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'blog');
  return sendHtml(res, 400, V.renderBlogEditor(ctx, shopId, { ...body, id, status: 'draft' }, r.json?.error ?? 'Không lưu được bài.', await shopMedia(shopId, cookie)));
}
/**
 * TẢI ẢNH BÌA cho bài viết (0-JS): nhận tệp → forward byte thô sang seller
 * /content-image (sniff magic byte + re-encode WebP) → lấy key trả về → PATCH vào bài
 * → redirect. Người dùng không bao giờ phải nhìn thấy chuỗi "key media".
 *
 * Chỉ làm được với bài ĐÃ tạo: không có id thì chưa có chỗ để gắn key. Form soạn bài
 * mới nói rõ điều đó thay vì hiện một nút bấm vào là lỗi.
 */
async function blogCoverUpload(req, res, me, cookie, shopId, id) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  let files = [];
  try { files = await readMultipartFiles(req); } catch (e) {
    if (e.statusCode === 413) return blogEditor(res, me, cookie, shopId, id, 'Ảnh quá lớn.');
  }
  files = files.filter((f) => f.bytes?.length);
  if (!files.length) return blogEditor(res, me, cookie, shopId, id, 'Chưa chọn ảnh.');
  const up = await sellerUpload(`/shops/${shopId}/content-image`, { cookie, bytes: files[0].bytes });
  if (up.status !== 200 || !up.json?.key) return blogEditor(res, me, cookie, shopId, id, up.json?.error ?? 'Tải ảnh thất bại.');
  const r = await sellerApi('PATCH', `/shops/${shopId}/blog/${id}`, { cookie, body: { cover_image_key: up.json.key } });
  if (r.status !== 200) return blogEditor(res, me, cookie, shopId, id, r.json?.error ?? 'Không gắn được ảnh bìa.');
  return redirect(res, `/shops/${shopId}/blog/${id}`);
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
  const r = await sellerApi('POST', `/shops/${shopId}/categories`, { cookie, body: { name: String(f.name ?? '').trim(), slug: String(f.slug ?? '').toLowerCase().trim(), parent_id: String(f.parent_id ?? '').trim() } });
  return categoriesPage(res, me, cookie, shopId, r.status === 201 ? 'Đã thêm danh mục.' : null, r.status === 201 ? null : (r.json?.error ?? 'Không thêm được danh mục.'));
}
async function categoryUpdate(req, res, me, cookie, shopId, cid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const body = { name: String(f.name ?? '').trim() };
  const pos = parseInt(f.position ?? '', 10); if (Number.isInteger(pos)) body.position = pos;
  // parent_id chỉ gửi khi form CÓ trường (chọn danh mục cha) — '' = đưa về cấp trên cùng.
  if (f.parent_id !== undefined) body.parent_id = String(f.parent_id ?? '').trim();
  const r = await sellerApi('PATCH', `/shops/${shopId}/categories/${cid}`, { cookie, body });
  return categoriesPage(res, me, cookie, shopId, r.status === 200 ? 'Đã lưu danh mục.' : null, r.status === 200 ? null : (r.json?.error ?? 'Không lưu được danh mục.'));
}
async function categoryDelete(res, me, cookie, shopId, cid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('DELETE', `/shops/${shopId}/categories/${cid}`, { cookie });
  return categoriesPage(res, me, cookie, shopId, r.status === 200 ? 'Đã xoá danh mục.' : null, r.status === 200 ? null : (r.json?.error ?? 'Không xoá được danh mục.'));
}
// Ảnh đại diện danh mục (0118). Tick "Xoá ảnh" → gỡ về suy-từ-sản-phẩm; ngược lại tải
// tệp đã chọn. Seller lo sniff + re-encode + gắn key trong MỘT lần gọi.
async function categoryImage(req, res, me, cookie, shopId, cid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  let files = [], fields = {};
  try { ({ files, fields } = await readMultipartAll(req)); } catch (e) {
    if (e.statusCode === 413) return categoriesPage(res, me, cookie, shopId, null, 'Ảnh quá lớn.');
    return categoriesPage(res, me, cookie, shopId, null, 'Không đọc được tệp tải lên.');
  }
  if (fields.remove) {
    const d = await sellerApi('DELETE', `/shops/${shopId}/categories/${cid}/image`, { cookie });
    return categoriesPage(res, me, cookie, shopId, d.status === 200 ? 'Đã gỡ ảnh danh mục.' : null, d.status === 200 ? null : (d.json?.error ?? 'Không gỡ được ảnh.'));
  }
  const f = files.find((x) => x.bytes?.length);
  if (!f) return categoriesPage(res, me, cookie, shopId, null, 'Chưa chọn ảnh.');
  const up = await sellerUpload(`/shops/${shopId}/categories/${cid}/image`, { cookie, bytes: f.bytes });
  return categoriesPage(res, me, cookie, shopId, up.status === 200 ? 'Đã đặt ảnh danh mục.' : null, up.status === 200 ? null : (up.json?.error ?? 'Tải ảnh thất bại.'));
}

// ── Khuyến mãi (mã giảm giá; catalog.write) ──────────────────────────────────
async function couponsPage(res, me, cookie, shopId, notice, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'coupons');
  const r = await sellerApi('GET', `/shops/${shopId}/coupons`, { cookie });
  if (r.status !== 200 && r.status !== 400) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tải được khuyến mãi.'));
  return sendHtmlJs(res, err ? 400 : 200, (nonce) => V.renderCoupons({ ...ctx, nonce }, shopId, r.status === 200 ? r.json : {}, notice, err));
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
// ── Flash sale (khuyến mãi tự động; catalog.write) ───────────────────────────
async function promotionsPage(res, me, cookie, shopId, notice, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'promotions');
  const r = await sellerApi('GET', `/shops/${shopId}/promotions`, { cookie });
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.status === 403 ? 'Chỉ chủ shop / quản trị / nhân viên sản phẩm quản lý được flash sale.' : (r.json?.error ?? 'Không tải được flash sale.')));
  return sendHtmlJs(res, err ? 400 : 200, (nonce) => V.renderPromotions({ ...ctx, nonce }, shopId, r.json, notice, err));
}
async function promotionCreate(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const body = { title: f.title, kind: f.kind, value: f.value, scope: f.scope, starts_at: f.starts_at, ends_at: f.ends_at };
  const r = await sellerApi('POST', `/shops/${shopId}/promotions`, { cookie, body });
  if (r.status !== 201) return promotionsPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không tạo được chương trình.');
  // scope=products → sang trang chi tiết để chọn SP; scope=all → về danh sách kèm cảnh báo (nếu có).
  if (f.scope === 'products') return redirect(res, `/shops/${shopId}/promotions/${r.json.id}`);
  return promotionsPage(res, me, cookie, shopId, r.json.warning ? `Đã tạo. ${r.json.warning}` : 'Đã tạo chương trình flash sale.', null);
}
async function promotionDetailPage(res, me, cookie, shopId, id, q, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'promotions');
  const r = await sellerApi('GET', `/shops/${shopId}/promotions/${id}`, { cookie });
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tìm thấy chương trình.'));
  let picker = null;
  const pq = (q ?? '').trim().slice(0, 100);
  if (pq && r.json.scope === 'products') {
    const pr = await sellerApi('GET', `/shops/${shopId}/products?q=${encodeURIComponent(pq)}`, { cookie });
    picker = { q: pq, products: pr.status === 200 ? (pr.json.products ?? []) : [], truncated: pr.json?.truncated === true };
  } else if (pq) picker = { q: pq, products: [] };
  return sendHtml(res, 200, V.renderPromotionDetail(ctx, shopId, r.json, picker, err));
}
async function promotionEnd(req, res, me, cookie, shopId, id) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  await sellerApi('PATCH', `/shops/${shopId}/promotions/${id}`, { cookie, body: { active: false } });
  return redirect(res, `/shops/${shopId}/promotions`);
}
async function promotionDelete(req, res, me, cookie, shopId, id) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  await sellerApi('DELETE', `/shops/${shopId}/promotions/${id}`, { cookie });
  return redirect(res, `/shops/${shopId}/promotions`);
}
async function promotionAddProduct(req, res, me, cookie, shopId, id) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const r = await sellerApi('POST', `/shops/${shopId}/promotions/${id}/products`, { cookie, body: { product_id: f.product_id } });
  if (r.status !== 200) return promotionDetailPage(res, me, cookie, shopId, id, null, r.json?.error ?? 'Không thêm được sản phẩm.');
  return redirect(res, `/shops/${shopId}/promotions/${id}`);
}
async function promotionRemoveProduct(req, res, me, cookie, shopId, id, productId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  await sellerApi('DELETE', `/shops/${shopId}/promotions/${id}/products/${productId}`, { cookie });
  return redirect(res, `/shops/${shopId}/promotions/${id}`);
}
async function productCategoriesSave(req, res, me, cookie, shopId, pid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const params = await readFormAll(req);
  const r = await sellerApi('PUT', `/shops/${shopId}/products/${pid}/categories`, { cookie, body: { category_ids: params.getAll('category_ids') } });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/products/${pid}`);
  return productDetail(res, me, cookie, shopId, pid, r.json?.error ?? 'Không lưu được danh mục.');
}

async function productDetail(res, me, cookie, shopId, pid, err, form, notice) {
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
  return sendHtml(res, err ? 409 : 200, V.renderProductDetail(ctx, shopId, r.json, levels, err, form, media, cats, notice));
}

async function productUpdate(req, res, me, cookie, shopId, pid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const body = {
    title: String(f.title ?? '').trim(), slug: String(f.slug ?? '').trim().toLowerCase(),
    price_vnd: parseVnd(f.price_vnd), description: String(f.description ?? '').trim() || null,
    // SEO (0098): ô trống → null → storefront quay lại tự suy từ tên/mô tả.
    seo_title: String(f.seo_title ?? '').trim() || null,
    seo_description: String(f.seo_description ?? '').trim() || null,
  };
  const r = await sellerApi('PATCH', `/shops/${shopId}/products/${pid}`, { cookie, body });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/products/${pid}`);
  // Giữ nguyên giá trị vừa nhập khi lưu lỗi (slug trùng…) — không revert về DB.
  return productDetail(res, me, cookie, shopId, pid, r.json?.error ?? 'Không lưu được thay đổi.', f);
}

/**
 * LƯU TẤT CẢ (một nút cho cả trang sửa sản phẩm).
 *
 * Người bán báo: "nhiều chỗ cập nhật riêng lẻ, mỗi lần chỉnh phải bấm cập nhật, gán
 * từng ảnh rất mệt". Đúng — trang này vốn có 4 nút lưu rời: thông tin, giá biến thể
 * (bulkvars), điều chỉnh tồn (bulkstock), và MỘT nút "Gán" cho MỖI ảnh.
 *
 * Gom ở TẦNG BFF, KHÔNG đụng API `seller`: handler này chỉ gọi lại đúng những endpoint
 * cũ, đúng thứ tự, đúng số lần. Nghĩa là sổ kho, chống oversell, RLS, quyền và bút toán
 * y hệt như khi bấm lẻ — chỉ khác ở chỗ người dùng bấm một lần. Đường tiền/kho không có
 * mã mới nào để mà sai.
 *
 * Chạy HẾT các bước rồi mới kết luận (không dừng ở lỗi đầu): sửa giá không đáng bị nuốt
 * chỉ vì slug trùng. Có lỗi → hiện lại trang kèm những gì ĐÃ lưu và lỗi cụ thể, giữ
 * nguyên giá trị vừa nhập.
 *
 * Tồn kho làm SAU CÙNG — nó là bước duy nhất ghi sổ cái không thể sửa lại bằng cách lưu
 * đè, nên chỉ chạy khi mọi thứ khác đã xong.
 */
async function productSaveAll(req, res, me, cookie, shopId, pid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const done = [], errs = [];

  // 1) Thông tin sản phẩm.
  const info = await sellerApi('PATCH', `/shops/${shopId}/products/${pid}`, { cookie, body: {
    title: String(f.title ?? '').trim(), slug: String(f.slug ?? '').trim().toLowerCase(),
    price_vnd: parseVnd(f.price_vnd), description: String(f.description ?? '').trim() || null,
    seo_title: String(f.seo_title ?? '').trim() || null,
    seo_description: String(f.seo_description ?? '').trim() || null,
  } });
  if (info.status === 200) done.push('thông tin'); else errs.push(info.json?.error ?? 'không lưu được thông tin');

  // 2) Giá / giá gạch / giá vốn / cân của từng biến thể — parse Y HỆT variantBulkPrice.
  const vidsPrice = Object.keys(f).map((k) => new RegExp(`^price_${UUID}$`).exec(k)?.[1]).filter(Boolean);
  let nPrice = 0;
  for (const vid of vidsPrice) {
    const wraw = String(f[`weight_${vid}`] ?? '').trim(), craw = String(f[`compare_${vid}`] ?? '').trim();
    const coraw = String(f[`cost_${vid}`] ?? '').trim();
    const r = await sellerApi('PATCH', `/shops/${shopId}/products/${pid}/variants/${vid}`, { cookie, body: {
      price_vnd: parseVnd(f[`price_${vid}`]),
      weight_gram: wraw === '' ? null : (Number.isFinite(Number(wraw)) ? Math.round(Number(wraw)) : -1),
      compare_at_vnd: craw === '' ? null : (Number.isFinite(Number(craw)) ? Math.round(Number(craw)) : -1),
      cost_vnd: coraw === '' ? null : (Number.isFinite(Number(coraw)) ? Math.round(Number(coraw)) : -1),
    } });
    if (r.status === 200) nPrice++; else errs.push(r.json?.error ?? `giá biến thể ${vid.slice(0, 8)} lỗi`);
  }
  if (nPrice) done.push(`${nPrice} biến thể`);

  // 3) Gán ảnh cho biến thể. CHỈ gửi ô nào ĐỔI so với hiện trạng (media_cur_<id> là
  //    giá trị đang lưu, render kèm) → không bắn N lượt ghi thừa mỗi lần bấm Lưu.
  const mids = Object.keys(f).map((k) => new RegExp(`^media_${UUID}$`).exec(k)?.[1]).filter(Boolean);
  let nMedia = 0;
  for (const mid of mids) {
    const want = String(f[`media_${mid}`] ?? '').trim();
    if (want === String(f[`media_cur_${mid}`] ?? '').trim()) continue;
    const r = await sellerApi('POST', `/shops/${shopId}/media/${mid}/variant`, { cookie, body: { variant_id: want || null } });
    if (r.status === 200) nMedia++; else errs.push(r.json?.error ?? `gán ảnh ${mid.slice(0, 8)} lỗi`);
  }
  if (nMedia) done.push(`${nMedia} ảnh`);

  // 4) Điều chỉnh tồn — sau cùng, và chỉ những dòng có nhập số.
  const reason = String(f.stock_reason ?? '').trim() || null;
  const vidsStock = Object.keys(f).map((k) => new RegExp(`^delta_${UUID}$`).exec(k)?.[1]).filter(Boolean);
  let nStock = 0;
  for (const vid of vidsStock) {
    const raw = String(f[`delta_${vid}`] ?? '').replace(/[^\d-]/g, '');
    if (raw === '' || raw === '-') continue;
    const delta = parseInt(raw, 10);
    if (!Number.isFinite(delta) || delta === 0) continue;
    const r = await sellerApi('POST', `/shops/${shopId}/variants/${vid}/inventory/adjust`, { cookie, body: { delta, reason } });
    if (r.status === 200) nStock++; else errs.push(r.json?.error ?? `tồn biến thể ${vid.slice(0, 8)} lỗi`);
  }
  if (nStock) done.push(`tồn ${nStock} biến thể`);

  if (errs.length) {
    const msg = `Đã lưu: ${done.join(', ') || 'không có gì'}. Lỗi: ${errs.slice(0, 4).join('; ')}${errs.length > 4 ? '…' : ''}`;
    return productDetail(res, me, cookie, shopId, pid, msg, f);
  }
  return redirect(res, `/shops/${shopId}/products/${pid}?saved=${encodeURIComponent(done.join(', ') || 'không có thay đổi')}`);
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

// Sửa giá + giá gạch + cân 1 biến thể (ô inline trong bảng biến thể, chung nút Lưu) → seller PATCH.
async function variantPrice(req, res, me, cookie, shopId, pid, vid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  // Cân: '' = xoá (NULL → dùng mặc định shop); rác → -1 để seller trả lỗi tiếng Việt.
  const wraw = String(f.weight_gram ?? '').trim();
  // Giá gạch (compare-at, chỉ hiển thị): '' = xoá; rác → -1 (seller trả 400 tiếng Việt).
  const craw = String(f.compare_at_vnd ?? '').trim();
  // Giá vốn (0081, bảng variant_costs): '' = xoá dòng; rác → -1 (seller 400).
  const coraw = String(f.cost_vnd ?? '').trim();
  const body = {
    price_vnd: parseVnd(f.price_vnd),
    weight_gram: wraw === '' ? null : (Number.isFinite(Number(wraw)) ? Math.round(Number(wraw)) : -1),
    compare_at_vnd: craw === '' ? null : (Number.isFinite(Number(craw)) ? Math.round(Number(craw)) : -1),
    cost_vnd: coraw === '' ? null : (Number.isFinite(Number(coraw)) ? Math.round(Number(coraw)) : -1),
  };
  const r = await sellerApi('PATCH', `/shops/${shopId}/products/${pid}/variants/${vid}`, { cookie, body });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/products/${pid}`);
  return productDetail(res, me, cookie, shopId, pid, r.json?.error ?? 'Không sửa được giá biến thể.');
}

// Lưu HÀNG LOẠT (0093): MỘT form gồm giá/giá gạch/giá vốn/cân của MỌI biến thể → lặp từng
// biến thể gọi ĐÚNG PATCH per-variant y như variantPrice (giữ NGUYÊN money semantics + validate
// của seller). Body key theo id: price_/compare_/cost_/weight_<vid>. KHÔNG nuốt lỗi: gom lỗi từng
// dòng để báo lại. Danh sách vid suy ra từ chính các key price_<uuid> (mỗi dòng luôn gửi 1 ô giá).
async function variantBulkPrice(req, res, me, cookie, shopId, pid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const idRe = new RegExp(`^price_${UUID}$`);
  const vids = Object.keys(f).map((k) => { const mm = idRe.exec(k); return mm ? mm[1] : null; }).filter(Boolean);
  let saved = 0; const errs = [];
  for (const vid of vids) {
    // Parse Y HỆT variantPrice: '' = xoá (NULL → mặc định shop); rác → -1 để seller trả 400 tiếng Việt.
    const wraw = String(f[`weight_${vid}`] ?? '').trim();
    const craw = String(f[`compare_${vid}`] ?? '').trim();
    const coraw = String(f[`cost_${vid}`] ?? '').trim();
    const body = {
      price_vnd: parseVnd(f[`price_${vid}`]),
      weight_gram: wraw === '' ? null : (Number.isFinite(Number(wraw)) ? Math.round(Number(wraw)) : -1),
      compare_at_vnd: craw === '' ? null : (Number.isFinite(Number(craw)) ? Math.round(Number(craw)) : -1),
      cost_vnd: coraw === '' ? null : (Number.isFinite(Number(coraw)) ? Math.round(Number(coraw)) : -1),
    };
    const r = await sellerApi('PATCH', `/shops/${shopId}/products/${pid}/variants/${vid}`, { cookie, body });
    if (r.status === 200) saved++;
    else errs.push(r.json?.error ?? `biến thể ${vid.slice(0, 8)} lỗi`);
  }
  if (errs.length) {
    // Có lỗi → hiện lại trang kèm số đã lưu + lỗi (không âm thầm bỏ qua dòng lỗi).
    const msg = `Đã lưu ${saved}/${vids.length} biến thể. Lỗi: ${errs.slice(0, 5).join('; ')}${errs.length > 5 ? '…' : ''}`;
    return productDetail(res, me, cookie, shopId, pid, msg);
  }
  return redirect(res, `/shops/${shopId}/products/${pid}?saved=${saved}`);
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

// Điều chỉnh tồn HÀNG LOẠT (nút "Cập nhật tồn"): mọi ô +/− của bảng biến thể nằm chung form
// bulkstock, key delta_<vid>. Chỉ áp cho dòng ĐÃ điền số khác 0; mỗi dòng gọi ĐÚNG cùng endpoint
// /inventory/adjust như nút lẻ cũ → sổ kho / oversell / RLS y hệt N lần bấm lẻ. Gom lỗi để báo lại.
async function inventoryBulkAdjust(req, res, me, cookie, shopId, pid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const reason = String(f.reason ?? '').trim() || null;
  const idRe = new RegExp(`^delta_${UUID}$`);
  const vids = Object.keys(f).map((k) => { const mm = idRe.exec(k); return mm ? mm[1] : null; }).filter(Boolean);
  let done = 0, filled = 0; const errs = [];
  for (const vid of vids) {
    const raw = String(f[`delta_${vid}`] ?? '').replace(/[^\d-]/g, '');
    if (raw === '' || raw === '-') continue;              // dòng bỏ trống → không đụng tới
    const delta = parseInt(raw, 10);
    if (!Number.isFinite(delta) || delta === 0) continue; // 0/rác → bỏ (không tạo chuyển động thừa)
    filled++;
    const r = await sellerApi('POST', `/shops/${shopId}/variants/${vid}/inventory/adjust`, { cookie, body: { delta, reason } });
    if (r.status === 200) done++;
    else errs.push(r.json?.error ?? `biến thể ${vid.slice(0, 8)} lỗi`);
  }
  if (errs.length) {
    const msg = `Đã chỉnh tồn ${done}/${filled} biến thể. Lỗi: ${errs.slice(0, 5).join('; ')}${errs.length > 5 ? '…' : ''}`;
    return productDetail(res, me, cookie, shopId, pid, msg);
  }
  return redirect(res, `/shops/${shopId}/products/${pid}?stocked=${done}`);
}

async function mediaUpload(req, res, me, cookie, shopId, pid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  let files = [], tooBig = false;
  // Nhiều ảnh cùng lúc (input multiple). Trần TỔNG 40MB; mỗi ảnh seller vẫn siết ≤10MB.
  try { files = await readMultipartFiles(req); } catch (e) { tooBig = e.statusCode === 413; }
  if (tooBig) return productDetail(res, me, cookie, shopId, pid, 'Ảnh quá lớn (tổng tối đa 40MB).');
  files = files.filter((f) => f.bytes?.length);
  if (!files.length) return productDetail(res, me, cookie, shopId, pid, 'Chưa chọn ảnh hợp lệ.');
  // Forward BYTE THÔ từng ảnh tới seller (sniff magic byte + re-encode WebP), tuần tự.
  let okN = 0, lastErr = null;
  for (const f of files) {
    const r = await sellerUpload(`/shops/${shopId}/products/${pid}/media`, { cookie, bytes: f.bytes });
    if (r.status === 201) okN++; else lastErr = r.json?.error ?? 'Tải ảnh thất bại.';
  }
  if (okN === files.length) return redirect(res, `/shops/${shopId}/products/${pid}`);
  return productDetail(res, me, cookie, shopId, pid, `Đã tải ${okN}/${files.length} ảnh. ${lastErr ?? ''}`.trim());
}

// Đặt/đổi TRỤC biến thể (Màu/Size…) → seller sinh ma trận. Ô "tên trục" trống = bỏ trục đó.
async function optionsSave(req, res, me, cookie, shopId, pid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readFormAll(req);
  const names = f.getAll('opt_name'), vals = f.getAll('opt_values');
  const options = [];
  for (let i = 0; i < names.length; i++) {
    const name = String(names[i] ?? '').trim();
    if (!name) continue;
    const values = String(vals[i] ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    options.push({ name, values });
  }
  const r = await sellerApi('PUT', `/shops/${shopId}/products/${pid}/options`, { cookie, body: { options } });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/products/${pid}`);
  return productDetail(res, me, cookie, shopId, pid, r.json?.error ?? 'Không lưu được biến thể.');
}

// Bảng thông số: textarea mỗi dòng "Tên: Giá trị".
async function specsSave(req, res, me, cookie, shopId, pid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const specs = String(f.specs ?? '').split(/\r?\n/).map((line) => {
    const idx = line.indexOf(':');
    if (idx < 0) return null;
    const name = line.slice(0, idx).trim(), value = line.slice(idx + 1).trim();
    return name && value ? { name, value } : null;
  }).filter(Boolean);
  const r = await sellerApi('PUT', `/shops/${shopId}/products/${pid}/specs`, { cookie, body: { specs } });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/products/${pid}`);
  return productDetail(res, me, cookie, shopId, pid, r.json?.error ?? 'Không lưu được thông số.');
}

// Gán 1 ảnh cho 1 biến thể (variant_id rỗng = ảnh chung sản phẩm).
async function mediaAssignVariant(req, res, me, cookie, shopId, pid, mediaId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const variant_id = String(f.variant_id ?? '').trim() || null;
  const r = await sellerApi('POST', `/shops/${shopId}/media/${mediaId}/variant`, { cookie, body: { variant_id } });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/products/${pid}`);
  return productDetail(res, me, cookie, shopId, pid, r.json?.error ?? 'Không gán được ảnh cho biến thể.');
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
  if (type === 'image') { // #24: key media ĐÃ upload (seller validate định dạng + đúng shop)
    const b = { type: 'image', key: String(f.key ?? '').trim(), alt: String(f.alt ?? '').trim() };
    const cap = String(f.caption ?? '').trim(); if (cap) b.caption = cap; return b;
  }
  return { type, text: String(f.text ?? '') }; // heading | paragraph
}

async function pagesList(res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('GET', `/shops/${shopId}/pages`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'pages');
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tải được danh sách trang.'));
  return sendHtmlJs(res, 200, (nonce) => V.renderContentPages({ ...ctx, nonce }, shopId, r.json));
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
  // Nạp SONG SONG ảnh của shop cho bộ chọn ảnh section — trang này vốn đã gọi 2 API,
  // thêm một tuần tự nữa là thêm một vòng chờ cho mỗi lần mở trang.
  const [r, media] = await Promise.all([
    sellerApi('GET', `/shops/${shopId}/pages/${pid}`, { cookie }),
    shopMedia(shopId, cookie),
  ]);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'pages');
  if (r.status !== 200 || !r.json) return sendHtml(res, r.status === 200 ? 502 : r.status, V.renderError(ctx, r.json?.error ?? 'Không tìm thấy trang.'));
  return sendHtml(res, err ? 409 : 200, V.renderPageEditor(ctx, shopId, r.json, err, notice, form, media));
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

/**
 * Đọc form section. Section CHỮ gửi url-encoded như cũ; section ẢNH gửi multipart vì
 * có ô tệp. Chọn ảnh sẵn có = radio `key`; chọn thêm tệp thì tệp GHI ĐÈ — người dùng
 * vừa tick vừa chọn tệp thì ý định rõ ràng là muốn dùng tệp mới.
 * Trả { f, err }: f đã có sẵn key đúng, err là câu báo lỗi cho người dùng.
 */
async function readBlockForm(req, cookie, shopId) {
  const ct = req.headers['content-type'] ?? '';
  if (!ct.startsWith('multipart/')) return { f: await readForm(req), err: null };
  let parsed;
  try { parsed = await readMultipartAll(req, 10 * 1024 * 1024); } catch (e) {
    return { f: {}, err: e.statusCode === 413 ? 'Ảnh quá lớn (tối đa 10MB).' : 'Không đọc được tệp tải lên.' };
  }
  const f = { ...parsed.fields };
  const file = (parsed.files ?? []).find((x) => x.bytes?.length);
  if (!file) return { f, err: null };
  const up = await sellerUpload(`/shops/${shopId}/content-image`, { cookie, bytes: file.bytes });
  if (up.status !== 200 || !up.json?.key) return { f, err: up.json?.error ?? 'Tải ảnh thất bại.' };
  f.key = up.json.key;
  return { f, err: null };
}

async function blockAdd(req, res, me, cookie, shopId, pid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const { f, err } = await readBlockForm(req, cookie, shopId);
  if (err) return pageEditor(res, me, cookie, shopId, pid, err);
  if (f.type === 'image' && !String(f.key ?? '').trim()) {
    return pageEditor(res, me, cookie, shopId, pid, 'Chưa chọn ảnh: bấm một ảnh có sẵn hoặc chọn tệp để tải lên.');
  }
  const r = await sellerApi('POST', `/shops/${shopId}/pages/${pid}/blocks`, { cookie, body: blockBody(f) });
  if (r.status === 201) return redirect(res, `/shops/${shopId}/pages/${pid}`);
  return pageEditor(res, me, cookie, shopId, pid, r.json?.error ?? 'Không thêm được section.');
}

async function blockEdit(req, res, me, cookie, shopId, pid, bid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const { f, err } = await readBlockForm(req, cookie, shopId);
  if (err) return pageEditor(res, me, cookie, shopId, pid, err);
  // Cùng lý do như blockAdd: seller sẽ trả 400 "key không hợp lệ", nhưng câu đó không
  // nói cho người dùng biết phải LÀM GÌ. Chặn tại đây với câu chỉ đúng thao tác.
  if (f.type === 'image' && !String(f.key ?? '').trim()) {
    return pageEditor(res, me, cookie, shopId, pid, 'Chưa chọn ảnh: bấm một ảnh có sẵn hoặc chọn tệp để tải lên.');
  }
  const r = await sellerApi('PATCH', `/shops/${shopId}/pages/${pid}/blocks/${bid}`, { cookie, body: blockBody(f) });
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
  // Nạp danh sách phiên đang sống + lịch sử đăng nhập (best-effort — lỗi thì trang vẫn hiện phần còn lại).
  let sessions = [], events = [];
  if (cookie) {
    try { const r = await authApi('GET', '/auth/sessions', { cookie }); if (r.status === 200) sessions = r.json?.sessions ?? []; } catch { /* ignore */ }
    try { const r = await authApi('GET', '/auth/events', { cookie }); if (r.status === 200) events = r.json?.events ?? []; } catch { /* ignore */ }
  }
  return sendHtml(res, extra.err ? 400 : 200, V.renderAccount({ email: me.email, mfa_enabled: me.mfa_enabled, sessions, events, ...extra }));
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

// ── quên mật khẩu (CÔNG KHAI — người quên mật khẩu KHÔNG có phiên) ────────────
// Trước đây /account/password/forgot nằm SAU tường đăng nhập = vô nghĩa với người
// đã quên mật khẩu. Cặp /forgot + /reset này công khai; POST vẫn qua sameOrigin.
function forgotPage(res) {
  return sendHtml(res, 200, V.renderForgot());
}
async function forgotSubmit(req, res) {
  const f = await readForm(req);
  // Nuốt lỗi + LUÔN trả trang trung tính: không tiết lộ email có tồn tại hay không.
  await authApi('POST', '/auth/password/forgot', { body: { email: String(f.email ?? '').trim() } }).catch(() => {});
  return sendHtml(res, 200, V.renderForgotDone());
}
function resetPage(res, url) {
  const token = url.searchParams.get('token') ?? '';
  if (!token) return sendHtml(res, 400, V.renderError({}, 'Thiếu mã đặt lại trong link.'));
  return sendHtml(res, 200, V.renderReset(token));
}
async function resetSubmit(req, res) {
  const f = await readForm(req);
  const token = String(f.token ?? '');
  const r = await authApi('POST', '/auth/password/reset', { body: { token, password: String(f.password ?? '') } });
  if (r.status === 200) return sendHtml(res, 200, V.renderResetDone());
  return sendHtml(res, r.status, V.renderReset(token, r.json?.error ?? 'Link không hợp lệ hoặc đã hết hạn.'));
}

// ── nhật ký hoạt động — seller cưỡng chế audit.read (owner/admin) ─────────────
async function auditPage(res, me, cookie, shopId, sp) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'audit');
  const offset = Math.max(parseInt(sp.get('offset') ?? '0', 10) || 0, 0), limit = 50;
  const r = await sellerApi('GET', `/shops/${shopId}/audit-log?limit=${limit}&offset=${offset}`, { cookie });
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tải được nhật ký.'));
  return sendHtmlJs(res, 200, (nonce) => V.renderAuditLog({ ...ctx, nonce }, shopId, r.json, { offset, limit }));
}

// ── nhân sự (member management) — SỬA cần step-up; seller cưỡng chế members.write ─
async function membersList(res, me, cookie, shopId, notice, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('GET', `/shops/${shopId}/members`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'members');
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error ?? 'Không tải được nhân sự.'));
  return sendHtmlJs(res, err ? 409 : 200, (nonce) => V.renderMembers({ ...ctx, nonce }, shopId, r.json, roleFor(me, shopId) === 'owner', notice, err));
}
// Lõi thao tác (giả định đã step-up; seller vẫn kiểm lại phía nó).
async function doInvite(res, me, cookie, shopId, p) {
  const r = await sellerApi('POST', `/shops/${shopId}/members/invite`, { cookie, body: { email: p.email, role: p.role } });
  // Token KHÔNG còn trong response (email hoá lời mời, 0073) — chỉ báo đã gửi email.
  if (r.status === 201) return membersList(res, me, cookie, shopId, { invited: p.email });
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

// ── Báo cáo lợi nhuận (0081) — owner/admin (seller cưỡng chế 'reports.read') ──
async function reportsPage(res, me, cookie, shopId, q) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'reports');
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const qs = new URLSearchParams();
  for (const k of ['from', 'to']) { const v = (q.get(k) ?? '').trim(); if (DATE_RE.test(v)) qs.set(k, v); }
  if (['day', 'month'].includes(q.get('group'))) qs.set('group', q.get('group'));
  if (['revenue', 'profit', 'qty'].includes(q.get('sort'))) qs.set('sort', q.get('sort'));
  // Allowlist tham số MỚI — thiếu dòng này thì preset/compare bị nuốt im lặng ở BFF.
  if (['today', '7d', '30d', 'mtd', 'last_month'].includes(q.get('preset'))) qs.set('preset', q.get('preset'));
  if (q.get('compare') === 'off') qs.set('compare', 'off');
  const r = await sellerApi('GET', `/shops/${shopId}/reports/sales${qs.size ? `?${qs}` : ''}`, { cookie });
  // 403 = order_manager/catalog_manager gõ tay URL (nav vốn ẩn) — trang lỗi rõ ràng.
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, r.json?.error === 'forbidden' || r.status === 403 ? 'Chỉ chủ shop / quản trị viên xem được báo cáo lợi nhuận.' : (r.json?.error ?? 'Không tải được báo cáo.')));
  const todayVN = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  return sendHtmlJs(res, 200, (nonce) => V.renderReports({ ...ctx, nonce }, shopId, r.json, { todayVN }));
}
// POST xuất CSV báo cáo → chưa step-up thì interstitial (mang theo type/from/to/group).
function reportExportFields(f) {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  return {
    type: f.type === 'products' ? 'products' : 'pnl',
    from: DATE_RE.test(String(f.from ?? '').trim()) ? String(f.from).trim() : '',
    to: DATE_RE.test(String(f.to ?? '').trim()) ? String(f.to).trim() : '',
    ...(['day', 'month'].includes(f.group) ? { group: f.group } : {}),
  };
}
async function doReportExport(res, me, cookie, shopId, fields) {
  const qs = new URLSearchParams(Object.entries(fields).filter(([, v]) => v));
  const r = await sellerDownload(`/shops/${shopId}/reports/export?${qs}`, { cookie });
  // filename PHẢI ASCII thuần — ký tự ngoài Latin-1 trong header → Node ném ERR_INVALID_CHAR (500).
  const fname = ['bao-cao', fields.type, fields.from, fields.to].filter(Boolean).join('-') + '.csv';
  if (r.status === 200) return sendDownload(res, r.bytes, { filename: fname, contentType: r.contentType ?? 'text/csv; charset=utf-8' });
  let msg = 'Không xuất được báo cáo.';
  try { const j = JSON.parse(r.bytes.toString('utf8')); if (j?.error) msg = j.error; } catch {}
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'reports');
  return sendHtml(res, 400, V.renderError(ctx, msg));
}
async function reportsExportCreate(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const fields = reportExportFields(await readForm(req));
  if (steppedUp(me)) return doReportExport(res, me, cookie, shopId, fields);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'reports');
  return sendHtml(res, 200, V.renderReportsStepUp(ctx, shopId, fields, null));
}
async function reportsExportStepUp(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const fields = reportExportFields(f);
  const r = await authApi('POST', '/auth/step-up', { cookie, body: { password: String(f.password ?? '') } });
  if (r.status !== 200) {
    const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'reports');
    return sendHtml(res, 401, V.renderReportsStepUp(ctx, shopId, fields, r.status === 429 ? 'Quá nhiều lần thử, đợi chút.' : 'Mật khẩu không đúng.'));
  }
  return doReportExport(res, me, cookie, shopId, fields);
}

// ── XUẤT CSV ĐƠN HÀNG theo bộ lọc đang xem ───────────────────────────────────
// Cùng bậc nhạy cảm với xuất báo cáo (perm 'export' + step-up ở seller): file chứa SĐT/địa
// chỉ khách HÀNG LOẠT, trong khi danh sách đơn cố tình không trả SĐT.
function ordersExportFields(f) {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  return {
    status: ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'refunded', 'returned'].includes(f.status) ? f.status : '',
    q: String(f.q ?? '').trim().slice(0, 100),
    from: DATE_RE.test(String(f.from ?? '').trim()) ? String(f.from).trim() : '',
    to: DATE_RE.test(String(f.to ?? '').trim()) ? String(f.to).trim() : '',
    source: ['web', 'manual', 'facebook', 'zalo', 'tiktok', 'other'].includes(f.source) ? f.source : '',
  };
}
async function doOrdersExport(res, me, cookie, shopId, fields) {
  const qs = new URLSearchParams(Object.entries(fields).filter(([, v]) => v));
  const r = await sellerDownload(`/shops/${shopId}/orders/export?${qs}`, { cookie });
  // Tên file PHẢI ASCII thuần — ký tự ngoài Latin-1 trong header là ERR_INVALID_CHAR (500).
  // TUYỆT ĐỐI không nhét `q` (người bán gõ tiếng Việt có dấu) vào tên file.
  const fname = ['don-hang', fields.status, fields.from, fields.to].filter(Boolean).join('-') + '.csv';
  if (r.status === 200) return sendDownload(res, r.bytes, { filename: fname, contentType: r.contentType ?? 'text/csv; charset=utf-8' });
  let msg = 'Không xuất được đơn hàng.';
  try { const j = JSON.parse(r.bytes.toString('utf8')); if (j?.error) msg = j.error; } catch {}
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
  return sendHtml(res, r.status === 413 ? 413 : 400, V.renderError(ctx, msg));
}
const ORDERS_STEPUP_OPTS = { section: 'orders', why: 'File này chứa tên, số điện thoại và địa chỉ khách hàng — nhập mật khẩu của bạn để tiếp tục.' };
async function ordersExportCreate(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const fields = ordersExportFields(await readForm(req));
  if (steppedUp(me)) return doOrdersExport(res, me, cookie, shopId, fields);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
  return sendHtml(res, 200, V.renderReportsStepUp(ctx, shopId, fields, null, ORDERS_STEPUP_OPTS));
}
async function ordersExportStepUp(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const fields = ordersExportFields(f);
  const r = await authApi('POST', '/auth/step-up', { cookie, body: { password: String(f.password ?? '') } });
  if (r.status !== 200) {
    const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
    return sendHtml(res, 401, V.renderReportsStepUp(ctx, shopId, fields, r.status === 429 ? 'Quá nhiều lần thử, đợi chút.' : 'Mật khẩu không đúng.', ORDERS_STEPUP_OPTS));
  }
  return doOrdersExport(res, me, cookie, shopId, fields);
}

// ── NHẬP HÀNG (0085) — owner/admin (seller cưỡng chế 'inventory.manage') ──────
// Trang lỗi thống nhất khi seller trả 403 (order/catalog_manager gõ tay URL — nav vốn ẩn).
function invForbidden(r) { return r.status === 403; }
const invDenyMsg = 'Chỉ chủ shop / quản trị viên dùng được khu Nhập hàng (giá nhập, nhà cung cấp là bí mật kinh doanh).';
const STOCKTAKE_NOTICE = { counted: 'Đã lưu số đếm.', completed: 'Đã chốt kiểm kê — tồn kho đã điều chỉnh theo số đếm.' };

async function purchasingPage(res, me, cookie, shopId, q) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'purchasing');
  const status = ['draft', 'ordered', 'received', 'cancelled'].includes(q.get('status')) ? q.get('status') : '';
  const r = await sellerApi('GET', `/shops/${shopId}/purchase-orders${status ? `?status=${status}` : ''}`, { cookie });
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, invForbidden(r) ? invDenyMsg : (r.json?.error ?? 'Không tải được phiếu nhập.')));
  return sendHtmlJs(res, 200, (nonce) => V.renderPurchasing({ ...ctx, nonce }, shopId, r.json, { status }));
}

async function suppliersPage(res, me, cookie, shopId, q, notice, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'purchasing');
  const showInactive = q?.get('all') === '1';
  const editId = q?.get('edit') ?? null;
  // Luôn nạp cả NCC đã ẩn để tìm được đối tượng đang sửa; lọc hiển thị theo showInactive.
  const r = await sellerApi('GET', `/shops/${shopId}/suppliers?all=1`, { cookie });
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, invForbidden(r) ? invDenyMsg : (r.json?.error ?? 'Không tải được nhà cung cấp.')));
  const all = r.json.suppliers ?? [];
  const editing = editId ? all.find((s) => s.id === editId) ?? null : null;
  const list = showInactive ? all : all.filter((s) => s.is_active);
  return sendHtmlJs(res, err ? 400 : 200, (nonce) => V.renderSuppliers({ ...ctx, nonce }, shopId, list, { notice, err, editing, showInactive }));
}
function supplierBody(f) {
  return {
    name: (f.get('name') ?? '').trim(), contact: (f.get('contact') ?? '').trim(),
    phone: (f.get('phone') ?? '').trim(), email: (f.get('email') ?? '').trim(),
    address: (f.get('address') ?? '').trim(), note: (f.get('note') ?? '').trim(),
  };
}
async function supplierCreate(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readFormAll(req);
  const r = await sellerApi('POST', `/shops/${shopId}/suppliers`, { cookie, body: supplierBody(f) });
  if (r.status !== 201) return suppliersPage(res, me, cookie, shopId, new URLSearchParams(), null, r.json?.error ?? 'Không thêm được nhà cung cấp.');
  return redirect(res, `/shops/${shopId}/suppliers?notice=created`);
}
async function supplierUpdate(req, res, me, cookie, shopId, sid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readFormAll(req);
  const body = { ...supplierBody(f), is_active: (f.get('is_active') ?? '') === '1' };
  const r = await sellerApi('PATCH', `/shops/${shopId}/suppliers/${sid}`, { cookie, body });
  if (r.status !== 200) return suppliersPage(res, me, cookie, shopId, new URLSearchParams(`edit=${sid}`), null, r.json?.error ?? 'Không lưu được.');
  return redirect(res, `/shops/${shopId}/suppliers?notice=saved`);
}

// Gom các slot dòng phiếu (variant_id[]/qty[]/unit_cost[] song song) → mảng dòng (bỏ slot rỗng).
function poLinesFromForm(f) {
  const vids = f.getAll('variant_id'), qtys = f.getAll('qty'), costs = f.getAll('unit_cost');
  const lines = [];
  for (let i = 0; i < vids.length; i++) {
    if (!vids[i]) continue;
    lines.push({ variant_id: vids[i], qty: Number(qtys[i] ?? 0), unit_cost_vnd: Number(costs[i] ?? 0) });
  }
  return lines;
}
async function poNewPage(res, me, cookie, shopId, err, form, q) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'purchasing');
  const pq = (q ?? '').trim().slice(0, 100);
  const [pv, sup] = await Promise.all([
    sellerApi('GET', `/shops/${shopId}/purchasable-variants${pq ? `?q=${encodeURIComponent(pq)}` : ''}`, { cookie }),
    sellerApi('GET', `/shops/${shopId}/suppliers`, { cookie }),
  ]);
  if (pv.status !== 200) return sendHtml(res, pv.status, V.renderError(ctx, invForbidden(pv) ? invDenyMsg : (pv.json?.error ?? 'Không tải được danh sách hàng.')));
  return sendHtml(res, err ? 400 : 200, V.renderPurchaseOrderNew(ctx, shopId, pv.json.variants ?? [], sup.json?.suppliers ?? [], err, form ?? {}, { q: pq, truncated: pv.json.truncated === true }));
}
async function poNewSubmit(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readFormAll(req);
  const lines = poLinesFromForm(f);
  const body = { supplier_id: f.get('supplier_id') ?? '', note: (f.get('note') ?? '').trim(), lines };
  const r = await sellerApi('POST', `/shops/${shopId}/purchase-orders`, { cookie, body });
  if (r.status === 201) return redirect(res, `/shops/${shopId}/purchasing/${r.json.id}`);
  const form = { supplier_id: body.supplier_id, note: body.note, lines };
  return poNewPage(res, me, cookie, shopId, r.json?.error ?? 'Không tạo được phiếu.', form, f.get('picker_q') ?? '');
}
async function poDetailPage(res, me, cookie, shopId, pid, notice, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'purchasing');
  const r = await sellerApi('GET', `/shops/${shopId}/purchase-orders/${pid}`, { cookie });
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, invForbidden(r) ? invDenyMsg : (r.json?.error ?? 'Không tìm thấy phiếu nhập.')));
  return sendHtmlJs(res, err ? 409 : 200, (nonce) => V.renderPurchaseOrderDetail({ ...ctx, nonce }, shopId, r.json, notice, err));
}
async function poEditPage(res, me, cookie, shopId, pid, err, q) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'purchasing');
  const pq = (q ?? '').trim().slice(0, 100);
  const r = await sellerApi('GET', `/shops/${shopId}/purchase-orders/${pid}`, { cookie });
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, invForbidden(r) ? invDenyMsg : (r.json?.error ?? 'Không tìm thấy phiếu.')));
  if (!['draft', 'ordered'].includes(r.json.status)) return poDetailPage(res, me, cookie, shopId, pid, null, 'Phiếu đã chốt/huỷ, không sửa được.');
  const [pv, sup] = await Promise.all([
    sellerApi('GET', `/shops/${shopId}/purchasable-variants${pq ? `?q=${encodeURIComponent(pq)}` : ''}`, { cookie }),
    sellerApi('GET', `/shops/${shopId}/suppliers?all=1`, { cookie }),
  ]);
  return sendHtml(res, err ? 400 : 200, V.renderPurchaseOrderEdit(ctx, shopId, r.json, pv.json?.variants ?? [], sup.json?.suppliers ?? [], err, { q: pq }));
}
async function poEditSubmit(req, res, me, cookie, shopId, pid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readFormAll(req);
  const body = { supplier_id: f.get('supplier_id') ?? '', note: (f.get('note') ?? '').trim(), lines: poLinesFromForm(f) };
  const r = await sellerApi('PATCH', `/shops/${shopId}/purchase-orders/${pid}`, { cookie, body });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/purchasing/${pid}`);
  return poEditPage(res, me, cookie, shopId, pid, r.json?.error ?? 'Không lưu được phiếu.', f.get('picker_q') ?? '');
}
async function poAction(res, me, cookie, shopId, pid, action) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('POST', `/shops/${shopId}/purchase-orders/${pid}/${action}`, { cookie });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/purchasing/${pid}`);
  return poDetailPage(res, me, cookie, shopId, pid, null, r.json?.error ?? 'Không thực hiện được.');
}
async function poReceivePage(res, me, cookie, shopId, pid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'purchasing');
  const r = await sellerApi('GET', `/shops/${shopId}/purchase-orders/${pid}`, { cookie });
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, invForbidden(r) ? invDenyMsg : (r.json?.error ?? 'Không tìm thấy phiếu.')));
  if (!['draft', 'ordered'].includes(r.json.status)) return poDetailPage(res, me, cookie, shopId, pid, null, 'Phiếu đã chốt/huỷ.');
  if ((r.json.lines ?? []).length === 0) return poDetailPage(res, me, cookie, shopId, pid, null, 'Phiếu chưa có dòng hàng — thêm hàng trước khi nhận.');
  return sendHtml(res, 200, V.renderPurchaseOrderReceive(ctx, shopId, r.json));
}
async function poReceiveSubmit(res, me, cookie, shopId, pid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('POST', `/shops/${shopId}/purchase-orders/${pid}/receive`, { cookie });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/purchasing/${pid}?notice=received`);
  return poDetailPage(res, me, cookie, shopId, pid, null, r.json?.error ?? 'Không nhận được hàng.');
}
async function purchasingReportPage(res, me, cookie, shopId, q) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'purchasing');
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const qs = new URLSearchParams();
  for (const k of ['from', 'to']) { const v = (q.get(k) ?? '').trim(); if (DATE_RE.test(v)) qs.set(k, v); }
  const r = await sellerApi('GET', `/shops/${shopId}/purchasing/report${qs.size ? `?${qs}` : ''}`, { cookie });
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, invForbidden(r) ? invDenyMsg : (r.json?.error ?? 'Không tải được báo cáo nhập.')));
  return sendHtml(res, 200, V.renderPurchasingReport(ctx, shopId, r.json));
}

// ── Sổ cái kho (0097) ────────────────────────────────────────────────────────
// Trang CHỈ-ĐỌC liệt kê chuyển động tồn toàn shop. Cùng khu Kho nên dùng chung invForbidden
// (perm 'inventory.manage' → owner/admin; vai khác nhận thông báo tử tế thay vì JSON 403).
async function inventoryLedgerPage(res, me, cookie, shopId, q) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'purchasing');
  const kind = ['receive', 'ship', 'adjust'].includes(q.get('kind')) ? q.get('kind') : '';
  // UUID chặt (khớp seller): regex lỏng cho chuỗi 36 gạch nối lọt → 22P02 ở Postgres → 500.
  const variantId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(q.get('variant_id') ?? '') ? q.get('variant_id') : '';
  const limit = 50, offset = Math.max(0, parseInt(q.get('offset') ?? '0', 10) || 0);
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (kind) qs.set('kind', kind);
  if (variantId) qs.set('variant_id', variantId);
  const r = await sellerApi('GET', `/shops/${shopId}/inventory/ledger?${qs}`, { cookie });
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, invForbidden(r) ? invDenyMsg : (r.json?.error ?? 'Không tải được sổ cái kho.')));
  return sendHtmlJs(res, 200, (nonce) => V.renderInventoryLedger({ ...ctx, nonce }, shopId, r.json, { kind, variantId, limit, offset }));
}

// ── Kiểm kê ──────────────────────────────────────────────────────────────────
async function stocktakesPage(res, me, cookie, shopId, notice, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'stocktakes');
  const r = await sellerApi('GET', `/shops/${shopId}/stocktakes`, { cookie });
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, invForbidden(r) ? invDenyMsg : (r.json?.error ?? 'Không tải được kiểm kê.')));
  return sendHtmlJs(res, err ? 400 : 200, (nonce) => V.renderStocktakes({ ...ctx, nonce }, shopId, r.json.stocktakes ?? [], { notice, err }));
}
async function stocktakeCreate(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readFormAll(req);
  const body = { scope: 'all', note: (f.get('note') ?? '').trim() };
  const r = await sellerApi('POST', `/shops/${shopId}/stocktakes`, { cookie, body });
  if (r.status === 201) return redirect(res, `/shops/${shopId}/stocktakes/${r.json.id}`);
  return stocktakesPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không tạo được phiên kiểm kê.');
}
async function stocktakeDetailPage(res, me, cookie, shopId, sid, notice, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'stocktakes');
  const r = await sellerApi('GET', `/shops/${shopId}/stocktakes/${sid}`, { cookie });
  if (r.status !== 200) return sendHtml(res, r.status, V.renderError(ctx, invForbidden(r) ? invDenyMsg : (r.json?.error ?? 'Không tìm thấy phiên kiểm kê.')));
  return sendHtml(res, err ? 409 : 200, V.renderStocktakeDetail(ctx, shopId, r.json, notice, err));
}
async function stocktakeCount(req, res, me, cookie, shopId, sid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readFormAll(req);
  const vids = f.getAll('variant_id'), cqs = f.getAll('counted_qty');
  const counts = [];
  for (let i = 0; i < vids.length; i++) {
    const raw = (cqs[i] ?? '').trim();
    if (raw === '') continue; // ô để trống = chưa đếm, bỏ qua (không ghi đè null lên số cũ)
    counts.push({ variant_id: vids[i], counted_qty: Number(raw) });
  }
  if (counts.length === 0) return redirect(res, `/shops/${shopId}/stocktakes/${sid}`);
  const r = await sellerApi('PATCH', `/shops/${shopId}/stocktakes/${sid}`, { cookie, body: { counts } });
  if (r.status !== 200) return stocktakeDetailPage(res, me, cookie, shopId, sid, null, r.json?.error ?? 'Không lưu được số đếm.');
  return redirect(res, `/shops/${shopId}/stocktakes/${sid}?notice=counted`);
}
async function stocktakeComplete(res, me, cookie, shopId, sid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('POST', `/shops/${shopId}/stocktakes/${sid}/complete`, { cookie });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/stocktakes/${sid}?notice=completed`);
  return stocktakeDetailPage(res, me, cookie, shopId, sid, null, r.json?.error ?? 'Không chốt được kiểm kê.');
}
async function stocktakeCancel(res, me, cookie, shopId, sid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('POST', `/shops/${shopId}/stocktakes/${sid}/cancel`, { cookie });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/stocktakes`);
  return stocktakeDetailPage(res, me, cookie, shopId, sid, null, r.json?.error ?? 'Không huỷ được.');
}

// ── Điểm thưởng (0086) — owner/admin (loyalty.write) + step-up khi lưu ────────
function loyaltyFields(f) {
  return {
    enabled: (f.get('enabled') ?? '') === '1',
    earn_points_per_1000: Number(f.get('earn_points_per_1000') ?? 1),
    redeem_vnd_per_point: Number(f.get('redeem_vnd_per_point') ?? 100),
    earn_vesting_days: Number(f.get('earn_vesting_days') ?? 7),
    min_redeem_points: Number(f.get('min_redeem_points') ?? 0),
    max_redeem_pct: Number(f.get('max_redeem_pct') ?? 50),
  };
}
const LOYALTY_ADMIN_ROLES = new Set(['owner', 'admin']);
async function loyaltyPage(res, me, cookie, shopId, notice, err) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'loyalty');
  if (!LOYALTY_ADMIN_ROLES.has(roleFor(me, shopId))) return sendHtml(res, 403, V.renderError(ctx, 'Chỉ chủ shop / quản trị viên dùng được Điểm thưởng.'));
  const [cfg, rep] = await Promise.all([
    sellerApi('GET', `/shops/${shopId}/loyalty`, { cookie }),
    sellerApi('GET', `/shops/${shopId}/reports/loyalty`, { cookie }).catch(() => null),
  ]);
  if (cfg.status !== 200) return sendHtml(res, cfg.status, V.renderError(ctx, cfg.status === 403 ? 'Chỉ chủ shop / quản trị viên dùng được Điểm thưởng.' : (cfg.json?.error ?? 'Không tải được cấu hình.')));
  const report = rep && rep.status === 200 ? rep.json : null; // 403 (manager) → ẩn báo cáo, vẫn xem/sửa cấu hình
  return sendHtml(res, err ? 400 : 200, V.renderLoyalty(ctx, shopId, cfg.json, report, notice, err));
}
async function doLoyaltySave(res, me, cookie, shopId, fields) {
  const r = await sellerApi('PUT', `/shops/${shopId}/loyalty`, { cookie, body: fields });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/loyalty?notice=saved`);
  if (r.json?.step_up_required) { // seller cưỡng chế step-up (phòng khi cờ local lệch)
    const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'loyalty');
    return sendHtml(res, 200, V.renderLoyaltyStepUp(ctx, shopId, fields, null));
  }
  return loyaltyPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không lưu được cấu hình.');
}
async function loyaltySave(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  if (!LOYALTY_ADMIN_ROLES.has(roleFor(me, shopId))) return sendHtml(res, 403, V.renderError(shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'loyalty'), 'Chỉ chủ shop / quản trị viên.'));
  const fields = loyaltyFields(await readFormAll(req));
  if (!steppedUp(me)) {
    const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'loyalty');
    return sendHtml(res, 200, V.renderLoyaltyStepUp(ctx, shopId, fields, null));
  }
  return doLoyaltySave(res, me, cookie, shopId, fields);
}
async function loyaltyStepUp(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readFormAll(req);
  const fields = loyaltyFields(f);
  const r = await authApi('POST', '/auth/step-up', { cookie, body: { password: String(f.get('password') ?? '') } });
  if (r.status !== 200) {
    const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'loyalty');
    return sendHtml(res, 401, V.renderLoyaltyStepUp(ctx, shopId, fields, r.status === 429 ? 'Quá nhiều lần thử, đợi chút.' : 'Mật khẩu không đúng.'));
  }
  return doLoyaltySave(res, me, cookie, shopId, fields);
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
async function themePage(res, me, cookie, shopId, ok, applied) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'theme');
  // Kèm danh mục + trang CMS thật → ô liên kết (nav/banner) thành SELECT đích có sẵn
  // (chủ shop không phải đoán URL); lỗi phụ → danh sách rỗng, form vẫn dùng được.
  const [r, catR, pgR] = await Promise.all([
    sellerApi('GET', `/shops/${shopId}/theme`, { cookie }),
    sellerApi('GET', `/shops/${shopId}/categories`, { cookie }).catch(() => ({ status: 0 })),
    sellerApi('GET', `/shops/${shopId}/pages`, { cookie }).catch(() => ({ status: 0 })),
  ]);
  const theme = r.status === 200 ? r.json : { tokens: {} };
  const linkTargets = {
    categories: catR.status === 200 ? (catR.json?.categories ?? []) : [],
    pages: pgR.status === 200 ? (pgR.json?.pages ?? []) : [],
  };
  const ap = applied ? getPreset(applied) : null;
  const notice = ap
    ? `Đã áp mẫu “${ap.name}” — màu sắc, bố cục và chữ mẫu đã đổi; banner, logo và sản phẩm giữ nguyên. Mở trang bán hàng để xem.`
    : (ok === '1' ? 'Đã lưu — mở trang bán hàng để xem thay đổi.' : null);
  return sendHtml(res, 200, V.renderTheme(ctx, theme, notice, linkTargets));
}

// Áp PRESET ngành (hệ preset): đổi màu + bố cục + chữ mẫu nhưng GIỮ ảnh banner đã upload.
// GET /theme/preset?preset=<slug> = màn XÁC NHẬN (không side-effect); POST = áp thật.
async function presetConfirmPage(res, me, cookie, shopId, slug) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const preset = getPreset(String(slug ?? ''));
  if (!preset) return redirect(res, `/shops/${shopId}/theme`);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'theme');
  return sendHtml(res, 200, V.renderPresetConfirm(ctx, String(slug), preset));
}
async function applyPreset(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const slug = String(f.preset ?? '');
  const preset = getPreset(slug);
  if (!preset) return redirect(res, `/shops/${shopId}/theme?ok=0`);
  // GIỮ ẢNH: trong layout, CHỈ props.slides mang media do shop upload (banner). Logo ở bảng
  // shops (không đụng). Gom slides từ theme HIỆN TẠI theo section-key rồi chép sang layout
  // preset → áp mẫu KHÔNG nuốt banner. Seller validateBannerInLayout kiểm key thuộc shop lần cuối.
  const cur = await sellerApi('GET', `/shops/${shopId}/theme`, { cookie });
  const curLayout = cur.status === 200 && Array.isArray(cur.json?.layout) ? cur.json.layout : [];
  const savedSlides = new Map();
  for (const s of curLayout) {
    if (s && typeof s === 'object' && Array.isArray(s.props?.slides) && s.props.slides.length && !savedSlides.has(s.section)) {
      savedSlides.set(s.section, s.props.slides);
    }
  }
  const layout = preset.layout.map((s) => ({ section: s.section, props: { ...(s.props ?? {}) } }));
  for (const s of layout) if (savedSlides.has(s.section)) s.props.slides = savedSlides.get(s.section);
  // Phòng thủ: preset thiếu hero mà shop có banner → chèn hero ngay sau header (không mất ảnh).
  if (savedSlides.has('hero') && !layout.some((s) => s.section === 'hero')) {
    const hi = layout.findIndex((s) => s.section === 'header');
    layout.splice(hi >= 0 ? hi + 1 : 0, 0, { section: 'hero', props: { slides: savedSlides.get('hero') } });
  }
  const tokens = { ...preset.tokens };
  delete tokens['font.body']; delete tokens['font.heading']; // CSP chặn font ngoài — giữ Be Vietnam Pro
  const r = await sellerApi('PUT', `/shops/${shopId}/theme`, { cookie, body: { tokens, layout } });
  return redirect(res, r.status === 200 ? `/shops/${shopId}/theme?applied=${slug}` : `/shops/${shopId}/theme?ok=0`);
}
async function themeSave(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  // reset → tokens/layout rỗng (storefront dùng mặc định — người dùng bấm nút tường minh).
  // Còn lại: MERGE (#39) — đọc theme HIỆN TẠI trước, chỉ ghi đè đúng phần form sửa
  // (màu/chữ/bo góc, hero, tiêu đề lưới, 4 cam kết). Section lạ / props lạ (layout tuỳ
  // chỉnh qua API) GIỮ NGUYÊN — lưu giao diện không được xoá tuỳ biến của shop.
  // Storefront sanitize khi render nên giá trị lạ sẽ bị bỏ lúc render.
  let tokens = {}, layout = [];
  if (!f.reset) {
    const cur = await sellerApi('GET', `/shops/${shopId}/theme`, { cookie });
    const curTheme = cur.status === 200 && cur.json ? cur.json : {};
    tokens = curTheme.tokens && typeof curTheme.tokens === 'object' && !Array.isArray(curTheme.tokens) ? { ...curTheme.tokens } : {};
    const HEX = /^#[0-9a-fA-F]{6}$/;
    for (const k of ['color.primary', 'color.accent', 'color.hero-bg', 'color.text', 'color.surface']) {
      const v = String(f[k] ?? ''); if (HEX.test(v)) tokens[k] = v;
    }
    if (tokens['color.primary']) tokens['color.primary-dark'] = tokens['color.primary']; // màu hover nút
    const font = String(f.font ?? '').trim();
    // Form luôn gửi font: có giá trị → đặt; chọn "Mặc định" ('') → XOÁ để về mặc định.
    if (font) { tokens['font.body'] = font; tokens['font.heading'] = font; }
    else { delete tokens['font.body']; delete tokens['font.heading']; }
    const radius = String(f.radius ?? '').trim();
    if (/^\d{1,4}px$/.test(radius)) tokens['radius'] = radius;

    // layout: bắt đầu từ layout ĐANG LƯU (deep-copy mức section/props); trống → khung chuẩn.
    layout = Array.isArray(curTheme.layout) && curTheme.layout.length
      ? curTheme.layout.map((s) => (s && typeof s === 'object' ? { ...s, props: s.props && typeof s.props === 'object' ? { ...s.props } : {} } : s))
      : [{ section: 'header', props: {} }, { section: 'hero', props: {} }, { section: 'product_grid', props: {} }, { section: 'footer', props: {} }];
    const findOrInsert = (name, afterName) => {
      let s = layout.find((x) => x && x.section === name);
      if (!s) {
        s = { section: name, props: {} };
        const i = layout.findIndex((x) => x && x.section === afterName);
        layout.splice(i >= 0 ? i + 1 : layout.length, 0, s);
      }
      return s;
    };
    const setOrDel = (props, key, val) => { if (val) props[key] = val; else delete props[key]; };
    // Thanh thông báo: props trên section header. Header PHẢI đứng ĐẦU — storefront render
    // các section theo THỨ TỰ mảng, header cuối mảng = header rơi xuống đáy trang. Layout
    // tuỳ chỉnh (API) có thể thiếu header → chèn về ĐẦU (findOrInsert generic sẽ chèn cuối).
    let head = layout.find((x) => x && x.section === 'header');
    if (!head) { head = { section: 'header', props: {} }; layout.unshift(head); }
    setOrDel(head.props, 'topbar_text', String(f.topbar_text ?? '').trim().slice(0, 120));
    // Menu điều hướng "Sản phẩm" (Phase 5b): 3 toggle shortcut + nav_links tuỳ chỉnh.
    // Checkbox KHÔNG tick → field vắng → tắt (false). Gán bool TƯỜNG MINH (không setOrDel:
    // false sẽ bị xoá → storefront lại mặc định hiện). Seller re-sanitize label/url + cap 6.
    head.props.menu_show_featured = !!f.menu_show_featured;
    head.props.menu_show_new = !!f.menu_show_new;
    head.props.menu_show_sale = !!f.menu_show_sale;
    const navLinks = [];
    for (let i = 0; i < 6; i++) {
      const label = String(f[`nav_label_${i}`] ?? '').trim().slice(0, 40);
      // Đích = ô "URL tự nhập" GHI ĐÈ khi có chữ, không thì lấy SELECT đích có sẵn
      // (no-JS: cả hai control luôn hiện; seller vẫn safeLink lần cuối — phòng thủ giữ nguyên).
      const url = (String(f[`nav_url_${i}`] ?? '').trim() || String(f[`nav_dest_${i}`] ?? '').trim()).slice(0, 300);
      if (label && url) navLinks.push({ label, url }); // bỏ hàng thiếu nhãn hoặc URL
    }
    if (navLinks.length) head.props.nav_links = navLinks; else delete head.props.nav_links;
    // Kênh bán & mạng xã hội (footer). MỘT bảng nhập → HAI prop: social (chân trang) và
    // float (nút nổi, chỉ dòng có tick). Không tick dòng nào thì float bị XOÁ hẳn — nếu
    // dùng setOrDel với mảng rỗng, `[]` là truthy nên prop sẽ ở lại và storefront phải
    // đoán. Seller re-sanitize kind theo whitelist + dựng tel: cho kênh Gọi ngay.
    const foot = findOrInsert('footer', null);
    const social = [], float = [];
    for (let i = 0; i < 6; i++) {
      const kind = String(f[`ch_kind_${i}`] ?? '').trim();
      const url = String(f[`ch_url_${i}`] ?? '').trim().slice(0, 300);
      if (!kind || !url) continue;
      social.push({ kind, url });
      if (f[`ch_float_${i}`]) float.push({ kind, url });
    }
    if (social.length) foot.props.social = social; else delete foot.props.social;
    if (float.length) foot.props.float = float; else delete foot.props.float;
    const hero = findOrInsert('hero', 'header');
    setOrDel(hero.props, 'eyebrow', String(f.hero_eyebrow ?? '').trim().slice(0, 60));
    setOrDel(hero.props, 'title', String(f.hero_title ?? '').trim().slice(0, 120));
    setOrDel(hero.props, 'subtitle', String(f.hero_subtitle ?? '').trim().slice(0, 300));
    const grid = findOrInsert('product_grid', 'hero');
    setOrDel(grid.props, 'title', String(f.grid_title ?? '').trim().slice(0, 80));
    // Câu chuyện thương hiệu: cả 3 ô trống → storefront ẨN section (không chữ mẫu).
    const story = findOrInsert('story', 'product_grid');
    setOrDel(story.props, 'title', String(f.story_title ?? '').trim().slice(0, 80));
    setOrDel(story.props, 'body', String(f.story_body ?? '').trim().slice(0, 400));
    setOrDel(story.props, 'cta_text', String(f.story_cta ?? '').trim().slice(0, 40));
    // 4 cam kết (#40): mỗi ô (tiêu đề, mô tả) trống = giữ mặc định Ô ĐÓ; cả 4 trống =
    // bỏ items (storefront dùng nguyên bộ mặc định). Icon cố định theo ô.
    let anyFeat = false;
    const items = V.THEME_FEATURE_DEFAULTS.map((def, i) => {
      const t = String(f[`feat_title_${i}`] ?? '').trim().slice(0, 80);
      const d = String(f[`feat_desc_${i}`] ?? '').trim().slice(0, 200);
      if (t || d) anyFeat = true;
      return { icon: def.icon, title: t || def.title, desc: d || def.desc };
    });
    const feats = findOrInsert('features', 'hero');
    if (anyFeat) feats.props.items = items; else delete feats.props.items;
  }
  const r = await sellerApi('PUT', `/shops/${shopId}/theme`, { cookie, body: { tokens, layout } });
  return redirect(res, `/shops/${shopId}/theme?ok=${r.status === 200 ? 1 : 0}`);
}

// Banner trang chủ (Phase 5): form multipart RIÊNG (ảnh + chữ). Với mỗi hàng slide:
// upload file mới (nếu chọn) qua sellerUpload → key banner-; nếu không chọn thì GIỮ key cũ
// (hidden existing_key_i); tick "xoá" → bỏ slide. Ráp mảng slides rồi MERGE vào hero.props
// của theme HIỆN TẠI (giữ nguyên màu/chữ hero/section khác) và PUT. Seller validate key +
// chuẩn hoá chữ/link lần cuối (chống chéo shop). No-JS: form multipart thường.
const BANNER_ROWS = 4; // số hàng slide hero hiển thị (≤ trần 5 của seller)
const PROMO_ROWS = 3;  // 3 banner khuyến mãi (preset M.O.I)
// Tên field theo tiền tố → hero & promo dùng CÙNG form-schema nhưng KHÁC route/prefix (không đè nhau).
const heroFkey = (i) => ({ file: `banner_file_${i}`, existing: `existing_key_${i}`, remove: `remove_${i}`, headline: `headline_${i}`, sub: `sub_${i}`, label: `button_label_${i}`, link: `button_link_${i}`, dest: `button_dest_${i}` });
const promoFkey = (i) => ({ file: `promo_file_${i}`, existing: `promo_existing_${i}`, remove: `promo_remove_${i}`, headline: `promo_headline_${i}`, sub: `promo_sub_${i}`, label: `promo_label_${i}`, link: `promo_link_${i}`, dest: `promo_dest_${i}` });
const sideFkey = (i) => ({ file: `side_file_${i}`, existing: `side_existing_${i}`, remove: `side_remove_${i}`, headline: `side_headline_${i}`, sub: `side_sub_${i}`, label: `side_label_${i}`, link: `side_link_${i}`, dest: `side_dest_${i}` });
const HEROSIDE_ROWS = 2; // 2 banner phụ bên phải hero split (M.O.I)
// Chung cho MỌI dải banner (hero / promo_banners): upload từng ảnh → seller /banner-image (sinh key
// thuộc shop), ráp slides, MERGE vào <section>.props.slides của layout ĐANG LƯU rồi PUT /theme.
// Seller validateBannerInLayout validate MỌI section có props.slides → không cần sửa lớp bảo mật.
async function saveSectionBanners(req, res, me, cookie, shopId, { section, rows, fkey }) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  let parsed;
  try { parsed = await readMultipartAll(req); }
  catch (e) { return redirect(res, `/shops/${shopId}/theme?ok=0`); } // 413 ảnh quá lớn → báo lỗi lưu
  const { fields, files } = parsed;
  const fileByField = new Map(files.map((f) => [f.field, f]));
  const slides = [];
  for (let i = 0; i < rows && slides.length < 5; i++) {
    const F = fkey(i);
    if (fields[F.remove]) continue; // tick xoá → bỏ hẳn slide này
    let key = String(fields[F.existing] ?? '').trim();
    const file = fileByField.get(F.file);
    if (file && file.bytes?.length) {
      const up = await sellerUpload(`/shops/${shopId}/banner-image`, { cookie, bytes: file.bytes });
      if (up.status === 200 && up.json?.key) key = up.json.key; // ảnh mới thay ảnh cũ
    }
    if (!key) continue; // không ảnh → không phải banner
    slides.push({
      image_key: key,
      headline: String(fields[F.headline] ?? '').trim().slice(0, 120),
      sub: String(fields[F.sub] ?? '').trim().slice(0, 200),
      button_label: String(fields[F.label] ?? '').trim().slice(0, 40),
      // Ô "URL tự nhập" ghi đè SELECT đích có sẵn (giống nav_links; seller safeLink lần cuối).
      button_link: (String(fields[F.link] ?? '').trim() || String(fields[F.dest] ?? '').trim()).slice(0, 300),
    });
  }
  // Merge vào <section>.props.slides của layout ĐANG LƯU (không đụng section/props khác).
  const cur = await sellerApi('GET', `/shops/${shopId}/theme`, { cookie });
  const curTheme = cur.status === 200 && cur.json ? cur.json : {};
  const tokens = curTheme.tokens && typeof curTheme.tokens === 'object' && !Array.isArray(curTheme.tokens) ? curTheme.tokens : {};
  let layout = Array.isArray(curTheme.layout) && curTheme.layout.length
    ? curTheme.layout.map((s) => (s && typeof s === 'object' ? { ...s, props: s.props && typeof s.props === 'object' ? { ...s.props } : {} } : s))
    : [{ section: 'header', props: {} }, { section: 'hero', props: {} }, { section: 'product_grid', props: {} }, { section: 'footer', props: {} }];
  let sec = layout.find((x) => x && x.section === section);
  if (!sec) { // chèn hero sau header; các section khác (promo) sau hero — đúng vị trí bố cục.
    sec = { section, props: {} };
    const anchor = section === 'hero' ? 'header' : 'hero';
    const ai = layout.findIndex((x) => x && x.section === anchor);
    layout.splice(ai >= 0 ? ai + 1 : layout.length, 0, sec);
  }
  if (!sec.props || typeof sec.props !== 'object') sec.props = {};
  if (slides.length) sec.props.slides = slides; else delete sec.props.slides;
  const r = await sellerApi('PUT', `/shops/${shopId}/theme`, { cookie, body: { tokens, layout } });
  return redirect(res, `/shops/${shopId}/theme?ok=${r.status === 200 ? 1 : 0}`);
}
async function bannerSave(req, res, me, cookie, shopId) {
  return saveSectionBanners(req, res, me, cookie, shopId, { section: 'hero', rows: BANNER_ROWS, fkey: heroFkey });
}
async function promoSave(req, res, me, cookie, shopId) {
  return saveSectionBanners(req, res, me, cookie, shopId, { section: 'promo_banners', rows: PROMO_ROWS, fkey: promoFkey });
}
async function heroSideSave(req, res, me, cookie, shopId) {
  return saveSectionBanners(req, res, me, cookie, shopId, { section: 'hero_side', rows: HEROSIDE_ROWS, fkey: sideFkey });
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
async function settingsPage(res, me, cookie, shopId, notice, err, unused) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'settings');
  const r = await sellerApi('GET', `/shops/${shopId}`, { cookie });
  const shop = r.status === 200 ? r.json : {};
  return sendHtml(res, err ? 400 : 200, V.renderShopSettings(ctx, shopId, shop, notice, err, unused));
}
// Dọn ảnh trưng bày không dùng. HAI BƯỚC CỐ Ý: bấm "Kiểm tra" chỉ ĐẾM và bày ảnh ra,
// nút xoá chỉ hiện SAU khi đã có danh sách. Xoá tệp của người dùng mà không cho họ
// nhìn trước là kiểu thao tác tôi đã làm hỏng một lần ở DB dev — không lặp lại.
async function unusedImagesScan(res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('GET', `/shops/${shopId}/media/unused`, { cookie });
  if (r.status !== 200) return settingsPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không kiểm tra được kho ảnh.');
  return settingsPage(res, me, cookie, shopId, null, null, r.json);
}
async function unusedImagesDelete(res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const r = await sellerApi('POST', `/shops/${shopId}/media/unused/delete`, { cookie, body: {} });
  if (r.status !== 200) return settingsPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không xoá được.');
  const mb = ((r.json?.bytes ?? 0) / 1048576).toFixed(1);
  const more = r.json?.remaining ? ` Còn ${r.json.remaining} ảnh — bấm lại để dọn tiếp.` : '';
  return settingsPage(res, me, cookie, shopId, `Đã xoá ${r.json?.deleted ?? 0} ảnh, giải phóng ${mb} MB.${more}`, null);
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
    ship_fee_far_vnd: String(f.ship_fee_far_vnd ?? '').trim(),
    ship_extra_per_500g_vnd: String(f.ship_extra_per_500g_vnd ?? '').trim(),
    default_weight_gram: String(f.default_weight_gram ?? '').trim(),
    ship_from_province: String(f.ship_from_province ?? '').trim(),
    pii_retention_months: String(f.pii_retention_months ?? '').trim(),
    low_stock_threshold: String(f.low_stock_threshold ?? '').trim(),
    max_pending_per_ip: String(f.max_pending_per_ip ?? '').trim(),
    max_pending_per_phone: String(f.max_pending_per_phone ?? '').trim(),
    // Ship theo km (0089): forward nguyên sang seller (nơi validate + mirror CHECK distance-requires-config).
    ship_mode: String(f.ship_mode ?? '').trim(),
    ship_origin_lat: String(f.ship_origin_lat ?? '').trim(),
    ship_origin_lng: String(f.ship_origin_lng ?? '').trim(),
    ship_base_vnd: String(f.ship_base_vnd ?? '').trim(),
    ship_per_km_vnd: String(f.ship_per_km_vnd ?? '').trim(),
    ship_max_km: String(f.ship_max_km ?? '').trim(),
    ship_road_factor: String(f.ship_road_factor ?? '').trim(),
    ship_over_max_behavior: String(f.ship_over_max_behavior ?? '').trim(),
  };
  const r = await sellerApi('PATCH', `/shops/${shopId}`, { cookie, body });
  if (r.status === 200) return settingsPage(res, me, cookie, shopId, 'Đã lưu hồ sơ cửa hàng.', null);
  return settingsPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không lưu được hồ sơ.');
}
// Bật/tắt "bắt buộc nhân sự dùng 2FA" (0074) — form riêng, owner-only (seller cưỡng chế).
async function requireMfaSave(req, res, me, cookie, shopId) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const r = await sellerApi('PATCH', `/shops/${shopId}/require-mfa`, { cookie, body: { require_mfa: String(f.require_mfa ?? '') === '1' } });
  if (r.status === 200) {
    return settingsPage(res, me, cookie, shopId, r.json.require_mfa
      ? 'Đã BẬT bắt buộc xác thực 2 lớp — nhân sự chưa bật 2FA sẽ bị chặn cho tới khi bật.'
      : 'Đã tắt bắt buộc xác thực 2 lớp.', null);
  }
  return settingsPage(res, me, cookie, shopId, null, r.json?.error ?? 'Không đổi được cài đặt 2FA.');
}

// ── Hoàn tiền (refund = owner/admin; step-up) ────────────────────────────────
// Bút toán 0070: form gửi kèm amount_vnd (để trống = hoàn TOÀN BỘ số còn lại) + reason;
// hai giá trị này phải SỐNG SÓT qua màn step-up (hidden input) — không bắt gõ lại.
async function doRefund(res, me, cookie, shopId, oid, vals) {
  const body = {};
  if ((vals?.amount_vnd ?? '') !== '') body.amount_vnd = parseVnd(vals.amount_vnd);
  if ((vals?.reason ?? '').trim() !== '') body.reason = vals.reason.trim();
  const r = await sellerApi('POST', `/shops/${shopId}/orders/${oid}/refund`, { cookie, body });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/orders/${oid}`);
  return orderDetail(res, me, cookie, shopId, oid, r.json?.error ?? 'Không hoàn tiền được.');
}
async function refundConfirm(req, res, me, cookie, shopId, oid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const vals = { amount_vnd: String(f.amount_vnd ?? '').trim(), reason: String(f.reason ?? '').trim().slice(0, 500) };
  if (!['owner', 'admin'].includes(roleFor(me, shopId))) return orderDetail(res, me, cookie, shopId, oid, 'Chỉ chủ cửa hàng hoặc quản trị mới hoàn tiền.');
  if (steppedUp(me)) return doRefund(res, me, cookie, shopId, oid, vals);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
  return sendHtml(res, 200, V.renderRefundStepUp(ctx, shopId, oid, null, vals));
}
async function refundStepUp(req, res, me, cookie, shopId, oid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const f = await readForm(req);
  const vals = { amount_vnd: String(f.amount_vnd ?? '').trim(), reason: String(f.reason ?? '').trim().slice(0, 500) };
  const r = await authApi('POST', '/auth/step-up', { cookie, body: { password: String(f.password ?? '') } });
  if (r.status !== 200) {
    const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
    return sendHtml(res, 401, V.renderRefundStepUp(ctx, shopId, oid, r.status === 429 ? 'Quá nhiều lần thử, đợi chút.' : 'Mật khẩu không đúng.', vals));
  }
  return doRefund(res, me, cookie, shopId, oid, vals);
}

// ── Nhận trả hàng (RMA 0078; owner/admin; perm 'refund' + STEP-UP ở seller) ───
// Đơn ĐÃ GIAO: chọn dòng + số lượng trả (seller chặn quá số mua/quá số còn hoàn). Money-out
// → mirror hoàn tiền/sửa-đã-trả: mang TOÀN BỘ phiếu trả qua màn step-up (retry không mất input).
// restock từ checkbox 'on' (form gốc) hoặc hidden '1'/'0' (interstitial) → chuẩn hoá boolean.
function readReturnBody(f) {
  const vids = f.getAll('variant_id'), qtys = f.getAll('qty');
  const lines = [];
  for (let i = 0; i < vids.length; i++) {
    if (!vids[i]) continue;
    const qty = Number(qtys[i] ?? 0);
    if (!Number.isFinite(qty) || qty < 1) continue; // SL 0/trống → không trả dòng này
    lines.push({ variant_id: vids[i], qty });
  }
  const rv = String(f.get('restock') ?? '');
  return { lines, reason: String(f.get('reason') ?? '').trim().slice(0, 500), restock: rv === 'on' || rv === 'true' || rv === '1' };
}
// GET form: nạp đơn + guard (đã giao + owner/admin + còn hàng chưa trả). Không dẫn user vào
// form chết — nếu không đủ điều kiện, quay về chi tiết đơn kèm lý do.
async function returnPage(res, me, cookie, shopId, oid, err, form) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  const or = await sellerApi('GET', `/shops/${shopId}/orders/${oid}`, { cookie });
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
  if (or.status !== 200) return sendHtml(res, or.status, V.renderError(ctx, or.json?.error ?? 'Không tìm thấy đơn.'));
  const o = or.json;
  if (!['owner', 'admin'].includes(roleFor(me, shopId))) return orderDetail(res, me, cookie, shopId, oid, 'Chỉ chủ cửa hàng hoặc quản trị mới nhận trả hàng.');
  if (o.status !== 'delivered') return orderDetail(res, me, cookie, shopId, oid, 'Chỉ nhận trả hàng cho đơn ĐÃ GIAO (khách đã nhận).');
  if (!(o.lines ?? []).some((l) => Number(l.qty) - Number(l.returned_qty ?? 0) > 0)) return orderDetail(res, me, cookie, shopId, oid, 'Đơn này đã trả hết hàng — không còn gì để trả.');
  return sendHtml(res, err ? 400 : 200, V.renderReturnForm(ctx, shopId, o, err, form));
}
// Lõi: forward tới seller /return (giả định đã step-up; seller kiểm lại). 200 → banner + hoàn;
// 403 step_up_required (cửa sổ hết giữa chừng) → interstitial lại; lỗi khác → form giữ input.
async function doReturn(res, me, cookie, shopId, oid, body) {
  const r = await sellerApi('POST', `/shops/${shopId}/orders/${oid}/return`, { cookie, body });
  if (r.status === 200) return redirect(res, `/shops/${shopId}/orders/${oid}?returned=1&refund=${Number(r.json?.refund_vnd) || 0}&restock=${r.json?.restocked ? 1 : 0}`);
  if (r.json?.step_up_required) {
    const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
    return sendHtml(res, 200, V.renderReturnStepUp(ctx, shopId, oid, null, body));
  }
  return returnPage(res, me, cookie, shopId, oid, r.json?.error ?? 'Không nhận trả hàng được.', body);
}
async function returnSubmit(req, res, me, cookie, shopId, oid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  if (!['owner', 'admin'].includes(roleFor(me, shopId))) return orderDetail(res, me, cookie, shopId, oid, 'Chỉ chủ cửa hàng hoặc quản trị mới nhận trả hàng.');
  const body = readReturnBody(await readFormAll(req));
  if (body.lines.length === 0) return returnPage(res, me, cookie, shopId, oid, 'Hãy nhập số lượng trả (≥1) cho ít nhất một dòng hàng.', body);
  // Chưa step-up → interstitial mang toàn bộ phiếu trả (retry không mất input). Đã step-up → làm luôn.
  if (steppedUp(me)) return doReturn(res, me, cookie, shopId, oid, body);
  const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
  return sendHtml(res, 200, V.renderReturnStepUp(ctx, shopId, oid, null, body));
}
async function returnStepUp(req, res, me, cookie, shopId, oid) {
  if (!isMember(me, shopId)) return denyShop(res, me);
  if (!['owner', 'admin'].includes(roleFor(me, shopId))) return orderDetail(res, me, cookie, shopId, oid, 'Chỉ chủ cửa hàng hoặc quản trị mới nhận trả hàng.');
  const f = await readFormAll(req);
  const body = readReturnBody(f);
  const r = await authApi('POST', '/auth/step-up', { cookie, body: { password: String(f.get('password') ?? '') } });
  if (r.status !== 200) {
    const ctx = shopCtx(me, shopId, await shopNameOf(shopId, cookie), 'orders');
    return sendHtml(res, 401, V.renderReturnStepUp(ctx, shopId, oid, r.status === 429 ? 'Quá nhiều lần thử, đợi chút.' : 'Mật khẩu không đúng.', body));
  }
  return doReturn(res, me, cookie, shopId, oid, body);
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
    // Quên mật khẩu: CÔNG KHAI (đặt TRƯỚC tường đăng nhập — người quên mật khẩu không có phiên).
    if (p === '/forgot' && req.method === 'GET') return forgotPage(res);
    if (p === '/forgot' && req.method === 'POST') return forgotSubmit(req, res);
    if (p === '/reset' && req.method === 'GET') return resetPage(res, url);
    if (p === '/reset' && req.method === 'POST') return resetSubmit(req, res);

    // Còn lại: cần phiên ĐẦY ĐỦ.
    const sess = await loadSession(cookie);
    if (sess.state === 'mfa') return redirect(res, '/mfa');
    if (sess.state !== 'ok') return redirect(res, '/login');
    const me = sess.me;

    if (p === '/' && req.method === 'GET') return dashboard(res, me, cookie);

    // Console nền tảng (chỉ platform_staff — gate ẩn qua platform requireStaff).
    let pm;
    if (p === '/platform' && req.method === 'GET') return platformShops(res, me, cookie, url.searchParams);
    if (p === '/platform/new' && req.method === 'GET') return platformShopNew(res, me, cookie, null, {});
    if (p === '/platform/support' && req.method === 'GET') return platformSupport(res, me, cookie, url.searchParams);
    if ((pm = new RegExp(`^/platform/support/${UUID}/(resolve|reopen)$`).exec(p)) && req.method === 'POST') return platformSupportAction(req, res, me, cookie, pm[1], pm[2]);
    if (p === '/platform' && req.method === 'POST') return platformCreate(req, res, me, cookie);
    if ((pm = new RegExp(`^/platform/shops/${UUID}$`).exec(p)) && req.method === 'GET') return platformShopDetail(res, me, cookie, pm[1]);
    if ((pm = new RegExp(`^/platform/shops/${UUID}/invite$`).exec(p)) && req.method === 'POST') return platformInvite(req, res, me, cookie, pm[1]);
    if ((pm = new RegExp(`^/platform/shops/${UUID}/(suspend|restore)$`).exec(p)) && req.method === 'POST') return platformStatus(res, me, cookie, pm[1], pm[2]);
    if ((pm = new RegExp(`^/platform/shops/${UUID}/renew$`).exec(p)) && req.method === 'POST') return platformRenew(req, res, me, cookie, pm[1]);
    if ((pm = new RegExp(`^/platform/shops/${UUID}/terminate$`).exec(p)) && req.method === 'POST') return platformTerminate(req, res, me, cookie, pm[1]);
    if ((pm = new RegExp(`^/platform/shops/${UUID}/export$`).exec(p)) && req.method === 'GET') return platformExport(res, me, cookie, pm[1]);
    if ((pm = new RegExp(`^/platform/shops/${UUID}/step-up$`).exec(p)) && req.method === 'POST') return platformStepUp(req, res, me, cookie, pm[1]);

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
    // Ép MFA per-shop (0074): shop bật require_mfa mà tài khoản CHƯA bật MFA →
    // seller trả 403 {mfa_required_by_shop} cho MỌI route. Probe whoami một lần
    // (chỉ khi user chưa bật MFA — user đã bật đi thẳng, không tốn gọi nội bộ)
    // để hiện trang hướng dẫn thân thiện thay vì lỗi rời rạc ở từng trang.
    if (!me.mfa_enabled && (m = new RegExp(`^/shops/${UUID}(/|$)`).exec(p)) && isMember(me, m[1])) {
      const probe = await sellerApi('GET', `/shops/${m[1]}/whoami`, { cookie }).catch(() => ({ status: 0 }));
      if (probe.status === 403 && probe.json?.mfa_required_by_shop) {
        return sendHtml(res, 403, V.renderMfaRequiredByShop({ user: me }));
      }
    }
    if ((m = new RegExp(`^/shops/${UUID}/overview$`).exec(p)) && req.method === 'GET') return overviewPage(res, me, cookie, m[1], url.searchParams.get('live'));
    if ((m = new RegExp(`^/shops/${UUID}/activate$`).exec(p)) && req.method === 'POST') return activateShop(res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/orders$`).exec(p)) && req.method === 'GET') return ordersList(res, me, cookie, m[1], url.searchParams);
    if ((m = new RegExp(`^/shops/${UUID}/orders/new$`).exec(p)) && req.method === 'GET') return orderNewPage(res, me, cookie, m[1], null, null, url.searchParams.get('q') ?? '');
    if ((m = new RegExp(`^/shops/${UUID}/orders/new$`).exec(p)) && req.method === 'POST') return orderNewSubmit(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/bulk-confirm$`).exec(p)) && req.method === 'POST') return ordersBulkConfirm(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/bulk-mark-paid$`).exec(p)) && req.method === 'POST') return ordersBulkMarkPaid(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/print-batch$`).exec(p)) && req.method === 'GET') return ordersPrintBatch(res, me, cookie, m[1], url.searchParams);
    if ((m = new RegExp(`^/shops/${UUID}/orders/export$`).exec(p)) && req.method === 'POST') return ordersExportCreate(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/export/step-up$`).exec(p)) && req.method === 'POST') return ordersExportStepUp(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}$`).exec(p)) && req.method === 'GET') return orderDetail(res, me, cookie, m[1], m[2], null, url.searchParams.get('edited') === '1' ? (url.searchParams.get('refund') ?? '1') : null, url.searchParams.get('returned') === '1' ? { refund: url.searchParams.get('refund') ?? '0', restock: url.searchParams.get('restock') === '1' } : null);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/edit$`).exec(p)) && req.method === 'GET') return orderEditPage(res, me, cookie, m[1], m[2], null, null, url.searchParams.get('q') ?? '');
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/edit$`).exec(p)) && req.method === 'POST') return orderEditSubmit(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/edit-paid$`).exec(p)) && req.method === 'GET') return orderEditPaidPage(res, me, cookie, m[1], m[2], null, null, url.searchParams.get('q') ?? '');
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/edit-paid$`).exec(p)) && req.method === 'POST') return orderEditPaidSubmit(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/edit-paid/step-up$`).exec(p)) && req.method === 'POST') return orderEditPaidStepUp(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/print$`).exec(p)) && req.method === 'GET') return orderPrint(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/(confirm|ship|cancel|deliver|mark-paid|mark-returned)$`).exec(p)) && req.method === 'POST') return orderAction(req, res, me, cookie, m[1], m[2], m[3]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/mark-paid-qr$`).exec(p)) && req.method === 'POST') return markPaidQrConfirm(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/mark-paid-qr/step-up$`).exec(p)) && req.method === 'POST') return markPaidQrStepUp(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/refund$`).exec(p)) && req.method === 'POST') return refundConfirm(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/refund/step-up$`).exec(p)) && req.method === 'POST') return refundStepUp(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/return$`).exec(p)) && req.method === 'GET') return returnPage(res, me, cookie, m[1], m[2], null, null);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/return$`).exec(p)) && req.method === 'POST') return returnSubmit(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/return/step-up$`).exec(p)) && req.method === 'POST') return returnStepUp(req, res, me, cookie, m[1], m[2]);

    // Sản phẩm & tồn kho.
    if ((m = new RegExp(`^/shops/${UUID}/products$`).exec(p)) && req.method === 'GET') {
      // Thông báo sau PRG bulk — mẫu notice của trang chi tiết SP (đọc từ query rồi hiện),
      // KHÔNG để số liệu nằm trơ trên URL mà không ai đọc.
      const okN = parseInt(url.searchParams.get('bulk_ok') ?? '', 10);
      const skipN = parseInt(url.searchParams.get('bulk_skip') ?? '', 10);
      const toLbl = { active: 'Đang bán', draft: 'Nháp', archived: 'Lưu trữ' }[url.searchParams.get('bulk_to')];
      const notice = url.searchParams.get('bulk_none') === '1'
        ? 'Chưa chọn sản phẩm nào — hãy tích ô ở cột đầu rồi bấm lại.'
        : (Number.isFinite(okN) && toLbl)
          // KHÔNG khẳng định lý do: `skipped` gộp cả "đã ở trạng thái đó", "không tìm thấy"
          // và "lỗi khi ghi" — nói chắc một lý do là nói sai với 2 trường hợp còn lại.
          ? `Đã chuyển ${okN} sản phẩm sang “${toLbl}”.${skipN > 0 ? ` Bỏ qua ${skipN} sản phẩm (đã ở trạng thái này hoặc không đổi được).` : ''}`
          : null;
      return productsList(res, me, cookie, m[1], url.searchParams, notice);
    }
    if ((m = new RegExp(`^/shops/${UUID}/products/bulk-status$`).exec(p)) && req.method === 'POST') return productsBulkStatus(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/products$`).exec(p)) && req.method === 'POST') return productCreate(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/products/new$`).exec(p)) && req.method === 'GET') return productNew(res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/import/mau.csv$`).exec(p)) && req.method === 'GET') return orderImportSample(res);
    if ((m = new RegExp(`^/shops/${UUID}/orders/import$`).exec(p)) && req.method === 'GET') return orderImportPage(res, me, cookie, m[1], null, null);
    if ((m = new RegExp(`^/shops/${UUID}/orders/import$`).exec(p)) && req.method === 'POST') return orderImport(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/help$`).exec(p)) && req.method === 'GET') return helpPage(res, me, cookie, m[1], url.searchParams.get('sent') ? 'Đã gửi yêu cầu — chúng tôi sẽ liên hệ lại sớm nhất có thể.' : null, null, {});
    if ((m = new RegExp(`^/shops/${UUID}/help$`).exec(p)) && req.method === 'POST') return helpSubmit(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/products/import/mau.csv$`).exec(p)) && req.method === 'GET') return productImportSample(res);
    if ((m = new RegExp(`^/shops/${UUID}/products/import$`).exec(p)) && req.method === 'GET') return productImportPage(res, me, cookie, m[1], null, null);
    if ((m = new RegExp(`^/shops/${UUID}/products/import$`).exec(p)) && req.method === 'POST') return productImport(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/categories$`).exec(p)) && req.method === 'POST') return productCategoriesSave(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/blog$`).exec(p)) && req.method === 'GET') return blogList(res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/blog/new$`).exec(p)) && req.method === 'GET') return blogNew(res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/blog$`).exec(p)) && req.method === 'POST') return blogCreate(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/blog/${UUID}/cover$`).exec(p)) && req.method === 'POST') return blogCoverUpload(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/blog/${UUID}/publish$`).exec(p)) && req.method === 'POST') return blogStatus(res, me, cookie, m[1], m[2], 'publish');
    if ((m = new RegExp(`^/shops/${UUID}/blog/${UUID}/unpublish$`).exec(p)) && req.method === 'POST') return blogStatus(res, me, cookie, m[1], m[2], 'unpublish');
    if ((m = new RegExp(`^/shops/${UUID}/blog/${UUID}/delete$`).exec(p)) && req.method === 'POST') return blogDelete(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/blog/${UUID}$`).exec(p)) && req.method === 'GET') return blogEditor(res, me, cookie, m[1], m[2], null);
    if ((m = new RegExp(`^/shops/${UUID}/blog/${UUID}$`).exec(p)) && req.method === 'POST') return blogUpdate(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/categories$`).exec(p)) && req.method === 'GET') return categoriesPage(res, me, cookie, m[1], null, null);
    if ((m = new RegExp(`^/shops/${UUID}/categories$`).exec(p)) && req.method === 'POST') return categoryCreate(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/categories/${UUID}/delete$`).exec(p)) && req.method === 'POST') return categoryDelete(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/categories/${UUID}/image$`).exec(p)) && req.method === 'POST') return categoryImage(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/categories/${UUID}$`).exec(p)) && req.method === 'POST') return categoryUpdate(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/coupons$`).exec(p)) && req.method === 'GET') return couponsPage(res, me, cookie, m[1], null, null);
    if ((m = new RegExp(`^/shops/${UUID}/coupons$`).exec(p)) && req.method === 'POST') return couponCreate(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/coupons/${UUID}/toggle$`).exec(p)) && req.method === 'POST') return couponToggle(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/coupons/${UUID}/delete$`).exec(p)) && req.method === 'POST') return couponDelete(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/promotions$`).exec(p)) && req.method === 'GET') return promotionsPage(res, me, cookie, m[1], null, null);
    if ((m = new RegExp(`^/shops/${UUID}/promotions$`).exec(p)) && req.method === 'POST') return promotionCreate(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/promotions/${UUID}$`).exec(p)) && req.method === 'GET') return promotionDetailPage(res, me, cookie, m[1], m[2], url.searchParams.get('q'), null);
    if ((m = new RegExp(`^/shops/${UUID}/promotions/${UUID}/end$`).exec(p)) && req.method === 'POST') return promotionEnd(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/promotions/${UUID}/delete$`).exec(p)) && req.method === 'POST') return promotionDelete(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/promotions/${UUID}/products$`).exec(p)) && req.method === 'POST') return promotionAddProduct(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/promotions/${UUID}/products/${UUID}/remove$`).exec(p)) && req.method === 'POST') return promotionRemoveProduct(req, res, me, cookie, m[1], m[2], m[3]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}$`).exec(p)) && req.method === 'GET') {
      const svRaw = url.searchParams.get('saved') ?? '';
      const sv = parseInt(svRaw, 10);
      const st = parseInt(url.searchParams.get('stocked') ?? '', 10);
      // "Lưu tất cả" trả về DANH SÁCH phần đã lưu ("thông tin, 3 biến thể, tồn 2 biến thể")
      // chứ không phải một con số — nói rõ cái gì đã đổi thì người bán mới yên tâm là cú
      // bấm duy nhất đã chạm đủ mọi thứ họ vừa sửa. Cắt độ dài; page vẫn esc() khi render.
      const notice = (Number.isFinite(sv) && sv > 0) ? `Đã lưu ${sv} biến thể.`
        : svRaw ? `✓ Đã lưu: ${svRaw.slice(0, 160)}.`
        : (Number.isFinite(st) && st > 0) ? `Đã cập nhật tồn ${st} biến thể.` : null;
      return productDetail(res, me, cookie, m[1], m[2], undefined, undefined, notice);
    }
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}$`).exec(p)) && req.method === 'POST') return productUpdate(req, res, me, cookie, m[1], m[2]);
    // Một nút "Lưu tất cả" cho cả trang sửa SP. Các endpoint lẻ GIỮ NGUYÊN — trang tạo
    // SP mới và mọi liên kết cũ vẫn dùng chúng.
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/save-all$`).exec(p)) && req.method === 'POST') return productSaveAll(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/(publish|archive)$`).exec(p)) && req.method === 'POST') return productStatus(res, me, cookie, m[1], m[2], m[3]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/delete$`).exec(p)) && req.method === 'POST') return productDelete(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/options$`).exec(p)) && req.method === 'POST') return optionsSave(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/specs$`).exec(p)) && req.method === 'POST') return specsSave(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/variants$`).exec(p)) && req.method === 'POST') return variantAdd(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/variants/bulk$`).exec(p)) && req.method === 'POST') return variantBulkPrice(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/inventory/bulk$`).exec(p)) && req.method === 'POST') return inventoryBulkAdjust(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/variants/${UUID}/price$`).exec(p)) && req.method === 'POST') return variantPrice(req, res, me, cookie, m[1], m[2], m[3]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/variants/${UUID}/delete$`).exec(p)) && req.method === 'POST') return variantDelete(res, me, cookie, m[1], m[2], m[3]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/variants/${UUID}/inventory$`).exec(p)) && req.method === 'POST') return inventoryAdjust(req, res, me, cookie, m[1], m[2], m[3]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/media$`).exec(p)) && req.method === 'POST') return mediaUpload(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/media/${UUID}/delete$`).exec(p)) && req.method === 'POST') return mediaDelete(res, me, cookie, m[1], m[2], m[3]);
    if ((m = new RegExp(`^/shops/${UUID}/products/${UUID}/media/${UUID}/variant$`).exec(p)) && req.method === 'POST') return mediaAssignVariant(req, res, me, cookie, m[1], m[2], m[3]);
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

    // Nhật ký hoạt động.
    if ((m = new RegExp(`^/shops/${UUID}/audit-log$`).exec(p)) && req.method === 'GET') return auditPage(res, me, cookie, m[1], url.searchParams);

    // Nhân sự.
    if ((m = new RegExp(`^/shops/${UUID}/members$`).exec(p)) && req.method === 'GET') return membersList(res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/members/invite$`).exec(p)) && req.method === 'POST') return memberInvite(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/members/step-up$`).exec(p)) && req.method === 'POST') return memberStepUp(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/members/${UUID}/role$`).exec(p)) && req.method === 'POST') return memberRole(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/members/${UUID}/remove$`).exec(p)) && req.method === 'POST') return memberRemove(res, me, cookie, m[1], m[2]);

    // Xuất dữ liệu (owner).
    if ((m = new RegExp(`^/shops/${UUID}/reports$`).exec(p)) && req.method === 'GET') return reportsPage(res, me, cookie, m[1], url.searchParams);
    if ((m = new RegExp(`^/shops/${UUID}/reports/export$`).exec(p)) && req.method === 'POST') return reportsExportCreate(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/reports/export/step-up$`).exec(p)) && req.method === 'POST') return reportsExportStepUp(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/loyalty$`).exec(p)) && req.method === 'GET') return loyaltyPage(res, me, cookie, m[1], url.searchParams.get('notice') === 'saved' ? 'Đã lưu cấu hình điểm thưởng.' : null, null);
    if ((m = new RegExp(`^/shops/${UUID}/loyalty$`).exec(p)) && req.method === 'POST') return loyaltySave(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/loyalty/step-up$`).exec(p)) && req.method === 'POST') return loyaltyStepUp(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/export$`).exec(p)) && req.method === 'GET') return exportPage(res, me, cookie, m[1], null, null);
    if ((m = new RegExp(`^/shops/${UUID}/export$`).exec(p)) && req.method === 'POST') return exportCreate(res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/export/step-up$`).exec(p)) && req.method === 'POST') return exportStepUp(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/export/download$`).exec(p)) && req.method === 'GET') return exportDownload(res, me, cookie, m[1], url.searchParams.get('token') ?? '');

    // Nhập hàng (owner/admin — inventory.manage). Route CỤ THỂ (new/report/edit/receive/order/cancel) TRƯỚC :id.
    if ((m = new RegExp(`^/shops/${UUID}/suppliers$`).exec(p)) && req.method === 'GET') return suppliersPage(res, me, cookie, m[1], url.searchParams, url.searchParams.get('notice') ? 'Đã lưu nhà cung cấp.' : null, null);
    if ((m = new RegExp(`^/shops/${UUID}/suppliers$`).exec(p)) && req.method === 'POST') return supplierCreate(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/suppliers/${UUID}$`).exec(p)) && req.method === 'POST') return supplierUpdate(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/purchasing$`).exec(p)) && req.method === 'GET') return purchasingPage(res, me, cookie, m[1], url.searchParams);
    if ((m = new RegExp(`^/shops/${UUID}/purchasing/new$`).exec(p)) && req.method === 'GET') return poNewPage(res, me, cookie, m[1], null, null, url.searchParams.get('q') ?? '');
    if ((m = new RegExp(`^/shops/${UUID}/purchasing/new$`).exec(p)) && req.method === 'POST') return poNewSubmit(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/purchasing/report$`).exec(p)) && req.method === 'GET') return purchasingReportPage(res, me, cookie, m[1], url.searchParams);
    if ((m = new RegExp(`^/shops/${UUID}/inventory-ledger$`).exec(p)) && req.method === 'GET') return inventoryLedgerPage(res, me, cookie, m[1], url.searchParams);
    if ((m = new RegExp(`^/shops/${UUID}/purchasing/${UUID}/edit$`).exec(p)) && req.method === 'GET') return poEditPage(res, me, cookie, m[1], m[2], null, url.searchParams.get('q') ?? '');
    if ((m = new RegExp(`^/shops/${UUID}/purchasing/${UUID}/edit$`).exec(p)) && req.method === 'POST') return poEditSubmit(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/purchasing/${UUID}/receive$`).exec(p)) && req.method === 'GET') return poReceivePage(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/purchasing/${UUID}/receive$`).exec(p)) && req.method === 'POST') return poReceiveSubmit(res, me, cookie, m[1], m[2]);
    // m[1]=shopId, m[2]=poId, m[3]=action. Bản cũ truyền TRÁO (m[3], m[2]) → dựng URL
    // /purchase-orders/order/<poId> thay vì /purchase-orders/<poId>/order → nút "Đánh dấu
    // đã đặt" và "Huỷ phiếu" LUÔN 404. Không test nào chạm tới nên lỗi sống lâu.
    if ((m = new RegExp(`^/shops/${UUID}/purchasing/${UUID}/(order|cancel)$`).exec(p)) && req.method === 'POST') return poAction(res, me, cookie, m[1], m[2], m[3]);
    if ((m = new RegExp(`^/shops/${UUID}/purchasing/${UUID}$`).exec(p)) && req.method === 'GET') return poDetailPage(res, me, cookie, m[1], m[2], url.searchParams.get('notice') === 'received' ? 'Đã nhận hàng — tồn kho và giá vốn đã cập nhật.' : null, null);
    // Kiểm kê.
    if ((m = new RegExp(`^/shops/${UUID}/stocktakes$`).exec(p)) && req.method === 'GET') return stocktakesPage(res, me, cookie, m[1], null, null);
    if ((m = new RegExp(`^/shops/${UUID}/stocktakes$`).exec(p)) && req.method === 'POST') return stocktakeCreate(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/stocktakes/${UUID}/count$`).exec(p)) && req.method === 'POST') return stocktakeCount(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/stocktakes/${UUID}/complete$`).exec(p)) && req.method === 'POST') return stocktakeComplete(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/stocktakes/${UUID}/cancel$`).exec(p)) && req.method === 'POST') return stocktakeCancel(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/stocktakes/${UUID}$`).exec(p)) && req.method === 'GET') return stocktakeDetailPage(res, me, cookie, m[1], m[2], STOCKTAKE_NOTICE[url.searchParams.get('notice')] ?? null, null);

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

    // Khách hàng (CRM-lite, orders.read/write ở seller).
    if ((m = new RegExp(`^/shops/${UUID}/customers$`).exec(p)) && req.method === 'GET') return customersPage(res, me, cookie, m[1], url.searchParams);
    if ((m = new RegExp(`^/shops/${UUID}/customers/(\\d{8,15})$`).exec(p)) && req.method === 'GET') return customerDetail(res, me, cookie, m[1], m[2], url.searchParams.get('saved') === '1');
    if ((m = new RegExp(`^/shops/${UUID}/customers/(\\d{8,15})/note$`).exec(p)) && req.method === 'POST') return customerNoteSave(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/customers/(\\d{8,15})/erase$`).exec(p)) && req.method === 'POST') return customerErase(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/customers/(\\d{8,15})/erase/step-up$`).exec(p)) && req.method === 'POST') return customerEraseStepUp(req, res, me, cookie, m[1], m[2]);

    // Đánh giá sản phẩm (content.write = owner/admin ở seller).
    if ((m = new RegExp(`^/shops/${UUID}/reviews$`).exec(p)) && req.method === 'GET') return reviewsPage(res, me, cookie, m[1], url.searchParams.get('status'));
    if ((m = new RegExp(`^/shops/${UUID}/reviews/${UUID}/(approve|reject|delete)$`).exec(p)) && req.method === 'POST') return reviewAction(res, me, cookie, m[1], m[2], m[3]);
    if ((m = new RegExp(`^/shops/${UUID}/reviews/${UUID}/reply$`).exec(p)) && req.method === 'POST') return reviewReply(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/reviews/${UUID}/images/${UUID}$`).exec(p)) && req.method === 'GET') return reviewImage(res, me, cookie, m[1], m[2], m[3]);
    if ((m = new RegExp(`^/shops/${UUID}/questions$`).exec(p)) && req.method === 'GET') return questionsPage(res, me, cookie, m[1], url.searchParams.get('status'));
    if ((m = new RegExp(`^/shops/${UUID}/questions/${UUID}/(answer|reject|delete)$`).exec(p)) && req.method === 'POST') return questionAction(req, res, me, cookie, m[1], m[2], m[3]);

    // Đối soát COD với hãng (orders.read xem; ghi phiếu = payment.write = owner ở seller).
    if ((m = new RegExp(`^/shops/${UUID}/cod$`).exec(p)) && req.method === 'GET') {
      const done = url.searchParams.get('done') === '1'
        ? { expected: url.searchParams.get('expected') ?? '0', received: url.searchParams.get('received') ?? '0', disc: url.searchParams.get('disc') ?? '0', count: url.searchParams.get('count') ?? '0' }
        : null;
      return codPage(res, me, cookie, m[1], done, null);
    }
    if ((m = new RegExp(`^/shops/${UUID}/cod/remittances$`).exec(p)) && req.method === 'POST') return codRemittanceSubmit(req, res, me, cookie, m[1]);

    // Thông báo Telegram (shop.write = owner/admin ở seller).
    if ((m = new RegExp(`^/shops/${UUID}/notify$`).exec(p)) && req.method === 'GET') return notifyPage(res, me, cookie, m[1], null, null);
    if ((m = new RegExp(`^/shops/${UUID}/notify/link$`).exec(p)) && req.method === 'POST') return notifyLink(res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/notify/unlink$`).exec(p)) && req.method === 'POST') return notifyUnlink(res, me, cookie, m[1]);

    // Vận chuyển hãng (shop.write = owner/admin + step-up ở seller).
    if ((m = new RegExp(`^/shops/${UUID}/api-keys$`).exec(p)) && req.method === 'GET') return apiKeysPage(res, me, cookie, m[1], null, null, null);
    if ((m = new RegExp(`^/shops/${UUID}/api-keys$`).exec(p)) && req.method === 'POST') return apiKeyCreate(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/api-keys/step-up$`).exec(p)) && req.method === 'POST') return apiKeyStepUp(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/api-keys/${UUID}/revoke$`).exec(p)) && req.method === 'POST') return apiKeyRevoke(res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/shipping$`).exec(p)) && req.method === 'GET') return shippingPage(res, me, cookie, m[1], null, null);
    if ((m = new RegExp(`^/shops/${UUID}/shipping/test$`).exec(p)) && req.method === 'GET') return shippingTest(res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/shipping$`).exec(p)) && req.method === 'POST') return shippingOp(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/shipping/step-up$`).exec(p)) && req.method === 'POST') return shippingStepUp(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/carrier-shipment$`).exec(p)) && req.method === 'POST') return carrierShipment(req, res, me, cookie, m[1], m[2]);
    if ((m = new RegExp(`^/shops/${UUID}/orders/${UUID}/carrier-reconcile$`).exec(p)) && req.method === 'POST') return carrierReconcile(req, res, me, cookie, m[1], m[2]);

    // Cài đặt / hồ sơ cửa hàng (shop.write = owner/admin).
    if ((m = new RegExp(`^/shops/${UUID}/settings$`).exec(p)) && req.method === 'GET') return settingsPage(res, me, cookie, m[1], null, null);
    if ((m = new RegExp(`^/shops/${UUID}/settings$`).exec(p)) && req.method === 'POST') return settingsSave(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/settings/require-mfa$`).exec(p)) && req.method === 'POST') return requireMfaSave(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/settings/unused-images$`).exec(p)) && req.method === 'POST') return unusedImagesScan(res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/settings/unused-images/delete$`).exec(p)) && req.method === 'POST') return unusedImagesDelete(res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/logo$`).exec(p)) && req.method === 'POST') return logoUpload(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/logo/remove$`).exec(p)) && req.method === 'POST') return logoRemove(res, me, cookie, m[1]);

    // Giao diện (theme.write = owner/admin).
    if ((m = new RegExp(`^/shops/${UUID}/theme$`).exec(p)) && req.method === 'GET') return themePage(res, me, cookie, m[1], url.searchParams.get('ok'), url.searchParams.get('applied'));
    if ((m = new RegExp(`^/shops/${UUID}/theme$`).exec(p)) && req.method === 'POST') return themeSave(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/theme/preset$`).exec(p)) && req.method === 'GET') return presetConfirmPage(res, me, cookie, m[1], url.searchParams.get('preset'));
    if ((m = new RegExp(`^/shops/${UUID}/theme/preset$`).exec(p)) && req.method === 'POST') return applyPreset(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/theme/banner$`).exec(p)) && req.method === 'POST') return bannerSave(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/theme/promos$`).exec(p)) && req.method === 'POST') return promoSave(req, res, me, cookie, m[1]);
    if ((m = new RegExp(`^/shops/${UUID}/theme/hero-side$`).exec(p)) && req.method === 'POST') return heroSideSave(req, res, me, cookie, m[1]);

    return sendHtml(res, 404, V.renderError({ user: me }, 'Không tìm thấy trang.'));
}

// Phông Be Vietnam Pro (OFL) tự-host — /fonts/*.woff2 same-origin (CSP font-src 'self').
const FONTS = (() => {
  const dir = new URL('./fonts/', import.meta.url);
  const m = new Map();
  try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.woff2')) m.set(f, fs.readFileSync(new URL(f, dir))); } catch {}
  return m;
})();

const server = http.createServer((req, res) => runReq(req, res, async () => {
  const url = new URL(req.url, 'http://internal');
  const p = url.pathname;
  if (await health(url.pathname, res, {})) return;
  if (p.startsWith('/fonts/')) {
    const buf = FONTS.get(p.slice(7));
    if (buf) { res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' }); return res.end(buf); }
    res.writeHead(404); return res.end();
  }
  // /favicon.ico: trả 204 sớm — khỏi chạy router + render 404 HTML cho icon.
  if (p === '/favicon.ico') {
    res.writeHead(204, { 'cache-control': 'public, max-age=86400' }); return res.end();
  }
  try {
    await handle(req, res, url, p);
  } catch (err) {
    log('error', 'handler_error', { path: p, message: err.message });
    if (!res.headersSent) sendHtml(res, 500, V.renderError({}, 'Lỗi hệ thống, vui lòng thử lại.'));
  }
}));

server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT }));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
