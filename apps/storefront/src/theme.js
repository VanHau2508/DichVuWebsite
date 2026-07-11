/**
 * Theme engine storefront — token an toàn + section render + escape.
 *
 * Hai tính chất bảo mật (mỗi cái có test + mutation):
 *   - escapeHtml MỌI dữ liệu do shop/người bán nhập (tên sản phẩm...) → chống XSS.
 *   - sanitizeTokens: giá trị token (màu/font/radius) do shop kiểm soát, phải khớp
 *     mẫu an toàn trước khi đổ vào CSS → chống CSS injection / breakout.
 *   (ADR-008: shop KHÔNG được chèn JS/HTML/CSS tuỳ ý.)
 */

const AMP = /&/g, LT = /</g, GT = />/g, QUOT = /"/g, APOS = /'/g;
export function esc(s) {
  return String(s ?? '')
    .replace(AMP, '&amp;').replace(LT, '&lt;').replace(GT, '&gt;')
    .replace(QUOT, '&quot;').replace(APOS, '&#39;');
}

export const DEFAULT_TOKENS = {
  'color.primary': '#111827',
  'color.bg': '#ffffff',
  'color.text': '#111827',
  'color.muted': '#6b7280',
  'font.heading': 'system-ui',
  'font.body': 'system-ui',
  radius: '10px',
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

// ── section renderers (nhận dữ liệu ĐÃ đọc, escape khi render) ────────────────
const SECTIONS = {
  header: (props, ctx) => `<header class="hdr"><a href="/" class="brand">${esc(ctx.shop.name)}</a>
    <nav>${ctx.categories.map((c) => `<a href="/c/${esc(c.slug)}">${esc(c.name)}</a>`).join('')}</nav></header>`,

  hero: (props) => `<section class="hero"><h1>${esc(props.title ?? '')}</h1>
    <p>${esc(props.subtitle ?? '')}</p></section>`,

  product_grid: (props, ctx) => `<section class="grid-wrap"><h2>${esc(props.title ?? 'Sản phẩm')}</h2>
    <div class="grid">${ctx.products.map((p) => `
      <a class="card" href="/p/${esc(p.slug)}">
        ${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.title)}" loading="lazy">` : '<div class="ph"></div>'}
        <div class="ct">${esc(p.title)}</div>
        <div class="pr">${money(p.price_vnd)}</div>
      </a>`).join('')}</div></section>`,

  footer: (props, ctx) => {
    const menu = ctx.menu ?? [];
    const nav = menu.length
      ? `<nav class="ftr-nav">${menu.map((pg) => `<a href="/pages/${esc(pg.slug)}">${esc(pg.title)}</a>`).join('')}</nav>`
      : '';
    return `<footer class="ftr">${nav}<div>© ${esc(ctx.shop.name)}</div></footer>`;
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
  { section: 'product_grid', props: { title: 'Sản phẩm' } },
  { section: 'footer', props: {} },
];

const STYLE = `*{box-sizing:border-box}body{margin:0;font-family:var(--font-body);color:var(--color-text);background:var(--color-bg)}
a{color:inherit;text-decoration:none}.hdr{display:flex;justify-content:space-between;padding:var(--spacing);border-bottom:1px solid #eee}
.brand{font-family:var(--font-heading);font-weight:700;font-size:1.25rem;color:var(--color-primary)}
.hdr nav a{margin-left:12px;color:var(--color-muted)}.hero{padding:48px var(--spacing);text-align:center}
.hero h1{font-family:var(--font-heading);margin:0 0 8px}.hero p{color:var(--color-muted)}
.grid-wrap{padding:var(--spacing)}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:var(--spacing)}
.card{border:1px solid #eee;border-radius:var(--radius);overflow:hidden}.card img,.card .ph{width:100%;aspect-ratio:1;object-fit:cover;background:#f3f4f6;display:block}
.card .ct{padding:8px 10px 0}.card .pr{padding:0 10px 10px;color:var(--color-primary);font-weight:600}
.ftr{padding:var(--spacing);border-top:1px solid #eee;color:var(--color-muted)}
.ftr-nav a{margin-right:14px;color:var(--color-muted)}.ftr-nav{margin-bottom:8px}
.content h2{font-family:var(--font-heading);margin:1.4em 0 .4em}.content p{line-height:1.6;margin:0 0 1em}
.content ul{line-height:1.6;padding-left:1.2em;margin:0 0 1em}
.content blockquote{margin:1em 0;padding:.2em 0 .2em 1em;border-left:3px solid var(--color-primary);color:var(--color-muted)}
.content blockquote cite{display:block;margin-top:.4em;font-size:.9em;font-style:normal}
.content hr{border:0;border-top:1px solid #eee;margin:1.6em 0}
.preview-banner{position:sticky;top:0;z-index:10;background:#b45309;color:#fff;padding:10px var(--spacing);font-weight:700;text-align:center;font-size:.95rem}
.pd{padding:var(--spacing);max-width:900px;margin:0 auto}.pd h1{font-family:var(--font-heading)}
.pd .price{color:var(--color-primary);font-size:1.4rem;font-weight:700}.pd img{max-width:100%;border-radius:var(--radius)}`;

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

/** Render trang chi tiết sản phẩm. */
export function renderProduct(ctx, p) {
  const imgs = p.media.map((m) => `<img src="${esc(m.url)}" alt="${esc(p.title)}" loading="lazy">`).join('');
  const variants = p.variants.map((v) => `<option>${esc(v.title ?? v.sku)} — ${money(v.price_vnd)}</option>`).join('');
  const body = `${SECTIONS.header({}, ctx)}
    <main class="pd"><h1>${esc(p.title)}</h1>
      <div class="price">${money(p.price_vnd)}</div>
      ${imgs}
      <p>${esc(p.description ?? '')}</p>
      ${variants ? `<select aria-label="Biến thể">${variants}</select>` : ''}
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
    <main class="pd content"><h1>${esc(doc.title)}</h1>
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
  return page('Tạm ngưng', {}, `<main class="pd"><h1>Cửa hàng tạm ngưng</h1>
    <p>${esc(shopName)} hiện không nhận đơn. Vui lòng quay lại sau.</p></main>`);
}
export function renderNotFound() {
  return page('Không tìm thấy', {}, `<main class="pd"><h1>404</h1><p>Không tìm thấy trang.</p></main>`);
}
