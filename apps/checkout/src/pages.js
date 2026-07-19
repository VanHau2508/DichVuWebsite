/**
 * Trang HTML cho luồng mua (giỏ / checkout / kết quả đơn). SSR thuần, KHÔNG JS
 * (form + Post-Redirect-Get; QR tự làm mới bằng <meta refresh>). Mobile-first.
 * MỌI dữ liệu người dùng/shop đều esc() → chống XSS (trang checkout không dùng theme
 * của shop nên không có token động; chỉ tên shop + nội dung đơn, đều escape).
 */
import QRCode from 'qrcode';
import { PROVINCES } from './provinces.js';

const AMP = /&/g, LT = /</g, GT = />/g, QUOT = /"/g, APOS = /'/g;
export const esc = (s) => String(s ?? '').replace(AMP, '&amp;').replace(LT, '&lt;').replace(GT, '&gt;').replace(QUOT, '&quot;').replace(APOS, '&#39;');
const money = (v) => new Intl.NumberFormat('vi-VN').format(Number(v)) + '₫';

// Icon giỏ nội tuyến (đồng bộ với storefront; là markup nên hợp CSP).
const I_CART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="20" r="1"/><circle cx="17" cy="20" r="1"/><path d="M2 3h2l2.4 12.3a1 1 0 0 0 1 .8h8.7a1 1 0 0 0 1-.8L21 7H5.6"/></svg>';

/** SVG QR nội tuyến (không tải resource ngoài → hợp CSP). */
export async function qrSvg(text) {
  try { return await QRCode.toString(text, { type: 'svg', margin: 1, width: 220 }); }
  catch { return ''; }
}

const FONTFACE = `@font-face{font-family:'Be Vietnam Pro';font-style:normal;font-weight:400;font-display:swap;src:url(/fonts/bevietnampro-400-vietnamese.woff2) format('woff2');unicode-range:U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB}
@font-face{font-family:'Be Vietnam Pro';font-style:normal;font-weight:400;font-display:swap;src:url(/fonts/bevietnampro-400-latin-ext.woff2) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:'Be Vietnam Pro';font-style:normal;font-weight:400;font-display:swap;src:url(/fonts/bevietnampro-400-latin.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:'Be Vietnam Pro';font-style:normal;font-weight:600;font-display:swap;src:url(/fonts/bevietnampro-600-vietnamese.woff2) format('woff2');unicode-range:U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB}
@font-face{font-family:'Be Vietnam Pro';font-style:normal;font-weight:600;font-display:swap;src:url(/fonts/bevietnampro-600-latin-ext.woff2) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:'Be Vietnam Pro';font-style:normal;font-weight:600;font-display:swap;src:url(/fonts/bevietnampro-600-latin.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:'Be Vietnam Pro';font-style:normal;font-weight:800;font-display:swap;src:url(/fonts/bevietnampro-800-vietnamese.woff2) format('woff2');unicode-range:U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB}
@font-face{font-family:'Be Vietnam Pro';font-style:normal;font-weight:800;font-display:swap;src:url(/fonts/bevietnampro-800-latin-ext.woff2) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:'Be Vietnam Pro';font-style:normal;font-weight:800;font-display:swap;src:url(/fonts/bevietnampro-800-latin.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}`;
const STYLE = `${FONTFACE}
*{box-sizing:border-box}
:root{
  --bg:#ffffff;--surf:#f5f8fd;--card:#ffffff;--ink:#0d1526;--soft:#3f4d66;--mut:#59647a;--bd:#e6ebf3;
  --pri:#2463eb;--prid:#1b48c0;--pri2:#7c3aed;--brand:#2463eb;--brand2:#7c3aed;--brandd:#1b48c0;--wash:#eef4ff;--good:#0e9f6e;
  --warn:#c2410c;--warnbg:#fff7ed;--bad:#b91c1c;--badbg:#fef2f2;--goodbg:#ecfdf5;
  --r-sm:9px;--r:13px;--r-lg:18px;--r-xl:24px;--pill:999px;
  --sh-sm:0 1px 2px rgba(13,21,38,.06),0 1px 3px rgba(13,21,38,.05);
  --sh:0 6px 20px -8px rgba(13,21,38,.14);
  --sh-lg:0 24px 50px -24px rgba(13,21,38,.30);
  --sh-pri:0 14px 34px -14px color-mix(in srgb,var(--pri) 60%,transparent)}
@media(prefers-color-scheme:dark){:root{
  --bg:#0a0e1a;--surf:#131b2e;--card:#1b2440;--ink:#eef1f9;--soft:#c2cadd;--mut:#8a94ab;--bd:#28324c;
  --pri:#5b8cff;--prid:#7ba0ff;--pri2:#a78bfa;--wash:#161f38;--good:#34d399;
  --warn:#fb923c;--warnbg:#2a1c0f;--bad:#f87171;--badbg:#2a1414;--goodbg:#0f2a1e;
  --sh-sm:0 1px 2px rgba(0,0,0,.4);--sh:0 8px 24px -8px rgba(0,0,0,.5);--sh-lg:0 30px 60px -24px rgba(0,0,0,.65)}}
body{margin:0;font-family:'Be Vietnam Pro',system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--surf);line-height:1.6;-webkit-font-smoothing:antialiased;background-image:radial-gradient(120% 55% at 50% -8%,color-mix(in srgb,var(--pri) 9%,transparent),transparent 62%);background-attachment:fixed}
a{color:var(--pri);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:600px;margin:0 auto;padding:16px 20px}
@media(min-width:680px){.wrap{max-width:640px;padding:24px 20px}}
.hdr{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--card) 80%,transparent);backdrop-filter:saturate(180%) blur(12px);-webkit-backdrop-filter:saturate(180%) blur(12px);border-bottom:1px solid var(--bd)}
.hdr .wrap{display:flex;justify-content:space-between;align-items:center;min-height:58px;padding:8px 20px}
.brand{font-weight:800;font-size:1.14rem;letter-spacing:-.02em;background:linear-gradient(135deg,var(--brand),var(--pri2));-webkit-background-clip:text;background-clip:text;color:transparent}
.brand:hover{text-decoration:none}
.hnav{display:flex;align-items:center;gap:18px;font-size:.9rem}
.hnav a{color:var(--mut);font-weight:500;transition:color .15s}.hnav a:hover{color:var(--ink);text-decoration:none}
.hnav .cart{display:inline-flex;align-items:center;gap:6px;color:var(--ink);font-weight:600}.hnav .cart svg{width:18px;height:18px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:var(--r-lg);padding:18px 20px;margin:14px 0;box-shadow:var(--sh-sm)}
.card[style*="text-align:center"]{position:relative;overflow:hidden;background:linear-gradient(180deg,color-mix(in srgb,var(--pri) 8%,var(--card)),var(--card));border-color:color-mix(in srgb,var(--pri) 24%,var(--bd));box-shadow:var(--sh)}
.card[style*="text-align:center"]::before{content:"";position:absolute;inset:-40% 0 auto 0;height:150px;background:radial-gradient(60% 100% at 50% 0,color-mix(in srgb,var(--pri) 26%,transparent),transparent 70%);pointer-events:none}
.card[style*="text-align:center"] h1{position:relative;font-size:1.6rem;background:none;-webkit-text-fill-color:var(--ink);color:var(--ink);text-shadow:0 2px 20px color-mix(in srgb,var(--pri) 22%,transparent)}
.card[style*="text-align:center"] p{position:relative}
h1{font-size:1.5rem;font-weight:800;letter-spacing:-.02em;line-height:1.15;text-wrap:balance;margin:.2em 0 .55em;background:linear-gradient(135deg,var(--brand),var(--pri2));-webkit-background-clip:text;background-clip:text;color:transparent}
h2{font-size:1rem;margin:0 0 .7em;font-weight:700;letter-spacing:-.01em;color:var(--ink)}
.row{display:flex;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid color-mix(in srgb,var(--bd) 65%,transparent)}
.row:last-child{border-bottom:0}.muted{color:var(--mut);font-size:.9rem}.right{text-align:right}
.it{display:flex;gap:12px}.cthumb{width:56px;height:56px;object-fit:cover;border-radius:var(--r);border:1px solid var(--bd);flex:0 0 auto;background:var(--surf)}.cthumb.ph{border-style:dashed}
.tot{display:flex;justify-content:space-between;padding:7px 0;font-variant-numeric:tabular-nums}.tot .muted{font-size:.95rem}.tot.grand{font-weight:800;font-size:1.14rem;letter-spacing:-.01em;border-top:1px solid var(--bd);margin-top:8px;padding-top:12px}
.btn{display:block;width:100%;text-align:center;background:linear-gradient(135deg,var(--brand),var(--pri2));background-size:150% 150%;color:#fff;border:1.5px solid transparent;border-radius:var(--pill);padding:15px;font-size:1rem;font-weight:600;letter-spacing:-.01em;text-decoration:none;cursor:pointer;box-shadow:var(--sh-pri);transition:transform .1s,background-position .3s,box-shadow .15s}
.btn:hover{background-position:100% 0;text-decoration:none;transform:translateY(-2px);box-shadow:0 18px 40px -14px color-mix(in srgb,var(--pri) 65%,transparent)}.btn:active{transform:translateY(1px)}
.btn.alt{background:var(--card);color:var(--ink);border:1.5px solid color-mix(in srgb,var(--pri) 26%,var(--bd));box-shadow:var(--sh-sm)}
.btn.alt:hover{background:var(--card);border-color:var(--pri);color:var(--pri);opacity:1;transform:translateY(-2px)}
label{display:block;font-size:.88rem;margin:12px 0 5px;font-weight:600;color:var(--soft)}
input,textarea,select{width:100%;padding:11px 13px;border:1.5px solid var(--bd);border-radius:var(--r);font-size:1rem;font-family:inherit;color:var(--ink);background:var(--card);transition:border-color .15s,box-shadow .15s}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--pri);box-shadow:0 0 0 3px color-mix(in srgb,var(--pri) 20%,transparent)}
.qty{display:flex;gap:8px;align-items:center}.qty input{width:70px;text-align:center}
.qtybtn{width:auto;padding:9px 14px;border:1.5px solid var(--bd);background:var(--card);border-radius:var(--r);font-size:.9rem;font-weight:600;cursor:pointer;text-decoration:none;text-align:center;color:var(--ink);transition:border-color .15s,color .15s,background .15s}.qtybtn:hover{background:var(--wash);border-color:color-mix(in srgb,var(--pri) 30%,var(--bd))}
.pay label{display:flex;gap:10px;align-items:center;font-weight:500;padding:14px;border:1.5px solid var(--bd);border-radius:var(--r);margin:8px 0;cursor:pointer;background:var(--card);transition:border-color .15s,box-shadow .15s,background .15s}
.pay label:hover{border-color:color-mix(in srgb,var(--pri) 40%,var(--bd))}
.pay label:has(input:checked){border-color:var(--pri);background:var(--wash);box-shadow:0 0 0 3px color-mix(in srgb,var(--pri) 15%,transparent)}
.pay input{width:auto;accent-color:var(--pri)}
.hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}
.addr-pick{border:0;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
.addr-opt{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border:1.5px solid var(--bd);border-radius:var(--r);cursor:pointer;background:var(--card);transition:border-color .15s,background .15s;font-weight:500}
.addr-opt input{width:auto;accent-color:var(--pri);margin-top:3px}
.addr-opt:hover{border-color:color-mix(in srgb,var(--pri) 40%,var(--bd))}
.addr-opt:has(input:checked){border-color:var(--pri);background:var(--wash)}
.addr-newlbl{font-weight:600;color:var(--pri)}
#addr-new{position:absolute;opacity:0;pointer-events:none;width:1px;height:1px}
#addr-new:checked~.addr-newlbl{border-color:var(--pri);background:var(--wash)}
.addr-new{display:none;margin-top:2px}
#addr-new:checked~.addr-new{display:block}
.badge-def{display:inline-block;font-size:.7rem;background:var(--goodbg);color:var(--good);padding:1px 7px;border-radius:var(--pill);font-weight:600;vertical-align:middle}
@media(max-width:680px){.checkout-submit{position:sticky;bottom:0;z-index:15;margin:14px -20px 0;padding:12px 20px calc(12px + env(safe-area-inset-bottom));background:color-mix(in srgb,var(--card) 92%,transparent);backdrop-filter:saturate(180%) blur(10px);-webkit-backdrop-filter:saturate(180%) blur(10px);border-top:1px solid var(--bd)}}
.bank{background:var(--surf);border:1px solid var(--bd);border-radius:var(--r);padding:14px}.bank .row{border-color:var(--bd)}
.qrbox{text-align:center;margin:14px 0}.qrbox svg{max-width:220px;height:auto;border:1px solid var(--bd);border-radius:var(--r);padding:8px;background:#fff}
.badge{display:inline-flex;align-items:center;gap:5px;padding:5px 13px;border-radius:var(--pill);font-size:.82rem;font-weight:600;line-height:1.3}
.badge.wait{background:var(--warnbg);color:var(--warn)}.badge.paid{background:var(--goodbg);color:var(--good)}.badge.ok{background:var(--wash);color:var(--prid)}
.empty{text-align:center;padding:48px 24px;color:var(--mut)}
a:focus-visible,.btn:focus-visible,button:focus-visible,summary:focus-visible{outline:3px solid var(--pri);outline-offset:2px;border-radius:8px}
.pay input:focus-visible{outline:3px solid var(--pri);outline-offset:2px}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}html{scroll-behavior:auto}}`;

function page(title, shopName, bodyHtml, extraHead = '') {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title>${extraHead}<style>${STYLE}</style></head><body>
<header class="hdr"><div class="wrap"><a class="brand" href="/">${esc(shopName || 'Cửa hàng')}</a>
<nav class="hnav"><a href="/checkout/lookup">Tra cứu đơn</a><a href="/cart" class="cart">${I_CART}Giỏ hàng</a></nav></div></header>
<main class="wrap">${bodyHtml}</main></body></html>`;
}

// Mọi thao tác đổi giỏ là POST form (sameOrigin chỉ chặn được POST/PATCH, KHÔNG chặn
// GET → không dùng link GET để sửa, tránh CSRF qua <img>/prefetch).
const itemsBlock = (items) => items.map((it) => `
  <div class="row"><div class="it">
    ${it.image ? `<img class="cthumb" src="${esc(it.image)}" alt="" loading="lazy" width="52" height="52">` : '<div class="cthumb ph"></div>'}
    <div>
    <div>${esc(it.product_title)}${it.variant_title ? ` — <span class="muted">${esc(it.variant_title)}</span>` : ''}</div>
    <div class="muted">${it.orig_unit_price_vnd ? `<s>${money(it.orig_unit_price_vnd)}</s> <span style="color:#b91c1c;font-weight:600">${money(it.unit_price_vnd)}</span> <span style="color:#b91c1c">-${esc(it.sale_off_pct)}%</span>` : money(it.unit_price_vnd)} / sp</div>
    <form method="POST" action="/cart/update" class="qty" style="margin-top:6px">
      <input type="hidden" name="variant_id" value="${esc(it.variant_id)}">
      <input type="number" name="qty" value="${it.qty}" min="0" max="1000" inputmode="numeric" aria-label="Số lượng">
      <button class="qtybtn" type="submit" title="Cập nhật">Cập nhật</button>
    </form>
    <form method="POST" action="/cart/update" style="margin-top:4px">
      <input type="hidden" name="variant_id" value="${esc(it.variant_id)}"><input type="hidden" name="qty" value="0">
      <button class="qtybtn" type="submit" style="width:auto;color:#b91c1c">Xoá</button>
    </form>
  </div></div><div class="right"><strong>${money(it.line_total_vnd)}</strong></div></div>`).join('');

const totalsBlock = (s) => `
  <div class="tot"><span class="muted">Tạm tính</span><span>${money(s.subtotal_vnd)}</span></div>
  ${s.discount_vnd ? `<div class="tot"><span class="muted">Giảm giá${s.coupon_code ? ` (${esc(s.coupon_code)})` : ''}</span><span style="color:#0e9f6e">−${money(s.discount_vnd)}</span></div>` : ''}
  ${s.points_discount_vnd ? `<div class="tot"><span class="muted">Đổi ${esc(s.loyalty?.applied_points ?? '')} điểm</span><span style="color:#0e9f6e">−${money(s.points_discount_vnd)}</span></div>` : ''}
  ${s.ship_out_of_range
    ? `<div class="tot"><span class="muted">Phí giao hàng</span><span style="color:#b91c1c">Ngoài vùng giao</span></div>
       <div class="muted" style="font-size:.82rem;color:#b91c1c">Địa chỉ vượt bán kính giao của cửa hàng — chọn địa chỉ gần hơn hoặc liên hệ cửa hàng.</div>`
    : `<div class="tot"><span class="muted">Phí giao hàng</span><span>${money(s.shipping_vnd)}</span></div>
       ${s.fee_region_pending ? `<div class="muted" style="font-size:.82rem">Phí trên tính theo giao nội miền — có thể thêm phụ phí liên miền tuỳ tỉnh/thành nhận hàng (chốt ở bước Đặt hàng).</div>` : ''}`}
  <div class="tot grand"><span>Tổng cộng</span><span>${s.ship_out_of_range ? '—' : money(s.total_vnd)}</span></div>`;

// Ô nhập mã giảm giá trên trang giỏ (no-JS: POST /cart/coupon → PRG). Rỗng = gỡ mã.
const couponBlock = (s) => `<div class="card">
  ${s.coupon_code
    ? `<div class="tot"><span>Mã <strong>${esc(s.coupon_code)}</strong> — giảm ${money(s.discount_vnd)}</span>
        <form method="POST" action="/cart/coupon" style="margin:0"><input type="hidden" name="code" value=""><button class="qtybtn" type="submit" style="width:auto;color:#b91c1c">Gỡ</button></form></div>`
    : `<form method="POST" action="/cart/coupon" class="qty" style="margin:0">
        <input name="code" placeholder="Mã giảm giá" maxlength="40" aria-label="Mã giảm giá" style="text-transform:uppercase">
        <button class="qtybtn" type="submit" style="width:auto">Áp dụng</button>
      </form>`}
  ${s.coupon_error ? `<div class="muted" style="color:#b91c1c;margin-top:8px">${esc(s.coupon_error)}</div>` : ''}
</div>`;

// Widget ĐỔI ĐIỂM trên giỏ (no-JS: POST /cart/points → PRG). Chỉ hiện khi shop bật + khách đăng nhập.
const loyaltyBlock = (s) => {
  const L = s.loyalty; if (!L) return '';
  const val = L.per_point_vnd ? ` <span class="muted" style="font-weight:400">(~${money(L.balance * L.per_point_vnd)})</span>` : '';
  const body = L.applied_points > 0
    ? `<div class="tot"><span>Đang đổi <strong>${esc(L.applied_points)}</strong> điểm — giảm ${money(s.points_discount_vnd)}</span>
        <form method="POST" action="/cart/points" style="margin:0"><input type="hidden" name="points" value="0"><button class="qtybtn" type="submit" style="width:auto;color:#b91c1c">Gỡ</button></form></div>`
    : (L.max_points > 0
      ? `<form method="POST" action="/cart/points" class="qty" style="margin:0">
          <input name="points" type="number" min="0" max="${esc(L.max_points)}" placeholder="Đổi điểm (tối đa ${esc(L.max_points)})" inputmode="numeric" aria-label="Số điểm đổi">
          <button class="qtybtn" type="submit" style="width:auto">Đổi điểm</button>
        </form>`
      : '<div class="muted" style="font-size:.85rem">Chưa đủ điểm để đổi cho đơn này.</div>');
  return `<div class="card"><div style="font-weight:600;margin-bottom:8px">🎁 Bạn có ${esc(L.balance)} điểm${val}</div>${body}</div>`;
};

export function renderError(shopName, msg) {
  return page('Có lỗi', shopName, `<div class="card empty"><h1>Rất tiếc</h1><p>${esc(msg)}</p>
    <a class="btn alt" href="/cart">Quay lại giỏ hàng</a></div>`);
}

// Tra cứu đơn: khách nhập số đơn + mã tra cứu → GET /checkout/success (hiển thị đơn).
// Dùng GET (chỉ đọc) — không đổi trạng thái. err escape để chống XSS khi hiển thị lại.
export function renderLookup(shopName, err) {
  return page('Tra cứu đơn hàng', shopName, `<h1>Tra cứu đơn hàng</h1>
    ${err ? `<div class="card" style="border-color:#fca5a5;color:#b91c1c">${esc(err)}</div>` : ''}
    <form method="GET" action="/checkout/success"><div class="card">
      <label>Số đơn hàng</label><input name="number" inputmode="numeric" required placeholder="vd 12">
      <label>Mã tra cứu</label><input name="token" required placeholder="mã trong trang xác nhận / email">
    </div><button class="btn" type="submit">Tra cứu</button></form>
    <a class="btn alt" href="/" style="margin-top:8px">Về cửa hàng</a>`);
}

export function renderCart(shopName, s) {
  if (!s.items.length) {
    return page('Giỏ hàng', shopName, `<div class="card empty"><p>Giỏ hàng trống.</p><a class="btn alt" href="/">Tiếp tục mua sắm</a></div>`);
  }
  return page('Giỏ hàng', shopName, `<h1>Giỏ hàng</h1>
    <div class="card">${itemsBlock(s.items)}</div>
    ${couponBlock(s)}
    ${loyaltyBlock(s)}
    <div class="card">${totalsBlock(s)}</div>
    <a class="btn" href="/checkout">Thanh toán</a>
    <a class="btn alt" href="/" style="margin-top:8px">Tiếp tục mua sắm</a>`);
}

export function renderCheckout(shopName, s, idemToken, opts = {}) {
  const pf = opts.prefill ?? {};
  const addresses = opts.addresses ?? [];
  const v = (x) => esc(x ?? '');
  const pm = pf.payment_method === 'qr' ? 'qr' : 'cod';
  const ch = opts.challenge;
  const provinceOpts = (sel) => PROVINCES.map((p) => `<option value="${esc(p)}"${sel === p ? ' selected' : ''}>${esc(p)}</option>`).join('');
  const honeypot = `<input class="hp" type="text" name="company" tabindex="-1" autocomplete="off" aria-hidden="true">`;
  const emailField = `<label>Email (tuỳ chọn — nhận xác nhận đơn)</label><input name="email" type="email" autocomplete="email" value="${v(pf.email)}">`;

  // Khách ĐĂNG NHẬP + có địa chỉ đã lưu → CHỌN NHANH (radio no-JS). Chọn "địa chỉ khác" (:checked)
  // mở ô nhập tay. Địa chỉ đã lưu KHÔNG required (khách có thể chọn radio) — server validate.
  const hasSaved = pf.logged_in && addresses.length > 0;
  let recipient;
  if (hasSaved) {
    const chosen = (pf.address_choice === 'new' || addresses.some((a) => a.id === pf.address_choice)) ? pf.address_choice : addresses[0].id;
    const savedRadios = addresses.map((a) => {
      const line = [a.line1, a.ward, a.district, a.province].filter(Boolean).join(', ');
      return `<label class="addr-opt"><input type="radio" name="address_choice" value="${esc(a.id)}"${chosen === a.id ? ' checked' : ''}>
        <span><strong>${esc(a.recipient_name)}</strong> · ${esc(a.phone)}${a.is_default ? ' <span class="badge-def">Mặc định</span>' : ''}<br><span class="muted">${esc(line)}</span></span></label>`;
    }).join('');
    recipient = `<div class="card"><h2>Giao tới</h2>
      <fieldset class="addr-pick">
        ${savedRadios}
        <input type="radio" name="address_choice" value="new" id="addr-new"${chosen === 'new' ? ' checked' : ''}>
        <label for="addr-new" class="addr-opt addr-newlbl">+ Giao tới địa chỉ khác</label>
        <div class="addr-new">
          <label>Họ tên</label><input name="name" maxlength="120" autocomplete="name" value="${v(pf.name)}">
          <label>Số điện thoại</label><input name="phone" inputmode="tel" autocomplete="tel" placeholder="09xxxxxxxx" value="${v(pf.phone)}">
          <label>Địa chỉ giao hàng</label><textarea name="address_line" rows="2" maxlength="300" autocomplete="street-address" placeholder="Số nhà, đường, phường/xã, quận/huyện">${v(pf.address_line)}</textarea>
          <label>Tỉnh / Thành phố</label><select name="province" autocomplete="address-level1"><option value="">— Chọn tỉnh/thành —</option>${provinceOpts(pf.province)}</select>
        </div>
      </fieldset>
      ${emailField}
      ${honeypot}</div>`;
  } else {
    recipient = `<div class="card"><h2>Người nhận</h2>
      <label>Họ tên *</label><input name="name" required maxlength="120" autocomplete="name" value="${v(pf.name)}">
      <label>Số điện thoại *</label><input name="phone" required inputmode="tel" autocomplete="tel" placeholder="09xxxxxxxx" value="${v(pf.phone)}">
      ${emailField}
      <label>Địa chỉ giao hàng *</label><textarea name="address_line" required rows="2" maxlength="300" autocomplete="street-address" placeholder="Số nhà, đường, phường/xã, quận/huyện">${v(pf.address_line)}</textarea>
      <label>Tỉnh / Thành phố *</label><select name="province" required autocomplete="address-level1">
        <option value="" disabled${pf.province ? '' : ' selected'}>— Chọn tỉnh/thành —</option>${provinceOpts(pf.province)}</select>
      ${honeypot}</div>`;
  }

  return page('Thanh toán', shopName, `<h1>Thanh toán</h1>
    ${opts.error ? `<div class="card" style="border-color:#fca5a5;background:#fef2f2;color:#b91c1c"><strong>${esc(opts.error)}</strong></div>` : ''}
    <div class="card"><h2>Đơn hàng</h2>
      ${s.items.map((it) => `<div class="tot"><span class="muted">${esc(it.product_title)} × ${it.qty}</span><span>${money(it.line_total_vnd)}</span></div>`).join('')}
      ${totalsBlock(s)}</div>
    <form method="POST" action="/checkout/place">
      <input type="hidden" name="idempotency_key" value="${esc(idemToken)}">
      <input type="hidden" name="ct" value="${esc(opts.formTs ?? '')}">
      <input type="hidden" name="ship_seen" value="${s.ship_out_of_range ? '' : Number(s.shipping_vnd)}">
      <input type="hidden" name="subtotal_seen" value="${Number(s.subtotal_vnd)}">
      <input type="hidden" name="lat" value="${v(pf.lat)}">
      <input type="hidden" name="lng" value="${v(pf.lng)}">
      ${recipient}
      <div class="card pay"><h2>Thanh toán</h2>
        <label><input type="radio" name="payment_method" value="cod"${pm === 'cod' ? ' checked' : ''}> Thanh toán khi nhận hàng (COD)</label>
        <label><input type="radio" name="payment_method" value="qr"${pm === 'qr' ? ' checked' : ''}> Chuyển khoản QR (VietQR)</label>
      </div>
      ${ch ? `<div class="card" style="border-color:#fcd34d;background:#fffbeb"><h2>Xác minh</h2>
        <p class="muted">Để chống đặt hàng tự động, vui lòng trả lời: <strong>${esc(ch.a)} + ${esc(ch.b)} = ?</strong></p>
        <input type="hidden" name="challenge_sig" value="${esc(ch.sig)}">
        <input name="challenge_answer" required inputmode="numeric" maxlength="4" style="max-width:120px" placeholder="Kết quả">
      </div>` : ''}
      <div class="checkout-submit"><button class="btn" type="submit">Đặt hàng · ${money(s.total_vnd)}</button></div>
    </form>
    <a class="btn alt" href="/cart" style="margin-top:8px">Quay lại giỏ</a>`);
}

export function renderOrder(shopName, o, pay, qr, justPlaced = false) {
  const paid = o.payment_status === 'paid';
  const statusVi = { pending: 'Chờ xử lý', confirmed: 'Đã xác nhận', shipped: 'Đang giao', delivered: 'Đã giao', cancelled: 'Đã huỷ' }[o.status] ?? o.status;
  const head = (o.payment_method === 'qr' && !paid && o.status !== 'cancelled') ? '<meta http-equiv="refresh" content="8">' : '';
  let payBlock = '';
  if (o.payment_method === 'qr' && o.status !== 'cancelled') {
    payBlock = paid
      ? `<div class="card"><span class="badge paid">Đã thanh toán ✓</span></div>`
      : o.pay_config_changed
      ? `<div class="card" style="border-color:#fcd34d;background:var(--warnbg,#fffbeb)"><h2>Thanh toán tạm gián đoạn</h2>
          <p class="muted">Cửa hàng vừa thay đổi thông tin nhận thanh toán nên mã QR của đơn này không còn hiệu lực.
          Vui lòng <strong>liên hệ cửa hàng</strong> để hoàn tất thanh toán — đừng chuyển tiền theo thông tin cũ.</p></div>`
      : `<div class="card"><h2>Chuyển khoản QR</h2>
          <p class="muted">Quét mã trong app ngân hàng, hoặc chuyển thủ công đúng nội dung. Trang tự cập nhật khi nhận được tiền.</p>
          ${qr ? `<div class="qrbox">${qr}</div>` : ''}
          <div class="bank">
            <div class="row"><span class="muted">Ngân hàng</span><span>${esc(pay?.bank_name || pay?.bank_bin || '—')}</span></div>
            <div class="row"><span class="muted">Số tài khoản</span><span><strong>${esc(pay?.account_number || '—')}</strong></span></div>
            <div class="row"><span class="muted">Chủ tài khoản</span><span>${esc(pay?.account_name || '—')}</span></div>
            <div class="row"><span class="muted">Số tiền</span><span><strong>${money(o.total_vnd)}</strong></span></div>
            <div class="row"><span class="muted">Nội dung</span><span><strong>${esc(o.payment_ref || '')}</strong></span></div>
          </div>
          <p class="muted" style="margin-top:8px"><span class="badge wait">Đang chờ thanh toán…</span></p></div>`;
  } else if (o.payment_method === 'cod') {
    payBlock = `<div class="card"><span class="badge ok">Thanh toán khi nhận hàng (COD)</span></div>`;
  }
  return page(`Đơn #${o.order_number}`, shopName, `
    <div class="card" style="text-align:center">
      <h1>${justPlaced ? 'Đặt hàng thành công 🎉' : `Đơn hàng #${o.order_number}`}</h1>
      <p>Đơn <strong>#${o.order_number}</strong> · <span class="badge ok">${esc(statusVi)}</span></p></div>
    ${payBlock}
    <div class="card"><h2>Chi tiết đơn</h2>
      ${o.lines.map((l) => `<div class="tot"><span class="muted">${esc(l.title_snapshot)} × ${l.qty}${l.orig_unit_price_vnd ? ` <span style="color:#b91c1c">(KM, tiết kiệm ${money((Number(l.orig_unit_price_vnd) - Number(l.unit_price_vnd)) * l.qty)})</span>` : ''}</span><span>${money(Number(l.unit_price_vnd) * l.qty)}</span></div>`).join('')}
      <div class="tot"><span class="muted">Phí giao hàng</span><span>${money(o.shipping_vnd)}</span></div>
      <div class="tot grand"><span>Tổng cộng</span><span>${money(o.total_vnd)}</span></div>
      <p class="muted" style="margin-top:8px">Giao tới: ${esc(o.customer_name)}</p>
      ${justPlaced ? '<p class="muted">Lưu lại đường link/số đơn + mã này để tra cứu sau.</p>' : ''}</div>
    <a class="btn alt" href="/checkout/lookup">Tra cứu đơn khác</a>
    <a class="btn alt" href="/" style="margin-top:8px">Tiếp tục mua sắm</a>`, head);
}
