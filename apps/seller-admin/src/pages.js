/**
 * Trang HTML admin (SSR form thuần, không JS). MỌI dữ liệu đều esc() → chống XSS.
 * CSP không cho script; thao tác nhạy cảm/đổi trạng thái đều là POST form + sameOrigin.
 */
import { esc } from './http.js';
import { PROVINCES } from './provinces.js';
import { presetChoices, getPreset } from '../presets.js';
import {
  CATALOG_ROLES, ORDER_ROLES, CONTENT_ROLES, REFUND_ROLES, PAYMENT_ROLES, INVENTORY_ROLES,
} from './roles.js';

// Trang ĐĂNG KÝ nằm ở site công khai (nentang.vn/signup) chứ KHÔNG phải trên admin — Caddy
// định tuyến `/signup*` sang service `signup`, còn admin ở tên miền khác. Nên link "chưa có
// cửa hàng?" bắt buộc là URL TUYỆT ĐỐI; để tương đối là ra 404 ngay trên admin.
// Mặc định là tên miền thật (đúng cho prod kể cả khi quên khai biến); dev đặt lại bằng
// PUBLIC_SITE_URL trong compose để bấm thử được qua Caddy cổng 8443.
export const SIGNUP_LINK = `${String(process.env.PUBLIC_SITE_URL ?? 'https://nentang.vn').replace(/\/+$/, '')}/signup`;
// Tên miền nền tảng để in "<slug>.nentang.vn" trong wizard. Lấy HOST (kèm cổng) từ chính
// PUBLIC_SITE_URL ở trên: dev chạy sau Caddy cổng 8443 nên in "nentang.vn" trần là đưa chủ
// shop một địa chỉ không mở được. URL hỏng → về mặc định thay vì ném lúc nạp module.
export const PLATFORM_DOMAIN = (() => {
  try { return new URL(process.env.PUBLIC_SITE_URL ?? 'https://nentang.vn').host; }
  catch { return 'nentang.vn'; }
})();

const money = (v) => new Intl.NumberFormat('vi-VN').format(Number(v)) + '₫';
// GIỜ VIỆT NAM, KHÔNG phải giờ của máy chủ. Thiếu `timeZone` thì Intl lấy múi giờ tiến trình —
// container chạy UTC — nên màn hình in sớm hơn 7 tiếng và 54/395 đơn của một shop thật hiện SAI
// NGÀY (đơn 05:17 sáng 01/08 hiện thành "22:17 31/07"). Đau nhất là nó CÃI NHAU VỚI CHÍNH TRANG
// ĐÓ: bộ lọc khoảng ngày đã tính theo giờ VN từ docs/60, nên lọc "ngày 01/08" trả về một đống
// đơn đề ngày 31/07 và người bán tưởng bộ lọc hỏng. Phiếu in giao cho người đóng gói cũng sai.
//
// Hai hàm `dt` cục bộ khác trong file này (trang Nhập hàng, trang Kiểm kê) đã truyền timeZone từ
// đầu — tức luật ĐÚNG đã có sẵn, chỉ bản dùng nhiều nhất là trôi. Bộ apps/seller-admin/test/
// date-tz.test.js canh mọi hàm định dạng ngày trong service này đều nêu múi giờ.
const dt = (s) => { try { return new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(s)); } catch { return esc(s); } };
const STATUS = { pending: 'Chờ xử lý', confirmed: 'Đã xác nhận', shipped: 'Đang giao', delivered: 'Đã giao', cancelled: 'Đã huỷ', refunded: 'Đã hoàn', returned: 'Hoàn hàng' };
const PAY = { unpaid: 'Chưa trả', pending: 'Đã trả một phần', paid: 'Đã trả', refunded: 'Đã hoàn' };
const PAYMENT_DISPLAY = {
  unpaid: ['unpaid', 'Chưa thu'], partial: ['pending', 'Thu một phần'], paid: ['paid', 'Đã thu đủ'],
  overpaid: ['returned', 'Khách chuyển dư'], refund_due: ['returned', 'Cần hoàn khách'], refunded: ['refunded', 'Đã hoàn'],
};
const EVENT_LABEL = {
  'order.created': 'Đơn được tạo', 'order.confirmed': 'Đã xác nhận đơn', 'order.cancelled': 'Đã huỷ đơn',
  'order.reopened': 'Đã mở lại đơn', 'payment.received': 'Đã ghi nhận khoản thu',
  'payment.reversed': 'Đã điều chỉnh khoản thu', 'payment.refunded': 'Đã hoàn tiền',
  'shipment.created': 'Đã tạo vận đơn', 'shipment.in_transit': 'Kiện hàng đang vận chuyển',
  'shipment.delivered': 'Kiện hàng đã giao', 'shipment.returned': 'Kiện hàng hoàn về',
  'shipment.cancelled': 'Vận đơn bị hãng huỷ',
  'return.requested': 'Khách yêu cầu trả hàng', 'return.received': 'Shop đã nhận hàng trả',
  'return.completed': 'Đã hoàn tất trả hàng', 'notification.sent': 'Thông báo đã gửi',
  'notification.failed': 'Gửi thông báo thất bại', 'resolution.opened': 'Mở ca cần xử lý',
  'resolution.completed': 'Đã chốt ca xử lý',
};
const SHIP_ST = { created: 'Đang tạo', in_transit: 'Đang vận chuyển', delivered: 'Đã giao', returned: 'Hoàn hàng', cancelled: 'Đã huỷ' };
// Vì sao đơn này còn nợ — mã do API trả (owed.js), câu chữ ở đây. Ba lý do dẫn tới ba cách xử
// lý khác nhau, nên nói ra lý do đắt hơn nhiều so với chỉ ném ra con số.
const OWED_WHY = {
  huy_da_thu: 'đơn đã huỷ nhưng khách đã thanh toán',
  hoan_ve_chua_tra: 'hàng đã về shop nhưng chưa hoàn tiền cho khách',
  thu_thua: 'đã thu nhiều hơn giá trị đơn (đơn bị sửa giảm)',
};

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
:root{--bg:#ffffff;--surf:#f5f6f7;--surface:#f5f6f7;--card:#ffffff;--ink0:#000000;--ink:#161823;--soft:#161823;--mut:#6b6f76;--faint:#9ea1a8;--bd:#e4e6e8;--bd2:#d0d3d6;--row:#f0f1f2;--navon:#f0f3f3;--fielddk:#2a2b32;--pri:#0fa3a3;--prid:#0b8585;--prip:#087272;--pri2:#0fa3a3;--brand:#0fa3a3;--brand2:#0fa3a3;--brandd:#0b8585;--wash:#e8f6f6;--washh:#d6efef;--good:#00b578;--goodbg:#e8f8f2;--warn:#ff8f1f;--warnbg:#fff7e8;--bad:#e8302f;--badbg:#fff1f0;--indigo:#1668dc;--indigobg:#f0f3f3;--cyan:#25f4ee;--magenta:#fe2c55;--sky:#7dd8f5;--pbtn:#0fa3a3;--pbtn-h:#0b8585;--pbtn-ink:#ffffff;--sh-sm:0 1px 2px rgba(0,0,0,.04);--sh:0 4px 12px rgba(0,0,0,.08);--sh-lg:0 8px 32px rgba(0,0,0,.12);--sh-pri:none;--r-xs:4px;--r-sm:8px;--r:8px;--r-lg:12px;--r-xl:12px;--pill:999px;--sp-1:4px;--sp-2:8px;--sp-3:12px;--sp-4:16px;--sp-5:20px;--sp-6:24px;--sp-7:32px;--sp-8:40px}
@media(prefers-color-scheme:dark){:root{--bg:#12141a;--surf:#0c0e13;--surface:#0c0e13;--card:#171a21;--ink0:#000000;--ink:#e8eaee;--soft:#e8eaee;--mut:#a2a7b1;--faint:#7b818c;--bd:#2a2e37;--bd2:#3b404b;--row:#23272f;--navon:#17262a;--fielddk:#2a2b32;--pri:#2fd4d4;--prid:#5fe3e3;--prip:#20b7b7;--pri2:#2fd4d4;--brand:#2fd4d4;--brand2:#2fd4d4;--brandd:#5fe3e3;--wash:#11282a;--washh:#173538;--good:#2fd69a;--goodbg:#0e2b22;--warn:#ffa64d;--warnbg:#2e2210;--bad:#ff6b6a;--badbg:#2e1616;--indigo:#7db2ff;--indigobg:#1b2430;--cyan:#25f4ee;--magenta:#fe2c55;--sky:#7dd8f5;--pbtn:#0fa3a3;--pbtn-h:#0b8585;--pbtn-ink:#ffffff;--sh-sm:0 1px 2px rgba(0,0,0,.4);--sh:0 4px 12px rgba(0,0,0,.5);--sh-lg:0 8px 32px rgba(0,0,0,.6);--sh-pri:none}}
:root[data-theme=dark]{--bg:#12141a;--surf:#0c0e13;--surface:#0c0e13;--card:#171a21;--ink0:#000000;--ink:#e8eaee;--soft:#e8eaee;--mut:#a2a7b1;--faint:#7b818c;--bd:#2a2e37;--bd2:#3b404b;--row:#23272f;--navon:#17262a;--fielddk:#2a2b32;--pri:#2fd4d4;--prid:#5fe3e3;--prip:#20b7b7;--pri2:#2fd4d4;--brand:#2fd4d4;--brand2:#2fd4d4;--brandd:#5fe3e3;--wash:#11282a;--washh:#173538;--good:#2fd69a;--goodbg:#0e2b22;--warn:#ffa64d;--warnbg:#2e2210;--bad:#ff6b6a;--badbg:#2e1616;--indigo:#7db2ff;--indigobg:#1b2430;--pbtn:#0fa3a3;--pbtn-h:#0b8585;--pbtn-ink:#ffffff;--sh-sm:0 1px 2px rgba(0,0,0,.4);--sh:0 4px 12px rgba(0,0,0,.5);--sh-lg:0 8px 32px rgba(0,0,0,.6);--sh-pri:none}
:root[data-theme=light]{--bg:#ffffff;--surf:#f5f6f7;--surface:#f5f6f7;--card:#ffffff;--ink0:#000000;--ink:#161823;--soft:#161823;--mut:#6b6f76;--faint:#9ea1a8;--bd:#e4e6e8;--bd2:#d0d3d6;--row:#f0f1f2;--navon:#f0f3f3;--fielddk:#2a2b32;--pri:#0fa3a3;--prid:#0b8585;--prip:#087272;--pri2:#0fa3a3;--brand:#0fa3a3;--brand2:#0fa3a3;--brandd:#0b8585;--wash:#e8f6f6;--washh:#d6efef;--good:#00b578;--goodbg:#e8f8f2;--warn:#ff8f1f;--warnbg:#fff7e8;--bad:#e8302f;--badbg:#fff1f0;--indigo:#1668dc;--indigobg:#f0f3f3;--pbtn:#0fa3a3;--pbtn-h:#0b8585;--pbtn-ink:#ffffff;--sh-sm:0 1px 2px rgba(0,0,0,.04);--sh:0 4px 12px rgba(0,0,0,.08);--sh-lg:0 8px 32px rgba(0,0,0,.12);--sh-pri:none}
*{box-sizing:border-box}html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}body{margin:0;font-family:'Be Vietnam Pro',system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--surf);font-size:14px;line-height:1.45;letter-spacing:0;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
::selection{background:color-mix(in srgb,var(--pri) 24%,transparent)}
a{color:var(--pri);text-decoration:none;transition:color .15s}a:hover{color:var(--prid);text-decoration:underline;text-underline-offset:2px}
/* line-height KHÔNG ĐƠN VỊ, không phải px. Chữ Việt có dấu CHỒNG (ị, ệ, ộ, ẩ) nên cần
   ~1,35 lần cỡ chữ; dưới ngưỡng đó tiêu đề xuống 2 dòng là dấu nặng dòng trên đâm vào dấu
   mũ dòng dưới. Dùng px thì mọi luật ghi đè CỠ CHỮ (.center h1 24px, .dash-hero h1 27,2px)
   vẫn kế thừa line-height cũ ⇒ tỉ lệ tụt còn 1,25 và 1,10. Đo ở trình duyệt thật: hai dòng
   ĐỤNG NHAU 1px. Không đơn vị thì tỉ lệ tự đúng ở mọi chỗ ghi đè. */
h1{font-size:28px;font-weight:700;letter-spacing:0;line-height:1.35;text-wrap:balance;margin:0 0 12px}
h2{font-size:20px;margin:0 0 12px;font-weight:600;letter-spacing:0;line-height:1.4;text-wrap:balance}
h3{font-size:16px;font-weight:600;margin:0 0 8px;letter-spacing:0;line-height:1.5}
@media(max-width:767px){h1{font-size:22px}}
/* Bộ lọc đơn: máy tính LUÔN mở (đủ chỗ, mở/gập chỉ tổ phiền); điện thoại gập mặc định. */
.filt-sum{cursor:pointer;font-weight:600;list-style:none}
.filt-sum::-webkit-details-marker{display:none}
.filt-sum::before{content:"▸ ";color:var(--soft)}
details[open]>.filt-sum::before{content:"▾ "}
@media(min-width:768px){
  .filt-wrap>.filt-sum{display:none}
  .filt-wrap{display:block}
  .filt-wrap>.filters{display:flex}
}
.authwrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:radial-gradient(52% 42% at 12% 6%,color-mix(in srgb,var(--brand) 11%,transparent),transparent 64%),radial-gradient(46% 40% at 90% 16%,color-mix(in srgb,var(--brand2) 11%,transparent),transparent 62%),var(--surf)}
/* ══ CỬA VÀO (đăng nhập · quên/đặt lại mật khẩu · MFA) — hai panel ══
   Bản trước là một thẻ nhỏ giữa màn hình trống: đúng chức năng nhưng không nói gì về sản
   phẩm, và trên desktop 1440px thì 90% màn hình là nền rỗng. Panel trái dùng ĐEN + teal
   đúng ngôn ngữ docs/44 mà người bán sẽ thấy ngay sau khi đăng nhập — cửa vào phải báo
   trước diện mạo bên trong, không phải một trang lạc loài.
   Không JS: mọi thứ là form + CSS. */
.au{min-height:100vh;display:grid;grid-template-columns:1.05fr .95fr}
.au-l{background:var(--ink0);color:#fff;padding:48px 52px;display:flex;flex-direction:column;position:relative;overflow:hidden}
/* Hai hình thoi cyan/magenta của docs/44 §1: CHỈ trang trí, không bao giờ là điều khiển. */
.au-l::before,.au-l::after{content:"";position:absolute;width:340px;height:340px;transform:rotate(45deg);border-radius:64px;opacity:.13;pointer-events:none}
.au-l::before{background:#25F4EE;right:-150px;top:-90px}
.au-l::after{background:#FE2C55;right:-60px;bottom:-190px}
.au-brand{display:inline-flex;align-items:center;gap:11px;font-weight:800;font-size:1.12rem;letter-spacing:-.02em;color:#fff;text-decoration:none;position:relative;z-index:1}
.au-brand i{width:34px;height:34px;border-radius:9px;background:var(--pri);display:grid;place-items:center;font-style:normal;font-weight:800;color:#fff;flex:none}
.au-mid{margin-top:auto;margin-bottom:auto;padding:40px 0;position:relative;z-index:1}
.au-mid h2{font-size:clamp(1.7rem,2.6vw,2.4rem);font-weight:800;line-height:1.16;letter-spacing:-.03em;color:#fff;margin:0 0 16px;max-width:15ch}
.au-mid h2 em{font-style:normal;color:var(--pri)}
.au-mid p{color:#A7B0B8;font-size:1rem;line-height:1.6;margin:0 0 26px;max-width:42ch}
.au-pts{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:13px}
.au-pts li{display:grid;grid-template-columns:auto 1fr;gap:12px;align-items:start;color:#DCE3E8;font-size:.95rem;line-height:1.5}
.au-pts svg{width:19px;height:19px;color:var(--pri);margin-top:2px;flex:none}
.au-foot{position:relative;z-index:1;color:#7C868F;font-size:.84rem;border-top:1px solid #23262B;padding-top:18px}
.au-r{background:var(--card);display:flex;align-items:center;justify-content:center;padding:40px 32px;overflow-y:auto}
.au-box{width:100%;max-width:400px}
.au-box h1{font-size:1.62rem;font-weight:800;letter-spacing:-.025em;color:var(--ink);margin:0 0 7px}
.au-box .au-sub{color:var(--mut);font-size:.94rem;line-height:1.55;margin:0 0 26px}
.au-box label{display:block;font-size:.88rem;font-weight:600;color:var(--ink);margin:0 0 6px}
.au-box label .rq{color:#E8302F}
.au-box input{width:100%;min-height:46px;padding:12px 14px;font:inherit;font-size:.97rem;color:var(--ink);background:var(--card);border:1.5px solid var(--bd);border-radius:9px;margin:0 0 16px}
.au-box input:focus{outline:none;border-color:var(--pri);box-shadow:0 0 0 3px var(--wash)}
.au-box input:focus-visible{outline:2px solid var(--pri);outline-offset:1px}
.au-hint{font-size:.82rem;color:var(--mut);margin:-10px 0 16px}
.au-btn{width:100%;min-height:48px;display:inline-flex;align-items:center;justify-content:center;gap:8px;font:inherit;font-size:1rem;font-weight:700;color:#fff;background:var(--pri);border:0;border-radius:9px;cursor:pointer;text-decoration:none;transition:background .16s ease}
.au-btn:hover{background:var(--prid)}
.au-btn:active{background:var(--prip)}
.au-btn.alt{background:var(--card);color:var(--ink);border:1.5px solid var(--bd)}
.au-btn.alt:hover{background:var(--surf);border-color:var(--bd2)}
.au-right{text-align:right;margin:-6px 0 18px}
.au-right a{font-size:.88rem;font-weight:600;color:var(--pri);text-decoration:none}
.au-right a:hover{text-decoration:underline}
.au-alt{display:flex;align-items:center;gap:14px;margin:22px 0;color:var(--faint);font-size:.84rem}
.au-alt::before,.au-alt::after{content:"";flex:1;height:1px;background:var(--bd)}
.au-end{text-align:center;margin:22px 0 0;font-size:.9rem;color:var(--mut)}
.au-end a{color:var(--pri);font-weight:700;text-decoration:none}
.au-end a:hover{text-decoration:underline}
.au-back{display:block;text-align:center;margin-top:26px;font-size:.86rem;color:var(--mut);text-decoration:none}
.au-back:hover{color:var(--pri)}
.au-ok{width:52px;height:52px;border-radius:14px;background:var(--wash);color:var(--pri);display:grid;place-items:center;margin-bottom:18px}
.au-ok svg{width:26px;height:26px}
@media(max-width:900px){
  .au{grid-template-columns:1fr;min-height:auto}
  .au-l{padding:28px 24px 30px}
  .au-l::before,.au-l::after{display:none}
  .au-mid{margin:0;padding:22px 0 0}
  .au-mid h2{font-size:1.5rem;max-width:none}
  .au-mid p{margin-bottom:18px}
  .au-pts{gap:10px}
  .au-foot{display:none}
  .au-r{padding:32px 24px 48px}
}
/* Wizard "Thiết lập nhanh" — dùng lại đúng bộ token của .au*, KHÔNG sinh màu mới.
   Radio ở bước Giao diện cố ý ĐỂ HIỆN (không ẩn rồi tô viền bằng :has()): trình duyệt
   không có :has() thì người dùng mất hoàn toàn dấu hiệu "tôi đang chọn cái nào" —
   viền sáng chỉ là phần thưởng thêm, không phải thứ duy nhất báo trạng thái chọn. */
.wiz{min-height:100vh;background:var(--surf);padding:30px 20px 56px}
.wiz-top,.wiz-rail,.wiz-card{max-width:760px;margin-left:auto;margin-right:auto}
.wiz-top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px}
.wiz-brand{display:inline-flex;align-items:center;gap:10px;font-weight:800;font-size:1.05rem;letter-spacing:-.02em;color:var(--ink);text-decoration:none}
.wiz-brand i{width:30px;height:30px;border-radius:8px;background:var(--pri);display:grid;place-items:center;font-style:normal;font-weight:800;color:#fff;flex:none;font-size:.95rem}
.wiz-skip{min-height:44px;display:inline-flex;align-items:center;font-size:.88rem;font-weight:600;color:var(--mut);text-decoration:none}
.wiz-skip:hover{color:var(--pri)}
.wiz-rail{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:20px}
.wiz-step{display:grid;grid-template-columns:auto 1fr;gap:11px;align-items:center;padding-bottom:12px;border-bottom:3px solid var(--bd)}
.wiz-step.on{border-bottom-color:var(--pri)}
.wiz-step.dn{border-bottom-color:var(--good)}
.wiz-step b{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-size:.92rem;font-weight:700;background:var(--bd);color:var(--mut)}
.wiz-step.on b{background:var(--pri);color:#fff}
.wiz-step.dn b{background:var(--good);color:#fff}
.wiz-step span{font-size:.93rem;font-weight:600;color:var(--mut);line-height:1.3}
.wiz-step.on span,.wiz-step.dn span{color:var(--ink)}
.wiz-card{background:var(--card);border:1px solid var(--bd);border-radius:var(--r-xl);padding:32px 32px 28px;box-shadow:var(--sh-lg)}
.wiz-card h1{font-size:1.5rem;font-weight:800;letter-spacing:-.025em;color:var(--ink);margin:0 0 7px}
.wiz-sub{color:var(--mut);font-size:.94rem;line-height:1.55;margin:0 0 24px}
.wiz-card label{display:block;font-size:.88rem;font-weight:600;color:var(--ink);margin:0 0 6px}
.wiz-card label .rq{color:var(--bad)}
.wiz-card input,.wiz-card textarea{width:100%;min-height:46px;padding:12px 14px;font:inherit;font-size:.97rem;color:var(--ink);background:var(--card);border:1.5px solid var(--bd);border-radius:9px;margin:0 0 6px}
.wiz-card textarea{min-height:80px;resize:vertical;line-height:1.5}
.wiz-card input:focus,.wiz-card textarea:focus{outline:none;border-color:var(--pri);box-shadow:0 0 0 3px var(--wash)}
.wiz-hint{font-size:.82rem;color:var(--mut);margin:0 0 18px;line-height:1.5}
.wiz-err{border:1px solid var(--bad);background:var(--badbg);color:var(--bad);border-radius:9px;padding:11px 14px;font-size:.9rem;margin:0 0 18px}
.wiz-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:12px;margin:0 0 22px}
.wiz-pick{display:block;border:1.5px solid var(--bd);border-radius:12px;background:var(--card);overflow:hidden;cursor:pointer}
.wiz-pick:hover{border-color:var(--bd2)}
.wiz-pick:has(input:checked){border-color:var(--pri);box-shadow:0 0 0 3px var(--wash)}
.wiz-sw{display:flex;height:50px}
.wiz-sw i{flex:1}
.wiz-pt{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start;padding:12px 14px 14px}
.wiz-pt input{width:auto;min-height:0;margin:3px 0 0;padding:0}
.wiz-pt b{display:block;font-size:.95rem;font-weight:700;color:var(--ink);margin:0 0 3px}
.wiz-pt em{display:block;font-style:normal;font-size:.82rem;color:var(--mut);line-height:1.45}
.wiz-act{display:flex;gap:12px;align-items:center;flex-wrap:wrap;border-top:1px solid var(--bd);padding-top:20px}
.wiz-btn{min-height:48px;padding:0 26px;display:inline-flex;align-items:center;justify-content:center;gap:8px;font:inherit;font-size:1rem;font-weight:700;color:#fff;background:var(--pri);border:0;border-radius:9px;cursor:pointer;text-decoration:none}
.wiz-btn:hover{background:var(--prid)}
.wiz-btn:active{background:var(--prip)}
.wiz-btn.alt{background:var(--card);color:var(--ink);border:1.5px solid var(--bd)}
.wiz-btn.alt:hover{background:var(--surf);border-color:var(--bd2)}
@media(max-width:640px){
  .wiz{padding:20px 14px 44px}
  .wiz-card{padding:22px 18px 20px;border-radius:12px}
  .wiz-rail{gap:10px}
  .wiz-step span{font-size:.84rem}
  .wiz-act .wiz-btn{width:100%}
}
.center{width:100%;max-width:428px;margin:40px auto}
.authwrap .center{margin:0}
.center .card{padding:34px 32px;border-radius:var(--r-xl);box-shadow:var(--sh-lg);border:1px solid var(--bd);position:relative;overflow:hidden;margin:0}
.center .card::before{content:"";position:absolute;left:0;right:0;top:0;height:4px;background:linear-gradient(90deg,var(--brand),var(--brand2))}
.center h1{font-size:1.5rem;margin:4px 0 6px;color:var(--ink)}
.center .card>p{color:var(--mut)}
.center .card input{padding:12px 14px}
.shell{display:flex;min-height:100vh;background:var(--surf)}
.side{width:240px;flex:0 0 240px;background:var(--card);border-right:1px solid var(--row);display:flex;flex-direction:column;position:sticky;top:0;height:100vh}
.side-brand{padding:0 16px;height:56px;font-weight:600;font-size:1rem;letter-spacing:0;color:var(--ink);border-bottom:1px solid var(--row);display:flex;align-items:center;gap:10px;flex:0 0 auto}.side-brand svg{width:20px;height:20px;color:var(--pri)}
.side-shop{padding:14px 16px 6px;font-size:13px;line-height:20px;letter-spacing:0;font-weight:400;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.side-nav{padding:6px 10px 12px;display:flex;flex-direction:column;gap:1px;flex:1;overflow-y:auto}
.side-nav a{position:relative;display:flex;align-items:center;gap:12px;min-height:40px;padding:8px 12px;border-radius:var(--r-sm);color:var(--ink);font-size:14px;line-height:20px;font-weight:400;transition:background .12s,color .12s}.side-nav a svg{width:20px;height:20px;flex:0 0 auto;color:var(--ink);transition:color .12s}
.side-nav a:hover{background:var(--surf);color:var(--ink);text-decoration:none}
.nav-grp{display:flex;flex-direction:column;gap:1px}
.nav-grp+.nav-grp{margin-top:1px}
/* Hàng DANH MỤC LỚN: <a> đứng riêng và <summary> của nhóm trông y hệt nhau — cùng cấp thì
   phải cùng dáng, khác nhau chỉ ở chỗ có mũi tên hay không. */
.side-nav .nav-top{list-style:none;cursor:pointer;display:flex;align-items:center;gap:12px;
  min-height:42px;padding:9px 12px;border-radius:var(--r-sm);color:var(--ink);font-size:14px;
  line-height:20px;font-weight:500;transition:background .12s,color .12s}
.side-nav .nav-top svg{width:20px;height:20px;flex:0 0 auto;color:var(--mut);transition:color .12s}
.side-nav .nav-top span{flex:1;min-width:0}
.side-nav .nav-top::-webkit-details-marker{display:none}
.side-nav .nav-top:hover{background:var(--surf);color:var(--ink)}
.side-nav .nav-top:hover svg{color:var(--pri)}
/* Mũi tên CHỈ ở summary (nhóm có con) — mục đứng riêng không có gì để sổ. */
.side-nav summary.nav-top::after{content:"";width:7px;height:7px;flex:0 0 auto;margin-left:4px;
  border-right:1.8px solid var(--mut);border-bottom:1.8px solid var(--mut);
  transform:rotate(-45deg);transition:transform .15s}
.side-nav details[open]>summary.nav-top::after{transform:rotate(45deg)}
.side-nav .nav-top.on,.side-nav .nav-top.has-on{background:var(--navon);font-weight:600}
.side-nav .nav-top.on svg,.side-nav .nav-top.has-on svg{color:var(--pri)}
/* Danh mục CON: không icon, thụt vào thẳng hàng với chữ của mục cha (12 padding + 20 icon
   + 12 gap = 44). Thẳng hàng là thứ khiến mắt đọc ra "cái này thuộc cái kia". */
.nav-subs{display:flex;flex-direction:column;gap:1px;padding:2px 0 4px}
.side-nav a.nav-sub{min-height:36px;padding:7px 12px 7px 44px;font-size:13.5px;color:var(--mut);font-weight:400}
.side-nav a.nav-sub:hover{background:var(--surf);color:var(--ink)}
.side-nav a.nav-sub.on{background:transparent;color:var(--pri);font-weight:600}
.side-nav a.nav-sub.on::before{content:"";position:absolute;left:24px;top:50%;transform:translateY(-50%);
  width:3px;height:16px;border-radius:2px;background:var(--pri)}
.nav-foot{margin-top:auto;padding-top:6px;border-top:1px solid var(--line)}
.side-user{border-top:1px solid var(--bd);padding:12px 16px}.side-user .email{color:var(--mut);font-size:.82rem;display:block;margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.side-user button{background:var(--card);border:1px solid var(--bd);border-radius:var(--r-sm);padding:8px 12px;font:inherit;font-size:.85rem;cursor:pointer;color:var(--ink);width:100%;transition:background .15s,border-color .15s}.side-user button:hover{background:var(--surf);border-color:color-mix(in srgb,var(--pri) 30%,var(--bd))}
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.tbar{background:var(--ink0);border-bottom:0;height:56px;padding:0 20px;display:flex;justify-content:space-between;align-items:center;gap:12px;position:sticky;top:0;z-index:100}
.tbar .brand{font-weight:600;font-size:18px;letter-spacing:0;color:#fff;display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tbar .brand svg{width:20px;height:20px;color:#fff;flex:0 0 auto}
@media(max-width:900px){.tbar .brand{font-size:15px}}
.tbar .acc{font-size:14px;color:#fff;display:flex;align-items:center;gap:8px}.tbar .acc form{display:inline;margin:0}
.tbar .acc a{color:#161823;font-weight:500;background:#fff;border-radius:var(--pill);padding:8px 16px;line-height:20px;display:inline-block;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tbar .acc a:hover{background:var(--row);color:#161823;text-decoration:none}
.tbar .acc button{background:var(--fielddk);border:0;color:#fff;cursor:pointer;font:inherit;font-size:14px;line-height:20px;padding:8px 14px;border-radius:var(--pill);transition:background .12s}.tbar .acc button:hover{background:#3a3b44}
/* --pad-x/--pad-t là MỘT nguồn sự thật cho khoảng đệm vùng nội dung: dải hero phải tràn
   ra đúng mép vùng này bằng margin âm, nên nếu padding và margin âm khai riêng thì mỗi
   lần đổi điểm ngắt là một dịp để hai số lệch nhau — hở một vệt xám ở mép, hoặc tràn
   ngang sinh thanh cuộn. Khai một chỗ, cả hai cùng đọc. */
.content{--pad-x:32px;--pad-t:24px;padding:var(--pad-t) var(--pad-x) 56px;max-width:1600px;margin:0 auto;width:100%;flex:1;background:var(--surf)}
@media(max-width:1023px){.content{--pad-x:24px;--pad-t:20px;padding-bottom:48px}}
@media(max-width:767px){.content{--pad-x:16px;--pad-t:16px;padding-bottom:40px}}
.card{background:var(--card);border:1px solid var(--bd);border-radius:var(--r-lg);padding:20px 24px;margin:16px 0;box-shadow:none}.card>h2:first-child,.card>h1:first-child{margin-top:0}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:16px 12px;border-bottom:1px solid var(--row);font-size:14px;line-height:22px;vertical-align:top}td:first-child,th:first-child{padding-left:0}td:last-child,th:last-child{padding-right:0}
th{color:var(--mut);font-weight:500;font-size:13px;line-height:18px;text-transform:none;letter-spacing:0;white-space:nowrap;padding-top:12px;padding-bottom:12px;vertical-align:middle;border-bottom:1px solid var(--bd)}
tr:last-child td{border-bottom:0}tbody tr{transition:background .12s}tbody tr:hover td{background:var(--surf)}
/* O chinh 2 dong (§4.7): nen thong tin thay vi them cot. Dong 1 dam, dong 2 phu. */
td .t1{font-size:14px;font-weight:600;line-height:22px;color:var(--ink)}
td .t2{font-size:12px;line-height:18px;color:var(--mut);margin-top:2px}
td .t2.id{color:var(--faint)}
.btn{display:inline-flex;align-items:center;gap:8px;justify-content:center;background:var(--pbtn);color:var(--pbtn-ink);border:1px solid transparent;border-radius:var(--r);min-height:36px;padding:8px 16px;font-size:14px;font-weight:500;line-height:20px;cursor:pointer;text-decoration:none;box-shadow:none;transition:background .12s,border-color .12s;white-space:nowrap}
@media(max-width:767px){.btn{min-height:44px}}
.btn:hover{background:var(--pbtn-h);color:var(--pbtn-ink);text-decoration:none;box-shadow:none}.btn:active{background:var(--prip)}.btn svg{width:16px;height:16px}
.btn:disabled,.btn[disabled]{background:var(--bd);color:var(--faint);opacity:1;cursor:not-allowed;box-shadow:none;pointer-events:none}
.btn.alt{background:var(--card);color:var(--ink);border-color:var(--bd);box-shadow:none}.btn.alt:hover{background:var(--surf);border-color:var(--bd2);color:var(--ink);opacity:1}
.btn.warn{background:var(--card);color:var(--bad);border-color:var(--bd);box-shadow:none}.btn.warn:hover{background:var(--badbg);border-color:var(--bad);color:var(--bad);opacity:1}
.btn.sm{min-height:32px;padding:6px 12px;font-size:13px;border-radius:var(--r-sm)}@media(max-width:767px){.btn.sm{min-height:44px}}
label{display:block;font-size:13px;line-height:20px;margin:14px 0 6px;font-weight:500;color:var(--mut)}
input,select,textarea{width:100%;padding:8px 12px;border:1px solid var(--bd);border-radius:var(--r);font-size:14px;line-height:20px;font-family:inherit;color:var(--ink);background:var(--card);transition:border-color .12s,box-shadow .12s}
input:not([type=checkbox]):not([type=radio]):not([type=file]),select{height:36px}
@media(max-width:767px){input:not([type=checkbox]):not([type=radio]):not([type=file]),select{height:44px}}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--pri);box-shadow:0 0 0 3px rgba(15,163,163,.12)}
input::placeholder,textarea::placeholder{color:var(--faint)}
textarea{min-height:80px;resize:vertical}
.err{background:var(--badbg);border:1px solid color-mix(in srgb,var(--bad) 40%,var(--bd));color:var(--bad);border-radius:var(--r);padding:12px 14px;margin:10px 0;font-weight:500}
.notice{border-radius:var(--r);padding:12px 15px;margin:10px 0;border:1px solid var(--bd);background:var(--card)}
.notice.success{background:var(--goodbg);border-color:color-mix(in srgb,var(--good) 40%,var(--bd));color:var(--good)}
.notice.warn{background:var(--warnbg);border-color:color-mix(in srgb,var(--warn) 40%,var(--bd));color:var(--warn)}
.notice.info{background:var(--wash);border-color:color-mix(in srgb,var(--pri) 35%,var(--bd));color:var(--prid)}
.badge{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:var(--pill);font-size:13px;font-weight:500;line-height:20px;background:var(--row);color:var(--mut)}
.badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 auto}
.badge.pending{background:var(--warnbg);color:var(--warn)}.badge.confirmed{background:var(--wash);color:var(--prid)}.badge.shipped{background:var(--indigobg);color:var(--indigo)}
.badge.delivered{background:var(--goodbg);color:var(--good)}.badge.cancelled{background:var(--badbg);color:var(--bad)}.badge.paid{background:var(--goodbg);color:var(--good)}.badge.unpaid{background:color-mix(in srgb,var(--mut) 15%,transparent);color:var(--soft)}
.badge.refunded{background:var(--wash);color:var(--prid)}
.badge.unpaid,.badge.archived,.badge.closed{background:var(--row);color:var(--mut)}
.badge.returned{background:var(--warnbg);color:var(--warn)}
.badge.active{background:var(--goodbg);color:var(--good)}.badge.draft{background:var(--warnbg);color:var(--warn)}.badge.archived{background:color-mix(in srgb,var(--mut) 15%,transparent);color:var(--soft)}.badge.published{background:var(--goodbg);color:var(--good)}
.badge.onboarding{background:var(--wash);color:var(--prid)}.badge.suspended{background:var(--badbg);color:var(--bad)}.badge.closed{background:color-mix(in srgb,var(--mut) 15%,transparent);color:var(--soft)}
.muted{color:var(--mut)}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:center}
.settings-jump{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:16px 0}
.settings-jump a{display:block;border:1px solid var(--bd);border-radius:var(--r);padding:12px 14px;background:var(--card);color:var(--ink);font-weight:600}
.settings-jump a:hover{border-color:var(--pri);background:var(--wash);color:var(--prid);text-decoration:none}
.settings-jump small{display:block;color:var(--mut);font-weight:400;margin-top:3px;line-height:1.45}
@media(max-width:900px){.settings-jump{grid-template-columns:1fr 1fr}}
@media(max-width:560px){.settings-jump{grid-template-columns:1fr}}
/* Lưới chọn ảnh bìa: radio thuần HTML, không JS. Ảnh đang chọn có viền đậm nhờ
   :checked + selector anh em — cùng lối no-JS đã dùng ở gallery storefront. */
.covgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:10px;margin:6px 0 4px;max-height:280px;overflow-y:auto;padding:2px}
.covpick{position:relative;display:block;cursor:pointer;border:2px solid var(--bd);border-radius:var(--r);overflow:hidden;background:var(--surf)}
.covpick input{position:absolute;opacity:0;pointer-events:none}
.covpick img{width:100%;aspect-ratio:1/1;object-fit:cover;display:block}
.covpick:has(input:checked){border-color:var(--acc,#2563eb);box-shadow:0 0 0 2px color-mix(in srgb,var(--acc,#2563eb) 30%,transparent)}
.covnone{display:flex;align-items:center;justify-content:center;aspect-ratio:1/1;font-size:.8rem;color:var(--mut);text-align:center;padding:6px}
.covlab{display:block;font-size:.72rem;color:var(--mut);padding:4px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* Danh sách "chép dòng này để chèn ảnh giữa bài". <details> nên mặc định gấp lại,
   không chiếm chỗ của người chỉ muốn viết chữ. */
.snip{margin:8px 0 0;border:1px solid var(--bd);border-radius:var(--r);padding:8px 10px;background:var(--surf)}
.snip summary{cursor:pointer;font-size:.86rem;font-weight:600}
.snipgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;max-height:300px;overflow-y:auto}
.snipit{border:1px solid var(--bd);border-radius:var(--r);overflow:hidden;background:var(--bg,#fff)}
.snipit img{width:100%;aspect-ratio:16/10;object-fit:cover;display:block}
.snipit code{display:block;font-size:.68rem;padding:5px 6px;word-break:break-all;line-height:1.35;-webkit-user-select:all;user-select:all}
/* Cụm thao tác đơn hàng chia theo VIỆC. Trước đây mọi nút nằm chung một hàng cuốn dòng
   nên trông "nằm không đều" và không gợi ý cái nào dùng khi nào — mà một trong số đó
   tiêu tiền thật. Mỗi nhóm: nhãn nhỏ in hoa + hàng nút + (tuỳ) một dòng giải thích.
   align-items:flex-start để nút có ô nhập kèm (lý do huỷ, tick nhập-lại-kho) không kéo
   giãn các nút trơn cùng hàng — đó chính là thứ làm cụm cũ so le. */
.actgrp{border-top:1px solid var(--bd);margin-top:14px;padding-top:10px}
.actgrp:first-of-type{border-top:0;margin-top:10px;padding-top:0}
.actgrp-l{display:block;font-size:.72rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--mut)}
.actgrp .actions{margin-top:8px;align-items:flex-start}
.actgrp .actions form{display:flex;flex-direction:column;gap:6px}
.actgrp-h{font-size:.82rem;margin:8px 0 0;line-height:1.5}
.filters{display:flex;gap:10px;align-items:end;flex-wrap:wrap}.filters>div{flex:0 0 auto;min-width:0;max-width:100%}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}@media(max-width:560px){.grid2{grid-template-columns:1fr}}
.inline{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}.inline input{width:auto}
.num{font-variant-numeric:tabular-nums}.right{text-align:right}.toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.stock{font-weight:600}.stock.low{color:var(--warn)}.stock.zero{color:var(--bad)}
input[type=file]{width:auto;padding:9px 12px;background:var(--surf);border:1.5px dashed color-mix(in srgb,var(--pri) 30%,var(--bd));border-radius:var(--r);color:var(--soft)}
.media-grid{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:10px;align-items:flex-start}
.tblscroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
/* ── docs/44 §8: BẢNG → DANH SÁCH THẺ trên mobile ────────────────────────────
   Cuộn ngang là cách thu gọn tệ nhất trên điện thoại: người bán phải kéo qua kéo lại
   mới ghép được "đơn nào — bao nhiêu tiền — trạng thái gì", và cột quan trọng nhất
   thường nằm ngoài màn hình. Mỗi hàng thành MỘT thẻ, mỗi ô một dòng "nhãn — giá trị".

   Móc vào THUỘC TÍNH data-cards, không vào một lớp do JS thêm. Bản trước móc vào lớp
   "cards", mà lớp đó chỉ xuất hiện sau khi JS chạy xong — nên TẮT JS là mọi bảng lại cuộn
   ngang. Đo bằng Chromium ở 360px trên chi tiết đơn có ca xử lý: JS bật 385/360 (tràn
   25px), JS tắt 572/360 (tràn 212px). Nhãn nay do server phát cùng markup (tblCards), nên
   thuộc tính và nhãn LUÔN đi cùng nhau, nên quy tắc này an toàn ngay từ byte đầu tiên.
   (Dấu backtick bị cấm trong chú thích này: cả biểu định kiểu nằm TRONG một template
   literal, một backtick lạc là cắt đứt chuỗi và lỗi báo ở dòng rất xa — CLAUDE.md §4.)
   (Cố ý không viết thẻ HTML dạng nguyên văn trong chú thích: CSS này đi kèm MỌI trang, nên
   một chuỗi trông-giống-markup ở đây sẽ khớp regex của e2e đang quét markup của trang.) */
@media(max-width:767px){
  table[data-cards],table[data-cards] tbody,table[data-cards] tr,table[data-cards] td{display:block;width:100%}
  table[data-cards] thead{display:none}
  table[data-cards]{border-collapse:separate;border-spacing:0}
  table[data-cards] tr{border:1px solid var(--bd);border-radius:var(--r-lg);padding:12px 14px;margin-bottom:12px;background:var(--card)}
  table[data-cards] tr:hover td{background:transparent}
  /* Nhãn cột đặt TUYỆT ĐỐI ở lề trái; phần giá trị chiếm chỗ còn lại và xuống dòng bình
     thường. Bản đầu dùng flex và ĐÃ SAI: flex biến MỖI CON của <td> thành một item, nên ô
     hai con — <a>tên khách</a> + <div>SĐT</div> — bị xếp NGANG cạnh nhau rồi tràn ra ngoài
     thẻ. Đơn/Sản phẩm không lộ vì ô chính của chúng có sẵn một <div> bọc.
     Vị trí tuyệt đối không quan tâm ô có mấy con, nên đúng cho mọi bảng. */
  table[data-cards] td{border:0;position:relative;padding:6px 0 6px 40%;text-align:right;min-height:20px;overflow-wrap:anywhere}
  table[data-cards] td::before{content:attr(data-label);position:absolute;left:0;top:6px;width:38%;
    color:var(--mut);font-size:13px;line-height:20px;font-weight:400;text-align:left;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* Ô rỗng (cột hành động trống, cột đệm) không đẻ ra dòng trắng vô nghĩa. */
  table[data-cards] td:empty{display:none}
  /* Ô KHÔNG có nhãn (cột checkbox chọn hàng loạt, cột nút) trải hết chiều ngang.
     Bộ chọn là :not([data-label]) chứ không phải [data-label=""]: tblCards BỎ HẲN thuộc
     tính khi nhãn rỗng, vì content:attr() với chuỗi rỗng vẫn sinh một ::before chiếm chỗ. */
  table[data-cards] td:not([data-label]){padding-left:0;text-align:left}
  table[data-cards] td:not([data-label])::before{display:none}
  /* Ô chứa VĂN XUÔI (nội dung phiếu hỗ trợ, ghi chú xử lý): xếp nhãn LÊN TRÊN thay vì
     dành 40% bề ngang cho nó. Đo thật ở 375px: ghi chú nằm trong ô có nhãn chỉ còn 109px
     → 33 dòng mỗi dòng 3-4 ký tự. Cột nhãn 40% là đúng cho GIÁ TRỊ NGẮN (số tiền, trạng
     thái, ngày) — sai cho một đoạn văn. */
  table[data-cards] td.stack{padding-left:0;text-align:left}
  table[data-cards] td.stack::before{position:static;display:block;width:auto;margin-bottom:2px}
  /* Hàng <tfoot> là dòng TỔNG, không phải một bản ghi — tblCards cố ý chỉ gán nhãn cho tbody.
     Không xử riêng thì ô không có data-label vẫn dính quy tắc td ở trên: chừa 40% trống
     cho nhãn rỗng rồi ép số tiền vào 60% còn lại. Cho cả hàng thành một dải
     "chữ trái — số phải" (đối soát COD, chi tiết phiếu nhập). */
  table[data-cards] tfoot{display:block;width:100%}
  table[data-cards] tfoot tr{display:flex;justify-content:space-between;align-items:baseline;gap:12px;background:var(--surf)}
  table[data-cards] tfoot td{display:block;width:auto;padding:0;min-height:0;text-align:right}
  table[data-cards] tfoot td::before{display:none}
  /* Trong thẻ thì không cần cuộn ngang nữa. */
  .tblscroll:has(table[data-cards]){overflow-x:visible}
}
.savebar{display:flex;justify-content:flex-end;align-items:center;gap:12px;flex-wrap:wrap;margin-top:16px;padding-top:16px;border-top:1px solid var(--bd)}.savebar .muted{margin-right:auto}
.vartbl th,.vartbl td{padding:11px 10px}.vartbl input{padding:8px 10px;font-size:.9rem}
/* Tổng quan: số liệu lớn + biểu đồ doanh thu (SVG nội tuyến, không JS) */
.hero-num{font-size:clamp(1.9rem,4vw,2.6rem);font-weight:800;letter-spacing:-.03em;line-height:1.1;font-variant-numeric:tabular-nums}
.hero-sub{color:var(--mut);font-size:.9rem;margin-top:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.delta{display:inline-flex;align-items:center;gap:4px;font-size:.8rem;font-weight:700;padding:3px 10px;border-radius:var(--pill);white-space:nowrap}
.delta.up{background:var(--goodbg);color:var(--good)}
.delta.down{background:var(--badbg);color:var(--bad)}
.delta.flat{background:var(--wash);color:var(--prid)}
.chart{width:100%;height:auto;display:block;margin-top:18px}
.chart path{transition:opacity .12s}.chart:hover path{opacity:.55}.chart path:hover{opacity:1}
.mbar{height:5px;border-radius:3px;background:var(--bd);margin-top:6px;overflow:hidden;min-width:70px}
.mbar i{display:block;height:100%;border-radius:3px;background:var(--pri)}
.sdot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;display:inline-block;margin-right:7px}
.pcell{display:flex;align-items:center;gap:11px;min-width:0}
/* docs/44 §4.7: ảnh thu nhỏ ĐƠN HÀNG 40px · SẢN PHẨM 56px, bo 4px, viền mảnh.
   Bo 10px cũ là của bảng màu trước — ở giao diện vận hành, ảnh bo tròn nhiều làm hàng
   bảng trông "mềm" và khó quét mắt theo cột. */
.pthumb{width:40px;height:40px;flex:0 0 auto;border-radius:var(--r-xs);object-fit:cover;border:1px solid var(--row);background:var(--surf);display:block}
.pthumb.lg{width:56px;height:56px}
/* Phiếu hỗ trợ (0108). Thân phiếu là VĂN XUÔI người bán gõ — pre-wrap giữ nguyên xuống dòng
   của họ (mô tả từng bước gặp lỗi mà bị ép thành một khối liền là mất đúng thứ cần đọc). */
.tkt{border-left:3px solid var(--bd)}
.tkt.late{border-left-color:var(--bad)}
/* max-width theo ch: phần còn lại của trang quản trị là BẢNG nên trải hết bề ngang là đúng,
   nhưng đây là văn xuôi. Ở màn 1280 thân phiếu rộng ~1150px = dòng hơn 150 ký tự, mắt phải
   quét ngang rồi dò lại đầu dòng — người đọc bỏ giữa chừng đúng lúc cần đọc kỹ nhất. */
.prosetxt{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6;max-width:74ch}
.tkt .prosetxt{margin:10px 0 0}
.tkt summary{cursor:pointer;color:var(--pri);font-size:.88rem;margin-top:6px}
.tkt .tmeta{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;font-size:.85rem;margin-top:12px;padding-top:10px;border-top:1px solid var(--row)}
/* §4.7 checkbox: 16px, chọn → nền teal + tick trắng. accent-color làm đúng việc đó bằng
   control NATIVE — chạy không cần JS, giữ nguyên hành vi bàn phím/đọc màn hình/forced-colors.
   KHÔNG làm phần "bo 4px, viền 1.5px" của spec: trình duyệt bỏ qua border-radius trên
   checkbox native, muốn có phải appearance:none rồi tự vẽ dấu tick — đổi lấy 4px bo góc
   trên ô 16px bằng cách tự dựng lại một control biểu mẫu nằm ngay trên trang Đơn hàng là
   không đáng. Ghi ra đây để lần sau không ai tưởng chỗ này bị bỏ sót. */
input[type=checkbox]{width:16px;height:16px;accent-color:var(--pri)}
.pthumb.ph{display:grid;place-items:center;color:color-mix(in srgb,var(--pri) 55%,var(--mut))}.pthumb.ph svg{width:20px;height:20px}
.thumb{margin:0;width:120px;position:relative}.thumb img{width:120px;height:120px;object-fit:cover;border-radius:var(--r);border:1px solid var(--bd);display:block}
.thumb .ph{width:120px;height:120px;border-radius:var(--r);border:1.5px dashed color-mix(in srgb,var(--pri) 25%,var(--bd));display:flex;align-items:center;justify-content:center;color:var(--mut);font-size:.82rem;background:var(--surf);text-align:center}
.thumb .prim{position:absolute;top:6px;left:6px;background:var(--good);color:#fff;font-size:.66rem;font-weight:700;padding:2px 7px;border-radius:999px;line-height:1.35;box-shadow:0 1px 3px rgba(0,0,0,.25)}
.thumb-act{display:flex;gap:3px;justify-content:center;flex-wrap:wrap;margin-top:4px}.thumb-act form{margin:0}
.thumb-act .btn.sm{padding:4px 7px;font-size:.8rem}
.block{border:1px solid var(--bd);border-radius:var(--r);padding:14px;margin:8px 0;background:var(--surf)}
.block textarea{background:var(--card)}code{background:color-mix(in srgb,var(--pri) 9%,transparent);color:var(--prid);padding:2px 7px;border-radius:6px;font-size:.85rem;font-family:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace}.pill{display:inline-block;margin-right:6px}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin:0 0 18px}
.metric{background:var(--card);border:1px solid var(--bd);border-radius:var(--r-lg);padding:18px 20px;box-shadow:var(--sh-sm);transition:transform .2s,box-shadow .2s,border-color .2s}
a.metric:hover{transform:translateY(-3px);box-shadow:var(--sh);border-color:color-mix(in srgb,var(--pri) 30%,var(--bd))}
.metric .l{font-size:.8rem;color:var(--mut);margin-bottom:4px}.metric .v{font-size:1.7rem;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.1}
/* "Việc cần làm" — lưới ô hành động đầu trang Tổng quan (mẫu TikTok Shop/Shopee).
   Ô CÓ việc: nền màu cảnh báo + số to đậm. Ô SẠCH: xám nhạt, không hút mắt. */
.todo-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:12px;margin-top:14px}
.todo-cell{display:block;padding:14px 16px;border:1px solid var(--bd);border-radius:var(--r-lg);background:var(--card);text-decoration:none;color:inherit;transition:transform .18s,box-shadow .18s,border-color .18s}
.todo-cell:hover{transform:translateY(-2px);box-shadow:var(--sh);text-decoration:none}
.todo-n{font-size:1.75rem;font-weight:800;line-height:1.05;letter-spacing:-.02em;font-variant-numeric:tabular-nums;color:var(--mut)}
.todo-cell.on .todo-n{font-size:1.9rem}
.todo-l{font-size:.8rem;color:var(--mut);margin-top:3px;line-height:1.3}
.todo-cell.on .todo-l{color:var(--soft);font-weight:600}
/* Tab trạng thái (Đơn hàng/Sản phẩm) — thay <select> bằng tab kèm số đếm, kiểu sàn TMĐT.
   Cuộn ngang trên mobile thay vì vỡ hàng. */
.stabs{display:flex;gap:4px;overflow-x:auto;border-bottom:1px solid var(--bd);margin:0 0 14px;padding-bottom:0;-webkit-overflow-scrolling:touch}
.stab{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;padding:9px 14px;border:0;border-bottom:2px solid transparent;background:none;color:var(--mut);font-size:.9rem;font-weight:600;text-decoration:none;white-space:nowrap;transition:color .15s,border-color .15s}
.stab:hover{color:var(--pri);text-decoration:none}
.stab.on{color:var(--pri);border-bottom-color:var(--pri)}
.stab .cnt{display:inline-block;min-width:19px;padding:0 6px;border-radius:999px;background:var(--bd2,#e5e7eb);color:var(--soft);font-size:.72rem;font-weight:800;line-height:19px;text-align:center;font-variant-numeric:tabular-nums}
.stab.on .cnt{background:var(--pri);color:#fff}
/* ── docs/44 §4.11: thẻ gợi ý nền bạc hà, cuộn ngang ────────────────────────
   VAI TRÒ KHÁC HẲN "Việc cần làm": ô kia là việc TỒN ĐỌNG (có số, phải xử lý), khối này
   là tính năng người bán ĐANG TRẢ TIỀN mà chưa dùng tới. Nền tảng có khuyến mãi, giá vốn,
   kiểm kê, tên miền riêng, CRM… — checklist onboarding giới thiệu được vài thứ rồi BIẾN
   MẤT khi shop mở bán, và từ đó không còn gì dẫn người bán tới phần còn lại.
   Cố ý KHÔNG đặt tên kiểu "đề xuất riêng cho bạn": khối này không cá nhân hoá theo dữ liệu,
   gọi vậy là hứa quá lời — tiêu đề thật (xem renderOverview) chỉ nói đúng thứ nó làm.
   Đừng chép nguyên văn chuỗi hiển thị vào comment: CSS đi kèm MỌI trang nên chuỗi ở đây
   khớp cả regex của e2e đang kiểm khối này VẮNG mặt. */
.sugg-row{display:flex;gap:16px;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:thin;padding-bottom:4px}
.sugg-card{flex:0 0 auto;width:min(280px,78vw);background:var(--wash);border-radius:var(--r-sm);padding:16px 20px;text-decoration:none;color:var(--ink);transition:background .12s;display:block}
.sugg-card:hover{background:var(--washh);text-decoration:none;color:var(--ink)}
.sugg-card .st{font-size:15px;line-height:22px;font-weight:600;margin:0 0 4px}
.sugg-card .sd{font-size:13px;line-height:20px;color:var(--mut);margin:0 0 10px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
/* "Mở ›" theo đúng §4.11: 13px/500 --indigo. Đã cân nhắc đổi sang teal (spec cho phép cả
   hai) nhưng #1668DC trên nền bạc hà #E8F6F6 đạt 4.68:1 — qua AA cho chữ thường, trong khi
   #0FA3A3 chỉ ~3:1. Giữ indigo cũng tách bạch: teal là nút bấm, đây là link trong thẻ. */
.sugg-card .sa{font-size:13px;line-height:20px;font-weight:500;color:var(--indigo)}
/* ── docs/44 §4.15: dải hero ĐEN, chỉ trang Tổng quan ───────────────────────
   Tràn hết chiều ngang VÙNG NỘI DUNG bằng margin âm đúng bằng --pad-x (xem chú thích ở
   .content). overflow:hidden để hình thoi trang trí không đẻ thanh cuộn ngang. */
.hero-band{position:relative;overflow:hidden;background:var(--ink0);color:#fff;min-height:150px;
  margin:calc(-1 * var(--pad-t)) calc(-1 * var(--pad-x)) 0;padding:28px var(--pad-x) 76px;display:flex;align-items:center}
/* Nêm chéo sáng bên phải — cùng màu canvas nên nó "cắt" dải đen chứ không thêm màu mới. */
.hero-band::after{content:"";position:absolute;inset:0 0 0 auto;width:38%;background:var(--surf);
  clip-path:polygon(100% 0,100% 100%,0 100%);pointer-events:none}
@media(max-width:767px){.hero-band::after{display:none}}
.hb-in{position:relative;z-index:2;max-width:min(760px,100%)}
.hb-shop{font-size:20px;line-height:28px;font-weight:600;margin:0 0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hb-line{font-size:15px;line-height:22px;color:rgba(255,255,255,.78);margin:0 0 14px}
/* Nút pill trên nền đen: nền #2A2B32 (Field on Black) — KHÔNG dùng teal ở đây, teal là
   màu "bấm được" của vùng làm việc; đặt lên dải đen sẽ loãng nghĩa (docs/44 §7). */
.hb-cta{display:inline-flex;align-items:center;gap:8px;background:var(--fielddk);color:#fff;
  border-radius:var(--pill);padding:10px 18px;font-size:14px;line-height:20px;font-weight:500;text-decoration:none;transition:background .12s}
.hb-cta:hover{background:#3a3b44;color:#fff;text-decoration:none}
@media(max-width:767px){.hb-cta{padding:12px 18px}}
/* Hình thoi: khối vuông xoay 45°, CHỈ trang trí (aria-hidden + pointer-events:none).
   Đây là chỗ DUY NHẤT được dùng cyan/magenta của TikTok (docs/44 §2). */
.hb-dot{position:absolute;transform:rotate(45deg);pointer-events:none;opacity:.9}
@media(prefers-reduced-motion:no-preference){.hb-dot{transition:none}}
/* Thẻ đầu tiên ĐÈ LÊN đáy dải (docs/44 §9 khuôn trang tổng quan).
   Phải triệt margin-top của .card bên trong: lề trên 16px của nó GỘP với lề âm ở đây
   (-60 + 16 = -44), nên đo thật chỉ đè 44px chứ không phải 60px như spec. */
.hero-lift{position:relative;z-index:3;margin-top:-60px}
.hero-lift>.card{margin-top:0}
@media(max-width:767px){.hero-band{min-height:0;padding-bottom:64px}.hero-lift{margin-top:-48px}}
.dash-hero{position:relative;overflow:hidden;background:linear-gradient(120deg,color-mix(in srgb,var(--brand) 7%,var(--card)),var(--card) 60%);border:1px solid var(--bd);border-radius:var(--r-lg);padding:26px 28px;margin:0 0 20px;box-shadow:var(--sh-sm)}
.dash-hero::after{content:"";position:absolute;top:-40%;right:-8%;width:300px;height:300px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--brand2) 12%,transparent),transparent 70%);pointer-events:none}
.dash-hero .eyebrow{position:relative;font-size:.74rem;text-transform:uppercase;letter-spacing:.09em;color:var(--pri);font-weight:800;margin:0 0 4px}
.dash-hero h1{position:relative;margin:0 0 6px;font-size:1.7rem}.dash-hero p{position:relative;margin:0;color:var(--soft)}
.staffbar{background:var(--wash);border:1px solid color-mix(in srgb,var(--pri) 35%,var(--bd));border-radius:var(--r-lg);padding:13px 18px;margin:0 0 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;color:var(--soft)}
.shop-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.shop-card{background:var(--card);border:1px solid var(--bd);border-radius:var(--r-lg);padding:20px 22px;display:flex;flex-direction:column;gap:16px;color:inherit;text-decoration:none;box-shadow:var(--sh-sm);transition:box-shadow .25s cubic-bezier(.2,.7,.2,1),transform .2s,border-color .2s}
.shop-card:hover{box-shadow:var(--sh);border-color:color-mix(in srgb,var(--pri) 30%,var(--bd));transform:translateY(-4px);text-decoration:none}
.sc-head{display:flex;align-items:flex-start;gap:13px}
.sc-avatar{flex:0 0 auto;width:48px;height:48px;border-radius:var(--r);background:linear-gradient(135deg,color-mix(in srgb,var(--brand) 18%,var(--card)),color-mix(in srgb,var(--brand2) 18%,var(--card)));color:var(--pri);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:1.3rem;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--pri) 20%,transparent)}
.sc-name{font-weight:800;font-size:1.06rem;letter-spacing:-.01em;color:var(--ink);line-height:1.25}
.sc-meta{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-top:6px}.sc-meta .role{color:var(--mut);font-size:.82rem}
.sc-go{margin-top:auto;color:var(--pri);font-weight:600;font-size:.92rem;display:inline-flex;align-items:center;gap:6px}
.sc-go .arr{transition:transform .18s}.shop-card:hover .sc-go .arr{transform:translateX(4px)}
.ok{background:var(--goodbg);border-color:color-mix(in srgb,var(--good) 40%,var(--bd))}
.empty-state{text-align:center;padding:48px 24px;color:var(--mut)}
.empty-state .ic{width:56px;height:56px;margin:0 auto 14px;border-radius:16px;background:var(--wash);color:var(--pri);display:grid;place-items:center}
a:focus-visible,.btn:focus-visible,.shop-card:focus-visible,.metric:focus-visible,summary:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid var(--pri);outline-offset:2px;border-radius:8px}
.admtoggle{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden}
/* ☰ là CỬA VÀO toàn bộ điều hướng trên điện thoại, mà đo được chỉ 22×24px. Ngón tay cần
   ~44px; trượt nút này là người bán không mở nổi menu và tưởng app không có gì khác. */
.admburger{display:none;cursor:pointer;font-size:1.5rem;line-height:1;margin-right:10px;user-select:none;color:var(--ink);
  min-width:44px;min-height:44px;align-items:center;justify-content:center;margin-left:-10px}
.admtoggle:focus-visible+.side .side-brand{outline:2.5px solid var(--pri);outline-offset:2px}
/* Mobile: gom sidebar (25 mục) vào nút ☰ trên topbar (no-JS checkbox). tbar lên trên, side hiện khi ☰. */
@media(max-width:760px){.shell{flex-direction:column}.main{order:0}.side{order:1;width:100%;flex:none;height:auto;position:static;display:none}.admtoggle:checked~.side{display:flex}.admburger{display:inline-flex}.side-nav{flex-direction:column}
  /* Ngón tay cần ≥44px. Trên desktop mục con 36px là đủ cho chuột, nhưng menu này mở
     bằng nút ☰ trên điện thoại — ở đó 36px là bấm trượt sang mục bên cạnh. */
  .side-nav a.nav-sub{min-height:44px;padding-top:11px;padding-bottom:11px}
  .side-nav .nav-top{min-height:46px}
  .content{padding:18px 16px}.tbar{padding:12px 16px}.center .card{padding:26px 22px}}
@media(prefers-color-scheme:dark){.card[style*="#ecfdf5"],.card[style*="#eff6ff"],.card[style*="#fffbeb"],.card[style*="#fef3c7"],.card[style*="#fef2f2"]{color:#0d1526}.card[style*="#ecfdf5"] .muted,.card[style*="#eff6ff"] .muted,.card[style*="#fffbeb"] .muted,.card[style*="#fef3c7"] .muted,.card[style*="#fef2f2"] .muted,.card[style*="#ecfdf5"] th,.card[style*="#eff6ff"] th,.card[style*="#fffbeb"] th,.card[style*="#fef3c7"] th,.card[style*="#fef2f2"] th{color:#3f4d66}.card[style*="#ecfdf5"] a,.card[style*="#eff6ff"] a,.card[style*="#fffbeb"] a,.card[style*="#fef3c7"] a,.card[style*="#fef2f2"] a{color:#1b48c0}.card[style*="#ecfdf5"] code,.card[style*="#eff6ff"] code,.card[style*="#fffbeb"] code,.card[style*="#fef3c7"] code,.card[style*="#fef2f2"] code{background:rgba(13,21,38,.08);color:#12306b}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}html{scroll-behavior:auto}}`;

const badge = (kind, label) => `<span class="badge ${esc(kind)}">${esc(label)}</span>`;

/**
 * BẢNG ĐỔ THÀNH THẺ Ở MOBILE — nhãn sinh Ở SERVER.
 *
 * VÌ SAO. Bản trước card-hoá bằng JavaScript: ADMIN_JS đọc `thead th` rồi gán `data-label`
 * cho từng `td`. CSS chỉ có `table.cards`, không có `[data-cards]`. Tắt JS là mọi bảng render
 * nguyên nhiều cột. Đo bằng Chromium ở 360px trên trang chi tiết đơn có ca xử lý:
 *   JS bật  385/360 (tràn 25px)   ·   JS tắt  572/360 (tràn 212px)
 * Vi phạm cùng lúc hai ràng buộc cố định: "JS chỉ là tăng cường" và "dùng được ở 360px".
 *
 * VÌ SAO KHÔNG SỬA BẰNG CSS. `content: attr()` chỉ đọc được thuộc tính của CHÍNH phần tử đó;
 * không có cách nào để CSS lấy chữ từ `th` tương ứng. Nhãn buộc phải do server phát ra.
 *
 * HỢP ĐỒNG
 *   head: [{ html, label, cls?, style?, attrs? }]
 *                             label='' → cột không sinh ::before (ô checkbox/nút)
 *                             label bỏ trống → lấy từ chính `html` sau khi bỏ thẻ
 *   rows: [[{ html, label?, cls?, style?, attrs?, colspan? }]]  label mặc định theo CHỈ SỐ cột
 *                             colspan > 1 → KHÔNG gán nhãn (chỉ số cột không xác định)
 *                             hàng cần thuộc tính riêng: { cells: [...], attrs: '…' }
 *   foot: [[{ html, colspan? }]]          KHÔNG card-hoá, giữ nguyên dạng hàng
 *
 * Nhãn suy theo CHỈ SỐ nên không thể chép tay lệch: thêm một cột vào `head` mà quên sửa
 * `rows` thì lệch lộ ra ngay ở chính hàng đó, không âm thầm mất nhãn.
 *
 * `style` và `attrs` KHÔNG đi qua esc(): chúng là CSS/HTML viết tại chỗ, esc() sẽ biến `"`
 * thành `&quot;` và hỏng thuộc tính. Cũng vì thế cả hai chỉ được nhận hằng viết tay hoặc
 * hàm sinh thuộc tính đã kiểm (như `neg()` ở báo cáo, trả nguyên ` style="…"`), KHÔNG BAO
 * GIỜ ghép từ dữ liệu người dùng.
 *
 * `attrs` là lối thoát cho ĐÚNG ba hàng trong cả kho có thuộc tính riêng (NCC đã ẩn, API
 * key đã thu hồi, dòng tổng in đậm — đều là một `style` mờ/đậm có điều kiện). Nó nhận HTML
 * thô nên chỉ được truyền hằng viết tại chỗ, không bao giờ ghép từ dữ liệu.
 */
const stripTags = (h) => String(h ?? '').replace(/<[^>]*>/g, '').trim();
function tblCards({ head = [], rows = [], foot = [], cls = '' } = {}) {
  const labels = head.map((h) => (h.label !== undefined ? h.label : stripTags(h.html)));
  const at = (c) => `${c.cls ? ` class="${esc(c.cls)}"` : ''}${c.style ? ` style="${c.style}"` : ''}${c.attrs ?? ''}`;
  const th = head.map((h) => `<th${at(h)}>${h.html ?? ''}</th>`).join('');
  const body = rows.map((r) => `<tr${Array.isArray(r) ? '' : r.attrs ?? ''}>${(Array.isArray(r) ? r : r.cells).map((c, i) => {
    const span = Number(c.colspan) > 1 ? ` colspan="${esc(c.colspan)}"` : '';
    // Ô spanning nhiều cột không thuộc về một tiêu đề nào → không gán nhãn, thay vì gán sai.
    // Nhãn RỖNG thì BỎ HẲN thuộc tính, không phát `data-label=""`: CSS dùng
    // `content: attr(data-label)` nên nhãn rỗng vẫn sinh một ::before chiếm chỗ và đẩy nội
    // dung ô lệch đi — đúng những cột không có tiêu đề (checkbox, nút) mới hay rơi vào đây.
    const want = c.label ?? labels[i] ?? '';
    const lab = span || !want ? '' : ` data-label="${esc(want)}"`;
    return `<td${at(c)}${span}${lab}>${c.html ?? ''}</td>`;
  }).join('')}</tr>`).join('');
  const tf = foot.length ? `<tfoot>${foot.map((cells) => `<tr>${cells.map((c) => {
    const span = Number(c.colspan) > 1 ? ` colspan="${esc(c.colspan)}"` : '';
    return `<td${at(c)}${span}>${c.html ?? ''}</td>`;
  }).join('')}</tr>`).join('')}</tfoot>` : '';
  return `<table data-cards${cls ? ` class="${esc(cls)}"` : ''}><thead><tr>${th}</tr></thead><tbody>${body}</tbody>${tf}</table>`;
}
// Vai trò nào thấy tab nào (backend mới là nơi cưỡng chế; đây chỉ để ẩn/hiện cho gọn).

/**
 * MÀN HÌNH ĐẦU TIÊN sau khi đăng nhập, theo vai.
 *
 * Trước đây mọi vai đều bị đẩy thẳng tới `/overview`. `catalog_manager` (chỉ catalog.read/write)
 * không có `orders.read`, mà `/overview` gọi `GET /stats` vốn đòi đúng quyền đó → 403 → trang
 * lỗi. Tệ hơn: sideNav cũng ẩn "Tổng quan" khỏi vai này (ORDER_ROLES), nên họ đứng trên một
 * trang lỗi mà trong thanh điều hướng KHÔNG có mục nào tương ứng — không có gì để bấm lùi.
 * Đăng nhập xong là gặp lỗi, mọi lần.
 *
 * Neo vào CHÍNH các Set mà sideNav dùng: một nguồn thì không trôi được. Thứ tự phản ánh thứ
 * tự trong nav — vai nào cũng vào đúng mục đầu tiên họ nhìn thấy ở đó.
 */
export function landingPath(shopId, role) {
  const base = `/shops/${shopId}`;
  if (ORDER_ROLES.has(role)) return { href: `${base}/overview`, label: 'Tổng quan' };
  if (CATALOG_ROLES.has(role)) return { href: `${base}/products`, label: 'Quản lý sản phẩm' };
  // Vai lạ (thêm vai mới mà quên khai ở đây): về màn chọn cửa hàng thay vì đoán bừa một
  // trang họ có thể không mở được — lặp lại đúng lỗi đang vá. Nhãn đi kèm href để nơi gọi
  // không phải chép lại tên màn hình lần nữa.
  return { href: '/', label: 'Bảng điều khiển' };
}
const MEMBER_READ_ROLES = new Set(['owner', 'admin']); // xem nhân sự; SỬA chỉ owner (seller cưỡng chế)
const EXPORT_ROLES = new Set(['owner']); // xuất dữ liệu: CHỈ chủ shop (seller cưỡng chế perm 'export')
const REPORT_ROLES = new Set(['owner', 'admin']); // báo cáo lãi: owner/admin (seller cưỡng chế 'reports.read' — ẩn nav chỉ là mỹ quan)
const DOMAIN_ROLES = new Set(['owner']); // tên miền: CHỈ chủ shop (seller cưỡng chế 'domain.write')
const SHIPPING_ROLES = new Set(['owner', 'admin']); // vận chuyển: owner/admin (seller cưỡng chế 'shop.write' + step-up)
const AUDIT_ROLES = new Set(['owner', 'admin']); // nhật ký hoạt động: owner/admin (seller cưỡng chế 'audit.read')
const LOYALTY_ROLES = new Set(['owner', 'admin']); // điểm thưởng: owner/admin (seller cưỡng chế 'loyalty.write' + step-up)
const ROLE_LABEL = { owner: 'Chủ shop', admin: 'Quản trị', catalog_manager: 'Quản lý sản phẩm', order_manager: 'Quản lý đơn' };
const INVITE_ROLES = ['admin', 'catalog_manager', 'order_manager']; // KHÔNG mời owner qua đây
const PSTATUS = { draft: 'Nháp', active: 'Đang bán', archived: 'Lưu trữ' };
const PGSTATUS = { draft: 'Nháp', published: 'Đã đăng' };
const SHOP_STATUS = { onboarding: 'Đang thiết lập', active: 'Đang hoạt động', suspended: 'Tạm ngưng', closed: 'Đã đóng' };
const BTYPE = { heading: 'Tiêu đề', paragraph: 'Đoạn văn', list: 'Danh sách', quote: 'Trích dẫn', divider: 'Đường kẻ', image: 'Hình ảnh' };
// 4 cam kết mặc định của dải features storefront (#40) — GIỮ ĐỒNG BỘ với
// DEFAULT_FEATURES ở apps/storefront/src/theme.js (đây là placeholder/fallback khi
// shop để trống; icon cố định theo ô). themeSave (server.js) dùng làm fallback per-ô.
export const THEME_FEATURE_DEFAULTS = [
  { icon: 'truck', title: 'Giao hàng toàn quốc', desc: 'Nhận hàng tận nơi, nhanh chóng khắp 63 tỉnh thành.' },
  { icon: 'return', title: 'Đổi trả trong 7 ngày', desc: 'Chưa ưng ý? Đổi hoặc trả dễ dàng, không rắc rối.' },
  { icon: 'badge', title: 'Cam kết chính hãng', desc: 'Sản phẩm đúng mô tả, chất lượng đảm bảo.' },
  { icon: 'wallet', title: 'Thanh toán an toàn', desc: 'COD khi nhận hàng hoặc chuyển khoản QR tiện lợi.' },
];

// Kênh bán & mạng xã hội hiện ở chân trang. PHẢI khớp CHANNEL_KINDS ở apps/seller
// (nơi cưỡng chế) và bảng CHANNELS ở storefront (nơi có tên/màu). Ba nơi vì ba
// service không chia sẻ mã; seller là nơi CHẶN, hai nơi kia chỉ là bày ra.
export const CHANNEL_OPTIONS = [
  ['facebook', 'Facebook'], ['instagram', 'Instagram'], ['tiktok', 'TikTok'],
  ['youtube', 'YouTube'], ['zalo', 'Zalo'], ['messenger', 'Messenger'],
  ['shopee', 'Shopee'], ['lazada', 'Lazada'], ['tiki', 'Tiki'], ['sendo', 'Sendo'],
  ['phone', 'Gọi ngay (điện thoại)'],
];

// Icon nội tuyến (markup → hợp CSP, không tải resource ngoài).
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
// Nguồn đơn (0119) — PHẢI khớp ORDER_SOURCES ở apps/seller/src/orders.js và CHECK của
// cột orders.source. 'web' không có trong ô chọn của form tạo đơn tay: đơn gõ tay theo
// định nghĩa không đi qua trang thanh toán, để đó chỉ tạo cơ hội ghi sai.
export const ORDER_SOURCE_LABEL = {
  web: 'Website', manual: 'Nhân viên nhập', facebook: 'Facebook',
  zalo: 'Zalo', tiktok: 'TikTok', other: 'Khác',
  kiotviet_pos: 'KiotViet POS', sapo_pos: 'Sapo POS',
};
export const ORDER_SOURCE_PICK = ['manual', 'facebook', 'zalo', 'tiktok', 'other'];
const PAYMENT_LABEL = { unpaid: 'Chưa thu tiền', pending: 'Chờ đối soát', paid: 'Đã thu tiền', refunded: 'Đã hoàn tiền' };
const IC_HOME = ic('<path d="M3 9l1-5h16l1 5"/><path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M3 9h18"/>');
const IC_ORDER = ic('<path d="M5 4h14v16l-3-2-2 2-2-2-2 2-3-2z"/><path d="M9 9h6"/><path d="M9 13h6"/>');
const IC_BOX = ic('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/><path d="M12 12v9"/>');
const IC_IMG = ic('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 16l-5-5L5 20"/>');
const IC_TREND = ic('<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>');
const IC_PALETTE = ic('<circle cx="13.5" cy="6.5" r="1.2"/><circle cx="17" cy="10" r="1.2"/><circle cx="8.5" cy="7" r="1.2"/><circle cx="6.5" cy="11.5" r="1.2"/><path d="M12 3a9 9 0 1 0 0 18 1.8 1.8 0 0 0 1.8-1.8 1.8 1.8 0 0 1 1.8-1.8H17a4 4 0 0 0 4-4 9 9 0 0 0-9-8.4z"/>');
const IC_CARD = ic('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 15h4"/>');
const IC_CHART = ic('<path d="M4 20V4"/><path d="M4 20h16"/><rect x="7" y="12" width="3" height="5"/><rect x="12" y="8" width="3" height="9"/><rect x="17" y="5" width="3" height="12"/>');
const IC_GEAR = ic('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>');
const IC_HEART = ic('<circle cx="12" cy="8" r="3.5"/><path d="M5 20v-1.5a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6V20"/>');
const IC_WAREHOUSE = ic('<path d="M3 21V8l9-5 9 5v13"/><path d="M3 21h18"/><rect x="7" y="13" width="10" height="8"/><path d="M7 17h10"/>');
const IC_PLUG = ic('<path d="M9 3v6M15 3v6"/><path d="M6 9h12v3a6 6 0 0 1-12 0z"/><path d="M12 18v3"/>');
// Báo cáo dùng icon KHÁC Tổng quan: hai mục này giờ đứng cạnh nhau ở cấp cao nhất, cùng
// hình cột thì mắt lướt qua sẽ đọc nhầm là một.
const IC_CHART2 = ic('<path d="M4 20V4"/><path d="M4 20h16"/><path d="M7 15l4-5 3 3 5-7"/>');
const IC_LIFE = ic('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.6"/><path d="M5.6 5.6l3.8 3.8M14.6 14.6l3.8 3.8M18.4 5.6l-3.8 3.8M9.4 14.6l-3.8 3.8"/>');

// Điều hướng dọc trong 1 shop (sidebar) — chỉ hiện mục vai trò được phép.

// ── Trợ giúp (0107) ────────────────────────────────────────────────────────
// Thông tin liên hệ lấy từ BIẾN MÔI TRƯỜNG của nền tảng, không phải bảng cấu hình: nó là
// một dòng cho toàn hệ, đổi vài tháng một lần, và thêm cả một bảng + màn hình quản trị cho
// một dòng là chi phí không đổi lại được gì. Không đặt ⇒ phần liên hệ trực tiếp ẩn đi và
// người bán vẫn gửi được yêu cầu qua form (đường luôn có).
const SUPPORT_ZALO = process.env.SUPPORT_ZALO ?? '';
const SUPPORT_PHONE = process.env.SUPPORT_PHONE ?? '';
const SUPPORT_MAIL = process.env.SUPPORT_EMAIL ?? '';
const SUPPORT_HOURS = process.env.SUPPORT_HOURS ?? '';

const TICKET_ST = { open: ['Đang chờ xử lý', 'pending'], resolved: ['Đã xử lý', 'delivered'] };

export function renderHelp(ctx, shopId, tickets, notice, err, form = {}) {
  const base = `/shops/${esc(shopId)}`;
  // Ghi chú xử lý (0108) nằm NGAY trong ô nội dung, không phải một cột thứ tư: nó là CÂU TRẢ
  // LỜI cho việc người bán hỏi — đọc nó quan trọng hơn đọc lại tiêu đề mình vừa gõ.
  const rows = (tickets ?? []).map((t) => [
    { cls: 'stack', html: `${esc(t.subject)}<div class="muted" style="font-size:.8rem">${esc(String(t.body).slice(0, 90))}${String(t.body).length > 90 ? '…' : ''}</div>
      ${t.resolution_note ? `<div class="prosetxt" style="margin-top:8px;padding:8px 10px;background:var(--goodbg);color:var(--good);border-radius:var(--r-xs);font-size:.85rem;text-align:left">${esc(t.resolution_note)}</div>` : ''}` },
    { html: badge(TICKET_ST[t.status]?.[1] ?? 'draft', TICKET_ST[t.status]?.[0] ?? t.status) },
    { cls: 'muted', html: dt(t.created_at) },
  ]);

  const contacts = [
    SUPPORT_ZALO ? ['Zalo', esc(SUPPORT_ZALO)] : null,
    SUPPORT_PHONE ? ['Điện thoại', `<a href="tel:${esc(SUPPORT_PHONE.replace(/\s/g, ''))}">${esc(SUPPORT_PHONE)}</a>`] : null,
    SUPPORT_MAIL ? ['Email', `<a href="mailto:${esc(SUPPORT_MAIL)}">${esc(SUPPORT_MAIL)}</a>`] : null,
  ].filter(Boolean);

  return layout('Trợ giúp', ctx, `
    <h1>Trợ giúp</h1>
    <p class="muted" style="margin-top:-8px">Gặp trục trặc hay không biết làm ở đâu — gửi cho chúng tôi, đừng loay hoay một mình.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice ? `<div class="card" style="border-color:var(--good);background:var(--goodbg);color:var(--good)">${esc(notice)}</div>` : ''}

    ${contacts.length ? `<div class="card">
      <h2 style="margin-top:0">Liên hệ trực tiếp</h2>
      <p class="muted" style="margin-top:-6px">Cần gấp thì gọi hoặc nhắn — nhanh hơn gửi yêu cầu.</p>
      <div class="tblscroll"><table><tbody>
        ${contacts.map(([k, v]) => `<tr><td style="width:140px">${esc(k)}</td><td><strong>${v}</strong></td></tr>`).join('')}
        ${SUPPORT_HOURS ? `<tr><td>Giờ làm việc</td><td class="muted">${esc(SUPPORT_HOURS)}</td></tr>` : ''}
      </tbody></table></div>
    </div>` : ''}

    <div class="card">
      <h2 style="margin-top:0">Gửi yêu cầu hỗ trợ</h2>
      <form method="POST" action="${base}/help">
        <label>Vấn đề của bạn là gì?</label>
        <input name="subject" maxlength="200" required placeholder="vd: Không tạo được mã vận đơn GHN"
               value="${esc(form.subject ?? '')}">
        <label style="margin-top:12px">Mô tả chi tiết</label>
        <textarea name="body" rows="6" maxlength="5000" required
          placeholder="Bạn đang làm gì thì gặp lỗi? Màn hình hiện thông báo gì? Càng cụ thể, chúng tôi càng xử lý nhanh.">${esc(form.body ?? '')}</textarea>
        <p class="muted" style="font-size:13px;margin:8px 0 0">Chúng tôi thấy được tên cửa hàng và email của bạn, không cần ghi lại.</p>
        <div class="savebar"><button class="btn" type="submit">Gửi yêu cầu</button></div>
      </form>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Yêu cầu đã gửi</h2>
      ${rows.length ? `<div class="tblscroll">${tblCards({
        head: [{ html: 'Nội dung' }, { html: 'Trạng thái' }, { html: 'Gửi lúc' }],
        rows,
      })}</div>`
        : '<p class="muted" style="margin-bottom:0">Bạn chưa gửi yêu cầu nào.</p>'}
    </div>`);
}


// Sidebar kiểu SÀN TMĐT (mẫu: TikTok Seller Center). Trước đây là 28 mục phẳng, rồi tới
// bản gom nhóm dùng <details> có tiêu đề IN HOA nhỏ — đọc như "nhãn phân đoạn" chứ không
// như mục bấm được, và mở nhiều nhóm cùng lúc thì danh sách lại dài y như cũ.
//
// Nay: mỗi DANH MỤC LỚN là một hàng bấm được (icon + tên, mũi tên bên phải); bấm thì sổ
// danh mục con; bấm danh mục khác thì cái đang mở TỰ ĐÓNG.
//
// ĐÓNG-CÁI-KHÁC KHÔNG CẦN JS: thuộc tính `name=` trên <details> biến cả cụm thành accordion
// loại trừ ngay trong trình duyệt (giống radio). Trình duyệt cũ chưa hiểu `name` thì bỏ qua
// nó và các nhóm mở độc lập — đúng bằng hành vi bản trước, không ai mất đường đi. Đây là
// lý do KHÔNG dùng radio+:checked: radio đã chọn thì không bỏ chọn được, tức mở rồi không
// đóng lại được, mà đó lại chính là thao tác người dùng mong đợi khi bấm lần hai.
//
// Vài mục ĐỨNG RIÊNG, không nhóm (Tổng quan, Khách hàng, Báo cáo): nhét một mục vào một
// "danh mục lớn" chỉ để cho đều là bắt người dùng bấm hai lần cho một trang.
//
// Nhóm chứa trang ĐANG XEM luôn bung: gập cả nhóm đang đứng thì mất dấu mình đang ở đâu.
// Không JS/cookie nên trạng thái gập không nhớ qua các trang — chấp nhận được, vì mở lại
// đúng nhóm đang dùng là hành vi đủ đúng.
//
// MỌI mục vẫn nằm trong HTML (details chỉ ẩn bằng CSS của trình duyệt) — link không biến
// mất, tìm bằng Ctrl+F vẫn ra, và e2e cũ bám theo href vẫn khớp.
function sideNav(ctx) {
  if (!ctx.shopId) return '';
  const base = `/shops/${esc(ctx.shopId)}`;
  const R = ctx.role;
  // Mục con: [href, nhãn, khoá-active, được-xem]. Nhóm: [tên, icon, [mục con…]].
  // Mục đứng riêng: [href, nhãn, icon, khoá-active, được-xem] — có icon vì nó ngang hàng
  // với tên danh mục lớn.
  const NAV = [
    { solo: [`${base}/overview`, 'Tổng quan', IC_CHART, 'overview', ORDER_ROLES.has(R)] },
    { title: 'Đơn hàng', icon: IC_ORDER, items: [
      [`${base}/orders`, 'Quản lý đơn hàng', 'orders', ORDER_ROLES.has(R)],
      [`${base}/order-requests`, 'Yêu cầu của khách', 'order-requests', ORDER_ROLES.has(R)],
      [`${base}/resolution-cases`, 'Ca cần xử lý', 'resolution-cases', ORDER_ROLES.has(R)],
      [`${base}/notification-deliveries?status=failed`, 'Thông báo lỗi', 'notification-deliveries', ORDER_ROLES.has(R)],
      [`${base}/cod`, 'Đối soát COD', 'cod', ORDER_ROLES.has(R)],
      [`${base}/export`, 'Xuất dữ liệu', 'export', EXPORT_ROLES.has(R)],
    ] },
    { title: 'Sản phẩm', icon: IC_BOX, items: [
      [`${base}/products`, 'Quản lý sản phẩm', 'products', CATALOG_ROLES.has(R)],
      [`${base}/categories`, 'Danh mục', 'categories', CATALOG_ROLES.has(R)],
      // `?status=pending` tường minh, cùng lý do với ô "Đánh giá chờ duyệt" ở Tổng quan: link
      // trần ăn may vào mặc định `status='pending'` của seller/reviews.js. Mục "Thông báo lỗi"
      // ngay dưới đã nêu bộ lọc của nó từ trước — chỗ này là chỗ duy nhất còn sót.
      [`${base}/reviews?status=pending`, 'Đánh giá', 'reviews', CONTENT_ROLES.has(R)],
      [`${base}/questions`, 'Hỏi đáp', 'questions', CONTENT_ROLES.has(R)],
    ] },
    { title: 'Kho vận', icon: IC_WAREHOUSE, items: [
      [`${base}/purchasing`, 'Nhập hàng', 'purchasing', INVENTORY_ROLES.has(R)],
      [`${base}/stocktakes`, 'Kiểm kê', 'stocktakes', INVENTORY_ROLES.has(R)],
      // Tên phải khớp NỘI DUNG: trang này CHỈ nối tài khoản GHN/GHTK. Phí giao hàng nằm ở
      // Cài đặt. Gọi nó là "Vận chuyển" thì người bán đi tìm phí ship sẽ bấm vào đây, không
      // thấy gì, rồi kết luận nền tảng không đặt được phí ship (đo được ở đợt kiểm toán).
      [`${base}/shipping`, 'Hãng vận chuyển', 'shipping', SHIPPING_ROLES.has(R)],
    ] },
    { title: 'Marketing', icon: IC_TREND, items: [
      [`${base}/promotions`, 'Flash sale', 'promotions', CATALOG_ROLES.has(R)],
      [`${base}/coupons`, 'Mã giảm giá', 'coupons', CATALOG_ROLES.has(R)],
      [`${base}/loyalty`, 'Điểm thưởng', 'loyalty', LOYALTY_ROLES.has(R)],
      [`${base}/affiliates`, 'Cộng tác viên', 'affiliates', LOYALTY_ROLES.has(R)],
    ] },
    { solo: [`${base}/customers`, 'Khách hàng', IC_HEART, 'customers', ORDER_ROLES.has(R)] },
    { solo: [`${base}/reports`, 'Báo cáo', IC_CHART2, 'reports', REPORT_ROLES.has(R)] },
    { title: 'Kênh bán', icon: IC_PLUG, items: [
      [`${base}/integrations`, 'Kết nối POS', 'integrations', true],
      [`${base}/api-keys`, 'Bán qua Facebook', 'apikeys', SHIPPING_ROLES.has(R)],
      [`${base}/domains`, 'Tên miền riêng', 'domains', DOMAIN_ROLES.has(R)],
    ] },
    { title: 'Giao diện', icon: IC_PALETTE, items: [
      [`${base}/theme`, 'Giao diện cửa hàng', 'theme', CONTENT_ROLES.has(R)],
      [`${base}/pages`, 'Trang nội dung', 'pages', CONTENT_ROLES.has(R)],
      [`${base}/blog`, 'Blog', 'blog', CONTENT_ROLES.has(R)],
    ] },
    { title: 'Cài đặt', icon: IC_GEAR, items: [
      [`${base}/payment`, 'Nhận tiền', 'payment', PAYMENT_ROLES.has(R)],
      [`${base}/settings`, 'Cài đặt cửa hàng', 'settings', CONTENT_ROLES.has(R)],
      [`${base}/notify`, 'Thông báo', 'notify', SHIPPING_ROLES.has(R)],
      [`${base}/members`, 'Nhân sự', 'members', MEMBER_READ_ROLES.has(R)],
      [`${base}/audit-log`, 'Nhật ký', 'audit', AUDIT_ROLES.has(R)],
    ] },
  ];
  const solo = ([href, label, icon, key, show]) =>
    (show ? `<a href="${href}" class="nav-top${ctx.active === key ? ' on' : ''}">${icon}<span>${label}</span></a>` : '');
  const sub = ([href, label, key, show]) =>
    (show ? `<a href="${href}" class="nav-sub${ctx.active === key ? ' on' : ''}"><span>${label}</span></a>` : '');
  let out = '';
  for (const g of NAV) {
    if (g.solo) { out += `<div class="nav-grp">${solo(g.solo)}</div>`; continue; }
    const links = g.items.map(sub).join('');
    if (!links) continue;                                   // cả nhóm ngoài quyền → bỏ hẳn tiêu đề
    const here = g.items.some(([, , key, show]) => show && ctx.active === key);
    out += `<details class="nav-grp" name="admnav"${here ? ' open' : ''}>`
      + `<summary class="nav-top${here ? ' has-on' : ''}">${g.icon}<span>${esc(g.title)}</span></summary>`
      + `<div class="nav-subs">${links}</div></details>`;
  }
  // Trợ giúp hiện cho MỌI vai: bắt phải có quyền cấu hình mới kêu cứu được là chặn đúng
  // người đang cần giúp — nhân viên gặp lỗi lúc 9 giờ tối là người duy nhất có mặt.
  // Gói dịch vụ cũng vậy: nhân viên thấy "còn 3 ngày" mới nhắc được chủ, và shop bị khoá
  // vì không ai để ý hạn là mất tiền thật cho cả hai bên. Hai mục này KHÔNG gập.
  out += `<div class="nav-grp nav-foot">
    ${solo([`${base}/help`, 'Trợ giúp', IC_LIFE, 'help', true])}
    ${solo([`${base}/billing`, 'Gói dịch vụ', IC_CARD, 'billing', true])}</div>`;
  return `<nav class="side-nav">${out}</nav>`;
}

// Khối JS DUY NHẤT của seller-admin (ADR-011 ràng buộc #3). Điều khiển hoàn toàn bằng
// data-attribute nên thêm trang mới KHÔNG cần thêm JS — hàng rào chống "trượt phạm vi".
//
// Hai tính năng, cả hai đều là LỚP CẢI THIỆN. Tắt JS thì mọi thứ vẫn dùng được đầy đủ:
//   · chọn hàng loạt — tick từng ô rồi bấm nút, y như trước;
//   · xoá/huỷ — form POST vẫn gửi thẳng, chỉ là không có bước hỏi lại.
// Không có đường ghi dữ liệu nào đi qua JS (ràng buộc #5): mọi thứ vẫn là form POST + CSRF.
const ADMIN_JS = `(function(){
  // ── 1. Chọn hàng loạt: ô "chọn tất cả" + đếm số đang chọn ──────────────────
  // Ô master và chỗ đếm được render sẵn nhưng ẨN. Không JS thì người dùng không bao giờ
  // thấy một điều khiển bấm vào chẳng làm gì — đó mới là hỏng, không phải "thiếu tính năng".
  document.querySelectorAll('[data-bulk-all]').forEach(function(all){
    var name = all.getAttribute('data-bulk-all');
    var boxes = Array.prototype.slice.call(
      document.querySelectorAll('input[type=checkbox][name="' + name + '"]'));
    if (!boxes.length) return;
    var out = document.querySelector('[data-bulk-count="' + name + '"]');
    var acts = Array.prototype.slice.call(
      document.querySelectorAll('[data-bulk-act="' + name + '"]'));
    function sync(){
      var n = boxes.filter(function(b){ return b.checked; }).length;
      all.checked = n === boxes.length && n > 0;
      all.indeterminate = n > 0 && n < boxes.length;
      if (out) out.textContent = n ? 'Đang chọn ' + n : 'Chưa chọn dòng nào';
      // Vô hiệu nút khi chưa chọn gì: server vẫn xử lý đúng nếu gửi rỗng (trả bulk_none),
      // nhưng chặn từ đầu thì người bán không mất một vòng tải trang để biết mình quên tick.
      acts.forEach(function(b){ b.disabled = n === 0; });
    }
    all.hidden = false;
    if (out) out.hidden = false;
    all.addEventListener('change', function(){
      boxes.forEach(function(b){ b.checked = all.checked; });
      sync();
    });
    boxes.forEach(function(b){ b.addEventListener('change', sync); });
    sync();
  });

  // ── 2. Hỏi lại trước thao tác phá huỷ ─────────────────────────────────────
  // Đặt trên form (data-confirm) hoặc trên từng nút (nút thắng, vì một form có thể có
  // nhiều nút với formaction khác nhau — ví dụ thanh hàng loạt). Chỉ canh sự kiện submit:
  // requestSubmit(button), Enter và click chuột đều đi qua đúng một đường xác nhận.
  document.addEventListener('submit', function(e){
    var f = e.target;
    if (!f || f.tagName !== 'FORM') return;
    var b = e.submitter;
    var message = b && b.getAttribute ? b.getAttribute('data-confirm') : '';
    if (!message) message = f.getAttribute('data-confirm');
    if (message && !window.confirm(message)) { e.preventDefault(); return; }
  }, true);

  // ── 2b. Nút data-busy: khoá lại sau lần bấm đầu ───────────────────────────
  // CHỈ là tăng cường trải nghiệm. An toàn THẬT nằm ở server: POST /preview dùng
  // INSERT..ON CONFLICT có điều kiện nên gửi lặp KHÔNG xoay token và không giết link vừa
  // tạo, còn go-live thì idempotent (chỉ lật khi đang onboarding). Tắt JS vẫn đúng, chỉ là
  // người dùng không thấy phản hồi "đang xử lý".
  //
  // Gắn ở bubble (không capture) và chạy SAU nhánh xác nhận ở trên: huỷ ở hộp confirm thì
  // e.defaultPrevented = true, khoá nút lúc đó là kẹt vĩnh viễn một nút vẫn dùng được.
  document.addEventListener('submit', function(e){
    var f = e.target, b = e.submitter;
    if (e.defaultPrevented || !f || f.tagName !== 'FORM' || !b) return;
    var busy = b.getAttribute && b.getAttribute('data-busy');
    if (!busy || b.dataset.busyOn) return;
    b.dataset.busyOn = '1';
    // disabled trước khi trình duyệt serialize form sẽ LÀM RƠI giá trị nút khỏi body.
    // Hoãn một nhịp: form đã gửi xong rồi mới khoá.
    var label = b.textContent;
    setTimeout(function(){ b.disabled = true; b.textContent = busy; }, 0);
    // Điều hướng thất bại (mạng đứt, back-forward cache) thì trả nút về dùng được.
    setTimeout(function(){ if (b.disabled) { b.disabled = false; b.textContent = label; delete b.dataset.busyOn; } }, 15000);
  });

  // ── 3. (đã gỡ) Bảng → thẻ trên mobile ─────────────────────────────────────
  // Trước đây khối này đọc chữ ở <th> rồi gán data-label cho từng <td>, và thêm lớp
  // "cards" để CSS ăn. Nghĩa là card-hoá CHỈ chạy khi có JS — vi phạm ràng buộc cố định
  // "JS chỉ là tăng cường". Nay tblCards phát nhãn ngay trong HTML ở server và CSS móc
  // vào thuộc tính data-cards, nên giữ khối này lại chỉ là bản sao thứ hai của cùng một
  // việc — đúng lớp lỗi "hai bản sao sẽ trôi" mà kho này đã bị ba đợt.
})();`;

// Nonce đi theo ctx (`{ ...ctx, nonce }` ở route), KHÔNG phải tham số vị trí của từng hàm
// render. Lý do đổi: đến lượt bật data-cards cho ~14 trang nữa thì mỗi hàm phải mọc thêm
// tham số thứ 5–7, và đặt nhầm thứ tự là hỏng ÂM THẦM — nonce lệch ⇒ trình duyệt chặn
// script, nhưng HTML vẫn đủ nên mọi khẳng định so chuỗi vẫn xanh. Gắn vào ctx thì không
// còn thứ tự để đặt nhầm.
// KHÔNG có ctx.nonce ⇒ KHÔNG chèn <script>, và http.js cũng không mở script-src. Trang
// phải CHỦ ĐỘNG xin JS bằng cách đi qua sendHtmlJs — quên thì hệ khoá cứng như cũ.
export function layout(title, ctx, body) {
  const nonce = ctx?.nonce || '';
  const head = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body>`;
  if (!ctx.user) return `${head}<div class="authwrap">${body}</div></body></html>`;
  const logout = `<form method="POST" action="/logout"><button type="submit">Đăng xuất</button></form>`;
  if (ctx.shopId) {
    return `${head}<div class="shell">
      <input type="checkbox" id="admtoggle" class="admtoggle" aria-label="Mở/đóng menu">
      <aside class="side">
        <a class="side-brand" href="/">${IC_HOME}Quản trị</a>
        ${ctx.shopName ? `<div class="side-shop">${esc(ctx.shopName)}</div>` : ''}
        ${sideNav(ctx)}
        <div class="side-user"><span class="email">${esc(ctx.user.email)}</span>${logout}</div>
      </aside>
      <div class="main">
        <header class="tbar"><label for="admtoggle" class="admburger" aria-hidden="true">☰</label><span class="brand">${esc(ctx.shopName || 'Quản trị')}</span>
          <span class="acc"><a href="/account">Tài khoản</a></span></header>
        <div class="content">${body}</div>
      </div>
    </div>${nonce ? `<script nonce="${esc(nonce)}">${ADMIN_JS}</script>` : ''}</body></html>`;
  }
  return `${head}<div class="main">
    <header class="tbar"><a class="brand" href="/">${IC_HOME}Quản trị</a>
      <span class="acc"><a href="/account">${esc(ctx.user.email)}</a>${logout}</span></header>
    <div class="content">${body}</div>
  </div>${nonce ? `<script nonce="${esc(nonce)}">${ADMIN_JS}</script>` : ''}</body></html>`;
}

// Trang "Giao diện": chủ shop (theme.write) chọn màu thương hiệu → lưu vào theme tokens.
// Không JS: dùng <input type="color"> gốc của trình duyệt. Storefront sanitize khi render.
// Mặc định ĐỒNG BỘ với DEFAULT_TOKENS ở apps/storefront/src/theme.js (bộ "MAISON"
// editorial): đổi bên kia thì đổi cả đây — def chỉ là swatch prefill, không ép giá trị.
export const THEME_COLORS = [
  { key: 'color.primary', label: 'Màu chủ đạo', hint: 'Nút, dải banner đầu trang, thương hiệu', def: '#141414' },
  { key: 'color.accent', label: 'Màu nhấn', hint: 'Nhãn nhỏ, điểm nhấn', def: '#b06a57' },
  { key: 'color.hero-bg', label: 'Màu nền phụ đậm', hint: 'Tile bộ sưu tập, badge còn hàng', def: '#efede8' },
  { key: 'color.text', label: 'Màu chữ', hint: 'Tiêu đề, nội dung', def: '#141414' },
  { key: 'color.surface', label: 'Nền phụ', hint: 'Ô ảnh, chân trang', def: '#f5f4f1' },
];
export const THEME_FONTS = [
  { v: '', label: 'Mặc định (hiện đại)' },
  { v: 'Georgia, serif', label: 'Georgia — serif cổ điển' },
  { v: 'Arial, sans-serif', label: 'Arial' },
  { v: 'Verdana, sans-serif', label: 'Verdana — dễ đọc' },
  { v: 'Tahoma, sans-serif', label: 'Tahoma' },
];
export const THEME_RADII = [
  { v: '4px', label: 'Sắc — editorial (mặc định)' },
  { v: '8px', label: 'Nhỏ — vuông vắn' },
  { v: '12px', label: 'Vừa — mềm mại' },
  { v: '18px', label: 'Lớn — bo tròn' },
];
function themeVal(tokens, key, def) {
  if (tokens && typeof tokens === 'object') {
    if (typeof tokens[key] === 'string') return tokens[key];
    const [a, b] = key.split('.');
    if (tokens[a] && typeof tokens[a][b] === 'string') return tokens[a][b];
  }
  return def;
}
const sectionProps = (layout, name) => (Array.isArray(layout) ? layout.find((s) => s && s.section === name)?.props : null) ?? {};
export function renderTheme(ctx, theme, notice, linkTargets = {}) {
  const tokens = theme?.tokens ?? {};
  // ── Bộ chọn liên kết (chủ shop không phải đoán URL): SELECT đích THẬT (trang cố định +
  // danh mục + trang CMS) + ô "URL tự nhập" ghi đè khi có chữ. No-JS: cả hai luôn hiện;
  // server ưu tiên ô tự nhập; seller vẫn safeLink lần cuối (phòng thủ giữ nguyên).
  const ltCats = Array.isArray(linkTargets.categories) ? linkTargets.categories : [];
  const ltPages = Array.isArray(linkTargets.pages) ? linkTargets.pages : [];
  const linkOptions = [
    ['/', 'Trang chủ'],
    ['/products', 'Tất cả sản phẩm'],
    ...ltCats.map((c) => [`/products?cat=${c.slug}`, `Danh mục: ${c.name}`]),
    ...ltPages.map((p) => [`/pages/${p.slug}`, `Trang: ${p.title}`]),
    ['/blog', 'Blog'],
    ['/checkout/lookup', 'Tra cứu đơn'],
  ];
  const linkPicker = (destName, urlName, saved) => {
    const cur = String(saved ?? '');
    const known = linkOptions.some(([v]) => v === cur);
    const opts = `<option value="">— Chọn đích có sẵn —</option>`
      + linkOptions.map(([v, label]) => `<option value="${esc(v)}"${known && v === cur ? ' selected' : ''}>${esc(label)}</option>`).join('');
    return `<select name="${esc(destName)}">${opts}</select>
      <input name="${esc(urlName)}" maxlength="300" value="${esc(known ? '' : cur)}" placeholder="Hoặc URL tự nhập (ghi đè lựa chọn trên)" style="margin-top:6px">`;
  };
  const hero = sectionProps(theme?.layout, 'hero');
  const grid = sectionProps(theme?.layout, 'product_grid');
  // 4 cam kết (#40): prefill từ features.props.items đã lưu; chưa lưu → ô trống,
  // placeholder = câu mặc định (storefront tự dùng mặc định khi không có items).
  const featureDefaults = THEME_FEATURE_DEFAULTS;
  const featsProps = sectionProps(theme?.layout, 'features');
  const feats = Array.isArray(featsProps.items) ? featsProps.items : [];
  const topbar = sectionProps(theme?.layout, 'header');
  const story = sectionProps(theme?.layout, 'story');
  const promo = sectionProps(theme?.layout, 'promo_banners');
  // Form banner khuyến mãi CHỈ hiện khi bố cục có section promo_banners (preset mỹ phẩm) — tránh
  // bày form thừa cho ngành khác. Chủ shop tải 3 ảnh → dải 3 ô trên trang chủ.
  const hasPromoSection = hero.variant === 'split'
    || (Array.isArray(theme?.layout) && theme.layout.some((s) => s && s.section === 'promo_banners'));
  const heroSide = sectionProps(theme?.layout, 'hero_side');
  // Form banner PHỤ hero hiện khi hero ở chế độ SPLIT (preset mỹ phẩm) — KHÔNG phụ thuộc section
  // hero_side đã tồn tại chưa (shop áp preset TRƯỚC lúc có section vẫn thấy form; heroSideSave tự tạo
  // section lúc lưu). Vẫn nhận nếu section đã có sẵn (áp preset mới).
  const hasHeroSide = hero.variant === 'split'
    || (Array.isArray(theme?.layout) && theme.layout.some((s) => s && s.section === 'hero_side'));
  const curFont = themeVal(tokens, 'font.body', '');
  const curRadius = themeVal(tokens, 'radius', '4px');
  const colorRow = (f) => {
    const raw = themeVal(tokens, f.key, f.def);
    const hex = /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : f.def;
    return `<div style="display:flex;align-items:center;gap:14px;padding:12px 0;border-bottom:1px solid #f1f2f4">
      <input type="color" name="${esc(f.key)}" value="${esc(hex)}" aria-label="${esc(f.label)}" style="width:50px;height:38px;padding:2px;border-radius:8px;flex:0 0 auto;cursor:pointer">
      <div><div style="font-weight:600;font-size:.94rem">${esc(f.label)}</div><div class="muted" style="font-size:.83rem">${esc(f.hint)}</div></div>
      <code style="margin-left:auto">${esc(hex)}</code></div>`;
  };
  const opt = (list, cur) => list.map((o) => `<option value="${esc(o.v)}"${o.v === cur ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  // Banner trang chủ (Phase 5): prefill từ hero.props.slides đã lưu. Mỗi hàng = 1 slide.
  const bannerSlides = Array.isArray(hero.slides) ? hero.slides : [];
  const BANNER_ROWS = 4;
  const bannerRows = Array.from({ length: BANNER_ROWS }, (_, i) => {
    const sl = bannerSlides[i] ?? {};
    const key = typeof sl.image_key === 'string' ? sl.image_key : '';
    return `<div class="card" style="border-color:#e5e7eb">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <strong style="font-size:.95rem">Banner ${i + 1}</strong>
        ${key ? `<label class="muted" style="font-size:.85rem;display:inline-flex;align-items:center;gap:6px"><input type="checkbox" name="remove_${i}" value="1"> Xoá banner này</label>` : ''}
      </div>
      ${key ? `<input type="hidden" name="existing_key_${i}" value="${esc(key)}">
        <div style="margin:8px 0"><img src="/media-public/${esc(key)}" alt="Banner ${i + 1}" style="max-height:110px;max-width:100%;border:1px solid #eceef1;border-radius:8px;background:#fff"></div>` : ''}
      <label>Ảnh banner ${key ? '(chọn ảnh mới để thay)' : ''}</label>
      <input type="file" name="banner_file_${i}" accept="image/*">
      <label>Tiêu đề</label><input name="headline_${i}" maxlength="120" value="${esc(sl.headline ?? '')}" placeholder="Ví dụ: Bộ sưu tập Thu Đông">
      <label>Mô tả ngắn</label><input name="sub_${i}" maxlength="200" value="${esc(sl.sub ?? '')}" placeholder="Ưu đãi tới 30% cho đơn đầu tiên">
      <div class="grid2">
        <div><label>Chữ trên nút</label><input name="button_label_${i}" maxlength="40" value="${esc(sl.button_label ?? '')}" placeholder="Mua ngay"></div>
        <div><label>Liên kết nút</label>${linkPicker(`button_dest_${i}`, `button_link_${i}`, sl.button_link)}</div>
      </div>
    </div>`;
  }).join('');
  // Menu điều hướng "Sản phẩm" (Phase 5b): 3 toggle shortcut cố định (mặc định BẬT khi chưa
  // cấu hình → checked khi != false) + tối đa 6 liên kết tuỳ chỉnh (nhãn + URL). Prefill từ
  // header props đã lưu (topbar). Form no-JS: checkbox không tick = tắt; hàng thiếu nhãn/URL bị bỏ.
  const navLinks = Array.isArray(topbar.nav_links) ? topbar.nav_links : [];
  const NAV_ROWS = 6;
  const navChk = (name, on, label) => `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:.94rem">
    <input type="checkbox" name="${name}" value="1"${on !== false ? ' checked' : ''} style="width:auto"> Hiển thị <strong>${esc(label)}</strong></label>`;
  const navRows = Array.from({ length: NAV_ROWS }, (_, i) => {
    const l = navLinks[i] ?? {};
    return `<div class="grid2" style="padding:5px 0">
      <div><input name="nav_label_${i}" maxlength="40" value="${esc(l.label ?? '')}" placeholder="Tên mục (vd: Về chúng tôi)"></div>
      <div>${linkPicker(`nav_dest_${i}`, `nav_url_${i}`, l.url)}</div>
    </div>`;
  }).join('');
  const navMenuCard = `<div class="card"><h2 style="margin-top:0">Menu điều hướng (dropdown “Sản phẩm”)</h2>
    <p class="muted" style="font-size:.85rem;margin-top:0">Bật/tắt 3 lối tắt cố định trong menu “Sản phẩm” và thêm liên kết riêng. Danh mục sản phẩm luôn tự hiện. Liên kết chỉ nhận đường dẫn nội bộ (bắt đầu <code>/</code>) hoặc <code>https://…</code>.</p>
    ${navChk('menu_show_featured', topbar.menu_show_featured, 'Nổi bật')}
    ${navChk('menu_show_new', topbar.menu_show_new, 'Hàng mới')}
    ${navChk('menu_show_sale', topbar.menu_show_sale, 'Khuyến mãi')}
    <label style="margin-top:10px;display:block">Liên kết tuỳ chỉnh (tối đa ${NAV_ROWS})</label>
    ${navRows}
  </div>`;
  // Kênh bán & mạng xã hội. MỘT bảng cho cả hai chỗ hiện: mỗi dòng là một kênh, tick
  // "nút nổi" thì kênh đó thêm một nút ở góc phải màn hình. Hai danh sách riêng sẽ bắt
  // chủ shop nhập link Zalo hai lần — cùng một thông tin, hai chỗ, chắc chắn lệch nhau.
  const ftrProps = sectionProps(theme?.layout, 'footer');
  const chSaved = Array.isArray(ftrProps.social) ? ftrProps.social : [];
  const chFloat = new Set((Array.isArray(ftrProps.float) ? ftrProps.float : []).map((x) => x && x.kind));
  const CH_ROWS = 6;
  const chRows = Array.from({ length: CH_ROWS }, (_, i) => {
    const c = chSaved[i] ?? {};
    const val = c.kind === 'phone' && typeof c.url === 'string' ? c.url.replace(/^tel:/, '') : (c.url ?? '');
    return `<div style="display:flex;gap:8px;align-items:center;padding:5px 0;flex-wrap:wrap">
      <select name="ch_kind_${i}" style="flex:0 0 150px"><option value="">— Chọn kênh —</option>${
  CHANNEL_OPTIONS.map(([k, n]) => `<option value="${esc(k)}"${c.kind === k ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>
      <input name="ch_url_${i}" maxlength="300" value="${esc(val)}" placeholder="https://facebook.com/… (kênh Gọi ngay: nhập số điện thoại)" style="flex:1 1 260px">
      <label class="muted" style="font-size:.85rem;display:inline-flex;align-items:center;gap:6px;white-space:nowrap">
        <input type="checkbox" name="ch_float_${i}" value="1"${c.kind && chFloat.has(c.kind) ? ' checked' : ''} style="width:auto"> Nút nổi</label>
    </div>`;
  }).join('');
  const channelCard = `<div class="card"><h2 style="margin-top:0">Kênh bán &amp; mạng xã hội</h2>
    <p class="muted" style="font-size:.85rem;margin-top:0">Hiện ở chân trang mọi trang. Tick <strong>Nút nổi</strong> để kênh đó thêm một nút ở góc phải màn hình cho khách bấm liên hệ nhanh (tối đa 4). Mỗi kênh chỉ nhập MỘT lần; dòng thiếu kênh hoặc thiếu địa chỉ sẽ bị bỏ qua.</p>
    ${chRows}
  </div>`;
  const bannerForm = `<form method="POST" action="/shops/${esc(ctx.shopId)}/theme/banner" enctype="multipart/form-data" style="margin-top:16px">
    <div class="card"><h2 style="margin-top:0">Banner trang chủ (ảnh tự tải)</h2>
      <p class="muted" style="font-size:.85rem;margin:0">Tải tối đa ${BANNER_ROWS} ảnh banner riêng cho dải đầu trang. <strong>Có ít nhất 1 banner → thay carousel tự động</strong> (ảnh phủ kín + chữ + nút). Bỏ trống tất cả = dùng hero tự động (chữ + ảnh sản phẩm). <strong>Ảnh NGANG tỉ lệ ~2:1</strong> (vd 1600×760px) hiển thị đẹp nhất; tỉ lệ khác vẫn hiện ĐỦ (hệ thống tự lấp nền mờ, không cắt). Ảnh nén WebP, tối đa 10MB mỗi ảnh.</p>
    </div>
    ${bannerRows}
    <div class="card actions"><button class="btn" type="submit">Lưu banner</button></div>
  </form>`;
  // Banner PHỤ hero (2 ô bên phải hero split) — cùng đường ống upload, nạp vào section hero_side.
  const sideSlides = Array.isArray(heroSide.slides) ? heroSide.slides : [];
  const sideRows = Array.from({ length: 2 }, (_, i) => {
    const sl = sideSlides[i] ?? {};
    const key = typeof sl.image_key === 'string' ? sl.image_key : '';
    return `<div class="card" style="border-color:#e5e7eb">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <strong style="font-size:.95rem">Banner phụ ${i + 1} ${i === 0 ? '(trên)' : '(dưới)'}</strong>
        ${key ? `<label class="muted" style="font-size:.85rem;display:inline-flex;align-items:center;gap:6px"><input type="checkbox" name="side_remove_${i}" value="1"> Xoá</label>` : ''}
      </div>
      ${key ? `<input type="hidden" name="side_existing_${i}" value="${esc(key)}">
        <div style="margin:8px 0"><img src="/media-public/${esc(key)}" alt="Banner phụ ${i + 1}" style="max-height:100px;max-width:100%;border:1px solid #eceef1;border-radius:8px;background:#fff"></div>` : ''}
      <label>Ảnh ${key ? '(chọn ảnh mới để thay)' : ''}</label>
      <input type="file" name="side_file_${i}" accept="image/*">
      <div class="grid2">
        <div><label>Chú thích (tuỳ chọn)</label><input name="side_headline_${i}" maxlength="120" value="${esc(sl.headline ?? '')}" placeholder="Ví dụ: Son thỏi Love Holiday"></div>
        <div><label>Liên kết khi bấm</label>${linkPicker(`side_dest_${i}`, `side_link_${i}`, sl.button_link)}</div>
      </div>
    </div>`;
  }).join('');
  const heroSideForm = hasHeroSide ? `<form method="POST" action="/shops/${esc(ctx.shopId)}/theme/hero-side" enctype="multipart/form-data" style="margin-top:16px">
    <div class="card"><h2 style="margin-top:0">Banner phụ hero (2 ô bên phải)</h2>
      <p class="muted" style="font-size:.85rem;margin:0">Bố cục hero kiểu M.O.I = 1 banner LỚN (chạy vòng, cấu hình ở "Banner trang chủ" phía trên) + 2 banner PHỤ nhỏ bên phải. Tải 2 ảnh phụ ở đây. Bỏ trống = hero về dạng banner lớn full-width. <strong>Ảnh ~2:1</strong> (vd 720×340px) đẹp nhất; tỉ lệ khác vẫn hiện đủ (tự lấp nền mờ). Ảnh nén WebP, tối đa 10MB.</p>
    </div>
    ${sideRows}
    <div class="card actions"><button class="btn" type="submit">Lưu banner phụ</button></div>
  </form>` : '';
  // Banner khuyến mãi (dải 3 ô kiểu M.O.I) — cùng đường ống upload, nạp vào section promo_banners.
  const promoSlides = Array.isArray(promo.slides) ? promo.slides : [];
  const PROMO_ROWS = 3;
  const promoRows = Array.from({ length: PROMO_ROWS }, (_, i) => {
    const sl = promoSlides[i] ?? {};
    const key = typeof sl.image_key === 'string' ? sl.image_key : '';
    return `<div class="card" style="border-color:#e5e7eb">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <strong style="font-size:.95rem">Ô khuyến mãi ${i + 1}</strong>
        ${key ? `<label class="muted" style="font-size:.85rem;display:inline-flex;align-items:center;gap:6px"><input type="checkbox" name="promo_remove_${i}" value="1"> Xoá</label>` : ''}
      </div>
      ${key ? `<input type="hidden" name="promo_existing_${i}" value="${esc(key)}">
        <div style="margin:8px 0"><img src="/media-public/${esc(key)}" alt="Ô khuyến mãi ${i + 1}" style="max-height:110px;max-width:100%;border:1px solid #eceef1;border-radius:8px;background:#fff"></div>` : ''}
      <label>Ảnh ${key ? '(chọn ảnh mới để thay)' : ''}</label>
      <input type="file" name="promo_file_${i}" accept="image/*">
      <div class="grid2">
        <div><label>Chú thích (tuỳ chọn)</label><input name="promo_headline_${i}" maxlength="120" value="${esc(sl.headline ?? '')}" placeholder="Ví dụ: Chuốt mi Perfect Shape"></div>
        <div><label>Liên kết khi bấm</label>${linkPicker(`promo_dest_${i}`, `promo_link_${i}`, sl.button_link)}</div>
      </div>
    </div>`;
  }).join('');
  const promoForm = hasPromoSection ? `<form method="POST" action="/shops/${esc(ctx.shopId)}/theme/promos" enctype="multipart/form-data" style="margin-top:16px">
    <div class="card"><h2 style="margin-top:0">Banner khuyến mãi (dải 3 ô)</h2>
      <p class="muted" style="font-size:.85rem;margin:0">Tải tối đa 3 ảnh khuyến mãi → hiện thành dải 3 ô ngang bằng trên trang chủ (kiểu M.O.I, đặt ngay dưới Flash sale). Bỏ trống tất cả = ẩn dải. <strong>Ảnh ~16:9</strong> (vd 800×450px) đẹp nhất. Ảnh nén WebP, tối đa 10MB mỗi ảnh.</p>
    </div>
    ${promoRows}
    <div class="card actions"><button class="btn" type="submit">Lưu banner khuyến mãi</button></div>
  </form>` : '';
  return layout('Giao diện', ctx, `<h1>Giao diện cửa hàng</h1>
    ${notice ? `<div class="card" style="border-color:#93c5fd;background:#eff6ff;color:#1e40af">${esc(notice)}</div>` : ''}
    <!-- Logo nằm ở Cài đặt (cùng form hồ sơ shop). Người vào "Giao diện" để làm đẹp cửa hàng
         chắc chắn coi logo là việc của trang này — không có lối sang là họ tưởng chưa làm được. -->
    <div class="card" style="background:#eff6ff;border-color:#bfdbfe">
      <p style="margin:0"><strong>Tải logo cửa hàng</strong> ở <a href="/shops/${esc(ctx.shopId)}/settings#logo"><strong>Cài đặt cửa hàng</strong></a>
        — cùng chỗ với tên shop, số điện thoại và địa chỉ kinh doanh.</p>
    </div>
    <form method="GET" action="/shops/${esc(ctx.shopId)}/theme/preset">
      <div class="card" style="border-color:#c7d2fe;background:#f5f7ff">
        <h2 style="margin-top:0">Đổi giao diện theo ngành</h2>
        <p class="muted" style="font-size:.85rem;margin-top:0">Chọn một mẫu ngành để đổi <strong>màu sắc + bố cục + chữ mẫu</strong> trang chủ chỉ với một cú bấm. <strong>Ảnh banner và sản phẩm đã tải sẽ được giữ nguyên.</strong> Bạn sẽ xem trước trước khi áp.</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin:6px 0 12px">
          ${presetChoices().map((p) => `<label style="display:flex;gap:10px;align-items:flex-start;border:1px solid #dbe1f0;border-radius:10px;padding:11px 13px;cursor:pointer;background:#fff">
            <input type="radio" name="preset" value="${esc(p.slug)}" required style="width:auto;margin-top:3px">
            <span><span style="font-weight:600;display:block">${esc(p.name)}</span><span class="muted" style="font-size:.8rem">${esc(p.description)}</span></span>
          </label>`).join('')}
        </div>
        <button class="btn" type="submit">Xem trước &amp; áp mẫu →</button>
      </div>
    </form>
    <form method="POST" action="/shops/${esc(ctx.shopId)}/theme">
      <div class="card"><h2 style="margin-top:0">Màu sắc thương hiệu</h2>
        <p class="muted" style="font-size:.85rem;margin-top:0"><strong>Màu chủ đạo</strong> dùng làm nền banner + thanh thông báo (chữ trắng) → nên chọn <strong>màu đậm/tối</strong> để chữ rõ. Màu quá sáng sẽ khó đọc.</p>
        ${THEME_COLORS.map(colorRow).join('')}
      </div>
      <div class="card"><h2 style="margin-top:0">Kiểu chữ & bo góc</h2>
        <div class="grid2">
          <div><label>Kiểu chữ</label><select name="font">${opt(THEME_FONTS, curFont)}</select></div>
          <div><label>Bo góc</label><select name="radius">${opt(THEME_RADII, curRadius)}</select></div>
        </div>
      </div>
      <div class="card"><h2 style="margin-top:0">Thanh thông báo (trên cùng mọi trang)</h2>
        <label>Nội dung</label><input name="topbar_text" maxlength="120" value="${esc(topbar.topbar_text ?? '')}" placeholder="Giao hàng toàn quốc · Thanh toán COD hoặc chuyển khoản QR">
        <p class="muted" style="font-size:.85rem;margin-bottom:0">Để trống = dùng câu mặc định. Chỉ hứa điều shop làm được (phí ship, đổi trả…).</p>
      </div>
      ${navMenuCard}
      ${channelCard}
      <div class="card"><h2 style="margin-top:0">Nội dung trang chủ (dải hero)</h2>
        <p class="muted" style="font-size:.85rem;margin-top:0">Banner đầu trang tự chuyển tối đa 3 cảnh: cảnh 1 là nội dung dưới đây, cảnh 2-3 lấy tự động từ sản phẩm có ảnh của shop.</p>
        <label>Dòng nhãn nhỏ</label><input name="hero_eyebrow" maxlength="60" value="${esc(hero.eyebrow ?? '')}" placeholder="Cửa hàng chính thức">
        <label>Tiêu đề lớn</label><input name="hero_title" maxlength="120" value="${esc(hero.title ?? '')}" placeholder="(để trống = tên cửa hàng)">
        <label>Mô tả</label><textarea name="hero_subtitle" maxlength="300" rows="2" placeholder="(để trống = câu mặc định)">${esc(hero.subtitle ?? '')}</textarea>
        <label>Tiêu đề khu sản phẩm</label><input name="grid_title" maxlength="80" value="${esc(grid.title ?? '')}" placeholder="Sản phẩm nổi bật">
      </div>
      <div class="card"><h2 style="margin-top:0">Câu chuyện thương hiệu (tuỳ chọn)</h2>
        <p class="muted" style="font-size:.85rem;margin-top:0">Băng giới thiệu gần cuối trang chủ. <strong>Để trống cả hai ô = ẩn hoàn toàn.</strong></p>
        <label>Tiêu đề</label><input name="story_title" maxlength="80" value="${esc(story.title ?? '')}" placeholder="Ví dụ: May thủ công từ vải tự nhiên">
        <label>Đoạn giới thiệu</label><textarea name="story_body" maxlength="400" rows="3" placeholder="Kể ngắn gọn shop của bạn khác biệt ở đâu…">${esc(story.body ?? '')}</textarea>
        <label>Chữ trên nút (tuỳ chọn)</label><input name="story_cta" maxlength="40" value="${esc(story.cta_text ?? '')}" placeholder="Ví dụ: Xem sản phẩm">
      </div>
      <div class="card"><h2 style="margin-top:0">4 cam kết với khách (dải dưới hero)</h2>
        <p class="muted" style="font-size:.85rem;margin-top:0">Để trống = dùng câu mặc định (hiện mờ trong ô). <strong>Sửa cho đúng chính sách THẬT của shop</strong> — ví dụ đừng hứa “Đổi trả trong 7 ngày” nếu shop không áp dụng.</p>
        ${featureDefaults.map((d, i) => `<div style="padding:10px 0;border-bottom:1px solid #f1f2f4">
          <div class="grid2">
            <div><label>Cam kết ${i + 1} — tiêu đề</label><input name="feat_title_${i}" maxlength="80" value="${esc(feats[i]?.title ?? '')}" placeholder="${esc(d.title)}"></div>
            <div><label>Mô tả ngắn</label><input name="feat_desc_${i}" maxlength="200" value="${esc(feats[i]?.desc ?? '')}" placeholder="${esc(d.desc)}"></div>
          </div>
        </div>`).join('')}
      </div>
      <div class="card actions"><button class="btn" type="submit">Lưu giao diện</button>
        <button class="btn alt" type="submit" name="reset" value="1">Khôi phục mặc định</button>
        <a class="btn alt" href="/shops/${esc(ctx.shopId)}/overview">← Quay lại</a></div>
    </form>
    ${bannerForm}
    ${heroSideForm}
    ${promoForm}`);
}

// Màn XÁC NHẬN áp preset ngành (no-JS): tên mẫu + bảng màu xem trước + thứ tự section +
// cảnh báo GIỮ ảnh. 2 nút: Áp mẫu (POST /theme/preset) / Huỷ (về Giao diện). Nhãn nói rõ
// "giữ banner" để chủ shop KHÔNG mất ảnh ngoài ý muốn (khác hẳn nút "Khôi phục mặc định").
export function renderPresetConfirm(ctx, slug, preset) {
  const t = preset.tokens ?? {};
  const swatch = (key, label) => {
    const v = String(t[key] ?? '');
    return /^#[0-9a-fA-F]{6}$/.test(v)
      ? `<div style="text-align:center"><div style="width:100%;height:40px;border-radius:8px;border:1px solid #e5e7eb;background:${esc(v)}"></div><div class="muted" style="font-size:.75rem;margin-top:4px">${esc(label)}</div></div>`
      : '';
  };
  const SECT_VI = { hero: 'Dải hero', features: '4 cam kết', collections: 'Bộ sưu tập', product_grid: 'Lưới sản phẩm', blog: 'Bài viết', story: 'Câu chuyện' };
  const sections = (Array.isArray(preset.layout) ? preset.layout : [])
    .map((s) => s.section).filter((s) => s !== 'header' && s !== 'footer');
  return layout('Xem trước mẫu', ctx, `
    <a class="muted" href="/shops/${esc(ctx.shopId)}/theme">← Giao diện</a>
    <h1>Áp mẫu “${esc(preset.name)}”</h1>
    <div class="card">
      <p class="muted" style="margin-top:0">${esc(preset.description)}</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(70px,1fr));gap:12px;margin:14px 0">
        ${swatch('color.primary', 'Chủ đạo')}${swatch('color.accent', 'Nhấn')}${swatch('color.bg', 'Nền')}${swatch('color.surface', 'Nền phụ')}${swatch('color.hero-bg', 'Dải hero')}${swatch('color.text', 'Chữ')}
      </div>
      <div class="muted" style="font-size:.88rem">Bố cục trang chủ: ${sections.map((s) => esc(SECT_VI[s] ?? s)).join(' · ')}</div>
    </div>
    <div class="card" style="border-color:#fcd34d;background:#fffbeb">
      <p style="margin:0"><strong>Khi áp mẫu này:</strong></p>
      <ul style="margin:8px 0 0;padding-left:20px;font-size:.92rem;line-height:1.6">
        <li>Đổi <strong>toàn bộ màu sắc, bố cục và chữ mẫu</strong> trang chủ theo mẫu ${esc(preset.name)}.</li>
        <li><strong>Giữ nguyên</strong> ảnh banner đã tải, logo cửa hàng, và toàn bộ sản phẩm.</li>
        <li>Bạn vẫn chỉnh tay lại mọi thứ trong trang Giao diện sau khi áp.</li>
      </ul>
    </div>
    <form method="POST" action="/shops/${esc(ctx.shopId)}/theme/preset" class="card actions">
      <input type="hidden" name="preset" value="${esc(slug)}">
      <button class="btn" type="submit">Áp mẫu — giữ banner của tôi</button>
      <a class="btn alt" href="/shops/${esc(ctx.shopId)}/theme">Huỷ</a>
    </form>`);
}

/**
 * Wizard "Thiết lập nhanh" — 2 bước: ① Tên gian hàng → ② Giao diện.
 *
 * VÌ SAO CÓ: người vừa đăng ký xong rơi thẳng vào bảng điều khiển 12 mục menu. docs/64
 * (vai shop ngày-60) và docs/65 (vai lúc sự cố) đều ghi lại cùng một chuyện ở đầu vào:
 * người mới không biết bấm cái gì TRƯỚC, nên bấm lung tung rồi bỏ dở. Wizard rút đúng
 * hai việc phải xong trước khi có thể đưa link cửa hàng cho ai xem: **tên** (khách đọc
 * ở mọi trang, mọi email) và **giao diện** (thứ khách nhìn thấy đầu tiên).
 *
 * KHÔNG dùng shell admin (side nav) — cố ý. Menu 12 mục bên cạnh chính là thứ wizard
 * sinh ra để che đi; để nguyên thì nó lại thành "một trang nữa trong đống trang".
 *
 * KHÔNG tự chuyển hướng vào đây. Cổng vào là nút trong checklist Tổng quan. Ép tự động
 * cần một cột "đã xong wizard" trong DB; đoán bằng dấu hiệu gián tiếp (ví dụ "chưa có
 * SĐT") thì người CỐ Ý không khai SĐT sẽ bị ném lại vào wizard mỗi lần mở trang — cái
 * bẫy đó khó chịu hơn hẳn việc phải bấm thêm một nút.
 *
 * @param step 1 | 2 — bước đang hiện.
 * @param shop bản ghi GET /shops/:id (điền sẵn ô, và là NGUỒN cho read-merge-write ở server).
 */
export function renderOnboarding(ctx, step, shop, err) {
  const base = `/shops/${esc(ctx.shopId)}`;
  const rail = [
    { n: '1', label: 'Tên gian hàng' },
    { n: '2', label: 'Giao diện' },
  ].map((s, i) => {
    const cls = (i + 1) === step ? 'on' : ((i + 1) < step ? 'dn' : '');
    return `<div class="wiz-step ${cls}"><b>${(i + 1) < step ? '✓' : esc(s.n)}</b><span>${esc(s.label)}</span></div>`;
  }).join('');

  let body;
  if (step === 1) {
    // Tên gian hàng: ô DUY NHẤT bắt buộc. Hai ô còn lại hiện ở chân trang cửa hàng và trong
    // email gửi khách — bỏ trống thì khách không có cách nào liên hệ ngoài chờ shop gọi lại.
    const shopUrl = shop?.slug ? `${esc(shop.slug)}.${esc(PLATFORM_DOMAIN)}` : '';
    body = `<h1>Đặt tên gian hàng</h1>
      <p class="wiz-sub">Tên này hiện ở mọi trang khách nhìn thấy, trên hoá đơn và trong email xác nhận đơn. Sửa lại lúc nào cũng được ở <strong>Cài đặt</strong>.</p>
      ${err ? `<div class="wiz-err">${esc(err)}</div>` : ''}
      <form method="POST" action="${base}/onboarding">
        <input type="hidden" name="step" value="1">
        <label for="wname">Tên cửa hàng <span class="rq">*</span></label>
        <input id="wname" name="name" required maxlength="120" value="${esc(shop?.name ?? '')}" placeholder="Ví dụ: Cửa hàng Minh Anh">
        ${shopUrl ? `<p class="wiz-hint">Địa chỉ cửa hàng của bạn: <strong>${shopUrl}</strong> — địa chỉ không đổi theo tên.</p>` : '<div style="height:12px"></div>'}
        <label for="wphone">Số điện thoại liên hệ</label>
        <input id="wphone" name="contact_phone" maxlength="30" value="${esc(shop?.contact_phone ?? '')}" placeholder="0912 345 678" inputmode="tel">
        <p class="wiz-hint">Khách gọi vào số này khi cần hỏi đơn. Để trống thì chân trang cửa hàng không có số nào cả.</p>
        <label for="waddr">Địa chỉ kinh doanh</label>
        <textarea id="waddr" name="business_address" maxlength="300" placeholder="Số nhà, đường, phường/xã, quận/huyện, tỉnh/thành">${esc(shop?.business_address ?? '')}</textarea>
        <p class="wiz-hint">Dùng cho hoá đơn và phần “Liên hệ”. Địa chỉ <em>lấy hàng</em> để tính phí ship khai riêng ở Cài đặt.</p>
        <div class="wiz-act"><button class="wiz-btn" type="submit">Tiếp tục →</button>
          <a class="wiz-skip" href="${base}/overview">Để sau</a></div>
      </form>`;
  } else {
    // Bước 2 KHÔNG đi qua màn xác nhận preset (/theme/preset GET): shop mới chưa có banner
    // hay tuỳ biến nào để mà "giữ lại", nên câu cảnh báo ở màn đó vô nghĩa và chỉ thêm một
    // cú bấm. Shop đã dùng lâu thì vẫn đi lối cũ qua trang Giao diện.
    const sw = (t) => ['color.primary', 'color.accent', 'color.hero-bg', 'color.surface']
      .map((k) => String(t?.[k] ?? ''))
      .filter((v) => /^#[0-9a-fA-F]{6}$/.test(v))
      .map((v) => `<i style="background:${esc(v)}"></i>`).join('');
    const cards = presetChoices().map((p) => {
      const t = getPreset(p.slug)?.tokens ?? {};
      return `<label class="wiz-pick"><span class="wiz-sw">${sw(t)}</span>
        <span class="wiz-pt"><input type="radio" name="preset" value="${esc(p.slug)}" required>
          <span><b>${esc(p.name)}</b><em>${esc(p.description)}</em></span></span></label>`;
    }).join('');
    body = `<h1>Chọn giao diện cửa hàng</h1>
      <p class="wiz-sub">Chọn mẫu gần với ngành hàng của bạn nhất — nó đặt sẵn <strong>màu sắc, bố cục trang chủ và chữ mẫu</strong>. Đổi mẫu khác hoặc chỉnh tay từng màu lúc nào cũng được ở trang <strong>Giao diện</strong>.</p>
      ${err ? `<div class="wiz-err">${esc(err)}</div>` : ''}
      <form method="POST" action="${base}/onboarding">
        <input type="hidden" name="step" value="2">
        <div class="wiz-grid">${cards}</div>
        <div class="wiz-act"><button class="wiz-btn" type="submit">Áp mẫu &amp; vào quản trị →</button>
          <a class="wiz-btn alt" href="${base}/onboarding?step=1">← Quay lại</a>
          <a class="wiz-skip" href="${base}/overview">Để sau</a></div>
      </form>`;
  }

  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Thiết lập cửa hàng</title><style>${STYLE}</style></head><body>
<div class="wiz">
  <div class="wiz-top"><a class="wiz-brand" href="${base}/overview"><i>n</i>Thiết lập cửa hàng</a>
    <a class="wiz-skip" href="${base}/overview">Bỏ qua, vào quản trị →</a></div>
  <div class="wiz-rail">${rail}</div>
  <div class="wiz-card">${body}</div>
</div></body></html>`;
}

// Cài đặt / Hồ sơ cửa hàng (shop.write = owner/admin). Tên + liên hệ + địa chỉ.
/**
 * Dọn ảnh trưng bày không dùng — HAI BƯỚC, không gộp thành một nút.
 *
 * Ảnh banner/logo/ảnh nội dung/ảnh danh mục không có dòng nào trong DB nên khi bị thay
 * thì object cũ nằm lại kho vĩnh viễn. Cần dọn, nhưng dọn là XOÁ TỆP CỦA NGƯỜI KHÁC:
 * bấm "Kiểm tra" chỉ đếm và BÀY ẢNH RA; nút xoá chỉ hiện sau khi đã có danh sách để
 * nhìn. Chưa xem mà đã xoá là kiểu thao tác đã làm hỏng dữ liệu một lần rồi.
 *
 * Chỉ tính ảnh cũ hơn 48 giờ — ảnh vừa tải mà form còn đang mở thì chưa gắn vào đâu cả.
 */
function unusedImagesCard(base, unused) {
  const mb = (n) => (Number(n ?? 0) / 1048576).toFixed(1);
  const body = !unused
    ? `<p class="muted" style="margin-top:0">Ảnh banner, logo cũ, ảnh trong bài viết và ảnh danh mục <strong>đã bị thay</strong> vẫn nằm trong kho và tính vào dung lượng. Bấm để xem có bao nhiêu — <strong>chưa xoá gì cả</strong>.</p>
       <form method="POST" action="${base}/settings/unused-images"><button class="btn alt" type="submit">Kiểm tra ảnh không dùng</button></form>`
    : (unused.total === 0
      ? '<p class="muted" style="margin-top:0">Không có ảnh thừa nào. Kho ảnh sạch.</p>'
      : `<p style="margin-top:0">Có <strong>${esc(unused.total)}</strong> ảnh không còn được dùng ở đâu, chiếm <strong>${esc(mb(unused.total_bytes))} MB</strong>. Chỉ tính ảnh cũ hơn ${esc(unused.grace_hours ?? 48)} giờ.</p>
         <div class="covgrid" style="max-height:220px">${(unused.items ?? []).slice(0, 40).map((i) => `<div class="covpick" style="cursor:default"><img src="${esc(i.url)}" alt="" loading="lazy"><span class="covlab">${esc(mb(i.size_bytes))} MB</span></div>`).join('')}</div>
         ${unused.total > 40 ? `<p class="muted" style="font-size:.83rem">(hiện 40 ảnh đầu)</p>` : ''}
         <form method="POST" action="${base}/settings/unused-images/delete" style="margin-top:10px">
           <button class="btn warn" type="submit">Xoá ${esc(Math.min(unused.total, 200))} ảnh này</button>
         </form>
         <p class="muted" style="font-size:.82rem;margin-bottom:0">Xoá là <strong>không lấy lại được</strong>. Ảnh đang hiển thị ở bất kỳ đâu (trang chủ, bài viết, danh mục, kể cả bản đăng cũ của trang nội dung) đều KHÔNG nằm trong danh sách này.</p>`);
  return `<div class="card"><h2 style="margin-top:0">Dọn ảnh không dùng</h2>${body}</div>`;
}

export function renderShopSettings(ctx, shopId, shop, notice, err, unused, draftSection = null) {
  const base = `/shops/${esc(shopId)}`;
  if (!CONTENT_ROLES.has(ctx.role)) {
    return layout('Cài đặt', ctx, `<h1>Cài đặt cửa hàng</h1><div class="card"><p class="muted">Chỉ <strong>chủ cửa hàng</strong> hoặc <strong>quản trị</strong> mới sửa hồ sơ.</p></div>`);
  }
  const source = shop ?? {};
  const s = draftSection?.section && draftSection?.values
    ? { ...source, ...draftSection.values }
    : source;
  const shipMode = s.ship_mode === 'distance' ? 'distance' : 'region';       // mặc định vùng
  const overMax = s.ship_over_max_behavior === 'reject' ? 'reject' : 'region'; // mặc định giao toàn quốc
  return layout('Cài đặt cửa hàng', ctx, `
    <h1>Cài đặt cửa hàng</h1>
    <p class="muted" style="margin-top:0">Mỗi nhóm được lưu độc lập. Sửa thông tin liên hệ sẽ không làm mất phí ship, ngưỡng tồn hoặc chính sách dữ liệu.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice ? `<div class="card" style="background:#ecfdf5;border-color:#a7f3d0;color:#065f46">${esc(notice)}</div>` : ''}
    <nav class="settings-jump" aria-label="Nhóm cài đặt">
      <a href="#thong-tin">Thông tin<small>Tên, liên hệ và địa chỉ cửa hàng</small></a>
      <a href="#phi-ship">Vận chuyển<small>Phí vùng, khối lượng và phí theo km</small></a>
      <a href="#van-hanh">Vận hành<small>Cảnh báo tồn và chống đơn ảo</small></a>
      <a href="#quyen-rieng-tu">Quyền riêng tư<small>Thời hạn lưu dữ liệu khách hàng</small></a>
    </nav>
    <div class="card" id="thong-tin">
      <h2 style="margin-top:0">Thông tin cửa hàng</h2>
      <p class="muted" style="margin-top:0">Thông tin này hiển thị ở chân trang để khách biết cách liên hệ và tin tưởng cửa hàng.</p>
      <form method="POST" action="${base}/settings/profile">
        <label>Tên cửa hàng</label>
        <input name="name" value="${esc(s.name ?? '')}" required maxlength="200" placeholder="Nhà Xinh Décor">
        <label>Email liên hệ</label>
        <input name="contact_email" type="email" value="${esc(s.contact_email ?? '')}" maxlength="200" placeholder="lienhe@cuahang.vn">
        <label>Số điện thoại</label>
        <input name="contact_phone" value="${esc(s.contact_phone ?? '')}" maxlength="40" placeholder="0912 345 678">
        <label>Địa chỉ kinh doanh</label>
        <textarea name="business_address" maxlength="500" rows="2" placeholder="Số 12, Trần Duy Hưng, Cầu Giấy, Hà Nội">${esc(s.business_address ?? '')}</textarea>
        <div class="actions"><button class="btn" type="submit">Lưu thông tin</button></div>
      </form>
    </div>
    <div class="card" id="logo">
      <h2 style="margin-top:0">Logo cửa hàng</h2>
      ${s.logo_url
        ? `<div style="margin-bottom:10px"><img src="${esc(s.logo_url)}" alt="Logo cửa hàng" style="max-height:64px;max-width:220px;border:1px solid #eceef1;border-radius:8px;padding:6px;background:#fff"></div>`
        : '<p class="muted" style="margin-top:0">Chưa có logo — hiện tên cửa hàng ở đầu trang. Tải ảnh JPEG/PNG/WebP.</p>'}
      <form method="POST" action="${base}/logo" enctype="multipart/form-data" class="actions" style="align-items:center">
        <input type="file" name="file" accept="image/*" required>
        <button class="btn" type="submit">${s.logo_url ? 'Đổi logo' : 'Tải logo'}</button>
      </form>
      ${s.logo_url ? `<form method="POST" action="${base}/logo/remove" style="margin-top:8px"><button class="btn alt sm" type="submit">Gỡ logo</button></form>` : ''}
    </div>
    ${unusedImagesCard(base, unused)}
    <div class="card" id="phi-ship">
      <h2 style="margin-top:0">Phí vận chuyển</h2>
      <form method="POST" action="${base}/settings/shipping">
        <p class="muted" style="margin:0 0 10px;font-size:.85rem">Phí ship áp cho mỗi đơn (tính tự động lúc thanh toán). Để trống = dùng mặc định nền tảng.
          Muốn hãng tới lấy hàng và tự theo dõi vận đơn? Nối tài khoản ở <a href="${base}/shipping">Hãng vận chuyển</a>.</p>
        <div class="actions" style="align-items:end;flex-wrap:wrap">
          <div><label>Phí ship nội miền (VND)</label><input name="ship_fee_vnd" value="${esc(s.ship_fee_vnd ?? '')}" inputmode="numeric" maxlength="8" placeholder="30000" style="width:170px"></div>
          <div><label>Phí ship liên miền (VND)</label><input name="ship_fee_far_vnd" value="${esc(s.ship_fee_far_vnd ?? '')}" inputmode="numeric" maxlength="8" placeholder="để trống = như nội miền" style="width:200px"></div>
          <div><label>Giao hàng từ tỉnh/thành</label><select name="ship_from_province" style="width:200px" aria-label="Tỉnh/thành gửi hàng">
            <option value="">— Chưa chọn —</option>
            ${PROVINCES.map((p) => `<option value="${esc(p)}"${s.ship_from_province === p ? ' selected' : ''}>${esc(p)}</option>`).join('')}
          </select></div>
          <div><label>Miễn phí ship từ (VND)</label><input name="free_ship_threshold_vnd" value="${esc(s.free_ship_threshold_vnd ?? '')}" inputmode="numeric" maxlength="10" placeholder="để trống = không" style="width:200px"></div>
        </div>
        <div class="actions" style="align-items:end;flex-wrap:wrap">
          <div><label>Phụ phí mỗi 500g vượt 500g đầu (VND)</label><input name="ship_extra_per_500g_vnd" value="${esc(s.ship_extra_per_500g_vnd ?? '')}" inputmode="numeric" maxlength="8" placeholder="để trống = không phụ phí" style="width:230px"></div>
          <div><label>Khối lượng mặc định mỗi sản phẩm (gram)</label><input name="default_weight_gram" value="${esc(s.default_weight_gram ?? '')}" inputmode="numeric" maxlength="5" placeholder="500" style="width:230px"></div>
        </div>
        <p class="muted" style="font-size:.8rem;margin:6px 0 0">Nội miền = cùng miền Bắc/Trung/Nam với tỉnh gửi hàng. Cân đơn = tổng khối lượng biến thể (khai ở từng sản phẩm; trống = mặc định). VD: phí 30.000đ, miễn phí từ 500.000đ → đơn ≥ 500k được free ship (miễn cả phụ phí cân).</p>

        <h2 style="margin:22px 0 4px;font-size:1.05rem">Ship theo khoảng cách (km) <span class="muted" style="font-weight:400;font-size:.8rem">— tuỳ chọn nâng cao</span></h2>
        <p class="muted" style="margin:0 0 10px;font-size:.85rem">Khi bật, khách bấm <strong>“📍 Dùng vị trí hiện tại”</strong> lúc thanh toán → phí giao <strong>tính ngay theo quãng đường</strong> từ cửa hàng tới khách (hợp lý cho <strong>khách gần</strong>, shipper riêng của bạn). Phí km <strong>chồng lên</strong> phí vùng ở trên — luôn lấy mức cao hơn, nên khách gần không bao giờ rẻ bất thường.</p>
        <div class="actions" style="align-items:center;flex-wrap:wrap;gap:18px">
          <label style="display:flex;align-items:center;gap:6px;font-weight:600"><input type="radio" name="ship_mode" value="region"${shipMode === 'region' ? ' checked' : ''} style="width:auto"> Tắt — chỉ tính phí vùng</label>
          <label style="display:flex;align-items:center;gap:6px;font-weight:600"><input type="radio" name="ship_mode" value="distance"${shipMode === 'distance' ? ' checked' : ''} style="width:auto"> Bật ship theo km</label>
        </div>
        <div class="actions" style="align-items:end;flex-wrap:wrap;margin-top:10px">
          <div><label>Vĩ độ cửa hàng (latitude)</label><input name="ship_origin_lat" value="${esc(s.ship_origin_lat ?? '')}" inputmode="decimal" maxlength="12" placeholder="vd 21.028511" style="width:180px"></div>
          <div><label>Kinh độ cửa hàng (longitude)</label><input name="ship_origin_lng" value="${esc(s.ship_origin_lng ?? '')}" inputmode="decimal" maxlength="12" placeholder="vd 105.804817" style="width:180px"></div>
        </div>
        <p class="muted" style="font-size:.8rem;margin:6px 0 0">Lấy toạ độ: mở <strong>Google Maps</strong> → bấm giữ (điện thoại) hoặc chuột phải (máy tính) đúng vị trí cửa hàng → hiện dãy số như <em>21.028511, 105.804817</em> → số đầu là <strong>Vĩ độ</strong>, số sau là <strong>Kinh độ</strong>.</p>
        <div class="actions" style="align-items:end;flex-wrap:wrap;margin-top:10px">
          <div><label>Phí cơ bản (VND)</label><input name="ship_base_vnd" value="${esc(s.ship_base_vnd ?? '')}" inputmode="numeric" maxlength="8" placeholder="vd 15000" style="width:160px"></div>
          <div><label>Phí mỗi km (VND)</label><input name="ship_per_km_vnd" value="${esc(s.ship_per_km_vnd ?? '')}" inputmode="numeric" maxlength="7" placeholder="vd 4000" style="width:150px"></div>
          <div><label>Bán kính giao tối đa (km)</label><input name="ship_max_km" value="${esc(s.ship_max_km ?? '')}" inputmode="numeric" maxlength="3" placeholder="vd 20 (1–500)" style="width:180px"></div>
          <div><label>Hệ số đường bộ</label><input name="ship_road_factor" value="${esc(s.ship_road_factor ?? '')}" inputmode="decimal" maxlength="4" placeholder="1.3 (mặc định)" style="width:150px"></div>
        </div>
        <p class="muted" style="font-size:.8rem;margin:8px 0 4px"><strong>Ngoài bán kính giao tối đa</strong> (vd khách ở tỉnh khác, cách hàng nghìn km):</p>
        <div class="actions" style="align-items:center;flex-wrap:wrap;gap:18px">
          <label style="display:flex;align-items:center;gap:6px"><input type="radio" name="ship_over_max_behavior" value="region"${overMax === 'region' ? ' checked' : ''} style="width:auto"> Vẫn giao toàn quốc — tính <strong>phí vùng liên miền</strong> ở trên (khuyến nghị)</label>
          <label style="display:flex;align-items:center;gap:6px"><input type="radio" name="ship_over_max_behavior" value="reject"${overMax === 'reject' ? ' checked' : ''} style="width:auto"> Chỉ giao trong bán kính — từ chối đơn xa</label>
        </div>
        <p class="muted" style="font-size:.8rem;margin:6px 0 0">Phí km = <em>phí cơ bản + (số km × phí mỗi km × hệ số đường bộ)</em>, nhưng không thấp hơn phí vùng. Ví dụ cửa hàng Hà Nội, khách cách 5km: 15.000 + 5×4.000×1.3 ≈ 41.000đ. Khách ở TP.HCM (ngoài bán kính) → rơi về phí liên miền, <strong>không</strong> tính nghìn km. Bật ship theo km <strong>bắt buộc</strong> khai toạ độ + phí cơ bản + phí/km + bán kính, và ở phần trên phải có <strong>tỉnh gửi hàng</strong> + <strong>phí liên miền</strong> (làm mức dự phòng khi khách không bật định vị).</p>
        <div class="actions"><button class="btn" type="submit">Lưu vận chuyển</button></div>
      </form>
    </div>
    <div class="card" id="van-hanh">
      <h2 style="margin-top:0">Vận hành và chống đơn ảo</h2>
      <form method="POST" action="${base}/settings/operations">
        <p class="muted" style="margin:0 0 10px;font-size:.85rem">Đặt ngưỡng để nhân viên nhận cảnh báo tồn thấp và hạn chế đơn spam. Để trống = dùng mặc định nền tảng.</p>
        <div class="actions" style="align-items:end;flex-wrap:wrap">
          <div><label>Cảnh báo sắp hết hàng khi tồn ≤</label><input name="low_stock_threshold" value="${esc(s.low_stock_threshold ?? '')}" inputmode="numeric" maxlength="5" placeholder="mặc định 5" style="width:220px"></div>
        </div>
        <p class="muted" style="margin:0 0 10px;font-size:.85rem">Trần số đơn <strong>chưa xử lý</strong> cùng lúc từ một nguồn mạng / một SĐT. Để trống = dùng mặc định nền tảng. Đặt thấp hơn nếu bị spam; đặt cao hơn nếu nhiều khách thật dùng chung mạng.</p>
        <div class="actions" style="align-items:end;flex-wrap:wrap">
          <div><label>Tối đa đơn chờ / nguồn mạng</label><input name="max_pending_per_ip" value="${esc(s.max_pending_per_ip ?? '')}" inputmode="numeric" maxlength="3" placeholder="mặc định 30 (1–200)" style="width:200px"></div>
          <div><label>Tối đa đơn chờ / SĐT</label><input name="max_pending_per_phone" value="${esc(s.max_pending_per_phone ?? '')}" inputmode="numeric" maxlength="2" placeholder="mặc định 8 (1–50)" style="width:200px"></div>
        </div>
        <p class="muted" style="font-size:.8rem;margin:6px 0 0">Trang thanh toán còn tự chặn bot (bẫy ẩn + câu hỏi xác minh khi một nguồn đặt quá nhiều đơn) — không cần cấu hình.</p>
        <div class="actions"><button class="btn" type="submit">Lưu vận hành</button></div>
      </form>
    </div>
    ${ctx.role === 'owner' ? `<div class="card" id="quyen-rieng-tu">
      <h2 style="margin-top:0">Dữ liệu cá nhân của khách</h2>
      <form method="POST" action="${base}/settings/privacy">
        <p class="muted" style="font-size:.85rem">Tuân thủ Luật Bảo vệ dữ liệu cá nhân 91/2025: tự động <strong>ẩn danh</strong>
          (xoá tên, SĐT, email, địa chỉ — doanh thu và trạng thái đơn giữ nguyên) các đơn ĐÃ XONG cũ hơn
          số tháng dưới đây. Để trống = giữ vĩnh viễn. Chỉ chủ cửa hàng đổi được.</p>
        <div><label>Ẩn danh đơn cũ hơn (tháng)</label>
          <input name="pii_retention_months" value="${esc(s.pii_retention_months ?? '')}" inputmode="numeric" maxlength="3" placeholder="trống = giữ vĩnh viễn (6–120)" style="width:240px"></div>
        <div class="actions"><button class="btn" type="submit">Lưu quyền riêng tư</button></div>
      </form>
    </div>` : `<div class="card" id="quyen-rieng-tu"><h2 style="margin-top:0">Dữ liệu cá nhân của khách</h2><p class="muted" style="margin-bottom:0">Chỉ chủ cửa hàng được thay đổi thời hạn lưu dữ liệu khách.</p></div>`}
    ${ctx.role === 'owner' ? `<div class="card">
      <h2 style="margin-top:0">Bảo mật nhân sự</h2>
      <p class="muted" style="font-size:.85rem">Bật để <strong>bắt buộc mọi nhân sự</strong> của cửa hàng dùng xác thực 2 lớp (2FA).
        Ai chưa bật 2FA sẽ bị <strong>chặn toàn bộ</strong> trang quản trị cửa hàng cho tới khi bật (họ được hướng dẫn bật trong trang Tài khoản).
        Bạn phải đang bật 2FA cho tài khoản của mình trước.</p>
      <form method="POST" action="${base}/settings/require-mfa">
        <label style="display:flex;align-items:center;gap:8px;font-weight:600">
          <input type="checkbox" name="require_mfa" value="1"${s.require_mfa ? ' checked' : ''} style="width:auto"> Bắt buộc nhân sự bật 2FA
        </label>
        <div class="actions" style="margin-top:10px"><button class="btn" type="submit">Lưu cài đặt 2FA</button></div>
      </form>
    </div>` : ''}
    <div class="card"><p class="muted" style="margin:0;font-size:.85rem">Tên miền cửa hàng: <code>${esc(s.slug ?? '')}.nentang.vn</code>.
      Đổi bảng màu ở <a href="${base}/theme">Giao diện</a>; tên miền riêng ở <a href="${base}/domains">Tên miền</a>.</p></div>`);
}

// ── Console nền tảng (super-admin, chỉ platform_staff) ───────────────────────
// Gate ẩn: seller-admin không biết ai là staff → mọi handler gọi platformApi; platform
// requireStaff (introspect + platform_staff + MFA) tự chặn (403 → renderPlatformDenied).
// Gói dịch vụ tải từ DB qua GET /ops/plans (KHÔNG hardcode giá — giá đổi trong DB là
// đổi khắp Console). Giá ghi ngay trong label từng gói: no-JS SSR không tính giá động được.
const planLabel = (p) => `${p.name} — ${money(p.price_vnd_month)}/tháng · ${p.max_products} SP`;
const planOptions = (plans, selected) => (plans ?? []).map((p) =>
  `<option value="${esc(p.code)}"${selected === p.code ? ' selected' : ''}>${esc(planLabel(p))}</option>`).join('');
const PLAT_STATUS = { onboarding: 'Đang thiết lập', active: 'Đang hoạt động', suspended: 'Tạm khoá', terminated: 'Đã chấm dứt' };

export function renderPlatformDenied(ctx) {
  return layout('Console nền tảng', ctx, `<h1>Console nền tảng</h1>
    <div class="card"><p class="muted">Khu vực này chỉ dành cho <strong>nhân viên nền tảng</strong> (đã bật MFA). Tài khoản của bạn không có quyền.</p>
    <a class="btn alt" href="/">← Về bảng điều khiển</a></div>`);
}
// Biểu đồ cột doanh thu THU thuê bao 12 tháng — mirror revenueChart bên dưới:
// SVG sinh ở SERVER (no-JS, hợp CSP), cột var(--pri), tooltip <title> gốc trình duyệt,
// nhãn thưa. Tháng 0đ vẫn có vạch mờ (dữ liệu đã lấp tháng trống ở API).
function platformRevenueChart(months) {
  const pts = (Array.isArray(months) ? months : []).filter((p) => p && p.month);
  if (!pts.length) return '';
  const W = 720, H = 168, BOTTOM = 22, TOP = 10;
  const base = H - BOTTOM, n = pts.length, gap = 8;
  const bw = (W - gap * (n - 1)) / n;
  const vals = pts.map((p) => Math.max(0, Number(p.amount_vnd) || 0));
  const max = Math.max(...vals, 1);
  // Nhãn 'YYYY-MM' → 'M/YYYY' TRỰC TIẾP từ chuỗi — không qua Date() để khỏi lệch múi giờ.
  const mLabel = (ym) => { const p = String(ym).split('-'); return `${Number(p[1])}/${p[0]}`; };
  const q = (v) => Math.round(v * 10) / 10;
  const bars = pts.map((p, i) => {
    const v = vals[i];
    const x = q(i * (bw + gap)), x2 = q(x + bw);
    const h = v > 0 ? Math.max(3, (v / max) * (base - TOP)) : 2;
    const y = q(base - h), r = q(Math.min(4, h / 2));
    const d = `M${x},${base} L${x},${q(y + r)} Q${x},${y} ${q(x + r)},${y} L${q(x2 - r)},${y} Q${x2},${y} ${x2},${q(y + r)} L${x2},${base} Z`;
    const nInv = Number(p.invoices) || 0;
    return `<path d="${d}" fill="${v > 0 ? 'var(--pri)' : 'var(--bd)'}"><title>${esc(mLabel(p.month))} · ${esc(money(v))}${nInv ? ` · ${esc(nInv)} lần thu` : ''}</title></path>`;
  }).join('');
  // Nhãn THƯA (2 tháng/nhãn + tháng cuối) → không chen chữ.
  const labels = pts.map((p, i) => ((i % 2 === 0 || i === n - 1)
    ? `<text x="${(i * (bw + gap) + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="var(--mut)">${esc(mLabel(p.month))}</text>` : '')).join('');
  const total = vals.reduce((a, b) => a + b, 0);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Doanh thu thu thuê bao 12 tháng: tổng ${money(total)}, tháng cao nhất ${money(max)}">
      <line x1="0" y1="${base}" x2="${W}" y2="${base}" stroke="var(--bd)" stroke-width="1"/>
      ${bars}${labels}</svg>`;
}

// Khối "Tổng quan" điều hành trên trang chủ Console. metrics null (API lỗi lẻ) →
// trả chuỗi rỗng, danh sách shop vẫn hiển thị bình thường.
function platformOverview(m) {
  if (!m) return '';
  const st = m.shops_by_sub_status ?? {};
  const tile = (label, value, sub = '') => `<div class="metric"><div class="l">${esc(label)}</div><div class="v">${value}</div>${sub ? `<div class="l" style="margin:4px 0 0">${esc(sub)}</div>` : ''}</div>`;
  const planMix = (m.shops_by_plan ?? []).map((p) => `${esc(p.plan_code)} × ${esc(p.n)}`).join(' · ');
  const chart = platformRevenueChart(m.revenue_by_month);
  const SUB_ST = { trial: 'Dùng thử', active: 'Đang trả phí', past_due: 'Quá hạn', cancelled: 'Đã huỷ' };
  const expRows = (m.expiring_soon ?? []).map((s) => `<tr>
    <td><a href="/platform/shops/${esc(s.id)}">${esc(s.name)}</a></td>
    <td>${esc(s.plan_code ?? '—')} <span class="muted">${esc(SUB_ST[s.sub_status] ?? s.sub_status ?? '')}</span></td>
    <td>${s.current_period_end ? dt(s.current_period_end) : '—'}</td>
    <td class="right"><a class="btn alt sm" href="/platform/shops/${esc(s.id)}">Gia hạn →</a></td></tr>`).join('');
  return `
    <h2 style="margin:18px 0 10px">Tổng quan</h2>
    <div class="metrics">
      ${tile('MRR (doanh thu định kỳ/tháng)', money(m.mrr_vnd ?? 0), 'thuê bao active + quá hạn')}
      ${tile('Đang trả phí', esc(st.active ?? 0), 'thuê bao active')}
      ${tile('Dùng thử', esc(st.trial ?? 0), `quá hạn: ${st.past_due ?? 0} · đã huỷ: ${st.cancelled ?? 0}`)}
      ${tile('Đã thu 30 ngày', money(m.collected_30d_vnd ?? 0))}
      ${tile('Tổng đã thu', money(m.collected_total_vnd ?? 0), 'từ trước tới nay')}
      ${tile('Phiếu hỗ trợ chờ', esc(m.open_tickets ?? 0),
        m.oldest_open_ticket_at ? `chờ lâu nhất: ${ago(m.oldest_open_ticket_at)}` : 'hàng đợi sạch')}
    </div>
    <div class="card"><h2 style="margin-top:0">Doanh thu thu thuê bao 12 tháng</h2>
      ${chart || '<p class="muted">Chưa ghi nhận khoản thu nào.</p>'}
      <p class="muted" style="font-size:.82rem;margin-bottom:0">${planMix ? `Gói đang tính tiền: ${planMix}. ` : ''}Huỷ 90 ngày qua: <strong>${esc(m.churn_90d ?? 0)}</strong> thuê bao (mốc huỷ thật)${Number(m.churn_90d_legacy_estimate) > 0 ? ` + <strong>${esc(m.churn_90d_legacy_estimate)}</strong> ước lượng theo kỳ hết hạn (huỷ trước khi hệ thống ghi mốc)` : ''}.</p></div>
    <div class="card"><h2 style="margin-top:0">Sắp hết hạn (7 ngày)</h2>
      ${expRows ? `<table><thead><tr><th>Cửa hàng</th><th>Gói</th><th>Hết hạn</th><th class="right"></th></tr></thead><tbody>${expRows}</tbody></table>`
        : '<p class="muted">Không có thuê bao nào hết hạn trong 7 ngày tới.</p>'}</div>`;
}

// data = payload /ops/shops: {shops, page, page_size, total, has_more, staff_role}.
// filters = {q, sub_status, page} đã parse ở BFF. Tìm/lọc/phân trang thuần GET (no-JS).
// staff_role='operator' → ẨN nút tạo shop (gate THẬT là minRole 403 phía platform —
// đây chỉ là đỡ bấm nhầm, không phải hàng rào bảo mật).
// ── Console: cấu hình THU TIỀN THUÊ BAO của nền tảng (0124-0128) ────────────
// Hai nửa phải khớp nhau mới thu được tiền, và trước đây cả hai đều phải sửa tay:
// token SePay (DB) + số tài khoản (env). Màn này cho thấy CẢ HAI cùng lúc — cấu hình
// đúng một nửa mà tưởng xong là shop không thấy nút trả tiền, còn mình không biết vì sao.
// TIỀN LẠC của đường tiền NỀN TẢNG (0135): shop đã chuyển tiền nhưng không khớp hoá đơn
// nào. Cảnh báo Telegram chỉ nói CÓ BAO NHIÊU; màn này nói LÀ GÌ và cho đóng lại.
// Mỗi dòng ở đây = một shop sắp bị khoá oan sau ân hạn 7 ngày, nên khối này để TRÊN phần
// cấu hình token: thứ cần hành động hôm nay phải nằm trước thứ cắm một lần rồi thôi.
const LY_DO_TIEN_LAC = {
  no_ref: 'Nội dung chuyển khoản thiếu mã SUB… — không biết của hoá đơn nào',
  charge_not_found: 'Mã SUB… không có trong hệ thống (gõ sai?)',
  charge_cancelled: 'Shop tạo mã mới sau khi đã chuyển theo mã cũ → mã cũ bị huỷ',
  charge_paid: 'Hoá đơn đã thu rồi (chuyển hai lần?)',
  amount_short: 'Về THIẾU so với hoá đơn (ngân hàng trừ phí?) — không có cộng dồn',
  // 0144: tiền rơi vào một tài khoản KHÁC tài khoản in trên mã QR. Câu chữ phải nói rõ phải
  // làm gì, vì đây là lý do duy nhất trong bảng này mà nguyên nhân có thể nằm ở CẤU HÌNH của
  // chính nền tảng (gắn nhầm/gắn thêm tài khoản vào SePay) chứ không phải shop gõ sai.
  account_mismatch: 'Tiền vào TÀI KHOẢN KHÁC với tài khoản in trên mã QR — kiểm lại PLATFORM_BANK_ACCOUNT và danh sách tài khoản gắn vào SePay',
};
function renderTienLac(rows) {
  if (!rows.length) return '';
  const tien = (n) => Number(n).toLocaleString('vi-VN') + '₫';
  return `<div class="card" style="border-color:#fca5a5;background:#fef2f2">
    <h2 style="margin-top:0">⚠ ${rows.length} khoản tiền shop chuyển về CHƯA khớp hoá đơn</h2>
    <p style="margin-top:0">Tiền đã nằm trong tài khoản nhận của bạn nhưng không vào hoá đơn nào.
      Shop tưởng đã trả xong, còn hệ thống vẫn tính là nợ — <strong>hết 7 ngày ân hạn là khoá nhầm</strong>.
      Xử lý: đối chiếu rồi vào shop đó bấm <em>Ghi nhận đã thu</em>, xong quay lại đây đánh dấu đã xử lý.</p>
    <table><thead><tr><th>Lúc</th><th>Số tiền</th><th>Shop</th><th>Nội dung CK</th><th>Vì sao lạc</th><th></th></tr></thead><tbody>
    ${rows.map((u) => `<tr>
      <td class="muted">${dt(u.created_at)}</td>
      <td><strong>${esc(tien(u.amount_vnd))}</strong></td>
      <td>${u.shop_slug ? esc(u.shop_slug) : '<span class="muted">chưa rõ</span>'}</td>
      <td><code>${esc(u.content ?? '')}</code></td>
      <td>${esc(LY_DO_TIEN_LAC[u.reason] ?? u.reason)}</td>
      <td><form method="POST" action="/platform/billing/unmatched/${esc(u.id)}/resolve" style="margin:0">
        <button class="btn" type="submit">Đã xử lý</button></form></td>
    </tr>`).join('')}
    </tbody></table></div>`;
}

export function renderPlatformBilling(ctx, d, err, ok) {
  const okmark = (v) => (v ? '<span style="color:#166534">✓</span>' : '<span style="color:#991b1b">✗</span>');
  const ready = d?.has_token && d?.bank_bin && d?.bank_account && d?.enabled;
  return layout('Thu tiền thuê bao', ctx, `<h1>Thu tiền thuê bao</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${ok ? `<div class="card" style="border-color:#86efac;background:#f0fdf4">${esc(ok)}</div>` : ''}
    <div class="card" style="background:${ready ? '#f0fdf4' : '#fffbeb'};border-color:${ready ? '#86efac' : '#fcd34d'}">
      <h2 style="margin-top:0">${ready ? '✓ Shop tự gia hạn được' : '⚠ Chưa thu tiền tự động được'}</h2>
      <p style="margin:0">${ready
        ? 'Shop thấy nút gia hạn + mã QR trong trang Gói dịch vụ; tiền về là hệ thống tự cộng hạn.'
        : 'Thiếu một trong các mục dưới — shop sẽ KHÔNG thấy nút trả tiền và bạn vẫn phải thu tay.'}</p>
    </div>
    <div class="card"><h2 style="margin-top:0">Tình trạng cấu hình</h2>
      <table><tbody>
        <tr><td>${okmark(d?.bank_bin)} Mã ngân hàng (BIN)</td><td><code>${esc(d?.bank_bin ?? '(chưa đặt)')}</code></td><td class="muted">env PLATFORM_BANK_BIN</td></tr>
        <tr><td>${okmark(d?.bank_account)} Số tài khoản</td><td><code>${esc(d?.bank_account ?? '(chưa đặt)')}</code></td><td class="muted">env PLATFORM_BANK_ACCOUNT</td></tr>
        <tr><td>${okmark(d?.bank_name)} Tên tài khoản</td><td><code>${esc(d?.bank_name ?? '(chưa đặt)')}</code></td><td class="muted">env PLATFORM_BANK_NAME</td></tr>
        <tr><td>${okmark(d?.has_token)} Token SePay</td><td>${d?.has_token ? 'đã lưu (chỉ giữ mã băm)' : '(chưa đặt)'}</td><td class="muted">đặt bên dưới</td></tr>
        <tr><td>${okmark(d?.enabled)} Đang bật</td><td>${d?.enabled ? 'bật' : 'tắt'}</td><td class="muted"></td></tr>
      </tbody></table>
      <p class="muted" style="margin:10px 0 0;font-size:.85rem">Ba dòng env sửa ở file cấu hình triển khai rồi khởi động lại — cố ý không cho sửa qua web: đổi nhầm số tài khoản trên giao diện là tiền của shop chảy đi chỗ khác.</p>
    </div>
    ${renderTienLac(d?.unmatched ?? [])}
    <div class="card"><h2 style="margin-top:0">Token SePay của nền tảng</h2>
      <p class="muted" style="margin-top:0">Token này để webhook nhận ra <strong>tiền shop trả cho bạn</strong> — khác hoàn toàn token per-shop (tiền khách trả cho shop). Chỉ lưu mã băm, không đọc lại được.</p>
      <form method="POST" action="/platform/billing">
        <label>Token SePay mới</label><input name="sepay_token" placeholder="để trống = giữ token cũ, chỉ đổi bật/tắt">
        <label style="display:flex;align-items:center;gap:8px;margin-top:10px">
          <input type="checkbox" name="enabled" value="1"${d?.enabled ? ' checked' : ''} style="width:auto"> Bật thu tiền tự động</label>
        <button class="btn" type="submit" style="margin-top:12px">Lưu</button>
      </form>
    </div>`);
}

export function renderPlatformShops(ctx, data, metrics = null, filters = {}) {
  const shops = data?.shops ?? [];
  const isOperator = data?.staff_role === 'operator';
  const q = filters.q ?? '';
  const subStatus = filters.sub_status ?? '';
  const page = data?.page ?? 1;
  // Link giữ nguyên bộ lọc hiện tại, ghi đè phần cần đổi (chip trạng thái / pager).
  const activity = data?.activity ?? filters.activity ?? '';
  const linkTo = (over = {}) => {
    const sp = new URLSearchParams();
    const v = { q, sub_status: subStatus, activity, page: '', ...over };
    if (v.q) sp.set('q', v.q);
    if (v.sub_status) sp.set('sub_status', v.sub_status);
    if (v.activity) sp.set('activity', v.activity);
    if (v.page && Number(v.page) > 1) sp.set('page', String(v.page));
    const s = sp.toString();
    return `/platform${s ? `?${s}` : ''}`;
  };
  const SUB_ST = { '': 'Tất cả', trial: 'Dùng thử', active: 'Đang trả phí', past_due: 'Quá hạn', cancelled: 'Đã huỷ' };
  const chips = Object.entries(SUB_ST).map(([k, label]) =>
    `<a class="btn sm ${k === subStatus ? '' : 'alt'}" href="${esc(linkTo({ sub_status: k }))}">${esc(label)}</a>`).join(' ');
  const rows = shops.map((s) => `<tr>
    <td><a href="/platform/shops/${esc(s.id)}">${esc(s.name)}</a><div class="muted" style="font-size:.8rem">${esc(s.subdomain ?? s.slug)}</div></td>
    <td>${badge(s.status, PLAT_STATUS[s.status] ?? s.status)}</td>
    <td>${esc(s.plan_code ?? '—')} <span class="muted">${esc(s.sub_status ?? '')}</span></td>
    <td>${s.first_product_at
      ? `<span class="muted" title="Sản phẩm đầu tiên: ${esc(dt(s.first_product_at))}">✓ đã đăng</span>`
      : '<span class="badge draft" title="Chưa đăng sản phẩm nào — khách vào chưa mua được gì">⚠ chưa có SP</span>'}</td>
    <td class="right">${money(s.total_collected_vnd ?? 0)}</td>
    <td class="muted">${dt(s.created_at)}</td></tr>`).join('');
  const total = data?.total ?? shops.length;
  const pager = (page > 1 || data?.has_more) ? `<div class="actions" style="margin-top:10px">
      ${page > 1 ? `<a class="btn alt sm" href="${esc(linkTo({ page: page - 1 }))}">← Trang trước</a>` : ''}
      <span class="muted" style="align-self:center">Trang ${esc(page)}</span>
      ${data?.has_more ? `<a class="btn alt sm" href="${esc(linkTo({ page: page + 1 }))}">Trang sau →</a>` : ''}
    </div>` : '';
  return layout('Console nền tảng', ctx, `
    <div class="toolbar"><h1 style="margin:0">Console nền tảng</h1>
      <div class="actions" style="gap:8px;flex-wrap:wrap">
        <a class="btn alt" href="/platform/support">Phiếu hỗ trợ${Number(metrics?.open_tickets) > 0 ? ` (${esc(metrics.open_tickets)})` : ''}</a>
        <a class="btn alt" href="/platform/billing">Thu tiền thuê bao</a>
        <a class="btn alt" href="/platform/usage">Đo luồng dùng</a>
        ${isOperator ? '<span class="muted" style="align-self:center">Vai trò: operator (chỉ xem)</span>' : '<a class="btn" href="/platform/new">+ Tạo cửa hàng</a>'}
      </div></div>
    ${platformOverview(metrics)}
    <div class="card">
      <form method="GET" action="/platform" class="actions" style="align-items:end;flex-wrap:wrap;margin-bottom:10px">
        <div><label>Tìm cửa hàng</label><input name="q" value="${esc(q)}" maxlength="100" placeholder="tên hoặc slug" style="width:240px"></div>
        ${subStatus ? `<input type="hidden" name="sub_status" value="${esc(subStatus)}">` : ''}
        <button class="btn sm" type="submit">Tìm</button>
        ${q || subStatus ? `<a class="btn alt sm" href="/platform">Xoá lọc</a>` : ''}
      </form>
      <div class="actions" style="flex-wrap:wrap;margin-bottom:10px">${chips}</div>
      <div class="actions" style="flex-wrap:wrap;margin-bottom:10px">
        <a class="btn sm ${activity === 'noproduct' ? '' : 'alt'}" href="${esc(linkTo({ activity: activity === 'noproduct' ? '' : 'noproduct' }))}"
           title="Nhóm cần gọi điện giúp: đã mở shop nhưng chưa đăng sản phẩm nào">⚠ Chưa có sản phẩm</a>
      </div>
      ${shops.length ? `<table><thead><tr><th>Cửa hàng</th><th>Trạng thái</th><th>Gói</th><th>Hàng hoá</th><th class="right">Đã thu</th><th>Tạo</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="muted" style="margin-top:10px">${esc(shops.length)} / ${esc(total)} cửa hàng${q ? ` khớp “${esc(q)}”` : ''}.</p>${pager}`
      : `<p class="muted">${q || subStatus ? 'Không có cửa hàng nào khớp bộ lọc.' : 'Chưa có cửa hàng nào. Bấm “Tạo cửa hàng”.'}</p>`}</div>`);
}
// ── Hàng đợi phiếu hỗ trợ (0108) ─────────────────────────────────────────────
// Thời gian TƯƠNG ĐỐI, không phải dấu thời gian. Ở đây câu hỏi duy nhất là "người này đã chờ
// bao lâu rồi" — "3 ngày trước" trả lời ngay, "14:32 27/07" bắt người đọc tự trừ.
const ago = (ts) => {
  const ms = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'vừa xong';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'vừa xong';
  if (m < 60) return `${m} phút trước`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} giờ trước`;
  return `${Math.floor(h / 24)} ngày trước`;
};
// Ngưỡng TRỄ. Người bán gặp sự cố mà chờ quá một ngày thì lời hứa hỗ trợ đã hỏng, dù cuối
// cùng có trả lời. Danh sách xếp cũ-trước nên phiếu trễ tự nổi lên đầu — không cần lọc riêng.
const LATE_MS = 24 * 3600 * 1000;
const TKT_SUB_ST = { trial: 'dùng thử', active: 'đang trả phí', past_due: 'quá hạn', cancelled: 'đã huỷ' };
// Thân phiếu dài thì gập lại sau <details> (thẻ gốc, no-JS): 20 phiếu × 5000 ký tự mở sẵn
// biến hàng đợi thành một bức tường chữ, và người ta sẽ ngừng đọc từ phiếu thứ ba.
const TKT_FOLD = 600;

// Bối cảnh chẩn đoán (0109) — HIỂN THỊ NHƯ MỘT DÒNG NGƯỜI ĐỌC ĐƯỢC, không phải đổ JSON.
// Đổ nguyên object ra màn hình là đẩy việc phân tích sang người đang vội. Ba mẩu này tồn tại
// để trả lời sẵn "vì sao anh không thấy nút" — phải đọc được trong một cái liếc.
//
// VAI làm nổi bật vì nó là nguyên nhân hay gặp nhất mà cũng hay bị bỏ qua nhất: chủ shop báo
// lỗi và nhân viên báo lỗi là hai câu chuyện khác nhau.
const DIAG_ROLE = { owner: 'chủ shop', admin: 'quản trị', catalog_manager: 'quản lý SP', order_manager: 'quản lý đơn' };
const DIAG_SHOP = { onboarding: 'shop đang thiết lập', suspended: 'shop TẠM KHOÁ', terminated: 'shop đã đóng' };
// Nhận diện máy từ user-agent bằng vài mẫu thô. Cố ý KHÔNG dùng thư viện: ta chỉ cần biết
// "iPhone hay máy tính", sai một chút cũng không hại — còn dựng cả bộ phân tích UA cho một
// dòng chú thích thì mới là sai chỗ.
function uaShort(ua) {
  const s = String(ua ?? '');
  if (!s) return null;
  const os = /iPhone|iPad/.test(s) ? 'iPhone/iPad' : /Android/.test(s) ? 'Android'
    : /Mac OS X/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : null;
  const br = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera'
    : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : /Firefox\//.test(s) ? 'Firefox' : null;
  return [os, br].filter(Boolean).join(' · ') || null;
}
function diagLine(diag) {
  if (!diag || typeof diag !== 'object') return '';
  const role = DIAG_ROLE[diag.role] ?? diag.role;
  const shop = DIAG_SHOP[diag.shop_status];   // 'active' KHÔNG hiện — bình thường thì im lặng
  const ua = uaShort(diag.ua);
  return [
    role ? `<span>Vai: <strong>${esc(role)}</strong></span>` : '',
    shop ? `<span class="muted">${esc(shop)}</span>` : '',
    ua ? `<span class="muted">${esc(ua)}</span>` : '',
  ].filter(Boolean).join('');
}

// ── ĐO LUỒNG DÙNG (0141) ─────────────────────────────────────────────────────
// Bảng xếp hạng NGƯỢC: ít shop dùng nhất lên đầu. Bảng xuôi thì ai cũng đoán được kết quả
// (danh sách đơn, danh sách SP luôn đứng nhất) — nó không dạy ta điều gì. Thứ đứng đầu bảng
// ngược mới là thứ đang âm thầm thu thuế bảo trì lên đúng một người.
//
// Cột quan trọng nhất là SỐ SHOP, không phải số lượt: một shop bấm 500 lần vẫn là MỘT shop
// cần nó. "10% shop dùng" là ngưỡng đã chốt để cân nhắc gỡ hoặc giấu vào mục nâng cao.
export function renderPlatformUsage(ctx, data, opt) {
  const rows = data?.rows ?? [];
  const shops = Number(data?.active_shops ?? 0);
  const pctOf = (n) => (shops > 0 ? Math.round((Number(n) / shops) * 100) : null);
  const dOpt = (v) => `<option value="${v}"${opt.days === v ? ' selected' : ''}>${v} ngày</option>`;
  const body = rows.map((r) => {
    const pct = pctOf(r.shops);
    // Ngưỡng 10%: dưới ngưỡng thì tô để mắt bắt được ngay, KHÔNG tự động kết luận "gỡ đi" —
    // một tính năng ít shop dùng vẫn có thể là tính năng giữ chân đúng shop trả tiền nhiều nhất.
    const yeu = pct !== null && pct < 10;
    return [
      { cls: 'muted', html: esc(r.service) },
      { html: `<code>${esc(r.route)}</code>` },
      { cls: 'num right', html: `<strong${yeu ? ' style="color:var(--bad)"' : ''}>${esc(r.shops)}</strong>${pct !== null ? ` <span class="muted">(${pct}%)</span>` : ''}` },
      { cls: 'num right muted', html: esc(r.hits) },
      { cls: 'muted', html: esc(String(r.last_day ?? '').slice(0, 10)) },
    ];
  });
  return layout('Đo luồng dùng', ctx, `
    <a class="muted" href="/platform">← Console nền tảng</a>
    <div class="toolbar"><h1 style="margin:0">Đo luồng dùng</h1></div>
    <p class="muted" style="margin-top:-8px">Cái gì đang được dùng, <strong>bao nhiêu cửa hàng</strong> dùng, lần cuối khi nào.
      Xếp <strong>ít cửa hàng dùng nhất lên đầu</strong> — thứ ở đầu bảng này là thứ đang tốn công bảo trì mà chưa chắc ai cần.
      Chỉ đếm <em>đường dẫn đã chuẩn hoá</em>: không có mã khách, không có tham số, không lần được ra một con người.</p>
    ${data?.measuring_since
      ? `<div class="card"><strong>${esc(shops)}</strong> cửa hàng đang hoạt động ·
           đo từ <strong>${esc(String(data.measuring_since).slice(0, 10))}</strong>
           đến <strong>${esc(String(data.measured_until ?? '').slice(0, 10))}</strong>.
           <div class="muted" style="margin-top:6px">Số liệu chỉ đáng tin sau khi đã đo đủ vài tuần với cửa hàng thật.
             Đo được vài ngày mà kết luận "tính năng này chết" là đọc sai con số.</div></div>`
      : '<div class="card">Chưa có số liệu nào. Bảng sẽ có dữ liệu sau vài phút kể từ lượt dùng đầu tiên (worker gộp theo chu kỳ 5 phút).</div>'}
    <div class="card"><form method="GET" action="/platform/usage" class="filters">
      <div><label>Khoảng</label><select name="days">${dOpt(7)}${dOpt(30)}${dOpt(90)}${dOpt(365)}</select></div>
      <div><label>Dịch vụ</label><input name="service" value="${esc(opt.service ?? '')}" maxlength="32" placeholder="tất cả" style="width:160px"></div>
      <div><button class="btn alt sm" type="submit">Xem</button></div>
    </form></div>
    <div class="card">${rows.length ? `<div class="tblscroll">${tblCards({
      head: [{ html: 'Dịch vụ' }, { html: 'Đường dẫn' }, { html: 'Cửa hàng dùng', cls: 'right' }, { html: 'Lượt', cls: 'right' }, { html: 'Lần cuối' }],
      rows: body,
    })}</div>
      <p class="muted" style="margin-top:12px;font-size:.85rem">
        <strong>Chưa trả lời được:</strong> đường dẫn <em>chưa ai chạm bao giờ</em> thì không xuất hiện ở đây — bảng này chỉ
        biết những gì đã được dùng ít nhất một lần. Muốn có danh sách "chưa từng chạm" thì cần một bản kê toàn bộ đường dẫn
        của mọi dịch vụ; đó là việc riêng, chưa làm.</p>`
      : '<p class="muted">Chưa có lượt dùng nào khớp bộ lọc.</p>'}</div>`);
}

export function renderPlatformSupport(ctx, data, opts = {}) {
  const tickets = data?.tickets ?? [];
  const status = data?.status === 'resolved' ? 'resolved' : 'open';
  const counts = data?.counts ?? {};
  const page = data?.page ?? 1;
  // Ô lọc ĐI THEO khi đổi tab / lật trang. Gõ xong rồi bấm sang tab kia mà mất chữ vừa gõ là
  // kiểu nhỏ-nhặt khiến người ta thôi dùng bộ lọc.
  const q = data?.q ?? '';
  const qs = (o = {}) => {
    const sp = new URLSearchParams();
    const v = { status, q, page: 1, ...o };
    sp.set('status', v.status);
    if (v.q) sp.set('q', v.q);
    if (Number(v.page) > 1) sp.set('page', String(v.page));
    return `/platform/support?${sp.toString()}`;
  };
  const linkTo = (st, pg = 1) => qs({ status: st, page: pg });
  const tab = (st, label) => `<a class="btn sm ${st === status ? '' : 'alt'}" href="${esc(linkTo(st))}">${esc(label)} (${esc(counts[st] ?? 0)})</a>`;

  const card = (t) => {
    const late = status === 'open' && (Date.now() - new Date(t.created_at).getTime()) > LATE_MS;
    const body = String(t.body ?? '');
    const long = body.length > TKT_FOLD;
    const mail = String(t.from_email ?? '').replace(/[^A-Za-z0-9@._+-]/g, '');
    return `<div class="card tkt${late ? ' late' : ''}">
      <div class="toolbar" style="margin-bottom:6px;gap:10px">
        <div class="actions" style="gap:8px;flex-wrap:wrap">
          <strong>${esc(ago(t.created_at))}</strong>
          ${late ? badge('cancelled', 'Quá hạn 24h') : ''}
          ${status === 'resolved' ? badge('delivered', `Xong ${esc(ago(t.resolved_at ?? t.created_at))}`) : ''}
        </div>
        <a class="btn alt sm" href="/platform/shops/${esc(t.shop_id)}">${esc(t.shop_name ?? t.shop_slug ?? 'cửa hàng')} →</a>
      </div>
      <h2 style="margin:0;font-size:1.05rem">${esc(t.subject)}</h2>
      ${long
        ? `<p class="prosetxt">${esc(body.slice(0, TKT_FOLD))}…</p>
           <details><summary>Xem đầy đủ</summary><p class="prosetxt">${esc(body)}</p></details>`
        : `<p class="prosetxt">${esc(body)}</p>`}
      <div class="tmeta">
        <span class="muted">${esc(t.plan_code ?? 'chưa có gói')} · ${esc(TKT_SUB_ST[t.sub_status] ?? t.sub_status ?? '—')}</span>
        ${diagLine(t.diag)}
        ${mail ? `<a href="mailto:${esc(mail)}?subject=${esc(encodeURIComponent(`[Hỗ trợ] ${t.subject}`))}">${esc(mail)}</a>` : '<span class="muted">không rõ người gửi</span>'}
        ${t.context_url ? `<span class="muted">Trang: <code>${esc(String(t.context_url).slice(0, 120))}</code></span>` : ''}
      </div>
      ${status === 'open' ? `<form method="POST" action="/platform/support/${esc(t.id)}/resolve" style="margin-top:12px">
          <input type="hidden" name="status" value="open">
          <label>Đã xử lý ra sao? <span class="muted">(người bán đọc được — để trống cũng gửi được)</span></label>
          <textarea name="note" rows="2" maxlength="2000" placeholder="vd: Đã bật lại kết nối GHN cho shop, thử tạo vận đơn lại giúp anh nhé."></textarea>
          <div class="savebar"><button class="btn" type="submit">Đánh dấu đã xử lý</button></div>
        </form>`
        : `${t.resolution_note ? `<div class="prosetxt" style="margin-top:12px;padding:10px 12px;background:var(--goodbg);color:var(--good);border-radius:var(--r-xs)">${esc(t.resolution_note)}</div>`
            : '<p class="muted" style="margin:12px 0 0;font-size:.85rem">Xử lý xong nhưng không ghi chú gì.</p>'}
          <form method="POST" action="/platform/support/${esc(t.id)}/reopen" style="margin-top:10px">
            <input type="hidden" name="status" value="resolved">
            <button class="btn alt sm" type="submit">Mở lại phiếu</button>
          </form>`}
    </div>`;
  };

  // Trống VÌ LỌC khác hẳn trống VÌ HẾT VIỆC — nói "hàng đợi sạch" khi người ta vừa gõ nhầm
  // một chữ là nói dối về trạng thái hệ thống.
  const empty = q
    ? `<div class="card"><p class="muted" style="margin:0">Không có phiếu nào khớp “${esc(q)}” trong tab này. <a href="${esc(qs({ q: '' }))}">Xoá lọc</a></p></div>`
    : status === 'open'
      ? '<div class="card"><p class="muted" style="margin:0">Không còn phiếu nào đang chờ. Hàng đợi sạch.</p></div>'
      : '<div class="card"><p class="muted" style="margin:0">Chưa có phiếu nào được xử lý.</p></div>';
  const pager = (page > 1 || data?.has_more) ? `<div class="actions" style="margin-top:10px">
      ${page > 1 ? `<a class="btn alt sm" href="${esc(linkTo(status, page - 1))}">← Trang trước</a>` : ''}
      <span class="muted" style="align-self:center">Trang ${esc(page)}</span>
      ${data?.has_more ? `<a class="btn alt sm" href="${esc(linkTo(status, page + 1))}">Trang sau →</a>` : ''}
    </div>` : '';

  return layout('Phiếu hỗ trợ', ctx, `
    <a class="muted" href="/platform">← Console nền tảng</a>
    <div class="toolbar"><h1 style="margin:0">Phiếu hỗ trợ</h1></div>
    ${opts.err ? `<div class="err">${esc(opts.err)}</div>` : ''}
    ${opts.notice ? `<div class="card" style="border-color:var(--good);background:var(--goodbg);color:var(--good)">${esc(opts.notice)}</div>` : ''}
    <div class="actions" style="flex-wrap:wrap;margin-bottom:12px">${tab('open', 'Đang chờ')} ${tab('resolved', 'Đã xử lý')}</div>
    <form method="GET" action="/platform/support" class="actions" style="align-items:end;flex-wrap:wrap;margin-bottom:12px">
      <input type="hidden" name="status" value="${esc(status)}">
      <div><label>Lọc</label><input name="q" value="${esc(q)}" maxlength="100"
        placeholder="tên shop hoặc nội dung phiếu" style="width:280px"></div>
      <button class="btn sm" type="submit">Tìm</button>
      ${q ? `<a class="btn alt sm" href="${esc(qs({ q: '' }))}">Xoá lọc</a>` : ''}
    </form>
    ${q ? `<p class="muted" style="margin:-6px 0 12px">${esc(tickets.length)} phiếu khớp “${esc(q)}” trong tab này. Số trên tab vẫn là TỔNG.</p>` : ''}
    ${status === 'open' && tickets.length && !q
      ? '<p class="muted" style="margin:-4px 0 12px">Xếp theo thứ tự CHỜ LÂU NHẤT trước.</p>' : ''}
    ${tickets.length ? tickets.map(card).join('') : empty}
    ${pager}`);
}

export function renderPlatformShopNew(ctx, err, f = {}, plans = []) {
  return layout('Tạo cửa hàng', ctx, `
    <a class="muted" href="/platform">← Console nền tảng</a>
    <h1>Tạo cửa hàng mới</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <div class="card"><form method="POST" action="/platform">
      <label>Tên cửa hàng</label><input name="name" value="${esc(f.name ?? '')}" required maxlength="200" placeholder="Nhà Xinh Décor">
      <label>Subdomain (slug)</label><input name="slug" value="${esc(f.slug ?? '')}" required pattern="[a-z0-9-]+" maxlength="40" placeholder="nha-xinh">
      <div class="muted" style="font-size:.82rem;margin:2px 0 8px">→ <code>&lt;slug&gt;.nentang.vn</code> (chỉ a-z, 0-9, gạch ngang)</div>
      <label>Gói dịch vụ</label><select name="plan_code">${planOptions(plans, f.plan_code)}</select>
      <div class="actions" style="margin-top:14px"><button class="btn" type="submit">Tạo cửa hàng</button></div>
    </form></div>`);
}
// Interstitial mật khẩu cho thao tác phá hoại của STAFF (mirror renderDomainStepUp):
// platform trả 403 step_up_required → form này; hidden fields giữ nguyên tham số
// renew (tháng/gói/tiền/ghi chú) để retry sau khi xác thực không mất dữ liệu đã gõ.
export function renderPlatformStepUp(ctx, shopId, action, params, err) {
  const base = `/platform/shops/${esc(shopId)}`;
  const label = { suspend: 'tạm khoá cửa hàng', restore: 'mở lại cửa hàng', renew: 'gia hạn / ghi nhận thu tiền', terminate: 'CHẤM DỨT HỢP ĐỒNG cửa hàng' }[action] ?? action;
  const hidden = Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return layout('Xác nhận mật khẩu', ctx, `<div class="center"><div class="card">
    <h1>Xác nhận mật khẩu</h1>
    <p class="muted">Thao tác nhạy cảm (${esc(label)}) cần xác thực lại. Nhập mật khẩu để tiếp tục.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="${base}/step-up">
      <input type="hidden" name="__action" value="${esc(action)}">${hidden}
      <label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">
      <button class="btn" type="submit" style="width:100%;margin-top:12px">Xác nhận &amp; tiếp tục</button>
    </form>
    <a class="muted" href="${base}" style="display:inline-block;margin-top:10px">← Huỷ</a>
  </div></div>`);
}

// Interstitial mật khẩu cho màn THU TIỀN của nền tảng. Không dùng lại renderPlatformStepUp
// được: form kia đóng đinh vào `/platform/shops/:id/step-up`, mà màn này không thuộc shop nào.
//
// Token SePay vừa gõ được MANG THEO trong hidden field — cân nhắc có thật, không phải sơ ý.
// Bỏ đi thì người dùng gõ lại token dài từ đầu sau mỗi lần xác thực, đúng kiểu "ngõ cụt mất
// dữ liệu" mà dự án đã phải vá một lần ở QR checkout. Bí mật này nằm trong POST body và
// trong DOM của CHÍNH trang họ vừa gõ nó vào, trên phiên đã đăng nhập của họ — không vào URL,
// không vào lịch sử trình duyệt, không vào log. Đổi lại là không mất dữ liệu.
export function renderPlatformBillingStepUp(ctx, p, err) {
  const hidden = Object.entries(p).filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return layout('Xác nhận mật khẩu', ctx, `<div class="center"><div class="card">
    <h1>Xác nhận mật khẩu</h1>
    <p class="muted">Đổi cấu hình <strong>thu tiền thuê bao</strong> là thao tác chạm đường tiền của nền tảng — cần xác thực lại. Nhập mật khẩu để lưu tiếp; những gì bạn vừa nhập được giữ nguyên.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="/platform/billing/step-up">
      ${hidden}
      <label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">
      <button class="btn" type="submit" style="width:100%;margin-top:12px">Xác nhận &amp; lưu</button>
    </form>
    <a class="muted" href="/platform/billing" style="display:inline-block;margin-top:10px">← Huỷ</a>
  </div></div>`);
}

// shop.staff_role (trả kèm từ GET /ops/shops/:id) = 'operator' → ẨN mọi form ghi
// (khoá/mở, gia hạn, mời, offboard). Chỉ là UX đỡ bấm nhầm — gate THẬT là minRole
// 403 phía platform. Offboard (admin): xuất dữ liệu (JSON quản lý) + chấm dứt hợp
// đồng — terminate CHỈ hiện khi shop đang suspended (giai đoạn nguội bắt buộc),
// đòi gõ đúng slug (typed confirmation, platform kiểm lại server-side).
export function renderPlatformShopDetail(ctx, shop, { notice = null, err = null, invite = null, plans = [] } = {}) {
  const base = `/platform/shops/${esc(shop.id)}`;
  const isOperator = shop.staff_role === 'operator';
  const inviteCard = invite ? `<div class="card" style="background:#ecfdf5;border-color:#a7f3d0">
    <h2 style="margin-top:0">Đã gửi email lời mời</h2>
    <p class="muted" style="margin-bottom:0">Lời mời đã gửi tới <strong>${esc(invite.email)}</strong> — chủ shop mở email, bấm link để đặt mật khẩu và nhận cửa hàng. Hết hạn ${dt(invite.expires_at)}.</p></div>` : '';
  const statusForm = isOperator ? '' : shop.status === 'suspended'
    ? `<form method="POST" action="${base}/restore" style="display:inline"><button class="btn sm" type="submit">Mở lại</button></form>`
    : `<form method="POST" action="${base}/suspend" style="display:inline"><button class="btn warn sm" type="submit">Tạm khoá</button></form>`;
  const offboardCard = isOperator ? '' : `
    <div class="card" style="border-color:#fecaca">
      <h2 style="margin-top:0">Đóng cửa hàng (offboard)</h2>
      <p class="muted" style="font-size:.85rem">Quy trình đúng luật (nghĩa vụ xuất dữ liệu rồi mới đóng): <strong>1.</strong> Tạm khoá → <strong>2.</strong> Xuất dữ liệu quản lý + nhắc chủ shop tự xuất dữ liệu bán hàng (trang Xuất dữ liệu của shop) → <strong>3.</strong> Chấm dứt hợp đồng.</p>
      <div class="actions"><a class="btn alt sm" href="${base}/export">⬇ Tải dữ liệu quản lý (JSON)</a></div>
      ${shop.status === 'suspended' ? `
      <form method="POST" action="${base}/terminate" class="actions" style="align-items:end;margin-top:10px">
        <div><label>Gõ đúng slug <code>${esc(shop.slug)}</code> để xác nhận</label>
          <input name="confirm_slug" required pattern="[a-z0-9-]+" maxlength="40" placeholder="${esc(shop.slug)}" style="width:220px"></div>
        <button class="btn warn" type="submit">Chấm dứt hợp đồng</button>
      </form>
      <p class="muted" style="font-size:.8rem;margin-bottom:0">Không thể hoàn tác: website ngừng phục vụ, thuê bao huỷ, shop biến khỏi danh sách Console (dữ liệu vẫn lưu — cam kết hợp đồng).</p>`
      : '<p class="muted" style="font-size:.8rem;margin-bottom:0">Muốn chấm dứt hợp đồng: <strong>tạm khoá</strong> cửa hàng trước (giai đoạn nguội bắt buộc), nút chấm dứt sẽ hiện ở đây.</p>'}
    </div>`;
  return layout(`Cửa hàng ${shop.name}`, ctx, `
    <a class="muted" href="/platform">← Console nền tảng</a>
    <h1>${esc(shop.name)}</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice ? `<div class="card" style="background:#ecfdf5;border-color:#a7f3d0;color:#065f46">${esc(notice)}</div>` : ''}
    ${inviteCard}
    <div class="card">
      <span class="pill">${badge(shop.status, PLAT_STATUS[shop.status] ?? shop.status)}</span>
      <span class="pill">Gói ${esc(shop.plan_code ?? '—')} · ${esc(shop.sub_status ?? '')}</span>
      ${isOperator ? '<span class="pill">Vai trò: operator (chỉ xem)</span>' : ''}
      <div class="actions" style="margin-top:10px">${statusForm}
        <a class="btn alt sm" href="https://${esc(shop.subdomain ?? '')}" target="_blank" rel="noopener">Mở storefront ↗</a></div>
      <table style="margin-top:12px"><tbody>
        <tr><td class="muted">Subdomain</td><td><code>${esc(shop.subdomain ?? '')}</code></td></tr>
        <tr><td class="muted">Slug</td><td>${esc(shop.slug)}</td></tr>
        <tr><td class="muted">Kỳ thuê bao đến</td><td>${shop.current_period_end ? dt(shop.current_period_end) : '<span class="muted">chưa đặt</span>'}</td></tr>
        <tr><td class="muted">Tạo</td><td>${dt(shop.created_at)}</td></tr>
      </tbody></table>
    </div>
    ${isOperator ? '' : `<div class="card">
      <h2 style="margin-top:0">Ghi nhận thu thuê bao / Gia hạn</h2>
      <p class="muted" style="font-size:.85rem">Khi chủ shop đã trả tiền: chọn số kỳ → thuê bao chuyển <strong>active</strong>, gia hạn kỳ, và <strong>mở lại</strong> shop nếu đang khoá vì nợ. (Thu tiền thủ công — chưa cổng recurring.)</p>
      <form method="POST" action="${base}/renew" class="actions" style="align-items:end;flex-wrap:wrap">
        <div><label>Số tháng</label><select name="months">${[1, 3, 6, 12].map((m) => `<option value="${m}">${m} tháng</option>`).join('')}</select></div>
        <div><label>Đổi gói (tuỳ chọn)</label><select name="plan_code"><option value="">— Giữ gói hiện tại —</option>${planOptions(plans, shop.plan_code)}</select></div>
        <div><label>Số tiền (VND, tuỳ chọn)</label><input name="amount_vnd" inputmode="numeric" maxlength="11" placeholder="để trống = giá gói × số tháng" style="width:220px"></div>
        <div><label>Ghi chú</label><input name="note" maxlength="500" placeholder="VD: deal 6 tháng giảm 10%" style="width:220px"></div>
        <button class="btn" type="submit">Ghi nhận thu + gia hạn</button>
      </form>
      <p class="muted" style="font-size:.8rem">Để trống số tiền → hệ thống tự tính theo giá gói (không JS — giá từng gói ghi ngay trong tên gói).</p>
    </div>`}
    <div class="card">
      <h2 style="margin-top:0">Lịch sử thu</h2>
      ${(shop.invoices ?? []).length ? `<table><thead><tr><th>Ngày</th><th>Gói</th><th>Số tháng</th><th class="right">Số tiền</th><th>Ghi chú</th></tr></thead><tbody>
        ${shop.invoices.map((i) => `<tr><td class="muted">${dt(i.created_at)}</td><td>${esc(i.plan_code)}</td><td>${esc(i.months)}</td><td class="right">${money(i.amount_vnd)}</td><td class="muted">${esc(i.note ?? '')}</td></tr>`).join('')}
      </tbody></table>
      <p class="muted">Tổng đã thu: <strong>${money(shop.invoice_total_vnd ?? 0)}</strong> (${esc(shop.invoice_count ?? 0)} lần thu)</p>` : '<p class="muted">Chưa ghi nhận khoản thu nào.</p>'}
      <p class="muted" style="font-size:.8rem">Hoá đơn VAT (NĐ 123): lập trên phần mềm kế toán, dùng bảng này làm căn cứ số liệu — nền tảng không tích hợp e-invoice.</p>
    </div>
    ${isOperator ? '' : `<div class="card"><h2 style="margin-top:0">Mời chủ shop (owner)</h2>
      <p class="muted" style="font-size:.85rem">Hệ thống gửi email lời mời để chủ shop đặt mật khẩu + nhận cửa hàng (link chỉ tới email người được mời).</p>
      <form method="POST" action="${base}/invite" class="actions" style="align-items:end">
        <div><label>Email chủ shop</label><input name="email" type="email" required placeholder="chushop@email.com" style="width:260px"></div>
        <button class="btn" type="submit">Gửi email lời mời</button>
      </form></div>`}
    ${offboardCard}`);
}

// `email` điền sẵn khi tới từ luồng tự-đăng-ký (?email=…). Vừa kích hoạt shop xong mà bắt
// gõ lại email vừa đăng ký 2 phút trước là bước thừa ở đúng lúc người ta hào hứng nhất.
// ── KHUNG CỬA VÀO: panel trái giới thiệu, panel phải là form ──────────────────
// Dùng chung cho đăng nhập · MFA · quên/đặt lại mật khẩu · nhận lời mời. Panel trái nói
// GIÁ TRỊ, panel phải làm VIỆC — người đang vội chỉ nhìn phải, người đang cân nhắc đọc trái.
//
// KHÔNG bịa số: bản mẫu tham khảo có dòng "Hơn 1.200 shop đang bán cùng…", nhưng README §1
// ghi rõ CHƯA CÓ KHÁCH THẬT. Ở đây chỉ nêu NĂNG LỰC đã kiểm được trong mã.
const AU_TICK = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M4 10.5l4 4 8-9"/></svg>`;
const AU_MAIL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="M3 6.5l9 6.5 9-6.5"/></svg>`;
const AU_PTS = [
  'Website riêng + tên miền phụ, dựng xong trong vài phút',
  'Đơn hàng, kho theo biến thể, vận đơn GHN/GHTK một chỗ',
  'COD và VietQR vào thẳng tài khoản ngân hàng của bạn',
  'Sao lưu, HTTPS, giám sát — phần kỹ thuật chúng tôi lo',
];

/** Trang cửa vào hai panel. `body` là nội dung panel phải (đã escape ở nơi gọi). */
function authSplit(title, body, { heading = 'Bán hàng online<br><em>không cần biết code</em>' } = {}) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body>
<div class="au">
  <section class="au-l">
    <a class="au-brand" href="/"><i>N</i>Nền Tảng</a>
    <div class="au-mid">
      <h2>${heading}</h2>
      <p>Nền tảng giúp bạn tạo website bán hàng riêng, quản lý đơn — kho — vận chuyển — tiền ở một chỗ.</p>
      <ul class="au-pts">${AU_PTS.map((p) => `<li>${AU_TICK}<span>${esc(p)}</span></li>`).join('')}</ul>
    </div>
    <p class="au-foot">Dùng thử 14 ngày · Không cần thẻ · Không phí thiết lập</p>
  </section>
  <main class="au-r"><div class="au-box">${body}</div></main>
</div></body></html>`;
}

// KHÔNG tự cấp phiên: link kích hoạt nằm trong hộp thư, ai đọc được mail sẽ vào thẳng được
// admin mà không cần biết mật khẩu — đây vẫn phải là hai lớp riêng.
export function renderLogin(err, email) {
  return authSplit('Đăng nhập', `<h1>Chào mừng trở lại</h1>
    <p class="au-sub">Đăng nhập để tiếp tục quản lý cửa hàng của bạn.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="/login">
      <label for="au-em">Email <span class="rq">*</span></label>
      <input id="au-em" name="email" type="email" required autocomplete="username" placeholder="ban@email.com" value="${esc(email ?? '')}"${email ? '' : ' autofocus'}>
      <label for="au-pw">Mật khẩu <span class="rq">*</span></label>
      <input id="au-pw" name="password" type="password" required autocomplete="current-password"${email ? ' autofocus' : ''}>
      <p class="au-right"><a href="/forgot">Quên mật khẩu?</a></p>
      <button class="au-btn" type="submit">Đăng nhập</button>
    </form>
    <p class="au-end">Chưa có cửa hàng? <a href="${esc(SIGNUP_LINK)}">Đăng ký miễn phí</a></p>`);
}

export function renderMfa(err) {
  return authSplit('Xác thực 2 lớp', `<h1>Mã xác thực</h1>
    <p class="au-sub">Nhập mã 6 số từ ứng dụng xác thực trên điện thoại của bạn.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="/mfa">
      <label for="au-code">Mã xác thực <span class="rq">*</span></label>
      <input id="au-code" name="code" inputmode="numeric" autocomplete="one-time-code" required placeholder="123456" autofocus>
      <button class="au-btn" type="submit">Xác nhận</button>
    </form>
    <a class="au-back" href="/login">← Quay lại đăng nhập</a>`, { heading: 'Thêm một lớp<br><em>cho chắc chắn</em>' });
}

// Tổng quan cửa hàng (GĐ2): KPI doanh thu + đơn theo trạng thái + bán chạy.
// Biểu đồ cột doanh thu theo ngày — SVG NỘI TUYẾN sinh ở SERVER: không JS, hợp CSP.
// Màu dùng var(--pri) → tự hợp dark mode. Tooltip = <title> gốc trình duyệt (no-JS).
// MỘT chuỗi số liệu ⇒ một màu, KHÔNG cần chú giải (tiêu đề đã nói rõ nó là gì).
function revenueChart(series) {
  const pts = (Array.isArray(series) ? series : []).filter((p) => p && p.day);
  if (!pts.length) return '';
  const W = 720, H = 168, BOTTOM = 22, TOP = 10;
  const base = H - BOTTOM, n = pts.length, gap = 6;
  const bw = (W - gap * (n - 1)) / n;
  const vals = pts.map((p) => Math.max(0, Number(p.revenue) || 0));
  const max = Math.max(...vals, 1);
  // Nhãn ngày lấy TRỰC TIẾP từ chuỗi 'YYYY-MM-DD' — không qua Date() để khỏi lệch múi giờ.
  const dayLabel = (iso) => { const p = String(iso).split('-'); return `${Number(p[2])}/${Number(p[1])}`; };
  const q = (v) => Math.round(v * 10) / 10; // làm tròn toạ độ → SVG gọn, không đổi hình
  const bars = pts.map((p, i) => {
    const v = vals[i];
    const x = q(i * (bw + gap)), x2 = q(x + bw);
    const h = v > 0 ? Math.max(3, (v / max) * (base - TOP)) : 2; // ngày 0đ vẫn có vạch mờ
    const y = q(base - h), r = q(Math.min(4, h / 2)); // bo 4px ĐẦU cột, chân cột phẳng trên trục
    const d = `M${x},${base} L${x},${q(y + r)} Q${x},${y} ${q(x + r)},${y} L${q(x2 - r)},${y} Q${x2},${y} ${x2},${q(y + r)} L${x2},${base} Z`;
    return `<path d="${d}" fill="${v > 0 ? 'var(--pri)' : 'var(--bd)'}"><title>${esc(dayLabel(p.day))} · ${esc(money(v))}</title></path>`;
  }).join('');
  // Nhãn THƯA (3 ngày/nhãn + ngày cuối) → không chen chữ.
  const labels = pts.map((p, i) => ((i % 3 === 0 || i === n - 1)
    ? `<text x="${(i * (bw + gap) + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="var(--mut)">${esc(dayLabel(p.day))}</text>` : '')).join('');
  const total = vals.reduce((a, b) => a + b, 0);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Doanh thu ${n} ngày gần nhất: tổng ${money(total)}, ngày cao nhất ${money(max)}">
      <line x1="0" y1="${base}" x2="${W}" y2="${base}" stroke="var(--bd)" stroke-width="1"/>
      ${bars}${labels}</svg>`;
}

export function renderOverview(ctx, shopId, s, setup = null, notice = null, shopStatus = null, preview = null, readinessErr = null, readinessErrHref = null) {
  const base = `/shops/${esc(shopId)}`;
  const st = s?.status ?? {};
  const rev = s?.revenue ?? {};
  const metric = (label, value, sub = '') => `<div class="metric"><div class="l">${esc(label)}</div><div class="v">${value}</div>${sub ? `<div class="l" style="margin:4px 0 0">${sub}</div>` : ''}</div>`;
  // % thay đổi 7 ngày này so với 7 ngày LIỀN TRƯỚC. Không có nền so sánh (prev7=0) →
  // không bịa %. Luôn kèm mũi tên + chữ (KHÔNG chỉ dựa vào màu).
  const d7 = Number(rev.d7 ?? 0), prev7 = Number(rev.prev7 ?? 0);
  const pct = prev7 > 0 ? Math.round(((d7 - prev7) / prev7) * 100) : null;
  const delta = pct === null
    ? (d7 > 0 ? '<span class="delta flat">● chưa có kỳ trước để so</span>' : '')
    : `<span class="delta ${pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'}">${pct > 0 ? '▲' : pct < 0 ? '▼' : '●'} ${esc(Math.abs(pct))}% so với 7 ngày trước</span>`;
  // Ô trạng thái đơn (bấm vào lọc danh sách đơn theo trạng thái). Màu TRẠNG THÁI riêng,
  // luôn đi kèm nhãn chữ → không bao giờ chỉ-dựa-vào-màu.
  const S = [
    { k: 'pending', label: 'Chờ xác nhận', c: 'var(--warn)' }, { k: 'confirmed', label: 'Đã xác nhận', c: 'var(--pri)' },
    { k: 'shipped', label: 'Đang giao', c: 'var(--indigo)' }, { k: 'delivered', label: 'Đã giao', c: 'var(--good)' }, { k: 'cancelled', label: 'Đã huỷ', c: 'var(--bad)' },
  ];
  // `migrated=0` KHÔNG thừa. Con số trên các ô này đến từ dashboard.js, vốn đếm với
  // `WHERE NOT is_migrated` — đơn nhập từ sàn cũ là lịch sử, không phải việc cần làm (0104).
  // Danh sách đơn thì mặc định KHÔNG lọc cờ đó, vì tra cứu lịch sử khách phải ra đủ. Không
  // mang bộ lọc theo thì ô "Đã giao 40" mở ra 40 + toàn bộ đơn vừa nhập từ TikTok, và người
  // bán học được rằng con số trên Tổng quan không dẫn tới tập nó đang đếm.
  //
  // Hôm nay chỉ `delivered`/`cancelled`/`refunded` lệch thật (O_STATUS ở import.js chỉ sinh
  // ba trạng thái đó, chuỗi lạ rơi về 'delivered'), nhưng gắn cho CẢ NĂM ô: một quy tắc đồng
  // nhất sống sót được khi đường nhập nhận thêm trạng thái chưa-xong, còn quy tắc "chỉ hai ô
  // này" thì phải nhớ để sửa, và sẽ không ai nhớ.
  const statusCards = S.map((x) => `<a class="metric" style="text-decoration:none;color:inherit;display:block" href="${base}/orders?status=${x.k}&migrated=0">
      <div class="l"><span class="sdot" style="background:${x.c}"></span>${esc(x.label)}</div><div class="v">${esc(st[x.k] ?? 0)}</div></a>`).join('');
  const top = (s?.top_products ?? []);
  const maxTop = Math.max(...top.map((t) => Number(t.revenue) || 0), 1);
  const topRows = top.map((t) => `<tr>
      <td><div class="pcell">${t.image_url ? `<img class="pthumb" src="${esc(t.image_url)}" alt="" loading="lazy" width="40" height="40">` : `<span class="pthumb ph">${IC_IMG}</span>`}<div style="min-width:0">${esc(t.title)}<div class="muted" style="font-size:.8rem">${esc(t.sku ?? '')}</div></div></div></td>
      <td class="num right">${esc(t.qty)}</td>
      <td class="num right"><strong>${money(t.revenue)}</strong><div class="mbar"><i style="width:${Math.round((Number(t.revenue) || 0) / maxTop * 100)}%"></i></div></td></tr>`).join('');
  const chart = revenueChart(s?.series);
  // Checklist đọc nguyên contract readiness từ seller. Client không tự tính và nút mở bán vẫn
  // bị backend kiểm tra lại, nên sửa HTML/request không thể tự khai shop đã sẵn sàng.
  let setupCard = '';
  if (setup) {
    const meta = {
      catalog: ['📦', 'Sản phẩm bán được'], payment: ['💳', 'Phương thức nhận tiền'], shipping: ['🚚', 'Vận chuyển'],
      contact: ['☎', 'Thông tin liên hệ'], purchase_policy: ['📄', 'Chính sách mua hàng'], privacy_policy: ['🔒', 'Quyền riêng tư'],
      domain: ['🌐', 'Tên miền cửa hàng'], checkout_dry_run: ['✓', 'Kiểm tra checkout'], mfa: ['🛡', 'Bảo mật chủ shop'],
    };
    const allChecks = Array.isArray(setup.checks) ? setup.checks : [];
    // checkout_dry_run KHÔNG phải việc người dùng làm — nó là KẾT QUẢ của các mục kia. Để nó
    // trong danh sách nghĩa là tiến độ đứng ở 8/9 mà không có nút nào bấm được, và người dùng
    // đi tìm "việc" thứ chín không tồn tại. Nó VẪN blocking ở server và ở
    // activate_current_shop_after_readiness(); chỉ đổi chỗ hiển thị.
    const dryRunCheck = allChecks.find((it) => it.code === 'checkout_dry_run') ?? null;
    const checks = allChecks.filter((it) => it.code !== 'checkout_dry_run');
    const done = checks.filter((it) => it.status === 'ready').length;
    const blockingLeft = checks.filter((it) => it.blocking && it.status !== 'ready').length;
    const pct = checks.length ? Math.round((done / checks.length) * 100) : 0;
    // MỘT allowlist cho MỌI link readiness động, không phải hai bản chép tay. `action_url` đến
    // từ hợp đồng readiness của seller — không phải người dùng gõ, nhưng nó là chuỗi đi qua ba
    // service, và "không phải input người dùng" là câu người ta nói ngay trước mỗi lần nó hoá
    // ra là input người dùng. Hai chỗ dùng: nút "Đi tới" của từng mục, và link "Đi tới mục
    // này →" của thông báo lỗi go-live. Bản trước chỉ gác chỗ thứ nhất.
    const noiBo = (h) => {
      const s = String(h ?? '');
      return s === '/account' || s.startsWith(`${base}/`) ? s : '';
    };
    const rows = checks.map((it) => {
      const ok = it.status === 'ready';
      const warning = it.status === 'warning';
      const [icon, title] = meta[it.code] ?? ['•', it.code];
      const safeHref = noiBo(it.action_url);
      const action = ok ? '<span class="muted" style="font-size:.82rem">Đã xong</span>'
        : !setup.canManage ? '<span class="muted" style="font-size:.82rem">Cần chủ shop</span>'
          : safeHref ? `<a class="btn alt sm" href="${esc(safeHref)}">Đi tới</a>` : '';
      return `<div style="display:flex;align-items:center;gap:12px;padding:11px 0;border-top:1px solid var(--bd)">
        <span style="flex:0 0 auto;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-size:.9rem;background:${ok ? 'var(--good)' : warning ? 'var(--warnbg)' : 'var(--row)'};color:${ok ? '#fff' : warning ? 'var(--warn)' : 'var(--mut)'}">${ok ? '✓' : warning ? '!' : '○'}</span>
        <div style="flex:1;min-width:0"><div style="font-weight:600;font-size:.95rem">${icon} ${esc(title)}</div><div class="muted" style="font-size:.82rem">${esc(it.label ?? '')}${it.blocking ? '' : ' · Khuyến nghị, không chặn mở bán'}</div></div>
        ${action}</div>`;
    }).join('');
    // DÒNG CHẨN ĐOÁN CHECKOUT — không phải một "việc", nên không có nút "Đi tới".
    // Khi mọi việc người dùng làm được đã xong mà nó vẫn hỏng thì đó là lỗi hệ thống/cấu
    // hình: nói đúng bản chất và đưa mã hỗ trợ, thay vì để người ta đi tìm việc thứ chín.
    const dryOk = dryRunCheck?.status === 'ready';
    const dryBlocked = dryRunCheck && !dryOk;
    const allActionableDone = blockingLeft === 0;
    const dryRunBox = !dryRunCheck ? '' : `<div style="display:flex;align-items:flex-start;gap:12px;padding:11px 0;border-top:1px solid var(--bd)">
      <span style="flex:0 0 auto;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-size:.9rem;background:${dryOk ? 'var(--goodbg)' : dryBlocked && allActionableDone ? 'var(--badbg)' : 'var(--row)'};color:${dryOk ? 'var(--good)' : dryBlocked && allActionableDone ? 'var(--bad)' : 'var(--mut)'}">${dryOk ? '✓' : '⚙'}</span>
      <div style="flex:1;min-width:0"><div style="font-weight:600;font-size:.95rem">Kiểm tra thử checkout <span class="muted" style="font-weight:400">· máy chủ tự chạy</span></div>
        <div class="muted" style="font-size:.82rem">${dryOk
          ? 'Máy chủ dựng thử một đơn (chỉ đọc, không tạo dữ liệu) và tính được tiền — cửa hàng bán được.'
          : allActionableDone
            ? 'Các mục trên đã đủ nhưng máy chủ vẫn chưa dựng thử được đơn. <strong>Đây là lỗi hệ thống hoặc cấu hình, không phải việc bạn còn thiếu.</strong> Thử lại sau ít phút; nếu vẫn vậy hãy báo chúng tôi kèm mã cửa hàng.'
            : 'Tự chuyển sang đạt khi các mục trên đã đủ. Đây là kết quả, không phải việc bạn cần làm.'}</div></div></div>`;

    // LINK XEM TRƯỚC — ba trạng thái, và cả ba đều nói ra thành lời.
    // Trước: một URL thô kèm "sống khoảng 15 phút". Hết hạn thì bấm vào ra đúng màn khách lạ
    // thấy ("đang chuẩn bị mở bán") — người dùng không phân biệt được "hết hạn" với "hỏng".
    // `reused` = vừa bấm lại khi link cũ CÒN sống; seller cố ý không xoay token và cũng không
    // trả lại token thô (chỉ lưu hash), nên ở đây nói rõ link cũ vẫn dùng được.
    const previewExp = preview?.expires_at
      ? new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' }).format(new Date(preview.expires_at))
      : null;
    const previewBox = preview?.preview_url
      ? `<div class="notice ok" style="margin-top:12px"><strong>Link xem trước${previewExp ? ` — dùng được tới ${esc(previewExp)}` : ''}:</strong><br>
        <a href="${esc(preview.preview_url)}" target="_blank" rel="noopener noreferrer" style="word-break:break-all">${esc(preview.preview_url)}</a>
        <div class="muted" style="font-size:.82rem;margin-top:6px">Ai có link cũng xem được cửa hàng trước khi mở bán. Hết hạn thì bấm “Tạo link mới”.</div></div>`
      : (preview?.reused || preview?.persisted === 'active'
        // KHÔNG nói "dùng lại link đó". Câu ấy giả định người dùng ĐANG CẦM link — sai khi
        // response đầu bị mất (mạng đứt, đóng tab), khi hai POST chạy đồng thời, hoặc khi
        // người bấm lần này khác người bấm lần đầu. Nói đúng thứ hệ thống BIẾT: có một link
        // còn hiệu lực, và vì chỉ lưu hash nên không hiện lại được.
        ? `<div class="notice" style="margin-top:12px">Đang có <strong>một link xem trước còn hiệu lực</strong>${previewExp ? ` tới ${esc(previewExp)}` : ''}.
           <div class="muted" style="font-size:.82rem;margin-top:6px">Hệ thống <strong>không hiển thị lại được</strong> link đó — chỉ lưu bản băm, không lưu link. Nếu bạn không còn giữ link, bấm “Tạo link mới”: <strong>link cũ sẽ hết hiệu lực ngay</strong>.</div></div>`
        : (preview?.persisted === 'expired'
          ? `<div class="notice" style="margin-top:12px">Link xem trước trước đó <strong>đã hết hạn</strong>${previewExp ? ` lúc ${esc(previewExp)}` : ''}.
             <div class="muted" style="font-size:.82rem;margin-top:6px">Bấm “Tạo link mới” để có link dùng được.</div></div>`
          : ''));

    // Nút KHÔNG dùng `disabled`. `disabled` khiến nút không nhận focus (bàn phím không tới
    // được) và `title` chỉ hiện khi hover — mobile không có hover, nên người dùng điện thoại
    // thấy một nút xám không giải thích gì. Nay nút luôn bấm được; server vẫn là nơi quyết
    // định (goLive tự kiểm lại readiness), và khi từ chối thì BFF nêu MỤC THIẾU ĐẦU TIÊN.
    const hasPreview = !!(preview?.preview_url || preview?.reused || preview?.persisted);
    const rotateWarn = preview?.persisted === 'active' || preview?.reused || preview?.preview_url;
    const controls = setup.canManage ? `<div style="border-top:1px solid var(--bd);margin-top:8px;padding-top:14px" class="actions">
      <form method="POST" action="${base}/preview" style="margin:0">${hasPreview ? '<input type="hidden" name="rotate" value="1">' : ''}
        <button class="btn alt" type="submit" data-busy="Đang tạo link…"${rotateWarn ? ' data-confirm="Tạo link mới sẽ làm LINK CŨ HẾT HIỆU LỰC ngay. Tiếp tục?"' : ''}>${hasPreview ? 'Tạo link mới' : 'Xem trước cửa hàng'}</button></form>
      <form method="POST" action="${base}/activate" style="margin:0">
        <button class="btn" type="submit" data-busy="Đang kiểm tra…"${setup.ready ? ' data-confirm="Mở checkout công khai cho khách ngay bây giờ?"' : ''}>🎉 Mở bán chính thức</button></form>
      <span class="muted" style="font-size:.82rem">${setup.ready
        ? 'Đã đủ điều kiện; server sẽ kiểm tra lại khi bấm.'
        : `Còn ${blockingLeft} mục bắt buộc — bấm để xem còn thiếu gì.`}</span>
    </div>` : '';
    setupCard = `<div class="card" style="border-color:color-mix(in srgb,var(--pri) 35%,var(--bd));background:var(--wash)">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap"><h2 style="margin:0">🚀 Hoàn tất thiết lập cửa hàng</h2><span class="muted" style="font-size:.9rem">${done}/${checks.length} đạt</span></div>
      <div style="height:8px;border-radius:999px;background:var(--row);overflow:hidden;margin:10px 0 4px"><i style="display:block;height:100%;width:${pct}%;background:var(--pri)"></i></div>
      <p class="muted" style="font-size:.85rem;margin:0 0 6px">Khách công khai chưa thể đặt hàng. Hoàn tất các mục bắt buộc, xem trước rồi mới mở checkout.</p>
      ${setup.canManage ? `<p style="margin:0 0 4px"><a class="btn alt" href="${base}/onboarding">⚡ Thiết lập nhanh trong 2 bước</a>
        <span class="muted" style="font-size:.82rem;margin-left:10px">Đặt tên gian hàng và chọn giao diện — khoảng một phút.</span></p>` : ''}
      ${readinessErr ? `<div class="err">${esc(readinessErr)}${noiBo(readinessErrHref) ? ` <a href="${esc(noiBo(readinessErrHref))}"><strong>Đi tới mục này →</strong></a>` : ''}</div>` : ''}${rows}${dryRunBox}${controls}${previewBox}</div>`;
  }
  // ── "VIỆC CẦN LÀM" — hộp hành động đầu trang (mẫu màn hình chính TikTok Shop/Shopee) ──
  // Chủ shop mở trang quản lý là để biết HÔM NAY phải làm gì, không phải để ngắm doanh thu.
  // Mỗi ô = 1 việc tồn đọng + link tới đúng trang ĐÃ LỌC SẴN. Ô có việc (n>0) mới nổi màu;
  // hết việc thì xám và không dẫn đi đâu gấp. Sạch việc → hiện lời chúc thay vì lưới trống.
  const td = s?.todo ?? {};
  // docs/44 §7: "Ô số liệu LÀ LINK — bấm vào con số phải nhảy tới danh sách ĐÃ LỌC SẴN".
  // Hai ô dưới đây trước đây dẫn tới danh sách ĐẦY ĐỦ: báo "3 đơn chưa thu tiền" rồi mở ra
  // 400 đơn. Người bán phải tự đi tìm 3 đơn đó — tệ hơn không có link, vì nó dạy người ta
  // rằng con số trên Tổng quan không dẫn đi đâu cả. Nay có bộ lọc thật ở API (payment=unpaid,
  // stock=low) nên href trỏ đúng tập hợp mà con số đang đếm.
  //
  // Màu lấy từ TOKEN (docs/44 §2: "không được sinh thêm màu ngoài danh sách này"). Bộ hex
  // cứng cũ (#b45309/#1d4ed8/#7c3aed…) là tàn dư của bảng màu xanh-tím trước đây — để lại
  // thì lưới này là mảng duy nhất trong admin không theo hệ.
  //
  // `see`: Ô CHỈ HIỆN KHI VAI ĐÓ MỞ ĐƯỢC TRANG ĐÍCH. Dùng ĐÚNG các Set mà sideNav dùng —
  // chép ra một danh sách riêng thì hai bên sẽ trôi, và trôi về đúng phía nguy hiểm: nav giấu
  // mục, lưới vẫn mời bấm. Đo được trước khi vá: vai `order_manager` (chỉ orders.read/write)
  // thấy "Đánh giá chờ duyệt" → /reviews cần content.write → 403, và "Sắp hết hàng" →
  // /products cần catalog.read → 403. Hai ô dẫn thẳng vào tường, trong khi sidebar đã giấu
  // đúng hai mục đó khỏi họ.
  //
  // `tier`: xếp theo AI ĐANG CHỜ, không theo bảng nào đẹp.
  //   1 = tiền/người đang chờ mình  · 2 = dòng đơn hằng ngày · 3 = giữ cửa hàng chạy.
  // Mười một ô đồng hạng thì mắt rơi vào ô có số to nhất, mà số to nhất thường là "Sắp hết
  // hàng" — việc ít gấp nhất trong danh sách.
  const TODO = [
    // ĐỨNG ĐẦU, và cố ý đứng trước cả đơn chờ xác nhận: mọi ô khác chỉ là tiền của shop về
    // CHẬM, ô này là tiền của NGƯỜI KHÁC đang nằm trong túi shop. Nhãn mang theo SỐ TIỀN vì
    // số đơn không nói lên mức độ — 1 đơn nợ 20 triệu gấp gáp hơn 11 đơn nợ 500 nghìn.
    { tier: 1, see: ORDER_ROLES, n: Number(td.owed_count ?? 0), label: `Còn nợ khách${Number(td.owed_vnd ?? 0) > 0 ? ` · ${money(td.owed_vnd)}` : ''}`, href: `${base}/orders/owed`, tone: 'var(--bad)', bg: 'var(--badbg)', bd: 'var(--bad)', icon: '↩' },
    { tier: 1, see: ORDER_ROLES, n: Number(td.order_requests ?? 0), label: 'Yêu cầu khách chờ xử lý', href: `${base}/order-requests?status=requested`, tone: 'var(--warn)', bg: 'var(--warnbg)', bd: 'var(--warn)', icon: '↩' },
    { tier: 1, see: ORDER_ROLES, n: Number(td.resolution_cases ?? 0), label: 'Ca giao hàng cần xử lý', href: `${base}/resolution-cases?status=active`, tone: 'var(--bad)', bg: 'var(--badbg)', bd: 'var(--bad)', icon: '↔' },
    { tier: 1, see: ORDER_ROLES, n: Number(td.shipment_attention ?? 0), label: 'Vận đơn cần xử lý', href: `${base}/overview#shipment-attention`, tone: 'var(--bad)', bg: 'var(--badbg)', bd: 'var(--bad)', icon: '🚚' },
    // `migrated=0` khớp với dashboard.js (`WHERE NOT is_migrated`) — cùng lý do đã ghi ở
    // statusCards. Ô tiền (unpaid/partial) KHÔNG cần: PAYMENT_ACTIONABLE_SQL trong owed.js
    // đã mang sẵn `NOT o.is_migrated`, nên đếm và danh sách vốn đã cùng một tập.
    { tier: 2, see: ORDER_ROLES, n: Number(td.to_confirm ?? 0), label: 'Đơn chờ xác nhận', href: `${base}/orders?status=pending&migrated=0`, tone: 'var(--warn)', bg: 'var(--warnbg)', bd: 'var(--warn)', icon: '🕐' },
    { tier: 2, see: ORDER_ROLES, n: Number(td.to_ship ?? 0), label: 'Đơn chờ gửi hàng', href: `${base}/orders?status=confirmed&migrated=0`, tone: 'var(--indigo)', bg: 'var(--indigobg)', bd: 'var(--indigo)', icon: '📦' },
    { tier: 2, see: ORDER_ROLES, n: Number(td.unpaid ?? 0), label: 'Đơn chưa thu tiền', href: `${base}/orders?payment=unpaid`, tone: 'var(--bad)', bg: 'var(--badbg)', bd: 'var(--bad)', icon: '💰' },
    { tier: 2, see: ORDER_ROLES, n: Number(td.partial_payments ?? 0), label: 'Đơn thu một phần', href: `${base}/orders?payment=pending`, tone: 'var(--warn)', bg: 'var(--warnbg)', bd: 'var(--warn)', icon: '◐' },
    { tier: 3, see: ORDER_ROLES, n: Number(td.notification_failures ?? 0), label: 'Thông báo gửi thất bại', href: `${base}/notification-deliveries?status=failed`, tone: 'var(--bad)', bg: 'var(--badbg)', bd: 'var(--bad)', icon: '✉' },
    // `?status=pending` TƯỜNG MINH. Trước đây link trần ăn may vào mặc định `status='pending'`
    // ở seller/reviews.js — đổi mặc định là con số dẫn tới danh sách khác mà không lỗi nào
    // hiện ra. Đúng lớp lỗi mà `payment=unpaid` và `stock=low` đã phải vá một lần rồi.
    { tier: 3, see: CONTENT_ROLES, n: Number(td.reviews_pending ?? 0), label: 'Đánh giá chờ duyệt', href: `${base}/reviews?status=pending`, tone: 'var(--pri)', bg: 'var(--wash)', bd: 'var(--pri)', icon: '⭐' },
    { tier: 3, see: CATALOG_ROLES, n: Number(td.low_stock ?? 0), label: 'Sắp hết hàng', href: `${base}/products?stock=low`, tone: 'var(--warn)', bg: 'var(--warnbg)', bd: 'var(--warn)', icon: '⚠' },
  ].filter((x) => x.see.has(ctx.role));
  // Đếm trên các ô CÒN LẠI sau khi lọc quyền. Cộng cả ô đã ẩn thì câu "7 việc đang chờ bạn"
  // nói về việc người này không thấy và không làm được — một con số không hành động được.
  const openWork = TODO.reduce((a, x) => a + x.n, 0);
  // "Không còn việc tồn đọng — cửa hàng đang chạy êm" là câu ĐÚNG cho shop đang chạy, và
  // là lời nói dối cho shop vừa mở: 0 việc vì 0 khách, mà 0 khách vì chưa có gì để bán.
  // Câu đầu tiên chủ shop mới đọc phải nói đúng tình trạng, không phải trấn an.
  // setup chỉ khác null khi shop còn 'onboarding'; setup.products = có SP đang bán + còn tồn.
  const notSellable = !!setup && !setup.products;
  const todoCell = (x) => {
    const on = x.n > 0;
    return `<a class="todo-cell${on ? ' on' : ''}" href="${x.href}"
      style="${on ? `background:${x.bg};border-color:${x.bd}` : ''}"
      aria-label="${esc(x.label)}: ${x.n}">
      <div class="todo-n" style="${on ? `color:${x.tone}` : ''}">${esc(x.n)}</div>
      <div class="todo-l">${x.icon} ${esc(x.label)}</div></a>`;
  };
  // BA NHÓM, mỗi nhóm nói rõ AI ĐANG CHỜ. Đây là phần biến khối này từ mười một con số xếp
  // cạnh nhau thành một thứ tự làm việc: đọc từ trên xuống đúng bằng thứ tự nên xử lý, và bỏ
  // qua được CẢ NHÓM khi chưa tới lượt. Không phân nhóm thì mắt rơi vào ô có SỐ TO NHẤT, mà
  // số to nhất gần như luôn là "Sắp hết hàng" — việc ít gấp nhất trong cả danh sách.
  // Nhóm rỗng (vai không thấy ô nào trong nhóm) thì bỏ hẳn cả tiêu đề, không để đầu đề trơ.
  const NHOM = [
    [1, 'Khách đang chờ bạn', 'Tiền của khách hoặc yêu cầu khách đã gửi. Chậm ở đây mất niềm tin, không chỉ mất thời gian.'],
    [2, 'Đơn hàng hôm nay', 'Dòng chảy bình thường: xác nhận, gửi hàng, thu tiền.'],
    // Câu mô tả KHÔNG được kể tên những việc trong nhóm: nhóm này lọc theo vai, nên
    // `order_manager` chỉ còn đúng ô "Thông báo gửi thất bại" mà lại đọc một câu nhắc tới
    // tồn kho và đánh giá — hai thứ họ không nhìn thấy và không mở được. Nói chung, đúng cho
    // mọi vai. Thấy được lỗi này khi render thử ba vai, không chốt mã nguồn nào bắt nổi.
    [3, 'Giữ cửa hàng chạy', 'Không gấp trong ngày, nhưng bỏ lâu thì hỏng âm thầm — không có ai báo.'],
  ];
  const todoGroups = NHOM.map(([t, ten, mo]) => {
    const cells = TODO.filter((x) => x.tier === t);
    if (!cells.length) return '';
    const con = cells.reduce((a, x) => a + x.n, 0);
    return `<div style="margin-top:18px">
      <div style="font-weight:600;font-size:.92rem">${esc(ten)}${con > 0 ? ` <span class="muted" style="font-weight:400">· ${esc(con)} việc</span>` : ''}</div>
      <div class="muted" style="font-size:.8rem;margin-top:2px">${esc(mo)}</div>
      <div class="todo-grid" style="margin-top:10px">${cells.map(todoCell).join('')}</div></div>`;
  }).join('');
  // Vai không thấy ô nào thì KHÔNG dựng khối rỗng: một tiêu đề "Việc cần làm" với vùng trống
  // bên dưới đọc như trang hỏng, chứ không như "phần này không dành cho bạn".
  const todoCard = !TODO.length ? '' : `<div class="card">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">Việc cần làm</h2>
      ${openWork > 0 ? `<span class="muted" style="font-size:.88rem">${esc(openWork)} việc đang chờ bạn</span>`
        : notSellable ? '<span class="muted" style="font-size:.88rem">Chưa có đơn — cửa hàng chưa bán được</span>'
        : '<span class="muted" style="font-size:.88rem">✓ Không còn việc tồn đọng</span>'}
    </div>
    ${todoGroups}</div>`;

  // Không dựng bộ lọc giả cho shipments: mỗi dòng dẫn tới đúng chi tiết đơn, nơi đã có hai
  // thao tác đối soát an toàn (xác nhận hãng đã tạo hoặc mở khoá sau khi kiểm tra portal).
  const shipmentAttention = Array.isArray(s?.shipment_attention) ? s.shipment_attention : [];
  const shipmentAttentionRows = shipmentAttention.map((item) => {
    const statusText = item.provider_status === 'ambiguous'
      ? 'Chưa rõ hãng đã tạo hay chưa'
      : 'Hãng đã tạo nhưng hệ thống chưa chốt đơn';
    const href = `${base}/orders/${esc(item.order_id)}?timeline=shipment`;
    return [
      { html: `<a href="${href}"><strong>#${esc(item.order_number)}</strong></a><div class="muted" style="font-size:.82rem">Phát sinh ${dt(item.created_at)}</div>` },
      { html: esc(String(item.provider ?? 'Hãng vận chuyển').toUpperCase()) },
      { html: badge(item.provider_status ?? 'unknown', statusText) },
      { html: item.tracking_number ? `<code>${esc(item.tracking_number)}</code>` : '<span class="muted">Chưa có mã</span>' },
      { style: 'text-align:right', html: `<a class="btn alt sm" href="${href}">Mở đơn phục hồi</a>` },
    ];
  });
  const shipmentAttentionCard = (Number(td.shipment_attention ?? 0) > 0 || shipmentAttention.length > 0)
    ? `<div class="card" id="shipment-attention" style="border-color:var(--bad)">
      <div class="toolbar"><div><h2 style="margin:0">Vận đơn cần xử lý</h2><p class="muted" style="margin:5px 0 0">Kiểm tra trên portal hãng trước khi thao tác; không tạo lại mù vì có thể sinh hai vận đơn và thu COD hai lần.</p></div></div>
      ${shipmentAttentionRows.length ? `<div class="tblscroll">${tblCards({
        head: [{ html: 'Đơn' }, { html: 'Hãng' }, { html: 'Tình trạng' }, { html: 'Mã vận đơn' }, { html: '', label: '' }],
        rows: shipmentAttentionRows,
      })}</div>` : '<div class="empty-state">Các vận đơn cần phục hồi vừa được xử lý xong.</div>'}
      ${Number(td.shipment_attention ?? 0) > shipmentAttention.length ? `<p class="muted" style="font-size:.82rem;margin-bottom:0">Đang hiện ${esc(shipmentAttention.length)} ca mới nhất trong tổng ${esc(td.shipment_attention)} ca.</p>` : ''}
    </div>` : '';

  // Nút pill THÍCH ỨNG: còn việc tồn → dẫn thẳng tới việc đầu tiên đang có (đúng danh sách
  // đã lọc vừa làm ở lô trước); sạch việc → mời thêm sản phẩm. Một dải hero nói y hệt nhau
  // ở mọi trạng thái thì chỉ là trang trí; nói khác nhau thì nó mới có việc để làm.
  //
  // NHÁNH SẠCH-VIỆC cũng phải theo quyền. `firstOpen` lấy từ TODO nên đã lọc rồi, nhưng nhánh
  // dự phòng "+ Thêm sản phẩm" trỏ `/products/new` — cần `catalog.write`. Vai `order_manager`
  // vào một ngày không còn việc tồn đọng thì nút to nhất trên trang dẫn thẳng vào 403. Lỗi
  // này sống được lâu vì nó CHỈ hiện khi mọi ô đều bằng 0 — trạng thái mà không fixture nào
  // dựng, và mọi bộ e2e thì đăng nhập bằng owner.
  const firstOpen = TODO.find((x) => x.n > 0);
  const cta = firstOpen
    ? { href: firstOpen.href, label: `${firstOpen.label} (${firstOpen.n})` }
    : CATALOG_ROLES.has(ctx.role)
      ? { href: `${base}/products/new`, label: '+ Thêm sản phẩm' }
      : { href: `${base}/orders`, label: 'Xem đơn hàng' };
  // Hình thoi trang trí — toạ độ cố định, KHÔNG ngẫu nhiên: dải hero nhảy chỗ mỗi lần tải
  // trang là nhiễu thị giác, và sẽ làm mọi ảnh chụp so sánh trở nên vô dụng.
  const DOTS = [
    { t: '18%', l: '52%', s: 28, c: 'var(--cyan)' },   { t: '62%', l: '58%', s: 16, c: 'var(--magenta)' },
    { t: '30%', l: '68%', s: 40, c: 'var(--sky)' },    { t: '12%', l: '80%', s: 20, c: 'var(--magenta)' },
    { t: '70%', l: '86%', s: 32, c: 'var(--cyan)' },
  ];
  const dots = DOTS.map((d) => `<span class="hb-dot" style="top:${d.t};left:${d.l};width:${d.s}px;height:${d.s}px;background:${d.c}"></span>`).join('');
  const heroBand = `<section class="hero-band" aria-labelledby="hb-shop">
    <span aria-hidden="true">${dots}</span>
    <div class="hb-in">
      <h1 id="hb-shop" class="hb-shop">${esc(ctx.shopName || 'Cửa hàng của bạn')}</h1>
      <p class="hb-line">${openWork > 0 ? `Bạn có <strong>${esc(openWork)}</strong> việc đang chờ xử lý.`
        : notSellable ? 'Khách chưa mua được gì — cần ít nhất một sản phẩm <strong>đang bán và còn hàng</strong>.'
        : 'Không còn việc tồn đọng — cửa hàng đang chạy êm.'}</p>
      <a class="hb-cta" href="${cta.href}">${esc(cta.label)}</a>
    </div></section>`;

  // Cổng là shopStatus === 'active', KHÔNG phải "không có checklist". Ba trạng thái khác
  // đều rơi vào nhánh setup === null: 'suspended'/'terminated' (đang bị cắt dịch vụ — mời
  // họ dùng thêm tính năng "đã nằm trong gói" là vô duyên) và cả trường hợp gọi API lấy
  // shop hỏng (shopStatus = null). Fail-closed: không biết chắc thì không quảng bá.
  // Giới hạn owner/admin: mọi đường dẫn dưới đây đều cần quyền cấu hình, hiện cho nhân
  // viên bán hàng chỉ tổ dẫn họ tới trang 403.
  const canCfg = ctx.role === 'owner' || ctx.role === 'admin';
  // `canCfg` (owner||admin) KHÔNG đủ cho mọi thẻ ở đây — đó là lỗi đã đo được: `DOMAIN_ROLES`
  // chỉ có `owner`, nên `admin` được mời bấm "Tên miền riêng" rồi rơi vào màn từ chối của
  // `renderDomains`. Lối cụt, không phải rò dữ liệu, nhưng vẫn là đúng thứ luật §9.3 cấm.
  //
  // Mỗi thẻ nay khai `see:` riêng, kể cả bốn thẻ hôm nay không đổi hành vi (Set của chúng đều
  // phủ owner+admin). Khai đủ để chốt manifest đối chiếu được TỪNG đích với rbac.js — thẻ
  // không khai chính sách là thẻ không ai kiểm.
  const SUGG = [
    { see: CATALOG_ROLES, t: 'Khuyến mãi & flash sale', d: 'Đặt lịch giảm giá tự động theo khung giờ — giá về đúng cũ khi hết hạn, không phải sửa tay.', href: `${base}/promotions` },
    { see: DOMAIN_ROLES, t: 'Tên miền riêng', d: 'Trỏ tên miền của bạn về cửa hàng, có HTTPS tự động.', href: `${base}/domains` },
    { see: REPORT_ROLES, t: 'Giá vốn & báo cáo lãi', d: 'Nhập giá vốn từng biến thể để báo cáo hiện LÃI THẬT, không chỉ doanh thu.', href: `${base}/reports` },
    { see: INVENTORY_ROLES, t: 'Nhập hàng & kiểm kê', d: 'Phiếu nhập tính giá vốn bình quân, kiểm kê 2 lượt đối chiếu tồn thực tế.', href: `${base}/purchasing` },
    { see: ORDER_ROLES, t: 'Khách hàng', d: 'Xem lịch sử mua của từng khách, ghi chú riêng để chăm sóc lại.', href: `${base}/customers` },
  ].filter((x) => x.see.has(ctx.role));
  const suggCard = (shopStatus === 'active' && canCfg && SUGG.length) ? `<div class="card">
      <h2 style="margin:0 0 4px">Có thể bạn chưa dùng</h2>
      <p class="muted" style="margin:0 0 14px;font-size:13px">Những phần này đã nằm trong gói của bạn.</p>
      <div class="sugg-row">${SUGG.map((x) => `<a class="sugg-card" href="${x.href}">
        <p class="st">${esc(x.t)}</p><p class="sd">${esc(x.d)}</p><span class="sa">Mở ›</span></a>`).join('')}</div>
    </div>` : '';

  return layout('Tổng quan', ctx, `
    ${heroBand}
    ${notice ? `<div class="card hero-lift" style="border-color:var(--good);background:var(--goodbg);color:var(--good)">${esc(notice)}</div>` : ''}
    ${readinessErr && !setup ? `<div class="err hero-lift">${esc(readinessErr)}</div>` : ''}
    ${setupCard ? `<div class="hero-lift">${setupCard}</div>` : ''}
    ${(notice || setupCard) ? todoCard : `<div class="hero-lift">${todoCard}</div>`}
    ${shipmentAttentionCard}
    <div class="dash-hero">
      <p class="eyebrow">Doanh thu 7 ngày gần nhất</p>
      <div class="hero-num">${money(d7)}</div>
      <div class="hero-sub">${delta}<span>Hôm nay <strong>${money(rev.today ?? 0)}</strong> · ${esc(s?.orders_today ?? 0)} đơn mới</span></div>
      ${chart || '<p class="muted" style="margin:14px 0 0">Chưa có dữ liệu doanh thu để vẽ biểu đồ.</p>'}
    </div>
    <div class="metrics">
      ${metric('Doanh thu hôm nay', money(rev.today ?? 0), `${esc(s?.orders_today ?? 0)} đơn mới`)}
      ${metric('Doanh thu 7 ngày', money(rev.d7 ?? 0))}
      ${metric('Cần thu tiền', esc(s?.unpaid ?? 0) + ' đơn', 'chưa thanh toán')}
      ${metric('Tổng đã thu', money(rev.all ?? 0), 'từ trước tới nay')}
    </div>
    <div class="card"><h2 style="margin-top:0">Đơn theo trạng thái</h2>
      <div class="metrics" style="margin-bottom:0">${statusCards}</div>
      <p class="muted" style="font-size:.82rem;margin-bottom:0">Bấm vào một ô để xem danh sách đơn ở trạng thái đó.</p></div>
    <div class="card"><h2 style="margin-top:0">Bán chạy 30 ngày</h2>
      ${top.length ? `<table><thead><tr><th>Sản phẩm</th><th class="right">Đã bán</th><th class="right">Doanh thu</th></tr></thead><tbody>${topRows}</tbody></table>`
        : '<p class="muted">Chưa có đơn đã thanh toán trong 30 ngày.</p>'}</div>
    ${(s?.low_stock ?? []).length ? `<div class="card" style="border-color:#fcd34d;background:#fffbeb"><h2 style="margin-top:0">⚠ Sắp hết hàng</h2>
      <table><thead><tr><th>Sản phẩm</th><th class="right">Còn bán được</th></tr></thead><tbody>
        ${s.low_stock.map((l) => `<tr><td>${esc(l.title)}${l.variant_title ? ` <span class="muted">${esc(l.variant_title)}</span>` : ''} <span class="muted" style="font-size:.8rem">${esc(l.sku ?? '')}</span></td>
          <td class="num right"><strong style="color:${l.available <= 0 ? '#b91c1c' : '#b45309'}">${esc(l.available)}</strong></td></tr>`).join('')}
      </tbody></table>
      <p class="muted" style="font-size:.82rem;margin-bottom:0">${CONTENT_ROLES.has(ctx.role)
        ? `Chỉnh ngưỡng cảnh báo trong <a href="${base}/settings">Cài đặt</a>.`
        : 'Ngưỡng cảnh báo do chủ shop hoặc quản trị viên cấu hình.'} Email nhắc gửi hằng ngày nếu shop có email liên hệ.</p></div>` : ''}
    ${suggCard}
    ${REPORT_ROLES.has(ctx.role) ? `<p style="margin-top:4px"><a class="btn alt sm" href="${base}/reports">Xem báo cáo lợi nhuận chi tiết →</a></p>` : ''}
    <p class="muted" style="font-size:.82rem">Doanh thu ghi tại <strong>ngày thanh toán</strong> (đơn đã từng thu tiền), hoàn tiền trừ tại ngày phiếu; mốc ngày theo giờ Việt Nam.</p>`);
}

// ── BÁO CÁO LỢI NHUẬN (0081) ─────────────────────────────────────────────────
// Chart 2 chuỗi/bucket (thuần + lãi gộp) — mở rộng revenueChart, CO GIÃN theo n
// (red-team: 92 bucket với gap=6 → cột <1px + nhãn đè nhau): gap thích ứng, nhãn
// stride=ceil(n/8). Bucket lỗ (lãi âm) vẽ vạch mờ dưới trục + tooltip số thật.
function profitChart(series) {
  const pts = (Array.isArray(series) ? series : []).filter((p) => p && p.bucket);
  if (!pts.length) return '';
  const n = pts.length;
  const W = 720, H = 190, BOTTOM = 24, TOP = 12;
  const base = H - BOTTOM;
  const gap = n > 62 ? 1 : n > 31 ? 2 : 6;      // cột luôn ≥ ~2px
  const inner = n > 31 ? 0 : 2;                  // khe giữa 2 cột cùng bucket
  const bw = Math.max(2, (W - gap * (n - 1)) / n);
  const colw = Math.max(1, (bw - inner) / 2);
  const rev = pts.map((p) => Number(p.net_revenue_vnd) || 0);
  const pro = pts.map((p) => Number(p.gross_profit_vnd) || 0);
  const max = Math.max(...rev, ...pro, 1);
  const q = (v) => Math.round(v * 10) / 10;
  const lb = (b) => { const p = String(b).split('-'); return p.length === 3 ? `${Number(p[2])}/${Number(p[1])}` : `${Number(p[1])}/${p[0].slice(2)}`; };
  const bar = (x, v, color, title) => {
    if (v > 0) {
      const h = Math.max(2, (v / max) * (base - TOP)), y = q(base - h);
      return `<rect x="${q(x)}" y="${y}" width="${q(colw)}" height="${q(h)}" rx="2" fill="${color}"><title>${title}</title></rect>`;
    }
    // 0 hoặc ÂM: vạch mờ 2px trên trục — tooltip vẫn mang số thật (CSV giữ số âm).
    return `<rect x="${q(x)}" y="${base - 2}" width="${q(colw)}" height="2" fill="var(--bd)"><title>${title}</title></rect>`;
  };
  const bars = pts.map((p, i) => {
    const x = i * (bw + gap);
    const t = `${esc(lb(p.bucket))} · thuần ${esc(money(rev[i]))} · lãi gộp ${esc(money(pro[i]))}`;
    return bar(x, rev[i], 'var(--pri)', t) + bar(x + colw + inner, pro[i], 'var(--good)', t);
  }).join('');
  const stride = Math.max(1, Math.ceil(n / 8));
  const labels = pts.map((p, i) => ((i % stride === 0 || i === n - 1)
    ? `<text x="${(i * (bw + gap) + bw / 2).toFixed(1)}" y="${H - 7}" text-anchor="middle" font-size="11" fill="var(--mut)">${esc(lb(p.bucket))}</text>` : '')).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Doanh thu thuần và lãi gộp theo ${n} kỳ">
      <line x1="0" y1="${base}" x2="${W}" y2="${base}" stroke="var(--bd)" stroke-width="1"/>
      ${bars}${labels}</svg>
    <p class="muted" style="font-size:.82rem;margin:6px 0 0"><span style="color:var(--pri)">■</span> Doanh thu thuần &nbsp; <span style="color:var(--good)">■</span> Lãi gộp — kỳ lỗ hiện vạch mờ (di chuột xem số âm).</p>`;
}

// Trang Báo cáo — no-JS: form GET from/to + preset link server-side (mang đủ tham số),
// khối P&L dọc đúng thứ tự kế toán, badge độ phủ giá vốn, bảng lãi theo SP ('—' khi
// thiếu cost), bảng theo kỳ, 2 nút xuất CSV (owner). d = JSON /reports/sales.
export function renderReports(ctx, shopId, d, f) {
  const base = `/shops/${esc(shopId)}/reports`;
  const { from, to, group } = d.range;
  const t = d.totals, cc = t.cost_coverage;
  const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const sort = d.sort ?? 'revenue';
  // Preset giờ VN — link mang from/to (KHÔNG reset ngầm khi bấm).
  const tv = f.todayVN, mStart = tv.slice(0, 8) + '01';
  const prevM = (() => { let [y, m] = tv.slice(0, 7).split('-').map(Number); m--; if (m < 1) { m = 12; y--; } const s = `${y}-${String(m).padStart(2, '0')}`; const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); return { from: `${s}-01`, to: `${s}-${String(last).padStart(2, '0')}` }; })();
  const addD = (s, k) => new Date(Date.parse(s + 'T00:00:00Z') + k * 86400e3).toISOString().slice(0, 10);
  const cmpOff = d.compare === false;
  // Preset NGÀY giữ link SẠCH (chỉ from+to) — e2e admin-reports assert đúng dạng đó.
  // Preset THÁNG phải kèm &preset= để SERVER biết ý định "tháng" mà chọn kỳ so sánh là
  // tháng dương lịch liền trước (28/29/30/31 ngày), không phải "N ngày trước".
  const presets = [
    { l: 'Hôm nay', from: tv, to: tv },
    { l: '7 ngày', from: addD(tv, -6), to: tv }, { l: '30 ngày', from: addD(tv, -29), to: tv },
    { l: 'Tháng này', from: mStart, to: tv, preset: 'mtd' }, { l: 'Tháng trước', ...prevM, preset: 'last_month' },
  ].map((p) => {
    const extra = { ...(p.preset ? { preset: p.preset } : {}), ...(cmpOff ? { compare: 'off' } : {}) };
    return `<a class="btn ${p.from === from && p.to === to ? '' : 'alt '}sm" href="${base}?${qs({ from: p.from, to: p.to, ...extra })}">${esc(p.l)}</a>`;
  }).join(' ');
  // So sánh KỲ TRƯỚC trên 4 ô chỉ số. Quy ước đã dùng ở Tổng quan: kỳ trước = 0 thì KHÔNG
  // bịa %. Chỉ tiêu có thể ÂM (lãi gộp/lãi vận hành) → % vô nghĩa, hiện CHÊNH TUYỆT ĐỐI.
  const prevT = d.previous?.totals ?? null;
  const delta = (key, { pct = true, money: asMoney = true } = {}) => {
    if (!prevT) return '';
    const cur = Number(d.totals?.[key] ?? 0), pv = Number(prevT[key] ?? 0);
    if (pv === 0) return cur !== 0 ? '<span class="delta flat">● chưa có kỳ trước để so</span>' : '';
    if (!pct || pv < 0 || cur < 0) {
      const diff = cur - pv;
      return `<span class="delta ${diff >= 0 ? 'up' : 'down'}">${diff >= 0 ? '▲' : '▼'} ${asMoney ? money(Math.abs(diff)) : esc(Math.abs(diff))}</span>`;
    }
    const v = Math.round(((cur - pv) / pv) * 100);
    return `<span class="delta ${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '▲' : '▼'} ${esc(Math.abs(v))}%</span>`;
  };
  // AOV có công thức RIÊNG (doanh thu thuần / số đơn) nên phải tự tính chênh lệch của CHÍNH
  // nó. Trước đây ô này gắn nhầm %-biến-động của SỐ ĐƠN — đọc thành "giá trị TB/đơn tăng 12%"
  // trong khi thực ra là số đơn tăng 12%, hai chuyện có thể ngược chiều nhau.
  const aovDelta = () => {
    if (!prevT) return '';
    const co = Number(d.totals?.orders_paid ?? 0), po = Number(prevT.orders_paid ?? 0);
    if (co <= 0 || po <= 0) return '';
    const cur = Number(d.totals.net_revenue_vnd) / co, pv = Number(prevT.net_revenue_vnd) / po;
    if (pv <= 0) return '';
    const v = Math.round(((cur - pv) / pv) * 100);
    return `<span class="delta ${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '▲' : '▼'} ${esc(Math.abs(v))}%</span> so kỳ trước`;
  };
  const pr = d.previous?.range;
  const cmpLine = pr
    ? `<p class="muted" style="font-size:.82rem;margin:8px 0 0">So với kỳ trước: <strong>${esc(pr.from)} → ${esc(pr.to)}</strong> · <a href="${base}?${qs({ from, to, sort, compare: 'off' })}">Tắt so sánh</a></p>`
    : `<p class="muted" style="font-size:.82rem;margin:8px 0 0"><a href="${base}?${qs({ from, to, sort })}">Bật so sánh kỳ trước</a></p>`;
  const neg = (v) => Number(v) < 0 ? ' style="color:#b91c1c"' : '';
  const provisional = cc.pct < 100 ? ' <span class="muted" style="font-weight:400">(tạm tính)</span>' : '';
  // P&L dọc: (−)/(+) chữ rõ ràng, số âm đỏ.
  const pnlRow = (label, v, { bold, sign } = {}) => `<tr${bold ? ' style="font-weight:700"' : ''}>
      <td>${sign ? `<span class="muted">(${sign})</span> ` : ''}${label}</td>
      <td class="num right"${neg(v)}>${money(v)}</td></tr>`;
  const covBadge = cc.pct < 100 ? `<div class="card" style="border-color:#fcd34d;background:#fffbeb;margin-top:10px">
      <p style="margin:0" class="muted">⚠ Giá vốn mới phủ <strong>${esc(cc.pct)}%</strong> doanh thu hàng — còn <strong>${esc(cc.lines_missing_cost)}</strong> dòng đơn chưa có giá vốn
      (${money(cc.revenue_missing_cost_vnd)} doanh thu chưa tính lãi). Nhập thêm ở trang <a href="/shops/${esc(shopId)}/products">Sản phẩm</a> → từng biến thể.</p></div>` : '';
  // PHẢI THU, không phải lỗ — cố ý ĐỨNG NGOÀI bảng P&L. "Lãi 50 triệu" mà 30 triệu đang
  // nằm ở hãng chưa chuyển về là hai tình cảnh rất khác nhau, chủ shop phải thấy cả hai.
  const co = d.totals?.cod_outstanding;
  const outstandingNote = co && co.amount_vnd > 0 ? `<div class="card" style="border-color:#bfdbfe;background:#eff6ff;margin-top:10px">
      <p style="margin:0" class="muted">🚚 Hãng đang giữ <strong>${money(co.amount_vnd)}</strong> của <strong>${esc(co.orders)}</strong> đơn đã giao nhưng
      chưa chuyển tiền về. Khoản này <strong>không</strong> trừ vào lãi (tiền vẫn của bạn) — đối chiếu ở trang
      <a href="/shops/${esc(shopId)}/cod">Đối soát COD</a>.</p></div>` : '';
  const sortLink = (k, label) => sort === k ? `<strong>${label}</strong>` : `<a href="${base}?${qs({ from, to, group, sort: k })}">${label}</a>`;
  // `neg(v)` trả về nguyên một chuỗi thuộc tính (` style="…"` hoặc rỗng) chứ không trả
  // giá trị CSS, nên nó đi vào `attrs` của ô, không đi vào `style`.
  const prodRows = (d.by_product ?? []).map((p) => [
    { html: `${esc(p.title)} <span class="muted">${esc(p.sku ?? '')}</span>` },
    { cls: 'num right', html: esc(p.qty) },
    { cls: 'num right', html: money(p.revenue_vnd) },
    { cls: 'num right', html: p.cogs_vnd == null ? '<span class="muted">—</span>' : money(p.cogs_vnd) },
    { cls: 'num right', attrs: p.profit_vnd != null ? neg(p.profit_vnd) : '', html: p.profit_vnd == null ? '<span class="muted">—</span>' : money(p.profit_vnd) },
    { cls: 'num right', html: p.margin_pct == null ? '<span class="muted">—</span>' : esc(p.margin_pct) + '%' },
  ]);
  const bucketRows = d.series.map((s) => [
    { cls: 'num', html: esc(s.bucket) },
    { cls: 'num right', html: esc(s.orders_paid) },
    { cls: 'num right', html: money(s.net_revenue_vnd) },
    { cls: 'num right', attrs: neg(s.gross_profit_vnd), html: money(s.gross_profit_vnd) },
    { cls: 'num right', attrs: neg(s.operating_profit_vnd), html: money(s.operating_profit_vnd) },
  ]);
  const exportBtns = EXPORT_ROLES.has(ctx.role) ? `<div class="actions" style="margin-top:10px">
      <form method="POST" action="${base}/export"><input type="hidden" name="type" value="pnl"><input type="hidden" name="from" value="${esc(from)}"><input type="hidden" name="to" value="${esc(to)}"><input type="hidden" name="group" value="${esc(group)}"><button class="btn alt sm" type="submit">Xuất CSV theo kỳ</button></form>
      <form method="POST" action="${base}/export"><input type="hidden" name="type" value="products"><input type="hidden" name="from" value="${esc(from)}"><input type="hidden" name="to" value="${esc(to)}"><button class="btn alt sm" type="submit">Xuất CSV theo sản phẩm</button></form>
    </div>` : '';
  return layout('Báo cáo', ctx, `
    <h1>Báo cáo lợi nhuận</h1>
    <div class="card">
      <form method="GET" action="${base}" class="actions" style="align-items:end">
        <div><label>Từ ngày</label><input type="date" name="from" value="${esc(from)}"></div>
        <div><label>Đến ngày</label><input type="date" name="to" value="${esc(to)}"></div>
        <input type="hidden" name="sort" value="${esc(sort)}">
        ${cmpOff ? '<input type="hidden" name="compare" value="off">' : ''}
        <button class="btn sm" type="submit">Xem</button>
        <span style="flex:1"></span>${presets}
      </form>
      ${group === 'month' ? '<p class="muted" style="font-size:.82rem;margin:8px 0 0">Kỳ dài — số liệu gộp theo <strong>tháng</strong>.</p>' : ''}
      ${cmpLine}
    </div>
    <div class="metrics">
      <div class="metric"><div class="l">Doanh thu thuần</div><div class="v">${money(t.net_revenue_vnd)}</div><div class="l">${esc(t.orders_paid)} đơn đã thu tiền ${delta('net_revenue_vnd')}</div></div>
      <div class="metric"><div class="l">Lãi gộp${provisional}</div><div class="v"${neg(t.gross_profit_vnd)}>${money(t.gross_profit_vnd)}</div>
        <div class="l">${t.net_revenue_vnd > 0 ? `biên ${Math.round((t.gross_profit_vnd / t.net_revenue_vnd) * 100)}%` : ''} ${delta('gross_profit_vnd', { pct: false })}</div></div>
      <div class="metric"><div class="l">Lãi vận hành${provisional}</div><div class="v"${neg(t.operating_profit_vnd)}>${money(t.operating_profit_vnd)}</div><div class="l">gồm ship & phí hãng ${delta('operating_profit_vnd', { pct: false })}</div></div>
      <div class="metric"><div class="l">Giá trị TB/đơn</div><div class="v">${money(t.orders_paid > 0 ? Math.round(t.net_revenue_vnd / t.orders_paid) : 0)}</div><div class="l">${aovDelta()}</div></div>
    </div>
    <div class="card"><h2 style="margin-top:0">Doanh thu thuần & lãi gộp theo ${group === 'month' ? 'tháng' : 'ngày'}</h2>
      ${profitChart(d.series) || '<p class="muted">Chưa có dữ liệu trong kỳ.</p>'}</div>
    <div class="card"><h2 style="margin-top:0">Kết quả kinh doanh (P&amp;L)</h2>
      <table><tbody>
        ${pnlRow('Doanh thu hàng', t.revenue_goods_vnd)}
        ${pnlRow('Hoàn tiền <span class="muted" style="font-weight:400;font-size:.82rem">(phiếu hoàn có thể gồm phần ship)</span>', -t.refunds_vnd, { sign: '−' })}
        ${pnlRow('Doanh thu thuần', t.net_revenue_vnd, { bold: true })}
        ${pnlRow('Giá vốn hàng bán (COGS)', -t.cogs_vnd, { sign: '−' })}
        ${pnlRow('Giá vốn hàng trả về kho', t.cogs_reversal_vnd, { sign: '+' })}
        ${pnlRow(`LÃI GỘP${provisional}`, t.gross_profit_vnd, { bold: true })}
        ${pnlRow('Thu phí ship của khách', t.shipping_income_vnd, { sign: '+' })}
        ${pnlRow('Phí hãng vận chuyển <span class="muted" style="font-weight:400;font-size:.82rem">(báo giá lúc tạo vận đơn)</span>', -t.carrier_fee_vnd, { sign: '−' })}
        ${pnlRow('Chênh lệch đối soát hãng <span class="muted" style="font-weight:400;font-size:.82rem">(tiền hãng THỰC chuyển so với kỳ vọng)</span>', t.settlement_variance_vnd, { sign: t.settlement_variance_vnd < 0 ? '−' : '+' })}
        ${pnlRow('Hoa hồng cộng tác viên <span class="muted" style="font-weight:400;font-size:.82rem">(tại ngày đủ điều kiện — chưa tính khoản còn tạm tính)</span>', -t.affiliate_commission_vnd, { sign: '−' })}
        ${pnlRow(`Lãi vận hành${provisional}`, t.operating_profit_vnd, { bold: true })}
      </tbody></table>
      ${covBadge}
      ${outstandingNote}
      ${exportBtns}
    </div>
    <div class="card"><h2 style="margin-top:0">Lãi theo sản phẩm${d.products_truncated ? ' <span class="muted" style="font-size:.82rem">(top 100)</span>' : ''}</h2>
      ${prodRows.length ? `${tblCards({
        head: [
          { html: 'Sản phẩm' }, { html: sortLink('qty', 'SL'), cls: 'right' }, { html: sortLink('revenue', 'Doanh thu'), cls: 'right' },
          { html: 'Giá vốn', cls: 'right' }, { html: sortLink('profit', 'Lãi'), cls: 'right' }, { html: 'Biên', cls: 'right' },
        ],
        rows: prodRows,
      })}
      <p class="muted" style="font-size:.8rem;margin-bottom:0">Doanh thu theo dòng hàng, CHƯA trừ giảm giá cấp đơn + hoàn/trả. Dòng "—" chưa có giá vốn.</p>` : '<p class="muted">Chưa có dữ liệu.</p>'}</div>
    <div class="card"><h2 style="margin-top:0">Theo ${group === 'month' ? 'tháng' : 'ngày'}</h2>
      ${tblCards({
    head: [{ html: 'Kỳ' }, { html: 'Đơn', cls: 'right' }, { html: 'Thuần', cls: 'right' }, { html: 'Lãi gộp', cls: 'right' }, { html: 'Lãi VH', cls: 'right' }],
    rows: bucketRows,
  })}</div>
    <p class="muted" style="font-size:.82rem">Doanh thu ghi tại <strong>ngày thanh toán</strong>; hoàn/trả trừ tại <strong>ngày phiếu</strong>; giá vốn chốt tại <strong>thời điểm đặt hàng</strong>; số kỳ cũ có thể thay đổi khi sửa đơn đã trả; mốc ngày giờ Việt Nam. Lãi vận hành chưa gồm phí nền tảng/quảng cáo/đóng gói.</p>`);
}

// Interstitial mật khẩu cho xuất CSV báo cáo — mang theo type/from/to/group (hidden).
// Màn nhập-lại-mật-khẩu trước khi tải CSV. Dùng chung cho Báo cáo và Đơn hàng — chỉ khác
// trang gốc + câu giải thích, nên tham số hoá thay vì nhân bản.
// LƯU Ý: mọi trường lọc PHẢI được phát lại thành hidden, nếu không nhập mật khẩu xong sẽ
// xuất nhầm phạm vi (mất bộ lọc người dùng đang xem).
export function renderReportsStepUp(ctx, shopId, fields, err, opts = {}) {
  const section = opts.section ?? 'reports';
  const why = opts.why ?? 'Xuất báo cáo là thao tác nhạy cảm — nhập mật khẩu của bạn để tiếp tục.';
  const base = `/shops/${esc(shopId)}/${esc(section)}`;
  // action/nhãn nút mở ra tham số để trang khác (Kết nối 0120) dùng CHUNG màn xác nhận
  // này. Mặc định giữ nguyên đường xuất CSV nên mọi nơi gọi cũ không đổi hành vi.
  const action = opts.action ?? `${base}/export/step-up`;
  const submitLabel = opts.submitLabel ?? 'Xác nhận & tải CSV';
  const keep = Object.entries(fields ?? {}).filter(([k, v]) => v != null && k !== 'password')
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return layout('Xác nhận mật khẩu', ctx, `<div class="center"><div class="card">
    <h1>Xác nhận mật khẩu</h1>
    <p class="muted">${esc(why)}</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="${esc(action)}">
      ${keep}
      <label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">
      <button class="btn" type="submit" style="width:100%;margin-top:12px">${esc(submitLabel)}</button>
    </form>
    <a class="muted" href="${base}" style="display:inline-block;margin-top:10px">← Huỷ</a>
  </div></div>`);
}

export function renderDashboard(ctx, shops, isStaff = false) {
  const initial = (name) => esc((String(name || '?').trim()[0] || '?').toUpperCase());
  const shopCard = (s) => {
    const nm = s.name || s.shop_id;
    const stLabel = SHOP_STATUS[s.status] || s.status;
    // Cả thẻ là 1 link → tới trang đầu tiên vai trò được phép (owner/admin/order → Tổng quan).
    const home = ORDER_ROLES.has(s.role) ? 'overview' : CATALOG_ROLES.has(s.role) ? 'products' : MEMBER_READ_ROLES.has(s.role) ? 'members' : 'overview';
    return `<a class="shop-card" href="/shops/${esc(s.shop_id)}/${home}">
      <div class="sc-head">
        <div class="sc-avatar">${initial(s.name)}</div>
        <div><div class="sc-name">${esc(nm)}</div>
          <div class="sc-meta">${s.status ? badge(s.status, stLabel) : ''}<span class="role">${esc(ROLE_LABEL[s.role] || s.role)}</span></div></div>
      </div>
      <div class="sc-go">Vào quản lý <span class="arr">→</span></div>
    </a>`;
  };
  const n = shops.length;
  return layout('Bảng điều khiển', ctx, `
    <div class="dash-hero">
      <p class="eyebrow">Bảng điều khiển</p>
      <h1>Xin chào 👋</h1>
      <p>${n ? `Bạn đang quản lý ${n} cửa hàng — chọn một để tiếp tục.` : 'Chào mừng bạn đến với trang quản trị.'}</p>
    </div>
    ${isStaff ? `<div class="staffbar"><span><strong>Nhân viên nền tảng</strong> · Bạn có quyền truy cập Console vận hành.</span><a class="btn sm" href="/platform">Mở Console →</a></div>` : ''}
    ${n ? `<div class="shop-grid">${shops.map(shopCard).join('')}</div>`
        : `<div class="card"><h2 style="margin-top:0">Chưa có cửa hàng</h2><p class="muted" style="margin:0">Bạn chưa được thêm vào cửa hàng nào. Liên hệ nền tảng để được cấp cửa hàng, hoặc nhờ chủ shop mời bạn vào bằng email này.</p></div>`}`);
}

const STATUSES = ['', 'pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'returned'];
// ── Tạo đơn thủ công: form no-JS 5 slot (select biến thể + SL), khách, thanh toán ──
// picker {q, truncated}: ô tìm GET lọc danh sách biến thể phía seller (?q= tên không
// dấu / SKU) — shop >500 biến thể vẫn chọn được đúng hàng.
export function renderOrderNew(ctx, shopId, variants, idem, err, form, picker) {
  const base = `/shops/${esc(shopId)}`;
  const money = (v) => new Intl.NumberFormat('vi-VN').format(Number(v)) + '₫';
  const pq = picker?.q ?? '';
  // <optgroup> theo sản phẩm → chọn nhanh không cần JS. Hiện giá + tồn ngay trong nhãn.
  const byProduct = new Map();
  for (const v of variants) { if (!byProduct.has(v.product_title)) byProduct.set(v.product_title, []); byProduct.get(v.product_title).push(v); }
  const chosen = Array.isArray(form?.lines) ? form.lines : [];
  const options = (sel) => [...byProduct.entries()].map(([pt, vs]) => `<optgroup label="${esc(pt)}">${vs.map((v) =>
    `<option value="${esc(v.id)}"${sel === v.id ? ' selected' : ''}>${esc(v.variant_title ? `${pt} — ${v.variant_title}` : pt)}${v.sku ? ` [${esc(v.sku)}]` : ''} · ${money(v.price_vnd)} · còn ${esc(v.available)}</option>`).join('')}</optgroup>`).join('');
  const slot = (i) => `<div class="grid2" style="grid-template-columns:1fr 90px;align-items:end">
    <div><label>Sản phẩm ${i + 1}${i === 0 ? ' *' : ' (tuỳ chọn)'}</label>
      <select name="variant_id"${i === 0 ? ' required' : ''}>
        <option value="">— ${i === 0 ? 'Chọn sản phẩm' : 'Bỏ trống'} —</option>${options(chosen[i]?.variant_id)}
      </select></div>
    <div><label>SL</label><input name="qty" type="number" min="1" max="1000" value="${esc(chosen[i]?.qty || 1)}" inputmode="numeric"></div>
  </div>`;
  const v = (k) => esc(form?.[k] ?? '');
  return layout('Tạo đơn', ctx, `
    <a class="muted" href="${base}/orders">← Danh sách đơn</a>
    <h1>Tạo đơn thủ công</h1>
    <p class="muted" style="margin-top:-6px">Chốt đơn qua Facebook/Zalo? Gõ vào đây: trừ tồn, tính giá server, in đơn, tạo vận đơn như đơn thường.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <div class="card"><form method="GET" action="${base}/orders/new" class="actions" style="align-items:end;flex-wrap:wrap">
      <div style="flex:1 1 220px"><label>Tìm sản phẩm cho ô chọn (tên / SKU — không cần dấu)</label>
        <input name="q" value="${esc(pq)}" maxlength="100" placeholder="ghe sofa, SKU…"></div>
      <button class="btn alt sm" type="submit">Lọc danh sách</button>
      ${pq ? `<a class="muted" href="${base}/orders/new" style="align-self:center">Xoá lọc</a>` : ''}
      ${picker?.truncated ? `<p class="muted" style="flex-basis:100%;margin:6px 0 0">⚠ Đang hiện 500 biến thể đầu — còn nhiều hơn, hãy tìm kiếm để thu hẹp.</p>` : ''}
    </form></div>
    ${variants.length ? `<form method="POST" action="${base}/orders/new">
      <input type="hidden" name="idem" value="${esc(idem)}">
      <input type="hidden" name="picker_q" value="${esc(pq)}">
      <div class="card"><h2 style="margin-top:0">Hàng${pq ? ` <span class="muted" style="font-weight:400;font-size:.85rem">(đang lọc theo “${esc(pq)}”)</span>` : ''}</h2>${[0, 1, 2, 3, 4].map(slot).join('')}</div>
      <div class="card"><h2 style="margin-top:0">Khách nhận</h2>
        <div class="grid2">
          <div><label>Họ tên *</label><input name="name" required maxlength="120" value="${v('name')}"></div>
          <div><label>SĐT *</label><input name="phone" required inputmode="tel" placeholder="09xxxxxxxx" value="${v('phone')}"></div>
        </div>
        <label>Email (tuỳ chọn — khách nhận xác nhận + link tra cứu/QR)</label><input name="email" type="email" value="${v('email')}">
        <label>Địa chỉ giao</label><input name="address_line" maxlength="300" placeholder="Số nhà, đường, phường/xã, quận/huyện" value="${v('address_line')}">
        <label>Tỉnh / Thành (tuỳ chọn — cần đúng để tạo vận đơn hãng)</label>
        <select name="province"><option value="">— Không ghi —</option>${PROVINCES.map((p) => `<option value="${esc(p)}"${form?.province === p ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select>
      </div>
      <div class="card"><h2 style="margin-top:0">Đơn này đến từ đâu</h2>
        <p class="muted" style="font-size:.85rem;margin-top:0">Ghi đúng nguồn thì trang Đơn hàng lọc được và báo cáo trả lời được câu "tháng này Facebook mang về bao nhiêu đơn". Dán thêm link đoạn chat để sau mở đơn là bấm về đúng cuộc hội thoại.</p>
        <div class="grid2">
          <div><label>Nguồn đơn</label><select name="source">${ORDER_SOURCE_PICK.map((k) => `<option value="${esc(k)}"${(form?.source ?? 'manual') === k ? ' selected' : ''}>${esc(ORDER_SOURCE_LABEL[k])}</option>`).join('')}</select></div>
          <div><label>Link / mã hội thoại (tuỳ chọn)</label><input name="source_ref" maxlength="200" placeholder="vd m.me/pagecuaban hoặc SĐT Zalo" value="${v('source_ref')}"></div>
        </div>
      </div>
      <div class="card"><h2 style="margin-top:0">Thanh toán & phí</h2>
        <label style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="radio" name="payment_method" value="cod"${form?.payment_method === 'qr' ? '' : ' checked'} style="width:auto"> COD — thu khi giao</label>
        <label style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="radio" name="payment_method" value="qr"${form?.payment_method === 'qr' ? ' checked' : ''} style="width:auto"> Chuyển khoản QR (tự đối soát theo mã đơn)</label>
        <div class="grid2">
          <div><label>Phí ship (đ — bỏ trống = tính theo cấu hình shop)</label><input name="ship_fee_vnd" inputmode="numeric" placeholder="vd 25000" value="${v('ship_fee_vnd')}"></div>
          <div><label>Ghi chú nội bộ (tuỳ chọn)</label><input name="note" maxlength="500" value="${v('note')}"></div>
        </div>
      </div>
      <button class="btn" type="submit">Tạo đơn</button>
    </form>` : `<div class="card"><p class="muted" style="margin:0">${pq ? `Không có sản phẩm nào khớp “${esc(pq)}” — thử từ khoá khác hoặc xoá lọc.` : 'Chưa có sản phẩm đang bán nào — thêm sản phẩm trước.'}</p></div>`}`);
}

// filter.payment: tình trạng thanh toán đang lọc (đến từ ô số liệu ở Tổng quan).
export function renderOrders(ctx, shopId, data, filter) {
  const orders = data.orders ?? [];
  // Cảnh báo khi 1 NGUỒN (mạng/kết nối) có ≥4 SĐT KHÁC NHAU đơn chưa xử lý — dấu hiệu 1 kẻ
  // giả nhiều khách. Đếm SĐT phân biệt (không đếm số đơn thô) để tránh báo nhầm mạng chung (CGNAT).
  const SUSPICIOUS_MIN = 4;
  const flagged = orders.filter((o) => Number(o.same_ip_phones) >= SUSPICIOUS_MIN).length;
  const rows = orders.map((o) => {
    const susp = Number(o.same_ip_phones) >= SUSPICIOUS_MIN;
    const externalReadOnly = ['kiotviet_pos', 'sapo_pos'].includes(o.source) || Boolean(o.external_ref);
    return [
      { label: '', html: externalReadOnly
        ? `<span class="muted" title="Đơn đã thuộc hệ thống POS ngoài; không xử lý hàng loạt tại đây">—</span>`
        : `<input type="checkbox" name="order_ids" value="${esc(o.id)}" form="bulkf" aria-label="Chọn đơn ${esc(o.order_number)}">` },
      { html: `<a href="/shops/${esc(shopId)}/orders/${esc(o.id)}">#${esc(o.order_number)}</a>` },
      { html: badge(o.status, STATUS[o.status] ?? o.status) },
      { html: `${badge(o.payment_status, PAY[o.payment_status] ?? o.payment_status)} <span class="muted">${esc(o.payment_method?.toUpperCase() ?? '')}</span>` },
      { html: `${esc(o.customer_name)}${susp ? ` <span class="badge cancelled" title="Cùng nguồn mạng với ${esc(o.same_ip_phones)} SĐT khác nhau đang chờ xử lý — kiểm tra kẻo đơn ảo">⚠ ${esc(o.same_ip_phones)} SĐT cùng nguồn</span>` : ''}` },
      { html: o.source ? `<span class="badge">${esc(ORDER_SOURCE_LABEL[o.source] ?? o.source)}</span>${
        o.sync_status === 'pending' ? ' <span class="badge wait">Đang đồng bộ</span>'
        : o.sync_status === 'needs_attention' ? ' <span class="badge cancelled">Cần xử lý</span>'
        : o.sync_status === 'synced' ? ' <span class="badge ok">Đã đồng bộ</span>' : ''}`
        : (o.is_migrated ? '<span class="muted">Nhập từ sàn cũ</span>' : '<span class="muted">—</span>') },
      { cls: 'muted', html: dt(o.created_at) },
      { style: 'text-align:right', html: `<strong>${money(o.total_vnd)}</strong>` },
    ];
  });
  const total = data.total ?? orders.length;
  const off = filter.offset, lim = filter.limit;
  const qenc = encodeURIComponent(filter.q ?? '');
  // MỌI đường rời trang này phải mang THEO ĐỦ bộ lọc. `payment` từng bị bỏ quên ở CẢ BỐN
  // nơi (phân trang, tab trạng thái, nút Xuất CSV, và hàm dựng query của BFF) — mà đường vào
  // mặc định của nó là ô "Đơn chưa thu tiền" trên Tổng quan. Người bán bấm vào đó rồi sang
  // trang 2, hoặc đổi tab, hoặc bấm Xuất CSV là bộ lọc BIẾN MẤT không báo gì.
  // `limit` cũng phải đi theo: chọn 100 dòng rồi bấm "Sau →" mà rơi về 20 thì người bán mất
  // chỗ đang đứng và phải chọn lại — đúng kiểu mất-bộ-lọc mà chú thích trên đang nói tới.
  const limQ = filter.limit && filter.limit !== 20 ? `&limit=${esc(filter.limit)}` : '';
  const nav = (o) => `?status=${esc(filter.status ?? '')}&q=${qenc}&from=${esc(filter.from ?? '')}&to=${esc(filter.to ?? '')}&source=${esc(filter.source ?? '')}&payment=${esc(filter.payment ?? '')}&migrated=${esc(filter.migrated ?? '')}${limQ}&offset=${o}`;
  // TAB trạng thái kèm SỐ ĐẾM (thay <select> cũ) — mẫu quen thuộc của TikTok Shop/Shopee:
  // nhìn là biết "còn 12 đơn chờ xác nhận", bấm 1 phát là lọc. Số đếm tôn trọng ô tìm kiếm
  // + khoảng ngày đang áp (nhưng không tính chính mệnh đề trạng thái) nên luôn khớp kết quả.
  // Giữ nguyên q/from/to khi đổi tab để không mất bộ lọc người dùng đang xem.
  const cnts = data.counts ?? {};
  const keep = `&q=${qenc}&from=${esc(filter.from ?? '')}&to=${esc(filter.to ?? '')}&source=${esc(filter.source ?? '')}&payment=${esc(filter.payment ?? '')}&migrated=${esc(filter.migrated ?? '')}${limQ}`;
  const statusTabs = `<div class="stabs" role="tablist" aria-label="Lọc theo trạng thái">${
    STATUSES.map((s) => {
      const on = (filter.status ?? '') === s;
      const label = s ? (STATUS[s] ?? s) : 'Tất cả';
      const n = cnts[s];
      return `<a class="stab${on ? ' on' : ''}" href="?status=${esc(s)}${keep}"${on ? ' aria-current="page"' : ''}>${esc(label)}${
        n != null ? `<span class="cnt">${esc(n)}</span>` : ''}</a>`;
    }).join('')}</div>`;
  // CHIP "ĐANG LỌC" cho các bộ lọc KHÔNG có ô nhập trong form Lọc — chúng chỉ tới từ link
  // trên Tổng quan. Không nói ra thì người bán nhìn một tập hẹp mà tưởng là toàn bộ đơn, và
  // không có lối quay ra ngoài việc sửa URL. `payment` đã có chip từ trước; `migrated` là chỗ
  // thứ hai cùng dạng nên dùng chung một khuôn thay vì chép thêm một nhánh nữa.
  //
  // Mỗi chip xoá ĐÚNG CHÍNH NÓ và giữ các bộ lọc còn lại. Bản trước dựng lại href từ đúng
  // hai trường (status + q) nên bấm "Xoá bộ lọc" ở màn "chưa thu tiền" là mất luôn khoảng
  // ngày và nguồn đơn người bán vừa chọn — một cú xoá rộng hơn thứ họ định xoá.
  const chipHref = (bo) => `?${new URLSearchParams(Object.entries({
    status: filter.status, q: filter.q, from: filter.from, to: filter.to,
    source: filter.source, payment: filter.payment, migrated: filter.migrated,
  }).filter(([k, v]) => k !== bo && v)).toString()}`;
  // Nhãn nói theo NGHIỆP VỤ, không theo tên tham số: "migrated=0" không nói được gì với
  // người bán, còn "không gồm đơn nhập từ sàn cũ" thì giải thích luôn vì sao số ở đây khác
  // số họ vừa thấy ở nơi khác.
  const MIGRATED_LABEL = { 0: 'Không gồm đơn nhập từ sàn cũ', 1: 'Chỉ đơn nhập từ sàn cũ' };
  const chips = [
    filter.payment ? [PAYMENT_LABEL[filter.payment] ?? filter.payment, chipHref('payment')] : null,
    filter.migrated ? [MIGRATED_LABEL[filter.migrated], chipHref('migrated')] : null,
  ].filter(Boolean);
  const filterChips = chips.length
    ? `<p class="muted" style="margin:0 0 10px">Đang lọc: ${chips.map(([lbl, href]) =>
      `<strong>${esc(lbl)}</strong> <a href="${esc(href)}">Xoá bộ lọc</a>`).join(' · ')}</p>`
    : '';
  // Xuất CSV theo ĐÚNG bộ lọc đang xem — hidden mang nguyên status/q/from/to sang POST.
  // Chỉ chủ shop (EXPORT_ROLES) thấy nút: file chứa SĐT + địa chỉ khách hàng loạt.
  // Form Lọc bên dưới mang `payment` ở dạng hidden: đây là chỗ THỨ NĂM từng đánh rơi nó.
  // Bấm "Lọc" từ màn "Đơn chưa thu tiền" mà mất điều kiện là người bán lặng lẽ nhìn nhầm
  // tập đơn — và nút xuất ngay cạnh sẽ xuất theo cái nhầm đó.
  // (Chú thích để ở JS, KHÔNG dùng <!-- --> : chú thích HTML lọt ra trang người dùng, và
  //  một khẳng định e2e khác grep đúng chuỗi trong đó → đỏ vì lý do không liên quan.)
  const exportBtn = EXPORT_ROLES.has(ctx.role) ? `<form method="POST" action="/shops/${esc(shopId)}/orders/export" style="display:inline">
        <input type="hidden" name="status" value="${esc(filter.status ?? '')}">
        <input type="hidden" name="q" value="${esc(filter.q ?? '')}">
        <input type="hidden" name="from" value="${esc(filter.from ?? '')}">
        <input type="hidden" name="to" value="${esc(filter.to ?? '')}">
        <input type="hidden" name="source" value="${esc(filter.source ?? '')}">
        <input type="hidden" name="payment" value="${esc(filter.payment ?? '')}">
        <input type="hidden" name="migrated" value="${esc(filter.migrated ?? '')}">
        <button class="btn alt" type="submit">⬇ Xuất CSV</button></form>` : '';
  return layout('Đơn hàng', ctx, `<div class="toolbar"><h1 style="margin:0">Đơn hàng</h1>
      <span class="actions">${exportBtn}<a class="btn" href="/shops/${esc(shopId)}/orders/new">+ Tạo đơn</a></span></div>
    ${flagged ? `<div class="card" style="background:#fef3c7;border-color:#fcd34d;color:#92400e"><strong>⚠ ${flagged} đơn nghi ngờ (đơn ảo?)</strong> — một nguồn mạng có nhiều SĐT khác nhau đang chờ xử lý. Kiểm tra kỹ trước khi giao; <strong>huỷ đơn ảo để trả lại tồn kho</strong>. (Đơn COD không xác nhận sẽ tự huỷ sau ${esc(7)} ngày.)</div>` : ''}
    ${statusTabs}
    <!-- Bộ lọc GẬP trên điện thoại. Đo ở 375×812: bộ lọc cao 408px + thẻ nút hàng loạt đẩy
         ĐƠN ĐẦU TIÊN xuống y=938, tức DƯỚI mép màn hình (812) — chủ shop mở "Đơn hàng" trên
         điện thoại thấy đúng một rừng ô lọc và KHÔNG thấy đơn nào. Thứ họ vào để xem bị đẩy
         khỏi tầm mắt. <details> thuần CSS: máy tính mở sẵn (đủ chỗ), điện thoại gập lại. -->
    <details class="card filt-wrap"${(filter.q || filter.from || filter.to || filter.source) ? ' open' : ''}>
      <summary class="filt-sum">Lọc &amp; tìm đơn${(filter.q || filter.from || filter.to || filter.source) ? ' <strong>(đang lọc)</strong>' : ''}</summary>
      <form method="GET" class="filters">
      <input type="hidden" name="status" value="${esc(filter.status ?? '')}">
      <input type="hidden" name="payment" value="${esc(filter.payment ?? '')}">
      <input type="hidden" name="migrated" value="${esc(filter.migrated ?? '')}">
      <div style="flex:1 1 200px"><label>Tìm (mã đơn / tên / SĐT)</label><input name="q" value="${esc(filter.q ?? '')}" placeholder="123, Nguyễn…, 09…"></div>
      <div><label>Từ ngày</label><input type="date" name="from" value="${esc(filter.from ?? '')}"></div>
      <div><label>Đến ngày</label><input type="date" name="to" value="${esc(filter.to ?? '')}"></div>
      <div><label>Nguồn</label><select name="source"><option value="">— Tất cả —</option>${
        Object.entries(ORDER_SOURCE_LABEL).map(([k, lbl]) => `<option value="${esc(k)}"${(filter.source ?? '') === k ? ' selected' : ''}>${esc(lbl)}</option>`).join('')}</select></div>
      <div><button class="btn alt sm" type="submit">Lọc</button></div>
    </form></details>
    <div class="card">
      <!-- Chip "đang lọc" nằm NGOÀI nhánh có-dòng: lọc ra 0 kết quả mà không nói đang lọc gì
           thì người bán thấy trang trống và không hiểu vì sao, cũng không có lối quay ra. -->
      ${filter.actionError ? `<div class="err">${esc(filter.actionError)}</div>` : ''}
      ${filter.bulk ? `<p class="ok" style="margin:0 0 10px">${esc(filter.bulk)}</p>` : ''}
      ${filterChips}
      ${orders.length ? `
      <form id="bulkf" method="POST" action="/shops/${esc(shopId)}/orders/bulk-confirm" class="actions" style="margin-bottom:10px">
        <!-- Bộ lọc đang xem đi kèm để làm xong còn QUAY VỀ ĐÚNG CHỖ ĐANG ĐỨNG (xem veLai ở BFF).
             Thiếu mấy dòng này là người bán bị đá về tab "Tất cả" sau mỗi lượt hàng loạt. -->
        ${['status', 'q', 'from', 'to', 'source', 'payment', 'migrated'].map((k) => `<input type="hidden" name="${k}" value="${esc(filter[k] ?? '')}">`).join('')}
        <input type="hidden" name="limit" value="${esc(filter.limit ?? '')}">
        <input type="hidden" name="offset" value="${esc(filter.offset ?? '')}">
        <button class="btn sm" type="submit">✓ Xác nhận các đơn đã chọn</button>
        <button class="btn sm" type="submit" formaction="/shops/${esc(shopId)}/orders/bulk-ship" data-confirm="Chuyển các đơn ĐANG CHỌN sang 'đang giao'? Mỗi đơn sẽ gửi ngay một email báo khách, và KHÔNG có nút lùi — muốn quay lại chỉ còn cách đánh dấu 'bom hàng', tức gắn nhãn xấu cho khách tử tế.">🚚 Giao các đơn đã chọn</button>
        ${ctx.role === 'owner' ? `<button class="btn alt sm" type="submit" formaction="/shops/${esc(shopId)}/orders/bulk-mark-paid" data-confirm="Xác nhận ĐÃ CẦM TIỀN MẶT của TẤT CẢ các đơn đang chọn? Việc này ghi thẳng vào doanh thu — bấm nhầm là báo cáo lãi/lỗ sai và phải gỡ từng đơn một.">₫ Đã nhận tiền (COD)</button>` : ''}
        <button class="btn alt sm" type="submit" formaction="/shops/${esc(shopId)}/orders/print-batch" formmethod="get" formtarget="_blank">🖨 In các đơn đã chọn</button>
        <span class="muted" data-bulk-count="order_ids" hidden style="font-size:13px"></span>
        <span class="muted" style="font-size:.82rem">Tích ô ở đầu bảng để chọn cả trang (xác nhận: chỉ đơn "Chờ xử lý"; giao: chỉ đơn đã xác nhận, KHÔNG gồm đơn đang gửi qua hãng vận chuyển${ctx.role === 'owner' ? '; nhận tiền: chỉ đơn COD chưa thu' : ''}; đơn khác tự bỏ qua).</span>
      </form>
      ${tblCards({
    head: [
      { html: '<input type="checkbox" data-bulk-all="order_ids" form="bulkf" hidden aria-label="Chọn tất cả đơn trên trang">', label: '' },
      { html: 'Đơn' }, { html: 'Trạng thái' }, { html: 'Thanh toán' }, { html: 'Khách' },
      { html: 'Nguồn' }, { html: 'Thời gian' }, { html: 'Tổng', style: 'text-align:right' },
    ],
    rows,
  })}
      <div class="muted" style="margin-top:12px">${total} đơn ·
        ${off > 0 ? `<a href="${nav(Math.max(0, off - lim))}">← Trước</a>` : '<span style="color:#d1d5db">← Trước</span>'} ·
        ${off + lim < total ? `<a href="${nav(off + lim)}">Sau →</a>` : '<span style="color:#d1d5db">Sau →</span>'}
        · <span style="white-space:nowrap">Mỗi trang: ${[20, 50, 100].map((n) => (n === lim
          ? `<strong>${n}</strong>`
          : `<a href="?status=${esc(filter.status ?? '')}${keep.replace(limQ, '')}${n === 20 ? '' : `&limit=${n}`}&offset=0">${n}</a>`)).join(' · ')}</span>
      </div>` : '<p class="muted">Không tìm thấy đơn nào khớp bộ lọc.</p>'}</div>
    <a class="btn alt" href="/">← Về bảng điều khiển</a>`);
}

export function renderOrderDetail(ctx, shopId, o, err, shipping, edited, returned, timelineFilter = '') {
  const totalVnd = Math.max(0, Number(o.payment_summary?.total_vnd ?? o.total_vnd) || 0);
  const orderDead = ['cancelled', 'returned', 'refunded'].includes(o.status);
  // V1 chưa có contract sửa/giao/hoàn đã được xác minh với provider. Đơn POS luôn chỉ để
  // quan sát; đơn website cũng tạm chỉ-đọc sau khi provider đã nhận (`external_ref`). DB vẫn
  // là chốt cuối, còn guard này tránh mời người vận hành đi vào một loạt 409 có chủ ý.
  const externalReadOnly = ['kiotviet_pos', 'sapo_pos'].includes(o.source) || Boolean(o.external_ref);
  const externalReadOnlyNotice = externalReadOnly ? `<div class="notice">
    <strong>Đơn này đang do hệ thống POS ngoài thực hiện.</strong>
    <p class="muted" style="margin:6px 0 0">Trang quản trị chỉ hiển thị để đối chiếu. Hãy sửa trạng thái, tiền, giao hàng hoặc hoàn trả tại POS; kết quả sẽ đồng bộ về đây.</p>
  </div>` : '';
  // Thiếu summary là lỗi hợp đồng giữa BFF và seller, không phải lý do để dựng lại công thức
  // tiền trong view. Bản fallback cũ đã trôi khỏi fulfillment_adjustment_vnd và có thể giấu
  // đúng khoản shop còn nợ khách. Giữ object 0 chỉ để render phần KHÔNG tài chính an toàn;
  // mọi nút tiền bên dưới đều gác bằng paymentReady và card hiện mã hỗ trợ rõ ràng.
  const paymentReady = o.payment_summary && typeof o.payment_summary === 'object'
    && ['total_vnd', 'received_vnd', 'refunded_vnd', 'net_received_vnd', 'amount_due_vnd', 'customer_credit_vnd']
      .every((k) => Number.isFinite(Number(o.payment_summary[k])))
    && typeof o.payment_summary.display_state === 'string';
  const payment = paymentReady ? o.payment_summary : {
    total_vnd: totalVnd, received_vnd: 0, refunded_vnd: 0, net_received_vnd: 0,
    amount_due_vnd: 0, customer_credit_vnd: 0, display_state: 'unpaid',
  };
  const paymentView = paymentReady
    ? (PAYMENT_DISPLAY[payment.display_state] ?? ['unpaid', payment.display_state ?? 'Chưa rõ'])
    : ['cancelled', 'Không tải được'];
  const fulfillmentAdjustment = Math.max(0, Number(o.fulfillment_adjustment_vnd) || 0);
  const transactions = Array.isArray(o.payment_transactions) ? o.payment_transactions : [];
  const reversedTransactions = new Set(transactions.filter((t) => t.reverses_transaction_id).map((t) => t.reverses_transaction_id));
  const cases = Array.isArray(o.resolution_cases) ? o.resolution_cases : [];
  const activeCases = cases.filter((c) => ['open', 'waiting_return'].includes(c.status));
  const deliveries = Array.isArray(o.notification_deliveries) ? o.notification_deliveries : [];
  const requests = Array.isArray(o.customer_requests) ? o.customer_requests : [];
  // HỎI LẠI TRƯỚC KHI LÀM THỨ KHÔNG LÙI ĐƯỢC. Cơ chế data-confirm đã có sẵn trong file này
  // (đang dùng cho "Lưu trữ sản phẩm", "Nhập thật", "Thu hồi khoá API") nhưng KHÔNG một nút
  // tiền/một-chiều nào của đơn hàng gắn nó — trong khi đó mới là chỗ bấm nhầm đắt nhất:
  // "Đã nhận tiền (COD)" bấm một cú là ghi doanh thu chưa từng thu, và đường lùi duy nhất là
  // ghi một phiếu hoàn tiền chưa từng trả → sổ sai vĩnh viễn ở bốn chỗ.
  const act = (path, label, cls = 'btn sm', extra = '', hoi = '') => `<form method="POST" action="/shops/${esc(shopId)}/orders/${esc(o.id)}/${path}">${extra}<button class="${cls}" type="submit"${hoi ? ` data-confirm="${esc(hoi)}"` : ''}>${label}</button></form>`;
  // "Sửa đơn" CHỈ khi đơn còn sửa được: chưa gửi hãng (pending/confirmed) VÀ chưa thanh toán.
  // Đơn đã trả / đã giao → seller từ chối (409) nên không hiện nút (khỏi dẫn user vào ngõ cụt).
  const editable = paymentReady && !externalReadOnly && ['pending', 'confirmed'].includes(o.status) && Number(payment.net_received_vnd) === 0;
  const editAction = editable ? `<a class="btn alt sm" href="/shops/${esc(shopId)}/orders/${esc(o.id)}/edit">Sửa đơn</a>` : '';
  // Sửa đơn ĐÃ TRẢ (v2): đơn paid + chưa gửi hãng, owner/admin (perm 'refund' + step-up ở seller).
  // Giảm tổng → tự tạo phiếu hoàn phần chênh; tăng tổng chưa hỗ trợ. Nút dẫn sang trang riêng.
  const editPaidAction = (paymentReady && !externalReadOnly && o.payment_status === 'paid' && ['pending', 'confirmed'].includes(o.status) && REFUND_ROLES.has(ctx.role))
    ? `<a class="btn alt sm" href="/shops/${esc(shopId)}/orders/${esc(o.id)}/edit-paid">Sửa đơn đã trả</a>` : '';
  // Nhận trả hàng (RMA 0078): đơn ĐÃ GIAO + còn hàng chưa trả (qty > returned_qty) — owner/admin
  // (perm 'refund' + step-up ở seller). Dẫn sang trang form riêng (chọn dòng + số lượng trả +
  // nhập lại kho). Trả HẾT mọi dòng → đơn "Hoàn hàng"; ẩn nút khi không còn gì để trả.
  const hasReturnable = (o.lines ?? []).some((l) => Number(l.qty) - Number(l.returned_qty ?? 0) > 0);
  const returnAction = (paymentReady && !externalReadOnly && o.status === 'delivered' && hasReturnable && REFUND_ROLES.has(ctx.role))
    ? `<a class="btn warn sm" href="/shops/${esc(shopId)}/orders/${esc(o.id)}/return">Nhận trả hàng</a>` : '';
  // GIAO MỘT PHẦN (0080): còn phải gửi = qty − shipped_qty − claim đang tạo. Nút "Đã giao xong" CHỈ
  // hiện khi đã gửi ĐỦ (fulfillment='fulfilled') — khớp guard seller (deliver partial → 409).
  const remLines = (o.lines ?? []).map((l) => ({
    ...l,
    planned: Number(l.planned_qty ?? 0),
    remaining: Math.max(0, Number(l.qty) - Number(l.shipped_qty ?? 0) - Number(l.planned_qty ?? 0)),
  })).filter((l) => l.remaining > 0);
  const canShipManual = !externalReadOnly && activeCases.length === 0 && ['confirmed', 'shipped'].includes(o.status) && remLines.length > 0;
  // HUỶ ĐƠN (0117): đơn ĐÃ TRẢ TIỀN thì lý do là BẮT BUỘC — seller trả 400 nếu thiếu,
  // và lý do đi thẳng vào email cho khách. Nói rõ ngay tại nút là khách sẽ đọc được nó,
  // để người bán không gõ ghi chú nội bộ vào đây.
  const paidCancel = paymentReady
    ? Number(payment.net_received_vnd) > 0
    : (o.payment_status === 'paid' || Boolean(o.paid_at));
  const cancelExtra = paidCancel
    ? `<div class="err" style="margin-bottom:8px;padding:10px 12px">${paymentReady
      ? `Shop đã ghi nhận <strong>${esc(money(payment.net_received_vnd))}</strong> từ khách.`
      : 'Đơn này có ghi nhận thanh toán nhưng bản tổng hợp tiền đang lỗi.'}
         Huỷ đơn KHÔNG tự hoàn tiền — bạn phải chuyển lại cho khách.
         <label style="display:block;margin-top:6px;font-size:.85rem">Lý do huỷ (bắt buộc — khách sẽ nhận được lý do này)
           <input name="reason" required maxlength="500" placeholder="vd: hết hàng, không kịp giao trước Tết"></label>
       </div>`
    : `<label style="display:block;font-size:.82rem;margin-bottom:6px">Lý do huỷ (tuỳ chọn — gửi cho khách)
         <input name="reason" maxlength="500" placeholder="vd: khách đổi ý"></label>`;
  // TÁCH THEO VIỆC, không rải ngang một hàng. Người bán báo cụm nút "nằm không đều,
  // rối, không hiểu mục đích". Gốc rễ: nút xử-lý-đơn, nút tiền, nút sửa/trả và nút huỷ
  // đứng chung một dòng nên không có gì gợi ý cái nào dùng khi nào — mà chúng thuộc ba
  // nhóm việc khác hẳn nhau, và một trong số đó tiêu tiền thật.
  let flowActions = '', cancelAction = '';
  // Huỷ đơn báo email cho khách NGAY, nên vẫn hỏi lại — nhưng từ khi có nút Mở lại thì nó không
  // còn là một chiều, và câu hỏi phải nói đúng như vậy: doạ "không mở lại được" khi thật ra mở
  // lại được chỉ dạy người ta bỏ qua mọi câu hỏi khác của phần mềm.
  const hoiHuy = `Huỷ đơn #${o.order_number}? Khách sẽ nhận ngay email báo đơn đã huỷ. Mở lại được sau đó, nhưng chỉ khi hàng vẫn còn.`;
  if (!externalReadOnly && o.status === 'pending') { flowActions = act('confirm', 'Xác nhận đơn'); cancelAction = act('cancel', 'Huỷ đơn', 'btn warn sm', cancelExtra, hoiHuy); }
  else if (!externalReadOnly && o.status === 'confirmed') cancelAction = act('cancel', 'Huỷ đơn', 'btn warn sm', cancelExtra, hoiHuy);
  // MỞ LẠI ĐƠN ĐÃ HUỶ — trước đây màn hình này chỉ còn dòng "Không có thao tác." Huỷ nhầm một
  // đơn (hoặc khách gọi lại xin mua tiếp) là buộc phải gõ tay một đơn mới: mất số đơn khách đang
  // cầm, mất lịch sử. Ẩn nút khi đã có phiếu hoàn — lúc đó tiền đã về khách, mở lại là nói dối sổ.
  else if (!externalReadOnly && o.status === 'cancelled' && !(o.refunds ?? []).length) {
    flowActions = act('reopen', '↻ Mở lại đơn', 'btn alt sm', '',
      `Mở lại đơn #${o.order_number}? Đơn quay về "Chờ xử lý" và GIỮ CHỖ lại số hàng trong đơn — nếu hàng đã bán hết cho người khác thì không mở được. Khách sẽ nhận email báo đơn được mở lại.`);
  }
  else if (!externalReadOnly && o.status === 'shipped' && o.fulfillment_status === 'fulfilled' && activeCases.length === 0) flowActions = act('deliver', 'Đã giao xong');
  // BOM HÀNG / HOÀN VỀ (audit #58): đơn ĐANG GIAO khách không nhận → hàng về. Restock phần đã gửi +
  // nhả reserve phần chưa gửi (đơn tách bỏ dở) → tồn sạch. Hiện cho MỌI đơn shipped (đủ/một-phần).
  if (!externalReadOnly && o.status === 'shipped' && activeCases.length === 0 && ORDER_ROLES.has(ctx.role)) {
    flowActions += act('mark-returned', '↩ Bom hàng / Hoàn về', 'btn warn sm',
      '<label style="display:block;font-size:.82rem;margin-bottom:6px"><input type="checkbox" name="restock" checked style="width:auto"> Nhập lại kho (bỏ tick nếu hàng hỏng)</label>',
      `Đánh dấu đơn #${o.order_number} là BOM HÀNG? Khách nhận ngay email báo hoàn hàng, đơn đóng lại và không giao tiếp được. Chỉ dùng khi hàng đã thật sự quay về.`);
  }
  // Card giao tay per-dòng: SL mặc định = còn lại; giảm để TÁCH kiện, gửi nốt sau. order_line_id[]
  // đứng TRƯỚC ship_qty[] mỗi hàng → server zip theo chỉ số (dòng SL 0 bị bỏ, gửi kiện sau).
  const shipCard = canShipManual ? `
    <div class="card"><h2 style="margin-top:0">Giao hàng (nhập tay)</h2>
      <p class="muted">Số lượng gửi mỗi mặt hàng — mặc định = còn lại. Gửi ÍT hơn → đơn "Giao một phần", gửi nốt kiện sau.</p>
      <form method="POST" action="/shops/${esc(shopId)}/orders/${esc(o.id)}/ship">
        <div class="tblscroll">${tblCards({
    head: [{ html: 'Mặt hàng' }, { html: 'Còn phải gửi' }, { html: 'Số lượng kiện này' }],
    rows: remLines.map((l) => [
      { html: `${esc(l.title_snapshot)} <span class="muted">${esc(l.sku_snapshot ?? '')}</span>` },
      { cls: 'muted', style: 'text-align:right;white-space:nowrap', html: `còn ${l.remaining}/${esc(l.qty)}${l.planned > 0 ? `<br><small>đang chờ hãng ${esc(l.planned)}</small>` : ''}` },
      { style: 'text-align:right', html: `<input type="hidden" name="order_line_id" value="${esc(l.order_line_id)}"><input name="ship_qty" type="number" min="0" max="${l.remaining}" value="${l.remaining}" inputmode="numeric" style="width:78px" aria-label="Số lượng gửi ${esc(l.title_snapshot)}">` },
    ]),
  })}</div>
        <div class="grid2" style="margin-top:8px">
          <div><label>Mã vận đơn</label><input name="tracking_number" required maxlength="64"></div>
          <div><label>Đơn vị VC</label><input name="carrier" maxlength="40" placeholder="GHN..."></div>
        </div>
        <button class="btn" type="submit" style="margin-top:12px">Giao kiện này</button>
      </form>
    </div>` : '';
  // Tạo vận đơn QUA HÃNG (GHN/GHTK) — chỉ khi đơn đã xác nhận + shop đã kết nối hãng.
  // Form prefill từ địa chỉ đơn; shop sửa/bổ sung quận-huyện trước khi đẩy sang hãng.
  const addr = typeof o.shipping_address === 'object' && o.shipping_address ? o.shipping_address : {};
  // Card tạo vận đơn HÃNG: đơn còn hàng chưa gửi (confirmed / shipped-partial) + đã kết nối.
  // Hãng gửi TRỌN phần CÒN LẠI (một kiện hãng/đơn). ẨN khi COD chưa thu mà đã gửi một phần —
  // seller cấm tách COD-hãng (409) → tránh dẫn user vào ngõ cụt.
  const codSplitBlocked = o.payment_method === 'cod' && Number(payment.amount_due_vnd) > 0 && o.fulfillment_status !== 'unfulfilled';
  const carrierCard = (!externalReadOnly && activeCases.length === 0 && ['confirmed', 'shipped'].includes(o.status) && remLines.length > 0 && o.fulfillment_status !== 'fulfilled' && shipping?.connected && !codSplitBlocked) ? `
    <div class="card"><h2 style="margin-top:0">Tạo vận đơn qua ${esc((shipping.provider ?? '').toUpperCase())}${o.fulfillment_status === 'partial' ? ' (phần còn lại)' : ''}</h2>
      <p class="muted">Đẩy đơn sang hãng — hãng trả <strong>mã vận đơn + phí</strong>, đơn tự chuyển "Đang giao".
        ${o.payment_method === 'cod' && o.payment_status !== 'paid'
          ? `Hãng sẽ <strong>thu hộ COD ${money(o.total_vnd)}</strong>.`
          : o.payment_status === 'paid'
            ? 'Đơn đã thanh toán — không thu hộ.'
            : `<strong style="color:#b45309">⚠ Đơn CHƯA thanh toán — hãng sẽ KHÔNG thu hộ (chỉ thu hộ đơn COD).</strong> Chờ khách chuyển khoản hoặc bấm "Đã nhận tiền" trước khi giao.`}</p>
      <form method="POST" action="/shops/${esc(shopId)}/orders/${esc(o.id)}/carrier-shipment">
        <div class="grid2">
          <div><label>Người nhận</label><input name="to_name" required maxlength="100" value="${esc(o.customer_name ?? '')}"></div>
          <div><label>SĐT</label><input name="to_phone" required maxlength="20" value="${esc(o.customer_phone ?? '')}"></div>
        </div>
        <label>Địa chỉ (số nhà, đường, phường/xã)</label><input name="to_address" required maxlength="300" value="${esc(addr.line ?? '')}">
        <div class="grid2">
          <div><label>Tỉnh / Thành</label><input name="to_province" required maxlength="60" value="${esc(addr.province ?? '')}"></div>
          <div><label>Quận / Huyện</label><input name="to_district" required maxlength="60" placeholder="VD: Quận 1"></div>
        </div>
        <div class="grid2">
          <div><label>Phường / Xã (tuỳ chọn)</label><input name="to_ward" maxlength="60"></div>
          <div><label>Khối lượng (gram)</label><input name="weight_gram" type="number" min="50" max="50000" value="${Math.min(50000, Math.max(50, Number(o.est_weight_gram) || 500))}"></div>
        </div>
        <label>Ghi chú cho hãng (tuỳ chọn)</label><input name="note" maxlength="200" placeholder="Cho xem hàng, không thử">
        <button class="btn" type="submit" style="margin-top:12px">Tạo vận đơn ${esc((shipping.provider ?? '').toUpperCase())}</button>
      </form>
    </div>` : '';
  // Sổ tiền v2: mỗi lần thu là một chứng từ. Form cho phép nhập phần thực nhận, còn đảo sai
  // sót tạo thêm reversal trỏ đúng dòng cũ — không còn công tắc xoá sạch dấu vết.
  const canRecordManual = paymentReady && !externalReadOnly && !orderDead && Number(payment.amount_due_vnd) > 0 && PAYMENT_ROLES.has(ctx.role);
  const manualPaymentForm = canRecordManual ? `
    <form method="POST" action="/shops/${esc(shopId)}/orders/${esc(o.id)}/payments/manual" class="gridform" style="margin-top:14px">
      <label>Số tiền thực nhận (đ)
        <input name="amount_vnd" type="number" min="1" step="1" required value="${esc(payment.amount_due_vnd)}" inputmode="numeric">
        <span class="muted" style="font-size:.8rem">Có thể nhỏ hơn số còn thiếu; hệ thống giữ trạng thái thu một phần.</span></label>
      <label>Ghi chú chứng từ (tuỳ chọn)
        <input name="note" maxlength="500" placeholder="vd: khách chuyển lần 1, thu COD kiện 2"></label>
      <div><button class="btn sm${o.payment_method === 'qr' ? ' warn' : ''}" type="submit" data-confirm="Xác nhận đã thực sự nhận khoản tiền này của đơn #${esc(o.order_number)}?">Đã nhận tiền (${esc(o.payment_method?.toUpperCase() ?? '')})</button></div>
    </form>` : '';
  const transactionRows = transactions.map((t) => {
    const reversal = t.entry_type === 'reversal';
    const canReverse = paymentReady && !externalReadOnly && !reversal && t.provider === 'manual' && !reversedTransactions.has(t.id)
      && !(o.refunds ?? []).length && PAYMENT_ROLES.has(ctx.role);
    const source = { manual: 'Ghi nhận tay', legacy: 'Số dư mở sổ', sepay: 'SePay' }[t.provider] ?? t.provider;
    const status = { received: 'Đã nhận', underpaid: 'Chưa đủ', unmatched: 'Chưa khớp' }[t.status] ?? t.status;
    const reverseForm = canReverse ? `<form method="POST" action="/shops/${esc(shopId)}/orders/${esc(o.id)}/payments/${esc(t.id)}/reverse" style="min-width:220px">
      <label class="muted" style="font-size:.78rem">Lý do điều chỉnh
        <input name="reason" required minlength="3" maxlength="500" placeholder="vd: nhân viên ghi nhận nhầm"></label>
      <button class="btn alt sm" type="submit" data-confirm="Tạo bút toán đảo ${esc(money(t.amount_vnd))}? Chứng từ cũ vẫn được giữ lại.">Điều chỉnh ghi nhận</button>
    </form>` : (reversal ? `<span class="muted">Đảo chứng từ ${esc(String(t.reverses_transaction_id ?? '').slice(0, 8))}</span>` : '');
    return [
      { cls: 'muted', html: dt(t.created_at) },
      { html: `<strong style="color:${reversal ? 'var(--bad)' : 'var(--good)'}">${reversal ? '−' : '+'}${money(t.amount_vnd)}</strong><br><span class="muted">${reversal ? 'Điều chỉnh giảm' : 'Khoản thu'}</span>` },
      { html: `${esc(source ?? '—')}<br><span class="muted">${esc(status ?? '—')}</span>` },
      { html: `${esc(t.note ?? '') || '<span class="muted">—</span>'}${t.recorded_by_email ? `<br><span class="muted">${esc(t.recorded_by_email)}</span>` : ''}` },
      { cls: canReverse ? 'stack' : undefined, html: reverseForm },
    ];
  });
  const creditText = Number(payment.customer_credit_vnd) > 0
    ? `<div class="err"><strong>Cần xử lý ${money(payment.customer_credit_vnd)}</strong> khách chuyển dư hoặc shop đang giữ sau khi đơn kết thúc. Không xoá giao dịch; hãy hoàn tiền và ghi bút toán hoàn.</div>` : '';
  const partialValueText = fulfillmentAdjustment > 0
    ? `<div class="notice"><strong>Đơn được chốt giao một phần.</strong> Giá trị phần không giao: ${money(fulfillmentAdjustment)}; shop chỉ được giữ tối đa ${money(Math.max(0, Number(payment.total_vnd) - fulfillmentAdjustment))}.</div>`
    : '';
  const paymentCard = paymentReady ? `<div class="card" id="thanh-toan"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <h2 style="margin:0">Thanh toán</h2>${badge(paymentView[0], paymentView[1])}
    </div>
    <div class="metrics" style="margin:14px 0">
      <div class="metric"><div class="l">Tổng đơn</div><div class="v">${money(payment.total_vnd)}</div></div>
      <div class="metric"><div class="l">Đã nhận</div><div class="v">${money(payment.received_vnd)}</div></div>
      <div class="metric"><div class="l">Đã hoàn</div><div class="v">${money(payment.refunded_vnd)}</div></div>
      <div class="metric"><div class="l">${Number(payment.amount_due_vnd) > 0 ? 'Còn thiếu' : Number(payment.customer_credit_vnd) > 0 ? 'Cần trả khách' : 'Còn thiếu'}</div><div class="v">${money(Number(payment.amount_due_vnd) > 0 ? payment.amount_due_vnd : payment.customer_credit_vnd)}</div></div>
    </div>
    ${partialValueText}${creditText}${manualPaymentForm}
    <h3 style="margin-top:18px">Lịch sử giao dịch</h3>
    ${transactionRows.length ? `<div class="tblscroll">${tblCards({
    head: [{ html: 'Thời gian' }, { html: 'Số tiền' }, { html: 'Nguồn' }, { html: 'Ghi chú' }, { html: 'Điều chỉnh' }],
    rows: transactionRows,
  })}</div>` : '<p class="muted">Chưa có chứng từ thanh toán.</p>'}
  </div>` : `<div class="card" id="thanh-toan" style="border-color:var(--bad)">
    <h2 style="margin-top:0">Thanh toán tạm thời không tải được</h2>
    <div class="err">Hệ thống thiếu bản tổng hợp thanh toán nên đã khoá toàn bộ thao tác tiền để tránh hiển thị hoặc ghi sai số.</div>
    <p class="muted" style="margin-bottom:0">Tải lại trang. Nếu vẫn còn lỗi, gửi hỗ trợ mã <code>PAYMENT_SUMMARY_MISSING</code>; không ghi nhận hoặc hoàn tiền ở màn hình khác.</p>
  </div>`;
  // Hoàn tiền (bút toán 0070): đơn ĐÃ thanh toán, chưa hoàn — owner/admin (perm 'refund'
  // + step-up). Số tiền để trống = hoàn TOÀN BỘ số còn lại; ghi số nhỏ hơn = hoàn MỘT PHẦN
  // (đơn giữ trạng thái, luỹ kế chạm tổng mới lật "Đã hoàn").
  const activeRequiredRefund = Math.max(0, ...activeCases.map((c) => Number(c.required_refund_vnd) || 0));
  const activeRefundMax = Math.max(0, Number(o.total_vnd) - Number(o.refunded_total_vnd ?? 0) - 1);
  const refundAction = (paymentReady && !externalReadOnly && o.payment_status === 'paid' && o.status !== 'refunded' && REFUND_ROLES.has(ctx.role))
    ? `<form method="POST" action="/shops/${esc(shopId)}/orders/${esc(o.id)}/refund" class="actions" style="align-items:end">
        <div><label>Số tiền hoàn (đ${activeCases.length ? ' — bắt buộc nhập khi đang xử lý giao một phần' : ' — để trống = hoàn toàn bộ'})</label><input name="amount_vnd" inputmode="numeric" style="width:200px"${activeCases.length ? ` required min="${esc(activeRequiredRefund || 1)}" max="${esc(activeRefundMax)}" value="${esc(Math.min(activeRequiredRefund || 1, activeRefundMax))}"` : ''} placeholder="vd 50000"></div>
        <div><label>Lý do (tuỳ chọn)</label><input name="reason" maxlength="500" style="width:180px" placeholder="khách trả 1 món…"></div>
        <button class="btn warn sm" type="submit" data-busy="Đang chuẩn bị xác nhận…">Hoàn tiền</button>${activeCases.length ? `<p class="muted actgrp-h">Ca giao một phần cần phiếu hoàn tối thiểu ${money(activeRequiredRefund)} cho phần không giao; không tự hoàn phí vận chuyển.</p>` : ''}</form>` : '';
  // Lịch sử hoàn tiền: mọi bút toán (một phần lẫn toàn bộ) + tổng đã hoàn.
  const refundHistory = (o.refunds ?? []).length ? `
    <div class="card"><h2>Hoàn tiền</h2>
      ${tblCards({
    head: [{ html: 'Thời gian' }, { html: 'Số tiền' }, { html: 'Lý do' }, { html: 'Người thao tác' }],
    rows: o.refunds.map((r) => [
      { cls: 'muted', html: dt(r.created_at) },
      { html: `<strong>${money(r.amount_vnd)}</strong>` },
      { html: `${esc(r.reason ?? '') || '<span class="muted">—</span>'}${r.restock ? ' <span class="muted">(khai nhập lại kho)</span>' : ''}` },
      { cls: 'muted', html: esc(r.created_by_email ?? '—') },
    ]),
  })}
      <div style="text-align:right;margin-top:8px"><strong>Tổng đã hoàn ${money(o.refunded_total_vnd ?? 0)}</strong>
        ${o.payment_status === 'paid' ? `<span class="muted"> / ${money(o.total_vnd)} — còn có thể hoàn ${money(Number(o.total_vnd) - Number(o.refunded_total_vnd ?? 0))}</span>` : ''}</div>
    </div>` : '';
  // Lịch sử đổi-trả (RMA 0078): mỗi phiếu trả (SL trả, tiền hoàn HÀNG, nhập kho, lý do, người
  // thao tác). Mirror card hoàn tiền — chứng từ trả giữ độc lập với bút toán hoàn.
  const returnHistory = (o.returns ?? []).length ? `
    <div class="card"><h2>Lịch sử đổi-trả</h2>
      ${tblCards({
    head: [{ html: 'Thời gian' }, { html: 'SL trả' }, { html: 'Số hoàn' }, { html: 'Nhập kho' }, { html: 'Lý do' }, { html: 'Người thao tác' }],
    rows: o.returns.map((r) => [
      { cls: 'muted', html: dt(r.created_at) },
      { html: esc(r.qty) },
      { html: `<strong>${money(r.refund_vnd)}</strong>` },
      { cls: 'muted', html: r.restocked ? 'có' : 'không' },
      { html: esc(r.reason ?? '') || '<span class="muted">—</span>' },
      { cls: 'muted', html: esc(r.created_by_email ?? '—') },
    ]),
  })}
    </div>` : '';
  // Danh sách KIỆN HÀNG (0080): mỗi vận đơn + mặt hàng trong kiện (shipment_lines từ getOrder).
  // Đơn nhiều kiện thấy rõ kiện nào chứa gì + trạng thái từng kiện. Thay <p> vận đơn cũ.
  const shipmentsCard = (o.shipments ?? []).length ? `
    <div class="card"><h2>Kiện hàng / vận đơn</h2>
      ${tblCards({
    head: [{ html: 'Mã vận đơn' }, { html: 'Trạng thái' }, { html: 'Hãng' }, { html: 'Mặt hàng' }],
    rows: o.shipments.map((s) => [
      { html: `<strong>${esc(s.tracking_number ?? '(đang tạo)')}</strong> ${esc(s.carrier ?? '')}` },
      { html: esc(SHIP_ST[s.status] ?? s.status) },
      { cls: 'muted', html: `${s.provider ? esc(s.provider.toUpperCase()) : 'giao tay'}${s.carrier_fee_vnd != null ? ` · ${money(s.carrier_fee_vnd)}` : ''}` },
      { cls: 'muted', html: (s.lines ?? []).length ? s.lines.map((sl) => `${esc(sl.sku ?? '?')}×${esc(sl.qty)}`).join(', ') : '—' },
    ]),
  })}
    </div>` : '';
  // Cụm nút chia theo VIỆC, mỗi nhóm một hàng có nhãn. Nhóm rỗng thì biến mất hẳn —
  // không để nhãn trơ không có nút nào bên dưới.
  const grp = (label, html, hint = '') => (html
    ? `<div class="actgrp"><span class="actgrp-l">${label}</span>
         <div class="actions">${html}</div>${hint ? `<p class="muted actgrp-h">${hint}</p>` : ''}</div>`
    : '');
  // Hai nút TIỀN hay bị nhầm nhau — người bán đã hỏi thẳng "nút Hoàn tiền để làm gì".
  // Chúng KHÁC nhau ở chỗ hàng có quay về hay không, nên nói đúng câu đó tại chỗ.
  const moneyHint = (refundAction && returnAction)
    ? '“Hoàn tiền” = trả tiền, hàng KHÔNG quay về (gồm cả phí ship). “Nhận trả hàng” = khách gửi hàng về, tự hoàn tiền hàng và nhập lại kho.'
    : refundAction ? 'Hoàn tiền mà hàng không quay về — dùng cả khi cần trả lại phí ship.' : '';
  const actionGroups = externalReadOnly ? '<div class="actions"><span class="muted">Không có thao tác cục bộ.</span></div>' : (grp('Xử lý đơn', flowActions)
    + grp('Sửa đơn', editAction + editPaidAction)
    + grp('Tiền &amp; hậu mãi', refundAction + returnAction, moneyHint)
    + grp('Huỷ đơn', cancelAction)) || (['delivered', 'returned'].includes(o.status) && !REFUND_ROLES.has(ctx.role)
      ? '<div class="notice"><strong>Cần chủ shop hoặc quản trị viên xử lý tiếp.</strong> Vai trò của bạn được xem đơn nhưng không được ghi hoàn tiền hoặc nhận trả hàng.</div>'
      : '<div class="actions"><span class="muted">Không có thao tác.</span></div>');

  // PHÍ VẬN CHUYỂN SHOP THỰC TRẢ (0147) — khoản lỗ có thật mà P&L đang không thấy.
  //
  // Đo trên DB dev: 1.568/2.019 vận đơn là GIAO TAY và không dòng nào có phí, nên với shop tự
  // giao hoặc dùng hãng chưa nối API thì toàn bộ tiền cước biến mất khỏi sổ lãi lỗ. Đơn bị bom
  // còn mất thêm cước CHIỀU VỀ — không hãng nào đồng bộ khoản đó về.
  //
  // Ô chỉ hiện khi CÓ CHỖ ĐỂ ĐIỀN: có vận đơn giao tay (sửa được), hoặc đơn đã quay về (nhập
  // được chiều về). Bày một ô không ghi được vào đâu chỉ để trang trông đầy đủ là mời người ta
  // gõ vào rồi nhận 409.
  const coGiaoTay = (o.shipments ?? []).some((s) => !s.provider && s.status !== 'cancelled');
  const daVeShop = ['returned', 'refunded', 'cancelled'].includes(o.status);
  const phiGiaoTay = (o.shipments ?? []).find((s) => !s.provider && s.status !== 'cancelled')?.carrier_fee_vnd;
  const shipCostCard = (!externalReadOnly && (coGiaoTay || daVeShop)) ? `
    <div class="card"><h2>Chi phí vận chuyển thực trả</h2>
      <p class="muted" style="margin-top:0">Tiền cước shop bỏ ra cho đơn này. Nhập vào đây thì nó vào <strong>Báo cáo lãi lỗ</strong>; bỏ trống thì khoản lỗ đó không nằm ở đâu cả.</p>
      <form method="POST" action="/shops/${esc(shopId)}/orders/${esc(o.id)}/ship-cost" class="gridform">
        ${coGiaoTay ? `<label>Phí chiều đi (giao tay)
          <input type="number" name="outbound_fee_vnd" min="0" step="1000" value="${phiGiaoTay != null ? esc(phiGiaoTay) : ''}" placeholder="chưa nhập">
          <span class="muted" style="font-size:.8rem">Vận đơn do hãng tạo thì lấy số từ hãng, không sửa ở đây.</span></label>` : ''}
        ${daVeShop ? `<label>Phí chiều về (hãng thu khi mang hàng ngược lại)
          <input type="number" name="return_fee_vnd" min="0" step="1000" value="${o.return_fee_vnd != null ? esc(o.return_fee_vnd) : ''}" placeholder="chưa nhập">
          <span class="muted" style="font-size:.8rem">Hãng không thu chiều về thì điền <strong>0</strong> — khác với bỏ trống.</span></label>` : ''}
        <div><button class="btn alt sm" type="submit">Lưu chi phí</button></div>
      </form>
    </div>` : '';

  const resolutionName = {
    accept_partial: 'Chấp nhận giao một phần', resent: 'Đã gửi bù', refunded_remainder: 'Đã hoàn phần thiếu',
    cancelled_remainder: 'Đã huỷ phần còn lại', other: 'Cách xử lý khác',
  };
  const canResolveOrder = !externalReadOnly && ORDER_ROLES.has(ctx.role);
  const canReceiveReturn = !externalReadOnly && INVENTORY_ROLES.has(ctx.role);
  const canResolveRefund = !externalReadOnly && REFUND_ROLES.has(ctx.role);
  const resolutionActions = (c) => {
    if (!['open', 'waiting_return'].includes(c.status)) return '';
    const remaining = Number(c.remaining_return_qty);
    const unresolved = Number(c.unresolved_qty);
    const receiptLines = (c.snapshot_lines ?? []).filter((line) => Number(line.remaining_return_qty) > 0);
    const refundOptions = (o.refunds ?? []).filter((r) => r.kind !== 'edit_adjustment');
    const requiredForCase = Number(c.required_refund_vnd || 0);
    const attributedForCase = Number(c.attributed_refund_vnd || 0);
    const remainingEvidence = Math.max(0, requiredForCase - attributedForCase);
    const wait = canResolveOrder && remaining > 0 && c.status !== 'waiting_return'
      ? `<form method="POST" action="/shops/${esc(shopId)}/orders/${esc(o.id)}/resolution-cases/${esc(c.id)}/wait-return">
           <button class="btn alt sm" type="submit">Chờ hàng hoàn về</button></form>` : '';
    const receive = canReceiveReturn && receiptLines.length ? `<details style="margin-top:8px"><summary class="btn alt sm">Xác nhận đã nhận hàng</summary>
      <form method="POST" action="/shops/${esc(shopId)}/orders/${esc(o.id)}/resolution-cases/${esc(c.id)}/receive-return" style="margin-top:10px">
        <input type="hidden" name="idempotency_key" value="receipt-${esc(c.id)}-${esc(c.received_return_qty)}">
        <div class="tblscroll">${tblCards({
      head: [{ html: 'Mặt hàng' }, { html: 'Chưa nhận' }, { html: 'Số lượng nhận' }],
      rows: receiptLines.map((line) => [
        { html: `<strong>${esc(line.title_snapshot ?? 'Mặt hàng')}</strong>${line.sku_snapshot ? `<br><span class="muted">SKU ${esc(line.sku_snapshot)}</span>` : ''}` },
        { cls: 'muted', html: `còn ${esc(line.remaining_return_qty)}/${esc(line.returned_qty)}` },
        { html: `<input type="hidden" name="case_line_id" value="${esc(line.id)}"><input type="number" name="qty" min="0" max="${esc(line.remaining_return_qty)}" value="${esc(line.remaining_return_qty)}" inputmode="numeric" style="width:76px" aria-label="Số lượng hàng hoàn đã nhận của ${esc(line.title_snapshot ?? 'mặt hàng')}">` },
      ]),
    })}</div>
        <label>Cách xử lý hàng
          <select name="disposition"><option value="restock">Nhập lại tồn bán được</option><option value="quarantine">Cách ly / hàng hỏng</option></select></label>
        <label>Ghi chú kiểm nhận <input name="note" required maxlength="1000" placeholder="Tình trạng hàng khi mở kiện"></label>
        <button class="btn sm" type="submit" data-confirm="Xác nhận số hàng này đã thực sự về shop? Tồn chỉ tăng khi chọn nhập lại tồn.">Lưu phiếu nhận hàng</button>
      </form></details>` : '';
    let accept = '';
    if (canResolveOrder && remaining === 0 && unresolved === 0) {
      const paid = Number(payment.received_vnd) > 0 || o.payment_status === 'paid' || Boolean(o.paid_at);
      if (!paid) {
        accept = `<form method="POST" action="/shops/${esc(shopId)}/orders/${esc(o.id)}/resolution-cases/${esc(c.id)}/accept-partial" style="margin-top:8px">
          <input type="hidden" name="financial_action" value="not_required">
          <label>Ghi chú quyết định <input name="note" required maxlength="1000" placeholder="Đã giao phần nào; đơn COD chưa thu phần không giao"></label>
          <button class="btn sm" type="submit" data-confirm="Chốt đơn là giao một phần? Ca sẽ đóng và không thể sửa chứng từ nhận hàng.">Chấp nhận giao một phần</button>
        </form>`;
      } else if (!canResolveRefund) {
        accept = '<div class="notice" style="margin-top:8px"><strong>Cần chủ shop hoặc quản trị viên.</strong> Đơn đã nhận tiền nên phải chọn chứng từ hoàn và xác thực lại trước khi chốt.</div>';
      } else {
        const refundChecks = refundOptions.length ? refundOptions.map((r) => {
          const usedElsewhere = r.attributed_case_id && r.attributed_case_id !== c.id;
          const beforeDetection = new Date(r.created_at) < new Date(c.detected_at);
          return `<label style="display:flex;gap:8px;align-items:flex-start;margin:7px 0">
            <input type="checkbox" name="refund_ids" value="${esc(r.id)}"${usedElsewhere ? ' disabled' : ''}>
            <span><strong>${money(r.amount_vnd)}</strong> · ${dt(r.created_at)}${beforeDetection ? ' · tạo trước khi ca được phát hiện' : ''}
              ${r.reason ? `<br><span class="muted">${esc(r.reason)}</span>` : ''}
              ${usedElsewhere ? '<br><span class="err" style="display:inline-block">Đã làm bằng chứng cho ca khác — không thể dùng lại.</span>' : ''}</span>
          </label>`;
        }).join('') : '<div class="err">Đơn chưa có phiếu hoàn tiền nghiệp vụ để chọn.</div>';
        accept = `<form method="POST" action="/shops/${esc(shopId)}/orders/${esc(o.id)}/resolution-cases/${esc(c.id)}/accept-partial-with-refund" style="margin-top:8px">
          <div class="metrics" style="margin:8px 0">
            <div class="metric"><div class="l">Cần chứng minh đã hoàn</div><div class="v">${money(requiredForCase)}</div></div>
            <div class="metric"><div class="l">Đã gắn vào ca</div><div class="v">${money(attributedForCase)}</div></div>
            <div class="metric"><div class="l">Còn thiếu bằng chứng</div><div class="v">${money(remainingEvidence)}</div></div>
          </div>
          <fieldset><legend>Chọn các phiếu hoàn tiền làm bằng chứng</legend>${refundChecks}</fieldset>
          <label>Ghi chú quyết định <input name="note" required maxlength="1000" placeholder="Đã giao phần nào, các phiếu hoàn bù cho phần nào"></label>
          <button class="btn sm" type="submit"${refundOptions.some((r) => !r.attributed_case_id || r.attributed_case_id === c.id) ? '' : ' disabled'} data-confirm="Các phiếu đã chọn sẽ gắn vĩnh viễn vào ca này. Tiếp tục xác thực mật khẩu?">Chấp nhận giao một phần</button>
        </form>`;
      }
    }
    const blocked = unresolved > 0 ? `<div class="muted" style="margin-top:8px">Còn ${esc(unresolved)} sản phẩm chưa có kết quả cuối từ vận chuyển.</div>` : '';
    return `<div class="stack" style="min-width:230px">${wait}${receive}${accept}${blocked}</div>`;
  };
  const resolutionCard = cases.length ? `<div class="card"><h2>Ca giao hàng cần xử lý</h2>
    ${tblCards({
    head: [{ html: 'Phát hiện' }, { html: 'Kết quả kiện' }, { html: 'Trạng thái' }, { html: 'Quyết định' }],
    rows: cases.map((c) => [
      { cls: 'muted', html: dt(c.detected_at) },
      { html: `Đã giao ${esc(c.delivered_shipments)} kiện / ${esc(c.delivered_qty)} SP<br><span class="muted">Hoàn về ${esc(c.returned_shipments)} kiện / ${esc(c.returned_qty)} SP</span>${Number(c.required_refund_vnd) > 0 ? `<br><span class="muted">Cần hoàn phần không giao: ${money(c.required_refund_vnd)}</span>` : ''}` },
      { html: `${badge(['open', 'waiting_return'].includes(c.status) ? 'pending' : 'delivered', c.status === 'waiting_return' ? 'Đang chờ hàng hoàn' : c.status === 'open' ? 'Đang chờ shop xử lý' : 'Đã chốt')}<br><span class="muted">Đã nhận ${esc(c.received_return_qty)}/${esc(c.returned_qty)} SP hoàn</span>` },
      { html: `${c.resolution ? esc(resolutionName[c.resolution] ?? c.resolution) : '<span class="muted">Chưa có quyết định</span>'}${c.refund_evidence_format === 'legacy' ? '<br><span class="muted">Bằng chứng tiền theo định dạng cũ (một refund_id trong lịch sử ca).</span>' : ''}${c.refund_evidence_format === 'attributions' ? `<br><span class="muted">${esc(c.refund_attributions?.length ?? 0)} phiếu hoàn · ${money(c.attributed_refund_vnd)}</span>` : ''}${c.resolution_note ? `<br><span class="muted">${esc(c.resolution_note)}</span>` : ''}${resolutionActions(c)}` },
    ]),
  })}
    ${activeCases.length ? '<p class="muted">Hệ thống chỉ nhập lại tồn sau khi shop xác nhận hàng đã về; phần tiền phải có phiếu hoàn trước khi chốt đơn đã thanh toán.</p>' : ''}
  </div>` : '';

  const deliveryStatus = {
    queued: ['pending', 'Đang chờ'], sending: ['pending', 'Đang gửi'], retrying: ['pending', 'Đang thử lại'],
    accepted: ['delivered', 'Provider đã nhận'], sent: ['delivered', 'Đã gửi'], failed: ['cancelled', 'Thất bại'],
    skipped: ['unpaid', 'Bỏ qua'], superseded: ['unpaid', 'Đã thay bằng lần gửi lại'],
  };
  const notificationCard = deliveries.length ? `<div class="card"><h2>Thông báo tới khách</h2>
    ${tblCards({
    head: [{ html: 'Thời gian' }, { html: 'Kênh' }, { html: 'Trạng thái' }, { html: 'Số lần thử' }, { html: 'Lỗi gần nhất' }],
    rows: deliveries.map((d) => {
      const st = deliveryStatus[d.status] ?? ['unpaid', d.status];
      return [
        { cls: 'muted', html: dt(d.last_attempt_at ?? d.created_at) },
        { html: `${esc(String(d.channel ?? '').toUpperCase())}<br><span class="muted">${esc(d.topic ?? '')}</span>` },
        { html: badge(st[0], st[1]) },
        { html: esc(d.attempts ?? 0) },
        { html: esc(d.last_error ?? '') || '<span class="muted">—</span>' },
      ];
    }),
  })}
  </div>` : '';

  const requestType = { cancel: 'Huỷ đơn', address_change: 'Đổi địa chỉ', return: 'Trả hàng' };
  const requestStatus = { requested: ['pending', 'Chờ shop xử lý'], approved: ['confirmed', 'Đã duyệt'], completed: ['delivered', 'Hoàn tất'], rejected: ['cancelled', 'Đã từ chối'] };
  const customerRequestCard = requests.length ? `<div class="card"><h2>Yêu cầu từ khách</h2>
    ${tblCards({
    head: [{ html: 'Thời gian' }, { html: 'Loại' }, { html: 'Nội dung' }, { html: 'Trạng thái' }, { html: 'Phản hồi shop' }],
    rows: requests.map((r) => {
      const st = requestStatus[r.status] ?? ['unpaid', r.status];
      return [
        { cls: 'muted', html: dt(r.created_at) },
        { html: `<strong>${esc(requestType[r.request_type] ?? r.request_type)}</strong><br><span class="muted">${esc(r.requester_type ?? '')}</span>` },
        { html: esc(r.reason ?? '') || '<span class="muted">Khách không ghi lý do</span>' },
        { html: badge(st[0], st[1]) },
        { html: esc(r.decision_note ?? '') || (r.status === 'requested' ? '<span class="muted">Cần mở hàng đợi hậu mãi để duyệt hoặc từ chối.</span>' : '<span class="muted">—</span>') },
      ];
    }),
  })}
  </div>` : '';

  const eventGroup = (eventType) => eventType.startsWith('payment.') ? 'payment'
    : eventType.startsWith('shipment.') ? 'shipment'
      : eventType.startsWith('notification.') ? 'notification' : 'order';
  const timelineKey = ['order', 'payment', 'shipment', 'notification'].includes(timelineFilter) ? timelineFilter : '';
  const visibleTimeline = (Array.isArray(o.timeline) ? o.timeline : []).filter((e) => !timelineKey || eventGroup(e.event_type) === timelineKey).slice().reverse();
  const returnedShipmentEvent = (Array.isArray(o.timeline) ? o.timeline : []).slice().reverse()
    .find((e) => e.event_type === 'shipment.returned');
  const returnedStockNote = returnedShipmentEvent?.payload?.restocked === true
    ? 'Hàng đã được nhập lại tồn theo thao tác hoàn về. Không cộng tồn thủ công lần nữa.'
    : returnedShipmentEvent?.payload?.restocked === false
      ? 'Người xử lý đã chọn không nhập lại tồn vì hàng hỏng/thiếu. Xem timeline để đối chiếu.'
      : 'Xem phiếu trả hàng và timeline bên dưới để biết số lượng đã nhập lại hoặc cách ly; không tự cộng tồn khi chưa đối chiếu.';
  const eventDetail = (e) => {
    const p = e.payload && typeof e.payload === 'object' ? e.payload : {};
    const parts = [];
    if (p.amount_vnd != null) parts.push(money(p.amount_vnd));
    if (p.received_vnd != null) parts.push(`luỹ kế ${money(p.received_vnd)}`);
    if (p.tracking_number) parts.push(`mã ${p.tracking_number}`);
    if (p.channel) parts.push(String(p.channel));
    if (p.reason) parts.push(String(p.reason));
    return parts.join(' · ');
  };
  const timelineTabs = [['', 'Tất cả'], ['order', 'Đơn hàng'], ['payment', 'Tiền'], ['shipment', 'Vận chuyển'], ['notification', 'Thông báo']]
    .map(([key, label]) => `<a class="stab${timelineKey === key ? ' on' : ''}" href="/shops/${esc(shopId)}/orders/${esc(o.id)}${key ? `?timeline=${key}` : ''}">${label}</a>`).join('');
  const timelineCard = `<div class="card" id="nhat-ky"><h2>Nhật ký đơn hàng</h2><nav class="stabs" aria-label="Lọc nhật ký">${timelineTabs}</nav>
    ${visibleTimeline.length ? `<div>${visibleTimeline.map((e) => `<div style="display:grid;grid-template-columns:minmax(125px,auto) minmax(0,1fr);gap:14px;padding:12px 0;border-bottom:1px solid var(--row)">
      <div class="muted">${dt(e.occurred_at ?? e.recorded_at)}</div><div style="min-width:0;overflow-wrap:anywhere"><strong>${esc(EVENT_LABEL[e.event_type] ?? e.event_type)}</strong>
      ${eventDetail(e) ? `<div class="muted">${esc(eventDetail(e))}</div>` : ''}<div class="muted" style="font-size:.78rem">${esc(e.source ?? 'system')}${e.actor_type ? ` · ${esc(e.actor_type)}` : ''}</div></div>
    </div>`).join('')}</div>` : '<p class="muted">Chưa có sự kiện trong nhóm này.</p>'}
  </div>`;

  const attentionParts = [];
  if (Number(payment.amount_due_vnd) > 0) attentionParts.push(`Còn thiếu ${money(payment.amount_due_vnd)}`);
  if (Number(payment.customer_credit_vnd) > 0) attentionParts.push(`Cần trả khách ${money(payment.customer_credit_vnd)}`);
  const openCases = activeCases.length;
  const failedDeliveries = deliveries.filter((d) => d.status === 'failed').length;
  const pendingRequests = requests.filter((r) => r.status === 'requested').length;
  const cancelledCarrierShipments = (o.shipments ?? []).filter((s) =>
    s.status === 'cancelled' && s.provider && !['claim_expired', 'reconciled_cancel', 'orphan'].includes(s.provider_status)
  ).length;
  if (openCases) attentionParts.push(`${openCases} ca giao hàng`);
  if (cancelledCarrierShipments) attentionParts.push(`${cancelledCarrierShipments} vận đơn hãng huỷ cần đối soát`);
  if (failedDeliveries) attentionParts.push(`${failedDeliveries} thông báo lỗi`);
  if (pendingRequests) attentionParts.push(`${pendingRequests} yêu cầu khách`);
  const fulfillmentLabel = o.fulfillment_status === 'fulfilled' ? 'Đã gửi đủ'
    : o.fulfillment_status === 'partial' ? 'Giao một phần' : o.status === 'delivered' ? 'Đã giao' : 'Chưa giao đủ';
  const orderSummaryBlocks = `<div class="metrics">
    <div class="metric"><div class="l">Trạng thái đơn</div><div class="v" style="font-size:1.15rem">${esc(STATUS[o.status] ?? o.status)}</div></div>
    <div class="metric"><div class="l">Thanh toán</div><div class="v" style="font-size:1.15rem">${esc(paymentView[1])}</div><div class="l">${esc(o.payment_method?.toUpperCase() ?? '')}</div></div>
    <div class="metric"><div class="l">Giao hàng</div><div class="v" style="font-size:1.15rem">${esc(fulfillmentLabel)}</div><div class="l">${esc((o.shipments ?? []).length)} kiện</div></div>
    <div class="metric"${attentionParts.length ? ' style="border-color:color-mix(in srgb,var(--warn) 45%,var(--bd));background:var(--warnbg)"' : ''}><div class="l">Việc cần xử lý</div><div class="v">${attentionParts.length}</div><div class="l">${esc(attentionParts[0] ?? 'Không có việc tồn đọng')}</div></div>
  </div>`;

  // CÒN NỢ KHÁCH (0117, sửa lại): con số nay do API tính bằng biểu thức DÙNG CHUNG (owed.js) —
  // trang này chỉ hiển thị. Luật cũ nằm ngay tại đây và vừa hụt vừa sai: nó chỉ xét đơn
  // 'cancelled' nên bỏ trắng đơn BOM HÀNG đã trả trước (10 đơn / 5,62 triệu trên shop ngày-60),
  // và với đơn từng SỬA GIẢM thì `total - đã hoàn` ra số ÂM nên tắt luôn cảnh báo cho một khoản
  // nợ 430.000₫ có thật. Tự trừ tay ở tầng hiển thị là cách con số tiền sinh ra lần thứ hai.
  const owed = Number(o.owed_vnd ?? 0);
  const cancelDebt = owed > 0
    ? `<div class="err"><strong>Còn nợ khách ${esc(money(owed))}</strong> — ${esc(OWED_WHY[o.owed_reason] ?? 'shop đang giữ tiền của khách')}.
         ${externalReadOnly
      ? 'Hãy hoàn tiền tại POS ngoài; chứng từ đồng bộ về sẽ cập nhật khoản còn nợ.'
      : 'Chuyển khoản lại cho khách, rồi bấm <em>Hoàn tiền</em> bên dưới để ghi nhận.'} Băng này biến mất khi đã hoàn đủ.</div>`
    : '';
  return layout(`Đơn #${o.order_number}`, ctx, `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
      <a class="muted" href="/shops/${esc(shopId)}/orders">← Danh sách đơn</a>
      <a class="btn alt sm" href="/shops/${esc(shopId)}/orders/${esc(o.id)}/print" target="_blank" rel="noopener">🖨 In đơn</a>
    </div>
    <h1>Đơn hàng #${esc(o.order_number)}</h1>
    ${edited ? `<div class="notice ok">✓ Đã lưu sửa đơn — tồn kho &amp; tổng tiền đã cập nhật theo thay đổi.${Number(edited) > 0 ? ` Đã tạo <strong>phiếu hoàn ${money(Number(edited))}</strong> — hãy chuyển khoản lại cho khách.` : ''}</div>` : ''}
    ${returned ? `<div class="notice ok">✓ Đã nhận trả hàng — đã tạo <strong>phiếu hoàn ${money(Number(returned.refund) || 0)}</strong> (tiền hàng, không gồm ship). Hãy chuyển khoản lại cho khách. Hàng ${returned.restock ? '<strong>đã nhập lại kho</strong>' : '<strong>KHÔNG</strong> nhập lại kho'}.</div>` : ''}
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${externalReadOnlyNotice}
    ${cancelDebt}
    ${o.status === 'cancelled' && o.cancel_reason ? `<div class="card" style="border-color:var(--bd)"><strong>Lý do huỷ:</strong> ${esc(o.cancel_reason)}<br><span class="muted" style="font-size:.85rem">Khách đã nhận lý do này qua email.</span></div>` : ''}
    ${orderSummaryBlocks}
    <div class="card"><span class="pill">${badge(o.status, STATUS[o.status] ?? o.status)}</span>
      <span class="pill">${badge(paymentView[0], paymentView[1])} ${esc(o.payment_method?.toUpperCase() ?? '')}</span>
      ${['confirmed', 'shipped'].includes(o.status) && ['partial', 'fulfilled'].includes(o.fulfillment_status) ? `<span class="pill">${badge(o.fulfillment_status === 'fulfilled' ? 'delivered' : 'shipped', o.fulfillment_status === 'fulfilled' ? 'Đã gửi đủ' : 'Giao một phần')}</span>` : ''}
      ${actionGroups}
    </div>
    ${paymentCard}
    ${shipCostCard}
    ${o.status === 'returned' ? `<div class="card" style="border-color:#fcd34d;background:var(--warnbg)">
      <h2 style="margin-top:0">↩️ Đơn bị hoàn (bom hàng)</h2>
      <p class="muted" style="margin-bottom:0">${returnedStockNote}</p></div>` : ''}
    <div class="card"><h2>Sản phẩm</h2><div class="tblscroll">${tblCards({
    head: [{ html: 'Mặt hàng' }, { html: 'Đơn giá × SL' }, { html: 'Thành tiền' }],
    rows: (o.lines ?? []).map((l) => [
      { html: `<div class="pcell">${l.image_url ? `<img class="pthumb" src="${esc(l.image_url)}" alt="" loading="lazy" width="40" height="40">` : `<span class="pthumb ph">${IC_IMG}</span>`}<div style="min-width:0">${esc(l.title_snapshot)} <span class="muted">${esc(l.sku_snapshot ?? '')}</span>${Number(l.shipped_qty) > 0 ? ` <span class="muted">· đã gửi ${esc(l.shipped_qty)}/${esc(l.qty)}</span>` : ''}${Number(l.returned_qty) > 0 ? ` <span class="muted">· đã trả ${esc(l.returned_qty)}</span>` : ''}</div></div>` },
      { cls: 'muted', html: `${money(l.unit_price_vnd)} × ${esc(l.qty)}` },
      { style: 'text-align:right', html: money(Number(l.unit_price_vnd) * l.qty) },
    ]),
  })}</div>
      <div style="text-align:right;margin-top:8px" class="muted">Tạm tính ${money(o.subtotal_vnd)} · Ship ${money(o.shipping_vnd)}</div>
      <div style="text-align:right;font-weight:700;font-size:1.1rem">Tổng ${money(o.total_vnd)}</div></div>
    ${shipCard}
    ${refundHistory}
    ${returnHistory}
    ${carrierCard}
    ${shipmentsCard}
    ${resolutionCard}
    ${customerRequestCard}
    ${notificationCard}
    ${(() => {
      if (externalReadOnly) return '';
      // Hai ca cùng cần người xử, KHÁC nhau ở chỗ ta biết gì:
      //   finalize_failed — hãng ĐÃ tạo, có mã, chỉ hỏng bước chốt → chỉ cần xác nhận.
      //   ambiguous       — request TIMEOUT, ta KHÔNG BIẾT hãng đã tạo chưa và KHÔNG CÓ mã.
      //                     Muốn xác nhận thì shop phải đọc mã trên trang hãng rồi gõ vào,
      //                     nếu không thì đường duy nhất là huỷ — tức bỏ rơi vận đơn thật.
      const kt = (o.shipments ?? []).find((s) => s.provider_status === 'finalize_failed' || s.provider_status === 'ambiguous');
      if (!kt) return '';
      const moHo = kt.provider_status === 'ambiguous';
      const act = `/shops/${esc(shopId)}/orders/${esc(o.id)}/carrier-reconcile`;
      return `<div class="card" style="border-color:#fca5a5;background:#fef2f2">
      <h2 style="margin-top:0;color:#b91c1c">⚠ Vận đơn cần phục hồi</h2>
      <p class="muted">${moHo
        ? 'Lần tạo vận đơn trước <strong>không nhận được phản hồi</strong> từ hãng (mạng chậm/đứt), nên hệ thống KHÔNG BIẾT hãng đã tạo hay chưa và chưa có mã vận đơn. Chỗ giữ được giữ nguyên để không tạo trùng — nếu tạo mới ngay, đơn có thể bị <strong>thu hộ COD hai lần</strong>.<br>Hãy mở trang hãng kiểm tra: <strong>nếu có</strong> vận đơn cho đơn này → nhập mã rồi bấm "Đã tạo trên hãng"; <strong>nếu không có</strong> → bấm "Chưa tạo — mở khoá" để đặt lại.'
        : `Hãng ĐÃ tạo vận đơn nhưng hệ thống chốt đơn không thành công (đơn còn "đã xác nhận", chưa trừ kho). Kiểm tra trên trang hãng: nếu vận đơn <strong>${esc(kt.tracking_number ?? '')}</strong> có thật → bấm "Đã tạo trên hãng"; nếu bạn đã huỷ nó trên portal hãng → bấm "Huỷ vận đơn".`}</p>
      <div class="actions">
        <form method="POST" action="${act}">
          <input type="hidden" name="action" value="shipped">
          ${moHo ? '<input name="tracking_number" placeholder="Mã vận đơn đọc trên trang hãng" required style="max-width:260px">' : ''}
          <button class="btn sm" type="submit">Đã tạo trên hãng → giao</button></form>
        <form method="POST" action="${act}"><input type="hidden" name="action" value="cancel"><button class="btn warn sm" type="submit">${moHo ? 'Chưa tạo — mở khoá' : 'Huỷ vận đơn'}</button></form>
      </div>
    </div>`;
    })()}
    ${timelineCard}
    <div class="card"><h2>Khách hàng</h2>
      <p>${esc(o.customer_name)} · ${esc(o.customer_phone ?? '')}${o.customer_email ? ` · ${esc(o.customer_email)}` : ''}</p>
      ${o.note ? `<p class="muted">📝 Ghi chú nội bộ: ${esc(o.note)}</p>` : ''}
      ${o.source || o.source_ref ? `<p class="muted">Nguồn đơn: <strong>${esc(ORDER_SOURCE_LABEL[o.source] ?? o.source ?? 'không rõ')}</strong>${
        o.source_ref ? ` · ${/^https?:\/\//i.test(o.source_ref)
          ? `<a href="${esc(o.source_ref)}" target="_blank" rel="noopener noreferrer">mở hội thoại ↗</a>`
          : esc(o.source_ref)}` : ''}</p>` : ''}
      ${o.sync_status && o.sync_status !== 'not_required' ? `<div class="card" style="margin:10px 0;border-color:${o.sync_status === 'needs_attention' ? '#fca5a5' : '#93c5fd'}"><strong>${
        o.sync_status === 'synced' ? 'Đã đồng bộ với hệ thống POS'
        : o.sync_status === 'needs_attention' ? 'Đồng bộ cần xử lý'
        : 'Đang chờ hệ thống POS xác nhận'}</strong>${o.external_ref ? `<p class="muted" style="margin:6px 0 0">Mã ngoài: <code>${esc(o.external_ref)}</code></p>` : ''}${o.sync_error ? `<p class="err" style="margin:6px 0 0">${esc(o.sync_error)}</p>` : ''}</div>` : ''}
      ${o.shipping_address ? `<p class="muted">${esc(typeof o.shipping_address === 'object' ? [o.shipping_address.line, o.shipping_address.province].filter(Boolean).join(', ') || JSON.stringify(o.shipping_address) : o.shipping_address)}</p>` : ''}
      <p class="muted">Tạo: ${dt(o.created_at)}</p></div>`);
}

// Trang SỬA ĐƠN (declarative) — mirror renderOrderNew. Form POST TOÀN BỘ tập dòng mong
// muốn; seller tính lại giá/tồn. No-JS thêm/bớt dòng (CSP cấm JS):
//  • Dòng HIỆN CÓ: hidden variant_id + ô SL (giữ giá snapshot hiển thị). Đặt SL = 0 → BFF
//    lọc bỏ trước khi POST ⇒ "xoá dòng" (biến thể vắng khỏi lines = seller coi như bỏ).
//  • THÊM dòng: 5 slot chọn từ sellable-variants (?q= lọc, giống form tạo đơn tay).
// variant_id[]/qty[] trùng tên, ghép theo CHỈ SỐ (DOM order: mỗi hàng variant_id trước qty).
export function renderOrderEdit(ctx, shopId, o, variants, err, form, picker) {
  const base = `/shops/${esc(shopId)}`;
  const paid = picker?.mode === 'paid'; // v2: sửa đơn ĐÃ TRẢ (route /edit-paid, giảm → hoàn)
  const eurl = `${base}/orders/${esc(o.id)}/edit${paid ? '-paid' : ''}`;
  const pq = picker?.q ?? '';
  // <optgroup> theo sản phẩm cho slot THÊM dòng (mirror renderOrderNew).
  const byProduct = new Map();
  for (const v of variants) { if (!byProduct.has(v.product_title)) byProduct.set(v.product_title, []); byProduct.get(v.product_title).push(v); }
  const options = () => [...byProduct.entries()].map(([pt, vs]) => `<optgroup label="${esc(pt)}">${vs.map((v) =>
    `<option value="${esc(v.id)}">${esc(v.variant_title ? `${pt} — ${v.variant_title}` : pt)}${v.sku ? ` [${esc(v.sku)}]` : ''} · ${money(v.price_vnd)} · còn ${esc(v.available)}</option>`).join('')}</optgroup>`).join('');
  // Nhãn/giá tra cứu để hiển thị lại dòng sau khi POST lỗi (form.lines mất snapshot).
  const info = new Map();
  for (const l of (o.lines ?? [])) info.set(l.variant_id, { label: l.title_snapshot, sku: l.sku_snapshot, unit: l.unit_price_vnd, image_url: l.image_url });
  for (const v of variants) if (!info.has(v.id)) info.set(v.id, { label: v.variant_title ? `${v.product_title} — ${v.variant_title}` : v.product_title, sku: v.sku, unit: v.price_vnd });
  // Tập dòng đang sửa: lần đầu = dòng hiện tại của đơn; sau lỗi = đúng giá trị đã gõ.
  const rows = Array.isArray(form?.lines)
    ? form.lines.map((r) => ({ variant_id: r.variant_id, qty: r.qty }))
    : (o.lines ?? []).map((l) => ({ variant_id: l.variant_id, qty: l.qty }));
  const curRows = rows.map((r) => {
    const it = info.get(r.variant_id) ?? {};
    const lbl = it.label ?? r.variant_id;
    return `<div class="grid2" style="grid-template-columns:1fr 90px;align-items:end">
      <div><label>${esc(lbl)}${it.sku ? ` <span class="muted">${esc(it.sku)}</span>` : ''}${it.unit != null ? ` <span class="muted">· ${money(it.unit)}/cái</span>` : ''}</label>
        <input type="hidden" name="variant_id" value="${esc(r.variant_id)}">
        <div class="muted" style="font-size:.8rem">Đặt SL = 0 để xoá dòng này khỏi đơn.</div></div>
      <div><label>SL</label><input name="qty" type="number" min="0" max="1000" value="${esc(r.qty)}" inputmode="numeric"></div>
    </div>`;
  }).join('');
  // 5 slot THÊM dòng mới (rỗng — mirror renderOrderNew slot; để trống = bỏ qua).
  const addSlot = (i) => `<div class="grid2" style="grid-template-columns:1fr 90px;align-items:end">
    <div><label>Thêm sản phẩm ${i + 1} (tuỳ chọn)</label>
      <select name="variant_id">
        <option value="">— Bỏ trống —</option>${options()}
      </select></div>
    <div><label>SL</label><input name="qty" type="number" min="1" max="1000" value="1" inputmode="numeric"></div>
  </div>`;
  // Nguồn giá trị khách: sau lỗi = form; lần đầu = trạng thái đơn hiện tại.
  const addr = (typeof o.shipping_address === 'object' && o.shipping_address) ? o.shipping_address : {};
  const cur = { name: o.customer_name ?? '', phone: o.customer_phone ?? '', email: o.customer_email ?? '', address_line: addr.line ?? '', province: addr.province ?? '', ship_fee_vnd: o.shipping_vnd ?? '', note: o.note ?? '' };
  const src = form ?? cur;
  const v = (k) => esc(src[k] ?? '');
  const prov = src.province ?? '';
  return layout(`Sửa đơn #${o.order_number}`, ctx, `
    <a class="muted" href="${base}/orders/${esc(o.id)}">← Về chi tiết đơn #${esc(o.order_number)}</a>
    <h1>Sửa đơn${paid ? ' đã trả' : ''} #${esc(o.order_number)}</h1>
    <p class="muted" style="margin-top:-6px">Sửa số lượng, thêm/bớt hàng, đổi khách nhận hoặc phí ship. Hệ thống <strong>tính lại tồn kho &amp; tổng tiền</strong> khi lưu. Dòng cũ giữ <strong>giá lúc chốt</strong> (snapshot); dòng thêm mới lấy giá hiện tại.</p>
    ${paid ? `<div class="card" style="border-color:#fcd34d;background:var(--warnbg)"><h2 style="margin-top:0">💰 Đơn đã thanh toán ${money(o.total_vnd)}${Number(o.refunded_total_vnd) > 0 ? ` · đã hoàn ${money(o.refunded_total_vnd)}` : ''}</h2>
      <p class="muted" style="margin-bottom:0"><strong>GIẢM tổng</strong> → hệ thống tự tạo <strong>phiếu hoàn</strong> phần chênh (bạn chuyển khoản lại cho khách; nền tảng không giữ tiền). <strong>TĂNG tổng</strong> chưa hỗ trợ — tạo đơn mới cho phần thêm. Thao tác này cần <strong>xác nhận lại mật khẩu</strong>.</p></div>` : ''}
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${variants.length ? `<div class="card"><form method="GET" action="${eurl}" class="actions" style="align-items:end;flex-wrap:wrap">
      <div style="flex:1 1 220px"><label>Tìm sản phẩm cho ô THÊM dòng (tên / SKU — không cần dấu)</label>
        <input name="q" value="${esc(pq)}" maxlength="100" placeholder="ghe sofa, SKU…"></div>
      <button class="btn alt sm" type="submit">Lọc danh sách</button>
      ${pq ? `<a class="muted" href="${eurl}" style="align-self:center">Xoá lọc</a>` : ''}
      ${picker?.truncated ? `<p class="muted" style="flex-basis:100%;margin:6px 0 0">⚠ Đang hiện 500 biến thể đầu — còn nhiều hơn, hãy tìm kiếm để thu hẹp.</p>` : ''}
      <p class="muted" style="flex-basis:100%;margin:6px 0 0">Lưu ý: bấm "Lọc danh sách" sẽ tải lại trang theo trạng thái đơn hiện tại — hãy lọc TRƯỚC khi nhập thay đổi.</p>
    </form></div>` : ''}
    <form method="POST" action="${eurl}">
      <input type="hidden" name="picker_q" value="${esc(pq)}">
      <div class="card"><h2 style="margin-top:0">Hàng trong đơn</h2>
        ${curRows || '<p class="muted">Đơn chưa có dòng hàng nào — thêm ít nhất 1 dòng bên dưới.</p>'}
      </div>
      <div class="card"><h2 style="margin-top:0">Thêm hàng${pq ? ` <span class="muted" style="font-weight:400;font-size:.85rem">(đang lọc theo “${esc(pq)}”)</span>` : ''}</h2>
        ${variants.length ? [0, 1, 2, 3, 4].map(addSlot).join('') : '<p class="muted" style="margin:0">Chưa có sản phẩm đang bán nào để thêm.</p>'}
      </div>
      <div class="card"><h2 style="margin-top:0">Khách nhận</h2>
        <div class="grid2">
          <div><label>Họ tên *</label><input name="name" required maxlength="120" value="${v('name')}"></div>
          <div><label>SĐT *</label><input name="phone" required inputmode="tel" placeholder="09xxxxxxxx" value="${v('phone')}"></div>
        </div>
        <label>Email (tuỳ chọn)</label><input name="email" type="email" value="${v('email')}">
        <label>Địa chỉ giao</label><input name="address_line" maxlength="300" placeholder="Số nhà, đường, phường/xã, quận/huyện" value="${v('address_line')}">
        <label>Tỉnh / Thành (tuỳ chọn — cần đúng để tạo vận đơn hãng)</label>
        <select name="province"><option value="">— Không ghi —</option>${PROVINCES.map((p) => `<option value="${esc(p)}"${prov === p ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select>
      </div>
      <div class="card"><h2 style="margin-top:0">Phí &amp; ghi chú</h2>
        <div class="grid2">
          <div><label>Phí ship (đ — bỏ trống = giữ phí hiện tại)</label><input name="ship_fee_vnd" inputmode="numeric" placeholder="vd 25000" value="${v('ship_fee_vnd')}"></div>
          <div><label>Ghi chú nội bộ (tuỳ chọn)</label><input name="note" maxlength="500" value="${v('note')}"></div>
        </div>
      </div>
      <div class="actions">
        <button class="btn" type="submit">${paid ? 'Lưu — hoàn phần chênh nếu giảm' : 'Lưu sửa đơn'}</button>
        <a class="btn alt" href="${base}/orders/${esc(o.id)}">Huỷ</a>
      </div>
    </form>`);
}

// Interstitial step-up cho SỬA ĐƠN ĐÃ TRẢ (v2): mang TOÀN BỘ body sửa (dòng + khách + phí +
// ghi chú) qua màn xác nhận mật khẩu bằng hidden input → sau step-up retry KHÔNG mất dữ liệu
// người dùng đã nhập (mirror renderRefundStepUp/platform renew, nhưng body phức tạp hơn).
// Cổng xác nhận mật khẩu DÙNG CHUNG cho các thao tác money-out no-JS.
// `hidden` là mảng [name, value] — mọi ô người dùng đã nhập/tick được mang sang màn này
// rồi gửi lại nguyên vẹn sau khi xác thực. KHÔNG mang theo là bắt họ tick lại 50 đơn.
// Tên trùng nhau lặp lại được (order_ids ×N) vì đây là mảng, không phải object.
export function renderStepUpGate(ctx, { title, giaiThich, action, huyUrl, hidden = [], err }) {
  const hid = ([n, v]) => `<input type="hidden" name="${esc(n)}" value="${esc(v ?? '')}">`;
  return layout(title, ctx, `<div class="center"><div class="card">
    <h1>${esc(title)}</h1>
    <p class="muted">${esc(giaiThich)}</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="${esc(action)}">
      ${hidden.map(hid).join('')}
      <label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">
      <button class="btn" type="submit" style="width:100%;margin-top:12px">Xác nhận &amp; tiếp tục</button>
    </form>
    <p class="muted" style="font-size:13px;margin:10px 0 0">Xác nhận một lần dùng được trong 5 phút — làm cả loạt không phải gõ lại.</p>
    <a class="muted" href="${esc(huyUrl)}" style="display:inline-block;margin-top:10px">← Huỷ</a>
  </div></div>`);
}

export function renderEditPaidStepUp(ctx, shopId, oid, err, body) {
  const base = `/shops/${esc(shopId)}`;
  const hid = (name, val) => `<input type="hidden" name="${esc(name)}" value="${esc(val ?? '')}">`;
  const lineHid = (body.lines ?? []).map((l) => hid('variant_id', l.variant_id) + hid('qty', l.qty)).join('');
  const cf = body.customer ?? {};
  return layout('Xác nhận mật khẩu', ctx, `<div class="center"><div class="card">
    <h1>Xác nhận mật khẩu</h1>
    <p class="muted">Sửa đơn ĐÃ THANH TOÁN (có thể sinh hoàn tiền) cần xác thực lại. Nhập mật khẩu để lưu thay đổi.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="${base}/orders/${esc(oid)}/edit-paid/step-up">
      ${lineHid}
      ${hid('name', cf.name)}${hid('phone', cf.phone)}${hid('email', cf.email)}${hid('address_line', cf.address_line)}${hid('province', cf.province)}
      ${hid('ship_fee_vnd', body.ship_fee_vnd)}${hid('note', body.note)}
      <label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">
      <button class="btn" type="submit" style="width:100%;margin-top:12px">Xác nhận &amp; lưu</button>
    </form>
    <a class="muted" href="${base}/orders/${esc(oid)}" style="display:inline-block;margin-top:10px">← Huỷ</a>
  </div></div>`);
}

// Trang NHẬN TRẢ HÀNG (RMA 0078) — no-JS. Mỗi dòng đơn: hidden variant_id + ô "Số lượng trả"
// (max = đã mua − đã trả; dòng đã trả hết → readonly 0). variant_id[]/qty[] ghép theo CHỈ SỐ
// (mirror sửa đơn — mỗi hàng phát variant_id TRƯỚC qty). Checkbox "Nhập lại kho" (mặc định BẬT).
// Lý do tuỳ chọn. Hoàn = GIÁ HÀNG (đơn giá × SL trả), KHÔNG gồm phí ship. Money-out → step-up.
// form (sau lỗi): { lines:[{variant_id,qty}], reason, restock } — giữ nguyên input người nhập.
export function renderReturnForm(ctx, shopId, o, err, form, requestId = null) {
  const base = `/shops/${esc(shopId)}`;
  const rurl = `${base}/orders/${esc(o.id)}/return`;
  const entered = new Map((Array.isArray(form?.lines) ? form.lines : []).map((l) => [l.variant_id, l.qty]));
  const restockChecked = form ? !!form.restock : true; // mặc định BẬT nhập lại kho
  const rows = (o.lines ?? []).map((l) => {
    const purchased = Number(l.qty), already = Number(l.returned_qty ?? 0);
    const remaining = Math.max(0, purchased - already);
    const val = entered.has(l.variant_id) ? entered.get(l.variant_id) : 0;
    return `<div class="grid2" style="grid-template-columns:1fr 118px;align-items:end">
      <div><label>${esc(l.title_snapshot)}${l.sku_snapshot ? ` <span class="muted">${esc(l.sku_snapshot)}</span>` : ''}</label>
        <div class="muted" style="font-size:.82rem">${money(l.unit_price_vnd)}/cái · đã mua ${esc(purchased)}${already > 0 ? ` · đã trả ${esc(already)}` : ''} · còn trả được <strong>${esc(remaining)}</strong></div>
        <input type="hidden" name="variant_id" value="${esc(l.variant_id)}"></div>
      <div><label>Số lượng trả</label><input name="qty" type="number" min="0" max="${esc(remaining)}" value="${esc(val)}" inputmode="numeric"${remaining === 0 ? ' readonly' : ''}></div>
    </div>`;
  }).join('');
  return layout(`Nhận trả hàng #${o.order_number}`, ctx, `
    <a class="muted" href="${base}/orders/${esc(o.id)}">← Về chi tiết đơn #${esc(o.order_number)}</a>
    <h1>Nhận trả hàng #${esc(o.order_number)}</h1>
    <div class="card" style="border-color:#fcd34d;background:var(--warnbg)"><h2 style="margin-top:0">↩️ Đơn đã giao — nhận trả hàng</h2>
      <p class="muted" style="margin-bottom:0">Nhập số lượng trả cho từng dòng (tối đa phần <strong>chưa trả</strong>). Hệ thống tạo <strong>phiếu hoàn = tiền hàng</strong> (đơn giá × SL trả) — <strong>KHÔNG hoàn phí ship</strong>. Trả hết mọi dòng → đơn chuyển "Hoàn hàng". Thao tác này cần <strong>xác nhận lại mật khẩu</strong>.</p></div>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="${rurl}">
      ${requestId ? `<input type="hidden" name="request_id" value="${esc(requestId)}">` : ''}
      <div class="card"><h2 style="margin-top:0">Hàng trong đơn</h2>${rows}</div>
      <div class="card"><h2 style="margin-top:0">Tuỳ chọn</h2>
        <label style="display:flex;align-items:center;gap:8px;font-weight:500"><input type="checkbox" name="restock" value="on"${restockChecked ? ' checked' : ''} style="width:auto">Nhập lại kho (cộng tồn cho hàng còn bán được)</label>
        <label style="margin-top:12px">Lý do (tuỳ chọn)</label><input name="reason" maxlength="500" value="${esc(form?.reason ?? '')}" placeholder="khách đổi ý, hàng lỗi…">
      </div>
      <div class="actions">
        <button class="btn warn" type="submit">Nhận trả — tạo phiếu hoàn</button>
        <a class="btn alt" href="${base}/orders/${esc(o.id)}">Huỷ</a>
      </div>
    </form>`);
}

// Interstitial step-up cho NHẬN TRẢ HÀNG: mang phiếu trả (dòng + lý do + nhập kho) qua màn
// xác nhận mật khẩu bằng hidden input → retry sau step-up KHÔNG mất input (mirror renderEditPaidStepUp).
// restock chuyển thành '1'/'0' (readReturnBody đọc lại đúng), reason + từng cặp variant_id/qty.
export function renderReturnStepUp(ctx, shopId, oid, err, body) {
  const base = `/shops/${esc(shopId)}`;
  const hid = (name, val) => `<input type="hidden" name="${esc(name)}" value="${esc(val ?? '')}">`;
  const lineHid = (body.lines ?? []).map((l) => hid('variant_id', l.variant_id) + hid('qty', l.qty)).join('');
  const totalQty = (body.lines ?? []).reduce((s, l) => s + Number(l.qty), 0);
  return layout('Xác nhận mật khẩu', ctx, `<div class="center"><div class="card">
    <h1>Xác nhận mật khẩu</h1>
    <p class="muted">Nhận trả hàng sẽ tạo <strong>phiếu hoàn tiền hàng</strong> (${esc(totalQty)} sản phẩm)${body.restock ? ' và <strong>nhập lại kho</strong>' : ''}. Thao tác cần xác thực lại — nhập mật khẩu để tiếp tục.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="${base}/orders/${esc(oid)}/return/step-up">
      ${lineHid}
      ${body.request_id ? hid('request_id', body.request_id) : ''}
      ${hid('restock', body.restock ? '1' : '0')}
      ${hid('reason', body.reason)}
      <label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">
      <button class="btn warn" type="submit" style="width:100%;margin-top:12px">Xác nhận &amp; nhận trả</button>
    </form>
    <a class="muted" href="${base}/orders/${esc(oid)}" style="display:inline-block;margin-top:10px">← Huỷ</a>
  </div></div>`);
}

// Trang IN đơn — HTML độc lập, tối ưu in (không sidebar, no-JS). User bấm Ctrl+P.
export function renderOrderPrint(shopId, shop, o) {
  const s = shop ?? {};
  const lines = o.lines ?? [];
  const addr = o.shipping_address
    ? (typeof o.shipping_address === 'object' ? (o.shipping_address.line ?? JSON.stringify(o.shipping_address)) : o.shipping_address)
    : '';
  const contact = [s.business_address, s.contact_phone ? `ĐT: ${s.contact_phone}` : '', s.contact_email ? `Email: ${s.contact_email}` : '']
    .filter(Boolean).map(esc).join(' · ');
  // KIỆN CÒN SỐNG đầu tiên, không phải kiện ĐẦU DANH SÁCH. o.shipments sắp xếp
  // ORDER BY created_at (cũ nhất trước), nên đơn có claim hỏng rồi gửi lại sẽ in mã của
  // kiện ĐÃ HUỶ lên phiếu giao hàng/hoá đơn — shipper cầm giấy sai, khách tra mã ra số 0.
  const ship = (o.shipments ?? []).find((x) => x.status !== 'cancelled');
  const ST = { pending: 'Chờ xác nhận', confirmed: 'Đã xác nhận', shipped: 'Đang giao', delivered: 'Đã giao', cancelled: 'Đã huỷ', refunded: 'Đã hoàn tiền', returned: 'Hoàn hàng' };
  const PT = { unpaid: 'Chưa thanh toán', pending: 'Chờ thanh toán', paid: 'Đã thanh toán', refunded: 'Đã hoàn tiền' };
  const CSS = `*{box-sizing:border-box}body{font-family:system-ui,'Segoe UI',Roboto,sans-serif;color:#0d1526;margin:0;padding:24px;font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased}
.doc{max-width:720px;margin:0 auto}.hd{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:2px solid #0d1526;padding-bottom:12px;margin-bottom:16px}
.shop{font-size:1.35rem;font-weight:800;letter-spacing:-.02em}.contact{color:#59647a;font-size:.82rem;margin-top:3px}.ord{text-align:right}.no{font-size:1.2rem;font-weight:800;letter-spacing:-.01em}.ord .d{color:#59647a;font-size:.85rem}
.tags{margin:0 0 14px}.tag{display:inline-block;border:1px solid #e6ebf3;border-radius:999px;padding:3px 11px;font-size:.8rem;font-weight:600;margin-right:8px}
.cust{background:#f5f8fd;border:1px solid #e6ebf3;border-radius:10px;padding:12px 14px;margin-bottom:16px}.cust b{display:inline-block;min-width:60px;color:#3f4d66}
table{width:100%;border-collapse:collapse;margin-bottom:14px;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:9px 6px;border-bottom:1px solid #e6ebf3}th{font-size:.76rem;color:#59647a;text-transform:uppercase;letter-spacing:.05em;font-weight:700}
td.r,th.r{text-align:right}.tot{margin-left:auto;width:260px}.tot .row{display:flex;justify-content:space-between;padding:4px 0}.tot .g{font-weight:800;font-size:1.1rem;letter-spacing:-.01em;border-top:2px solid #0d1526;padding-top:8px;margin-top:4px}
.foot{margin-top:24px;color:#59647a;font-size:.82rem}.noprint a{color:#2463eb;font-weight:600}
@media print{.noprint{display:none}body{padding:0}}`;
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Đơn #${esc(o.order_number)} — ${esc(s.name ?? '')}</title><style>${CSS}</style></head><body>
  ${printDoc(shopId, s, o, { backLink: true })}
</body></html>`;
}

// Khối .doc của MỘT đơn — dùng chung cho in lẻ + in hàng loạt.
function printDoc(shopId, s, o, { backLink = false } = {}) {
  const lines = o.lines ?? [];
  const addr = o.shipping_address
    ? (typeof o.shipping_address === 'object' ? [o.shipping_address.line, o.shipping_address.province].filter(Boolean).join(', ') || JSON.stringify(o.shipping_address) : o.shipping_address)
    : '';
  const contact = [s.business_address, s.contact_phone ? `ĐT: ${s.contact_phone}` : '', s.contact_email ? `Email: ${s.contact_email}` : '']
    .filter(Boolean).map(esc).join(' · ');
  // KIỆN CÒN SỐNG đầu tiên, không phải kiện ĐẦU DANH SÁCH. o.shipments sắp xếp
  // ORDER BY created_at (cũ nhất trước), nên đơn có claim hỏng rồi gửi lại sẽ in mã của
  // kiện ĐÃ HUỶ lên phiếu giao hàng/hoá đơn — shipper cầm giấy sai, khách tra mã ra số 0.
  const ship = (o.shipments ?? []).find((x) => x.status !== 'cancelled');
  const ST = { pending: 'Chờ xác nhận', confirmed: 'Đã xác nhận', shipped: 'Đang giao', delivered: 'Đã giao', cancelled: 'Đã huỷ', refunded: 'Đã hoàn tiền', returned: 'Hoàn hàng' };
  const PT = { unpaid: 'Chưa thanh toán', pending: 'Chờ thanh toán', paid: 'Đã thanh toán', refunded: 'Đã hoàn tiền' };
  return `<div class="doc">
    <div class="hd">
      <div><div class="shop">${esc(s.name ?? 'Cửa hàng')}</div>${contact ? `<div class="contact">${contact}</div>` : ''}</div>
      <div class="ord"><div class="no">Đơn #${esc(o.order_number)}</div><div class="d">${dt(o.created_at)}</div></div>
    </div>
    <div class="tags"><span class="tag">${esc(ST[o.status] ?? o.status)}</span><span class="tag">${esc(PT[o.payment_status] ?? o.payment_status)} · ${esc(o.payment_method?.toUpperCase() ?? '')}</span></div>
    <div class="cust">
      <div><b>Khách:</b> ${esc(o.customer_name ?? '')} ${o.customer_phone ? `· ${esc(o.customer_phone)}` : ''}${o.customer_email ? ` · ${esc(o.customer_email)}` : ''}</div>
      ${addr ? `<div style="margin-top:4px"><b>Giao tới:</b> ${esc(addr)}</div>` : ''}
      ${ship ? `<div style="margin-top:4px"><b>Vận đơn:</b> ${esc(ship.tracking_number ?? '')} ${esc(ship.carrier ?? '')}</div>` : ''}
    </div>
    <table><thead><tr><th>Sản phẩm</th><th class="r">Đơn giá</th><th class="r">SL</th><th class="r">Thành tiền</th></tr></thead><tbody>
      ${lines.map((l) => `<tr><td>${esc(l.title_snapshot)}${l.sku_snapshot ? ` <span style="color:#6b7280">(${esc(l.sku_snapshot)})</span>` : ''}</td><td class="r">${money(l.unit_price_vnd)}</td><td class="r">${esc(l.qty)}</td><td class="r">${money(Number(l.unit_price_vnd) * l.qty)}</td></tr>`).join('')}
    </tbody></table>
    <div class="tot">
      <div class="row"><span>Tạm tính</span><span>${money(o.subtotal_vnd)}</span></div>
      <div class="row"><span>Phí vận chuyển</span><span>${Number(o.shipping_vnd) === 0 ? 'Miễn phí' : money(o.shipping_vnd)}</span></div>
      <div class="row g"><span>Tổng cộng</span><span>${money(o.total_vnd)}</span></div>
    </div>
    ${backLink ? `<div class="foot noprint"><a href="/shops/${esc(shopId)}/orders/${esc(o.id)}">← Quay lại</a> · Nhấn <strong>Ctrl+P</strong> (hoặc ⌘P) để in / lưu PDF.</div>` : ''}
  </div>`;
}

// In HÀNG LOẠT: mỗi đơn một trang (page-break). Ctrl+P một lần in cả xấp.
export function renderOrderPrintBatch(shopId, shop, orders) {
  const s = shop ?? {};
  const CSS = `*{box-sizing:border-box}body{font-family:system-ui,'Segoe UI',Roboto,sans-serif;color:#0d1526;margin:0;padding:24px;font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased}
.doc{max-width:720px;margin:0 auto 32px;page-break-after:always}.doc:last-child{page-break-after:auto}
.hd{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:2px solid #0d1526;padding-bottom:12px;margin-bottom:16px}
.shop{font-size:1.35rem;font-weight:800;letter-spacing:-.02em}.contact{color:#59647a;font-size:.82rem;margin-top:3px}.ord{text-align:right}.no{font-size:1.2rem;font-weight:800;letter-spacing:-.01em}.ord .d{color:#59647a;font-size:.85rem}
.tags{margin:0 0 14px}.tag{display:inline-block;border:1px solid #e6ebf3;border-radius:999px;padding:3px 11px;font-size:.8rem;font-weight:600;margin-right:8px}
.cust{background:#f5f8fd;border:1px solid #e6ebf3;border-radius:10px;padding:12px 14px;margin-bottom:16px}.cust b{display:inline-block;min-width:60px;color:#3f4d66}
table{width:100%;border-collapse:collapse;margin-bottom:14px;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:9px 6px;border-bottom:1px solid #e6ebf3}th{font-size:.76rem;color:#59647a;text-transform:uppercase;letter-spacing:.05em;font-weight:700}
td.r,th.r{text-align:right}.tot{margin-left:auto;width:260px}.tot .row{display:flex;justify-content:space-between;padding:4px 0}.tot .g{font-weight:800;font-size:1.1rem;letter-spacing:-.01em;border-top:2px solid #0d1526;padding-top:8px;margin-top:4px}
.noprint{max-width:720px;margin:0 auto 16px;color:#59647a;font-size:.85rem}
@media print{.noprint{display:none}body{padding:0}}`;
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>In ${orders.length} đơn — ${esc(s.name ?? '')}</title><style>${CSS}</style></head><body>
  <div class="noprint">Xấp ${esc(String(orders.length))} đơn — nhấn <strong>Ctrl+P</strong> để in (mỗi đơn một trang).</div>
  ${orders.map((o) => printDoc(shopId, s, o)).join('\n')}
</body></html>`;
}

// ── Sản phẩm & tồn kho ───────────────────────────────────────────────────────
const PSTATUSES = ['', 'active', 'draft', 'archived'];
export function renderProducts(ctx, shopId, data, filter, notice = null) {
  const d = data ?? {}; // backend có thể trả 200 body rỗng → data null; đừng để .products nổ
  const products = d.products ?? [];
  const q = encodeURIComponent(filter.q ?? '');
  const total = d.total ?? products.length;
  const off = filter.offset, lim = filter.limit;
  const nav = (o) => `?q=${q}&status=${esc(filter.status)}&offset=${o}`;
  // Tồn: '—' = CHƯA BIẾT (API cũ chưa trả cột) ≠ 0 = hết hàng. Giữ đúng quy ước của trang
  // chi tiết SP (pages.js:2202) để hai trang không "chửi nhau".
  // CON SỐ TỔNG GIẤU SIZE ĐÃ HẾT. Khách không mua "tổng" — khách mua đúng MỘT size. Trên một
  // shop thật 60 ngày, 14/15 biến thể hết hàng nằm trong sản phẩm hiện tồn 204, 172, 148: nhìn
  // là yên tâm bỏ qua, còn khách chọn đúng size đó thì mất đơn. Ngày đầu mỗi SP một biến thể
  // nên con số tổng CHÍNH LÀ sự thật — lỗi này chỉ sinh ra khi shop bắt đầu bán nhiều size.
  const stockCell = (p) => {
    if (p.stock == null) return '<span class="muted" title="Chưa tải được tồn kho">—</span>';
    const n = Number(p.stock);
    const het = Number(p.oos_variants ?? 0);
    const nhan = het > 0 && Number(p.variant_count) > 1
      ? ` <span class="badge cancelled" title="${esc(het)} phân loại (size/màu) đã hết hàng — khách chọn đúng phân loại đó sẽ không mua được">${esc(het)} loại hết</span>`
      : '';
    return `<span class="stock${n <= 0 ? ' zero' : (n < 5 ? ' low' : '')}">${esc(n)}</span>${nhan}`;
  };
  const rows = products.map((p) => [
    { label: '', html: `<input type="checkbox" name="product_ids" value="${esc(p.id)}" form="pbulk" aria-label="Chọn ${esc(p.title)}">` },
    { html: `<div class="pcell">${p.image_url ? `<img class="pthumb lg" src="${esc(p.image_url)}" alt="" loading="lazy" width="56" height="56">` : `<span class="pthumb lg ph">${IC_IMG}</span>`}<div style="min-width:0"><a href="/shops/${esc(shopId)}/products/${esc(p.id)}">${esc(p.title)}</a><div class="muted" style="font-size:.8rem">${esc(p.slug)}</div></div></div>` },
    { html: badge(p.status, PSTATUS[p.status] ?? p.status) },
    { cls: 'num right', html: money(p.price_vnd) },
    { cls: 'num right', html: p.variant_count },
    { cls: 'num right', html: stockCell(p) },
    { cls: 'num right', html: p.views_30d != null ? esc(p.views_30d) : '<span class="muted">—</span>' },
    { cls: 'num right', html: p.wish_count ? esc(p.wish_count) : '<span class="muted">0</span>' },
    { cls: 'num right', html: p.sold_count != null ? esc(p.sold_count) : '<span class="muted">—</span>' },
    { cls: 'muted', html: dt(p.created_at) },
  ]);
  // TAB trạng thái kèm SỐ ĐẾM (mẫu trang Đơn hàng). Đổi tab GIỮ ô tìm và RESET offset về 0
  // — nếu giữ offset, user đang ở trang 3 bấm tab khác sẽ thấy trang trắng.
  const cnts = d.counts ?? {};
  const statusTabs = `<div class="stabs" role="tablist" aria-label="Lọc theo trạng thái">${
    PSTATUSES.map((s) => {
      const on = (filter.status ?? '') === s;
      const label = s ? (PSTATUS[s] ?? s) : 'Tất cả';
      const n = cnts[s];
      // Bộ lọc "sắp hết hàng" phải đi theo ở CẢ BA đường rời trang: tab này, ô "Tìm theo tên",
      // và form thao tác hàng loạt. Số trên tab ĐÃ tính theo bộ lọc đó (tab ghi "26") nhưng
      // đường dẫn thì không mang nó — bấm vào ra 190 sản phẩm. Con số trên nút nói một đằng,
      // bấm vào ra một nẻo, và người bán lạc mà không biết mình đang lạc.
      return `<a class="stab${on ? ' on' : ''}" href="?status=${esc(s)}&q=${q}${filter.stock === 'low' ? '&stock=low' : ''}"${on ? ' aria-current="page"' : ''}>${esc(label)}${
        n != null ? `<span class="cnt">${esc(n)}</span>` : ''}</a>`;
    }).join('')}</div>`;
  // Thao tác hàng loạt (no-JS): checkbox nằm TRONG <table> nhưng thuộc form ngoài qua
  // thuộc tính form="pbulk"; mỗi nút dùng formaction riêng → 1 form, 3 đích.
  // Hidden status/q/offset để PRG quay lại ĐÚNG trang đang xem (mẫu đơn hàng làm rơi bộ lọc).
  const bulkBar = products.length ? `
      <form id="pbulk" method="POST" action="/shops/${esc(shopId)}/products/bulk-status" class="actions" style="margin-bottom:10px">
        <input type="hidden" name="status_filter" value="${esc(filter.status ?? '')}">
        <input type="hidden" name="q" value="${esc(filter.q ?? '')}">
        <input type="hidden" name="stock" value="${esc(filter.stock ?? '')}">
        <input type="hidden" name="offset" value="${esc(off)}">
        <button class="btn sm" type="submit" name="to" value="active" data-bulk-act="product_ids">✓ Đăng bán</button>
        <button class="btn alt sm" type="submit" name="to" value="draft" data-bulk-act="product_ids">✎ Chuyển nháp (ẩn)</button>
        <button class="btn alt sm" type="submit" name="to" value="archived" data-bulk-act="product_ids" data-confirm="Lưu trữ các sản phẩm đang chọn? Chúng sẽ bị ẩn khỏi cửa hàng.">📦 Lưu trữ</button>
        <span class="muted" data-bulk-count="product_ids" hidden style="font-size:13px"></span>
        <span class="muted" style="font-size:13px">Tích chọn ở cột đầu. Sản phẩm đã ở trạng thái đó sẽ được bỏ qua.</span>
      </form>` : '';
  const mx = d.max_products, cc = d.catalog_count;
  const capLine = mx != null ? `<p class="muted" style="margin:-6px 0 14px">Đã dùng <strong>${esc(cc)}/${esc(mx)}</strong> sản phẩm theo gói.${cc >= mx ? ' <strong style="color:#b45309">Đã đạt giới hạn — nâng gói để thêm.</strong>' : ''}</p>` : '';
  return layout('Sản phẩm', ctx, `
    <div class="toolbar"><h1 style="margin:0">Sản phẩm</h1>
      <span class="actions"><a class="btn alt" href="/shops/${esc(shopId)}/products/import">⬆ Nhập CSV/XLSX</a>
      <a class="btn" href="/shops/${esc(shopId)}/products/new">+ Thêm sản phẩm</a></span></div>
    ${capLine}
    ${notice ? `<div class="card" style="border-color:#a7f3d0;background:#ecfdf5;color:#065f46">${esc(notice)}</div>` : ''}
    ${statusTabs}
    <div class="card"><form method="GET" class="filters">
      <input type="hidden" name="status" value="${esc(filter.status ?? '')}">
      ${filter.stock === 'low' ? '<input type="hidden" name="stock" value="low">' : ''}
      <div style="flex:1 1 200px"><label>Tìm theo tên</label><input name="q" value="${esc(filter.q ?? '')}" placeholder="Ghế sofa…"></div>
      <div><button class="btn alt sm" type="submit">Lọc</button></div>
    </form></div>
    <div class="card">${products.length ? `${bulkBar}${filter.stock === 'low' ? `<p class="muted" style="margin:0 0 10px">Đang lọc: <strong>Sắp hết hàng</strong> · <a href="?${esc(new URLSearchParams({ ...(filter.status ? { status: filter.status } : {}), ...(filter.q ? { q: filter.q } : {}) }).toString())}">Xoá bộ lọc</a></p>` : ''}<div class="tblscroll">${tblCards({
      head: [
        { html: '<input type="checkbox" data-bulk-all="product_ids" hidden aria-label="Chọn tất cả sản phẩm trên trang">', label: '' },
        { html: 'Sản phẩm' }, { html: 'Trạng thái' }, { html: 'Giá', cls: 'right' }, { html: 'Biến thể', cls: 'right' },
        { html: 'Tồn', cls: 'right' },
        { html: 'Lượt xem', cls: 'right', attrs: ' title="Lượt xem trang sản phẩm trong 30 ngày qua"' },
        { html: 'Thích', cls: 'right', attrs: ' title="Số khách đã bấm Yêu thích"' },
        { html: 'Đã bán', cls: 'right' }, { html: 'Tạo' },
      ],
      rows,
    })}</div>
      <div class="muted" style="margin-top:12px">${total} sản phẩm ·
        ${off > 0 ? `<a href="${nav(Math.max(0, off - lim))}">← Trước</a>` : '<span style="color:#d1d5db">← Trước</span>'} ·
        ${off + lim < total ? `<a href="${nav(off + lim)}">Sau →</a>` : '<span style="color:#d1d5db">Sau →</span>'}
      </div>
      <p class="muted" style="font-size:.8rem;margin-bottom:0">“Tồn” là số còn bán được (đã trừ hàng đang giữ chỗ cho đơn chưa chốt). “Lượt xem” là số lần khách mở trang sản phẩm trong 30 ngày qua (đã loại bot). “Đã bán” tính từ đơn đã thanh toán. Cả hai cập nhật lại sau vài phút.</p>`
      // Rỗng vì LỌC ≠ rỗng vì CHƯA CÓ GÌ. Nói "Chưa có sản phẩm" ngay cạnh tab đếm 50 SP là
      // sai sự thật và làm chủ shop hoảng — phải mời họ bỏ lọc thay vì mời tạo mới.
      : (filter.status || filter.q || off > 0)
        ? `<p class="muted">Không có sản phẩm nào khớp bộ lọc hiện tại. <a href="?status=&q=">Xoá bộ lọc</a></p>`
        : '<p class="muted">Chưa có sản phẩm. Bấm “+ Thêm sản phẩm” để tạo.</p>'}</div>`);
}

// Quản lý danh mục: tạo/sửa/xoá + (gán sản phẩm ở trang chi tiết SP). Hiện storefront /c/:slug.
export function renderCategories(ctx, shopId, data, notice, err) {
  const base = `/shops/${esc(shopId)}`;
  const cats = data?.categories ?? [];
  // Cây 2 cấp (0095): cấp-1 = parent_id rỗng (hoặc con mồ côi khi cha đã xoá). byId để lọc mồ côi.
  const byId = new Map(cats.map((c) => [c.id, c]));
  const isRoot = (c) => !c.parent_id || !byId.has(c.parent_id);
  const roots = cats.filter(isRoot);
  const childrenOf = (pid) => cats.filter((c) => c.parent_id === pid && byId.has(c.parent_id));
  const hasKids = (c) => cats.some((x) => x.parent_id === c.id);
  // <option> danh mục cha = các danh mục CẤP-1 (trừ chính nó, chống tự làm cha). '' = cấp trên cùng.
  const parentOpts = (selId, exclId) => `<option value="">— Cấp trên cùng —</option>` +
    roots.filter((r) => r.id !== exclId).map((r) => `<option value="${esc(r.id)}"${r.id === selId ? ' selected' : ''}>${esc(r.name)}</option>`).join('');
  // Ô ảnh danh mục (0118). Form RIÊNG cho mỗi danh mục vì multipart không trộn được với
  // form "Lưu tên/thứ tự" bên cạnh (khác enctype). Có ảnh → xem trước + tick gỡ.
  const catImgCell = (c) => `<form method="POST" action="${base}/categories/${esc(c.id)}/image" enctype="multipart/form-data" style="display:flex;gap:8px;align-items:center;margin:0;flex-wrap:wrap">
      ${c.image_key
    ? `<img src="/media-public/${esc(c.image_key)}" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:8px;border:1px solid #eceef1;background:#fff">`
    : '<span class="muted" style="font-size:.78rem;white-space:nowrap">chưa có</span>'}
      <input type="file" name="image" accept="image/*" style="max-width:150px;font-size:.8rem">
      <button class="btn alt sm" type="submit">Lưu ảnh</button>
      ${c.image_key ? `<label class="muted" style="font-size:.78rem;display:inline-flex;align-items:center;gap:4px"><input type="checkbox" name="remove" value="1" style="width:auto"> Gỡ</label>` : ''}
    </form>`;
  const row = (c, child) => {
    // Danh mục ĐANG có con phải ở cấp-1 → không cho chọn cha (ẩn select, hiện nhãn "danh mục cha").
    const parentCell = hasKids(c)
      ? `<span class="muted" style="font-size:.78rem;align-self:center;white-space:nowrap">danh mục cha</span>`
      : `<select name="parent_id" aria-label="Danh mục cha" style="min-width:132px">${parentOpts(c.parent_id, c.id)}</select>`;
    return `<tr>
      <td><form method="POST" action="${base}/categories/${esc(c.id)}" style="display:flex;gap:8px;align-items:center;margin:0;flex-wrap:wrap">
        ${child ? '<span class="muted" aria-hidden="true">↳</span>' : ''}
        <input name="name" value="${esc(c.name)}" maxlength="200" required aria-label="Tên danh mục" style="flex:1;min-width:130px${child ? '' : ';font-weight:700'}">
        <input name="position" type="number" value="${esc(c.position)}" min="0" style="width:60px" aria-label="Thứ tự" title="Thứ tự hiển thị">
        ${parentCell}
        <button class="btn alt sm" type="submit">Lưu</button>
      </form></td>
      <td class="muted"><code>${esc(c.slug)}</code></td>
      <td>${catImgCell(c)}</td>
      <td style="text-align:right"><form method="POST" action="${base}/categories/${esc(c.id)}/delete" style="display:inline;margin:0"><button class="btn warn sm" type="submit">Xoá</button></form></td>
    </tr>`;
  };
  const rows = roots.map((r) => row(r, false) + childrenOf(r.id).map((ch) => row(ch, true)).join('')).join('');
  const createParentSel = `<option value="">— Cấp trên cùng —</option>` +
    roots.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  return layout('Danh mục', ctx, `
    <h1>Danh mục sản phẩm</h1>
    <p class="muted">Danh mục <strong>2 cấp</strong>: tạo danh mục cha (vd <em>Thịt</em>) rồi thêm danh mục con (<em>Thịt heo</em>, <em>Thịt bò</em>) bằng cách chọn "Danh mục cha". Khách bấm danh mục cha thấy tất cả sản phẩm của các con; bấm con thì lọc riêng loại đó.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice ? `<div class="card" style="background:#ecfdf5;border-color:#a7f3d0;color:#065f46">${esc(notice)}</div>` : ''}
    <div class="card"><h2 style="margin-top:0">Thêm danh mục</h2>
      <form method="POST" action="${base}/categories" class="actions" style="align-items:end;flex-wrap:wrap">
        <div><label>Tên</label><input name="name" required maxlength="200" placeholder="Thịt heo"></div>
        <div><label>Đường dẫn (slug)</label><input name="slug" required pattern="[a-z0-9][a-z0-9-]*" maxlength="60" placeholder="thit-heo"></div>
        <div><label>Danh mục cha</label><select name="parent_id">${createParentSel}</select></div>
        <button class="btn" type="submit">Thêm danh mục</button>
      </form>
      <p class="muted" style="font-size:.82rem;margin-bottom:0">Slug là đường dẫn trên storefront: <code>/products?cat=&lt;slug&gt;</code>. Chỉ chữ thường, số, gạch ngang. Chỉ hỗ trợ 2 cấp (cha → con).</p>
    </div>
    <div class="card">${cats.length
      ? `<table><thead><tr><th>Tên · thứ tự · danh mục cha</th><th>Slug</th><th>Ảnh đại diện</th><th></th></tr></thead><tbody>${rows}</tbody></table>
         <p class="muted" style="margin-top:10px;font-size:.85rem">Gán sản phẩm vào danh mục (nên gán vào danh mục <strong>con</strong>) ở <strong>trang chi tiết từng sản phẩm</strong> (mục "Danh mục").</p>
         <p class="muted" style="font-size:.85rem;margin-bottom:0"><strong>Ảnh đại diện</strong> hiện ở dải danh mục trang chủ. Bỏ trống thì hệ thống tự lấy ảnh sản phẩm mới nhất trong danh mục — nhưng danh mục chưa có sản phẩm (hoặc sản phẩm chưa có ảnh) sẽ trông trống, nên nên tự đặt. Ảnh <strong>vuông</strong> đẹp nhất.</p>`
      : '<p class="muted">Chưa có danh mục. Thêm ở trên để nhóm sản phẩm + hiện trên storefront.</p>'}</div>`);
}

// Khuyến mãi: mã giảm giá (% hoặc số tiền), điều kiện đơn tối thiểu / lượt / hết hạn.
export function renderCoupons(ctx, shopId, data, notice, err) {
  const base = `/shops/${esc(shopId)}`;
  const cps = data?.coupons ?? [];
  const fmtVal = (c) => c.kind === 'percent' ? `${esc(c.value)}%` : money(c.value);
  const rows = cps.map((c) => [
    { html: `<code>${esc(c.code)}</code>` },
    { html: `Giảm ${fmtVal(c)}${Number(c.min_subtotal_vnd) > 0 ? `<div class="muted" style="font-size:.8rem">đơn từ ${money(c.min_subtotal_vnd)}</div>` : ''}` },
    { cls: 'num', html: `${esc(c.used_count)}${c.max_uses != null ? `/${esc(c.max_uses)}` : ''}` },
    { cls: 'muted', html: c.expires_at ? dt(c.expires_at) : '—' },
    { html: badge(c.active ? 'active' : 'archived', c.active ? 'Đang bật' : 'Tắt') },
    { style: 'text-align:right', html: `<div class="thumb-act" style="justify-content:flex-end">
      <form method="POST" action="${base}/coupons/${esc(c.id)}/toggle" style="margin:0"><input type="hidden" name="active" value="${c.active ? '' : '1'}"><button class="btn alt sm" type="submit">${c.active ? 'Tắt' : 'Bật'}</button></form>
      <form method="POST" action="${base}/coupons/${esc(c.id)}/delete" style="margin:0"><button class="btn warn sm" type="submit">Xoá</button></form>
    </div>` },
  ]);
  return layout('Mã giảm giá', ctx, `
    <h1>Mã giảm giá</h1>
    <p class="muted">Khách <strong>nhập mã</strong> ở giỏ hàng để được giảm. Muốn giảm giá <strong>tự động theo khung giờ</strong> (không cần mã) → dùng <a href="${base}/promotions">Flash sale</a>.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice ? `<div class="card" style="background:#ecfdf5;border-color:#a7f3d0;color:#065f46">${esc(notice)}</div>` : ''}
    <div class="card"><h2 style="margin-top:0">Tạo mã giảm giá</h2>
      <form method="POST" action="${base}/coupons" class="filters" style="align-items:end">
        <div><label>Mã (khách nhập ở giỏ)</label><input name="code" required maxlength="40" placeholder="GIAM10" style="text-transform:uppercase;width:150px"></div>
        <div><label>Loại</label><select name="kind"><option value="percent">% phần trăm</option><option value="fixed">Số tiền (đ)</option></select></div>
        <div><label>Giá trị</label><input name="value" type="number" min="1" required placeholder="10" style="width:110px"></div>
        <div><label>Đơn tối thiểu (đ)</label><input name="min_subtotal_vnd" type="number" min="0" placeholder="0" style="width:130px"></div>
        <div><label>Số lượt (trống=∞)</label><input name="max_uses" type="number" min="1" placeholder="∞" style="width:110px"></div>
        <div><label>Hết hạn (trống=∞)</label><input name="expires_at" type="date" style="width:150px"></div>
        <button class="btn" type="submit">Tạo</button>
      </form>
      <p class="muted" style="font-size:.82rem;margin-bottom:0">Giảm trên <strong>tạm tính</strong> (không giảm phí ship). Khách nhập mã ở trang giỏ hàng.</p>
    </div>
    <div class="card">${cps.length
      ? tblCards({
        head: [{ html: 'Mã' }, { html: 'Ưu đãi' }, { html: 'Đã dùng' }, { html: 'Hết hạn' }, { html: 'Trạng thái' }, { html: '', label: '' }],
        rows,
      })
      : '<p class="muted">Chưa có mã giảm giá. Tạo ở trên để chạy khuyến mãi.</p>'}</div>`);
}

// Flash sale (0082): chương trình giảm giá TỰ ĐỘNG theo khung giờ (không mã). Storefront tự
// hiện giá sale + gạch giá gốc. Danh sách nhóm theo trạng thái + form tạo (no-JS).
const PROMO_STATUS = { off: ['Đã tắt', 'archived'], upcoming: ['Sắp diễn ra', 'pending'], running: ['Đang chạy', 'active'], ended: ['Đã kết thúc', 'archived'] };
// datetime-local value theo GIỜ VN (input hiển thị giờ địa phương của khách; ta gửi chuỗi
// VN wall-clock, seller parse +07:00). Format ISO ts → 'YYYY-MM-DDTHH:MM' giờ VN.
const vnLocal = (ts) => { const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ts)).reduce((o, x) => (o[x.type] = x.value, o), {}); return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`; };
const vnFull = (ts) => new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(ts));
export function renderPromotions(ctx, shopId, data, notice, err) {
  const base = `/shops/${esc(shopId)}`;
  const ps = data?.promotions ?? [];
  const fmtVal = (p) => p.kind === 'percent' ? `-${esc(p.value)}%` : `-${money(p.value)}`;
  const scopeTxt = (p) => p.scope === 'all' ? 'Toàn shop' : `${esc(p.product_count ?? 0)} sản phẩm`;
  const row = (p) => [
    { html: `<a href="${base}/promotions/${esc(p.id)}">${esc(p.title)}</a>` },
    { html: `<strong>${fmtVal(p)}</strong>` },
    { cls: 'muted', html: scopeTxt(p) },
    { cls: 'muted', style: 'font-size:.85rem', html: `${vnFull(p.starts_at)}<br>→ ${vnFull(p.ends_at)}` },
    { html: badge(PROMO_STATUS[p.status]?.[1] ?? 'archived', PROMO_STATUS[p.status]?.[0] ?? p.status) },
    { style: 'text-align:right', html: `<div class="thumb-act" style="justify-content:flex-end">
      ${p.active ? `<form method="POST" action="${base}/promotions/${esc(p.id)}/end" style="margin:0"><button class="btn alt sm" type="submit">Kết thúc sớm</button></form>` : ''}
      <form method="POST" action="${base}/promotions/${esc(p.id)}/delete" style="margin:0"><button class="btn warn sm" type="submit">Xoá</button></form>
    </div>` },
  ];
  const table = ps.length
    ? tblCards({
      head: [{ html: 'Tên' }, { html: 'Ưu đãi' }, { html: 'Phạm vi' }, { html: 'Thời gian (giờ VN)' }, { html: 'Trạng thái' }, { html: '', label: '' }],
      rows: ps.map(row),
    })
    : '<p class="muted">Chưa có chương trình. Tạo ở trên để chạy flash sale.</p>';
  return layout('Flash sale', ctx, `
    <h1>Flash sale — khuyến mãi tự động</h1>
    <p class="muted">Giảm giá <strong>tự động theo khung giờ</strong> (khách KHÔNG cần nhập mã). Cửa hàng tự hiện giá sale + gạch giá gốc + badge %. Hết giờ giá tự về như cũ.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice ? `<div class="card" style="background:#ecfdf5;border-color:#a7f3d0;color:#065f46">${esc(notice)}</div>` : ''}
    <div class="card"><h2 style="margin-top:0">Tạo chương trình</h2>
      <form method="POST" action="${base}/promotions">
        <div class="filters" style="align-items:end">
          <div><label>Tên chương trình</label><input name="title" required maxlength="120" placeholder="Sale cuối tuần" style="width:200px"></div>
          <div><label>Loại giảm</label><select name="kind"><option value="percent">% phần trăm</option><option value="fixed">Số tiền (đ)</option></select></div>
          <div><label>Giá trị</label><input name="value" type="number" min="1" required placeholder="20" style="width:110px"></div>
          <div><label>Phạm vi</label><select name="scope"><option value="all">Toàn bộ sản phẩm</option><option value="products">Chọn sản phẩm</option></select></div>
        </div>
        <div class="filters" style="align-items:end;margin-top:8px">
          <div><label>Bắt đầu (giờ VN)</label><input name="starts_at" type="datetime-local" required style="width:210px"></div>
          <div><label>Kết thúc (giờ VN)</label><input name="ends_at" type="datetime-local" required style="width:210px"></div>
          <button class="btn" type="submit">Tạo chương trình</button>
        </div>
      </form>
      <p class="muted" style="font-size:.82rem;margin-bottom:0">Chọn "Chọn sản phẩm" rồi bấm vào chương trình để thêm từng sản phẩm. Nhiều chương trình trùng sản phẩm → khách hưởng mức giảm <strong>sâu nhất</strong> (không cộng dồn).</p>
    </div>
    <div class="card">${table}</div>`);
}

// Chi tiết chương trình + picker sản phẩm 2 bước (scope=products). data từ GET /promotions/:id;
// picker {q, products, truncated} từ GET /products?q= (tìm không dấu). No-JS: mỗi SP 1 form Thêm.
export function renderPromotionDetail(ctx, shopId, p, picker, err) {
  const base = `/shops/${esc(shopId)}`;
  const fmtVal = p.kind === 'percent' ? `-${esc(p.value)}%` : `-${money(p.value)}`;
  const chosen = p.products ?? [];
  const chosenIds = new Set(chosen.map((x) => x.product_id));
  const warnFixed = p.kind === 'fixed' ? chosen.filter((x) => Number(p.value) >= Number(x.price_vnd)) : [];
  const chosenRows = chosen.length ? chosen.map((x) => `<tr>
      <td>${esc(x.title)}</td><td class="num">${money(x.price_vnd)}</td>
      <td style="text-align:right"><form method="POST" action="${base}/promotions/${esc(p.id)}/products/${esc(x.product_id)}/remove" style="margin:0"><button class="btn warn sm" type="submit">Gỡ</button></form></td>
    </tr>`).join('') : `<tr><td colspan="3" class="muted">Chưa chọn sản phẩm nào — chương trình chưa áp cho ai.</td></tr>`;
  const found = picker?.products ?? [];
  const pickRows = found.map((v) => `<tr>
      <td>${esc(v.title)}</td><td class="num">${money(v.price_vnd)}</td>
      <td style="text-align:right">${chosenIds.has(v.id)
        ? '<span class="muted">đã thêm</span>'
        : `<form method="POST" action="${base}/promotions/${esc(p.id)}/products" style="margin:0"><input type="hidden" name="product_id" value="${esc(v.id)}"><button class="btn alt sm" type="submit">Thêm</button></form>`}</td>
    </tr>`).join('');
  return layout('Chi tiết flash sale', ctx, `
    <a class="muted" href="${base}/promotions">← Danh sách flash sale</a>
    <h1>${esc(p.title)}</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <div class="card"><span class="pill">${badge(PROMO_STATUS[p.status]?.[1] ?? 'archived', PROMO_STATUS[p.status]?.[0] ?? p.status)}</span>
      <span class="pill">Ưu đãi <strong>${fmtVal}</strong></span>
      <span class="pill">${p.scope === 'all' ? 'Toàn shop' : 'Chọn sản phẩm'}</span>
      <p class="muted" style="margin:10px 0 0">Từ <strong>${vnFull(p.starts_at)}</strong> đến <strong>${vnFull(p.ends_at)}</strong> (giờ VN).</p>
    </div>
    ${p.scope === 'all' ? `<div class="card"><p class="muted" style="margin:0">Phạm vi TOÀN SHOP — mọi sản phẩm đang bán đều được giảm ${fmtVal} trong khung giờ.</p></div>` : `
    ${warnFixed.length ? `<div class="card" style="border-color:#fcd34d;background:#fffbeb"><p style="margin:0" class="muted">⚠ ${warnFixed.length} sản phẩm có giá ≤ mức giảm cố định — sẽ về 0đ khi sale.</p></div>` : ''}
    <div class="card"><h2 style="margin-top:0">Sản phẩm trong chương trình</h2>
      <table><thead><tr><th>Sản phẩm</th><th class="num">Giá</th><th></th></tr></thead><tbody>${chosenRows}</tbody></table></div>
    <div class="card"><h2 style="margin-top:0">Thêm sản phẩm</h2>
      <form method="GET" action="${base}/promotions/${esc(p.id)}" class="filters" style="align-items:end">
        <div><label>Tìm sản phẩm (tên / SKU)</label><input name="q" value="${esc(picker?.q ?? '')}" maxlength="100" placeholder="tên hoặc mã SKU" style="width:240px"></div>
        <button class="btn alt sm" type="submit">Tìm</button>
      </form>
      ${picker?.q ? (found.length
        ? `<table style="margin-top:10px"><thead><tr><th>Sản phẩm</th><th class="num">Giá</th><th></th></tr></thead><tbody>${pickRows}</tbody></table>${picker.truncated ? '<p class="muted" style="font-size:.82rem">Chỉ hiện 100 kết quả đầu — gõ rõ hơn để lọc.</p>' : ''}`
        : '<p class="muted" style="margin-top:10px">Không tìm thấy sản phẩm.</p>')
        : '<p class="muted" style="margin-top:10px">Gõ từ khoá rồi bấm Tìm để thêm sản phẩm.</p>'}</div>`}`);
}

// Blog: danh sách bài viết.
export function renderBlogList(ctx, shopId, data) {
  const base = `/shops/${esc(shopId)}`;
  const posts = data?.posts ?? [];
  const rows = posts.map((p) => `<tr>
    <td><a href="${base}/blog/${esc(p.id)}">${esc(p.title)}</a><div class="muted" style="font-size:.8rem">/blog/${esc(p.slug)}</div></td>
    <td>${badge(p.status, p.status === 'published' ? 'Đã đăng' : 'Nháp')}</td>
    <td class="muted">${p.published_at ? dt(p.published_at) : dt(p.updated_at)}</td></tr>`).join('');
  return layout('Blog', ctx, `
    <div class="toolbar"><h1 style="margin:0">Blog / Tin tức</h1><a class="btn" href="${base}/blog/new">+ Viết bài</a></div>
    <div class="card">${posts.length
      ? `<table><thead><tr><th>Bài viết</th><th>Trạng thái</th><th>Cập nhật</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="muted">Chưa có bài viết. Bấm “Viết bài” — bài đã đăng hiện ở <code>/blog</code> trên storefront (tốt cho SEO & marketing).</p>'}</div>`);
}
/**
 * BỘ CHỌN ẢNH dùng chung cho mọi chỗ cần "chọn một ảnh của shop".
 *
 * Trước đây mỗi chỗ như vậy là một ô text bắt dán chuỗi `<shop-id>/<media-id>.webp`,
 * kèm câu hướng dẫn "vào trang Sản phẩm, mở ảnh, lấy phần sau /media-public/". Chủ shop
 * nói thẳng: đọc xong vẫn không biết phải chèn gì. Ô nào người dùng không tự đoán được
 * cách điền thì tính năng đó coi như không tồn tại — và đó là lý do "Blog và trang nội
 * dung khó vận hành".
 *
 * Radio thuần HTML nên vẫn 0-JS. `noneLabel` rỗng = KHÔNG có lựa chọn "không ảnh"
 * (section ảnh bắt buộc phải có ảnh; ảnh bìa blog thì được phép trống).
 *
 * Ảnh đang dùng mà KHÔNG nằm trong danh sách (ảnh tải riêng, không gắn sản phẩm nào)
 * vẫn phải hiện: thiếu nó thì bấm Lưu là ảnh biến mất mà không ai hiểu vì sao.
 */
export function mediaPicker(name, cur, media, { noneLabel = 'Không dùng ảnh' } = {}) {
  const one = (key, url, label, checked) => `<label class="covpick">
      <input type="radio" name="${esc(name)}" value="${esc(key)}"${checked ? ' checked' : ''}>
      ${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : `<span class="covnone">${esc(noneLabel)}</span>`}
      ${label ? `<span class="covlab">${esc(label)}</span>` : ''}
    </label>`;
  const list = Array.isArray(media) ? media : [];
  const inList = list.some((m) => m.public_key === cur);
  return `<div class="covgrid">
      ${noneLabel ? one('', null, '', !cur) : ''}
      ${cur && !inList ? one(cur, `/media-public/${cur}`, 'ảnh đã tải lên', true) : ''}
      ${list.map((m) => one(m.public_key, m.url, m.product_title, m.public_key === cur)).join('')}
    </div>`;
}

/**
 * Ảnh CHÈN GIỮA BÀI blog. Ảnh bìa đã có bộ chọn, nhưng ảnh trong thân bài vẫn phải là
 * một dòng `[anh:<key>|mô tả]` — đây là cú pháp văn bản, không thể thay bằng radio.
 *
 * Việc còn làm được là bỏ chỗ NHỚ: bày sẵn từng ảnh kèm ĐÚNG dòng cần dán, để người
 * viết chỉ việc bôi đen và chép. Trước đây placeholder viết "[anh:<key-media>|mô tả]"
 * rồi để mặc người dùng tự đi tìm key ở đâu đó — đúng cái họ nói là không hiểu.
 */
function insertSnippets(media) {
  const list = (Array.isArray(media) ? media : []).slice(0, 24);
  if (!list.length) return '';
  return `<details class="snip"><summary>Chèn ảnh vào giữa bài (${list.length} ảnh có sẵn)</summary>
    <p class="muted" style="font-size:.83rem;margin:6px 0">Chép dòng dưới mỗi ảnh rồi dán vào ô Nội dung, <strong>trên một dòng riêng</strong>. Sửa phần sau dấu <code>|</code> thành mô tả ảnh của bạn.</p>
    <div class="snipgrid">${list.map((m) => `<div class="snipit">
        <img src="${esc(m.url)}" alt="" loading="lazy">
        <code>[anh:${esc(m.public_key)}|${esc(m.product_title ?? 'mô tả ảnh')}]</code>
      </div>`).join('')}</div></details>`;
}

// Blog: soạn/sửa bài. publish/gỡ/xoá TÁCH khỏi form chính (không lồng form).
export function renderBlogEditor(ctx, shopId, post, err, media = []) {
  const base = `/shops/${esc(shopId)}/blog`;
  const p = post ?? {};
  const isNew = !p.id;
  const action = isNew ? base : `${base}/${esc(p.id)}`;
  const manage = isNew ? '' : `<div class="card"><div class="actions">
    ${p.status === 'published'
      ? `<form method="POST" action="${base}/${esc(p.id)}/unpublish"><button class="btn alt" type="submit">Gỡ đăng</button></form>`
      : `<form method="POST" action="${base}/${esc(p.id)}/publish"><button class="btn" type="submit">Đăng bài</button></form>`}
    <form method="POST" action="${base}/${esc(p.id)}/delete"><button class="btn warn" type="submit">Xoá bài</button></form>
  </div></div>`;
  // BỘ CHỌN ẢNH BÌA — thay cho ô bắt dán "key media".
  //
  // Ô cũ yêu cầu người dùng tự đi tìm chuỗi `<shop-id>/<media-id>.webp` rồi dán vào.
  // Chủ shop nói thẳng: đọc giải thích cũng không hiểu phải chèn cái gì. Một ô mà
  // người dùng không thể tự đoán ra cách điền thì tính năng coi như không tồn tại.
  //
  // Nay hai đường, đúng hai cách chủ shop đề xuất:
  //   1) CHỌN từ ảnh đã có — radio thuần HTML, giữ nguyên 0-JS, ảnh đang dùng tick sẵn.
  //   2) TẢI LÊN ảnh mới — form riêng, chỉ hiện với bài ĐÃ tạo (bài mới chưa có chỗ gắn).
  const cur = p.cover_image_key ?? '';
  const coverPicker = mediaPicker('cover_image_key', cur, media)
    + (media.length === 0 && !cur ? '<p class="muted" style="font-size:.83rem;margin:6px 0 0">Chưa có ảnh nào. Tải ảnh sản phẩm lên trước, hoặc dùng nút tải ảnh bìa bên dưới.</p>' : '');
  return layout(isNew ? 'Viết bài' : `Sửa bài`, ctx, `
    <a class="muted" href="${base}">← Blog</a>
    <div class="toolbar"><h1 style="margin:0">${isNew ? 'Viết bài mới' : esc(p.title)}</h1>${isNew ? '' : badge(p.status, p.status === 'published' ? 'Đã đăng' : 'Nháp')}</div>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <div class="card"><form method="POST" action="${action}">
      <label>Tiêu đề</label><input name="title" required maxlength="200" value="${esc(p.title ?? '')}">
      <label>Đường dẫn (slug)</label><input name="slug" required pattern="[a-z0-9][a-z0-9-]*" maxlength="60" value="${esc(p.slug ?? '')}" placeholder="meo-chon-ghe-sofa">
      <label>Tóm tắt (hiện ở danh sách blog)</label><textarea name="excerpt" maxlength="500" rows="2">${esc(p.excerpt ?? '')}</textarea>
      <label>Ảnh bìa <span class="muted" style="font-weight:400">(tuỳ chọn — hiện ở danh sách blog, đầu bài, và khi chia sẻ Facebook/Zalo)</span></label>
      ${coverPicker}
      <label>Nội dung</label><textarea name="body" rows="14" maxlength="50000" placeholder="Viết nội dung bài… (cách dòng để tách đoạn). Muốn chèn ảnh giữa bài: xem danh sách ảnh ngay dưới ô này.">${esc(p.body ?? '')}</textarea>
      ${insertSnippets(media)}
      <div class="actions" style="margin-top:12px"><button class="btn" type="submit">${isNew ? 'Tạo bài (nháp)' : 'Lưu thay đổi'}</button></div>
    </form>
    ${isNew
      ? '<p class="muted" style="font-size:.83rem;margin:10px 0 0">Muốn dùng ảnh bìa RIÊNG (không phải ảnh sản phẩm)? Tạo bài nháp trước, rồi tải ảnh lên ở đây.</p>'
      : `<form method="POST" action="${base}/${esc(p.id)}/cover" enctype="multipart/form-data" class="actions" style="margin-top:14px;border-top:1px solid var(--bd);padding-top:14px">
          <input type="file" name="file" accept="image/*" required>
          <button class="btn alt sm" type="submit">Tải ảnh bìa lên</button>
          <span class="muted" style="font-size:.82rem">JPEG/PNG/WebP/GIF. Ảnh tự nén lại thành WebP.</span>
        </form>`}
    </div>
    ${manage}`);
}

// Nhập sản phẩm hàng loạt từ CSV/XLSX (onboard concierge nhanh). Mỗi dòng biến thể; các dòng
// cùng handle/product_id được gộp thành một sản phẩm.
// Tệp mẫu — ĐÚNG định dạng docs/45: có handle để gộp biến thể, có trục, danh mục, ảnh URL.
// Ba dòng đầu cùng handle ⇒ MỘT sản phẩm ba biến thể; dòng cuối handle khác ⇒ sản phẩm riêng.
// Mẫu phải TỰ NÓ dạy được cách gộp, vì đó là thứ khó hiểu nhất của định dạng này — một mẫu
// một-dòng-một-sản-phẩm sẽ dạy sai ngay từ đầu.
export const IMPORT_SAMPLE_CSV = [
  'handle,title,description,status,category,option1_name,option1_value,option2_name,option2_value,sku,price_vnd,compare_at_price_vnd,cost_vnd,stock,weight_gram,image_url',
  'ao-thun-basic,Áo thun cotton basic,Cotton 100% co giãn,active,Thời trang > Áo,Màu,Đen,Size,M,ATB-DEN-M,199000,259000,120000,12,220,',
  'ao-thun-basic,,,,,Màu,Đen,Size,L,ATB-DEN-L,199000,259000,120000,8,240,',
  'ao-thun-basic,,,,,Màu,Trắng,Size,M,ATB-TRA-M,209000,259000,125000,5,220,',
  'den-ngu-go,Đèn ngủ để bàn gỗ sồi,,draft,Nhà cửa > Đèn,,,,,DEN-GO-01,390000,,210000,3,900,',
].join('\n');

export function renderProductImport(ctx, shopId, result, err) {
  const base = `/shops/${esc(shopId)}/products`;
  const n = (x) => esc(Number(x ?? 0));

  // Bảng lỗi theo DÒNG trong file gốc — người bán sửa file, không sửa cơ sở dữ liệu.
  const errRows = (result?.errors ?? []).map((e) => [
    { cls: 'num', html: esc(e.line) },
    { html: esc(e.title || '(trống)') },
    { cls: 'muted', html: esc(e.error) },
  ]);
  const errTable = errRows.length ? `<div class="tblscroll">${tblCards({
    head: [{ html: 'Dòng' }, { html: 'Sản phẩm' }, { html: 'Lý do bị bỏ' }],
    rows: errRows,
  })}</div>` : '';

  // Cột nhận diện được / bị bỏ qua. Bỏ qua IM LẶNG là cách người bán mất nguyên cột giá mà
  // không hề biết — nên cột lạ phải hiện ra kèm câu "dữ liệu ở đây KHÔNG được nhập".
  const cols = result?.columns;
  const colCard = cols ? `<div class="card">
    <h2 style="margin-top:0">Cột đọc được từ tệp</h2>
    <p class="muted" style="margin-top:-6px;font-size:13px">Tên cột không phân biệt hoa thường và dấu cách — <code>Variant SKU</code>, <code>variant_sku</code>, <code>sku</code> là một.</p>
    <p style="margin:0 0 8px">${(cols.recognised ?? []).map((c) => `<span class="badge delivered" style="margin:0 6px 6px 0;display:inline-block">${esc(c.header)} → ${esc(c.field)}</span>`).join('') || '<span class="muted">không nhận ra cột nào</span>'}</p>
    ${(cols.ignored ?? []).length ? `<p class="muted" style="margin:0"><strong style="color:var(--warn)">Bỏ qua:</strong> ${cols.ignored.map((h) => `<code>${esc(h)}</code>`).join(', ')} — dữ liệu ở các cột này KHÔNG được nhập.</p>` : ''}
  </div>` : '';

  const axisHints = (result?.axisHints ?? []).filter((h) => h?.productId);
  const axisControls = axisHints.length ? `<div class="card" style="flex-basis:100%">
    <h2 style="margin-top:0">Tách trục TikTok</h2>
    <p class="muted" style="margin-top:-6px">Dấu <code>, </code> chỉ là suy đoán. Kiểm tra giá trị gốc và đặt tên trục trước khi nhập thật. Bỏ chọn <strong>Tách</strong> nếu dấu phẩy thuộc cùng một giá trị.</p>
    <div class="tblscroll">${tblCards({
    head: [{ html: 'product_id' }, { html: 'Giá trị gốc' }, { html: 'Tên trục' }, { html: 'Hành động' }],
    rows: axisHints.map((h) => [
      { html: `<code>${esc(h.productId)}</code><div class="muted">${esc(h.name || '')}</div>` },
      { html: `<code>${esc(h.sample || '—')}</code><div class="muted">→ ${(h.parts ?? []).map(esc).join(' · ')}</div>` },
      { cls: 'actions', style: 'align-items:flex-start;flex-wrap:wrap', html: `
          ${Array.from({ length: Number(h.count ?? 1) }, (_, i) => `<label style="min-width:130px"><span class="muted">Trục ${i + 1}</span><input name="axis_${esc(h.productId)}_${i + 1}" value="${esc(h.axisNames?.[i] || (h.count === 1 ? 'Phân loại' : `Phân loại ${i + 1}`))}" maxlength="60"></label>`).join('')}
        ` },
      { html: `<label><input type="checkbox" name="split_off_${esc(h.productId)}" value="1"> Tắt tách</label>` },
    ]),
  })}</div>
  </div>` : '';

  const selectedImportMode = ['create_only', 'update_only', 'upsert'].includes(result?.import_mode) ? result.import_mode : 'create_only';
  const importControls = `<div class="card" style="flex-basis:100%;display:grid;gap:10px">
    <div><strong>Chế độ nhập</strong><span class="muted" style="margin-left:8px">Chỉ ghép theo mã nguồn TikTok, không ghép theo tên.</span></div>
    <div class="actions" style="align-items:flex-start;flex-wrap:wrap;gap:12px">
      <label><input type="radio" name="import_mode" value="create_only"${selectedImportMode === 'create_only' ? ' checked' : ''}> Chỉ tạo mới</label>
      <label><input type="radio" name="import_mode" value="update_only"${selectedImportMode === 'update_only' ? ' checked' : ''}> Chỉ cập nhật</label>
      <label><input type="radio" name="import_mode" value="upsert"${selectedImportMode === 'upsert' ? ' checked' : ''}> Upsert</label>
    </div>
    <div class="actions" style="align-items:flex-start;flex-wrap:wrap;gap:12px">
      <label><input type="checkbox" name="update_content" value="1"${result?.update_content !== false ? ' checked' : ''}> Cập nhật tiêu đề, mô tả, ảnh</label>
      <label><input type="checkbox" name="update_stock" value="1"${result?.update_stock ? ' checked' : ''}> Cập nhật tồn kho (ghi sổ điều chỉnh)</label>
      <label><input type="checkbox" name="update_price" value="1"${result?.update_price ? ' checked' : ''}> Cập nhật giá bán</label>
      <label class="muted"><input type="checkbox" name="price_confirmed" value="1"${result?.price_confirmed ? ' checked' : ''}> Tôi xác nhận thay đổi giá có thể ảnh hưởng khuyến mãi</label>
    </div>
  </div>`;

  let resultCard = '';
  if (result?.dry_run) {
    // XEM TRƯỚC: chưa ghi gì. Phải NÓI RÕ điều đó — một trang tên "kết quả" mà không nói đã
    // ghi hay chưa là chỗ người bán tưởng xong rồi và bỏ đi, cửa hàng vẫn trống.
    const rows = (result.preview ?? []).map((p) => [
      { html: `${esc(p.title)}<div class="muted" style="font-size:.8rem">${esc(p.slug)}</div>` },
      { cls: 'num', html: esc(p.variants) },
      { cls: 'muted', html: p.axes?.length ? esc(p.axes.join(' × ')) : '—' },
      { cls: 'muted', html: esc(p.category || '—') },
    ]);
    const diffRows = (result.diffs ?? []).map((d) => [
      { html: `<code>${esc(d.external_id || d.product_external_id || '')}</code>` },
      { html: esc(d.sku || d.field || '') },
      { html: esc(d.action) },
      { cls: 'muted', html: `${esc(d.from == null ? '—' : d.from)} → ${esc(d.to == null ? '—' : d.to)}` },
      { cls: 'muted', html: esc(d.reason || '') },
    ]);
    const diffTable = diffRows.length ? `<h2 style="margin:16px 0 6px;font-size:15px">Bảng khác biệt trước khi ghi</h2><div class="tblscroll">${tblCards({
      head: [{ html: 'Mã nguồn' }, { html: 'SKU/trường' }, { html: 'Hành động' }, { html: 'Hiện tại → file' }, { html: 'Ghi chú' }],
      rows: diffRows,
    })}</div>` : '';
    const warningBox = (result.warnings ?? []).length ? `<p style="color:var(--warn)"><strong>Cảnh báo:</strong> ${(result.warnings ?? []).map((w) => esc(w.message)).join(' ')}</p>` : '';
    resultCard = `<div class="card" style="border-color:var(--indigo)">
      <h2 style="margin-top:0">Xem trước — <span style="color:var(--indigo)">chưa ghi gì vào cửa hàng</span></h2>
      <div class="metrics" style="margin-bottom:12px">
        <div class="metric"><div class="l">Dòng trong tệp</div><div class="v">${n(result.rows)}</div></div>
        <div class="metric"><div class="l">Sẽ tạo</div><div class="v">${n(result.created)} sản phẩm</div></div>
        ${result.skipped_existing ? `<div class="metric"><div class="l">Đã có, sẽ bỏ qua</div><div class="v">${n(result.skipped_existing)}</div></div>` : ''}
        <div class="metric"><div class="l">Biến thể</div><div class="v">${n(result.variants)}</div></div>
        <div class="metric"><div class="l">Ảnh sẽ tải</div><div class="v">${n(result.images?.queued)}${result.images?.invalid ? ` <span style="font-size:13px;color:var(--warn)">+${n(result.images.invalid)} sai địa chỉ</span>` : ''}${result.images?.skipped ? ` <span style="font-size:13px;color:var(--warn)">+${n(result.images.skipped)} vượt trần</span>` : ''}</div></div>
        ${result.updated ? `<div class="metric"><div class="l">Sẽ cập nhật</div><div class="v">${n(result.updated)}</div></div>` : ''}
      </div>
      ${result.failed ? `<p><strong style="color:var(--warn)">${n(result.failed)} dòng cần xem lại</strong> — sửa các dòng dưới rồi tải lại.</p>${errTable}` : '<p class="muted">Không có lỗi nào.</p>'}
      ${warningBox}${diffTable}
      ${rows ? `<h2 style="margin:16px 0 6px;font-size:15px">Sản phẩm sẽ tạo${result.created > (result.preview ?? []).length ? ` (${(result.preview ?? []).length} đầu tiên)` : ''}</h2>
      <div class="tblscroll">${tblCards({
      head: [{ html: 'Sản phẩm' }, { html: 'Biến thể' }, { html: 'Trục' }, { html: 'Danh mục' }],
      rows,
    })}</div>` : ''}
      <p style="margin:16px 0 0">Ưng ý thì chọn lại tệp ở dưới và bấm <strong>Nhập thật</strong>.</p>
    </div>`;
  } else if (result) {
    const img = result.images ?? { queued: 0, invalid: 0, skipped: 0 };
    const warningBox = (result.warnings ?? []).length ? `<p style="color:var(--warn)"><strong>Cảnh báo:</strong> ${(result.warnings ?? []).map((w) => esc(w.message)).join(' ')}</p>` : '';
    resultCard = `<div class="card" style="border-color:${result.failed ? 'var(--warn)' : 'var(--good)'}">
      <h2 style="margin-top:0">Đã nhập xong</h2>
      <div class="metrics" style="margin-bottom:12px">
        <div class="metric"><div class="l">Sản phẩm đã tạo</div><div class="v" style="color:var(--good)">${n(result.created)}</div></div>
        ${result.updated ? `<div class="metric"><div class="l">Sản phẩm cập nhật</div><div class="v" style="color:var(--good)">${n(result.updated)}</div></div>` : ''}
        ${result.unchanged ? `<div class="metric"><div class="l">Không thay đổi</div><div class="v">${n(result.unchanged)}</div></div>` : ''}
        ${result.skipped_existing ? `<div class="metric"><div class="l">Bỏ qua trùng</div><div class="v">${n(result.skipped_existing)}</div></div>` : ''}
        <div class="metric"><div class="l">Biến thể</div><div class="v">${n(result.variants)}</div></div>
        <div class="metric"><div class="l">Ảnh đang tải nền</div><div class="v">${n(img.queued)}</div></div>
        ${result.failed ? `<div class="metric"><div class="l">Bị bỏ</div><div class="v" style="color:var(--warn)">${n(result.failed)}</div></div>` : ''}
      </div>
      ${img.queued ? `<p class="muted" style="margin-top:-4px">Ảnh được tải <strong>ở chế độ nền</strong> và hiện dần trong vài phút — không cần chờ ở trang này.</p>` : ''}
      ${(img.invalid || img.skipped) ? `<p class="muted" style="margin-top:-4px"><strong style="color:var(--warn)">${n(img.invalid)}</strong> địa chỉ ảnh sai định dạng (phải bắt đầu bằng <code>http://</code> hoặc <code>https://</code>) nên không tải được${img.skipped ? `, <strong>${n(img.skipped)}</strong> bỏ qua do vượt trần mỗi lần nhập` : ''}. Sản phẩm vẫn đã tạo — bạn tự tải ảnh lên sau ở trang sản phẩm.</p>` : ''}
      ${warningBox}${errTable}
      ${result.created ? `<p style="margin-bottom:0"><a class="btn" href="${base}">Xem danh sách sản phẩm →</a></p>` : ''}
    </div>`;
  }

  return layout('Nhập sản phẩm', ctx, `
    <a class="muted" href="${base}">← Danh sách sản phẩm</a>
    <h1>Nhập sản phẩm từ CSV hoặc XLSX</h1>
    <p class="muted" style="margin-top:-8px">Chuyển danh mục từ TikTok Shop, Shopify hoặc Haravan. Tệp XLSX TikTok và CSV Shopify/Haravan được nhận diện tự động.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${resultCard}
    ${colCard}

    <div class="card">
      <h2 style="margin-top:0">Tải tệp lên</h2>
      <p class="muted" style="margin-top:-6px">Bấm <strong>Xem trước</strong> để kiểm tra kết quả trước khi ghi — bước này không ghi gì vào cửa hàng.</p>
      <form method="POST" action="${base}/import" enctype="multipart/form-data" class="actions" style="align-items:center;flex-wrap:wrap;gap:10px">
        ${importControls}
        ${axisControls}
        <input type="file" name="file" accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required>
        <button class="btn" type="submit" name="mode" value="preview">Xem trước</button>
        <button class="btn alt" type="submit" name="mode" value="commit"
          data-confirm="Ghi THẬT sản phẩm mới và các cập nhật đã chọn vào cửa hàng. Tiếp tục?">Nhập thật</button>
      </form>
      <p class="muted" style="font-size:13px;margin-bottom:0">Tối đa 1000 sản phẩm và 10MB mỗi lần. Hệ thống tự chia lô nhưng không bao giờ cắt giữa các biến thể của cùng sản phẩm. Sản phẩm mới mặc định ở trạng thái <strong>nháp</strong>.</p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Định dạng tệp</h2>
      <p style="margin-top:-6px"><a class="btn alt sm" href="${base}/import/mau.csv">⬇ Tải tệp mẫu</a>
        <span class="muted" style="margin-left:8px;font-size:13px">Mở bằng Excel, thay dữ liệu của bạn rồi tải lên.</span></p>
      <p><strong>Nhiều biến thể của cùng một sản phẩm:</strong> cho các dòng đó cùng giá trị cột <code>handle</code>.
        Dòng đầu của nhóm ghi tên/mô tả/danh mục; các dòng sau chỉ cần cột biến thể.</p>
      <div class="tblscroll">${tblCards({
        head: [{ html: 'Cột' }, { html: 'Bắt buộc' }, { html: 'Ý nghĩa' }],
        rows: [
          [{ html: `<code>handle</code>` }, { html: `không`, cls: 'muted' }, { html: `Khoá gộp biến thể. Bỏ trống ⇒ mỗi dòng một sản phẩm.` }],
          [{ html: `<code>title</code>` }, { html: `<strong>có</strong>` }, { html: `Tên sản phẩm (ghi ở dòng đầu của nhóm).` }],
          [{ html: `<code>sku</code>` }, { html: `<strong>có</strong>` }, { html: `Mã hàng, không trùng trong cửa hàng.` }],
          [{ html: `<code>price_vnd</code>` }, { html: `<strong>có</strong>` }, { html: `Giá bán, ví dụ <code>199000</code>.` }],
          [{ html: `<code>option1_name</code> / <code>option1_value</code>` }, { html: `không`, cls: 'muted' }, { html: `Trục biến thể, ví dụ <code>Màu</code> / <code>Đen</code>. Tối đa 3 trục.` }],
          [{ html: `<code>category</code>` }, { html: `không`, cls: 'muted' }, { html: `Danh mục, tối đa 2 cấp: <code>Thời trang &gt; Áo</code>.` }],
          [{ html: `<code>image_url</code>` }, { html: `không`, cls: 'muted' }, { html: `Địa chỉ ảnh (http/https). Hệ thống tự tải về và lưu.` }],
          [{ html: `<code>compare_at_price_vnd</code>` }, { html: `không`, cls: 'muted' }, { html: `Giá gạch ngang — phải lớn hơn giá bán.` }],
          [{ html: `<code>cost_vnd</code>` }, { html: `không`, cls: 'muted' }, { html: `Giá vốn, dùng cho báo cáo lãi.` }],
          [{ html: `<code>stock</code>` }, { html: `không`, cls: 'muted' }, { html: `Tồn kho ban đầu (mặc định 0).` }],
          [{ html: `<code>weight_gram</code>` }, { html: `không`, cls: 'muted' }, { html: `Cân nặng tính bằng <strong>gram</strong> — dùng để tính phí ship.` }],
          [{ html: `<code>status</code>` }, { html: `không`, cls: 'muted' }, { html: `<code>active</code> để bán ngay, mặc định <code>draft</code>.` }],
        ],
      })}</div>
      <p class="muted" style="font-size:13px;margin-bottom:0">Đơn hàng cũ và khách hàng cũ <strong>chưa</strong> nhập được — phần đó chạm vào số liệu doanh thu nên phải làm riêng cho chắc.</p>
    </div>`);
}


// ── Nhập ĐƠN CŨ từ sàn khác (docs/45) ──────────────────────────────────────
export const ORDER_IMPORT_SAMPLE_CSV = [
  'order_code,date,customer_name,customer_phone,customer_email,total_vnd,status,address,province',
  'SPX-240615-001,15/06/2026,Phạm Thị Lan,0933444555,lan@gmail.com,1250000,delivered,12 Lê Lợi,Đà Nẵng',
  'SPX-240620-002,20/06/2026,Phạm Thị Lan,0933444555,,750000,delivered,,',
  'SPX-240701-003,01/07/2026,Trần Văn Nam,0912888777,,99000,đã huỷ,,',
].join('\n');

// Cảnh báo ẩn danh PII cho lô đơn cũ sắp nhập / vừa nhập.
// Nói HẬU QUẢ trước, cơ chế sau, và chỉ THẲNG chỗ đổi — người bán vừa bỏ công di cư để giữ
// hồ sơ khách, họ cần biết ngay là sẽ mất phần nào và đổi được ở đâu. Nói RÕ cái KHÔNG mất
// (doanh số, nội dung đơn) cũng quan trọng ngang: thiếu vế đó thì câu này đọc như "mất đơn".
function piiImportWarn(pii, shopId, truocKhiNhap) {
  if (!pii?.rows) return '';
  return `<div class="card" style="border-color:var(--warn);background:var(--warnbg)">
    <h2 style="margin-top:0">⚠ ${esc(pii.rows)} đơn trong lô này cũ hơn hạn lưu thông tin khách của bạn (${esc(pii.retention_months)} tháng)</h2>
    <p style="margin:0 0 8px">${truocKhiNhap
      ? `Nếu nhập, <strong>tên · số điện thoại · email · địa chỉ</strong> của ${esc(pii.rows)} đơn đó sẽ được <strong>ẩn danh trong vòng 24 giờ</strong>.`
      : `<strong>Tên · số điện thoại · email · địa chỉ</strong> của ${esc(pii.rows)} đơn vừa nhập sẽ được <strong>ẩn danh trong vòng 24 giờ</strong>.`}
      Doanh số, dòng hàng và trạng thái đơn <strong>giữ nguyên</strong> — chỉ phần nhận dạng khách bị xoá.</p>
    <p class="muted" style="margin:0 0 12px;font-size:.9rem">Đây là chính sách <em>bạn</em> đã đặt: hạn lưu tính theo
      <strong>tuổi của đơn</strong>, không tính theo ngày nhập vào hệ thống — nên đơn cũ vừa nhập cũng đã quá hạn.</p>
    <p style="margin:0">${truocKhiNhap
      ? `Muốn giữ lại thông tin khách thì <strong>đổi hạn lưu trước khi bấm Nhập thật</strong>: `
      : `Muốn giữ lại cho những lần nhập sau: `}<a class="btn" href="/shops/${esc(shopId)}/settings">Cài đặt → Ẩn danh đơn cũ</a></p>
  </div>`;
}

export function renderOrderImport(ctx, shopId, result, err) {
  const base = `/shops/${esc(shopId)}/orders`;
  const n = (x) => esc(Number(x ?? 0));
  const errRows = (result?.errors ?? []).map((e) => [
    { cls: 'num', html: esc(e.line) },
    { html: esc(e.title || '(không mã)') },
    { cls: 'muted', html: esc(e.error) },
  ]);
  const errTable = errRows.length ? `<div class="tblscroll">${tblCards({
    head: [{ html: 'Dòng' }, { html: 'Mã đơn' }, { html: 'Lý do bị bỏ' }],
    rows: errRows,
  })}</div>` : '';

  const cols = result?.columns;
  const colCard = cols ? `<div class="card">
    <h2 style="margin-top:0">Cột đọc được từ tệp</h2>
    <p style="margin:0 0 8px">${(cols.recognised ?? []).map((c) => `<span class="badge delivered" style="margin:0 6px 6px 0;display:inline-block">${esc(c.header)} → ${esc(c.field)}</span>`).join('') || '<span class="muted">không nhận ra cột nào</span>'}</p>
    ${(cols.ignored ?? []).length ? `<p class="muted" style="margin:0"><strong style="color:var(--warn)">Bỏ qua:</strong> ${cols.ignored.map((h) => `<code>${esc(h)}</code>`).join(', ')} — dữ liệu ở các cột này KHÔNG được nhập.</p>` : ''}
  </div>` : '';

  let card = '';
  if (result?.dry_run) {
    const rows = (result.preview ?? []).map((o) => [
      { html: esc(o.ref || '—') },
      { cls: 'muted', html: esc(o.date) },
      { html: `${esc(o.name || '(không tên)')}<div class="muted" style="font-size:.8rem">${esc(o.phone)}</div>` },
      { cls: 'num right', html: money(o.total_vnd) },
      { cls: 'muted', html: esc(o.status) },
    ]);
    card = `<div class="card" style="border-color:var(--indigo)">
      <h2 style="margin-top:0">Xem trước — <span style="color:var(--indigo)">chưa ghi gì vào cửa hàng</span></h2>
      <div class="metrics" style="margin-bottom:12px">
        <div class="metric"><div class="l">Dòng trong tệp</div><div class="v">${n(result.rows)}</div></div>
        <div class="metric"><div class="l">Đơn sẽ nhập</div><div class="v">${n(result.created)}</div></div>
        <div class="metric"><div class="l">Khách hàng</div><div class="v">${n(result.customers)}</div></div>
      </div>
      ${result.failed ? `<p><strong style="color:var(--warn)">${n(result.failed)} dòng sẽ bị bỏ</strong> — sửa rồi tải lại.</p>${errTable}` : '<p class="muted">Không có lỗi nào.</p>'}
      ${rows.length ? `<div class="tblscroll">${tblCards({
        head: [{ html: 'Mã gốc' }, { html: 'Ngày' }, { html: 'Khách' }, { html: 'Tổng tiền', cls: 'right' }, { html: 'Trạng thái' }],
        rows,
      })}</div>` : ''}
      <p style="margin:16px 0 0">Ưng ý thì chọn lại tệp ở dưới và bấm <strong>Nhập thật</strong>.</p>
    </div>${piiImportWarn(result.pii, shopId, true)}`;
  } else if (result) {
    card = `<div class="card" style="border-color:var(--good)">
      <h2 style="margin-top:0">Đã nhập xong</h2>
      <div class="metrics" style="margin-bottom:12px">
        <div class="metric"><div class="l">Đơn cũ đã nhập</div><div class="v" style="color:var(--good)">${n(result.created)}</div></div>
        ${result.duplicate ? `<div class="metric"><div class="l">Bỏ qua vì đã có</div><div class="v">${n(result.duplicate)}</div></div>` : ''}
        ${result.failed ? `<div class="metric"><div class="l">Dòng hỏng</div><div class="v" style="color:var(--warn)">${n(result.failed)}</div></div>` : ''}
      </div>
      ${result.duplicate ? '<p class="muted" style="margin-top:-4px">Các đơn bỏ qua đã có sẵn (khớp mã gốc) — nhập lại cùng tệp KHÔNG nhân đôi số liệu khách.</p>' : ''}
      ${errTable}
      <p style="margin-bottom:0"><a class="btn" href="/shops/${esc(shopId)}/customers">Xem hồ sơ khách hàng →</a></p>
    </div>${piiImportWarn(result.pii, shopId, false)}`;
  }

  return layout('Nhập đơn cũ', ctx, `
    <a class="muted" href="${base}">← Danh sách đơn</a>
    <h1>Nhập đơn hàng cũ từ sàn khác</h1>
    <p class="muted" style="margin-top:-8px">Mang lịch sử mua của khách sang đây, để bạn biết ai đã mua gì trước khi chuyển nền tảng.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}

    <div class="card" style="border-color:var(--indigo);background:var(--indigobg)">
      <h2 style="margin-top:0">Đọc kỹ trước khi nhập</h2>
      <ul style="margin:0;line-height:1.9">
        <li>Đơn cũ <strong>KHÔNG tính vào doanh thu</strong>, báo cáo lãi, đối soát COD hay điểm thưởng — báo cáo của bạn vẫn chỉ phản ánh việc bán hàng <strong>trên nền tảng này</strong>.</li>
        <li>Chúng vào hệ thống để <strong>tra cứu</strong> và <strong>gộp thành hồ sơ khách hàng</strong> (ai mua gì, chi bao nhiêu, mua gần nhất khi nào).</li>
        <li><strong>Không nhập dòng hàng</strong>, chỉ phần đầu đơn — hàng đã ngừng kinh doanh không còn khớp mã nào trong kho hiện tại.</li>
        <li>Tồn kho <strong>không bị trừ</strong>: hàng đã giao ở sàn cũ từ lâu.</li>
      </ul>
    </div>

    ${card}
    ${colCard}

    <div class="card">
      <h2 style="margin-top:0">Tải tệp lên</h2>
      <form method="POST" action="${base}/import" enctype="multipart/form-data" class="actions" style="align-items:center;flex-wrap:wrap;gap:10px">
        <input type="file" name="file" accept=".csv,text/csv" required>
        <button class="btn" type="submit" name="mode" value="preview">Xem trước</button>
        <button class="btn alt" type="submit" name="mode" value="commit"
          data-confirm="Ghi THẬT vào cửa hàng. Nên bấm Xem trước ít nhất một lần. Tiếp tục?">Nhập thật</button>
      </form>
      <p class="muted" style="font-size:13px;margin-bottom:0">Tối đa 2000 dòng mỗi lần.</p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Định dạng tệp</h2>
      <p style="margin-top:-6px"><a class="btn alt sm" href="${base}/import/mau.csv">⬇ Tải tệp mẫu</a></p>
      <div class="tblscroll">${tblCards({
        head: [{ html: 'Cột' }, { html: 'Bắt buộc' }, { html: 'Ý nghĩa' }],
        rows: [
          [{ html: `<code>customer_phone</code>` }, { html: `<strong>có</strong>` }, { html: `Số điện thoại — <strong>khoá gộp hồ sơ khách</strong>. Thiếu thì đơn không gắn được với ai nên bị bỏ.` }],
          [{ html: `<code>date</code>` }, { html: `<strong>có</strong>` }, { html: `Ngày đặt: <code>28/07/2026</code> hoặc <code>2026-07-28</code>. Ngày ở tương lai bị từ chối.` }],
          [{ html: `<code>total_vnd</code>` }, { html: `<strong>có</strong>` }, { html: `Tổng tiền đơn.` }],
          [{ html: `<code>order_code</code>` }, { html: `nên có`, cls: 'muted' }, { html: `Mã đơn ở sàn cũ. Đây là <strong>khoá chống nhập trùng</strong> — có nó thì nhập lại cùng tệp sẽ bỏ qua thay vì nhân đôi.` }],
          [{ html: `<code>customer_name</code>, <code>customer_email</code>` }, { html: `không`, cls: 'muted' }, { html: `Tên và email khách.` }],
          [{ html: `<code>status</code>` }, { html: `không`, cls: 'muted' }, { html: `<code>delivered</code> (mặc định) · <code>đã huỷ</code> · <code>refunded</code>.` }],
          [{ html: `<code>address</code>, <code>province</code>` }, { html: `không`, cls: 'muted' }, { html: `Địa chỉ giao.` }],
        ],
      })}</div>
      <p class="muted" style="font-size:13px;margin-bottom:0">Không khai <code>order_code</code> thì hệ thống không có gì để nhận diện, nên nhập lại tệp sẽ tạo đơn trùng.</p>
    </div>`);
}


export function renderProductNew(ctx, shopId, err, f = {}) {
  return layout('Thêm sản phẩm', ctx, `
    <a class="muted" href="/shops/${esc(shopId)}/products">← Danh sách sản phẩm</a>
    <h1>Thêm sản phẩm</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="/shops/${esc(shopId)}/products" enctype="multipart/form-data">
      <div class="card"><h2 style="margin-top:0">Thông tin</h2>
        <label>Tên sản phẩm *</label><input name="title" required maxlength="200" value="${esc(f.title ?? '')}" placeholder="Cà phê sữa đá">
        <div class="grid2">
          <div><label>Giá (VND) *</label><input name="price_vnd" type="number" min="0" step="1000" required value="${esc(f.price_vnd ?? '')}"></div>
          <div><label>Tồn kho ban đầu</label><input name="stock" type="number" min="0" step="1" value="${esc(f.stock ?? '0')}"></div>
        </div>
        <p class="muted" style="margin:-6px 0 12px">Để tồn 0 thì khách vào thấy “Hết hàng” — sửa lại bất cứ lúc nào ở trang sản phẩm.
          Nếu bạn khai size/màu bên dưới, số này áp cho <strong>mỗi phiên bản</strong> (vd 10 với 3 size × 2 màu = mỗi tổ hợp 10 cái).</p>
        <label>Trạng thái</label><select name="status"><option value="draft"${f.status !== 'active' ? ' selected' : ''}>Nháp</option><option value="active"${f.status === 'active' ? ' selected' : ''}>Đăng bán ngay</option></select>
        <label>Mô tả</label><textarea name="description" maxlength="5000">${esc(f.description ?? '')}</textarea>
        <label>Ảnh sản phẩm</label>
        <input type="file" name="image" accept="image/jpeg,image/png,image/webp,image/gif" multiple>
        <p class="muted" style="margin:5px 0 0">Chọn được nhiều ảnh. Ảnh đầu tiên là ảnh bìa. JPEG/PNG/WebP/GIF,
          mỗi ảnh tối đa 10MB — hệ thống tự nén sang WebP.</p>
      </div>
      <!-- Biến thể ngay tại form TẠO. Trước đợt kiểm toán phải tạo SP xong rồi mới vào trang
           chi tiết mới đặt được size/màu — shop thời trang, giày dép, mỹ phẩm gặp cái này ở
           ĐÚNG sản phẩm đầu tiên họ đăng (docs/50 đã ghi nợ). Ô trống = SP không có biến thể,
           hành vi y như cũ. Cùng tên trường (opt_name/opt_values) với trang chi tiết. -->
      <details class="card"${f.opt_name0 || f.opt_name1 ? ' open' : ''}><summary style="cursor:pointer;font-weight:600">Sản phẩm có nhiều phiên bản? (size, màu…)</summary>
        <p class="muted" style="margin:6px 0 10px">Bỏ trống nếu chỉ bán một phiên bản. Điền vào đây thì hệ thống
          <strong>tự sinh đủ tổ hợp</strong> — ví dụ Size <em>S, M, L</em> × Màu <em>Đen, Trắng</em> ra 6 phiên bản.
          Giá và tồn của từng phiên bản chỉnh ở trang sản phẩm sau khi tạo.</p>
        <div class="grid2">
          <div><label>Tên phân loại 1</label><input name="opt_name0" maxlength="40" value="${esc(f.opt_name0 ?? '')}" placeholder="Size"></div>
          <div><label>Các giá trị (phân cách dấu phẩy)</label><input name="opt_values0" maxlength="600" value="${esc(f.opt_values0 ?? '')}" placeholder="S, M, L, XL"></div>
        </div>
        <div class="grid2">
          <div><label>Tên phân loại 2</label><input name="opt_name1" maxlength="40" value="${esc(f.opt_name1 ?? '')}" placeholder="Màu"></div>
          <div><label>Các giá trị (phân cách dấu phẩy)</label><input name="opt_values1" maxlength="600" value="${esc(f.opt_values1 ?? '')}" placeholder="Đen, Trắng, Be"></div>
        </div>
        <p class="muted" style="font-size:.82rem;margin:6px 0 0">Tối đa 100 tổ hợp. Cần trục thứ ba? Thêm ở trang sản phẩm sau khi tạo.</p>
      </details>
      <details class="card"${f.slug || f.sku ? ' open' : ''}><summary style="cursor:pointer;font-weight:600">Tuỳ chọn nâng cao</summary>
        <p class="muted">Bỏ trống cũng được — hệ thống tự điền.</p>
        <label>Đường dẫn (slug)</label><input name="slug" pattern="[a-z0-9][a-z0-9-]*" maxlength="60" value="${esc(f.slug ?? '')}" placeholder="tự tạo từ tên sản phẩm">
        <label>Mã SKU</label><input name="sku" maxlength="64" value="${esc(f.sku ?? '')}" placeholder="tự tạo từ đường dẫn">
      </details>
      <button class="btn" type="submit">Tạo sản phẩm</button>
    </form>`);
}

export function renderProductDetail(ctx, shopId, p, levels, err, form, media, cats, notice) {
  const base = `/shops/${esc(shopId)}/products/${esc(p.id)}`;
  const catIds = new Set(p.category_ids ?? []);
  const catList = cats ?? [];
  // Sắp danh mục theo cây 2 cấp (0095): cha rồi con (thụt lề) để gán đúng danh mục con.
  const catById = new Map(catList.map((c) => [c.id, c]));
  const catTree = [];
  for (const r of catList.filter((c) => !c.parent_id || !catById.has(c.parent_id))) {
    catTree.push({ c: r, child: false });
    for (const k of catList.filter((c) => c.parent_id === r.id && catById.has(c.parent_id))) catTree.push({ c: k, child: true });
  }
  const f = form ?? {}; // khi lưu lỗi: ưu tiên giá trị vừa nhập để không nuốt sửa đổi
  const val = (k) => esc(f[k] ?? p[k] ?? '');
  const imgs = media ?? [];
  const variantOpts = (p.variants ?? []).map((v) => ({ id: v.id, label: v.title || v.sku }));
  // Gán ảnh cho biến thể (chỉ khi có >1 biến thể) → khách chọn biến thể sẽ thấy đúng ảnh.
  // GÁN ẢNH cho biến thể: BỎ nút "Gán" riêng từng ảnh (người bán báo "gán từng cái rất
  // mệt"). Ô select nay thuộc form "pall" chung. media_cur_<id> mang giá trị ĐANG lưu để
  // handler chỉ ghi những ô THỰC SỰ đổi — một lần bấm Lưu không bắn N lượt ghi thừa.
  const assignForm = (m) => variantOpts.length > 1 ? `<div class="thumb-assign">
      <input form="pall" type="hidden" name="media_cur_${esc(m.id)}" value="${esc(m.variant_id ?? '')}">
      <select form="pall" name="media_${esc(m.id)}" aria-label="Gán ảnh cho biến thể"><option value="">Ảnh chung</option>${variantOpts.map((v) => `<option value="${esc(v.id)}"${m.variant_id === v.id ? ' selected' : ''}>${esc(v.label)}</option>`).join('')}</select>
    </div>` : '';
  const thumb = (m, i) => `<figure class="thumb">
    ${m.status === 'ready' && m.url ? `<img src="${esc(m.url)}" alt="Ảnh sản phẩm" loading="lazy" width="120" height="120">` : `<div class="ph">${esc(m.status === 'failed' ? 'lỗi xử lý' : 'đang xử lý…')}</div>`}
    ${i === 0 && m.status === 'ready' ? '<div class="prim">★ Ảnh chính</div>' : ''}
    <div class="thumb-act">
      ${i > 0 ? `<form method="POST" action="${base}/media/${esc(m.id)}/moveup"><button class="btn alt sm" type="submit" title="Sang trái">←</button></form>` : ''}
      ${i < imgs.length - 1 ? `<form method="POST" action="${base}/media/${esc(m.id)}/movedown"><button class="btn alt sm" type="submit" title="Sang phải">→</button></form>` : ''}
      ${i > 0 ? `<form method="POST" action="${base}/media/${esc(m.id)}/primary"><button class="btn alt sm" type="submit" title="Đặt làm ảnh chính">★</button></form>` : ''}
      <form method="POST" action="${base}/media/${esc(m.id)}/delete"><button class="btn warn sm" type="submit" title="Xoá">✕</button></form>
    </div>
    ${assignForm(m)}
  </figure>`;
  // Bộ thiết lập TRỤC biến thể (đa trục): 3 ô, mỗi ô = 1 trục + giá trị phân cách bằng dấu phẩy.
  const optList = p.options ?? [];
  const optSlots = Array.from({ length: 3 }, (_, i) => {
    const o = optList[i];
    const ph = ['Màu', 'Size', 'Chất liệu'][i];
    const phv = ['Đỏ, Xanh, Vàng', 'M, L, XL', 'Cotton, Lụa'][i];
    return `<div class="grid2" style="margin-bottom:10px">
      <div><label>Tên trục ${i + 1}</label><input name="opt_name" maxlength="40" value="${o ? esc(o.name) : ''}" placeholder="${ph}"></div>
      <div><label>Giá trị (phân cách dấu phẩy)</label><input name="opt_values" maxlength="600" value="${o ? esc(o.values.map((v) => v.value).join(', ')) : ''}" placeholder="${phv}"></div>
    </div>`;
  }).join('');
  const specsText = (p.specs ?? []).map((s) => `${s.name}: ${s.value}`).join('\n');
  const statusBtn = p.status === 'active'
    ? `<form method="POST" action="${base}/archive"><button class="btn alt sm" type="submit">Ẩn (lưu trữ)</button></form>`
    : `<form method="POST" action="${base}/publish"><button class="btn sm" type="submit">${p.status === 'draft' ? 'Đăng bán' : 'Đăng bán lại'}</button></form>`;
  const canDel = (p.variants?.length ?? 0) > 1;
  // Link sang SỔ CÁI KHO đã lọc sẵn biến thể này — nếu không có, bộ lọc variant_id của sổ cái
  // là tính năng chết (không đường nào bấm tới). Chỉ hiện với vai xem được khu Kho.
  const canSeeLedger = INVENTORY_ROLES.has(ctx.role);
  const stock = (vid) => {
    const l = levels[vid];
    const hist = canSeeLedger
      ? ` <a class="muted" style="font-size:.78rem" href="/shops/${esc(shopId)}/inventory-ledger?variant_id=${esc(vid)}" title="Xem lịch sử nhập/xuất/điều chỉnh của biến thể này">lịch sử</a>` : '';
    if (!l) return `<span class="muted" title="Chưa tải được tồn kho">—</span>${hist}`; // "chưa biết" ≠ "hết hàng"
    const cls = l.available <= 0 ? 'zero' : (l.available < 5 ? 'low' : '');
    return `<span class="stock ${cls} num">${l.available}</span> <span class="muted num" style="font-size:.82rem">(tồn ${l.on_hand} · giữ ${l.reserved})</span>${hist}`;
  };
  // Biên lãi gợi ý server-render cạnh ô giá vốn (0081): đủ giá + vốn → "biên ~X%";
  // vốn ≥ giá bán → cảnh báo MỀM đỏ (bán lỗ chủ đích hợp lệ — seller không chặn).
  const marginHint = (v) => {
    if (v.cost_vnd == null) return '';
    const price = Number(v.price_vnd), cost = Number(v.cost_vnd);
    if (cost >= price) return '<div style="color:#b91c1c;font-size:.78rem">⚠ vốn ≥ giá bán</div>';
    return price > 0 ? `<div class="muted" style="font-size:.78rem">biên ~${Math.round(((price - cost) / price) * 100)}%</div>` : '';
  };
  const nVar = (p.variants ?? []).length;
  // Bảng biến thể (sửa hàng loạt): giá/giá gạch/giá vốn/cân của MỌI dòng nằm chung MỘT form
  // (form="pall", key price_/compare_/cost_/weight_<id>) — chung nút "Lưu tất cả" của cả trang.
  // Cột "Điều chỉnh tồn" (+/−) cũng thuộc form "pall" (key delta_<id>) — handler bỏ qua dòng
  // "Cập nhật tồn": chỉ áp cho dòng ĐÃ điền, mỗi dòng gọi đúng 1 lần /inventory/adjust như cũ.
  // No-JS: input dùng thuộc tính form= để thuộc form ngoài bảng (tránh <form> lồng nhau).
  // Cột "Xoá" VẪN là form riêng từng dòng (tác dụng ngay).
  const rows = (p.variants ?? []).map((v) => `<tr>
    <td>${esc(v.sku)}${v.title ? ` <span class="muted">${esc(v.title)}</span>` : ''}</td>
    <td class="num right"><input form="pall" name="price_${esc(v.id)}" type="number" min="0" step="1000" value="${esc(v.price_vnd)}" style="width:104px" aria-label="Giá biến thể ${esc(v.sku)} (VND)"></td>
    <td class="num right"><input form="pall" name="compare_${esc(v.id)}" type="number" min="0" step="1000" value="${esc(v.compare_at_vnd ?? '')}" placeholder="không KM" style="width:104px" aria-label="Giá gạch ${esc(v.sku)} (VND)"></td>
    <td class="num right"><input form="pall" name="cost_${esc(v.id)}" type="number" min="0" step="1000" value="${esc(v.cost_vnd ?? '')}" placeholder="chưa nhập" style="width:104px" aria-label="Giá vốn ${esc(v.sku)} (VND)">${marginHint(v)}</td>
    <td><input form="pall" name="weight_${esc(v.id)}" type="number" min="1" max="50000" value="${esc(v.weight_gram ?? '')}" placeholder="mặc định" style="width:86px" aria-label="Khối lượng ${esc(v.sku)} (gram)"></td>
    <td>${stock(v.id)}</td>
    <td><input form="pall" name="delta_${esc(v.id)}" type="number" step="1" placeholder="+/−" style="width:96px" aria-label="Điều chỉnh tồn ${esc(v.sku)}"></td>
    <td class="right">${canDel ? `<form method="POST" action="${base}/variants/${esc(v.id)}/delete"><button class="btn warn sm" type="submit">Xoá</button></form>` : ''}</td>
  </tr>`).join('');
  return layout(`SP: ${p.title}`, ctx, `
    <a class="muted" href="/shops/${esc(shopId)}/products">← Danh sách sản phẩm</a>
    <div class="toolbar"><h1 style="margin:0">${esc(p.title)}</h1>${badge(p.status, PSTATUS[p.status] ?? p.status)}</div>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice ? `<div class="notice success">${esc(notice)}</div>` : ''}
    <!-- MỘT FORM cho cả trang (id="pall"): thông tin + giá biến thể + gán ảnh + điều chỉnh
         tồn dùng chung một nút Lưu. Các ô nằm rải rác trong nhiều thẻ <div class="card">
         nên KHÔNG bọc được bằng cây DOM — dùng thuộc tính form="pall" của HTML, đúng cách
         đã dùng cho bulkvars/bulkstock trước đây. Giữ nguyên 0-JS. -->
    <form id="pall" method="POST" action="${base}/save-all"></form>
    <div class="card"><div class="toolbar"><h2 style="margin:0">Thông tin</h2>
      <div class="actions"><button class="btn" form="pall" type="submit">Lưu tất cả</button>${statusBtn}</div></div>
      <p class="muted" style="font-size:.85rem;margin-top:0">Một nút <strong>Lưu tất cả</strong> ghi hết: thông tin, giá/giá vốn/cân của mọi biến thể, ảnh gán cho biến thể, và điều chỉnh tồn đã điền. Tải ảnh lên vẫn là bước riêng.</p>
      <div>
        <label>Tên sản phẩm</label><input form="pall" name="title" required maxlength="200" value="${val('title')}">
        <div class="grid2">
          <div><label>Đường dẫn (slug)</label><input form="pall" name="slug" required pattern="[a-z0-9][a-z0-9-]*" maxlength="60" value="${val('slug')}"></div>
          <div><label>Giá (VND)</label><input form="pall" name="price_vnd" type="number" min="0" step="1000" required value="${val('price_vnd')}"></div>
        </div>
        <label>Mô tả</label><textarea form="pall" name="description" maxlength="5000">${val('description')}</textarea>
        <details style="margin-top:14px"${(f.seo_title || f.seo_description) ? ' open' : ''}>
          <summary style="cursor:pointer;font-weight:600">Tối ưu Google (SEO) — không bắt buộc</summary>
          <p class="muted" style="font-size:.83rem;margin:8px 0">Đây là dòng tiêu đề và đoạn mô tả hiện trên kết quả tìm kiếm Google và khi chia sẻ lên Facebook/Zalo.
            Bỏ trống thì hệ thống tự lấy tên và mô tả sản phẩm.</p>
          <label>Tiêu đề SEO <span class="muted" style="font-weight:400">(nên ≤ 60 ký tự để Google không cắt)</span></label>
          <input form="pall" name="seo_title" maxlength="200" placeholder="${esc(f.title ?? 'Tên sản phẩm')}" value="${val('seo_title')}">
          <label>Mô tả SEO <span class="muted" style="font-weight:400">(nên 120–160 ký tự)</span></label>
          <textarea form="pall" name="seo_description" maxlength="500" rows="3" placeholder="Câu mô tả ngắn gọn, có từ khoá khách hay tìm.">${val('seo_description')}</textarea>
        </details>
      </div>
    </div>
    <div class="card"><h2 style="margin-top:0">Phân loại (biến thể đa trục)</h2>
      <p class="muted">Khai báo các <strong>trục</strong> như Màu, Size… mỗi trục nhiều giá trị (phân cách bằng dấu phẩy). Lưu xong hệ thống <strong>tự sinh biến thể cho mọi tổ hợp</strong> (vd Màu×Size), rồi bạn đặt giá/tồn cho từng biến thể ở bảng bên dưới. Để trống tất cả = sản phẩm không phân loại.</p>
      <form method="POST" action="${base}/options">
        ${optSlots}
        <button class="btn sm" type="submit">Lưu phân loại & sinh biến thể</button>
      </form>
    </div>
    <div class="card"><div class="toolbar"><h2 style="margin:0">Biến thể & tồn kho</h2></div>
      <p class="muted" style="font-size:.85rem;margin-top:0">Sửa <strong>giá, giá gạch, giá vốn, khối lượng</strong> cho nhiều biến thể cùng lúc — tất cả lưu chung một nút <strong>“Lưu tất cả”</strong>. Điền cột <strong>Điều chỉnh tồn</strong> (+/−) cho những dòng cần rồi bấm <strong>“Cập nhật tồn”</strong> — mỗi nút lưu một lần cho mọi dòng đã sửa. Cột <strong>Xoá</strong> vẫn tác dụng ngay từng dòng.</p>
      <div class="tblscroll"><table class="vartbl"><thead><tr><th>SKU / Phân loại</th><th class="right">Giá</th><th class="right">Giá gạch (đ)</th><th class="right">Giá vốn (đ)</th><th>Nặng (g)</th><th>Có thể bán</th><th>Điều chỉnh tồn</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      ${nVar ? `<div class="savebar"><span class="muted" style="font-size:.82rem">${nVar} biến thể</span><input form="pall" name="stock_reason" maxlength="200" placeholder="lý do điều chỉnh tồn (tuỳ chọn)" style="width:230px"><button class="btn" form="pall" type="submit">Lưu tất cả</button></div>` : ''}
      <p class="muted" style="font-size:.82rem">Giá vốn KHÔNG hiện với khách; nhân viên sản phẩm nhập được, chỉ owner/admin xem báo cáo lãi. Đơn đã đặt giữ giá vốn tại thời điểm đặt.</p>
      <h2>Thêm biến thể lẻ</h2>
      <p class="muted" style="font-size:.85rem">Dùng khi KHÔNG dùng phân loại đa trục ở trên (thêm tay từng biến thể).</p>
      <form method="POST" action="${base}/variants" class="inline">
        <div><label>SKU</label><input name="sku" required maxlength="64" style="width:160px"></div>
        <div><label>Giá (VND)</label><input name="price_vnd" type="number" min="0" step="1000" required style="width:140px"></div>
        <button class="btn alt sm" type="submit">Thêm biến thể</button>
      </form>
    </div>
    <div class="card"><h2 style="margin-top:0">Thông số kỹ thuật</h2>
      <form method="POST" action="${base}/specs">
        <label>Mỗi dòng một thông số, dạng <code>Tên: Giá trị</code></label>
        <textarea name="specs" rows="5" placeholder="Chất liệu: Polyester&#10;Kích thước: 1m6 x 2m3&#10;Xuất xứ: Việt Nam">${esc(specsText)}</textarea>
        <button class="btn sm" type="submit" style="margin-top:10px">Lưu thông số</button>
      </form>
    </div>
    <div class="card"><h2 style="margin-top:0">Danh mục</h2>
      ${catList.length
        ? `<form method="POST" action="${base}/categories">
            <div style="display:flex;flex-direction:column;gap:8px">${catTree.map(({ c, child }) => `<label style="display:inline-flex;align-items:center;gap:7px;font-size:.92rem${child ? ';padding-left:20px' : ';font-weight:600'}"><input type="checkbox" name="category_ids" value="${esc(c.id)}"${catIds.has(c.id) ? ' checked' : ''}> ${child ? '<span class="muted" aria-hidden="true">↳</span> ' : ''}${esc(c.name)}</label>`).join('')}</div>
            <button class="btn alt sm" type="submit" style="margin-top:12px">Lưu danh mục</button>
          </form>`
        : `<p class="muted">Chưa có danh mục. Tạo ở trang <a href="/shops/${esc(shopId)}/categories">Danh mục</a> rồi quay lại gán.</p>`}
    </div>
    <div class="card"><h2 style="margin-top:0">Hình ảnh</h2>
      ${imgs.length ? `<div class="media-grid">${imgs.map((m, i) => thumb(m, i)).join('')}</div>` : '<p class="muted">Chưa có ảnh nào.</p>'}
      <form method="POST" enctype="multipart/form-data" action="${base}/media" class="inline">
        <input type="file" name="image" accept="image/jpeg,image/png,image/webp,image/gif" multiple required aria-label="Chọn ảnh">
        <button class="btn alt sm" type="submit">Tải ảnh lên</button>
      </form>
      <p class="muted" style="font-size:.82rem">Chọn <strong>nhiều ảnh cùng lúc</strong>. JPEG / PNG / WebP / GIF, mỗi ảnh tối đa 10MB. Ảnh gốc được nén lại thành WebP tự động. ${variantOpts.length > 1 ? 'Dùng ô "Gán" dưới mỗi ảnh để gắn ảnh cho từng biến thể (khách chọn biến thể sẽ thấy đúng ảnh).' : ''}</p>
    </div>
    <div class="card"><h2 style="margin-top:0">Xoá sản phẩm</h2>
      <p class="muted">Ẩn sản phẩm khỏi cửa hàng (xoá mềm). Đơn hàng cũ không bị ảnh hưởng.</p>
      <form method="POST" action="${base}/delete"><button class="btn warn sm" type="submit">Xoá sản phẩm</button></form>
    </div>`);
}

// ── Trang nội dung (versioned: draft → publish snapshot) ─────────────────────
export function renderContentPages(ctx, shopId, data) {
  const pages = data?.pages ?? [];
  // Dòng phụ dưới tên trang phải là ĐƯỜNG DẪN CÔNG KHAI THẬT `/pages/<slug>`. Đây là chỉ dẫn
  // DUY NHẤT trên màn này về chỗ trang đang nằm, và người bán sẽ dán nó vào bài Facebook/Zalo.
  // In "/<slug>" trần là đưa họ một link 404 — đúng lỗi mà sitemap từng mắc (storefront chỉ
  // phục vụ trang nội dung ở /pages/:slug). Bộ chọn liên kết của trang Giao diện, CÙNG FILE
  // này, vốn đã dựng đúng '/pages/' + slug.
  const rows = pages.map((p) => [
    { html: `<a href="/shops/${esc(shopId)}/pages/${esc(p.id)}">${esc(p.title)}</a><div class="muted" style="font-size:.8rem">/pages/${esc(p.slug)}</div>` },
    { html: badge(p.status, PGSTATUS[p.status] ?? p.status) },
    { cls: 'num right', html: p.menu_position ?? '—' },
    { cls: 'muted', html: dt(p.updated_at) },
  ]);
  return layout('Trang nội dung', ctx, `
    <div class="toolbar"><h1 style="margin:0">Trang nội dung</h1>
      <a class="btn" href="/shops/${esc(shopId)}/pages/new">+ Thêm trang</a></div>
    <div class="card">${pages.length ? tblCards({
      head: [{ html: 'Trang' }, { html: 'Trạng thái' }, { html: 'Vị trí menu', cls: 'right' }, { html: 'Cập nhật' }],
      rows,
    })
      : '<p class="muted">Chưa có trang nào. Tạo “Giới thiệu”, “Chính sách đổi trả”… bằng nút “+ Thêm trang”.</p>'}</div>`);
}

export function renderPageNew(ctx, shopId, err, f = {}) {
  return layout('Thêm trang', ctx, `
    <a class="muted" href="/shops/${esc(shopId)}/pages">← Danh sách trang</a>
    <h1>Thêm trang nội dung</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="/shops/${esc(shopId)}/pages">
      <div class="card">
        <label>Tiêu đề *</label><input name="title" required maxlength="200" value="${esc(f.title ?? '')}" placeholder="Giới thiệu">
        <label>Đường dẫn (slug) *</label><input name="slug" required pattern="[a-z0-9][a-z0-9-]*" maxlength="60" value="${esc(f.slug ?? '')}" placeholder="gioi-thieu">
        <label>SEO title</label><input name="seo_title" maxlength="120" value="${esc(f.seo_title ?? '')}">
        <label>SEO description</label><textarea name="seo_description" maxlength="320">${esc(f.seo_description ?? '')}</textarea>
      </div>
      <button class="btn" type="submit">Tạo trang (nháp)</button>
      <p class="muted" style="font-size:.85rem">Tạo xong sẽ vào trình sửa: thêm section (tiêu đề, đoạn văn, danh sách…) rồi bấm Đăng.</p>
    </form>`);
}

export function renderPageEditor(ctx, shopId, p, err, notice, form, media = []) {
  const base = `/shops/${esc(shopId)}/pages/${esc(p.id)}`;
  const blocks = p.blocks ?? [];
  const revs = p.revisions ?? [];
  const f = form ?? {}; // khi lưu meta lỗi: ưu tiên giá trị vừa nhập, không revert về DB
  const mval = (k) => esc(f[k] ?? p[k] ?? '');
  const blockEdit = (b) => {
    if (b.type === 'divider') return '<p class="muted" style="margin:4px 0">— đường kẻ ngang —</p>';
    const hid = `<input type="hidden" name="type" value="${esc(b.type)}">`;
    // Ảnh: CHỌN từ ảnh sẵn có hoặc TẢI LÊN ảnh mới, không còn ô dán "key ảnh".
    // multipart vì có ô tệp; tệp (nếu chọn) GHI ĐÈ ảnh đang tick.
    if (b.type === 'image') return `<form method="POST" action="${base}/blocks/${esc(b.id)}/edit" enctype="multipart/form-data">${hid}
      ${mediaPicker('key', b.key ?? '', media, { noneLabel: '' })}
      <label style="font-size:.82rem">… hoặc tải ảnh mới lên (ghi đè lựa chọn trên)</label>
      <input type="file" name="file" accept="image/*">
      <input name="alt" required maxlength="300" value="${esc(b.alt ?? '')}" placeholder="Mô tả ảnh (alt — bắt buộc)">
      <input name="caption" maxlength="500" value="${esc(b.caption ?? '')}" placeholder="Chú thích dưới ảnh (tuỳ chọn)">
      <button class="btn alt sm" type="submit">Lưu section</button></form>`;
    if (b.type === 'list') return `<form method="POST" action="${base}/blocks/${esc(b.id)}/edit">${hid}
      <textarea name="text" rows="4" maxlength="5000" placeholder="mỗi dòng 1 mục">${esc((b.items ?? []).join('\n'))}</textarea>
      <button class="btn alt sm" type="submit">Lưu section</button></form>`;
    if (b.type === 'quote') return `<form method="POST" action="${base}/blocks/${esc(b.id)}/edit">${hid}
      <textarea name="text" rows="2" maxlength="5000">${esc(b.text ?? '')}</textarea>
      <input name="cite" placeholder="Nguồn trích (tuỳ chọn)" maxlength="200" value="${esc(b.cite ?? '')}">
      <button class="btn alt sm" type="submit">Lưu section</button></form>`;
    return `<form method="POST" action="${base}/blocks/${esc(b.id)}/edit">${hid}
      <textarea name="text" rows="${b.type === 'heading' ? 1 : 3}" maxlength="5000">${esc(b.text ?? '')}</textarea>
      <button class="btn alt sm" type="submit">Lưu section</button></form>`;
  };
  const blockCard = (b, i) => `<div class="block">
    <div class="toolbar" style="margin-bottom:6px"><span class="badge">${esc(BTYPE[b.type] ?? b.type)}</span>
      <div class="actions">
        ${i > 0 ? `<form method="POST" action="${base}/blocks/${esc(b.id)}/moveup"><button class="btn alt sm" type="submit" title="Lên">↑</button></form>` : ''}
        ${i < blocks.length - 1 ? `<form method="POST" action="${base}/blocks/${esc(b.id)}/movedown"><button class="btn alt sm" type="submit" title="Xuống">↓</button></form>` : ''}
        <form method="POST" action="${base}/blocks/${esc(b.id)}/delete"><button class="btn warn sm" type="submit">Xoá</button></form>
      </div></div>
    ${blockEdit(b)}</div>`;
  return layout(`Sửa: ${p.title}`, ctx, `
    <a class="muted" href="/shops/${esc(shopId)}/pages">← Danh sách trang</a>
    <div class="toolbar"><h1 style="margin:0">${esc(p.title)}</h1>${badge(p.status, PGSTATUS[p.status] ?? p.status)}</div>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice?.preview ? `<div class="card" style="background:#ecfdf5;border-color:#a7f3d0"><strong>Link xem trước</strong> (sống ~${Math.round((notice.preview.expires_in ?? 1800) / 60)} phút):<br>
      <code style="word-break:break-all">${esc(notice.preview.preview_url ?? notice.preview.path)}</code></div>` : ''}
    <div class="card"><div class="toolbar"><h2 style="margin:0">Thông tin & xuất bản</h2>
      <div class="actions">
        <form method="POST" action="${base}/preview"><button class="btn alt sm" type="submit">Xem trước</button></form>
        <form method="POST" action="${base}/publish"><button class="btn sm" type="submit">${p.status === 'published' ? 'Đăng lại' : 'Đăng trang'}</button></form>
      </div></div>
      ${p.published_revision ? `<p class="muted">Đang đăng: bản #${p.published_revision}. Sửa bên dưới chỉ đổi bản NHÁP tới khi bấm Đăng.</p>` : '<p class="muted">Chưa đăng bao giờ — storefront chưa thấy trang này.</p>'}
      <form method="POST" action="${base}">
        <label>Tiêu đề</label><input name="title" required maxlength="200" value="${mval('title')}">
        <div class="grid2">
          <div><label>Đường dẫn (slug)</label><input value="/${esc(p.slug)}" disabled></div>
          <div><label>Vị trí menu (trống = ẩn khỏi menu)</label><input name="menu_position" type="number" value="${mval('menu_position')}"></div>
        </div>
        <label>SEO title</label><input name="seo_title" maxlength="120" value="${mval('seo_title')}">
        <label>SEO description</label><textarea name="seo_description" maxlength="320">${mval('seo_description')}</textarea>
        <button class="btn" type="submit" style="margin-top:10px">Lưu thông tin (nháp)</button>
      </form>
    </div>
    <div class="card"><h2 style="margin-top:0">Nội dung (section)</h2>
      <p class="muted" style="font-size:.85rem">Sửa/thêm/xoá là lưu vào bản NHÁP. Dùng ↑ ↓ để đổi thứ tự. Bấm “Đăng trang” để đưa lên storefront.</p>
      ${blocks.length ? blocks.map(blockCard).join('') : '<p class="muted">Chưa có section nào — thêm bên dưới.</p>'}
      <h2>Thêm section chữ</h2>
      <form method="POST" action="${base}/blocks">
        <div class="grid2"><div><label>Loại</label><select name="type">${Object.entries(BTYPE).filter(([k]) => k !== 'image').map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div></div>
        <label>Nội dung</label><textarea name="text" maxlength="5000" placeholder="Tiêu đề / đoạn / trích: gõ nội dung • Danh sách: mỗi dòng 1 mục • Đường kẻ: để trống"></textarea>
        <label>Nguồn trích (chỉ dùng cho Trích dẫn)</label><input name="cite" maxlength="200">
        <button class="btn alt" type="submit">Thêm section chữ</button>
      </form>
      <h2 style="margin-top:22px">Thêm ảnh</h2>
      <p class="muted" style="font-size:.85rem;margin-top:0">Chọn một ảnh đã có, hoặc chọn tệp để tải ảnh mới lên. <strong>Mô tả ảnh</strong> là câu ngắn nói ảnh chụp gì — người khiếm thị và Google đọc câu này.</p>
      <form method="POST" action="${base}/blocks" enctype="multipart/form-data">
        <input type="hidden" name="type" value="image">
        ${media.length ? mediaPicker('key', '', media, { noneLabel: '' }) : '<p class="muted" style="font-size:.83rem">Chưa có ảnh nào sẵn — chọn tệp bên dưới để tải lên.</p>'}
        <label>… hoặc tải ảnh mới lên (ghi đè lựa chọn trên)</label>
        <input type="file" name="file" accept="image/*">
        <label>Mô tả ảnh (alt — bắt buộc)</label><input name="alt" required maxlength="300" placeholder="VD: Ghế sofa xám trong phòng khách">
        <label>Chú thích dưới ảnh (tuỳ chọn)</label><input name="caption" maxlength="500">
        <button class="btn alt" type="submit" style="margin-top:8px">Thêm ảnh</button>
      </form>
    </div>
    ${revs.length ? `<div class="card"><h2 style="margin-top:0">Lịch sử bản đăng</h2><table><tbody>
      ${revs.map((rv) => `<tr><td>Bản #${rv.revision}${rv.revision === p.published_revision ? ' <span class="badge published">đang đăng</span>' : ''} <span class="muted">${esc(rv.title)}</span></td>
        <td class="muted">${dt(rv.created_at)}</td>
        <td class="right">${rv.revision === p.published_revision ? '' : `<form method="POST" action="${base}/rollback"><input type="hidden" name="revision" value="${esc(rv.revision)}"><button class="btn alt sm" type="submit">Khôi phục</button></form>`}</td></tr>`).join('')}
    </tbody></table></div>` : ''}
    <div class="card"><h2 style="margin-top:0">Xoá trang</h2>
      <p class="muted">Xoá mềm; link xem trước cũng bị vô hiệu ngay.</p>
      <form method="POST" action="${base}/delete"><button class="btn warn sm" type="submit">Xoá trang này</button></form></div>`);
}

// ── Tài khoản (bảo mật) ──────────────────────────────────────────────────────
// Nhãn tiếng Việt cho sự kiện đăng nhập/bảo mật (GET /auth/events). Mã lạ hiện nguyên văn.
const AUTH_EVENT_LABEL = {
  'user.register': 'Tạo tài khoản',
  'user.login': 'Đăng nhập thành công',
  'user.login_failed': 'Đăng nhập thất bại',
  'user.login_rate_limited': 'Chặn đăng nhập (thử quá nhiều)',
  'user.login_password_ok_mfa_pending': 'Đăng nhập — chờ mã 2 lớp',
  'user.mfa_verified': 'Xác thực 2 lớp thành công',
  'user.mfa_failed': 'Nhập sai mã 2 lớp',
  'user.mfa_replay_blocked': 'Chặn mã 2 lớp dùng lại',
  'user.mfa_enabled': 'Bật xác thực 2 lớp',
  'user.mfa_disabled': 'Tắt xác thực 2 lớp',
  'user.mfa_disable_failed': 'Tắt 2 lớp thất bại',
  'user.password_changed': 'Đổi mật khẩu',
  'user.password_change_failed': 'Đổi mật khẩu thất bại',
  'user.password_reset_requested': 'Yêu cầu đặt lại mật khẩu',
  'user.password_reset': 'Đặt lại mật khẩu qua email',
  'user.step_up': 'Xác nhận lại mật khẩu (step-up)',
  'user.step_up_failed': 'Xác nhận mật khẩu thất bại',
  'user.session_revoked': 'Thu hồi phiên đăng nhập',
  'user.sessions_revoked_others': 'Đăng xuất mọi thiết bị khác',
  'user.logout': 'Đăng xuất',
  'user.invitation_accepted': 'Chấp nhận lời mời vào cửa hàng',
};

export function renderAccount(info) {
  const { email, mfa_enabled, enroll, recovery_codes, notice, err } = info;
  const sessions = info.sessions ?? [];
  const events = info.events ?? [];
  let mfaCard;
  if (recovery_codes) {
    mfaCard = `<div class="card"><h2 style="margin-top:0">✅ Đã bật xác thực 2 lớp</h2>
      <div class="err" style="background:#fffbeb;border-color:#fcd34d;color:#92400e">Lưu KỸ các mã khôi phục sau — chỉ hiện MỘT lần, dùng khi mất thiết bị:</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">${recovery_codes.map((c) => `<code>${esc(c)}</code>`).join('')}</div></div>`;
  } else if (enroll) {
    mfaCard = `<div class="card"><h2 style="margin-top:0">Bật MFA — bước 2/2</h2>
      <p>Thêm khoá này vào ứng dụng xác thực (Google Authenticator, Authy…):</p>
      <p>Khoá bí mật: <code>${esc(enroll.secret)}</code></p>
      <p class="muted" style="font-size:.82rem;word-break:break-all">otpauth: <code>${esc(enroll.otpauth_url)}</code></p>
      <form method="POST" action="/account/mfa/activate">
        <input type="hidden" name="secret" value="${esc(enroll.secret)}"><input type="hidden" name="otpauth" value="${esc(enroll.otpauth_url)}">
        <label>Nhập mã 6 số từ ứng dụng</label><input name="code" inputmode="numeric" autocomplete="one-time-code" required placeholder="123456" style="max-width:180px">
        <button class="btn" type="submit" style="margin-top:10px">Kích hoạt MFA</button></form></div>`;
  } else if (mfa_enabled) {
    mfaCard = `<div class="card"><h2 style="margin-top:0">Xác thực 2 lớp (MFA)</h2>
      <p>${badge('active', 'Đang bật')} — tài khoản đã được bảo vệ bằng MFA.</p>
      <form method="POST" action="/account/mfa/disable" style="margin-top:8px">
        <label>Tắt MFA — nhập mã 6 số (hoặc mã khôi phục) để xác nhận</label>
        <input name="code" inputmode="numeric" autocomplete="one-time-code" required placeholder="123456" style="max-width:220px">
        <button class="btn warn" type="submit" style="margin-top:8px">Tắt MFA</button>
      </form></div>`;
  } else {
    mfaCard = `<div class="card"><h2 style="margin-top:0">Xác thực 2 lớp (MFA)</h2>
      <p class="muted">Bảo vệ tài khoản bằng mã 6 số đổi liên tục. Nên bật — nhất là với chủ shop.</p>
      <form method="POST" action="/account/mfa/enroll"><button class="btn" type="submit">Bật MFA</button></form></div>`;
  }
  return layout('Tài khoản', { user: { email } }, `<h1>Tài khoản</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice ? `<div class="card" style="background:#ecfdf5;border-color:#a7f3d0;color:#065f46">${esc(notice)}</div>` : ''}
    <div class="card"><h2 style="margin-top:0">Thông tin</h2><p>Email: <strong>${esc(email)}</strong></p></div>
    ${mfaCard}
    <div class="card"><h2 style="margin-top:0">Đổi mật khẩu</h2>
      <form method="POST" action="/account/password/change">
        <label>Mật khẩu hiện tại</label><input name="current_password" type="password" required autocomplete="current-password">
        <label>Mật khẩu mới (tối thiểu 10 ký tự)</label><input name="new_password" type="password" required minlength="10" autocomplete="new-password">
        <button class="btn" type="submit" style="margin-top:10px">Đổi mật khẩu</button>
      </form>
      <div style="margin-top:12px;border-top:1px solid #eee;padding-top:10px">
        <p class="muted" style="font-size:.82rem;margin:0 0 6px">Quên mật khẩu hiện tại? Gửi link đặt lại qua email:</p>
        <form method="POST" action="/account/password/forgot"><button class="btn alt sm" type="submit">Gửi link đặt lại</button></form>
      </div></div>
    ${sessions.length ? `<div class="card"><h2 style="margin-top:0">Phiên đăng nhập</h2>
      <p class="muted" style="font-size:.82rem">Thiết bị/trình duyệt đang đăng nhập vào tài khoản. Thu hồi phiên lạ nếu thấy nghi ngờ.</p>
      <table><tbody>${sessions.map((s) => `<tr>
        <td>${s.current ? badge('active', 'Thiết bị này') : '<span class="muted">Thiết bị khác</span>'}</td>
        <td class="muted" style="font-size:.8rem">${esc((s.user_agent ?? '').slice(0, 70) || '—')}<br>${esc(s.ip ?? '')} · ${dt(s.last_seen_at)}</td>
        <td style="text-align:right">${s.current ? '' : `<form method="POST" action="/account/sessions/revoke"><input type="hidden" name="session_id" value="${esc(s.id)}"><button class="btn warn sm" type="submit">Thu hồi</button></form>`}</td>
      </tr>`).join('')}</tbody></table>
      ${sessions.filter((s) => !s.current).length ? `<form method="POST" action="/account/sessions/revoke-others" style="margin-top:10px"><button class="btn warn sm" type="submit">Đăng xuất mọi thiết bị KHÁC</button></form>` : ''}
    </div>` : ''}
    ${events.length ? `<div class="card"><h2 style="margin-top:0">Hoạt động đăng nhập gần đây</h2>
      <p class="muted" style="font-size:.82rem">50 sự kiện bảo mật gần nhất của tài khoản (đăng nhập, sai mật khẩu, đổi mật khẩu, 2 lớp…). Thấy hoạt động lạ → đổi mật khẩu + đăng xuất thiết bị khác.</p>
      <table><thead><tr><th>Thời gian</th><th>Hoạt động</th><th>IP</th></tr></thead><tbody>
      ${events.map((e) => `<tr>
        <td class="muted" style="white-space:nowrap">${dt(e.created_at)}</td>
        <td>${esc(AUTH_EVENT_LABEL[e.action] ?? e.action)}</td>
        <td class="muted">${esc(e.ip ?? '—')}</td>
      </tr>`).join('')}</tbody></table>
    </div>` : ''}
    <a class="btn alt" href="/">← Bảng điều khiển</a>`);
}

// Trang chặn thân thiện khi shop BẮT BUỘC 2FA mà tài khoản chưa bật (0074).
export function renderMfaRequiredByShop(ctx) {
  return layout('Cần bật xác thực 2 lớp', ctx, `<div class="center"><div class="card">
    <h1>Cửa hàng yêu cầu xác thực 2 lớp</h1>
    <p class="muted">Chủ cửa hàng đã bật <strong>bắt buộc xác thực 2 lớp (2FA)</strong> cho toàn bộ nhân sự.
      Tài khoản của bạn chưa bật 2FA nên tạm thời không truy cập được cửa hàng này.</p>
    <p class="muted">Vào trang <strong>Tài khoản</strong> để bật 2FA (mất ~1 phút, cần ứng dụng Google Authenticator/Authy), sau đó đăng nhập lại.</p>
    <a class="btn" href="/account">Bật 2FA trong Tài khoản</a>
    <a class="btn alt" href="/" style="margin-left:8px">← Bảng điều khiển</a>
  </div></div>`);
}

// ── Nhân sự ──────────────────────────────────────────────────────────────────
export function renderMembers(ctx, shopId, data, canWrite, notice, err) {
  const members = data?.members ?? [];
  const base = `/shops/${esc(shopId)}/members`;
  const rows = members.map((mb) => [
    { html: esc(mb.email) },
    { html: `${canWrite && mb.role !== 'owner' ? `<form method="POST" action="${base}/${esc(mb.user_id)}/role" class="inline">
        <select name="role">${INVITE_ROLES.map((r) => `<option value="${r}"${r === mb.role ? ' selected' : ''}>${esc(ROLE_LABEL[r])}</option>`).join('')}</select>
        <button class="btn alt sm" type="submit">Đổi</button></form>` : `<span class="badge">${esc(ROLE_LABEL[mb.role] ?? mb.role)}</span>`}` },
    { cls: 'muted', html: dt(mb.created_at) },
    { cls: 'right', html: canWrite ? `<form method="POST" action="${base}/${esc(mb.user_id)}/remove"><button class="btn warn sm" type="submit">Gỡ</button></form>` : '' },
  ]);
  // LỜI MỜI ĐANG CHỜ. Trước đây màn này chỉ liệt kê người ĐÃ vào, nên lời mời gửi nhầm nằm im
  // 7 ngày mà chủ shop không biết là có — không thấy thì không thể muốn thu hồi.
  //
  // TUYỆT ĐỐI KHÔNG in token/link nhận lời mời ra đây (bất biến 0073: token chỉ đi qua email
  // người được mời; có bộ test canh đúng chuỗi `invite/accept?token=`). Chỉ email + vai trò +
  // hạn. Vai trò in bằng NHÃN trong <span>, KHÔNG dùng <select><option> — trang này có khẳng
  // định "không được có option value=owner" và một select thừa ở đây sẽ phá nó.
  const cho = data?.invitations ?? [];
  const choRows = cho.map((iv) => [
    { html: esc(iv.email) },
    { html: `<span class="badge">${esc(ROLE_LABEL[iv.role] ?? iv.role)}</span>` },
    { cls: 'muted', html: dt(iv.expires_at) },
    { cls: 'right', html: canWrite ? `<form method="POST" action="${base}/invitations/${esc(iv.id)}/revoke"><button class="btn warn sm" type="submit" data-confirm="Huỷ lời mời gửi tới ${esc(iv.email)}? Link đã gửi sẽ hết hiệu lực ngay.">Huỷ</button></form>` : '' },
  ]);
  return layout('Nhân sự', ctx, `<h1>Nhân sự cửa hàng</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice?.invited ? `<div class="card" style="background:#ecfdf5;border-color:#a7f3d0">
      <strong>Đã gửi email lời mời tới ${esc(notice.invited)}.</strong> Họ mở email, bấm link để đặt mật khẩu & tham gia (lời mời sống 7 ngày).</div>` : ''}
    ${notice?.revoked ? `<div class="card" style="background:#ecfdf5;border-color:#a7f3d0">
      <strong>Đã huỷ lời mời${notice.revoked ? ` gửi tới ${esc(notice.revoked)}` : ''}.</strong> Link trong email đó không dùng được nữa.</div>` : ''}
    <div class="card">${tblCards({
    head: [{ html: 'Email' }, { html: 'Vai trò' }, { html: 'Tham gia' }, { html: '', label: '' }],
    rows,
  })}</div>
    ${cho.length ? `<div class="card"><h2 style="margin-top:0">Lời mời đang chờ</h2>
      <p class="muted" style="font-size:.85rem">Người được mời chưa bấm link. Mời nhầm email hoặc nhầm vai trò thì <strong>Huỷ</strong> ngay — link đã gửi sẽ hết hiệu lực lập tức.</p>
      ${tblCards({
    head: [{ html: 'Email' }, { html: 'Vai trò' }, { html: 'Hết hạn' }, { html: '', label: '' }],
    rows: choRows,
  })}</div>` : ''}
    ${canWrite ? `<div class="card"><h2 style="margin-top:0">Mời thành viên</h2>
      <p class="muted" style="font-size:.85rem">Thao tác nhân sự cần xác nhận lại mật khẩu (step-up).</p>
      <form method="POST" action="${base}/invite">
        <div class="grid2">
          <div><label>Email</label><input name="email" type="email" required></div>
          <div><label>Vai trò</label><select name="role">${INVITE_ROLES.map((r) => `<option value="${r}">${esc(ROLE_LABEL[r])}</option>`).join('')}</select></div>
        </div>
        <button class="btn" type="submit" style="margin-top:10px">Mời</button>
      </form></div>` : '<p class="muted">Chỉ chủ shop mới mời / đổi vai trò / gỡ thành viên.</p>'}`);
}

// Interstitial step-up: mang theo hành động đang chờ (hidden) → xác nhận mật khẩu → chạy tiếp.
export function renderStepUp(ctx, shopId, action, params, err) {
  const base = `/shops/${esc(shopId)}/members`;
  const label = { invite: 'mời thành viên', role: 'đổi vai trò', remove: 'gỡ thành viên' }[action] ?? action;
  const hidden = Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return layout('Xác nhận mật khẩu', ctx, `<div class="center"><div class="card">
    <h1>Xác nhận mật khẩu</h1>
    <p class="muted">Thao tác nhạy cảm (${esc(label)}) cần xác thực lại. Nhập mật khẩu của bạn để tiếp tục.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="${base}/step-up">
      <input type="hidden" name="__action" value="${esc(action)}">${hidden}
      <label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">
      <button class="btn" type="submit" style="width:100%;margin-top:12px">Xác nhận & tiếp tục</button>
    </form>
    <a class="muted" href="${base}" style="display:inline-block;margin-top:10px">← Huỷ</a>
  </div></div>`);
}

// ── Nhật ký hoạt động (audit.read = owner/admin ở seller) ────────────────────
// Nhãn tiếng Việt cho mã hành động; mã lạ hiện nguyên văn (fallback trung thực).
const ACTION_LABEL = {
  'product.created': 'Tạo sản phẩm', 'product.updated': 'Sửa sản phẩm', 'product.deleted': 'Xoá sản phẩm',
  'product.imported': 'Nhập sản phẩm từ CSV', 'product.options_saved': 'Lưu thuộc tính sản phẩm',
  'product.options_cleared': 'Xoá thuộc tính sản phẩm', 'product.specs_set': 'Cập nhật thông số',
  'product.categories_set': 'Gán danh mục sản phẩm',
  'variant.added': 'Thêm biến thể', 'variant.updated': 'Sửa biến thể', 'variant.deleted': 'Xoá biến thể',
  'category.created': 'Tạo danh mục', 'category.updated': 'Sửa danh mục', 'category.deleted': 'Xoá danh mục',
  'inventory.adjusted': 'Điều chỉnh tồn kho',
  'order.confirmed': 'Xác nhận đơn', 'order.shipped': 'Giao đơn cho vận chuyển', 'order.cancelled': 'Huỷ đơn',
  'order.marked_paid': 'Đánh dấu đã thu tiền', 'order.qr_marked_paid_manual': 'Xác nhận tay chuyển khoản QR',
  'order.refunded': 'Hoàn tiền đơn', 'order.created_manual': 'Tạo đơn tay',
  // Xuất dữ liệu có PII — phải đọc được trong nhật ký, không để hiện mã thô.
  'orders.exported': 'Xuất CSV đơn hàng', 'report.exported': 'Xuất CSV báo cáo',
  'product.unpublished': 'Chuyển sản phẩm về nháp',
  'coupon.created': 'Tạo mã giảm giá', 'coupon.updated': 'Sửa mã giảm giá', 'coupon.deleted': 'Xoá mã giảm giá',
  'customer.note_set': 'Ghi chú khách hàng', 'customer.erased': 'Ẩn danh dữ liệu khách',
  'review.deleted': 'Xoá đánh giá', 'review.approved': 'Duyệt đánh giá', 'review.rejected': 'Từ chối đánh giá',
  'review.replied': 'Trả lời đánh giá', 'review.reply_removed': 'Gỡ trả lời đánh giá',
  'question.answered': 'Trả lời câu hỏi', 'question.draft_answer': 'Lưu nháp câu trả lời',
  'question.rejected': 'Ẩn câu hỏi', 'question.deleted': 'Xoá câu hỏi',
  'page.created': 'Tạo trang nội dung', 'page.updated': 'Sửa trang nội dung', 'page.published': 'Đăng trang',
  'page.rolled_back': 'Khôi phục bản trang cũ', 'page.deleted': 'Xoá trang', 'page.previewed': 'Xem thử trang',
  'page.block_added': 'Thêm khối nội dung', 'page.block_updated': 'Sửa khối nội dung',
  'page.block_deleted': 'Xoá khối nội dung', 'page.blocks_reordered': 'Sắp xếp khối nội dung',
  'blog.created': 'Tạo bài blog', 'blog.updated': 'Sửa bài blog', 'blog.deleted': 'Xoá bài blog',
  'media.uploaded': 'Tải ảnh lên', 'media.deleted': 'Xoá ảnh', 'media.reordered': 'Sắp xếp ảnh',
  'media.variant_assigned': 'Gán ảnh cho biến thể',
  'shop.logo_updated': 'Đổi logo shop', 'shop.logo_removed': 'Gỡ logo shop', 'shop.profile_updated': 'Sửa hồ sơ shop',
  'shop.banner_uploaded': 'Tải ảnh banner trang chủ',
  'theme.updated': 'Đổi giao diện',
  'member.invited': 'Mời nhân sự', 'member.role_changed': 'Đổi vai trò nhân sự', 'member.removed': 'Gỡ nhân sự',
  'domain.added': 'Thêm tên miền', 'domain.primary_changed': 'Đổi tên miền chính', 'domain.revoked': 'Gỡ tên miền',
  'payment_config.updated': 'Sửa cấu hình thanh toán', 'payment_config.sepay_enabled': 'Bật SePay',
  'payment_config.sepay_disabled': 'Tắt SePay', 'payment.reconcile_resolved': 'Xử lý đối soát tiền',
  'shipping.connected': 'Kết nối hãng vận chuyển', 'shipping.disconnected': 'Ngắt hãng vận chuyển',
  'shipping.cod_mismatch': 'Lệch COD vận chuyển', 'shipping.reconcile_cancel': 'Đối soát đơn huỷ VC',
  'telegram.link_requested': 'Yêu cầu kết nối Telegram', 'telegram.unlinked': 'Ngắt Telegram',
  'export.created': 'Xuất dữ liệu',
  // Hành động cấp nền tảng gắn shop này (actor là nhân viên nền tảng).
  'invitation.created': 'Nền tảng tạo lời mời', 'shop.suspended': 'Nền tảng tạm ngưng shop',
  'shop.restored': 'Nền tảng khôi phục shop',
};

// Tóm tắt metadata AN TOÀN: giấu key nhạy cảm, che email/SĐT (phòng khi handler
// nào đó ghi PII thô — đa số đã ghi phone_masked sẵn), cắt ngắn giá trị dài.
const META_HIDE = /token|secret|hash|password|key/i;
function maskMetaValue(v) {
  let s = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
  // email → a***@domain
  s = s.replace(/([^\s@"{}[\],]+)@([^\s@"{}[\],]+)/g, (_, a, d) => `${a.slice(0, 1)}***@${d}`);
  // chuỗi toàn số dài như SĐT → che còn 3 số cuối
  s = s.replace(/(?<!\d)\d{8,15}(?!\d)/g, (m) => '•••' + m.slice(-3));
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
}
function maskMeta(m) {
  if (m == null || typeof m !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(m)) {
    if (v == null || META_HIDE.test(k)) continue;
    parts.push(`${esc(k)}: ${esc(maskMetaValue(v))}`);
    if (parts.length >= 6) break;
  }
  return parts.join(' · ');
}

export function renderAuditLog(ctx, shopId, data, filter) {
  const entries = data?.entries ?? [];
  const off = filter.offset, lim = filter.limit;
  const actorOf = (e) => e.actor_email ? esc(e.actor_email)
    : e.actor_type === 'system' ? 'Hệ thống'
    : e.actor_type === 'platform_staff' ? 'Nhân viên nền tảng'
    : '(không còn là nhân sự)';
  const rows = entries.map((e) => [
    { cls: 'muted', style: 'white-space:nowrap', html: dt(e.created_at) },
    { html: actorOf(e) },
    { html: ACTION_LABEL[e.action] ? esc(ACTION_LABEL[e.action]) : `<code>${esc(e.action)}</code>` },
    { cls: 'muted', style: 'font-size:.85rem', html: maskMeta(e.metadata) },
  ]);
  const nav = (o) => `/shops/${esc(shopId)}/audit-log?offset=${o}`;
  return layout('Nhật ký', ctx, `<h1>Nhật ký hoạt động</h1>
    <p class="muted">Mọi thao tác trong shop đều được ghi lại, không sửa/xoá được.
      Lịch sử đăng nhập, đổi mật khẩu, MFA là sự kiện cấp tài khoản (không gắn shop) nên không hiển thị tại đây.</p>
    <div class="card">${rows.length ? `${tblCards({
      head: [{ html: 'Thời điểm' }, { html: 'Người thực hiện' }, { html: 'Hành động' }, { html: 'Chi tiết' }],
      rows,
    })}
      <div class="muted" style="margin-top:12px">
        ${off > 0 ? `<a href="${nav(Math.max(0, off - lim))}">← Mới hơn</a>` : '<span style="color:#d1d5db">← Mới hơn</span>'} ·
        ${data?.has_more ? `<a href="${nav(off + lim)}">Cũ hơn →</a>` : '<span style="color:#d1d5db">Cũ hơn →</span>'}</div>`
      : '<p class="muted">Chưa có hoạt động nào được ghi.</p>'}</div>`);
}

// ── Xuất dữ liệu (owner) ─────────────────────────────────────────────────────
export function renderExport(ctx, shopId, notice, err) {
  const base = `/shops/${esc(shopId)}`;
  if (ctx.role !== 'owner') {
    return layout('Xuất dữ liệu', ctx, `<h1>Xuất dữ liệu</h1>
      <div class="card"><p class="muted">Chỉ <strong>chủ cửa hàng</strong> mới xuất được dữ liệu.</p></div>`);
  }
  const N = (n) => new Intl.NumberFormat('vi-VN').format(Number(n ?? 0));
  const dl = notice ? `<div class="card ok">
      <h2>Bản xuất đã sẵn sàng</h2>
      <p class="muted">Gồm ${N(notice.counts?.products)} sản phẩm · ${N(notice.counts?.orders)} đơn · ${N(notice.counts?.customers)} khách · ${N(Math.round((notice.bytes ?? 0) / 1024))} KB.</p>
      <p><a class="btn" href="${base}/export/download?token=${esc(notice.token)}">⬇ Tải ZIP</a></p>
      <p class="muted">Link tải HẾT HẠN sau ${Math.round((notice.expires_in ?? 0) / 60)} phút. Hết hạn thì tạo bản xuất mới.</p>
    </div>` : '';
  return layout('Xuất dữ liệu', ctx, `
    <h1>Xuất dữ liệu</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${dl}
    <div class="card">
      <p>Tải toàn bộ dữ liệu cửa hàng dạng ZIP nhiều tệp CSV: sản phẩm, biến thể (kèm tồn kho),
         đơn hàng, chi tiết đơn, khách hàng (suy từ đơn) và danh mục ảnh.</p>
      <p class="muted">Thao tác nhạy cảm — sẽ yêu cầu xác nhận lại mật khẩu. Bản xuất chứa
         thông tin khách hàng, hãy giữ tệp cẩn thận.</p>
      <form method="POST" action="${base}/export">
        <button class="btn" type="submit">Tạo bản xuất</button>
      </form>
    </div>`);
}

export function renderExportStepUp(ctx, shopId, err) {
  const base = `/shops/${esc(shopId)}/export`;
  return layout('Xác nhận mật khẩu', ctx, `<div class="center"><div class="card">
    <h1>Xác nhận mật khẩu</h1>
    <p class="muted">Xuất dữ liệu là thao tác nhạy cảm — nhập mật khẩu của bạn để tiếp tục.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="${base}/step-up">
      <label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">
      <button class="btn" type="submit" style="width:100%;margin-top:12px">Xác nhận & tạo bản xuất</button>
    </form>
    <a class="muted" href="${base}" style="display:inline-block;margin-top:10px">← Huỷ</a>
  </div></div>`);
}

// ── Tên miền tùy chỉnh (owner) ───────────────────────────────────────────────
export function renderDomains(ctx, shopId, domains, notice, err, platformIp, check) {
  const base = `/shops/${esc(shopId)}`;
  if (ctx.role !== 'owner') {
    return layout('Tên miền', ctx, `<h1>Tên miền</h1><div class="card"><p class="muted">Chỉ <strong>chủ cửa hàng</strong> mới quản lý tên miền.</p></div>`);
  }
  const isPlatform = (h) => h.endsWith('.nentang.vn') || h === 'nentang.vn';
  // Bản ghi A phải hiện IP CỤ THỂ. "Trỏ về IP nền tảng" mà không nói IP nào thì khách
  // không làm theo được — họ buộc phải nhắn hỏi shop, đúng thứ trang này sinh ra để tránh.
  const ipCell = platformIp
    ? `<code style="word-break:break-all">${esc(platformIp)}</code>`
    : '<span class="muted">chưa cấu hình — báo bộ phận hỗ trợ</span>';
  const rows = domains.map((d) => {
    const status = d.verified ? badge('active', 'Đã xác minh') : badge('pending', 'Chờ xác minh DNS');
    const primary = d.is_primary ? ` ${badge('confirmed', 'Tên miền chính')}` : '';
    // Kết quả "Kiểm tra ngay" chỉ hiện ở ĐÚNG tên miền vừa bấm.
    const goodCk = check && (check.verified || check.cname?.ok || (check.a?.ok && check.txt?.ok));
    const ck = (check && check.id === d.id) ? `<div class="card" style="margin:8px 0 0;border-color:${goodCk ? '#a7f3d0' : '#fcd34d'};background:${goodCk ? '#ecfdf5' : '#fffbeb'}">
        <p style="margin:0"><strong>Cách 1:</strong> ${check.cname?.ok ? '✓' : '✗'} Bản ghi CNAME
          &nbsp;·&nbsp; <strong>Cách 2:</strong> <strong>${check.a?.ok ? '✓' : '✗'} Bản ghi A</strong> + <strong>${check.txt?.ok ? '✓' : '✗'} Bản ghi TXT</strong></p>
        <p style="margin:6px 0 0">${esc(check.message ?? '')}</p></div>` : '';
    // HAI đường, khách chỉ làm MỘT. Tên miền con → CNAME một bản ghi (khuyên dùng, và cũng
    // là đường an toàn hơn: đích mang slug riêng của shop nên wildcard của người khác không
    // mượn được). Tên miền GỐC không đặt CNAME được (ADR-004) → bắt buộc A + TXT.
    const cn = d.challenge?.cname ?? null;
    const rowsATxt = `<table><tbody>
          <tr><td class="muted">Loại</td><td><code>A</code></td><td class="muted">trỏ tên miền về máy chủ</td></tr>
          <tr><td class="muted">Tên/Host</td><td><code style="word-break:break-all">${esc(d.hostname)}</code></td><td></td></tr>
          <tr><td class="muted">Giá trị</td><td>${ipCell}</td><td></td></tr>
          <tr><td colspan="3" style="border:0;height:8px"></td></tr>
          <tr><td class="muted">Loại</td><td><code>TXT</code></td><td class="muted">chứng minh tên miền là của bạn</td></tr>
          <tr><td class="muted">Tên/Host</td><td><code style="word-break:break-all">${esc(d.challenge?.name ?? '')}</code></td><td></td></tr>
          <tr><td class="muted">Giá trị</td><td><code style="word-break:break-all">${esc(d.challenge?.value ?? '')}</code></td><td></td></tr>
        </tbody></table>`;
    const rowsCname = cn ? `<table><tbody>
          <tr><td class="muted">Loại</td><td><code>CNAME</code></td><td class="muted">trỏ tên miền về cửa hàng của bạn</td></tr>
          <tr><td class="muted">Tên/Host</td><td><code style="word-break:break-all">${esc(cn.name)}</code></td><td></td></tr>
          <tr><td class="muted">Giá trị</td><td><code style="word-break:break-all">${esc(cn.value)}</code></td><td></td></tr>
        </tbody></table>` : '';
    const checkForm = `<form method="POST" action="${base}/domains/${esc(d.id)}/check" style="margin:10px 0 0">
          <button class="btn alt sm" type="submit">Kiểm tra ngay</button>
          <span class="muted" style="font-size:.82rem;margin-left:8px">Xem đã đặt DNS đúng chưa, không phải ngồi đoán.</span>
        </form>`;
    const guide = (cn && !d.apex)
      ? `<p class="muted" style="margin:0 0 6px">Thêm <strong>một</strong> bản ghi DNS này tại nơi bạn mua tên miền, rồi chờ ~1 phút (hệ thống tự kiểm):</p>
         ${rowsCname}
         <details style="margin:10px 0 0"><summary class="muted" style="cursor:pointer">Nhà cung cấp không cho đặt CNAME? Dùng cách 2 (hai bản ghi)</summary>
           <div style="margin-top:8px">${rowsATxt}</div></details>`
      : `<p class="muted" style="margin:0 0 6px">Đây là <strong>tên miền gốc</strong> — theo chuẩn DNS không đặt được CNAME, nên cần
           <strong>hai</strong> bản ghi. Thêm tại nơi bạn mua tên miền rồi chờ ~1 phút (hệ thống tự kiểm):</p>
         ${rowsATxt}
         ${cn ? `<p class="muted" style="margin:8px 0 0;font-size:.85rem">Nếu bạn dùng tên miền con (vd <code>shop.${esc(d.hostname)}</code>) thì chỉ cần MỘT bản ghi CNAME → <code>${esc(cn.value)}</code>.</p>` : ''}`;
    const challenge = (!d.verified && d.challenge)
      ? `<div class="card" style="background:#fffbeb;border-color:#fcd34d;margin:8px 0 0">${guide}${checkForm}</div>` : '';
    const setPrimary = (d.verified && !d.is_primary) ? `<form method="POST" action="${base}/domains/${esc(d.id)}/primary" style="display:inline"><button class="btn sm" type="submit">Đặt làm chính</button></form>` : '';
    const revoke = (!d.is_primary && !isPlatform(d.hostname)) ? `<form method="POST" action="${base}/domains/${esc(d.id)}/revoke" style="display:inline"><button class="btn warn sm" type="submit">Gỡ</button></form>` : '';
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div><strong style="word-break:break-all">${esc(d.hostname)}</strong> ${status}${primary}</div>
        <div class="actions">${setPrimary} ${revoke}</div>
      </div>${ck}${challenge}</div>`;
  }).join('');
  return layout('Tên miền', ctx, `
    <h1>Tên miền</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice ? `<div class="card" style="background:#ecfdf5;border-color:#a7f3d0;color:#065f46">${esc(notice)}</div>` : ''}
    ${rows || '<div class="card"><p class="muted">Chưa có tên miền nào.</p></div>'}
    <div class="card"><h2 style="margin-top:0">Thêm tên miền riêng</h2>
      <p class="muted" style="font-size:.85rem">Nhập tên miền bạn đã mua. Thêm xong, màn hình sẽ hiện <strong>chính xác hai bản ghi DNS</strong>
        cần đặt (kèm ${platformIp ? `IP <code>${esc(platformIp)}</code>` : 'IP máy chủ'}) và nút kiểm tra. Chứng chỉ HTTPS được cấp tự động — bạn không phải làm gì.</p>
      <form method="POST" action="${base}/domains" class="actions" style="align-items:end">
        <div><label>Tên miền (vd shop.cuahang.vn)</label><input name="hostname" required placeholder="shop.cuahang.vn" style="width:260px"></div>
        <button class="btn" type="submit">Thêm tên miền</button>
      </form></div>`);
}

export function renderDomainStepUp(ctx, shopId, action, params, err) {
  const base = `/shops/${esc(shopId)}/domains`;
  const label = { add: 'thêm tên miền', primary: 'đặt tên miền chính', revoke: 'gỡ tên miền' }[action] ?? action;
  const hidden = Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return layout('Xác nhận mật khẩu', ctx, `<div class="center"><div class="card">
    <h1>Xác nhận mật khẩu</h1>
    <p class="muted">Thao tác nhạy cảm (${esc(label)}) cần xác thực lại. Nhập mật khẩu để tiếp tục.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="${base}/step-up">
      <input type="hidden" name="__action" value="${esc(action)}">${hidden}
      <label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">
      <button class="btn" type="submit" style="width:100%;margin-top:12px">Xác nhận & tiếp tục</button>
    </form>
    <a class="muted" href="${base}" style="display:inline-block;margin-top:10px">← Huỷ</a>
  </div></div>`);
}

// ── Thanh toán (owner + step-up) ─────────────────────────────────────────────
// Cấu hình tài khoản ngân hàng NHẬN TIỀN qua VietQR. Tiền vào THẲNG tài khoản shop;
// nền tảng chỉ đối soát. Vài BIN napas phổ biến để chủ shop tra nhanh.
const BANK_HINT = 'VD BIN napas: Vietcombank 970436 · Techcombank 970407 · MB 970422 · ACB 970416 · VietinBank 970415 · BIDV 970418 · VPBank 970432 · Agribank 970405 · Sacombank 970403 · TPBank 970423';
const RECONCILE_REASON = { no_ref: 'Thiếu mã đối soát', order_not_found: 'Không thấy đơn', account_mismatch: 'Sai tài khoản nhận' };
export function renderPayment(ctx, shopId, cfg, notice, err, sepay = null, reconcile = null, tokenInfo = null) {
  const base = `/shops/${esc(shopId)}`;
  if (ctx.role !== 'owner') {
    return layout('Thanh toán', ctx, `<h1>Thanh toán</h1><div class="card"><p class="muted">Chỉ <strong>chủ cửa hàng</strong> mới cấu hình tài khoản nhận tiền.</p></div>`);
  }
  const c = cfg ?? {};
  const on = c.qr_enabled === true;
  return layout('Thanh toán', ctx, `
    <h1>Thanh toán</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice ? `<div class="card" style="background:#ecfdf5;border-color:#a7f3d0;color:#065f46">${esc(notice)}</div>` : ''}
    ${tokenInfo ? `<div class="card" style="background:#eef4ff;border-color:#93c5fd">
      <h2 style="margin-top:0">✅ Đã bật SePay — lưu API Key ngay</h2>
      <p class="muted" style="margin-top:0">Mở <strong>SePay → Cấu hình → Webhooks</strong>, tạo webhook mới với thông tin dưới đây. <strong>API Key chỉ hiện MỘT LẦN</strong> — không lưu lại thì phải tạo mới.</p>
      <label>URL webhook</label>
      <code style="display:block;word-break:break-all;padding:11px 12px;background:#fff;border:1px solid #d8dbe0;border-radius:8px">${esc(tokenInfo.webhook_url)}</code>
      <label>API Key (SePay gửi qua header Authorization)</label>
      <code style="display:block;word-break:break-all;padding:11px 12px;background:#fff;border:1px solid #d8dbe0;border-radius:8px">${esc(tokenInfo.api_key)}</code>
    </div>` : ''}
    <div class="card">
      <p class="muted" style="margin-top:0">Khai báo tài khoản ngân hàng của cửa hàng để nhận tiền qua <strong>VietQR</strong>.
        Khi bật, trang thanh toán sẽ hiện mã QR chuyển tiền <strong>thẳng vào tài khoản của bạn</strong>.
        Nền tảng không giữ tiền hộ.</p>
      <p class="muted" style="font-size:.85rem">Thao tác nhạy cảm — lưu sẽ yêu cầu xác nhận lại mật khẩu.</p>
      <form method="POST" action="${base}/payment" class="actions" style="align-items:end;flex-wrap:wrap">
        <div><label>Mã ngân hàng (BIN napas, 6 số)</label><input name="bank_bin" value="${esc(c.bank_bin ?? '')}" inputmode="numeric" pattern="\\d{6}" maxlength="6" placeholder="970436" style="width:150px"></div>
        <div><label>Số tài khoản</label><input name="account_number" value="${esc(c.account_number ?? '')}" inputmode="numeric" pattern="\\d{6,19}" maxlength="19" placeholder="0011002222" style="width:200px"></div>
        <div><label>Tên chủ tài khoản</label><input name="account_name" value="${esc(c.account_name ?? '')}" maxlength="100" placeholder="NGUYEN VAN A" style="width:240px"></div>
        <label style="display:flex;align-items:center;gap:8px;font-weight:600"><input type="checkbox" name="qr_enabled" value="1"${on ? ' checked' : ''} style="width:auto">Bật nhận tiền QR</label>
        <button class="btn" type="submit">Lưu</button>
      </form>
      <p class="muted" style="font-size:.8rem;margin-bottom:0">${esc(BANK_HINT)}</p>
    </div>
    <div class="card"><p class="muted" style="margin:0"><strong>${on ? '✅ Đang bật' : '⏸ Đang tắt'}</strong> nhận tiền QR.
      ${on ? 'Khách có thể chọn chuyển khoản QR khi đặt hàng.' : 'Bật ở trên để khách thanh toán bằng QR; hiện chỉ có COD (thu tiền mặt khi giao).'}</p></div>
    ${renderSepayCard(base, sepay)}
    ${renderReconcileCard(base, reconcile)}`);
}
// Thẻ "Tự đối soát (SePay)": kết nối SePay của shop để tự đánh dấu đơn đã trả.
function renderSepayCard(base, sepay) {
  const s = sepay ?? {};
  const son = s.sepay_enabled === true;
  const hasBank = s.has_bank === true;
  const enableForm = `<form method="POST" action="${base}/payment/sepay" style="margin:0"><input type="hidden" name="__op" value="enable"><button class="btn" type="submit"${hasBank ? '' : ' disabled'}>${son ? 'Tạo lại token' : 'Bật SePay'}</button></form>`;
  const disableForm = son ? `<form method="POST" action="${base}/payment/sepay" style="margin:0"><input type="hidden" name="__op" value="disable"><button class="btn warn" type="submit">Tắt SePay</button></form>` : '';
  return `<div class="card">
    <h2 style="margin-top:0">Tự đối soát (SePay)</h2>
    <p class="muted">Kết nối tài khoản <strong>SePay</strong> của bạn (miễn phí) để đơn tự chuyển sang "đã thanh toán" ngay khi tiền vào — khỏi bấm tay. Tiền vẫn vào <strong>thẳng tài khoản của bạn</strong>; SePay chỉ báo cho hệ thống biết giao dịch đã tới.</p>
    ${hasBank ? '' : '<p class="muted" style="font-size:.85rem;color:#b45309">Hãy khai tài khoản ngân hàng nhận tiền ở trên trước khi bật SePay.</p>'}
    <p style="margin:0 0 12px"><strong>${son ? '✅ Đang bật' : '⏸ Đang tắt'}</strong>${son && s.token_prefix ? ` · token <code>${esc(s.token_prefix)}…</code>` : ''}</p>
    <div class="actions" style="margin-top:0">${enableForm}${disableForm}</div>
    <p class="muted" style="font-size:.8rem;margin-bottom:0">Thao tác nhạy cảm — cần xác nhận lại mật khẩu.</p>
  </div>`;
}
// Thẻ "Giao dịch chưa khớp": tiền vào nhưng không tự khớp đơn → owner đối chiếu tay.
function renderReconcileCard(base, reconcile) {
  const rows = Array.isArray(reconcile) ? reconcile : [];
  const pending = rows.filter((t) => !t.resolved_at);
  const body = rows.length
    ? `<table><thead><tr><th>Thời gian</th><th>Số tiền</th><th>Nội dung</th><th>TK nhận</th><th>Lý do</th><th></th></tr></thead><tbody>${rows.map((t) => `<tr>
        <td class="muted" style="font-size:.85rem">${dt(t.created_at)}</td>
        <td class="num"><strong>${money(t.amount_vnd)}</strong></td>
        <td class="muted" style="max-width:220px;font-size:.85rem">${esc(t.content ?? '')}</td>
        <td class="muted">${esc(t.received_account ?? '')}</td>
        <td>${t.resolved_at ? '<span class="badge">Đã xử lý</span>' : `<span class="badge cancelled">${esc(RECONCILE_REASON[t.reason] ?? t.reason)}</span>`}</td>
        <td style="text-align:right">${t.resolved_at ? '' : `<form method="POST" action="${base}/payment/reconcile/${esc(t.id)}/resolve" style="margin:0"><button class="btn alt sm" type="submit">Đã xử lý</button></form>`}</td>
      </tr>`).join('')}</tbody></table>`
    : '<p class="muted" style="margin:0">Chưa có giao dịch nào cần đối soát tay.</p>';
  return `<div class="card">
    <h2 style="margin-top:0">Giao dịch chưa khớp${pending.length ? ` <span class="badge cancelled">${pending.length}</span>` : ''}</h2>
    <p class="muted">Tiền vào nhưng hệ thống không tự khớp được đơn (thiếu mã đối soát, không thấy đơn, hoặc sai tài khoản). Kiểm tra và đối chiếu tay; bấm "Đã xử lý" khi xong.</p>
    ${body}
  </div>`;
}
export function renderPaymentStepUp(ctx, shopId, form, err) {
  const base = `/shops/${esc(shopId)}/payment`;
  const f = form ?? {};
  const hidden = ['bank_bin', 'account_number', 'account_name', 'qr_enabled'].map((k) => `<input type="hidden" name="${k}" value="${esc(f[k] ?? '')}">`).join('');
  return layout('Xác nhận mật khẩu', ctx, `<div class="center"><div class="card">
    <h1>Xác nhận mật khẩu</h1>
    <p class="muted">Đổi cấu hình nhận tiền là thao tác nhạy cảm — nhập mật khẩu của bạn để tiếp tục.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="${base}/step-up">${hidden}
      <label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">
      <button class="btn" type="submit" style="width:100%;margin-top:12px">Xác nhận & lưu</button>
    </form>
    <a class="muted" href="${base}" style="display:inline-block;margin-top:10px">← Huỷ</a>
  </div></div>`);
}
// Interstitial step-up cho thao tác SePay (bật/tắt token) và đối soát tay.
export function renderSepayStepUp(ctx, shopId, op, txnId, err) {
  const base = `/shops/${esc(shopId)}/payment`;
  const label = op === 'disable' ? 'tắt SePay' : op === 'resolve' ? 'đánh dấu giao dịch đã xử lý' : 'bật / tạo lại token SePay';
  const action = op === 'resolve' ? `${base}/reconcile/${esc(txnId)}/resolve/step-up` : `${base}/sepay/step-up`;
  return layout('Xác nhận mật khẩu', ctx, `<div class="center"><div class="card">
    <h1>Xác nhận mật khẩu</h1>
    <p class="muted">Thao tác nhạy cảm (${esc(label)}) cần xác thực lại. Nhập mật khẩu để tiếp tục.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="${action}">
      ${op !== 'resolve' ? `<input type="hidden" name="__op" value="${esc(op)}">` : ''}
      <label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">
      <button class="btn" type="submit" style="width:100%;margin-top:12px">Xác nhận & tiếp tục</button>
    </form>
    <a class="muted" href="${base}" style="display:inline-block;margin-top:10px">← Huỷ</a>
  </div></div>`);
}
// ── CRM-lite: khách hàng gộp từ đơn (theo SĐT) + ghi chú ──────────────────────
export function renderCustomers(ctx, shopId, data, filter, notice) {
  const base = `/shops/${esc(shopId)}/customers`;
  const rows = (data?.customers ?? []).map((cu) => [
    { html: `<a href="${base}/${esc(cu.phone)}">${esc(cu.name ?? '(không tên)')}</a><div class="muted" style="font-size:.8rem">${esc(cu.phone)}${cu.email ? ` · ${esc(cu.email)}` : ''}</div>` },
    { cls: 'num', html: `${esc(cu.n_orders)} đơn${Number(cu.n_orders) >= 3 ? ' <span class="badge delivered">thân thiết</span>' : ''}` },
    { cls: 'num right', html: `<strong>${money(cu.total_spent_vnd)}</strong>` },
    { cls: 'muted', html: dt(cu.last_order_at) },
  ]);
  const total = data?.total ?? 0, off = filter.offset, lim = filter.limit;
  const nav = (o) => `?q=${encodeURIComponent(filter.q ?? '')}&min_orders=${esc(String(filter.min_orders ?? 1))}&offset=${o}`;
  return layout('Khách hàng', ctx, `<h1>Khách hàng</h1>
    ${notice ? `<div class="card" style="background:#ecfdf5;border-color:#a7f3d0;color:#065f46">Đã ẩn danh dữ liệu khách theo yêu cầu — các đơn cũ chỉ còn "(đã ẩn danh)".</div>` : ''}
    <p class="muted">Gộp từ đơn hàng theo số điện thoại (không tính đơn huỷ). Bấm tên để xem lịch sử mua + ghi chú.</p>
    <div class="card"><form method="GET" class="filters">
      <div style="flex:1 1 200px"><label>Tìm (tên / SĐT)</label><input name="q" value="${esc(filter.q ?? '')}" placeholder="Nguyễn…, 09…"></div>
      <div><label>Mua tối thiểu</label><select name="min_orders">${[1, 2, 3, 5].map((n) => `<option value="${n}"${Number(filter.min_orders) === n ? ' selected' : ''}>≥ ${n} đơn</option>`).join('')}</select></div>
      <div><button class="btn alt sm" type="submit">Lọc</button></div>
    </form></div>
    <div class="card">${rows.length ? `${tblCards({
      head: [{ html: 'Khách' }, { html: 'Số đơn' }, { html: 'Tổng chi', cls: 'right' }, { html: 'Mua gần nhất' }],
      rows,
    })}
      <div class="muted" style="margin-top:12px">${esc(String(total))} khách ·
        ${off > 0 ? `<a href="${nav(Math.max(0, off - lim))}">← Trước</a>` : '<span style="color:#d1d5db">← Trước</span>'} ·
        ${off + lim < total ? `<a href="${nav(off + lim)}">Sau →</a>` : '<span style="color:#d1d5db">Sau →</span>'}</div>`
      : '<p class="muted">Chưa có khách nào khớp bộ lọc.</p>'}</div>`);
}

export function renderCustomerDetail(ctx, shopId, cu, saved, err) {
  const base = `/shops/${esc(shopId)}`;
  const rows = (cu.orders ?? []).map((o) => [
    { html: `<a href="${base}/orders/${esc(o.id)}">#${esc(o.order_number)}</a>` },
    { html: badge(o.status, STATUS[o.status] ?? o.status) },
    { html: `${badge(o.payment_status, PAY[o.payment_status] ?? o.payment_status)} <span class="muted">${esc(o.payment_method?.toUpperCase() ?? '')}</span>` },
    { cls: 'muted', html: dt(o.created_at) },
    { cls: 'right', html: `<strong>${money(o.total_vnd)}</strong>` },
  ]);
  return layout(`Khách: ${cu.name ?? cu.phone}`, ctx, `
    <a class="muted" href="${base}/customers">← Danh sách khách hàng</a>
    <h1>${esc(cu.name ?? '(không tên)')}</h1>
    <div class="card"><div class="metrics">
      <div class="metric"><div class="v">${esc(cu.phone)}</div><div class="l">SĐT${cu.email ? ` · ${esc(cu.email)}` : ''}</div></div>
      <div class="metric"><div class="v">${esc(String(cu.n_orders))}</div><div class="l">đơn (không tính huỷ)</div></div>
      <div class="metric"><div class="v">${money(cu.total_spent_vnd)}</div><div class="l">tổng chi</div></div>
    </div></div>
    <div class="card"><h2 style="margin-top:0">Ghi chú của shop</h2>
      ${saved ? '<div class="card" style="border-color:#86efac;background:#f0fdf4;padding:8px 12px">Đã lưu ghi chú.</div>' : ''}
      <form method="POST" action="${base}/customers/${esc(cu.phone)}/note">
        <textarea name="note" rows="3" maxlength="2000" placeholder="VD: khách quen, thích giao giờ hành chính, hay đổi size…">${esc(cu.note ?? '')}</textarea>
        <button class="btn sm" type="submit" style="margin-top:10px">Lưu ghi chú</button>
      </form></div>
    <div class="card"><h2 style="margin-top:0">Lịch sử mua (${esc(String((cu.orders ?? []).length))})</h2>
      ${tblCards({
      head: [{ html: 'Đơn' }, { html: 'Trạng thái' }, { html: 'Thanh toán' }, { html: 'Thời gian' }, { html: 'Tổng', cls: 'right' }],
      rows,
    })}</div>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${ctx.role === 'owner' ? `<div class="card" style="border-color:#fca5a5">
      <h2 style="margin-top:0">Xoá dữ liệu cá nhân (ẩn danh)</h2>
      <p class="muted">Khi khách yêu cầu xoá dữ liệu (Luật BVDLCN 91/2025): hệ thống xoá tên, SĐT, email, địa chỉ
        khỏi <strong>toàn bộ đơn cũ</strong> của khách này, xoá ghi chú và ẩn tên trên đánh giá đã xác minh.
        Doanh thu, trạng thái đơn và tồn kho giữ nguyên. <strong>Không hoàn tác được.</strong>
        Đơn đang xử lý phải hoàn tất hoặc huỷ trước.</p>
      <form method="POST" action="${base}/customers/${esc(cu.phone)}/erase"><button class="btn warn sm" type="submit">Ẩn danh khách này</button></form>
    </div>` : ''}`);
}

// Interstitial mật khẩu cho ẨN DANH khách (mirror renderExportStepUp — thao tác huỷ dữ liệu).
export function renderCustomerEraseStepUp(ctx, shopId, phone, err) {
  const base = `/shops/${esc(shopId)}`;
  return layout('Xác nhận mật khẩu', ctx, `<div class="center"><div class="card">
    <h1>Xác nhận mật khẩu</h1>
    <p class="muted">Ẩn danh dữ liệu khách là thao tác nhạy cảm, KHÔNG hoàn tác — nhập mật khẩu để tiếp tục.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="${base}/customers/${esc(phone)}/erase/step-up">
      <label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">
      <button class="btn warn" type="submit" style="width:100%;margin-top:12px">Xác nhận & ẩn danh</button>
    </form>
    <a class="muted" href="${base}/customers/${esc(phone)}" style="display:inline-block;margin-top:10px">← Huỷ</a>
  </div></div>`);
}

// ── Đánh giá sản phẩm (moderation: pending → duyệt/từ chối) ──────────────────
// ── Hỏi đáp sản phẩm (0100) ─────────────────────────────────────────────────
// Khác trang Đánh giá ở một điểm: câu hỏi KHÔNG có câu trả lời thì đăng lên trang sản phẩm
// chỉ tổ hại (khách thấy câu hỏi bỏ ngỏ = shop không chăm). Nên chỉ có nút "Trả lời & đăng",
// không có nút "Duyệt" trống.
export function renderQuestions(ctx, shopId, data, activeStatus) {
  const base = `/shops/${esc(shopId)}/questions`;
  const qs = data?.questions ?? [];
  const tab = (st, label) => `<a class="btn ${activeStatus === st ? '' : 'alt '}sm" href="${base}?status=${st}">${label}</a>`;
  const rows = qs.map((q) => `<div class="card">
      <div><strong>${esc(q.asker_name)}</strong> <span class="muted" style="font-size:.82rem">· ${dt(q.created_at)}</span></div>
      <div class="muted" style="font-size:.85rem;margin:4px 0">SP: ${esc(q.product_title)}</div>
      <p style="margin:6px 0 0;white-space:pre-line"><strong>Hỏi:</strong> ${esc(q.question)}</p>
      <form method="POST" action="${base}/${esc(q.id)}/answer" style="margin-top:10px;max-width:620px">
        <input type="hidden" name="status" value="${esc(activeStatus ?? 'pending')}">
        <label style="font-size:.83rem;font-weight:600">${q.answer ? 'Câu trả lời (đang hiện công khai)' : 'Trả lời cho khách'}</label>
        <textarea name="answer" maxlength="1000" rows="2" required placeholder="Trả lời ngắn gọn, đúng trọng tâm.">${esc(q.answer ?? '')}</textarea>
        <div class="actions" style="margin-top:6px">
          <button class="btn sm" type="submit">${q.answer ? 'Cập nhật câu trả lời' : 'Trả lời & đăng'}</button>
        </div>
      </form>
      <div class="actions" style="margin-top:8px">
        ${activeStatus !== 'rejected' ? `<form method="POST" action="${base}/${esc(q.id)}/reject"><button class="btn alt sm" type="submit">Ẩn (spam / không liên quan)</button></form>` : ''}
        <form method="POST" action="${base}/${esc(q.id)}/delete"><button class="btn warn sm" type="submit">Xoá</button></form>
      </div>
    </div>`).join('');
  return layout('Hỏi đáp', ctx, `<h1>Hỏi đáp sản phẩm</h1>
    <p class="muted">Câu hỏi của khách chỉ hiện trên cửa hàng sau khi bạn <strong>trả lời</strong> — câu hỏi bỏ ngỏ trên trang sản phẩm làm khách e ngại. Đang chờ: <strong>${esc(String(data?.pending_count ?? 0))}</strong></p>
    <div class="actions" style="margin-bottom:14px">${tab('pending', 'Chờ trả lời')}${tab('approved', 'Đã đăng')}${tab('rejected', 'Đã ẩn')}</div>
    ${rows || '<div class="card"><p class="muted" style="margin:0">Không có câu hỏi nào ở mục này.</p></div>'}`);
}

export function renderReviews(ctx, shopId, data, activeStatus) {
  const base = `/shops/${esc(shopId)}/reviews`;
  const rvs = data?.reviews ?? [];
  const stars = (r) => '★'.repeat(Number(r)) + '☆'.repeat(5 - Number(r));
  const tab = (st, label) => `<a class="btn ${activeStatus === st ? '' : 'alt '}sm" href="${base}?status=${st}">${label}</a>`;
  const rows = rvs.map((r) => `<div class="card">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div>
          <div><span style="color:#f59e0b">${stars(r.rating)}</span> <strong>${esc(r.author_name)}</strong>
            ${r.verified ? '<span class="badge delivered">✓ đã mua</span>' : ''}
            <span class="muted" style="font-size:.82rem">· ${dt(r.created_at)}</span></div>
          <div class="muted" style="font-size:.85rem;margin:4px 0">SP: ${esc(r.product_title)}</div>
          <p style="margin:6px 0 0;white-space:pre-line">${esc(r.content)}</p>
          ${/* Ảnh người mua gửi (0101). Ảnh CHƯA DUYỆT nằm bucket riêng tư → xem qua endpoint
               có xác thực, KHÔNG có URL công khai. Phải nhìn được thì mới duyệt có trách nhiệm. */''}
          ${(r.images ?? []).length ? `<div class="actions" style="gap:8px;margin-top:8px">${(r.images ?? []).map((im) => `
            <a href="${base}/${esc(r.id)}/images/${esc(im.id)}" target="_blank" rel="noopener" title="Mở ảnh cỡ lớn">
              <img src="${base}/${esc(r.id)}/images/${esc(im.id)}" alt="Ảnh từ người mua" width="84" height="84"
                   style="width:84px;height:84px;object-fit:cover;border-radius:8px;border:1px solid var(--bd)"></a>`).join('')}
            <span class="muted" style="font-size:.8rem;align-self:center">${esc((r.images ?? []).length)} ảnh — ${r.images.some((i) => i.public_key) ? 'đã công khai' : '<strong>chưa công khai</strong>, chỉ hiện sau khi bạn duyệt'}</span>
          </div>` : ''}
          ${r.helpful_count > 0 ? `<div class="muted" style="font-size:.8rem;margin-top:4px">👍 ${esc(r.helpful_count)} người thấy hữu ích</div>` : ''}
          ${/* TRẢ LỜI CÔNG KHAI (0099): hiện ngay dưới đánh giá trên trang sản phẩm. Với đánh
               giá thấp, một câu trả lời tử tế thuyết phục hơn mười đánh giá 5 sao. */''}
          <form method="POST" action="${base}/${esc(r.id)}/reply" style="margin-top:10px;max-width:560px">
            <input type="hidden" name="status" value="${esc(activeStatus ?? 'pending')}">
            <label style="font-size:.83rem;font-weight:600">${r.seller_reply ? 'Phản hồi của bạn (đang hiện công khai)' : 'Trả lời công khai'}</label>
            <textarea name="reply" maxlength="1000" rows="2" placeholder="Cảm ơn anh/chị đã phản hồi. Về vấn đề…">${esc(r.seller_reply ?? '')}</textarea>
            <div class="actions" style="margin-top:6px">
              <button class="btn alt sm" type="submit">${r.seller_reply ? 'Cập nhật phản hồi' : 'Gửi phản hồi'}</button>
              ${r.seller_reply ? '<span class="muted" style="font-size:.8rem">Xoá trắng ô rồi lưu để gỡ phản hồi.</span>' : ''}
            </div>
          </form>
        </div>
        <div class="actions" style="align-items:flex-start">
          ${activeStatus !== 'approved' ? `<form method="POST" action="${base}/${esc(r.id)}/approve"><button class="btn sm" type="submit">Duyệt</button></form>` : ''}
          ${activeStatus !== 'rejected' ? `<form method="POST" action="${base}/${esc(r.id)}/reject"><button class="btn alt sm" type="submit">Từ chối</button></form>` : ''}
          <form method="POST" action="${base}/${esc(r.id)}/delete"><button class="btn warn sm" type="submit">Xoá</button></form>
        </div>
      </div>
    </div>`).join('');
  return layout('Đánh giá', ctx, `<h1>Đánh giá sản phẩm</h1>
    <p class="muted">Đánh giá khách gửi chỉ hiện trên cửa hàng sau khi bạn <strong>duyệt</strong>. Đang chờ: <strong>${esc(String(data?.pending_count ?? 0))}</strong></p>
    <div class="actions" style="margin-bottom:14px">${tab('pending', 'Chờ duyệt')}${tab('approved', 'Đã duyệt')}${tab('rejected', 'Đã từ chối')}</div>
    ${rows || '<div class="card"><p class="muted">Không có đánh giá nào ở mục này.</p></div>'}`);
}

// ── Thông báo Telegram per-shop ───────────────────────────────────────────────
export function renderNotify(ctx, shopId, data, err, ok) {
  const base = `/shops/${esc(shopId)}/notify`;
  const d = data ?? {};
  if (!d.available) {
    return layout('Thông báo', ctx, `<h1>Thông báo</h1>
      <div class="card"><p class="muted">Nền tảng chưa bật kênh Telegram. Liên hệ quản trị nền tảng.</p></div>`);
  }
  const connected = !!d.connected, pending = !!d.pending;
  return layout('Thông báo', ctx, `<h1>Thông báo qua Telegram</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${ok ? `<div class="card" style="border-color:#86efac;background:#f0fdf4">${esc(ok)}</div>` : ''}
    ${connected ? `<div class="card" style="border-color:#86efac;background:#f0fdf4">
        <strong>✓ Đã kết nối Telegram</strong>
        <p class="muted" style="margin:8px 0 0">Cửa hàng sẽ nhận tin nhắn khi có: <strong>đơn mới · đã thanh toán · đơn huỷ · sắp hết hàng</strong> — ngay trên điện thoại.</p>
        <form method="POST" action="${base}/unlink" style="margin-top:10px"><button class="btn warn sm" type="submit">Ngắt kết nối</button></form>
      </div>` : ''}
    <div class="card"><h2 style="margin-top:0">${connected ? 'Kết nối lại / đổi máy' : 'Kết nối Telegram'}</h2>
      <p class="muted">Nhận thông báo đơn hàng + vận hành <strong>tận điện thoại</strong>, không cần mở máy tính. Miễn phí, 3 bước:</p>
      <ol class="muted" style="line-height:1.9">
        <li>Bấm nút bên dưới → mở đường link Telegram (cần cài app Telegram)</li>
        <li>Trong Telegram, bấm <strong>START / BẮT ĐẦU</strong> với bot của nền tảng</li>
        <li>Quay lại đây <strong>tải lại trang</strong> — sẽ thấy "Đã kết nối"</li>
      </ol>
      ${pending && d.deep_link ? `<div class="card" style="background:var(--surface,#f6f7f8)">
          <p style="margin:0 0 8px"><strong>Mã liên kết đã tạo</strong> — bấm mở Telegram:</p>
          <a class="btn" href="${esc(d.deep_link)}" target="_blank" rel="noopener">Mở Telegram & bấm START</a>
          <p class="muted" style="font-size:.82rem;margin:8px 0 0">Đường link: <code>${esc(d.deep_link)}</code> — mã dùng 1 lần, <strong>hết hạn sau 30 phút</strong> — bấm tạo lại nếu quá hạn.</p>
        </div>` : `<form method="POST" action="${base}/link"><button class="btn" type="submit">Tạo liên kết Telegram</button></form>`}
    </div>
    <div class="card"><p class="muted" style="margin:0;font-size:.85rem">Chưa có Telegram? Tải app "Telegram" trên điện thoại (miễn phí) rồi quay lại bước 1. Một máy nhận cho cả cửa hàng — kết nối máy mới sẽ THAY máy cũ.</p></div>`);
}

// ── Vận chuyển hãng (GHN/GHTK) — kết nối per-shop ─────────────────────────────
export function renderShipping(ctx, shopId, cfg, err, ok) {
  const base = `/shops/${esc(shopId)}/shipping`;
  const c = cfg ?? {};
  const p = c.pickup ?? {};
  if (c.available === false) {
    return layout('Vận chuyển', ctx, `<h1>Vận chuyển</h1>
      <div class="card"><p class="muted">Nền tảng chưa bật tích hợp hãng vận chuyển. Liên hệ quản trị nền tảng.</p></div>`);
  }
  const connected = !!c.connected;
  const status = connected
    ? `<div class="card" style="border-color:#86efac;background:#f0fdf4"><strong>✓ Đã kết nối ${esc((c.provider ?? '').toUpperCase())}</strong>
        <span class="muted"> · token ${esc(c.token_prefix ?? '')}…</span>
        <p class="muted" style="margin:8px 0 0">Điểm lấy hàng: ${esc([p.name, p.phone].filter(Boolean).join(' · '))}<br>${esc([p.address, p.ward, p.district, p.province].filter(Boolean).join(', '))}</p>
        <div class="actions" style="margin-top:10px">
          <a class="btn alt sm" href="${base}/test">Kiểm tra kết nối (0đ)</a>
          <form method="POST" action="${base}"><input type="hidden" name="__op" value="disconnect"><button class="btn warn sm" type="submit">Ngắt kết nối</button></form>
        </div>
        <p class="muted" style="font-size:.8rem;margin:8px 0 0">"Kiểm tra kết nối" chỉ hỏi phí ship của hãng — KHÔNG tạo đơn, KHÔNG tốn tiền.</p>
      </div>` : '';
  return layout('Hãng vận chuyển', ctx, `<h1>Hãng vận chuyển</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${ok ? `<div class="card" style="border-color:#86efac;background:#f0fdf4">${esc(ok)}</div>` : ''}
    <div class="card" style="background:#eff6ff;border-color:#bfdbfe">
      <p style="margin:0"><strong>Tìm phí giao hàng?</strong> Phí ship nội miền / liên miền / miễn phí từ bao nhiêu
        nằm ở <a href="/shops/${esc(shopId)}/settings#phi-ship"><strong>Cài đặt cửa hàng</strong></a>.</p>
      <p class="muted" style="margin:6px 0 0;font-size:.86rem">Trang này chỉ để nối <strong>tài khoản GHN/GHTK của bạn</strong> —
        dùng khi muốn hãng tới lấy hàng và tự theo dõi vận đơn. Không nối vẫn bán được bình thường (tự giao hoặc tự gọi hãng).</p>
    </div>
    ${status}
    <div class="card"><h2 style="margin-top:0">${connected ? 'Đổi kết nối' : 'Kết nối hãng vận chuyển'}</h2>
      <p class="muted">Dùng <strong>tài khoản GHN / GHTK của chính shop</strong>: lấy API token trong trang quản
        trị hãng rồi dán vào đây. Sau khi kết nối, mỗi đơn đã xác nhận sẽ có nút <strong>"Tạo vận đơn"</strong> —
        hãng trả mã vận đơn + phí, hệ thống tự theo dõi trạng thái tới khi giao xong. Token được
        <strong>mã hoá</strong> khi lưu; thao tác này cần xác nhận lại mật khẩu.</p>
      <form method="POST" action="${base}">
        <input type="hidden" name="__op" value="connect">
        <div class="grid2">
          <div><label>Hãng</label><select name="provider">
            <option value="ghtk"${c.provider === 'ghtk' ? ' selected' : ''}>GHTK (Giao Hàng Tiết Kiệm)</option>
            <option value="ghn"${c.provider === 'ghn' ? ' selected' : ''}>GHN (Giao Hàng Nhanh)</option>
          </select></div>
          <div><label>ShopId GHN (chỉ khi chọn GHN)</label><input name="ghn_shop_id" maxlength="20" inputmode="numeric" value="${esc(c.ghn_shop_id ?? '')}" placeholder="Dãy số trong trang GHN"></div>
        </div>
        <label>API Token của hãng</label><input name="token" type="password" required maxlength="300" autocomplete="off" placeholder="Dán token từ trang quản trị hãng">
        <h2 style="font-size:1rem">Điểm lấy hàng (hãng tới lấy tại đây)</h2>
        <div class="grid2">
          <div><label>Tên người gửi</label><input name="pick_name" required maxlength="100" value="${esc(p.name ?? '')}"></div>
          <div><label>SĐT</label><input name="pick_phone" required maxlength="20" value="${esc(p.phone ?? '')}"></div>
        </div>
        <label>Địa chỉ (số nhà, đường, phường/xã)</label><input name="pick_address" required maxlength="300" value="${esc(p.address ?? '')}">
        <div class="grid2">
          <div><label>Tỉnh / Thành</label><input name="pick_province" required maxlength="60" value="${esc(p.province ?? '')}"></div>
          <div><label>Quận / Huyện</label><input name="pick_district" required maxlength="60" value="${esc(p.district ?? '')}"></div>
        </div>
        <label>Phường / Xã (tuỳ chọn)</label><input name="pick_ward" maxlength="60" value="${esc(p.ward ?? '')}">
        <button class="btn" type="submit" style="margin-top:12px">${connected ? 'Cập nhật kết nối' : 'Kết nối'}</button>
      </form>
    </div>
    <div class="card"><h2 style="margin-top:0">Chưa có tài khoản hãng?</h2>
      <p class="muted">Đăng ký shop miễn phí tại trang của hãng (GHTK: khachhang.ghtk.vn · GHN: sso.ghn.vn),
        hoàn tất hồ sơ rồi lấy API token trong phần cài đặt/tích hợp. Tiền thu hộ COD hãng chuyển
        <strong>thẳng về tài khoản shop</strong> theo kỳ đối soát của hãng — nền tảng không giữ tiền.</p></div>`);
}

// Interstitial step-up cho kết nối/ngắt hãng VC — mang theo TOÀN BỘ form dưới dạng hidden.
export function renderShippingStepUp(ctx, shopId, fields, err) {
  const base = `/shops/${esc(shopId)}/shipping`;
  const keep = Object.entries(fields ?? {})
    .filter(([k, v]) => v != null && k !== 'password')
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(String(v))}">`).join('');
  const label = fields?.__op === 'disconnect' ? 'ngắt kết nối hãng vận chuyển' : 'kết nối hãng vận chuyển (lưu token)';
  return layout('Xác nhận mật khẩu', ctx, `<div class="center"><div class="card">
    <h1>Xác nhận mật khẩu</h1>
    <p class="muted">Thao tác nhạy cảm (${esc(label)}) cần xác thực lại. Nhập mật khẩu để tiếp tục.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="${base}/step-up">
      ${keep}
      <label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">
      <button class="btn" type="submit" style="width:100%;margin-top:12px">Xác nhận & tiếp tục</button>
    </form>
    <a class="muted" href="${base}" style="display:inline-block;margin-top:10px">← Huỷ</a>
  </div></div>`);
}

// Interstitial cho khoản chuyển khoản ghi nhận tay. Số tiền và ghi chú phải sống sót qua
// cổng mật khẩu; nếu làm rơi chúng, khoản 200.000đ có thể bị retry thành toàn bộ số còn thiếu.
export function renderOrderPayStepUp(ctx, shopId, oid, err, vals = {}) {
  const base = `/shops/${esc(shopId)}/orders/${esc(oid)}`;
  const amount = vals.amount_vnd == null ? '' : String(vals.amount_vnd);
  const note = String(vals.note ?? '');
  return layout('Xác nhận mật khẩu', ctx, `<div class="center"><div class="card">
    <h1>Xác nhận đã nhận tiền</h1>
    <p class="muted">Bạn xác nhận đã nhận được ${amount ? `<strong>${money(amount)}</strong>` : '<strong>phần còn thiếu</strong>'} cho đơn này. Đây là thao tác nhạy cảm
      (đánh dấu đã thanh toán thủ công) — nhập mật khẩu để tiếp tục. Chỉ làm khi bạn ĐÃ kiểm tra tiền về tài khoản.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="${base}/mark-paid-qr/step-up">
      <input type="hidden" name="amount_vnd" value="${esc(amount)}">
      <input type="hidden" name="note" value="${esc(note)}">
      <label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">
      <button class="btn" type="submit" style="width:100%;margin-top:12px">Xác nhận đã nhận tiền</button>
    </form>
    <a class="muted" href="${base}" style="display:inline-block;margin-top:10px">← Huỷ</a>
  </div></div>`);
}
// Interstitial cho hoàn tiền (thao tác nhạy cảm — mang theo mã đơn).
// vals {amount_vnd, reason} từ form chi tiết đơn SỐNG SÓT qua hidden input — không gõ lại.
export function renderRefundConfirm(ctx, shopId, oid, err, vals, requirePassword) {
  const base = `/shops/${esc(shopId)}/orders/${esc(oid)}`;
  const amount = String(vals?.amount_vnd ?? '').trim();
  const partial = amount !== '';
  return layout('Xác nhận hoàn tiền', ctx, `<div class="center"><div class="card">
    <h1>Xác nhận hoàn tiền</h1>
    <p class="muted">${partial
      ? `Bạn sẽ ghi nhận hoàn <strong>${esc(amount)}đ</strong> cho khách (hoàn MỘT PHẦN — đơn giữ nguyên trạng thái cho tới khi hoàn đủ tổng).`
      : `Bạn sẽ hoàn <strong>TOÀN BỘ số còn lại</strong> của đơn và đánh dấu <strong>ĐÃ HOÀN TIỀN</strong>. Nếu đơn <strong>chưa giao</strong>, hàng sẽ được trả lại kho.`}
      Hãy đảm bảo đã thực sự chuyển/trả tiền. Thao tác không thể hoàn tác.${requirePassword ? ' Phiên xác thực đã hết hạn nên cần nhập lại mật khẩu.' : ' Phiên xác thực vẫn còn hiệu lực; hãy kiểm tra lần cuối trước khi ghi chứng từ.'}</p>
    <dl style="display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin:14px 0">
      <dt class="muted">Số tiền</dt><dd style="margin:0"><strong>${partial ? esc(`${amount}đ`) : 'Toàn bộ số còn lại'}</strong></dd>
      <dt class="muted">Lý do</dt><dd style="margin:0">${esc(vals?.reason ?? '') || '<span class="muted">Không ghi lý do</span>'}</dd>
    </dl>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="${base}/refund/confirm">
      <input type="hidden" name="amount_vnd" value="${esc(amount)}">
      <input type="hidden" name="reason" value="${esc(vals?.reason ?? '')}">
      <input type="hidden" name="idempotency_key" value="${esc(vals?.idempotency_key ?? '')}">
      ${requirePassword ? '<label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">' : ''}
      <button class="btn warn" type="submit" data-busy="Đang ghi phiếu hoàn…" style="width:100%;margin-top:12px">Xác nhận hoàn tiền</button>
    </form>
    <a class="muted" href="${base}" style="display:inline-block;margin-top:10px">← Huỷ</a>
  </div></div>`);
}

// ── Chấp nhận lời mời (CÔNG KHAI — người được mời chưa có phiên) ──────────────
export function renderInviteAccept(token, err) {
  return layout('Chấp nhận lời mời', {}, `<div class="center"><div class="card">
    <h1>Tham gia cửa hàng</h1>
    <p class="muted">Bạn được mời làm nhân sự. Đặt mật khẩu để tạo tài khoản và tham gia.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="/invite/accept">
      <input type="hidden" name="token" value="${esc(token)}">
      <label>Mật khẩu (tối thiểu 10 ký tự)</label><input name="password" type="password" required minlength="10" autocomplete="new-password">
      <button class="btn" type="submit" style="width:100%;margin-top:12px">Tạo tài khoản & tham gia</button>
    </form>
    <p class="muted" style="font-size:.82rem;margin-top:10px">Email này đã có tài khoản? <a href="/login">Đăng nhập</a> trước rồi mở lại link mời.</p>
  </div></div>`);
}

export function renderInviteDone(kind) {
  const T = {
    created: ['Đã tham gia cửa hàng 🎉', 'Tài khoản của bạn đã được tạo và bạn đã tham gia cửa hàng. Đăng nhập để bắt đầu.'],
    joined: ['Đã tham gia cửa hàng 🎉', 'Bạn đã tham gia cửa hàng. Đăng nhập để bắt đầu.'],
    login_required: ['Cần đăng nhập trước', 'Email này đã có tài khoản. Hãy đăng nhập bằng tài khoản đó rồi mở lại link mời để tham gia.'],
  }[kind] ?? ['Lời mời', ''];
  return layout('Lời mời', {}, `<div class="center"><div class="card">
    <h1>${esc(T[0])}</h1><p class="muted">${esc(T[1])}</p>
    <a class="btn" href="/login">Đăng nhập</a></div></div>`);
}

// ── Quên mật khẩu (CÔNG KHAI — mirror renderInviteAccept: layout({}) → authwrap) ──
export function renderForgot(err) {
  return authSplit('Quên mật khẩu', `<h1>Quên mật khẩu?</h1>
    <p class="au-sub">Nhập email tài khoản. Chúng tôi gửi link đặt lại vào hộp thư của bạn — đó cũng là cách xác thực bạn đúng là chủ tài khoản.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="/forgot">
      <label for="au-fe">Email <span class="rq">*</span></label>
      <input id="au-fe" name="email" type="email" required autocomplete="username" placeholder="ban@email.com" autofocus>
      <button class="au-btn" type="submit">Gửi link đặt lại</button>
    </form>
    <a class="au-back" href="/login">← Quay lại đăng nhập</a>`, { heading: 'Lấy lại quyền vào<br><em>trong một phút</em>' });
}
export function renderForgotDone() {
  // Trung tính: KHÔNG tiết lộ email có tồn tại hay không (chống dò tài khoản).
  return authSplit('Quên mật khẩu', `<div class="au-ok">${AU_MAIL}</div>
    <h1>Kiểm tra hộp thư</h1>
    <p class="au-sub">Nếu email vừa nhập có tài khoản, chúng tôi đã gửi link đặt lại mật khẩu. Link hết hạn sau <strong>30 phút</strong>. Nhớ xem cả mục spam.</p>
    <a class="au-btn alt" href="/login">Về trang đăng nhập</a>`, { heading: 'Đã gửi link<br><em>vào email của bạn</em>' });
}
export function renderReset(token, err) {
  return authSplit('Đặt lại mật khẩu', `<h1>Đặt mật khẩu mới</h1>
    <p class="au-sub">Chọn mật khẩu dài và khó đoán. Mọi phiên đăng nhập cũ sẽ bị đăng xuất.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="/reset">
      <input type="hidden" name="token" value="${esc(token)}">
      <label for="au-np">Mật khẩu mới <span class="rq">*</span></label>
      <input id="au-np" name="password" type="password" required minlength="10" autocomplete="new-password" autofocus>
      <p class="au-hint">Tối thiểu 10 ký tự.</p>
      <button class="au-btn" type="submit">Đặt lại mật khẩu</button>
    </form>`, { heading: 'Đặt mật khẩu mới<br><em>rồi bán tiếp</em>' });
}
export function renderResetDone() {
  return authSplit('Đặt lại mật khẩu', `<div class="au-ok">${AU_TICK}</div>
    <h1>Đã đổi mật khẩu</h1>
    <p class="au-sub">Mật khẩu đã được đặt lại và mọi phiên cũ đã bị đăng xuất. Đăng nhập lại bằng mật khẩu mới.</p>
    <a class="au-btn" href="/login">Đăng nhập</a>`, { heading: 'Xong rồi<br><em>mời bạn vào lại</em>' });
}

// ── ĐỐI SOÁT COD với hãng (đường tiền: đơn COD giao-qua-hãng, kỳ vọng = tổng − phí hãng) ──
// No-JS multi-select: ô tick "order_ids" ở cột đầu bảng "đang chờ" gắn form="codf" (thuộc
// tính form HTML5) → cùng POST với form "Ghi phiếu chuyển tiền" dù nằm ngoài <form> — GIỐNG
// bulk xác nhận đơn (renderOrders). CHỈ chủ shop (payment.write) thấy ô tick + form ghi phiếu;
// vai trò khác xem danh sách chờ + lịch sử ở chế độ chỉ-đọc.
export function renderCodReconcile(ctx, shopId, data, isOwner, done, err) {
  const base = `/shops/${esc(shopId)}`;
  const outstanding = data.outstanding ?? [];
  const byCarrier = data.by_carrier ?? [];
  const remittances = data.remittances ?? [];
  const provOf = (p) => (p ? String(p).toUpperCase() : '—');
  // Hãng phân biệt trong danh sách chờ → gợi ý cho ô chọn hãng của phiếu (vẫn cho để trống).
  const providers = [...new Set(outstanding.map((o) => o.provider).filter(Boolean))];
  const carrierCards = byCarrier.map((c) => `<div class="metric"><div class="l">${esc(provOf(c.provider))} · ${esc(c.count)} đơn</div>
    <div class="v">${money(c.expected_vnd)}</div></div>`).join('');
  // Cột checkbox chỉ có với chủ shop, nên nó phải vắng mặt ở CẢ head lẫn rows — cùng một
  // cờ `isOwner` sinh cả hai, không chép hai bản điều kiện.
  const rows = outstanding.map((o) => [
    ...(isOwner ? [{ label: '', html: `<input type="checkbox" name="order_ids" value="${esc(o.id)}" form="codf" aria-label="Chọn đơn ${esc(o.order_number)}">` }] : []),
    { html: `<a href="${base}/orders/${esc(o.id)}">#${esc(o.order_number)}</a>` },
    { cls: 'muted', html: dt(o.delivered_at) },
    { html: `${esc(provOf(o.provider))}${o.carrier ? ` <span class="muted">${esc(o.carrier)}</span>` : ''}` },
    { cls: 'right num', html: money(o.total_vnd) },
    { cls: 'right num muted', html: money(o.carrier_fee_vnd) },
    { cls: 'right num', html: `<strong>${money(o.expected_net_vnd)}</strong>` },
  ]);
  const colspan = isOwner ? 7 : 6;
  // Banner thành công sau khi ghi phiếu (kỳ vọng vs thực nhận + chênh lệch).
  const disc = done ? Number(done.disc) : 0;
  const doneNotice = done ? `<div class="notice success">✓ Đã ghi phiếu chuyển tiền cho <strong>${esc(done.count)} đơn</strong> — kỳ vọng ${money(done.expected)}, thực nhận <strong>${money(done.received)}</strong>, chênh lệch <strong>${money(disc)}</strong> ${disc < 0 ? '(hãng còn nợ)' : '(đủ/dư)'}.</div>` : '';
  const recordCard = isOwner ? `
    <div class="card"><h2 style="margin-top:0">Ghi phiếu chuyển tiền</h2>
      <p class="muted" style="margin-top:-4px">Tick các đơn hãng vừa chuyển tiền ở bảng trên, nhập <strong>số tiền THỰC nhận</strong> rồi ghi phiếu. Hệ thống so với kỳ vọng và tính <strong>chênh lệch</strong> (âm = hãng còn nợ).</p>
      <form id="codf" method="POST" action="${base}/cod/remittances">
        <div class="grid2">
          <div><label>Hãng (tuỳ chọn)</label>
            <select name="carrier"><option value="">— Không xác định / tất cả —</option>
              ${providers.map((pv) => `<option value="${esc(pv)}">${esc(provOf(pv))}</option>`).join('')}</select></div>
          <div><label>Số tiền THỰC nhận (đ)</label><input name="amount_vnd" inputmode="numeric" required placeholder="vd 520000"></div>
        </div>
        <div class="grid2">
          <div><label>Ngày nhận (tuỳ chọn)</label><input name="remitted_at" type="date"></div>
          <div><label>Ghi chú (tuỳ chọn)</label><input name="note" maxlength="500" placeholder="sao kê GHN 18/07…"></div>
        </div>
        <button class="btn" type="submit" style="margin-top:12px">Ghi phiếu chuyển tiền</button>
      </form>
    </div>` : '';
  const histRows = remittances.map((r) => {
    const d = Number(r.discrepancy_vnd);
    return [
      { cls: 'muted', html: dt(r.remitted_at ?? r.created_at) },
      { html: esc(provOf(r.carrier)) },
      { cls: 'num', html: esc(r.order_count) },
      { cls: 'right num', html: money(r.expected_vnd) },
      { cls: 'right num', html: `<strong>${money(r.amount_vnd)}</strong>` },
      { cls: 'right num', style: `color:${d < 0 ? 'var(--bad)' : 'var(--good)'};font-weight:700`, html: money(d) },
      { html: esc(r.note ?? '') || '<span class="muted">—</span>' },
      { cls: 'muted', html: esc(r.created_by_email ?? '—') },
    ];
  });
  return layout('Đối soát COD', ctx, `
    <h1>Đối soát COD với hãng</h1>
    <p class="muted" style="margin-top:-6px">Đơn COD đã giao qua hãng — hãng thu hộ tiền rồi chuyển lại (đã trừ phí). <strong>Kỳ vọng nhận = tổng đơn − phí hãng</strong>. Đối chiếu với số hãng thực chuyển để phát hiện thiếu/thất thoát.</p>
    ${doneNotice}
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <div class="metrics">
      <div class="metric" style="border-color:color-mix(in srgb,var(--pri) 30%,var(--bd))"><div class="l">Tổng đang chờ đối soát</div>
        <div class="v">${money(data.total_outstanding_vnd ?? 0)}</div></div>
      ${carrierCards}
    </div>
    <div class="card"><h2 style="margin-top:0">Đơn chờ đối soát (${esc(outstanding.length)})</h2>
      ${outstanding.length ? `${tblCards({
        head: [
          ...(isOwner ? [{ html: '', label: '' }] : []),
          { html: 'Đơn' }, { html: 'Ngày giao' }, { html: 'Hãng' },
          { html: 'Tổng COD', cls: 'right' }, { html: 'Phí hãng', cls: 'right' }, { html: 'Kỳ vọng nhận', cls: 'right' },
        ],
        rows,
        foot: [[
          { colspan: colspan - 1, cls: 'muted', html: 'Tổng kỳ vọng' },
          { cls: 'right num', html: `<strong>${money(data.total_outstanding_vnd ?? 0)}</strong>` },
        ]],
      })}
        ${isOwner ? '<p class="muted" style="margin:12px 0 0;font-size:.85rem">Tick các đơn thuộc phiếu chuyển tiền của hãng ở cột đầu, rồi ghi phiếu bên dưới.</p>' : '<p class="muted" style="margin:12px 0 0;font-size:.85rem">Chỉ chủ cửa hàng mới ghi được phiếu chuyển tiền.</p>'}`
        : '<p class="muted">Không có đơn COD nào đang chờ đối soát.</p>'}
    </div>
    ${recordCard}
    <div class="card"><h2 style="margin-top:0">Lịch sử đối soát</h2>
      ${remittances.length ? `${tblCards({
        head: [
          { html: 'Ngày' }, { html: 'Hãng' }, { html: 'Số đơn' }, { html: 'Kỳ vọng', cls: 'right' },
          { html: 'Thực nhận', cls: 'right' }, { html: 'Chênh lệch', cls: 'right' }, { html: 'Ghi chú' }, { html: 'Người ghi' },
        ],
        rows: histRows,
      })}
        <p class="muted" style="margin:12px 0 0;font-size:.85rem">Chênh lệch <span style="color:var(--bad);font-weight:700">âm (đỏ)</span> = hãng còn nợ; <span style="color:var(--good);font-weight:700">≥0 (xanh)</span> = đủ/dư.</p>`
        : '<p class="muted">Chưa có phiếu đối soát nào.</p>'}
    </div>
    <a class="btn alt" href="${base}/overview">← Về tổng quan</a>`);
}

// ── NHẬP HÀNG (0085): NCC + phiếu nhập + kiểm kê + báo cáo nhập ────────────────
const PO_STATUS = { draft: 'Nháp', ordered: 'Đã đặt', received: 'Đã nhận', cancelled: 'Đã huỷ' };
const PO_BADGE = { draft: 'draft', ordered: 'confirmed', received: 'delivered', cancelled: 'cancelled' };
const ST_STATUS = { counting: 'Đang đếm', completed: 'Đã chốt', cancelled: 'Đã huỷ' };
const ST_BADGE = { counting: 'draft', completed: 'delivered', cancelled: 'cancelled' };
// Thanh điều hướng phụ dùng chung cho khu Kho.
function invTabs(shopId, active) {
  const base = `/shops/${esc(shopId)}`;
  const t = (href, label, on) => `<a class="btn ${on ? '' : 'alt '}sm" href="${href}">${label}</a>`;
  return `<div class="actions" style="flex-wrap:wrap;margin-bottom:16px">
    ${t(`${base}/purchasing`, 'Phiếu nhập', active === 'po')}
    ${t(`${base}/suppliers`, 'Nhà cung cấp', active === 'suppliers')}
    ${t(`${base}/stocktakes`, 'Kiểm kê', active === 'stocktakes')}
    ${t(`${base}/purchasing/report`, 'Báo cáo nhập', active === 'report')}
    ${t(`${base}/inventory-ledger`, 'Sổ cái kho', active === 'ledger')}
    ${t(`${base}/safety-stock`, 'Tồn an toàn', active === 'safety')}
  </div>`;
}

// ── TỒN AN TOÀN (0140) ───────────────────────────────────────────────────────
// Trang này trả lời đúng một câu hỏi mà MỌI người bán hỏi khi mở web bán hàng: "lỡ web bán
// mất món cuối cùng mà kho đã hết thì sao?" — chừa lại một phần tồn không bán online.
//
// BA CON SỐ phải nằm CẠNH NHAU trên cùng một dòng. Nếu chỉ hiện "còn bán được", người bán mở
// kho thấy 100 cái mà web nói 80 sẽ tin là hệ thống đếm sai — rồi tắt tính năng. Bốn cột
// (tồn thực · đang giữ chỗ · giữ an toàn · còn bán được online) khép kín phép trừ, tự giải thích.
const OK_MSG = { pct: 'Đã lưu tỉ lệ giữ an toàn cho toàn shop.', override: 'Đã lưu mức giữ riêng cho biến thể.' };
export function renderSafetyStock(ctx, shopId, data, opt) {
  const base = `/shops/${esc(shopId)}`;
  const rows = data?.rows ?? [];
  const pct = Number(data?.safety_stock_pct ?? 0);
  const off = opt.offset, lim = opt.limit;
  const body = rows.map((r) => {
    const ov = r.safety_override;
    return [
      { html: `${esc(r.product_title)}${r.variant_title ? ` <span class="muted">${esc(r.variant_title)}</span>` : ''}
        ${r.sku ? `<div class="muted" style="font-size:.8rem">${esc(r.sku)}</div>` : ''}` },
      { cls: 'num right', html: esc(r.on_hand) },
      { cls: 'num right muted', html: esc(r.reserved) },
      { cls: 'num right', html: `${esc(r.safety_effective)}${ov != null ? ' <span class="muted" style="font-size:.75rem">(riêng)</span>' : ''}` },
      { cls: 'num right', html: `<strong>${esc(r.available_online)}</strong>` },
      { cls: 'num right', html: Number(r.blocked_count) > 0 ? `<strong style="color:var(--bad)">${esc(r.blocked_count)}</strong>` : '<span class="muted">0</span>' },
      { html: `<form method="POST" action="${base}/safety-stock/override" class="actions" style="gap:6px">
        <input type="hidden" name="variant_id" value="${esc(r.variant_id)}">
        <input class="sm" type="number" name="safety_stock_qty" min="0" step="1" style="width:80px"
               value="${ov != null ? esc(ov) : ''}" placeholder="theo tỉ lệ" aria-label="Giữ riêng cho ${esc(r.product_title)}">
        <button class="btn alt sm" type="submit">Lưu</button>
      </form>` },
    ];
  });
  const nav = (o) => `?offset=${o}`;
  return layout('Tồn an toàn', ctx, `
    <h1>Tồn an toàn</h1>
    ${invTabs(shopId, 'safety')}
    ${opt.notice && OK_MSG[opt.notice] ? `<div class="ok">${OK_MSG[opt.notice]}</div>` : ''}
    ${opt.err ? `<div class="err">${esc(opt.err)}</div>` : ''}
    <p class="muted" style="margin-top:-8px">Chừa lại một phần tồn <strong>không bán trên web</strong>, để hàng vỡ,
      hàng bán tại quầy hay đếm sai không làm khách đặt trúng món đã hết.
      Vùng đệm chỉ chặn <strong>khách tự đặt trên web</strong> — bạn tạo <strong>đơn tay</strong> thì vẫn bán được
      tới con số tồn thực, vì lúc đó bạn đang nhìn thấy kho.</p>
    <div class="card">
      <form method="POST" action="${base}/safety-stock" class="filters">
        <div><label>Tỉ lệ giữ an toàn cho toàn shop (%)</label>
          <input type="number" name="safety_stock_pct" min="0" max="90" step="1" value="${esc(pct)}" style="width:110px">
          <div class="muted" style="font-size:.8rem">0 = tắt. Ví dụ 20% thì kho 100 cái chỉ bán online 80.</div>
        </div>
        <div><button class="btn sm" type="submit">Lưu tỉ lệ</button></div>
      </form>
    </div>
    <div class="card">${rows.length ? `<div class="tblscroll">${tblCards({
      head: [
        { html: 'Sản phẩm' },
        { html: 'Tồn thực', cls: 'right' },
        { html: 'Đang giữ chỗ', cls: 'right' },
        { html: 'Giữ an toàn', cls: 'right' },
        { html: 'Còn bán được online', cls: 'right' },
        { html: 'Số lần bị chặn', cls: 'right' },
        { html: 'Giữ riêng (số cái)' },
      ],
      rows: body,
    })}</div>
      <p class="muted" style="margin-top:12px;font-size:.85rem">
        <strong>Còn bán được online = Tồn thực − Đang giữ chỗ − Giữ an toàn</strong> (không âm).
        Ô <em>Giữ riêng</em> để trống nghĩa là dùng tỉ lệ chung; gõ <code>0</code> nghĩa là sản phẩm này không giữ lại gì cả.
        <strong>Số lần bị chặn</strong> đếm những lần khách bị vùng đệm chặn <em>trong khi kho vẫn còn hàng</em> —
        số này cao ở đâu thì cân nhắc hạ mức giữ ở đó.</p>
      <div class="muted" style="margin-top:12px">
        ${off > 0 ? `<a href="${nav(Math.max(0, off - lim))}">← Trang trước</a>` : '<span style="color:#d1d5db">← Trang trước</span>'} ·
        ${data?.has_more ? `<a href="${nav(off + lim)}">Trang sau →</a>` : '<span style="color:#d1d5db">Trang sau →</span>'}
      </div>` : '<p class="muted">Chưa có biến thể nào.</p>'}</div>`);
}

// ── SỔ CÁI KHO (0097) — mọi chuyển động tồn của cả shop, mới nhất trước ───────
// Chủ shop chỉnh tồn được từ lâu nhưng KHÔNG truy vết được ai/khi nào/vì sao. Dữ liệu vẫn
// luôn được ghi (inventory_ledger từ 0009), chỉ là chưa từng có màn hình nào đọc nó.
//
// Sổ cái là CHỈ-GHI-THÊM ở tầng DB (app_rw bị REVOKE UPDATE/DELETE) → trang này THUẦN
// CHỈ-ĐỌC, không nút sửa/xoá. Muốn "đính chính" thì tạo dòng điều chỉnh mới.
const LEDGER_KIND = { receive: 'Nhập kho', ship: 'Xuất kho', adjust: 'Điều chỉnh' };
const LEDGER_BADGE = { receive: 'delivered', ship: 'shipped', adjust: 'draft' };
export function renderInventoryLedger(ctx, shopId, data, filter) {
  const base = `/shops/${esc(shopId)}`;
  const entries = data?.entries ?? [];
  const off = filter.offset, lim = filter.limit;
  const keep = `&kind=${esc(filter.kind ?? '')}${filter.variantId ? `&variant_id=${esc(filter.variantId)}` : ''}`;
  const nav = (o) => `?offset=${o}${keep}`;
  const rows = entries.map((e) => {
    const d = Number(e.delta);
    const name = e.product_title
      ? `${esc(e.product_title)}${e.variant_title ? ` <span class="muted">${esc(e.variant_title)}</span>` : ''}`
      : '<span class="muted">(biến thể đã xoá)</span>';
    return [
      { cls: 'muted', html: dt(e.created_at) },
      { html: `${name}${e.sku ? `<div class="muted" style="font-size:.8rem">${esc(e.sku)}</div>` : ''}` },
      { html: badge(LEDGER_BADGE[e.kind] ?? 'draft', LEDGER_KIND[e.kind] ?? e.kind) },
      { cls: 'num right', html: `<strong style="color:${d > 0 ? 'var(--good)' : 'var(--bad)'}">${d > 0 ? '+' : ''}${esc(d)}</strong>` },
      { html: e.reason ? esc(e.reason) : '<span class="muted">—</span>' },
      { cls: 'muted', html: e.actor_email ? esc(e.actor_email) : '<span class="muted">hệ thống</span>' },
    ];
  });
  const kOpt = (v, l) => `<option value="${v}"${(filter.kind ?? '') === v ? ' selected' : ''}>${l}</option>`;
  return layout('Sổ cái kho', ctx, `
    <h1>Sổ cái kho</h1>
    ${invTabs(shopId, 'ledger')}
    <p class="muted" style="margin-top:-8px">Mọi thay đổi tồn kho đều được ghi lại và <strong>không sửa/xoá được</strong>.
      Hàng đang giữ chỗ cho đơn chưa chốt <strong>không</strong> tạo dòng ở đây (chỉ khoá tồn, chưa xuất kho).
      Tên sản phẩm là tên <strong>hiện tại</strong>, có thể khác lúc phát sinh.</p>
    <div class="card"><form method="GET" class="filters">
      <div><label>Loại</label><select name="kind">${kOpt('', 'Tất cả')}${kOpt('receive', 'Nhập kho')}${kOpt('ship', 'Xuất kho')}${kOpt('adjust', 'Điều chỉnh')}</select></div>
      ${filter.variantId ? `<input type="hidden" name="variant_id" value="${esc(filter.variantId)}">` : ''}
      <div><button class="btn alt sm" type="submit">Lọc</button></div>
      ${filter.variantId ? `<div><a class="btn alt sm" href="${base}/inventory-ledger">Bỏ lọc 1 biến thể</a></div>` : ''}
    </form></div>
    <div class="card">${entries.length ? `<div class="tblscroll">${tblCards({
      head: [{ html: 'Thời điểm' }, { html: 'Sản phẩm' }, { html: 'Loại' }, { html: 'Thay đổi', cls: 'right' }, { html: 'Lý do' }, { html: 'Người thực hiện' }],
      rows,
    })}</div>
      <div class="muted" style="margin-top:12px">
        ${off > 0 ? `<a href="${nav(Math.max(0, off - lim))}">← Mới hơn</a>` : '<span style="color:#d1d5db">← Mới hơn</span>'} ·
        ${data?.has_more ? `<a href="${nav(off + lim)}">Cũ hơn →</a>` : '<span style="color:#d1d5db">Cũ hơn →</span>'}
      </div>` : '<p class="muted">Chưa có chuyển động kho nào khớp bộ lọc.</p>'}</div>`);
}

/* CÔNG NỢ KHÁCH — một màn hình trả lời đúng một câu: "tôi còn nợ khách bao nhiêu".
 *
 * Trước khi có trang này, câu trả lời không tồn tại ở đâu cả. Số tiền nằm rải trong từng đơn,
 * và chủ shop chỉ biết mình nợ khi khách gọi tới đòi — lúc đó thì mất khách rồi. Đo trên shop
 * ngày-60: 6.050.000₫ trên 11 đơn, không màn hình nào nói ra được.
 *
 * Bố cục cố ý ĐẢO so với các trang danh sách khác: con số TỔNG đứng trước, to, ngay đầu trang.
 * Bảng bên dưới chỉ để trả lời câu hỏi tiếp theo ("nợ ai, vì sao"). Người mở trang này đang
 * cần một con số để quyết định, không cần một bảng để đọc.
 */
export function renderOwed(ctx, shopId, data) {
  const base = `/shops/${esc(shopId)}`;
  const list = data?.orders ?? [];
  const tong = Number(data?.total_owed_vnd ?? 0);
  const rows = list.map((o) => [
    { html: `<a href="${base}/orders/${esc(o.id)}">#${esc(o.order_number)}</a>` },
    { html: `${esc(o.customer_name ?? '')}${o.customer_phone ? `<div class="muted" style="font-size:.8rem">${esc(o.customer_phone)}</div>` : ''}` },
    { html: badge(o.status === 'cancelled' ? 'draft' : 'warn', STATUS[o.status] ?? o.status) },
    { cls: 'muted', html: esc(OWED_WHY[o.owed_reason] ?? '—') },
    { cls: 'right num muted', html: money(o.amount_paid_vnd) },
    { cls: 'right num muted', html: money(o.refunded_vnd) },
    { cls: 'right num', html: `<strong style="color:var(--bad)">${money(o.owed_vnd)}</strong>` },
    { cls: 'muted', html: dt(o.since) },
    { html: `<a class="btn alt sm" href="${base}/orders/${esc(o.id)}">Xử lý →</a>` },
  ]);
  const heading = tong > 0
    ? `<div class="card" style="border-color:var(--bad);background:var(--badbg)">
         <div class="muted" style="font-size:.9rem">Tổng tiền của khách đang nằm ở cửa hàng</div>
         <div style="font-size:2.4rem;font-weight:700;color:var(--bad);line-height:1.2">${money(tong)}</div>
         <div class="muted">${esc(data.count)} đơn cần trả lại tiền. Chuyển khoản cho khách rồi bấm <em>Hoàn tiền</em> trong từng đơn để ghi nhận — dòng đó sẽ tự rời khỏi danh sách này.</div>
       </div>`
    : `<div class="card"><div style="font-size:1.4rem;font-weight:600">Không nợ khách đồng nào</div>
         <p class="muted" style="margin:6px 0 0">Mọi khoản đã thu đều tương ứng với đơn còn hiệu lực, hoặc đã hoàn đủ cho khách.</p></div>`;
  return layout('Công nợ khách', ctx, `
    <div class="toolbar"><h1 style="margin:0">Còn nợ khách</h1>
      <a class="btn alt sm" href="${base}/orders">Danh sách đơn →</a></div>
    ${heading}
    ${list.length ? `<div class="card"><div class="tblscroll">${tblCards({
      head: [
        { html: 'Đơn' }, { html: 'Khách' }, { html: 'Trạng thái' }, { html: 'Vì sao còn nợ' },
        { html: 'Đã thu', cls: 'right' }, { html: 'Đã hoàn', cls: 'right' }, { html: 'Còn nợ', cls: 'right' },
        { html: 'Từ' }, { html: '', label: '' },
      ],
      rows,
    })}</div>
      ${data.truncated ? '<p class="muted" style="margin:12px 0 0">⚠ Danh sách bị cắt ở 500 đơn — con số tổng phía trên vẫn tính trên TOÀN BỘ đơn.</p>' : ''}
    </div>` : ''}`);
}

// Danh sách phiếu nhập.
export function renderPurchasing(ctx, shopId, data, filter) {
  const base = `/shops/${esc(shopId)}`;
  const pos = data.purchase_orders ?? [];
  const cur = filter?.status ?? '';
  const tab = (val, label) => `<a class="btn ${cur === val ? '' : 'alt '}sm" href="${base}/purchasing${val ? `?status=${val}` : ''}">${label}</a>`;
  const rows = pos.map((o) => [
    { html: `<a href="${base}/purchasing/${esc(o.id)}">#${esc(o.po_number)}</a>` },
    { html: badge(PO_BADGE[o.status], PO_STATUS[o.status] ?? o.status) },
    { html: esc(o.supplier_name) },
    { cls: 'right num', html: esc(o.line_count) },
    { cls: 'right num', html: `<strong>${money(o.subtotal_vnd)}</strong>` },
    { cls: 'muted', html: o.received_at ? dt(o.received_at) : dt(o.created_at) },
  ]);
  return layout('Phiếu nhập', ctx, `${invTabs(shopId, 'po')}
    <div class="toolbar"><h1 style="margin:0">Phiếu nhập hàng</h1>
      <a class="btn" href="${base}/purchasing/new">+ Tạo phiếu nhập</a></div>
    <div class="actions" style="flex-wrap:wrap;margin-bottom:12px">${tab('', 'Tất cả')}${tab('draft', 'Nháp')}${tab('ordered', 'Đã đặt')}${tab('received', 'Đã nhận')}${tab('cancelled', 'Đã huỷ')}</div>
    <div class="card">${pos.length ? `${tblCards({
      head: [{ html: 'Phiếu' }, { html: 'Trạng thái' }, { html: 'Nhà cung cấp' }, { html: 'Dòng', cls: 'right' }, { html: 'Trị giá', cls: 'right' }, { html: 'Ngày' }],
      rows,
    })}${data.truncated ? '<p class="muted" style="margin:12px 0 0">⚠ Hiện 200 phiếu gần nhất.</p>' : ''}` : '<p class="muted" style="margin:0">Chưa có phiếu nhập nào. Tạo phiếu để nhập kho + cập nhật giá vốn.</p>'}</div>`);
}

// Nhà cung cấp: danh sách + form tạo/sửa (inline).
export function renderSuppliers(ctx, shopId, suppliers, opts = {}) {
  const base = `/shops/${esc(shopId)}`;
  const ed = opts.editing; // đối tượng NCC đang sửa (nếu có)
  const list = suppliers ?? [];
  const rows = list.map((s) => ({
    attrs: s.is_active ? '' : ' style="opacity:.55"',
    cells: [
      { html: `<a href="${base}/suppliers?edit=${esc(s.id)}">${esc(s.name)}</a>${s.is_active ? '' : ' <span class="badge archived">Đã ẩn</span>'}` },
      { cls: 'muted', html: `${esc(s.phone ?? '') || '—'}` },
      { cls: 'muted', html: `${esc(s.contact ?? '') || '—'}` },
      { cls: 'muted', html: `${esc(s.email ?? '') || '—'}` },
    ],
  }));
  const f = (k) => esc(ed?.[k] ?? '');
  const formCard = `<div class="card"><h2 style="margin-top:0">${ed ? `Sửa: ${esc(ed.name)}` : 'Thêm nhà cung cấp'}</h2>
    <form method="POST" action="${base}/suppliers${ed ? `/${esc(ed.id)}` : ''}">
      <div class="grid2">
        <div><label>Tên NCC *</label><input name="name" required maxlength="200" value="${f('name')}"></div>
        <div><label>SĐT</label><input name="phone" maxlength="40" value="${f('phone')}"></div>
      </div>
      <div class="grid2">
        <div><label>Người liên hệ</label><input name="contact" maxlength="200" value="${f('contact')}"></div>
        <div><label>Email</label><input name="email" type="email" maxlength="200" value="${f('email')}"></div>
      </div>
      <label>Địa chỉ</label><input name="address" maxlength="500" value="${f('address')}">
      <label>Ghi chú</label><input name="note" maxlength="1000" value="${f('note')}">
      ${ed ? `<label style="display:flex;gap:8px;align-items:center;font-weight:500;margin-top:8px"><input type="checkbox" name="is_active" value="1"${ed.is_active ? ' checked' : ''} style="width:auto"> Đang hoạt động (bỏ tick = ẩn khỏi danh sách chọn)</label>` : ''}
      <div class="actions" style="margin-top:12px"><button class="btn" type="submit">${ed ? 'Lưu' : 'Thêm NCC'}</button>${ed ? `<a class="btn alt" href="${base}/suppliers">Huỷ</a>` : ''}</div>
    </form></div>`;
  return layout('Nhà cung cấp', ctx, `${invTabs(shopId, 'suppliers')}
    <h1>Nhà cung cấp</h1>
    ${opts.err ? `<div class="err">${esc(opts.err)}</div>` : ''}
    ${opts.notice ? `<div class="notice success">${esc(opts.notice)}</div>` : ''}
    ${formCard}
    <div class="card"><div class="toolbar"><h2 style="margin:0">Danh sách</h2>
      <a class="btn alt sm" href="${base}/suppliers${opts.showInactive ? '' : '?all=1'}">${opts.showInactive ? 'Chỉ NCC hoạt động' : 'Hiện cả NCC đã ẩn'}</a></div>
      ${list.length ? tblCards({
    head: [{ html: 'Tên' }, { html: 'SĐT' }, { html: 'Liên hệ' }, { html: 'Email' }],
    rows,
  }) : '<p class="muted" style="margin:0">Chưa có nhà cung cấp nào.</p>'}</div>`);
}

// Tạo phiếu nhập mới.
export function renderPurchaseOrderNew(ctx, shopId, suppliers, err, form) {
  const base = `/shops/${esc(shopId)}`;
  const activeSuppliers = (suppliers ?? []).filter((s) => s.is_active);
  const supOptions = activeSuppliers.map((s) => `<option value="${esc(s.id)}"${form?.supplier_id === s.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
  return layout('Tạo phiếu nhập', ctx, `${invTabs(shopId, 'po')}
    <a class="muted" href="${base}/purchasing">← Danh sách phiếu</a>
    <h1>Tạo phiếu nhập</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${activeSuppliers.length === 0 ? `<div class="notice warn">Chưa có nhà cung cấp đang hoạt động. <a href="${base}/suppliers">Thêm nhà cung cấp</a> trước.</div>` : ''}
    <form method="POST" action="${base}/purchasing/new">
      <div class="card"><h2 style="margin-top:0">Thông tin phiếu</h2>
        <select name="supplier_id" required><option value="">— Chọn nhà cung cấp —</option>${supOptions}</select>
        <label>Ghi chú phiếu (tuỳ chọn)</label><input name="note" maxlength="1000" value="${esc(form?.note ?? '')}">
        <p class="muted">Tạo nháp trước, sau đó tìm SKU và thêm từng dòng. Mỗi dòng được lưu ngay nên không mất khi lọc hoặc tải lại trang.</p></div>
      <button class="btn" type="submit"${activeSuppliers.length === 0 ? ' disabled' : ''}>Tạo nháp và thêm hàng →</button>
    </form>`);
}

// Sửa phiếu nhập (draft/ordered).
export function renderPurchaseOrderEdit(ctx, shopId, po, variantData, suppliers, err, picker) {
  const base = `/shops/${esc(shopId)}`;
  const pq = picker?.q ?? '';
  const variants = variantData?.variants ?? [];
  const offset = Number(variantData?.offset ?? picker?.offset ?? 0);
  const limit = Number(variantData?.limit ?? picker?.limit ?? 20);
  const activeSuppliers = (suppliers ?? []).filter((s) => s.is_active || s.id === po.supplier_id);
  const supOptions = activeSuppliers.map((s) => `<option value="${esc(s.id)}"${po.supplier_id === s.id ? ' selected' : ''}>${esc(s.name)}${s.is_active ? '' : ' (đã ẩn)'}</option>`).join('');
  const notices = { header: 'Đã lưu nhà cung cấp và ghi chú.', 'line-added': 'Đã thêm dòng hàng.', 'line-saved': 'Đã cập nhật dòng hàng.', 'line-deleted': 'Đã xoá dòng hàng.' };
  const pickerState = `<input type="hidden" name="q" value="${esc(pq)}"><input type="hidden" name="offset" value="${esc(offset)}">`;
  const selectedVariantIds = new Set((po.lines ?? []).map((l) => String(l.variant_id)));
  const lineRows = (po.lines ?? []).map((l) => [
    { html: `<strong>${esc(l.title_snapshot ?? '')}</strong>${l.sku_snapshot ? `<br><span class="muted">${esc(l.sku_snapshot)}</span>` : ''}` },
    { html: `<form method="POST" action="${base}/purchasing/${esc(po.id)}/lines/${esc(l.id)}" class="actions" style="align-items:end;flex-wrap:wrap">
      <input type="hidden" name="variant_id" value="${esc(l.variant_id)}">
      ${pickerState}
      <label style="max-width:110px">Số lượng<input name="qty" type="number" min="1" max="100000" required value="${esc(l.qty)}" inputmode="numeric"></label>
      <label style="max-width:170px">Giá nhập (đ)<input name="unit_cost" type="number" min="0" required value="${esc(l.unit_cost_vnd)}" inputmode="numeric"></label>
      <button class="btn alt sm" type="submit">Lưu dòng</button></form>` },
    { cls: 'right', html: `<form method="POST" action="${base}/purchasing/${esc(po.id)}/lines/${esc(l.id)}/delete">${pickerState}<button class="btn warn sm" type="submit" data-confirm="Xoá ${esc(l.title_snapshot ?? 'dòng hàng')} khỏi phiếu?">Xoá</button></form>` },
  ]);
  const resultRows = variants.map((v) => {
    const alreadyAdded = selectedVariantIds.has(String(v.id));
    return [
      { html: `<strong>${esc(v.product_title)}</strong>${v.variant_title ? ` / ${esc(v.variant_title)}` : ''}<br><span class="muted">${esc(v.sku ?? '')} · tồn ${esc(v.on_hand)}${v.cost_vnd != null ? ` · vốn ${money(v.cost_vnd)}` : ''}</span>` },
      { html: `<form method="POST" action="${base}/purchasing/${esc(po.id)}/lines" class="actions" style="align-items:end;flex-wrap:wrap">
      <input type="hidden" name="variant_id" value="${esc(v.id)}">${pickerState}
      <label style="max-width:100px">SL<input name="qty" type="number" min="1" max="100000" value="1" required inputmode="numeric"></label>
      <label style="max-width:160px">Giá nhập<input name="unit_cost" type="number" min="0" value="${esc(v.cost_vnd ?? 0)}" required inputmode="numeric"></label>
      <button class="btn ${alreadyAdded ? 'alt ' : ''}sm" type="submit"${alreadyAdded ? ' disabled title="Biến thể này đã có trong phiếu"' : ''}>${alreadyAdded ? 'Đã có trong phiếu' : '+ Thêm'}</button></form>` },
    ];
  });
  const pageHref = (nextOffset) => `${base}/purchasing/${esc(po.id)}/edit?${new URLSearchParams({ ...(pq ? { q: pq } : {}), offset: String(nextOffset) })}`;
  return layout('Sửa phiếu nhập', ctx, `${invTabs(shopId, 'po')}
    <a class="muted" href="${base}/purchasing/${esc(po.id)}">← Phiếu #${esc(po.po_number)}</a>
    <div class="toolbar"><h1 style="margin:0">Soạn phiếu nhập #${esc(po.po_number)}</h1><a class="btn alt" href="${base}/purchasing/${esc(po.id)}">Xem chi tiết</a></div>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notices[picker?.notice] ? `<div class="notice success">${esc(notices[picker.notice])}</div>` : ''}
    <form method="POST" action="${base}/purchasing/${esc(po.id)}/edit">
      ${pickerState}
      <div class="card"><h2 style="margin-top:0">Thông tin chung</h2>
        <select name="supplier_id" required>${supOptions}</select>
        <label>Ghi chú</label><input name="note" maxlength="1000" value="${esc(po.note ?? '')}"></div>
      <button class="btn" type="submit">Lưu thông tin chung</button></form>
    <div class="card"><div class="toolbar"><h2 style="margin:0">Dòng đã thêm (${esc((po.lines ?? []).length)}/200)</h2><strong>${money(po.subtotal_vnd)}</strong></div>
      ${lineRows.length ? `<div class="tblscroll">${tblCards({
        head: [{ html: 'Hàng' }, { html: 'Số lượng / giá' }, { html: '', label: '' }],
        rows: lineRows,
      })}</div>` : '<p class="muted">Phiếu đang trống. Tìm sản phẩm bên dưới để thêm dòng đầu tiên.</p>'}</div>
    <div class="card"><h2 style="margin-top:0">Tìm và thêm hàng</h2>
      <form method="GET" action="${base}/purchasing/${esc(po.id)}/edit" class="actions" style="align-items:end;flex-wrap:wrap">
        <div style="flex:1 1 260px"><label>Tên sản phẩm, tên biến thể hoặc SKU</label><input name="q" value="${esc(pq)}" maxlength="100" placeholder="vd: Blue XL, SKU-001"></div>
        <button class="btn alt sm" type="submit">Tìm</button>${pq ? `<a class="muted" href="${base}/purchasing/${esc(po.id)}/edit">Xoá lọc</a>` : ''}</form>
      ${resultRows.length ? `<div class="tblscroll">${tblCards({
        head: [{ html: 'Kết quả' }, { html: 'Thêm vào phiếu' }],
        rows: resultRows,
      })}</div>` : '<p class="muted">Không có biến thể phù hợp.</p>'}
      <div class="actions" style="justify-content:space-between;margin-top:12px">
        ${offset > 0 ? `<a class="btn alt sm" href="${pageHref(Math.max(0, offset - limit))}">← Trang trước</a>` : '<span></span>'}
        ${variantData?.has_more ? `<a class="btn alt sm" href="${pageHref(offset + limit)}">Trang sau →</a>` : ''}
      </div></div>`);
}

// Chi tiết phiếu nhập + hành động theo trạng thái.
export function renderPurchaseOrderDetail(ctx, shopId, po, notice, err) {
  const base = `/shops/${esc(shopId)}`;
  const lineRows = (po.lines ?? []).map((l) => [
    { html: `${esc(l.title_snapshot ?? '')}${l.sku_snapshot ? ` <span class="muted">[${esc(l.sku_snapshot)}]</span>` : ''}` },
    { cls: 'right num', html: esc(l.qty) },
    { cls: 'right num', html: money(l.unit_cost_vnd) },
    { cls: 'right num', html: `<strong>${money(l.qty * l.unit_cost_vnd)}</strong>` },
    { cls: 'right num muted', html: esc(l.on_hand) },
  ]);
  const canReceiveOrCancel = po.status === 'draft' || po.status === 'ordered';
  const actions = [];
  if (po.status === 'draft') actions.push(`<form method="POST" action="${base}/purchasing/${esc(po.id)}/order" style="display:inline"><button class="btn alt" type="submit">Đánh dấu đã đặt</button></form>`);
  if (canReceiveOrCancel) actions.push(`<a class="btn" href="${base}/purchasing/${esc(po.id)}/receive">Nhận hàng →</a>`);
  if (po.status === 'draft') actions.push(`<a class="btn alt" href="${base}/purchasing/${esc(po.id)}/edit">Sửa phiếu</a>`);
  if (canReceiveOrCancel) actions.push(`<form method="POST" action="${base}/purchasing/${esc(po.id)}/cancel" style="display:inline"><button class="btn warn" type="submit">Huỷ phiếu</button></form>`);
  return layout(`Phiếu #${po.po_number}`, ctx, `${invTabs(shopId, 'po')}
    <a class="muted" href="${base}/purchasing">← Danh sách phiếu</a>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice ? `<div class="notice success">${esc(notice)}</div>` : ''}
    <div class="toolbar"><h1 style="margin:0">Phiếu nhập #${esc(po.po_number)} ${badge(PO_BADGE[po.status], PO_STATUS[po.status] ?? po.status)}</h1></div>
    <div class="card"><p style="margin:0"><strong>Nhà cung cấp:</strong> ${esc(po.supplier_name)}${po.supplier_active === false ? ' <span class="badge archived">đã ẩn</span>' : ''}</p>
      ${po.note ? `<p class="muted" style="margin:6px 0 0">Ghi chú: ${esc(po.note)}</p>` : ''}
      ${po.received_at ? `<p class="muted" style="margin:6px 0 0">Đã nhận: ${dt(po.received_at)}</p>` : (po.ordered_at ? `<p class="muted" style="margin:6px 0 0">Đã đặt: ${dt(po.ordered_at)}</p>` : '')}</div>
    <div class="card"><h2 style="margin-top:0">Hàng${po.status === 'received' ? '' : ' dự kiến'}</h2>
      ${(po.lines ?? []).length ? tblCards({
        head: [{ html: 'Hàng' }, { html: 'SL', cls: 'right' }, { html: 'Giá nhập', cls: 'right' }, { html: 'Thành tiền', cls: 'right' }, { html: 'Tồn hiện tại', cls: 'right' }],
        rows: lineRows,
        foot: [[
          { colspan: 3, cls: 'right', html: '<strong>Tổng trị giá</strong>' },
          { cls: 'right num', html: `<strong>${money(po.subtotal_vnd)}</strong>` },
          { html: '' },
        ]],
      })
        : '<p class="muted" style="margin:0">Phiếu chưa có dòng hàng nào.</p>'}</div>
    ${actions.length ? `<div class="actions" style="flex-wrap:wrap">${actions.join('')}</div>` : ''}`);
}

// Trang XÁC NHẬN nhận hàng (preview: hàng + SL + giá nhập → tồn sẽ tăng). Không hoàn tác.
export function renderPurchaseOrderReceive(ctx, shopId, po) {
  const base = `/shops/${esc(shopId)}`;
  const rows = (po.lines ?? []).map((l) => `<tr>
    <td>${esc(l.title_snapshot ?? '')}${l.sku_snapshot ? ` <span class="muted">[${esc(l.sku_snapshot)}]</span>` : ''}</td>
    <td class="right num muted">${esc(l.on_hand)}</td>
    <td class="right num">+${esc(l.qty)}</td>
    <td class="right num"><strong>${esc(l.on_hand + l.qty)}</strong></td>
    <td class="right num">${money(l.unit_cost_vnd)}</td></tr>`).join('');
  return layout(`Nhận phiếu #${po.po_number}`, ctx, `${invTabs(shopId, 'po')}
    <a class="muted" href="${base}/purchasing/${esc(po.id)}">← Phiếu #${esc(po.po_number)}</a>
    <h1>Xác nhận nhận hàng — phiếu #${esc(po.po_number)}</h1>
    <div class="notice warn">Nhận hàng sẽ <strong>cộng tồn kho</strong> và <strong>cập nhật giá vốn bình quân</strong> cho từng biến thể. Thao tác <strong>không hoàn tác</strong> (điều chỉnh sai dùng Kiểm kê).</div>
    <div class="card"><table><thead><tr><th>Hàng</th><th class="right">Tồn nay</th><th class="right">Nhận</th><th class="right">Tồn sau</th><th class="right">Giá nhập</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <p style="margin:12px 0 0" class="right"><strong>Tổng trị giá nhập: ${money(po.subtotal_vnd)}</strong></p></div>
    <form method="POST" action="${base}/purchasing/${esc(po.id)}/receive">
      <div class="actions"><button class="btn" type="submit">Xác nhận nhận hàng</button><a class="btn alt" href="${base}/purchasing/${esc(po.id)}">Quay lại</a></div>
    </form>`);
}

// Báo cáo nhập hàng theo kỳ.
export function renderPurchasingReport(ctx, shopId, data, opts = {}) {
  const base = `/shops/${esc(shopId)}`;
  const r = data.range ?? {};
  const supRows = (data.by_supplier ?? []).map((s) => `<tr><td>${esc(s.supplier_name)}</td><td class="right num">${esc(s.po_count)}</td><td class="right num"><strong>${money(s.value_vnd)}</strong></td></tr>`).join('');
  const prodRows = (data.by_product ?? []).map((p) => `<tr><td>${esc(p.title ?? '')}${p.sku ? ` <span class="muted">[${esc(p.sku)}]</span>` : ''}</td><td class="right num">${esc(p.qty)}</td><td class="right num">${money(p.value_vnd)}</td></tr>`).join('');
  return layout('Báo cáo nhập', ctx, `${invTabs(shopId, 'report')}
    <h1>Báo cáo nhập hàng</h1>
    <div class="card"><form method="GET" action="${base}/purchasing/report" class="actions" style="align-items:end;flex-wrap:wrap">
      <div><label>Từ ngày</label><input type="date" name="from" value="${esc(r.from ?? '')}"></div>
      <div><label>Đến ngày</label><input type="date" name="to" value="${esc(r.to ?? '')}"></div>
      <button class="btn alt sm" type="submit">Xem</button></form></div>
    ${opts.err ? `<div class="err">${esc(opts.err)}</div>` : ''}
    <div class="card"><h2 style="margin-top:0">Tổng kỳ ${esc(r.from ?? '')} → ${esc(r.to ?? '')}</h2>
      <p style="margin:0;font-size:1.1rem">Đã nhận <strong>${esc(data.totals?.po_count ?? 0)}</strong> phiếu · trị giá <strong>${money(data.totals?.value_vnd ?? 0)}</strong></p></div>
    <div class="card"><h2 style="margin-top:0">Theo nhà cung cấp</h2>
      ${supRows ? `<table><thead><tr><th>Nhà cung cấp</th><th class="right">Phiếu</th><th class="right">Trị giá</th></tr></thead><tbody>${supRows}</tbody></table>` : '<p class="muted" style="margin:0">Chưa có phiếu nhận nào trong kỳ.</p>'}</div>
    <div class="card"><h2 style="margin-top:0">Theo hàng${data.products_truncated ? ' <span class="muted" style="font-weight:400;font-size:.85rem">(top 100)</span>' : ''}</h2>
      ${prodRows ? `<table><thead><tr><th>Hàng</th><th class="right">SL nhập</th><th class="right">Trị giá</th></tr></thead><tbody>${prodRows}</tbody></table>` : '<p class="muted" style="margin:0">—</p>'}</div>`);
}

// Kiểm kê: danh sách + form tạo phiên.
export function renderStocktakes(ctx, shopId, list, opts = {}) {
  const base = `/shops/${esc(shopId)}`;
  const rows = (list ?? []).map((s) => [
    { html: `<a href="${base}/stocktakes/${esc(s.id)}">#${esc(s.stocktake_number)}</a>` },
    { html: badge(ST_BADGE[s.status], ST_STATUS[s.status] ?? s.status) },
    { cls: 'right num', html: `${esc(s.counted_count)}/${esc(s.line_count)}` },
    { cls: 'muted', html: `${esc(s.note ?? '') || '—'}` },
    { cls: 'muted', html: s.completed_at ? dt(s.completed_at) : dt(s.created_at) },
  ]);
  return layout('Kiểm kê', ctx, `${invTabs(shopId, 'stocktakes')}
    <h1>Kiểm kê kho</h1>
    ${opts.err ? `<div class="err">${esc(opts.err)}</div>` : ''}
    ${opts.notice ? `<div class="notice success">${esc(opts.notice)}</div>` : ''}
    <div class="card"><h2 style="margin-top:0">Tạo phiên kiểm kê</h2>
      <p class="muted" style="margin-top:-4px">Chụp tồn hệ thống lúc tạo, bạn đếm thực tế rồi chốt — chênh lệch tự điều chỉnh tồn (ghi sổ kho).</p>
      <form method="POST" action="${base}/stocktakes">
        <label>Ghi chú (tuỳ chọn)</label><input name="note" maxlength="1000" placeholder="Kiểm kê cuối tháng, kho A…">
        <label style="display:flex;gap:8px;align-items:center;font-weight:500;margin-top:10px"><input type="radio" name="scope" value="all" checked style="width:auto"> Toàn bộ biến thể của shop (tối đa 500)</label>
        <button class="btn" type="submit" style="margin-top:12px">Bắt đầu đếm</button>
      </form></div>
    <div class="card"><h2 style="margin-top:0">Các phiên</h2>
      ${rows.length ? tblCards({
        head: [{ html: 'Phiên' }, { html: 'Trạng thái' }, { html: 'Đã đếm', cls: 'right' }, { html: 'Ghi chú' }, { html: 'Ngày' }],
        rows,
      }) : '<p class="muted" style="margin:0">Chưa có phiên kiểm kê nào.</p>'}</div>`);
}

// Chi tiết + ghi số đếm cho một phiên kiểm kê.
export function renderStocktakeDetail(ctx, shopId, st, notice, err) {
  const base = `/shops/${esc(shopId)}`;
  const counting = st.status === 'counting';
  const lineRows = (st.lines ?? []).map((l) => {
    const nameCell = `${esc(l.product_title ?? '')}${l.variant_title ? ` — ${esc(l.variant_title)}` : ''}${l.sku ? ` <span class="muted">[${esc(l.sku)}]</span>` : ''}`;
    const diff = l.counted_qty == null ? null : Number(l.counted_qty) - Number(l.system_qty);
    const diffCell = diff == null ? '<span class="muted">—</span>' : (diff === 0 ? '0' : `<span style="color:var(--${diff > 0 ? 'good' : 'bad'});font-weight:700">${diff > 0 ? '+' : ''}${esc(diff)}</span>`);
    if (counting) {
      return `<tr><td>${nameCell}</td><td class="right num">${counting ? esc(l.on_hand_now) : esc(l.system_qty)}</td>
        <td style="width:110px"><input type="hidden" name="variant_id" value="${esc(l.variant_id)}"><input name="counted_qty" type="number" min="0" inputmode="numeric" value="${l.counted_qty == null ? '' : esc(l.counted_qty)}" style="margin:0" aria-label="Số đếm ${esc(l.sku ?? '')}"></td></tr>`;
    }
    return `<tr><td>${nameCell}</td><td class="right num">${esc(l.system_qty)}</td><td class="right num">${l.counted_qty == null ? '<span class="muted">chưa đếm</span>' : esc(l.counted_qty)}</td><td class="right">${diffCell}</td></tr>`;
  }).join('');
  const head = counting
    ? '<tr><th>Hàng</th><th class="right">Tồn hệ thống</th><th>Số đếm thực tế</th></tr>'
    : '<tr><th>Hàng</th><th class="right">Tồn (lúc chốt)</th><th class="right">Đã đếm</th><th class="right">Chênh</th></tr>';
  const body = counting
    ? `<form method="POST" action="${base}/stocktakes/${esc(st.id)}/count">
        <div class="card"><table><thead>${head}</thead><tbody>${lineRows}</tbody></table></div>
        <div class="actions" style="flex-wrap:wrap"><button class="btn alt" type="submit">Lưu số đếm</button></div>
       </form>
       <form method="POST" action="${base}/stocktakes/${esc(st.id)}/complete" style="margin-top:12px">
        <div class="notice info">Chốt sẽ điều chỉnh tồn về số đã đếm (chỉ các dòng đã nhập số) + ghi sổ kho. Dòng chưa đếm giữ nguyên.</div>
        <div class="actions"><button class="btn" type="submit">Chốt kiểm kê</button>
          <button class="btn warn" type="submit" formaction="${base}/stocktakes/${esc(st.id)}/cancel">Huỷ phiên</button></div>
       </form>`
    : `<div class="card"><table><thead>${head}</thead><tbody>${lineRows}</tbody></table></div>`;
  return layout(`Kiểm kê #${st.stocktake_number}`, ctx, `${invTabs(shopId, 'stocktakes')}
    <a class="muted" href="${base}/stocktakes">← Danh sách kiểm kê</a>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice ? `<div class="notice success">${esc(notice)}</div>` : ''}
    <div class="toolbar"><h1 style="margin:0">Kiểm kê #${esc(st.stocktake_number)} ${badge(ST_BADGE[st.status], ST_STATUS[st.status] ?? st.status)}</h1></div>
    ${st.note ? `<p class="muted" style="margin-top:-6px">${esc(st.note)}</p>` : ''}
    ${body}`);
}

// ── ĐIỂM THƯỞNG (0086): cấu hình + báo cáo nợ ────────────────────────────────
export function renderLoyalty(ctx, shopId, cfg, report, notice, err) {
  const base = `/shops/${esc(shopId)}`;
  const c = cfg ?? {};
  const num = (k, d) => esc(c[k] ?? d);
  const rep = report;
  const reportCard = rep ? `<div class="card"><h2 style="margin-top:0">Nợ điểm hiện tại</h2>
    <p style="margin:0;font-size:1.15rem">Đang lưu hành <strong>${esc(rep.outstanding_points)}</strong> điểm ·
      ước tính nợ <strong>${money(rep.liability_vnd)}</strong>
      <span class="muted">(${esc(rep.members_with_points)} khách có điểm${rep.members_in_debt ? `, ${esc(rep.members_in_debt)} khách đang nợ điểm` : ''})</span></p>
    <p class="muted" style="margin:8px 0 0;font-size:.85rem">Đây là chỉ số nợ phải trả (điểm khách có thể đổi thành giảm giá) — KHÔNG phải chi phí kỳ này. Chi phí điểm đã tính khi khách ĐỔI (giảm doanh thu lúc tiêu).</p>
    <table style="margin-top:10px"><tbody>
      <tr><td>Đã phát (tích)</td><td class="right num">${esc(rep.movements.earned)}</td></tr>
      <tr><td>Đã đổi</td><td class="right num">${esc(rep.movements.redeemed)}</td></tr>
      <tr><td>Hoàn (đơn huỷ/hoàn)</td><td class="right num">${esc(rep.movements.reversed)}</td></tr>
      <tr><td>Thu hồi (đơn huỷ/hoàn)</td><td class="right num">${esc(rep.movements.clawed_back)}</td></tr>
      ${rep.movements.adjusted ? `<tr><td>Điều chỉnh tay</td><td class="right num">${esc(rep.movements.adjusted)}</td></tr>` : ''}
    </tbody></table></div>` : '';
  return layout('Điểm thưởng', ctx, `
    <h1>Điểm thưởng khách hàng</h1>
    <p class="muted" style="margin-top:-6px">Khách tích điểm khi mua (đã thanh toán), đổi điểm thành giảm giá ở lần mua sau — giữ chân khách quay lại.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice ? `<div class="notice success">${esc(notice)}</div>` : ''}
    <div class="card"><form method="POST" action="${base}/loyalty">
      <label style="display:flex;gap:8px;align-items:center;font-weight:600"><input type="checkbox" name="enabled" value="1"${c.enabled ? ' checked' : ''} style="width:auto"> Bật chương trình điểm thưởng</label>
      <div class="grid2" style="margin-top:12px">
        <div><label>Tích điểm: số điểm cho mỗi 1.000đ tiền hàng</label><input name="earn_points_per_1000" type="number" min="1" max="1000" value="${num('earn_points_per_1000', 1)}" inputmode="numeric"></div>
        <div><label>Đổi điểm: 1 điểm = bao nhiêu đồng giảm giá</label><input name="redeem_vnd_per_point" type="number" min="1" max="1000000" value="${num('redeem_vnd_per_point', 100)}" inputmode="numeric"></div>
      </div>
      <div class="grid2">
        <div><label>Số ngày chờ cộng điểm (chống hoàn đơn — nên ≥ hạn đổi/trả)</label><input name="earn_vesting_days" type="number" min="0" max="365" value="${num('earn_vesting_days', 7)}" inputmode="numeric"></div>
        <div><label>Giảm tối đa mỗi đơn (% tiền hàng)</label><input name="max_redeem_pct" type="number" min="1" max="100" value="${num('max_redeem_pct', 50)}" inputmode="numeric"></div>
      </div>
      <label>Ngưỡng đổi tối thiểu (điểm) — 0 = không giới hạn</label><input name="min_redeem_points" type="number" min="0" value="${num('min_redeem_points', 0)}" inputmode="numeric" style="max-width:200px">
      <p class="muted" style="font-size:.85rem;margin:10px 0 0">Ví dụ: tích 1 điểm/1.000đ + đổi 100đ/điểm = hoàn ~10% dưới dạng điểm. Điểm chỉ giảm tiền HÀNG, không giảm phí ship.</p>
      <button class="btn" type="submit" style="margin-top:14px">Lưu cấu hình</button>
    </form></div>
    ${reportCard}`);
}

export function renderLoyaltyStepUp(ctx, shopId, fields, err) {
  const base = `/shops/${esc(shopId)}/loyalty`;
  const keep = Object.entries(fields ?? {}).filter(([k, v]) => v != null && k !== 'password')
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return layout('Xác nhận mật khẩu', ctx, `<div class="center"><div class="card">
    <h1>Xác nhận mật khẩu</h1>
    <p class="muted">Đổi cấu hình điểm thưởng chạm đường tiền — nhập mật khẩu của bạn để tiếp tục.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="POST" action="${base}/step-up">
      ${keep}
      <label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password">
      <button class="btn" type="submit" style="width:100%;margin-top:12px">Xác nhận &amp; lưu</button>
    </form>
    <a class="muted" href="${base}" style="display:inline-block;margin-top:10px">← Huỷ</a>
  </div></div>`);
}

// ── KẾT NỐI: khoá cho phần mềm ngoài đẩy đơn vào (0120) ──────────────────────
// Người đọc trang này là chủ shop, không phải lập trình viên. Nên trang nói bằng
// việc-của-họ ("đơn chốt trong chat Facebook chạy thẳng về đây"), còn phần kỹ thuật
// gói vào một khối để đưa cho ai dựng tích hợp. Token hiện ĐÚNG một lần — nói thẳng
// điều đó ngay cạnh nó, chứ không giấu trong một dòng ghi chú nhạt màu.
export function renderApiKeys(ctx, shopId, data, err, ok, freshToken, mess, verifyToken) {
  const base = `/shops/${esc(shopId)}/api-keys`;
  const mbase = `/shops/${esc(shopId)}/messenger`;
  const keys = data?.keys ?? [];
  const url = data?.ingest_url ?? '';
  const dt = (v) => (v ? new Date(v).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '—');
  const rows = keys.map((k) => ({
    attrs: k.revoked_at ? ' style="opacity:.55"' : '',
    cells: [
      { html: `<strong>${esc(k.name)}</strong><br><code class="muted" style="font-size:.8rem">${esc(k.token_prefix)}…</code>` },
      { cls: 'muted', html: dt(k.created_at) },
      { cls: 'muted', html: k.last_used_at ? dt(k.last_used_at) : '<em>chưa dùng lần nào</em>' },
      { style: 'text-align:right', html: esc(k.orders_count ?? 0) },
      { html: k.revoked_at
        ? `<span class="badge cancelled">Đã thu hồi</span>`
        : `<form method="POST" action="${base}/${esc(k.id)}/revoke" data-confirm="Thu hồi khoá &quot;${esc(k.name)}&quot;? Phần mềm đang dùng khoá này sẽ NGỪNG đẩy đơn về ngay lập tức.">
           <button class="btn warn sm" type="submit">Thu hồi</button></form>` },
    ],
  }));
  // Tên trang phải nói được rằng ĐÂY là chỗ bán qua Facebook. Trước đợt kiểm toán trang tên
  // "Kết nối phần mềm ngoài" mà lại chứa kết nối Trang Messenger — không ai đi tìm Facebook
  // trong mục nghe như dành cho lập trình viên.
  return layout('Kênh bán & kết nối', { ...ctx, active: 'apikeys' }, `<h1>Kênh bán &amp; kết nối</h1>
    <p class="muted" style="margin:-6px 0 14px">Bán qua <strong>chat Facebook</strong>, và nối phần mềm ngoài đẩy đơn về đây.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${ok ? `<div class="card" style="border-color:#86efac;background:#f0fdf4">${esc(ok)}</div>` : ''}
    ${freshToken ? `<div class="card" style="border-color:#f59e0b;background:#fffbeb">
      <h2 style="margin-top:0">Khoá mới — CHÉP NGAY BÂY GIỜ</h2>
      <p style="margin:0 0 8px">Đây là lần <strong>duy nhất</strong> khoá này hiện ra. Rời trang là không xem lại được nữa (chúng tôi không lưu bản đọc được — làm vậy thì khoá của bạn rò theo mọi ảnh chụp màn hình).</p>
      <textarea readonly rows="2" style="width:100%;font-family:ui-monospace,monospace;font-size:.9rem">${esc(freshToken)}</textarea>
      <p class="muted" style="margin:8px 0 0;font-size:.85rem">Dán vào phần mềm chat/tự-động-hoá của bạn. Lỡ mất thì quay lại đây thu hồi và tạo khoá mới.</p>
    </div>` : ''}
    ${verifyToken ? `<div class="card" style="border-color:#f59e0b;background:#fffbeb">
      <h2 style="margin-top:0">Còn 1 bước — dán mã này sang Meta</h2>
      <p style="margin:0 0 8px">Vào <strong>developers.facebook.com</strong> → app của bạn → <strong>Messenger → Cài đặt → Webhooks → Chỉnh sửa</strong>, rồi điền:</p>
      <p style="margin:0 0 4px"><strong>URL callback:</strong> <code>${esc(mess?.webhook_url ?? '')}</code></p>
      <p style="margin:0 0 8px"><strong>Verify token:</strong></p>
      <textarea readonly rows="2" style="width:100%;font-family:ui-monospace,monospace">${esc(verifyToken)}</textarea>
      <p class="muted" style="margin:8px 0 0;font-size:.85rem">Mã này chỉ hiện <strong>một lần</strong>. Mất thì bấm "Kết nối lại" ở dưới để sinh mã mới. Nhớ tick sự kiện <code>messages</code> và <code>messaging_postbacks</code>.</p>
    </div>` : ''}

    <div class="card">
      <h2 id="facebook" style="margin-top:0">Bán hàng qua chat Facebook (Messenger)</h2>
      ${mess?.available === false ? '<p class="muted">Nền tảng chưa bật kênh này. Liên hệ quản trị nền tảng.</p>' : mess?.connected ? `
        <div style="border-left:3px solid #22c55e;padding-left:12px">
          <p style="margin:0"><strong>✓ Đã kết nối Trang</strong> ${esc(mess.config?.page_name || mess.config?.page_id || '')}</p>
          <p class="muted" style="margin:6px 0 0;font-size:.88rem">Khách nhắn tin Trang này sẽ được bot dẫn chọn hàng và <strong>chốt đơn ngay trong chat</strong>. Đơn về thẳng trang Đơn hàng, nguồn <strong>Facebook</strong>.</p>
        </div>
        <form method="POST" action="${mbase}/disconnect" style="margin-top:12px"
              data-confirm="Ngắt kết nối Trang? Bot sẽ ngừng trả lời khách ngay, và mọi hội thoại đang dở (kèm SĐT/địa chỉ khách đã nhập) sẽ bị xoá.">
          <button class="btn warn sm" type="submit">Ngắt kết nối</button></form>` : `
        <p class="muted" style="margin-top:0">Khách bấm quảng cáo → nhắn tin → bot đưa sản phẩm, khách bấm <strong>Mua ngay</strong> rồi nhập địa chỉ là xong đơn. Không cần rời Messenger.</p>`}
      <details style="margin-top:12px">
        <summary style="cursor:pointer"><strong>${mess?.connected ? 'Kết nối lại / đổi Trang' : 'Kết nối Trang Facebook'}</strong></summary>
        <p class="muted" style="font-size:.85rem">Lấy <strong>ID Trang</strong> ở Trang → Giới thiệu. Lấy <strong>Page Access Token</strong> ở developers.facebook.com → app → Messenger → Cài đặt → Tạo token cho Trang.</p>
        <form method="POST" action="${mbase}">
          <div class="grid2">
            <div><label>ID Trang *</label><input name="page_id" required inputmode="numeric" placeholder="1246183341910660"></div>
            <div><label>Tên Trang (tuỳ chọn)</label><input name="page_name" maxlength="120" placeholder="TikFlash - Máy Chốt Đơn"></div>
          </div>
          <label>Page Access Token *</label><input name="page_token" required placeholder="EAAG…">
          <button class="btn" type="submit" style="margin-top:10px">Kết nối Trang</button>
        </form>
      </details>
    </div>
    <div class="card">
      <p style="margin-top:0">Đang chốt đơn bằng <strong>phần mềm khác</strong> bằng phần mềm khác (Pancake, Botcake, n8n, Zapier…)? Tạo một khoá ở đây, dán sang bên đó — <strong>đơn chốt trong chat sẽ chạy thẳng về cửa hàng này</strong>: trừ kho, vào sổ doanh thu, in được vận đơn, y như đơn đặt trên website.</p>
      <p class="muted" style="margin-bottom:0">Mỗi phần mềm nên một khoá riêng, đặt tên theo phần mềm đó. Nghi lộ khoá nào thì thu hồi đúng khoá đó, những cái còn lại vẫn chạy.</p>
    </div>
    <div class="card"><h2 style="margin-top:0">Tạo khoá mới</h2>
      <form method="POST" action="${base}" class="actions" style="align-items:end;flex-wrap:wrap">
        <div style="flex:1 1 220px"><label>Đặt tên khoá</label><input name="name" maxlength="80" required placeholder="VD: Pancake, n8n, bot Messenger"></div>
        <div><button class="btn" type="submit">Tạo khoá</button></div>
      </form>
    </div>
    <div class="card"><h2 style="margin-top:0">Khoá của cửa hàng</h2>
      ${keys.length ? tblCards({
        head: [{ html: 'Tên' }, { html: 'Tạo lúc' }, { html: 'Dùng lần cuối' }, { html: 'Đơn đã nhận', style: 'text-align:right' }, { html: '', label: '' }],
        rows,
      })
        : '<p class="muted">Chưa có khoá nào.</p>'}
    </div>
    <div class="card"><h2 style="margin-top:0">Đưa phần này cho người dựng tích hợp</h2>
      <p class="muted" style="margin-top:0">Gửi đơn bằng <code>POST</code> tới địa chỉ dưới đây, kèm khoá ở header <code>Authorization</code>.</p>
      <p><strong>Địa chỉ:</strong> <code>${esc(url)}</code></p>
      <pre style="overflow-x:auto;background:var(--surface,#f6f7f8);padding:12px;border-radius:6px;font-size:.82rem"><code>${esc(`curl -X POST ${url} \\
  -H "Authorization: Bearer ntk_KHOA_CUA_BAN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "lines": [{ "variant_id": "<id biến thể>", "qty": 1 }],
    "customer": { "name": "Nguyễn Văn A", "phone": "0901234567",
                  "address_line": "12 Lê Lợi", "province": "TP Hồ Chí Minh" },
    "payment_method": "cod",
    "source": "facebook",
    "source_ref": "m.me/trang-cua-ban",
    "idempotency_key": "id-doan-chat-hoac-ma-don-ben-kia"
  }'`)}</code></pre>
      <ul class="muted" style="font-size:.85rem;line-height:1.8">
        <li><code>idempotency_key</code> <strong>bắt buộc</strong> — gửi lại cùng một key thì KHÔNG tạo đơn thứ hai. Dùng mã đơn bên phần mềm kia là chuẩn nhất.</li>
        <li><code>variant_id</code> lấy ở trang Sản phẩm (mỗi biến thể một mã). Giá và tồn kho <strong>lấy theo cửa hàng này</strong>, không lấy theo số bên kia gửi sang.</li>
        <li><code>source</code>: <code>facebook</code> · <code>zalo</code> · <code>tiktok</code> · <code>other</code> — để trang Đơn hàng lọc được theo kênh.</li>
        <li>Hết hàng / thiếu trường → trả mã lỗi kèm câu tiếng Việt, đơn <strong>không</strong> được tạo nửa vời.</li>
      </ul>
    </div>`);
}

// ── POS ngoài: kết nối, ánh xạ và ca đồng bộ ────────────────────────────────
// Một trang cho cả ba vai vận hành nhưng mỗi vai chỉ thấy việc mình làm được. Credential
// không bao giờ quay lại HTML; owner/admin nhập mới thì giá trị đi thẳng qua POST + step-up.
export function renderIntegrations(ctx, shopId, data = {}, notice, err, probe = null) {
  const base = `/shops/${esc(shopId)}/integrations`;
  const dt = (value) => value ? new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : 'Chưa có';
  const canManage = ctx.role === 'owner' || ctx.role === 'admin';
  const canMap = canManage || ctx.role === 'catalog_manager';
  const canRetry = canManage || ctx.role === 'order_manager';
  const integration = (data.integrations ?? []).find((row) => row.provider === 'kiotviet') ?? null;
  const status = {
    connecting: ['Đang đồng bộ thử', 'wait'], active: ['Đang hoạt động', 'ok'],
    degraded: ['Cần xử lý', 'wait'], disabled: ['Đã ngắt', 'cancelled'],
  }[integration?.status] ?? ['Chưa kết nối', 'cancelled'];
  const authority = integration?.inventory_authority === 'external_master'
    ? 'KiotViet làm chủ tồn vật lý' : 'Nền tảng đang làm chủ tồn vật lý';
  const webhookRows = integration?.webhook_urls ? Object.entries(integration.webhook_urls).map(([name, url]) => `
    <div style="margin:8px 0"><strong>${esc(name)}</strong><br><code style="word-break:break-all">${esc(url)}</code></div>`).join('') : '';
  const mappingCards = (data.mappings ?? []).map((row) => `<div class="card" style="margin:10px 0">
    <div class="actions" style="justify-content:space-between"><strong>${esc(row.raw_meta?.name || row.external_id)}</strong><span class="badge wait">${row.mapping_status === 'conflict' ? 'Trùng khớp' : 'Chưa ánh xạ'}</span></div>
    <p class="muted" style="margin:6px 0">KiotViet ID: <code>${esc(row.external_id)}</code>${row.raw_meta?.sku ? ` · SKU: <code>${esc(row.raw_meta.sku)}</code>` : ''}${row.raw_meta?.barcode ? ` · Barcode: <code>${esc(row.raw_meta.barcode)}</code>` : ''}</p>
    ${canMap ? `<form method="POST" action="${base}/mappings/${esc(row.id)}" class="actions" style="align-items:end;flex-wrap:wrap">
      <div style="flex:1 1 240px"><label>ID ${row.entity_type === 'product' ? 'sản phẩm' : 'biến thể'} nội bộ</label><input name="local_id" required placeholder="UUID trên trang sản phẩm"></div>
      <button class="btn sm" type="submit">Liên kết</button></form>
      <form method="POST" action="${base}/mappings/${esc(row.id)}/ignore" style="margin-top:8px" data-confirm="Sản phẩm này sẽ không được bán trên website và không còn chặn việc kích hoạt đồng bộ. Tiếp tục?">
        <button class="btn sm alt" type="submit">Không bán trên website</button>
      </form>` : ''}
  </div>`).join('');
  const discrepancyCards = (data.discrepancies ?? []).map((row) => `<div class="card" style="margin:10px 0;border-color:${row.severity === 'critical' ? '#fca5a5' : '#fcd34d'}">
    <div class="actions" style="justify-content:space-between"><strong>${esc(row.message)}</strong><span class="badge ${row.severity === 'critical' ? 'cancelled' : 'wait'}">${row.severity === 'critical' ? 'Quan trọng' : 'Cảnh báo'}</span></div>
    <p class="muted" style="margin:6px 0">${esc(row.kind)} · ${dt(row.created_at)}</p>
    ${canRetry ? `<form method="POST" action="${base}/discrepancies/${esc(row.id)}/retry">${row.entity_type === 'order' ? '<label style="display:block;margin:8px 0;color:#92400e"><input type="checkbox" name="confirm_provider_absent" value="1" required> Tôi đã kiểm tra KiotViet và xác nhận chưa có đơn mang mã Nền Tảng của đơn này.</label>' : ''}<button class="btn sm" type="submit">${row.entity_type === 'order' ? 'Xác nhận chưa có đơn rồi gửi lại' : 'Thử đối soát lại'}</button></form>` : ''}
  </div>`).join('');
  return layout('Kết nối POS', { ...ctx, active: 'integrations' }, `<h1>Kết nối POS</h1>
    <p class="muted" style="margin:-6px 0 14px">Đồng bộ KiotViet với website mà không bắt khách tại quầy vào website đặt hàng.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${notice ? `<div class="card" style="border-color:#86efac;background:#f0fdf4">${esc(notice)}</div>` : ''}
    <div class="card">
      <div class="actions" style="justify-content:space-between;align-items:flex-start"><div><h2 style="margin:0">KiotViet</h2><p class="muted" style="margin:6px 0 0">${esc(authority)}</p></div><span class="badge ${status[1]}">${status[0]}</span></div>
      ${integration ? `<div style="margin-top:12px">
        <div class="row"><span class="muted">Retailer</span><strong>${esc(integration.retailer || '—')}</strong></div>
        <div class="row"><span class="muted">Chi nhánh</span><strong>${esc(integration.external_branch_name || 'Chưa chọn')}</strong></div>
        <div class="row"><span class="muted">Tồn cập nhật</span><span>${dt(integration.inventory_synced_at)}</span></div>
        <div class="row"><span class="muted">Đối soát gần nhất</span><span>${dt(integration.reconciled_at)}</span></div>
        <div class="row"><span class="muted">Webhook đăng ký</span><span>${dt(integration.webhook_registered_at)}</span></div>
        <div class="row"><span class="muted">Lỗi ánh xạ / ca mở</span><span>${Number(integration.mapping_issues ?? 0)} / ${Number(integration.open_discrepancies ?? 0)}</span></div>
        ${integration.last_error ? `<div class="err" style="margin-top:10px">${esc(integration.last_error)}</div>` : ''}
      </div>` : '<p class="muted">Chưa có kết nối KiotViet cho cửa hàng này.</p>'}
    </div>
    ${canManage ? `<div class="card"><h2 style="margin-top:0">${integration ? 'Kiểm tra lại credential' : 'Kết nối KiotViet'}</h2>
      <p class="muted">Lấy Client ID và Client Secret trong thiết lập Public API của KiotViet. Hệ thống kiểm tra thật và chỉ lưu bản mã hóa.</p>
      <form method="POST" action="${base}/kiotviet/probe">
        <div class="grid2"><div><label>Tên retailer *</label><input name="retailer" required value="${esc(integration?.retailer || '')}" placeholder="ten-cua-hang"></div><div><label>Client ID *</label><input name="client_id" required autocomplete="off"></div></div>
        <label>Client Secret *</label><input type="password" name="client_secret" required autocomplete="new-password">
        <button class="btn" type="submit" style="margin-top:10px">Kiểm tra và đọc chi nhánh</button>
      </form>
      ${probe?.branches?.length ? `<hr style="margin:18px 0;border:0;border-top:1px solid var(--line,#ddd)"><h3>Chọn một chi nhánh cho V1</h3>
        <form method="POST" action="${base}/kiotviet/activate"><input type="hidden" name="pending_token" value="${esc(probe.pending_token || '')}">${probe.branches.map((branch, index) => `<label style="display:block;border:1px solid var(--line,#ddd);border-radius:8px;padding:10px;margin:8px 0"><input type="radio" name="branch_id" value="${esc(branch.id)}"${index === 0 ? ' checked' : ''}> <strong>${esc(branch.name)}</strong>${branch.address ? `<br><span class="muted">${esc(branch.address)}</span>` : ''}</label>`).join('')}<button class="btn" type="submit">Chạy đồng bộ thử</button></form>` : ''}
      ${integration && integration.status !== 'disabled' ? `<form method="POST" action="${base}/${esc(integration.id)}/disable" style="margin-top:14px" data-confirm="Ngắt kết nối? Ánh xạ vẫn được giữ; nếu KiotViet đang làm chủ tồn thì checkout sẽ tạm khóa cho tới khi chuyển quyền an toàn."><button class="btn warn sm" type="submit">Ngắt kết nối an toàn</button></form>` : ''}
      ${integration?.status === 'disabled' && integration.inventory_authority === 'external_master' ? `<form method="POST" action="${base}/${esc(integration.id)}/transfer-local" style="margin-top:14px" data-confirm="Chuyển bản chiếu tồn cuối thành tồn local? Bạn cần kiểm đếm lại kho thực tế sau thao tác này."><button class="btn warn sm" type="submit">Chuyển quyền tồn về nền tảng</button></form>` : ''}
    </div>` : ''}
    ${canManage && webhookRows ? `<details class="card"><summary><strong>Webhook KiotViet đã đăng ký tự động</strong></summary><p class="muted">Các URL dưới đây chỉ để đối chiếu vận hành. Secret chữ ký được mã hóa và không xuất hiện trên giao diện.</p>${webhookRows}</details>` : ''}
    <div class="card"><h2 style="margin-top:0">Ánh xạ sản phẩm</h2>
      <p class="muted">Chỉ tự nối khi SKU/barcode khớp duy nhất. Thiếu hoặc trùng thì dừng để người quản lý sản phẩm quyết định.</p>
      ${mappingCards || '<p class="muted">Không có ánh xạ cần xử lý.</p>'}
    </div>
    <div class="card"><h2 style="margin-top:0">Trung tâm đồng bộ</h2>
      ${discrepancyCards || '<p class="muted">Không có ca đồng bộ đang mở.</p>'}
    </div>`);
}

// ── GÓI DỊCH VỤ: chủ shop xem hạn + TỰ TRẢ TIỀN (0124-0128) ─────────────────
// Người đọc là chủ shop, không phải kế toán. Thứ họ cần biết trong 2 giây: "còn mấy ngày"
// và "trả tiền ở đâu". Mọi thứ khác xếp sau.
export function renderBilling(ctx, shopId, d, err, ok) {
  const base = `/shops/${esc(shopId)}/billing`;
  const dt = (v) => (v ? new Date(v).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '—');
  const left = d?.days_left;
  // Màu theo mức KHẨN, không phải theo trạng thái kỹ thuật: hết hạn rồi mà hiện xám thì
  // người bán lướt qua và mất shop.
  const tone = d?.suspended_for_nonpayment ? { bg: '#fef2f2', bd: '#fca5a5', fg: '#991b1b' }
    : left == null ? { bg: 'var(--surface,#f6f7f8)', bd: '#e5e7eb', fg: 'inherit' }
    : left < 0 ? { bg: '#fef2f2', bd: '#fca5a5', fg: '#991b1b' }
    : left <= 7 ? { bg: '#fffbeb', bd: '#fcd34d', fg: '#92400e' }
    : { bg: '#f0fdf4', bd: '#86efac', fg: '#166534' };
  const headline = d?.suspended_for_nonpayment ? 'Cửa hàng ĐANG BỊ KHOÁ vì chưa thanh toán'
    : left == null ? 'Chưa có thông tin hạn dịch vụ'
    : left < 0 ? `Đã quá hạn ${Math.abs(left)} ngày`
    : left === 0 ? 'Hết hạn hôm nay'
    : `Còn ${left} ngày sử dụng`;
  const p = d?.pending;
  return layout('Gói dịch vụ', { ...ctx, active: 'billing' }, `<h1>Gói dịch vụ</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${ok ? `<div class="card" style="border-color:#86efac;background:#f0fdf4">${esc(ok)}</div>` : ''}
    <div class="card" style="background:${tone.bg};border-color:${tone.bd};color:${tone.fg}">
      <h2 style="margin:0 0 6px">${esc(headline)}</h2>
      <p style="margin:0">Gói <strong>${esc(d?.plan_name ?? d?.plan_code ?? '—')}</strong>${
        d?.price_vnd_month != null ? ` · ${esc(money(d.price_vnd_month))}/tháng` : ''} · hạn đến <strong>${dt(d?.current_period_end)}</strong></p>
      ${d?.suspended_for_nonpayment ? '<p style="margin:8px 0 0"><strong>Khách vào website sẽ thấy trang "tạm ngưng".</strong> Thanh toán xong cửa hàng mở lại ngay, không mất dữ liệu gì.</p>' : ''}
    </div>
    ${d?.available === false ? '<div class="card"><p class="muted" style="margin:0">Nền tảng chưa mở kênh thanh toán tự động. Liên hệ hỗ trợ để gia hạn.</p></div>' : `
    ${p ? `<div class="card" style="border-color:#f59e0b">
      <h2 style="margin-top:0">Chuyển khoản để gia hạn ${esc(p.months)} tháng</h2>
      <div class="grid2" style="align-items:center">
        <div>${p.qr_svg ? `<div style="max-width:220px">${p.qr_svg}</div>` : '<p class="muted">Không dựng được mã QR — chuyển khoản tay theo thông tin bên cạnh.</p>'}</div>
        <div>
          <p style="margin:0 0 4px">Số tiền: <strong style="font-size:1.3rem">${esc(money(p.amount_vnd))}</strong></p>
          <p style="margin:0 0 4px">Số tài khoản: <strong>${esc(p.bank_account ?? '')}</strong>${p.bank_name ? ` (${esc(p.bank_name)})` : ''}</p>
          <p style="margin:0 0 4px">Nội dung chuyển khoản <strong>BẮT BUỘC</strong>:</p>
          <p style="margin:0"><code style="font-size:1.25rem;font-weight:700">${esc(p.pay_ref)}</code></p>
          <p class="muted" style="margin:10px 0 0;font-size:.85rem">Ghi sai nội dung thì hệ thống không tự nhận ra tiền của bạn, phải xử lý tay và chậm hơn nhiều. Mã có hiệu lực tới ${dt(p.expires_at)}.</p>
        </div>
      </div>
      <p class="muted" style="margin:12px 0 0;font-size:.88rem">Chuyển xong <strong>không cần báo ai</strong> — hệ thống tự nhận trong vài phút rồi cộng hạn. Tải lại trang để xem.</p>
    </div>` : ''}
    <div class="card"><h2 style="margin-top:0">${p ? 'Đổi số tháng / đổi gói' : 'Gia hạn'}</h2>
      ${p ? '<p class="muted" style="margin-top:0">Tạo mã mới sẽ <strong>huỷ mã cũ</strong> — chỉ chuyển khoản theo mã mới nhất.</p>' : ''}
      <form method="POST" action="${base}/charge" class="actions" style="align-items:end;flex-wrap:wrap">
        <div><label>Số tháng</label><select name="months">${[1, 3, 6, 12].map((m) => `<option value="${m}"${m === 3 ? ' selected' : ''}>${m} tháng</option>`).join('')}</select></div>
        <div><label>Gói</label><select name="plan_code"><option value="">— Giữ gói hiện tại —</option>${
          (d?.plans ?? []).filter((x) => x.code !== d?.plan_code).map((x) => `<option value="${esc(x.code)}">${esc(x.name)} — ${esc(money(x.price_vnd_month))}/tháng</option>`).join('')}</select></div>
        <div><button class="btn" type="submit">Tạo mã thanh toán</button></div>
      </form>
    </div>`}
    <div class="card"><h2 style="margin-top:0">Lịch sử đóng phí</h2>
      ${(d?.invoices ?? []).length ? tblCards({
        head: [{ html: 'Ngày' }, { html: 'Gói' }, { html: 'Số tháng' }, { html: 'Số tiền', style: 'text-align:right' }, { html: 'Ghi chú' }],
        rows: d.invoices.map((i) => [
          { cls: 'muted', html: dt(i.created_at) },
          { html: esc(i.plan_code) },
          { html: esc(i.months) },
          { style: 'text-align:right', html: `<strong>${esc(money(i.amount_vnd))}</strong>` },
          { cls: 'muted', html: esc(i.note ?? '') },
        ]),
      })
        : '<p class="muted">Chưa có khoản đóng phí nào.</p>'}
    </div>`);
}

// Hàng đợi hành động từ Tổng quan. Các trang này cố ý là SSR/no-JS để người bán
// luôn có thể xem, lọc, xử lý và quay lại danh sách sau một POST.
function queueTabs(base, current, tabs, extra = '') {
  return `<div class="stabs" role="tablist">${tabs.map(([value, label]) => {
    const on = value === current;
    const href = `${base}?status=${encodeURIComponent(value)}${extra}`;
    return `<a class="stab${on ? ' on' : ''}" href="${href}"${on ? ' aria-current="page"' : ''}>${esc(label)}</a>`;
  }).join('')}</div>`;
}

function queuePager(base, filter, total) {
  const limit = Number(filter.limit) || 20;
  const offset = Number(filter.offset) || 0;
  const params = new URLSearchParams();
  if (filter.status) params.set('status', filter.status);
  if (filter.type) params.set('type', filter.type);
  params.set('limit', String(limit));
  const link = (next) => `${base}?${new URLSearchParams([...params, ['offset', String(next)]]).toString()}`;
  const pageSizeLink = (nextLimit) => {
    const next = new URLSearchParams(params);
    next.set('limit', String(nextLimit));
    next.set('offset', '0');
    return `${base}?${next.toString()}`;
  };
  return `<div class="muted" style="margin-top:12px">${esc(total)} mục ·
    ${offset > 0 ? `<a href="${link(Math.max(0, offset - limit))}">← Trước</a>` : '<span style="color:#d1d5db">← Trước</span>'} ·
    ${offset + limit < Number(total) ? `<a href="${link(offset + limit)}">Sau →</a>` : '<span style="color:#d1d5db">Sau →</span>'}
    · Mỗi trang: ${[20, 50, 100].map((n) => n === limit ? `<strong>${n}</strong>` : `<a href="${pageSizeLink(n)}">${n}</a>`).join(' · ')}</div>`;
}

export function renderNotificationDeliveries(ctx, shopId, data, filter = {}) {
  const base = `/shops/${esc(shopId)}/notification-deliveries`;
  const status = filter.status || data.status || 'failed';
  const rows = (data.deliveries ?? []).map((d) => {
    const order = d.order_id
      ? `<a href="/shops/${esc(shopId)}/orders/${esc(d.order_id)}">#${esc(d.order_number ?? '')}</a>`
      : (d.order_number != null ? `#${esc(d.order_number)}` : '—');
    const retry = d.retryable
      ? `<form method="POST" action="${base}/${esc(d.id)}/retry" style="display:inline"><button class="btn sm" type="submit">Gửi lại</button></form>`
      : `<span class="muted">${esc({
        topic_not_retryable: 'Không thuộc email đơn hàng',
        order_not_found: 'Không còn khớp đơn hàng',
        recipient_scrubbed: 'Đã xoá dữ liệu người nhận',
        retry_window_expired: 'Đã hết hạn gửi lại',
        channel_not_supported: 'Kênh không hỗ trợ gửi lại',
      }[d.retry_block_reason] ?? '—')}</span>`;
    return [
      { html: `${order}<div class="muted" style="font-size:.82rem">${esc(d.topic ?? '')}</div>` },
      { html: badge(d.channel ?? 'unknown', d.channel ?? '—') },
      { html: `${badge(d.status ?? 'unknown', d.status ?? '—')}<div class="muted" style="font-size:.82rem">${esc(d.attempts ?? 0)} lần thử</div>` },
      { cls: 'muted', html: d.last_attempt_at ? dt(d.last_attempt_at) : dt(d.updated_at ?? d.created_at) },
      { cls: 'stack', html: d.last_error ? `<span style="color:var(--bad)">${esc(d.last_error)}</span>` : (d.provider_message_id ? `Mã provider: ${esc(d.provider_message_id)}` : '—') },
      { style: 'text-align:right', html: retry },
    ];
  });
  const extra = `&limit=${encodeURIComponent(filter.limit || 20)}`;
  return layout('Thông báo cần xử lý', ctx, `
    <div class="toolbar"><div><a class="muted" href="/shops/${esc(shopId)}/overview">← Tổng quan</a><h1 style="margin:4px 0 0">Thông báo cần xử lý</h1></div></div>
    ${filter.err ? `<div class="err">${esc(filter.err)}</div>` : ''}
    ${filter.notice ? `<div class="notice success">${esc(filter.notice)}</div>` : ''}
    ${queueTabs(base, status, [['failed', 'Gửi thất bại'], ['queued', 'Đang chờ'], ['retrying', 'Đang thử lại'], ['sending', 'Đang gửi'], ['accepted', 'Đã provider nhận'], ['skipped', 'Đã bỏ qua'], ['superseded', 'Đã thay thế']], extra)}
    <div class="card"><p class="muted" style="margin-top:0">Chỉ hiện “đã gửi” sau khi nhà cung cấp chấp nhận. Lỗi email có thể gửi lại; các kênh khác cần xử lý theo cấu hình kênh.</p>
      ${rows.length ? `<div class="tblscroll">${tblCards({
        head: [{ html: 'Đơn' }, { html: 'Kênh' }, { html: 'Trạng thái' }, { html: 'Lần thử gần nhất' }, { html: 'Lỗi / mã provider' }, { html: '', label: '' }],
        rows,
      })}</div>` : '<div class="empty-state">Không có thông báo trong trạng thái này.</div>'}
      ${queuePager(base, filter, data.total ?? 0)}</div>`);
}

export function renderResolutionCases(ctx, shopId, data, filter = {}) {
  const base = `/shops/${esc(shopId)}/resolution-cases`;
  const status = filter.status || data.status || 'active';
  const rows = (data.cases ?? []).map((c) => {
    const remaining = Number(c.unresolved_qty ?? 0);
    const returned = Number(c.returned_qty ?? 0);
    const received = Number(c.received_return_qty ?? 0);
    const action = c.status === 'open'
      ? 'Mở đơn để đối soát kiện giao/hoàn'
      : c.status === 'waiting_return'
        ? `Chờ nhận hàng hoàn (${Math.max(0, returned - received)} sp)`
        : 'Đã xử lý';
    return [
      { html: `<a href="/shops/${esc(shopId)}/orders/${esc(c.order_id)}?timeline=shipment"><strong>#${esc(c.order_number)}</strong></a><div class="muted" style="font-size:.82rem">${esc(c.kind ?? 'mixed_shipment')}</div>` },
      { html: badge(c.status ?? 'unknown', c.status === 'waiting_return' ? 'Chờ hàng hoàn' : c.status === 'open' ? 'Cần xử lý' : c.status ?? '—') },
      { html: `<div>Đã giao: <strong>${esc(c.delivered_qty ?? 0)}</strong></div><div>Đã hoàn: <strong>${esc(returned)}</strong> · Đã nhận: ${esc(received)}</div><div class="muted">Chưa phân định: ${esc(remaining)}</div>` },
      { html: Number(c.required_refund_vnd ?? 0) > 0 ? `<strong>${money(c.required_refund_vnd)}</strong><div class="muted">mức hoàn tối thiểu</div>` : '—' },
      { cls: 'muted', html: dt(c.detected_at) },
      { style: 'text-align:right', html: `<a class="btn alt sm" href="/shops/${esc(shopId)}/orders/${esc(c.order_id)}?timeline=shipment">${esc(action)}</a>` },
    ];
  });
  const extra = `&limit=${encodeURIComponent(filter.limit || 20)}`;
  return layout('Ca đơn hàng cần xử lý', ctx, `
    <div class="toolbar"><div><a class="muted" href="/shops/${esc(shopId)}/overview">← Tổng quan</a><h1 style="margin:4px 0 0">Ca đơn hàng cần xử lý</h1></div></div>
    ${queueTabs(base, status, [['active', 'Đang mở'], ['open', 'Mở'], ['waiting_return', 'Chờ hàng hoàn'], ['resolved', 'Đã xử lý']], extra)}
    <div class="card"><div class="notice warn" style="margin-top:0">Không tự hoàn tiền hoặc nhập lại kho chỉ vì hãng báo hoàn. Mở chi tiết đơn để xác nhận từng số lượng và chọn bước tiếp theo.</div>
      ${rows.length ? `<div class="tblscroll">${tblCards({
        head: [{ html: 'Đơn' }, { html: 'Trạng thái ca' }, { html: 'Tiến độ số lượng' }, { html: 'Hoàn tiền' }, { html: 'Phát hiện' }, { html: '', label: '' }],
        rows,
      })}</div>` : '<div class="empty-state">Không có ca nào trong trạng thái này.</div>'}
      ${queuePager(base, filter, data.total ?? 0)}</div>`);
}

export function renderOrderRequests(ctx, shopId, data, filter = {}) {
  const base = `/shops/${esc(shopId)}/order-requests`;
  const status = filter.status || data.status || 'requested';
  const type = filter.type || data.type || '';
  const typeLabel = { cancel: 'Hủy đơn', address_change: 'Đổi địa chỉ', return: 'Trả hàng' };
  const rows = (data.requests ?? []).map((r) => {
    const canDecide = r.status === 'requested';
    const note = (required = false) => `<label style="margin:0 0 4px">Ghi chú quyết định${required ? ' *' : ''}</label><input name="note" maxlength="500" placeholder="Lý do / hướng xử lý"${required ? ' required' : ''}${canDecide ? '' : ' disabled'}>`;
    const orderId = `<input type="hidden" name="order_id" value="${esc(r.order_id)}">`;
    const actions = canDecide ? `<div class="actions" style="justify-content:flex-end;flex-wrap:wrap">
      <form method="POST" action="${base}/${esc(r.id)}/approve" style="display:flex;gap:6px;align-items:end;flex-wrap:wrap">${orderId}${note()}<button class="btn sm" type="submit">Chấp thuận</button></form>
      <form method="POST" action="${base}/${esc(r.id)}/reject" style="display:flex;gap:6px;align-items:end;flex-wrap:wrap">${orderId}${note(true)}<button class="btn warn sm" type="submit">Từ chối</button></form>
    </div>` : (r.status === 'approved' && r.request_type === 'return'
      ? `<a class="btn sm" href="/shops/${esc(shopId)}/orders/${esc(r.order_id)}/return?request_id=${encodeURIComponent(r.id)}">Tiếp tục nhận trả</a>`
      : `<span class="muted">${esc(r.decision_note ?? 'Đã có quyết định')}</span>`);
    const payload = r.request_payload && typeof r.request_payload === 'object' ? r.request_payload : {};
    return [
      { html: `<a href="/shops/${esc(shopId)}/orders/${esc(r.order_id)}"><strong>#${esc(r.order_number)}</strong></a><div class="muted" style="font-size:.82rem">${esc(r.customer_name ?? '')} · ${esc(r.customer_phone ?? '')}</div>` },
      { html: badge(r.request_type ?? 'unknown', typeLabel[r.request_type] ?? r.request_type ?? '—') },
      { html: `${badge(r.status ?? 'unknown', r.status ?? '—')}<div class="muted" style="font-size:.82rem">${dt(r.created_at)}</div>` },
      { cls: 'stack', html: `${esc(r.reason ?? '')}${r.request_type === 'address_change' && payload.line ? `<div class="muted" style="margin-top:4px">Địa chỉ mới: ${esc(payload.line)}, ${esc(payload.province ?? '')}</div>` : ''}` },
      { style: 'min-width:260px', html: actions },
    ];
  });
  const extra = `&limit=${encodeURIComponent(filter.limit || 20)}${type ? `&type=${encodeURIComponent(type)}` : ''}`;
  return layout('Yêu cầu của khách', ctx, `
    <div class="toolbar"><div><a class="muted" href="/shops/${esc(shopId)}/overview">← Tổng quan</a><h1 style="margin:4px 0 0">Yêu cầu của khách</h1></div></div>
    ${filter.err ? `<div class="err">${esc(filter.err)}</div>` : ''}
    ${filter.notice ? `<div class="notice success">${esc(filter.notice)}</div>` : ''}
    ${queueTabs(base, status, [['requested', 'Chờ shop xử lý'], ['approved', 'Đã chấp thuận'], ['completed', 'Đã hoàn tất'], ['rejected', 'Đã từ chối']], extra)}
    <div class="card"><form method="GET" class="filters" style="align-items:end;margin-bottom:14px"><input type="hidden" name="status" value="${esc(status)}"><input type="hidden" name="limit" value="${esc(filter.limit || 20)}"><div><label>Loại yêu cầu</label><select name="type"><option value="">Tất cả</option>${Object.entries(typeLabel).map(([k, v]) => `<option value="${k}"${type === k ? ' selected' : ''}>${v}</option>`).join('')}</select></div><button class="btn alt sm" type="submit">Lọc</button></form>
      ${rows.length ? `<div class="tblscroll">${tblCards({
        head: [{ html: 'Đơn / khách' }, { html: 'Loại' }, { html: 'Trạng thái' }, { html: 'Nội dung yêu cầu' }, { html: 'Quyết định' }],
        rows,
      })}</div>` : '<div class="empty-state">Không có yêu cầu trong trạng thái này.</div>'}
      ${queuePager(base, filter, data.total ?? 0)}</div>`);
}

// `action` (tuỳ chọn) = { href, label }: lối đi TIẾP, không phải lối lùi. Trang lỗi chỉ có
// "Về bảng điều khiển" là đủ khi lỗi là tạm thời; khi lỗi là "vai của bạn không mở được màn
// này" thì thứ người dùng cần là màn hình họ mở ĐƯỢC, nói tên ra hẳn.
export function renderError(ctx, msg, action = null) {
  return layout('Lỗi', ctx, `<div class="card"><h1>Rất tiếc</h1><p class="err">${esc(msg)}</p>${
    action ? `<a class="btn" href="${esc(action.href)}">${esc(action.label)}</a> ` : ''
  }<a class="btn alt" href="/">Về bảng điều khiển</a></div>`);
}

// ── Cộng tác viên (CTV / affiliate) — docs/51 ────────────────────────────────
// Màn hình phải trả lời đúng ba câu chủ shop hỏi: ai đang bán cho tôi · tôi NỢ ai bao
// nhiêu · bấm đâu để trả. Mọi thứ khác là phụ.
export function renderAffiliates(ctx, shopId, data, cfg, err, ok) {
  const base = `/shops/${esc(shopId)}`;
  const list = data.affiliates ?? [];
  const rateOf = (a) => (a.rate_kind == null
    ? `<span class="muted">chung (${cfg.rate_kind === 'percent' ? `${esc(cfg.rate_value)}%` : money(cfg.rate_value)})</span>`
    : (a.rate_kind === 'percent' ? `${esc(a.rate_value)}%` : money(a.rate_value)));
  const rows = list.map((a) => [
    { html: `<a href="${base}/affiliates/${esc(a.id)}"><strong>${esc(a.code)}</strong></a>
        <div class="muted" style="font-size:.84rem">${esc(a.name)}${a.phone ? ` · ${esc(a.phone)}` : ''}</div>` },
    { html: rateOf(a) },
    { cls: 'num right', html: esc(a.order_count) },
    { cls: 'num right muted', html: money(a.pending_vnd) },
    { cls: 'num right', html: `<strong>${money(a.eligible_vnd)}</strong>` },
    { cls: 'num right muted', html: money(a.paid_vnd) },
    { html: a.active ? 'Đang chạy' : '<span class="muted">Đã tắt</span>' },
  ]);
  const owed = list.reduce((s, a) => s + Number(a.eligible_vnd || 0), 0);
  return layout('Cộng tác viên', ctx, `
    <h1>Cộng tác viên</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${ok ? `<div class="ok">${esc(ok)}</div>` : ''}
    <div class="card"><h2 style="margin-top:0">Chương trình hoa hồng</h2>
      <p class="muted" style="margin-top:0">Hoa hồng chốt khi đơn <strong>đã giao</strong> và qua hạn đổi trả —
        đơn bị huỷ/hoàn trong hạn thì hoa hồng tự rụng, bạn không phải đi đòi lại tiền đã trả.</p>
      <form method="POST" action="${base}/affiliates/config">
        <label><input type="checkbox" name="enabled" value="on"${cfg.enabled ? ' checked' : ''}> Bật chương trình cộng tác viên</label>
        <div class="grid2">
          <div><label>Mức hoa hồng chung</label>
            <select name="rate_kind">
              <option value="percent"${cfg.rate_kind === 'percent' ? ' selected' : ''}>Phần trăm (%)</option>
              <option value="fixed"${cfg.rate_kind === 'fixed' ? ' selected' : ''}>Số tiền cố định (đ/đơn)</option>
            </select></div>
          <div><label>Giá trị</label><input name="rate_value" type="number" min="1" required value="${esc(cfg.rate_value)}"></div>
          <div><label>Hạn giữ hoa hồng (ngày sau khi giao)</label><input name="hold_days" type="number" min="0" max="90" value="${esc(cfg.hold_days)}"></div>
          <div><label>Ghi nhớ mã giới thiệu (ngày)</label><input name="cookie_days" type="number" min="1" max="90" value="${esc(cfg.cookie_days)}"></div>
        </div>
        <label><input type="checkbox" name="block_self_referral" value="on"${cfg.block_self_referral ? ' checked' : ''}>
          Chặn CTV tự mua qua mã của mình (khớp số điện thoại)</label>
        <button class="btn sm" type="submit" style="margin-top:12px">Lưu chương trình</button>
      </form>
    </div>
    <div class="card"><h2 style="margin-top:0">Thêm cộng tác viên</h2>
      <form method="POST" action="${base}/affiliates">
        <div class="grid2">
          <div><label>Mã giới thiệu *</label><input name="code" required maxlength="24" placeholder="HAU2025"
            pattern="[A-Za-z0-9][A-Za-z0-9-]{1,23}"></div>
          <div><label>Tên cộng tác viên *</label><input name="name" required maxlength="120"></div>
          <div><label>Số điện thoại</label><input name="phone" maxlength="20"></div>
          <div><label>Email</label><input name="email" type="email" maxlength="254"></div>
        </div>
        <p class="muted" style="margin:6px 0 0">Mức riêng — bỏ trống để dùng mức chung ở trên.</p>
        <div class="grid2">
          <div><label>Loại</label><select name="rate_kind"><option value="">— dùng mức chung —</option>
            <option value="percent">Phần trăm (%)</option><option value="fixed">Số tiền cố định</option></select></div>
          <div><label>Giá trị</label><input name="rate_value" type="number" min="1"></div>
        </div>
        <button class="btn" type="submit" style="margin-top:12px">Thêm cộng tác viên</button>
      </form>
    </div>
    <div class="card"><h2 style="margin-top:0">Danh sách${owed > 0 ? ` <span class="muted" style="font-size:.9rem;font-weight:400">— đang nợ ${money(owed)}</span>` : ''}</h2>
      ${rows.length ? `<div class="tblscroll">${tblCards({
        head: [
          { html: 'Mã / tên' }, { html: 'Hoa hồng' }, { html: 'Đơn', cls: 'right' }, { html: 'Tạm tính', cls: 'right' },
          { html: 'Chờ chi', cls: 'right' }, { html: 'Đã trả', cls: 'right' }, { html: 'Trạng thái' },
        ],
        rows,
      })}</div>`
        : '<p class="muted" style="margin-bottom:0">Chưa có cộng tác viên nào.</p>'}</div>`);
}

export function renderAffiliateDetail(ctx, shopId, d, err, ok) {
  const base = `/shops/${esc(shopId)}`;
  const a = d.affiliate, t = d.totals, cu = d.cod_unsettled ?? { amount_vnd: 0, orders: 0 };
  const LABEL = { pending: 'Tạm tính', eligible: 'Chờ chi', void: 'Đã rụng', paid: 'Đã trả' };
  const rows = (d.commissions ?? []).map((k) => [
    { html: `<a href="${base}/orders/${esc(k.order_id)}">#${esc(k.order_number)}</a>
        ${k.cod_unsettled ? '<div class="muted" style="font-size:.8rem">🚚 hãng chưa chuyển tiền</div>' : ''}` },
    { cls: 'num right muted', html: money(k.base_vnd) },
    { cls: 'num right', html: `<strong>${money(k.amount_vnd)}</strong>` },
    { html: `${esc(LABEL[k.status] ?? k.status)}${k.void_reason ? `<div class="muted" style="font-size:.8rem">${esc(k.void_reason)}</div>` : ''}` },
  ]);
  const payRows = (d.payouts ?? []).map((p) => [
    { html: esc(String(p.paid_at).slice(0, 10)) },
    { cls: 'num right', html: `<strong>${money(p.amount_vnd)}</strong>` },
    { cls: 'num right muted', html: esc(p.item_count) },
    { cls: 'muted', html: `${esc(p.method ?? '')} ${esc(p.note ?? '')}` },
  ]);
  return layout(`CTV: ${a.code}`, ctx, `
    <a class="muted" href="${base}/affiliates">← Cộng tác viên</a>
    <h1>${esc(a.name)} <span class="muted">${esc(a.code)}</span></h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${ok ? `<div class="ok">${esc(ok)}</div>` : ''}
    <div class="metrics">
      <div class="metric"><div class="l">Tạm tính</div><div class="v">${money(t.pending_vnd)}</div><div class="l">chờ giao xong</div></div>
      <div class="metric"><div class="l">Chờ chi</div><div class="v">${money(t.eligible_vnd)}</div><div class="l">đủ điều kiện trả</div></div>
      <div class="metric"><div class="l">Đã trả</div><div class="v">${money(t.paid_vnd)}</div><div class="l">tổng từ trước tới nay</div></div>
      <div class="metric"><div class="l">Đã rụng</div><div class="v muted">${money(t.void_vnd)}</div><div class="l">đơn huỷ/hoàn</div></div>
    </div>
    <div class="card"><h2 style="margin-top:0">Chi tiền cho cộng tác viên</h2>
      ${cu.amount_vnd > 0 ? `<div class="card" style="border-color:#bfdbfe;background:#eff6ff;margin:0 0 12px">
        <p style="margin:0" class="muted">🚚 Trong khoản chờ chi, có <strong>${money(cu.amount_vnd)}</strong> thuộc
        <strong>${esc(cu.orders)}</strong> đơn COD mà <strong>hãng chưa chuyển tiền về</strong>. Bạn vẫn trả được —
        chỉ để bạn biết mình đang ứng trước. Đối chiếu ở <a href="${base}/cod">Đối soát COD</a>.</p></div>` : ''}
      ${t.eligible_vnd > 0 ? `<form method="POST" action="${base}/affiliates/${esc(a.id)}/payouts">
        <p>Chốt phiếu chi <strong>${money(t.eligible_vnd)}</strong> — gom mọi hoa hồng đang ở trạng thái “chờ chi”.</p>
        <div class="grid2">
          <div><label>Hình thức</label><input name="method" maxlength="40" placeholder="chuyển khoản / tiền mặt"></div>
          <div><label>Ngày chi</label><input name="paid_at" type="date"></div>
        </div>
        <label>Ghi chú</label><input name="note" maxlength="500">
        <button class="btn" type="submit" data-confirm="Xác nhận đã chi ${money(t.eligible_vnd)} cho ${esc(a.name)}? Phiếu chi KHÔNG sửa/xoá được." style="margin-top:12px">Đã chi tiền</button>
      </form>` : '<p class="muted" style="margin-bottom:0">Chưa có hoa hồng nào đủ điều kiện chi.</p>'}
    </div>
    <div class="card"><h2 style="margin-top:0">Hoa hồng theo đơn</h2>
      ${rows.length ? `<div class="tblscroll">${tblCards({
        head: [{ html: 'Đơn' }, { html: 'Căn cứ', cls: 'right' }, { html: 'Hoa hồng', cls: 'right' }, { html: 'Trạng thái' }],
        rows,
      })}</div>`
        : '<p class="muted" style="margin-bottom:0">Chưa có đơn nào qua mã này.</p>'}</div>
    ${payRows ? `<div class="card"><h2 style="margin-top:0">Phiếu đã chi</h2>
      <div class="tblscroll">${tblCards({
        head: [{ html: 'Ngày' }, { html: 'Số tiền', cls: 'right' }, { html: 'Số dòng', cls: 'right' }, { html: 'Ghi chú' }],
        rows: payRows,
      })}</div></div>` : ''}`);
}
