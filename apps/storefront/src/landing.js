/**
 * Trang CHỦ công ty của nền tảng (nentang.vn gốc — không phải shop nào): marketing + bảng giá.
 * Dùng khung chung site.js (nav/footer/CSS nền). SSR tĩnh, KHÔNG JS, hợp CSP nghiêm —
 * mọi "ảnh" là SVG nội tuyến + gradient CSS; hiệu ứng 3D/cuộn/parallax bằng CSS THUẦN.
 *
 * An toàn: hiệu ứng cuộn (scroll-driven) chỉ bật khi trình duyệt HỖ TRỢ + người dùng KHÔNG
 * chọn "giảm chuyển động" — nếu không, nội dung hiện đầy đủ bình thường (không kẹt ẩn).
 * Sửa nội dung: chỉnh các mảng dữ liệu dưới đây.
 */
import { esc, I, mailtoHref, sitePage } from './site.js';

// ── DỮ LIỆU (sửa nội dung ở đây) ─────────────────────────────────────────────
const STATS = [
  { n: '3 phút', l: 'Có cửa hàng mẫu để xem ngay' },
  { n: '0đ', l: 'Phí thiết lập ban đầu' },
  { n: '100%', l: 'Tiền khách trả vào thẳng tài khoản bạn' },
  { n: '24/7', l: 'Cửa hàng luôn online, không lo sập' },
];
const FEATURES = [
  { icon: I.store, t: 'Cửa hàng đẹp, đâu ra đấy', d: 'Giao diện hiện đại, tự đổi màu thương hiệu, logo, phông chữ và nội dung trang chủ — không cần biết code.' },
  { icon: I.seo, t: 'Chuẩn SEO, tự lên Google', d: 'Sitemap, dữ liệu có cấu trúc, tốc độ nhanh. Khách tìm là thấy cửa hàng của bạn.' },
  { icon: I.cart, t: 'Bán hàng dễ như trở tay', d: 'Sản phẩm, đơn hàng, tồn kho, danh mục, blog — gói gọn trong một trang quản trị.' },
  { icon: I.wallet, t: 'Tiền vào thẳng túi bạn', d: 'COD và chuyển khoản QR VietQR. Chúng tôi KHÔNG giữ tiền của bạn, không ôm dòng tiền.' },
  { icon: I.shield, t: 'Bảo mật & sao lưu tự động', d: 'Máy chủ, chứng chỉ HTTPS, sao lưu, cập nhật — chúng tôi lo. Bạn chỉ việc bán.' },
  { icon: I.headset, t: 'Có người thật hỗ trợ', d: 'Dựng shop, cấu hình thanh toán, gỡ rối — đội ngũ đồng hành cùng bạn, không bỏ mặc.' },
];
const INDUSTRIES = [
  { icon: I.shirt, name: 'Thời trang', a: '#db2777', b: '#7c3aed' },
  { icon: I.cosmetic, name: 'Mỹ phẩm', a: '#e11d48', b: '#9f1239' },
  { icon: I.sofa, name: 'Nội thất', a: '#d97706', b: '#92400e' },
  { icon: I.device, name: 'Điện tử', a: '#2563eb', b: '#1e3a8a' },
  { icon: I.baby, name: 'Mẹ & Bé', a: '#0d9488', b: '#115e59' },
  { icon: I.food, name: 'Thực phẩm', a: '#ea580c', b: '#9a3412' },
  { icon: I.book, name: 'Nhà sách', a: '#4f46e5', b: '#3730a3' },
  { icon: I.gift, name: 'Quà tặng · Handmade', a: '#7c3aed', b: '#5b21b6' },
];
const STEPS = [
  { n: '1', t: 'Bạn liên hệ', d: 'Cho chúng tôi biết bạn bán gì và tên thương hiệu bạn muốn.' },
  { n: '2', t: 'Chúng tôi dựng shop', d: 'Tạo website, cấu hình thanh toán, hướng dẫn bạn dùng — trọn gói, trong vài ngày.' },
  { n: '3', t: 'Bạn bắt đầu bán', d: 'Đăng sản phẩm, nhận đơn, thu tiền. Đơn giản vậy thôi.' },
];
const TESTIMONIALS = [
  { q: 'Trước tôi bán qua Facebook, đơn hay sót. Có website riêng, khách tự đặt, tôi chỉ việc gói hàng. Nhàn hẳn.', name: 'Chị Hương', role: 'Shop thời trang, Hà Nội' },
  { q: 'Cái tôi thích nhất là tiền khách chuyển khoản vào thẳng tài khoản mình, không qua trung gian. Rõ ràng, yên tâm.', name: 'Anh Tuấn', role: 'Đồ nội thất, TP.HCM' },
  { q: 'Không rành công nghệ mà vẫn có shop chuẩn SEO. Bên này dựng giúp hết, cần gì nhắn là được hỗ trợ.', name: 'Chị Mai', role: 'Mỹ phẩm handmade, Đà Nẵng' },
];
const FAQS = [
  { q: 'Tôi không biết gì về kỹ thuật, có dùng được không?', a: 'Được. Chúng tôi dựng sẵn cửa hàng cho bạn và hướng dẫn tận tay. Việc của bạn chỉ là đăng sản phẩm và xử lý đơn — mọi phần kỹ thuật (máy chủ, bảo mật, sao lưu) do chúng tôi lo.' },
  { q: 'Tiền khách hàng trả có qua trung gian không?', a: 'Không. Khách thanh toán COD hoặc chuyển khoản QR VietQR vào thẳng tài khoản ngân hàng của bạn. Chúng tôi không giữ, không ôm dòng tiền của bạn.' },
  { q: 'Tôi có được dùng tên miền riêng không?', a: 'Có. Bạn có thể dùng tên miền phụ miễn phí dạng shop.nentang.vn, hoặc gắn tên miền riêng của bạn (vd cuahangcuaban.com) ở gói Growth.' },
  { q: 'Nếu muốn ngừng thì dữ liệu của tôi thế nào?', a: 'Dữ liệu là của bạn. Bạn có thể xuất toàn bộ sản phẩm, đơn hàng, khách hàng ra file bất cứ lúc nào trong trang quản trị.' },
  { q: 'Chi phí có phát sinh gì ẩn không?', a: 'Không. Bạn trả theo gói hằng tháng đã niêm yết, nâng/hạ gói bất cứ lúc nào. Không phí thiết lập, không phí ẩn.' },
];
const PLANS = [
  { code: 'platform', name: 'Platform', price: '990.000', unit: 'đ/tháng', hot: false, tagline: 'Bắt đầu bán online', feat: ['100 sản phẩm', 'Tên miền phụ .nentang.vn', 'COD + QR chuyển khoản', 'Quản lý đơn · tồn kho · danh mục'] },
  { code: 'care', name: 'Care', price: '2.490.000', unit: 'đ/tháng', hot: true, tagline: 'Đầy đủ để bán tốt', feat: ['Tất cả gói Platform', 'Blog & SEO nâng cao', 'Trình dựng giao diện sâu', 'Hỗ trợ ưu tiên'] },
  { code: 'growth', name: 'Growth', price: '5.900.000', unit: 'đ/tháng', hot: false, tagline: 'Cho cửa hàng lớn', feat: ['Tất cả gói Care', '500 sản phẩm', 'Tên miền riêng của bạn', 'Đối soát QR tự động'] },
];

// CSS RIÊNG của trang chủ (hiệu ứng 3D/cuộn/glass — CSS THUẦN, không JS, hợp CSP).
const CSS = `
/* ══ HERO: nền mesh gradient + lưới chấm + quả cầu phát sáng bay ══ */
.hero{position:relative;overflow:hidden;padding:88px 0 100px;background:var(--bg);isolation:isolate}
.hero::before{content:"";position:absolute;inset:0;z-index:-3;background:
  radial-gradient(58% 48% at 8% -12%,color-mix(in srgb,var(--pri) 24%,transparent),transparent 70%),
  radial-gradient(52% 44% at 110% 2%,color-mix(in srgb,var(--pri2) 22%,transparent),transparent 66%),
  radial-gradient(46% 42% at 50% 122%,color-mix(in srgb,var(--pri) 14%,transparent),transparent 70%)}
.hero::after{content:"";position:absolute;inset:0;z-index:-3;opacity:.55;
  background-image:radial-gradient(color-mix(in srgb,var(--ink) 9%,transparent) 1px,transparent 1.4px);background-size:24px 24px;
  -webkit-mask-image:radial-gradient(72% 62% at 50% 26%,#000,transparent 80%);mask-image:radial-gradient(72% 62% at 50% 26%,#000,transparent 80%)}
.orb{position:absolute;z-index:-2;border-radius:50%;filter:blur(48px);opacity:.55;pointer-events:none}
.orb.o1{width:360px;height:360px;background:radial-gradient(circle,color-mix(in srgb,var(--pri) 62%,transparent),transparent 70%);top:-70px;left:-70px}
.orb.o2{width:320px;height:320px;background:radial-gradient(circle,color-mix(in srgb,var(--pri2) 56%,transparent),transparent 70%);top:30px;right:-50px}
.orb.o3{width:240px;height:240px;background:radial-gradient(circle,color-mix(in srgb,var(--good) 40%,transparent),transparent 70%);bottom:-80px;left:36%}
.hero-grid{position:relative;display:grid;grid-template-columns:1.05fr .95fr;gap:56px;align-items:center}
.hero h1{font-size:clamp(2.4rem,5vw,4rem);line-height:1.05;letter-spacing:-.035em;font-weight:800;margin:0 0 20px;text-wrap:balance}
.hero h1 .g{color:var(--pri)}
@supports((-webkit-background-clip:text) or (background-clip:text)){
  .hero h1 .g{background:linear-gradient(100deg,var(--pri),var(--pri2) 52%,var(--pri));background-size:220% 100%;-webkit-background-clip:text;background-clip:text;color:transparent}
}
.hero .lead{font-size:clamp(1.06rem,2vw,1.3rem);color:var(--soft);max-width:566px;margin:0 0 30px}
.hero-cta{display:flex;gap:14px;flex-wrap:wrap}
.hero-cta .btn-primary{background:linear-gradient(135deg,var(--brand),var(--pri2));background-size:160% 160%;box-shadow:0 14px 34px -12px color-mix(in srgb,var(--pri) 70%,transparent);position:relative;overflow:hidden}
.hero-cta .btn-primary:hover{background-position:100% 0}
.hero-trust{display:flex;gap:20px;flex-wrap:wrap;margin-top:24px}
.hero-trust span{display:inline-flex;align-items:center;gap:6px;font-size:.85rem;color:var(--soft);font-weight:500}.hero-trust svg{width:16px;height:16px;color:var(--good)}
/* ══ MOCKUP 3D (cửa hàng mẫu) — nghiêng phối cảnh + trôi nhẹ ══ */
.mock-wrap{position:relative;perspective:1600px}
.mock{border-radius:20px;background:var(--card);border:1px solid var(--bd);box-shadow:0 60px 100px -50px rgba(13,21,38,.55),0 0 0 1px color-mix(in srgb,var(--bd) 55%,transparent);overflow:hidden;transform:rotateY(-9deg) rotateX(4deg);transform-origin:left center;transition:transform .5s cubic-bezier(.2,.7,.2,1)}
.mock-wrap:hover .mock{transform:rotateY(-3deg) rotateX(1.5deg)}
.mock-bar{display:flex;align-items:center;gap:7px;padding:12px 15px;background:var(--surf);border-bottom:1px solid var(--bd)}
.mock-bar i{width:11px;height:11px;border-radius:50%;background:#d4d9e2;display:block}
.mock-bar i:nth-child(1){background:#fca5a5}.mock-bar i:nth-child(2){background:#fcd34d}.mock-bar i:nth-child(3){background:#86efac}
.mock-bar .url{margin-left:8px;flex:1;height:20px;border-radius:6px;background:color-mix(in srgb,var(--bd) 55%,var(--card));font-size:.7rem;color:var(--mut);display:flex;align-items:center;padding:0 10px}
.mk-screen{padding:16px}
.mk-top{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.mk-logo{font-size:.8rem;font-weight:800;color:var(--pri);letter-spacing:-.01em}
.mk-nav{flex:1;height:8px;border-radius:5px;background:var(--bd);max-width:130px}
.mk-dot{width:26px;height:26px;border-radius:8px;background:var(--wash);border:1px solid var(--bd);display:grid;place-items:center;color:var(--pri)}.mk-dot svg{width:14px;height:14px}
.mk-banner{height:82px;border-radius:12px;background:linear-gradient(120deg,var(--brand),var(--brand2));position:relative;margin-bottom:16px;overflow:hidden;display:flex;flex-direction:column;justify-content:center;padding:0 18px;color:#fff}
.mk-banner::after{content:"";position:absolute;inset:0;background:radial-gradient(60% 120% at 90% -10%,rgba(255,255,255,.28),transparent 55%)}
.mkb-t{font-size:.9rem;font-weight:700;position:relative}
.mkb-btn{margin-top:8px;align-self:flex-start;background:#fff;color:var(--brand);font-size:.72rem;font-weight:700;padding:5px 12px;border-radius:7px;position:relative}
.mk-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:11px}
.mk-card{border:1px solid var(--bd);border-radius:11px;overflow:hidden;background:var(--card)}
.mk-img{aspect-ratio:1.1;display:grid;place-items:center;color:rgba(255,255,255,.95)}.mk-img svg{width:28px;height:28px}
.mk-body{padding:8px 9px 9px}
.mk-l{height:7px;border-radius:4px;background:var(--bd);margin-bottom:8px;width:82%}
.mk-row{display:flex;align-items:center;justify-content:space-between}
.mk-price{font-size:.7rem;font-weight:800;color:var(--ink)}
.mk-buy{width:22px;height:17px;border-radius:6px;background:var(--good);display:grid;place-items:center}.mk-buy svg{width:11px;height:11px;color:#fff}
.mk-noti{position:absolute;left:-18px;bottom:24px;z-index:2;background:color-mix(in srgb,var(--card) 82%,transparent);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border:1px solid var(--bd);border-radius:14px;padding:11px 15px;display:flex;align-items:center;gap:10px;box-shadow:0 24px 48px -18px rgba(13,21,38,.5)}
.mk-noti .ico{width:30px;height:30px;border-radius:9px;background:color-mix(in srgb,var(--good) 18%,transparent);color:var(--good);display:grid;place-items:center}.mk-noti .ico svg{width:16px;height:16px}
.mk-noti b{font-size:.85rem;display:block}.mk-noti span{font-size:.72rem;color:var(--mut)}
/* ══ STATS ══ */
.stats{border-top:1px solid var(--bd);border-bottom:1px solid var(--bd);background:var(--surf)}
.stats .wrap{display:grid;grid-template-columns:repeat(4,1fr);gap:20px;padding:34px 24px}
.stat .n{font-size:clamp(1.6rem,3vw,2rem);font-weight:800;letter-spacing:-.02em;color:var(--pri)}
@supports((-webkit-background-clip:text) or (background-clip:text)){
  .stat .n{background:linear-gradient(120deg,var(--pri),var(--pri2));-webkit-background-clip:text;background-clip:text;color:transparent}
}
.stat .l{font-size:.9rem;color:var(--mut);margin-top:4px}
/* ══ FEATURES: thẻ kính + nghiêng 3D khi rê ══ */
.feat-grid{display:grid;gap:22px;grid-template-columns:repeat(3,1fr)}
.feat{position:relative;background:color-mix(in srgb,var(--card) 88%,transparent);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);border:1px solid var(--bd);border-radius:20px;padding:30px;transition:transform .3s cubic-bezier(.2,.7,.2,1),box-shadow .3s,border-color .3s}
.feat:hover{transform:translateY(-6px) rotateX(4deg);border-color:color-mix(in srgb,var(--pri) 34%,var(--bd));box-shadow:0 30px 60px -32px color-mix(in srgb,var(--pri) 60%,transparent)}
.feat-ic{width:54px;height:54px;border-radius:15px;background:linear-gradient(135deg,color-mix(in srgb,var(--pri) 18%,transparent),color-mix(in srgb,var(--pri2) 16%,transparent));color:var(--pri);display:grid;place-items:center;margin-bottom:18px;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--pri) 22%,transparent)}.feat-ic svg{width:26px;height:26px}
.feat h3{margin:0 0 8px;font-size:1.16rem;font-weight:700}.feat p{margin:0;color:var(--mut);font-size:.96rem}
/* ══ INDUSTRIES: thẻ gradient + nâng 3D + quét sáng ══ */
.ind-wrap{background:var(--surf)}
.ind-grid{display:grid;gap:16px;grid-template-columns:repeat(4,1fr)}
.ind{position:relative;aspect-ratio:1.35;border-radius:18px;padding:18px;display:flex;flex-direction:column;justify-content:space-between;color:#fff;overflow:hidden;box-shadow:0 18px 36px -22px rgba(13,21,38,.7);transition:transform .3s cubic-bezier(.2,.7,.2,1),box-shadow .3s}
.ind:hover{transform:translateY(-6px) scale(1.02)}
.ind::after{content:"";position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.5),transparent 58%);pointer-events:none}
.ind::before{content:"";position:absolute;top:0;left:-120%;width:70%;height:100%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.35),transparent);transform:skewX(-18deg);transition:left .6s ease}
.ind:hover::before{left:130%}
.ind-ic{position:relative;z-index:1;width:46px;height:46px;border-radius:13px;background:rgba(0,0,0,.2);display:grid;place-items:center}.ind-ic svg{width:26px;height:26px;color:#fff}
.ind-name{position:relative;z-index:1;font-weight:700;font-size:1.05rem;text-shadow:0 1px 10px rgba(0,0,0,.45)}
/* ══ STEPS ══ */
.steps{display:grid;gap:24px;grid-template-columns:repeat(3,1fr);position:relative}
.step{text-align:center;padding:0 8px}
.step .n{width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;font-weight:800;font-size:1.4rem;display:grid;place-items:center;margin:0 auto 16px;box-shadow:0 16px 32px -12px var(--brand)}
.step h3{margin:0 0 6px;font-size:1.2rem}.step p{margin:0;color:var(--mut);font-size:.98rem}
/* ══ PRICING ══ */
.pricing{background:var(--surf)}
.plans{display:grid;gap:24px;grid-template-columns:repeat(3,1fr);align-items:start}
.plan{position:relative;background:color-mix(in srgb,var(--card) 90%,transparent);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);border:1px solid var(--bd);border-radius:22px;padding:34px 28px;display:flex;flex-direction:column;transition:transform .3s,box-shadow .3s}
.plan:hover{transform:translateY(-5px)}
.plan.hot{border:2px solid transparent;background:linear-gradient(var(--card),var(--card)) padding-box,linear-gradient(135deg,var(--brand),var(--pri2)) border-box;box-shadow:0 36px 70px -34px color-mix(in srgb,var(--pri) 65%,transparent)}
.plan-badge{position:absolute;top:-15px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;font-size:.76rem;font-weight:700;padding:6px 16px;border-radius:999px;white-space:nowrap;box-shadow:0 10px 22px -8px var(--brand)}
.plan-tag{font-size:.85rem;color:var(--mut);font-weight:600}
.plan-name{font-weight:800;font-size:1.35rem;margin:2px 0 6px}
.plan-price{font-size:2.3rem;font-weight:800;letter-spacing:-.02em;margin:0 0 22px}.plan-price span{font-size:.95rem;font-weight:500;color:var(--mut)}
.plan ul{list-style:none;padding:0;margin:0 0 26px;flex:1;display:flex;flex-direction:column;gap:12px}
.plan li{display:flex;align-items:flex-start;gap:10px;color:var(--soft);font-size:.96rem}
.plan li svg{width:18px;height:18px;flex:none;color:var(--good);margin-top:2px}
/* ══ TESTIMONIALS ══ */
.tst-grid{display:grid;gap:22px;grid-template-columns:repeat(3,1fr)}
.tst{background:color-mix(in srgb,var(--card) 88%,transparent);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);border:1px solid var(--bd);border-radius:20px;padding:30px;display:flex;flex-direction:column;transition:transform .3s,box-shadow .3s}
.tst:hover{transform:translateY(-4px);box-shadow:0 26px 52px -30px rgba(13,21,38,.4)}
.tst .quote{font-size:2.8rem;line-height:1;color:var(--pri);font-family:Georgia,"Times New Roman",serif;height:26px;opacity:.6}
.tst p{margin:12px 0 20px;color:var(--soft);font-size:1rem;line-height:1.7;flex:1}
.tst .who{display:flex;align-items:center;gap:12px}
.tst .av{width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;font-weight:700;display:grid;place-items:center}
.tst .nm{font-weight:700;font-size:.95rem}.tst .rl{font-size:.85rem;color:var(--mut)}
/* ══ HIỆU ỨNG CUỘN TIẾT LỘ + TRÔI — chỉ khi TRÌNH DUYỆT HỖ TRỢ & không giảm chuyển động.
   Trình duyệt cũ / giảm chuyển động: cả khối này không áp → nội dung HIỆN bình thường. ══ */
@media(prefers-reduced-motion:no-preference){
  @supports(animation-timeline:view()){
    .reveal{opacity:0;transform:translateY(42px);animation:reveal-in both;animation-timeline:view();animation-range:entry 4% cover 32%}
    @keyframes reveal-in{to{opacity:1;transform:none}}
  }
  .orb{animation:drift 16s ease-in-out infinite}
  .orb.o2{animation-duration:20s;animation-direction:reverse}
  .orb.o3{animation-duration:24s}
  @keyframes drift{0%,100%{transform:translate(0,0)}33%{transform:translate(28px,-22px)}66%{transform:translate(-20px,18px)}}
  .mock-wrap{animation:floaty 7s ease-in-out infinite}
  @keyframes floaty{0%,100%{transform:translateY(0)}50%{transform:translateY(-12px)}}
  .mk-noti{animation:pulse 3.2s ease-in-out infinite}
  @keyframes pulse{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
  .hero h1 .g{animation:shimmer 7s ease-in-out infinite}
  @keyframes shimmer{0%,100%{background-position:0 0}50%{background-position:100% 0}}
}
/* ══ RESPONSIVE ══ */
@media(max-width:960px){.hero-grid{grid-template-columns:1fr;gap:44px}.mock{transform:none;max-width:520px;margin:0 auto}.mock-wrap:hover .mock{transform:none}.feat-grid,.tst-grid{grid-template-columns:1fr 1fr}.ind-grid{grid-template-columns:repeat(3,1fr)}.plans{grid-template-columns:1fr;max-width:440px;margin:0 auto}}
@media(max-width:680px){.stats .wrap{grid-template-columns:1fr 1fr;gap:24px}.feat-grid,.tst-grid,.steps{grid-template-columns:1fr}.ind-grid{grid-template-columns:1fr 1fr}.hero{padding:52px 0 64px}.orb{opacity:.4}}`;

export function renderLanding({ contactEmail = 'lienhe@nentang.vn', contactPhone = '', brand = 'Nền Tảng' } = {}) {
  const mailto = (subj) => mailtoHref(contactEmail, subj);
  const contactLine = [contactPhone ? `ĐT: ${esc(contactPhone)}` : '', `Email: ${esc(contactEmail)}`].filter(Boolean).join(' · ');

  const industryTile = (x) => `<a class="ind reveal" href="${mailto('Tư vấn dịch vụ website — ngành ' + x.name)}" aria-label="Tư vấn ngành ${esc(x.name)} (gửi email)" style="background:linear-gradient(135deg,${x.a},${x.b})">
    <span class="ind-ic">${x.icon}</span><span class="ind-name">${esc(x.name)}</span></a>`;

  const planCard = (p) => `<div class="plan reveal${p.hot ? ' hot' : ''}">
    ${p.hot ? '<div class="plan-badge">Phổ biến nhất</div>' : ''}
    <div class="plan-tag">${esc(p.tagline)}</div>
    <h3 class="plan-name">${esc(p.name)}</h3>
    <div class="plan-price">${esc(p.price)}<span>${esc(p.unit)}</span></div>
    <ul>${p.feat.map((f) => `<li>${I.check}<span>${esc(f)}</span></li>`).join('')}</ul>
    <a class="btn ${p.hot ? 'btn-primary' : 'btn-ghost'} btn-block" href="${mailto('Đăng ký gói ' + p.name)}" aria-label="Đăng ký gói ${esc(p.name)} (gửi email)">Chọn gói ${esc(p.name)}</a>
  </div>`;

  const mockCard = (icon, hue, price) => `<div class="mk-card"><div class="mk-img" style="background:linear-gradient(135deg,${hue})">${icon}</div><div class="mk-body"><div class="mk-l"></div><div class="mk-row"><span class="mk-price">${price}</span><span class="mk-buy">${I.cart}</span></div></div></div>`;

  const body = `<header class="hero"><span class="orb o1"></span><span class="orb o2"></span><span class="orb o3"></span><div class="wrap"><div class="hero-grid">
  <div>
    <p class="eyebrow">${I.bolt}Dịch vụ website trọn gói</p>
    <h1>Website bán hàng <span class="g">chuyên nghiệp</span> — chúng tôi lo, bạn chỉ việc bán.</h1>
    <p class="lead">Bạn mua dịch vụ, nhận ngay một cửa hàng trực tuyến hoàn chỉnh: đẹp, chuẩn SEO, thanh toán tận nơi. Không cần biết kỹ thuật.</p>
    <div class="hero-cta">
      <a class="btn btn-primary" href="/#bang-gia">Xem bảng giá ${I.arrow}</a>
      <a class="btn btn-ghost" href="${mailto('Tư vấn dịch vụ website')}" aria-label="Nhận tư vấn miễn phí (gửi email)">Nhận tư vấn miễn phí</a>
    </div>
    <div class="hero-trust"><span>${I.wallet}Thanh toán COD</span><span>${I.check}Chuyển khoản VietQR</span><span>${I.shield}Bảo mật SSL</span></div>
  </div>
  <div class="mock-wrap">
    <div class="mock" aria-hidden="true">
      <div class="mock-bar"><i></i><i></i><i></i><span class="url">shop.nentang.vn</span></div>
      <div class="mk-screen">
        <div class="mk-top"><span class="mk-logo">CỬA HÀNG</span><span class="mk-nav"></span><span class="mk-dot">${I.cart}</span></div>
        <div class="mk-banner"><span class="mkb-t">Bộ sưu tập mới về</span><span class="mkb-btn">Mua ngay</span></div>
        <div class="mk-grid">
          ${mockCard(I.shirt, '#f472b6,#a855f7', '₫350.000')}
          ${mockCard(I.sofa, '#f59e0b,#b45309', '₫1.290.000')}
          ${mockCard(I.cosmetic, '#fb7185,#e11d48', '₫250.000')}
        </div>
      </div>
    </div>
    <div class="mk-noti" aria-hidden="true"><span class="ico">${I.cart}</span><div><b>Đơn mới +1</b><span>vừa xong</span></div></div>
  </div>
</div></div></header>

<section class="stats" aria-label="Cam kết"><div class="wrap">
  ${STATS.map((s) => `<div class="stat reveal"><div class="n">${esc(s.n)}</div><div class="l">${esc(s.l)}</div></div>`).join('')}
</div></section>

<section class="sec" id="tinh-nang"><div class="wrap">
  <div class="sec-head reveal"><p class="kick">Tính năng</p><h2>Mọi thứ bạn cần để bán hàng online</h2><p>Chúng tôi lo phần khó; bạn tập trung vào sản phẩm và khách hàng.</p></div>
  <div class="feat-grid">${FEATURES.map((f) => `<div class="feat reveal"><div class="feat-ic">${f.icon}</div><h3>${esc(f.t)}</h3><p>${esc(f.d)}</p></div>`).join('')}</div>
</div></section>

<section class="sec ind-wrap" id="nganh-hang"><div class="wrap">
  <div class="sec-head reveal"><p class="kick">Ngành hàng</p><h2>Dù bạn kinh doanh gì, cũng có giao diện phù hợp</h2><p>Từ thời trang tới nội thất, mỹ phẩm tới điện tử — chúng tôi dựng đúng phong cách ngành của bạn.</p></div>
  <div class="ind-grid">${INDUSTRIES.map(industryTile).join('')}</div>
</div></section>

<section class="sec" id="cach-hoat-dong"><div class="wrap">
  <div class="sec-head reveal"><p class="kick">Cách hoạt động</p><h2>Bắt đầu chỉ trong 3 bước</h2><p>Không cài đặt, không cấu hình rắc rối — chúng tôi làm cùng bạn.</p></div>
  <div class="steps">${STEPS.map((s) => `<div class="step reveal"><div class="n">${esc(s.n)}</div><h3>${esc(s.t)}</h3><p>${esc(s.d)}</p></div>`).join('')}</div>
</div></section>

<section class="sec pricing" id="bang-gia"><div class="wrap">
  <div class="sec-head reveal"><p class="kick">Bảng giá</p><h2>Đơn giản, minh bạch, không phí ẩn</h2><p>Chọn gói phù hợp — nâng hoặc hạ bất cứ lúc nào.</p></div>
  <div class="plans">${PLANS.map(planCard).join('')}</div>
</div></section>

<section class="sec"><div class="wrap">
  <div class="sec-head reveal"><p class="kick">Khách hàng nói gì</p><h2>Người bán thật, kết quả thật</h2></div>
  <div class="tst-grid">${TESTIMONIALS.map((t) => `<div class="tst reveal"><div class="quote" aria-hidden="true">&ldquo;</div><p>${esc(t.q)}</p><div class="who"><div class="av" aria-hidden="true">${esc(t.name.trim().split(' ').pop()[0] || '?')}</div><div><div class="nm">${esc(t.name)}</div><div class="rl">${esc(t.role)}</div></div></div></div>`).join('')}</div>
</div></section>

<section class="sec" id="faq" style="background:var(--surf)"><div class="wrap">
  <div class="sec-head reveal"><p class="kick">Hỏi đáp</p><h2>Câu hỏi thường gặp</h2></div>
  <div class="faq">${FAQS.map((f) => `<details><summary>${esc(f.q)}</summary><div class="ans">${esc(f.a)}</div></details>`).join('')}</div>
</div></section>

<section class="cta-final"><div class="wrap"><div class="cta-box reveal">
  <h2>Sẵn sàng mở cửa hàng của bạn?</h2>
  <p>Liên hệ để chúng tôi dựng website cho bạn — thường trong vài ngày.</p>
  <a class="btn btn-primary" href="${mailto('Tôi muốn mở cửa hàng')}" aria-label="Liên hệ mở cửa hàng (gửi email)">Liên hệ ngay ${I.arrow}</a>
  <div class="cta-contact">${contactLine}</div>
</div></div></section>`;

  return sitePage({
    title: `${esc(brand)} — Dịch vụ website bán hàng trọn gói cho người Việt`,
    description: 'Chúng tôi dựng và vận hành website bán hàng chuyên nghiệp cho bạn: chuẩn SEO, thanh toán QR/COD vào thẳng tài khoản, hỗ trợ tận tay. Bạn chỉ việc bán.',
    brand, contactEmail, contactPhone, active: '', extraCss: CSS, body,
  });
}
