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
input,select{width:100%;padding:9px 11px;border:1px solid var(--bd);border-radius:8px;font-size:1rem;background:#fff}
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

export function renderLogin(shopName, { error, notice } = {}) {
  return layout('Đăng nhập', shopName, `
    <h1>Đăng nhập</h1>
    <p class="muted">Tài khoản của bạn tại ${esc(shopName || 'cửa hàng')} — theo dõi đơn hàng & sổ địa chỉ.</p>
    ${okBox(notice)}${errBox(error)}
    <div class="card"><form method="POST" action="/account/login">
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

export function renderDashboard(shopName, cust, { notice } = {}) {
  const base = '/account';
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
    </div>`);
}

export const _layout = layout;
export { errBox, okBox };
