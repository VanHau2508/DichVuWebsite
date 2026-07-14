/**
 * Theme engine storefront — token an toàn + section render + escape.
 *
 * Hai tính chất bảo mật (mỗi cái có test + mutation):
 *   - escapeHtml MỌI dữ liệu do shop/người bán nhập (tên sản phẩm...) → chống XSS.
 *   - sanitizeTokens: giá trị token (màu/font/radius) do shop kiểm soát, phải khớp
 *     mẫu an toàn trước khi đổ vào CSS → chống CSS injection / breakout.
 *   (ADR-008: shop KHÔNG được chèn JS/HTML/CSS tuỳ ý.)
 *
 * Giao diện: SSR thuần, KHÔNG JavaScript, CSP nghiêm (style-src 'unsafe-inline' cho <style>).
 * Icon = SVG nội tuyến (stroke currentColor) — không phụ thuộc font/ảnh ngoài.
 */

const AMP = /&/g, LT = /</g, GT = />/g, QUOT = /"/g, APOS = /'/g;
export function esc(s) {
  return String(s ?? '')
    .replace(AMP, '&amp;').replace(LT, '&lt;').replace(GT, '&gt;')
    .replace(QUOT, '&quot;').replace(APOS, '&#39;');
}

// Bảng màu MẶC ĐỊNH (phong cách Haravan — xanh dương). Mỗi shop tự override được các
// token này (sanitizeTokens chỉ nhận hex hợp lệ) → website cá nhân đổi màu thương hiệu.
export const DEFAULT_TOKENS = {
  'color.primary': '#2463eb',      // xanh dương: CTA, thương hiệu, giá
  'color.primary-dark': '#1e4bcc', // hover nút chính
  'color.accent': '#007bff',       // xanh sáng: link, nhấn nhỏ
  'color.bg': '#ffffff',
  'color.surface': '#f9fafb',      // xám nhạt: ô ảnh trống, nền phụ
  'color.hero-bg': '#eef4ff',      // xanh dương RẤT nhạt: hero + dải nổi bật
  'color.text': '#111827',
  'color.muted': '#6b7280',
  'color.border': '#eceef1',
  'font.heading': 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  'font.body': 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  radius: '12px',
  spacing: '16px',
};

const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const FONT_RE = /^[a-zA-Z0-9 ,_-]{1,40}$/;
const SIZE_RE = /^\d{1,4}(px|rem|em|%)$/;

/**
 * Trộn token của shop lên default, nhưng CHỈ nhận giá trị khớp mẫu an toàn.
 * Giá trị lạ (vd "#fff; } body{...}") bị bỏ, dùng default → không breakout CSS.
 * Nhận token dạng phẳng {"color.primary": "#f00", ...} hoặc lồng {"color":{...}}.
 */
export function sanitizeTokens(raw) {
  const flat = flatten(raw ?? {});
  const out = { ...DEFAULT_TOKENS };
  for (const [k, def] of Object.entries(DEFAULT_TOKENS)) {
    const v = flat[k];
    if (typeof v !== 'string') continue;
    const okColor = k.startsWith('color.') && COLOR_RE.test(v);
    const okFont = k.startsWith('font.') && FONT_RE.test(v);
    const okSize = (k === 'radius' || k === 'spacing') && SIZE_RE.test(v);
    if (okColor || okFont || okSize) out[k] = v;
  }
  return out;
}

function flatten(obj, prefix = '', acc = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, acc);
    else acc[key] = v;
  }
  return acc;
}

/** Token → biến CSS trên :root. Giá trị đã sanitize nên an toàn để nội suy. */
export function tokensToCss(tokens) {
  const t = sanitizeTokens(tokens);
  const vars = Object.entries(t).map(([k, v]) => `  --${k.replace(/\./g, '-')}: ${v};`).join('\n');
  return `:root{\n${vars}\n}`;
}

const money = (vnd) => new Intl.NumberFormat('vi-VN').format(Number(vnd)) + '₫';
const fmtDate = (d) => { try { return d ? new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(d)) : ''; } catch { return ''; } };

// ── icon SVG nội tuyến (an toàn với CSP: là markup, không phải tài nguyên ngoài) ──
const I_CART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="20" r="1"/><circle cx="17" cy="20" r="1"/><path d="M2 3h2l2.4 12.3a1 1 0 0 0 1 .8h8.7a1 1 0 0 0 1-.8L21 7H5.6"/></svg>';
const I_IMG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 16l-5-5L5 20"/></svg>';
const I_TRUCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h11v9H3z"/><path d="M14 9h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.5"/><circle cx="17" cy="18" r="1.5"/></svg>';
const I_SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v5c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"/><path d="M9 12l2 2 4-4"/></svg>';

// Thẻ sản phẩm dùng chung (lưới trang chủ / danh mục / tìm kiếm). Escape mọi field người bán.
function productCards(products) {
  return products.map((p) => {
    const out = Number(p.available) <= 0;
    return `<a class="card${out ? ' is-out' : ''}" href="/p/${esc(p.slug)}">
          <div class="thumb">${out ? '<span class="soldout-tag">Hết hàng</span>' : ''}${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.title)}" loading="lazy">` : `<span class="ph">${I_IMG}</span>`}</div>
          <div class="body"><div class="name">${esc(p.title)}</div><div class="price">${money(p.price_vnd)}</div><span class="cta">Xem chi tiết →</span></div>
        </a>`;
  }).join('');
}
// Phân trang ← Trước / Sau → từ pageInfo {total, offset, pageSize, basePath}.
function pager(pi) {
  if (!pi || pi.total <= pi.pageSize) return '';
  const cur = Math.floor(pi.offset / pi.pageSize) + 1;
  const last = Math.max(1, Math.ceil(pi.total / pi.pageSize));
  const link = (n) => esc(`${pi.basePath}${pi.basePath.includes('?') ? '&' : '?'}page=${n}`);
  const prev = cur > 1 ? `<a class="pg-btn" href="${link(cur - 1)}">← Trước</a>` : '<span class="pg-btn off">← Trước</span>';
  const next = cur < last ? `<a class="pg-btn" href="${link(cur + 1)}">Sau →</a>` : '<span class="pg-btn off">Sau →</span>';
  return `<nav class="pager">${prev}<span class="pg-info">Trang ${cur}/${last}</span>${next}</nav>`;
}

// ── section renderers (nhận dữ liệu ĐÃ đọc, escape khi render) ────────────────
const SECTIONS = {
  header: (props, ctx) => `<header class="hdr"><div class="wrap">
    <a href="/" class="brand">${ctx.shop.logo_url ? `<img src="${esc(ctx.shop.logo_url)}" alt="${esc(ctx.shop.name)}" class="brand-logo">` : esc(ctx.shop.name)}</a>
    <form class="hsearch" method="GET" action="/search" role="search">
      <input name="q" value="${esc(ctx.query ?? '')}" placeholder="Tìm sản phẩm…" aria-label="Tìm sản phẩm">
    </form>
    <nav class="hnav">
      ${ctx.categories.slice(0, 4).map((c) => `<a href="/c/${esc(c.slug)}">${esc(c.name)}</a>`).join('')}
      ${ctx.hasBlog ? '<a href="/blog">Blog</a>' : ''}
      <a href="/checkout/lookup">Tra cứu đơn</a>
      <a href="/cart" class="cart"><span class="i">${I_CART}</span>Giỏ hàng</a>
    </nav>
  </div></header>`,

  hero: (props, ctx) => `<section class="hero"><div class="wrap">
    <p class="eyebrow">${esc(props.eyebrow || 'Cửa hàng chính thức')}</p>
    <h1>${esc(props.title || ctx.shop.name)}</h1>
    <p>${esc(props.subtitle || 'Mua sắm dễ dàng — giao hàng toàn quốc, thanh toán COD hoặc chuyển khoản QR.')}</p>
    <a class="btn btn-primary" href="#san-pham">Xem sản phẩm</a>
  </div></section>`,

  product_grid: (props, ctx) => {
    const chips = ctx.categories.length
      ? `<div class="chips"><a class="chip" href="/">Tất cả</a>${ctx.categories.map((c) => `<a class="chip" href="/c/${esc(c.slug)}">${esc(c.name)}</a>`).join('')}</div>`
      : '';
    const cards = ctx.products.length ? productCards(ctx.products) : '<p class="empty">Cửa hàng chưa có sản phẩm nào.</p>';
    return `<section class="section" id="san-pham"><div class="wrap">
      <div class="section-h"><h2>${esc(props.title || 'Sản phẩm')}</h2></div>
      ${chips}
      <div class="grid">${cards}</div>
      ${pager(ctx.pageInfo)}
    </div></section>`;
  },

  footer: (props, ctx) => {
    const menu = ctx.menu ?? [];
    const links = (ctx.hasBlog ? '<a href="/blog">Blog</a>' : '') + menu.map((pg) => `<a href="/pages/${esc(pg.slug)}">${esc(pg.title)}</a>`).join('');
    const nav = links ? `<nav class="ftr-nav">${links}</nav>` : '';
    const s = ctx.shop;
    const bits = [
      s.business_address ? esc(s.business_address) : '',
      s.contact_phone ? `ĐT: ${esc(s.contact_phone)}` : '',
      s.contact_email ? `Email: ${esc(s.contact_email)}` : '',
    ].filter(Boolean);
    const contact = bits.length ? `<div class="ftr-contact">${bits.join(' · ')}</div>` : '';
    return `<footer class="ftr"><div class="wrap">
      <div>${nav}${contact}<div class="copy">© ${esc(ctx.shop.name)}</div></div>
      <div class="badges"><span>${I_TRUCK}Giao toàn quốc</span><span>${I_SHIELD}COD · QR</span></div>
    </div></footer>`;
  },
};

// Section nội dung: typed registry (ADR-008 — không HTML/JS tuỳ ý). MỌI text người
// bán nhập đều escape. type lạ bị bỏ (không render thô).
const BLOCK_RENDER = {
  heading: (b) => `<h2>${esc(b.text)}</h2>`,
  paragraph: (b) => `<p>${esc(b.text)}</p>`,
  list: (b) => `<ul>${(Array.isArray(b.items) ? b.items : []).map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`,
  quote: (b) => `<blockquote><p>${esc(b.text)}</p>${b.cite ? `<cite>${esc(b.cite)}</cite>` : ''}</blockquote>`,
  divider: () => '<hr>',
};

const DEFAULT_LAYOUT = [
  { section: 'header', props: {} },
  { section: 'hero', props: { title: '', subtitle: '' } },
  { section: 'product_grid', props: { title: 'Sản phẩm nổi bật' } },
  { section: 'footer', props: {} },
];

const STYLE = `*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:var(--font-body);color:var(--color-text);background:var(--color-bg);line-height:1.55;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}img{max-width:100%;display:block}
h1,h2,h3{font-family:var(--font-heading);font-weight:600;letter-spacing:-.01em;line-height:1.25;color:var(--color-text)}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px}
.i{display:inline-flex}.i svg,.cart svg{width:18px;height:18px}
.hdr{position:sticky;top:0;z-index:20;background:var(--color-bg);border-bottom:1px solid var(--color-border)}
.hdr .wrap{display:flex;align-items:center;justify-content:space-between;min-height:64px;gap:16px}
.brand{font-family:var(--font-heading);font-weight:700;font-size:1.2rem;letter-spacing:-.02em;color:var(--color-text);white-space:nowrap;display:inline-flex;align-items:center}
.brand-logo{max-height:40px;max-width:180px;width:auto;display:block}
.hnav{display:flex;align-items:center;gap:24px;font-size:.92rem;flex-wrap:wrap}
.hnav a{color:var(--color-muted);transition:color .15s}.hnav a:hover{color:var(--color-primary)}
.hnav .cart{display:inline-flex;align-items:center;gap:6px;color:var(--color-text);font-weight:500}.hnav .cart:hover{color:var(--color-primary)}
.hero{background:var(--color-hero-bg)}
.hero .wrap{max-width:780px;padding:64px 20px;text-align:center}
.hero .eyebrow{color:var(--color-primary);font-weight:600;font-size:.8rem;letter-spacing:.05em;text-transform:uppercase;margin:0 0 12px}
.hero h1{margin:0 0 14px;font-size:2.4rem;font-weight:600}.hero p{margin:0 0 26px;color:#3d5067;font-size:1.05rem}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;font-family:var(--font-body);font-size:1rem;font-weight:500;min-height:48px;padding:12px 26px;border-radius:999px;border:1px solid transparent;cursor:pointer;transition:background .15s,opacity .15s,transform .06s;line-height:1}
.btn:active{transform:translateY(1px)}.btn svg{width:18px;height:18px}
.btn-primary{background:var(--color-primary);color:#fff}.btn-primary:hover{background:var(--color-primary-dark)}
.btn-ghost{background:#fff;color:var(--color-text);border-color:var(--color-text)}.btn-ghost:hover{background:var(--color-surface)}
.section{padding:44px 0}.section-h{display:flex;align-items:baseline;justify-content:space-between;margin:0 0 20px}.section-h h2{margin:0;font-size:1.4rem}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 24px}
.chip{border:1px solid var(--color-border);border-radius:999px;padding:7px 16px;font-size:.86rem;color:var(--color-muted);transition:.15s}
.chip:hover{border-color:var(--color-primary);color:var(--color-primary);background:var(--color-hero-bg)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:20px}
.empty{color:var(--color-muted);padding:20px 0}
.hsearch{flex:1 1 180px;max-width:280px;margin:0 8px}
.hsearch input{width:100%;padding:9px 14px;border:1px solid var(--color-border);border-radius:999px;font-size:.9rem;font-family:inherit;background:var(--color-surface);color:var(--color-text)}
.hsearch input:focus{outline:none;border-color:var(--color-primary);box-shadow:0 0 0 3px rgba(36,99,235,.12)}
.searchbar{display:flex;gap:10px;margin:0 0 24px;max-width:520px}
.searchbar input{flex:1;padding:12px 16px;border:1px solid var(--color-border);border-radius:999px;font-size:1rem;font-family:inherit;background:var(--color-bg);color:var(--color-text)}
.searchbar input:focus{outline:none;border-color:var(--color-primary);box-shadow:0 0 0 3px rgba(36,99,235,.12)}
.pager{display:flex;align-items:center;justify-content:center;gap:16px;margin:32px 0 8px}
.pg-btn{padding:9px 18px;border:1px solid var(--color-border);border-radius:999px;color:var(--color-text);font-size:.9rem}
.pg-btn:hover{border-color:var(--color-primary);color:var(--color-primary)}
.pg-btn.off{color:#c9ced6;pointer-events:none}
.pg-info{color:var(--color-muted);font-size:.88rem}
.blog-list{display:grid;gap:18px;max-width:760px}
.blog-card{border:1px solid var(--color-border);border-radius:14px;padding:20px 24px;background:var(--color-bg);transition:border-color .12s,box-shadow .12s}
.blog-card:hover{border-color:var(--color-primary);box-shadow:0 6px 20px -12px rgba(36,99,235,.3)}
.blog-card h2{margin:0 0 4px;font-size:1.28rem;font-weight:700;line-height:1.3}
.blog-card h2 a{color:var(--color-text)}.blog-card h2 a:hover{color:var(--color-primary)}
.blog-date{color:var(--color-muted);font-size:.84rem;margin:0 0 10px}
.blog-card p{color:var(--color-muted);margin:0 0 12px;line-height:1.7}
.blog-more{color:var(--color-primary);font-weight:600;font-size:.92rem}
.blog-post{max-width:720px}.blog-post h1{margin:10px 0 2px;font-size:1.9rem}
.blog-post p{line-height:1.85;color:var(--color-text);margin:0 0 18px}
.card{display:flex;flex-direction:column;background:var(--color-bg);border:1px solid var(--color-border);border-radius:12px;overflow:hidden;transition:transform .12s,box-shadow .12s,border-color .12s}
.card:hover{transform:translateY(-3px);border-color:#c9dcff;box-shadow:0 8px 24px rgba(36,99,235,.10)}
.card .thumb{aspect-ratio:1;background:var(--color-surface);overflow:hidden}
.card .thumb img{width:100%;height:100%;object-fit:cover}
.card .thumb .ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#c4c8cf}.card .thumb .ph svg{width:34px;height:34px}
.card .body{padding:13px 15px 15px;display:flex;flex-direction:column;gap:6px;flex:1}
.card .name{font-size:.92rem;color:var(--color-text);line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.6em}
.card .price{font-weight:700;color:var(--color-text);font-size:1.05rem;margin-top:auto}
.card .cta{font-size:.82rem;color:var(--color-primary);font-weight:600}
.pd{padding:28px 20px 52px}
.crumb{font-size:.85rem;color:var(--color-muted);margin:0 0 20px}.crumb a:hover{color:var(--color-primary)}
.pd-grid{display:grid;grid-template-columns:1fr 1fr;gap:40px;align-items:start}
.pd-media{display:flex;flex-direction:column;gap:12px}
.pd-media .main{aspect-ratio:1;background:var(--color-surface);border:1px solid var(--color-border);border-radius:16px;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#c4c8cf}
.pd-media .main img{width:100%;height:100%;object-fit:cover}.pd-media .main svg{width:56px;height:56px}
.pd-media .thumbs{display:flex;gap:10px;flex-wrap:wrap}
.pd-media .thumbs img{width:74px;height:74px;object-fit:cover;border:1px solid var(--color-border);border-radius:10px}
.pd-info h1{margin:0 0 12px;font-size:1.9rem;font-weight:600}
.pd-info .price{font-size:1.7rem;font-weight:700;color:var(--color-primary);margin:0 0 20px}
.pd-info .desc{color:#3d5067;line-height:1.75;margin:0 0 24px;white-space:pre-line}
.addcart{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:0 0 22px}
.addcart select,.addcart input{padding:12px 14px;border:1px solid #d6d6d6;border-radius:12px;font-size:1rem;font-family:inherit;background:var(--color-bg);color:var(--color-text)}
.addcart select:focus,.addcart input:focus{outline:none;border-color:var(--color-primary);box-shadow:0 0 0 3px rgba(36,99,235,.12)}
.addcart input[type=number]{width:88px;text-align:center}
.stock{display:inline-block;font-size:.9rem;font-weight:600;padding:5px 12px;border-radius:999px;margin:0 0 18px}
.stock.in{background:var(--color-hero-bg);color:var(--color-primary-dark)}
.stock.low{background:#fff7ed;color:#c2410c}
.stock.out{background:#fef2f2;color:#b91c1c}
.soldout-note{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:12px;padding:14px 16px;font-weight:600;margin:0 0 22px}
.card .thumb{position:relative}
.card .soldout-tag{position:absolute;top:8px;left:8px;z-index:1;background:rgba(17,24,39,.82);color:#fff;font-size:.76rem;font-weight:600;padding:4px 10px;border-radius:999px}
.card.is-out .thumb img{opacity:.55;filter:grayscale(.3)}
.trust{display:flex;gap:22px;flex-wrap:wrap;color:var(--color-muted);font-size:.85rem;border-top:1px solid var(--color-border);padding-top:18px}
.trust span{display:inline-flex;align-items:center;gap:6px}.trust svg{width:16px;height:16px;color:var(--color-primary)}
.content{max-width:720px;margin:0 auto;padding:40px 20px 60px}
.content h1{font-size:2rem;margin:0 0 .6em;font-weight:600}.content h2{margin:1.6em 0 .4em;font-size:1.3rem}
.content p{line-height:1.8;margin:0 0 1.1em;color:#3d5067}.content ul{line-height:1.8;padding-left:1.3em;margin:0 0 1.1em}
.content blockquote{margin:1.4em 0;padding:.4em 0 .4em 1.1em;border-left:3px solid var(--color-primary);color:var(--color-muted);font-style:italic}
.content blockquote cite{display:block;margin-top:.5em;font-size:.88em;font-style:normal}
.content hr{border:0;border-top:1px solid var(--color-border);margin:2em 0}
.ftr{border-top:1px solid var(--color-border);background:var(--color-surface);margin-top:28px}
.ftr .wrap{padding:32px 20px;display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between;color:var(--color-muted);font-size:.88rem}
.ftr-nav{display:flex;flex-wrap:wrap;gap:20px;margin:0 0 6px}.ftr-nav a:hover{color:var(--color-primary)}
.ftr-contact{font-size:.85rem;color:var(--color-muted);margin:0 0 6px;line-height:1.6}
.ftr .badges{display:flex;gap:20px;flex-wrap:wrap}.ftr .badges span{display:inline-flex;align-items:center;gap:6px}.ftr .badges svg{width:16px;height:16px;color:var(--color-primary)}
.center-msg{max-width:520px;margin:80px auto;text-align:center;padding:0 20px}.center-msg h1{font-size:1.7rem;margin:0 0 10px;font-weight:600}.center-msg p{color:var(--color-muted)}
.preview-banner{position:sticky;top:0;z-index:30;background:#b45309;color:#fff;padding:10px 20px;font-weight:600;text-align:center;font-size:.9rem}
@media(max-width:720px){.pd-grid{grid-template-columns:1fr;gap:24px}.hero h1{font-size:1.8rem}.hero .wrap{padding:44px 20px}.hnav{gap:14px;font-size:.85rem}.grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}.pd-info h1{font-size:1.5rem}}`;

function page(title, tokens, bodyHtml, head = '') {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${head}<style>${tokensToCss(tokens)}\n${STYLE}</style></head>
<body>${bodyHtml}</body></html>`;
}

/** Render trang chủ theo layout của theme (hoặc mặc định). */
export function renderHome(ctx, { canonical = null } = {}) {
  const layout = Array.isArray(ctx.theme?.layout) && ctx.theme.layout.length ? ctx.theme.layout : DEFAULT_LAYOUT;
  const body = layout
    .map((s) => (SECTIONS[s.section] ? SECTIONS[s.section](s.props ?? {}, ctx) : ''))
    .join('\n');
  const head = metaHead({
    description: `${ctx.shop.name} — cửa hàng trực tuyến. Giao hàng toàn quốc, thanh toán COD hoặc chuyển khoản QR.`,
    canonical, ogTitle: ctx.shop.name, siteName: ctx.shop.name,
  });
  return page(ctx.shop.name, ctx.theme?.tokens, body, head);
}

/** Render trang chi tiết sản phẩm + form "thêm vào giỏ" (POST thuần, không JS). */
export function renderProduct(ctx, p, { canonical = null } = {}) {
  const media = Array.isArray(p.media) ? p.media : [];
  const main = media.length ? `<img src="${esc(media[0].url)}" alt="${esc(p.title)}">` : I_IMG;
  const thumbs = media.length > 1
    ? `<div class="thumbs">${media.slice(0, 6).map((m) => `<img src="${esc(m.url)}" alt="${esc(p.title)}" loading="lazy">`).join('')}</div>`
    : '';
  // Tồn kho: available = on_hand - reserved (KHỚP checkout). ≤0 = hết. Tổng để xác định
  // sản phẩm còn bán được không; per-variant để vô hiệu lựa chọn đã hết.
  const av = (v) => Math.max(0, Number(v.available) || 0);
  const totalAvail = p.variants.reduce((s, v) => s + av(v), 0);
  const maxAvail = p.variants.reduce((m, v) => Math.max(m, av(v)), 0);
  const soldOut = totalAvail <= 0;
  const single = p.variants.length === 1;
  const stockBadge = soldOut
    ? '<div class="stock out">Hết hàng</div>'
    : (single && maxAvail <= 5 ? `<div class="stock low">Chỉ còn ${maxAvail}</div>` : '<div class="stock in">Còn hàng</div>');
  const options = p.variants.map((v) => {
    const a = av(v);
    return `<option value="${esc(v.id)}"${a <= 0 ? ' disabled' : ''}>${esc(v.title ?? v.sku)} — ${money(v.price_vnd)}${a <= 0 ? ' (hết hàng)' : ''}</option>`;
  }).join('');
  // action=/cart/add tới checkout service (cùng origin qua Caddy) → form-action 'self' cho phép.
  const qtyMax = Math.min(1000, maxAvail || 1);
  const addForm = !p.variants.length ? '' : (soldOut
    ? '<div class="soldout-note">Sản phẩm tạm hết hàng. Vui lòng quay lại sau.</div>'
    : `
    <form class="addcart" method="POST" action="/cart/add">
      ${p.variants.length > 1 ? `<select name="variant_id" aria-label="Phân loại">${options}</select>` : `<input type="hidden" name="variant_id" value="${esc(p.variants[0].id)}">`}
      <input type="number" name="qty" value="1" min="1" max="${qtyMax}" inputmode="numeric" aria-label="Số lượng">
      <button class="btn btn-primary" type="submit">${I_CART}Thêm vào giỏ</button>
    </form>`);
  // Structured data qua MICRODATA (itemprop) — CSP-sạch, không cần <script> (default-src 'none').
  const availability = soldOut ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock';
  const priceAttr = esc(String(Number(p.price_vnd)));
  const body = `${SECTIONS.header({}, ctx)}
    <main class="wrap pd" itemscope itemtype="https://schema.org/Product">
      <div class="crumb"><a href="/">Trang chủ</a> / <span itemprop="name">${esc(p.title)}</span></div>
      ${media.length ? `<meta itemprop="image" content="${esc(media[0].url)}">` : ''}
      <div class="pd-grid">
        <div class="pd-media"><div class="main">${main}</div>${thumbs}</div>
        <div class="pd-info">
          <h1>${esc(p.title)}</h1>
          <div class="price" itemprop="offers" itemscope itemtype="https://schema.org/Offer">
            <span itemprop="price" content="${priceAttr}">${money(p.price_vnd)}</span>
            <meta itemprop="priceCurrency" content="VND"><link itemprop="availability" href="${availability}">
          </div>
          ${stockBadge}
          ${addForm}
          ${p.description ? `<div class="desc" itemprop="description">${esc(p.description)}</div>` : ''}
          <div class="trust"><span>${I_TRUCK}Giao hàng toàn quốc</span><span>${I_SHIELD}Thanh toán COD hoặc QR</span></div>
        </div>
      </div>
    </main>${SECTIONS.footer({}, ctx)}`;
  const desc = p.description ? String(p.description).replace(/\s+/g, ' ').trim().slice(0, 200) : `${p.title} — ${ctx.shop.name}`;
  const ogImg = media.length ? `<meta property="og:image" content="${esc(media[0].url)}"><meta name="twitter:image" content="${esc(media[0].url)}">` : '';
  const head = metaHead({ description: desc, canonical, ogTitle: p.title, ogType: 'product', siteName: ctx.shop.name }) + ogImg;
  return page(`${p.title} — ${ctx.shop.name}`, ctx.theme?.tokens, body, head);
}

/** Trang kết quả tìm kiếm. Trang KQ tìm không nên index (robots noindex,follow). */
export function renderSearch(ctx, { canonical = null } = {}) {
  const q = ctx.query ?? '';
  const count = ctx.pageInfo?.total ?? ctx.products.length;
  const results = ctx.products.length
    ? `<div class="grid">${productCards(ctx.products)}</div>${pager(ctx.pageInfo)}`
    : `<p class="empty">${q ? `Không tìm thấy sản phẩm nào cho “${esc(q)}”.` : 'Nhập từ khoá để tìm sản phẩm.'}</p>`;
  const body = `${SECTIONS.header({}, ctx)}
    <main class="wrap section">
      <div class="section-h"><h2>${q ? `Kết quả tìm “${esc(q)}”` : 'Tìm kiếm'}</h2>${q ? `<p class="muted">${esc(count)} sản phẩm</p>` : ''}</div>
      <form class="searchbar" method="GET" action="/search" role="search">
        <input name="q" value="${esc(q)}" placeholder="Tìm sản phẩm…" aria-label="Tìm sản phẩm">
        <button class="btn btn-primary" type="submit">Tìm</button>
      </form>
      ${results}
    </main>${SECTIONS.footer({}, ctx)}`;
  const head = metaHead({
    description: q ? `Kết quả tìm kiếm cho "${q}" tại ${ctx.shop.name}` : `Tìm sản phẩm tại ${ctx.shop.name}`,
    canonical, ogTitle: q ? `Tìm "${q}"` : 'Tìm kiếm', siteName: ctx.shop.name, robots: 'noindex, follow',
  });
  return page(`${q ? `Tìm "${q}"` : 'Tìm kiếm'} — ${ctx.shop.name}`, ctx.theme?.tokens, body, head);
}

/** Blog: danh sách bài published. */
export function renderBlogList(ctx, posts, { canonical = null } = {}) {
  const items = (posts ?? []).length
    ? posts.map((p) => `<article class="blog-card">
        <h2><a href="/blog/${esc(p.slug)}">${esc(p.title)}</a></h2>
        <div class="blog-date">${esc(fmtDate(p.published_at))}</div>
        ${p.excerpt ? `<p>${esc(p.excerpt)}</p>` : ''}
        <a class="blog-more" href="/blog/${esc(p.slug)}">Đọc tiếp →</a>
      </article>`).join('')
    : '<p class="empty">Chưa có bài viết nào.</p>';
  const body = `${SECTIONS.header({}, ctx)}
    <main class="wrap section">
      <div class="section-h"><h2>Blog</h2></div>
      <div class="blog-list">${items}</div>
    </main>${SECTIONS.footer({}, ctx)}`;
  const head = metaHead({ description: `Bài viết & tin tức từ ${ctx.shop.name}`, canonical, ogTitle: `Blog — ${ctx.shop.name}`, siteName: ctx.shop.name });
  return page(`Blog — ${ctx.shop.name}`, ctx.theme?.tokens, body, head);
}

/** Blog: một bài. body TEXT → tách đoạn theo dòng trống, esc + <br> cho xuống dòng đơn. */
export function renderBlogPost(ctx, post, { canonical = null } = {}) {
  const paras = String(post.body ?? '').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
    .map((para) => `<p>${esc(para).replace(/\n/g, '<br>')}</p>`).join('');
  const body = `${SECTIONS.header({}, ctx)}
    <main class="wrap content blog-post">
      <div class="crumb"><a href="/">Trang chủ</a> / <a href="/blog">Blog</a> / ${esc(post.title)}</div>
      <h1>${esc(post.title)}</h1>
      <div class="blog-date">${esc(fmtDate(post.published_at))}</div>
      ${paras || ''}
      <p style="margin-top:36px"><a class="btn btn-primary" href="/blog">← Về Blog</a></p>
    </main>${SECTIONS.footer({}, ctx)}`;
  const desc = post.excerpt ? String(post.excerpt) : String(post.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const head = metaHead({ description: desc, canonical, ogTitle: post.title, ogType: 'article', siteName: ctx.shop.name });
  return page(`${post.title} — ${ctx.shop.name}`, ctx.theme?.tokens, body, head);
}

// Banner preview: tĩnh, không nội suy dữ liệu shop → an toàn. Nổi bật để không ai
// nhầm bản nháp với bản đang chạy thật.
const PREVIEW_BANNER = '<div class="preview-banner" role="status">⚠ BẢN NHÁP — trang xem trước, CHƯA xuất bản. Không lập chỉ mục.</div>';

/** Mô tả SEO dự phòng: text section đầu tiên (list → gộp items), cắt ~200 ký tự. */
function deriveDescription(blocks) {
  const clip = (s) => s.trim().replace(/\s+/g, ' ').slice(0, 200);
  for (const b of blocks) {
    if (b && typeof b.text === 'string' && b.text.trim()) return clip(b.text);
    if (b && b.type === 'list' && Array.isArray(b.items) && b.items.length) return clip(b.items.join(' '));
  }
  return null;
}

/**
 * Thẻ meta SEO/OG. MỌI giá trị do người bán nhập đều esc() — kể cả trong thuộc tính
 * content="..." (esc escape cả " và ') → không breakout attribute (ADR-008).
 */
function metaHead({ description, canonical, ogTitle, ogType, siteName, robots }) {
  const t = [];
  if (robots) t.push(`<meta name="robots" content="${esc(robots)}">`);
  if (description) t.push(`<meta name="description" content="${esc(description)}">`);
  if (canonical) t.push(`<link rel="canonical" href="${esc(canonical)}">`);
  t.push(`<meta property="og:type" content="${esc(ogType || 'website')}">`);
  t.push(`<meta property="og:title" content="${esc(ogTitle ?? '')}">`);
  if (description) t.push(`<meta property="og:description" content="${esc(description)}">`);
  if (canonical) t.push(`<meta property="og:url" content="${esc(canonical)}">`);
  if (siteName) t.push(`<meta property="og:site_name" content="${esc(siteName)}">`);
  t.push(`<meta name="twitter:card" content="summary">`);
  t.push(`<meta name="twitter:title" content="${esc(ogTitle ?? '')}">`);
  if (description) t.push(`<meta name="twitter:description" content="${esc(description)}">`);
  return t.join('');
}

/**
 * Render trang nội dung. Mặc định là bản published (blocks + seo từ page_revisions).
 * preview=true → SNAPSHOT draft (page_previews) + banner + robots noindex.
 * SEO theo trang: seo_title/seo_description do người bán nhập (versioned theo publish);
 * thiếu thì fallback tiêu đề trang + mô tả suy từ block đầu.
 */
export function renderPage(ctx, doc, { preview = false, canonical = null } = {}) {
  const blocks = Array.isArray(doc.blocks) ? doc.blocks : [];
  const body = `${preview ? PREVIEW_BANNER : ''}${SECTIONS.header({}, ctx)}
    <main class="content"><h1>${esc(doc.title)}</h1>
      ${blocks.map((b) => (BLOCK_RENDER[b.type] ? BLOCK_RENDER[b.type](b) : '')).join('\n')}
    </main>${SECTIONS.footer({}, ctx)}`;
  const baseTitle = doc.seo_title || `${doc.title} — ${ctx.shop.name}`;
  const title = preview ? `[Nháp] ${baseTitle}` : baseTitle;
  const head = metaHead({
    description: doc.seo_description || deriveDescription(blocks),
    canonical: preview ? null : canonical, // preview đã noindex → không đặt canonical
    ogTitle: doc.seo_title || doc.title,
    ogType: 'article',
    siteName: ctx.shop.name,
    robots: preview ? 'noindex, nofollow' : null,
  });
  return page(title, ctx.theme?.tokens, body, head);
}

export function renderMaintenance(shopName) {
  return page('Tạm ngưng', {}, `<main class="center-msg"><h1>Cửa hàng tạm ngưng</h1>
    <p>${esc(shopName)} hiện không nhận đơn. Vui lòng quay lại sau.</p></main>`);
}
export function renderNotFound() {
  return page('Không tìm thấy', {}, `<main class="center-msg"><h1>Không tìm thấy trang</h1>
    <p>Trang bạn tìm không tồn tại.</p></main>`);
}
