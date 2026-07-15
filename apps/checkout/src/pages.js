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

// Icon giỏ nội tuyến (đồng bộ với storefront; là markup nên hợp CSP).
const I_CART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="20" r="1"/><circle cx="17" cy="20" r="1"/><path d="M2 3h2l2.4 12.3a1 1 0 0 0 1 .8h8.7a1 1 0 0 0 1-.8L21 7H5.6"/></svg>';

/** SVG QR nội tuyến (không tải resource ngoài → hợp CSP). */
export async function qrSvg(text) {
  try { return await QRCode.toString(text, { type: 'svg', margin: 1, width: 220 }); }
  catch { return ''; }
}

const STYLE = `*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1f2430;background:#f6f7f8;line-height:1.55;-webkit-font-smoothing:antialiased}
a{color:#2463eb;text-decoration:none}a:hover{text-decoration:underline}.wrap{max-width:600px;margin:0 auto;padding:16px 20px}
.hdr{position:sticky;top:0;z-index:20;background:#fff;border-bottom:1px solid #e6e8eb}.hdr .wrap{display:flex;justify-content:space-between;align-items:center;min-height:58px;padding:8px 20px}
.brand{font-weight:700;font-size:1.12rem;letter-spacing:-.02em;color:#111827}
.hnav{display:flex;align-items:center;gap:18px;font-size:.9rem}.hnav a{color:#6b7280}.hnav a:hover{color:#111827;text-decoration:none}
.hnav .cart{display:inline-flex;align-items:center;gap:6px;color:#111827;font-weight:600}.hnav .cart svg{width:18px;height:18px}
.card{background:#fff;border:1px solid #e6e8eb;border-radius:12px;padding:16px 18px;margin:14px 0}
h1{font-size:1.35rem;margin:.2em 0 .5em;letter-spacing:-.01em}h2{font-size:1rem;margin:0 0 .6em;font-weight:600}
.row{display:flex;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid #f1f2f4}
.row:last-child{border-bottom:0}.muted{color:#6b7280;font-size:.9rem}.right{text-align:right}
.it{display:flex;gap:12px}.cthumb{width:56px;height:56px;object-fit:cover;border-radius:10px;border:1px solid #e6e8eb;flex:0 0 auto;background:#f6f7f8}.cthumb.ph{border-style:dashed}
.tot{display:flex;justify-content:space-between;padding:7px 0}.tot .muted{font-size:.95rem}.tot.grand{font-weight:700;font-size:1.12rem;border-top:1px solid #e6e8eb;margin-top:8px;padding-top:12px}
.btn{display:block;width:100%;text-align:center;background:#2463eb;color:#fff;border:0;border-radius:999px;padding:15px;font-size:1rem;font-weight:500;text-decoration:none;cursor:pointer;transition:background .15s,transform .06s}
.btn:hover{background:#1e4bcc;text-decoration:none}.btn:active{transform:translateY(1px)}
.btn.alt{background:#fff;color:#111827;border:1px solid #d8dbe0}.btn.alt:hover{background:#f6f7f8;opacity:1}
label{display:block;font-size:.88rem;margin:12px 0 5px;font-weight:600;color:#374151}
input,textarea,select{width:100%;padding:11px 12px;border:1px solid #d8dbe0;border-radius:10px;font-size:1rem;font-family:inherit;color:#1f2430;background:#fff}
input:focus,textarea:focus,select:focus{outline:none;border-color:#2463eb;box-shadow:0 0 0 3px rgba(36,99,235,.12)}
.qty{display:flex;gap:8px;align-items:center}.qty input{width:70px;text-align:center}
.qtybtn{width:auto;padding:9px 14px;border:1px solid #d8dbe0;background:#fff;border-radius:10px;font-size:.9rem;cursor:pointer;text-decoration:none;text-align:center;color:#111827}.qtybtn:hover{background:#f6f7f8}
.pay label{display:flex;gap:10px;align-items:center;font-weight:500;padding:12px;border:1px solid #d8dbe0;border-radius:10px;margin:8px 0;cursor:pointer}.pay input{width:auto}
.bank{background:#f6f7f8;border-radius:10px;padding:14px}.bank .row{border-color:#e6e8eb}
.qrbox{text-align:center;margin:14px 0}.qrbox svg{max-width:220px;height:auto;border:1px solid #e6e8eb;border-radius:12px;padding:8px;background:#fff}
.badge{display:inline-block;padding:4px 12px;border-radius:999px;font-size:.85rem;font-weight:600}
.badge.wait{background:#fef3c7;color:#92400e}.badge.paid{background:#d1fae5;color:#065f46}.badge.ok{background:#eef4ff;color:#1e4bcc}
.empty{text-align:center;padding:44px 0;color:#6b7280}`;

function page(title, shopName, bodyHtml, extraHead = '') {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title>${extraHead}<style>${STYLE}</style></head><body>
<header class="hdr"><div class="wrap"><a class="brand" href="/">${esc(shopName || 'Cửa hàng')}</a>
<nav class="hnav"><a href="/checkout/lookup">Tra cứu đơn</a><a href="/cart" class="cart">${I_CART}Giỏ hàng</a></nav></div></header>
<main class="wrap">${bodyHtml}</main></body></html>`;
}

// Mọi thao tác đổi giỏ là POST form (sameOrigin chỉ chặn được POST/PATCH, KHÔNG chặn
// GET → không dùng link GET để sửa, tránh CSRF qua <img>/prefetch).
const itemsBlock = (items) => items.map((it) => `
  <div class="row"><div class="it">
    ${it.image ? `<img class="cthumb" src="${esc(it.image)}" alt="" loading="lazy" width="52" height="52">` : '<div class="cthumb ph"></div>'}
    <div>
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
  </div></div><div class="right"><strong>${money(it.line_total_vnd)}</strong></div></div>`).join('');

const totalsBlock = (s) => `
  <div class="tot"><span class="muted">Tạm tính</span><span>${money(s.subtotal_vnd)}</span></div>
  ${s.discount_vnd ? `<div class="tot"><span class="muted">Giảm giá${s.coupon_code ? ` (${esc(s.coupon_code)})` : ''}</span><span style="color:#0e9f6e">−${money(s.discount_vnd)}</span></div>` : ''}
  <div class="tot"><span class="muted">Phí giao hàng</span><span>${money(s.shipping_vnd)}</span></div>
  <div class="tot grand"><span>Tổng cộng</span><span>${money(s.total_vnd)}</span></div>`;

// Ô nhập mã giảm giá trên trang giỏ (no-JS: POST /cart/coupon → PRG). Rỗng = gỡ mã.
const couponBlock = (s) => `<div class="card">
  ${s.coupon_code
    ? `<div class="tot"><span>Mã <strong>${esc(s.coupon_code)}</strong> — giảm ${money(s.discount_vnd)}</span>
        <form method="POST" action="/cart/coupon" style="margin:0"><input type="hidden" name="code" value=""><button class="qtybtn" type="submit" style="width:auto;color:#b91c1c">Gỡ</button></form></div>`
    : `<form method="POST" action="/cart/coupon" class="qty" style="margin:0">
        <input name="code" placeholder="Mã giảm giá" maxlength="40" aria-label="Mã giảm giá" style="text-transform:uppercase">
        <button class="qtybtn" type="submit" style="width:auto">Áp dụng</button>
      </form>`}
  ${s.coupon_error ? `<div class="muted" style="color:#b91c1c;margin-top:8px">${esc(s.coupon_error)}</div>` : ''}
</div>`;

export function renderError(shopName, msg) {
  return page('Có lỗi', shopName, `<div class="card empty"><h1>Rất tiếc</h1><p>${esc(msg)}</p>
    <a class="btn alt" href="/cart">Quay lại giỏ hàng</a></div>`);
}

// Tra cứu đơn: khách nhập số đơn + mã tra cứu → GET /checkout/success (hiển thị đơn).
// Dùng GET (chỉ đọc) — không đổi trạng thái. err escape để chống XSS khi hiển thị lại.
export function renderLookup(shopName, err) {
  return page('Tra cứu đơn hàng', shopName, `<h1>Tra cứu đơn hàng</h1>
    ${err ? `<div class="card" style="border-color:#fca5a5;color:#b91c1c">${esc(err)}</div>` : ''}
    <form method="GET" action="/checkout/success"><div class="card">
      <label>Số đơn hàng</label><input name="number" inputmode="numeric" required placeholder="vd 12">
      <label>Mã tra cứu</label><input name="token" required placeholder="mã trong trang xác nhận / email">
    </div><button class="btn" type="submit">Tra cứu</button></form>
    <a class="btn alt" href="/" style="margin-top:8px">Về cửa hàng</a>`);
}

export function renderCart(shopName, s) {
  if (!s.items.length) {
    return page('Giỏ hàng', shopName, `<div class="card empty"><p>Giỏ hàng trống.</p><a class="btn alt" href="/">Tiếp tục mua sắm</a></div>`);
  }
  return page('Giỏ hàng', shopName, `<h1>Giỏ hàng</h1>
    <div class="card">${itemsBlock(s.items)}</div>
    ${couponBlock(s)}
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

export function renderOrder(shopName, o, pay, qr, justPlaced = false) {
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
    <div class="card" style="text-align:center">
      <h1>${justPlaced ? 'Đặt hàng thành công 🎉' : `Đơn hàng #${o.order_number}`}</h1>
      <p>Đơn <strong>#${o.order_number}</strong> · <span class="badge ok">${esc(statusVi)}</span></p></div>
    ${payBlock}
    <div class="card"><h2>Chi tiết đơn</h2>
      ${o.lines.map((l) => `<div class="tot"><span class="muted">${esc(l.title_snapshot)} × ${l.qty}</span><span>${money(Number(l.unit_price_vnd) * l.qty)}</span></div>`).join('')}
      <div class="tot"><span class="muted">Phí giao hàng</span><span>${money(o.shipping_vnd)}</span></div>
      <div class="tot grand"><span>Tổng cộng</span><span>${money(o.total_vnd)}</span></div>
      <p class="muted" style="margin-top:8px">Giao tới: ${esc(o.customer_name)}</p>
      ${justPlaced ? '<p class="muted">Lưu lại đường link/số đơn + mã này để tra cứu sau.</p>' : ''}</div>
    <a class="btn alt" href="/checkout/lookup">Tra cứu đơn khác</a>
    <a class="btn alt" href="/" style="margin-top:8px">Tiếp tục mua sắm</a>`, head);
}
