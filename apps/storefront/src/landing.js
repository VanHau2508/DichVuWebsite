/**
 * Trang CÔNG TY của nền tảng (nentang.vn gốc — không phải shop nào).
 * SSR tĩnh, no-JS, hợp CSP (style-src 'unsafe-inline'). Marketing + bảng giá.
 * Chưa tự-đăng-ký (GĐ5) → CTA = liên hệ concierge. Sửa email/điện thoại qua env.
 */
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const PLANS = [
  { code: 'platform', name: 'Platform', price: '990.000', unit: 'đ/tháng', feat: ['100 sản phẩm', 'Tên miền phụ .nentang.vn', 'COD + QR chuyển khoản', 'Quản lý đơn · tồn kho'], hot: false },
  { code: 'care', name: 'Care', price: '2.490.000', unit: 'đ/tháng', feat: ['100 sản phẩm', 'Tất cả gói Platform', 'Blog & SEO nâng cao', 'Hỗ trợ ưu tiên'], hot: true },
  { code: 'growth', name: 'Growth', price: '5.900.000', unit: 'đ/tháng', feat: ['500 sản phẩm', 'Tất cả gói Care', 'Tên miền riêng của bạn', 'Đối soát QR tự động'], hot: false },
];
const FEATURES = [
  { t: 'Cửa hàng đẹp, chuẩn SEO', d: 'Giao diện hiện đại, tự lên Google với sitemap + dữ liệu có cấu trúc. Khách tìm thấy bạn.' },
  { t: 'Bán hàng dễ như trở tay', d: 'Quản lý sản phẩm, đơn hàng, tồn kho, danh mục — tất cả trong một trang quản trị gọn gàng.' },
  { t: 'Thanh toán tiện lợi', d: 'COD và chuyển khoản QR VietQR. Tiền vào thẳng tài khoản của bạn — chúng tôi không giữ tiền.' },
  { t: 'Chúng tôi lo kỹ thuật', d: 'Máy chủ, bảo mật, sao lưu, cập nhật — bạn không phải đụng tới. Chỉ tập trung bán hàng.' },
];
const STEPS = [
  { n: '1', t: 'Bạn liên hệ', d: 'Cho chúng tôi biết cửa hàng của bạn bán gì.' },
  { n: '2', t: 'Chúng tôi dựng shop', d: 'Tạo website, cấu hình thanh toán, hướng dẫn bạn — trọn gói.' },
  { n: '3', t: 'Bạn bắt đầu bán', d: 'Đăng sản phẩm, nhận đơn, thu tiền. Đơn giản vậy thôi.' },
];

export function renderLanding({ contactEmail = 'lienhe@nentang.vn', contactPhone = '', brand = 'Nền Tảng' } = {}) {
  const contactLine = [contactPhone ? `ĐT: ${esc(contactPhone)}` : '', `Email: ${esc(contactEmail)}`].filter(Boolean).join(' · ');
  const planCard = (p) => `<div class="plan${p.hot ? ' hot' : ''}">
    ${p.hot ? '<div class="plan-badge">Phổ biến</div>' : ''}
    <div class="plan-name">${esc(p.name)}</div>
    <div class="plan-price">${esc(p.price)}<span>${esc(p.unit)}</span></div>
    <ul>${p.feat.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
    <a class="btn ${p.hot ? 'btn-primary' : 'btn-ghost'}" href="mailto:${esc(contactEmail)}?subject=Đăng ký gói ${esc(p.name)}">Chọn gói ${esc(p.name)}</a>
  </div>`;
  const CSS = `*{box-sizing:border-box}:root{--bg:#ffffff;--surf:#f7f9fc;--ink:#0f1729;--soft:#41506b;--mut:#6b7890;--bd:#e6ebf3;--pri:#2463eb;--prid:#1e4bcc;--wash:#eef4ff;--good:#0e9f6e}
@media(prefers-color-scheme:dark){:root{--bg:#0b0f1c;--surf:#121828;--ink:#eef1f9;--soft:#c2cadd;--mut:#8b95ac;--bd:#26304a;--pri:#5b8cff;--prid:#3f74f0;--wash:#17213c}}
body{margin:0;font-family:Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:var(--ink);background:var(--bg);line-height:1.6;-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:0 24px}
a{text-decoration:none;color:inherit}
.nav{display:flex;align-items:center;justify-content:space-between;padding:20px 0}
.logo{font-weight:800;font-size:1.3rem;letter-spacing:-.02em}.logo span{color:var(--pri)}
.nav a.cta{background:var(--pri);color:#fff;padding:9px 18px;border-radius:999px;font-weight:600;font-size:.92rem}
.hero{text-align:center;padding:64px 0 56px}
.eyebrow{display:inline-block;font-size:.8rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--pri);background:var(--wash);padding:6px 14px;border-radius:999px;margin-bottom:20px}
.hero h1{font-size:clamp(2.2rem,6vw,3.6rem);line-height:1.08;letter-spacing:-.03em;font-weight:800;margin:0 0 18px;text-wrap:balance}
.hero p{font-size:clamp(1.05rem,2.4vw,1.3rem);color:var(--soft);max-width:620px;margin:0 auto 30px}
.btn{display:inline-block;padding:14px 30px;border-radius:999px;font-weight:600;font-size:1rem;cursor:pointer;transition:transform .1s,background .12s;border:none}
.btn:active{transform:translateY(1px)}
.btn-primary{background:var(--pri);color:#fff}.btn-primary:hover{background:var(--prid)}
.btn-ghost{background:transparent;color:var(--pri);border:1.5px solid var(--bd)}.btn-ghost:hover{border-color:var(--pri)}
.sec{padding:56px 0}.sec-head{text-align:center;margin-bottom:40px}
.sec-head h2{font-size:clamp(1.6rem,4vw,2.3rem);font-weight:800;letter-spacing:-.02em;margin:0 0 10px;text-wrap:balance}
.sec-head p{color:var(--mut);font-size:1.05rem;margin:0}
.grid{display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}
.feat{background:var(--surf);border:1px solid var(--bd);border-radius:16px;padding:26px}
.feat h3{margin:0 0 8px;font-size:1.12rem;font-weight:700}.feat p{margin:0;color:var(--mut);font-size:.95rem}
.steps{display:grid;gap:22px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));counter-reset:s}
.step{text-align:center}.step .n{width:48px;height:48px;border-radius:50%;background:var(--pri);color:#fff;font-weight:800;font-size:1.2rem;display:grid;place-items:center;margin:0 auto 14px}
.step h3{margin:0 0 6px;font-size:1.1rem}.step p{margin:0;color:var(--mut);font-size:.94rem}
.pricing{background:var(--surf)}
.plans{display:grid;gap:22px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));align-items:start}
.plan{position:relative;background:var(--bg);border:1px solid var(--bd);border-radius:18px;padding:30px 26px;display:flex;flex-direction:column}
.plan.hot{border:2px solid var(--pri);box-shadow:0 18px 40px -20px rgba(36,99,235,.4)}
.plan-badge{position:absolute;top:-13px;left:50%;transform:translateX(-50%);background:var(--pri);color:#fff;font-size:.75rem;font-weight:700;padding:5px 14px;border-radius:999px}
.plan-name{font-weight:700;font-size:1.15rem;color:var(--mut)}
.plan-price{font-size:2.1rem;font-weight:800;letter-spacing:-.02em;margin:6px 0 18px}.plan-price span{font-size:.95rem;font-weight:500;color:var(--mut)}
.plan ul{list-style:none;padding:0;margin:0 0 24px;flex:1}
.plan li{padding:8px 0 8px 26px;position:relative;color:var(--soft);font-size:.95rem;border-bottom:1px solid var(--bd)}
.plan li::before{content:'✓';position:absolute;left:0;color:var(--good);font-weight:800}
.plan .btn{text-align:center}
.cta-final{text-align:center;padding:70px 0}
.cta-final h2{font-size:clamp(1.8rem,4vw,2.6rem);font-weight:800;margin:0 0 14px;letter-spacing:-.02em}
.cta-final p{color:var(--soft);font-size:1.1rem;margin:0 0 26px}
.contact{color:var(--mut);font-size:.95rem;margin-top:16px}
footer{border-top:1px solid var(--bd);padding:30px 0;color:var(--mut);font-size:.88rem;text-align:center}
@media(max-width:640px){.hero{padding:40px 0}}`;
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(brand)} — Dịch vụ website bán hàng trọn gói</title>
<meta name="description" content="Chúng tôi dựng và vận hành website bán hàng chuyên nghiệp cho bạn. Bạn chỉ việc bán — kỹ thuật để chúng tôi lo.">
<style>${CSS}</style></head><body>
<div class="wrap">
  <nav class="nav">
    <div class="logo">${esc(brand)}<span>.</span></div>
    <a class="cta" href="mailto:${esc(contactEmail)}?subject=Tư vấn dịch vụ website">Liên hệ tư vấn</a>
  </nav>
</div>
<header class="hero"><div class="wrap">
  <span class="eyebrow">Dịch vụ website trọn gói</span>
  <h1>Website bán hàng chuyên nghiệp — chúng tôi lo, bạn chỉ việc bán.</h1>
  <p>Bạn mua dịch vụ, nhận ngay một cửa hàng trực tuyến hoàn chỉnh. Không cần biết kỹ thuật — chỉ cập nhật sản phẩm và xử lý đơn.</p>
  <a class="btn btn-primary" href="#bang-gia">Xem bảng giá</a>
</div></header>

<section class="sec"><div class="wrap">
  <div class="sec-head"><h2>Mọi thứ bạn cần để bán hàng online</h2><p>Chúng tôi lo phần khó; bạn tập trung vào khách hàng.</p></div>
  <div class="grid">${FEATURES.map((f) => `<div class="feat"><h3>${esc(f.t)}</h3><p>${esc(f.d)}</p></div>`).join('')}</div>
</div></section>

<section class="sec"><div class="wrap">
  <div class="sec-head"><h2>Bắt đầu trong 3 bước</h2><p>Không cài đặt, không cấu hình — chúng tôi làm cùng bạn.</p></div>
  <div class="steps">${STEPS.map((s) => `<div class="step"><div class="n">${esc(s.n)}</div><h3>${esc(s.t)}</h3><p>${esc(s.d)}</p></div>`).join('')}</div>
</div></section>

<section class="sec pricing" id="bang-gia"><div class="wrap">
  <div class="sec-head"><h2>Bảng giá đơn giản, minh bạch</h2><p>Chọn gói phù hợp — nâng/hạ bất cứ lúc nào.</p></div>
  <div class="plans">${PLANS.map(planCard).join('')}</div>
</div></section>

<section class="cta-final"><div class="wrap">
  <h2>Sẵn sàng mở cửa hàng?</h2>
  <p>Liên hệ để chúng tôi dựng website cho bạn — thường trong vài ngày.</p>
  <a class="btn btn-primary" href="mailto:${esc(contactEmail)}?subject=Tôi muốn mở cửa hàng">Liên hệ ngay</a>
  <div class="contact">${contactLine}</div>
</div></section>

<footer><div class="wrap">© ${esc(brand)} · Dịch vụ website bán hàng trọn gói cho người Việt.</div></footer>
</body></html>`;
}
