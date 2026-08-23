/**
 * Trang CHỦ công ty của nền tảng (nentang.vn gốc — không phải shop nào): marketing + bảng giá.
 * Dùng khung chung site.js (nav/footer/CSS nền). SSR tĩnh, KHÔNG JS, hợp CSP nghiêm —
 * mọi "ảnh" là SVG/khung UI phẳng; hiệu ứng cuộn/tab/marquee bằng CSS THUẦN
 * (tab = radio + :checked; marquee = @keyframes; tiết lộ cuộn = animation-timeline:view()).
 *
 * PHONG CÁCH: ẤM kiểu thương mại Việt (Haravan/Sapo) — điểm nhấn ĐỎ GẠCH/CORAL duy nhất,
 * nền kem ấm, section xen kẽ trắng ↔ kem-đào, UI mô phỏng PHẲNG & thẳng (không nghiêng 3D,
 * không gradient tràn, không glass-blur, không quả cầu trôi, không chữ gradient). Hiệu ứng
 * giữ KÍN: chỉ trượt-lên khi cuộn (có cổng an toàn), nâng nhẹ khi hover, marquee ngành hàng.
 *
 * An toàn: hiệu ứng cuộn + marquee chỉ bật khi trình duyệt HỖ TRỢ + người dùng KHÔNG chọn
 * "giảm chuyển động" — nếu không, nội dung hiện đầy đủ (không kẹt ẩn; marquee → lưới tĩnh).
 * NỘI DUNG TRUNG THỰC: không bịa số khách hàng/giải thưởng — chỉ cam kết thật
 * (3 phút / 0đ / 100% tiền về chủ shop / 24/7) + tính năng có thật. Sửa nội dung: các mảng dưới.
 */
import { esc, I, mailtoHref, sitePage, SIGNUP_URL } from './site.js';

// ── DỮ LIỆU (sửa nội dung ở đây) ─────────────────────────────────────────────
const STATS = [
  { n: '3 phút', l: 'Có cửa hàng mẫu để xem ngay' },
  { n: '0đ', l: 'Phí thiết lập ban đầu' },
  { n: '100%', l: 'Tiền khách trả vào thẳng tài khoản bạn' },
  { n: '24/7', l: 'Cửa hàng luôn online, không lo sập' },
];
// Tab tính năng (radio + :checked — thuần CSS). `vis`: khóa hình minh hoạ dựng bằng CSS.
const TABS = [
  {
    icon: I.palette, label: 'Cửa hàng & giao diện', vis: 'shop',
    h: 'Cửa hàng đẹp, đúng chất thương hiệu của bạn',
    d: 'Tự đổi mọi thứ trong trang quản trị — không cần biết một dòng code.',
    bullets: ['Tự chỉnh banner, menu, màu sắc, logo, phông chữ', 'Chuẩn SEO: sitemap, dữ liệu có cấu trúc, tự lên Google', 'Blog bán hàng + trang nội dung tuỳ ý', 'Giỏ hàng trượt, xem nhanh sản phẩm — mượt như sàn lớn'],
  },
  {
    icon: I.truck, label: 'Đơn hàng & vận chuyển', vis: 'orders',
    h: 'Đơn về là chạy — từ chốt tới giao',
    d: 'Kết nối hãng vận chuyển bằng tài khoản của CHÍNH BẠN, phí ship bạn tự cài.',
    bullets: ['Kết nối GHN, GHTK bằng tài khoản riêng của bạn', 'Phí ship theo km (định vị GPS) hoặc theo vùng — bạn đặt luật', 'Tách vận đơn, giao một phần; khách tự tra cứu đơn bằng mã', 'Sửa đơn, đổi-trả, đối soát COD với hãng — đủ nghiệp vụ'],
  },
  {
    icon: I.box, label: 'Kho & nhập hàng', vis: 'stock',
    h: 'Tồn kho chuẩn tới từng biến thể',
    d: 'Màu, size, phiên bản — mỗi biến thể một số tồn, không bao giờ bán lố.',
    bullets: ['Tồn kho theo từng biến thể (màu / size / loại)', 'Nhập hàng từ nhà cung cấp — giá vốn bình quân tự tính', 'Kiểm kê hai lượt, cảnh báo sắp hết hàng', 'Báo cáo lãi lỗ (P&L) theo giá vốn thật'],
  },
  {
    icon: I.percent, label: 'Khuyến mãi & khách quen', vis: 'promo',
    h: 'Kéo khách mới, giữ khách quen',
    d: 'Đủ công cụ tăng đơn — và mọi khuyến mãi đều tính đúng tiền tới từng đồng.',
    bullets: ['Flash sale hẹn giờ, giá gạch tự áp lên cửa hàng', 'Mã giảm giá theo điều kiện bạn đặt', 'Điểm thưởng tích luỹ cho khách quen', 'CRM-lite, đánh giá sản phẩm, tài khoản khách hàng'],
  },
  {
    icon: I.wallet, label: 'Tiền về thẳng túi', vis: 'money',
    h: 'Chúng tôi không bao giờ giữ tiền của bạn',
    d: 'Khách trả COD hoặc quét VietQR — tiền vào thẳng tài khoản ngân hàng của bạn.',
    bullets: ['COD + chuyển khoản VietQR vào THẲNG tài khoản bạn', 'Không trung gian, không ôm dòng tiền — bao giờ cũng vậy', 'Đối soát chuyển khoản tự động, đối soát COD với hãng ship', 'Cảnh báo ngay khi đường tiền trục trặc'],
  },
];
const INDUSTRIES = [
  { icon: I.shirt, name: 'Thời trang' },
  { icon: I.cosmetic, name: 'Mỹ phẩm' },
  { icon: I.sofa, name: 'Nội thất' },
  { icon: I.device, name: 'Điện tử' },
  { icon: I.baby, name: 'Mẹ & Bé' },
  { icon: I.food, name: 'Thực phẩm' },
  { icon: I.book, name: 'Nhà sách' },
  { icon: I.gift, name: 'Quà tặng · Handmade' },
  { icon: I.coffee, name: 'Cà phê & Trà' },
  { icon: I.dumbbell, name: 'Thể thao' },
  { icon: I.paw, name: 'Thú cưng' },
  { icon: I.gem, name: 'Trang sức' },
];
const STEPS = [
  { n: '1', t: 'Đăng ký miễn phí', d: 'Điền email và tên shop — 2 phút, không cần thẻ. Xác nhận email là có ngay cửa hàng dùng thử 14 ngày.' },
  { n: '2', t: 'Tự dựng trong 3 phút', d: 'Cửa hàng mẫu dựng sẵn: đổi logo, màu, đăng sản phẩm là xong. Cần thì chúng tôi dựng giúp tận tay.' },
  { n: '3', t: 'Bắt đầu bán', d: 'Nhận đơn, giao hàng, thu tiền — COD và VietQR vào thẳng tài khoản bạn.' },
];
// 4 khối tính năng xen kẽ (chữ ↔ hình đổi bên, hiệu ứng trượt vào khi cuộn).
const FLAGS = [
  {
    kick: 'Đường tiền', icon: I.wallet, vis: 'qr',
    h: 'Tiền của bạn không qua tay ai',
    d: 'Khác với sàn thương mại điện tử, ở đây khách thanh toán là tiền vào thẳng tài khoản ngân hàng CỦA BẠN — nền tảng không giữ hộ, không đối soát chậm, không phí rút tiền.',
    bullets: ['Mỗi shop một cấu hình VietQR riêng, tiền về tài khoản riêng', 'Hệ thống tự khớp tiền vào với đơn hàng', 'Sao kê rõ ràng — bạn luôn biết đồng nào của đơn nào'],
  },
  {
    kick: 'Chống thất thoát', icon: I.shield, vis: 'guard',
    h: 'Bớt đơn ảo, bớt bom hàng',
    d: 'Bán COD ở Việt Nam sợ nhất đơn ảo. Nền tảng chặn từ gốc — không cần bạn phải ngồi soi từng đơn.',
    bullets: ['Đơn COD quá hạn không nhận — tự huỷ, nhả lại tồn kho', 'Chặn spam đặt đơn hàng loạt từ cùng một nguồn', 'Tự gắn cờ cảnh báo số điện thoại đặt bất thường'],
  },
  {
    kick: 'Khách quen', icon: I.users, vis: 'loyal',
    h: 'Khách mua một lần, quay lại nhiều lần',
    d: 'Đơn đầu tiên là quảng cáo, đơn thứ hai mới là lãi. Đủ công cụ để khách cũ quay lại mà không tốn thêm tiền quảng cáo.',
    bullets: ['Điểm thưởng tích luỹ — mua càng nhiều, ưu đãi càng lớn', 'Tài khoản khách hàng: lịch sử đơn, sổ địa chỉ, đặt lại nhanh', 'CRM-lite: biết ai mua gì, bao nhiêu lần, lần cuối khi nào'],
  },
  {
    kick: 'An toàn', icon: I.doc, vis: 'safe',
    h: 'Bạn ngủ ngon, hệ thống tự lo',
    d: 'Máy chủ, HTTPS, sao lưu, giám sát — phần việc "ngầm" nhưng sống còn, chúng tôi trực thay bạn.',
    bullets: ['Sao lưu mã hoá định kỳ, khôi phục được khi có sự cố', 'HTTPS tự động cho cả tên miền riêng của bạn', 'Dữ liệu là của bạn — xuất toàn bộ ra file bất cứ lúc nào'],
  },
];
// Khối SẢN PHẨM: danh sách bên trái, khung xem bên phải DÁN DÍNH và tự đổi theo chỗ
// đang cuộn tới. Đồng bộ hai cột bằng CSS thuần (view-timeline-name trên từng mục ở cột
// trái + timeline-scope ở khối cha → khung bên phải chạy theo dòng thời gian ĐÓ). Không JS,
// hợp CSP nghiêm — trang này không có script-src nên mọi hiệu ứng buộc phải nằm ở CSS.
const PRODUCTS = [
  {
    n: '01', icon: I.chart, kick: 'Tổng quan', vis: 'dash',
    h: 'Mở máy là biết hôm nay bán được bao nhiêu',
    d: 'Doanh thu, đơn mới, việc cần xử lý — gom về một màn hình, không phải mở bốn chỗ để cộng tay.',
    bullets: ['Doanh thu hôm nay, tuần này, tháng này — theo giờ Việt Nam', 'Việc cần xử lý xếp trước: đơn chờ xác nhận, hàng sắp hết', 'Sản phẩm bán chạy để biết nên nhập thêm gì'],
  },
  {
    n: '02', icon: I.truck, kick: 'Đơn hàng', vis: 'orders',
    h: 'Đơn về là chạy — từ chốt tới giao',
    d: 'Xác nhận, đóng gói, đẩy sang GHN/GHTK bằng tài khoản của chính bạn. Khách tự tra cứu bằng mã đơn.',
    bullets: ['Tách vận đơn, giao một phần, đổi trả — đủ nghiệp vụ thật', 'Đối soát COD với hãng ship, lệch là thấy ngay', 'Sửa đơn có ghi vết: ai sửa gì, lúc nào'],
  },
  {
    n: '03', icon: I.box, kick: 'Kho hàng', vis: 'stock',
    h: 'Tồn kho chuẩn tới từng biến thể',
    d: 'Màu, size, phiên bản — mỗi biến thể một số tồn. Trừ kho ngay lúc khách đặt, không bao giờ bán lố.',
    bullets: ['Tồn khả dụng = tồn thật − đang giữ − đệm an toàn bạn đặt', 'Nhập hàng, giá vốn bình quân tự tính, báo cáo lãi lỗ thật', 'Cảnh báo sắp hết trước khi hết, không phải sau'],
  },
  {
    n: '04', icon: I.wallet, kick: 'Tiền về', vis: 'money',
    h: 'Tiền vào thẳng tài khoản của bạn',
    d: 'Khách quét VietQR là tiền về ngân hàng của bạn. Hệ thống tự khớp tiền với đơn, không cần bạn dò tay.',
    bullets: ['Khớp đúng TÀI KHOẢN NHẬN, không chỉ khớp mã đơn', 'Khách bấm trả hai lần cũng không cộng hai lần', 'Trả thiếu thì vào hàng đợi đối soát, không tự ghi "đã trả"'],
  },
  {
    n: '05', icon: I.palette, kick: 'Cửa hàng', vis: 'shop',
    h: 'Cửa hàng đẹp, và chạy được cả khi mạng yếu',
    d: 'Đổi banner, màu, logo ngay trong trang quản trị. Trang bán hàng dựng sẵn ở máy chủ nên mở là thấy.',
    bullets: ['Trang bán và trang đặt hàng chạy được cả khi không có JavaScript', 'Chuẩn SEO: sitemap, dữ liệu có cấu trúc, tự lên Google', 'Tên miền riêng của bạn, HTTPS tự cấp và tự gia hạn'],
  },
];
const TESTIMONIALS = [
  { q: 'Trước tôi bán qua Facebook, đơn hay sót. Có website riêng, khách tự đặt, tôi chỉ việc gói hàng. Nhàn hẳn.', name: 'Chị Hương', role: 'Shop thời trang, Hà Nội' },
  { q: 'Cái tôi thích nhất là tiền khách chuyển khoản vào thẳng tài khoản mình, không qua trung gian. Rõ ràng, yên tâm.', name: 'Anh Tuấn', role: 'Đồ nội thất, TP.HCM' },
  { q: 'Không rành công nghệ mà vẫn có shop chuẩn SEO. Bên này dựng giúp hết, cần gì nhắn là được hỗ trợ.', name: 'Chị Mai', role: 'Mỹ phẩm handmade, Đà Nẵng' },
];
const FAQS = [
  { q: 'Đăng ký dùng thử thế nào? Có mất phí không?', a: 'Bấm "Bắt đầu miễn phí", điền email và tên shop — sau khi xác nhận email bạn có ngay cửa hàng dùng thử 14 ngày, đầy đủ tính năng, không cần thẻ, không phí thiết lập.' },
  { q: 'Tôi không biết gì về kỹ thuật, có dùng được không?', a: 'Được. Cửa hàng mẫu dựng sẵn, bạn chỉ đổi logo, màu và đăng sản phẩm. Nếu cần, chúng tôi dựng giúp và hướng dẫn tận tay — mọi phần kỹ thuật (máy chủ, bảo mật, sao lưu) do chúng tôi lo.' },
  { q: 'Tiền khách hàng trả có qua trung gian không?', a: 'Không. Khách thanh toán COD hoặc chuyển khoản QR VietQR vào thẳng tài khoản ngân hàng của bạn. Chúng tôi không giữ, không ôm dòng tiền của bạn.' },
  { q: 'Tôi có được dùng tên miền riêng không?', a: 'Có. Bạn có thể dùng tên miền phụ miễn phí dạng shop.nentang.vn, hoặc gắn tên miền riêng của bạn (vd cuahangcuaban.com) ở gói Growth.' },
  { q: 'Nếu muốn ngừng thì dữ liệu của tôi thế nào?', a: 'Dữ liệu là của bạn. Bạn có thể xuất toàn bộ sản phẩm, đơn hàng, khách hàng ra file bất cứ lúc nào trong trang quản trị.' },
  { q: 'Chi phí có phát sinh gì ẩn không?', a: 'Không. Bạn trả theo gói hằng tháng đã niêm yết, nâng/hạ gói bất cứ lúc nào. Không phí thiết lập, không phí ẩn, không thu phần trăm trên đơn hàng.' },
];
const PLANS = [
  { code: 'platform', name: 'Platform', price: '990.000', unit: 'đ/tháng', hot: false, tagline: 'Bắt đầu bán online', feat: ['100 sản phẩm', 'Tên miền phụ .nentang.vn', 'COD + QR chuyển khoản', 'Quản lý đơn · tồn kho · danh mục'] },
  { code: 'care', name: 'Care', price: '2.490.000', unit: 'đ/tháng', hot: true, tagline: 'Đầy đủ để bán tốt', feat: ['Tất cả gói Platform', 'Blog & SEO nâng cao', 'Trình dựng giao diện sâu', 'Hỗ trợ ưu tiên'] },
  { code: 'growth', name: 'Growth', price: '5.900.000', unit: 'đ/tháng', hot: false, tagline: 'Cho cửa hàng lớn', feat: ['Tất cả gói Care', '500 sản phẩm', 'Tên miền riêng của bạn', 'Đối soát QR tự động'] },
];

// CSS RIÊNG của trang chủ. PHẲNG + ẤM: không gradient tràn, không glass-blur, không nghiêng 3D,
// không quả cầu, không chữ gradient, không shimmer. Chỉ còn: trượt-cuộn (có cổng an toàn),
// nâng-hover nhẹ, tab-fade, marquee ngành hàng. Thuần CSS, không JS, hợp CSP nghiêm.
const CSS = `
/* ══ HERO: nền kem, một dải wash ấm rất nhẹ ở đỉnh (phẳng, không chấm/không cầu) ══ */
.hero{position:relative;overflow:hidden;padding:80px 0 96px;background:var(--bg)}
.hero::before{content:"";position:absolute;inset:0 0 auto;height:62%;z-index:-1;background:linear-gradient(180deg,var(--surf),transparent)}
.hero-grid{position:relative;display:grid;grid-template-columns:1.05fr .95fr;gap:56px;align-items:center}
.hero h1{font-size:clamp(2.4rem,5vw,3.8rem);line-height:1.07;letter-spacing:-.03em;font-weight:800;margin:0 0 20px;text-wrap:balance}
.hero h1 .g{color:var(--pri)}
.hero .lead{font-size:clamp(1.06rem,2vw,1.26rem);color:var(--soft);max-width:566px;margin:0 0 30px}
.hero-cta{display:flex;gap:14px;flex-wrap:wrap}
.hero-trust{display:flex;gap:18px;flex-wrap:wrap;margin-top:26px}
.hero-trust span{display:inline-flex;align-items:center;gap:6px;font-size:.86rem;color:var(--soft);font-weight:500}.hero-trust svg{width:16px;height:16px;color:var(--good)}
/* ══ MOCKUP cửa hàng — PHẲNG, thẳng, viền ấm + đổ bóng mềm (không nghiêng 3D) ══ */
.mock-wrap{position:relative}
.mock{border-radius:16px;background:var(--card);border:1px solid var(--bd);box-shadow:0 30px 64px -40px rgba(33,26,22,.28);overflow:hidden}
.mock-shot{display:block;width:100%;height:auto}
.mock-bar{display:flex;align-items:center;gap:7px;padding:12px 15px;background:var(--surf);border-bottom:1px solid var(--bd)}
.mock-bar i{width:11px;height:11px;border-radius:50%;background:#e3d8cc;display:block}
.mock-bar i:nth-child(1){background:#e9b7a6}.mock-bar i:nth-child(2){background:#ecd3a0}.mock-bar i:nth-child(3){background:#b6d3bf}
.mock-bar .url{margin-left:8px;flex:1;height:20px;border-radius:6px;background:var(--wash);font-size:.7rem;color:var(--mut);display:flex;align-items:center;padding:0 10px}
.mk-screen{padding:16px}
.mk-top{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.mk-logo{font-size:.8rem;font-weight:800;color:var(--pri);letter-spacing:-.01em}
.mk-nav{flex:1;height:8px;border-radius:5px;background:var(--bd);max-width:130px}
.mk-dot{width:26px;height:26px;border-radius:8px;background:var(--wash);border:1px solid var(--bd);display:grid;place-items:center;color:var(--pri)}.mk-dot svg{width:14px;height:14px}
.mk-banner{height:80px;border-radius:12px;background:var(--surf);border:1px solid var(--bd);position:relative;margin-bottom:16px;display:flex;flex-direction:column;justify-content:center;padding:0 18px;color:var(--ink)}
.mkb-t{font-size:.9rem;font-weight:700}
.mkb-btn{margin-top:8px;align-self:flex-start;background:var(--pri);color:#fff;font-size:.72rem;font-weight:700;padding:5px 12px;border-radius:7px}
.mk-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:11px}
.mk-card{border:1px solid var(--bd);border-radius:11px;overflow:hidden;background:var(--card)}
.mk-img{aspect-ratio:1.1;display:grid;place-items:center;color:var(--pri);background:var(--wash)}.mk-img svg{width:28px;height:28px}
.mk-body{padding:8px 9px 9px}
.mk-l{height:7px;border-radius:4px;background:var(--bd);margin-bottom:8px;width:82%}
.mk-row{display:flex;align-items:center;justify-content:space-between}
.mk-price{font-size:.7rem;font-weight:800;color:var(--ink)}
.mk-buy{width:22px;height:17px;border-radius:6px;background:var(--pri);display:grid;place-items:center}.mk-buy svg{width:11px;height:11px;color:#fff}
.mk-float{position:absolute;z-index:2;background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:11px 15px;display:flex;align-items:center;gap:10px;box-shadow:0 18px 40px -18px rgba(33,26,22,.3)}
.mk-float .ico{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;flex:none}.mk-float .ico svg{width:16px;height:16px}
.mk-float b{font-size:.85rem;display:block}.mk-float span{font-size:.72rem;color:var(--mut)}
.mk-noti{left:-18px;bottom:24px}.mk-noti .ico{background:var(--wash);color:var(--pri)}
.mk-pay{right:-14px;top:34px}.mk-pay .ico{background:color-mix(in srgb,var(--good) 15%,transparent);color:var(--good)}
/* ══ STATS: dải số cam kết (nền kem-đào) ══ */
.stats{border-top:1px solid var(--bd);border-bottom:1px solid var(--bd);background:var(--surf)}
.stats .wrap{display:grid;grid-template-columns:repeat(4,1fr);gap:20px;padding:38px 24px}
.stat{position:relative;padding-left:18px}
.stat::before{content:"";position:absolute;left:0;top:6px;bottom:6px;width:3px;border-radius:3px;background:var(--pri)}
.stat .n{font-size:clamp(1.7rem,3.2vw,2.3rem);font-weight:800;letter-spacing:-.02em;color:var(--pri)}
.stat .l{font-size:.9rem;color:var(--mut);margin-top:4px}
/* ══ TAB TÍNH NĂNG — radio + :checked, thuần CSS, bàn phím dùng mũi tên ══ */
.tabs{position:relative}
.tabs>input{position:absolute;opacity:0;width:1px;height:1px;margin:0;pointer-events:none}
/* Tab: MỘT HÀNG gọn (như Sapo). nowrap + overflow-x auto → không rớt 4+1; safe center =
   vừa thì căn giữa, tràn (mobile) thì cuộn ngang không bị kẹp mất đầu. */
.tabbar{display:flex;gap:8px;flex-wrap:nowrap;overflow-x:auto;justify-content:safe center;margin-bottom:36px;padding-bottom:4px;scrollbar-width:thin}
.tabbar::-webkit-scrollbar{height:6px}.tabbar::-webkit-scrollbar-thumb{background:var(--bd);border-radius:3px}
.tabbar label{display:inline-flex;align-items:center;gap:7px;padding:10px 16px;border-radius:999px;border:1.5px solid var(--bd);background:var(--card);font-weight:600;font-size:.9rem;color:var(--soft);cursor:pointer;transition:border-color .2s,color .2s,background .2s,transform .12s;white-space:nowrap;flex:0 0 auto}
.tabbar label svg{width:16px;height:16px;flex:0 0 auto}
.tabbar label:hover{border-color:color-mix(in srgb,var(--pri) 45%,var(--bd));color:var(--pri);transform:translateY(-1px)}
#ft-0:checked~.tabbar label[for="ft-0"],#ft-1:checked~.tabbar label[for="ft-1"],#ft-2:checked~.tabbar label[for="ft-2"],#ft-3:checked~.tabbar label[for="ft-3"],#ft-4:checked~.tabbar label[for="ft-4"]{
  background:var(--pri);border-color:transparent;color:#fff;box-shadow:0 8px 18px -10px color-mix(in srgb,var(--pri) 65%,transparent)}
#ft-0:focus-visible~.tabbar label[for="ft-0"],#ft-1:focus-visible~.tabbar label[for="ft-1"],#ft-2:focus-visible~.tabbar label[for="ft-2"],#ft-3:focus-visible~.tabbar label[for="ft-3"],#ft-4:focus-visible~.tabbar label[for="ft-4"]{outline:3px solid var(--pri);outline-offset:2px}
.pane{display:none;grid-template-columns:1fr 1fr;gap:48px;align-items:center;background:var(--card);border:1px solid var(--bd);border-radius:20px;padding:40px 44px;box-shadow:0 20px 50px -42px rgba(33,26,22,.24)}
#ft-0:checked~.panes .pane:nth-child(1),#ft-1:checked~.panes .pane:nth-child(2),#ft-2:checked~.panes .pane:nth-child(3),#ft-3:checked~.panes .pane:nth-child(4),#ft-4:checked~.panes .pane:nth-child(5){display:grid}
.pane h3{font-size:clamp(1.3rem,2.4vw,1.7rem);font-weight:800;letter-spacing:-.02em;margin:0 0 10px}
.pane .pd{color:var(--mut);margin:0 0 18px}
.pane ul{list-style:none;margin:0 0 22px;padding:0;display:flex;flex-direction:column;gap:12px}
.pane li{display:flex;gap:10px;align-items:flex-start;color:var(--soft);font-size:.97rem}
.pane li svg{width:19px;height:19px;flex:none;color:var(--good);margin-top:2px}
.pane .plink{display:inline-flex;align-items:center;gap:7px;color:var(--pri);font-weight:700}
.pane .plink svg{width:17px;height:17px;transition:transform .18s}.pane .plink:hover svg{transform:translateX(3px)}
/* hình minh hoạ trong tab/khối xen kẽ — khung "màn hình" chung (phẳng) */
.vis{border:1px solid var(--bd);border-radius:16px;background:var(--card);box-shadow:0 22px 48px -40px rgba(33,26,22,.3);padding:18px;min-width:0}
.vis-h{display:flex;align-items:center;gap:8px;font-size:.78rem;font-weight:700;color:var(--mut);text-transform:uppercase;letter-spacing:.05em;margin-bottom:14px}
.vis-h i{width:8px;height:8px;border-radius:50%;background:var(--good);display:block}
.vrow{display:flex;align-items:center;gap:12px;padding:11px 12px;border:1px solid var(--bd);border-radius:11px;margin-bottom:9px;background:var(--bg)}
.vrow:last-child{margin-bottom:0}
.vrow .vc{font-size:.78rem;font-weight:800;color:var(--mut);flex:none}
.vrow .vn{flex:1;font-size:.86rem;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vrow b{font-size:.84rem;flex:none}
.pill{font-size:.7rem;font-weight:700;padding:3px 10px;border-radius:999px;flex:none}
.pill.new{background:color-mix(in srgb,var(--pri) 13%,transparent);color:var(--prid)}
.pill.ship{background:color-mix(in srgb,#C67A1E 16%,transparent);color:#9A5B12}
.pill.done{background:color-mix(in srgb,var(--good) 15%,transparent);color:var(--good)}
.pill.warn{background:color-mix(in srgb,#C0392B 13%,transparent);color:#B02A1C}
.vbar{flex:1;height:8px;border-radius:5px;background:var(--bd);overflow:hidden}.vbar i{display:block;height:100%;border-radius:5px;background:var(--pri)}
.vbar i.lo{background:#C0392B}
.vqr{display:grid;grid-template-columns:auto 1fr;gap:16px;align-items:center;border:1px solid var(--bd);border-radius:14px;padding:16px;background:var(--bg);margin-bottom:12px}
.vqr .q{width:74px;height:74px;border-radius:10px;background:var(--ink);color:var(--card);display:grid;place-items:center}.vqr .q svg{width:52px;height:52px}
.vqr b{display:block;font-size:1rem}.vqr span{font-size:.8rem;color:var(--mut)}
.vcredit{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--good) 30%,var(--bd));border-radius:11px;background:color-mix(in srgb,var(--good) 7%,var(--bg));margin-bottom:9px}
.vcredit:last-child{margin-bottom:0}
.vcredit .amt{font-weight:800;color:var(--good);font-size:.92rem;flex:none}
.vcredit .src{flex:1;font-size:.82rem;color:var(--soft)}.vcredit .tm{font-size:.74rem;color:var(--mut);flex:none}
.vflash{border-radius:14px;background:var(--pri);color:#fff;padding:16px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.vflash b{font-size:1.02rem}.vflash .cd{display:flex;gap:5px}.vflash .cd i{background:rgba(0,0,0,.24);border-radius:7px;padding:5px 8px;font-style:normal;font-weight:800;font-size:.86rem}
.vcoupon{display:flex;align-items:center;gap:12px;border:1.6px dashed color-mix(in srgb,var(--pri) 55%,var(--bd));border-radius:12px;padding:12px 14px;background:color-mix(in srgb,var(--pri) 6%,var(--bg));margin-bottom:12px}
.vcoupon .code{font-weight:800;letter-spacing:.06em;color:var(--pri);flex:none}.vcoupon span{font-size:.82rem;color:var(--soft)}
.vpts{display:flex;align-items:center;gap:10px;padding:11px 13px;border:1px solid var(--bd);border-radius:12px;background:var(--bg)}
.vpts .ic{width:30px;height:30px;border-radius:9px;background:color-mix(in srgb,#C67A1E 16%,transparent);color:#9A5B12;display:grid;place-items:center;flex:none}.vpts .ic svg{width:16px;height:16px}
.vpts b{font-size:.88rem;display:block}.vpts span{font-size:.76rem;color:var(--mut)}
.vshop .sb{height:62px;border-radius:11px;background:var(--surf);border:1px solid var(--bd);margin-bottom:12px;display:flex;align-items:center;padding:0 16px;color:var(--ink);font-weight:700;font-size:.86rem}
.vshop .sg{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.vshop .sc{border:1px solid var(--bd);border-radius:10px;overflow:hidden}
.vshop .si{aspect-ratio:1.15;display:grid;place-items:center;color:var(--pri);background:var(--wash)}.vshop .si svg{width:24px;height:24px}
.vshop .sl{height:6px;border-radius:4px;background:var(--bd);margin:8px 8px 10px;width:70%}
/* ══ NGÀNH HÀNG: marquee 2 hàng ngược chiều — có gate; không hỗ trợ/giảm chuyển động → lưới tĩnh ══ */
.ind-wrap{background:var(--surf)}
.mq{overflow:hidden;padding:6px 0}
.mq-inner{display:flex}
.mq-set{display:flex;flex-wrap:wrap;justify-content:center;gap:14px;width:100%}
.mq-set.clone{display:none}
.mchip{display:inline-flex;align-items:center;gap:11px;padding:9px 20px 9px 10px;border:1px solid var(--bd);border-radius:999px;background:var(--card);font-weight:600;font-size:.95rem;white-space:nowrap;box-shadow:0 1px 2px rgba(33,26,22,.05);transition:transform .18s,border-color .18s,box-shadow .18s}
.mchip:hover{transform:translateY(-3px);border-color:color-mix(in srgb,var(--pri) 40%,var(--bd));box-shadow:0 12px 24px -16px color-mix(in srgb,var(--pri) 45%,transparent)}
.mchip .mi{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;color:var(--pri);background:var(--wash);flex:none}.mchip .mi svg{width:19px;height:19px}
/* ══ 3 BƯỚC: huy hiệu số phẳng + đường nối ══ */
.steps{display:grid;gap:24px;grid-template-columns:repeat(3,1fr);position:relative}
.step{text-align:center;padding:0 8px;position:relative}
.step .n{width:60px;height:60px;border-radius:50%;background:var(--pri);color:#fff;font-weight:800;font-size:1.4rem;display:grid;place-items:center;margin:0 auto 16px;box-shadow:0 12px 24px -14px color-mix(in srgb,var(--pri) 70%,transparent);position:relative;z-index:1;border:4px solid var(--bg)}
.step h3{margin:0 0 6px;font-size:1.2rem}.step p{margin:0;color:var(--mut);font-size:.97rem}
@media(min-width:961px){.steps::before{content:"";position:absolute;top:30px;left:17%;right:17%;height:2px;background:repeating-linear-gradient(90deg,color-mix(in srgb,var(--pri) 40%,var(--bd)) 0 10px,transparent 10px 20px)}}
/* ══ KHỐI TÍNH NĂNG XEN KẼ ══ */
.flag{display:grid;grid-template-columns:1fr 1fr;gap:56px;align-items:center;padding:34px 0}
.flag .kick2{display:inline-flex;align-items:center;gap:8px;font-size:.8rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--prid);background:color-mix(in srgb,var(--pri) 12%,var(--bg));padding:6px 14px;border-radius:999px;margin:0 0 14px}
.flag .kick2 svg{width:15px;height:15px}
.flag h3{font-size:clamp(1.4rem,2.6vw,1.9rem);font-weight:800;letter-spacing:-.02em;margin:0 0 12px;text-wrap:balance}
.flag .fd{color:var(--mut);margin:0 0 18px;line-height:1.7}
.flag ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:11px}
.flag li{display:flex;gap:10px;align-items:flex-start;color:var(--soft);font-size:.97rem}
.flag li svg{width:19px;height:19px;flex:none;color:var(--good);margin-top:2px}
.flag.rev .flag-vis{order:-1}
/* ══ TESTIMONIALS (thẻ phẳng, viền ấm, bóng mềm — không glass) ══ */
.tst-grid{display:grid;gap:22px;grid-template-columns:repeat(3,1fr)}
.tst{background:var(--card);border:1px solid var(--bd);border-radius:18px;padding:30px;display:flex;flex-direction:column;transition:transform .25s cubic-bezier(.2,.7,.2,1),box-shadow .25s,border-color .25s}
.tst:hover{transform:translateY(-4px);border-color:color-mix(in srgb,var(--pri) 28%,var(--bd));box-shadow:0 22px 44px -32px color-mix(in srgb,var(--pri) 40%,transparent)}
.tst .quote{font-size:2.8rem;line-height:1;color:var(--pri);font-family:Georgia,"Times New Roman",serif;height:26px;opacity:.55}
.tst p{margin:12px 0 20px;color:var(--soft);font-size:1rem;line-height:1.7;flex:1}
.tst .who{display:flex;align-items:center;gap:12px}
.tst .av{width:44px;height:44px;border-radius:50%;background:var(--pri);color:#fff;font-weight:700;display:grid;place-items:center}
.tst .nm{font-weight:700;font-size:.95rem}.tst .rl{font-size:.85rem;color:var(--mut)}
/* ══ PRICING (nền kem-đào) ══ */
.pricing{background:var(--surf)}
.plans{display:grid;gap:24px;grid-template-columns:repeat(3,1fr);align-items:start}
.plan{position:relative;background:var(--card);border:1px solid var(--bd);border-radius:20px;padding:34px 28px;display:flex;flex-direction:column;transition:transform .25s,box-shadow .25s}
.plan:hover{transform:translateY(-4px);box-shadow:0 22px 46px -34px rgba(33,26,22,.3)}
.plan.hot{border:2px solid var(--pri);box-shadow:0 28px 56px -36px color-mix(in srgb,var(--pri) 55%,transparent);transform:translateY(-8px)}
.plan.hot:hover{transform:translateY(-12px)}
.plan-badge{position:absolute;top:-14px;left:50%;transform:translateX(-50%);background:var(--pri);color:#fff;font-size:.76rem;font-weight:700;padding:6px 16px;border-radius:999px;white-space:nowrap;box-shadow:0 8px 18px -8px color-mix(in srgb,var(--pri) 70%,transparent)}
.plan-tag{font-size:.85rem;color:var(--mut);font-weight:600}
.plan-name{font-weight:800;font-size:1.35rem;margin:2px 0 6px}
.plan-price{font-size:2.3rem;font-weight:800;letter-spacing:-.02em;margin:0 0 22px}.plan-price span{font-size:.95rem;font-weight:500;color:var(--mut)}
.plan ul{list-style:none;padding:0;margin:0 0 26px;flex:1;display:flex;flex-direction:column;gap:12px}
.plan li{display:flex;align-items:flex-start;gap:10px;color:var(--soft);font-size:.96rem}
.plan li svg{width:18px;height:18px;flex:none;color:var(--good);margin-top:2px}
.plan-note{text-align:center;color:var(--mut);font-size:.94rem;margin-top:30px}
.plan-note a{color:var(--pri);font-weight:600}.plan-note a:hover{text-decoration:underline}
/* ══ CTA CUỐI ══ */
.cta-box .cta-sub{font-size:1.02rem;opacity:.92;margin-top:-16px;margin-bottom:26px;position:relative}
.cta-box .cta-row{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;position:relative}
.cta-box .btn-ghost{background:transparent;color:#fff;border-color:rgba(255,255,255,.55)}.cta-box .btn-ghost:hover{border-color:#fff;color:#fff}
/* ══ CHỐNG TRÀN NGANG — ba lỗi ĐO ĐƯỢC trên bản trước, ba nguyên nhân khác nhau ══
   Đo bằng headless_shell ở bề rộng thật, so scrollWidth với clientWidth (KHÔNG so với
   innerWidth: innerWidth còn tính cả thanh cuộn nên bỏ lọt tràn 15px).
   (1) 360px — sw 495/345. Ô .vrow trong khối minh hoạ là flex một dòng; bề rộng tối
       thiểu của nó lên tới 391px, kéo min-content của .vis lên 429px. Ô lưới mặc định
       min-width:auto nên cột KHÔNG co xuống dưới mức đó → đẩy cả trang. Cho .vrow và
       các ô cùng họ xuống dòng khi màn hẹp.
   (2) 768px — sw 771/753. Trạng thái ĐẦU của hiệu ứng trượt ngang (.srl/.srr dịch 42px)
       nằm ngoài mép phải. Nội dung đúng, nhưng trong lúc chưa cuộn tới thì trang cuộn
       ngang được. Cắt ở đúng khối dùng hiệu ứng đó — KHÔNG cắt toàn trang, vì cắt ở tổ
       tiên sẽ phá position:sticky của khối sản phẩm.
   (3) 1024px — sw 1143/1009. Ba thẻ giá giữ nguyên 3 cột tới tận 960px; min-content mỗi
       thẻ 356px nên 3×356 + gap vượt 961px chỗ trống. Cho track co được và đổi bố cục
       sớm hơn. ══ */
.vis{min-width:0}
@media(max-width:820px){
  .vrow,.vcredit,.vcoupon,.vpts,.vflash{flex-wrap:wrap}
  .vrow .vn,.vcredit .src,.vcoupon span{flex:1 1 100%;min-width:0;white-space:normal;overflow:visible;text-overflow:clip}
  .vqr{grid-template-columns:1fr}
}
.flags{overflow-x:clip}
.flag>*,.pane>*,.prod-grid>*,.prod-list,.plan{min-width:0}
.plans{grid-template-columns:repeat(3,minmax(0,1fr))}
@media(max-width:1100px){
  .plans{grid-template-columns:1fr;max-width:440px;margin:0 auto}
  .plan.hot{transform:none}
}
/* ══ KHỐI SẢN PHẨM — cột trái cuộn, cột phải DÁN DÍNH và đổi theo ══
   Đồng bộ hai cột KHÔNG dùng JS: mỗi mục bên trái đặt một view-timeline-name, khối cha
   mở timeline-scope, khung bên phải chạy animation theo ĐÚNG dòng thời gian của mục
   tương ứng. Trang này CSP default-src 'none' và không có script-src, nên JS không phải
   lựa chọn — không phải sở thích.
   CỔNG AN TOÀN: mặc định cột phải ẨN và mỗi mục tự mang khung minh hoạ của nó ngay dưới
   chữ. Chỉ khi trình duyệt hỗ trợ ĐỦ (timeline-scope + animation-timeline), màn đủ rộng
   và người dùng không chọn giảm chuyển động thì mới đổi sang bố cục dán dính. Trình duyệt
   cũ nhận một trang bình thường đầy đủ nội dung, không có ô nào kẹt trống. ══ */
.prod{background:var(--surf)}
.prod-grid{display:grid;gap:0;margin-top:40px;align-items:start}
.pitem{padding:44px 0;border-top:1px solid var(--bd)}
.pitem:first-child{border-top:0;padding-top:0}
.pkick{display:flex;align-items:center;gap:9px;margin:0 0 12px;font-size:.78rem;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--pri)}
.pkick .pn{display:grid;place-items:center;width:26px;height:26px;border-radius:8px;background:color-mix(in srgb,var(--pri) 12%,transparent);font-variant-numeric:tabular-nums;letter-spacing:0}
.pkick svg{width:17px;height:17px}
.pitem h3{margin:0 0 10px;font-size:clamp(1.3rem,2.4vw,1.85rem);font-weight:800;letter-spacing:-.02em;text-wrap:balance}
.pitem .pd{margin:0 0 16px;color:var(--soft)}
.pitem ul{display:grid;gap:9px;margin:0;padding:0;list-style:none}
.pitem li{display:flex;gap:10px;align-items:flex-start;font-size:.97rem;color:var(--soft)}
.pitem li svg{flex:none;width:18px;height:18px;margin-top:3px;color:var(--good)}
.pvis-in{margin-top:22px}
.prod-stick{display:none}
.pstage{display:grid;min-width:0}
.pframe{grid-area:1/1;min-width:0}

@supports (timeline-scope:--a) and (animation-timeline:view()){
  @media (prefers-reduced-motion:no-preference) and (min-width:1100px){
    .prod-grid{grid-template-columns:minmax(0,1fr) minmax(0,1.04fr);gap:64px;timeline-scope:--p1,--p2,--p3,--p4,--p5}
    .pitem{min-height:74vh;display:flex;flex-direction:column;justify-content:center;padding:32px 0}
    .pitem:first-child{padding-top:32px}
    .pitem:nth-child(1){view-timeline-name:--p1}
    .pitem:nth-child(2){view-timeline-name:--p2}
    .pitem:nth-child(3){view-timeline-name:--p3}
    .pitem:nth-child(4){view-timeline-name:--p4}
    .pitem:nth-child(5){view-timeline-name:--p5}
    .pvis-in{display:none}
    .prod-stick{display:block;position:sticky;top:92px}
    .pframe{opacity:0;animation:pframe-in both;animation-timing-function:linear;animation-range:cover 0% cover 100%}
    .pframe:nth-child(1){animation-timeline:--p1}
    .pframe:nth-child(2){animation-timeline:--p2}
    .pframe:nth-child(3){animation-timeline:--p3}
    .pframe:nth-child(4){animation-timeline:--p4}
    .pframe:nth-child(5){animation-timeline:--p5}
    @keyframes pframe-in{0%,10%{opacity:0;transform:translateY(14px)}45%,55%{opacity:1;transform:none}90%,100%{opacity:0;transform:translateY(-14px)}}
  }
}
/* ══ HIỆU ỨNG CHUYỂN ĐỘNG — mỗi hiệu ứng có "cổng an toàn" riêng (giữ KÍN):
   · tab-fade/marquee: cần @media(prefers-reduced-motion:no-preference)
     (fallback = trạng thái tĩnh đầy đủ nội dung; marquee thêm @supports để chỉ chuyển
     sang nowrap khi chắc chắn chạy được animation).
   · tiết lộ cuộn (.srl/.srr): thêm @supports(animation-timeline:view()) —
     trình duyệt cũ/giảm chuyển động: KHÔNG áp opacity:0 → nội dung hiện bình thường. ══ */
@media(prefers-reduced-motion:no-preference){
  .pane{animation:pane-in .38s cubic-bezier(.2,.7,.2,1)}
  @keyframes pane-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
  @supports(width:max-content){
    .mq{-webkit-mask-image:linear-gradient(90deg,transparent,#000 7%,#000 93%,transparent);mask-image:linear-gradient(90deg,transparent,#000 7%,#000 93%,transparent)}
    .mq-inner{width:max-content;animation:mq-l 44s linear infinite}
    .mq.rev .mq-inner{animation-name:mq-r}
    .mq-set{flex-wrap:nowrap;width:auto;padding-right:14px}
    .mq-set.clone{display:flex}
    .mq:hover .mq-inner{animation-play-state:paused}
    @keyframes mq-l{to{transform:translateX(-50%)}}
    @keyframes mq-r{from{transform:translateX(-50%)}to{transform:translateX(0)}}
  }
  @supports(animation-timeline:view()){
    .srl{opacity:0;transform:translateX(-42px);animation:sr-in both;animation-timeline:view();animation-range:entry 5% cover 30%}
    .srr{opacity:0;transform:translateX(42px);animation:sr-in both;animation-timeline:view();animation-range:entry 5% cover 30%}
    @keyframes sr-in{to{opacity:1;transform:none}}
    .stag>*:nth-child(2){animation-range:entry 10% cover 36%}
    .stag>*:nth-child(3){animation-range:entry 16% cover 42%}
    .stag>*:nth-child(4){animation-range:entry 22% cover 48%}
  }
}
/* ══ RESPONSIVE ══ */
@media(max-width:960px){
  .hero-grid{grid-template-columns:1fr;gap:44px}
  .mock{max-width:520px;margin:0 auto}
  .pane{grid-template-columns:1fr;gap:30px;padding:28px 24px}
  .flag{grid-template-columns:1fr;gap:30px;padding:26px 0}
  .flag.rev .flag-vis{order:0}
  .tst-grid{grid-template-columns:1fr 1fr}
  .plans{grid-template-columns:1fr;max-width:440px;margin:0 auto}
  .plan.hot{transform:none}.plan.hot:hover{transform:translateY(-4px)}
}
@media(max-width:680px){
  .pitem{padding:32px 0}
  .stats .wrap{grid-template-columns:1fr 1fr;gap:22px}
  .tst-grid{grid-template-columns:1fr}.steps{grid-template-columns:1fr}
  .hero{padding:52px 0 64px}
  .mk-noti{left:-6px}.mk-pay{right:-6px}
  .tabbar{gap:8px}.tabbar label{padding:9px 14px;font-size:.86rem}
  .hero-cta .btn{flex:1;min-width:150px}
}`;

export function renderLanding({ contactEmail = 'lienhe@nentang.vn', contactPhone = '', brand = 'Nền Tảng', assets = new Map() } = {}) {
  // Ảnh THẬT tuỳ chọn cho các "khe" trên landing: thả file vào apps/storefront/src/assets/
  // (vd hero.webp) → hiện ảnh thật; chưa có file → dùng mock CSS (không vỡ). Thử các đuôi ảnh.
  const assetSrc = (base) => { for (const e of ['webp', 'avif', 'png', 'jpg', 'jpeg', 'svg']) { const f = base + '.' + e; if (assets && assets.has && assets.has(f)) return '/assets/' + f; } return null; };
  const heroShot = assetSrc('hero');
  const mailto = (subj) => mailtoHref(contactEmail, subj);
  const contactLine = [contactPhone ? `ĐT: ${esc(contactPhone)}` : '', `Email: ${esc(contactEmail)}`].filter(Boolean).join(' · ');

  // ── Hình minh hoạ UI phẳng cho tab + khối xen kẽ (aria-hidden: trang trí thuần) ──
  const VIS = {
    shop: `<div class="vis vshop" aria-hidden="true"><div class="vis-h"><i></i>Cửa hàng của bạn</div>
      <div class="sb">Bộ sưu tập mới về</div>
      <div class="sg">
        <div class="sc"><div class="si">${I.shirt}</div><div class="sl"></div></div>
        <div class="sc"><div class="si">${I.sofa}</div><div class="sl"></div></div>
        <div class="sc"><div class="si">${I.cosmetic}</div><div class="sl"></div></div>
      </div></div>`,
    dash: `<div class="vis" aria-hidden="true"><div class="vis-h"><i></i>Tổng quan hôm nay</div>
      <div class="dnum"><b>4.280.000đ</b><span>doanh thu hôm nay · 12 đơn</span></div>
      <div class="dbars"><i style="height:38%"></i><i style="height:56%"></i><i style="height:44%"></i><i style="height:71%"></i><i style="height:62%"></i><i style="height:88%"></i><i class="on" style="height:74%"></i></div>
      <div class="vrow"><span class="vn">Đơn chờ xác nhận</span><b>3</b><span class="pill new">Cần làm</span></div>
      <div class="vrow"><span class="vn">Sản phẩm sắp hết hàng</span><b>2</b><span class="pill warn">Cần nhập</span></div></div>`,
    orders: `<div class="vis" aria-hidden="true"><div class="vis-h"><i></i>Đơn hàng hôm nay</div>
      <div class="vrow"><span class="vc">#1042</span><span class="vn">Áo thun basic ×2</span><b>350.000đ</b><span class="pill new">Mới</span></div>
      <div class="vrow"><span class="vc">#1041</span><span class="vn">Ghế gỗ sồi ×1</span><b>1.290.000đ</b><span class="pill ship">Đang giao</span></div>
      <div class="vrow"><span class="vc">#1040</span><span class="vn">Son dưỡng ×3</span><b>250.000đ</b><span class="pill done">Đã giao</span></div>
      <div class="vrow"><span class="vc">GHN</span><span class="vn">Mã vận đơn GHN — khách tự tra cứu</span><span class="pill done">Đã lấy hàng</span></div></div>`,
    stock: `<div class="vis" aria-hidden="true"><div class="vis-h"><i></i>Tồn kho theo biến thể</div>
      <div class="vrow"><span class="vn">Áo thun — Đen / M</span><span class="vbar"><i style="width:72%"></i></span><b>36</b></div>
      <div class="vrow"><span class="vn">Áo thun — Trắng / L</span><span class="vbar"><i style="width:48%"></i></span><b>24</b></div>
      <div class="vrow"><span class="vn">Son dưỡng — Đỏ gạch</span><span class="vbar"><i class="lo" style="width:9%"></i></span><b>4</b><span class="pill warn">Sắp hết</span></div>
      <div class="vrow"><span class="vn">Phiếu nhập NCC An Phát — giá vốn tự tính</span><span class="pill done">Đã nhận</span></div></div>`,
    promo: `<div class="vis" aria-hidden="true"><div class="vis-h"><i></i>Khuyến mãi đang chạy</div>
      <div class="vflash"><b>FLASH SALE −30%</b><span class="cd"><i>02</i><i>11</i><i>45</i></span></div>
      <div class="vcoupon"><span class="code">GIAM10</span><span>Giảm 10% cho đơn từ 500.000đ — hết hạn tự khoá</span></div>
      <div class="vpts"><span class="ic">${I.star}</span><div><b>+120 điểm thưởng</b><span>Khách quen tích luỹ, đổi giảm giá lần sau</span></div></div></div>`,
    money: `<div class="vis" aria-hidden="true"><div class="vis-h"><i></i>Tiền vào tài khoản CỦA BẠN</div>
      <div class="vcredit"><span class="amt">+350.000đ</span><span class="src">VietQR · đơn #1042 — tự khớp</span><span class="tm">vừa xong</span></div>
      <div class="vcredit"><span class="amt">+1.290.000đ</span><span class="src">COD · hãng ship chuyển — đã đối soát</span><span class="tm">hôm nay</span></div>
      <div class="vrow"><span class="vn">Nền tảng không giữ tiền — 0đ nằm ở trung gian</span><span class="pill done">Luôn luôn</span></div></div>`,
    qr: `<div class="vis" aria-hidden="true"><div class="vis-h"><i></i>Thanh toán VietQR</div>
      <div class="vqr"><span class="q">${I.qr}</span><div><b>Quét là tiền về tài khoản bạn</b><span>Mỗi shop một cấu hình QR riêng — không ví trung gian</span></div></div>
      <div class="vcredit"><span class="amt">+499.000đ</span><span class="src">Khớp đơn #1039 tự động</span><span class="tm">3 phút trước</span></div></div>`,
    guard: `<div class="vis" aria-hidden="true"><div class="vis-h"><i></i>Lá chắn đơn ảo</div>
      <div class="vrow"><span class="vn">Đơn COD quá 7 ngày không nhận</span><span class="pill warn">Tự huỷ + nhả kho</span></div>
      <div class="vrow"><span class="vn">Cùng SĐT đặt dồn dập nhiều đơn</span><span class="pill warn">Chặn vượt trần</span></div>
      <div class="vrow"><span class="vn">SĐT đặt bất thường nhiều nguồn</span><span class="pill ship">⚠ Gắn cờ chờ duyệt</span></div>
      <div class="vrow"><span class="vn">Khách thật đặt hàng bình thường</span><span class="pill done">Vào mượt</span></div></div>`,
    loyal: `<div class="vis" aria-hidden="true"><div class="vis-h"><i></i>Khách quen của shop</div>
      <div class="vrow"><span class="vn">Chị Lan — 5 đơn · lần cuối 3 ngày trước</span><span class="pill done">Thân thiết</span></div>
      <div class="vpts"><span class="ic">${I.star}</span><div><b>860 điểm tích luỹ</b><span>Đổi được 86.000đ cho đơn sau</span></div></div>
      <div class="vcoupon"><span class="code">QUAYLAI15</span><span>Ưu đãi riêng gửi khách lâu chưa mua</span></div></div>`,
    safe: `<div class="vis" aria-hidden="true"><div class="vis-h"><i></i>Trực hệ thống 24/7</div>
      <div class="vrow"><span class="vn">Sao lưu mã hoá hằng ngày</span><span class="pill done">Hoàn tất</span></div>
      <div class="vrow"><span class="vn">Chứng chỉ HTTPS mọi tên miền</span><span class="pill done">Tự gia hạn</span></div>
      <div class="vrow"><span class="vn">Giám sát đường tiền webhook</span><span class="pill done">Đang canh</span></div>
      <div class="vrow"><span class="vn">Xuất toàn bộ dữ liệu của bạn</span><span class="pill new">Bất cứ lúc nào</span></div></div>`,
  };

  const tabInputs = TABS.map((_, i) => `<input type="radio" name="ft" id="ft-${i}"${i === 0 ? ' checked' : ''} aria-label="${esc(TABS[i].label)}">`).join('');
  const tabLabels = TABS.map((t, i) => `<label for="ft-${i}">${t.icon}${esc(t.label)}</label>`).join('');
  const tabPanes = TABS.map((t) => `<div class="pane">
    <div><h3>${esc(t.h)}</h3><p class="pd">${esc(t.d)}</p>
      <ul>${t.bullets.map((b) => `<li>${I.check}<span>${esc(b)}</span></li>`).join('')}</ul>
      <a class="plink" href="${SIGNUP_URL}">Dùng thử miễn phí 14 ngày ${I.arrow}</a>
    </div>
    <div>${VIS[t.vis]}</div>
  </div>`).join('');

  // Mỗi mục dựng HAI lần từ CÙNG một nguồn (PRODUCTS + VIS): bản trong dòng cho màn hẹp
  // và trình duyệt chưa hỗ trợ, bản dán dính cho màn rộng. Dựng từ một nguồn nên hai bản
  // KHÔNG THỂ trôi khỏi nhau — chép tay ra hai chỗ thì sẽ trôi, và trôi âm thầm.
  const prodItem = (x) => `<article class="pitem">
    <p class="pkick"><span class="pn">${esc(x.n)}</span>${x.icon}${esc(x.kick)}</p>
    <h3>${esc(x.h)}</h3>
    <p class="pd">${esc(x.d)}</p>
    <ul>${x.bullets.map((b) => `<li>${I.check}<span>${esc(b)}</span></li>`).join('')}</ul>
    <div class="pvis-in">${VIS[x.vis]}</div>
  </article>`;

  const chip = (x) => `<span class="mchip"><span class="mi">${x.icon}</span>${esc(x.name)}</span>`;
  const half = Math.ceil(INDUSTRIES.length / 2);
  const mqRow = (items, rev) => {
    const set = items.map(chip).join('');
    return `<div class="mq${rev ? ' rev' : ''}"><div class="mq-inner"><div class="mq-set">${set}</div><div class="mq-set clone" aria-hidden="true">${set}</div></div></div>`;
  };

  const flagBlock = (f, i) => `<div class="flag${i % 2 ? ' rev' : ''}">
    <div class="flag-txt ${i % 2 ? 'srr' : 'srl'}"><p class="kick2">${f.icon}${esc(f.kick)}</p><h3>${esc(f.h)}</h3><p class="fd">${esc(f.d)}</p>
      <ul>${f.bullets.map((b) => `<li>${I.check}<span>${esc(b)}</span></li>`).join('')}</ul></div>
    <div class="flag-vis ${i % 2 ? 'srl' : 'srr'}">${VIS[f.vis]}</div>
  </div>`;

  const planCard = (p) => `<div class="plan reveal${p.hot ? ' hot' : ''}">
    ${p.hot ? '<div class="plan-badge">Phổ biến nhất</div>' : ''}
    <div class="plan-tag">${esc(p.tagline)}</div>
    <h3 class="plan-name">${esc(p.name)}</h3>
    <div class="plan-price">${esc(p.price)}<span>${esc(p.unit)}</span></div>
    <ul>${p.feat.map((f) => `<li>${I.check}<span>${esc(f)}</span></li>`).join('')}</ul>
    <a class="btn ${p.hot ? 'btn-cta' : 'btn-ghost'} btn-block" href="${SIGNUP_URL}">Dùng thử miễn phí 14 ngày</a>
  </div>`;

  const mockCard = (icon, price) => `<div class="mk-card"><div class="mk-img">${icon}</div><div class="mk-body"><div class="mk-l"></div><div class="mk-row"><span class="mk-price">${price}</span><span class="mk-buy">${I.cart}</span></div></div></div>`;

  const body = `<header class="hero"><div class="wrap"><div class="hero-grid">
  <div>
    <p class="eyebrow">${I.bolt}Nền tảng bán hàng online cho người Việt</p>
    <h1>Website bán hàng của riêng bạn — <span class="g">tiền về thẳng túi</span>.</h1>
    <p class="lead">Dựng cửa hàng trong 3 phút, dùng thử miễn phí 14 ngày. Đơn hàng, vận chuyển GHN/GHTK, kho, khuyến mãi — đủ đồ nghề để bán, không cần biết code.</p>
    <div class="hero-cta">
      <a class="btn btn-cta btn-lg" href="${SIGNUP_URL}">Bắt đầu miễn phí <span class="btn-arrow">${I.arrow}</span></a>
      <a class="btn btn-ghost btn-lg" href="/#bang-gia">Xem bảng giá</a>
    </div>
    <div class="hero-trust"><span>${I.check}14 ngày dùng thử miễn phí</span><span>${I.check}Không cần thẻ</span><span>${I.wallet}Chúng tôi không giữ tiền của bạn</span><span>${I.headset}Hỗ trợ người thật</span></div>
  </div>
  <div class="mock-wrap">
    <div class="mock"${heroShot ? '' : ' aria-hidden="true"'}>
      <div class="mock-bar"><i></i><i></i><i></i><span class="url">shop.nentang.vn</span></div>
      ${heroShot ? `<img class="mock-shot" src="${esc(heroShot)}" alt="Ảnh giao diện cửa hàng trên nền tảng" loading="eager">` : `<div class="mk-screen">
        <div class="mk-top"><span class="mk-logo">CỬA HÀNG</span><span class="mk-nav"></span><span class="mk-dot">${I.cart}</span></div>
        <div class="mk-banner"><span class="mkb-t">Bộ sưu tập mới về</span><span class="mkb-btn">Mua ngay</span></div>
        <div class="mk-grid">
          ${mockCard(I.shirt, '₫350.000')}
          ${mockCard(I.sofa, '₫1.290.000')}
          ${mockCard(I.cosmetic, '₫250.000')}
        </div>
      </div>`}
    </div>
    <div class="mk-float mk-pay" aria-hidden="true"><span class="ico">${I.qr}</span><div><b>+350.000đ VietQR</b><span>vào tài khoản của bạn</span></div></div>
    <div class="mk-float mk-noti" aria-hidden="true"><span class="ico">${I.bell}</span><div><b>Đơn hàng mới +1</b><span>vừa xong</span></div></div>
  </div>
</div></div></header>

<section class="stats" aria-label="Cam kết"><div class="wrap stag">
  ${STATS.map((s) => `<div class="stat reveal"><div class="n">${esc(s.n)}</div><div class="l">${esc(s.l)}</div></div>`).join('')}
</div></section>

<section class="sec prod" id="san-pham"><div class="wrap">
  <div class="sec-head reveal"><p class="kick">Sản phẩm</p><h2>Một vòng qua thứ bạn sẽ dùng mỗi ngày</h2><p>Cuộn xuống — khung bên phải đổi theo đúng phần bạn đang đọc.</p></div>
  <div class="prod-grid">
    <div class="prod-list">${PRODUCTS.map(prodItem).join('')}</div>
    <div class="prod-stick" aria-hidden="true"><div class="pstage">${PRODUCTS.map((x) => `<div class="pframe">${VIS[x.vis]}</div>`).join('')}</div></div>
  </div>
</div></section>

<section class="sec" id="tinh-nang"><div class="wrap">
  <div class="sec-head reveal"><p class="kick">Tính năng</p><h2>Mọi thứ để bán hàng online, gọn trong một chỗ</h2><p>Chọn một mảng để xem — tất cả đều có sẵn trong mọi gói, không cài thêm gì.</p></div>
  <div class="tabs">
    ${tabInputs}
    <div class="tabbar">${tabLabels}</div>
    <div class="panes">${tabPanes}</div>
  </div>
</div></section>

<section class="sec ind-wrap" id="nganh-hang"><div class="wrap">
  <div class="sec-head reveal"><p class="kick">Ngành hàng</p><h2>Dù bạn kinh doanh gì, cũng dựng được cửa hàng hợp gu</h2><p>Từ thời trang tới nội thất, cà phê tới thú cưng — giao diện tự chỉnh theo đúng chất ngành của bạn.</p></div>
</div>
  ${mqRow(INDUSTRIES.slice(0, half), false)}
  ${mqRow(INDUSTRIES.slice(half), true)}
</section>

<section class="sec" id="cach-hoat-dong"><div class="wrap">
  <div class="sec-head reveal"><p class="kick">Cách hoạt động</p><h2>Bắt đầu bán trong 3 bước</h2><p>Tự làm được hết — và luôn có người thật đồng hành khi bạn cần.</p></div>
  <div class="steps stag">${STEPS.map((s) => `<div class="step reveal"><div class="n">${esc(s.n)}</div><h3>${esc(s.t)}</h3><p>${esc(s.d)}</p></div>`).join('')}</div>
</div></section>

<section class="sec flags" style="padding-top:40px"><div class="wrap">
  <div class="sec-head reveal"><p class="kick">Vì sao chọn chúng tôi</p><h2>Làm thật những việc khó nhất của bán hàng online</h2></div>
  ${FLAGS.map(flagBlock).join('')}
</div></section>

<section class="sec ind-wrap"><div class="wrap">
  <div class="sec-head reveal"><p class="kick">Khách hàng nói gì</p><h2>Người bán thật, kết quả thật</h2></div>
  <div class="tst-grid stag">${TESTIMONIALS.map((t) => `<div class="tst reveal"><div class="quote" aria-hidden="true">&ldquo;</div><p>${esc(t.q)}</p><div class="who"><div class="av" aria-hidden="true">${esc(t.name.trim().split(' ').pop()[0] || '?')}</div><div><div class="nm">${esc(t.name)}</div><div class="rl">${esc(t.role)}</div></div></div></div>`).join('')}</div>
</div></section>

<section class="sec pricing" id="bang-gia"><div class="wrap">
  <div class="sec-head reveal"><p class="kick">Bảng giá</p><h2>Đơn giản, minh bạch, không phí ẩn</h2><p>Mọi gói đều bắt đầu bằng 14 ngày dùng thử miễn phí — không cần thẻ.</p></div>
  <div class="plans stag">${PLANS.map(planCard).join('')}</div>
  <p class="plan-note">Chưa chắc chọn gói nào? <a href="${mailto('Tư vấn chọn gói dịch vụ')}">Nhận tư vấn miễn phí qua email</a> — có người thật trả lời.</p>
</div></section>

<section class="sec" id="faq"><div class="wrap">
  <div class="sec-head reveal"><p class="kick">Hỏi đáp</p><h2>Câu hỏi thường gặp</h2></div>
  <div class="faq">${FAQS.map((f) => `<details><summary>${esc(f.q)}</summary><div class="ans">${esc(f.a)}</div></details>`).join('')}</div>
</div></section>

<section class="cta-final"><div class="wrap"><div class="cta-box reveal">
  <h2>Dễ bắt đầu · Dễ bán hàng · Dễ tăng trưởng</h2>
  <p>Trải nghiệm miễn phí 14 ngày — không cần thẻ, huỷ lúc nào cũng được.</p>
  <p class="cta-sub">Hoặc để chúng tôi dựng cửa hàng giúp bạn, tận tay từ A tới Z.</p>
  <div class="cta-row">
    <a class="btn btn-primary btn-lg" href="${SIGNUP_URL}">Bắt đầu miễn phí ${I.arrow}</a>
    <a class="btn btn-ghost btn-lg" href="${mailto('Tôi muốn được dựng cửa hàng giúp')}" aria-label="Nhờ dựng cửa hàng giúp (gửi email)">Nhờ dựng giúp</a>
  </div>
  <div class="cta-contact">${contactLine}</div>
</div></div></section>`;

  return sitePage({
    title: `${esc(brand)} — Nền tảng website bán hàng cho người Việt, tiền về thẳng tài khoản bạn`,
    description: 'Dựng cửa hàng online trong 3 phút, dùng thử miễn phí 14 ngày. Đơn hàng, vận chuyển GHN/GHTK, kho, khuyến mãi, thanh toán COD + VietQR vào thẳng tài khoản bạn — không cần biết code.',
    brand, contactEmail, contactPhone, active: '', extraCss: CSS, body,
  });
}
