/**
 * Trang HTML cho luồng mua (giỏ / checkout / kết quả đơn). SSR thuần, KHÔNG JS
 * (form + Post-Redirect-Get; QR tự làm mới bằng <meta refresh>). Mobile-first.
 * MỌI dữ liệu người dùng/shop đều esc() → chống XSS (trang checkout không dùng theme
 * của shop nên không có token động; chỉ tên shop + nội dung đơn, đều escape).
 */
import QRCode from 'qrcode';

const AMP = /&/g, LT = /</g, GT = />/g, QUOT = /"/g, APOS = /'/g;
export const esc = (s) => String(s ?? '').replace(AMP, '&amp;').replace(LT, '&lt;').replace(GT, '&gt;').replace(QUOT, '&quot;').replace(APOS, '&#39;');
const money = (v) => new Intl.NumberFormat('vi-VN').format(Number(v)) + '₫';

/** SVG QR nội tuyến (không tải resource ngoài → hợp CSP). */
export async function qrSvg(text) {
  try { return await QRCode.toString(text, { type: 'svg', margin: 1, width: 220 }); }
  catch { return ''; }
}

const STYLE = `*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#111827;background:#f9fafb;line-height:1.5}
a{color:#2563eb}.wrap{max-width:560px;margin:0 auto;padding:16px}
.hdr{background:#fff;border-bottom:1px solid #eee}.hdr .wrap{display:flex;justify-content:space-between;align-items:center;padding:12px 16px}
.brand{font-weight:700;font-size:1.1rem;color:#111827;text-decoration:none}
.card{background:#fff;border:1px solid #eee;border-radius:12px;padding:16px;margin:12px 0}
h1{font-size:1.25rem;margin:.2em 0}h2{font-size:1rem;margin:1em 0 .4em}
.row{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid #f3f4f6}
.row:last-child{border-bottom:0}.muted{color:#6b7280;font-size:.9rem}.right{text-align:right}
.tot{display:flex;justify-content:space-between;padding:6px 0}.tot.grand{font-weight:700;font-size:1.1rem;border-top:2px solid #eee;margin-top:6px;padding-top:10px}
.btn{display:block;width:100%;text-align:center;background:#111827;color:#fff;border:0;border-radius:10px;padding:14px;font-size:1rem;font-weight:600;text-decoration:none;cursor:pointer}
.btn.alt{background:#fff;color:#111827;border:1px solid #d1d5db}
label{display:block;font-size:.9rem;margin:10px 0 4px;font-weight:600}
input,textarea,select{width:100%;padding:11px;border:1px solid #d1d5db;border-radius:8px;font-size:1rem;font-family:inherit}
.qty{display:flex;gap:6px;align-items:center}.qty input{width:64px;text-align:center}
.qtybtn{width:38px;padding:8px 0;border:1px solid #d1d5db;background:#fff;border-radius:8px;font-size:1.1rem;cursor:pointer;text-decoration:none;text-align:center;color:#111827}
.pay label{display:flex;gap:8px;align-items:center;font-weight:400;padding:10px;border:1px solid #d1d5db;border-radius:8px;margin:6px 0}.pay input{width:auto}
.bank{background:#f3f4f6;border-radius:10px;padding:12px}.bank .row{border-color:#e5e7eb}
.qrbox{text-align:center;margin:12px 0}.qrbox svg{max-width:220px;height:auto}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:.85rem;font-weight:600}
.badge.wait{background:#fef3c7;color:#92400e}.badge.paid{background:#d1fae5;color:#065f46}.badge.ok{background:#dbeafe;color:#1e40af}
.empty{text-align:center;padding:40px 0;color:#6b7280}`;

function page(title, shopName, bodyHtml, extraHead = '') {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title>${extraHead}<style>${STYLE}</style></head><body>
<header class="hdr"><div class="wrap"><a class="brand" href="/">${esc(shopName || 'Cửa hàng')}</a>
<a href="/cart" class="muted">Giỏ hàng</a></div></header>
<main class="wrap">${bodyHtml}</main></body></html>`;
}

// Mọi thao tác đổi giỏ là POST form (sameOrigin chỉ chặn được POST/PATCH, KHÔNG chặn
// GET → không dùng link GET để sửa, tránh CSRF qua <img>/prefetch).
const itemsBlock = (items) => items.map((it) => `
  <div class="row"><div>
    <div>${esc(it.product_title)}${it.variant_title ? ` — <span class="muted">${esc(it.variant_title)}</span>` : ''}</div>
    <div class="muted">${money(it.unit_price_vnd)} / sp</div>
    <form method="POST" action="/cart/update" class="qty" style="margin-top:6px">
      <input type="hidden" name="variant_id" value="${esc(it.variant_id)}">
      <input type="number" name="qty" value="${it.qty}" min="0" max="1000" inputmode="numeric" aria-label="Số lượng">
      <button class="qtybtn" type="submit" title="Cập nhật">Cập nhật</button>
    </form>
    <form method="POST" action="/cart/update" style="margin-top:4px">
      <input type="hidden" name="variant_id" value="${esc(it.variant_id)}"><input type="hidden" name="qty" value="0">
      <button class="qtybtn" type="submit" style="width:auto;color:#b91c1c">Xoá</button>
    </form>
  </div><div class="right"><strong>${money(it.line_total_vnd)}</strong></div></div>`).join('');

const totalsBlock = (s) => `
  <div class="tot"><span class="muted">Tạm tính</span><span>${money(s.subtotal_vnd)}</span></div>
  <div class="tot"><span class="muted">Phí giao hàng</span><span>${money(s.shipping_vnd)}</span></div>
  <div class="tot grand"><span>Tổng cộng</span><span>${money(s.total_vnd)}</span></div>`;

export function renderError(shopName, msg) {
  return page('Có lỗi', shopName, `<div class="card empty"><h1>Rất tiếc</h1><p>${esc(msg)}</p>
    <a class="btn alt" href="/cart">Quay lại giỏ hàng</a></div>`);
}

export function renderCart(shopName, s) {
  if (!s.items.length) {
    return page('Giỏ hàng', shopName, `<div class="card empty"><p>Giỏ hàng trống.</p><a class="btn alt" href="/">Tiếp tục mua sắm</a></div>`);
  }
  return page('Giỏ hàng', shopName, `<h1>Giỏ hàng</h1>
    <div class="card">${itemsBlock(s.items)}</div>
    <div class="card">${totalsBlock(s)}</div>
    <a class="btn" href="/checkout">Thanh toán</a>
    <a class="btn alt" href="/" style="margin-top:8px">Tiếp tục mua sắm</a>`);
}

export function renderCheckout(shopName, s, idemToken) {
  return page('Thanh toán', shopName, `<h1>Thanh toán</h1>
    <div class="card"><h2>Đơn hàng</h2>
      ${s.items.map((it) => `<div class="tot"><span class="muted">${esc(it.product_title)} × ${it.qty}</span><span>${money(it.line_total_vnd)}</span></div>`).join('')}
      ${totalsBlock(s)}</div>
    <form method="POST" action="/checkout/place">
      <input type="hidden" name="idempotency_key" value="${esc(idemToken)}">
      <div class="card"><h2>Người nhận</h2>
        <label>Họ tên *</label><input name="name" required maxlength="120" autocomplete="name">
        <label>Số điện thoại *</label><input name="phone" required inputmode="tel" autocomplete="tel" placeholder="09xxxxxxxx">
        <label>Email (tuỳ chọn — nhận xác nhận đơn)</label><input name="email" type="email" autocomplete="email">
        <label>Địa chỉ giao hàng *</label><textarea name="address_line" required rows="2" maxlength="300" autocomplete="street-address"></textarea>
      </div>
      <div class="card pay"><h2>Thanh toán</h2>
        <label><input type="radio" name="payment_method" value="cod" checked> Thanh toán khi nhận hàng (COD)</label>
        <label><input type="radio" name="payment_method" value="qr"> Chuyển khoản QR (VietQR)</label>
      </div>
      <button class="btn" type="submit">Đặt hàng · ${money(s.total_vnd)}</button>
    </form>
    <a class="btn alt" href="/cart" style="margin-top:8px">Quay lại giỏ</a>`);
}

export function renderOrder(shopName, o, pay, qr) {
  const paid = o.payment_status === 'paid';
  const statusVi = { pending: 'Chờ xử lý', confirmed: 'Đã xác nhận', shipped: 'Đang giao', delivered: 'Đã giao', cancelled: 'Đã huỷ' }[o.status] ?? o.status;
  const head = (o.payment_method === 'qr' && !paid && o.status !== 'cancelled') ? '<meta http-equiv="refresh" content="8">' : '';
  let payBlock = '';
  if (o.payment_method === 'qr' && o.status !== 'cancelled') {
    payBlock = paid
      ? `<div class="card"><span class="badge paid">Đã thanh toán ✓</span></div>`
      : `<div class="card"><h2>Chuyển khoản QR</h2>
          <p class="muted">Quét mã trong app ngân hàng, hoặc chuyển thủ công đúng nội dung. Trang tự cập nhật khi nhận được tiền.</p>
          ${qr ? `<div class="qrbox">${qr}</div>` : ''}
          <div class="bank">
            <div class="row"><span class="muted">Ngân hàng</span><span>${esc(pay?.bank_name || pay?.bank_bin || '—')}</span></div>
            <div class="row"><span class="muted">Số tài khoản</span><span><strong>${esc(pay?.account_number || '—')}</strong></span></div>
            <div class="row"><span class="muted">Chủ tài khoản</span><span>${esc(pay?.account_name || '—')}</span></div>
            <div class="row"><span class="muted">Số tiền</span><span><strong>${money(o.total_vnd)}</strong></span></div>
            <div class="row"><span class="muted">Nội dung</span><span><strong>${esc(o.payment_ref || '')}</strong></span></div>
          </div>
          <p class="muted" style="margin-top:8px"><span class="badge wait">Đang chờ thanh toán…</span></p></div>`;
  } else if (o.payment_method === 'cod') {
    payBlock = `<div class="card"><span class="badge ok">Thanh toán khi nhận hàng (COD)</span></div>`;
  }
  return page(`Đơn #${o.order_number}`, shopName, `
    <div class="card" style="text-align:center"><h1>Đặt hàng thành công 🎉</h1>
      <p>Đơn <strong>#${o.order_number}</strong> · <span class="badge ok">${esc(statusVi)}</span></p></div>
    ${payBlock}
    <div class="card"><h2>Chi tiết đơn</h2>
      ${o.lines.map((l) => `<div class="tot"><span class="muted">${esc(l.title_snapshot)} × ${l.qty}</span><span>${money(Number(l.unit_price_vnd) * l.qty)}</span></div>`).join('')}
      <div class="tot"><span class="muted">Phí giao hàng</span><span>${money(o.shipping_vnd)}</span></div>
      <div class="tot grand"><span>Tổng cộng</span><span>${money(o.total_vnd)}</span></div>
      <p class="muted" style="margin-top:8px">Giao tới: ${esc(o.customer_name)}</p></div>
    <a class="btn alt" href="/">Tiếp tục mua sắm</a>`, head);
}
