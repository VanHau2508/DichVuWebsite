/**
 * Trang HTML admin (SSR form thuần, không JS). MỌI dữ liệu đều esc() → chống XSS.
 * CSP không cho script; thao tác nhạy cảm/đổi trạng thái đều là POST form + sameOrigin.
 */
import { esc } from './http.js';

const money = (v) => new Intl.NumberFormat('vi-VN').format(Number(v)) + '₫';
const dt = (s) => { try { return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(s)); } catch { return esc(s); } };
const STATUS = { pending: 'Chờ xử lý', confirmed: 'Đã xác nhận', shipped: 'Đang giao', delivered: 'Đã giao', cancelled: 'Đã huỷ', refunded: 'Đã hoàn' };
const PAY = { unpaid: 'Chưa trả', paid: 'Đã trả' };

const STYLE = `*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1f2430;background:#f6f7f8;line-height:1.55;-webkit-font-smoothing:antialiased}
a{color:#2463eb;text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:1.4rem;letter-spacing:-.01em;margin:0 0 .6em}h2{font-size:1.05rem;margin:0 0 .5em;font-weight:600}
.authwrap{padding:20px}.center{max-width:400px;margin:56px auto}
.shell{display:flex;min-height:100vh}
.side{width:232px;flex:0 0 232px;background:#fff;border-right:1px solid #e6e8eb;display:flex;flex-direction:column;position:sticky;top:0;height:100vh}
.side-brand{padding:17px 20px;font-weight:700;font-size:1.02rem;color:#111827;border-bottom:1px solid #e6e8eb;display:flex;align-items:center;gap:9px}.side-brand svg{width:20px;height:20px}
.side-shop{padding:13px 20px 4px;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:#9ca3af}
.side-nav{padding:4px 12px 12px;display:flex;flex-direction:column;gap:2px;flex:1}
.side-nav a{display:flex;align-items:center;gap:11px;padding:9px 12px;border-radius:9px;color:#4b5563;font-size:.92rem;font-weight:500}
.side-nav a:hover{background:#f6f7f8;color:#111827;text-decoration:none}
.side-nav a.on{background:#eef4ff;color:#2463eb;font-weight:600}.side-nav a svg{width:18px;height:18px;flex:0 0 auto}
.side-user{border-top:1px solid #e6e8eb;padding:12px 16px}.side-user .email{color:#6b7280;font-size:.82rem;display:block;margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.side-user button{background:#fff;border:1px solid #d8dbe0;border-radius:9px;padding:8px 12px;font:inherit;font-size:.85rem;cursor:pointer;color:#111827;width:100%}.side-user button:hover{background:#f6f7f8}
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.tbar{background:#fff;border-bottom:1px solid #e6e8eb;padding:14px 26px;display:flex;justify-content:space-between;align-items:center;gap:12px;position:sticky;top:0;z-index:10}
.tbar .brand{font-weight:700;color:#111827;display:flex;align-items:center;gap:8px}.tbar .brand svg{width:20px;height:20px}
.tbar .acc{font-size:.88rem;color:#6b7280;display:flex;align-items:center;gap:14px}.tbar .acc form{display:inline;margin:0}
.tbar .acc button{background:transparent;border:0;color:#6b7280;cursor:pointer;font:inherit}.tbar .acc button:hover{color:#111827}
.content{padding:26px;max-width:1000px;margin:0 auto;width:100%;flex:1}
.card{background:#fff;border:1px solid #e6e8eb;border-radius:12px;padding:18px 20px;margin:14px 0}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:11px 10px;border-bottom:1px solid #f1f2f4;font-size:.92rem}
th{color:#6b7280;font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.02em}tr:last-child td{border-bottom:0}tbody tr:hover td{background:#fafbfc}
.btn{display:inline-flex;align-items:center;gap:7px;justify-content:center;background:#2463eb;color:#fff;border:0;border-radius:10px;padding:10px 18px;font-size:.92rem;font-weight:500;cursor:pointer;text-decoration:none;transition:background .15s,transform .06s}
.btn:hover{background:#1e4bcc;text-decoration:none}.btn:active{transform:translateY(1px)}.btn svg{width:16px;height:16px}
.btn.alt{background:#fff;color:#111827;border:1px solid #d8dbe0}.btn.alt:hover{background:#f6f7f8;opacity:1}
.btn.warn{background:#fff;color:#b91c1c;border:1px solid #f0a6a6}.btn.warn:hover{background:#fef2f2;opacity:1}
.btn.sm{padding:7px 13px;font-size:.86rem;border-radius:8px}
label{display:block;font-size:.86rem;margin:12px 0 5px;font-weight:600;color:#374151}
input,select,textarea{width:100%;padding:11px 12px;border:1px solid #d8dbe0;border-radius:10px;font-size:1rem;font-family:inherit;color:#1f2430;background:#fff}
input:focus,select:focus,textarea:focus{outline:none;border-color:#2463eb;box-shadow:0 0 0 3px rgba(36,99,235,.12)}
textarea{min-height:80px;resize:vertical}
.err{background:#fef2f2;border:1px solid #f0a6a6;color:#b91c1c;border-radius:10px;padding:11px 14px;margin:10px 0}
.badge{display:inline-block;padding:3px 11px;border-radius:999px;font-size:.8rem;font-weight:600;background:#eef0f2;color:#4b5563}
.badge.pending{background:#fef3c7;color:#92400e}.badge.confirmed{background:#dbeafe;color:#1e40af}.badge.shipped{background:#e0e7ff;color:#3730a3}
.badge.delivered{background:#d1fae5;color:#065f46}.badge.cancelled{background:#fee2e2;color:#991b1b}.badge.paid{background:#d1fae5;color:#065f46}.badge.unpaid{background:#eef0f2;color:#6b7280}
.badge.active{background:#d1fae5;color:#065f46}.badge.draft{background:#fef3c7;color:#92400e}.badge.archived{background:#eef0f2;color:#4b5563}.badge.published{background:#d1fae5;color:#065f46}
.muted{color:#6b7280}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.filters{display:flex;gap:10px;align-items:end;flex-wrap:wrap}.filters>div{flex:0 0 auto}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}@media(max-width:560px){.grid2{grid-template-columns:1fr}}
.inline{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}.inline input{width:auto}
.num{font-variant-numeric:tabular-nums}.toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.stock{font-weight:600}.stock.low{color:#b45309}.stock.zero{color:#b91c1c}
input[type=file]{width:auto;padding:9px;background:#f6f7f8;border:1px dashed #cbd5e1}
.media-grid{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.thumb{margin:0;width:120px}.thumb img{width:120px;height:120px;object-fit:cover;border-radius:10px;border:1px solid #e6e8eb;display:block}
.thumb .ph{width:120px;height:120px;border-radius:10px;border:1px dashed #cbd5e1;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:.82rem;background:#f6f7f8;text-align:center}
.thumb .prim{font-size:.72rem;text-align:center;color:#065f46;font-weight:600;margin-top:3px}
.thumb-act{display:flex;gap:3px;justify-content:center;flex-wrap:wrap;margin-top:4px}.thumb-act form{margin:0}
.thumb-act .btn.sm{padding:4px 7px;font-size:.8rem}
.block{border:1px solid #e6e8eb;border-radius:10px;padding:12px;margin:8px 0;background:#fafbfc}
.block textarea{background:#fff}code{background:#f1f2f4;padding:2px 6px;border-radius:5px;font-size:.85rem}.pill{display:inline-block;margin-right:6px}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:0 0 18px}
.metric{background:#fff;border:1px solid #e6e8eb;border-radius:12px;padding:14px 16px}.metric .l{font-size:.8rem;color:#6b7280;margin-bottom:4px}.metric .v{font-size:1.5rem;font-weight:700;letter-spacing:-.01em}
@media(max-width:760px){.shell{flex-direction:column}.side{width:100%;flex:none;height:auto;position:static}.side-nav{flex-direction:row;flex-wrap:wrap}.content{padding:16px}.tbar{padding:12px 16px}}`;

const badge = (kind, label) => `<span class="badge ${esc(kind)}">${esc(label)}</span>`;
// Vai trò nào thấy tab nào (backend mới là nơi cưỡng chế; đây chỉ để ẩn/hiện cho gọn).
const CATALOG_ROLES = new Set(['owner', 'admin', 'catalog_manager']);
const ORDER_ROLES = new Set(['owner', 'admin', 'order_manager']);
const CONTENT_ROLES = new Set(['owner', 'admin']);
const MEMBER_READ_ROLES = new Set(['owner', 'admin']); // xem nhân sự; SỬA chỉ owner (seller cưỡng chế)
const EXPORT_ROLES = new Set(['owner']); // xuất dữ liệu: CHỈ chủ shop (seller cưỡng chế perm 'export')
const DOMAIN_ROLES = new Set(['owner']); // tên miền: CHỈ chủ shop (seller cưỡng chế 'domain.write')
const PAYMENT_ROLES = new Set(['owner']); // thanh toán: CHỈ chủ shop (seller cưỡng chế 'payment.write' + step-up)
const ROLE_LABEL = { owner: 'Chủ shop', admin: 'Quản trị', catalog_manager: 'Quản lý sản phẩm', order_manager: 'Quản lý đơn' };
const INVITE_ROLES = ['admin', 'catalog_manager', 'order_manager']; // KHÔNG mời owner qua đây
const PSTATUS = { draft: 'Nháp', active: 'Đang bán', archived: 'Lưu trữ' };
const PGSTATUS = { draft: 'Nháp', published: 'Đã đăng' };
const BTYPE = { heading: 'Tiêu đề', paragraph: 'Đoạn văn', list: 'Danh sách', quote: 'Trích dẫn', divider: 'Đường kẻ' };

// Icon nội tuyến (markup → hợp CSP, không tải resource ngoài).
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const IC_HOME = ic('<path d="M3 9l1-5h16l1 5"/><path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M3 9h18"/>');
const IC_ORDER = ic('<path d="M5 4h14v16l-3-2-2 2-2-2-2 2-3-2z"/><path d="M9 9h6"/><path d="M9 13h6"/>');
const IC_BOX = ic('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/><path d="M12 12v9"/>');
const IC_TAG = ic('<path d="M3 7v5.6a2 2 0 0 0 .6 1.4l7 7a2 2 0 0 0 2.8 0l5.6-5.6a2 2 0 0 0 0-2.8l-7-7A2 2 0 0 0 12.6 5H7a4 4 0 0 0-4 4z"/><circle cx="7.5" cy="9.5" r="1.3"/>');
const IC_FILE = ic('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6"/><path d="M9 16h6"/>');
const IC_USERS = ic('<circle cx="9" cy="8" r="3"/><path d="M4 20v-1a5 5 0 0 1 10 0v1"/><path d="M17 8a3 3 0 0 1 0 6"/><path d="M20 20v-1a4 4 0 0 0-3-3.8"/>');
const IC_GLOBE = ic('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18"/>');
const IC_DOWN = ic('<path d="M12 4v10"/><path d="M8 12l4 4 4-4"/><path d="M5 20h14"/>');
const IC_PALETTE = ic('<circle cx="13.5" cy="6.5" r="1.2"/><circle cx="17" cy="10" r="1.2"/><circle cx="8.5" cy="7" r="1.2"/><circle cx="6.5" cy="11.5" r="1.2"/><path d="M12 3a9 9 0 1 0 0 18 1.8 1.8 0 0 0 1.8-1.8 1.8 1.8 0 0 1 1.8-1.8H17a4 4 0 0 0 4-4 9 9 0 0 0-9-8.4z"/>');
const IC_CARD = ic('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 15h4"/>');
const IC_CHART = ic('<path d="M4 20V4"/><path d="M4 20h16"/><rect x="7" y="12" width="3" height="5"/><rect x="12" y="8" width="3" height="9"/><rect x="17" y="5" width="3" height="12"/>');
const IC_GEAR = ic('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>');

// Điều hướng dọc trong 1 shop (sidebar) — chỉ hiện mục vai trò được phép.
function sideNav(ctx) {
  if (!ctx.shopId) return '';
  const base = `/shops/${esc(ctx.shopId)}`;
  const it = (href, label, icon, on, show) => (show ? `<a href="${href}"${on ? ' class="on"' : ''}>${icon}<span>${label}</span></a>` : '');
  const t = it(`${base}/overview`, 'Tổng quan', IC_CHART, ctx.active === 'overview', ORDER_ROLES.has(ctx.role))
          + it(`${base}/orders`, 'Đơn hàng', IC_ORDER, ctx.active === 'orders', ORDER_ROLES.has(ctx.role))
          + it(`${base}/products`, 'Sản phẩm', IC_BOX, ctx.active === 'products', CATALOG_ROLES.has(ctx.role))
          + it(`${base}/categories`, 'Danh mục', IC_TAG, ctx.active === 'categories', CATALOG_ROLES.has(ctx.role))
          + it(`${base}/pages`, 'Trang nội dung', IC_FILE, ctx.active === 'pages', CONTENT_ROLES.has(ctx.role))
          + it(`${base}/members`, 'Nhân sự', IC_USERS, ctx.active === 'members', MEMBER_READ_ROLES.has(ctx.role))
          + it(`${base}/domains`, 'Tên miền', IC_GLOBE, ctx.active === 'domains', DOMAIN_ROLES.has(ctx.role))
          + it(`${base}/payment`, 'Thanh toán', IC_CARD, ctx.active === 'payment', PAYMENT_ROLES.has(ctx.role))
          + it(`${base}/export`, 'Xuất dữ liệu', IC_DOWN, ctx.active === 'export', EXPORT_ROLES.has(ctx.role))
          + it(`${base}/theme`, 'Giao diện', IC_PALETTE, ctx.active === 'theme', CONTENT_ROLES.has(ctx.role))
          + it(`${base}/settings`, 'Cài đặt', IC_GEAR, ctx.active === 'settings', CONTENT_ROLES.has(ctx.role));
  return `<nav class="side-nav">${t}</nav>`;
}

export function layout(title, ctx, body) {
  const head = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body>`;
  if (!ctx.user) return `${head}<div class="authwrap">${body}</div></body></html>`;
  const logout = `<form method="POST" action="/logout"><button type="submit">Đăng xuất</button></form>`;
  if (ctx.shopId) {
    return `${head}<div class="shell">
      <aside class="side">
        <a class="side-brand" href="/">${IC_HOME}Quản trị</a>
        ${ctx.shopName ? `<div class="side-shop">${esc(ctx.shopName)}</div>` : ''}
        ${sideNav(ctx)}
        <div class="side-user"><span class="email">${esc(ctx.user.email)}</span>${logout}</div>
      </aside>
      <div class="main">
        <header class="tbar"><span class="brand">${esc(ctx.shopName || 'Quản trị')}</span>
          <span class="acc"><a href="/account">Tài khoản</a></span></header>
        <div class="content">${body}</div>
      </div>
    </div></body></html>`;
  }
  return `${head}<div class="main">
    <header class="tbar"><a class="brand" href="/">${IC_HOME}Quản trị</a>
      <span class="acc"><a href="/account">${esc(ctx.user.email)}</a>${logout}</span></header>
    <div class="content">${body}</div>
  </div></body></html>`;
}

// Trang "Giao diện": chủ shop (theme.write) chọn màu thương hiệu → lưu vào theme tokens.
// Không JS: dùng <input type="color"> gốc của trình duyệt. Storefront sanitize khi render.
const THEME_FIELDS = [
  { key: 'color.primary', label: 'Màu chủ đạo', hint: 'Nút, link, giá', def: '#2463eb' },
  { key: 'color.hero-bg', label: 'Nền dải hero', hint: 'Dải lớn đầu trang chủ', def: '#eef4ff' },
  { key: 'color.text', label: 'Màu chữ chính', hint: 'Tiêu đề, nội dung', def: '#111827' },
  { key: 'color.surface', label: 'Màu nền phụ', hint: 'Ô ảnh, chân trang', def: '#f9fafb' },
];
function themeVal(tokens, key, def) {
  if (tokens && typeof tokens === 'object') {
    if (typeof tokens[key] === 'string') return tokens[key];
    const [a, b] = key.split('.');
    if (tokens[a] && typeof tokens[a][b] === 'string') return tokens[a][b];
  }
  return def;
}
export function renderTheme(ctx, theme, notice) {
  const tokens = theme?.tokens ?? {};
  const rows = THEME_FIELDS.map((f) => {
    const raw = themeVal(tokens, f.key, f.def);
    const hex = /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : f.def;
    return `<div style="display:flex;align-items:center;gap:14px;padding:14px 0;border-bottom:1px solid #f1f2f4">
      <input type="color" name="${esc(f.key)}" value="${esc(hex)}" aria-label="${esc(f.label)}" style="width:52px;height:40px;padding:2px;border-radius:8px;flex:0 0 auto;cursor:pointer">
      <div><div style="font-weight:600;font-size:.95rem">${esc(f.label)}</div><div class="muted" style="font-size:.84rem">${esc(f.hint)}</div></div>
      <code style="margin-left:auto">${esc(hex)}</code></div>`;
  }).join('');
  return layout('Giao diện', ctx, `<h1>Giao diện cửa hàng</h1>
    ${notice ? `<div class="card" style="border-color:#93c5fd;background:#eff6ff;color:#1e40af">${esc(notice)}</div>` : ''}
    <div class="card">
      <p class="muted">Chọn màu thương hiệu cho <strong>trang bán hàng</strong>. Bấm ô màu để chọn; lưu là áp dụng ngay cho website của bạn.</p>
      <form method="POST" action="/shops/${esc(ctx.shopId)}/theme">
        ${rows}
        <div class="actions"><button class="btn" type="submit">Lưu giao diện</button>
          <button class="btn alt" type="submit" name="reset" value="1">Khôi phục mặc định</button></div>
      </form>
    </div>
    <a class="btn alt" href="/shops/${esc(ctx.shopId)}/orders" style="margin-top:12px">← Quay lại</a>`);
}

// Cài đặt / Hồ sơ cửa hàng (shop.write = owner/admin). Tên + liên hệ + địa chỉ.
export function renderShopSettings(ctx, shopId, shop, notice, err) {
  const base = `/shops/${esc(shopId)}`;
  if (!CONTENT_ROLES.has(ctx.role)) {
    return layout('Cài đặt', ctx, `<h1>Cài đặt cửa hàng</h1><div class="card"><p class="muted">Chỉ <strong>chủ cửa hàng</strong> hoặc <strong>quản trị</strong> mới sửa hồ sơ.</p></div>`);
  }
  const s = shop ?? {};
  return layout('Cài đặt cửa hàng', ctx, `
    <h1>Cài đặt cửa hàng</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice ? `<div class="card" style="background:#ecfdf5;border-color:#a7f3d0;color:#065f46">${esc(notice)}</div>` : ''}
    <div class="card">
      <h2 style="margin-top:0">Logo cửa hàng</h2>
      ${s.logo_url
        ? `<div style="margin-bottom:10px"><img src="${esc(s.logo_url)}" alt="Logo cửa hàng" style="max-height:64px;max-width:220px;border:1px solid #eceef1;border-radius:8px;padding:6px;background:#fff"></div>`
        : '<p class="muted" style="margin-top:0">Chưa có logo — hiện tên cửa hàng ở đầu trang. Tải ảnh JPEG/PNG/WebP.</p>'}
      <form method="POST" action="${base}/logo" enctype="multipart/form-data" class="actions" style="align-items:center">
        <input type="file" name="file" accept="image/*" required>
        <button class="btn" type="submit">${s.logo_url ? 'Đổi logo' : 'Tải logo'}</button>
      </form>
      ${s.logo_url ? `<form method="POST" action="${base}/logo/remove" style="margin-top:8px"><button class="btn alt sm" type="submit">Gỡ logo</button></form>` : ''}
    </div>
    <div class="card">
      <p class="muted" style="margin-top:0">Thông tin liên hệ hiển thị ở <strong>chân trang cửa hàng</strong> để khách tin tưởng và liên hệ.</p>
      <form method="POST" action="${base}/settings">
        <label>Tên cửa hàng</label>
        <input name="name" value="${esc(s.name ?? '')}" required maxlength="200" placeholder="Nhà Xinh Décor">
        <label>Email liên hệ</label>
        <input name="contact_email" type="email" value="${esc(s.contact_email ?? '')}" maxlength="200" placeholder="lienhe@cuahang.vn">
        <label>Số điện thoại</label>
        <input name="contact_phone" value="${esc(s.contact_phone ?? '')}" maxlength="40" placeholder="0912 345 678">
        <label>Địa chỉ kinh doanh</label>
        <textarea name="business_address" maxlength="500" rows="2" placeholder="Số 12, Trần Duy Hưng, Cầu Giấy, Hà Nội">${esc(s.business_address ?? '')}</textarea>

        <h2 style="margin:22px 0 4px;font-size:1.05rem">Phí vận chuyển</h2>
        <p class="muted" style="margin:0 0 10px;font-size:.85rem">Phí ship áp cho mỗi đơn (tính tự động lúc thanh toán). Để trống = dùng mặc định nền tảng.</p>
        <div class="actions" style="align-items:end;flex-wrap:wrap">
          <div><label>Phí ship (VND)</label><input name="ship_fee_vnd" value="${esc(s.ship_fee_vnd ?? '')}" inputmode="numeric" maxlength="8" placeholder="30000" style="width:150px"></div>
          <div><label>Miễn phí ship từ (VND)</label><input name="free_ship_threshold_vnd" value="${esc(s.free_ship_threshold_vnd ?? '')}" inputmode="numeric" maxlength="10" placeholder="để trống = không" style="width:200px"></div>
        </div>
        <p class="muted" style="font-size:.8rem;margin:6px 0 0">VD: phí 30.000đ, miễn phí từ 500.000đ → đơn ≥ 500k được free ship.</p>

        <div class="actions" style="margin-top:16px"><button class="btn" type="submit">Lưu cài đặt</button></div>
      </form>
    </div>
    <div class="card"><p class="muted" style="margin:0;font-size:.85rem">Tên miền cửa hàng: <code>${esc(s.slug ?? '')}.nentang.vn</code>.
      Đổi bảng màu ở <a href="${base}/theme">Giao diện</a>; tên miền riêng ở <a href="${base}/domains">Tên miền</a>.</p></div>`);
}

// ── Console nền tảng (super-admin, chỉ platform_staff) ───────────────────────
// Gate ẩn: seller-admin không biết ai là staff → mọi handler gọi platformApi; platform
// requireStaff (introspect + platform_staff + MFA) tự chặn (403 → renderPlatformDenied).
const PLANS = [
  { code: 'platform', label: 'Platform — 990.000đ/tháng · 100 SP' },
  { code: 'care', label: 'Care — 2.490.000đ/tháng · 100 SP' },
  { code: 'growth', label: 'Growth — 5.900.000đ/tháng · 500 SP' },
];
const PLAT_STATUS = { onboarding: 'Đang thiết lập', active: 'Đang hoạt động', suspended: 'Tạm khoá' };

export function renderPlatformDenied(ctx) {
  return layout('Console nền tảng', ctx, `<h1>Console nền tảng</h1>
    <div class="card"><p class="muted">Khu vực này chỉ dành cho <strong>nhân viên nền tảng</strong> (đã bật MFA). Tài khoản của bạn không có quyền.</p>
    <a class="btn alt" href="/">← Về bảng điều khiển</a></div>`);
}
export function renderPlatformShops(ctx, shops) {
  const rows = (shops ?? []).map((s) => `<tr>
    <td><a href="/platform/shops/${esc(s.id)}">${esc(s.name)}</a><div class="muted" style="font-size:.8rem">${esc(s.subdomain ?? s.slug)}</div></td>
    <td>${badge(s.status, PLAT_STATUS[s.status] ?? s.status)}</td>
    <td>${esc(s.plan_code ?? '—')} <span class="muted">${esc(s.sub_status ?? '')}</span></td>
    <td class="muted">${dt(s.created_at)}</td></tr>`).join('');
  return layout('Console nền tảng', ctx, `
    <div class="toolbar"><h1 style="margin:0">Console nền tảng</h1>
      <a class="btn" href="/platform/new">+ Tạo cửa hàng</a></div>
    <div class="card">${(shops ?? []).length ? `<table><thead><tr><th>Cửa hàng</th><th>Trạng thái</th><th>Gói</th><th>Tạo</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="muted" style="margin-top:10px">${shops.length} cửa hàng.</p>` : '<p class="muted">Chưa có cửa hàng nào. Bấm “Tạo cửa hàng”.</p>'}</div>`);
}
export function renderPlatformShopNew(ctx, err, f = {}) {
  return layout('Tạo cửa hàng', ctx, `
    <a class="muted" href="/platform">← Console nền tảng</a>
    <h1>Tạo cửa hàng mới</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <div class="card"><form method="POST" action="/platform">
      <label>Tên cửa hàng</label><input name="name" value="${esc(f.name ?? '')}" required maxlength="200" placeholder="Nhà Xinh Décor">
      <label>Subdomain (slug)</label><input name="slug" value="${esc(f.slug ?? '')}" required pattern="[a-z0-9-]+" maxlength="40" placeholder="nha-xinh">
      <div class="muted" style="font-size:.82rem;margin:2px 0 8px">→ <code>&lt;slug&gt;.nentang.vn</code> (chỉ a-z, 0-9, gạch ngang)</div>
      <label>Gói dịch vụ</label><select name="plan_code">${PLANS.map((p) => `<option value="${p.code}"${f.plan_code === p.code ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
      <div class="actions" style="margin-top:14px"><button class="btn" type="submit">Tạo cửa hàng</button></div>
    </form></div>`);
}
export function renderPlatformShopDetail(ctx, shop, { notice = null, err = null, invite = null } = {}) {
  const base = `/platform/shops/${esc(shop.id)}`;
  const inviteCard = invite ? `<div class="card" style="background:#ecfdf5;border-color:#a7f3d0">
    <h2 style="margin-top:0">Link mời đã tạo</h2>
    <p class="muted">Gửi link này cho chủ shop <strong>${esc(invite.email)}</strong> để họ đặt mật khẩu và nhận cửa hàng. Hết hạn ${dt(invite.expires_at)}.</p>
    <p><code style="word-break:break-all">${esc(invite.url)}</code></p></div>` : '';
  const statusForm = shop.status === 'suspended'
    ? `<form method="POST" action="${base}/restore" style="display:inline"><button class="btn sm" type="submit">Mở lại</button></form>`
    : `<form method="POST" action="${base}/suspend" style="display:inline"><button class="btn warn sm" type="submit">Tạm khoá</button></form>`;
  return layout(`Cửa hàng ${shop.name}`, ctx, `
    <a class="muted" href="/platform">← Console nền tảng</a>
    <h1>${esc(shop.name)}</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice ? `<div class="card" style="background:#ecfdf5;border-color:#a7f3d0;color:#065f46">${esc(notice)}</div>` : ''}
    ${inviteCard}
    <div class="card">
      <span class="pill">${badge(shop.status, PLAT_STATUS[shop.status] ?? shop.status)}</span>
      <span class="pill">Gói ${esc(shop.plan_code ?? '—')} · ${esc(shop.sub_status ?? '')}</span>
      <div class="actions" style="margin-top:10px">${statusForm}
        <a class="btn alt sm" href="https://${esc(shop.subdomain ?? '')}" target="_blank" rel="noopener">Mở storefront ↗</a></div>
      <table style="margin-top:12px"><tbody>
        <tr><td class="muted">Subdomain</td><td><code>${esc(shop.subdomain ?? '')}</code></td></tr>
        <tr><td class="muted">Slug</td><td>${esc(shop.slug)}</td></tr>
        <tr><td class="muted">Kỳ thuê bao đến</td><td>${shop.current_period_end ? dt(shop.current_period_end) : '<span class="muted">chưa đặt</span>'}</td></tr>
        <tr><td class="muted">Tạo</td><td>${dt(shop.created_at)}</td></tr>
      </tbody></table>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Ghi nhận thu thuê bao / Gia hạn</h2>
      <p class="muted" style="font-size:.85rem">Khi chủ shop đã trả tiền: chọn số kỳ → thuê bao chuyển <strong>active</strong>, gia hạn kỳ, và <strong>mở lại</strong> shop nếu đang khoá vì nợ. (Thu tiền thủ công — chưa cổng recurring.)</p>
      <form method="POST" action="${base}/renew" class="actions" style="align-items:end;flex-wrap:wrap">
        <div><label>Số tháng</label><select name="months">${[1, 3, 6, 12].map((m) => `<option value="${m}">${m} tháng</option>`).join('')}</select></div>
        <div><label>Đổi gói (tuỳ chọn)</label><select name="plan_code"><option value="">— Giữ gói hiện tại —</option>${PLANS.map((p) => `<option value="${p.code}"${shop.plan_code === p.code ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}</select></div>
        <button class="btn" type="submit">Ghi nhận thu + gia hạn</button>
      </form>
    </div>
    <div class="card"><h2 style="margin-top:0">Mời chủ shop (owner)</h2>
      <p class="muted" style="font-size:.85rem">Tạo link mời để chủ shop đặt mật khẩu + nhận cửa hàng (concierge — chưa gửi email tự động).</p>
      <form method="POST" action="${base}/invite" class="actions" style="align-items:end">
        <div><label>Email chủ shop</label><input name="email" type="email" required placeholder="chushop@email.com" style="width:260px"></div>
        <button class="btn" type="submit">Tạo link mời</button>
      </form></div>`);
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

// Tổng quan cửa hàng (GĐ2): KPI doanh thu + đơn theo trạng thái + bán chạy.
export function renderOverview(ctx, shopId, s) {
  const base = `/shops/${esc(shopId)}`;
  const st = s?.status ?? {};
  const rev = s?.revenue ?? {};
  const metric = (label, value, sub = '') => `<div class="metric"><div class="l">${esc(label)}</div><div class="v">${value}</div>${sub ? `<div class="l" style="margin:4px 0 0">${sub}</div>` : ''}</div>`;
  // Ô trạng thái đơn (bấm vào lọc danh sách đơn theo trạng thái).
  const S = [
    { k: 'pending', label: 'Chờ xác nhận' }, { k: 'confirmed', label: 'Đã xác nhận' },
    { k: 'shipped', label: 'Đang giao' }, { k: 'delivered', label: 'Đã giao' }, { k: 'cancelled', label: 'Đã huỷ' },
  ];
  const statusCards = S.map((x) => `<a class="metric" style="text-decoration:none;color:inherit;display:block" href="${base}/orders?status=${x.k}">
      <div class="l">${esc(x.label)}</div><div class="v">${esc(st[x.k] ?? 0)}</div></a>`).join('');
  const top = (s?.top_products ?? []);
  const topRows = top.map((t) => `<tr><td>${esc(t.title)} <span class="muted" style="font-size:.8rem">${esc(t.sku ?? '')}</span></td>
      <td class="num right">${esc(t.qty)}</td><td class="num right"><strong>${money(t.revenue)}</strong></td></tr>`).join('');
  return layout('Tổng quan', ctx, `
    <h1>Tổng quan</h1>
    <div class="metrics">
      ${metric('Doanh thu hôm nay', money(rev.today ?? 0), `${esc(s?.orders_today ?? 0)} đơn mới`)}
      ${metric('Doanh thu 7 ngày', money(rev.d7 ?? 0))}
      ${metric('Cần thu tiền', esc(s?.unpaid ?? 0) + ' đơn', 'chưa thanh toán')}
      ${metric('Tổng đã thu', money(rev.all ?? 0), 'từ trước tới nay')}
    </div>
    <div class="card"><h2 style="margin-top:0">Đơn theo trạng thái</h2>
      <div class="metrics" style="margin-bottom:0">${statusCards}</div>
      <p class="muted" style="font-size:.82rem;margin-bottom:0">Bấm vào một ô để xem danh sách đơn ở trạng thái đó.</p></div>
    <div class="card"><h2 style="margin-top:0">Bán chạy 30 ngày</h2>
      ${top.length ? `<table><thead><tr><th>Sản phẩm</th><th class="right">Đã bán</th><th class="right">Doanh thu</th></tr></thead><tbody>${topRows}</tbody></table>`
        : '<p class="muted">Chưa có đơn đã thanh toán trong 30 ngày.</p>'}</div>
    <p class="muted" style="font-size:.82rem">Doanh thu chỉ tính đơn <strong>đã thanh toán</strong>; mốc ngày theo giờ Việt Nam.</p>`);
}

export function renderDashboard(ctx, shops, isStaff = false) {
  return layout('Bảng điều khiển', ctx, `<h1>Cửa hàng của bạn</h1>
    ${isStaff ? `<div class="card" style="background:#eef4ff;border-color:#93c5fd"><strong>Nhân viên nền tảng</strong> · <a href="/platform">Mở Console nền tảng →</a></div>` : ''}
    ${shops.length ? shops.map((s) => `<div class="card">
      <h2 style="margin:0">${esc(s.name || s.shop_id)}</h2>
      <p class="muted">Vai trò: ${esc(s.role)}${s.status && s.status !== 'active' ? ` · <strong>${esc(s.status)}</strong>` : ''}</p>
      <div class="actions">
        ${ORDER_ROLES.has(s.role) ? `<a class="btn" href="/shops/${esc(s.shop_id)}/overview">Tổng quan</a>` : ''}
        ${ORDER_ROLES.has(s.role) ? `<a class="btn alt" href="/shops/${esc(s.shop_id)}/orders">Quản lý đơn hàng</a>` : ''}
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
  const qenc = encodeURIComponent(filter.q ?? '');
  const nav = (o) => `?status=${esc(filter.status ?? '')}&q=${qenc}&from=${esc(filter.from ?? '')}&to=${esc(filter.to ?? '')}&offset=${o}`;
  return layout('Đơn hàng', ctx, `<h1>Đơn hàng</h1>
    <div class="card"><form method="GET" class="filters">
      <div style="flex:1 1 200px"><label>Tìm (mã đơn / tên / SĐT)</label><input name="q" value="${esc(filter.q ?? '')}" placeholder="123, Nguyễn…, 09…"></div>
      <div><label>Trạng thái</label><select name="status">${STATUSES.map((s) => `<option value="${s}"${s === filter.status ? ' selected' : ''}>${s ? (STATUS[s] ?? s) : 'Tất cả'}</option>`).join('')}</select></div>
      <div><label>Từ ngày</label><input type="date" name="from" value="${esc(filter.from ?? '')}"></div>
      <div><label>Đến ngày</label><input type="date" name="to" value="${esc(filter.to ?? '')}"></div>
      <div><button class="btn alt sm" type="submit">Lọc</button></div>
    </form></div>
    <div class="card">${orders.length ? `<table><thead><tr><th>Đơn</th><th>Trạng thái</th><th>Thanh toán</th><th>Khách</th><th>Thời gian</th><th style="text-align:right">Tổng</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="muted" style="margin-top:12px">${total} đơn ·
        ${off > 0 ? `<a href="${nav(Math.max(0, off - lim))}">← Trước</a>` : '<span style="color:#d1d5db">← Trước</span>'} ·
        ${off + lim < total ? `<a href="${nav(off + lim)}">Sau →</a>` : '<span style="color:#d1d5db">Sau →</span>'}
      </div>` : '<p class="muted">Không tìm thấy đơn nào khớp bộ lọc.</p>'}</div>
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
  // Đơn QR: webhook đối soát tự đặt paid. Nút xác nhận TAY chỉ hiện cho CHỦ SHOP
  // (owner) làm fallback khi feed vắng — sẽ đòi xác nhận lại mật khẩu (step-up).
  const unpaidLive = o.payment_status !== 'paid' && !['cancelled', 'refunded'].includes(o.status);
  let payAction = '';
  if (o.payment_method === 'cod' && unpaidLive) payAction = act('mark-paid', 'Đã nhận tiền (COD)');
  else if (o.payment_method === 'qr' && unpaidLive && ctx.role === 'owner') payAction = act('mark-paid-qr', 'Đã nhận tiền (QR) — xác nhận tay', 'btn warn sm');
  // Hoàn tiền: đơn ĐÃ thanh toán, chưa hoàn — owner/admin (perm 'refund' + step-up).
  const refundAction = (o.payment_status === 'paid' && o.status !== 'refunded' && ['owner', 'admin'].includes(ctx.role))
    ? act('refund', 'Hoàn tiền', 'btn warn sm') : '';
  return layout(`Đơn #${o.order_number}`, ctx, `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
      <a class="muted" href="/shops/${esc(shopId)}/orders">← Danh sách đơn</a>
      <a class="btn alt sm" href="/shops/${esc(shopId)}/orders/${esc(o.id)}/print" target="_blank" rel="noopener">🖨 In đơn</a>
    </div>
    <h1>Đơn hàng #${esc(o.order_number)}</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <div class="card"><span class="pill">${badge(o.status, STATUS[o.status] ?? o.status)}</span>
      <span class="pill">${badge(o.payment_status, PAY[o.payment_status] ?? o.payment_status)} ${esc(o.payment_method?.toUpperCase() ?? '')}</span>
      <div class="actions">${(actions + payAction + refundAction) || '<span class="muted">Không có thao tác.</span>'}</div></div>
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

// Trang IN đơn — HTML độc lập, tối ưu in (không sidebar, no-JS). User bấm Ctrl+P.
export function renderOrderPrint(shopId, shop, o) {
  const s = shop ?? {};
  const lines = o.lines ?? [];
  const addr = o.shipping_address
    ? (typeof o.shipping_address === 'object' ? (o.shipping_address.line ?? JSON.stringify(o.shipping_address)) : o.shipping_address)
    : '';
  const contact = [s.business_address, s.contact_phone ? `ĐT: ${s.contact_phone}` : '', s.contact_email ? `Email: ${s.contact_email}` : '']
    .filter(Boolean).map(esc).join(' · ');
  const ship = (o.shipments ?? [])[0];
  const ST = { pending: 'Chờ xác nhận', confirmed: 'Đã xác nhận', shipped: 'Đang giao', delivered: 'Đã giao', cancelled: 'Đã huỷ', refunded: 'Đã hoàn tiền' };
  const PT = { unpaid: 'Chưa thanh toán', pending: 'Chờ thanh toán', paid: 'Đã thanh toán', refunded: 'Đã hoàn tiền' };
  const CSS = `*{box-sizing:border-box}body{font-family:system-ui,'Segoe UI',sans-serif;color:#111827;margin:0;padding:24px;font-size:14px;line-height:1.5}
.doc{max-width:720px;margin:0 auto}.hd{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:2px solid #111827;padding-bottom:12px;margin-bottom:16px}
.shop{font-size:1.35rem;font-weight:700}.contact{color:#6b7280;font-size:.82rem;margin-top:3px}.ord{text-align:right}.no{font-size:1.2rem;font-weight:700}.ord .d{color:#6b7280;font-size:.85rem}
.tags{margin:0 0 14px}.tag{display:inline-block;border:1px solid #d1d5db;border-radius:6px;padding:3px 10px;font-size:.82rem;margin-right:8px}
.cust{background:#f9fafb;border:1px solid #eceef1;border-radius:8px;padding:12px 14px;margin-bottom:16px}.cust b{display:inline-block;min-width:60px}
table{width:100%;border-collapse:collapse;margin-bottom:14px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #eceef1}th{font-size:.8rem;color:#6b7280;text-transform:uppercase;letter-spacing:.03em}
td.r,th.r{text-align:right}.tot{margin-left:auto;width:260px}.tot .row{display:flex;justify-content:space-between;padding:4px 0}.tot .g{font-weight:700;font-size:1.1rem;border-top:2px solid #111827;padding-top:8px;margin-top:4px}
.foot{margin-top:24px;color:#6b7280;font-size:.82rem}.noprint a{color:#2463eb}
@media print{.noprint{display:none}body{padding:0}}`;
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Đơn #${esc(o.order_number)} — ${esc(s.name ?? '')}</title><style>${CSS}</style></head><body>
  <div class="doc">
    <div class="hd">
      <div><div class="shop">${esc(s.name ?? 'Cửa hàng')}</div>${contact ? `<div class="contact">${contact}</div>` : ''}</div>
      <div class="ord"><div class="no">Đơn #${esc(o.order_number)}</div><div class="d">${dt(o.created_at)}</div></div>
    </div>
    <div class="tags"><span class="tag">${esc(ST[o.status] ?? o.status)}</span><span class="tag">${esc(PT[o.payment_status] ?? o.payment_status)} · ${esc(o.payment_method?.toUpperCase() ?? '')}</span></div>
    <div class="cust">
      <div><b>Khách:</b> ${esc(o.customer_name ?? '')} ${o.customer_phone ? `· ${esc(o.customer_phone)}` : ''}${o.customer_email ? ` · ${esc(o.customer_email)}` : ''}</div>
      ${addr ? `<div style="margin-top:4px"><b>Giao tới:</b> ${esc(addr)}</div>` : ''}
      ${ship ? `<div style="margin-top:4px"><b>Vận đơn:</b> ${esc(ship.tracking_number ?? '')} ${esc(ship.carrier ?? '')}</div>` : ''}
    </div>
    <table><thead><tr><th>Sản phẩm</th><th class="r">Đơn giá</th><th class="r">SL</th><th class="r">Thành tiền</th></tr></thead><tbody>
      ${lines.map((l) => `<tr><td>${esc(l.title_snapshot)}${l.sku_snapshot ? ` <span style="color:#6b7280">(${esc(l.sku_snapshot)})</span>` : ''}</td><td class="r">${money(l.unit_price_vnd)}</td><td class="r">${esc(l.qty)}</td><td class="r">${money(Number(l.unit_price_vnd) * l.qty)}</td></tr>`).join('')}
    </tbody></table>
    <div class="tot">
      <div class="row"><span>Tạm tính</span><span>${money(o.subtotal_vnd)}</span></div>
      <div class="row"><span>Phí vận chuyển</span><span>${Number(o.shipping_vnd) === 0 ? 'Miễn phí' : money(o.shipping_vnd)}</span></div>
      <div class="row g"><span>Tổng cộng</span><span>${money(o.total_vnd)}</span></div>
    </div>
    <div class="foot noprint"><a href="/shops/${esc(shopId)}/orders/${esc(o.id)}">← Quay lại</a> · Nhấn <strong>Ctrl+P</strong> (hoặc ⌘P) để in / lưu PDF.</div>
  </div>
</body></html>`;
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
  const mx = d.max_products, cc = d.catalog_count;
  const capLine = mx != null ? `<p class="muted" style="margin:-6px 0 14px">Đã dùng <strong>${esc(cc)}/${esc(mx)}</strong> sản phẩm theo gói.${cc >= mx ? ' <strong style="color:#b45309">Đã đạt giới hạn — nâng gói để thêm.</strong>' : ''}</p>` : '';
  return layout('Sản phẩm', ctx, `
    <div class="toolbar"><h1 style="margin:0">Sản phẩm</h1>
      <span class="actions"><a class="btn alt" href="/shops/${esc(shopId)}/products/import">⬆ Nhập CSV</a>
      <a class="btn" href="/shops/${esc(shopId)}/products/new">+ Thêm sản phẩm</a></span></div>
    ${capLine}
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

// Quản lý danh mục: tạo/sửa/xoá + (gán sản phẩm ở trang chi tiết SP). Hiện storefront /c/:slug.
export function renderCategories(ctx, shopId, data, notice, err) {
  const base = `/shops/${esc(shopId)}`;
  const cats = data?.categories ?? [];
  const rows = cats.map((c) => `<tr>
    <td><form method="POST" action="${base}/categories/${esc(c.id)}" style="display:flex;gap:8px;align-items:center;margin:0">
      <input name="name" value="${esc(c.name)}" maxlength="200" required aria-label="Tên danh mục" style="flex:1;min-width:140px">
      <input name="position" type="number" value="${esc(c.position)}" min="0" style="width:66px" aria-label="Thứ tự" title="Thứ tự hiển thị">
      <button class="btn alt sm" type="submit">Lưu</button>
    </form></td>
    <td class="muted"><code>${esc(c.slug)}</code></td>
    <td style="text-align:right"><form method="POST" action="${base}/categories/${esc(c.id)}/delete" style="display:inline;margin:0"><button class="btn warn sm" type="submit">Xoá</button></form></td>
  </tr>`).join('');
  return layout('Danh mục', ctx, `
    <h1>Danh mục sản phẩm</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice ? `<div class="card" style="background:#ecfdf5;border-color:#a7f3d0;color:#065f46">${esc(notice)}</div>` : ''}
    <div class="card"><h2 style="margin-top:0">Thêm danh mục</h2>
      <form method="POST" action="${base}/categories" class="actions" style="align-items:end;flex-wrap:wrap">
        <div><label>Tên</label><input name="name" required maxlength="200" placeholder="Ghế sofa"></div>
        <div><label>Đường dẫn (slug)</label><input name="slug" required pattern="[a-z0-9][a-z0-9-]*" maxlength="60" placeholder="ghe-sofa"></div>
        <button class="btn" type="submit">Thêm danh mục</button>
      </form>
      <p class="muted" style="font-size:.82rem;margin-bottom:0">Slug là đường dẫn trên storefront: <code>/c/&lt;slug&gt;</code>. Chỉ chữ thường, số, gạch ngang.</p>
    </div>
    <div class="card">${cats.length
      ? `<table><thead><tr><th>Tên · thứ tự</th><th>Slug</th><th></th></tr></thead><tbody>${rows}</tbody></table>
         <p class="muted" style="margin-top:10px;font-size:.85rem">Gán sản phẩm vào danh mục ở <strong>trang chi tiết từng sản phẩm</strong> (mục "Danh mục").</p>`
      : '<p class="muted">Chưa có danh mục. Thêm ở trên để nhóm sản phẩm + hiện trên storefront.</p>'}</div>`);
}

// Nhập sản phẩm hàng loạt từ CSV (onboard concierge nhanh). Mỗi dòng = 1 sản phẩm.
export function renderProductImport(ctx, shopId, result, err) {
  const base = `/shops/${esc(shopId)}/products`;
  const sample = 'title,price_vnd,sku,stock,status,description\nGhế sofa vải 3 chỗ,4990000,SOFA-01,8,active,Ghế sofa phòng khách\nĐèn ngủ để bàn,390000,DEN-01,40,active,';
  let resultCard = '';
  if (result) {
    const errRows = (result.errors ?? []).map((e) => `<tr><td>${esc(e.line)}</td><td>${esc(e.title || '(trống)')}</td><td class="muted">${esc(e.error)}</td></tr>`).join('');
    resultCard = `<div class="card ${result.failed ? '' : 'ok'}" style="${result.failed ? 'border-color:#fcd34d;background:#fffbeb' : ''}">
      <h2 style="margin-top:0">Kết quả nhập</h2>
      <p><strong style="color:#059669">${esc(result.created)}</strong> sản phẩm đã tạo${result.failed ? ` · <strong style="color:#b45309">${esc(result.failed)}</strong> dòng lỗi (bỏ qua)` : ''} trên tổng ${esc(result.total ?? '')} dòng.</p>
      ${errRows ? `<table><thead><tr><th>Dòng</th><th>Sản phẩm</th><th>Lỗi</th></tr></thead><tbody>${errRows}</tbody></table>` : ''}
      ${result.created ? `<p style="margin-bottom:0"><a class="btn alt sm" href="${base}">Xem danh sách sản phẩm →</a></p>` : ''}
    </div>`;
  }
  return layout('Nhập sản phẩm CSV', ctx, `
    <a class="muted" href="${base}">← Danh sách sản phẩm</a>
    <h1>Nhập sản phẩm từ CSV</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${resultCard}
    <div class="card">
      <p>Tải lên tệp <strong>CSV</strong> (UTF-8) — mỗi dòng là một sản phẩm với một biến thể. Cột:</p>
      <ul class="muted" style="line-height:1.9">
        <li><code>title</code> — tên sản phẩm <em>(bắt buộc)</em></li>
        <li><code>price_vnd</code> — giá bán, số nguyên VND, ví dụ <code>4990000</code> <em>(bắt buộc)</em></li>
        <li><code>sku</code> — mã hàng, duy nhất trong shop <em>(bắt buộc)</em></li>
        <li><code>stock</code> — tồn kho ban đầu (mặc định 0)</li>
        <li><code>status</code> — <code>active</code> để bán ngay, hoặc <code>draft</code> (mặc định)</li>
        <li><code>description</code>, <code>slug</code> — tùy chọn (slug tự tạo từ tên nếu bỏ trống)</li>
      </ul>
      <p class="muted" style="font-size:.85rem">Dòng đầu tiên phải là hàng tiêu đề. Tối đa 1000 dòng/lần. Trùng SKU/slug sẽ bị bỏ qua và báo ở kết quả.</p>
      <form method="POST" action="${base}/import" enctype="multipart/form-data" class="actions" style="align-items:center">
        <input type="file" name="file" accept=".csv,text/csv" required>
        <button class="btn" type="submit">Nhập sản phẩm</button>
      </form>
    </div>
    <div class="card"><h2 style="margin-top:0">Mẫu CSV</h2>
      <pre style="overflow-x:auto;background:#f9fafb;border:1px solid #eceef1;border-radius:8px;padding:12px;font-size:.82rem">${esc(sample)}</pre>
      <p class="muted" style="font-size:.82rem;margin-bottom:0">Sao chép vào một tệp <code>.csv</code>, sửa dữ liệu rồi tải lên. Có thể mở/soạn bằng Excel hay Google Sheets (lưu dạng CSV UTF-8).</p>
    </div>`);
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

export function renderProductDetail(ctx, shopId, p, levels, err, form, media, cats) {
  const base = `/shops/${esc(shopId)}/products/${esc(p.id)}`;
  const catIds = new Set(p.category_ids ?? []);
  const catList = cats ?? [];
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
    <div class="card"><h2 style="margin-top:0">Danh mục</h2>
      ${catList.length
        ? `<form method="POST" action="${base}/categories">
            <div style="display:flex;flex-wrap:wrap;gap:10px 20px">${catList.map((c) => `<label style="display:inline-flex;align-items:center;gap:7px;font-size:.92rem"><input type="checkbox" name="category_ids" value="${esc(c.id)}"${catIds.has(c.id) ? ' checked' : ''}> ${esc(c.name)}</label>`).join('')}</div>
            <button class="btn alt sm" type="submit" style="margin-top:12px">Lưu danh mục</button>
          </form>`
        : `<p class="muted">Chưa có danh mục. Tạo ở trang <a href="/shops/${esc(shopId)}/categories">Danh mục</a> rồi quay lại gán.</p>`}
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
  const sessions = info.sessions ?? [];
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
    ${sessions.length ? `<div class="card"><h2 style="margin-top:0">Phiên đăng nhập</h2>
      <p class="muted" style="font-size:.82rem">Thiết bị/trình duyệt đang đăng nhập vào tài khoản. Thu hồi phiên lạ nếu thấy nghi ngờ.</p>
      <table><tbody>${sessions.map((s) => `<tr>
        <td>${s.current ? badge('active', 'Thiết bị này') : '<span class="muted">Thiết bị khác</span>'}</td>
        <td class="muted" style="font-size:.8rem">${esc((s.user_agent ?? '').slice(0, 70) || '—')}<br>${esc(s.ip ?? '')} · ${dt(s.last_seen_at)}</td>
        <td style="text-align:right">${s.current ? '' : `<form method="POST" action="/account/sessions/revoke"><input type="hidden" name="session_id" value="${esc(s.id)}"><button class="btn warn sm" type="submit">Thu hồi</button></form>`}</td>
      </tr>`).join('')}</tbody></table>
      ${sessions.filter((s) => !s.current).length ? `<form method="POST" action="/account/sessions/revoke-others" style="margin-top:10px"><button class="btn warn sm" type="submit">Đăng xuất mọi thiết bị KHÁC</button></form>` : ''}
    </div>` : ''}
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

// ── Tên miền tùy chỉnh (owner) ───────────────────────────────────────────────
export function renderDomains(ctx, shopId, domains, notice, err) {
  const base = `/shops/${esc(shopId)}`;
  if (ctx.role !== 'owner') {
    return layout('Tên miền', ctx, `<h1>Tên miền</h1><div class="card"><p class="muted">Chỉ <strong>chủ cửa hàng</strong> mới quản lý tên miền.</p></div>`);
  }
  const isPlatform = (h) => h.endsWith('.nentang.vn') || h === 'nentang.vn';
  const rows = domains.map((d) => {
    const status = d.verified ? badge('active', 'Đã xác minh') : badge('pending', 'Chờ xác minh DNS');
    const primary = d.is_primary ? ` ${badge('confirmed', 'Tên miền chính')}` : '';
    const challenge = (!d.verified && d.challenge) ? `<div class="card" style="background:#fffbeb;border-color:#fcd34d;margin:8px 0 0">
        <p class="muted" style="margin:0 0 6px">Thêm bản ghi DNS TXT này tại nhà cung cấp tên miền, rồi chờ ~1 phút (tự kiểm):</p>
        <table><tbody>
          <tr><td class="muted">Loại</td><td><code>TXT</code></td></tr>
          <tr><td class="muted">Tên/Host</td><td><code style="word-break:break-all">${esc(d.challenge.name)}</code></td></tr>
          <tr><td class="muted">Giá trị</td><td><code style="word-break:break-all">${esc(d.challenge.value)}</code></td></tr>
        </tbody></table></div>` : '';
    const setPrimary = (d.verified && !d.is_primary) ? `<form method="POST" action="${base}/domains/${esc(d.id)}/primary" style="display:inline"><button class="btn sm" type="submit">Đặt làm chính</button></form>` : '';
    const revoke = (!d.is_primary && !isPlatform(d.hostname)) ? `<form method="POST" action="${base}/domains/${esc(d.id)}/revoke" style="display:inline"><button class="btn warn sm" type="submit">Gỡ</button></form>` : '';
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div><strong style="word-break:break-all">${esc(d.hostname)}</strong> ${status}${primary}</div>
        <div class="actions">${setPrimary} ${revoke}</div>
      </div>${challenge}</div>`;
  }).join('');
  return layout('Tên miền', ctx, `
    <h1>Tên miền</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice ? `<div class="card" style="background:#ecfdf5;border-color:#a7f3d0;color:#065f46">${esc(notice)}</div>` : ''}
    ${rows || '<div class="card"><p class="muted">Chưa có tên miền nào.</p></div>'}
    <div class="card"><h2 style="margin-top:0">Thêm tên miền riêng</h2>
      <p class="muted" style="font-size:.85rem">Trỏ bản ghi A của tên miền về IP nền tảng, rồi thêm ở đây. Xác minh sở hữu qua DNS TXT.</p>
      <form method="POST" action="${base}/domains" class="actions" style="align-items:end">
        <div><label>Tên miền (vd shop.cuahang.vn)</label><input name="hostname" required placeholder="shop.cuahang.vn" style="width:260px"></div>
        <button class="btn" type="submit">Thêm tên miền</button>
      </form></div>`);
}

export function renderDomainStepUp(ctx, shopId, action, params, err) {
  const base = `/shops/${esc(shopId)}/domains`;
  const label = { add: 'thêm tên miền', primary: 'đặt tên miền chính', revoke: 'gỡ tên miền' }[action] ?? action;
  const hidden = Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return layout('Xác nhận mật khẩu', ctx, `<div class="center"><div class="card">
    <h1>Xác nhận mật khẩu</h1>
    <p class="muted">Thao tác nhạy cảm (${esc(label)}) cần xác thực lại. Nhập mật khẩu để tiếp tục.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="${base}/step-up">
      <input type="hidden" name="__action" value="${esc(action)}">${hidden}
      <label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">
      <button class="btn" type="submit" style="width:100%;margin-top:12px">Xác nhận & tiếp tục</button>
    </form>
    <a class="muted" href="${base}" style="display:inline-block;margin-top:10px">← Huỷ</a>
  </div></div>`);
}

// ── Thanh toán (owner + step-up) ─────────────────────────────────────────────
// Cấu hình tài khoản ngân hàng NHẬN TIỀN qua VietQR. Tiền vào THẲNG tài khoản shop;
// nền tảng chỉ đối soát. Vài BIN napas phổ biến để chủ shop tra nhanh.
const BANK_HINT = 'VD BIN napas: Vietcombank 970436 · Techcombank 970407 · MB 970422 · ACB 970416 · VietinBank 970415 · BIDV 970418 · VPBank 970432 · Agribank 970405 · Sacombank 970403 · TPBank 970423';
export function renderPayment(ctx, shopId, cfg, notice, err) {
  const base = `/shops/${esc(shopId)}`;
  if (ctx.role !== 'owner') {
    return layout('Thanh toán', ctx, `<h1>Thanh toán</h1><div class="card"><p class="muted">Chỉ <strong>chủ cửa hàng</strong> mới cấu hình tài khoản nhận tiền.</p></div>`);
  }
  const c = cfg ?? {};
  const on = c.qr_enabled === true;
  return layout('Thanh toán', ctx, `
    <h1>Thanh toán</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice ? `<div class="card" style="background:#ecfdf5;border-color:#a7f3d0;color:#065f46">${esc(notice)}</div>` : ''}
    <div class="card">
      <p class="muted" style="margin-top:0">Khai báo tài khoản ngân hàng của cửa hàng để nhận tiền qua <strong>VietQR</strong>.
        Khi bật, trang thanh toán sẽ hiện mã QR chuyển tiền <strong>thẳng vào tài khoản của bạn</strong>.
        Nền tảng không giữ tiền hộ.</p>
      <p class="muted" style="font-size:.85rem">Thao tác nhạy cảm — lưu sẽ yêu cầu xác nhận lại mật khẩu.</p>
      <form method="POST" action="${base}/payment" class="actions" style="align-items:end;flex-wrap:wrap">
        <div><label>Mã ngân hàng (BIN napas, 6 số)</label><input name="bank_bin" value="${esc(c.bank_bin ?? '')}" inputmode="numeric" pattern="\\d{6}" maxlength="6" placeholder="970436" style="width:150px"></div>
        <div><label>Số tài khoản</label><input name="account_number" value="${esc(c.account_number ?? '')}" inputmode="numeric" pattern="\\d{6,19}" maxlength="19" placeholder="0011002222" style="width:200px"></div>
        <div><label>Tên chủ tài khoản</label><input name="account_name" value="${esc(c.account_name ?? '')}" maxlength="100" placeholder="NGUYEN VAN A" style="width:240px"></div>
        <label style="display:flex;align-items:center;gap:8px;font-weight:600"><input type="checkbox" name="qr_enabled" value="1"${on ? ' checked' : ''} style="width:auto">Bật nhận tiền QR</label>
        <button class="btn" type="submit">Lưu</button>
      </form>
      <p class="muted" style="font-size:.8rem;margin-bottom:0">${esc(BANK_HINT)}</p>
    </div>
    <div class="card"><p class="muted" style="margin:0"><strong>${on ? '✅ Đang bật' : '⏸ Đang tắt'}</strong> nhận tiền QR.
      ${on ? 'Khách có thể chọn chuyển khoản QR khi đặt hàng.' : 'Bật ở trên để khách thanh toán bằng QR; hiện chỉ có COD (thu tiền mặt khi giao).'}</p></div>`);
}
export function renderPaymentStepUp(ctx, shopId, form, err) {
  const base = `/shops/${esc(shopId)}/payment`;
  const f = form ?? {};
  const hidden = ['bank_bin', 'account_number', 'account_name', 'qr_enabled'].map((k) => `<input type="hidden" name="${k}" value="${esc(f[k] ?? '')}">`).join('');
  return layout('Xác nhận mật khẩu', ctx, `<div class="center"><div class="card">
    <h1>Xác nhận mật khẩu</h1>
    <p class="muted">Đổi cấu hình nhận tiền là thao tác nhạy cảm — nhập mật khẩu của bạn để tiếp tục.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="${base}/step-up">${hidden}
      <label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">
      <button class="btn" type="submit" style="width:100%;margin-top:12px">Xác nhận & lưu</button>
    </form>
    <a class="muted" href="${base}" style="display:inline-block;margin-top:10px">← Huỷ</a>
  </div></div>`);
}
// Interstitial cho "xác nhận tay đơn QR đã nhận tiền" (mang theo mã đơn).
export function renderOrderPayStepUp(ctx, shopId, oid, err) {
  const base = `/shops/${esc(shopId)}/orders/${esc(oid)}`;
  return layout('Xác nhận mật khẩu', ctx, `<div class="center"><div class="card">
    <h1>Xác nhận đã nhận tiền</h1>
    <p class="muted">Bạn xác nhận đã nhận được tiền chuyển khoản cho đơn này. Đây là thao tác nhạy cảm
      (đánh dấu đã thanh toán thủ công) — nhập mật khẩu để tiếp tục. Chỉ làm khi bạn ĐÃ kiểm tra tiền về tài khoản.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="${base}/mark-paid-qr/step-up">
      <label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">
      <button class="btn" type="submit" style="width:100%;margin-top:12px">Xác nhận đã nhận tiền</button>
    </form>
    <a class="muted" href="${base}" style="display:inline-block;margin-top:10px">← Huỷ</a>
  </div></div>`);
}
// Interstitial cho hoàn tiền (thao tác nhạy cảm — mang theo mã đơn).
export function renderRefundStepUp(ctx, shopId, oid, err) {
  const base = `/shops/${esc(shopId)}/orders/${esc(oid)}`;
  return layout('Xác nhận hoàn tiền', ctx, `<div class="center"><div class="card">
    <h1>Xác nhận hoàn tiền</h1>
    <p class="muted">Bạn sẽ đánh dấu đơn này <strong>ĐÃ HOÀN TIỀN</strong> cho khách. Hãy đảm bảo
      đã thực sự chuyển/trả tiền. Nếu đơn <strong>chưa giao</strong>, hàng sẽ được trả lại kho.
      Thao tác không thể hoàn tác — nhập mật khẩu để tiếp tục.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="${base}/refund/step-up">
      <label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">
      <button class="btn warn" type="submit" style="width:100%;margin-top:12px">Xác nhận hoàn tiền</button>
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
