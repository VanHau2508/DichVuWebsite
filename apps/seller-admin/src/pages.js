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
input,select{width:100%;padding:11px;border:1px solid #d1d5db;border-radius:8px;font-size:1rem}
.center{max-width:380px;margin:48px auto}.err{background:#fef2f2;border:1px solid #fca5a5;color:#b91c1c;border-radius:8px;padding:10px;margin:8px 0}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:.82rem;font-weight:600;background:#e5e7eb;color:#374151}
.badge.pending{background:#fef3c7;color:#92400e}.badge.confirmed{background:#dbeafe;color:#1e40af}.badge.shipped{background:#e0e7ff;color:#3730a3}
.badge.delivered{background:#d1fae5;color:#065f46}.badge.cancelled{background:#fee2e2;color:#991b1b}.badge.paid{background:#d1fae5;color:#065f46}.badge.unpaid{background:#f3f4f6;color:#6b7280}
.muted{color:#6b7280}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.filters{display:flex;gap:8px;align-items:end;flex-wrap:wrap}.filters>div{flex:0 0 auto}
.pill{display:inline-block;margin-right:6px}nav.tabs a{margin-right:14px;padding:6px 0;color:#374151}nav.tabs a.on{border-bottom:2px solid #111827;font-weight:600}`;

const badge = (kind, label) => `<span class="badge ${esc(kind)}">${esc(label)}</span>`;

export function layout(title, ctx, body) {
  const top = ctx.user ? `<div class="top"><div class="in">
    <span><a class="brand" href="/">⚙ Quản trị</a>${ctx.shopName ? ` · ${esc(ctx.shopName)}` : ''}</span>
    <span class="muted" style="color:#9ca3af">${esc(ctx.user.email)}
      <form method="POST" action="/logout" style="margin-left:10px"><button type="submit">Đăng xuất</button></form></span>
  </div></div>` : '';
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${top}<main class="wrap">${body}</main></body></html>`;
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
      <a class="btn" href="/shops/${esc(s.shop_id)}/orders">Quản lý đơn hàng</a>
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
  return layout(`Đơn #${o.order_number}`, ctx, `
    <a class="muted" href="/shops/${esc(shopId)}/orders">← Danh sách đơn</a>
    <h1>Đơn hàng #${esc(o.order_number)}</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <div class="card"><span class="pill">${badge(o.status, STATUS[o.status] ?? o.status)}</span>
      <span class="pill">${badge(o.payment_status, PAY[o.payment_status] ?? o.payment_status)} ${esc(o.payment_method?.toUpperCase() ?? '')}</span>
      <div class="actions">${actions || '<span class="muted">Không có thao tác.</span>'}</div></div>
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

export function renderError(ctx, msg) {
  return layout('Lỗi', ctx, `<div class="card"><h1>Rất tiếc</h1><p class="err">${esc(msg)}</p><a class="btn alt" href="/">Về bảng điều khiển</a></div>`);
}
