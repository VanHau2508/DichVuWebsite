/** Trang SSR no-JS cho self-serve signup (0091). Mọi dữ liệu người dùng qua esc(). */
import { esc } from './http.js';

const money = (n) => new Intl.NumberFormat('vi-VN').format(Number(n ?? 0)) + 'đ';

// ── KHUNG HAI PANEL ──────────────────────────────────────────────────────────
// Trái giới thiệu, phải làm việc. Cùng ngôn ngữ với cửa vào của seller-admin (/login,
// /forgot) — người bán đi signup → email → admin thấy MỘT sản phẩm, không phải ba trang
// của ba nơi khác nhau.
//
// BẢNG MÀU: trước đây file này dùng --brand:#2563eb (xanh dương), trong khi admin dùng
// Action Teal #0fa3a3 của docs/44 và landing dùng bảng riêng. Ba nơi ba màu là lý do người
// dùng thấy "chắp vá". Nay theo docs/44.
//
// CSS CỐ Ý CHÉP LẠI, không dùng chung với seller-admin: hai service build từ context riêng
// nên image này KHÔNG có apps/seller-admin. Dùng chung phải qua bind-mount — thêm một phụ
// thuộc VÔ HÌNH (CLAUDE.md §3) cho ~60 dòng CSS của trang gần như không đổi. Đổi lại: sửa
// màu thì phải sửa CẢ HAI nơi. Đánh dấu bằng chuỗi mốc dưới đây để grep ra.
// MỐC-ĐỒNG-BỘ: cua-vao-hai-panel (khớp với .au* trong seller-admin/src/pages.js)
function layout(title, body, { heading = 'Bán hàng online<br><em>không cần biết code</em>', wide = false } = {}) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · Nền Tảng</title>
<style>
  :root{--ink0:#000;--ink:#161823;--mut:#6b6f76;--faint:#9ea1a8;--line:#e4e6e8;--line2:#d0d3d6;
    --pri:#0fa3a3;--prid:#0b8585;--prip:#087272;--wash:#e8f6f6;--card:#fff;--surf:#f5f6f7}
  *{box-sizing:border-box}
  body{margin:0;background:var(--card);color:var(--ink);
    font:16px/1.55 'Be Vietnam Pro',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
  .au{min-height:100vh;display:grid;grid-template-columns:1.05fr .95fr}
  .au-l{background:var(--ink0);color:#fff;padding:48px 52px;display:flex;flex-direction:column;position:relative;overflow:hidden}
  .au-l::before,.au-l::after{content:"";position:absolute;width:340px;height:340px;transform:rotate(45deg);border-radius:64px;opacity:.13;pointer-events:none}
  .au-l::before{background:#25F4EE;right:-150px;top:-90px}
  .au-l::after{background:#FE2C55;right:-60px;bottom:-190px}
  .au-brand{display:inline-flex;align-items:center;gap:11px;font-weight:800;font-size:1.12rem;letter-spacing:-.02em;color:#fff;text-decoration:none;position:relative;z-index:1}
  .au-brand i{width:34px;height:34px;border-radius:9px;background:var(--pri);display:grid;place-items:center;font-style:normal;font-weight:800;color:#fff;flex:none}
  .au-mid{margin:auto 0;padding:40px 0;position:relative;z-index:1}
  .au-mid h2{font-size:clamp(1.7rem,2.6vw,2.4rem);font-weight:800;line-height:1.16;letter-spacing:-.03em;color:#fff;margin:0 0 16px;max-width:15ch}
  .au-mid h2 em{font-style:normal;color:var(--pri)}
  .au-mid p{color:#A7B0B8;font-size:1rem;line-height:1.6;margin:0 0 26px;max-width:42ch}
  .au-pts{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:13px}
  .au-pts li{display:grid;grid-template-columns:auto 1fr;gap:12px;align-items:start;color:#DCE3E8;font-size:.95rem;line-height:1.5}
  .au-pts svg{width:19px;height:19px;color:var(--pri);margin-top:2px;flex:none}
  .au-foot{position:relative;z-index:1;color:#7C868F;font-size:.84rem;border-top:1px solid #23262B;padding-top:18px;margin:0}
  .au-r{display:flex;align-items:center;justify-content:center;padding:40px 32px;overflow-y:auto}
  .au-box{width:100%;max-width:${wide ? '520px' : '400px'}}
  h1{font-size:1.62rem;font-weight:800;letter-spacing:-.025em;margin:0 0 7px}
  .lede{color:var(--mut);font-size:.94rem;line-height:1.55;margin:0 0 26px}
  label{display:block;font-weight:600;font-size:.88rem;margin:0 0 6px}
  label .rq{color:#E8302F}
  input[type=text],input[type=email],input[type=password],input[type=tel],select,textarea{
    width:100%;min-height:46px;padding:12px 14px;font:inherit;font-size:.97rem;color:var(--ink);
    background:var(--card);border:1.5px solid var(--line);border-radius:9px;margin:0 0 16px}
  textarea{min-height:88px;resize:vertical}
  input:focus,select:focus,textarea:focus{outline:none;border-color:var(--pri);box-shadow:0 0 0 3px var(--wash)}
  input:focus-visible,select:focus-visible,textarea:focus-visible,.btn:focus-visible,a:focus-visible{outline:2px solid var(--pri);outline-offset:2px}
  .hint{font-size:.82rem;color:var(--mut);margin:-10px 0 16px}
  .slug-row{display:flex;align-items:stretch;margin:0 0 16px}
  .slug-row input{border-radius:9px 0 0 9px;margin:0}
  .slug-suffix{display:flex;align-items:center;padding:0 13px;border:1.5px solid var(--line);border-left:0;
    border-radius:0 9px 9px 0;background:var(--surf);color:var(--mut);font-size:.92rem;white-space:nowrap}
  .plans{display:grid;gap:10px;margin:0 0 4px}
  .plan{display:flex;align-items:center;gap:11px;border:1.5px solid var(--line);border-radius:10px;padding:13px 15px;cursor:pointer;min-height:46px}
  .plan:has(input:checked){border-color:var(--pri);background:var(--wash)}
  .plan input{width:auto;min-height:0;margin:0}
  .plan .pn{font-weight:700}.plan .pp{margin-left:auto;color:var(--mut);font-size:.9rem}
  .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
  .btn{display:flex;align-items:center;justify-content:center;width:100%;min-height:48px;margin-top:20px;
    padding:13px;border:0;border-radius:9px;background:var(--pri);color:#fff;font:inherit;font-size:1rem;
    font-weight:700;cursor:pointer;text-decoration:none;transition:background .16s ease}
  .btn:hover{background:var(--prid)}.btn:active{background:var(--prip)}
  .btn.alt{background:var(--card);color:var(--ink);border:1.5px solid var(--line)}
  .btn.alt:hover{background:var(--surf);border-color:var(--line2)}
  .err{background:#FFF1F0;border:1px solid #F5C6C4;color:#B3231F;padding:11px 14px;border-radius:9px;margin:0 0 18px;font-size:.92rem}
  .muted{color:var(--mut);font-size:.88rem}
  .foot{margin-top:22px;text-align:center;font-size:.9rem;color:var(--mut)}
  a{color:var(--pri);font-weight:600;text-decoration:none}a:hover{text-decoration:underline}
  .ok-badge{width:52px;height:52px;border-radius:14px;background:var(--wash);color:var(--pri);display:grid;place-items:center;margin-bottom:18px}
  .ok-badge svg{width:26px;height:26px}
  @media(max-width:900px){
    .au{grid-template-columns:1fr;min-height:auto}
    .au-l{padding:28px 24px 30px}
    .au-l::before,.au-l::after{display:none}
    .au-mid{margin:0;padding:22px 0 0}
    .au-mid h2{font-size:1.5rem;max-width:none}
    .au-foot{display:none}
    .au-r{padding:32px 24px 48px}
  }
</style></head><body>
<div class="au">
  <section class="au-l">
    <a class="au-brand" href="/"><i>N</i>Nền Tảng</a>
    <div class="au-mid">
      <h2>${heading}</h2>
      <p>Nền tảng giúp bạn tạo website bán hàng riêng, quản lý đơn — kho — vận chuyển — tiền ở một chỗ.</p>
      <ul class="au-pts">${PTS.map((p) => `<li>${TICK}<span>${esc(p)}</span></li>`).join('')}</ul>
    </div>
    <p class="au-foot">Dùng thử 14 ngày · Không cần thẻ · Không phí thiết lập</p>
  </section>
  <main class="au-r"><div class="au-box">${body}</div></main>
</div></body></html>`;
}

const TICK = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M4 10.5l4 4 8-9"/></svg>`;
// KHÔNG bịa số khách hàng: README §1 ghi rõ chưa có khách thật. Chỉ nêu năng lực có trong mã.
const PTS = [
  'Website riêng + tên miền phụ, dựng xong trong vài phút',
  'Đơn hàng, kho theo biến thể, vận đơn GHN/GHTK một chỗ',
  'COD và VietQR vào thẳng tài khoản ngân hàng của bạn',
  'Sao lưu, HTTPS, giám sát — phần kỹ thuật chúng tôi lo',
];

// Trang đăng ký. plans: [{code,name,price_vnd_month}]. f: dữ liệu đã nhập (giữ khi lỗi). ct: form-ts HMAC.
export function renderSignupForm(plans, { error, f = {}, ct = '', domain = 'nentang.vn', adminUrl } = {}) {
  const admin = adminUrl || `https://admin.${domain}`;
  const chosen = f.plan_code || plans[0]?.code;
  const planHtml = plans.map((p) => `<label class="plan">
      <input type="radio" name="plan_code" value="${esc(p.code)}"${p.code === chosen ? ' checked' : ''} required>
      <span class="pn">${esc(p.name)}</span><span class="pp">${money(p.price_vnd_month)}/tháng</span>
    </label>`).join('');
  return layout('Tạo cửa hàng', `
    <h1>Tạo tài khoản miễn phí</h1>
    <p class="lede">Không cần thẻ tín dụng. Dựng cửa hàng đầu tiên trong vài phút.</p>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    <form method="POST" action="/signup" autocomplete="on">
      <label for="name">Tên cửa hàng <span class="rq">*</span></label>
      <input id="name" name="name" type="text" required maxlength="200" value="${esc(f.name ?? '')}" placeholder="Ví dụ: Nhà Xinh Décor">

      <label for="slug">Địa chỉ cửa hàng</label>
      <div class="slug-row">
        <input id="slug" name="slug" type="text" maxlength="60" value="${esc(f.slug ?? '')}"
          inputmode="url" placeholder="nha-xinh-decor">
        <span class="slug-suffix">.${esc(domain)}</span>
      </div>
      <p class="hint">Đường link khách vào shop. Bỏ trống thì tự lấy theo tên — gõ có dấu cũng được, hệ thống tự bỏ dấu.</p>

      <label for="email">Email <span class="rq">*</span></label>
      <input id="email" name="email" type="email" required maxlength="254" autocomplete="email" value="${esc(f.email ?? '')}" placeholder="ban@email.com">
      <p class="hint">Chúng tôi gửi link kích hoạt vào email này — đó cũng là bước xác thực bạn là chủ tài khoản.</p>

      <label for="password">Mật khẩu <span class="rq">*</span></label>
      <input id="password" name="password" type="password" required autocomplete="new-password">
      <p class="hint">Tối thiểu 10 ký tự.</p>

      <label for="industry">Ngành hàng</label>
      <select id="industry" name="industry">
        <option value="">— Chọn ngành để có sẵn giao diện (tuỳ chọn) —</option>
        <option value="fashion"${f.industry === 'fashion' ? ' selected' : ''}>Thời trang</option>
        <option value="food"${f.industry === 'food' ? ' selected' : ''}>Thực phẩm / Đồ uống</option>
        <option value="furniture"${f.industry === 'furniture' ? ' selected' : ''}>Nội thất</option>
        <option value="cosmetics"${f.industry === 'cosmetics' ? ' selected' : ''}>Mỹ phẩm</option>
        <option value="general"${f.industry === 'general' ? ' selected' : ''}>Khác / Đa ngành</option>
      </select>
      <p class="hint">Shop nhận sẵn màu và bố cục hợp ngành. Đổi lại bất cứ lúc nào trong phần Giao diện.</p>

      <label>Chọn gói <span class="rq">*</span></label>
      <div class="plans">${planHtml}</div>

      <input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
      <input type="hidden" name="ct" value="${esc(ct)}">
      <button class="btn" type="submit">Tạo cửa hàng</button>
    </form>
    <p class="foot">Đã có tài khoản? <a href="${esc(admin)}/login">Đăng nhập</a></p>`,
    { heading: 'Mở cửa hàng<br><em>trong vài phút</em>', wide: true });
}

// Liên hệ hỗ trợ trên trang trung tính — cùng biến môi trường với trang Trợ giúp (docs/46).
// Không đặt ⇒ phần này ẩn, trang vẫn có nút "Thử lại".
const SUP_ZALO = process.env.SUPPORT_ZALO ?? '';
const SUP_PHONE = process.env.SUPPORT_PHONE ?? '';
const SUP_MAIL = process.env.SUPPORT_EMAIL ?? '';

// Trang trung tính SAU khi nộp — GIỐNG HỆT dù email mới / đã tồn tại / bị nuốt (enum-safe).
//
// LỐI THOÁT là phần bắt buộc, không phải trang trí. Trang này cố ý không nói được điều gì đã
// xảy ra (đúng, để không cho ai dò email đã đăng ký). Hệ quả: người bị các hàng rào chống bot
// NUỐT NHẦM sẽ kiểm hộp thư spam, không thấy gì, rồi HẾT ĐƯỜNG — trong khi vẫn tin là đã gửi.
// Với trần 5 nháp/IP/giờ thì gửi lại vài lần còn tự khoá mình thêm một tiếng, cũng im lặng.
//
// Hai lối ra dưới đây KHÔNG làm yếu lớp chống dò email: chúng hiện y hệt cho MỌI người nộp,
// không phụ thuộc email có tồn tại hay không.
export function renderSignupDone(email) {
  const lienHe = [
    SUP_ZALO ? `Zalo <strong>${esc(SUP_ZALO)}</strong>` : '',
    SUP_PHONE ? `<a href="tel:${esc(SUP_PHONE.replace(/\s/g, ''))}">${esc(SUP_PHONE)}</a>` : '',
    SUP_MAIL ? `<a href="mailto:${esc(SUP_MAIL)}">${esc(SUP_MAIL)}</a>` : '',
  ].filter(Boolean).join(' · ');
  return layout('Kiểm tra email', `
    <div class="ok-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="M3 6.5l9 6.5 9-6.5"/></svg></div>
      <h1>Kiểm tra hộp thư</h1>
      <p class="lede">Nếu <strong>${esc(email)}</strong> hợp lệ, chúng tôi vừa gửi một liên kết xác minh.
        Bấm vào liên kết đó để kích hoạt cửa hàng.</p>
      <p class="muted">Không thấy email? Kiểm tra hộp thư spam. Liên kết hết hạn sau 30 phút.</p>
      <p class="foot">Chờ vài phút vẫn chưa thấy? <a href="/signup">Thử lại</a>${
        lienHe ? ` hoặc nhắn cho chúng tôi: ${lienHe}` : ''}.</p>`,
    { heading: 'Còn một bước<br><em>xác thực email</em>' });
}

// Lỗi cứng (hiếm) — không lộ chi tiết hệ thống.
export function renderError(msg) {
  return layout('Lỗi', `<h1>Có lỗi xảy ra</h1><p class="lede">${esc(msg)}</p>
    <p class="foot"><a href="/signup">Thử lại</a></p>`);
}

// Trang XÁC NHẬN verify (GET — KHÔNG side-effect). Bấm nút = POST → provision. token trong hidden field.
export function renderVerifyConfirm(name, slug, token, ct, domain = 'nentang.vn') {
  return layout('Kích hoạt cửa hàng', `
    <h1>Kích hoạt cửa hàng</h1>
      <p class="lede">Xác nhận tạo cửa hàng <strong>${esc(name)}</strong> tại
        <strong>${esc(slug)}.${esc(domain)}</strong>.</p>
      <form method="POST" action="/signup/verify">
        <input type="hidden" name="token" value="${esc(token)}">
        <input type="hidden" name="ct" value="${esc(ct)}">
        <button class="btn" type="submit">Kích hoạt cửa hàng của tôi</button>
      </form>`, { heading: 'Một cú bấm nữa<br><em>là xong</em>' });
}

// Provision xong — KHÔNG auto-login (parity): mời đăng nhập ở admin.
export function renderVerifyDone(name, slug, domain = 'nentang.vn', adminUrl, email) {
  const admin = adminUrl || `https://admin.${domain}`;
  // Trỏ thẳng /login kèm ?email= để ô email điền sẵn — người vừa đăng ký xong không phải nhớ
  // lại mình dùng email nào. (Trỏ vào "/" thì redirect sang /login sẽ ĐÁNH RƠI query.)
  const to = `${admin}/login${email ? `?email=${encodeURIComponent(email)}` : ''}`;
  return layout('Cửa hàng đã sẵn sàng', `
    <div class="ok-badge"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M4 10.5l4 4 8-9"/></svg></div>
      <h1>Cửa hàng đã sẵn sàng</h1>
      <p class="lede"><strong>${esc(name)}</strong> đã được tạo tại
        <a href="https://${esc(slug)}.${esc(domain)}">${esc(slug)}.${esc(domain)}</a>.</p>
      <a class="btn" href="${esc(to)}">Đăng nhập để bắt đầu bán hàng</a>
      <p class="hint" style="margin-top:14px">Chỉ cần nhập mật khẩu bạn vừa đặt lúc đăng ký.</p>`,
    { heading: 'Xong rồi<br><em>mời bạn vào bán hàng</em>' });
}

// Link verify hỏng / đã dùng / hết hạn — TRUNG TÍNH (không phân biệt lý do).
export function renderVerifyInvalid(domain = 'nentang.vn') {
  return layout('Liên kết không hợp lệ', `
    <h1>Liên kết không còn hiệu lực</h1>
    <p class="lede">Liên kết xác minh đã được dùng, hết hạn, hoặc không hợp lệ.</p>
    <p class="foot"><a href="/signup">Đăng ký lại</a></p>`);
}

// Email đã có TÀI KHOẢN đã xác minh — self-serve KHÔNG bind mù (nhánh c acceptInvitation).
export function renderVerifyLoginRequired(domain = 'nentang.vn', adminUrl) {
  const admin = adminUrl || `https://admin.${domain}`;
  return layout('Đăng nhập để tiếp tục', `
    <h1>Email này đã có tài khoản</h1>
      <p class="lede">Email bạn dùng đã có tài khoản trên nền tảng. Vì lý do an toàn, hãy
        <strong>đăng nhập</strong> rồi tạo cửa hàng từ tài khoản của bạn.</p>
    <a class="btn" href="${esc(admin)}/login">Đăng nhập</a>`);
}

// Slug bị người khác lấy giữa lúc đăng ký và kích hoạt (hiếm).
export function renderVerifySlugTaken(domain = 'nentang.vn') {
  return layout('Địa chỉ đã có người dùng', `
    <h1>Địa chỉ cửa hàng vừa bị lấy</h1>
    <p class="lede">Rất tiếc, địa chỉ này vừa được người khác đăng ký. Vui lòng đăng ký lại với tên khác.</p>
    <p class="foot"><a href="/signup">Đăng ký lại</a></p>`);
}
