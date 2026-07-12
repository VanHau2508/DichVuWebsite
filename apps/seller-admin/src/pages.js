/**
 * Trang HTML admin (SSR form thuần, không JS). MỌI dữ liệu đều esc() → chống XSS.
 * CSP không cho script; thao tác nhạy cảm/đổi trạng thái đều là POST form + sameOrigin.
 */
import { esc } from './http.js';

const money = (v) => new Intl.NumberFormat('vi-VN').format(Number(v)) + '₫';
const dt = (s) => { try { return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(s)); } catch { return esc(s); } };
const STATUS = { pending: 'Chờ xử lý', confirmed: 'Đã xác nhận', shipped: 'Đang giao', delivered: 'Đã giao', cancelled: 'Đã huỷ', refunded: 'Đã hoàn' };
const PAY = { unpaid: 'Chưa trả', paid: 'Đã trả' };

const STYLE = `*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#111827;background:#f3f4f6;line-height:1.5}
a{color:#2563eb;text-decoration:none}.top{background:#111827;color:#fff}.top .in{max-width:920px;margin:0 auto;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;gap:12px}
.top a{color:#fff}.top .brand{font-weight:700}.top form{display:inline}.top button{background:transparent;color:#d1d5db;border:0;cursor:pointer;font:inherit}
.wrap{max-width:920px;margin:0 auto;padding:16px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin:12px 0}
h1{font-size:1.35rem}h2{font-size:1.05rem;margin:1em 0 .4em}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid #f0f0f0;font-size:.92rem}
th{color:#6b7280;font-weight:600}tr:hover td{background:#fafafa}
.btn{display:inline-block;background:#111827;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:.95rem;font-weight:600;cursor:pointer;text-decoration:none}
.btn.alt{background:#fff;color:#111827;border:1px solid #d1d5db}.btn.warn{background:#fff;color:#b91c1c;border:1px solid #fca5a5}.btn.sm{padding:7px 12px;font-size:.9rem}
label{display:block;font-size:.9rem;margin:10px 0 4px;font-weight:600}
input,select,textarea{width:100%;padding:11px;border:1px solid #d1d5db;border-radius:8px;font-size:1rem;font-family:inherit}
textarea{min-height:76px;resize:vertical}
.center{max-width:380px;margin:48px auto}.err{background:#fef2f2;border:1px solid #fca5a5;color:#b91c1c;border-radius:8px;padding:10px;margin:8px 0}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:.82rem;font-weight:600;background:#e5e7eb;color:#374151}
.badge.pending{background:#fef3c7;color:#92400e}.badge.confirmed{background:#dbeafe;color:#1e40af}.badge.shipped{background:#e0e7ff;color:#3730a3}
.badge.delivered{background:#d1fae5;color:#065f46}.badge.cancelled{background:#fee2e2;color:#991b1b}.badge.paid{background:#d1fae5;color:#065f46}.badge.unpaid{background:#f3f4f6;color:#6b7280}
.muted{color:#6b7280}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.filters{display:flex;gap:8px;align-items:end;flex-wrap:wrap}.filters>div{flex:0 0 auto}
.pill{display:inline-block;margin-right:6px}nav.tabs{margin:2px 0 14px;border-bottom:1px solid #e5e7eb;display:flex;gap:6px}
nav.tabs a{margin-right:8px;padding:8px 2px;color:#6b7280}nav.tabs a.on{border-bottom:2px solid #111827;font-weight:600;color:#111827}
.badge.active{background:#d1fae5;color:#065f46}.badge.draft{background:#fef3c7;color:#92400e}.badge.archived{background:#e5e7eb;color:#4b5563}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}@media(max-width:560px){.grid2{grid-template-columns:1fr}}
.inline{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}.inline input{width:auto}
.num{font-variant-numeric:tabular-nums}.toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:6px}
.stock{font-weight:600}.stock.low{color:#b45309}.stock.zero{color:#b91c1c}
input[type=file]{width:auto;padding:8px;background:#f9fafb;border:1px dashed #cbd5e1}
.media-grid{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.thumb{margin:0;width:120px}.thumb img{width:120px;height:120px;object-fit:cover;border-radius:8px;border:1px solid #e5e7eb;display:block}
.thumb .ph{width:120px;height:120px;border-radius:8px;border:1px dashed #cbd5e1;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:.82rem;background:#f9fafb;text-align:center}
.thumb .prim{font-size:.72rem;text-align:center;color:#065f46;font-weight:600;margin-top:3px}
.thumb-act{display:flex;gap:3px;justify-content:center;flex-wrap:wrap;margin-top:4px}.thumb-act form{margin:0}
.thumb-act .btn.sm{padding:4px 7px;font-size:.8rem}
.badge.published{background:#d1fae5;color:#065f46}
.block{border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin:8px 0;background:#fafafa}
.block textarea{background:#fff}code{background:#f3f4f6;padding:2px 5px;border-radius:4px;font-size:.85rem}`;

const badge = (kind, label) => `<span class="badge ${esc(kind)}">${esc(label)}</span>`;
// Vai trò nào thấy tab nào (backend mới là nơi cưỡng chế; đây chỉ để ẩn/hiện cho gọn).
const CATALOG_ROLES = new Set(['owner', 'admin', 'catalog_manager']);
const ORDER_ROLES = new Set(['owner', 'admin', 'order_manager']);
const CONTENT_ROLES = new Set(['owner', 'admin']);
const MEMBER_READ_ROLES = new Set(['owner', 'admin']); // xem nhân sự; SỬA chỉ owner (seller cưỡng chế)
const EXPORT_ROLES = new Set(['owner']); // xuất dữ liệu: CHỈ chủ shop (seller cưỡng chế perm 'export')
const ROLE_LABEL = { owner: 'Chủ shop', admin: 'Quản trị', catalog_manager: 'Quản lý sản phẩm', order_manager: 'Quản lý đơn' };
const INVITE_ROLES = ['admin', 'catalog_manager', 'order_manager']; // KHÔNG mời owner qua đây
const PSTATUS = { draft: 'Nháp', active: 'Đang bán', archived: 'Lưu trữ' };
const PGSTATUS = { draft: 'Nháp', published: 'Đã đăng' };
const BTYPE = { heading: 'Tiêu đề', paragraph: 'Đoạn văn', list: 'Danh sách', quote: 'Trích dẫn', divider: 'Đường kẻ' };

// Tab điều hướng trong 1 shop (Đơn hàng / Sản phẩm) — chỉ hiện tab vai trò được phép.
function shopTabs(ctx) {
  if (!ctx.shopId) return '';
  const base = `/shops/${esc(ctx.shopId)}`;
  const tab = (href, label, on, show) => (show ? `<a href="${href}"${on ? ' class="on"' : ''}>${label}</a>` : '');
  const t = tab(`${base}/orders`, 'Đơn hàng', ctx.active === 'orders', ORDER_ROLES.has(ctx.role))
          + tab(`${base}/products`, 'Sản phẩm', ctx.active === 'products', CATALOG_ROLES.has(ctx.role))
          + tab(`${base}/pages`, 'Trang nội dung', ctx.active === 'pages', CONTENT_ROLES.has(ctx.role))
          + tab(`${base}/members`, 'Nhân sự', ctx.active === 'members', MEMBER_READ_ROLES.has(ctx.role))
          + tab(`${base}/export`, 'Xuất dữ liệu', ctx.active === 'export', EXPORT_ROLES.has(ctx.role));
  return t ? `<nav class="tabs">${t}</nav>` : '';
}

export function layout(title, ctx, body) {
  const top = ctx.user ? `<div class="top"><div class="in">
    <span><a class="brand" href="/">⚙ Quản trị</a>${ctx.shopName ? ` · ${esc(ctx.shopName)}` : ''}</span>
    <span class="muted" style="color:#9ca3af"><a href="/account" style="color:#d1d5db" title="Tài khoản">${esc(ctx.user.email)}</a>
      <form method="POST" action="/logout" style="margin-left:10px"><button type="submit">Đăng xuất</button></form></span>
  </div></div>` : '';
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${top}<main class="wrap">${shopTabs(ctx)}${body}</main></body></html>`;
}

export function renderLogin(err) {
  return layout('Đăng nhập', {}, `<div class="center"><div class="card"><h1>Đăng nhập quản trị</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="/login">
      <label>Email</label><input name="email" type="email" required autocomplete="username">
      <label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">
      <button class="btn" type="submit" style="width:100%;margin-top:14px">Đăng nhập</button>
    </form></div></div>`);
}

export function renderMfa(err) {
  return layout('Xác thực 2 lớp', {}, `<div class="center"><div class="card"><h1>Mã xác thực (MFA)</h1>
    <p class="muted">Nhập mã 6 số từ ứng dụng xác thực.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="/mfa">
      <label>Mã</label><input name="code" inputmode="numeric" autocomplete="one-time-code" required placeholder="123456">
      <button class="btn" type="submit" style="width:100%;margin-top:14px">Xác nhận</button>
    </form></div></div>`);
}

export function renderDashboard(ctx, shops) {
  return layout('Bảng điều khiển', ctx, `<h1>Cửa hàng của bạn</h1>
    ${shops.length ? shops.map((s) => `<div class="card">
      <h2 style="margin:0">${esc(s.name || s.shop_id)}</h2>
      <p class="muted">Vai trò: ${esc(s.role)}${s.status && s.status !== 'active' ? ` · <strong>${esc(s.status)}</strong>` : ''}</p>
      <div class="actions">
        ${ORDER_ROLES.has(s.role) ? `<a class="btn" href="/shops/${esc(s.shop_id)}/orders">Quản lý đơn hàng</a>` : ''}
        ${CATALOG_ROLES.has(s.role) ? `<a class="btn alt" href="/shops/${esc(s.shop_id)}/products">Quản lý sản phẩm</a>` : ''}
        ${CONTENT_ROLES.has(s.role) ? `<a class="btn alt" href="/shops/${esc(s.shop_id)}/pages">Trang nội dung</a>` : ''}
        ${MEMBER_READ_ROLES.has(s.role) ? `<a class="btn alt" href="/shops/${esc(s.shop_id)}/members">Nhân sự</a>` : ''}
      </div>
    </div>`).join('') : `<div class="card"><p class="muted">Bạn chưa thuộc cửa hàng nào.</p></div>`}`);
}

const STATUSES = ['', 'pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];
export function renderOrders(ctx, shopId, data, filter) {
  const orders = data.orders ?? [];
  const rows = orders.map((o) => `<tr>
    <td><a href="/shops/${esc(shopId)}/orders/${esc(o.id)}">#${esc(o.order_number)}</a></td>
    <td>${badge(o.status, STATUS[o.status] ?? o.status)}</td>
    <td>${badge(o.payment_status, PAY[o.payment_status] ?? o.payment_status)} <span class="muted">${esc(o.payment_method?.toUpperCase() ?? '')}</span></td>
    <td>${esc(o.customer_name)}</td>
    <td class="muted">${dt(o.created_at)}</td>
    <td style="text-align:right"><strong>${money(o.total_vnd)}</strong></td></tr>`).join('');
  const total = data.total ?? orders.length;
  const off = filter.offset, lim = filter.limit;
  return layout('Đơn hàng', ctx, `<h1>Đơn hàng</h1>
    <div class="card"><form method="GET" class="filters">
      <div><label>Trạng thái</label><select name="status">${STATUSES.map((s) => `<option value="${s}"${s === filter.status ? ' selected' : ''}>${s ? (STATUS[s] ?? s) : 'Tất cả'}</option>`).join('')}</select></div>
      <div><button class="btn alt sm" type="submit">Lọc</button></div>
    </form></div>
    <div class="card">${orders.length ? `<table><thead><tr><th>Đơn</th><th>Trạng thái</th><th>Thanh toán</th><th>Khách</th><th>Thời gian</th><th style="text-align:right">Tổng</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="muted" style="margin-top:12px">${total} đơn ·
        ${off > 0 ? `<a href="?status=${esc(filter.status)}&offset=${Math.max(0, off - lim)}">← Trước</a>` : '<span style="color:#d1d5db">← Trước</span>'} ·
        ${off + lim < total ? `<a href="?status=${esc(filter.status)}&offset=${off + lim}">Sau →</a>` : '<span style="color:#d1d5db">Sau →</span>'}
      </div>` : '<p class="muted">Không có đơn nào.</p>'}</div>
    <a class="btn alt" href="/">← Về bảng điều khiển</a>`);
}

export function renderOrderDetail(ctx, shopId, o, err) {
  const act = (path, label, cls = 'btn sm', extra = '') => `<form method="POST" action="/shops/${esc(shopId)}/orders/${esc(o.id)}/${path}">${extra}<button class="${cls}" type="submit">${label}</button></form>`;
  let actions = '';
  if (o.status === 'pending') actions = act('confirm', 'Xác nhận đơn') + act('cancel', 'Huỷ đơn', 'btn warn sm');
  else if (o.status === 'confirmed') actions = `<form method="POST" action="/shops/${esc(shopId)}/orders/${esc(o.id)}/ship" class="actions" style="align-items:end">
      <div><label>Mã vận đơn</label><input name="tracking_number" required maxlength="64" style="width:180px"></div>
      <div><label>Đơn vị VC</label><input name="carrier" maxlength="40" style="width:120px" placeholder="GHN..."></div>
      <button class="btn sm" type="submit">Giao hàng</button></form>` + act('cancel', 'Huỷ đơn', 'btn warn sm');
  else if (o.status === 'shipped') actions = act('deliver', 'Đã giao xong');
  // Đơn COD chưa thu tiền → nút "Đã nhận tiền" (độc lập với trạng thái giao hàng).
  // Đơn QR do webhook đối soát tự đặt paid — KHÔNG hiện nút thủ công.
  const payAction = (o.payment_method === 'cod' && o.payment_status !== 'paid') ? act('mark-paid', 'Đã nhận tiền (COD)') : '';
  return layout(`Đơn #${o.order_number}`, ctx, `
    <a class="muted" href="/shops/${esc(shopId)}/orders">← Danh sách đơn</a>
    <h1>Đơn hàng #${esc(o.order_number)}</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <div class="card"><span class="pill">${badge(o.status, STATUS[o.status] ?? o.status)}</span>
      <span class="pill">${badge(o.payment_status, PAY[o.payment_status] ?? o.payment_status)} ${esc(o.payment_method?.toUpperCase() ?? '')}</span>
      <div class="actions">${(actions + payAction) || '<span class="muted">Không có thao tác.</span>'}</div></div>
    <div class="card"><h2>Sản phẩm</h2><table><tbody>
      ${(o.lines ?? []).map((l) => `<tr><td>${esc(l.title_snapshot)} <span class="muted">${esc(l.sku_snapshot ?? '')}</span></td><td class="muted">${money(l.unit_price_vnd)} × ${esc(l.qty)}</td><td style="text-align:right">${money(Number(l.unit_price_vnd) * l.qty)}</td></tr>`).join('')}
    </tbody></table>
      <div style="text-align:right;margin-top:8px" class="muted">Tạm tính ${money(o.subtotal_vnd)} · Ship ${money(o.shipping_vnd)}</div>
      <div style="text-align:right;font-weight:700;font-size:1.1rem">Tổng ${money(o.total_vnd)}</div></div>
    <div class="card"><h2>Khách hàng</h2>
      <p>${esc(o.customer_name)} · ${esc(o.customer_phone ?? '')}${o.customer_email ? ` · ${esc(o.customer_email)}` : ''}</p>
      ${o.shipping_address ? `<p class="muted">${esc(typeof o.shipping_address === 'object' ? (o.shipping_address.line ?? JSON.stringify(o.shipping_address)) : o.shipping_address)}</p>` : ''}
      ${(o.shipments ?? []).map((s) => `<p class="muted">Vận đơn: <strong>${esc(s.tracking_number)}</strong> ${esc(s.carrier ?? '')} (${esc(s.status)})</p>`).join('')}
      <p class="muted">Tạo: ${dt(o.created_at)}</p></div>`);
}

// ── Sản phẩm & tồn kho ───────────────────────────────────────────────────────
const PSTATUSES = ['', 'active', 'draft', 'archived'];
export function renderProducts(ctx, shopId, data, filter) {
  const d = data ?? {}; // backend có thể trả 200 body rỗng → data null; đừng để .products nổ
  const products = d.products ?? [];
  const q = encodeURIComponent(filter.q ?? '');
  const total = d.total ?? products.length;
  const off = filter.offset, lim = filter.limit;
  const nav = (o) => `?q=${q}&status=${esc(filter.status)}&offset=${o}`;
  const rows = products.map((p) => `<tr>
    <td><a href="/shops/${esc(shopId)}/products/${esc(p.id)}">${esc(p.title)}</a><div class="muted" style="font-size:.8rem">${esc(p.slug)}</div></td>
    <td>${badge(p.status, PSTATUS[p.status] ?? p.status)}</td>
    <td class="num right">${money(p.price_vnd)}</td>
    <td class="num right">${p.variant_count}</td>
    <td class="muted">${dt(p.created_at)}</td></tr>`).join('');
  return layout('Sản phẩm', ctx, `
    <div class="toolbar"><h1 style="margin:0">Sản phẩm</h1>
      <a class="btn" href="/shops/${esc(shopId)}/products/new">+ Thêm sản phẩm</a></div>
    <div class="card"><form method="GET" class="filters">
      <div style="flex:1 1 200px"><label>Tìm theo tên</label><input name="q" value="${esc(filter.q ?? '')}" placeholder="Ghế sofa…"></div>
      <div><label>Trạng thái</label><select name="status">${PSTATUSES.map((s) => `<option value="${s}"${s === filter.status ? ' selected' : ''}>${s ? (PSTATUS[s] ?? s) : 'Tất cả'}</option>`).join('')}</select></div>
      <div><button class="btn alt sm" type="submit">Lọc</button></div>
    </form></div>
    <div class="card">${products.length ? `<table><thead><tr><th>Sản phẩm</th><th>Trạng thái</th><th class="right">Giá</th><th class="right">Biến thể</th><th>Tạo</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="muted" style="margin-top:12px">${total} sản phẩm ·
        ${off > 0 ? `<a href="${nav(Math.max(0, off - lim))}">← Trước</a>` : '<span style="color:#d1d5db">← Trước</span>'} ·
        ${off + lim < total ? `<a href="${nav(off + lim)}">Sau →</a>` : '<span style="color:#d1d5db">Sau →</span>'}
      </div>` : '<p class="muted">Chưa có sản phẩm. Bấm “+ Thêm sản phẩm” để tạo.</p>'}</div>`);
}

export function renderProductNew(ctx, shopId, err, f = {}) {
  return layout('Thêm sản phẩm', ctx, `
    <a class="muted" href="/shops/${esc(shopId)}/products">← Danh sách sản phẩm</a>
    <h1>Thêm sản phẩm</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="/shops/${esc(shopId)}/products">
      <div class="card"><h2 style="margin-top:0">Thông tin</h2>
        <label>Tên sản phẩm *</label><input name="title" required maxlength="200" value="${esc(f.title ?? '')}">
        <label>Đường dẫn (slug) *</label><input name="slug" required pattern="[a-z0-9][a-z0-9-]*" maxlength="60" value="${esc(f.slug ?? '')}" placeholder="ghe-sofa-3-cho">
        <div class="grid2">
          <div><label>Giá (VND) *</label><input name="price_vnd" type="number" min="0" step="1000" required value="${esc(f.price_vnd ?? '')}"></div>
          <div><label>Trạng thái</label><select name="status"><option value="draft"${f.status !== 'active' ? ' selected' : ''}>Nháp</option><option value="active"${f.status === 'active' ? ' selected' : ''}>Đăng bán ngay</option></select></div>
        </div>
        <label>Mô tả</label><textarea name="description" maxlength="5000">${esc(f.description ?? '')}</textarea>
      </div>
      <div class="card"><h2 style="margin-top:0">Biến thể đầu tiên</h2>
        <p class="muted">Mỗi sản phẩm cần ít nhất 1 biến thể. Thêm biến thể khác sau khi tạo.</p>
        <div class="grid2">
          <div><label>Mã SKU *</label><input name="sku" required maxlength="64" value="${esc(f.sku ?? '')}" placeholder="GHE-SOFA-01"></div>
          <div><label>Giá biến thể (VND) *</label><input name="variant_price_vnd" type="number" min="0" step="1000" required value="${esc(f.variant_price_vnd ?? f.price_vnd ?? '')}"></div>
        </div>
      </div>
      <button class="btn" type="submit">Tạo sản phẩm</button>
    </form>`);
}

export function renderProductDetail(ctx, shopId, p, levels, err, form, media) {
  const base = `/shops/${esc(shopId)}/products/${esc(p.id)}`;
  const f = form ?? {}; // khi lưu lỗi: ưu tiên giá trị vừa nhập để không nuốt sửa đổi
  const val = (k) => esc(f[k] ?? p[k] ?? '');
  const imgs = media ?? [];
  const thumb = (m, i) => `<figure class="thumb">
    ${m.status === 'ready' && m.url ? `<img src="${esc(m.url)}" alt="Ảnh sản phẩm" loading="lazy" width="120" height="120">` : `<div class="ph">${esc(m.status === 'failed' ? 'lỗi xử lý' : 'đang xử lý…')}</div>`}
    ${i === 0 && m.status === 'ready' ? '<div class="prim">★ Ảnh chính</div>' : ''}
    <div class="thumb-act">
      ${i > 0 ? `<form method="POST" action="${base}/media/${esc(m.id)}/moveup"><button class="btn alt sm" type="submit" title="Sang trái">←</button></form>` : ''}
      ${i < imgs.length - 1 ? `<form method="POST" action="${base}/media/${esc(m.id)}/movedown"><button class="btn alt sm" type="submit" title="Sang phải">→</button></form>` : ''}
      ${i > 0 ? `<form method="POST" action="${base}/media/${esc(m.id)}/primary"><button class="btn alt sm" type="submit" title="Đặt làm ảnh chính">★</button></form>` : ''}
      <form method="POST" action="${base}/media/${esc(m.id)}/delete"><button class="btn warn sm" type="submit" title="Xoá">✕</button></form>
    </div>
  </figure>`;
  const statusBtn = p.status === 'active'
    ? `<form method="POST" action="${base}/archive"><button class="btn alt sm" type="submit">Ẩn (lưu trữ)</button></form>`
    : `<form method="POST" action="${base}/publish"><button class="btn sm" type="submit">${p.status === 'draft' ? 'Đăng bán' : 'Đăng bán lại'}</button></form>`;
  const canDel = (p.variants?.length ?? 0) > 1;
  const stock = (vid) => {
    const l = levels[vid];
    if (!l) return '<span class="muted" title="Chưa tải được tồn kho">—</span>'; // "chưa biết" ≠ "hết hàng"
    const cls = l.available <= 0 ? 'zero' : (l.available < 5 ? 'low' : '');
    return `<span class="stock ${cls} num">${l.available}</span> <span class="muted num" style="font-size:.82rem">(tồn ${l.on_hand} · giữ ${l.reserved})</span>`;
  };
  const rows = (p.variants ?? []).map((v) => `<tr>
    <td>${esc(v.sku)}${v.title ? ` <span class="muted">${esc(v.title)}</span>` : ''}</td>
    <td class="num right">${money(v.price_vnd)}</td>
    <td>${stock(v.id)}</td>
    <td><form method="POST" action="${base}/variants/${esc(v.id)}/inventory" class="inline">
      <input name="delta" type="number" step="1" required placeholder="+/−" style="width:84px" aria-label="Điều chỉnh tồn">
      <input name="reason" maxlength="200" placeholder="lý do" style="width:120px">
      <button class="btn alt sm" type="submit">Cập nhật</button></form></td>
    <td class="right">${canDel ? `<form method="POST" action="${base}/variants/${esc(v.id)}/delete"><button class="btn warn sm" type="submit">Xoá</button></form>` : ''}</td>
  </tr>`).join('');
  return layout(`SP: ${p.title}`, ctx, `
    <a class="muted" href="/shops/${esc(shopId)}/products">← Danh sách sản phẩm</a>
    <div class="toolbar"><h1 style="margin:0">${esc(p.title)}</h1>${badge(p.status, PSTATUS[p.status] ?? p.status)}</div>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <div class="card"><div class="toolbar"><h2 style="margin:0">Thông tin</h2><div class="actions">${statusBtn}</div></div>
      <form method="POST" action="${base}">
        <label>Tên sản phẩm</label><input name="title" required maxlength="200" value="${val('title')}">
        <div class="grid2">
          <div><label>Đường dẫn (slug)</label><input name="slug" required pattern="[a-z0-9][a-z0-9-]*" maxlength="60" value="${val('slug')}"></div>
          <div><label>Giá (VND)</label><input name="price_vnd" type="number" min="0" step="1000" required value="${val('price_vnd')}"></div>
        </div>
        <label>Mô tả</label><textarea name="description" maxlength="5000">${val('description')}</textarea>
        <button class="btn" type="submit" style="margin-top:12px">Lưu thay đổi</button>
      </form>
    </div>
    <div class="card"><h2 style="margin-top:0">Biến thể & tồn kho</h2>
      <table><thead><tr><th>SKU</th><th class="right">Giá</th><th>Có thể bán</th><th>Điều chỉnh tồn</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <h2>Thêm biến thể</h2>
      <form method="POST" action="${base}/variants" class="inline">
        <div><label>SKU</label><input name="sku" required maxlength="64" style="width:160px"></div>
        <div><label>Giá (VND)</label><input name="price_vnd" type="number" min="0" step="1000" required style="width:140px"></div>
        <button class="btn alt sm" type="submit">Thêm biến thể</button>
      </form>
    </div>
    <div class="card"><h2 style="margin-top:0">Hình ảnh</h2>
      ${imgs.length ? `<div class="media-grid">${imgs.map((m, i) => thumb(m, i)).join('')}</div>` : '<p class="muted">Chưa có ảnh nào.</p>'}
      <form method="POST" enctype="multipart/form-data" action="${base}/media" class="inline">
        <input type="file" name="image" accept="image/jpeg,image/png,image/webp,image/gif" required aria-label="Chọn ảnh">
        <button class="btn alt sm" type="submit">Tải ảnh lên</button>
      </form>
      <p class="muted" style="font-size:.82rem">JPEG / PNG / WebP / GIF, tối đa 10MB. Ảnh gốc được nén lại thành WebP tự động.</p>
    </div>
    <div class="card"><h2 style="margin-top:0">Xoá sản phẩm</h2>
      <p class="muted">Ẩn sản phẩm khỏi cửa hàng (xoá mềm). Đơn hàng cũ không bị ảnh hưởng.</p>
      <form method="POST" action="${base}/delete"><button class="btn warn sm" type="submit">Xoá sản phẩm</button></form>
    </div>`);
}

// ── Trang nội dung (versioned: draft → publish snapshot) ─────────────────────
export function renderContentPages(ctx, shopId, data) {
  const pages = data?.pages ?? [];
  const rows = pages.map((p) => `<tr>
    <td><a href="/shops/${esc(shopId)}/pages/${esc(p.id)}">${esc(p.title)}</a><div class="muted" style="font-size:.8rem">/${esc(p.slug)}</div></td>
    <td>${badge(p.status, PGSTATUS[p.status] ?? p.status)}</td>
    <td class="num right">${p.menu_position ?? '—'}</td>
    <td class="muted">${dt(p.updated_at)}</td></tr>`).join('');
  return layout('Trang nội dung', ctx, `
    <div class="toolbar"><h1 style="margin:0">Trang nội dung</h1>
      <a class="btn" href="/shops/${esc(shopId)}/pages/new">+ Thêm trang</a></div>
    <div class="card">${pages.length ? `<table><thead><tr><th>Trang</th><th>Trạng thái</th><th class="right">Vị trí menu</th><th>Cập nhật</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="muted">Chưa có trang nào. Tạo “Giới thiệu”, “Chính sách đổi trả”… bằng nút “+ Thêm trang”.</p>'}</div>`);
}

export function renderPageNew(ctx, shopId, err, f = {}) {
  return layout('Thêm trang', ctx, `
    <a class="muted" href="/shops/${esc(shopId)}/pages">← Danh sách trang</a>
    <h1>Thêm trang nội dung</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="/shops/${esc(shopId)}/pages">
      <div class="card">
        <label>Tiêu đề *</label><input name="title" required maxlength="200" value="${esc(f.title ?? '')}" placeholder="Giới thiệu">
        <label>Đường dẫn (slug) *</label><input name="slug" required pattern="[a-z0-9][a-z0-9-]*" maxlength="60" value="${esc(f.slug ?? '')}" placeholder="gioi-thieu">
        <label>SEO title</label><input name="seo_title" maxlength="120" value="${esc(f.seo_title ?? '')}">
        <label>SEO description</label><textarea name="seo_description" maxlength="320">${esc(f.seo_description ?? '')}</textarea>
      </div>
      <button class="btn" type="submit">Tạo trang (nháp)</button>
      <p class="muted" style="font-size:.85rem">Tạo xong sẽ vào trình sửa: thêm section (tiêu đề, đoạn văn, danh sách…) rồi bấm Đăng.</p>
    </form>`);
}

export function renderPageEditor(ctx, shopId, p, err, notice, form) {
  const base = `/shops/${esc(shopId)}/pages/${esc(p.id)}`;
  const blocks = p.blocks ?? [];
  const revs = p.revisions ?? [];
  const f = form ?? {}; // khi lưu meta lỗi: ưu tiên giá trị vừa nhập, không revert về DB
  const mval = (k) => esc(f[k] ?? p[k] ?? '');
  const blockEdit = (b) => {
    if (b.type === 'divider') return '<p class="muted" style="margin:4px 0">— đường kẻ ngang —</p>';
    const hid = `<input type="hidden" name="type" value="${esc(b.type)}">`;
    if (b.type === 'list') return `<form method="POST" action="${base}/blocks/${esc(b.id)}/edit">${hid}
      <textarea name="text" rows="4" maxlength="5000" placeholder="mỗi dòng 1 mục">${esc((b.items ?? []).join('\n'))}</textarea>
      <button class="btn alt sm" type="submit">Lưu section</button></form>`;
    if (b.type === 'quote') return `<form method="POST" action="${base}/blocks/${esc(b.id)}/edit">${hid}
      <textarea name="text" rows="2" maxlength="5000">${esc(b.text ?? '')}</textarea>
      <input name="cite" placeholder="Nguồn trích (tuỳ chọn)" maxlength="200" value="${esc(b.cite ?? '')}">
      <button class="btn alt sm" type="submit">Lưu section</button></form>`;
    return `<form method="POST" action="${base}/blocks/${esc(b.id)}/edit">${hid}
      <textarea name="text" rows="${b.type === 'heading' ? 1 : 3}" maxlength="5000">${esc(b.text ?? '')}</textarea>
      <button class="btn alt sm" type="submit">Lưu section</button></form>`;
  };
  const blockCard = (b, i) => `<div class="block">
    <div class="toolbar" style="margin-bottom:6px"><span class="badge">${esc(BTYPE[b.type] ?? b.type)}</span>
      <div class="actions">
        ${i > 0 ? `<form method="POST" action="${base}/blocks/${esc(b.id)}/moveup"><button class="btn alt sm" type="submit" title="Lên">↑</button></form>` : ''}
        ${i < blocks.length - 1 ? `<form method="POST" action="${base}/blocks/${esc(b.id)}/movedown"><button class="btn alt sm" type="submit" title="Xuống">↓</button></form>` : ''}
        <form method="POST" action="${base}/blocks/${esc(b.id)}/delete"><button class="btn warn sm" type="submit">Xoá</button></form>
      </div></div>
    ${blockEdit(b)}</div>`;
  return layout(`Sửa: ${p.title}`, ctx, `
    <a class="muted" href="/shops/${esc(shopId)}/pages">← Danh sách trang</a>
    <div class="toolbar"><h1 style="margin:0">${esc(p.title)}</h1>${badge(p.status, PGSTATUS[p.status] ?? p.status)}</div>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice?.preview ? `<div class="card" style="background:#ecfdf5;border-color:#a7f3d0"><strong>Link xem trước</strong> (sống ~${Math.round((notice.preview.expires_in ?? 1800) / 60)} phút):<br>
      <code style="word-break:break-all">${esc(notice.preview.preview_url ?? notice.preview.path)}</code></div>` : ''}
    <div class="card"><div class="toolbar"><h2 style="margin:0">Thông tin & xuất bản</h2>
      <div class="actions">
        <form method="POST" action="${base}/preview"><button class="btn alt sm" type="submit">Xem trước</button></form>
        <form method="POST" action="${base}/publish"><button class="btn sm" type="submit">${p.status === 'published' ? 'Đăng lại' : 'Đăng trang'}</button></form>
      </div></div>
      ${p.published_revision ? `<p class="muted">Đang đăng: bản #${p.published_revision}. Sửa bên dưới chỉ đổi bản NHÁP tới khi bấm Đăng.</p>` : '<p class="muted">Chưa đăng bao giờ — storefront chưa thấy trang này.</p>'}
      <form method="POST" action="${base}">
        <label>Tiêu đề</label><input name="title" required maxlength="200" value="${mval('title')}">
        <div class="grid2">
          <div><label>Đường dẫn (slug)</label><input value="/${esc(p.slug)}" disabled></div>
          <div><label>Vị trí menu (trống = ẩn khỏi menu)</label><input name="menu_position" type="number" value="${mval('menu_position')}"></div>
        </div>
        <label>SEO title</label><input name="seo_title" maxlength="120" value="${mval('seo_title')}">
        <label>SEO description</label><textarea name="seo_description" maxlength="320">${mval('seo_description')}</textarea>
        <button class="btn" type="submit" style="margin-top:10px">Lưu thông tin (nháp)</button>
      </form>
    </div>
    <div class="card"><h2 style="margin-top:0">Nội dung (section)</h2>
      <p class="muted" style="font-size:.85rem">Sửa/thêm/xoá là lưu vào bản NHÁP. Dùng ↑ ↓ để đổi thứ tự. Bấm “Đăng trang” để đưa lên storefront.</p>
      ${blocks.length ? blocks.map(blockCard).join('') : '<p class="muted">Chưa có section nào — thêm bên dưới.</p>'}
      <h2>Thêm section</h2>
      <form method="POST" action="${base}/blocks">
        <div class="grid2"><div><label>Loại</label><select name="type">${Object.entries(BTYPE).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div></div>
        <label>Nội dung</label><textarea name="text" maxlength="5000" placeholder="Tiêu đề / đoạn / trích: gõ nội dung • Danh sách: mỗi dòng 1 mục • Đường kẻ: để trống"></textarea>
        <label>Nguồn trích (chỉ dùng cho Trích dẫn)</label><input name="cite" maxlength="200">
        <button class="btn alt" type="submit">Thêm section</button>
      </form>
    </div>
    ${revs.length ? `<div class="card"><h2 style="margin-top:0">Lịch sử bản đăng</h2><table><tbody>
      ${revs.map((rv) => `<tr><td>Bản #${rv.revision}${rv.revision === p.published_revision ? ' <span class="badge published">đang đăng</span>' : ''} <span class="muted">${esc(rv.title)}</span></td>
        <td class="muted">${dt(rv.created_at)}</td>
        <td class="right">${rv.revision === p.published_revision ? '' : `<form method="POST" action="${base}/rollback"><input type="hidden" name="revision" value="${esc(rv.revision)}"><button class="btn alt sm" type="submit">Khôi phục</button></form>`}</td></tr>`).join('')}
    </tbody></table></div>` : ''}
    <div class="card"><h2 style="margin-top:0">Xoá trang</h2>
      <p class="muted">Xoá mềm; link xem trước cũng bị vô hiệu ngay.</p>
      <form method="POST" action="${base}/delete"><button class="btn warn sm" type="submit">Xoá trang này</button></form></div>`);
}

// ── Tài khoản (bảo mật) ──────────────────────────────────────────────────────
export function renderAccount(info) {
  const { email, mfa_enabled, enroll, recovery_codes, notice, err } = info;
  let mfaCard;
  if (recovery_codes) {
    mfaCard = `<div class="card"><h2 style="margin-top:0">✅ Đã bật xác thực 2 lớp</h2>
      <div class="err" style="background:#fffbeb;border-color:#fcd34d;color:#92400e">Lưu KỸ các mã khôi phục sau — chỉ hiện MỘT lần, dùng khi mất thiết bị:</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">${recovery_codes.map((c) => `<code>${esc(c)}</code>`).join('')}</div></div>`;
  } else if (enroll) {
    mfaCard = `<div class="card"><h2 style="margin-top:0">Bật MFA — bước 2/2</h2>
      <p>Thêm khoá này vào ứng dụng xác thực (Google Authenticator, Authy…):</p>
      <p>Khoá bí mật: <code>${esc(enroll.secret)}</code></p>
      <p class="muted" style="font-size:.82rem;word-break:break-all">otpauth: <code>${esc(enroll.otpauth_url)}</code></p>
      <form method="POST" action="/account/mfa/activate">
        <input type="hidden" name="secret" value="${esc(enroll.secret)}"><input type="hidden" name="otpauth" value="${esc(enroll.otpauth_url)}">
        <label>Nhập mã 6 số từ ứng dụng</label><input name="code" inputmode="numeric" autocomplete="one-time-code" required placeholder="123456" style="max-width:180px">
        <button class="btn" type="submit" style="margin-top:10px">Kích hoạt MFA</button></form></div>`;
  } else if (mfa_enabled) {
    mfaCard = `<div class="card"><h2 style="margin-top:0">Xác thực 2 lớp (MFA)</h2>
      <p>${badge('active', 'Đang bật')} — tài khoản đã được bảo vệ bằng MFA.</p>
      <form method="POST" action="/account/mfa/disable" style="margin-top:8px">
        <label>Tắt MFA — nhập mã 6 số (hoặc mã khôi phục) để xác nhận</label>
        <input name="code" inputmode="numeric" autocomplete="one-time-code" required placeholder="123456" style="max-width:220px">
        <button class="btn warn" type="submit" style="margin-top:8px">Tắt MFA</button>
      </form></div>`;
  } else {
    mfaCard = `<div class="card"><h2 style="margin-top:0">Xác thực 2 lớp (MFA)</h2>
      <p class="muted">Bảo vệ tài khoản bằng mã 6 số đổi liên tục. Nên bật — nhất là với chủ shop.</p>
      <form method="POST" action="/account/mfa/enroll"><button class="btn" type="submit">Bật MFA</button></form></div>`;
  }
  return layout('Tài khoản', { user: { email } }, `<h1>Tài khoản</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice ? `<div class="card" style="background:#ecfdf5;border-color:#a7f3d0;color:#065f46">${esc(notice)}</div>` : ''}
    <div class="card"><h2 style="margin-top:0">Thông tin</h2><p>Email: <strong>${esc(email)}</strong></p></div>
    ${mfaCard}
    <div class="card"><h2 style="margin-top:0">Đổi mật khẩu</h2>
      <form method="POST" action="/account/password/change">
        <label>Mật khẩu hiện tại</label><input name="current_password" type="password" required autocomplete="current-password">
        <label>Mật khẩu mới (tối thiểu 10 ký tự)</label><input name="new_password" type="password" required minlength="10" autocomplete="new-password">
        <button class="btn" type="submit" style="margin-top:10px">Đổi mật khẩu</button>
      </form>
      <div style="margin-top:12px;border-top:1px solid #eee;padding-top:10px">
        <p class="muted" style="font-size:.82rem;margin:0 0 6px">Quên mật khẩu hiện tại? Gửi link đặt lại qua email:</p>
        <form method="POST" action="/account/password/forgot"><button class="btn alt sm" type="submit">Gửi link đặt lại</button></form>
      </div></div>
    <a class="btn alt" href="/">← Bảng điều khiển</a>`);
}

// ── Nhân sự ──────────────────────────────────────────────────────────────────
export function renderMembers(ctx, shopId, data, canWrite, notice, err) {
  const members = data?.members ?? [];
  const base = `/shops/${esc(shopId)}/members`;
  const rows = members.map((mb) => `<tr>
    <td>${esc(mb.email)}</td>
    <td>${canWrite && mb.role !== 'owner' ? `<form method="POST" action="${base}/${esc(mb.user_id)}/role" class="inline">
        <select name="role">${INVITE_ROLES.map((r) => `<option value="${r}"${r === mb.role ? ' selected' : ''}>${esc(ROLE_LABEL[r])}</option>`).join('')}</select>
        <button class="btn alt sm" type="submit">Đổi</button></form>` : `<span class="badge">${esc(ROLE_LABEL[mb.role] ?? mb.role)}</span>`}</td>
    <td class="muted">${dt(mb.created_at)}</td>
    <td class="right">${canWrite ? `<form method="POST" action="${base}/${esc(mb.user_id)}/remove"><button class="btn warn sm" type="submit">Gỡ</button></form>` : ''}</td>
  </tr>`).join('');
  return layout('Nhân sự', ctx, `<h1>Nhân sự cửa hàng</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice?.invited ? `<div class="card" style="background:#ecfdf5;border-color:#a7f3d0">
      <strong>Đã mời ${esc(notice.invited)}.</strong> Gửi link này cho họ để đặt mật khẩu & tham gia (sống 7 ngày):
      <br><code style="word-break:break-all">${esc(notice.acceptUrl ?? notice.token)}</code></div>` : ''}
    <div class="card"><table><thead><tr><th>Email</th><th>Vai trò</th><th>Tham gia</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    ${canWrite ? `<div class="card"><h2 style="margin-top:0">Mời thành viên</h2>
      <p class="muted" style="font-size:.85rem">Thao tác nhân sự cần xác nhận lại mật khẩu (step-up).</p>
      <form method="POST" action="${base}/invite">
        <div class="grid2">
          <div><label>Email</label><input name="email" type="email" required></div>
          <div><label>Vai trò</label><select name="role">${INVITE_ROLES.map((r) => `<option value="${r}">${esc(ROLE_LABEL[r])}</option>`).join('')}</select></div>
        </div>
        <button class="btn" type="submit" style="margin-top:10px">Mời</button>
      </form></div>` : '<p class="muted">Chỉ chủ shop mới mời / đổi vai trò / gỡ thành viên.</p>'}`);
}

// Interstitial step-up: mang theo hành động đang chờ (hidden) → xác nhận mật khẩu → chạy tiếp.
export function renderStepUp(ctx, shopId, action, params, err) {
  const base = `/shops/${esc(shopId)}/members`;
  const label = { invite: 'mời thành viên', role: 'đổi vai trò', remove: 'gỡ thành viên' }[action] ?? action;
  const hidden = Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return layout('Xác nhận mật khẩu', ctx, `<div class="center"><div class="card">
    <h1>Xác nhận mật khẩu</h1>
    <p class="muted">Thao tác nhạy cảm (${esc(label)}) cần xác thực lại. Nhập mật khẩu của bạn để tiếp tục.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="${base}/step-up">
      <input type="hidden" name="__action" value="${esc(action)}">${hidden}
      <label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">
      <button class="btn" type="submit" style="width:100%;margin-top:12px">Xác nhận & tiếp tục</button>
    </form>
    <a class="muted" href="${base}" style="display:inline-block;margin-top:10px">← Huỷ</a>
  </div></div>`);
}

// ── Xuất dữ liệu (owner) ─────────────────────────────────────────────────────
export function renderExport(ctx, shopId, notice, err) {
  const base = `/shops/${esc(shopId)}`;
  if (ctx.role !== 'owner') {
    return layout('Xuất dữ liệu', ctx, `<h1>Xuất dữ liệu</h1>
      <div class="card"><p class="muted">Chỉ <strong>chủ cửa hàng</strong> mới xuất được dữ liệu.</p></div>`);
  }
  const N = (n) => new Intl.NumberFormat('vi-VN').format(Number(n ?? 0));
  const dl = notice ? `<div class="card ok">
      <h2>Bản xuất đã sẵn sàng</h2>
      <p class="muted">Gồm ${N(notice.counts?.products)} sản phẩm · ${N(notice.counts?.orders)} đơn · ${N(notice.counts?.customers)} khách · ${N(Math.round((notice.bytes ?? 0) / 1024))} KB.</p>
      <p><a class="btn" href="${base}/export/download?token=${esc(notice.token)}">⬇ Tải ZIP</a></p>
      <p class="muted">Link tải HẾT HẠN sau ${Math.round((notice.expires_in ?? 0) / 60)} phút. Hết hạn thì tạo bản xuất mới.</p>
    </div>` : '';
  return layout('Xuất dữ liệu', ctx, `
    <h1>Xuất dữ liệu</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${dl}
    <div class="card">
      <p>Tải toàn bộ dữ liệu cửa hàng dạng ZIP nhiều tệp CSV: sản phẩm, biến thể (kèm tồn kho),
         đơn hàng, chi tiết đơn, khách hàng (suy từ đơn) và danh mục ảnh.</p>
      <p class="muted">Thao tác nhạy cảm — sẽ yêu cầu xác nhận lại mật khẩu. Bản xuất chứa
         thông tin khách hàng, hãy giữ tệp cẩn thận.</p>
      <form method="POST" action="${base}/export">
        <button class="btn" type="submit">Tạo bản xuất</button>
      </form>
    </div>`);
}

export function renderExportStepUp(ctx, shopId, err) {
  const base = `/shops/${esc(shopId)}/export`;
  return layout('Xác nhận mật khẩu', ctx, `<div class="center"><div class="card">
    <h1>Xác nhận mật khẩu</h1>
    <p class="muted">Xuất dữ liệu là thao tác nhạy cảm — nhập mật khẩu của bạn để tiếp tục.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="${base}/step-up">
      <label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">
      <button class="btn" type="submit" style="width:100%;margin-top:12px">Xác nhận & tạo bản xuất</button>
    </form>
    <a class="muted" href="${base}" style="display:inline-block;margin-top:10px">← Huỷ</a>
  </div></div>`);
}

// ── Chấp nhận lời mời (CÔNG KHAI — người được mời chưa có phiên) ──────────────
export function renderInviteAccept(token, err) {
  return layout('Chấp nhận lời mời', {}, `<div class="center"><div class="card">
    <h1>Tham gia cửa hàng</h1>
    <p class="muted">Bạn được mời làm nhân sự. Đặt mật khẩu để tạo tài khoản và tham gia.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="/invite/accept">
      <input type="hidden" name="token" value="${esc(token)}">
      <label>Mật khẩu (tối thiểu 10 ký tự)</label><input name="password" type="password" required minlength="10" autocomplete="new-password">
      <button class="btn" type="submit" style="width:100%;margin-top:12px">Tạo tài khoản & tham gia</button>
    </form>
    <p class="muted" style="font-size:.82rem;margin-top:10px">Email này đã có tài khoản? <a href="/login">Đăng nhập</a> trước rồi mở lại link mời.</p>
  </div></div>`);
}

export function renderInviteDone(kind) {
  const T = {
    created: ['Đã tham gia cửa hàng 🎉', 'Tài khoản của bạn đã được tạo và bạn đã tham gia cửa hàng. Đăng nhập để bắt đầu.'],
    joined: ['Đã tham gia cửa hàng 🎉', 'Bạn đã tham gia cửa hàng. Đăng nhập để bắt đầu.'],
    login_required: ['Cần đăng nhập trước', 'Email này đã có tài khoản. Hãy đăng nhập bằng tài khoản đó rồi mở lại link mời để tham gia.'],
  }[kind] ?? ['Lời mời', ''];
  return layout('Lời mời', {}, `<div class="center"><div class="card">
    <h1>${esc(T[0])}</h1><p class="muted">${esc(T[1])}</p>
    <a class="btn" href="/login">Đăng nhập</a></div></div>`);
}

export function renderError(ctx, msg) {
  return layout('Lỗi', ctx, `<div class="card"><h1>Rất tiếc</h1><p class="err">${esc(msg)}</p><a class="btn alt" href="/">Về bảng điều khiển</a></div>`);
}
