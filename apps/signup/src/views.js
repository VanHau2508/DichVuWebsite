/** Trang SSR no-JS cho self-serve signup (0091). Mọi dữ liệu người dùng qua esc(). */
import { esc } from './http.js';

const money = (n) => new Intl.NumberFormat('vi-VN').format(Number(n ?? 0)) + 'đ';

function layout(title, body) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · nền tảng</title>
<style>
  :root { --ink:#1f2430; --muted:#6b7280; --line:#e5e7eb; --brand:#2563eb; --bg:#f7f8fa; }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink);
    font:16px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif; }
  .wrap { max-width:520px; margin:0 auto; padding:32px 20px 64px; }
  h1 { font-size:1.6rem; margin:0 0 4px; } .lede { color:var(--muted); margin:0 0 24px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:14px; padding:22px; }
  label { display:block; font-weight:600; font-size:.92rem; margin:14px 0 5px; }
  input[type=text],input[type=email],input[type=password] { width:100%; padding:11px 12px;
    border:1px solid var(--line); border-radius:9px; font-size:1rem; }
  input:focus { outline:2px solid var(--brand); border-color:var(--brand); }
  .slug-row { display:flex; align-items:center; gap:0; }
  .slug-row input { border-radius:9px 0 0 9px; }
  .slug-suffix { padding:11px 12px; border:1px solid var(--line); border-left:0; border-radius:0 9px 9px 0;
    background:#f3f4f6; color:var(--muted); font-size:.95rem; white-space:nowrap; }
  .plans { display:grid; gap:10px; margin-top:6px; }
  .plan { display:flex; align-items:center; gap:11px; border:1px solid var(--line); border-radius:11px;
    padding:12px 14px; cursor:pointer; }
  .plan:has(input:checked) { border-color:var(--brand); box-shadow:0 0 0 1px var(--brand) inset; background:#eff5ff; }
  .plan input { width:auto; margin:0; } .plan .pn { font-weight:700; } .plan .pp { margin-left:auto; color:var(--muted); }
  .hp { position:absolute; left:-9999px; width:1px; height:1px; overflow:hidden; }
  .btn { display:block; width:100%; margin-top:22px; padding:13px; border:0; border-radius:10px;
    background:var(--brand); color:#fff; font-size:1.05rem; font-weight:700; cursor:pointer; }
  .err { background:#fef2f2; border:1px solid #fecaca; color:#991b1b; padding:11px 14px;
    border-radius:10px; margin-bottom:16px; font-size:.93rem; }
  .ok-hero { text-align:center; padding:8px 0 4px; } .ok-hero .big { font-size:2.6rem; }
  .muted { color:var(--muted); font-size:.9rem; } .foot { margin-top:22px; text-align:center; }
  a { color:var(--brand); }
</style></head><body><div class="wrap">${body}</div></body></html>`;
}

// Trang đăng ký. plans: [{code,name,price_vnd_month}]. f: dữ liệu đã nhập (giữ khi lỗi). ct: form-ts HMAC.
export function renderSignupForm(plans, { error, f = {}, ct = '', domain = 'nentang.vn' } = {}) {
  const chosen = f.plan_code || plans[0]?.code;
  const planHtml = plans.map((p) => `<label class="plan">
      <input type="radio" name="plan_code" value="${esc(p.code)}"${p.code === chosen ? ' checked' : ''} required>
      <span class="pn">${esc(p.name)}</span><span class="pp">${money(p.price_vnd_month)}/tháng</span>
    </label>`).join('');
  return layout('Tạo cửa hàng', `
    <h1>Tạo cửa hàng của bạn</h1>
    <p class="lede">Mở gian hàng online trong 1 phút — dùng thử miễn phí, không cần thẻ.</p>
    <div class="card">
      ${error ? `<div class="err">${esc(error)}</div>` : ''}
      <form method="POST" action="/signup" autocomplete="on">
        <label for="name">Tên cửa hàng</label>
        <input id="name" name="name" type="text" required maxlength="200" value="${esc(f.name ?? '')}" placeholder="Nhà Xinh Décor">

        <label for="slug">Địa chỉ cửa hàng</label>
        <div class="slug-row">
          <input id="slug" name="slug" type="text" required maxlength="40" value="${esc(f.slug ?? '')}"
            inputmode="url" placeholder="nha-xinh" pattern="[a-z0-9][a-z0-9-]*[a-z0-9]">
          <span class="slug-suffix">.${esc(domain)}</span>
        </div>
        <p class="muted" style="margin:5px 0 0">Chỉ chữ thường, số và gạch ngang. Đây là đường link khách vào shop.</p>

        <label for="email">Email</label>
        <input id="email" name="email" type="email" required maxlength="254" autocomplete="email" value="${esc(f.email ?? '')}" placeholder="ban@email.com">

        <label for="password">Mật khẩu</label>
        <input id="password" name="password" type="password" required autocomplete="new-password" placeholder="ít nhất 10 ký tự">

        <label>Chọn gói</label>
        <div class="plans">${planHtml}</div>

        <input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
        <input type="hidden" name="ct" value="${esc(ct)}">
        <button class="btn" type="submit">Tạo cửa hàng</button>
      </form>
    </div>
    <p class="foot muted">Đã có tài khoản? <a href="https://admin.${esc(domain)}/">Đăng nhập</a></p>`);
}

// Trang trung tính SAU khi nộp — GIỐNG HỆT dù email mới / đã tồn tại / bị nuốt (enum-safe).
export function renderSignupDone(email) {
  return layout('Kiểm tra email', `
    <div class="card ok-hero">
      <div class="big">📬</div>
      <h1>Kiểm tra email của bạn</h1>
      <p class="lede">Nếu <strong>${esc(email)}</strong> hợp lệ, chúng tôi vừa gửi một liên kết xác minh.
        Bấm vào liên kết đó để kích hoạt cửa hàng.</p>
      <p class="muted">Không thấy email? Kiểm tra hộp thư spam. Liên kết hết hạn sau 30 phút.</p>
    </div>`);
}

// Lỗi cứng (hiếm) — không lộ chi tiết hệ thống.
export function renderError(msg) {
  return layout('Lỗi', `<div class="card"><h1>Có lỗi xảy ra</h1><p class="lede">${esc(msg)}</p>
    <p class="foot"><a href="/signup">Thử lại</a></p></div>`);
}
