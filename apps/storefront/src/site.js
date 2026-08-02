/**
 * Khung dùng chung cho TRANG CÔNG TY của nền tảng (nentang.vn): CSS nền, thanh điều
 * hướng, chân trang, và bộ icon SVG nội tuyến. landing.js + company.js đều import từ đây
 * để nav/footer/giao diện ĐỒNG NHẤT trên mọi trang (đổi 1 chỗ, cả site đổi theo).
 *
 * SSR tĩnh, KHÔNG JavaScript, hợp CSP nghiêm (img-src 'self' data:). Mọi "ảnh" là SVG
 * nội tuyến + gradient CSS — không tải tài nguyên ngoài.
 */
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
export const mailtoHref = (email, subject) => `mailto:${esc(email)}?subject=${encodeURIComponent(subject)}`;

// ── Icon SVG nội tuyến (markup → hợp CSP). stroke currentColor để đổi màu theo ngữ cảnh ──
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
export const I = {
  store: ic('<path d="M3 9l1.6-5h14.8L21 9"/><path d="M5 9v10h14V9"/><path d="M3 9h18"/><path d="M9 19v-6h6v6"/>'),
  cart: ic('<circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/><path d="M2 3h2.2l2.3 12.2a1 1 0 0 0 1 .8h8.6a1 1 0 0 0 1-.8L20 7H5.5"/>'),
  seo: ic('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><path d="M8 11h6M11 8v6"/>'),
  wallet: ic('<path d="M3 7a2 2 0 0 1 2-2h13v4"/><path d="M3 7v10a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-3"/><path d="M21 11v4h-4a2 2 0 0 1 0-4z"/>'),
  shield: ic('<path d="M12 3l8 3v5c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"/><path d="M9 12l2 2 4-4"/>'),
  chart: ic('<path d="M4 20V4"/><path d="M4 20h16"/><rect x="7" y="12" width="3" height="5" rx=".5"/><rect x="12" y="8" width="3" height="9" rx=".5"/><rect x="17" y="5" width="3" height="12" rx=".5"/>'),
  headset: ic('<path d="M4 13v-1a8 8 0 0 1 16 0v1"/><path d="M4 13a2 2 0 0 1 2 2v2a2 2 0 0 1-4 0v-2a2 2 0 0 1 2-2z"/><path d="M20 13a2 2 0 0 1 2 2v2a2 2 0 0 1-4 0v-2a2 2 0 0 1 2-2z"/><path d="M20 17v1a4 4 0 0 1-4 4h-3"/>'),
  bolt: ic('<path d="M13 2L4 14h6l-1 8 9-12h-6z"/>'),
  check: ic('<path d="M20 6L9 17l-5-5"/>'),
  arrow: ic('<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>'),
  phone: ic('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.4-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>'),
  mail: ic('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>'),
  book: ic('<path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z"/><path d="M4 19a2 2 0 0 0 2 2h12"/><path d="M9 7h6"/>'),
  rocket: ic('<path d="M5 15c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.8-.8.8-2 0-3s-2.2-.8-3 0z"/><path d="M9 12c6-8 11-8 11-8s0 5-8 11"/><path d="M15 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/><path d="M9 12l3 3"/>'),
  spark: ic('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>'),
  chat: ic('<path d="M21 12a8 8 0 0 1-11.3 7.3L3 21l1.7-6.7A8 8 0 1 1 21 12z"/>'),
  doc: ic('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/>'),
  tag: ic('<path d="M3 7v5.6a2 2 0 0 0 .6 1.4l7 7a2 2 0 0 0 2.8 0l5.6-5.6a2 2 0 0 0 0-2.8l-7-7A2 2 0 0 0 12.6 5H7a4 4 0 0 0-4 4z"/><circle cx="7.5" cy="9.5" r="1.3"/>'),
  clock: ic('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  // ── icon ngành hàng ──
  shirt: ic('<path d="M8 3l4 2.4L16 3l4 2.6-2.6 3.2L16 8v12H8V8l-1.4.8L4 5.6z"/>'),
  sofa: ic('<path d="M4 11V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3"/><path d="M2 12a2 2 0 0 1 2 2v3h16v-3a2 2 0 0 1 4 0"/><path d="M4 12a2 2 0 0 1 4 0v2M20 12a2 2 0 0 0-4 0v2"/><path d="M4 19v2M20 19v2"/>'),
  cosmetic: ic('<path d="M9 3h4v5H9z"/><path d="M8 8h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z"/><path d="M6 13h10"/>'),
  device: ic('<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>'),
  baby: ic('<circle cx="12" cy="9" r="4"/><path d="M9 8h.01M15 8h.01M10 11a3 3 0 0 0 4 0"/><path d="M5 21a7 7 0 0 1 14 0"/>'),
  food: ic('<path d="M4 11h16a8 8 0 0 1-16 0z"/><path d="M6 11c0-3 2-4 2-6M12 11c0-3 2-4 2-6M18 11c0-3 0-3 0-5"/><path d="M3 20h18"/>'),
  gift: ic('<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v9h14v-9"/><path d="M12 8v13"/><path d="M12 8S10.5 3 8.5 3 6 6 8 8m4 0s1.5-5 3.5-5S18 6 16 8"/>'),
  // ── icon nghiệp vụ (landing v2) ──
  truck: ic('<path d="M1 6h12v10H1z"/><path d="M13 9h4l3 3v4h-7"/><circle cx="5.5" cy="17.5" r="1.7"/><circle cx="16.5" cy="17.5" r="1.7"/>'),
  box: ic('<path d="M12 2l8 4.5v11L12 22l-8-4.5v-11z"/><path d="M12 22V11"/><path d="M4 6.5l8 4.5 8-4.5"/>'),
  users: ic('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5a3.5 3.5 0 0 1 0 7"/><path d="M17.5 14a6.5 6.5 0 0 1 4 6"/>'),
  star: ic('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>'),
  percent: ic('<path d="M19 5L5 19"/><circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/>'),
  qr: ic('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3z"/><path d="M21 14v4"/><path d="M14 21h4"/><path d="M19 19h2v2h-2z"/>'),
  bell: ic('<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 19a2.2 2.2 0 0 0 4 0"/>'),
  palette: ic('<path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-.8 2-1.8 0-.9-.6-1.4-.6-2.2 0-1 .8-1.8 2-1.8H17a4 4 0 0 0 4-4c0-4.5-4-8.2-9-8.2z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="10.5" cy="7.5" r="1"/><circle cx="14.8" cy="8" r="1"/>'),
  coffee: ic('<path d="M4 9h12v6a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5z"/><path d="M16 10h2a3 3 0 0 1 0 6h-2"/><path d="M7 2c0 1.2-1 1.6-1 3M11 2c0 1.2-1 1.6-1 3"/>'),
  dumbbell: ic('<path d="M7 8v8M17 8v8"/><rect x="3.2" y="10" width="2.4" height="4" rx=".6"/><rect x="18.4" y="10" width="2.4" height="4" rx=".6"/><path d="M7 12h10"/>'),
  paw: ic('<circle cx="7" cy="8.5" r="1.7"/><circle cx="12" cy="6.5" r="1.7"/><circle cx="17" cy="8.5" r="1.7"/><path d="M12 11c-3 0-6 2.6-6 5.2 0 1.6 1.2 2.8 2.8 2.8 1.2 0 2-.6 3.2-.6s2 .6 3.2.6c1.6 0 2.8-1.2 2.8-2.8C18 13.6 15 11 12 11z"/>'),
  gem: ic('<path d="M6 3h12l4 6-10 12L2 9z"/><path d="M2 9h20"/><path d="M12 21L8 9M12 21l4-12"/>'),
  // ── icon landing v3 ──
  user: ic('<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>'),
  pin: ic('<path d="M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z"/><circle cx="12" cy="10" r="2.6"/>'),
};

// Phông Be Vietnam Pro (giấy phép OFL) TỰ-HOST: @font-face trỏ /fonts/*.woff2 — storefront
// phục vụ same-origin nên CSP font-src 'self' cho phép (KHÔNG tải CDN ngoài). font-display:swap
// → hiện chữ ngay bằng phông hệ thống rồi đổi sang. Xuất khẩu để theme.js (shop) dùng chung.
export const FONTFACE = `@font-face{font-family:'Be Vietnam Pro';font-style:normal;font-weight:400;font-display:swap;src:url(/fonts/bevietnampro-400-vietnamese.woff2) format('woff2');unicode-range:U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB}
@font-face{font-family:'Be Vietnam Pro';font-style:normal;font-weight:400;font-display:swap;src:url(/fonts/bevietnampro-400-latin-ext.woff2) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:'Be Vietnam Pro';font-style:normal;font-weight:400;font-display:swap;src:url(/fonts/bevietnampro-400-latin.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:'Be Vietnam Pro';font-style:normal;font-weight:600;font-display:swap;src:url(/fonts/bevietnampro-600-vietnamese.woff2) format('woff2');unicode-range:U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB}
@font-face{font-family:'Be Vietnam Pro';font-style:normal;font-weight:600;font-display:swap;src:url(/fonts/bevietnampro-600-latin-ext.woff2) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:'Be Vietnam Pro';font-style:normal;font-weight:600;font-display:swap;src:url(/fonts/bevietnampro-600-latin.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:'Be Vietnam Pro';font-style:normal;font-weight:800;font-display:swap;src:url(/fonts/bevietnampro-800-vietnamese.woff2) format('woff2');unicode-range:U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB}
@font-face{font-family:'Be Vietnam Pro';font-style:normal;font-weight:800;font-display:swap;src:url(/fonts/bevietnampro-800-latin-ext.woff2) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:'Be Vietnam Pro';font-style:normal;font-weight:800;font-display:swap;src:url(/fonts/bevietnampro-800-latin.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}`;

// ── CSS nền dùng chung (biến màu, nút, nav, footer, section, FAQ, typography bài viết) ──
export const BASE_CSS = `${FONTFACE}
*{box-sizing:border-box}
/* PALETTE ẤM VIỆT (Haravan/Sapo): đỏ gạch/coral làm ĐIỂM NHẤN DUY NHẤT, nền kem ấm,
   mực nâu sâu, xám ấm phụ; 1 dải kem-đào cho section xen kẽ; xanh tin-cậy chỉ dùng cho
   điểm "tiền/an toàn". TUYỆT ĐỐI không tím/xanh-tím. --pri2 = coral-cam ấm, chỉ còn dùng
   cho DUY NHẤT một gradient nhẹ trên nút CTA chính. */
:root{--bg:#F5F9FD;--surf:#E7F1FB;--card:#ffffff;--ink:#13202E;--soft:#3A4959;--mut:#667789;--bd:#DAE6F1;--pri:#0E6DBE;--prid:#0A5495;--pri2:#1E93D6;--brand:#0E6DBE;--brand2:#1E93D6;--brandd:#0A5495;--wash:#E7F1FB;--good:#16A34A}
@media(prefers-color-scheme:dark){:root{--bg:#0E1621;--surf:#15212D;--card:#16222E;--ink:#EAF2FA;--soft:#C4D3E0;--mut:#8B9CAD;--bd:#26343F;--pri:#3BA6EC;--prid:#64BCF2;--pri2:#52B6EE;--brand:#3BA6EC;--brand2:#52B6EE;--brandd:#64BCF2;--wash:#15212D;--good:#34D399}}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;font-family:'Be Vietnam Pro',system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg);line-height:1.6;-webkit-font-smoothing:antialiased}
a{text-decoration:none;color:inherit}svg{display:block}
.wrap{max-width:1140px;margin:0 auto;padding:0 24px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:13px 26px;border-radius:12px;font-weight:600;font-size:1rem;cursor:pointer;border:1.5px solid transparent;transition:transform .1s,background .14s,box-shadow .14s;white-space:nowrap}
.btn svg{width:18px;height:18px}.btn:active{transform:translateY(1px)}
.btn-primary{background:var(--brand);color:#fff;box-shadow:0 8px 20px -8px var(--brand)}.btn-primary:hover{background:var(--brandd)}
.btn-ghost{background:var(--card);color:var(--ink);border-color:color-mix(in srgb,var(--pri) 32%,var(--bd))}.btn-ghost:hover{border-color:var(--pri);color:var(--pri)}
.btn-block{width:100%}
.btn-lg{padding:15px 30px;font-size:1.06rem;border-radius:14px}
.btn-sm{padding:10px 18px;font-size:.92rem}
.btn-cta{background:linear-gradient(135deg,var(--brand),var(--pri2));background-size:170% 170%;color:#fff;box-shadow:0 10px 24px -10px color-mix(in srgb,var(--pri) 75%,transparent);transition:transform .1s,background-position .3s,box-shadow .2s}
.btn-cta:hover{background-position:100% 0;box-shadow:0 14px 30px -10px color-mix(in srgb,var(--pri) 80%,transparent)}
.btn-cta .btn-arrow{transition:transform .18s}.btn-cta:hover .btn-arrow{transform:translateX(3px)}
.nav{position:sticky;top:0;z-index:40;background:var(--bg);border-bottom:1px solid var(--bd)}
.nav .wrap{display:flex;align-items:center;justify-content:space-between;height:66px;gap:20px}
.logo{display:inline-flex;align-items:center;gap:9px;font-weight:800;font-size:1.28rem;letter-spacing:-.02em}
.logo .mk{width:30px;height:30px;border-radius:9px;background:var(--pri);color:#fff;display:grid;place-items:center}.logo .mk svg{width:18px;height:18px}
.logo b{color:var(--pri)}
.nav-links{display:flex;gap:26px;font-size:.95rem;font-weight:500;color:var(--soft)}
.nav-links a:hover,.nav-links a.on{color:var(--pri)}
.nav-act{display:flex;align-items:center;gap:16px}
.nav-login{display:inline-flex;align-items:center;gap:7px;font-weight:600;font-size:.95rem;color:var(--soft)}
.nav-login svg{width:17px;height:17px}.nav-login:hover{color:var(--pri)}
@media(max-width:900px){.nav-links{display:none}}
@media(max-width:520px){.nav .wrap{gap:10px}.btn{padding:11px 16px}.nav-login span{display:none}}
.sec{padding:76px 0}
.sec-head{text-align:center;max-width:680px;margin:0 auto 46px}
.sec-head .kick{font-size:.82rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--pri);margin:0 0 10px}
.sec-head h2{font-size:clamp(1.7rem,3.6vw,2.5rem);font-weight:800;letter-spacing:-.02em;margin:0 0 12px;text-wrap:balance}
.sec-head p{color:var(--mut);font-size:1.06rem;margin:0}
.eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:.8rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--prid);background:color-mix(in srgb,var(--pri) 16%,var(--bg));padding:7px 15px;border-radius:999px;margin:0 0 20px}
.eyebrow svg{width:15px;height:15px}
.page-hero{position:relative;overflow:hidden;isolation:isolate;text-align:center;padding:72px 0 12px;background:var(--surf);border-bottom:1px solid var(--bd)}
.page-hero .wrap{position:relative;z-index:1}
.page-hero h1{font-size:clamp(2rem,4.2vw,3.1rem);font-weight:800;letter-spacing:-.025em;line-height:1.12;margin:0 0 14px;text-wrap:balance}
.page-hero h1 .g{color:var(--pri)}
.page-hero .sub{color:var(--mut);font-size:1.12rem;max-width:620px;margin:0 auto;text-wrap:balance}
.content{max-width:760px;margin:0 auto}
.content h2{font-size:1.5rem;font-weight:800;letter-spacing:-.01em;margin:1.9em 0 .5em}
.content h2:first-child{margin-top:0}
.content h3{font-size:1.18rem;font-weight:700;margin:1.5em 0 .4em}
.content p{color:var(--soft);line-height:1.85;margin:0 0 1.1em}
.content ul{color:var(--soft);line-height:1.8;padding-left:1.3em;margin:0 0 1.2em}
.content li{margin-bottom:.55em}
.content a{color:var(--pri);font-weight:600}.content a:hover{text-decoration:underline}
.content blockquote{margin:1.6em 0;padding:.4em 0 .4em 1.2em;border-left:3px solid var(--pri);color:var(--mut);font-style:italic}
.faq{max-width:780px;margin:0 auto}
.faq details{border:1px solid var(--bd);border-radius:14px;background:var(--card);margin-bottom:12px;overflow:hidden}
.faq details[open]{border-color:color-mix(in srgb,var(--pri) 40%,var(--bd))}
.faq summary{padding:18px 22px;font-weight:600;font-size:1.04rem;cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:16px}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";font-size:1.5rem;font-weight:400;color:var(--pri);line-height:1;transition:transform .2s}
.faq details[open] summary::after{content:"−"}
.faq .ans{padding:0 22px 20px;color:var(--mut);line-height:1.75}
.cta-final{padding:20px 0 84px}
.cta-box{background:var(--pri);border-radius:24px;padding:60px 40px;text-align:center;color:#fff;position:relative;overflow:hidden}
.cta-box h2{font-size:clamp(1.8rem,4vw,2.7rem);font-weight:800;margin:0 0 14px;letter-spacing:-.02em;position:relative}
.cta-box p{font-size:1.12rem;opacity:.94;margin:0 0 28px;position:relative}
.cta-box .btn{position:relative}
.cta-box .btn-primary{background:#fff;color:var(--pri);box-shadow:0 12px 30px -10px rgba(0,0,0,.28)}.cta-box .btn-primary:hover{background:#E7F1FB}
.cta-contact{margin-top:18px;font-size:.95rem;opacity:.9;position:relative}
footer{background:var(--surf);border-top:1px solid var(--bd);padding:60px 0 30px}
.ft-grid{display:grid;grid-template-columns:1.9fr 1fr 1fr 1.1fr .9fr;gap:34px;margin-bottom:42px}
.ft-about{max-width:320px}.ft-about .logo{margin-bottom:14px}.ft-about p{color:var(--mut);font-size:.92rem;margin:0 0 18px}
.ft-col h3{font-size:.82rem;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:0 0 14px;font-weight:700}
.ft-col a,.ft-col span{display:flex;align-items:center;gap:8px;color:var(--soft);font-size:.94rem;margin-bottom:10px}.ft-col a:hover{color:var(--pri)}
.ft-col svg{width:16px;height:16px;flex:none}
.ft-bottom{border-top:1px solid var(--bd);padding-top:24px;display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;color:var(--mut);font-size:.88rem}
.ft-bottom a{color:var(--soft)}.ft-bottom a:hover{color:var(--pri)}
@media(max-width:960px){.ft-grid{grid-template-columns:1fr 1fr}}
@media(max-width:680px){.sec{padding:56px 0}.ft-grid{grid-template-columns:1fr;gap:26px}.ft-bottom{justify-content:center;text-align:center}}

/* ── VÙNG BẤM trên điện thoại (site công ty) ─────────────────────────────────
   Cùng lớp lỗi đã vá ở theme.js, nhưng trang GIỚI THIỆU NỀN TẢNG dùng file này nên bản vá
   kia không với tới — và đây lại là trang ĐẦU TIÊN một chủ shop tiềm năng nhìn thấy.
   Đo ở 375×812 bằng engine trình duyệt thật: link "Đăng nhập" ở header còn 17×17 (vì ≤520px
   giấu chữ, chỉ còn icon), 19 link chân trang cao 24px. Ngón tay cần ~44px.
   Chỉ nới vùng bấm, không phóng to phần nhìn thấy. */
@media(max-width:820px){
  .nav-login{min-width:44px;min-height:44px;justify-content:center}
  .ft-col a,.ft-col span{min-height:44px;margin-bottom:2px}
  .ft-bottom a{display:inline-flex;align-items:center;min-height:44px;padding:0 6px}
}
/* Tên thương hiệu ở header KHÔNG được xuống dòng.
   Nhìn bằng mắt ở 375px mới thấy: "Nền Tảng." rớt thành hai dòng ("Nền" / "Tảng."), header
   phình lên 67px và dấu chấm — vốn là nét nhận diện — bị tách ra trông như lỗi hiển thị.
   Không phép đo nào trong bộ kiểm toán bắt được: không tràn ngang, không chữ bị cắt, vùng
   bấm vẫn đủ. Chỉ ẢNH CHỤP mới lộ. Cùng lớp bug đã vá cho .brand ở theme.js, khác file. */
@media(max-width:520px){
  .nav .logo{white-space:nowrap;font-size:1.14rem;gap:7px;min-width:0}
  .nav .logo .mk{width:26px;height:26px;flex:none}
}
a:focus-visible,.btn:focus-visible,summary:focus-visible,.ind:focus-visible,details:focus-visible{outline:3px solid var(--pri);outline-offset:2px;border-radius:8px}
.skip{position:absolute;left:12px;top:-70px;z-index:60;background:var(--brand);color:#fff;padding:11px 18px;border-radius:10px;font-weight:600;transition:top .16s}
.skip:focus{top:12px}
/* Tiết lộ khi cuộn (dùng chung cho landing + trang công ty) — CHỈ bật khi trình duyệt HỖ TRỢ
   scroll-timeline & KHÔNG giảm chuyển động. Nếu không hỗ trợ/giảm chuyển động: nội dung HIỆN
   đầy đủ (opacity mặc định = 1, không kẹt ẩn). Quả cầu phát sáng trôi nhẹ ở .page-hero. */
@media(prefers-reduced-motion:no-preference){@supports(animation-timeline:view()){
.reveal{opacity:0;transform:translateY(42px);animation:reveal-in both;animation-timeline:view();animation-range:entry 4% cover 32%}
@keyframes reveal-in{to{opacity:1;transform:none}}
}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important;animation:none!important}}`;

// Liên kết điều hướng — TUYỆT ĐỐI (/#...) để dùng chung mọi trang; ở "/" trình duyệt chỉ
// cuộn tới mục, không tải lại. `active` tô đậm mục của trang hiện tại.
const NAV_ITEMS = [
  { href: '/#tinh-nang', label: 'Tính năng', key: 'features' },
  { href: '/#nganh-hang', label: 'Ngành hàng', key: 'industries' },
  { href: '/#bang-gia', label: 'Bảng giá', key: 'pricing' },
  { href: '/ho-tro', label: 'Hỗ trợ', key: 'support' },
  { href: '/blog', label: 'Blog', key: 'blog' },
];
// URL đăng nhập quản trị (host cố định) + đăng ký tự phục vụ (Caddy: /signup* → service signup).
export const ADMIN_LOGIN_URL = 'https://admin.nentang.vn';
export const SIGNUP_URL = '/signup';

export function siteNav(brand, contactEmail, active = '') {
  const links = NAV_ITEMS.map((n) => `<a href="${n.href}"${n.key === active ? ' class="on"' : ''}>${esc(n.label)}</a>`).join('');
  return `<nav class="nav"><div class="wrap">
    <a class="logo" href="/"><span class="mk">${I.store}</span>${esc(brand)}<b>.</b></a>
    <div class="nav-links">${links}</div>
    <div class="nav-act">
      <a class="nav-login" href="${ADMIN_LOGIN_URL}">${I.user}<span>Đăng nhập</span></a>
      <a class="btn btn-cta" href="${SIGNUP_URL}">Bắt đầu miễn phí</a>
    </div>
  </div></nav>`;
}

export function siteFooter(brand, contactEmail, contactPhone) {
  return `<footer><div class="wrap">
    <div class="ft-grid">
      <div class="ft-about">
        <a class="logo" href="/"><span class="mk">${I.store}</span>${esc(brand)}<b>.</b></a>
        <p>Nền tảng bán hàng online cho người Việt. Chúng tôi lo kỹ thuật, tiền khách trả vào thẳng tài khoản bạn.</p>
        <a class="btn btn-cta btn-sm" href="${SIGNUP_URL}">Dùng thử miễn phí 14 ngày</a>
      </div>
      <div class="ft-col"><h3>Giải pháp</h3><a href="/#tinh-nang">Tính năng</a><a href="/#nganh-hang">Ngành hàng</a><a href="/#bang-gia">Bảng giá</a><a href="${SIGNUP_URL}">Đăng ký dùng thử</a></div>
      <div class="ft-col"><h3>Về chúng tôi</h3><a href="/gioi-thieu">Giới thiệu</a><a href="/blog">Blog</a><a href="${ADMIN_LOGIN_URL}">Đăng nhập quản trị</a></div>
      <div class="ft-col"><h3>Hỗ trợ</h3><a href="/ho-tro">Trung tâm hỗ trợ</a><a href="/lien-he">Liên hệ</a><a href="${mailtoHref(contactEmail, 'Cần hỗ trợ')}">${I.mail}${esc(contactEmail)}</a>${contactPhone ? `<span>${I.phone}${esc(contactPhone)}</span>` : ''}</div>
      <div class="ft-col"><h3>Pháp lý</h3><a href="/dieu-khoan">Điều khoản dịch vụ</a><a href="/bao-mat">Chính sách bảo vệ dữ liệu</a></div>
    </div>
    <div class="ft-bottom"><span>© ${esc(brand)} · Nền tảng bán hàng online cho người Việt.</span><span><a href="/dieu-khoan">Điều khoản</a> · <a href="/bao-mat">Bảo mật</a> · <a href="/lien-he">Liên hệ</a> · <a href="/ho-tro">Hỗ trợ</a></span></div>
  </div></footer>`;
}

/** Bọc một trang công ty hoàn chỉnh: head + nav + body + footer. `extraCss` là CSS riêng của trang. */
export function sitePage({ title, description, brand = 'Nền Tảng', contactEmail = 'lienhe@nentang.vn', contactPhone = '', active = '', extraCss = '', body }) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<style>${BASE_CSS}${extraCss}</style></head><body>
<a class="skip" href="#main">Bỏ qua tới nội dung</a>
${siteNav(brand, contactEmail, active)}
<main id="main">${body}</main>
${siteFooter(brand, contactEmail, contactPhone)}
</body></html>`;
}
