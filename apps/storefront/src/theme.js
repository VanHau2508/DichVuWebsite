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

// Bảng màu MẶC ĐỊNH (phong cách "MAISON" — editorial đen-trắng, cao cấp). Mỗi shop tự
// override được các token này (sanitizeTokens chỉ nhận hex hợp lệ) → đổi màu thương hiệu.
export const DEFAULT_TOKENS = {
  'color.primary': '#141414',      // đen mực: CTA, thương hiệu, dải hero
  'color.primary-dark': '#000000', // hover nút chính + đáy gradient hero
  'color.accent': '#b06a57',       // đất nung: eyebrow, nhấn nhỏ
  'color.bg': '#ffffff',
  'color.surface': '#f5f4f1',      // trắng ngà ấm: ô ảnh trống, nền phụ
  'color.hero-bg': '#efede8',      // wash ấm nhạt: dải nhấn, tile bộ sưu tập, badge còn hàng
  'color.text': '#141414',
  'color.muted': '#6e6a63',
  'color.border': '#e8e6e1',
  'font.heading': '"Be Vietnam Pro", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  'font.body': '"Be Vietnam Pro", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  radius: '4px',
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

// Ảnh trong nội dung (block image / blog): dựng URL từ key media PUBLIC — cùng nguồn
// cấu hình với server.js (mặc định tương đối /media-public → CSP img-src 'self').
// Key phải ĐÚNG định dạng media của shop ("<uuid>/<uuid>.webp", logo có tiền tố logo-)
// — phòng thủ thêm ở tầng render (seller đã validate khi lưu): key lạ → không render.
const MEDIA_PUBLIC_BASE = process.env.MEDIA_PUBLIC_BASE ?? '/media-public';
const U36 = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MEDIA_KEY_RE = new RegExp(`^${U36}/(?:logo-)?${U36}\\.webp$`);
// Banner trang chủ (Phase 5): key riêng có tiền tố banner- (uploadBanner ở seller sinh ra).
// Phòng thủ tầng render: seller đã validate lúc lưu, đây re-check định dạng (key lạ → bỏ slide).
const BANNER_KEY_RE = new RegExp(`^${U36}/banner-${U36}\\.webp$`);
// button_link banner: chỉ nội bộ ('/...') hoặc http(s) tuyệt đối; còn lại → '#' (an toàn CSP).
const normLink = (l) => {
  const s = String(l ?? '');
  if (s.startsWith('//')) return '#';
  if (s.startsWith('/')) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return '#';
};
const mediaFigure = (key, alt, caption) => (typeof key === 'string' && MEDIA_KEY_RE.test(key)
  ? `<figure class="ct-img"><img src="${esc(`${MEDIA_PUBLIC_BASE}/${key}`)}" alt="${esc(alt ?? '')}" loading="lazy">${caption ? `<figcaption>${esc(caption)}</figcaption>` : ''}</figure>`
  : '');

// ── icon SVG nội tuyến (an toàn với CSP: là markup, không phải tài nguyên ngoài) ──
const I_CART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="20" r="1"/><circle cx="17" cy="20" r="1"/><path d="M2 3h2l2.4 12.3a1 1 0 0 0 1 .8h8.7a1 1 0 0 0 1-.8L21 7H5.6"/></svg>';
const I_IMG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 16l-5-5L5 20"/></svg>';
const I_TRUCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h11v9H3z"/><path d="M14 9h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.5"/><circle cx="17" cy="18" r="1.5"/></svg>';
const I_SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v5c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"/><path d="M9 12l2 2 4-4"/></svg>';
const I_RETURN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7v6h6"/><path d="M3.5 13a9 9 0 1 0 2.2-9.3L3 6"/></svg>';
const I_BADGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l2.4 1.8 3 .1.9 2.9 2.4 1.8-.9 2.9.9 2.9-2.4 1.8-.9 2.9-3 .1L12 22l-2.4-1.8-3-.1-.9-2.9L3.3 15.4l.9-2.9-.9-2.9 2.4-1.8.9-2.9 3-.1z"/><path d="M9 12l2 2 4-4"/></svg>';
const I_WALLET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h13v4"/><path d="M3 7v10a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-3"/><path d="M21 11v4h-4a2 2 0 0 1 0-4z"/></svg>';
const I_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';
const I_USER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6"/></svg>';
// 👁 xem-nhanh (Phase 3): con mắt — mở modal quick-view (không JS → link về trang SP).
const I_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';

// Giá GẠCH NGANG (compare-at, 0067 — CHỈ hiển thị, checkout luôn tính price_vnd):
// chỉ render khi compare > giá bán; kèm badge -N%.
const offPct = (price, cmp) => Math.round((1 - Number(price) / Number(cmp)) * 100);
const compareHtml = (price, cmp) =>
  (cmp != null && Number(cmp) > Number(price)
    ? ` <s class="cmp">${money(cmp)}</s><span class="off">-${offPct(price, cmp)}%</span>` : '');
// Flash sale (0082) ĐÈ compare_at: giá sale ĐẬM + gạch giá GỐC + badge -X% (off_pct từ
// promo_effective — đúng cho giá đang hiện). Hết promo → compare_at trở lại (0067).
// Tái dùng class .cmp/.off (theme-safe, không ép màu tuỳ biến của shop).
const salePriceHtml = (base, sale, off) =>
  `<strong>${money(sale)}</strong> <s class="cmp">${money(base)}</s><span class="off">-${esc(off)}%</span>`;
// Giá hiển thị của một mục (thẻ/related): sale nếu có, không thì giá gốc + compare_at.
const priceLine = (base, sale, off, cmp) =>
  (sale != null ? salePriceHtml(base, sale, off) : `${money(base)}${compareHtml(base, cmp)}`);

// Thẻ sản phẩm dùng chung (lưới trang chủ / danh mục / tìm kiếm). Escape mọi field người bán.
// Phase 3 — HTML HỢP LỆ (KHÔNG nhét phần tử tương tác vào trong <a>):
//   .card (div) ▸ .card-thumb ▸ [ <a.card-media> ảnh1 + ảnh2 + tag hết-hàng ] + [ .card-actions
//   (👁 quick-view + Thêm vào giỏ) — là ANH EM của <a>, không lồng ] ; .card-body ▸ tên(link)+giá.
//   No-JS: card-media/tên/👁 → /p/:slug ; thêm-giỏ SP-phẳng = <form> PRG /cart ; SP-nhiều-biến-thể
//   = <a> về /p/:slug. Có JS: 👁/thêm-nhiều-biến-thể mở quick-view; thêm SP-phẳng mở drawer.
function productCards(products) {
  return products.map((p) => {
    const out = Number(p.available) <= 0;
    const href = `/p/${esc(p.slug)}`;
    // Thêm-nhanh CHỈ khi SP phẳng (server đặt default_variant_id) và còn hàng; ngược lại → link PDP.
    const quickAdd = !p.has_options && p.default_variant_id && !out;
    const img2 = p.image2 ? `<img class="card-img2" src="${esc(p.image2)}" alt="" loading="lazy" aria-hidden="true">` : '';
    const media = `<a class="card-media" href="${href}" aria-label="${esc(p.title)}">${out ? '<span class="soldout-tag">Hết hàng</span>' : ''}${p.image ? `<img class="card-img1" src="${esc(p.image)}" alt="${esc(p.title)}" loading="lazy">` : `<span class="ph">${I_IMG}</span>`}${img2}</a>`;
    const addBtn = quickAdd
      ? `<form class="card-add-form" method="POST" action="/cart/add"><input type="hidden" name="variant_id" value="${esc(p.default_variant_id)}"><input type="hidden" name="qty" value="1"><button class="card-add" type="submit">${I_CART}<span>Thêm vào giỏ</span></button></form>`
      : `<a class="card-add" href="${href}">${I_CART}<span>Thêm vào giỏ</span></a>`;
    const actions = out ? '' : `<div class="card-actions">
            <a class="card-qv" href="${href}" aria-label="Xem nhanh ${esc(p.title)}">${I_EYE}</a>
            ${addBtn}
          </div>`;
    return `<div class="card${out ? ' is-out' : ''}">
          <div class="card-thumb">${media}${actions}</div>
          <div class="card-body"><a class="name" href="${href}">${esc(p.title)}</a><div class="price">${priceLine(p.price_vnd, p.sale_price_vnd, p.sale_off_pct, p.compare_at_vnd)}</div></div>
        </div>`;
  }).join('');
}
// Query sort đính kèm link (bỏ khi 'new' = mặc định → URL sạch).
const sortQs = (pi) => (pi?.sort && pi.sort !== 'new' ? `&sort=${pi.sort}` : '');
// Bộ lọc (#27) đính kèm link phân trang/sắp xếp — pager + sort KHÔNG được làm rơi
// lọc đang áp. Giá trị đã parse server-side (bool/int) nên an toàn để nối query.
const filterParts = (pi) => {
  const f = pi?.filters ?? {};
  const parts = [];
  if (f.instock) parts.push('instock=1');
  if (f.pmin != null) parts.push(`pmin=${f.pmin}`);
  if (f.pmax != null) parts.push(`pmax=${f.pmax}`);
  return parts;
};
const filterQs = (pi) => filterParts(pi).map((p) => `&${p}`).join('');
// Phân trang ← Trước / Sau → từ pageInfo {total, offset, pageSize, basePath, sort, filters}.
function pager(pi) {
  if (!pi || pi.total <= pi.pageSize) return '';
  const cur = Math.floor(pi.offset / pi.pageSize) + 1;
  const last = Math.max(1, Math.ceil(pi.total / pi.pageSize));
  const link = (n) => esc(`${pi.basePath}${pi.basePath.includes('?') ? '&' : '?'}page=${n}${sortQs(pi)}${filterQs(pi)}`);
  const prev = cur > 1 ? `<a class="pg-btn" href="${link(cur - 1)}">← Trước</a>` : '<span class="pg-btn off">← Trước</span>';
  const next = cur < last ? `<a class="pg-btn" href="${link(cur + 1)}">Sau →</a>` : '<span class="pg-btn off">Sau →</span>';
  return `<nav class="pager">${prev}<span class="pg-info">Trang ${cur}/${last}</span>${next}</nav>`;
}
// Thanh sắp xếp no-JS (3 link GET, CSP-sạch) — trên lưới trang chủ / danh mục / tìm kiếm.
// Đổi sort = về trang 1 (không kèm page) nhưng GIỮ bộ lọc. Đang chọn → span.
function sortBar(pi) {
  if (!pi) return '';
  const cur = pi.sort ?? 'new';
  const opts = [['new', 'Mới nhất'], ['price_asc', 'Giá tăng dần'], ['price_desc', 'Giá giảm dần']];
  const links = opts.map(([k, label]) => {
    if (k === cur) return `<span class="sort-link on" aria-current="true">${label}</span>`;
    const parts = (k === 'new' ? [] : [`sort=${k}`]).concat(filterParts(pi));
    const href = parts.length ? `${pi.basePath}${pi.basePath.includes('?') ? '&' : '?'}${parts.join('&')}` : pi.basePath;
    return `<a class="sort-link" href="${esc(href)}">${label}</a>`;
  }).join('');
  return `<nav class="sortbar" aria-label="Sắp xếp sản phẩm"><span class="sort-lbl">Sắp xếp:</span>${links}</nav>`;
}
// Form lọc no-JS (#27, GET — CSP-sạch): còn hàng + khoảng giá. Chỉ hiện ở danh mục /
// tìm kiếm (pageInfo.filterable). Giữ q/sort qua input hidden; submit = về trang 1.
function filterBar(pi, query, extraHidden = '') {
  if (!pi?.filterable) return '';
  const f = pi.filters ?? {};
  const path = pi.basePath.split('?')[0]; // /products, /c/:slug hoặc /search (q giữ bằng hidden)
  const hidden = extraHidden
    + (query ? `<input type="hidden" name="q" value="${esc(query)}">` : '')
    + (pi.sort && pi.sort !== 'new' ? `<input type="hidden" name="sort" value="${esc(pi.sort)}">` : '');
  return `<form class="filterbar" method="GET" action="${esc(path)}">${hidden}
    <label class="fb-chk"><input type="checkbox" name="instock" value="1"${f.instock ? ' checked' : ''}> Còn hàng</label>
    <input class="fb-num" name="pmin" inputmode="numeric" value="${f.pmin != null ? f.pmin : ''}" placeholder="Giá từ (đ)" aria-label="Giá từ (đồng)">
    <span class="fb-sep">–</span>
    <input class="fb-num" name="pmax" inputmode="numeric" value="${f.pmax != null ? f.pmax : ''}" placeholder="đến (đ)" aria-label="Giá đến (đồng)">
    <button class="fb-btn" type="submit">Áp dụng</button>
  </form>`;
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

// Carousel BANNER tuỳ chỉnh (Phase 5): tái dùng khung .hero/.hero-track/.hslide/.hero-dots
// + animation thuần CSS + chấm như hero tự động. Mỗi slide: ảnh phủ kín (.hbanner-img) +
// overlay tối nhẹ để chữ trắng đọc được + copy (tiêu đề/mô tả/nút). Chỉ slide ĐẦU dùng <h1>
// (SEO: 1 h1/trang), còn lại <p class="hero-h">. esc mọi field người bán; normLink lọc nút.
function heroBanner(slides) {
  const hs = slides.map((s, i) => {
    const first = i === 0;
    const src = esc(`${MEDIA_PUBLIC_BASE}/${s.image_key}`);
    const head = s.headline
      ? (first ? `<h1 class="hero-h1">${esc(s.headline)}</h1>` : `<p class="hero-h">${esc(s.headline)}</p>`)
      : '';
    const sub = s.sub ? `<p class="hero-sub">${esc(s.sub)}</p>` : '';
    const cta = (s.button_label && s.button_link)
      ? `<div class="hero-cta"><a class="btn btn-hero" href="${esc(normLink(s.button_link))}">${esc(s.button_label)}</a></div>` : '';
    return `<div class="hslide hbanner">
      <img class="hbanner-img" src="${src}" alt="${esc(s.headline || '')}"${first ? '' : ' loading="lazy"'}>
      <div class="hbanner-overlay"><div class="hbanner-copy">${head}${sub}${cta}</div></div>
    </div>`;
  });
  const n = hs.length;
  const dots = n > 1 ? `<div class="hero-dots" aria-hidden="true">${'<span class="dot"></span>'.repeat(n)}</div>` : '';
  return `<section class="hero hero-banner hero-n${n}"><div class="hero-track">${hs.join('')}</div>${dots}</section>`;
}

// ── section renderers (nhận dữ liệu ĐÃ đọc, escape khi render) ────────────────
const SECTIONS = {
  // Thanh thông báo (props.topbar_text, sửa ở trang Giao diện; trống → câu mặc định an toàn
  // cho mọi shop) + header dính. Trang con (SP/blog/CMS) gọi header với props RỖNG →
  // tự tra props đã lưu trong ctx.theme.layout để topbar hiện NHẤT QUÁN trên mọi trang.
  header: (props, ctx) => {
    const saved = (Array.isArray(ctx.theme?.layout)
      ? ctx.theme.layout.find((s) => s && s.section === 'header')?.props : null) ?? {};
    const topbarText = (typeof props.topbar_text === 'string' && props.topbar_text)
      ? props.topbar_text
      : (typeof saved.topbar_text === 'string' && saved.topbar_text)
        ? saved.topbar_text
        : 'Giao hàng toàn quốc · Thanh toán COD hoặc chuyển khoản QR';
    // Dropdown "Sản phẩm" (thuần CSS, :hover + :focus-within): shortcut cố định + danh mục THẬT.
    // Shortcut trỏ về lưới trang chủ theo sort có sẵn (GRID_SORTS) — KHÔNG route mới, không 404.
    // (Khuyến mãi = giá tăng dần tạm thời — Phase 2 có thể thêm trang /sale riêng.)
    const catLinks = (Array.isArray(ctx.categories) ? ctx.categories : [])
      .map((c) => `<a href="/c/${esc(c.slug)}">${esc(c.name)}</a>`).join('');
    // Menu "Sản phẩm" tuỳ chỉnh (Phase 5b): shop bật/tắt 3 shortcut cố định + thêm liên kết
    // riêng. Đọc từ header props (nơi topbar_text được lưu) — merge saved+props để trang con
    // (props rỗng) vẫn NHẤT QUÁN. KHÔNG cấu hình / field thiếu = coi như TRUE → giữ hành vi cũ.
    const hp = { ...saved, ...(props && typeof props === 'object' ? props : {}) };
    const shortcuts = [
      hp.menu_show_featured !== false ? '<a href="/">Nổi bật</a>' : '',
      hp.menu_show_new !== false ? '<a href="/products?sort=new">Hàng mới</a>' : '',
      hp.menu_show_sale !== false ? '<a href="/products?sort=price_asc">Khuyến mãi</a>' : '',
    ].join('');
    // Liên kết tuỳ chỉnh: seller đã sanitize (kẹp nhãn, safeLink url, ≤6) — đây re-lọc khi render
    // (esc nhãn + normLink url) chống XSS/CSP nếu dữ liệu cũ lọt.
    const navLinksHtml = (Array.isArray(hp.nav_links) ? hp.nav_links : [])
      .filter((l) => l && typeof l === 'object' && l.label && l.url)
      .map((l) => `<a href="${esc(normLink(l.url))}">${esc(l.label)}</a>`).join('');
    // Ghép các nhóm (shortcut / danh mục / liên kết tuỳ chỉnh) — gạch ngăn giữa nhóm KHÔNG rỗng.
    const menuInner = [shortcuts, catLinks, navLinksHtml].filter(Boolean)
      .join('<span class="hnav-sep" aria-hidden="true"></span>');
    const productMenu = `<div class="hnav-drop">
        <a class="hnav-trig" href="/#san-pham" aria-haspopup="true">Sản phẩm<span class="caret" aria-hidden="true">▾</span></a>
        <div class="hnav-menu" role="menu">
          ${menuInner}
        </div>
      </div>`;
    // "Giới thiệu": trỏ trang CMS giới thiệu nếu shop có (khớp slug about-like → trang menu đầu);
    // không có trang nào → ẩn mục (tránh liên kết chết). Footer vẫn liệt kê đủ trang CMS.
    const aboutPage = (ctx.menu ?? []).find((p) => /gioi-?thieu|about|ve-chung-toi/i.test(p.slug)) ?? (ctx.menu ?? [])[0] ?? null;
    const aboutLink = aboutPage ? `<a href="/pages/${esc(aboutPage.slug)}">Giới thiệu</a>` : '';
    return `<div class="topbar">${esc(topbarText)}</div><header class="hdr"><div class="wrap">
    <input type="checkbox" id="navtoggle" class="navtoggle vh" aria-label="Mở/đóng menu">
    <label for="navtoggle" class="navburger" aria-hidden="true">☰</label>
    <a href="/" class="brand">${ctx.shop.logo_url ? `<img src="${esc(ctx.shop.logo_url)}" alt="${esc(ctx.shop.name)}" class="brand-logo">` : esc(ctx.shop.name)}</a>
    <nav class="hnav">
      <a href="/">Trang chủ</a>
      ${productMenu}
      ${aboutLink}
      ${ctx.hasBlog ? '<a href="/blog">Tin tức</a>' : ''}
      <a href="/checkout/lookup">Tra cứu đơn</a>
    </nav>
    <div class="hicons">
      <div class="hsearch-wrap">
        <input type="checkbox" id="searchtoggle" class="searchtoggle vh" aria-label="Mở/đóng tìm kiếm">
        <label for="searchtoggle" class="hicon" title="Tìm kiếm"><span class="i">${I_SEARCH}</span><span class="vh">Tìm kiếm</span></label>
        <form class="hsearch" method="GET" action="/search" role="search">
          <input name="q" value="${esc(ctx.query ?? '')}" placeholder="Tìm sản phẩm…" aria-label="Tìm sản phẩm">
          <button class="hsearch-go" type="submit" aria-label="Tìm">${I_SEARCH}</button>
        </form>
      </div>
      <a href="/account" class="hicon" title="Tài khoản"><span class="i">${I_USER}</span><span class="vh">Tài khoản</span></a>
      <a href="/cart" class="hicon cart" title="Giỏ hàng"><span class="i">${I_CART}</span><span class="vh">Giỏ hàng</span><span class="cart-badge" id="cart-badge" aria-live="polite" hidden></span></a>
    </div>
  </div></header>`;
  },

  // HERO CAROUSEL thuần CSS (không JS — CSP default-src 'none' giữ nguyên):
  //   Cảnh 1: thông điệp shop (props eyebrow/title/subtitle) + SP có ảnh đầu tiên làm visual.
  //   Cảnh 2-3: hai SP có ảnh kế tiếp (tiêu đề + giá + CTA vào trang SP) — banner "sống"
  //   từ chính dữ liệu shop, không cần shop tải banner riêng. 1 cảnh → tĩnh, không chấm.
  //   Cảnh 2-3 dùng <p class="hero-h"> (không thêm h1 — mỗi trang chỉ 1 h1 cho SEO).
  hero: (props, ctx) => {
    // Phase 5 — BANNER TUỲ CHỈNH: shop cấu hình slides (ảnh tự tải) → dùng làm carousel.
    // Mỗi slide = ảnh phủ kín + overlay (headline/sub/nút). Không cấu hình / key sai hết →
    // rơi về hero TỰ ĐỘNG (cảnh chữ + ảnh sản phẩm) bên dưới, KHÔNG đổi.
    const banner = (Array.isArray(props.slides) ? props.slides : [])
      .filter((s) => s && typeof s.image_key === 'string' && BANNER_KEY_RE.test(s.image_key))
      .slice(0, 5);
    if (banner.length) return heroBanner(banner);
    const withImg = (Array.isArray(ctx.products) ? ctx.products : []).filter((p) => p.image).slice(0, 3);
    const visual = (p) => (p
      ? `<a class="hero-media" href="/p/${esc(p.slug)}">
          <img src="${esc(p.image)}" alt="${esc(p.title)}"${p === withImg[0] ? '' : ' loading="lazy"'}>
          <span class="hero-card"><span class="hc-name">${esc(p.title)}</span><span class="hc-price">${p.sale_price_vnd != null ? `${money(p.sale_price_vnd)} <span class="off">-${esc(p.sale_off_pct)}%</span>` : money(p.price_vnd)}</span></span>
        </a>`
      : `<div class="hero-media deco" aria-hidden="true">${I_SHIELD}</div>`);
    const ghost = (Array.isArray(ctx.categories) && ctx.categories.length)
      ? '<a class="btn btn-hero-ghost" href="#bo-suu-tap">Bộ sưu tập</a>' : '';
    const slides = [`<div class="hslide"><div class="hero-grid">
      <div class="hero-copy">
        <p class="eyebrow">${esc(props.eyebrow || 'Cửa hàng chính thức')}</p>
        <h1>${esc(props.title || ctx.shop.name)}</h1>
        <p class="hero-sub">${esc(props.subtitle || 'Mua sắm dễ dàng — giao hàng toàn quốc, thanh toán COD hoặc chuyển khoản QR.')}</p>
        <div class="hero-cta"><a class="btn btn-hero" href="#san-pham">Xem sản phẩm</a>${ghost}</div>
      </div>
      ${visual(withImg[0])}
    </div></div>`];
    const SLIDE_LABEL = [['Nổi bật', 'Xem ngay'], ['Hàng mới', 'Khám phá']];
    withImg.slice(1).forEach((p, i) => {
      const [eb, cta] = SLIDE_LABEL[i];
      const priceHtml = p.sale_price_vnd != null
        ? `${money(p.sale_price_vnd)} <s class="cmp">${money(p.price_vnd)}</s> <span class="off">-${esc(p.sale_off_pct)}%</span>`
        : money(p.price_vnd);
      slides.push(`<div class="hslide"><div class="hero-grid">
      <div class="hero-copy">
        <p class="eyebrow">${eb}</p>
        <p class="hero-h">${esc(p.title)}</p>
        <p class="hero-sub">${priceHtml}</p>
        <div class="hero-cta"><a class="btn btn-hero" href="/p/${esc(p.slug)}">${cta}</a></div>
      </div>
      ${visual(p)}
    </div></div>`);
    });
    const n = slides.length;
    const dots = n > 1 ? `<div class="hero-dots" aria-hidden="true">${'<span class="dot"></span>'.repeat(n)}</div>` : '';
    return `<section class="hero hero-n${n}"><div class="hero-track">${slides.join('')}</div>${dots}</section>`;
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

  // Bộ sưu tập (Phase 3 — bố cục lại + đầu-mục có eyebrow/subtitle + link "Xem tất cả" cho đỡ
  // "trơ trọi"): tái dùng danh mục của shop → tile lớn dẫn tới /c/:slug. Rỗng nếu chưa có danh mục.
  collections: (props, ctx) => {
    const cats = Array.isArray(ctx.categories) ? ctx.categories.slice(0, 6) : [];
    if (!cats.length) return '';
    return `<section class="section collections" id="bo-suu-tap"><div class="wrap">
      <div class="section-h">
        <div class="section-h-l"><p class="section-eyebrow">${esc(props.eyebrow || 'Danh mục nổi bật')}</p><h2>${esc(props.title || 'Mua theo bộ sưu tập')}</h2></div>
      </div>
      <div class="coll-grid">${cats.map((c) => `<a class="coll-tile" href="/c/${esc(c.slug)}"><span class="coll-name">${esc(c.name)}</span><span class="coll-go">Xem ngay →</span></a>`).join('')}</div>
    </div></section>`;
  },

  product_grid: (props, ctx) => {
    const cards = ctx.products.length ? productCards(ctx.products) : '<p class="empty">Cửa hàng chưa có sản phẩm nào.</p>';
    // TRANG CHỦ (không pageInfo): chế độ "NỔI BẬT" — server chỉ đưa 8 SP, KHÔNG chips/sort/
    // lọc/pager; nút "Xem thêm" to, căn giữa → /products (lưới đầy đủ). Chủ shop: khu nổi
    // bật không được ôm cả 100 SP.
    if (!ctx.pageInfo) {
      return `<section class="section" id="san-pham"><div class="wrap">
      <div class="section-h">
        <div class="section-h-l"><h2>${esc(props.title || 'Sản phẩm nổi bật')}</h2></div>
        <a class="section-all" href="/products">Xem tất cả →</a>
      </div>
      <div class="grid">${cards}</div>
      ${ctx.products.length ? `<div class="grid-more"><a class="btn btn-primary btn-more" href="/products">Xem thêm<span class="btn-more-arrow" aria-hidden="true">→</span></a></div>` : ''}
    </div></section>`;
    }
    // TRANG DANH SÁCH (có pageInfo — /c/:slug qua renderHome): giữ nguyên lưới đầy đủ như cũ.
    const chips = ctx.categories.length
      ? `<div class="chips"><a class="chip" href="/products">Tất cả</a>${ctx.categories.map((c) => `<a class="chip" href="/c/${esc(c.slug)}">${esc(c.name)}</a>`).join('')}</div>`
      : '';
    return `<section class="section" id="san-pham"><div class="wrap">
      <div class="section-h">
        <div class="section-h-l"><h2>${esc(props.title || 'Sản phẩm')}</h2></div>
        <a class="section-all" href="/products">Xem tất cả →</a>
      </div>
      ${chips}
      ${filterBar(ctx.pageInfo, ctx.query)}
      ${ctx.products.length ? sortBar(ctx.pageInfo) : ''}
      <div class="grid">${cards}</div>
      ${pager(ctx.pageInfo)}
    </div></section>`;
  },

  // "Bài viết mới nhất" (trang chủ, kiểu Haravan): 3 bài published gần nhất, thẻ ngang có
  // ảnh bìa (placeholder khi thiếu) + trích đoạn (~120 ký tự, server cắt) + ngày + Xem thêm.
  // KHÔNG có bài → section tự ẩn (không khung rỗng). SSR thuần, esc mọi field người bán.
  blog: (props, ctx) => {
    const posts = Array.isArray(ctx.blogPosts) ? ctx.blogPosts : [];
    if (!posts.length) return '';
    const fmtVN = (d) => {
      try { const dt = new Date(d); const p2 = (n) => String(n).padStart(2, '0'); return `${p2(dt.getDate())} Tháng ${p2(dt.getMonth() + 1)}, ${dt.getFullYear()}`; } catch { return ''; }
    };
    const cards = posts.map((p) => `<article class="hblog-card">
        <a class="hblog-thumb" href="/blog/${esc(p.slug)}" aria-label="${esc(p.title)}">${p.cover ? `<img src="${esc(p.cover)}" alt="${esc(p.title)}" loading="lazy">` : `<span class="ph">${I_IMG}</span>`}</a>
        <div class="hblog-body">
          <h3><a href="/blog/${esc(p.slug)}">${esc(p.title)}</a></h3>
          <div class="hblog-date">${esc(fmtVN(p.published_at))}</div>
          ${p.excerpt ? `<p>${esc(p.excerpt)}…</p>` : ''}
          <a class="hblog-more" href="/blog/${esc(p.slug)}">Xem thêm →</a>
        </div>
      </article>`).join('');
    return `<section class="section hblog" id="bai-viet"><div class="wrap">
      <div class="section-h">
        <div class="section-h-l"><h2>${esc(props.title || 'Bài viết mới nhất')}</h2></div>
        <a class="section-all" href="/blog">Xem tất cả →</a>
      </div>
      <div class="hblog-grid">${cards}</div>
    </div></section>`;
  },

  // Băng câu chuyện thương hiệu — CHỈ hiện khi shop điền (trang Giao diện). Không nhét
  // chữ mẫu vào shop người ta: title/body trống → section rỗng, layout không đổi.
  story: (props, ctx) => {
    const title = typeof props.title === 'string' ? props.title.trim() : '';
    const body = typeof props.body === 'string' ? props.body.trim() : '';
    if (!title && !body) return '';
    const cta = (typeof props.cta_text === 'string' && props.cta_text.trim())
      ? `<a class="btn btn-solid" href="#san-pham">${esc(props.cta_text.trim())}</a>` : '';
    return `<section class="story"><div class="wrap">
      <div><p class="eyebrow">${esc(props.eyebrow || 'Câu chuyện của chúng tôi')}</p>
        <h2>${esc(title || ctx.shop.name)}</h2></div>
      <div>${body ? `<p>${esc(body)}</p>` : ''}${cta}</div>
    </div></section>`;
  },

  // Footer 4 cột: thương hiệu+liên hệ / Cửa hàng (danh mục+blog) / Hỗ trợ / Chính sách
  // (trang CMS trong menu — giữ nguyên đường /pages/:slug cho test + SEO).
  footer: (props, ctx) => {
    const s = ctx.shop;
    const cats = (Array.isArray(ctx.categories) ? ctx.categories : []).slice(0, 4)
      .map((c) => `<a href="/c/${esc(c.slug)}">${esc(c.name)}</a>`).join('');
    const shopCol = (cats || ctx.hasBlog)
      ? `<div class="ftr-col"><h4>Cửa hàng</h4><a href="/">Trang chủ</a>${cats}${ctx.hasBlog ? '<a href="/blog">Blog</a>' : ''}</div>` : '';
    const helpCol = `<div class="ftr-col"><h4>Hỗ trợ</h4><a href="/checkout/lookup">Tra cứu đơn</a><a href="/account">Tài khoản</a><a href="/cart">Giỏ hàng</a></div>`;
    const menu = (ctx.menu ?? []).map((pg) => `<a href="/pages/${esc(pg.slug)}">${esc(pg.title)}</a>`).join('');
    const menuCol = menu ? `<div class="ftr-col"><h4>Chính sách</h4>${menu}</div>` : '';
    const bits = [
      s.business_address ? esc(s.business_address) : '',
      s.contact_phone ? `ĐT: ${esc(s.contact_phone)}` : '',
      s.contact_email ? `Email: ${esc(s.contact_email)}` : '',
    ].filter(Boolean);
    return `<footer class="ftr"><div class="wrap">
      <div class="ftr-grid">
        <div class="ftr-about">
          <div class="ftr-brand">${esc(ctx.shop.name)}</div>
          ${bits.length ? `<div class="ftr-contact">${bits.join('<br>')}</div>` : ''}
          <div class="badges"><span>${I_TRUCK}Giao toàn quốc</span><span>${I_SHIELD}COD · QR</span></div>
        </div>
        ${shopCol}${helpCol}${menuCol}
      </div>
      <div class="copy">© ${esc(ctx.shop.name)}</div>
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
  // Ảnh (#24): key media của shop (seller đã validate; mediaFigure re-check định dạng
  // + esc mọi thứ). alt/caption là text người bán nhập → escape như mọi block khác.
  image: (b) => mediaFigure(b.key, b.alt, b.caption),
};

const DEFAULT_LAYOUT = [
  { section: 'header', props: {} },
  { section: 'hero', props: { title: '', subtitle: '' } },
  { section: 'product_grid', props: { title: 'Sản phẩm nổi bật' } },
  { section: 'blog', props: {} },
  { section: 'footer', props: {} },
];

const STYLE = `${FONTFACE}
/* Bo góc dẫn xuất từ token --radius nhưng KẸP TRẦN px (min): token có thể là %, rem hay
   px lớn (SIZE_RE cho tới 9999px / 100%) — không kẹp thì thẻ/ảnh phình thành blob. */
:root{--r-sm:clamp(2px,calc(var(--radius)*.75),12px);--r:min(var(--radius),20px);--r-lg:clamp(var(--radius),calc(var(--radius)*1.8),26px);--r-xl:clamp(var(--radius),calc(var(--radius)*2.6),34px);--pill:999px;--sh-sm:0 1px 2px rgba(18,16,12,.05),0 2px 6px -2px rgba(18,16,12,.08);--sh:0 10px 26px -14px rgba(18,16,12,.20),0 2px 6px -3px rgba(18,16,12,.08);--sh-lg:0 30px 60px -28px rgba(18,16,12,.34)}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;font-family:var(--font-body);color:var(--color-text);background:var(--color-bg);line-height:1.6;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:inherit;text-decoration:none}img{max-width:100%;display:block}
h1,h2,h3{font-family:var(--font-heading);font-weight:800;letter-spacing:-.02em;line-height:1.18;color:var(--color-text);text-wrap:balance}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px}
.i{display:inline-flex}.i svg,.cart svg{width:18px;height:18px}
.muted{color:var(--color-muted)}
a:focus-visible,.btn:focus-visible,summary:focus-visible,button:focus-visible,.th:focus-visible,.chip:focus-visible{outline:2.5px solid var(--color-primary);outline-offset:2px;border-radius:10px}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}html{scroll-behavior:auto}
  /* Carousel hero đứng yên ở cảnh 1 (slide gốc opacity:0 chờ animation — phải bật lại thủ công). */
  .hero .hslide{opacity:0;visibility:hidden}
  .hero .hslide:first-child{opacity:1;visibility:visible}
  .hero-dots{display:none}}
/* Thanh thông báo (không sticky — cuộn qua là ẩn, nhường chỗ header).
   Nền NEO TỐI 14% để chữ trắng vẫn đọc được kể cả khi shop chọn màu chủ đạo hơi sáng
   (mặc định #141414 gần như không đổi). Cùng lý do áp cho gradient hero bên dưới. */
.topbar{background:color-mix(in srgb,var(--color-primary) 86%,#0a0a0a);color:#fff;text-align:center;font-size:.8rem;font-weight:500;letter-spacing:.02em;padding:8px 16px}
.hdr{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--color-bg) 86%,transparent);backdrop-filter:saturate(1.5) blur(12px);-webkit-backdrop-filter:saturate(1.5) blur(12px);border-bottom:1px solid color-mix(in srgb,var(--color-border) 70%,transparent)}
.hdr .wrap{display:flex;align-items:center;min-height:68px;gap:18px}
/* Brand editorial: chữ HOA giãn cách (khí chất MAISON); logo ảnh giữ nguyên kích thước. */
.brand{font-family:var(--font-heading);font-weight:800;font-size:1.06rem;letter-spacing:.16em;text-transform:uppercase;color:var(--color-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:min(52vw,320px);display:inline-flex;align-items:center}
.brand-logo{max-width:min(52vw,180px)}
.brand-logo{max-height:40px;max-width:180px;width:auto;display:block}
.hnav{display:flex;align-items:center;gap:22px;font-size:.86rem;flex-wrap:wrap;margin-right:auto}
.hnav>a,.hnav-trig{color:var(--color-muted);font-weight:600;letter-spacing:.02em;transition:color .15s}
.hnav>a:hover,.hnav-trig:hover{color:var(--color-primary)}
/* Dropdown "Sản phẩm" thuần CSS (:hover + :focus-within — không JS, hợp CSP). */
.hnav-drop{position:relative}
.hnav-trig{display:inline-flex;align-items:center;gap:4px;cursor:pointer;padding:6px 0}
.caret{font-size:.66em;transition:transform .18s}
.hnav-drop:hover .caret,.hnav-drop:focus-within .caret{transform:rotate(180deg)}
.hnav-menu{position:absolute;top:100%;left:0;min-width:210px;display:none;flex-direction:column;background:var(--color-bg);border:1px solid var(--color-border);border-radius:var(--r-lg);box-shadow:var(--sh-lg);padding:8px;z-index:30}
.hnav-drop:hover .hnav-menu,.hnav-drop:focus-within .hnav-menu{display:flex}
.hnav-menu a{padding:9px 12px;border-radius:var(--r-sm);color:var(--color-text);font-weight:500;white-space:nowrap;transition:background .15s,color .15s}
.hnav-menu a:hover{background:var(--color-hero-bg);color:var(--color-primary)}
.hnav-sep{height:1px;background:var(--color-border);margin:6px 6px}
/* Nhóm icon phải: tìm kiếm (reveal form) · tài khoản · giỏ (kèm badge). */
.hicons{display:flex;align-items:center;gap:4px}
.hicon{position:relative;display:inline-flex;align-items:center;justify-content:center;width:42px;height:42px;border-radius:var(--pill);color:var(--color-text);cursor:pointer;transition:background .15s,color .15s}
.hicon:hover{background:var(--color-hero-bg);color:var(--color-primary)}
.hicon .i svg{width:21px;height:21px}
.cart-badge{position:absolute;top:3px;right:3px;min-width:18px;height:18px;padding:0 5px;border-radius:var(--pill);background:var(--color-primary);color:#fff;font-size:.66rem;font-weight:800;line-height:18px;text-align:center;font-variant-numeric:tabular-nums;box-shadow:0 0 0 2px var(--color-bg)}
.cart-badge[hidden]{display:none}
/* Tìm kiếm reveal (checkbox + :checked ~ .hsearch — no-JS, như hamburger). */
.hsearch-wrap{position:relative}
.hsearch{position:absolute;top:calc(100% + 10px);right:0;display:none;align-items:center;gap:4px;background:var(--color-bg);border:1px solid var(--color-border);border-radius:var(--pill);padding:4px 4px 4px 8px;box-shadow:var(--sh-lg);z-index:30}
.searchtoggle:checked~.hsearch{display:flex}
.searchtoggle:focus-visible+.hicon{outline:2.5px solid var(--color-primary);outline-offset:2px}
.hsearch input{border:0;background:transparent;padding:9px 6px;font-size:.9rem;font-family:inherit;color:var(--color-text);width:210px;outline:none}
.hsearch-go{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;flex:0 0 auto;border:0;border-radius:var(--pill);background:var(--color-primary);color:#fff;cursor:pointer}
.hsearch-go svg{width:18px;height:18px}
/* Hamburger no-JS (checkbox + :checked ~ .hnav) — mobile gom menu vào nút ☰; desktop ẩn nút, nav luôn hiện. */
.navburger{display:none;cursor:pointer;font-size:1.7rem;line-height:1;color:var(--color-text);padding:2px 8px;user-select:none}
.navtoggle:focus-visible+.navburger{outline:2.5px solid var(--color-primary);outline-offset:2px;border-radius:8px}
/* Ngưỡng hamburger = 860px (khớp hero 1 cột ở 820px + tránh dồn nav ở iPad dọc 768px).
   Menu mở: nền ĐẶC (không dựa nền blur của header) để chữ luôn đọc được; mỗi mục cao ≥44px.
   Icon giỏ/tài khoản/tìm kiếm LUÔN hiện (ngoài burger); dropdown "Sản phẩm" bung tĩnh (touch không hover). */
@media(max-width:860px){
  .hdr .wrap{flex-wrap:wrap;row-gap:10px;gap:10px}
  .navburger{display:inline-flex;order:0}
  .brand{order:1;margin-right:auto}
  .hicons{order:2}
  .hnav{order:3;display:none;flex-basis:100%;flex-direction:column;align-items:stretch;gap:0;padding:4px 0 8px;margin:0;background:var(--color-bg);border-top:1px solid var(--color-border)}
  .hnav>a,.hnav-trig{padding:12px 2px;border-bottom:1px solid color-mix(in srgb,var(--color-border) 60%,transparent)}
  .navtoggle:checked~.hnav{display:flex}
  .hnav-drop{position:static}
  .caret{display:none}
  .hnav-menu{position:static;display:flex;box-shadow:none;border:0;border-radius:0;padding:2px 0 8px 14px;min-width:0;background:transparent}
  .hnav-menu a{padding:9px 2px}
  .hnav-sep{display:none}
  .hsearch{right:auto;left:0}
}
/* ── HERO CAROUSEL (thuần CSS, không JS — hợp CSP default-src 'none') ─────────────
   Dải tối editorial trên nền gradient màu thương hiệu, chữ TRẮNG cố định.
   Cơ chế: các .hslide xếp chồng (grid-area 1/1), mỗi slide chạy cùng @keyframes fade
   với animation-delay lệch nhau 6s → đúng 1 slide hiện tại mỗi thời điểm.
   Số cảnh quyết định lớp .hero-n1/-n2/-n3 (chu kỳ 12s/18s); 1 cảnh = tĩnh, không chấm. */
.hero{position:relative;overflow:hidden;background:linear-gradient(165deg,color-mix(in srgb,var(--color-primary) 88%,#0a0a0a),color-mix(in srgb,var(--color-primary-dark) 70%,#000));color:#fff}
.hero .hero-copy{text-shadow:0 1px 12px rgba(0,0,0,.28)}
.hero::after{content:"";position:absolute;top:-32%;right:-14%;width:58%;aspect-ratio:1;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.10),transparent 64%);pointer-events:none}
.hero-track{position:relative;z-index:1;display:grid}
/* WCAG 2.2.2: cho người dùng cách DỪNG banner tự chạy — trỏ chuột / focus bàn phím vào
   dải hero là tạm dừng mọi cảnh + chấm (đọc kỹ nội dung, bấm CTA không bị "trôi"). */
.hero:hover .hslide,.hero:focus-within .hslide,.hero:hover .dot,.hero:focus-within .dot{animation-play-state:paused}
.hslide{grid-area:1/1;opacity:0;visibility:hidden}
.hero-n1 .hslide{opacity:1;visibility:visible}
.hero-n2 .hslide{animation:hcycle2 10s infinite}
.hero-n3 .hslide{animation:hcycle3 15s infinite}
.hero-n2 .hslide:nth-child(2),.hero-n3 .hslide:nth-child(2){animation-delay:5s}
.hero-n3 .hslide:nth-child(3){animation-delay:10s}
/* Có JS (.js-run — script nonce gắn khi >1 cảnh): TẮT keyframes CSS, lớp .on điều khiển
   cảnh hiện tại (mũi tên/chấm bấm + tự chạy 5s + dừng khi rê/focus). Specificity
   .hero.js-run thắng .hero-nN. Không JS → keyframes fallback ở trên vẫn tự chạy. */
.hero.js-run .hslide{animation:none;opacity:0;visibility:hidden;transition:opacity .5s ease}
.hero.js-run .hslide.on{opacity:1;visibility:visible}
.hero.js-run .hero-dots .dot{animation:none;cursor:pointer;border:0;padding:0;transition:background .2s,width .2s}
.hero.js-run .hero-dots .dot.on{background:#fff;width:22px}
/* Mũi tên ‹ › do JS dựng (createElement) — vòng tròn MAISON, chỉ hiện khi .js-run. */
.hero-arrow{position:absolute;top:50%;transform:translateY(-50%);z-index:3;width:44px;height:44px;display:none;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.42);border-radius:var(--pill);background:rgba(10,8,6,.32);color:#fff;font-size:1.6rem;line-height:1;cursor:pointer;backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);transition:background .15s,border-color .15s}
.hero-arrow:hover{background:rgba(10,8,6,.55);border-color:#fff}
.hero.js-run .hero-arrow{display:inline-flex}
.hero-arrow.prev{left:14px}.hero-arrow.next{right:14px}
@media(max-width:720px){.hero-arrow{width:36px;height:36px;font-size:1.3rem}.hero-arrow.prev{left:8px}.hero-arrow.next{right:8px}}
@keyframes hcycle2{0%{opacity:0;visibility:hidden;transform:translateY(10px)}3%{opacity:1;visibility:visible;transform:none}47%{opacity:1;visibility:visible;transform:none}50%,100%{opacity:0;visibility:hidden}}
@keyframes hcycle3{0%{opacity:0;visibility:hidden;transform:translateY(10px)}2.5%{opacity:1;visibility:visible;transform:none}30.8%{opacity:1;visibility:visible;transform:none}33.4%,100%{opacity:0;visibility:hidden}}
.hero-grid{max-width:1120px;margin:0 auto;padding:56px 20px 60px;display:grid;grid-template-columns:1.05fr .95fr;gap:48px;align-items:center}
.hero .eyebrow{display:inline-flex;align-items:center;gap:7px;color:#fff;font-weight:700;font-size:.74rem;letter-spacing:.14em;text-transform:uppercase;margin:0 0 16px;padding:6px 14px;border-radius:var(--pill);background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2)}
.hero h1,.hero .hero-h{margin:0 0 16px;font-size:clamp(2rem,3.8vw,3.1rem);font-weight:800;letter-spacing:-.025em;line-height:1.08;color:#fff;text-wrap:balance;overflow-wrap:anywhere}
/* Tên SP ở cảnh 2-3 (người bán nhập, dài tới 200 ký tự) — kẹp 2 dòng để carousel không
   phình cao (các cảnh chồng grid, cảnh cao nhất quyết định chiều cao chung). */
.hero .hero-h{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.hero-sub{margin:0;color:rgba(255,255,255,.78);font-size:1.08rem;line-height:1.65;max-width:46ch}
.hero-sub .cmp{color:rgba(255,255,255,.55)}
.hero-cta{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}
/* Nút TRONG hero (nền tối): đặc trắng + viền kính — tách khỏi .btn-primary của trang sáng. */
.btn-hero{background:#fff;color:var(--color-primary);box-shadow:0 14px 30px -14px rgba(0,0,0,.55)}
.btn-hero:hover{transform:translateY(-2px);box-shadow:0 20px 38px -16px rgba(0,0,0,.6)}
.btn-hero-ghost{background:transparent;color:#fff;border-color:rgba(255,255,255,.38)}
.btn-hero-ghost:hover{border-color:#fff;background:rgba(255,255,255,.1)}
.hero-media{position:relative;display:block;border-radius:var(--r-xl);overflow:hidden;aspect-ratio:4/3;border:1px solid rgba(255,255,255,.14);box-shadow:var(--sh-lg);transition:transform .35s cubic-bezier(.2,.7,.2,1),box-shadow .35s}
.hero-media:hover{transform:translateY(-3px)}
.hero-media img{width:100%;height:100%;object-fit:cover;transition:transform .5s cubic-bezier(.2,.7,.2,1)}
.hero-media:hover img{transform:scale(1.05)}
.hero-card{position:absolute;left:14px;right:14px;bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:10px;background:rgba(255,255,255,.95);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);border-radius:var(--r);padding:12px 16px;box-shadow:0 14px 30px -16px rgba(0,0,0,.5)}
.hc-name{font-weight:600;font-size:.92rem;color:#141414;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.hc-price{font-weight:800;color:#141414;white-space:nowrap;font-variant-numeric:tabular-nums}
.hero-media.deco{display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.07);color:rgba(255,255,255,.85);box-shadow:none}
.hero-media.deco svg{width:88px;height:88px;opacity:.9}
/* ── BANNER TUỲ CHỈNH (Phase 5) — ảnh phủ kín + overlay chữ, tái dùng carousel trên ──
   Ảnh nền absolute phủ .hslide; overlay gradient tối để chữ trắng đọc rõ trên mọi ảnh.
   Chiều cao do .hbanner-overlay quyết định (các slide chồng grid → cao nhất chi phối). */
.hero-banner::after{display:none}
.hero-banner .hero-track{display:grid}
/* Khung banner TỶ LỆ CỐ ĐỊNH (chủ shop: "chỉ cần upload là khớp"): desktop 21/8 (to hơn
   trước, kẹp 400–560px), mobile 4/3; ảnh object-fit cover tự phủ kín mọi kích thước gốc. */
.hbanner{position:relative;overflow:hidden;width:100%;aspect-ratio:21/8;min-height:400px;max-height:560px}
.hbanner-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center;z-index:0}
.hbanner-overlay{position:relative;z-index:1;height:100%;display:flex;align-items:center;background:linear-gradient(90deg,rgba(10,8,6,.62),rgba(10,8,6,.28) 55%,rgba(10,8,6,.08))}
@media(max-width:720px){.hbanner{aspect-ratio:4/3;min-height:0;max-height:none}}
.hbanner-copy{max-width:1120px;width:100%;margin:0 auto;padding:48px 20px}
.hero .hero-h1{margin:0 0 16px;font-size:clamp(2rem,3.8vw,3.1rem);font-weight:800;letter-spacing:-.025em;line-height:1.08;color:#fff;text-wrap:balance;overflow-wrap:anywhere;max-width:18ch}
@media(max-width:820px){.hbanner-overlay{background:linear-gradient(0deg,rgba(10,8,6,.66),rgba(10,8,6,.3));text-align:center}.hbanner-copy{padding:40px 20px}.hbanner-copy .hero-sub{max-width:none;margin-inline:auto}.hbanner-copy .hero-cta{justify-content:center}}
/* Chấm chỉ báo: cùng chu kỳ + delay với slide → chấm "đang chiếu" giãn thành vạch trắng. */
.hero-dots{position:relative;z-index:1;display:flex;justify-content:center;gap:8px;padding:0 0 20px}
.hero-dots .dot{width:8px;height:8px;border-radius:var(--pill);background:rgba(255,255,255,.35)}
.hero-n2 .dot{animation:hdot2 10s infinite}
.hero-n3 .dot{animation:hdot3 15s infinite}
.hero-n2 .dot:nth-child(2),.hero-n3 .dot:nth-child(2){animation-delay:5s}
.hero-n3 .dot:nth-child(3){animation-delay:10s}
@keyframes hdot2{0%,50%,100%{background:rgba(255,255,255,.35);width:8px}3%,47%{background:#fff;width:22px}}
@keyframes hdot3{0%,33.4%,100%{background:rgba(255,255,255,.35);width:8px}2.5%,30.8%{background:#fff;width:22px}}
@media(max-width:820px){.hero-grid{grid-template-columns:1fr;gap:26px;padding:38px 20px 42px;text-align:center}.hero-sub{max-width:none}.hero-cta{justify-content:center}.hero-media{max-width:440px;width:100%;margin:0 auto}}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;font-family:var(--font-body);font-size:1rem;font-weight:600;min-height:48px;padding:12px 26px;border-radius:var(--pill);border:1px solid transparent;cursor:pointer;transition:transform .12s cubic-bezier(.2,.7,.2,1),background-position .35s,box-shadow .2s,border-color .15s,color .15s,background .15s;line-height:1}
.btn:active{transform:translateY(1px)}.btn svg{width:18px;height:18px}
.btn-primary{background:linear-gradient(135deg,var(--color-primary),color-mix(in srgb,var(--color-primary) 55%,var(--color-accent)));background-size:150% 150%;color:#fff;box-shadow:0 10px 26px -12px color-mix(in srgb,var(--color-primary) 66%,transparent)}
.btn-primary:hover{background-position:100% 0;transform:translateY(-1px);box-shadow:0 16px 32px -14px color-mix(in srgb,var(--color-primary) 72%,transparent)}
.btn-ghost{background:var(--color-bg);color:var(--color-text);border-color:color-mix(in srgb,var(--color-primary) 30%,var(--color-border))}.btn-ghost:hover{border-color:var(--color-primary);color:var(--color-primary);background:color-mix(in srgb,var(--color-primary) 6%,var(--color-bg))}
.section{padding:clamp(48px,6vw,72px) 0}.section-h{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin:0 0 26px}.section-h h2{margin:0;font-size:clamp(1.4rem,2.4vw,1.85rem);font-weight:800;letter-spacing:-.02em}
/* Đầu-mục section (Phase 3): eyebrow nhỏ + tiêu đề bên trái, link "Xem tất cả →" bên phải. */
.section-eyebrow{margin:0 0 6px;color:var(--color-accent);font-weight:700;font-size:.74rem;letter-spacing:.14em;text-transform:uppercase}
.section-all{flex:0 0 auto;align-self:center;font-size:.86rem;font-weight:700;color:var(--color-primary);white-space:nowrap;transition:color .15s,transform .15s}
.section-all:hover{color:var(--color-primary-dark);transform:translateX(3px)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 24px}
.chip{border:1px solid var(--color-border);border-radius:var(--pill);padding:8px 16px;font-size:.86rem;font-weight:500;color:var(--color-muted);background:var(--color-bg);transition:border-color .15s,color .15s,background .15s,box-shadow .15s}
.chip:hover{border-color:var(--color-primary);color:var(--color-primary);background:color-mix(in srgb,var(--color-primary) 8%,var(--color-bg));box-shadow:0 6px 16px -8px color-mix(in srgb,var(--color-primary) 45%,transparent)}
/* Chip ĐANG CHỌN (bộ lọc danh mục /products) — đồng bộ ngôn ngữ với .sort-link.on. */
.chip.on{border-color:var(--color-primary);background:var(--color-hero-bg);color:color-mix(in srgb,var(--color-primary) 82%,#000);font-weight:700}
/* Trang /products: chip + thanh sort/lọc CĂN GIỮA (bớt thô, đúng nhịp MAISON). */
.chips-center{justify-content:center}
.products-h{justify-content:center;text-align:center}
.products-h .section-h-l{width:100%}
.products-title{margin:0 0 4px;font-size:clamp(1.5rem,2.8vw,2.1rem);font-weight:800;letter-spacing:-.02em}
.products-h .muted{margin:0;font-size:.9rem}
.products-toolbar{display:flex;flex-direction:column;align-items:center;gap:4px;margin:0 0 24px}
.products-toolbar .sortbar,.products-toolbar .filterbar{justify-content:center;margin:0 0 10px}
/* Nút "Xem thêm" TO, căn giữa dưới lưới nổi bật trang chủ → /products. */
.grid-more{display:flex;justify-content:center;margin:34px 0 4px}
.btn-more{min-height:54px;padding:14px 46px;font-size:1.05rem;font-weight:700;letter-spacing:.01em}
.btn-more-arrow{margin-left:10px;transition:transform .2s}
.btn-more:hover .btn-more-arrow{transform:translateX(4px)}
/* ── "Bài viết mới nhất" trang chủ (kiểu Haravan): 3 thẻ dọc ảnh bìa + trích đoạn ── */
.hblog-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:22px}
.hblog-card{display:flex;flex-direction:column;background:var(--color-bg);border:1px solid var(--color-border);border-radius:var(--r-lg);overflow:hidden;box-shadow:var(--sh-sm);transition:transform .25s cubic-bezier(.2,.7,.2,1),box-shadow .25s,border-color .25s}
.hblog-card:hover{transform:translateY(-4px);border-color:color-mix(in srgb,var(--color-primary) 30%,var(--color-border));box-shadow:var(--sh)}
.hblog-thumb{display:block;aspect-ratio:16/9;background:var(--color-surface);position:relative}
.hblog-thumb img{width:100%;height:100%;object-fit:cover}
.hblog-thumb .ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#c9c5bd}.hblog-thumb .ph svg{width:34px;height:34px}
.hblog-body{display:flex;flex-direction:column;gap:6px;padding:16px 18px 18px;flex:1}
.hblog-body h3{margin:0;font-size:1.02rem;font-weight:700;letter-spacing:-.01em;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.hblog-body h3 a{color:var(--color-text)}.hblog-body h3 a:hover{color:var(--color-primary)}
.hblog-date{color:var(--color-muted);font-size:.8rem}
.hblog-body p{margin:0;color:var(--color-muted);font-size:.88rem;line-height:1.6;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.hblog-more{margin-top:auto;padding-top:8px;color:var(--color-primary);font-weight:700;font-size:.88rem}
.hblog-more:hover{text-decoration:underline}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:22px}
.empty{color:var(--color-muted);padding:28px 0;text-align:center}
.features{background:var(--color-surface);border-top:1px solid var(--color-border);border-bottom:1px solid var(--color-border)}
.features .wrap{padding:36px 20px}
.feat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:26px}
.feat-item{display:flex;align-items:flex-start;gap:14px}
.feat-ic{flex:0 0 auto;width:46px;height:46px;border-radius:var(--pill);background:var(--color-bg);color:var(--color-primary);display:flex;align-items:center;justify-content:center;box-shadow:inset 0 0 0 1px var(--color-border)}
.feat-ic svg{width:23px;height:23px}
.feat-t{font-weight:700;font-size:.98rem;color:var(--color-text);margin-bottom:3px}
.feat-d{font-size:.85rem;color:var(--color-muted);line-height:1.5}
/* Bộ sưu tập (Phase 3): tile lớn hơn (min 200px, cao 168px), gradient thương hiệu + mũi tên
   trượt khi rê. Bố cục 3 cột trên desktop nên khối không còn "trơ trọi" như trước. */
.coll-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:18px}
.coll-tile{position:relative;display:flex;flex-direction:column;justify-content:flex-end;gap:6px;min-height:168px;padding:22px 24px;border-radius:var(--r-lg);background:linear-gradient(150deg,var(--color-hero-bg),color-mix(in srgb,var(--color-hero-bg) 40%,var(--color-bg)));border:1px solid var(--color-border);overflow:hidden;transition:transform .25s cubic-bezier(.2,.7,.2,1),box-shadow .25s,border-color .25s}
.coll-tile::after{content:"";position:absolute;top:-30px;right:-30px;width:120px;height:120px;border-radius:50%;background:color-mix(in srgb,var(--color-primary) 9%,transparent);transition:transform .35s}
.coll-tile:hover{transform:translateY(-4px);border-color:color-mix(in srgb,var(--color-primary) 42%,var(--color-border));box-shadow:var(--sh)}
.coll-tile:hover::after{transform:scale(1.35)}
.coll-name{position:relative;font-family:var(--font-heading);font-weight:800;font-size:1.1rem;letter-spacing:-.01em;color:var(--color-text);line-height:1.25}
.coll-go{position:relative;font-size:.82rem;font-weight:700;color:var(--color-accent);transition:transform .2s}
.coll-tile:hover .coll-go{transform:translateX(4px)}
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
/* Form lọc lưới (#27, no-JS GET) */
.filterbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 16px;font-size:.88rem}
.fb-chk{display:inline-flex;align-items:center;gap:6px;color:var(--color-text);cursor:pointer;padding:8px 14px;border:1px solid var(--color-border);border-radius:var(--pill);background:var(--color-bg)}
.fb-chk input{accent-color:var(--color-primary)}
.fb-num{width:110px;padding:8px 12px;border:1px solid var(--color-border);border-radius:var(--pill);font-size:.88rem;font-family:inherit;background:var(--color-bg);color:var(--color-text)}
.fb-num:focus{outline:none;border-color:var(--color-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--color-primary) 22%,transparent)}
.fb-sep{color:var(--color-muted)}
.fb-btn{padding:8px 18px;border:1px solid color-mix(in srgb,var(--color-primary) 55%,var(--color-border));border-radius:var(--pill);background:var(--color-bg);color:var(--color-primary);font-weight:700;font-size:.88rem;font-family:inherit;cursor:pointer;transition:background .15s,border-color .15s}
.fb-btn:hover{background:color-mix(in srgb,var(--color-primary) 8%,var(--color-bg));border-color:var(--color-primary)}
/* Ảnh trong nội dung (block image / blog) */
.ct-img{margin:1.4em 0}
.ct-img img{width:100%;border-radius:var(--r-lg);border:1px solid var(--color-border)}
.ct-img figcaption{margin-top:8px;font-size:.85rem;color:var(--color-muted);text-align:center}
.blog-list{display:grid;gap:18px;max-width:760px}
.blog-thumb{display:block;margin:0 0 14px;border-radius:var(--r);overflow:hidden;aspect-ratio:16/7;background:var(--color-surface)}
.blog-thumb img{width:100%;height:100%;object-fit:cover}
.blog-cover{margin:16px 0 22px}
.blog-cover img{width:100%;border-radius:var(--r-lg);border:1px solid var(--color-border)}
.blog-card{border:1px solid var(--color-border);border-radius:var(--r-lg);padding:22px 26px;background:var(--color-bg);box-shadow:var(--sh-sm);transition:transform .2s cubic-bezier(.2,.7,.2,1),border-color .2s,box-shadow .2s}
.blog-card:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--color-primary) 34%,var(--color-border));box-shadow:var(--sh)}
.blog-card h2{margin:0 0 4px;font-size:1.3rem;font-weight:800;letter-spacing:-.02em;line-height:1.3}
.blog-card h2 a{color:var(--color-text)}.blog-card h2 a:hover{color:var(--color-primary)}
.blog-date{color:var(--color-muted);font-size:.84rem;margin:0 0 10px}
.blog-card p{color:var(--color-muted);margin:0 0 12px;line-height:1.7}
.blog-more{color:var(--color-primary);font-weight:700;font-size:.92rem}
.blog-post{max-width:720px}.blog-post h1{margin:10px 0 2px;font-size:2rem;font-weight:800;letter-spacing:-.02em}
.blog-post p{line-height:1.85;color:var(--color-text);margin:0 0 18px}
/* ── Thẻ SP "cao cấp" kiểu ICONDENIM/Shopify (Phase 3) ───────────────────────────
   Rê chuột: nâng 6px + đổ bóng · ĐỔI sang ảnh thứ 2 (ảnh2 phủ lên, mờ→rõ) · hiện lớp phủ
   hành-động (👁 xem-nhanh + nút "Thêm vào giỏ" ở giữa) trượt lên. Máy cảm ứng (hover:none):
   lớp phủ LUÔN hiện (không có trạng thái hover). Chuyển động do rule reduced-motion toàn cục tắt. */
.card{position:relative;display:flex;flex-direction:column;background:var(--color-bg);border:1px solid var(--color-border);border-radius:var(--r-lg);overflow:hidden;box-shadow:var(--sh-sm);transition:transform .3s cubic-bezier(.2,.7,.2,1),box-shadow .3s,border-color .3s}
.card:hover{transform:translateY(-6px);border-color:color-mix(in srgb,var(--color-primary) 30%,var(--color-border));box-shadow:var(--sh-lg)}
.card-thumb{position:relative;aspect-ratio:1;background:var(--color-surface);overflow:hidden}
.card-media{position:absolute;inset:0;display:block}
.card-media img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transition:transform .6s cubic-bezier(.2,.7,.2,1),opacity .45s ease}
.card-img2{opacity:0}
.card:hover .card-img2{opacity:1}
.card:hover .card-media img{transform:scale(1.05)}
.card-media .ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#c9c5bd}.card-media .ph svg{width:34px;height:34px}
/* Lớp phủ hành-động — ANH EM của <a.card-media> (không lồng trong link → HTML hợp lệ). */
.card-actions{position:absolute;left:0;right:0;bottom:0;z-index:2;display:flex;align-items:center;gap:8px;padding:10px;opacity:0;transform:translateY(10px);transition:opacity .3s cubic-bezier(.2,.7,.2,1),transform .3s cubic-bezier(.2,.7,.2,1);background:linear-gradient(to top,color-mix(in srgb,var(--color-primary) 20%,transparent),transparent)}
.card:hover .card-actions{opacity:1;transform:none}
.card-qv{flex:0 0 auto;width:42px;height:42px;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--pill);background:var(--color-bg);color:var(--color-text);box-shadow:var(--sh-sm);transition:background .15s,color .15s}
.card-qv:hover{background:var(--color-primary);color:#fff}
.card-qv svg{width:19px;height:19px}
.card-add-form{flex:1;display:flex;margin:0}
.card-add{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:42px;padding:0 14px;border:0;border-radius:var(--pill);background:var(--color-primary);color:#fff;font-family:inherit;font-size:.85rem;font-weight:700;letter-spacing:.01em;cursor:pointer;box-shadow:var(--sh-sm);transition:background .15s,transform .12s}
.card-add:hover{background:var(--color-primary-dark)}
.card-add:active{transform:translateY(1px)}
.card-add svg{width:17px;height:17px}
@media(hover:none){.card-actions{opacity:1;transform:none}}
.card-body{padding:14px 16px 16px;display:flex;flex-direction:column;gap:6px;flex:1}
.card .name{font-size:.92rem;color:var(--color-text);line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.6em;transition:color .15s}
.card .name:hover{color:var(--color-primary)}
.card .price{font-weight:800;color:var(--color-text);font-size:1.08rem;letter-spacing:-.01em;font-variant-numeric:tabular-nums;margin-top:auto}
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
.card.is-out .card-media img{opacity:.55;filter:grayscale(.3)}
.trust{display:flex;gap:22px;flex-wrap:wrap;color:var(--color-muted);font-size:.85rem;border-top:1px solid var(--color-border);padding-top:18px}
.trust span{display:inline-flex;align-items:center;gap:6px}.trust svg{width:16px;height:16px;color:var(--color-primary)}
.content{max-width:720px;margin:0 auto;padding:44px 20px 64px}
.content h1{font-size:2.1rem;margin:0 0 .6em;font-weight:800;letter-spacing:-.02em}.content h2{margin:1.6em 0 .4em;font-size:1.35rem;font-weight:800;letter-spacing:-.02em}
.content p{line-height:1.8;margin:0 0 1.1em;color:color-mix(in srgb,var(--color-text) 72%,var(--color-bg))}.content ul{line-height:1.8;padding-left:1.3em;margin:0 0 1.1em}
.content blockquote{margin:1.4em 0;padding:.6em 0 .6em 1.2em;border-left:3px solid var(--color-primary);color:var(--color-muted);font-style:italic}
.content blockquote cite{display:block;margin-top:.5em;font-size:.88em;font-style:normal}
.content hr{border:0;border-top:1px solid var(--color-border);margin:2em 0}
/* ── Băng câu chuyện thương hiệu (chỉ hiện khi shop điền nội dung ở trang Giao diện) ── */
.story{background:var(--color-surface);border-top:1px solid var(--color-border);border-bottom:1px solid var(--color-border)}
.story .wrap{display:grid;grid-template-columns:.9fr 1.1fr;gap:48px;align-items:start;padding:clamp(44px,6vw,72px) 20px}
.story .eyebrow{display:inline-block;color:var(--color-accent);font-weight:700;font-size:.74rem;letter-spacing:.14em;text-transform:uppercase;margin:0 0 12px}
.story h2{margin:0;font-size:clamp(1.6rem,3vw,2.3rem);font-weight:800;letter-spacing:-.02em;line-height:1.15}
.story p{margin:0 0 22px;color:var(--color-muted);font-size:1.05rem;line-height:1.8;max-width:52ch}
.btn-solid{background:var(--color-primary);color:#fff}
.btn-solid:hover{background:var(--color-primary-dark);transform:translateY(-2px)}
@media(max-width:820px){.story .wrap{grid-template-columns:1fr;gap:18px}}
/* ── Footer 4 cột ── */
.ftr{border-top:1px solid var(--color-border);background:var(--color-surface);margin-top:36px}
.ftr .wrap{padding:clamp(38px,5vw,56px) 20px 26px;color:var(--color-muted);font-size:.88rem}
.ftr-grid{display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr;gap:32px}
.ftr-brand{font-family:var(--font-heading);font-weight:800;font-size:1rem;letter-spacing:.16em;text-transform:uppercase;color:var(--color-text);margin:0 0 12px}
.ftr-col h4{margin:0 0 12px;font-size:.76rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--color-text)}
.ftr-col a{display:block;padding:4px 0;color:var(--color-muted);font-weight:500;transition:color .15s}.ftr-col a:hover{color:var(--color-primary)}
.ftr-contact{font-size:.85rem;color:var(--color-muted);margin:0 0 14px;line-height:1.7}
.ftr .badges{display:flex;gap:18px;flex-wrap:wrap}.ftr .badges span{display:inline-flex;align-items:center;gap:6px}.ftr .badges svg{width:16px;height:16px;color:var(--color-primary)}
.ftr .copy{margin-top:30px;padding-top:18px;border-top:1px solid var(--color-border);font-size:.84rem}
@media(max-width:900px){.ftr-grid{grid-template-columns:1fr 1fr}.ftr-about{grid-column:1/-1}}
@media(max-width:480px){.ftr-grid{grid-template-columns:1fr}}
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
@media(max-width:720px){.pd-grid{grid-template-columns:1fr;gap:24px}.hnav{gap:14px;font-size:.85rem}.grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}.pd-info h1{font-size:1.5rem}.pd-actions .btn{flex:1}}
/* ── Drawer giỏ hàng (Phase 2, chỉ hoạt động khi có JS — shell TĨNH, JS đổ dữ liệu) ──
   z-index 70/71: trên header (20), menu/search (30), lightbox (50). [hidden] phải thắng
   display:flex → khai display:none tường minh. prefers-reduced-motion: rule toàn cục
   (*{transition:none!important}) đã tắt slide/fade — không cần rule riêng. */
html.cd-lock{overflow:hidden}
#cart-backdrop{position:fixed;inset:0;z-index:70;background:rgba(17,24,39,.5);opacity:0;transition:opacity .25s}
#cart-backdrop.open{opacity:1}
#cart-backdrop[hidden]{display:none}
#cart-drawer{position:fixed;top:0;right:0;bottom:0;z-index:71;width:min(400px,92vw);background:var(--color-bg);display:flex;flex-direction:column;box-shadow:-24px 0 60px -30px rgba(0,0,0,.35);transform:translateX(100%);transition:transform .3s cubic-bezier(.2,.7,.2,1)}
#cart-drawer.open{transform:none}
#cart-drawer[hidden]{display:none}
.cd-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--color-border)}
.cd-head h2{margin:0;font-size:1.1rem}
.cd-close{background:none;border:0;font-size:1.15rem;cursor:pointer;color:var(--color-muted);padding:6px 10px;border-radius:8px;line-height:1}
.cd-close:hover{color:var(--color-text);background:var(--color-surface)}
.cd-ship{padding:14px 20px;border-bottom:1px solid var(--color-border);background:var(--color-surface)}
.cd-bar{height:8px;border-radius:var(--pill);background:color-mix(in srgb,var(--color-primary) 14%,var(--color-bg));overflow:hidden}
.cd-fill{display:block;height:100%;width:0;border-radius:var(--pill);background:var(--color-primary);transition:width .3s}
.cd-ship-text{margin:8px 0 0;font-size:.85rem;color:var(--color-muted)}
.cd-items{flex:1;overflow-y:auto;padding:6px 20px}
.cd-row{display:flex;gap:12px;align-items:flex-start;padding:14px 0;border-bottom:1px solid var(--color-border)}
.cd-img{width:64px;height:64px;object-fit:cover;border-radius:10px;border:1px solid var(--color-border);background:var(--color-surface);flex:none}
.cd-mid{flex:1;min-width:0}
.cd-title{font-size:.92rem;line-height:1.4}
.cd-var{font-size:.8rem;color:var(--color-muted)}
.cd-price{font-weight:700;font-size:.9rem;margin-top:2px;font-variant-numeric:tabular-nums}
.cd-qty{display:inline-flex;align-items:center;gap:2px;margin-top:8px;border:1px solid var(--color-border);border-radius:var(--pill)}
.cd-btn{background:none;border:0;cursor:pointer;font-size:1rem;color:var(--color-text);width:32px;height:30px;line-height:1;border-radius:var(--pill);padding:0}
.cd-btn:hover{background:var(--color-surface)}
.cd-btn:disabled{opacity:.4;cursor:default}
.cd-num{min-width:26px;text-align:center;font-size:.9rem;font-variant-numeric:tabular-nums}
.cd-del{width:30px;height:30px;flex:none;color:var(--color-muted);font-size:.85rem}
.cd-del:hover{color:#b91c1c}
.cd-empty{text-align:center;padding:48px 10px;color:var(--color-muted);display:flex;flex-direction:column;gap:14px;align-items:center}
.cd-foot{border-top:1px solid var(--color-border);padding:14px 20px calc(14px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:10px}
.cd-sub{display:flex;justify-content:space-between;font-size:.95rem}
.cd-sub strong{font-variant-numeric:tabular-nums}
.cd-go{width:100%}
.cd-view{text-align:center;font-size:.9rem;color:var(--color-muted);text-decoration:underline}
.cd-view:hover{color:var(--color-primary)}
/* ── Quick-view modal (Phase 3, chỉ JS — shell TĨNH, JS đổ dữ liệu bằng DOM, KHÔNG innerHTML) ──
   Tái dùng mẫu backdrop/overlay như drawer giỏ; căn GIỮA màn hình; a11y dialog + trả focus.
   z-index 72/73: trên header(20)/menu(30)/lightbox(50)/drawer(70-71). [hidden] thắng display. */
#qv-backdrop{position:fixed;inset:0;z-index:72;background:rgba(17,24,39,.55);opacity:0;transition:opacity .25s}
#qv-backdrop.open{opacity:1}
#qv-backdrop[hidden]{display:none}
#qv-modal{position:fixed;top:50%;left:50%;z-index:73;transform:translate(-50%,-47%);width:min(860px,94vw);max-height:90vh;overflow:auto;background:var(--color-bg);border-radius:var(--r-lg);box-shadow:var(--sh-lg);opacity:0;transition:opacity .25s,transform .3s cubic-bezier(.2,.7,.2,1)}
#qv-modal.open{opacity:1;transform:translate(-50%,-50%)}
#qv-modal[hidden]{display:none}
.qv-close{position:absolute;top:12px;right:12px;z-index:2;background:var(--color-bg);border:1px solid var(--color-border);width:38px;height:38px;border-radius:var(--pill);font-size:1rem;cursor:pointer;color:var(--color-muted);line-height:1}
.qv-close:hover{color:var(--color-text);background:var(--color-surface)}
.qv-body{display:grid;grid-template-columns:1fr 1fr;gap:28px;padding:26px}
.qv-media{display:flex;flex-direction:column;gap:12px}
.qv-main{aspect-ratio:1;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--r-lg);overflow:hidden;display:flex;align-items:center;justify-content:center;color:#c4c8cf}
.qv-main img{width:100%;height:100%;object-fit:cover}
.qv-thumbs{display:flex;gap:8px;flex-wrap:wrap}
.qv-thumb{width:60px;height:60px;border:2px solid var(--color-border);border-radius:10px;overflow:hidden;cursor:pointer;padding:0;background:none}
.qv-thumb.sel{border-color:var(--color-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--color-primary) 30%,transparent)}
.qv-thumb img{width:100%;height:100%;object-fit:cover}
.qv-info h2{margin:0 0 12px;font-size:1.4rem;font-weight:800;letter-spacing:-.02em;line-height:1.22}
.qv-price{font-size:1.5rem;font-weight:800;color:var(--color-primary);margin:0 0 8px;font-variant-numeric:tabular-nums}
.qv-price .cmp{font-size:.62em}.qv-price .off{font-size:.46em}
.qv-stock{font-size:.85rem;font-weight:700;margin:0 0 16px}
.qv-stock.in{color:color-mix(in srgb,var(--color-primary) 82%,#000)}
.qv-stock.out{color:#b91c1c}
.qv-desc{font-size:.9rem;color:var(--color-muted);line-height:1.6;margin:0 0 18px}
.qv-opt{margin:0 0 14px}
.qv-opt-name{font-size:.82rem;font-weight:600;color:var(--color-muted);margin:0 0 8px}
.qv-chips{display:flex;gap:8px;flex-wrap:wrap}
.qv-chip{padding:8px 14px;border:1px solid var(--color-border);border-radius:var(--r-sm);font-size:.88rem;font-family:inherit;color:var(--color-text);background:var(--color-bg);cursor:pointer;transition:border-color .15s,background .15s,box-shadow .15s}
.qv-chip:hover{border-color:var(--color-primary)}
.qv-chip.sel{border-color:var(--color-primary);background:var(--color-hero-bg);color:color-mix(in srgb,var(--color-primary) 82%,#000);font-weight:700;box-shadow:0 0 0 3px color-mix(in srgb,var(--color-primary) 16%,transparent)}
.qv-chip.out{color:var(--color-muted);text-decoration:line-through}
.qv-chip[disabled]{color:#c4c8cf;background:var(--color-surface);border-style:dashed;cursor:not-allowed;text-decoration:line-through}
.qv-buy{display:flex;gap:10px;align-items:center;margin:18px 0 14px;flex-wrap:wrap}
.qv-qty{display:inline-flex;align-items:center;border:1px solid var(--color-border);border-radius:var(--pill)}
.qv-qty button{background:none;border:0;width:36px;height:38px;font-size:1.1rem;cursor:pointer;color:var(--color-text);line-height:1}
.qv-qty button:disabled{opacity:.4;cursor:default}
.qv-qty span{min-width:30px;text-align:center;font-variant-numeric:tabular-nums}
.qv-add{flex:1;min-width:150px;min-height:44px}
.qv-add:disabled{opacity:.5;cursor:not-allowed}
.qv-detail{display:inline-block;font-size:.9rem;font-weight:700;color:var(--color-primary)}
.qv-detail:hover{text-decoration:underline}
@media(max-width:640px){.qv-body{grid-template-columns:1fr;gap:18px;padding:20px}.qv-main{max-width:320px;margin:0 auto}}`;

// ── Drawer giỏ hàng (Phase 2): shell TĨNH render server-side trên MỌI trang có nonce ──
// CACHE-SAFE: trang storefront cache CDN ~60s dùng chung mọi khách → shell TUYỆT ĐỐI không
// chứa dữ liệu giỏ/sản phẩm — chỉ nhãn tiếng Việt tĩnh; JS fetch /cart/summary (no-store) đổ
// dữ liệu per-khách. <template> trạng-thái-rỗng cũng tĩnh (JS clone, không innerHTML).
const DRAWER_SHELL = `<div id="cart-backdrop" hidden></div>
<aside id="cart-drawer" role="dialog" aria-modal="true" aria-label="Giỏ hàng" hidden>
  <div class="cd-head"><h2>Giỏ hàng</h2><button type="button" id="cd-close" class="cd-close" aria-label="Đóng giỏ hàng">✕</button></div>
  <div class="cd-ship" id="cd-ship" hidden><div class="cd-bar"><span class="cd-fill" id="cd-ship-fill"></span></div><p class="cd-ship-text" id="cd-ship-text"></p></div>
  <div class="cd-items" id="cd-items" aria-live="polite"></div>
  <div class="cd-foot">
    <div class="cd-sub"><span>Tạm tính</span><strong id="cd-subtotal"></strong></div>
    <a class="btn btn-primary cd-go" href="/checkout">Thanh toán</a>
    <a class="cd-view" href="/cart">Xem giỏ hàng</a>
  </div>
</aside>
<template id="cd-empty-tpl"><div class="cd-empty"><p>Giỏ hàng trống</p><a class="btn btn-alt" href="/">Tiếp tục mua sắm</a></div></template>`;

// ── Quick-view modal (Phase 3): shell TĨNH — thân #qv-body do JS dựng bằng DOM (KHÔNG innerHTML).
// Ẩn + không nội dung khi không JS (thẻ 👁/Thêm-giỏ vẫn là <a> về /p/:slug → suy biến sạch).
const QUICKVIEW_SHELL = `<div id="qv-backdrop" hidden></div>
<div id="qv-modal" role="dialog" aria-modal="true" aria-label="Xem nhanh sản phẩm" hidden>
  <button type="button" id="qv-close" class="qv-close" aria-label="Đóng xem nhanh">✕</button>
  <div class="qv-body" id="qv-body"></div>
</div>`;

// Lớp JS DUY NHẤT của storefront (Phase 1 badge + Phase 2 drawer). 1 khối <script nonce> — không
// framework, không phụ thuộc ngoài (hợp CSP script-src 'nonce'). XSS-SAFE: KHÔNG nội suy dữ liệu
// server/user vào thân script (chỉ nonce ở thuộc tính); MỌI dữ liệu từ /cart/summary vào DOM qua
// createElement + textContent + gán thuộc tính (img.src) — TUYỆT ĐỐI không innerHTML.
// fetch same-origin (checkout service qua Caddy) gửi kèm cookie __Host-cart. Lỗi/tắt JS → mọi thứ
// rơi về no-JS: 🛒 dẫn /cart, form thêm giỏ PRG, badge vắng lặng lẽ.
// "Mua ngay" (name=buynow) KHÔNG bị chặn — phải điều hướng /checkout?bn=1 (giỏ riêng 1 món).
function cartScript(nonce) {
  return `<script nonce="${esc(nonce)}">(function(){
  'use strict';
  if(!window.fetch) return;
  var badge=document.getElementById('cart-badge');
  function setBadge(n){ if(!badge) return; if(n>0){ badge.textContent=(n>99?'99+':String(n)); badge.hidden=false; } else { badge.textContent=''; badge.hidden=true; } }
  // Định dạng VNĐ thuần JS (không Intl để chắc chắn ổn định): 1234567 → "1.234.567₫".
  function vnd(n){ n=Math.round(Number(n)||0); return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g,'.')+'\\u20ab'; }
  function getSummary(){ return fetch('/cart/summary',{credentials:'same-origin',headers:{'accept':'application/json'}}).then(function(r){ return r.ok?r.json():null; }); }
  getSummary().then(function(d){ if(d) setBadge(d.count||0); }).catch(function(){});

  // ── Carousel hero (Phase 6): >1 cảnh + có JS → JS cầm lái: mũi tên ‹ › + chấm BẤM được
  // + tự chuyển 5s + DỪNG khi rê chuột/focus (WCAG 2.2.2), rời ra chạy tiếp. Nút do JS dựng
  // (createElement/textContent — không innerHTML) nên markup no-JS sạch; không JS →
  // keyframes CSS fallback (10s/15s) tự chạy như cũ. .js-run tắt keyframes, .on cầm cảnh.
  var hero=document.querySelector('.hero');
  var hslides=hero?hero.querySelectorAll('.hslide'):[];
  if(hero&&hslides.length>1){
    hero.classList.add('js-run');
    var hIdx=0,hTimer=null,hDots=[];
    var hDotsWrap=hero.querySelector('.hero-dots');
    function hShow(n){
      hIdx=(n+hslides.length)%hslides.length;
      for(var i=0;i<hslides.length;i++){ if(i===hIdx) hslides[i].classList.add('on'); else hslides[i].classList.remove('on'); }
      for(var j=0;j<hDots.length;j++){ if(j===hIdx) hDots[j].classList.add('on'); else hDots[j].classList.remove('on'); }
    }
    var hReduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function hStop(){ if(hTimer){ clearInterval(hTimer); hTimer=null; } }
    function hStart(){ hStop(); if(hReduce) return; hTimer=setInterval(function(){ hShow(hIdx+1); },5000); } // reduced-motion: không tự chạy, mũi tên vẫn dùng được
    if(hDotsWrap){ // thay chấm <span> tĩnh bằng <button> bấm được (bàn phím tới được)
      while(hDotsWrap.firstChild) hDotsWrap.removeChild(hDotsWrap.firstChild);
      hDotsWrap.removeAttribute('aria-hidden');
      for(var d=0;d<hslides.length;d++)(function(d){
        var b=document.createElement('button'); b.type='button'; b.className='dot';
        b.setAttribute('aria-label','Chuyển tới cảnh '+(d+1));
        b.addEventListener('click',function(){ hShow(d); hStart(); });
        hDotsWrap.appendChild(b); hDots.push(b);
      })(d);
    }
    function hArrow(cls,txt,label,step){
      var b=document.createElement('button'); b.type='button'; b.className='hero-arrow '+cls;
      b.textContent=txt; b.setAttribute('aria-label',label);
      b.addEventListener('click',function(){ hShow(hIdx+step); hStart(); });
      hero.appendChild(b);
    }
    hArrow('prev','\\u2039','Cảnh trước',-1);
    hArrow('next','\\u203a','Cảnh sau',1);
    hero.addEventListener('mouseenter',hStop);
    hero.addEventListener('mouseleave',hStart);
    hero.addEventListener('focusin',hStop);
    hero.addEventListener('focusout',hStart);
    hShow(0); hStart();
  }

  var drawer=document.getElementById('cart-drawer'), backdrop=document.getElementById('cart-backdrop');
  if(!drawer||!backdrop) return; // trang không có shell (404/bảo trì) → chỉ badge
  var itemsBox=document.getElementById('cd-items'), subEl=document.getElementById('cd-subtotal'),
      shipZone=document.getElementById('cd-ship'), shipFill=document.getElementById('cd-ship-fill'),
      shipText=document.getElementById('cd-ship-text'), closeBtn=document.getElementById('cd-close'),
      emptyTpl=document.getElementById('cd-empty-tpl');
  var lastFocus=null, closing=null;

  function btn(txt,label,cls){ var b=document.createElement('button'); b.type='button'; b.className=cls; b.textContent=txt; b.setAttribute('aria-label',label); return b; }
  // Dựng 1 dòng sản phẩm — CHỈ createElement/textContent/gán thuộc tính (chống XSS lớp 1;
  // CSP nonce là lớp 2). qty đổi → POST /cart/update rồi re-render toàn bộ (dòng mới tinh).
  function rowEl(it){
    var row=document.createElement('div'); row.className='cd-row';
    var im;
    if(it.image_url){ im=document.createElement('img'); im.className='cd-img'; im.src=it.image_url; im.alt=''; im.loading='lazy'; }
    else { im=document.createElement('div'); im.className='cd-img'; }
    row.appendChild(im);
    var mid=document.createElement('div'); mid.className='cd-mid';
    var t=document.createElement('div'); t.className='cd-title'; t.textContent=it.title; mid.appendChild(t);
    if(it.variant_label){ var v=document.createElement('div'); v.className='cd-var'; v.textContent=it.variant_label; mid.appendChild(v); }
    var pr=document.createElement('div'); pr.className='cd-price'; pr.textContent=vnd(it.unit_price_vnd); mid.appendChild(pr);
    var minus=btn('\\u2212','Giảm số lượng','cd-btn'), plus=btn('+','Tăng số lượng','cd-btn'), del=btn('\\u2715','Xoá khỏi giỏ','cd-btn cd-del');
    var num=document.createElement('span'); num.className='cd-num'; num.textContent=String(it.qty);
    var q=document.createElement('div'); q.className='cd-qty';
    q.appendChild(minus); q.appendChild(num); q.appendChild(plus); mid.appendChild(q);
    row.appendChild(mid); row.appendChild(del);
    var busy=false;
    function change(nq){ // khoá nút khi đang gửi (chống double-submit); re-render thay dòng mới
      if(busy) return; busy=true; minus.disabled=plus.disabled=del.disabled=true;
      update(it.line_id,nq);
    }
    minus.onclick=function(){ change(Math.max(0,it.qty-1)); };
    plus.onclick=function(){ change(it.qty+1); };
    del.onclick=function(){ change(0); };
    return row;
  }
  // POST /cart/update form-encoded — ĐÚNG field của form /cart no-JS (variant_id + qty; qty 0 =
  // xoá). line_id chính là variant_id (checkout /cart/summary). 303 → fetch tự follow, bỏ body.
  function update(lineId,qty){
    var body=new URLSearchParams(); body.set('variant_id',lineId); body.set('qty',String(qty));
    return fetch('/cart/update',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/x-www-form-urlencoded'},body:body.toString()})
      .then(refresh,refresh); // kể cả lỗi (422 hết tồn…) vẫn re-fetch → drawer về đúng trạng thái server
  }
  function refresh(){ return getSummary().then(function(d){ if(d) render(d); }).catch(function(){}); }
  function render(d){
    while(itemsBox.firstChild) itemsBox.removeChild(itemsBox.firstChild);
    setBadge(d.count||0);
    if(!d.count){ if(emptyTpl&&emptyTpl.content) itemsBox.appendChild(emptyTpl.content.cloneNode(true)); }
    else for(var i=0;i<d.items.length;i++) itemsBox.appendChild(rowEl(d.items[i]));
    subEl.textContent=vnd(d.subtotal_vnd||0);
    var th=d.free_ship_threshold_vnd;
    if(th!=null&&th>0){ // shop có ngưỡng freeship → thanh tiến độ; không có → ẩn cả vùng
      shipZone.hidden=false;
      shipFill.style.width=Math.min(100,Math.round((d.subtotal_vnd||0)/th*100))+'%';
      var rem=d.free_ship_remaining_vnd;
      shipText.textContent=(rem!=null&&rem>0)?('Mua thêm '+vnd(rem)+' để được MIỄN PHÍ vận chuyển'):'\\ud83c\\udf89 Đơn của bạn được MIỄN PHÍ vận chuyển';
    } else shipZone.hidden=true;
  }
  function open(){
    if(closing){ clearTimeout(closing); closing=null; }
    lastFocus=document.activeElement;
    backdrop.hidden=false; drawer.hidden=false;
    void drawer.offsetWidth; // ép reflow để transition translateX chạy từ trạng thái đóng
    drawer.classList.add('open'); backdrop.classList.add('open');
    document.documentElement.classList.add('cd-lock'); // khoá scroll body (CSS overflow:hidden)
    if(closeBtn) closeBtn.focus();
    refresh();
  }
  function close(){
    drawer.classList.remove('open'); backdrop.classList.remove('open');
    document.documentElement.classList.remove('cd-lock');
    closing=setTimeout(function(){ drawer.hidden=true; backdrop.hidden=true; closing=null; },300);
    if(lastFocus&&lastFocus.focus) lastFocus.focus(); // trả focus về nơi trước khi mở
  }
  if(closeBtn) closeBtn.addEventListener('click',close);
  backdrop.addEventListener('click',close);
  document.addEventListener('keydown',function(e){ if(e.key==='Escape'&&!drawer.hidden) close(); });
  // 🛒 header: có JS → mở drawer thay vì điều hướng; không JS → <a href="/cart"> như cũ.
  // Ctrl/Cmd/Shift-click hoặc chuột giữa = ý định "mở tab mới" → tôn trọng, không chặn.
  var cartLink=document.querySelector('.hicon.cart');
  if(cartLink) cartLink.addEventListener('click',function(e){ if(e.ctrlKey||e.metaKey||e.shiftKey||e.button===1) return; e.preventDefault(); open(); });
  // Form thêm giỏ trang SP: chặn CHỈ nút "Thêm vào giỏ". "Mua ngay" (submitter name=buynow)
  // GIỮ điều hướng /checkout?bn=1. Trình duyệt cũ không có e.submitter → không chặn (an toàn:
  // không thể phân biệt nút → để form submit thật). FormData KHÔNG gồm nút không tên → body sạch.
  var addForm=document.querySelector('form.pd-actions[action="/cart/add"]');
  if(addForm) addForm.addEventListener('submit',function(e){
    if(!('submitter' in e)) return;
    if(e.submitter&&e.submitter.name==='buynow') return;
    e.preventDefault();
    var body=new URLSearchParams(new FormData(addForm)).toString();
    fetch('/cart/add',{method:'POST',credentials:'same-origin',redirect:'follow',headers:{'content-type':'application/x-www-form-urlencoded'},body:body})
      .then(function(r){ if(!r.ok){ addForm.submit(); return; } open(); }) // lỗi (hết tồn…) → submit thật, hiện trang lỗi server
      .catch(function(){ addForm.submit(); });
  });

  // ── Quick-view modal (Phase 3) ────────────────────────────────────────────────
  // 👁 (.card-qv) hoặc "Thêm vào giỏ" bản LINK (a.card-add = SP nhiều biến thể) → mở modal.
  // Form thêm-nhanh SP phẳng (.card-add-form) → fetch + mở drawer. Dữ liệu quick-view vào DOM
  // CHỈ qua createElement/textContent/gán thuộc tính — TUYỆT ĐỐI không innerHTML. Lỗi mạng/JSON
  // → điều hướng /p/:slug (suy biến về trang SP). Tái dùng open() (drawer) sau khi thêm giỏ.
  var qvModal=document.getElementById('qv-modal'), qvBackdrop=document.getElementById('qv-backdrop'),
      qvBody=document.getElementById('qv-body'), qvCloseBtn=document.getElementById('qv-close');
  var qvLastFocus=null, qvClosing=null;
  function el(tag,cls,txt){ var e=document.createElement(tag); if(cls) e.className=cls; if(txt!=null) e.textContent=txt; return e; }
  function qvOpen(){
    if(qvClosing){ clearTimeout(qvClosing); qvClosing=null; }
    qvLastFocus=document.activeElement;
    qvBackdrop.hidden=false; qvModal.hidden=false;
    void qvModal.offsetWidth;
    qvModal.classList.add('open'); qvBackdrop.classList.add('open');
    document.documentElement.classList.add('cd-lock');
    if(qvCloseBtn) qvCloseBtn.focus();
  }
  function qvClose(){
    qvModal.classList.remove('open'); qvBackdrop.classList.remove('open');
    document.documentElement.classList.remove('cd-lock');
    qvClosing=setTimeout(function(){ qvModal.hidden=true; qvBackdrop.hidden=true; while(qvBody.firstChild) qvBody.removeChild(qvBody.firstChild); qvClosing=null; },300);
    if(qvLastFocus&&qvLastFocus.focus) qvLastFocus.focus();
  }
  // Giá 1 biến thể → cụm node (giá sale ĐẬM + gạch giá gốc + badge -% nếu có sale; không thì chỉ giá).
  function qvPriceNodes(v){
    var frag=document.createDocumentFragment();
    if(v.sale_price_vnd!=null){
      frag.appendChild(el('strong',null,vnd(v.sale_price_vnd)));
      frag.appendChild(document.createTextNode(' '));
      frag.appendChild(el('s','cmp',vnd(v.price_vnd)));
      if(v.sale_off_pct!=null) frag.appendChild(el('span','off','-'+v.sale_off_pct+'%'));
    } else { frag.appendChild(el('strong',null,vnd(v.price_vnd))); }
    return frag;
  }
  function qvBuild(d){
    while(qvBody.firstChild) qvBody.removeChild(qvBody.firstChild);
    var variants=d.variants||[], options=d.options||[], images=d.images||[], i, k;
    var sel={}, def=null; // sel: option_id -> value_id ; def = biến thể còn hàng đầu (hoặc đầu tiên)
    for(i=0;i<variants.length;i++){ if(variants[i].available>0){ def=variants[i]; break; } }
    if(!def) def=variants[0]||null;
    if(def) for(k=0;k<options.length;k++) sel[options[k].id]=def.value_ids[k];
    function resolve(){ // khớp tổ hợp value_ids đang chọn → biến thể
      for(var i=0;i<variants.length;i++){ var v=variants[i], m=true; for(var k=0;k<options.length;k++){ if(v.value_ids[k]!==sel[options[k].id]){ m=false; break; } } if(m) return v; }
      return options.length?null:(variants[0]||null);
    }
    // ── Cột ảnh: ảnh chính + dải thumbnail
    var media=el('div','qv-media'), mainBox=el('div','qv-main'), mainImg=null;
    if(images.length){ mainImg=document.createElement('img'); mainImg.src=images[0]; mainImg.alt=d.title; mainBox.appendChild(mainImg); }
    media.appendChild(mainBox);
    var thumbBtns=[];
    if(images.length>1){
      var strip=el('div','qv-thumbs');
      images.forEach(function(u,idx){
        var b=el('button','qv-thumb'+(idx===0?' sel':'')); b.type='button';
        var im=document.createElement('img'); im.src=u; im.alt=''; b.appendChild(im);
        b.onclick=function(){ if(mainImg) mainImg.src=u; thumbBtns.forEach(function(x){ x.classList.remove('sel'); }); b.classList.add('sel'); };
        thumbBtns.push(b); strip.appendChild(b);
      });
      media.appendChild(strip);
    }
    qvBody.appendChild(media);
    // ── Cột thông tin
    var info=el('div','qv-info');
    info.appendChild(el('h2',null,d.title));
    var priceEl=el('div','qv-price'); info.appendChild(priceEl);
    var stockEl=el('div','qv-stock'); info.appendChild(stockEl);
    if(d.short_desc) info.appendChild(el('p','qv-desc',d.short_desc));
    var chipRefs=[]; // {optId,valId,btn}
    options.forEach(function(o){
      var wrap=el('div','qv-opt'); wrap.appendChild(el('div','qv-opt-name',o.name));
      var chips=el('div','qv-chips');
      o.values.forEach(function(val){
        var b=el('button','qv-chip',val.label); b.type='button';
        b.onclick=function(){ if(b.disabled) return; sel[o.id]=val.id; update(); };
        chipRefs.push({optId:o.id,valId:val.id,btn:b}); chips.appendChild(b);
      });
      wrap.appendChild(chips); info.appendChild(wrap);
    });
    var buy=el('div','qv-buy'), qty=1;
    var qbox=el('div','qv-qty');
    var minus=el('button',null,'\\u2212'); minus.type='button';
    var qnum=el('span',null,'1');
    var plus=el('button',null,'+'); plus.type='button';
    qbox.appendChild(minus); qbox.appendChild(qnum); qbox.appendChild(plus); buy.appendChild(qbox);
    var addBtn=el('button','btn btn-primary qv-add','Thêm vào giỏ'); addBtn.type='button';
    buy.appendChild(addBtn); info.appendChild(buy);
    var detail=el('a','qv-detail','Xem chi tiết →'); detail.href='/p/'+d.slug; info.appendChild(detail);
    qvBody.appendChild(info);
    function update(){
      var cur=resolve();
      while(priceEl.firstChild) priceEl.removeChild(priceEl.firstChild);
      if(cur) priceEl.appendChild(qvPriceNodes(cur)); else priceEl.textContent=vnd(d.price_vnd);
      var avail=cur?cur.available:0;
      stockEl.className='qv-stock '+(avail>0?'in':'out');
      stockEl.textContent=avail>0?(avail<=5?('Chỉ còn '+avail):'Còn hàng'):'Hết hàng';
      if(cur&&cur.image_url&&mainImg){ mainImg.src=cur.image_url; thumbBtns.forEach(function(x){ x.classList.remove('sel'); }); }
      chipRefs.forEach(function(ref){ // đổi 1 trục giữ trục khác → có biến thể? còn hàng?
        var probe={}; for(var key in sel) probe[key]=sel[key]; probe[ref.optId]=ref.valId;
        var match=null;
        for(var i=0;i<variants.length;i++){ var v=variants[i], ok=true; for(var k=0;k<options.length;k++){ if(v.value_ids[k]!==probe[options[k].id]){ ok=false; break; } } if(ok){ match=v; break; } }
        ref.btn.classList.remove('sel','out'); ref.btn.disabled=false;
        if(!match){ ref.btn.disabled=true; }
        else { if(sel[ref.optId]===ref.valId) ref.btn.classList.add('sel'); if(match.available<=0) ref.btn.classList.add('out'); }
      });
      addBtn.disabled=!(cur&&cur.available>0);
      if(cur&&cur.available>0&&qty>cur.available){ qty=cur.available; qnum.textContent=String(qty); }
      minus.disabled=qty<=1;
    }
    minus.onclick=function(){ if(qty>1){ qty--; qnum.textContent=String(qty); update(); } };
    plus.onclick=function(){ var cur=resolve(); if(!cur||qty<cur.available){ qty++; qnum.textContent=String(qty); update(); } };
    addBtn.onclick=function(){
      var cur=resolve(); if(!cur||cur.available<=0) return;
      addBtn.disabled=true;
      var body=new URLSearchParams(); body.set('variant_id',cur.id); body.set('qty',String(qty));
      fetch('/cart/add',{method:'POST',credentials:'same-origin',redirect:'follow',headers:{'content-type':'application/x-www-form-urlencoded'},body:body.toString()})
        .then(function(r){ if(!r.ok){ location.href='/p/'+d.slug; return; } qvClose(); open(); })
        .catch(function(){ location.href='/p/'+d.slug; });
    };
    update();
  }
  function qvOpenFor(href){
    fetch(href+'/quickview',{credentials:'same-origin',headers:{'accept':'application/json'}})
      .then(function(r){ return r.ok?r.json():null; })
      .then(function(d){ if(!d||!d.variants||!d.variants.length){ location.href=href; return; } qvBuild(d); qvOpen(); })
      .catch(function(){ location.href=href; });
  }
  if(qvModal&&qvBackdrop&&qvBody){
    if(qvCloseBtn) qvCloseBtn.addEventListener('click',qvClose);
    qvBackdrop.addEventListener('click',qvClose);
    document.addEventListener('keydown',function(e){ if(e.key==='Escape'&&!qvModal.hidden) qvClose(); });
    document.addEventListener('click',function(e){ // uỷ quyền: 👁 + "Thêm vào giỏ" bản LINK
      if(!e.target||!e.target.closest) return;
      var t=e.target.closest('.card-qv, a.card-add');
      if(!t) return;
      if(e.ctrlKey||e.metaKey||e.shiftKey||e.button===1) return; // tôn trọng "mở tab mới"
      e.preventDefault(); qvOpenFor(t.getAttribute('href'));
    });
    document.addEventListener('submit',function(e){ // form thêm-nhanh SP phẳng → drawer
      var f=e.target;
      if(!f||!f.classList||!f.classList.contains('card-add-form')) return;
      if(!drawer) return;
      e.preventDefault();
      var body=new URLSearchParams(new FormData(f)).toString();
      fetch('/cart/add',{method:'POST',credentials:'same-origin',redirect:'follow',headers:{'content-type':'application/x-www-form-urlencoded'},body:body})
        .then(function(r){ if(!r.ok){ f.submit(); return; } open(); })
        .catch(function(){ f.submit(); });
    });
  }
})();</script>`;
}

function page(title, tokens, bodyHtml, head = '', nonce = '') {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${head}<style>${tokensToCss(tokens)}\n${STYLE}</style></head>
<body>${bodyHtml}${nonce ? DRAWER_SHELL + QUICKVIEW_SHELL + cartScript(nonce) : ''}</body></html>`;
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
  if (!has('blog')) {
    // "Bài viết mới nhất": NGAY SAU lưới sản phẩm (layout cũ lưu trước khi có section này
    // vẫn tự hiện — mirror cách chèn features/collections). Không có product_grid → trước
    // footer. Shop chưa có bài published → renderer trả rỗng, vô hại.
    const gi = out.findIndex((s) => s && s.section === 'product_grid');
    if (gi >= 0) out.splice(gi + 1, 0, { section: 'blog', props: {} });
    else {
      const fi = out.findIndex((s) => s && s.section === 'footer');
      out.splice(fi >= 0 ? fi : out.length, 0, { section: 'blog', props: {} });
    }
  }
  if (!has('story')) {
    // Băng câu chuyện: trước footer (cuối trang nếu không có footer). Chưa cấu hình
    // → render rỗng, vô hại; có mặt sẵn để trang Giao diện ghi props vào.
    const fi = out.findIndex((s) => s && s.section === 'footer');
    out.splice(fi >= 0 ? fi : out.length, 0, { section: 'story', props: {} });
  }
  return out;
}

/** Render trang chủ theo layout của theme (hoặc mặc định). */
export function renderHome(ctx, { canonical = null, prevUrl = null, nextUrl = null } = {}) {
  const base = Array.isArray(ctx.theme?.layout) && ctx.theme.layout.length ? ctx.theme.layout : DEFAULT_LAYOUT;
  const layout = withHomeSections(base);
  const body = layout
    .map((s) => (SECTIONS[s.section] ? SECTIONS[s.section](s.props ?? {}, ctx) : ''))
    .join('\n');
  const head = metaHead({
    description: `${ctx.shop.name} — cửa hàng trực tuyến. Giao hàng toàn quốc, thanh toán COD hoặc chuyển khoản QR.`,
    canonical, prevUrl, nextUrl, ogTitle: ctx.shop.name, siteName: ctx.shop.name, ogImage: shopOgImage(ctx),
  });
  return page(ctx.shop.name, ctx.theme?.tokens, body, head, ctx.nonce);
}

/** Trang TẤT CẢ sản phẩm (/products): lưới đầy đủ — chip danh mục là NÚT LỌC tại chỗ
 *  (?cat=<slug>, chủ shop yêu cầu "lọc, không nhảy trang"), thanh sort/lọc căn giữa kiểu
 *  MAISON, pager giữ nguyên. Chip/sort/pager đều mang theo bộ lọc đang áp. */
export function renderProducts(ctx, { canonical = null, prevUrl = null, nextUrl = null, catSlug = null } = {}) {
  const pi = ctx.pageInfo;
  // Link chip: đổi danh mục = về trang 1 nhưng GIỮ sort + bộ lọc còn-hàng/giá.
  const chipHref = (cs) => {
    const parts = [];
    if (cs) parts.push(`cat=${encodeURIComponent(cs)}`);
    if (pi?.sort && pi.sort !== 'new') parts.push(`sort=${pi.sort}`);
    parts.push(...filterParts(pi));
    return `/products${parts.length ? `?${parts.join('&')}` : ''}`;
  };
  const chip = (cs, label) => {
    const on = (cs ?? null) === (catSlug ?? null);
    return `<a class="chip${on ? ' on' : ''}" href="${esc(chipHref(cs))}"${on ? ' aria-current="true"' : ''}>${esc(label)}</a>`;
  };
  const chips = ctx.categories.length
    ? `<div class="chips chips-center">${chip(null, 'Tất cả')}${ctx.categories.map((c) => chip(c.slug, c.name)).join('')}</div>`
    : '';
  // Form lọc phải GIỮ ?cat khi submit (GET về /products) — nhét hidden qua filterBar.
  const catHidden = catSlug ? `<input type="hidden" name="cat" value="${esc(catSlug)}">` : '';
  const cards = ctx.products.length ? productCards(ctx.products) : '<p class="empty">Chưa có sản phẩm nào trong mục này.</p>';
  const body = `${SECTIONS.header({}, ctx)}
    <main class="wrap section" id="san-pham">
      <div class="section-h products-h"><div class="section-h-l"><h1 class="products-title">Tất cả sản phẩm</h1>${pi ? `<p class="muted">${esc(String(pi.total))} sản phẩm</p>` : ''}</div></div>
      ${chips}
      <div class="products-toolbar">
        ${ctx.products.length || filterParts(pi).length ? sortBar(pi) : ''}
        ${filterBar(pi, '', catHidden)}
      </div>
      <div class="grid">${cards}</div>
      ${pager(pi)}
    </main>${SECTIONS.footer({}, ctx)}`;
  const head = metaHead({
    description: `Tất cả sản phẩm của ${ctx.shop.name} — giao hàng toàn quốc, thanh toán COD hoặc chuyển khoản QR.`,
    canonical, prevUrl, nextUrl, ogTitle: `Tất cả sản phẩm — ${ctx.shop.name}`, siteName: ctx.shop.name, ogImage: shopOgImage(ctx),
  });
  return page(`Tất cả sản phẩm — ${ctx.shop.name}`, ctx.theme?.tokens, body, head, ctx.nonce);
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

  // Flash sale (0082): giá HIỆU LỰC của biến thể đang chọn (microdata itemprop=price PHẢI là
  // giá bán thực cho Google Merchant). base = giá gốc để gạch ngang khi có sale.
  const base = selected ? selected.price_vnd : p.price_vnd;
  const saleNow = selected ? selected.sale_price_vnd : null;
  const price = saleNow != null ? saleNow : base;
  // Khung giờ flash sale — text TĨNH (không countdown JS, hợp CSP). ends_at giờ VN.
  const promoText = (saleNow != null && p.promo) ? `<div class="flash-sale" style="margin:8px 0;font-weight:600;color:#e11d48">⚡ Flash sale${p.promo.title ? ' · ' + esc(p.promo.title) : ''} — đến ${esc(new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).format(new Date(p.promo.ends_at)))}</div>` : '';
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
            <span itemprop="price" content="${esc(String(Number(price)))}">${money(price)}</span>${saleNow != null ? ` <s class="cmp">${money(base)}</s><span class="off">-${esc(selected.sale_off_pct)}%</span>` : compareHtml(price, selected?.compare_at_vnd)}
            <meta itemprop="priceCurrency" content="VND"><link itemprop="availability" href="${availability}">
          </div>
          ${promoText}
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
  return page(`${p.title} — ${ctx.shop.name}`, ctx.theme?.tokens, body, head, ctx.nonce);
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
      ${q ? filterBar(ctx.pageInfo, q) : ''}
      ${results}
    </main>${SECTIONS.footer({}, ctx)}`;
  const head = metaHead({
    description: q ? `Kết quả tìm kiếm cho "${q}" tại ${ctx.shop.name}` : `Tìm sản phẩm tại ${ctx.shop.name}`,
    canonical, ogTitle: q ? `Tìm "${q}"` : 'Tìm kiếm', siteName: ctx.shop.name, robots: 'noindex, follow',
  });
  return page(`${q ? `Tìm "${q}"` : 'Tìm kiếm'} — ${ctx.shop.name}`, ctx.theme?.tokens, body, head, ctx.nonce);
}

/** Blog: danh sách bài published (kèm ảnh bìa nếu có + phân trang ?page=). */
export function renderBlogList(ctx, posts, { canonical = null, prevUrl = null, nextUrl = null, blogPage = null } = {}) {
  const items = (posts ?? []).length
    ? posts.map((p) => `<article class="blog-card">
        ${p.cover ? `<a class="blog-thumb" href="/blog/${esc(p.slug)}"><img src="${esc(p.cover)}" alt="${esc(p.title)}" loading="lazy"></a>` : ''}
        <h2><a href="/blog/${esc(p.slug)}">${esc(p.title)}</a></h2>
        <div class="blog-date">${esc(fmtDate(p.published_at))}</div>
        ${p.excerpt ? `<p>${esc(p.excerpt)}</p>` : ''}
        <a class="blog-more" href="/blog/${esc(p.slug)}">Đọc tiếp →</a>
      </article>`).join('')
    : '<p class="empty">Chưa có bài viết nào.</p>';
  // Phân trang no-JS (12 bài/trang — server LIMIT/OFFSET). Trang 1 = URL sạch /blog.
  let pagerHtml = '';
  if (blogPage && blogPage.last > 1) {
    const link = (n) => esc(n > 1 ? `/blog?page=${n}` : '/blog');
    const prev = blogPage.page > 1 ? `<a class="pg-btn" href="${link(blogPage.page - 1)}">← Trước</a>` : '<span class="pg-btn off">← Trước</span>';
    const next = blogPage.page < blogPage.last ? `<a class="pg-btn" href="${link(blogPage.page + 1)}">Sau →</a>` : '<span class="pg-btn off">Sau →</span>';
    pagerHtml = `<nav class="pager">${prev}<span class="pg-info">Trang ${blogPage.page}/${blogPage.last}</span>${next}</nav>`;
  }
  const body = `${SECTIONS.header({}, ctx)}
    <main class="wrap section">
      <div class="section-h"><h2>Blog</h2></div>
      <div class="blog-list">${items}</div>
      ${pagerHtml}
    </main>${SECTIONS.footer({}, ctx)}`;
  const head = metaHead({ description: `Bài viết & tin tức từ ${ctx.shop.name}`, canonical, prevUrl, nextUrl, ogTitle: `Blog — ${ctx.shop.name}`, siteName: ctx.shop.name, ogImage: shopOgImage(ctx) });
  return page(`Blog — ${ctx.shop.name}`, ctx.theme?.tokens, body, head, ctx.nonce);
}

/** Blog: một bài. body TEXT → tách đoạn theo dòng trống, esc + <br> cho xuống dòng đơn.
 *  Ảnh TRONG BÀI: đoạn đứng riêng dạng [anh:<key-media>|mô tả] → <figure> (key phải
 *  đúng định dạng media của shop — mediaFigure re-check; sai → rơi về text thường). */
export function renderBlogPost(ctx, post, { canonical = null } = {}) {
  const IMG_LINE_RE = /^\[anh:([^\]|\s]+)(?:\|([^\]]*))?\]$/;
  const paras = String(post.body ?? '').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
    .map((para) => {
      const m = IMG_LINE_RE.exec(para);
      if (m) { const fig = mediaFigure(m[1], m[2] ?? '', ''); if (fig) return fig; }
      return `<p>${esc(para).replace(/\n/g, '<br>')}</p>`;
    }).join('');
  const coverHtml = post.cover ? `<figure class="blog-cover"><img src="${esc(post.cover)}" alt="${esc(post.title)}"></figure>` : '';
  const body = `${SECTIONS.header({}, ctx)}
    <main class="wrap content blog-post">
      <div class="crumb"><a href="/">Trang chủ</a> / <a href="/blog">Blog</a> / ${esc(post.title)}</div>
      <h1>${esc(post.title)}</h1>
      <div class="blog-date">${esc(fmtDate(post.published_at))}</div>
      ${coverHtml}
      ${paras || ''}
      <p style="margin-top:36px"><a class="btn btn-primary" href="/blog">← Về Blog</a></p>
    </main>${SECTIONS.footer({}, ctx)}`;
  const desc = post.excerpt ? String(post.excerpt) : String(post.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  // og:image: ƯU TIÊN ảnh bìa bài (URL tuyệt đối) → fallback ảnh cấp shop (logo/SP đầu).
  const abs = (u) => (u ? (/^https?:\/\//i.test(u) ? u : `${ctx.origin || ''}${u}`) : null);
  const ogImage = abs(post.cover) ?? shopOgImage(ctx);
  const head = metaHead({ description: desc, canonical, ogTitle: post.title, ogType: 'article', siteName: ctx.shop.name, ogImage });
  return page(`${post.title} — ${ctx.shop.name}`, ctx.theme?.tokens, body, head, ctx.nonce);
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
function metaHead({ description, canonical, ogTitle, ogType, siteName, robots, ogImage, prevUrl, nextUrl }) {
  const t = [];
  if (robots) t.push(`<meta name="robots" content="${esc(robots)}">`);
  if (description) t.push(`<meta name="description" content="${esc(description)}">`);
  if (canonical) t.push(`<link rel="canonical" href="${esc(canonical)}">`);
  // Phân trang (#28): báo trang kề cho crawler (canonical mỗi trang trỏ chính nó).
  if (prevUrl) t.push(`<link rel="prev" href="${esc(prevUrl)}">`);
  if (nextUrl) t.push(`<link rel="next" href="${esc(nextUrl)}">`);
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
  return page(title, ctx.theme?.tokens, body, head, ctx.nonce);
}

export function renderMaintenance(shopName) {
  return page('Tạm ngưng', {}, `<main class="center-msg"><h1>Cửa hàng tạm ngưng</h1>
    <p>${esc(shopName)} hiện không nhận đơn. Vui lòng quay lại sau.</p></main>`);
}
export function renderNotFound() {
  return page('Không tìm thấy', {}, `<main class="center-msg"><h1>Không tìm thấy trang</h1>
    <p>Trang bạn tìm không tồn tại.</p></main>`);
}
