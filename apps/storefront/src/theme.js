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

import { FONTFACE } from './site.js';

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
  'font.heading': '"Be Vietnam Pro", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  'font.body': '"Be Vietnam Pro", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
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
const I_RETURN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7v6h6"/><path d="M3.5 13a9 9 0 1 0 2.2-9.3L3 6"/></svg>';
const I_BADGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l2.4 1.8 3 .1.9 2.9 2.4 1.8-.9 2.9.9 2.9-2.4 1.8-.9 2.9-3 .1L12 22l-2.4-1.8-3-.1-.9-2.9L3.3 15.4l.9-2.9-.9-2.9 2.4-1.8.9-2.9 3-.1z"/><path d="M9 12l2 2 4-4"/></svg>';
const I_WALLET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h13v4"/><path d="M3 7v10a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-3"/><path d="M21 11v4h-4a2 2 0 0 1 0-4z"/></svg>';

// Giá GẠCH NGANG (compare-at, 0067 — CHỈ hiển thị, checkout luôn tính price_vnd):
// chỉ render khi compare > giá bán; kèm badge -N%.
const offPct = (price, cmp) => Math.round((1 - Number(price) / Number(cmp)) * 100);
const compareHtml = (price, cmp) =>
  (cmp != null && Number(cmp) > Number(price)
    ? ` <s class="cmp">${money(cmp)}</s><span class="off">-${offPct(price, cmp)}%</span>` : '');

// Thẻ sản phẩm dùng chung (lưới trang chủ / danh mục / tìm kiếm). Escape mọi field người bán.
function productCards(products) {
  return products.map((p) => {
    const out = Number(p.available) <= 0;
    return `<a class="card${out ? ' is-out' : ''}" href="/p/${esc(p.slug)}">
          <div class="thumb">${out ? '<span class="soldout-tag">Hết hàng</span>' : ''}${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.title)}" loading="lazy">` : `<span class="ph">${I_IMG}</span>`}</div>
          <div class="body"><div class="name">${esc(p.title)}</div><div class="price">${money(p.price_vnd)}${compareHtml(p.price_vnd, p.compare_at_vnd)}</div><span class="cta">Xem chi tiết →</span></div>
        </a>`;
  }).join('');
}
// Query sort đính kèm link (bỏ khi 'new' = mặc định → URL sạch).
const sortQs = (pi) => (pi?.sort && pi.sort !== 'new' ? `&sort=${pi.sort}` : '');
// Phân trang ← Trước / Sau → từ pageInfo {total, offset, pageSize, basePath, sort}.
function pager(pi) {
  if (!pi || pi.total <= pi.pageSize) return '';
  const cur = Math.floor(pi.offset / pi.pageSize) + 1;
  const last = Math.max(1, Math.ceil(pi.total / pi.pageSize));
  const link = (n) => esc(`${pi.basePath}${pi.basePath.includes('?') ? '&' : '?'}page=${n}${sortQs(pi)}`);
  const prev = cur > 1 ? `<a class="pg-btn" href="${link(cur - 1)}">← Trước</a>` : '<span class="pg-btn off">← Trước</span>';
  const next = cur < last ? `<a class="pg-btn" href="${link(cur + 1)}">Sau →</a>` : '<span class="pg-btn off">Sau →</span>';
  return `<nav class="pager">${prev}<span class="pg-info">Trang ${cur}/${last}</span>${next}</nav>`;
}
// Thanh sắp xếp no-JS (3 link GET, CSP-sạch) — trên lưới trang chủ / danh mục / tìm kiếm.
// Đổi sort = về trang 1 (không kèm page). Đang chọn → span (không phải link).
function sortBar(pi) {
  if (!pi) return '';
  const cur = pi.sort ?? 'new';
  const opts = [['new', 'Mới nhất'], ['price_asc', 'Giá tăng dần'], ['price_desc', 'Giá giảm dần']];
  const links = opts.map(([k, label]) => {
    if (k === cur) return `<span class="sort-link on" aria-current="true">${label}</span>`;
    const href = k === 'new' ? pi.basePath : `${pi.basePath}${pi.basePath.includes('?') ? '&' : '?'}sort=${k}`;
    return `<a class="sort-link" href="${esc(href)}">${label}</a>`;
  }).join('');
  return `<nav class="sortbar" aria-label="Sắp xếp sản phẩm"><span class="sort-lbl">Sắp xếp:</span>${links}</nav>`;
}

// Dải "vì sao chọn chúng tôi" — mặc định 4 cam kết. Shop có thể override qua props.items
// (nhưng text luôn escape khi render). icon chọn từ FEAT_ICON, giá trị lạ → khiên mặc định.
const FEAT_ICON = { truck: I_TRUCK, return: I_RETURN, badge: I_BADGE, wallet: I_WALLET, shield: I_SHIELD };
const DEFAULT_FEATURES = [
  { icon: 'truck', title: 'Giao hàng toàn quốc', desc: 'Nhận hàng tận nơi, nhanh chóng khắp 63 tỉnh thành.' },
  { icon: 'return', title: 'Đổi trả trong 7 ngày', desc: 'Chưa ưng ý? Đổi hoặc trả dễ dàng, không rắc rối.' },
  { icon: 'badge', title: 'Cam kết chính hãng', desc: 'Sản phẩm đúng mô tả, chất lượng đảm bảo.' },
  { icon: 'wallet', title: 'Thanh toán an toàn', desc: 'COD khi nhận hàng hoặc chuyển khoản QR tiện lợi.' },
];

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

  hero: (props, ctx) => {
    // Cột phải: sản phẩm đầu tiên CÓ ẢNH làm visual (giờ ảnh hiển thị được qua same-origin).
    // Không có ảnh nào → panel trang trí (icon) → hero vẫn cân đối, không vỡ layout.
    const feat = (Array.isArray(ctx.products) ? ctx.products : []).find((p) => p.image);
    const visual = feat
      ? `<a class="hero-media" href="/p/${esc(feat.slug)}">
          <img src="${esc(feat.image)}" alt="${esc(feat.title)}">
          <span class="hero-card"><span class="hc-name">${esc(feat.title)}</span><span class="hc-price">${money(feat.price_vnd)}</span></span>
        </a>`
      : `<div class="hero-media deco" aria-hidden="true">${I_SHIELD}</div>`;
    const ghost = (Array.isArray(ctx.categories) && ctx.categories.length)
      ? '<a class="btn btn-ghost" href="#bo-suu-tap">Bộ sưu tập</a>' : '';
    return `<section class="hero"><div class="hero-grid">
      <div class="hero-copy">
        <p class="eyebrow">${esc(props.eyebrow || 'Cửa hàng chính thức')}</p>
        <h1>${esc(props.title || ctx.shop.name)}</h1>
        <p>${esc(props.subtitle || 'Mua sắm dễ dàng — giao hàng toàn quốc, thanh toán COD hoặc chuyển khoản QR.')}</p>
        <div class="hero-cta"><a class="btn btn-primary" href="#san-pham">Xem sản phẩm</a>${ghost}</div>
      </div>
      ${visual}
    </div></section>`;
  },

  features: (props, ctx) => {
    const items = (Array.isArray(props.items) && props.items.length ? props.items : DEFAULT_FEATURES).slice(0, 4);
    return `<section class="features"><div class="wrap">
      <div class="feat-grid">${items.map((f) => `<div class="feat-item">
        <span class="feat-ic">${FEAT_ICON[f.icon] || I_SHIELD}</span>
        <div><div class="feat-t">${esc(f.title)}</div><div class="feat-d">${esc(f.desc)}</div></div>
      </div>`).join('')}</div>
    </div></section>`;
  },

  // Bộ sưu tập: tái sử dụng danh mục của shop → tile lớn dẫn tới /c/:slug. Rỗng nếu chưa có danh mục.
  collections: (props, ctx) => {
    const cats = Array.isArray(ctx.categories) ? ctx.categories.slice(0, 8) : [];
    if (!cats.length) return '';
    return `<section class="section collections" id="bo-suu-tap"><div class="wrap">
      <div class="section-h"><h2>${esc(props.title || 'Mua theo bộ sưu tập')}</h2></div>
      <div class="coll-grid">${cats.map((c) => `<a class="coll-tile" href="/c/${esc(c.slug)}"><span class="coll-name">${esc(c.name)}</span><span class="coll-go">Xem tất cả →</span></a>`).join('')}</div>
    </div></section>`;
  },

  product_grid: (props, ctx) => {
    const chips = ctx.categories.length
      ? `<div class="chips"><a class="chip" href="/">Tất cả</a>${ctx.categories.map((c) => `<a class="chip" href="/c/${esc(c.slug)}">${esc(c.name)}</a>`).join('')}</div>`
      : '';
    const cards = ctx.products.length ? productCards(ctx.products) : '<p class="empty">Cửa hàng chưa có sản phẩm nào.</p>';
    return `<section class="section" id="san-pham"><div class="wrap">
      <div class="section-h"><h2>${esc(props.title || 'Sản phẩm')}</h2></div>
      ${chips}
      ${ctx.products.length ? sortBar(ctx.pageInfo) : ''}
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

const STYLE = `${FONTFACE}
:root{--r-sm:10px;--r:14px;--r-lg:20px;--r-xl:26px;--pill:999px;--sh-sm:0 1px 2px rgba(13,21,38,.05),0 2px 6px -2px rgba(13,21,38,.08);--sh:0 10px 26px -14px rgba(13,21,38,.20),0 2px 6px -3px rgba(13,21,38,.08);--sh-lg:0 30px 60px -28px rgba(13,21,38,.32)}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;font-family:var(--font-body);color:var(--color-text);background:var(--color-bg);line-height:1.6;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:inherit;text-decoration:none}img{max-width:100%;display:block}
h1,h2,h3{font-family:var(--font-heading);font-weight:800;letter-spacing:-.02em;line-height:1.18;color:var(--color-text);text-wrap:balance}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px}
.i{display:inline-flex}.i svg,.cart svg{width:18px;height:18px}
.muted{color:var(--color-muted)}
a:focus-visible,.btn:focus-visible,summary:focus-visible,button:focus-visible,.th:focus-visible,.chip:focus-visible{outline:2.5px solid var(--color-primary);outline-offset:2px;border-radius:10px}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}html{scroll-behavior:auto}}
.hdr{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--color-bg) 82%,transparent);backdrop-filter:saturate(1.6) blur(12px);-webkit-backdrop-filter:saturate(1.6) blur(12px);border-bottom:1px solid color-mix(in srgb,var(--color-border) 65%,transparent)}
.hdr .wrap{display:flex;align-items:center;justify-content:space-between;min-height:66px;gap:16px}
.brand{font-family:var(--font-heading);font-weight:800;font-size:1.24rem;letter-spacing:-.02em;color:var(--color-text);white-space:nowrap;display:inline-flex;align-items:center}
.brand-logo{max-height:40px;max-width:180px;width:auto;display:block}
.hnav{display:flex;align-items:center;gap:24px;font-size:.92rem;flex-wrap:wrap}
.hnav a{color:var(--color-muted);font-weight:500;transition:color .15s}.hnav a:hover{color:var(--color-primary)}
.hnav .cart{display:inline-flex;align-items:center;gap:6px;color:var(--color-text);font-weight:600}.hnav .cart:hover{color:var(--color-primary)}
.hero{background:var(--color-hero-bg);position:relative;overflow:hidden}
.hero::before,.hero::after{content:"";position:absolute;border-radius:50%;filter:blur(70px);z-index:0;pointer-events:none}
.hero::before{width:360px;height:360px;top:-130px;left:-90px;background:color-mix(in srgb,var(--color-primary) 24%,transparent)}
.hero::after{width:320px;height:320px;bottom:-150px;right:-70px;background:color-mix(in srgb,var(--color-accent) 20%,transparent)}
.hero-grid{position:relative;z-index:1;max-width:1120px;margin:0 auto;padding:64px 20px;display:grid;grid-template-columns:1.05fr .95fr;gap:48px;align-items:center}
.hero-copy .eyebrow{display:inline-flex;align-items:center;gap:7px;color:var(--color-primary);font-weight:700;font-size:.76rem;letter-spacing:.09em;text-transform:uppercase;margin:0 0 16px;padding:6px 14px;border-radius:var(--pill);background:color-mix(in srgb,var(--color-primary) 12%,transparent);border:1px solid color-mix(in srgb,var(--color-primary) 22%,transparent)}
.hero-copy h1{margin:0 0 16px;font-size:clamp(2.1rem,3.6vw,3.2rem);font-weight:800;letter-spacing:-.025em;line-height:1.1;color:var(--color-text)}
@supports ((-webkit-background-clip:text) or (background-clip:text)){.hero-copy h1{background-image:linear-gradient(120deg,var(--color-primary),var(--color-accent));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent}}
.hero-copy p{margin:0;color:color-mix(in srgb,var(--color-text) 72%,var(--color-bg));font-size:1.1rem;line-height:1.65;max-width:46ch}
.hero-cta{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}
.hero-media{position:relative;display:block;border-radius:var(--r-xl);overflow:hidden;aspect-ratio:4/3;border:1px solid color-mix(in srgb,var(--color-border) 80%,transparent);box-shadow:var(--sh-lg);transition:transform .35s cubic-bezier(.2,.7,.2,1),box-shadow .35s}
.hero-media:hover{transform:translateY(-3px);box-shadow:0 42px 70px -30px rgba(13,21,38,.42)}
.hero-media img{width:100%;height:100%;object-fit:cover;transition:transform .5s cubic-bezier(.2,.7,.2,1)}
.hero-media:hover img{transform:scale(1.05)}
.hero-card{position:absolute;left:14px;right:14px;bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:10px;background:rgba(255,255,255,.94);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);border-radius:var(--r);padding:12px 16px;box-shadow:0 14px 30px -16px rgba(13,21,38,.5)}
.hc-name{font-weight:600;font-size:.92rem;color:#111827;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.hc-price{font-weight:800;color:color-mix(in srgb,var(--color-primary) 68%,#111827);white-space:nowrap;font-variant-numeric:tabular-nums}
.hero-media.deco{display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--color-primary) 10%,var(--color-bg));color:var(--color-primary);box-shadow:none}
.hero-media.deco svg{width:88px;height:88px;opacity:.85}
@media(max-width:820px){.hero-grid{grid-template-columns:1fr;gap:26px;padding:40px 20px;text-align:center}.hero-copy p{max-width:none}.hero-cta{justify-content:center}.hero-media{max-width:440px;width:100%;margin:0 auto}}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;font-family:var(--font-body);font-size:1rem;font-weight:600;min-height:48px;padding:12px 26px;border-radius:var(--pill);border:1px solid transparent;cursor:pointer;transition:transform .12s cubic-bezier(.2,.7,.2,1),background-position .35s,box-shadow .2s,border-color .15s,color .15s,background .15s;line-height:1}
.btn:active{transform:translateY(1px)}.btn svg{width:18px;height:18px}
.btn-primary{background:linear-gradient(135deg,var(--color-primary),color-mix(in srgb,var(--color-primary) 55%,var(--color-accent)));background-size:150% 150%;color:#fff;box-shadow:0 10px 26px -12px color-mix(in srgb,var(--color-primary) 66%,transparent)}
.btn-primary:hover{background-position:100% 0;transform:translateY(-1px);box-shadow:0 16px 32px -14px color-mix(in srgb,var(--color-primary) 72%,transparent)}
.btn-ghost{background:var(--color-bg);color:var(--color-text);border-color:color-mix(in srgb,var(--color-primary) 30%,var(--color-border))}.btn-ghost:hover{border-color:var(--color-primary);color:var(--color-primary);background:color-mix(in srgb,var(--color-primary) 6%,var(--color-bg))}
.section{padding:56px 0}.section-h{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin:0 0 24px}.section-h h2{margin:0;font-size:1.5rem;font-weight:800;letter-spacing:-.02em}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 24px}
.chip{border:1px solid var(--color-border);border-radius:var(--pill);padding:8px 16px;font-size:.86rem;font-weight:500;color:var(--color-muted);background:var(--color-bg);transition:border-color .15s,color .15s,background .15s,box-shadow .15s}
.chip:hover{border-color:var(--color-primary);color:var(--color-primary);background:color-mix(in srgb,var(--color-primary) 8%,var(--color-bg));box-shadow:0 6px 16px -8px color-mix(in srgb,var(--color-primary) 45%,transparent)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:22px}
.empty{color:var(--color-muted);padding:28px 0;text-align:center}
.features{background:var(--color-surface);border-top:1px solid var(--color-border);border-bottom:1px solid var(--color-border)}
.features .wrap{padding:36px 20px}
.feat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:26px}
.feat-item{display:flex;align-items:flex-start;gap:14px}
.feat-ic{flex:0 0 auto;width:48px;height:48px;border-radius:var(--r);background:linear-gradient(135deg,color-mix(in srgb,var(--color-primary) 16%,var(--color-bg)),color-mix(in srgb,var(--color-accent) 12%,var(--color-bg)));color:var(--color-primary);display:flex;align-items:center;justify-content:center;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--color-primary) 14%,transparent)}
.feat-ic svg{width:23px;height:23px}
.feat-t{font-weight:700;font-size:.98rem;color:var(--color-text);margin-bottom:3px}
.feat-d{font-size:.85rem;color:var(--color-muted);line-height:1.5}
.coll-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:16px}
.coll-tile{position:relative;display:flex;flex-direction:column;justify-content:flex-end;gap:4px;min-height:112px;padding:18px 20px;border-radius:var(--r-lg);background:linear-gradient(135deg,var(--color-hero-bg),color-mix(in srgb,var(--color-hero-bg) 55%,var(--color-bg)));border:1px solid var(--color-border);overflow:hidden;transition:transform .2s cubic-bezier(.2,.7,.2,1),box-shadow .2s,border-color .2s}
.coll-tile:hover{transform:translateY(-3px);border-color:color-mix(in srgb,var(--color-primary) 42%,var(--color-border));box-shadow:var(--sh)}
.coll-name{font-family:var(--font-heading);font-weight:700;font-size:1.02rem;color:var(--color-text);line-height:1.3}
.coll-go{font-size:.8rem;font-weight:700;color:var(--color-primary)}
.hsearch{flex:1 1 180px;max-width:280px;margin:0 8px}
.hsearch input{width:100%;padding:10px 15px;border:1px solid var(--color-border);border-radius:var(--pill);font-size:.9rem;font-family:inherit;background:var(--color-surface);color:var(--color-text);transition:border-color .15s,box-shadow .15s}
.hsearch input:focus{outline:none;border-color:var(--color-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--color-primary) 22%,transparent)}
.searchbar{display:flex;gap:10px;margin:0 0 24px;max-width:520px}
.searchbar input{flex:1;padding:12px 16px;border:1px solid var(--color-border);border-radius:var(--pill);font-size:1rem;font-family:inherit;background:var(--color-bg);color:var(--color-text);transition:border-color .15s,box-shadow .15s}
.searchbar input:focus{outline:none;border-color:var(--color-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--color-primary) 22%,transparent)}
.pager{display:flex;align-items:center;justify-content:center;gap:16px;margin:36px 0 8px}
.pg-btn{padding:10px 20px;border:1px solid var(--color-border);border-radius:var(--pill);color:var(--color-text);font-size:.9rem;font-weight:600;transition:border-color .15s,color .15s,background .15s}
.pg-btn:hover{border-color:var(--color-primary);color:var(--color-primary);background:color-mix(in srgb,var(--color-primary) 6%,var(--color-bg))}
.pg-btn.off{color:#c9ced6;pointer-events:none}
.pg-info{color:var(--color-muted);font-size:.88rem;font-variant-numeric:tabular-nums}
/* Giá gạch ngang + badge -% (kích thước theo em → tự cân trong thẻ lưới lẫn trang SP). */
.cmp{color:var(--color-muted);font-weight:500;font-size:.72em;text-decoration:line-through;margin-left:7px;font-variant-numeric:tabular-nums}
.off{display:inline-block;background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;font-size:.56em;font-weight:800;border-radius:6px;padding:1px 6px;margin-left:6px;vertical-align:middle;line-height:1.5}
/* Thanh sắp xếp lưới sản phẩm (no-JS, 3 link). */
.sortbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 20px;font-size:.88rem}
.sort-lbl{color:var(--color-muted)}
.sort-link{padding:7px 14px;border:1px solid var(--color-border);border-radius:var(--pill);color:var(--color-muted);font-weight:500;transition:border-color .15s,color .15s,background .15s}
a.sort-link:hover{border-color:var(--color-primary);color:var(--color-primary);background:color-mix(in srgb,var(--color-primary) 6%,var(--color-bg))}
.sort-link.on{border-color:var(--color-primary);color:var(--color-primary);background:var(--color-hero-bg);font-weight:700}
.blog-list{display:grid;gap:18px;max-width:760px}
.blog-card{border:1px solid var(--color-border);border-radius:var(--r-lg);padding:22px 26px;background:var(--color-bg);box-shadow:var(--sh-sm);transition:transform .2s cubic-bezier(.2,.7,.2,1),border-color .2s,box-shadow .2s}
.blog-card:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--color-primary) 34%,var(--color-border));box-shadow:var(--sh)}
.blog-card h2{margin:0 0 4px;font-size:1.3rem;font-weight:800;letter-spacing:-.02em;line-height:1.3}
.blog-card h2 a{color:var(--color-text)}.blog-card h2 a:hover{color:var(--color-primary)}
.blog-date{color:var(--color-muted);font-size:.84rem;margin:0 0 10px}
.blog-card p{color:var(--color-muted);margin:0 0 12px;line-height:1.7}
.blog-more{color:var(--color-primary);font-weight:700;font-size:.92rem}
.blog-post{max-width:720px}.blog-post h1{margin:10px 0 2px;font-size:2rem;font-weight:800;letter-spacing:-.02em}
.blog-post p{line-height:1.85;color:var(--color-text);margin:0 0 18px}
.card{display:flex;flex-direction:column;background:var(--color-bg);border:1px solid var(--color-border);border-radius:var(--r-lg);overflow:hidden;box-shadow:var(--sh-sm);transition:transform .25s cubic-bezier(.2,.7,.2,1),box-shadow .25s,border-color .25s}
.card:hover{transform:translateY(-4px);border-color:color-mix(in srgb,var(--color-primary) 34%,var(--color-border));box-shadow:var(--sh)}
.card .thumb{position:relative;aspect-ratio:1;background:var(--color-surface);overflow:hidden}
.card .thumb img{width:100%;height:100%;object-fit:cover;transition:transform .35s cubic-bezier(.2,.7,.2,1)}
.card:hover .thumb img{transform:scale(1.04)}
.card .thumb .ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#c4c8cf}.card .thumb .ph svg{width:34px;height:34px}
.card .body{padding:14px 16px 16px;display:flex;flex-direction:column;gap:6px;flex:1}
.card .name{font-size:.92rem;color:var(--color-text);line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.6em}
.card .price{font-weight:800;color:var(--color-text);font-size:1.1rem;letter-spacing:-.01em;font-variant-numeric:tabular-nums;margin-top:auto}
.card .cta{font-size:.82rem;color:var(--color-primary);font-weight:700}
.pd{padding:28px 20px 52px}
.crumb{font-size:.85rem;color:var(--color-muted);margin:0 0 20px}.crumb a:hover{color:var(--color-primary)}
.pd-grid{display:grid;grid-template-columns:1fr 1fr;gap:44px;align-items:start}
.pd-media{display:flex;flex-direction:column;gap:12px}
.pd-media .main{aspect-ratio:1;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--r-lg);overflow:hidden;display:flex;align-items:center;justify-content:center;color:#c4c8cf;box-shadow:var(--sh-sm)}
.pd-media .main img{width:100%;height:100%;object-fit:cover}.pd-media .main svg{width:56px;height:56px}
.pd-media .thumbs{display:flex;gap:10px;flex-wrap:wrap}
.pd-media .thumbs img{width:74px;height:74px;object-fit:cover;border:1px solid var(--color-border);border-radius:10px}
.pd-info h1{margin:0 0 12px;font-size:2rem;font-weight:800;letter-spacing:-.02em;line-height:1.18}
.pd-info .price{font-size:1.8rem;font-weight:800;letter-spacing:-.02em;color:var(--color-primary);margin:0 0 20px;font-variant-numeric:tabular-nums}
.pd-info .desc{color:color-mix(in srgb,var(--color-text) 72%,var(--color-bg));line-height:1.75;margin:0 0 24px;white-space:pre-line}
.addcart{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:0 0 22px}
.addcart select,.addcart input{padding:12px 14px;border:1px solid #d6d6d6;border-radius:var(--r);font-size:1rem;font-family:inherit;background:var(--color-bg);color:var(--color-text)}
.addcart select:focus,.addcart input:focus{outline:none;border-color:var(--color-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--color-primary) 22%,transparent)}
.addcart input[type=number]{width:88px;text-align:center}
.stock{display:inline-flex;align-items:center;gap:6px;font-size:.9rem;font-weight:700;padding:6px 14px;border-radius:var(--pill);margin:0 0 18px}
.stock.in{background:var(--color-hero-bg);color:color-mix(in srgb,var(--color-primary) 82%,#000)}
.stock.low{background:#fff7ed;color:#c2410c}
.stock.out{background:#fef2f2;color:#b91c1c}
.soldout-note{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:var(--r);padding:14px 16px;font-weight:600;margin:0 0 22px}
.card .soldout-tag{position:absolute;top:10px;left:10px;z-index:1;background:rgba(17,24,39,.82);color:#fff;font-size:.76rem;font-weight:600;padding:4px 10px;border-radius:var(--pill);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)}
.card.is-out .thumb img{opacity:.55;filter:grayscale(.3)}
.trust{display:flex;gap:22px;flex-wrap:wrap;color:var(--color-muted);font-size:.85rem;border-top:1px solid var(--color-border);padding-top:18px}
.trust span{display:inline-flex;align-items:center;gap:6px}.trust svg{width:16px;height:16px;color:var(--color-primary)}
.content{max-width:720px;margin:0 auto;padding:44px 20px 64px}
.content h1{font-size:2.1rem;margin:0 0 .6em;font-weight:800;letter-spacing:-.02em}.content h2{margin:1.6em 0 .4em;font-size:1.35rem;font-weight:800;letter-spacing:-.02em}
.content p{line-height:1.8;margin:0 0 1.1em;color:color-mix(in srgb,var(--color-text) 72%,var(--color-bg))}.content ul{line-height:1.8;padding-left:1.3em;margin:0 0 1.1em}
.content blockquote{margin:1.4em 0;padding:.6em 0 .6em 1.2em;border-left:3px solid var(--color-primary);color:var(--color-muted);font-style:italic}
.content blockquote cite{display:block;margin-top:.5em;font-size:.88em;font-style:normal}
.content hr{border:0;border-top:1px solid var(--color-border);margin:2em 0}
.ftr{border-top:1px solid var(--color-border);background:var(--color-surface);margin-top:36px}
.ftr .wrap{padding:36px 20px;display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between;color:var(--color-muted);font-size:.88rem}
.ftr-nav{display:flex;flex-wrap:wrap;gap:20px;margin:0 0 6px}.ftr-nav a{font-weight:500;transition:color .15s}.ftr-nav a:hover{color:var(--color-primary)}
.ftr-contact{font-size:.85rem;color:var(--color-muted);margin:0 0 6px;line-height:1.6}
.ftr .badges{display:flex;gap:20px;flex-wrap:wrap}.ftr .badges span{display:inline-flex;align-items:center;gap:6px}.ftr .badges svg{width:16px;height:16px;color:var(--color-primary)}
.center-msg{max-width:520px;margin:80px auto;text-align:center;padding:0 20px}.center-msg h1{font-size:1.8rem;margin:0 0 10px;font-weight:800;letter-spacing:-.02em}.center-msg p{color:var(--color-muted)}
.preview-banner{position:sticky;top:0;z-index:30;background:#b45309;color:#fff;padding:10px 20px;font-weight:600;text-align:center;font-size:.9rem}
/* ── Trang sản phẩm nâng cấp: gallery no-JS (radio+:checked), chip biến thể, specs, lightbox ── */
.vh{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.pd-media .main{position:relative}
.pd-media .stack{position:absolute;inset:0}
.pd-media .slide{display:none;position:absolute;inset:0}
.pd-media .slide img{width:100%;height:100%;object-fit:cover;cursor:zoom-in}
${Array.from({ length: 8 }, (_, i) => `#gsel-${i}:checked~.main .stack .s-${i}{display:block}#gsel-${i}:checked~.thumbs .t-${i}{border-color:var(--color-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--color-primary) 30%,transparent)}`).join('')}
.pd-media .thumbs .th{width:70px;height:70px;border:2px solid var(--color-border);border-radius:10px;overflow:hidden;cursor:pointer;padding:0;background:none;display:block;transition:border-color .15s,box-shadow .15s}
.pd-media .thumbs .th:hover{border-color:color-mix(in srgb,var(--color-primary) 55%,var(--color-border))}
.pd-media .thumbs .th img{width:100%;height:100%;object-fit:cover;display:block;border:0;border-radius:0}
.lightbox{display:none}
.lightbox:target{display:flex;position:fixed;inset:0;z-index:50;align-items:center;justify-content:center;background:rgba(17,24,39,.88);padding:20px}
.lightbox .lb-bg{position:absolute;inset:0}
.lightbox img{position:relative;max-width:96vw;max-height:92vh;object-fit:contain;border-radius:12px;box-shadow:0 40px 80px -30px rgba(0,0,0,.6)}
.pd-sku{font-size:.82rem;color:var(--color-muted);margin:-8px 0 12px}
.opt{margin:0 0 16px}.opt-name{font-size:.85rem;font-weight:600;color:var(--color-muted);margin:0 0 8px}
/* Chip biến thể GIỚI HẠN trong .opt — tránh đè .chip lọc danh mục trang chủ (trùng tên class). */
.opt .chips{display:flex;gap:8px;flex-wrap:wrap}
.opt .chip{display:inline-block;padding:9px 15px;border:1px solid var(--color-border);border-radius:var(--r-sm);font-size:.9rem;color:var(--color-text);background:var(--color-bg);cursor:pointer;transition:border-color .15s,background .15s,box-shadow .15s}
.opt .chip:hover{border-color:var(--color-primary)}
.opt .chip.sel{border-color:var(--color-primary);background:var(--color-hero-bg);color:color-mix(in srgb,var(--color-primary) 82%,#000);font-weight:700;box-shadow:0 0 0 3px color-mix(in srgb,var(--color-primary) 16%,transparent)}
.opt .chip.out{color:var(--color-muted);text-decoration:line-through}
.opt .chip.disabled{color:#c4c8cf;background:var(--color-surface);border-style:dashed;cursor:not-allowed;text-decoration:line-through}
.pd-actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:6px 0 22px}
.pd-actions .qty{padding:12px 14px;border:1px solid #d6d6d6;border-radius:var(--r);font-size:1rem;font-family:inherit;background:var(--color-bg);color:var(--color-text);width:84px;text-align:center}
.pd-actions .qty:focus{outline:none;border-color:var(--color-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--color-primary) 22%,transparent)}
.btn-alt{background:var(--color-bg);color:var(--color-primary);border:1px solid color-mix(in srgb,var(--color-primary) 55%,var(--color-border))}
.btn-alt:hover{background:color-mix(in srgb,var(--color-primary) 8%,var(--color-bg));border-color:var(--color-primary)}
.pd-block{margin:44px 0 0;padding:28px 0 0;border-top:1px solid var(--color-border)}
.pd-block h2{font-size:1.25rem;font-weight:800;letter-spacing:-.02em;margin:0 0 16px}
.pd-block .desc{color:color-mix(in srgb,var(--color-text) 72%,var(--color-bg));line-height:1.8}
.pd-block .desc p{margin:0 0 12px}.pd-block .desc ul{margin:0 0 12px;padding-left:1.3em;line-height:1.8}
.specs{border-collapse:collapse;width:100%;max-width:560px;font-variant-numeric:tabular-nums}
.specs th,.specs td{text-align:left;padding:11px 14px;border:1px solid var(--color-border);font-size:.92rem;vertical-align:top}
.specs th{background:var(--color-surface);color:var(--color-muted);font-weight:700;width:38%}
/* ── Đánh giá sản phẩm ── */
.pd-rating{display:inline-flex;align-items:center;gap:6px;font-size:.9rem;color:var(--color-muted);margin:-6px 0 10px;transition:color .15s}
.pd-rating:hover{color:var(--color-primary)}
.st{color:#f59e0b;letter-spacing:1px}
.rv{border-bottom:1px solid var(--color-border);padding:14px 0}
.rv-head{display:flex;align-items:center;gap:8px;font-size:.92rem}
.rv-ok{color:#15803d;font-size:.78rem;font-weight:600;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:var(--pill);padding:2px 8px}
.rv p{margin:6px 0 0;color:color-mix(in srgb,var(--color-text) 75%,var(--color-bg));line-height:1.65}
.rv-note{border-radius:var(--r);padding:12px 15px;margin:0 0 14px;font-size:.9rem;font-weight:500}
.rv-note.ok{background:#f0fdf4;border:1px solid #bbf7d0;color:#15803d}
.rv-note.err{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c}
.rv-form{margin-top:16px}.rv-form summary{cursor:pointer;color:var(--color-primary);font-weight:700}
.rv-form form{display:flex;flex-direction:column;gap:10px;margin-top:12px;max-width:480px}
.rv-form input,.rv-form textarea{padding:11px 13px;border:1px solid #d6d6d6;border-radius:var(--r-sm);font-size:.95rem;font-family:inherit;background:var(--color-bg);color:var(--color-text);transition:border-color .15s,box-shadow .15s}
.rv-form input:focus,.rv-form textarea:focus{outline:none;border-color:var(--color-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--color-primary) 22%,transparent)}
.rv-form .hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}
.rv-verify{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:.85rem}
.rv-verify input{width:130px}
/* Chọn sao no-JS: radio ẩn + label ★; hàng đảo (5→1) + flex row-reverse → tô "từ trái sang"
   bằng :checked ~ (các label SAU radio đã chọn trong DOM = các sao BÊN TRÁI khi đảo chiều). */
.rv-stars{display:inline-flex;flex-direction:row-reverse;gap:2px}
.rv-stars input{position:absolute;width:1px;height:1px;opacity:0}
.rv-stars label{font-size:1.7rem;color:#d1d5db;cursor:pointer;line-height:1}
.rv-stars input:checked ~ label,.rv-stars label:hover,.rv-stars label:hover ~ label{color:#f59e0b}
@media(max-width:720px){.pd-grid{grid-template-columns:1fr;gap:24px}.hnav{gap:14px;font-size:.85rem}.grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}.pd-info h1{font-size:1.5rem}.pd-actions .btn{flex:1}}`;

function page(title, tokens, bodyHtml, head = '') {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${head}<style>${tokensToCss(tokens)}\n${STYLE}</style></head>
<body>${bodyHtml}</body></html>`;
}

// Chèn dải "cam kết" (sau hero) và "bộ sưu tập" (trước lưới sản phẩm) nếu layout đã lưu
// chưa có — để cả theme cũ (lưu trước khi có 2 khối này) vẫn hiển thị trang chủ giàu hơn.
function withHomeSections(layout) {
  const has = (name) => layout.some((s) => s && s.section === name);
  const out = layout.slice();
  if (!has('features')) {
    const hi = out.findIndex((s) => s && s.section === 'hero');
    out.splice(hi >= 0 ? hi + 1 : 1, 0, { section: 'features', props: {} });
  }
  if (!has('collections')) {
    // Chèn NGAY TRƯỚC lưới sản phẩm; nếu layout không có product_grid thì bỏ qua
    // (không nhét collections xuống sau footer).
    const gi = out.findIndex((s) => s && s.section === 'product_grid');
    if (gi >= 0) out.splice(gi, 0, { section: 'collections', props: {} });
  }
  return out;
}

/** Render trang chủ theo layout của theme (hoặc mặc định). */
export function renderHome(ctx, { canonical = null } = {}) {
  const base = Array.isArray(ctx.theme?.layout) && ctx.theme.layout.length ? ctx.theme.layout : DEFAULT_LAYOUT;
  const layout = withHomeSections(base);
  const body = layout
    .map((s) => (SECTIONS[s.section] ? SECTIONS[s.section](s.props ?? {}, ctx) : ''))
    .join('\n');
  const head = metaHead({
    description: `${ctx.shop.name} — cửa hàng trực tuyến. Giao hàng toàn quốc, thanh toán COD hoặc chuyển khoản QR.`,
    canonical, ogTitle: ctx.shop.name, siteName: ctx.shop.name, ogImage: shopOgImage(ctx),
  });
  return page(ctx.shop.name, ctx.theme?.tokens, body, head);
}

// Mô tả có ĐỊNH DẠNG (no-JS, CSP-sạch): tách đoạn theo dòng trống; dòng bắt đầu "- "/"• "
// gộp thành danh sách. Nội dung ĐỀU esc() (chống XSS) — chỉ thẻ khối do ta sinh.
function formatDesc(text) {
  const blocks = String(text).replace(/\r\n?/g, '\n').split(/\n{2,}/);
  return blocks.map((blk) => {
    const lines = blk.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return '';
    if (lines.every((l) => /^[-•]\s+/.test(l))) {
      return `<ul>${lines.map((l) => `<li>${esc(l.replace(/^[-•]\s+/, ''))}</li>`).join('')}</ul>`;
    }
    return `<p>${lines.map((l) => esc(l)).join('<br>')}</p>`;
  }).join('');
}

/** Render trang chi tiết sản phẩm kiểu Shopee (no-JS): gallery bấm đổi ảnh (radio+:checked) +
 *  phóng to (:target), chọn biến thể ĐA TRỤC đổi giá/tồn/ảnh (SSR ?variant=), bảng thông số,
 *  sản phẩm liên quan, "Mua ngay". Mọi tương tác chạy bằng HTML+CSS, KHÔNG JavaScript. */
export function renderProduct(ctx, p, { canonical = null } = {}) {
  const variants = Array.isArray(p.variants) ? p.variants : [];
  const options = Array.isArray(p.options) ? p.options : [];
  const allMedia = Array.isArray(p.media) ? p.media : [];
  const av = (v) => Math.max(0, Number(v?.available) || 0);

  // Biến thể đang chọn: từ ?variant= (nếu hợp lệ) → biến thể còn hàng đầu tiên → biến thể đầu.
  const selected = variants.find((v) => v.id === p.selectedId) || variants.find((v) => av(v) > 0) || variants[0] || null;

  // Ảnh gallery cho biến thể đang chọn: ảnh RIÊNG biến thể (nếu có) + ảnh CHUNG sản phẩm.
  const variantImgs = selected ? allMedia.filter((m) => m.variant_id === selected.id) : [];
  const commonImgs = allMedia.filter((m) => !m.variant_id);
  let gallery = [...variantImgs, ...commonImgs];
  if (!gallery.length) gallery = allMedia;
  gallery = gallery.slice(0, 8);

  // ── Gallery no-JS: radio ẩn + :checked đổi ảnh chính; bấm ảnh chính mở lightbox (:target).
  const galleryHtml = gallery.length ? `
      <div class="pd-media" id="gallery">
        ${gallery.map((_, i) => `<input class="gsel vh" type="radio" name="gsel" id="gsel-${i}"${i === 0 ? ' checked' : ''} aria-label="Ảnh ${i + 1}">`).join('')}
        <div class="main"><div class="stack">${gallery.map((m, i) => `<a class="slide s-${i}" href="#lb-${i}" aria-label="Phóng to"><img src="${esc(m.url)}" alt="${esc(p.title)}"${i ? ' loading="lazy"' : ''}></a>`).join('')}</div></div>
        ${gallery.length > 1 ? `<div class="thumbs">${gallery.map((m, i) => `<label class="th t-${i}" for="gsel-${i}"><img src="${esc(m.url)}" alt="" loading="lazy"></label>`).join('')}</div>` : ''}
        ${gallery.map((m, i) => `<div class="lightbox" id="lb-${i}"><a class="lb-bg" href="#gallery" aria-label="Đóng"></a><img src="${esc(m.url)}" alt="${esc(p.title)}"></div>`).join('')}
      </div>` : '<div class="pd-media"><div class="main">' + I_IMG + '</div></div>';

  // ── Bộ chọn phân loại. bySig: chữ ký value_id theo thứ tự trục → biến thể (resolve tổ hợp).
  const sig = (vals) => options.map((o) => vals?.[o.id] ?? '').join('|');
  const bySig = new Map(variants.map((v) => [sig(v.values), v]));
  const link = (vid) => `/p/${encodeURIComponent(p.slug)}?variant=${encodeURIComponent(vid)}`;
  let selector = '';
  if (options.length && selected) {
    selector = options.map((o) => {
      const chips = o.values.map((val) => {
        const tv = bySig.get(sig({ ...selected.values, [o.id]: val.id })); // đổi 1 trục, giữ trục khác
        const isSel = selected.values[o.id] === val.id;
        if (!tv) return `<span class="chip disabled">${esc(val.value)}</span>`;
        return `<a class="chip${isSel ? ' sel' : ''}${av(tv) <= 0 ? ' out' : ''}" href="${esc(link(tv.id))}"${isSel ? ' aria-current="true"' : ''}>${esc(val.value)}</a>`;
      }).join('');
      return `<div class="opt"><div class="opt-name">${esc(o.name)}</div><div class="chips">${chips}</div></div>`;
    }).join('');
  } else if (variants.length > 1) {
    // Không có trục: mỗi biến thể là 1 chip (một trục ngầm "Phân loại").
    const chips = variants.map((v) => {
      const isSel = selected && v.id === selected.id;
      return `<a class="chip${isSel ? ' sel' : ''}${av(v) <= 0 ? ' out' : ''}" href="${esc(link(v.id))}"${isSel ? ' aria-current="true"' : ''}>${esc(v.title || v.sku)}</a>`;
    }).join('');
    selector = `<div class="opt"><div class="opt-name">Phân loại</div><div class="chips">${chips}</div></div>`;
  }

  const price = selected ? selected.price_vnd : p.price_vnd;
  const selAvail = selected ? av(selected) : 0;
  const totalAvail = variants.reduce((s, v) => s + av(v), 0);
  const soldOut = totalAvail <= 0;
  const stockBadge = soldOut ? '<div class="stock out">Hết hàng</div>'
    : selAvail <= 0 ? '<div class="stock out">Phân loại này đã hết</div>'
    : selAvail <= 5 ? `<div class="stock low">Chỉ còn ${selAvail}</div>`
    : '<div class="stock in">Còn hàng</div>';

  // Form thêm giỏ + Mua ngay (POST /cart/add tới checkout, cùng origin qua Caddy → form-action 'self').
  // "Mua ngay" = submit kèm name=buynow → checkout redirect thẳng trang thanh toán.
  const canBuy = selected && selAvail > 0;
  const actions = !variants.length ? '' : (canBuy ? `
          <form class="pd-actions" method="POST" action="/cart/add">
            <input type="hidden" name="variant_id" value="${esc(selected.id)}">
            <input class="qty" type="number" name="qty" value="1" min="1" max="${Math.min(1000, selAvail)}" inputmode="numeric" aria-label="Số lượng">
            <button class="btn btn-alt" type="submit">${I_CART}Thêm vào giỏ</button>
            <button class="btn btn-primary" type="submit" name="buynow" value="1">Mua ngay</button>
          </form>`
    : `<div class="soldout-note">${soldOut ? 'Sản phẩm tạm hết hàng. Vui lòng quay lại sau.' : 'Phân loại đang chọn đã hết. Vui lòng chọn phân loại khác.'}</div>`);

  const skuHtml = selected?.sku ? `<div class="pd-sku">Mã: ${esc(selected.sku)}</div>` : '';
  const specs = Array.isArray(p.specs) ? p.specs : [];
  const specsHtml = specs.length ? `<section class="pd-block"><h2>Thông số</h2><table class="specs">${specs.map((s) => `<tr><th>${esc(s.name)}</th><td>${esc(s.value)}</td></tr>`).join('')}</table></section>` : '';
  const descHtml = p.description ? `<section class="pd-block"><h2>Mô tả sản phẩm</h2><div class="desc" itemprop="description">${formatDesc(p.description)}</div></section>` : '';
  const related = Array.isArray(p.related) ? p.related : [];
  const relatedHtml = related.length ? `<section class="pd-block related"><h2>Có thể bạn thích</h2><div class="grid">${productCards(related)}</div></section>` : '';

  // ── Đánh giá: sao trung bình + danh sách approved + form gửi (POST /checkout/review, PRG).
  const stats = p.reviewStats ?? { n: 0, avg: 0 };
  const stars = (r) => '★'.repeat(Math.round(Number(r))) + '☆'.repeat(5 - Math.round(Number(r)));
  const ratingSummary = Number(stats.n) > 0
    ? `<a class="pd-rating" href="#danh-gia"><span class="st">${stars(stats.avg)}</span> ${esc(String(stats.avg))} (${esc(String(stats.n))} đánh giá)</a>` : '';
  const reviewItems = (p.reviews ?? []).map((rv) => `<div class="rv">
      <div class="rv-head"><span class="st">${stars(rv.rating)}</span> <strong>${esc(rv.author_name)}</strong>${rv.verified ? ' <span class="rv-ok">✓ Đã mua hàng</span>' : ''}</div>
      <p>${esc(rv.content)}</p></div>`).join('');
  const flagMsg = p.reviewFlag === 'sent'
    ? '<div class="rv-note ok">Cảm ơn bạn! Đánh giá sẽ hiển thị sau khi cửa hàng duyệt.</div>'
    : p.reviewFlag === 'invalid' ? '<div class="rv-note err">Đánh giá chưa hợp lệ — cần chọn số sao và viết ít nhất 10 ký tự.</div>' : '';
  const reviewsHtml = `<section class="pd-block" id="danh-gia"><h2>Đánh giá${Number(stats.n) ? ` (${esc(String(stats.n))})` : ''}</h2>
      ${flagMsg}
      ${reviewItems || '<p class="muted">Chưa có đánh giá nào. Hãy là người đầu tiên!</p>'}
      <details class="rv-form"><summary>Viết đánh giá</summary>
        <form method="POST" action="/checkout/review">
          <input type="hidden" name="product_id" value="${esc(p.id)}">
          <input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
          <div class="rv-stars" role="radiogroup" aria-label="Số sao">
            ${[5, 4, 3, 2, 1].map((n) => `<input type="radio" id="rv-s${n}" name="rating" value="${n}" required><label for="rv-s${n}" title="${n} sao">★</label>`).join('')}
          </div>
          <input name="author_name" required maxlength="80" placeholder="Tên của bạn" aria-label="Tên">
          <textarea name="content" required minlength="10" maxlength="1000" rows="3" placeholder="Sản phẩm dùng thế nào? (ít nhất 10 ký tự)" aria-label="Nội dung"></textarea>
          <div class="rv-verify"><span class="muted">Đã mua hàng? Nhập để nhận dấu ✓:</span>
            <input name="order_number" inputmode="numeric" maxlength="15" placeholder="Số đơn">
            <input name="phone" inputmode="tel" maxlength="20" placeholder="SĐT đặt hàng"></div>
          <button class="btn btn-primary" type="submit">Gửi đánh giá</button>
        </form>
      </details>
    </section>`;
  const crumb = `<div class="crumb"><a href="/">Trang chủ</a>${p.category ? ` / <a href="/c/${esc(p.category.slug)}">${esc(p.category.name)}</a>` : ''} / <span>${esc(p.title)}</span></div>`;

  const availability = soldOut ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock';
  const body = `${SECTIONS.header({}, ctx)}
    <main class="wrap pd" itemscope itemtype="https://schema.org/Product">
      ${crumb}
      ${gallery.length ? `<meta itemprop="image" content="${esc(gallery[0].url)}">` : ''}
      <div class="pd-grid">
        ${galleryHtml}
        <div class="pd-info">
          <h1 itemprop="name">${esc(p.title)}</h1>
          ${ratingSummary}
          ${skuHtml}
          <div class="price" itemprop="offers" itemscope itemtype="https://schema.org/Offer">
            <span itemprop="price" content="${esc(String(Number(price)))}">${money(price)}</span>${compareHtml(price, selected?.compare_at_vnd)}
            <meta itemprop="priceCurrency" content="VND"><link itemprop="availability" href="${availability}">
          </div>
          ${stockBadge}
          ${selector}
          ${actions}
          <div class="trust"><span>${I_TRUCK}Giao hàng toàn quốc</span><span>${I_SHIELD}Thanh toán COD hoặc QR</span></div>
        </div>
      </div>
      ${descHtml}
      ${specsHtml}
      ${reviewsHtml}
      ${relatedHtml}
      ${Number(stats.n) > 0 ? `<div itemprop="aggregateRating" itemscope itemtype="https://schema.org/AggregateRating"><meta itemprop="ratingValue" content="${esc(String(stats.avg))}"><meta itemprop="reviewCount" content="${esc(String(stats.n))}"></div>` : ''}
    </main>${SECTIONS.footer({}, ctx)}`;
  const desc = p.description ? String(p.description).replace(/\s+/g, ' ').trim().slice(0, 200) : `${p.title} — ${ctx.shop.name}`;
  const absUrl = (u) => (u ? (/^https?:\/\//i.test(u) ? u : `${ctx.origin || ''}${u}`) : '');
  const ogSrc = gallery.length ? absUrl(gallery[0].url) : '';
  const ogImg = ogSrc ? `<meta property="og:image" content="${esc(ogSrc)}"><meta name="twitter:image" content="${esc(ogSrc)}">` : '';
  const head = metaHead({ description: desc, canonical, ogTitle: p.title, ogType: 'product', siteName: ctx.shop.name }) + ogImg;
  return page(`${p.title} — ${ctx.shop.name}`, ctx.theme?.tokens, body, head);
}

/** Trang kết quả tìm kiếm. Trang KQ tìm không nên index (robots noindex,follow). */
export function renderSearch(ctx, { canonical = null } = {}) {
  const q = ctx.query ?? '';
  const count = ctx.pageInfo?.total ?? ctx.products.length;
  const results = ctx.products.length
    ? `${sortBar(ctx.pageInfo)}<div class="grid">${productCards(ctx.products)}</div>${pager(ctx.pageInfo)}`
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
  const head = metaHead({ description: `Bài viết & tin tức từ ${ctx.shop.name}`, canonical, ogTitle: `Blog — ${ctx.shop.name}`, siteName: ctx.shop.name, ogImage: shopOgImage(ctx) });
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
  const head = metaHead({ description: desc, canonical, ogTitle: post.title, ogType: 'article', siteName: ctx.shop.name, ogImage: shopOgImage(ctx) });
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
function metaHead({ description, canonical, ogTitle, ogType, siteName, robots, ogImage }) {
  const t = [];
  if (robots) t.push(`<meta name="robots" content="${esc(robots)}">`);
  if (description) t.push(`<meta name="description" content="${esc(description)}">`);
  if (canonical) t.push(`<link rel="canonical" href="${esc(canonical)}">`);
  t.push(`<meta property="og:type" content="${esc(ogType || 'website')}">`);
  t.push(`<meta property="og:title" content="${esc(ogTitle ?? '')}">`);
  if (description) t.push(`<meta property="og:description" content="${esc(description)}">`);
  if (canonical) t.push(`<meta property="og:url" content="${esc(canonical)}">`);
  if (siteName) t.push(`<meta property="og:site_name" content="${esc(siteName)}">`);
  // og:image (URL TUYỆT ĐỐI — bộ quét FB/Zalo không hiểu đường dẫn tương đối): thiếu
  // → thẻ share trắng trên FB/Zalo, kênh bán chính của shop VN.
  if (ogImage) { t.push(`<meta property="og:image" content="${esc(ogImage)}">`); t.push(`<meta name="twitter:image" content="${esc(ogImage)}">`); }
  t.push(`<meta name="twitter:card" content="summary">`);
  t.push(`<meta name="twitter:title" content="${esc(ogTitle ?? '')}">`);
  if (description) t.push(`<meta name="twitter:description" content="${esc(description)}">`);
  return t.join('');
}

/** Ảnh og cho trang cấp-shop (trang chủ/blog): logo shop → ảnh SP đầu tiên → null.
 *  Trả URL TUYỆT ĐỐI theo ctx.origin (server.js luôn set cho mọi trang shop). */
function shopOgImage(ctx) {
  const abs = (u) => (u ? (/^https?:\/\//i.test(u) ? u : `${ctx.origin || ''}${u}`) : null);
  return abs(ctx.shop?.logo_url) ?? abs((Array.isArray(ctx.products) ? ctx.products : []).find((p) => p.image)?.image);
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
