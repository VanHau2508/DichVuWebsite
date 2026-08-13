/** SSR HTML thuần no-JS cho service tài khoản khách (esc() mọi dữ liệu khách). */
import { esc } from './http.js';

const STYLE = `
:root{--bg:#f7f7f8;--card:#fff;--bd:#e5e7eb;--pri:#2563eb;--ink:#111827;--mut:#6b7280;--bad:#b91c1c;--good:#059669}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--ink);line-height:1.5}
a{color:var(--pri)}.wrap{max-width:960px;margin:0 auto;padding:20px 16px}
.auth{max-width:420px;margin:40px auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:20px;margin-bottom:16px}
h1{font-size:1.4rem;margin:0 0 4px}h2{font-size:1.05rem;margin:0 0 12px}
label{display:block;font-size:.85rem;color:var(--mut);margin:10px 0 4px}
input,select,textarea{width:100%;padding:9px 11px;border:1px solid var(--bd);border-radius:8px;font:inherit;background:#fff}
.btn{display:inline-block;background:var(--pri);color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:1rem;cursor:pointer;text-decoration:none}
.btn.alt{background:#f3f4f6;color:var(--ink);border:1px solid var(--bd)}
.btn.sm{padding:6px 11px;font-size:.85rem}.btn.warn{background:#fee2e2;color:var(--bad);border:1px solid #fecaca}
.err{background:#fef2f2;border:1px solid #fecaca;color:var(--bad);border-radius:8px;padding:10px 12px;margin:12px 0}
.ok{background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;border-radius:8px;padding:10px 12px;margin:12px 0}
.muted{color:var(--mut)}.row{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--bd);font-size:.92rem}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.78rem;background:#eef2ff;color:#3730a3}
.hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.foot{margin-top:24px;font-size:.82rem;color:var(--mut);text-align:center}
`;

function layout(title, shopName, body, { back } = {}) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} — ${esc(shopName || 'Cửa hàng')}</title><style>${STYLE}</style></head><body>
<div class="${back === 'auth' ? 'auth' : 'wrap'}">${body}
<div class="foot"><a href="/">← Về cửa hàng</a> · ${esc(shopName || '')}</div></div></body></html>`;
}

const errBox = (e) => e ? `<div class="err">${esc(e)}</div>` : '';
const okBox = (m) => m ? `<div class="ok">${esc(m)}</div>` : '';

export function renderLogin(shopName, { error, notice, next = '/account' } = {}) {
  return layout('Đăng nhập', shopName, `
    <h1>Đăng nhập</h1>
    <p class="muted">Tài khoản của bạn tại ${esc(shopName || 'cửa hàng')} — theo dõi đơn hàng & sổ địa chỉ.</p>
    ${okBox(notice)}${errBox(error)}
    <div class="card"><form method="POST" action="/account/login">
      <input type="hidden" name="next" value="${esc(next)}">
      <label>Email</label><input name="email" type="email" required autocomplete="email">
      <label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">
      <button class="btn" type="submit" style="width:100%;margin-top:14px">Đăng nhập</button>
    </form>
    <p class="muted" style="margin:12px 0 0"><a href="/account/forgot">Quên mật khẩu?</a> · Chưa có tài khoản? <a href="/account/register">Đăng ký</a></p></div>`, { back: 'auth' });
}

export function renderRegister(shopName, { error, form = {} } = {}) {
  return layout('Đăng ký', shopName, `
    <h1>Đăng ký</h1>
    <p class="muted">Tạo tài khoản tại ${esc(shopName || 'cửa hàng')}.</p>
    ${errBox(error)}
    <div class="card"><form method="POST" action="/account/register">
      <label>Email</label><input name="email" type="email" required autocomplete="email" value="${esc(form.email)}">
      <label>Họ tên (tuỳ chọn)</label><input name="full_name" maxlength="120" value="${esc(form.full_name)}">
      <label>Mật khẩu (tối thiểu 10 ký tự)</label><input name="password" type="password" required autocomplete="new-password">
      ${form.claim_order ? `<input type="hidden" name="claim_order" value="${esc(form.claim_order)}"><input type="hidden" name="claim_token" value="${esc(form.claim_token)}">` : ''}
      <button class="btn" type="submit" style="width:100%;margin-top:14px">Tạo tài khoản</button>
    </form>
    <p class="muted" style="margin:12px 0 0">Đã có tài khoản? <a href="/account/login">Đăng nhập</a></p></div>`, { back: 'auth' });
}

// Trang SAU đăng ký — TRUNG TÍNH (must-fix #3): giống hệt cho email mới lẫn đã tồn tại →
// KHÔNG rò email nào đã có tài khoản. Không auto-login.
export function renderRegisterDone(shopName) {
  return layout('Kiểm tra email', shopName, `
    <h1>Gần xong rồi!</h1>
    <div class="card">
      <p>Nếu đây là lần đầu, chúng tôi đã gửi email xác minh tới hộp thư của bạn. Nếu email này đã có tài khoản, bạn sẽ nhận được nhắc đăng nhập.</p>
      <p class="muted">Kiểm tra hộp thư (cả mục spam), rồi <a href="/account/login">đăng nhập</a> để tiếp tục.</p>
    </div>`, { back: 'auth' });
}

export function renderDashboard(shopName, cust, { notice, loyalty = null } = {}) {
  const base = '/account';
  const loyaltyCard = loyalty ? `<div class="card" style="flex:1;min-width:220px"><h2>Điểm thưởng</h2>
        <p class="muted" style="margin:0 0 8px">Bạn có <strong>${esc(loyalty.balance)}</strong> điểm — đổi lấy giảm giá khi mua.</p>
        <a class="btn alt sm" href="${base}/points">Xem điểm →</a></div>` : '';
  const unverified = !cust.email_verified_at ? `<div class="card" style="border-color:#fcd34d;background:#fffbeb">
      <div class="row"><span>⚠ Email <strong>chưa xác minh</strong>.</span>
      <form method="POST" action="${base}/resend-verify" style="margin:0"><button class="btn alt sm" type="submit">Gửi lại email xác minh</button></form></div></div>` : '';
  return layout('Tài khoản', shopName, `
    <div class="hd"><h1>Xin chào, ${esc(cust.full_name || cust.email || 'bạn')}</h1>
      <form method="POST" action="${base}/logout" style="margin:0"><button class="btn alt sm" type="submit">Đăng xuất</button></form></div>
    ${okBox(notice)}${unverified}
    <div class="card"><h2>Hồ sơ</h2>
      <p class="muted" style="margin:0">Email: ${esc(cust.email || '(đã ẩn danh)')}${cust.email_verified_at ? ' <span class="badge">đã xác minh</span>' : ''}<br>
      Họ tên: ${esc(cust.full_name || '—')} · SĐT: ${esc(cust.phone || '—')}</p>
    </div>
    <div class="row">
      <div class="card" style="flex:1;min-width:220px"><h2>Đơn hàng của tôi</h2>
        <p class="muted">Xem lịch sử đơn đã đặt.</p><a class="btn alt sm" href="${base}/orders">Xem đơn hàng →</a></div>
      <div class="card" style="flex:1;min-width:220px"><h2>Sổ địa chỉ</h2>
        <p class="muted">Lưu địa chỉ để điền nhanh khi thanh toán.</p><a class="btn alt sm" href="${base}/addresses">Quản lý địa chỉ →</a></div>
      ${loyaltyCard}
    </div>`);
}

const POINT_KIND = { earn: 'Tích điểm', redeem: 'Đổi điểm', reversal: 'Hoàn điểm (đơn huỷ/hoàn)', clawback: 'Thu hồi (đơn huỷ/hoàn)', adjust: 'Điều chỉnh' };
export function renderPoints(shopName, { balance, perPoint, rows, page = 1, hasMore = false }) {
  const base = '/account';
  const valueStr = perPoint > 0 && balance > 0 ? ` <span class="muted" style="font-size:1rem;font-weight:400">(~${money(balance * perPoint)})</span>` : '';
  const trs = rows.length ? rows.map((r) => `<tr>
      <td class="muted">${dt(r.created_at)}</td>
      <td>${esc(POINT_KIND[r.kind] ?? r.kind)}</td>
      <td style="font-weight:600;color:${Number(r.delta) >= 0 ? '#16a34a' : '#dc2626'}">${Number(r.delta) >= 0 ? '+' : ''}${esc(r.delta)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="muted">Chưa có hoạt động điểm nào.</td></tr>';
  const pager = (page > 1 || hasMore) ? `<div class="row" style="margin-top:10px">
      ${page > 1 ? `<a class="btn alt sm" href="${base}/points?page=${page - 1}">← Trước</a>` : '<span></span>'}
      ${hasMore ? `<a class="btn alt sm" href="${base}/points?page=${page + 1}">Sau →</a>` : ''}</div>` : '';
  return layout('Điểm thưởng', shopName, `
    <div class="hd"><h1>Điểm thưởng</h1><a class="btn alt sm" href="${base}">← Tài khoản</a></div>
    <div class="card" style="text-align:center">
      <p class="muted" style="margin:0 0 4px">Số dư điểm khả dụng</p>
      <p style="font-size:2rem;font-weight:800;margin:0">${esc(balance)}${valueStr}</p>
      <p class="muted" style="margin:8px 0 0;font-size:.85rem">Dùng điểm để giảm giá tiền hàng khi thanh toán đơn mới.</p></div>
    <div class="card"><h2>Lịch sử điểm</h2>
      <table><thead><tr><th>Ngày</th><th>Hoạt động</th><th>Điểm</th></tr></thead><tbody>${trs}</tbody></table>${pager}</div>`);
}

const money = (v) => new Intl.NumberFormat('vi-VN').format(Number(v ?? 0)) + '₫';
const dt = (ts) => new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(ts));
const ORDER_ST = { pending: 'Chờ xác nhận', confirmed: 'Đã xác nhận', shipped: 'Đang giao', delivered: 'Đã giao', cancelled: 'Đã huỷ', refunded: 'Đã hoàn', returned: 'Đã trả' };
const PAY_ST = { unpaid: 'Chưa thanh toán', paid: 'Đã thanh toán', refunded: 'Đã hoàn tiền' };

export function renderOrders(shopName, orders, { page = 1, hasMore = false, notice } = {}) {
  const base = '/account';
  const rows = orders.length ? orders.map((o) => `<tr>
      <td><a href="${base}/orders/${esc(o.order_number)}">#${esc(o.order_number)}</a></td>
      <td class="muted">${dt(o.created_at)}</td>
      <td>${money(o.total_vnd)}</td>
      <td><span class="badge">${esc(ORDER_ST[o.status] ?? o.status)}</span></td></tr>`).join('')
    : '<tr><td colspan="4" class="muted">Chưa có đơn hàng nào gắn với tài khoản.</td></tr>';
  const pager = (page > 1 || hasMore) ? `<div class="row" style="margin-top:10px">
      ${page > 1 ? `<a class="btn alt sm" href="${base}/orders?page=${page - 1}">← Trước</a>` : '<span></span>'}
      ${hasMore ? `<a class="btn alt sm" href="${base}/orders?page=${page + 1}">Sau →</a>` : ''}</div>` : '';
  return layout('Đơn hàng của tôi', shopName, `
    <div class="hd"><h1>Đơn hàng của tôi</h1><a class="btn alt sm" href="${base}">← Tài khoản</a></div>
    ${okBox(notice)}
    <div class="card"><table><thead><tr><th>Mã đơn</th><th>Ngày đặt</th><th>Tổng tiền</th><th>Trạng thái</th></tr></thead><tbody>${rows}</tbody></table>${pager}</div>
    <div class="card"><h2>Nhận đơn đã đặt trước đây</h2>
      <p class="muted">Nếu bạn từng đặt đơn KHÔNG đăng nhập, nhập <strong>mã đơn</strong> và <strong>mã tra cứu</strong> (trong email/trang xác nhận đơn) để gắn đơn vào tài khoản.</p>
      <form method="POST" action="${base}/claim">
        <div class="row"><div style="flex:1"><label>Mã đơn</label><input name="order_number" inputmode="numeric" required placeholder="123"></div>
        <div style="flex:2"><label>Mã tra cứu</label><input name="token" required placeholder="dán mã tra cứu"></div></div>
        <button class="btn sm" type="submit" style="margin-top:12px">Nhận đơn</button>
      </form></div>`);
}

// ── Yêu thích (0100) ─────────────────────────────────────────────────────────
// Lưới ảnh + giá, mỗi thẻ có nút bỏ thích (chính endpoint toggle). Rỗng thì mời đi xem
// hàng thay vì để trang trắng.
export function renderWishlist(shopName, items) {
  const cards = items.map((p) => {
    const href = `/p/${esc(p.slug)}`;
    const available = Math.max(0, Number(p.available_qty) || 0);
    const price = Math.max(0, Number(p.price_vnd) || 0);
    const basePrice = Math.max(price, Number(p.base_price_vnd) || 0);
    const onSale = basePrice > price;
    const offPct = onSale && Number.isInteger(Number(p.off_pct)) && Number(p.off_pct) > 0
      ? Math.min(100, Number(p.off_pct)) : null;
    const canQuickAdd = !!p.default_variant_id && available > 0;
    const buyAction = canQuickAdd
      ? `<form class="wl-buy" method="POST" action="/cart/add">
          <input type="hidden" name="variant_id" value="${esc(p.default_variant_id)}">
          <input type="hidden" name="qty" value="1">
          <button class="btn sm" type="submit">Thêm vào giỏ</button>
        </form>`
      : `<a class="btn alt sm wl-choose" href="${href}">${available > 0 ? 'Chọn phân loại' : 'Xem sản phẩm'}</a>`;
    return `<div class="wl-card">
      <a class="wl-img" href="/p/${esc(p.slug)}">${p.image_url
        ? `<img src="${esc(p.image_url)}" alt="${esc(p.title)}" loading="lazy">`
        : '<span class="wl-ph">Chưa có ảnh</span>'}</a>
      <a class="wl-name" href="${href}">${esc(p.title)}</a>
      <div class="wl-prices"><strong>${money(price)}</strong>${onSale ? `<del>${money(basePrice)}</del>${offPct ? `<span class="wl-sale">-${offPct}%</span>` : ''}` : ''}</div>
      <div class="wl-stock ${available > 0 ? 'ok-stock' : 'out-stock'}">${available > 0 ? `Còn ${available} sản phẩm` : 'Hết hàng'}</div>
      <div class="wl-actions">${buyAction}<form class="wl-remove" method="POST" action="/account/wishlist/toggle">
        <input type="hidden" name="product_id" value="${esc(p.id)}">
        <button class="btn alt sm" type="submit">♥ Bỏ thích</button>
      </form></div>
    </div>`;
  }).join('');
  return layout('Sản phẩm yêu thích', shopName, `
    <div class="hd"><h1>Sản phẩm yêu thích</h1><a class="btn alt sm" href="/account">← Tài khoản</a></div>
    ${items.length ? `<div class="wl-grid">${cards}</div>`
      : `<div class="card"><p class="muted">Bạn chưa lưu sản phẩm nào. Bấm <strong>♡ Yêu thích</strong> ở trang sản phẩm để lưu lại xem sau.</p>
         <a class="btn sm" href="/products">Xem sản phẩm</a></div>`}
    <style>
      .wl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px}
      .wl-card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:7px;min-width:0}
      .wl-img{display:block;aspect-ratio:1;background:#f3f4f6;border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:center}
      .wl-img img{width:100%;height:100%;object-fit:cover}
      .wl-ph{font-size:.78rem;color:#9ca3af}
      .wl-name{font-size:.9rem;font-weight:600;line-height:1.35;color:#111827;text-decoration:none;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      .wl-prices{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:auto}.wl-prices strong{font-size:1rem}.wl-prices del{font-size:.78rem;color:#9ca3af}.wl-sale{font-size:.72rem;font-weight:700;color:#b91c1c;background:#fee2e2;border-radius:999px;padding:1px 6px}
      .wl-stock{font-size:.78rem;font-weight:600}.ok-stock{color:#047857}.out-stock{color:#b91c1c}
      .wl-actions{display:grid;gap:7px}.wl-buy,.wl-remove{margin:0}.wl-buy .btn,.wl-remove .btn,.wl-choose{width:100%;text-align:center}
    </style>`);
}

// Vận đơn: tên hãng + link tra cứu công khai của hãng.
const carrierName = (c) => ({ ghn: 'GHN', ghtk: 'GHTK' }[String(c ?? '').toLowerCase()] ?? (c || 'Hãng vận chuyển'));
const carrierTrackUrl = (c, code) => {
  if (!code) return null;
  const k = String(c ?? '').toLowerCase();
  if (k === 'ghn') return `https://donhang.ghn.vn/?order_code=${encodeURIComponent(code)}`;
  if (k === 'ghtk') return `https://i.ghtk.vn/?order_code=${encodeURIComponent(code)}`;
  return null;
};
export function renderOrderDetail(shopName, o, lines, shipments = [], {
  requests = [], hasActiveShipment = false, requestError, requestForm = {}, notice, provinces = [],
} = {}) {
  const base = '/account';
  const addr = o.shipping_address && typeof o.shipping_address === 'object' ? o.shipping_address : {};
  const addrStr = [addr.line || addr.line1, addr.ward, addr.district, addr.province].filter(Boolean).join(', ');
  const lineRows = lines.map((l) => `<tr>
      <td>${esc(l.title_snapshot)}${l.sku_snapshot ? ` <span class="muted">${esc(l.sku_snapshot)}</span>` : ''}</td>
      <td class="muted">×${esc(l.qty)}</td><td style="text-align:right">${money(Number(l.unit_price_vnd) * l.qty)}</td></tr>`).join('');
  // ĐƠN ĐÃ ĐÓNG (huỷ / hoàn hàng / hoàn tiền): nhãn tiền trần "Đã thanh toán" ở đây là NỬA
  // SỰ THẬT — đơn bom hàng giữ nguyên payment_status='paid', nên khách đã trả hàng đọc được
  // đúng chữ "Đã trả" đứng cạnh "Đã thanh toán" và không biết tiền đã về hay chưa. Thay nhãn
  // đó bằng khối tiền nói đủ ba con số. Mirror trang tra cứu của checkout — hai đường vào
  // cùng một sự thật phải nói cùng một câu.
  const daDong = ['cancelled', 'refunded', 'returned'].includes(o.status);
  const daTraGi = Number(o.amount_paid_vnd ?? 0) > 0 || Number(o.refunded_vnd ?? 0) > 0;
  const payment = o.payment_summary ?? {
    total_vnd: Number(o.total_vnd ?? 0), received_vnd: Number(o.amount_paid_vnd ?? 0),
    refunded_vnd: Number(o.refunded_vnd ?? 0), amount_due_vnd: Math.max(0, Number(o.total_vnd ?? 0) - Number(o.amount_paid_vnd ?? 0)),
    customer_credit_vnd: 0, display_state: o.payment_status === 'paid' ? 'paid' : 'unpaid',
  };
  const moneyBlock = (daDong && daTraGi) ? `<div class="card">
      <h2>Khoản tiền của đơn này</h2>
      <div class="row"><span class="muted">Bạn đã thanh toán</span><span><strong>${money(o.amount_paid_vnd)}</strong></span></div>
      <div class="row"><span class="muted">Cửa hàng đã hoàn lại</span><span><strong>${money(o.refunded_vnd)}</strong>${o.last_refund_at ? ` <span class="muted">· ${dt(o.last_refund_at)}</span>` : ''}</span></div>
      ${Number(o.owed_vnd ?? 0) > 0
        ? `<div class="row" style="font-weight:700;border-top:1px solid var(--bd);padding-top:8px;margin-top:6px"><span>Cửa hàng còn phải hoàn</span><span>${money(o.owed_vnd)}</span></div>
           <p class="muted" style="margin:10px 0 0">Nếu sau vài ngày làm việc bạn vẫn chưa nhận được, hãy liên hệ cửa hàng kèm số đơn <strong>#${esc(o.order_number)}</strong>.</p>`
        : Number(o.refunded_vnd ?? 0) > 0
        ? '<p class="muted" style="margin:10px 0 0">Cửa hàng đã hoàn đủ khoản bạn thanh toán cho đơn này.</p>'
        : '<p class="muted" style="margin:10px 0 0">Đơn này bạn chưa thanh toán khoản nào nên không có gì phải hoàn.</p>'}
    </div>` : !daDong ? `<div class="card">
      <h2>Thanh toán</h2>
      <div class="row"><span class="muted">Tổng đơn</span><span><strong>${money(payment.total_vnd)}</strong></span></div>
      <div class="row"><span class="muted">Cửa hàng đã nhận</span><span><strong>${money(payment.received_vnd)}</strong></span></div>
      ${payment.refunded_vnd > 0 ? `<div class="row"><span class="muted">Đã hoàn lại</span><span><strong>${money(payment.refunded_vnd)}</strong></span></div>` : ''}
      ${payment.amount_due_vnd > 0
        ? `<div class="row" style="border-top:1px solid var(--bd);padding-top:8px"><span>Còn phải thanh toán</span><span><strong>${money(payment.amount_due_vnd)}</strong></span></div>`
        : '<p style="margin:10px 0 0"><span class="badge">Đã thanh toán đủ</span></p>'}
      ${payment.customer_credit_vnd > 0 ? `<p class="muted">Bạn đã thanh toán dư ${money(payment.customer_credit_vnd)}; cửa hàng sẽ đối soát khoản dư.</p>` : ''}
    </div>` : '';
  const requestTypeLabel = { cancel: 'Huỷ đơn', address_change: 'Đổi địa chỉ giao', return: 'Trả hàng' };
  const requestStatusLabel = { requested: 'Đang chờ cửa hàng', approved: 'Đã chấp thuận', completed: 'Đã xử lý', rejected: 'Không chấp thuận' };
  const requestCards = requests.map((r) => {
    const p = r.request_payload && typeof r.request_payload === 'object' ? r.request_payload : {};
    const address = r.request_type === 'address_change'
      ? `<p class="muted" style="margin:8px 0 0">Địa chỉ đề nghị: ${esc([p.line, p.ward, p.district, p.province].filter(Boolean).join(', '))}<br>${esc(p.recipient_name ?? '')}${p.phone ? ` · ${esc(p.phone)}` : ''}</p>`
      : '';
    const next = r.status === 'approved' && r.request_type === 'return'
      ? '<p class="muted" style="margin:8px 0 0">Cửa hàng đã đồng ý nhận trả. Vui lòng làm theo hướng dẫn của cửa hàng; tồn kho và hoàn tiền chỉ cập nhật sau khi hàng được nhận và kiểm tra.</p>'
      : '';
    return `<div style="padding:12px 0;border-top:1px solid var(--bd)">
      <div class="row"><strong>${esc(requestTypeLabel[r.request_type] ?? r.request_type)}</strong><span class="badge">${esc(requestStatusLabel[r.status] ?? r.status)}</span></div>
      <p class="muted" style="margin:6px 0 0">Gửi ngày ${dt(r.created_at)}${r.reason ? ` · ${esc(r.reason)}` : ''}</p>
      ${address}${r.decision_note ? `<p style="margin:8px 0 0"><strong>Phản hồi cửa hàng:</strong> ${esc(r.decision_note)}</p>` : ''}${next}
    </div>`;
  }).join('');
  const openTypes = new Set(requests.filter((r) => ['requested', 'approved'].includes(r.status)).map((r) => r.request_type));
  const canCancel = ['pending', 'confirmed'].includes(o.status) && !openTypes.has('cancel');
  const canAddress = ['pending', 'confirmed'].includes(o.status) && !hasActiveShipment && !openTypes.has('address_change');
  const canReturn = o.status === 'delivered' && !openTypes.has('return');
  const selectedType = String(requestForm.request_type ?? '');
  const fv = (name, fallback = '') => esc(requestForm[name] != null && requestForm[name] !== '' ? requestForm[name] : fallback);
  const selectedProvince = selectedType === 'address_change' && requestForm.province ? String(requestForm.province) : String(addr.province ?? '');
  const provinceOptions = provinces.map((p) => `<option value="${esc(p)}"${p === selectedProvince ? ' selected' : ''}>${esc(p)}</option>`).join('');
  const requestForms = [
    canCancel ? `<details${selectedType === 'cancel' ? ' open' : ''}><summary>Yêu cầu huỷ đơn</summary>
      <form method="POST" action="${base}/orders/${esc(o.order_number)}/requests" style="margin-top:12px">
        <input type="hidden" name="request_type" value="cancel">
        <label>Lý do muốn huỷ</label><textarea name="reason" maxlength="500" required placeholder="Ví dụ: đặt nhầm sản phẩm">${selectedType === 'cancel' ? fv('reason') : ''}</textarea>
        <button class="btn warn sm" type="submit" style="margin-top:10px">Gửi yêu cầu huỷ</button>
      </form></details>` : '',
    canAddress ? `<details${selectedType === 'address_change' ? ' open' : ''}><summary>Yêu cầu đổi địa chỉ giao</summary>
      <form method="POST" action="${base}/orders/${esc(o.order_number)}/requests" style="margin-top:12px">
        <input type="hidden" name="request_type" value="address_change">
        <label>Người nhận</label><input name="recipient_name" maxlength="120" required value="${selectedType === 'address_change' ? fv('recipient_name', o.customer_name ?? '') : esc(o.customer_name ?? '')}">
        <label>Số điện thoại</label><input name="phone" maxlength="20" inputmode="tel" required value="${selectedType === 'address_change' ? fv('phone', o.customer_phone ?? '') : esc(o.customer_phone ?? '')}">
        <label>Địa chỉ</label><input name="line" maxlength="300" required value="${selectedType === 'address_change' ? fv('line', addr.line ?? addr.line1 ?? '') : esc(addr.line ?? addr.line1 ?? '')}">
        <div class="row"><div style="flex:1"><label>Phường/Xã</label><input name="ward" maxlength="60" value="${selectedType === 'address_change' ? fv('ward', addr.ward ?? '') : esc(addr.ward ?? '')}"></div>
        <div style="flex:1"><label>Quận/Huyện</label><input name="district" maxlength="60" value="${selectedType === 'address_change' ? fv('district', addr.district ?? '') : esc(addr.district ?? '')}"></div></div>
        <label>Tỉnh/Thành phố</label><select name="province" required><option value="">-- Chọn tỉnh/thành --</option>${provinceOptions}</select>
        <label>Ghi chú cho cửa hàng (không bắt buộc)</label><textarea name="reason" maxlength="500">${selectedType === 'address_change' ? fv('reason') : ''}</textarea>
        <button class="btn sm" type="submit" style="margin-top:10px">Gửi địa chỉ mới</button>
      </form></details>` : '',
    canReturn ? `<details${selectedType === 'return' ? ' open' : ''}><summary>Yêu cầu trả hàng</summary>
      <form method="POST" action="${base}/orders/${esc(o.order_number)}/requests" style="margin-top:12px">
        <input type="hidden" name="request_type" value="return">
        <label>Lý do trả hàng</label><textarea name="reason" maxlength="500" required placeholder="Mô tả sản phẩm và vấn đề gặp phải">${selectedType === 'return' ? fv('reason') : ''}</textarea>
        <p class="muted">Gửi yêu cầu không tự hoàn tiền hoặc cộng lại tồn. Cửa hàng sẽ xác nhận và hướng dẫn bước tiếp theo.</p>
        <button class="btn sm" type="submit">Gửi yêu cầu trả hàng</button>
      </form></details>` : '',
  ].filter(Boolean).join('');
  const requestBlock = (requests.length || requestForms || requestError) ? `<div class="card">
      <h2>Yêu cầu hỗ trợ đơn hàng</h2>
      <p class="muted">Bạn gửi yêu cầu trước; cửa hàng sẽ kiểm tra và chấp thuận. Đơn hàng, tiền và tồn kho chưa thay đổi ngay khi bấm gửi.</p>
      ${errBox(requestError)}
      ${requestForms ? `<div class="request-actions">${requestForms}</div>` : ''}
      ${requestCards ? `<div style="margin-top:14px"><strong>Lịch sử yêu cầu</strong>${requestCards}</div>` : ''}
      <style>.request-actions{display:grid;gap:9px}.request-actions details{border:1px solid var(--bd);border-radius:10px;padding:10px 12px}.request-actions summary{cursor:pointer;font-weight:600}.request-actions textarea{min-height:82px}</style>
    </div>` : '';
  return layout(`Đơn #${o.order_number}`, shopName, `
    <div class="hd"><h1>Đơn #${esc(o.order_number)}</h1><a class="btn alt sm" href="${base}/orders">← Danh sách đơn</a></div>
    ${okBox(notice)}
    <div class="card"><p class="muted" style="margin:0">Đặt ngày ${dt(o.created_at)} · <span class="badge">${esc(ORDER_ST[o.status] ?? o.status)}</span>${daDong ? '' : ` <span class="badge">${esc(PAY_ST[o.payment_status] ?? o.payment_status)}</span>`}</p></div>
    ${moneyBlock}
    <div class="card"><h2>Sản phẩm</h2>
      <table><tbody>${lineRows}</tbody></table>
      <div class="row" style="margin-top:10px"><span class="muted">Tạm tính</span><span>${money(o.subtotal_vnd)}</span></div>
      <div class="row"><span class="muted">Phí giao hàng</span><span>${money(o.shipping_vnd)}</span></div>
      ${Number(o.discount_vnd) > 0 ? `<div class="row"><span class="muted">Giảm giá</span><span>-${money(o.discount_vnd)}</span></div>` : ''}
      <div class="row" style="font-weight:700;border-top:1px solid var(--bd);padding-top:8px;margin-top:6px"><span>Tổng cộng</span><span>${money(o.total_vnd)}</span></div></div>
    ${(shipments?.length) ? `<div class="card"><h2>Vận chuyển</h2>
      ${shipments.map((s) => `<div class="row"><span class="muted">${esc(carrierName(s.carrier))}</span><span><strong style="user-select:all">${esc(s.tracking_number)}</strong></span></div>
        ${carrierTrackUrl(s.carrier, s.tracking_number) ? `<a class="btn alt sm" style="margin-top:8px" href="${carrierTrackUrl(s.carrier, s.tracking_number)}" target="_blank" rel="noopener noreferrer">Tra cứu vận đơn ${esc(carrierName(s.carrier))} →</a>` : ''}`).join('')}</div>` : ''}
    ${requestBlock}
    <div class="card"><h2>Giao đến</h2>
      <p class="muted" style="margin:0">${esc(o.customer_name || '(đã ẩn danh)')} · ${esc(o.customer_phone || '')}<br>${esc(addrStr || '—')}</p></div>`);
}

export function renderAddresses(shopName, addresses, provinces, { editing, deleting, form = {}, error } = {}) {
  const base = '/account';
  const opts = (sel) => provinces.map((p) => `<option${p === sel ? ' selected' : ''}>${esc(p)}</option>`).join('');
  const cards = addresses.length ? addresses.map((a) => `<div class="card">
      <div class="row"><div><strong>${esc(a.recipient_name)}</strong> · ${esc(a.phone)}${a.is_default ? ' <span class="badge">Mặc định</span>' : ''}
        <div class="muted" style="font-size:.9rem">${esc([a.line1, a.ward, a.district, a.province].filter(Boolean).join(', '))}</div></div>
        <div class="row" style="gap:6px">
          ${a.is_default ? '' : `<form method="POST" action="${base}/addresses/default" style="margin:0"><input type="hidden" name="id" value="${esc(a.id)}"><button class="btn alt sm" type="submit">Đặt mặc định</button></form>`}
          <a class="btn alt sm" href="${base}/addresses?edit=${esc(a.id)}">Sửa</a>
          <a class="btn warn sm" href="${base}/addresses?delete=${esc(a.id)}#xac-nhan-xoa" aria-label="Xoá địa chỉ của ${esc(a.recipient_name)}">Xoá</a>
        </div></div></div>`).join('') : '<div class="card"><p class="muted" style="margin:0">Chưa có địa chỉ nào.</p></div>';
  const deleteConfirm = deleting ? `<section class="card" id="xac-nhan-xoa" aria-labelledby="xac-nhan-xoa-title">
      <h2 id="xac-nhan-xoa-title">Xác nhận xoá địa chỉ</h2>
      <p>Bạn sắp xoá địa chỉ của <strong>${esc(deleting.recipient_name)}</strong>. Thao tác này không thể hoàn tác.</p>
      <p class="muted">${esc(deleting.phone)}<br>${esc([deleting.line1, deleting.ward, deleting.district, deleting.province].filter(Boolean).join(', '))}</p>
      <form method="POST" action="${base}/addresses/delete">
        <input type="hidden" name="id" value="${esc(deleting.id)}">
        <input type="hidden" name="confirm_delete" value="1">
        <button class="btn warn" type="submit">Xoá địa chỉ này</button>
        <a class="btn alt" href="${base}/addresses">Huỷ</a>
      </form>
    </section>` : '';
  const f = editing || form;
  const formTitle = editing ? 'Sửa địa chỉ' : 'Thêm địa chỉ mới';
  const action = editing ? `${base}/addresses/edit` : `${base}/addresses/add`;
  return layout('Sổ địa chỉ', shopName, `
    <div class="hd"><h1>Sổ địa chỉ</h1><a class="btn alt sm" href="${base}">← Tài khoản</a></div>
    ${errBox(error)}
    ${cards}
    ${deleteConfirm}
    <div class="card"><h2>${formTitle}</h2>
      <form method="POST" action="${action}">
        ${editing ? `<input type="hidden" name="id" value="${esc(editing.id)}">` : ''}
        <div class="row"><div style="flex:1"><label>Người nhận</label><input name="recipient_name" required maxlength="120" value="${esc(f.recipient_name)}"></div>
        <div style="flex:1"><label>Số điện thoại</label><input name="phone" required maxlength="20" value="${esc(f.phone)}"></div></div>
        <label>Địa chỉ (số nhà, đường)</label><input name="line1" required maxlength="200" value="${esc(f.line1)}">
        <div class="row"><div style="flex:1"><label>Phường/Xã</label><input name="ward" maxlength="100" value="${esc(f.ward)}"></div>
        <div style="flex:1"><label>Quận/Huyện</label><input name="district" maxlength="100" value="${esc(f.district)}"></div></div>
        <label>Tỉnh/Thành</label><select name="province"><option value="">— Chọn —</option>${opts(f.province)}</select>
        <label style="display:flex;align-items:center;gap:8px;margin-top:12px"><input type="checkbox" name="is_default" value="1"${f.is_default ? ' checked' : ''} style="width:auto"> Đặt làm địa chỉ mặc định</label>
        <button class="btn" type="submit" style="margin-top:12px">${editing ? 'Lưu thay đổi' : 'Thêm địa chỉ'}</button>
        ${editing ? ` <a class="btn alt" href="${base}/addresses">Huỷ</a>` : ''}
      </form></div>`);
}

export function renderForgot(shopName, { error, sent } = {}) {
  if (sent) return layout('Kiểm tra email', shopName, `
    <h1>Đã gửi hướng dẫn</h1>
    <div class="card"><p>Nếu email này có tài khoản, chúng tôi đã gửi link đặt lại mật khẩu (hết hạn sau 30 phút). Kiểm tra hộp thư (cả spam).</p>
      <p class="muted"><a href="/account/login">← Về đăng nhập</a></p></div>`, { back: 'auth' });
  return layout('Quên mật khẩu', shopName, `
    <h1>Quên mật khẩu</h1>
    <p class="muted">Nhập email tài khoản — chúng tôi gửi link đặt lại mật khẩu.</p>
    ${errBox(error)}
    <div class="card"><form method="POST" action="/account/forgot">
      <label>Email</label><input name="email" type="email" required autocomplete="email">
      <button class="btn" type="submit" style="width:100%;margin-top:14px">Gửi link đặt lại</button>
    </form><p class="muted" style="margin:12px 0 0"><a href="/account/login">← Về đăng nhập</a></p></div>`, { back: 'auth' });
}

export function renderReset(shopName, token, { error, invalid } = {}) {
  if (invalid) return layout('Link không hợp lệ', shopName, `
    <h1>Link đã hết hạn</h1>
    <div class="card"><p>Link đặt lại mật khẩu không hợp lệ hoặc đã hết hạn (dùng một lần, 30 phút).</p>
      <p><a class="btn alt sm" href="/account/forgot">Yêu cầu link mới</a></p></div>`, { back: 'auth' });
  return layout('Đặt mật khẩu mới', shopName, `
    <h1>Đặt mật khẩu mới</h1>
    ${errBox(error)}
    <div class="card"><form method="POST" action="/account/reset">
      <input type="hidden" name="token" value="${esc(token)}">
      <label>Mật khẩu mới (tối thiểu 10 ký tự)</label><input name="password" type="password" required autocomplete="new-password">
      <button class="btn" type="submit" style="width:100%;margin-top:14px">Đổi mật khẩu</button>
    </form><p class="muted" style="margin:8px 0 0">Đổi mật khẩu sẽ đăng xuất khỏi mọi thiết bị.</p></div>`, { back: 'auth' });
}

export function renderVerified(shopName, { ok: okv } = {}) {
  return layout('Xác minh email', shopName, `
    <h1>${okv ? 'Đã xác minh email ✓' : 'Link không hợp lệ'}</h1>
    <div class="card"><p>${okv ? 'Cảm ơn bạn đã xác minh email.' : 'Link xác minh không hợp lệ hoặc đã hết hạn.'}</p>
      <p><a class="btn alt sm" href="/account">Về tài khoản</a></p></div>`, { back: 'auth' });
}

export const _layout = layout;
export { errBox, okBox };
