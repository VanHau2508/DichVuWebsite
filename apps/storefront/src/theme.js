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

export const DEFAULT_TOKENS = {
  'color.primary': '#111827', // than chì: tiêu đề, nút, giá
  'color.accent': '#0f766e',  // xanh ngọc: nhấn nhỏ, hover, viền trích dẫn
  'color.bg': '#ffffff',
  'color.surface': '#f6f7f8', // nền hero/section nhạt + ô ảnh trống
  'color.text': '#1f2430',
  'color.muted': '#6b7280',
  'color.border': '#e6e8eb',
  'font.heading': 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  'font.body': 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
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

// ── icon SVG nội tuyến (an toàn với CSP: là markup, không phải tài nguyên ngoài) ──
const I_CART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="20" r="1"/><circle cx="17" cy="20" r="1"/><path d="M2 3h2l2.4 12.3a1 1 0 0 0 1 .8h8.7a1 1 0 0 0 1-.8L21 7H5.6"/></svg>';
const I_IMG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 16l-5-5L5 20"/></svg>';
const I_TRUCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h11v9H3z"/><path d="M14 9h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.5"/><circle cx="17" cy="18" r="1.5"/></svg>';
const I_SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v5c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"/><path d="M9 12l2 2 4-4"/></svg>';

// ── section renderers (nhận dữ liệu ĐÃ đọc, escape khi render) ────────────────
const SECTIONS = {
  header: (props, ctx) => `<header class="hdr"><div class="wrap">
    <a href="/" class="brand">${esc(ctx.shop.name)}</a>
    <nav class="hnav">
      ${ctx.categories.slice(0, 4).map((c) => `<a href="/c/${esc(c.slug)}">${esc(c.name)}</a>`).join('')}
      <a href="/checkout/lookup">Tra cứu đơn</a>
      <a href="/cart" class="cart"><span class="i">${I_CART}</span>Giỏ hàng</a>
    </nav>
  </div></header>`,

  hero: (props, ctx) => `<section class="hero"><div class="wrap">
    <p class="eyebrow">Cửa hàng chính thức</p>
    <h1>${esc(props.title || ctx.shop.name)}</h1>
    <p>${esc(props.subtitle || 'Mua sắm dễ dàng — giao hàng toàn quốc, thanh toán COD hoặc chuyển khoản QR.')}</p>
    <a class="btn btn-primary" href="#san-pham">Xem sản phẩm</a>
  </div></section>`,

  product_grid: (props, ctx) => {
    const chips = ctx.categories.length
      ? `<div class="chips"><a class="chip" href="/">Tất cả</a>${ctx.categories.map((c) => `<a class="chip" href="/c/${esc(c.slug)}">${esc(c.name)}</a>`).join('')}</div>`
      : '';
    const cards = ctx.products.length
      ? ctx.products.map((p) => `
        <a class="card" href="/p/${esc(p.slug)}">
          <div class="thumb">${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.title)}" loading="lazy">` : `<span class="ph">${I_IMG}</span>`}</div>
          <div class="body">
            <div class="name">${esc(p.title)}</div>
            <div class="price">${money(p.price_vnd)}</div>
            <span class="cta">Xem chi tiết →</span>
          </div>
        </a>`).join('')
      : '<p class="empty">Cửa hàng chưa có sản phẩm nào.</p>';
    return `<section class="section" id="san-pham"><div class="wrap">
      <div class="section-h"><h2>${esc(props.title || 'Sản phẩm')}</h2></div>
      ${chips}
      <div class="grid">${cards}</div>
    </div></section>`;
  },

  footer: (props, ctx) => {
    const menu = ctx.menu ?? [];
    const nav = menu.length
      ? `<nav class="ftr-nav">${menu.map((pg) => `<a href="/pages/${esc(pg.slug)}">${esc(pg.title)}</a>`).join('')}</nav>`
      : '';
    return `<footer class="ftr"><div class="wrap">
      <div>${nav}<div class="copy">© ${esc(ctx.shop.name)}</div></div>
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
h1,h2,h3{font-family:var(--font-heading);font-weight:700;letter-spacing:-.01em;line-height:1.25;color:var(--color-text)}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px}
.i{display:inline-flex}.i svg,.cart svg{width:18px;height:18px}
.hdr{position:sticky;top:0;z-index:20;background:var(--color-bg);border-bottom:1px solid var(--color-border)}
.hdr .wrap{display:flex;align-items:center;justify-content:space-between;min-height:60px;gap:16px}
.brand{font-family:var(--font-heading);font-weight:700;font-size:1.15rem;letter-spacing:-.02em;color:var(--color-text);white-space:nowrap}
.hnav{display:flex;align-items:center;gap:22px;font-size:.92rem;flex-wrap:wrap}
.hnav a{color:var(--color-muted);transition:color .15s}.hnav a:hover{color:var(--color-text)}
.hnav .cart{display:inline-flex;align-items:center;gap:6px;color:var(--color-text);font-weight:600}
.hero{background:var(--color-surface);border-bottom:1px solid var(--color-border)}
.hero .wrap{max-width:760px;padding:56px 20px;text-align:center}
.hero .eyebrow{color:var(--color-accent);font-weight:600;font-size:.78rem;letter-spacing:.05em;text-transform:uppercase;margin:0 0 10px}
.hero h1{margin:0 0 12px;font-size:2rem}.hero p{margin:0 0 22px;color:var(--color-muted);font-size:1.02rem}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;font-family:var(--font-body);font-size:.95rem;font-weight:600;padding:11px 20px;border-radius:var(--radius);border:1px solid transparent;cursor:pointer;transition:transform .06s,opacity .15s,background .15s;line-height:1}
.btn:active{transform:translateY(1px)}.btn svg{width:17px;height:17px}
.btn-primary{background:var(--color-primary);color:#fff}.btn-primary:hover{opacity:.9}
.section{padding:40px 0}.section-h{display:flex;align-items:baseline;justify-content:space-between;margin:0 0 18px}.section-h h2{margin:0;font-size:1.35rem}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 22px}
.chip{border:1px solid var(--color-border);border-radius:999px;padding:6px 15px;font-size:.85rem;color:var(--color-muted);transition:.15s}
.chip:hover{border-color:var(--color-text);color:var(--color-text)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:18px}
.empty{color:var(--color-muted);padding:20px 0}
.card{display:flex;flex-direction:column;background:var(--color-bg);border:1px solid var(--color-border);border-radius:var(--radius);overflow:hidden;transition:transform .12s,box-shadow .12s,border-color .12s}
.card:hover{transform:translateY(-3px);border-color:#d1d5db;box-shadow:0 8px 24px rgba(17,24,39,.07)}
.card .thumb{aspect-ratio:1;background:var(--color-surface);overflow:hidden}
.card .thumb img{width:100%;height:100%;object-fit:cover}
.card .thumb .ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#c4c8cf}.card .thumb .ph svg{width:34px;height:34px}
.card .body{padding:12px 14px 14px;display:flex;flex-direction:column;gap:6px;flex:1}
.card .name{font-size:.92rem;color:var(--color-text);line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.6em}
.card .price{font-weight:700;color:var(--color-text);font-size:1.04rem;margin-top:auto}
.card .cta{font-size:.8rem;color:var(--color-accent);font-weight:600}
.pd{padding:26px 20px 48px}
.crumb{font-size:.85rem;color:var(--color-muted);margin:0 0 18px}.crumb a:hover{color:var(--color-text)}
.pd-grid{display:grid;grid-template-columns:1fr 1fr;gap:36px;align-items:start}
.pd-media{display:flex;flex-direction:column;gap:12px}
.pd-media .main{aspect-ratio:1;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius);overflow:hidden;display:flex;align-items:center;justify-content:center;color:#c4c8cf}
.pd-media .main img{width:100%;height:100%;object-fit:cover}.pd-media .main svg{width:56px;height:56px}
.pd-media .thumbs{display:flex;gap:10px;flex-wrap:wrap}
.pd-media .thumbs img{width:72px;height:72px;object-fit:cover;border:1px solid var(--color-border);border-radius:10px}
.pd-info h1{margin:0 0 10px;font-size:1.7rem}
.pd-info .price{font-size:1.55rem;font-weight:700;color:var(--color-text);margin:0 0 18px}
.pd-info .desc{color:#4b5563;line-height:1.75;margin:0 0 22px;white-space:pre-line}
.addcart{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 20px}
.addcart select,.addcart input{padding:11px 12px;border:1px solid var(--color-border);border-radius:var(--radius);font-size:.95rem;font-family:inherit;background:var(--color-bg);color:var(--color-text)}
.addcart input[type=number]{width:84px;text-align:center}.addcart .btn-primary{padding:12px 24px}
.trust{display:flex;gap:20px;flex-wrap:wrap;color:var(--color-muted);font-size:.85rem;border-top:1px solid var(--color-border);padding-top:16px}
.trust span{display:inline-flex;align-items:center;gap:6px}.trust svg{width:16px;height:16px}
.content{max-width:720px;margin:0 auto;padding:36px 20px 56px}
.content h1{font-size:1.9rem;margin:0 0 .6em}.content h2{margin:1.5em 0 .4em;font-size:1.3rem}
.content p{line-height:1.75;margin:0 0 1.1em;color:#374151}.content ul{line-height:1.75;padding-left:1.3em;margin:0 0 1.1em}
.content blockquote{margin:1.4em 0;padding:.4em 0 .4em 1.1em;border-left:3px solid var(--color-accent);color:var(--color-muted);font-style:italic}
.content blockquote cite{display:block;margin-top:.5em;font-size:.88em;font-style:normal}
.content hr{border:0;border-top:1px solid var(--color-border);margin:2em 0}
.ftr{border-top:1px solid var(--color-border);background:var(--color-surface);margin-top:24px}
.ftr .wrap{padding:28px 20px;display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between;color:var(--color-muted);font-size:.88rem}
.ftr-nav{display:flex;flex-wrap:wrap;gap:18px;margin:0 0 6px}.ftr-nav a:hover{color:var(--color-text)}
.ftr .badges{display:flex;gap:18px;flex-wrap:wrap}.ftr .badges span{display:inline-flex;align-items:center;gap:6px}.ftr .badges svg{width:16px;height:16px}
.center-msg{max-width:520px;margin:80px auto;text-align:center;padding:0 20px}.center-msg h1{font-size:1.6rem;margin:0 0 10px}.center-msg p{color:var(--color-muted)}
.preview-banner{position:sticky;top:0;z-index:30;background:#b45309;color:#fff;padding:10px 20px;font-weight:600;text-align:center;font-size:.9rem}
@media(max-width:720px){.pd-grid{grid-template-columns:1fr;gap:22px}.hero h1{font-size:1.6rem}.hero .wrap{padding:40px 20px}.hnav{gap:14px;font-size:.85rem}.grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}.pd-info h1{font-size:1.4rem}}`;

function page(title, tokens, bodyHtml, head = '') {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${head}<style>${tokensToCss(tokens)}\n${STYLE}</style></head>
<body>${bodyHtml}</body></html>`;
}

/** Render trang chủ theo layout của theme (hoặc mặc định). */
export function renderHome(ctx) {
  const layout = Array.isArray(ctx.theme?.layout) && ctx.theme.layout.length ? ctx.theme.layout : DEFAULT_LAYOUT;
  const body = layout
    .map((s) => (SECTIONS[s.section] ? SECTIONS[s.section](s.props ?? {}, ctx) : ''))
    .join('\n');
  return page(ctx.shop.name, ctx.theme?.tokens, body);
}

/** Render trang chi tiết sản phẩm + form "thêm vào giỏ" (POST thuần, không JS). */
export function renderProduct(ctx, p) {
  const media = Array.isArray(p.media) ? p.media : [];
  const main = media.length ? `<img src="${esc(media[0].url)}" alt="${esc(p.title)}">` : I_IMG;
  const thumbs = media.length > 1
    ? `<div class="thumbs">${media.slice(0, 6).map((m) => `<img src="${esc(m.url)}" alt="${esc(p.title)}" loading="lazy">`).join('')}</div>`
    : '';
  const options = p.variants.map((v) => `<option value="${esc(v.id)}">${esc(v.title ?? v.sku)} — ${money(v.price_vnd)}</option>`).join('');
  // action=/cart/add tới checkout service (cùng origin qua Caddy) → form-action 'self' cho phép.
  const addForm = p.variants.length ? `
    <form class="addcart" method="POST" action="/cart/add">
      ${p.variants.length > 1 ? `<select name="variant_id" aria-label="Phân loại">${options}</select>` : `<input type="hidden" name="variant_id" value="${esc(p.variants[0].id)}">`}
      <input type="number" name="qty" value="1" min="1" max="1000" inputmode="numeric" aria-label="Số lượng">
      <button class="btn btn-primary" type="submit">${I_CART}Thêm vào giỏ</button>
    </form>` : '';
  const body = `${SECTIONS.header({}, ctx)}
    <main class="wrap pd">
      <div class="crumb"><a href="/">Trang chủ</a> / ${esc(p.title)}</div>
      <div class="pd-grid">
        <div class="pd-media"><div class="main">${main}</div>${thumbs}</div>
        <div class="pd-info">
          <h1>${esc(p.title)}</h1>
          <div class="price">${money(p.price_vnd)}</div>
          ${addForm}
          ${p.description ? `<div class="desc">${esc(p.description)}</div>` : ''}
          <div class="trust"><span>${I_TRUCK}Giao hàng toàn quốc</span><span>${I_SHIELD}Thanh toán COD hoặc QR</span></div>
        </div>
      </div>
    </main>${SECTIONS.footer({}, ctx)}`;
  return page(`${p.title} — ${ctx.shop.name}`, ctx.theme?.tokens, body);
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
