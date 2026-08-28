/**
 * Trang CHỦ công ty của nền tảng (nentang.vn gốc — không phải shop nào): marketing + bảng giá.
 *
 * BỐ CỤC: thanh điều hướng nổi ẩn/hiện theo chiều cuộn · hero băng 3 banner đổi được · dải cam
 * kết · bảng so sánh với thị trường · khối sản phẩm hai cột đồng bộ khi cuộn · giải pháp tăng
 * trưởng trên nền tối · băng thẻ ngành hàng lướt ngang có lọc · bảng giá · hỏi đáp · CTA cuối · chân trang · thanh CTA
 * nổi. Trang tự mang header/footer riêng (sitePage với shell:false) vì bộ điều hướng của nó
 * khác hẳn các trang công ty còn lại.
 *
 * LỚP TĂNG CƯỜNG — đọc trước khi sửa JS:
 * Trang phải DÙNG ĐƯỢC KHI KHÔNG CÓ JS. Server chỉ phát script-src khi có nonce; thiếu nonce
 * thì sitePage cũng không chèn script. Vì vậy mọi thứ JS làm đều là TĂNG CƯỜNG, không phải điều
 * kiện: không JS thì thanh điều hướng đứng yên (vẫn bấm được), hero hiện slide đầu (vẫn đủ chữ
 * và đủ nút), thanh CTA nổi không xuất hiện, và hiệu ứng hiện-dần KHÔNG áp trạng thái ẩn (quy
 * tắc nằm sau html.lpjs, mà cờ đó do chính JS gắn). Đừng bao giờ để nội dung chỉ tồn tại trong
 * JS — đã có lần phần tử kẹt opacity:0 và mất trắng chữ trong khi mọi phép đo tràn ngang vẫn
 * báo ĐẠT.
 *
 * Đồng bộ hai cột ở khối sản phẩm vẫn giữ THUẦN CSS (view-timeline-name + timeline-scope) dù
 * trang đã có JS: nó chạy trên luồng dựng hình nên không giật, và không tốn handler cuộn nào.
 *
 * PHÔNG: Be Vietnam Pro tự-host, CHỈ có 400/600/800 — không khai 500/700/900, thiếu file thì
 * trình duyệt tự bóp chữ và kết quả xấu theo kiểu rất khó chỉ tên.
 *
 * NỘI DUNG TRUNG THỰC: không bịa số khách hàng, không bịa giải thưởng, không bịa case study.
 * Kho này chưa triển khai và chưa có khách thật (CLAUDE.md §0) — mọi lời chứng thực dựng lên
 * đều là nói dối người đọc, và là thứ đối thủ kiểm chứng được. Chỉ nêu cam kết thật và tính
 * năng có thật. Sửa nội dung: các mảng ngay dưới đây.
 */
import { esc, I, mailtoHref, sitePage, SIGNUP_URL, ADMIN_LOGIN_URL } from './site.js';

// ── BANNER HERO — thêm/bớt phần tử là đổi được băng, không phải sửa markup ────
// Còn đúng 1 phần tử thì băng tự tắt tự-chạy và ẩn thanh điều khiển.
const BANNERS = [
  {
    h: 'Website bán hàng của riêng bạn, tiền về thẳng túi',
    d: 'Dựng cửa hàng trong 3 phút, dùng thử miễn phí 14 ngày. Đơn hàng, vận chuyển GHN/GHTK, kho, khuyến mãi — đủ đồ nghề để bán, không cần biết code.',
    cta: 'Bắt đầu miễn phí', href: SIGNUP_URL, vis: 'shop',
  },
  {
    h: 'Khách quét mã là tiền vào tài khoản của bạn',
    d: 'Không ví trung gian, không giữ hộ, không phí rút. Hệ thống tự khớp tiền với đơn và khớp đúng tài khoản nhận — trả trùng cũng không cộng hai lần.',
    cta: 'Xem cách đường tiền chạy', href: '#giai-phap', vis: 'money',
  },
  {
    h: 'Cửa hàng chạy được cả khi mạng yếu',
    d: 'Trang bán và trang đặt hàng dựng sẵn ở máy chủ, không bắt khách tải app. Mạng chập chờn vẫn mua được — chỗ khác là trang trắng và mất đơn mà không ai biết.',
    cta: 'So với nơi khác', href: '#loi-ich', vis: 'orders',
  },
];

// Mục LỢI ÍCH: danh sách bên trái trên nền xanh, khung xem bên phải trên nền trắng.
// Mỗi mục có khe ảnh riêng — thả li-<khoá>.webp (hoặc .png/.jpg/.avif/.svg) vào
// apps/storefront/src/assets/. Chưa có tệp thì dùng khung minh hoạ CSS, không để ô trống.
const LOI_ICH = [
  {
    icon: I.users, key: 'du-lieu', vis: 'loyal',
    t: 'Sở hữu 100% dữ liệu khách hàng',
    d: 'Kênh bán của riêng bạn: tên miền riêng, danh sách khách riêng, không sàn nào đứng giữa bạn và người mua.',
    h: 'Sở hữu 100% dữ liệu khách hàng với kênh bán riêng của bạn',
  },
  {
    icon: I.wallet, key: 'tien-ve', vis: 'qr',
    t: 'Tiền về thẳng tài khoản của bạn',
    d: 'Khách quét VietQR là tiền vào ngân hàng của bạn. Không ví trung gian, không giữ hộ, không phí rút.',
    h: 'Tiền khách trả vào thẳng tài khoản ngân hàng của bạn',
  },
  {
    icon: I.bolt, key: 'mang-yeu', vis: 'shop',
    t: 'Bán được cả khi mạng yếu',
    d: 'Trang bán và trang đặt hàng dựng sẵn ở máy chủ, chạy được cả khi trình duyệt không có JavaScript.',
    h: 'Không mất đơn vì trang trắng khi mạng chập chờn',
  },
  {
    icon: I.box, key: 'nghiep-vu', vis: 'orders',
    t: 'Đủ nghiệp vụ để bán thật',
    d: 'Đơn hàng, tồn kho theo biến thể, GHN/GHTK, khuyến mãi, đối soát — không phải ghép từ năm công cụ rời.',
    h: 'Đủ đồ nghề để bán, không phải ghép từ năm công cụ rời',
  },
];

const NAV = [
  { href: '#san-pham', label: 'Sản phẩm' },
  { href: '#loi-ich', label: 'So sánh' },
  { href: '#giai-phap', label: 'Giải pháp' },
  { href: '#nganh-hang', label: 'Ngành hàng' },
  { href: '#bang-gia', label: 'Bảng giá' },
];


// ── BẢNG SO SÁNH ────────────────────────────────────────────────────────────
// Dòng cuối là chỗ CHÚNG TA THUA. Bảng so sánh thắng mọi ô thì người đọc trừ điểm
// ngay, và đó là phản ứng đúng. Số liệu của bên khác mô tả CÁCH VẬN HÀNH phổ biến,
// không phải báo giá — không bịa con số của đối thủ.
const CMP_COLS = ['TikFlash', 'Nền tảng phổ thông', 'Sàn TMĐT'];
const CMP = [
  ['Hoa hồng trên mỗi đơn',
    ['ok', '<b>0%.</b> Bạn giữ trọn doanh thu, chỉ trả phí thuê bao cố định'],
    ['mid', 'Không thu hoa hồng, nhưng cộng phí cổng thanh toán mỗi giao dịch'],
    ['no', 'Chiết khấu theo ngành hàng, cộng phí thanh toán và phí dịch vụ']],
  ['Tiền về tài khoản shop',
    ['ok', 'Ngay khi khách chuyển khoản, vào <b>thẳng tài khoản của shop</b>'],
    ['mid', 'Qua ví trung gian rồi mới rút về ngân hàng'],
    ['no', 'Chỉ giải ngân sau khi giao thành công và hết hạn khiếu nại']],
  ['Dữ liệu khách hàng',
    ['ok', 'Shop sở hữu toàn bộ. Xuất khách, đơn, doanh thu bất cứ lúc nào'],
    ['mid', 'Shop sở hữu, nhưng xuất đầy đủ thường phải lên gói cao'],
    ['no', 'Sàn giữ. Số điện thoại và địa chỉ khách bị che một phần']],
  ['Đối soát thanh toán',
    ['ok', 'Khớp <b>đúng tài khoản nhận</b>, không chỉ khớp mã đơn. Khách bấm trả hai lần cũng không cộng hai lần'],
    ['mid', 'Tuỳ cổng thanh toán bạn gắn vào; lệch thì tự dò tay'],
    ['mid', 'Sàn đối soát theo kỳ; lệch phải mở khiếu nại và chờ']],
  ['Khách mua khi mạng yếu',
    ['ok', 'Trang bán và trang đặt hàng <b>chạy được cả khi không có JavaScript</b>'],
    ['mid', 'Phụ thuộc JavaScript. Mạng chập chờn là trang trắng, mất đơn mà không ai biết'],
    ['no', 'Bắt tải app, hoặc trang nặng vài megabyte']],
  ['Tên miền riêng của shop',
    ['ok', 'Có, kèm chứng chỉ HTTPS tự cấp và tự gia hạn'],
    ['mid', 'Có, thường nằm ở gói cao'],
    ['no', 'Không — địa chỉ luôn mang tên sàn']],
  ['Đối thủ nằm cạnh sản phẩm',
    ['ok', 'Không. Trang chỉ có sản phẩm của bạn'],
    ['ok', 'Không'],
    ['no', 'Có. Khách so giá với shop khác ngay dưới sản phẩm của bạn']],
  ['Nguồn khách có sẵn',
    ['no', '<b>Chưa có.</b> Bạn mang khách về, chúng tôi lo phần bán và giữ chân'],
    ['no', 'Chưa có'],
    ['ok', 'Có sẵn lượng truy cập lớn — đổi bằng chiết khấu và cạnh tranh giá']],
];

const PRODUCTS = [
  {
    n: '01', icon: I.chart, kick: 'Tổng quan', key: 'tong-quan', vis: 'dash',
    h: 'Mở máy là biết hôm nay bán được bao nhiêu',
    d: 'Doanh thu, đơn mới, việc cần xử lý — gom về một màn hình, không phải mở bốn chỗ để cộng tay.',
    bullets: ['Doanh thu hôm nay, tuần này, tháng này — theo giờ Việt Nam', 'Việc cần xử lý xếp trước: đơn chờ xác nhận, hàng sắp hết', 'Sản phẩm bán chạy để biết nên nhập thêm gì'],
  },
  {
    n: '02', icon: I.truck, kick: 'Đơn hàng', key: 'don-hang', vis: 'orders',
    h: 'Đơn về là chạy — từ chốt tới giao',
    d: 'Xác nhận, đóng gói, đẩy sang GHN/GHTK bằng tài khoản của chính bạn. Khách tự tra cứu bằng mã đơn.',
    bullets: ['Tách vận đơn, giao một phần, đổi trả — đủ nghiệp vụ thật', 'Đối soát COD với hãng ship, lệch là thấy ngay', 'Sửa đơn có ghi vết: ai sửa gì, lúc nào'],
  },
  {
    n: '03', icon: I.box, kick: 'Kho hàng', key: 'kho-hang', vis: 'stock',
    h: 'Tồn kho chuẩn tới từng biến thể',
    d: 'Màu, size, phiên bản — mỗi biến thể một số tồn. Trừ kho ngay lúc khách đặt, không bao giờ bán lố.',
    bullets: ['Tồn khả dụng = tồn thật − đang giữ − đệm an toàn bạn đặt', 'Nhập hàng, giá vốn bình quân tự tính, báo cáo lãi lỗ thật', 'Cảnh báo sắp hết trước khi hết, không phải sau'],
  },
  {
    n: '04', icon: I.wallet, kick: 'Tiền về', key: 'tien-ve', vis: 'money',
    h: 'Tiền vào thẳng tài khoản của bạn',
    d: 'Khách quét VietQR là tiền về ngân hàng của bạn. Hệ thống tự khớp tiền với đơn, không cần bạn dò tay.',
    bullets: ['Khớp đúng TÀI KHOẢN NHẬN, không chỉ khớp mã đơn', 'Khách bấm trả hai lần cũng không cộng hai lần', 'Trả thiếu thì vào hàng đợi đối soát, không tự ghi "đã trả"'],
  },
  {
    n: '05', icon: I.palette, kick: 'Cửa hàng', key: 'cua-hang', vis: 'shop',
    h: 'Cửa hàng đẹp, và chạy được cả khi mạng yếu',
    d: 'Đổi banner, màu, logo ngay trong trang quản trị. Trang bán hàng dựng sẵn ở máy chủ nên mở là thấy.',
    bullets: ['Trang bán và trang đặt hàng chạy được cả khi không có JavaScript', 'Chuẩn SEO: sitemap, dữ liệu có cấu trúc, tự lên Google', 'Tên miền riêng của bạn, HTTPS tự cấp và tự gia hạn'],
  },
];

// ── NGÀNH HÀNG — mỗi ngành MỘT THẺ trong băng lướt ngang ─────────────────────
// Bố cục thẻ (ảnh bìa · nhãn ngành · tên · mô tả · đồ nghề) cố ý dựng theo hình dạng
// một CASE STUDY để sau này thay được bằng cửa hàng thật của khách: chỉ cần đổi `h`,
// `d` và thả ảnh vào khe `nh-<khoá>` là thẻ thành hồ sơ khách hàng, không phải sửa CSS.
// CHƯA CÓ KHÁCH THẬT (CLAUDE.md §0) nên hôm nay đây là CỬA HÀNG MẪU và mục có một
// dòng nói rõ điều đó — bịa tên shop là thứ đối thủ kiểm chứng được trong một phút.
// `tags` chỉ được nêu tính năng CÓ THẬT trong hệ thống.
const INDUSTRIES = [
  {
    key: 'thoi-trang', icon: I.shirt, name: 'Thời trang',
    h: 'Cửa hàng thời trang',
    d: 'Một mã hàng nhiều size nhiều màu, mỗi biến thể một tồn riêng. Hết size nào thì size đó tự ngưng bán, khách không đặt được đơn mà bạn không có hàng.',
    tags: ['Biến thể size · màu', 'Flash sale theo giờ'],
  },
  {
    key: 'my-pham', icon: I.cosmetic, name: 'Mỹ phẩm',
    h: 'Cửa hàng mỹ phẩm',
    d: 'Ngành sống bằng khách mua lại. Danh sách khách quen là của bạn — không sàn nào đứng giữa, nhắc đúng người vào đúng đợt.',
    tags: ['Khách quen · điểm thưởng', 'Mã giảm giá riêng'],
  },
  {
    key: 'noi-that', icon: I.sofa, name: 'Nội thất',
    h: 'Cửa hàng nội thất',
    d: 'Hàng cồng kềnh nên phí giao khác nhau theo vùng. Biểu phí tính theo nơi nhận, không đổ đồng một giá rồi lỗ ở đơn xa.',
    tags: ['Phí ship theo vùng', 'Ảnh nhiều góc'],
  },
  {
    key: 'dien-tu', icon: I.device, name: 'Điện tử',
    h: 'Cửa hàng điện tử',
    d: 'Giá trị đơn cao nên đơn ảo COD là rủi ro thật. Đơn quá hạn không nhận sẽ tự huỷ và nhả lại tồn, còn bảo hành đi theo một luồng riêng.',
    tags: ['Yêu cầu hậu mãi · RMA', 'Lá chắn đơn ảo'],
  },
  {
    key: 'me-be', icon: I.baby, name: 'Mẹ & Bé',
    h: 'Cửa hàng mẹ & bé',
    d: 'Khách cần giao nhanh và cần biết còn hàng thật hay không. Tồn hiển thị đã trừ phần đang giữ cho đơn chưa xong, không phải con số trong kho.',
    tags: ['Tồn an toàn', 'GHN · GHTK'],
  },
  {
    key: 'thuc-pham', icon: I.food, name: 'Thực phẩm',
    h: 'Cửa hàng thực phẩm',
    d: 'Bán theo ngày, tồn thay đổi từng giờ. Đặt ngưỡng giữ an toàn cho từng mặt hàng để không bán quá số hàng thật sự còn.',
    tags: ['Tồn an toàn theo mặt hàng', 'COD · VietQR'],
  },
  {
    key: 'nha-sach', icon: I.book, name: 'Nhà sách',
    h: 'Nhà sách trực tuyến',
    d: 'Vài nghìn đầu sách thì nhập tay là hết ngày. Nhập cả danh mục từ tệp Excel hoặc từ sàn cũ, rồi xếp vào danh mục hai cấp.',
    tags: ['Nhập hàng loạt từ tệp', 'Danh mục hai cấp'],
  },
  {
    key: 'qua-tang', icon: I.gift, name: 'Quà tặng · Handmade',
    h: 'Cửa hàng quà tặng',
    d: 'Bán theo mùa và theo dịp. Đợt khuyến mãi hẹn giờ trước, tới giờ tự chạy và tự tắt, không phải thức canh.',
    tags: ['Khuyến mãi hẹn giờ', 'Ảnh nhiều góc'],
  },
  {
    key: 'ca-phe', icon: I.coffee, name: 'Cà phê & Trà',
    h: 'Cửa hàng cà phê & trà',
    d: 'Khách quay lại đều đặn nếu bạn nhớ họ. Điểm thưởng tích theo hoá đơn và đổi thẳng thành tiền giảm, chạy sẵn trong hệ thống, không cần app rời.',
    tags: ['Điểm thưởng · đổi điểm', 'Khách quen của shop'],
  },
  {
    key: 'the-thao', icon: I.dumbbell, name: 'Thể thao',
    h: 'Cửa hàng đồ thể thao',
    d: 'Nhiều size, nhiều mẫu, hay hết cục bộ. Mỗi biến thể một mã và một tồn riêng nên báo cáo bán chạy đọc được ở mức size.',
    tags: ['Biến thể size', 'Báo cáo bán chạy'],
  },
  {
    key: 'thu-cung', icon: I.paw, name: 'Thú cưng',
    h: 'Cửa hàng thú cưng',
    d: 'Đồ ăn và đồ dùng mua lại theo chu kỳ. Lịch sử mua của từng khách nằm trong tay bạn để nhắc đúng lúc họ sắp hết hàng.',
    tags: ['Khách quen', 'Phí ship theo vùng'],
  },
  {
    key: 'trang-suc', icon: I.gem, name: 'Trang sức',
    h: 'Cửa hàng trang sức',
    d: 'Đơn giá trị cao thì đường tiền phải rõ. Khách quét VietQR là tiền vào thẳng tài khoản ngân hàng của bạn, hệ thống tự khớp tiền với đơn.',
    tags: ['VietQR — tiền về thẳng', 'Ảnh cận cảnh'],
  },
];

const STEPS = [
  { n: '1', t: 'Đăng ký miễn phí', d: 'Điền email và tên shop — 2 phút, không cần thẻ. Xác nhận email là có ngay cửa hàng dùng thử 14 ngày.' },
  { n: '2', t: 'Tự dựng trong 3 phút', d: 'Cửa hàng mẫu dựng sẵn: đổi logo, màu, đăng sản phẩm là xong. Cần thì chúng tôi dựng giúp tận tay.' },
  { n: '3', t: 'Bắt đầu bán', d: 'Nhận đơn, giao hàng, thu tiền — COD và VietQR vào thẳng tài khoản bạn.' },
];

// 4 khối tính năng xen kẽ (chữ ↔ hình đổi bên, hiệu ứng trượt vào khi cuộn).
const FLAGS = [
  {
    kick: 'Đường tiền', key: 'duong-tien', icon: I.wallet, vis: 'qr',
    h: 'Tiền của bạn không qua tay ai',
    d: 'Khác với sàn thương mại điện tử, ở đây khách thanh toán là tiền vào thẳng tài khoản ngân hàng CỦA BẠN — nền tảng không giữ hộ, không đối soát chậm, không phí rút tiền.',
    bullets: ['Mỗi shop một cấu hình VietQR riêng, tiền về tài khoản riêng', 'Hệ thống tự khớp tiền vào với đơn hàng', 'Sao kê rõ ràng — bạn luôn biết đồng nào của đơn nào'],
  },
  {
    kick: 'Chống thất thoát', key: 'chong-that-thoat', icon: I.shield, vis: 'guard',
    h: 'Bớt đơn ảo, bớt bom hàng',
    d: 'Bán COD ở Việt Nam sợ nhất đơn ảo. Nền tảng chặn từ gốc — không cần bạn phải ngồi soi từng đơn.',
    bullets: ['Đơn COD quá hạn không nhận — tự huỷ, nhả lại tồn kho', 'Chặn spam đặt đơn hàng loạt từ cùng một nguồn', 'Tự gắn cờ cảnh báo số điện thoại đặt bất thường'],
  },
  {
    kick: 'Khách quen', key: 'khach-quen', icon: I.users, vis: 'loyal',
    h: 'Khách mua một lần, quay lại nhiều lần',
    d: 'Đơn đầu tiên là quảng cáo, đơn thứ hai mới là lãi. Đủ công cụ để khách cũ quay lại mà không tốn thêm tiền quảng cáo.',
    bullets: ['Điểm thưởng tích luỹ — mua càng nhiều, ưu đãi càng lớn', 'Tài khoản khách hàng: lịch sử đơn, sổ địa chỉ, đặt lại nhanh', 'CRM-lite: biết ai mua gì, bao nhiêu lần, lần cuối khi nào'],
  },
  {
    kick: 'An toàn', key: 'an-toan', icon: I.doc, vis: 'safe',
    h: 'Bạn ngủ ngon, hệ thống tự lo',
    d: 'Máy chủ, HTTPS, sao lưu, giám sát — phần việc "ngầm" nhưng sống còn, chúng tôi trực thay bạn.',
    bullets: ['Sao lưu mã hoá định kỳ, khôi phục được khi có sự cố', 'HTTPS tự động cho cả tên miền riêng của bạn', 'Dữ liệu là của bạn — xuất toàn bộ ra file bất cứ lúc nào'],
  },
];

const PLANS = [
  { code: 'platform', name: 'Platform', price: '990.000', unit: 'đ/tháng', hot: false, tagline: 'Bắt đầu bán online', feat: ['100 sản phẩm', 'Tên miền phụ .nentang.vn', 'COD + QR chuyển khoản', 'Quản lý đơn · tồn kho · danh mục'] },
  { code: 'care', name: 'Care', price: '2.490.000', unit: 'đ/tháng', hot: true, tagline: 'Đầy đủ để bán tốt', feat: ['Tất cả gói Platform', 'Blog & SEO nâng cao', 'Trình dựng giao diện sâu', 'Hỗ trợ ưu tiên'] },
  { code: 'growth', name: 'Growth', price: '5.900.000', unit: 'đ/tháng', hot: false, tagline: 'Cho cửa hàng lớn', feat: ['Tất cả gói Care', '500 sản phẩm', 'Tên miền riêng của bạn', 'Đối soát QR tự động'] },
];

const FAQS = [
  { q: 'Đăng ký dùng thử thế nào? Có mất phí không?', a: 'Bấm "Bắt đầu miễn phí", điền email và tên shop — sau khi xác nhận email bạn có ngay cửa hàng dùng thử 14 ngày, đầy đủ tính năng, không cần thẻ, không phí thiết lập.' },
  { q: 'Tôi không biết gì về kỹ thuật, có dùng được không?', a: 'Được. Cửa hàng mẫu dựng sẵn, bạn chỉ đổi logo, màu và đăng sản phẩm. Nếu cần, chúng tôi dựng giúp và hướng dẫn tận tay — mọi phần kỹ thuật (máy chủ, bảo mật, sao lưu) do chúng tôi lo.' },
  { q: 'Tiền khách hàng trả có qua trung gian không?', a: 'Không. Khách thanh toán COD hoặc chuyển khoản QR VietQR vào thẳng tài khoản ngân hàng của bạn. Chúng tôi không giữ, không ôm dòng tiền của bạn.' },
  { q: 'Tôi có được dùng tên miền riêng không?', a: 'Có. Bạn có thể dùng tên miền phụ miễn phí dạng shop.nentang.vn, hoặc gắn tên miền riêng của bạn (vd cuahangcuaban.com) ở gói Growth.' },
  { q: 'Nếu muốn ngừng thì dữ liệu của tôi thế nào?', a: 'Dữ liệu là của bạn. Bạn có thể xuất toàn bộ sản phẩm, đơn hàng, khách hàng ra file bất cứ lúc nào trong trang quản trị.' },
  { q: 'Chi phí có phát sinh gì ẩn không?', a: 'Không. Bạn trả theo gói hằng tháng đã niêm yết, nâng/hạ gói bất cứ lúc nào. Không phí thiết lập, không phí ẩn, không thu phần trăm trên đơn hàng.' },
];


// ── Khung minh hoạ giao diện, dựng bằng CSS (aria-hidden: trang trí thuần) ────
// Dùng lại ở CẢ khối sản phẩm, hero và giải pháp — một nguồn, ba chỗ hiện.
const VIS = {
  dash: `<div class="lp-vis" aria-hidden="true"><div class="lp-vis-h"><i></i>Tổng quan hôm nay</div>
    <div class="lp-num"><b>4.280.000đ</b><span>doanh thu hôm nay · 12 đơn</span></div>
    <div class="lp-bars"><i style="height:38%"></i><i style="height:56%"></i><i style="height:44%"></i><i style="height:71%"></i><i style="height:62%"></i><i style="height:88%"></i><i class="on" style="height:74%"></i></div>
    <div class="lp-row"><span class="n">Đơn chờ xác nhận</span><b>3</b><span class="lp-pill2 new">Cần làm</span></div>
    <div class="lp-row"><span class="n">Sản phẩm sắp hết hàng</span><b>2</b><span class="lp-pill2 warn">Cần nhập</span></div></div>`,
  orders: `<div class="lp-vis" aria-hidden="true"><div class="lp-vis-h"><i></i>Đơn hàng hôm nay</div>
    <div class="lp-row"><span class="c">#1042</span><span class="n">Áo thun basic ×2</span><b>350.000đ</b><span class="lp-pill2 new">Mới</span></div>
    <div class="lp-row"><span class="c">#1041</span><span class="n">Ghế gỗ sồi ×1</span><b>1.290.000đ</b><span class="lp-pill2 ship">Đang giao</span></div>
    <div class="lp-row"><span class="c">#1040</span><span class="n">Son dưỡng ×3</span><b>250.000đ</b><span class="lp-pill2 done">Đã giao</span></div>
    <div class="lp-row"><span class="c">GHN</span><span class="n">Mã vận đơn — khách tự tra cứu</span><span class="lp-pill2 done">Đã lấy hàng</span></div></div>`,
  stock: `<div class="lp-vis" aria-hidden="true"><div class="lp-vis-h"><i></i>Tồn kho theo biến thể</div>
    <div class="lp-row"><span class="n">Áo thun — Đen / M</span><span class="bar"><i style="width:72%"></i></span><b>36</b></div>
    <div class="lp-row"><span class="n">Áo thun — Trắng / L</span><span class="bar"><i style="width:48%"></i></span><b>24</b></div>
    <div class="lp-row"><span class="n">Son dưỡng — Đỏ gạch</span><span class="bar"><i class="lo" style="width:9%"></i></span><b>4</b><span class="lp-pill2 warn">Sắp hết</span></div>
    <div class="lp-row"><span class="n">Phiếu nhập NCC An Phát — giá vốn tự tính</span><span class="lp-pill2 done">Đã nhận</span></div></div>`,
  money: `<div class="lp-vis" aria-hidden="true"><div class="lp-vis-h"><i></i>Tiền vào tài khoản CỦA BẠN</div>
    <div class="lp-credit"><span class="amt">+350.000đ</span><span class="src">VietQR · đơn #1042 — tự khớp</span><span class="tm">vừa xong</span></div>
    <div class="lp-credit"><span class="amt">+1.290.000đ</span><span class="src">COD · hãng ship chuyển — đã đối soát</span><span class="tm">hôm nay</span></div>
    <div class="lp-row"><span class="n">Nền tảng không giữ tiền — 0đ nằm ở trung gian</span><span class="lp-pill2 done">Luôn luôn</span></div></div>`,
  shop: `<div class="lp-vis lp-shop" aria-hidden="true"><div class="lp-vis-h"><i></i>Cửa hàng của bạn</div>
    <div class="sb">Bộ sưu tập mới về</div>
    <div class="sg">
      <div class="sc"><div class="si">${I.shirt}</div><div class="sl"></div></div>
      <div class="sc"><div class="si">${I.sofa}</div><div class="sl"></div></div>
      <div class="sc"><div class="si">${I.cosmetic}</div><div class="sl"></div></div>
    </div></div>`,
  qr: `<div class="lp-vis" aria-hidden="true"><div class="lp-vis-h"><i></i>Thanh toán VietQR</div>
    <div class="lp-qr"><span class="q">${I.qr}</span><div><b>Quét là tiền về tài khoản bạn</b><span>Mỗi shop một cấu hình QR riêng — không ví trung gian</span></div></div>
    <div class="lp-credit"><span class="amt">+499.000đ</span><span class="src">Khớp đơn #1039 tự động</span><span class="tm">3 phút trước</span></div></div>`,
  guard: `<div class="lp-vis" aria-hidden="true"><div class="lp-vis-h"><i></i>Lá chắn đơn ảo</div>
    <div class="lp-row"><span class="n">Đơn COD quá 7 ngày không nhận</span><span class="lp-pill2 warn">Tự huỷ + nhả kho</span></div>
    <div class="lp-row"><span class="n">Cùng SĐT đặt dồn dập nhiều đơn</span><span class="lp-pill2 warn">Chặn vượt trần</span></div>
    <div class="lp-row"><span class="n">SĐT đặt bất thường nhiều nguồn</span><span class="lp-pill2 ship">Gắn cờ chờ duyệt</span></div>
    <div class="lp-row"><span class="n">Khách thật đặt hàng bình thường</span><span class="lp-pill2 done">Vào mượt</span></div></div>`,
  loyal: `<div class="lp-vis" aria-hidden="true"><div class="lp-vis-h"><i></i>Khách quen của shop</div>
    <div class="lp-row"><span class="n">Chị Lan — 5 đơn · lần cuối 3 ngày trước</span><span class="lp-pill2 done">Thân thiết</span></div>
    <div class="lp-pts"><span class="ic">${I.star}</span><div><b>860 điểm tích luỹ</b><span>Đổi được 86.000đ cho đơn sau</span></div></div>
    <div class="lp-coup"><span class="code">QUAYLAI15</span><span>Ưu đãi riêng gửi khách lâu chưa mua</span></div></div>`,
  safe: `<div class="lp-vis" aria-hidden="true"><div class="lp-vis-h"><i></i>Trực hệ thống 24/7</div>
    <div class="lp-row"><span class="n">Sao lưu mã hoá hằng ngày</span><span class="lp-pill2 done">Hoàn tất</span></div>
    <div class="lp-row"><span class="n">Chứng chỉ HTTPS mọi tên miền</span><span class="lp-pill2 done">Tự gia hạn</span></div>
    <div class="lp-row"><span class="n">Giám sát đường tiền webhook</span><span class="lp-pill2 done">Đang canh</span></div>
    <div class="lp-row"><span class="n">Xuất toàn bộ dữ liệu của bạn</span><span class="lp-pill2 new">Bất cứ lúc nào</span></div></div>`,
  promo: `<div class="lp-vis" aria-hidden="true"><div class="lp-vis-h"><i></i>Khuyến mãi đang chạy</div>
    <div class="lp-flash"><b>FLASH SALE −30%</b><span class="cd"><i>02</i><i>11</i><i>45</i></span></div>
    <div class="lp-coup"><span class="code">GIAM10</span><span>Giảm 10% cho đơn từ 500.000đ — hết hạn tự khoá</span></div>
    <div class="lp-pts"><span class="ic">${I.star}</span><div><b>+120 điểm thưởng</b><span>Khách quen tích luỹ, đổi giảm giá lần sau</span></div></div></div>`,
};

// ── CSS RIÊNG của trang chủ ─────────────────────────────────────────────────
const CSS = `
/* ══════════════════════════════════════════════════════════════════════════════
   TRANG CHỦ — hệ thiết kế riêng, phủ lên BASE_CSS.
   Xanh cobalt trên nền tối ở hero, sáng ở thân trang. Phông Be Vietnam Pro TỰ-HOST,
   chỉ có 400/600/800 nên KHÔNG dùng 500/700/900: khai một cân nặng không có file thì
   trình duyệt tự bóp chữ, và nó xấu theo kiểu rất khó chỉ tên.
   ══════════════════════════════════════════════════════════════════════════════ */
:root{
  --lp-blue:#0045FF; --lp-blue-h:#0038CC; --lp-blue-br:#2286FF;
  --lp-b100:#CDDAFF; --lp-b050:#EAF0FF; --lp-b025:#EFF4FF;
  --lp-ink:#141723; --lp-body:#2A2F3D; --lp-mut:#5A6172; --lp-mut2:#6C7280;
  --lp-line:#E5E7EB; --lp-soft:#EEF1F6; --lp-alt:#F5F6F8;
  --lp-navy:#0A1024; --lp-deep:#080B14;
  --lp-ok:#15803D; --lp-ok-bg:#E7F6ED;
  --lp-warn:#B45309; --lp-warn-bg:#FDF1DF;
  --lp-bad:#B91C1C; --lp-bad-bg:#FCEBEB;
  --lp-hero:radial-gradient(120% 95% at 62% 42%,#143E96 0%,#0B1A4A 46%,#080B14 100%);
  --lp-r:12px; --lp-r2:16px; --lp-r3:20px; --lp-r4:28px; --lp-pill:9999px;
  --lp-sh:0 4px 20px rgba(20,23,35,.08);
  --lp-sh2:0 12px 40px rgba(20,23,35,.10);
  --lp-t:240ms; --lp-e:cubic-bezier(.22,1,.36,1);
}
body{background:#fff;color:var(--lp-body);font-family:'Be Vietnam Pro',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;
     font-size:clamp(15.5px,.95rem + .1vw,17px);line-height:1.7;overflow-x:hidden}
main{display:block}
.ct{width:100%;max-width:1240px;margin-inline:auto;padding-inline:clamp(20px,4.4vw,56px)}
.lp h1,.lp h2,.lp h3,.lp h4{color:var(--lp-ink);text-wrap:balance;letter-spacing:-.015em;margin:0}
.lp p{margin:0;text-wrap:pretty}
.lp ul{margin:0;padding:0;list-style:none}
/* KHÔNG đặt màu cho thẻ a ở đây. Hai lần thử đều hỏng, mỗi lần một kiểu:
   .lp a{color:inherit} có độ ưu tiên (0,1,1), cao hơn mọi lớp nút (0,1,0) ⇒ chữ nút
   thừa hưởng màu khối cha, trên hero nền tối là chữ TRẮNG trên nút TRẮNG — nút rỗng.
   .lp a:not([class]) còn tệ hơn: :not([class]) tính như một bộ chọn thuộc tính nên
   thành (0,2,1), thắng cả .lp-nav a ⇒ mục điều hướng nhận màu chữ thân trang, tức
   gần như vô hình trên nền tối. Kết luận: MỌI thẻ a phải tự khai màu ở lớp của nó. */
.lp a{text-decoration:none}
/* Nút KHÔNG tự thừa hưởng phông của trang — đó là mặc định của trình duyệt chứ không
   phải lỗi hiếm gặp. Đo được: nút thẻ sản phẩm dựng bằng Arial 13,33px trong khi bản
   sao dựng bằng div thì đúng Be Vietnam Pro 16,64px, cao 211 so với 241 — hai bộ thẻ
   lệch nhau nên mối nối vòng lặp lộ ra, và quan trọng hơn là MỌI nút trên trang đang
   sai phông. Dùng bộ chọn phần tử TRẦN (độ ưu tiên 0,0,1) để mọi quy tắc lớp đều thắng
   được nó — đặt ở lớp cao hơn là lặp lại đúng cái bẫy đã cắn với thẻ a. */
button{font:inherit}
.lp :focus-visible{outline:3px solid rgba(0,69,255,.5);outline-offset:2px;border-radius:5px}
.lp-dark :focus-visible{outline-color:rgba(255,255,255,.8)}
.lp-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

.lp-eb{display:inline-flex;align-items:center;gap:10px;font-size:.8rem;font-weight:800;
       letter-spacing:.1em;text-transform:uppercase;color:var(--lp-blue)}
.lp-eb::before{content:'';width:22px;height:2px;background:currentColor;border-radius:2px}
.lp-h2{margin-top:12px;font-size:clamp(1.45rem,1.1rem + 1.5vw,2.4rem);font-weight:800;
       line-height:1.26;text-transform:uppercase;max-width:24ch}
.lp-h2 em{font-style:normal;color:var(--lp-blue)}
.lp-sub{margin-top:14px;font-size:clamp(.95rem,.92rem + .15vw,1.05rem);line-height:1.62;color:var(--lp-mut);max-width:56ch}
.lp-sec{padding:60px 0}
@media(min-width:1024px){.lp-sec{padding:88px 0}}
/* Khối tiêu đề mục là MỘT đơn vị nhịp: cùng khoảng cách tới nội dung bên dưới ở mọi mục.
   Từ 1024px trở lên nó chia HAI CỘT — tiêu đề trái, câu dẫn phải — để khối tiêu đề trải
   đúng bề rộng của nội dung bên dưới nó. Xếp một cột thì trên màn 1440px tiêu đề chỉ chiếm
   nửa trái còn nửa phải bỏ trống, trong khi bảng ngay dưới lại trải hết: đó chính là cảm
   giác "lệch tỉ lệ", và nó lặp ở mọi mục nên phải sửa ở đây, không sửa từng chỗ. */
.lp-head{margin-bottom:32px}
/* Biến thể CĂN GIỮA: cho mục chỉ có tiêu đề, không có câu dẫn. Phải huỷ luôn lưới hai
   cột ở mốc 1024px bên dưới, nếu không tiêu đề vẫn bị ghim vào cột trái. */
/* Biến thể căn giữa: mọi khối con phải tự canh giữa. text-align:center chỉ canh CHỮ bên
   trong khối, còn bản thân khối vẫn dính mép trái vì nó có max-width — đó là lý do câu dẫn
   nằm lệch hẳn sang trái dưới một tiêu đề đã căn giữa. Và bỏ gạch đầu dòng của nhãn: gạch
   nằm bên trái một nhãn căn giữa thì trông như thừa ra một nét. */
.lp-head-mid{text-align:center}
.lp-head-mid .lp-eb{justify-content:center}
.lp-head-mid .lp-eb::before{display:none}
.lp-head-mid .lp-sub{margin-inline:auto}
/* Tiêu đề mục căn giữa lấy MỘT màu xanh cho cả khối, không tô hai tông như tiêu đề căn
   trái: căn giữa mà đổi màu giữa chừng thì mắt đọc thành hai câu rời. */
.lp-head-mid .lp-h2{margin-inline:auto;max-width:22ch;color:var(--lp-blue)}
.lp-head-mid .lp-h2 em{color:inherit}
@media(min-width:1024px){
  .lp-head{margin-bottom:48px;display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);
           column-gap:56px;align-items:end}
  .lp-head-mid{display:block}
  .lp-head-mid .lp-h2{max-width:26ch}
  .lp-head .lp-eb{grid-column:1;grid-row:1}
  .lp-head .lp-h2{grid-column:1;grid-row:2;max-width:20ch}
  .lp-head .lp-sub{grid-column:2;grid-row:2;margin-top:0;max-width:44ch;padding-bottom:5px}
}

/* ── Nút ─────────────────────────────────────────────────────────────────── */
.lp-btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;height:48px;
        padding:0 24px;border-radius:var(--lp-pill);font-weight:600;font-size:1rem;
        white-space:nowrap;flex:none;
        transition:background var(--lp-t),color var(--lp-t),transform 140ms var(--lp-e)}
.lp-btn svg{width:18px;height:18px;flex:none}
.lp-b-pri{background:var(--lp-blue);color:#fff}
.lp-b-pri:hover{background:var(--lp-blue-h)}
.lp-b-gh{border:1px solid var(--lp-line);color:var(--lp-ink);background:#fff}
.lp-b-gh:hover{border-color:var(--lp-blue);color:var(--lp-blue)}
.lp-dark .lp-b-gh{border-color:rgba(255,255,255,.3);color:#fff;background:transparent}
.lp-dark .lp-b-gh:hover{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.5)}

/* Nút pill trắng có núm xanh — chữ ký thị giác của trang */
.lp-knob{height:56px;background:#fff;color:var(--lp-navy);font-weight:800;font-size:1.05rem;
         padding:6px 6px 6px 26px;gap:18px;box-shadow:var(--lp-sh2)}
.lp-knob:hover{background:#fff;transform:translateY(-1px)}
.lp-knob i{display:grid;place-items:center;width:44px;height:44px;border-radius:var(--lp-pill);
           background:var(--lp-blue);color:#fff;flex:none;transition:transform 140ms var(--lp-e)}
.lp-knob:hover i{transform:translateX(3px)}

/* ── HEADER thanh nổi ────────────────────────────────────────────────────── */
.lp-hdr{position:fixed;inset:12px 0 auto;z-index:60;transition:transform 300ms var(--lp-e)}
.lp-hdr.hide{transform:translateY(calc(-100% - 16px))}
.lp-pill{display:flex;align-items:center;gap:14px;height:62px;padding:0 10px 0 20px;
         border-radius:var(--lp-pill);background:rgba(11,16,36,.55);
         border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(14px);
         transition:background var(--lp-t),border-color var(--lp-t),box-shadow var(--lp-t)}
.lp-hdr.solid .lp-pill{background:#fff;border-color:var(--lp-line);box-shadow:var(--lp-sh)}
.lp-brand{display:flex;align-items:center;gap:9px;flex:none;white-space:nowrap;
          font-weight:800;font-size:1.05rem;color:#fff;letter-spacing:-.02em}
.lp-hdr.solid .lp-brand{color:var(--lp-ink)}
.lp-brand .mk{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:var(--lp-blue);color:#fff}
.lp-brand .mk svg{width:17px;height:17px}
.lp-nav{display:none}
@media(min-width:1180px){
  .lp-nav{display:flex;gap:4px;margin-inline:auto}
  .lp-nav a{padding:9px 13px;border-radius:var(--lp-pill);font-size:.93rem;font-weight:600;
            white-space:nowrap;color:rgba(255,255,255,.82);
            transition:background var(--lp-t),color var(--lp-t)}
  .lp-nav a:hover{background:rgba(255,255,255,.12);color:#fff}
  .lp-hdr.solid .lp-nav a{color:var(--lp-mut)}
  .lp-hdr.solid .lp-nav a:hover{background:var(--lp-b025);color:var(--lp-blue)}
}
.lp-hdr-act{display:flex;align-items:center;gap:8px;margin-left:auto}
@media(min-width:1180px){.lp-hdr-act{margin-left:0}}
.lp-login{display:none}
@media(min-width:720px){
  .lp-login{display:inline-flex;align-items:center;gap:7px;font-size:.92rem;font-weight:600;
            padding:0 10px;white-space:nowrap;color:rgba(255,255,255,.82)}
  .lp-login svg{width:17px;height:17px}
  .lp-hdr.solid .lp-login{color:var(--lp-mut)}
}
/* Dưới 480px, viên thuốc không đủ chỗ cho thương hiệu + nút + nút menu: đo được nút
   menu bị CẮT CỤT ở mép phải. Không phát hiện được bằng scrollWidth vì body có
   overflow-x:hidden — tràn bị biến thành cắt, trang không cuộn ngang nên mọi phép đo
   tràn đều báo ĐẠT. Bỏ nút ở cỡ này; ngăn kéo vẫn mang nó ở vị trí nổi bật, và thanh
   CTA nổi cũng phủ vai trò đó. */
.lp-hdr .lp-btn{display:none}
@media(min-width:480px){.lp-hdr .lp-btn{display:inline-flex;height:44px;padding:0 18px;font-size:.92rem}}
.lp-burger{display:grid;place-items:center;width:44px;height:44px;border-radius:var(--lp-pill);
           border:1px solid rgba(255,255,255,.24);color:#fff;background:none;cursor:pointer}
.lp-hdr.solid .lp-burger{border-color:var(--lp-line);color:var(--lp-ink)}
@media(min-width:1180px){.lp-burger{display:none}}

.lp-scrim{position:fixed;inset:0;z-index:70;background:rgba(8,11,20,.6);opacity:0;
          transition:opacity var(--lp-t)}
.lp-scrim.on{opacity:1}
.lp-drawer{position:fixed;inset:0 0 0 auto;z-index:71;width:min(86vw,340px);background:#fff;
           padding:24px 20px calc(24px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:6px;
           transform:translateX(100%);transition:transform 280ms var(--lp-e);overflow-y:auto}
.lp-drawer.on{transform:none}
/* Khai display cho .lp-drawer/.lp-scrim ĐÈ MẤT display:none của thuộc tính hidden — ngăn
   kéo đang đóng vẫn nằm trong bố cục, chỉ trượt ra ngoài mép bằng transform. Hậu quả: bấm
   Tab từ trang là đi thẳng vào một menu KHÔNG NHÌN THẤY. Phải trả lại display:none. */
.lp-drawer[hidden],.lp-scrim[hidden]{display:none}
.lp-drawer .x{align-self:flex-end;width:44px;height:44px;border-radius:var(--lp-pill);display:grid;
              place-items:center;border:1px solid var(--lp-line);background:none;cursor:pointer;margin-bottom:8px}
.lp-drawer a:not(.lp-btn){padding:13px 12px;border-radius:var(--lp-r);font-weight:600;color:var(--lp-ink)}
.lp-drawer a:not(.lp-btn):hover{background:var(--lp-b025);color:var(--lp-blue)}
.lp-drawer .lp-btn{margin-top:14px;width:100%}

/* ── HERO ────────────────────────────────────────────────────────────────── */
/* HERO PHẢI GỌN TRONG MỘT KHUNG HÌNH — kể cả khung thấp. Bản trước đặt padding trên
   150px rồi canh giữa, nên trên màn cao ~790px (laptop 1080 ở 125%) phần khung thiết bị
   và cả cụm điều khiển băng đều rơi xuống dưới mép: người xem phải cuộn mới thấy hết
   một khối lẽ ra là "ảnh bìa". Nay dựng theo chiều dọc: nội dung canh giữa phần còn
   lại, cụm điều khiển bị đẩy xuống đáy bằng margin-top:auto, và khung thiết bị có trần
   theo chiều cao khung nhìn nên nó co lại thay vì đẩy mọi thứ ra ngoài. */
.lp-hero{position:relative;background:var(--lp-hero);color:#fff;overflow:hidden;
         padding:96px 0 22px;min-height:100svh;display:flex}
.lp-hero > .ct{display:flex;flex-direction:column;justify-content:center;width:100%}
@media(min-width:1024px){.lp-hero{padding:104px 0 26px}}
.lp-hero-g{display:grid;gap:36px}
@media(min-width:1024px){.lp-hero-g{grid-template-columns:minmax(0,1fr) minmax(0,1.02fr);gap:56px;align-items:center}}
.lp-slide{display:none}
.lp-slide.on{display:block}
@media(prefers-reduced-motion:no-preference){.lp-slide.on{animation:lp-in 420ms var(--lp-e) both}}
@keyframes lp-in{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
/* KHÔNG viết hoa: ở cỡ này dấu tiếng Việt (ồ, ế, ữ) chạm vào chân dòng trên, đo được
   trên chính ảnh chụp. Chữ thường cỡ lớn cũng là kiểu chữ sang hơn. */
.lp-hero h1,.lp-hero h2{font-size:clamp(1.9rem,1.2rem + 2.6vw,3.35rem);font-weight:800;line-height:1.16;
            letter-spacing:-.025em;color:#fff;max-width:17ch}
.lp-hero .lead{margin-top:20px;font-size:clamp(1rem,.94rem + .3vw,1.14rem);line-height:1.6;
               color:rgba(255,255,255,.76);max-width:50ch}
.lp-hero .lp-knob{margin-top:26px;width:100%}
@media(min-width:600px){.lp-hero .lp-knob{width:auto;max-width:360px}}
.lp-trust{display:flex;flex-wrap:wrap;gap:9px 22px;margin-top:24px}
.lp-trust span{display:inline-flex;align-items:center;gap:7px;font-size:.88rem;color:rgba(255,255,255,.72)}
.lp-trust svg{width:16px;height:16px;color:#7FE0A5;flex:none}

/* Khung thiết bị dựng bằng CSS — không phụ thuộc ảnh ngoài, không vỡ khi thiếu file */
.lp-stage{position:relative;margin-inline:auto;width:100%;max-width:560px}
/* Trần theo chiều cao khung nhìn: khung thiết bị co lại trên màn thấp thay vì đẩy cụm
   điều khiển ra ngoài mép dưới. Nội dung bên trong tự thu theo, không bị cắt. */
@media(min-width:1024px){.lp-stage{max-width:none;max-height:min(50svh,470px)}}
/* Khung nhìn THẤP (laptop 1080 ở 125%, cửa sổ không toàn màn hình): siết thêm nhịp dọc
   thay vì để hero tràn 20–40px — tràn ít cũng vẫn là phải cuộn mới thấy hết ảnh bìa. */
@media(max-height:780px){
  .lp-hero{padding-top:88px}
  .lp-hero .lead{margin-top:16px}
  .lp-hero .lp-knob{margin-top:20px}
  .lp-trust{margin-top:18px}
  .lp-ctl{padding-top:20px}
}
/* MOBILE: xếp dọc nên không thể vừa một khung nếu khung thiết bị giữ nguyên cỡ. Cho nó
   HÉ ra: cắt bớt phần dưới và làm mờ dần ở mép, vừa đủ để hiểu đây là màn quản trị mà
   không đẩy nút và cụm điều khiển xuống dưới mép. Cắt CÓ CHỦ Ý, khác hẳn cắt vì tràn:
   phần bị che không mang thông tin nào mà chỗ khác trên trang chưa nói. */
@media(max-width:1023px){
  .lp-hero h1,.lp-hero h2{font-size:clamp(1.72rem,1.05rem + 2.6vw,2.4rem)}
  .lp-hero .lead{font-size:.98rem;line-height:1.55;max-width:44ch}
  /* Ba dòng tin cậy chiếm gần 90px trên điện thoại. Giữ hai dòng đắt nhất; dòng thứ ba
     ("không giữ tiền") được nói lại đầy đủ ở mục Giải pháp nên không mất thông tin. */
  .lp-trust span:nth-child(3){display:none}
  .lp-stage{max-height:min(24svh,210px);overflow:hidden;
            -webkit-mask-image:linear-gradient(180deg,#000 62%,transparent 100%);
            mask-image:linear-gradient(180deg,#000 62%,transparent 100%)}
  .lp-hero{padding:80px 0 16px}
  .lp-hero-g{gap:18px}
  .lp-hero .lead{margin-top:16px}
  .lp-hero .lp-knob{margin-top:22px}
  .lp-trust{margin-top:18px;gap:7px 18px;font-size:.9rem}
  .lp-ctl{padding-top:18px;gap:12px}
}
/* Điện thoại MÀN THẤP (360×740 và tương đương): còn hụt ~67px sau các mức trên. Thu khung
   thiết bị xuống mức chỉ còn thẻ doanh thu — vẫn nhận ra là màn quản trị, và đó là thứ
   duy nhất trong khối này chịu co được mà không mất chữ. */
@media(max-width:1023px) and (max-height:780px){
  .lp-hero{padding:74px 0 10px}
  .lp-stage{max-height:min(18svh,140px)}
  .lp-ctl{padding-top:14px}
  .lp-hero .lead{margin-top:14px}
  .lp-hero .lp-knob{margin-top:18px;height:52px}
  .lp-trust{margin-top:14px}
  .lp-hero-g{gap:14px}
}
.lp-lap{border-radius:14px;background:#0E1526;border:1px solid rgba(255,255,255,.14);
        box-shadow:0 30px 80px -40px rgba(0,0,0,.9);overflow:hidden;
        display:flex;flex-direction:column;max-height:100%}
.lp-lap .bar{display:flex;align-items:center;gap:6px;padding:10px 14px;background:rgba(255,255,255,.05);
             border-bottom:1px solid rgba(255,255,255,.08)}
.lp-lap .bar i{width:9px;height:9px;border-radius:50%;background:rgba(255,255,255,.22)}
.lp-lap .bar .u{margin-left:8px;flex:1;height:22px;border-radius:6px;background:rgba(255,255,255,.07);
                display:flex;align-items:center;padding:0 10px;font-size:.7rem;color:rgba(255,255,255,.5)}
.lp-lap .scr{padding:16px;min-height:0;overflow:hidden}
.lp-shot{display:block;width:100%;height:auto}
.lp-float{position:absolute;display:flex;align-items:center;gap:10px;padding:11px 14px;border-radius:14px;
          background:#fff;color:var(--lp-ink);box-shadow:var(--lp-sh2);max-width:74%}
.lp-float .ic{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;flex:none}
.lp-float b{display:block;font-size:.88rem;font-weight:800;line-height:1.3}
.lp-float span{font-size:.76rem;color:var(--lp-mut2)}
.lp-f-pay{right:-6px;bottom:-16px}
.lp-f-pay .ic{background:var(--lp-ok-bg);color:var(--lp-ok)}
.lp-f-noti{left:-6px;top:-18px}
.lp-f-noti .ic{background:var(--lp-b050);color:var(--lp-blue)}
@media(min-width:600px){.lp-f-pay{right:-18px}.lp-f-noti{left:-18px}}
/* Hai thẻ nổi là trang trí. Trên khung thiết bị đã thu nhỏ và làm mờ mép ở màn hẹp,
   chúng bị cắt ngang và đè lên nhau — thêm rối chứ không thêm thông tin.
   Quy tắc này PHẢI nằm SAU khai .lp-float{display:flex} ở trên: cùng độ ưu tiên (0,1,0)
   thì cái viết sau mới thắng. Bản trước đặt nó trong khối màn-hẹp ở phía trên và nó bị
   đè im lặng — ảnh chụp vẫn thấy hai thẻ, trong khi đọc CSS thì tưởng đã ẩn. */
@media(max-width:1023px){.lp-float{display:none}}

.lp-ctl{display:flex;flex-direction:column;align-items:center;gap:16px;margin-top:auto;padding-top:26px}
html:not(.lpjs) .lp-ctl{display:none}
@media(min-width:1024px){.lp-ctl{flex-direction:row;justify-content:space-between;align-items:center;padding-top:30px}}
.lp-count{font-weight:600;font-size:1.15rem;color:rgba(255,255,255,.5);font-variant-numeric:tabular-nums}
.lp-count b{font-size:1.75rem;font-weight:800;color:#fff}
.lp-ctl-r{display:flex;align-items:center;gap:18px}
.lp-dots{display:flex;gap:8px;align-items:center}
.lp-dots button{width:7px;height:7px;padding:0;border:0;border-radius:var(--lp-pill);background:#fff;opacity:.32;
                cursor:pointer;transition:width var(--lp-t) var(--lp-e),opacity var(--lp-t)}
.lp-dots button[aria-current="true"]{width:26px;opacity:1}
.lp-arr{display:none}
@media(min-width:720px){
  .lp-arr{display:flex;gap:10px}
  .lp-arr button{width:50px;height:50px;border-radius:var(--lp-pill);display:grid;place-items:center;
                 border:1px solid rgba(255,255,255,.26);color:#fff;background:none;cursor:pointer;
                 transition:background var(--lp-t)}
  .lp-arr button:hover{background:rgba(255,255,255,.12)}
}
.lp-pause{display:grid;place-items:center;width:42px;height:42px;border-radius:var(--lp-pill);
          border:1px solid rgba(255,255,255,.26);color:#fff;background:none;cursor:pointer}
.lp-pause:hover{background:rgba(255,255,255,.12)}

/* ── BẢNG SO SÁNH ────────────────────────────────────────────────────────────
   Bảng THẬT: đọc màn hình cần quan hệ hàng↔cột. Dưới 900px hoá THẺ bằng CSS thuần
   (data-label + ::before) — không cần JS mới đọc được nhãn cột. ── */
.lp-cmp{background:#fff;background-image:radial-gradient(76% 50% at 50% -6%,var(--lp-b025) 0%,transparent 66%)}
.lp-cmp-img{margin:0 0 32px}
.lp-cmp-img img{display:block;width:100%;max-width:1100px;height:auto;margin-inline:auto;
                border-radius:var(--lp-r3)}
@media(min-width:1024px){.lp-cmp-img{margin-bottom:48px}}
/* KHI CÓ ẢNH (lớp co-anh) — hai bề mặt, hai vai trò, không chỗ nào mất dữ liệu:
   · Màn rộng: ảnh thay bảng. Bảng HTML lui về dạng CHỈ-ĐỌC-MÀN-HÌNH chứ KHÔNG display:none
     — display:none thì mất khỏi cả cây trợ năng lẫn thứ Google đọc được, tức đổi một bảng
     so sánh 8 tiêu chí lấy một tấm ảnh không có chữ nào.
   · Màn hẹp: bảng hiện dạng thẻ như cũ, ảnh ẩn hẳn — một tấm chụp bảng bốn cột thu xuống
     360px thì không ai đọc nổi, phóng to cũng không.
   Hai quy tắc này PHẢI nằm sau phần khai .lp-cmp-img ở trên: cùng độ ưu tiên thì cái viết
   sau mới thắng, @media không cộng thêm gì. */
@media(min-width:900px){
  .lp-cmp.co-anh .lp-cmp-w{position:absolute;width:1px;height:1px;padding:0;margin:-1px;
                           overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
}
@media(max-width:899px){.lp-cmp-img{display:none}}
.lp-cmp-w{margin-top:0}
@media(min-width:900px){.lp-cmp-w{overflow-x:auto;padding-top:14px}}
.lp-tbl{width:100%;border-collapse:separate;border-spacing:0}
@media(min-width:900px){.lp-tbl{min-width:840px}}
.lp-tbl thead th{padding:16px 18px 13px;text-align:left;vertical-align:bottom;font-size:.92rem;
                 font-weight:600;line-height:1.4;color:var(--lp-mut)}
.lp-tbl thead th.crit{width:18%;color:var(--lp-mut2);font-weight:400}
.lp-tbl tbody th{padding:15px 18px 15px 0;text-align:left;vertical-align:top;font-size:.96rem;
                 font-weight:800;line-height:1.4;color:var(--lp-ink)}
.lp-tbl tbody td{padding:15px 18px;vertical-align:top;font-size:.9rem;line-height:1.55;color:var(--lp-body)}
.lp-tbl tbody th,.lp-tbl tbody td{border-bottom:1px solid var(--lp-soft)}
.lp-tbl tbody tr:last-child th,.lp-tbl tbody tr:last-child td{border-bottom:0}
/* Đường kẻ hàng phải chạy qua CẢ cột nổi bật, nếu không bảng gãy làm hai mảnh: bên trái
   có kẻ, giữa thì không, trông như thẻ dán đè lên bảng chứ không phải một cột của bảng. */
.lp-tbl tbody td.us{border-bottom-color:var(--lp-b100)}
/* Cột "chúng tôi" nổi lên như một thẻ chạy dọc bảng: bo góc ở ô đầu/cuối, viền trái–phải
   lặp trên MỌI ô — cách duy nhất giữ liền mạch khi border-collapse:separate. */
.lp-tbl .us{background:var(--lp-b025);border-left:1px solid var(--lp-b100);border-right:1px solid var(--lp-b100)}
.lp-tbl thead th.us{background:var(--lp-b050);border-top:1px solid var(--lp-b100);
                    border-radius:var(--lp-r2) var(--lp-r2) 0 0;padding-top:20px;color:var(--lp-ink);
                    font-size:1.08rem;font-weight:800}
.lp-tbl tbody tr:last-child td.us{border-bottom:1px solid var(--lp-b100);border-radius:0 0 var(--lp-r2) var(--lp-r2)}
.lp-tbl tbody tr:hover td:not(.us){background:var(--lp-alt)}
.lp-badge{display:inline-block;margin-left:9px;padding:3px 9px;border-radius:var(--lp-pill);
          background:var(--lp-blue);color:#fff;font-size:.68rem;font-weight:800;letter-spacing:.06em;
          text-transform:uppercase;vertical-align:middle}
.lp-cell{display:flex;align-items:flex-start;gap:10px}
.lp-mk{flex:none;display:grid;place-items:center;width:21px;height:21px;margin-top:2px;border-radius:var(--lp-pill)}
.lp-mk svg{width:12px;height:12px}
.lp-mk.ok{background:var(--lp-ok-bg);color:var(--lp-ok)}
.lp-mk.mid{background:var(--lp-warn-bg);color:var(--lp-warn)}
.lp-mk.no{background:var(--lp-bad-bg);color:var(--lp-bad)}
.lp-note{margin-top:22px;font-size:.82rem;line-height:1.6;color:var(--lp-mut2);max-width:74ch}
@media(max-width:899px){
  .lp-tbl{min-width:0}
  .lp-tbl,.lp-tbl tbody,.lp-tbl tr{display:block}
  .lp-tbl thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  .lp-tbl tr{background:#fff;border:1px solid var(--lp-line);border-radius:var(--lp-r2);padding:14px;box-shadow:var(--lp-sh)}
  .lp-tbl tr + tr{margin-top:12px}
  .lp-tbl tbody th{display:block;padding:0 0 10px;font-size:1rem;line-height:1.35;border-bottom:1px solid var(--lp-soft)}
  .lp-tbl tbody td{display:grid;grid-template-columns:76px minmax(0,1fr);gap:9px;align-items:start;
                   padding:9px 0;font-size:.9rem;line-height:1.55}
  .lp-tbl tbody td::before{content:attr(data-label);font-size:.68rem;font-weight:800;line-height:1.45;
                           padding-top:3px;text-transform:uppercase;letter-spacing:.05em;color:var(--lp-mut2)}
  .lp-tbl tbody tr td.us{background:var(--lp-b025);border:1px solid var(--lp-b100);border-radius:var(--lp-r);
                         padding:10px 11px;margin:10px 0 3px}
  .lp-tbl tbody tr td.us::before{color:var(--lp-blue)}
  .lp-tbl tbody tr:last-child td{border-bottom:1px solid var(--lp-soft)}
  .lp-tbl tbody td:last-child{border-bottom:0 !important;padding-bottom:0}
}

/* ── KHỐI SẢN PHẨM — nút bên trái, khe hình + nội dung bên phải ───────────────
   Bản trước dùng cột phải DÁN DÍNH đổi theo cuộn: đo ra thì đúng 5/5, nhưng nhìn thì
   mỗi màn hình một khoảng trống lớn và hai cột không bao giờ ngang hàng. Nay là bộ TAB:
   nút bên trái, khung bên phải, tự chạy lần lượt.

   CỔNG AN TOÀN: quy tắc ẩn panel nằm sau html.lpjs — cờ do chính JS gắn. Không JS thì
   MỌI panel hiện đủ (xếp dọc dưới danh sách nút), nên không mất một chữ nào. ── */
.lp-prod{background:var(--lp-alt)}
.lp-showcase{display:grid;gap:20px}
@media(min-width:1024px){
  /* Tỉ lệ 5:7 — cột nút đủ rộng cho hai dòng mô tả mà không nuốt chỗ của khung xem. */
  /* stretch + space-between: cột nút CAO BẰNG cột khung xem, khoảng cách giữa các nút
     tự dãn cho vừa. Để align-items:start thì cột trái hụt ~150px so với cột phải và
     dưới cùng bên trái trống một mảng — đúng thứ nhìn ra ngay là lệch tỉ lệ. */
  .lp-showcase{grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:24px;align-items:stretch}
  /* THANG MÁY: khung cắt cố định chiều cao (JS đặt bằng đúng chiều cao cột phải), ray bên
     trong TRƯỢT để nút đang mở về giữa khung. Nút trên/dưới ló ra rồi mờ dần ở hai mép —
     đó là thứ cho biết danh sách còn tiếp, thay vì một cột đứng im.
     Chiều cao do JS đặt: nếu để CSS đoán một con số thì hai cột lại lệch nhau ngay khi
     nội dung mục đổi. Không JS ⇒ không cắt, không trượt, năm nút hiện đủ (xem dưới). */
  /* Ray đặt TUYỆT ĐỐI trong khung cắt. Đây là mấu chốt: để ray nằm trong dòng chảy thì
     chính nó kéo chiều cao hàng lưới lên bằng chiều cao của cả năm nút, khung cắt cao
     đúng bằng nội dung, phần tràn bằng 0 — và thang máy đứng im. Ra khỏi dòng chảy thì
     chiều cao hàng do MỘT MÌNH cột phải quyết, khung cắt nhận đúng chiều cao đó qua
     align-items:stretch, và phần tràn mới có thật để mà trượt. */
  html.lpjs .lp-tabs{position:relative;overflow:hidden;
    -webkit-mask-image:linear-gradient(180deg,transparent 0,#000 9%,#000 91%,transparent 100%);
    mask-image:linear-gradient(180deg,transparent 0,#000 9%,#000 91%,transparent 100%)}
  /* THANG MÁY CUỘN LIÊN TỤC. Bản trước nhảy từng nấc và đo ra thế này: ray đứng ở
     0px, 0px, −154px, −329px, −295px cho năm mục — mục 1 và 2 CÙNG một chỗ, mục 4 và 5
     CÙNG một chỗ, tức 2/4 nhịp ray không hề nhúc nhích. Nhìn vào thì đúng là "đứng im".
     Nay ray chạy đều, không nghỉ: hai bộ thẻ giống hệt nhau xếp nối đuôi, ray trôi tới
     -50% rồi lặp — đúng chỗ bộ thứ hai trùng khít vị trí bộ thứ nhất, nên mắt không
     thấy mối nối. Thẻ nào trôi qua giữa khung thì thẻ đó sáng lên và khung bên phải đổi
     theo. Tốc độ do JS đặt theo chiều cao thật của một bộ, để thêm bớt mục không làm
     băng chạy nhanh hay chậm đi. */
  html.lpjs .lp-track{position:absolute;inset:0 0 auto 0;will-change:transform}
  @media(prefers-reduced-motion:no-preference){
    html.lpjs .lp-track{animation:lp-thang var(--lp-tg,28s) linear infinite}
  }
  /* Quãng đường một vòng KHÔNG dùng -50%. Đo được: ray cao 2291px nên nửa ray là 1146px,
     trong khi một bộ thẻ chỉ cao 1079px — lề dưới của thẻ cuối mỗi bộ bị thu ra ngoài
     chiều cao bộ, nên hai con số lệch 67px và mỗi vòng lặp giật đúng ngần ấy. Nay JS đo
     KHOẢNG CÁCH THẬT giữa đỉnh bộ một và đỉnh bộ hai rồi truyền vào --lp-dy: đó đúng bằng
     chu kỳ lặp, nên mối nối trùng khít bất kể lề co giãn thế nào. */
  @keyframes lp-thang{from{transform:translateY(0)}to{transform:translateY(var(--lp-dy,-1000px))}}
  /* Dừng khi trỏ vào cột nút hoặc khi có tiêu điểm bàn phím trong khối — khai bằng CSS
     nên không cần một handler nào, và không có trạng thái JS nào để trôi lệch. */
  html.lpjs .lp-tabs:hover .lp-track,
  html.lpjs .lp-showcase:focus-within .lp-track{animation-play-state:paused}
  html.lpjs .lp-showcase.ngu .lp-track{animation-play-state:paused}
  html.lpjs .lp-tab.bong{cursor:pointer}
  /* KHÔNG làm mờ nút chưa mở: chữ mờ 50% thì đọc mệt và trông như bị vô hiệu hoá. Phân
     biệt bằng thứ khác đã đủ rõ — nút đang mở nổi lên có bóng, ô biểu tượng xanh đặc,
     tên mục màu xanh; nút chưa mở phẳng, ô biểu tượng nhạt, tên mục màu chữ phụ. */
  html.lpjs .lp-tab{transition:border-color var(--lp-t),box-shadow var(--lp-t),transform 160ms var(--lp-e)}
}
.lp-tabs{min-width:0}
/* Khoảng cách bằng margin-bottom trên TỪNG nút, không bằng gap của lưới. Lý do là phép
   toán vòng lặp: ray chứa HAI bộ giống hệt nhau và chạy tới -50%, nên nửa ray phải bằng
   ĐÚNG một bộ KỂ CẢ khoảng cách đuôi. Dùng gap thì 10 thẻ chỉ có 9 khoảng, nửa ray hụt
   mất một khoảng và mỗi vòng lệch 12px — chạy vài vòng là thấy giật ở mối nối. */
.lp-tab{margin-bottom:12px}
/* Bản BÓNG chỉ có nghĩa khi thang máy đang chạy. Không JS thì không có băng; dưới
   1024px thì thang máy tắt và cột nút xếp dọc trên cột phải — để bản bóng ở đó là người
   dùng thấy đủ năm mục HAI LẦN. Đo được đúng vậy: 10 nút ở khung 390px. */
html:not(.lpjs) .lp-set + .lp-set{display:none}
@media(max-width:1023px){.lp-set + .lp-set{display:none}}

.lp-tab{display:flex;gap:16px;align-items:flex-start;width:100%;padding:20px;text-align:left;
        border:1px solid var(--lp-line);border-radius:var(--lp-r3);background:#fff;cursor:pointer;
        transition:border-color var(--lp-t),box-shadow var(--lp-t),transform 160ms var(--lp-e)}
.lp-tab:hover{border-color:var(--lp-b100)}
.lp-tab.on{border-color:transparent;box-shadow:var(--lp-sh2);transform:translateX(4px)}
.lp-tab .ic{flex:none;display:grid;place-items:center;width:52px;height:52px;border-radius:var(--lp-r2);
            background:var(--lp-b025);color:var(--lp-blue);transition:background var(--lp-t),color var(--lp-t)}
.lp-tab .ic svg{width:24px;height:24px}
.lp-tab.on .ic{background:var(--lp-blue);color:#fff}
.lp-tab .tx{display:block;min-width:0}
.lp-tab .t{display:block;font-size:1.05rem;font-weight:800;letter-spacing:.02em;text-transform:uppercase;
           color:var(--lp-mut);transition:color var(--lp-t)}
.lp-tab.on .t{color:var(--lp-blue)}
.lp-tab .h{display:block;margin-top:5px;font-size:.98rem;font-weight:600;line-height:1.4;color:var(--lp-ink)}
.lp-tab .b{display:block;margin-top:10px}
.lp-tab .b span{display:block;position:relative;padding-left:15px;font-size:.88rem;line-height:1.5;
                color:var(--lp-mut2);transition:color var(--lp-t)}
.lp-tab.on .b span{color:var(--lp-mut)}
.lp-tab .b span + span{margin-top:3px}
.lp-tab .b span::before{content:'';position:absolute;left:2px;top:.62em;width:5px;height:5px;
                        border-radius:50%;background:var(--lp-b100)}

.lp-panes{position:relative;min-width:0;display:grid;gap:16px}
.lp-panel{min-width:0;border-radius:var(--lp-r4);background:var(--lp-navy);color:#fff;overflow:hidden;
          box-shadow:var(--lp-sh2)}
html.lpjs .lp-panel:not(.on){display:none}
@media(prefers-reduced-motion:no-preference){
  html.lpjs .lp-panel.on{animation:lp-pan 380ms var(--lp-e) both}
}
@keyframes lp-pan{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}

/* Khe hình: TỈ LỆ CỐ ĐỊNH nên đổi mục không làm khung nhảy chiều cao — ảnh của chủ dự án
   và khung minh hoạ CSS dùng chung một khung, muốn thay ảnh không phải sửa gì thêm. */
.lp-pv{position:relative;aspect-ratio:16/10;background:linear-gradient(160deg,#12203f,#0A1024);
       display:grid;place-items:center;padding:22px;overflow:hidden}
.lp-pv-img{width:100%;height:100%;object-fit:cover;object-position:top center;border-radius:var(--lp-r2)}
.lp-pv-mock{width:100%;max-width:460px}
.lp-pv-mock .lp-vis{box-shadow:0 24px 60px -34px rgba(0,0,0,.85)}

.lp-pd{padding:24px 24px 28px}
@media(min-width:768px){.lp-pd{padding:28px 32px 32px}}
.lp-pd .k{font-size:.78rem;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:var(--lp-blue-br)}
.lp-pd h3{margin-top:9px;font-size:clamp(1.2rem,1rem + 1vw,1.65rem);font-weight:800;line-height:1.28;color:#fff}
.lp-pd .d{margin-top:11px;font-size:.97rem;line-height:1.62;color:rgba(255,255,255,.72);max-width:58ch}
.lp-pd ul{display:grid;gap:9px;margin-top:18px}
.lp-pd li{display:flex;gap:11px;align-items:flex-start;font-size:.93rem;line-height:1.55;color:rgba(255,255,255,.8)}
.lp-pd li svg{flex:none;width:17px;height:17px;margin-top:3px;color:#7FE0A5}

.lp-pnav{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 4px}
html:not(.lpjs) .lp-pnav{display:none}
.lp-pcount{font-size:1rem;font-weight:600;color:var(--lp-mut2);font-variant-numeric:tabular-nums}
.lp-pcount b{font-size:1.5rem;font-weight:800;color:var(--lp-ink)}
.lp-pdots{display:flex;gap:7px}
.lp-pdots span{width:7px;height:7px;border-radius:var(--lp-pill);background:var(--lp-b100);
               transition:width var(--lp-t) var(--lp-e),background var(--lp-t)}
.lp-pdots span.on{width:24px;background:var(--lp-blue)}

/* ── Khung minh hoạ dùng chung (sản phẩm + giải pháp) ────────────────────── */
.lp-vis{border:1px solid var(--lp-line);border-radius:var(--lp-r3);background:#fff;
        box-shadow:var(--lp-sh2);padding:18px;min-width:0}
.lp-dark .lp-vis{background:#0E1526;border-color:rgba(255,255,255,.12);box-shadow:none}
.lp-vis-h{display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:.72rem;font-weight:800;
          letter-spacing:.06em;text-transform:uppercase;color:var(--lp-mut2)}
.lp-vis-h i{width:8px;height:8px;border-radius:50%;background:var(--lp-ok);flex:none}
.lp-row{display:flex;align-items:center;gap:11px;padding:10px 12px;margin-bottom:8px;
        border:1px solid var(--lp-line);border-radius:var(--lp-r);background:var(--lp-alt);min-width:0}
.lp-row:last-child{margin-bottom:0}
.lp-row .c{font-size:.75rem;font-weight:800;color:var(--lp-mut2);flex:none}
.lp-row .n{flex:1;min-width:0;font-size:.84rem;font-weight:600;color:var(--lp-ink)}
.lp-row b{font-size:.82rem;flex:none;color:var(--lp-ink)}
.lp-row .bar{flex:1;min-width:40px;height:7px;border-radius:4px;background:var(--lp-soft);overflow:hidden}
.lp-row .bar i{display:block;height:100%;border-radius:4px;background:var(--lp-blue)}
.lp-row .bar i.lo{background:var(--lp-warn)}
.lp-pill2{flex:none;font-size:.68rem;font-weight:800;padding:3px 9px;border-radius:var(--lp-pill)}
.lp-pill2.new{background:var(--lp-b050);color:var(--lp-blue)}
.lp-pill2.ship{background:var(--lp-warn-bg);color:var(--lp-warn)}
.lp-pill2.done{background:var(--lp-ok-bg);color:var(--lp-ok)}
.lp-pill2.warn{background:var(--lp-bad-bg);color:var(--lp-bad)}
.lp-num{padding:14px 16px;margin-bottom:12px;border-radius:var(--lp-r);background:var(--lp-b025);
        border:1px solid var(--lp-b100)}
.lp-num b{display:block;font-size:1.5rem;font-weight:800;color:var(--lp-ink);line-height:1.15}
.lp-num span{font-size:.8rem;color:var(--lp-mut2)}
.lp-bars{display:flex;align-items:flex-end;gap:6px;height:64px;margin-bottom:12px;padding-bottom:7px;
         border-bottom:2px solid var(--lp-soft)}
.lp-bars i{flex:1;min-height:6px;border-radius:4px 4px 0 0;background:var(--lp-b100)}
.lp-bars i.on{background:var(--lp-blue)}
.lp-credit{display:flex;align-items:center;gap:10px;padding:10px 12px;margin-bottom:8px;
           border:1px solid var(--lp-ok-bg);border-radius:var(--lp-r);background:var(--lp-ok-bg);min-width:0}
.lp-credit:last-child{margin-bottom:0}
.lp-credit .amt{font-weight:800;color:var(--lp-ok);font-size:.9rem;flex:none}
.lp-credit .src{flex:1;min-width:0;font-size:.8rem;color:var(--lp-body)}
.lp-credit .tm{font-size:.72rem;color:var(--lp-mut2);flex:none}
.lp-qr{display:grid;grid-template-columns:auto minmax(0,1fr);gap:15px;align-items:center;padding:16px;
       margin-bottom:12px;border:1px solid var(--lp-line);border-radius:var(--lp-r2);background:var(--lp-alt)}
.lp-qr .q{display:grid;place-items:center;width:72px;height:72px;border-radius:12px;background:var(--lp-ink);color:#fff}
.lp-qr .q svg{width:48px;height:48px}
.lp-qr b{display:block;font-size:.98rem;color:var(--lp-ink)}
.lp-qr span{font-size:.8rem;color:var(--lp-mut2)}
.lp-flash{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 17px;
          margin-bottom:12px;border-radius:var(--lp-r2);background:var(--lp-blue);color:#fff}
.lp-flash b{font-size:1rem}
.lp-flash .cd{display:flex;gap:5px}
.lp-flash .cd i{padding:5px 8px;border-radius:7px;background:rgba(0,0,0,.26);font-style:normal;font-weight:800;font-size:.84rem}
.lp-coup{display:flex;align-items:center;gap:12px;padding:12px 14px;margin-bottom:12px;
         border:1.6px dashed var(--lp-b100);border-radius:var(--lp-r);background:var(--lp-b025);min-width:0}
.lp-coup .code{flex:none;font-weight:800;letter-spacing:.06em;color:var(--lp-blue)}
.lp-coup span{font-size:.8rem;color:var(--lp-mut)}
.lp-pts{display:flex;align-items:center;gap:10px;padding:11px 13px;border:1px solid var(--lp-line);
        border-radius:var(--lp-r);background:var(--lp-alt);min-width:0}
.lp-pts .ic{flex:none;display:grid;place-items:center;width:30px;height:30px;border-radius:9px;
            background:var(--lp-warn-bg);color:var(--lp-warn)}
.lp-pts .ic svg{width:16px;height:16px}
.lp-pts b{display:block;font-size:.86rem;color:var(--lp-ink)}
.lp-pts span{font-size:.76rem;color:var(--lp-mut2)}
.lp-shop .sb{display:flex;align-items:center;padding:0 16px;height:58px;margin-bottom:12px;
             border:1px solid var(--lp-line);border-radius:var(--lp-r);background:var(--lp-alt);
             font-weight:800;font-size:.86rem;color:var(--lp-ink)}
.lp-shop .sg{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.lp-shop .sc{border:1px solid var(--lp-line);border-radius:var(--lp-r);overflow:hidden;background:var(--lp-alt)}
.lp-shop .si{display:grid;place-items:center;height:58px;color:var(--lp-mut2)}
.lp-shop .si svg{width:24px;height:24px}
.lp-shop .sl{height:8px;margin:0 10px 12px;border-radius:4px;background:var(--lp-soft)}
@media(max-width:820px){
  .lp-row,.lp-credit,.lp-coup,.lp-pts,.lp-flash{flex-wrap:wrap}
  .lp-row .n,.lp-credit .src,.lp-coup span{flex:1 1 100%;min-width:0}
  .lp-qr{grid-template-columns:1fr}
}

/* ── MỤC LỢI ÍCH: một tấm thẻ lớn, nửa trái xanh, nửa phải trắng ─────────────
   Nửa trái là danh sách lợi ích trên nền xanh đặc; nửa phải là khung xem có khe ảnh.
   Hai nút mũi tên đè lên mép trái/phải của thẻ. Cùng cơ chế tab như mục Sản phẩm nhưng
   KHÔNG có thang máy: lặp lại đúng một hiệu ứng ở hai mục liền nhau thì thành nhàm, và
   ở đây danh sách chỉ bốn mục nên hiện đủ được. ── */
.lp-loi-sec{background:#fff}
.lp-loi{position:relative;display:grid;border-radius:var(--lp-r4);overflow:hidden;
        box-shadow:var(--lp-sh2);background:#fff}
@media(min-width:960px){
  /* 5:7 — nửa trái đủ chỗ cho hai dòng mô tả, nửa phải rộng hơn để ảnh có đất. */
  .lp-loi{grid-template-columns:minmax(0,5fr) minmax(0,7fr);align-items:stretch}
}
.lp-loi>*{min-width:0}

.lp-loi-l{position:relative;padding:26px 20px;background:linear-gradient(160deg,#1553F0,var(--lp-blue) 55%,#0038CC)}
@media(min-width:960px){.lp-loi-l{padding:32px 26px}}
/* Lưới mờ chìm dưới nền xanh — cùng thủ pháp với ảnh mẫu, dựng bằng gradient nên không
   tốn thêm một tệp ảnh nào. */
.lp-loi-l::before{content:'';position:absolute;inset:0;opacity:.16;pointer-events:none;
  background-image:linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px);
  background-size:44px 44px}
.lp-loi-brand{position:relative;justify-content:center;margin:0 0 20px;color:#fff;font-size:1.12rem}
.lp-loi-brand .mk{background:#fff;color:var(--lp-blue)}
.lp-loi-list{position:relative;display:grid;gap:12px}

.lp-li{display:flex;gap:14px;align-items:flex-start;width:100%;padding:16px;text-align:left;
       border:1px solid rgba(255,255,255,.22);border-radius:var(--lp-r2);cursor:pointer;
       background:rgba(255,255,255,.10);
       transition:background var(--lp-t),border-color var(--lp-t),transform 160ms var(--lp-e)}
.lp-li:hover{background:rgba(255,255,255,.18)}
.lp-li.on{background:#fff;border-color:#fff;box-shadow:var(--lp-sh)}
.lp-li .ic{flex:none;display:grid;place-items:center;width:44px;height:44px;border-radius:var(--lp-r2);
           background:rgba(255,255,255,.18);color:#fff;transition:background var(--lp-t),color var(--lp-t)}
.lp-li .ic svg{width:21px;height:21px}
.lp-li.on .ic{background:var(--lp-b050);color:var(--lp-blue)}
.lp-li .tx{display:block;min-width:0}
.lp-li .t{display:block;font-size:1rem;font-weight:800;line-height:1.35;color:#fff}
.lp-li.on .t{color:var(--lp-ink)}
.lp-li .d{display:block;margin-top:6px;font-size:.88rem;line-height:1.55;color:rgba(255,255,255,.8)}
.lp-li.on .d{color:var(--lp-mut)}

.lp-loi-r{position:relative;display:grid;padding:26px 20px}
@media(min-width:960px){.lp-loi-r{padding:34px 32px}}
.lp-lp{grid-area:1/1;min-width:0;display:flex;flex-direction:column}
html.lpjs .lp-lp:not(.on){display:none}
@media(prefers-reduced-motion:no-preference){
  html.lpjs .lp-lp.on{animation:lp-pan 380ms var(--lp-e) both}
}
.lp-lp .k{font-size:.8rem;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:var(--lp-mut2)}
.lp-lp h3{margin-top:10px;font-size:clamp(1.15rem,.95rem + 1vw,1.6rem);font-weight:800;line-height:1.32;
          color:var(--lp-blue);max-width:22ch}
.lp-lp .gach{display:block;width:64px;height:3px;margin-top:16px;border-radius:2px;background:var(--lp-blue)}
.lp-lp-v{margin-top:20px;flex:1;display:grid;align-content:start}
.lp-lp-img{width:100%;height:auto;display:block;border-radius:var(--lp-r2)}
.lp-lp-mock{width:100%;max-width:440px;margin-inline:auto}

/* Mũi tên đè lên mép thẻ. Ẩn ở màn hẹp: chỗ đó đã chật, và danh sách bên trái vốn đã
   hiện đủ bốn mục nên bấm thẳng vào mục là xong. */
.lp-loi-arr{display:none}
@media(min-width:1100px){
  .lp-loi-arr{position:absolute;top:50%;z-index:2;display:grid;place-items:center;
              width:46px;height:46px;margin-top:-23px;border-radius:var(--lp-pill);border:1px solid var(--lp-line);
              background:#fff;color:var(--lp-ink);cursor:pointer;box-shadow:var(--lp-sh);
              transition:background var(--lp-t),color var(--lp-t)}
  .lp-loi-arr:hover{background:var(--lp-blue);border-color:var(--lp-blue);color:#fff}
  .lp-loi-arr.truoc{left:-23px}
  .lp-loi-arr.sau{right:-23px}
  /* Thẻ phải thôi cắt thì mũi tên đè mép mới thấy được. */
  .lp-loi{overflow:visible}
  .lp-loi-l{border-radius:var(--lp-r4) 0 0 var(--lp-r4)}
  .lp-loi-r{border-radius:0 var(--lp-r4) var(--lp-r4) 0;background:#fff}
}
/* Không JS thì mũi tên bấm không làm gì — một nút chết mời người ta bấm còn tệ hơn là
   không có nút. Quy tắc này PHẢI nằm SAU khối media ở trên: cùng độ ưu tiên thì cái viết
   sau mới thắng, @media không cộng thêm gì. */
html:not(.lpjs) .lp-loi-arr{display:none}

/* ── GIẢI PHÁP TĂNG TRƯỞNG (giữ chuyển động, dựng lại cách trình bày) ─────── */
/* Nền SÁNG, không còn navy. Ba mục sáng liền nhau thì dễ phẳng, nên mục này lấy một
   tông xanh rất nhạt để tự tách khỏi mục sản phẩm (#F5F6F8) và mục ngành hàng (trắng)
   mà không cần đổi hẳn sang nền tối. */
.lp-grow{background:var(--lp-b025);
         background-image:radial-gradient(90% 60% at 50% 0,#fff 0,transparent 62%)}
.lp-flag{display:grid;gap:28px;padding:44px 0;border-top:1px solid var(--lp-line)}
.lp-flag:first-of-type{border-top:0}
@media(min-width:960px){
  .lp-flag{grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:52px;align-items:center;padding:52px 0}
  .lp-flag.rev .lp-flag-v{order:-1}
}
.lp-flag>*{min-width:0}
.lp-kick2{display:inline-flex;align-items:center;gap:8px;margin:0 0 14px;padding:7px 15px;
          border-radius:var(--lp-pill);background:var(--lp-b050);border:1px solid var(--lp-b100);
          font-size:.76rem;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--lp-blue)}
.lp-kick2 svg{width:15px;height:15px}
.lp-flag h3{font-size:clamp(1.25rem,1rem + 1.2vw,1.85rem);font-weight:800;line-height:1.24}
.lp-flag .d{margin-top:12px;color:var(--lp-mut)}
.lp-flag ul{display:grid;gap:10px;margin-top:18px}
.lp-flag li{display:flex;gap:11px;align-items:flex-start;font-size:.94rem;color:var(--lp-mut)}
.lp-flag li svg{flex:none;width:17px;height:17px;margin-top:4px;color:var(--lp-ok)}
/* Ảnh do chủ dự án chèn dùng CHUNG khung với khung minh hoạ CSS: cùng bo góc, cùng đổ
   bóng, nên thay ảnh không phải sửa gì và bốn khối vẫn đồng bộ dù mới thay được một cái. */
.lp-flag-img{width:100%;height:auto;display:block;border-radius:var(--lp-r3);
             box-shadow:var(--lp-sh2)}

/* ── NGÀNH HÀNG: băng thẻ lướt ngang ──────────────────────────────────────── */
/* Nền xanh rất nhạt: mục nằm giữa "Lợi ích" (trắng) và "Bảng giá" (xám), hai mục
   cùng tông kề nhau thì mắt đọc thành một mục dài. */
.lp-ind{background:var(--lp-b025);padding:56px 0}
@media(min-width:1024px){.lp-ind{padding:88px 0}}

/* Hàng lọc theo ngành. Không JS thì các nút này KHÔNG làm gì (ẩn hẳn ở cuối khối
   CSS này) — băng vẫn đủ 12 thẻ và vẫn vuốt được, nên không mất nội dung nào. */
/* Màn hẹp: MỘT HÀNG cuộn ngang, không xuống dòng. Đo được ở 390px: 13 chip xuống dòng
   thành BẢY hàng, đẩy thẻ đầu tiên xuống dưới mép màn hình — người dùng cuộn tới mục này
   chỉ thấy một rừng nút, không thấy thứ mà nút đó lọc. */
.lp-nh-loc{display:flex;flex-wrap:nowrap;overflow-x:auto;overscroll-behavior-x:contain;gap:9px;
           margin:0 0 22px;padding:2px clamp(20px,4.4vw,56px) 8px;
           scroll-padding-inline:clamp(20px,4.4vw,56px)}
@media(min-width:960px){
  .lp-nh-loc{flex-wrap:wrap;justify-content:center;overflow:visible;margin-bottom:28px}
}
html.lpjs .lp-nh-loc{scrollbar-width:none}
html.lpjs .lp-nh-loc::-webkit-scrollbar{display:none}
.lp-chip{display:inline-flex;align-items:center;gap:9px;padding:7px 15px 7px 7px;white-space:nowrap;
         border:1px solid var(--lp-line);border-radius:var(--lp-pill);background:#fff;font-weight:600;
         font-size:.87rem;color:var(--lp-ink);cursor:pointer;
         transition:border-color var(--lp-t),background var(--lp-t),color var(--lp-t)}
.lp-chip:hover{border-color:var(--lp-b100)}
.lp-chip .i{display:grid;place-items:center;width:26px;height:26px;border-radius:var(--lp-pill);
            background:var(--lp-b025);color:var(--lp-blue);flex:none;transition:background var(--lp-t),color var(--lp-t)}
.lp-chip .i svg{width:15px;height:15px}
.lp-chip[aria-pressed="true"]{background:var(--lp-blue);border-color:var(--lp-blue);color:#fff}
.lp-chip[aria-pressed="true"] .i{background:rgba(255,255,255,.18);color:#fff}

/* Băng TRÀN RA HAI MÉP khung nội dung: đệm trong bằng đúng đệm của .ct nên thẻ đầu
   thẳng hàng với tiêu đề, còn thẻ cuối cùng ló ra khỏi mép phải — đó là tín hiệu
   "còn nữa, vuốt tiếp" mà không cần chữ nào. Cuộn ngang nằm TRONG băng, không phải
   ở trang: cuộn của trang thì mọi mục khác trôi theo. */
.lp-nh-box{position:relative}
.lp-nh-ray{display:flex;gap:20px;overflow-x:auto;overscroll-behavior-x:contain;
           scroll-snap-type:x mandatory;padding:6px clamp(20px,4.4vw,56px) 10px;
           scroll-padding-inline:clamp(20px,4.4vw,56px)}
.lp-nh-ray.nh-tu-chay{scroll-snap-type:none;scroll-behavior:auto}
/* Thanh cuộn chỉ giấu khi CÓ mũi tên thay thế. Không JS mà cũng giấu thanh cuộn thì
   người dùng chuột không còn cách nào biết băng lướt được. */
html.lpjs .lp-nh-ray{scrollbar-width:none}
html.lpjs .lp-nh-ray::-webkit-scrollbar{display:none}
.lp-nh{flex:0 0 var(--lp-nhw,min(80vw,310px));scroll-snap-align:start;display:flex;flex-direction:column;
       background:#fff;border:1px solid var(--lp-line);border-radius:var(--lp-r3);overflow:hidden;
       transition:border-color var(--lp-t),box-shadow var(--lp-t),transform 160ms var(--lp-e)}
.lp-nh:hover{border-color:var(--lp-b100);box-shadow:var(--lp-sh2);transform:translateY(-4px)}
@media(min-width:720px){.lp-nh{--lp-nhw:min(46vw,330px)}}
@media(min-width:1080px){.lp-nh{--lp-nhw:336px}}
/* Ảnh bìa giữ TỈ LỆ CỐ ĐỊNH: mười hai thẻ mà chỉ thay được vài ảnh thì ảnh cao thấp
   khác nhau sẽ đẩy phần chữ lệch nhau — object-fit cắt ảnh, không cắt bố cục. */
.lp-nh-anh{position:relative;aspect-ratio:16/10;background:var(--lp-b050);overflow:hidden}
.lp-nh-anh img{width:100%;height:100%;display:block;object-fit:cover}
/* Ba tông luân phiên cho khung minh hoạ. Mười hai thẻ cùng MỘT nền xanh xếp cạnh nhau
   đọc thành một dải phẳng — mắt không tách được thẻ nào với thẻ nào. Đây là khung TẠM,
   thay bằng ảnh thật là hết luân phiên, nên tông phải cùng họ màu thương hiệu. */
.lp-nh-mock{position:absolute;inset:0;display:grid;place-items:center;
            background:radial-gradient(120% 120% at 30% 15%,#1553F0 0%,var(--lp-blue) 45%,#0038CC 100%)}
.lp-nh-mock.t2{background:radial-gradient(120% 120% at 30% 15%,#1B2E6E 0%,#101B45 48%,var(--lp-navy) 100%)}
.lp-nh-mock.t3{background:radial-gradient(120% 120% at 30% 15%,#48A0FF 0%,var(--lp-blue-br) 42%,#0B4FD6 100%)}
.lp-nh-mock::before{content:'';position:absolute;inset:0;opacity:.22;
  background-image:linear-gradient(rgba(255,255,255,.5) 1px,transparent 1px),
                   linear-gradient(90deg,rgba(255,255,255,.5) 1px,transparent 1px);
  background-size:34px 34px}
.lp-nh-mock svg{position:relative;width:52px;height:52px;color:#fff;opacity:.95}
.lp-nh-ndu{display:flex;flex-direction:column;flex:1;padding:18px 20px 20px}
.lp-nh-pill{display:inline-flex;align-items:center;gap:7px;align-self:flex-start;
            padding:5px 12px 5px 5px;border-radius:var(--lp-pill);background:var(--lp-b025);
            color:var(--lp-blue);font-size:.78rem;font-weight:800;letter-spacing:.02em}
.lp-nh-pill .i{display:grid;place-items:center;width:22px;height:22px;border-radius:var(--lp-pill);
               background:#fff;flex:none}
.lp-nh-pill .i svg{width:13px;height:13px}
.lp-nh h3{margin-top:12px;font-size:1.08rem;font-weight:800;line-height:1.3}
/* margin-bottom ở đây + margin-top:auto ở hàng đồ nghề = hàng đồ nghề DÁN ĐÁY thẻ.
   Mười hai thẻ có mô tả dài ngắn khác nhau; để hàng đồ nghề trôi theo chữ thì mỗi thẻ
   một độ cao gạch ngang, nhìn thành một hàng răng cưa. */
.lp-nh .d{margin-top:9px;margin-bottom:16px;font-size:.9rem;line-height:1.6;color:var(--lp-mut)}
/* Phải viết .lp-nh .lp-nh-tg chứ không phải .lp-nh-tg: quy tắc nền .lp ul{margin:0}
   có độ ưu tiên (0,1,1), cao hơn một lớp trần (0,1,0) ⇒ margin-top:auto bị nuốt và thẻ
   nào ít đồ nghề thì hàng đó trôi lên giữa thẻ. Đo được: thẻ Nội thất có gạch ngang cao
   hơn ba thẻ bên cạnh 58px, đủ để cả hàng nhìn như răng cưa. */
.lp-nh .lp-nh-tg{display:flex;flex-wrap:wrap;gap:7px;margin-top:auto;padding-top:14px;
          border-top:1px solid var(--lp-line)}
.lp-nh-tg li{padding:4px 10px;border-radius:var(--lp-pill);background:var(--lp-alt);
             font-size:.76rem;font-weight:600;color:var(--lp-mut)}
/* Thẻ bị lọc ra dùng [hidden]: phải khai lại display:none vì .lp-nh có display:flex,
   mà khai display thắng thuộc tính hidden — đúng cái bẫy đã cắn ở ngăn kéo menu. */
.lp-nh[hidden]{display:none}

.lp-nh-dieu{display:flex;justify-content:center;align-items:center;gap:12px;margin-top:24px}
.lp-nh-arr{display:grid;place-items:center;width:44px;height:44px;border-radius:var(--lp-pill);
           border:1px solid var(--lp-line);background:#fff;color:var(--lp-ink);cursor:pointer;
           transition:background var(--lp-t),border-color var(--lp-t),color var(--lp-t)}
.lp-nh-arr:hover{background:var(--lp-blue);border-color:var(--lp-blue);color:#fff}
.lp-nh-dem{min-width:78px;text-align:center;font-size:.85rem;font-weight:600;color:var(--lp-mut);
           font-variant-numeric:tabular-nums}
.lp-nh-note{margin-top:20px;text-align:center;font-size:.84rem;line-height:1.6;color:var(--lp-mut2)}
/* Không JS: mũi tên không bấm được thì đừng bày ra, và hàng lọc cũng vậy. Đặt SAU
   mọi khai display ở trên — cùng độ ưu tiên thì quy tắc viết sau thắng, @media không
   cộng thêm độ ưu tiên nào (đã đốt một lượt vì đặt nhầm thứ tự). */
html:not(.lpjs) .lp-nh-dieu,html:not(.lpjs) .lp-nh-loc{display:none}

/* ── BẢNG GIÁ ────────────────────────────────────────────────────────────── */
.lp-price{background:var(--lp-alt)}
.lp-plans{display:grid;gap:20px;grid-template-columns:repeat(3,minmax(0,1fr));align-items:start}
@media(max-width:1100px){.lp-plans{grid-template-columns:1fr;max-width:460px;margin-inline:auto}}
.lp-plan{position:relative;min-width:0;display:flex;flex-direction:column;padding:30px 26px;
         border:1px solid var(--lp-line);border-radius:var(--lp-r4);background:#fff;
         transition:border-color var(--lp-t),box-shadow var(--lp-t),transform 160ms var(--lp-e)}
.lp-plan:hover{transform:translateY(-4px);box-shadow:var(--lp-sh2)}
.lp-plan.hot{background:var(--lp-navy);border-color:var(--lp-navy);color:#fff}
.lp-plan.hot .tag{color:rgba(255,255,255,.6)}
.lp-plan.hot .pr span{color:rgba(255,255,255,.6)}
.lp-plan.hot h3,.lp-plan.hot .pr{color:#fff}
.lp-plan.hot li{color:rgba(255,255,255,.8)}
.lp-plan.hot li svg{color:#7FE0A5}
.lp-hot-b{position:absolute;top:-13px;left:26px;padding:5px 14px;border-radius:var(--lp-pill);
          background:var(--lp-blue);color:#fff;font-size:.7rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase}
.lp-plan .tag{font-size:.8rem;font-weight:600;color:var(--lp-mut2)}
.lp-plan h3{margin-top:6px;font-size:1.5rem;font-weight:800}
.lp-plan .pr{margin-top:14px;font-size:2rem;font-weight:800;color:var(--lp-ink);line-height:1.1;
             font-variant-numeric:tabular-nums}
.lp-plan .pr span{margin-left:5px;font-size:.88rem;font-weight:400;color:var(--lp-mut2)}
.lp-plan ul{display:grid;gap:11px;margin:22px 0 26px}
.lp-plan li{display:flex;gap:10px;align-items:flex-start;font-size:.93rem;color:var(--lp-mut)}
.lp-plan li svg{flex:none;width:17px;height:17px;margin-top:4px;color:var(--lp-ok)}
.lp-plan .lp-btn{margin-top:auto;width:100%}
.lp-plan.hot .lp-b-gh{background:transparent;border-color:rgba(255,255,255,.34);color:#fff}
.lp-plan.hot .lp-b-gh:hover{background:rgba(255,255,255,.12)}
.lp-plan-note{margin-top:24px;text-align:center;font-size:.9rem;color:var(--lp-mut)}
.lp-plan-note a{color:var(--lp-blue);font-weight:600;text-decoration:underline;text-underline-offset:3px}

/* ── HỎI ĐÁP ─────────────────────────────────────────────────────────────── */
.lp-faq{background:#fff}
.lp-faq-l{display:grid;gap:12px;max-width:900px;margin-inline:auto}
.lp-faq details{border:1px solid var(--lp-line);border-radius:var(--lp-r2);background:#fff;overflow:hidden}
.lp-faq details[open]{border-color:var(--lp-b100);background:var(--lp-b025)}
.lp-faq summary{padding:18px 20px;font-weight:600;font-size:1rem;color:var(--lp-ink);cursor:pointer;
                list-style:none;display:flex;align-items:center;justify-content:space-between;gap:14px}
.lp-faq summary::-webkit-details-marker{display:none}
.lp-faq summary::after{content:'';flex:none;width:11px;height:11px;border-right:2px solid var(--lp-blue);
                       border-bottom:2px solid var(--lp-blue);transform:rotate(45deg) translateY(-2px);
                       transition:transform var(--lp-t) var(--lp-e)}
.lp-faq details[open] summary::after{transform:rotate(225deg) translateY(-2px)}
.lp-faq .ans{padding:0 20px 18px;color:var(--lp-mut);font-size:.95rem;line-height:1.68}

/* ── CTA cuối + chân trang ───────────────────────────────────────────────── */
.lp-final{padding:64px 0}
@media(min-width:1024px){.lp-final{padding:96px 0}}
.lp-box{padding:48px 26px;border-radius:var(--lp-r4);background:var(--lp-hero);color:#fff;text-align:center}
@media(min-width:768px){.lp-box{padding:68px 56px}}
.lp-box h2{color:#fff;font-size:clamp(1.35rem,1.05rem + 1.5vw,2.2rem);font-weight:800;line-height:1.3;
           text-transform:uppercase;margin-inline:auto;max-width:26ch}
.lp-box p{margin-top:16px;color:rgba(255,255,255,.76);margin-inline:auto;max-width:52ch}
.lp-box-r{display:flex;flex-wrap:wrap;gap:12px;justify-content:center;margin-top:30px}
.lp-box-c{margin-top:24px;font-size:.86rem;color:rgba(255,255,255,.6)}

.lp-ft{background:var(--lp-deep);color:rgba(255,255,255,.66);padding:56px 0 28px}
.lp-ft-g{display:grid;gap:34px}
@media(min-width:760px){.lp-ft-g{grid-template-columns:1.5fr 1fr 1fr}}
@media(min-width:1180px){.lp-ft-g{grid-template-columns:1.7fr repeat(4,1fr);gap:32px}}
.lp-ft .lp-brand{color:#fff;margin-bottom:14px}
.lp-ft-ab p{font-size:.9rem;line-height:1.65;max-width:38ch}
.lp-ft-ab .lp-btn{margin-top:18px;height:44px;font-size:.93rem}
.lp-ft-c h3{font-size:.78rem;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#fff;margin-bottom:14px}
.lp-ft-c a,.lp-ft-c span{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:.9rem;color:rgba(255,255,255,.66)}
.lp-ft-c a:hover{color:#fff}
.lp-ft-c svg{width:15px;height:15px;flex:none}
.lp-ft-b{display:flex;flex-wrap:wrap;gap:10px 20px;justify-content:space-between;margin-top:38px;
         padding-top:22px;border-top:1px solid rgba(255,255,255,.1);font-size:.84rem}
.lp-ft-b a{color:rgba(255,255,255,.66)}
.lp-ft-b a:hover{color:#fff}

/* ── THANH CTA NỔI ───────────────────────────────────────────────────────── */
.lp-dock{position:fixed;z-index:50;left:0;right:0;bottom:0;padding-bottom:env(safe-area-inset-bottom);
         transform:translateY(130%);opacity:0;visibility:hidden;
         transition:transform var(--lp-t) var(--lp-e),opacity var(--lp-t),visibility var(--lp-t)}
.lp-dock.on{transform:none;opacity:1;visibility:visible}
.lp-dock-c{display:flex;align-items:center;gap:12px;height:64px;padding:0 12px 0 16px;
           background:var(--lp-blue);border-radius:var(--lp-r2) var(--lp-r2) 0 0}
.lp-dock-c .t{flex:1;min-width:0}
.lp-dock-c .t1{font-size:.93rem;font-weight:800;color:#fff;line-height:1.35;
               overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lp-dock-c .t2{display:none}
.lp-dock-c .go{flex:none;display:inline-flex;align-items:center;gap:8px;height:44px;padding:0 18px;
               border-radius:var(--lp-pill);background:#fff;color:var(--lp-blue);font-size:.93rem;font-weight:800}
.lp-dock-c .x{flex:none;display:grid;place-items:center;width:32px;height:32px;border-radius:var(--lp-pill);
              background:rgba(255,255,255,.18);color:#fff;border:0;cursor:pointer}
@media(min-width:768px){
  .lp-dock{left:auto;right:24px;bottom:24px;width:352px}
  .lp-dock-c{height:auto;flex-direction:column;align-items:stretch;gap:14px;padding:20px;
             border-radius:var(--lp-r3);box-shadow:0 6px 24px rgba(0,56,209,.36)}
  .lp-dock-c .hd{display:flex;align-items:flex-start;gap:12px}
  .lp-dock-c .t1{font-size:1.12rem;white-space:normal}
  .lp-dock-c .t2{display:block;margin-top:6px;font-size:.88rem;font-weight:400;line-height:1.55;color:rgba(255,255,255,.86)}
  .lp-dock-c .go{width:100%;height:46px;justify-content:center;border-radius:var(--lp-r);
                 background:rgba(255,255,255,.18);color:#fff;border:1px solid rgba(255,255,255,.3)}
  .lp-dock-c .go:hover{background:rgba(255,255,255,.28)}
}
.lp-reopen{position:fixed;z-index:50;right:16px;bottom:16px;width:54px;height:54px;border:0;cursor:pointer;
           border-radius:var(--lp-pill);background:var(--lp-blue);color:#fff;display:none;place-items:center;
           box-shadow:0 6px 24px rgba(0,56,209,.36)}
@media(min-width:768px){.lp-reopen{right:24px;bottom:24px}}
.lp-reopen.on{display:grid}

/* ── Hiện dần khi cuộn. Trạng thái ẩn CHỈ bật khi có JS (html.lpjs) ─────────
   Không có JS thì quy tắc này không tồn tại, nên trang không bao giờ kẹt opacity:0. ── */
html.lpjs .rv{opacity:0;transform:translateY(18px)}
html.lpjs .rv.in{opacity:1;transform:none;transition:opacity 520ms var(--lp-e),transform 520ms var(--lp-e)}

/* LƯỚT NGANG HAI CHIỀU — khác .rv ở hai điểm, và cả hai đều là yêu cầu của chủ dự án:
   · lướt theo chiều NGANG, mỗi cột vào từ đúng phía nó đứng;
   · ĐI RỒI VỀ: cuộn ngược lên thì hai cột lướt trở ra hai bên, chứ không phải hiện một
     lần rồi ở lại vĩnh viễn như .rv.
   Transition khai ngay ở trạng thái gốc (không phải ở .in như .rv): có thế thì lượt đi
   RA mới có chuyển động, nếu khai ở .in thì gỡ .in là biến mất tức thì. */
html.lpjs .rv-x{opacity:0;transition:opacity 640ms var(--lp-e),transform 640ms var(--lp-e)}
/* Quãng lướt phải LUÔN NHỎ HƠN lề của khung chứa (.ct dùng clamp(20px,4.4vw,56px)).
   Đặt cứng 56px thì ở khung 1024px lề chỉ 45px, cột phải đỗ 11px ngoài mép và trang
   tràn 1020/1009 — chỉ ở đúng cỡ đó, hai cỡ hai bên đều sạch. Cùng dạng clamp nhưng
   hệ số nhỏ hơn thì khoảng cách an toàn giữ được ở MỌI bề rộng, không phải vá từng mốc. */
html.lpjs .rv-l{transform:translateX(calc(-1 * clamp(16px,3.2vw,44px)))}
html.lpjs .rv-r{transform:translateX(clamp(16px,3.2vw,44px))}
html.lpjs .rv-x.in{opacity:1;transform:none}
@media(max-width:959px){
  /* Màn hẹp: lướt DỌC, không lướt ngang. Hai lý do, cả hai đều đo được:
     · dưới 960px hai cột xếp chồng lên nhau nên "vào từ trái / vào từ phải" mất hết ý
       nghĩa — chỉ còn là hai khối cùng giật ngang;
     · trạng thái ẩn đỗ 26px ngoài mép phải làm trang tràn 351/345 ở khung 360px. Không
       thấy bằng scrollWidth vì body có overflow-x:hidden — tràn bị biến thành CẮT, đúng
       cái bẫy đã ghi ở CLAUDE.md §4. */
  html.lpjs .rv-l,html.lpjs .rv-r{transform:translateY(22px)}
}
@media(prefers-reduced-motion:reduce){
  html.lpjs .rv,html.lpjs .rv-x{opacity:1;transform:none;transition:none}
  html.lpjs .lp-track{transition:none}
  .lp-hdr{transition:none}
}
`;

// ── LỚP TĂNG CƯỜNG (chỉ chèn khi có nonce — xem chú thích đầu file) ─────────
const JS = `(function(){
  'use strict';
  var RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var D = document, root = D.documentElement;
  root.classList.add('lpjs');

  /* ── HIỆN DẦN KHI CUỘN ───────────────────────────────────────────────────
     Gọi TRỰC TIẾP trong listener cuộn, KHÔNG qua requestAnimationFrame và KHÔNG
     qua IntersectionObserver. Đo được cả hai đường kia đều có lúc không chạy ở
     khung hẹp, và hậu quả là phần tử kẹt opacity:0 — mất trắng chữ, trong khi
     mọi phép đo tràn ngang vẫn báo ĐẠT. Hiệu ứng hỏng thì chấp nhận được; chữ
     biến mất thì không. */
  var rvs = [].slice.call(D.querySelectorAll('.rv')), rvDone = 0, rvArmed = false;
  rvs.forEach(function(e, i){ e.dataset.d = String(Math.min(i, 4) * 70); });
  function rvScan(){
    if (!rvs.length) return;
    var h = innerHeight;
    rvs = rvs.filter(function(e){
      var r = e.getBoundingClientRect();
      /* CHỈ giữ lại thứ CHƯA tới lượt (còn nằm dưới mép dưới). Bản trước giữ luôn thứ đã
         trôi LÊN TRÊN khung nhìn, và đó là lỗi: nhảy tới một mỏ neo, tải lại trang giữa
         chừng, hay cuộn nhanh một phát tới cuối — mọi phần tử bị vượt qua sẽ kẹt opacity:0
         VĨNH VIỄN. Đo được 4/37 phần tử hiện sau khi cuộn tới giữa trang. */
      if (r.top > h * 0.94) return true;
      rvDone++;
      setTimeout(function(){ e.classList.add('in'); }, Number(e.dataset.d || 0));
      return false;
    });
  }
  /* LƯỚT NGANG HAI CHIỀU. Khác .rv ở chỗ KHÔNG lọc phần tử ra khỏi danh sách sau lần
     hiện đầu: mỗi lượt quét đều đặt lại cờ theo việc phần tử có đang trong khung nhìn
     hay không, nên cuộn ngược lên là hai cột lướt trở ra hai bên. Đó chính là thứ .rv
     không làm được — nó là hiệu ứng một-lần theo thiết kế, cố ý. */
  var rvX = [].slice.call(D.querySelectorAll('.rv-x'));
  function rvXQuet(){
    if (!rvX.length) return;
    var h = innerHeight;
    for (var i = 0; i < rvX.length; i++) {
      var r = rvX[i].getBoundingClientRect();
      var trong = r.top < h * 0.88 && r.bottom > h * 0.12;
      rvX[i].classList.toggle('in', trong);
      if (trong) rvDone++;      // tính vào lưới an toàn chung, xem rvGuard
    }
  }
  if (RM) {
    rvs.forEach(function(e){ e.classList.add('in'); }); rvs = [];
    rvX.forEach(function(e){ e.classList.add('in'); });
  }
  /* Lưới an toàn hẹn giờ từ LẦN CUỘN ĐẦU, không từ lúc nạp: đứng đọc hero vài giây
     là bình thường, không phải hỏng. Nếu hiệu ứng không quét được thì hiện thẳng các
     phần tử đang kẹt, nhưng GIỮ cờ lpjs — cờ này còn điều khiển các carousel khác. */
  function rvGuard(){
    if (rvArmed) return;
    rvArmed = true;
    setTimeout(function(){
      if (rvDone === 0 && (rvs.length || rvX.length)) {
        rvs.forEach(function(e){ e.classList.add('in'); });
        rvX.forEach(function(e){ e.classList.add('in'); });
        rvs = []; rvX = [];
      }
    }, 1500);
  }

  /* ── HEADER: ẩn khi lướt xuống, hiện khi lướt lên ────────────────────────── */
  var hdr = D.getElementById('lpHdr'), last = scrollY;
  function onScroll(){
    var y = Math.max(0, scrollY), d = y - last;
    hdr.classList.toggle('solid', y > 80);
    /* Vùng chết 6px để tay run không làm thanh nhấp nháy. Luôn hiện lại khi gần
       đỉnh, và KHÔNG ẩn khi ngăn kéo đang mở (ẩn thì mất luôn nút đóng). */
    if (!D.body.classList.contains('lp-lock')) {
      if (y < 120 || d < -6) hdr.classList.remove('hide');
      else if (d > 6 && y > 160) hdr.classList.add('hide');
    }
    last = y;
    dockPos();
    dock();
  }
  /* Gọi THẲNG, không bọc requestAnimationFrame. Trình duyệt đã tiết chế sự kiện cuộn
     xuống quanh nhịp khung hình rồi, listener lại khai passive nên không chặn cuộn; đổi
     lại thì hành vi không còn phụ thuộc việc có khung hình được vẽ hay không. Đo được:
     trong môi trường không vẽ đều, rAF chỉ chạy 2 lần trong CẢ MỘT GIÂY — thanh điều
     hướng kẹt nguyên trạng thái cũ, và cùng lớp lỗi đó từng làm chữ kẹt opacity:0. */
  function beat(){ rvScan(); rvXQuet(); rvGuard(); onScroll(); spTrongTam(); liTrongTam(); nhTrongTam(); }
  addEventListener('resize', spNhip, { passive: true });
  if (D.fonts && D.fonts.ready) D.fonts.ready.then(spNhip);
  addEventListener('scroll', beat, { passive: true });
  addEventListener('resize', beat, { passive: true });
  addEventListener('load', beat);
  if (D.fonts && D.fonts.ready) D.fonts.ready.then(beat);

  /* ── NGĂN KÉO ────────────────────────────────────────────────────────────── */
  var dw = D.getElementById('lpDrawer'), sc = D.getElementById('lpScrim'),
      bg = D.getElementById('lpBurger'), dx = D.getElementById('lpDx'), moTruoc = null;
  function moDong(mo){
    dw.hidden = !mo; sc.hidden = !mo;
    bg.setAttribute('aria-expanded', String(mo));
    D.body.classList.toggle('lp-lock', mo);
    D.body.style.overflow = mo ? 'hidden' : '';
    requestAnimationFrame(function(){ dw.classList.toggle('on', mo); sc.classList.toggle('on', mo); });
    if (mo) { moTruoc = D.activeElement; dx.focus(); }
    else if (moTruoc) { moTruoc.focus(); moTruoc = null; }
  }
  bg.addEventListener('click', function(){ moDong(true); });
  dx.addEventListener('click', function(){ moDong(false); });
  sc.addEventListener('click', function(){ moDong(false); });
  dw.addEventListener('click', function(e){ if (e.target.tagName === 'A') moDong(false); });
  addEventListener('keydown', function(e){
    if (e.key === 'Escape' && !dw.hidden) moDong(false);
    if (e.key !== 'Tab' || dw.hidden) return;
    /* Giữ tiêu điểm trong ngăn kéo: không có bẫy này thì Tab đi ra sau tấm phủ và
       người dùng bàn phím lạc vào một trang họ không nhìn thấy. */
    var f = dw.querySelectorAll('a[href],button:not([disabled])');
    if (!f.length) return;
    var a = f[0], z = f[f.length - 1];
    if (e.shiftKey && D.activeElement === a) { e.preventDefault(); z.focus(); }
    else if (!e.shiftKey && D.activeElement === z) { e.preventDefault(); a.focus(); }
  });

  /* ── CAROUSEL HERO ───────────────────────────────────────────────────────── */
  var slides = [].slice.call(D.querySelectorAll('.lp-slide')),
      dots = [].slice.call(D.querySelectorAll('.lp-dots button')),
      cur = D.getElementById('lpCur'), pause = D.getElementById('lpPause'),
      hero = D.getElementById('lpHero'), i = 0, timer = null, dungTay = false;
  function den(k){
    i = (k + slides.length) % slides.length;
    slides.forEach(function(s, n){ s.classList.toggle('on', n === i); });
    dots.forEach(function(d, n){ d.setAttribute('aria-current', String(n === i)); });
    if (cur) cur.textContent = String(i + 1).padStart(2, '0');
  }
  function chay(){ if (!timer && !dungTay && !RM && slides.length > 1) timer = setInterval(function(){ den(i + 1); }, 6000); }
  function ngung(){ if (timer) { clearInterval(timer); timer = null; } }
  dots.forEach(function(d, n){ d.addEventListener('click', function(){ den(n); ngung(); chay(); }); });
  var prev = D.getElementById('lpPrev'), next = D.getElementById('lpNext');
  if (prev) prev.addEventListener('click', function(){ den(i - 1); ngung(); chay(); });
  if (next) next.addEventListener('click', function(){ den(i + 1); ngung(); chay(); });
  if (pause) pause.addEventListener('click', function(){
    dungTay = !dungTay;
    pause.setAttribute('aria-pressed', String(dungTay));
    pause.setAttribute('aria-label', dungTay ? 'Chạy lại băng giới thiệu' : 'Tạm dừng băng giới thiệu');
    if (dungTay) ngung(); else chay();
  });
  /* WCAG 2.2.2: nội dung tự chạy phải dừng được, VÀ phải tự dừng khi người ta đang
     đọc nó — trỏ chuột vào hoặc đưa tiêu điểm bàn phím vào. */
  if (hero) {
    hero.addEventListener('mouseenter', ngung);
    hero.addEventListener('mouseleave', chay);
    hero.addEventListener('focusin', ngung);
    hero.addEventListener('focusout', function(e){ if (!hero.contains(e.relatedTarget)) chay(); });
  }
  chay();

  /* ── BỘ TAB SẢN PHẨM: cột nút cuộn liên tục như thang máy ────────────────── */
  var tabs = [].slice.call(D.querySelectorAll('.lp-tab[role="tab"]')),
      moiThe = [].slice.call(D.querySelectorAll('.lp-tab')),
      panes = [].slice.call(D.querySelectorAll('.lp-panel')),
      dots2 = [].slice.call(D.querySelectorAll('.lp-pdots span')),
      spCur = D.getElementById('spCur'), spWrap = D.querySelector('.lp-showcase'),
      spBox = D.querySelector('.lp-tabs'), spRay = D.querySelector('.lp-track'),
      spBo = D.querySelector('.lp-set'), spBo2 = D.querySelectorAll('.lp-set')[1],
      sp = 0, spKhoa = -1;

  function spDen(k){
    sp = (k + tabs.length) % tabs.length;
    tabs.forEach(function(t, i){
      var on = i === sp;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;               // bộ tab chỉ chiếm MỘT nấc Tab, đúng chuẩn
    });
    moiThe.forEach(function(t){ t.classList.toggle('on', Number(t.dataset.i) === sp); });
    panes.forEach(function(pn, i){ pn.classList.toggle('on', i === sp); });
    dots2.forEach(function(d, i){ d.classList.toggle('on', i === sp); });
    if (spCur) spCur.textContent = String(sp + 1).padStart(2, '0');
  }

  /* Tốc độ tính theo chiều cao THẬT của một bộ, không đặt cứng một con số giây: thêm hay
     bớt một mục thì băng vẫn trôi đúng bằng ấy pixel mỗi giây. 38px/giây là tốc độ đọc
     kịp mà không sốt ruột. */
  function spNhip(){
    if (!spBo || !spBo2 || !spRay) return;
    var dy = spBo2.offsetTop - spBo.offsetTop;     // chu kỳ lặp, đo bằng vị trí thật
    if (!(dy > 0)) return;
    spRay.style.setProperty('--lp-dy', (-dy) + 'px');
    spRay.style.setProperty('--lp-tg', Math.max(12, Math.round(dy / 38)) + 's');
  }

  /* Thẻ nào đang ở GIỮA khung thì thẻ đó sáng, và khung bên phải đổi theo. Đọc vị trí
     thật bằng getBoundingClientRect thay vì tự tính từ tiến độ animation: animation chạy
     trên luồng dựng hình, tự tính thì sớm muộn cũng lệch khỏi thứ mắt đang thấy. */
  function spQuet(){
    if (!spBox || spKhoa >= 0 || innerWidth < 1024) return;
    var b = spBox.getBoundingClientRect(), tam = b.top + b.height / 2;
    var gan = -1, lech = 1e9;
    moiThe.forEach(function(t){
      var r = t.getBoundingClientRect();
      if (r.bottom < b.top || r.top > b.bottom) return;   // ngoài khung thì bỏ qua
      var d = Math.abs(r.top + r.height / 2 - tam);
      if (d < lech) { lech = d; gan = Number(t.dataset.i); }
    });
    if (gan >= 0 && gan !== sp) spDen(gan);
  }
  setInterval(spQuet, 140);

  /* Bấm được cả trên bản BÓNG: nếu chỉ bản thật ăn thì một nửa số thẻ đang trôi qua mắt
     bấm không có phản ứng, và người dùng không có cách nào đoán ra vì sao. */
  if (spRay) spRay.addEventListener('click', function(e){
    var t = e.target.closest('.lp-tab');
    if (!t) return;
    spKhoa = Number(t.dataset.i);
    spDen(spKhoa);
  });
  /* Mở khoá khi trỏ rời cột nút: lúc đó người ta đã đọc xong mục vừa chọn. Không mở khoá
     thì băng vẫn trôi nhưng khung bên phải đứng yên mãi — hai bên nói hai chuyện khác
     nhau, tệ hơn cả đứng im cả hai. */
  if (spBox) spBox.addEventListener('mouseleave', function(){ spKhoa = -1; });

  tabs.forEach(function(t, i){
    t.addEventListener('keydown', function(e){
      var d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1
            : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1
            : e.key === 'Home' ? -sp : e.key === 'End' ? tabs.length - 1 - sp : 0;
      if (!d) return;
      e.preventDefault();
      spDen(sp + d);
      spKhoa = sp;
      tabs[sp].focus();
    });
  });
  if (spWrap) spWrap.addEventListener('focusout', function(e){
    if (!spWrap.contains(e.relatedTarget)) spKhoa = -1;
  });

  /* Ngủ khi khối ra khỏi tầm mắt: băng chạy dưới đáy trang không ai thấy chỉ tổ tốn pin. */
  function spTrongTam(){
    if (!spWrap) return;
    var r = spWrap.getBoundingClientRect();
    spWrap.classList.toggle('ngu', !(r.top < innerHeight * 0.95 && r.bottom > innerHeight * 0.05));
  }

  /* ── MỤC LỢI ÍCH: bộ tab có mũi tên, tự chạy ─────────────────────────────── */
  var liNuts = [].slice.call(D.querySelectorAll('.lp-li')),
      liKhungs = [].slice.call(D.querySelectorAll('.lp-lp')),
      liThe = D.querySelector('.lp-loi'),
      li = 0, liTimer = null;
  function liDen(k){
    li = (k + liNuts.length) % liNuts.length;
    liNuts.forEach(function(t, i){
      var on = i === li;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });
    liKhungs.forEach(function(pn, i){ pn.classList.toggle('on', i === li); });
  }
  function liChay(){
    if (!liTimer && !RM && liNuts.length > 1) liTimer = setInterval(function(){ liDen(li + 1); }, 5600);
  }
  function liNgung(){ if (liTimer) { clearInterval(liTimer); liTimer = null; } }
  liNuts.forEach(function(t, i){
    /* Bấm chỉ ĐẶT LẠI đồng hồ, không dừng hẳn — cùng lý do như băng sản phẩm: dừng vĩnh
       viễn thì bấm thử một cái là băng chết, và trông y hệt một băng hỏng. */
    t.addEventListener('click', function(){ liDen(i); liNgung(); liChay(); });
    t.addEventListener('keydown', function(e){
      var d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1
            : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault(); liNgung(); liDen(li + d); liNuts[li].focus(); liChay();
    });
  });
  var liP = D.getElementById('liPrev'), liN = D.getElementById('liNext');
  if (liP) liP.addEventListener('click', function(){ liDen(li - 1); liNgung(); liChay(); });
  if (liN) liN.addEventListener('click', function(){ liDen(li + 1); liNgung(); liChay(); });
  if (liThe) {
    liThe.addEventListener('mouseenter', liNgung);
    liThe.addEventListener('mouseleave', liChay);
    liThe.addEventListener('focusin', liNgung);
    liThe.addEventListener('focusout', function(e){ if (!liThe.contains(e.relatedTarget)) liChay(); });
  }
  /* Chỉ chạy khi khối trong tầm mắt — chạy dưới đáy trang thì tới nơi đã nhảy mất mấy mục. */
  function liTrongTam(){
    if (!liThe) return;
    var r = liThe.getBoundingClientRect();
    if (r.top < innerHeight * 0.85 && r.bottom > innerHeight * 0.15) liChay(); else liNgung();
  }

  /* ── MỤC NGÀNH HÀNG: băng thẻ lướt ngang, có lọc theo ngành ──────────────── */
  var nhRay = D.getElementById('nhRay'),
      nhThes = nhRay ? [].slice.call(nhRay.querySelectorAll('.lp-nh')) : [],
      nhLocs = [].slice.call(D.querySelectorAll('.lp-nh-loc .lp-chip')),
      nhP = D.getElementById('nhPrev'), nhN = D.getElementById('nhNext'),
      nhDem = D.getElementById('nhDem'), nhTimer = null, nhHen = null,
      nhBongs = [], nhTrong = false, nhTro = false, nhNet = false, nhCham = false;
  /* Bản bóng tạo vòng lặp liền mạch: khi nửa thứ hai tới đúng vị trí của nửa đầu,
     scrollLeft được chuẩn hoá mà mắt vẫn thấy cùng một thẻ. Bản bóng không tham gia
     bộ đếm, bộ lọc hay cây trợ năng. */
  if (nhRay && nhThes.length > 1) {
    nhThes.forEach(function(t){
      var b = t.cloneNode(true);
      b.classList.add('lp-nh-bong');
      b.setAttribute('aria-hidden', 'true');
      nhRay.appendChild(b); nhBongs.push(b);
    });
  }
  /* Thẻ đang HIỆN, không phải toàn bộ thẻ: lọc xong mà vẫn đếm theo mảng gốc thì
     bộ đếm nói "3 / 12" trong khi băng chỉ còn 1 thẻ. */
  function nhHien(){ return nhThes.filter(function(e){ return !e.hidden; }); }
  /* Vị trí đọc TỪ scrollLeft THẬT, không giữ một biến chỉ số riêng: người dùng vuốt
     tay hoặc kéo thanh cuộn thì biến kia lệch ngay, và mũi tên nhảy về chỗ cũ. */
  function nhDoDaiVong(){
    var ds = nhHien(); if (!ds.length || !nhBongs.length) return 0;
    var i = nhThes.indexOf(ds[0]), b = nhBongs[i];
    return b && !b.hidden ? b.offsetLeft - ds[0].offsetLeft : 0;
  }
  function nhChuanHoa(){
    var dai = nhDoDaiVong();
    if (nhRay && dai > 0 && nhRay.scrollLeft >= dai) nhRay.scrollLeft -= dai;
  }
  function nhChiSo(){
    var ds = nhHien(); if (!ds.length || !nhRay) return 0;
    var x = nhRay.scrollLeft, dai = nhDoDaiVong(), k = 0, gan = Infinity;
    if (dai > 0) x %= dai;
    for (var i = 0; i < ds.length; i++) {
      var d = Math.abs(ds[i].offsetLeft - nhRay.offsetLeft - x);
      if (d < gan) { gan = d; k = i; }
    }
    return k;
  }
  function nhVe(){
    if (!nhRay) return;
    var ds = nhHien(), k = nhChiSo();
    /* Bộ đếm nói vị trí; mũi tên KHÔNG bị khoá ở hai đầu. Khoá mũi tên "sau" ở thẻ cuối
       trong khi đồng hồ tự chạy vẫn quay về đầu là hai lời nói ngược nhau trên cùng một
       băng — và một nút mờ đi ngay lúc người ta đang bấm liên tục trông như trang lỗi. */
    if (nhDem) nhDem.textContent = (ds.length ? k + 1 : 0) + ' / ' + ds.length;
  }
  function nhDen(k, tuc){
    var ds = nhHien(); if (!nhRay || !ds.length) return;
    k = (k + ds.length) % ds.length;
    nhRay.scrollTo({ left: ds[k].offsetLeft - nhRay.offsetLeft, behavior: (tuc || RM) ? 'instant' : 'smooth' });
    nhVe();
  }
  function nhBuoc(d){
    var ds = nhHien(); if (!nhRay || !ds.length) return;
    nhChuanHoa();
    nhDen(nhChiSo() + d);
  }
  function nhNhip(){
    var dai = nhDoDaiVong(); if (!nhRay || dai <= 0) return;
    nhRay.scrollLeft += 1;
    if (nhRay.scrollLeft >= dai) nhRay.scrollLeft -= dai;
  }
  function nhDangDung(){ return nhTro || nhNet || nhCham; }
  function nhChay(){
    if (!nhTimer && !RM && nhTrong && !nhDangDung() && nhRay && nhHien().length > 1) {
      nhRay.classList.add('nh-tu-chay');
      nhTimer = setInterval(nhNhip, 24);
    }
  }
  function nhNgung(){
    if (nhTimer) { clearInterval(nhTimer); nhTimer = null; }
    if (nhRay) nhRay.classList.remove('nh-tu-chay');
  }
  function nhHenChay(){
    if (nhHen) clearTimeout(nhHen);
    nhHen = setTimeout(function(){ nhHen = null; nhChay(); }, 700);
  }
  /* Thao tác tay được ưu tiên; băng tiếp tục tự chạy sau khi hiệu ứng chuyển thẻ xong. */
  function nhTay(d){ nhNgung(); nhBuoc(d); nhHenChay(); }
  if (nhP) nhP.addEventListener('click', function(){ nhTay(-1); });
  if (nhN) nhN.addEventListener('click', function(){ nhTay(1); });
  if (nhRay) {
    nhRay.addEventListener('scroll', nhVe, { passive: true });
    nhRay.addEventListener('mouseenter', function(){ nhTro = true; nhNgung(); });
    nhRay.addEventListener('mouseleave', function(){ nhTro = false; nhChay(); });
    nhRay.addEventListener('focusin', function(){ nhNet = true; nhNgung(); });
    nhRay.addEventListener('focusout', function(e){
      if (!nhRay.contains(e.relatedTarget)) { nhNet = false; nhChay(); }
    });
    /* Vuốt tay: dừng hẳn đồng hồ trong lúc ngón còn trên màn, rồi chạy lại. Không có
       nhánh này thì đang vuốt dở bị đồng hồ giật băng về chỗ khác. */
    nhRay.addEventListener('touchstart', function(){ nhCham = true; nhNgung(); }, { passive: true });
    nhRay.addEventListener('touchend', function(){ nhCham = false; nhHenChay(); }, { passive: true });
    nhRay.addEventListener('keydown', function(e){
      var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault(); nhTay(d);
    });
  }
  nhLocs.forEach(function(b){
    b.addEventListener('click', function(){
      var k = b.dataset.loc || '';
      nhLocs.forEach(function(o){ o.setAttribute('aria-pressed', String(o === b)); });
      nhThes.forEach(function(t){ t.hidden = !!k && t.dataset.nh !== k; });
      nhBongs.forEach(function(t, i){ t.hidden = nhThes[i].hidden; });
      if (nhRay) nhRay.scrollTo({ left: 0, behavior: 'instant' });
      nhVe(); nhNgung(); nhChay();
    });
  });
  function nhTrongTam(){
    if (!nhRay) return;
    var r = nhRay.getBoundingClientRect();
    nhTrong = r.top < innerHeight * 0.9 && r.bottom > innerHeight * 0.1;
    if (nhTrong) nhChay(); else nhNgung();
  }

  /* ── THANH CTA NỔI ───────────────────────────────────────────────────────── */
  var dk = D.getElementById('lpDock'), rp = D.getElementById('lpReopen'),
      KEY = 'lp-dock-dong', thayCuoi = false;
  function daDong(){
    try {
      var t = Number(localStorage.getItem(KEY) || 0);
      return t > 0 && (Date.now() - t) < 864e5;      // nhớ 24 giờ
    } catch (e) { return false; }
  }
  var dong = daDong();
  if (dong && rp) rp.classList.add('on');
  /* "Đã tới cuối trang" đo bằng KHOẢNG CÁCH TỚI ĐÁY TÀI LIỆU, không bằng việc khối CTA
     cuối có nằm trong khung nhìn hay không. Đo được: ở 390px chân trang xếp dọc nên cao
     hơn hẳn, tới đáy thì khối CTA đã trôi hết lên trên — phép đo cũ kết luận "chưa tới
     cuối" và thanh nổi vẫn đè lên chính cái nút mà chân trang đang mời bấm. Khoảng cách
     tới đáy thì không phụ thuộc bố cục nào. */
  function dockPos(){
    thayCuoi = (root.scrollHeight - (scrollY + innerHeight)) < innerHeight * 0.9;
  }
  function dock(){
    var h = root.scrollHeight - innerHeight;
    var qua = h > 0 && (scrollY / h) > 0.35;
    dk.classList.toggle('on', qua && !dong && !thayCuoi);
    rp.classList.toggle('on', qua && dong && !thayCuoi);
  }
  D.getElementById('lpDockX').addEventListener('click', function(){
    dong = true;
    try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {}
    dock();
  });
  rp.addEventListener('click', function(){
    dong = false;
    try { localStorage.removeItem(KEY); } catch (e) {}
    dock();
  });
  /* Bàn phím ảo mở (đang gõ vào một ô) thì thanh dán đáy che mất ô đang gõ. */
  addEventListener('focusin', function(e){
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) dk.hidden = true;
  });
  addEventListener('focusout', function(){ dk.hidden = false; });

  spNhip(); spTrongTam(); liTrongTam(); nhVe(); nhTrongTam();
  rvScan(); rvXQuet(); dockPos(); dock();
})();
`;

const MK = {
  ok: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5.2 5.2L20 7"/></svg>`,
  mid: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"><path d="M5 12h14"/></svg>`,
  no: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
};
const MK_SR = { ok: 'Có', mid: 'Một phần', no: 'Không' };
const AR = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>`;

export function renderLanding({ contactEmail = 'lienhe@nentang.vn', contactPhone = '', brand = 'TikFlash', assets = new Map(), nonce = '' } = {}) {
  // Ảnh THẬT tuỳ chọn: thả file vào apps/storefront/src/assets/ (vd hero.webp) → hiện ảnh
  // thật; chưa có file → dùng khung dựng bằng CSS. Không có nhánh nào làm vỡ bố cục.
  const assetSrc = (base) => { for (const e of ['webp', 'avif', 'png', 'jpg', 'jpeg', 'svg']) { const f = base + '.' + e; if (assets && assets.has && assets.has(f)) return '/assets/' + f; } return null; };
  const heroShot = assetSrc('hero');
  const mailto = (subj) => mailtoHref(contactEmail, subj);

  const nhieuBanner = BANNERS.length > 1;

  const brandMark = `<span class="mk">${I.store}</span>${esc(brand)}`;

  const header = `<header class="lp-hdr" id="lpHdr">
  <div class="ct"><div class="lp-pill">
    <a class="lp-brand" href="/" aria-label="${esc(brand)} — trang chủ">${brandMark}</a>
    <nav class="lp-nav" aria-label="Điều hướng chính">${NAV.map((n) => `<a href="${n.href}">${esc(n.label)}</a>`).join('')}</nav>
    <div class="lp-hdr-act">
      <a class="lp-login" href="${ADMIN_LOGIN_URL}">${I.user}<span>Đăng nhập</span></a>
      <a class="lp-btn lp-b-pri" href="${SIGNUP_URL}">Dùng thử miễn phí</a>
      <button class="lp-burger" id="lpBurger" type="button" aria-label="Mở menu" aria-expanded="false" aria-controls="lpDrawer">
        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
      </button>
    </div>
  </div></div>
</header>
<div class="lp-scrim" id="lpScrim" hidden></div>
<div class="lp-drawer" id="lpDrawer" role="dialog" aria-modal="true" aria-label="Menu" hidden>
  <button class="x" id="lpDx" type="button" aria-label="Đóng menu">
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
  </button>
  ${NAV.map((n) => `<a href="${n.href}">${esc(n.label)}</a>`).join('')}
  <a href="${ADMIN_LOGIN_URL}">Đăng nhập quản trị</a>
  <a class="lp-btn lp-b-pri" href="${SIGNUP_URL}">Dùng thử miễn phí</a>
</div>`;

  // Hero: slide ĐẦU mang class "on" ngay từ server — không JS thì nó vẫn là slide đang hiện,
  // đủ tiêu đề, đủ mô tả, đủ nút. Các slide sau chỉ là bổ sung.
  const slide = (b, k) => `<div class="lp-slide${k === 0 ? ' on' : ''}" role="group" aria-roledescription="banner" aria-label="Banner ${k + 1} trên ${BANNERS.length}">
      <h${k === 0 ? 1 : 2}>${esc(b.h)}</h${k === 0 ? 1 : 2}>
      <p class="lead">${esc(b.d)}</p>
      <a class="lp-btn lp-knob" href="${esc(b.href)}">${esc(b.cta)}<i>${AR}</i></a>
    </div>`;

  const hero = `<section class="lp-hero lp-dark" id="lpHero"${nhieuBanner ? ' aria-roledescription="carousel" aria-label="Giới thiệu nền tảng"' : ''}>
  <div class="ct">
    <div class="lp-hero-g">
      <div>
        ${BANNERS.map(slide).join('')}
        <div class="lp-trust">
          <span>${I.check}14 ngày dùng thử miễn phí</span>
          <span>${I.check}Không cần thẻ</span>
          <span>${I.wallet}Chúng tôi không giữ tiền của bạn</span>
        </div>
      </div>
      <div class="lp-stage">
        <div class="lp-lap">
          <div class="bar"><i></i><i></i><i></i><span class="u">shop.nentang.vn</span></div>
          <div class="scr">${heroShot ? `<img class="lp-shot" src="${esc(heroShot)}" alt="Ảnh giao diện cửa hàng trên nền tảng" loading="eager" width="800" height="520">` : VIS.dash}</div>
        </div>
        <div class="lp-float lp-f-pay"><span class="ic">${I.qr}</span><div><b>+350.000đ VietQR</b><span>vào tài khoản của bạn</span></div></div>
        <div class="lp-float lp-f-noti"><span class="ic">${I.bell}</span><div><b>Đơn hàng mới +1</b><span>vừa xong</span></div></div>
      </div>
    </div>
    ${nhieuBanner ? `<div class="lp-ctl">
      <p class="lp-count"><b id="lpCur">01</b> / ${String(BANNERS.length).padStart(2, '0')}</p>
      <div class="lp-ctl-r">
        <button class="lp-pause" id="lpPause" type="button" aria-pressed="false" aria-label="Tạm dừng băng giới thiệu">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
        </button>
        <div class="lp-dots" role="group" aria-label="Chọn banner">
          ${BANNERS.map((b, k) => `<button type="button" aria-current="${k === 0}" aria-label="Banner ${k + 1}: ${esc(b.h)}"></button>`).join('')}
        </div>
        <div class="lp-arr">
          <button id="lpPrev" type="button" aria-label="Banner trước"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H6M11 6l-6 6 6 6"/></svg></button>
          <button id="lpNext" type="button" aria-label="Banner sau"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg></button>
        </div>
      </div>
    </div>` : ''}
  </div>
</section>`;

  // Khe ảnh của mục so sánh. Thả tệp vào apps/storefront/src/assets/ (so-sanh.webp,
  // .png, .jpg…) là ảnh hiện ngay dưới tiêu đề. Chưa có tệp thì KHÔNG dựng gì cả —
  // không để lại khoảng trống hay khung viền rỗng.
  const soSanhShot = assetSrc('so-sanh');
  const cmpImg = soSanhShot
    ? `<figure class="lp-cmp-img rv" aria-hidden="true"><img src="${esc(soSanhShot)}" alt="" loading="lazy" decoding="async"></figure>`
    : '';

  const o = (kind, cot, mark, html) => `<td${kind === 0 ? ' class="us"' : ''} data-label="${esc(cot)}">
        <span class="lp-cell"><span class="lp-mk ${mark}" aria-hidden="true">${MK[mark]}</span><span><span class="lp-sr">${MK_SR[mark]} — </span>${html}</span></span>
      </td>`;
  const cmp = `<section class="lp-sec lp-cmp${soSanhShot ? ' co-anh' : ''}" id="loi-ich" aria-labelledby="lpCmpH"><div class="ct">
  <div class="lp-head lp-head-mid rv">
    <h2 class="lp-h2" id="lpCmpH">Cùng một đơn hàng, <em>ai giữ lại bao nhiêu?</em></h2>
  </div>
  ${cmpImg}
  <div class="lp-cmp-w rv">
    <table class="lp-tbl">
      <caption class="lp-sr">So sánh ${esc(brand)} với nền tảng website phổ thông và sàn thương mại điện tử</caption>
      <thead><tr>
        <th scope="col" class="crit">Tiêu chí</th>
        <th scope="col" class="us">${esc(CMP_COLS[0])} <span class="lp-badge">Chúng tôi</span></th>
        <th scope="col">${esc(CMP_COLS[1])}</th>
        <th scope="col">${esc(CMP_COLS[2])}</th>
      </tr></thead>
      <tbody>${CMP.map((r) => `<tr><th scope="row">${esc(r[0])}</th>${r.slice(1).map((c, k) => o(k, CMP_COLS[k], c[0], c[1])).join('')}</tr>`).join('')}</tbody>
    </table>
  </div>
  <p class="lp-note rv">Mức phí và chính sách của nền tảng khác thay đổi theo ngành hàng, gói dịch vụ và từng chương trình — bảng này mô tả cách vận hành phổ biến, không phải báo giá của bên thứ ba. Cột ${esc(CMP_COLS[0])} là cam kết của chúng tôi và được hệ thống cưỡng chế.</p>
</div></section>`;

  // Hai bản dựng từ CÙNG một nguồn (PRODUCTS + VIS): bản trong dòng cho màn hẹp và trình
  // duyệt chưa hỗ trợ, bản dán dính cho màn rộng. Chép tay ra hai chỗ thì chúng sẽ trôi.
  // Mỗi mục sản phẩm có KHE ẢNH riêng: thả sp-<khoá>.webp (hoặc .png/.jpg/.avif/.svg)
  // vào apps/storefront/src/assets/ là ảnh thay khung minh hoạ dựng bằng CSS. Chưa có tệp
  // thì dùng khung CSS — không nhánh nào để lại ô trống chờ ảnh.
  const spHinh = (x) => {
    const f = assetSrc('sp-' + x.key);
    return f
      ? `<img class="lp-pv-img" src="${esc(f)}" alt="" loading="lazy" decoding="async">`
      : `<div class="lp-pv-mock">${VIS[x.vis]}</div>`;
  };

  // NÚT bên trái — bộ tab THẬT (role=tab), không phải thẻ trang trí: đi được bằng bàn
  // phím, và trình đọc màn hình biết mục nào đang mở.
  const prodTab = (x, k) => `<button class="lp-tab${k === 0 ? ' on' : ''}" type="button" data-i="${k}" role="tab" id="spT${k}" aria-controls="spP${k}" aria-selected="${k === 0}" tabindex="${k === 0 ? 0 : -1}">
    <span class="ic">${x.icon}</span>
    <span class="tx">
      <span class="t">${esc(x.kick)}</span>
      <span class="h">${esc(x.h)}</span>
      <span class="b">${x.bullets.slice(0, 3).map((b) => `<span>${esc(b)}</span>`).join('')}</span>
    </span>
  </button>`;

  const prodBong = (x, k) => `<div class="lp-tab bong" data-i="${k}">
    <span class="ic">${x.icon}</span>
    <span class="tx">
      <span class="t">${esc(x.kick)}</span>
      <span class="h">${esc(x.h)}</span>
      <span class="b">${x.bullets.slice(0, 3).map((b) => `<span>${esc(b)}</span>`).join('')}</span>
    </span>
  </div>`;

  // KHUNG bên phải: ảnh ở trên, nội dung của đúng mục đang mở ở dưới.
  const prodPanel = (x, k) => `<div class="lp-panel${k === 0 ? ' on' : ''}" id="spP${k}" role="tabpanel" aria-labelledby="spT${k}">
    <div class="lp-pv">${spHinh(x)}</div>
    <div class="lp-pd">
      <p class="k">${esc(x.kick)}</p>
      <h3>${esc(x.h)}</h3>
      <p class="d">${esc(x.d)}</p>
      <ul>${x.bullets.map((b) => `<li>${I.check}<span>${esc(b)}</span></li>`).join('')}</ul>
    </div>
  </div>`;
  const prod = `<section class="lp-sec lp-prod" id="san-pham" aria-labelledby="lpProdH"><div class="ct">
  <div class="lp-head lp-head-mid rv"><p class="lp-eb">Sản phẩm</p>
  <h2 class="lp-h2" id="lpProdH">Thứ bạn <em>dùng mỗi ngày</em></h2>
  <p class="lp-sub">Các tính năng chính của nền tảng bán hàng.</p></div>
  <div class="lp-showcase rv">
    <div class="lp-tabs">
      <div class="lp-track">
        <div class="lp-set" role="tablist" aria-label="Chọn nhóm tính năng" aria-orientation="vertical">
          ${PRODUCTS.map(prodTab).join('')}
        </div>
        <div class="lp-set" aria-hidden="true">${PRODUCTS.map(prodBong).join('')}</div>
      </div>
    </div>
    <div class="lp-panes">
      ${PRODUCTS.map(prodPanel).join('')}
      <div class="lp-pnav">
        <p class="lp-pcount"><b id="spCur">01</b> / ${String(PRODUCTS.length).padStart(2, '0')}</p>
        <div class="lp-pdots" aria-hidden="true">${PRODUCTS.map((x, k) => `<span${k === 0 ? ' class="on"' : ''}></span>`).join('')}</div>
      </div>
    </div>
  </div>
</div></section>`;

  // Khe ảnh cho từng khối giải pháp: thả gp-<khoá>.webp (hoặc .png/.jpg/.avif/.svg) vào
  // apps/storefront/src/assets/ — gp-duong-tien, gp-chong-that-thoat, gp-khach-quen,
  // gp-an-toan. Chưa có tệp thì dùng khung minh hoạ CSS, không để lại ô trống chờ ảnh.
  const gpHinh = (f) => {
    const t = assetSrc('gp-' + f.key);
    return t
      ? `<img class="lp-flag-img" src="${esc(t)}" alt="" loading="lazy" decoding="async">`
      : VIS[f.vis];
  };
  const grow = `<section class="lp-sec lp-grow" id="giai-phap" aria-labelledby="lpGrowH"><div class="ct">
  <div class="lp-head lp-head-mid rv"><p class="lp-eb">Giải pháp tăng trưởng</p>
  <h2 class="lp-h2" id="lpGrowH">Làm thật những việc <em>khó nhất</em></h2>
  <p class="lp-sub">Bốn chỗ mà người bán mất tiền nhiều nhất mà thường không nhìn thấy. Đây là cách chúng tôi chặn từ gốc.</p></div>
  ${FLAGS.map((f, k) => {
    // Hàng lẻ đảo bên (lp-flag.rev đẩy cột hình sang trái bằng order), nên hướng lướt
    // phải bám VỊ TRÍ THẤY ĐƯỢC chứ không bám thứ tự trong HTML — nếu không thì hàng đảo
    // sẽ có cột bên trái lướt vào từ bên phải, tức là bay ngang qua nhau.
    const dao = k % 2 === 1;
    return `<div class="lp-flag${dao ? ' rev' : ''}">
    <div class="rv-x ${dao ? 'rv-r' : 'rv-l'}"><p class="lp-kick2">${f.icon}${esc(f.kick)}</p><h3>${esc(f.h)}</h3><p class="d">${esc(f.d)}</p>
      <ul>${f.bullets.map((b) => `<li>${I.check}<span>${esc(b)}</span></li>`).join('')}</ul></div>
    <div class="lp-flag-v rv-x ${dao ? 'rv-l' : 'rv-r'}">${gpHinh(f)}</div>
  </div>`;
  }).join('')}
</div></section>`;

  // ── MỤC LỢI ÍCH ──────────────────────────────────────────────────────────
  const liHinh = (x) => {
    const t = assetSrc('li-' + x.key);
    return t
      ? `<img class="lp-lp-img" src="${esc(t)}" alt="" loading="lazy" decoding="async">`
      : `<div class="lp-lp-mock">${VIS[x.vis]}</div>`;
  };
  const liNut = (x, k) => `<button class="lp-li${k === 0 ? ' on' : ''}" type="button" data-li="${k}" role="tab" id="liT${k}" aria-controls="liP${k}" aria-selected="${k === 0}" tabindex="${k === 0 ? 0 : -1}">
    <span class="ic">${x.icon}</span>
    <span class="tx"><span class="t">${esc(x.t)}</span><span class="d">${esc(x.d)}</span></span>
  </button>`;
  const liKhung = (x, k) => `<div class="lp-lp${k === 0 ? ' on' : ''}" id="liP${k}" role="tabpanel" aria-labelledby="liT${k}">
    <p class="k">Lợi ích giải pháp</p>
    <h3>${esc(x.h)}</h3>
    <span class="gach" aria-hidden="true"></span>
    <div class="lp-lp-v">${liHinh(x)}</div>
  </div>`;
  const loiIch = `<section class="lp-sec lp-loi-sec" id="uu-diem" aria-labelledby="lpLoiH"><div class="ct">
  <div class="lp-head lp-head-mid rv">
  <h2 class="lp-h2" id="lpLoiH">Lợi ích ${esc(brand)} mang đến</h2>
  <p class="lp-sub">Bốn thứ người bán được thêm ngay từ ngày đầu, không phải chờ lên gói.</p></div>
  <div class="lp-loi rv">
    <button class="lp-loi-arr truoc" id="liPrev" type="button" aria-label="Lợi ích trước">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
    </button>
    <div class="lp-loi-l">
      <p class="lp-loi-brand lp-brand">${brandMark}</p>
      <div class="lp-loi-list" role="tablist" aria-label="Chọn lợi ích">${LOI_ICH.map(liNut).join('')}</div>
    </div>
    <div class="lp-loi-r">${LOI_ICH.map(liKhung).join('')}</div>
    <button class="lp-loi-arr sau" id="liNext" type="button" aria-label="Lợi ích sau">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
    </button>
  </div>
</div></section>`;

  // ── MỤC NGÀNH HÀNG ────────────────────────────────────────────────────────
  // Ảnh bìa của từng thẻ đọc từ khe `nh-<khoá>` — thả tệp vào apps/storefront/src/assets/
  // là thẻ đổi ảnh, không phải sửa mã. Chưa có tệp thì dựng khung xanh có biểu tượng
  // ngành, KHÔNG để ô trống: ô trống trên một băng 12 thẻ trông như trang hỏng.
  const nhAnh = (x, k) => {
    const t = assetSrc('nh-' + x.key);
    return `<div class="lp-nh-anh">${t
      ? `<img src="${esc(t)}" alt="Ảnh cửa hàng mẫu ngành ${esc(x.name)}" loading="lazy" decoding="async">`
      : `<div class="lp-nh-mock t${(k % 3) + 1}" aria-hidden="true">${x.icon}</div>`}</div>`;
  };
  const nhThe = (x, k) => `<article class="lp-nh" data-nh="${esc(x.key)}">
    ${nhAnh(x, k)}
    <div class="lp-nh-ndu">
      <p class="lp-nh-pill"><span class="i">${x.icon}</span>${esc(x.name)}</p>
      <h3>${esc(x.h)}</h3>
      <p class="d">${esc(x.d)}</p>
      <ul class="lp-nh-tg">${x.tags.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>
    </div>
  </article>`;
  const nhLoc = (x) => `<button class="lp-chip" type="button" data-loc="${esc(x.key)}" aria-pressed="false">
    <span class="i">${x.icon}</span>${esc(x.name)}</button>`;
  const ind = `<section class="lp-ind" id="nganh-hang" aria-labelledby="lpIndH"><div class="ct">
  <div class="lp-head lp-head-mid rv">
    <p class="lp-eb">Ngành hàng</p>
    <h2 class="lp-h2" id="lpIndH">Kinh doanh gì cũng dựng được cửa hàng hợp gu</h2>
    <p class="lp-sub">Mỗi ngành một cửa hàng mẫu dựng sẵn — đổi logo, màu và sản phẩm là thành của bạn.</p>
  </div>
</div>
  <div class="lp-nh-loc rv" role="group" aria-label="Lọc theo ngành hàng">
    <button class="lp-chip" type="button" data-loc="" aria-pressed="true"><span class="i">${I.store}</span>Tất cả</button>
    ${INDUSTRIES.map(nhLoc).join('')}
  </div>
  <div class="lp-nh-box rv">
    <div class="lp-nh-ray" id="nhRay" tabindex="0" role="region" aria-label="Cửa hàng mẫu theo ngành hàng">
      ${INDUSTRIES.map(nhThe).join('')}
    </div>
  </div>
  <div class="ct">
    <div class="lp-nh-dieu">
      <button class="lp-nh-arr" id="nhPrev" type="button" aria-label="Xem thẻ trước">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
      </button>
      <p class="lp-nh-dem" id="nhDem" aria-live="polite">1 / ${INDUSTRIES.length}</p>
      <button class="lp-nh-arr" id="nhNext" type="button" aria-label="Xem thẻ sau">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      </button>
    </div>
    <p class="lp-nh-note">Đây là cửa hàng <strong>mẫu</strong> do chúng tôi dựng theo từng ngành — chưa phải khách hàng thật. Khi có shop đồng ý cho nêu tên, mục này sẽ là họ.</p>
  </div>
</section>`;

  const price = `<section class="lp-sec lp-price" id="bang-gia" aria-labelledby="lpPriceH"><div class="ct">
  <div class="lp-head"><p class="lp-eb rv">Bảng giá</p>
  <h2 class="lp-h2 rv" id="lpPriceH">Đơn giản, minh bạch, <em>không phí ẩn</em></h2>
  <p class="lp-sub rv">Mọi gói đều bắt đầu bằng 14 ngày dùng thử miễn phí — không cần thẻ.</p></div>
  <div class="lp-plans">
    ${PLANS.map((p) => `<div class="lp-plan${p.hot ? ' hot' : ''} rv">
      ${p.hot ? '<div class="lp-hot-b">Phổ biến nhất</div>' : ''}
      <p class="tag">${esc(p.tagline)}</p>
      <h3>${esc(p.name)}</h3>
      <p class="pr">${esc(p.price)}<span>${esc(p.unit)}</span></p>
      <ul>${p.feat.map((f) => `<li>${I.check}<span>${esc(f)}</span></li>`).join('')}</ul>
      <a class="lp-btn ${p.hot ? 'lp-b-gh' : 'lp-b-pri'}" href="${SIGNUP_URL}">Dùng thử miễn phí 14 ngày</a>
    </div>`).join('')}
  </div>
  <p class="lp-plan-note rv">Chưa chắc chọn gói nào? <a href="${mailto('Tư vấn chọn gói dịch vụ')}">Nhận tư vấn miễn phí qua email</a> — có người thật trả lời.</p>
</div></section>`;

  const faq = `<section class="lp-sec lp-faq" id="faq" aria-labelledby="lpFaqH"><div class="ct">
  <div class="lp-head"><p class="lp-eb rv">Hỏi đáp</p>
  <h2 class="lp-h2 rv" id="lpFaqH">Câu hỏi thường gặp</h2></div>
  <div class="lp-faq-l">${FAQS.map((f) => `<details class="rv"><summary>${esc(f.q)}</summary><div class="ans">${esc(f.a)}</div></details>`).join('')}</div>
</div></section>`;

  const final = `<section class="lp-final"><div class="ct"><div class="lp-box lp-dark rv">
  <h2>Dễ bắt đầu · Dễ bán hàng · Dễ tăng trưởng</h2>
  <p>${STEPS.map((s) => esc(s.t)).join(' → ')}. Trải nghiệm miễn phí 14 ngày — không cần thẻ, huỷ lúc nào cũng được.</p>
  <div class="lp-box-r">
    <a class="lp-btn lp-knob" href="${SIGNUP_URL}">Bắt đầu miễn phí<i>${AR}</i></a>
    <a class="lp-btn lp-b-gh" href="${mailto('Tôi muốn được dựng cửa hàng giúp')}">Nhờ dựng giúp</a>
  </div>
  <p class="lp-box-c">${contactPhone ? `ĐT: ${esc(contactPhone)} · ` : ''}Email: ${esc(contactEmail)}</p>
</div></div></section>`;

  const footer = `<footer class="lp-ft"><div class="ct">
  <div class="lp-ft-g">
    <div class="lp-ft-ab">
      <a class="lp-brand" href="/">${brandMark}</a>
      <p>Nền tảng bán hàng online cho người Việt. Chúng tôi lo kỹ thuật, tiền khách trả vào thẳng tài khoản bạn.</p>
      <a class="lp-btn lp-b-pri" href="${SIGNUP_URL}">Dùng thử miễn phí 14 ngày</a>
    </div>
    <div class="lp-ft-c"><h3>Giải pháp</h3><a href="#san-pham">Sản phẩm</a><a href="#nganh-hang">Ngành hàng</a><a href="#bang-gia">Bảng giá</a><a href="${SIGNUP_URL}">Đăng ký dùng thử</a></div>
    <div class="lp-ft-c"><h3>Về chúng tôi</h3><a href="/gioi-thieu">Giới thiệu</a><a href="/blog">Blog</a><a href="${ADMIN_LOGIN_URL}">Đăng nhập quản trị</a></div>
    <div class="lp-ft-c"><h3>Hỗ trợ</h3><a href="/ho-tro">Trung tâm hỗ trợ</a><a href="/lien-he">Liên hệ</a><a href="${mailto('Cần hỗ trợ')}">${I.mail}${esc(contactEmail)}</a>${contactPhone ? `<span>${I.phone}${esc(contactPhone)}</span>` : ''}</div>
    <div class="lp-ft-c"><h3>Pháp lý</h3><a href="/dieu-khoan">Điều khoản dịch vụ</a><a href="/bao-mat">Chính sách bảo vệ dữ liệu</a></div>
  </div>
  <div class="lp-ft-b"><span>© ${esc(brand)} · Nền tảng bán hàng online cho người Việt.</span>
    <span><a href="/dieu-khoan">Điều khoản</a> · <a href="/bao-mat">Bảo mật</a> · <a href="/lien-he">Liên hệ</a></span></div>
</div></footer>`;

  // Thanh CTA nổi CHỈ dựng khi có nonce: không JS thì nó không bao giờ hiện được (mặc định
  // visibility:hidden), nên chèn vào chỉ là rác DOM và một nút Đóng không làm gì.
  const dock = nonce ? `<aside class="lp-dock" id="lpDock" aria-label="Ưu đãi">
  <div class="lp-dock-c"><div class="hd"><div class="t">
    <p class="t1">Miễn phí tạo shop</p>
    <p class="t2">Trọn bộ tính năng trong 14 ngày, không cần thẻ</p>
  </div>
  <button class="x" id="lpDockX" type="button" aria-label="Đóng">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
  </button></div>
  <a class="go" href="${SIGNUP_URL}">Đăng ký ngay${AR}</a></div>
</aside>
<button class="lp-reopen" id="lpReopen" type="button" aria-label="Mở lại ưu đãi">
  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h2l2.4 12.3a2 2 0 0 0 2 1.7h7.7a2 2 0 0 0 2-1.6L21 8H6"/><circle cx="10" cy="20" r="1"/><circle cx="17" cy="20" r="1"/></svg>
</button>` : '';

  const body = `<div class="lp">${header}<main id="main">${hero}${cmp}${prod}${loiIch}${grow}${ind}${price}${faq}${final}</main>${footer}${dock}</div>`;

  return sitePage({
    title: `${esc(brand)} — Nền tảng website bán hàng cho người Việt, tiền về thẳng tài khoản bạn`,
    description: 'Dựng cửa hàng online trong 3 phút, dùng thử miễn phí 14 ngày. Đơn hàng, vận chuyển GHN/GHTK, kho, khuyến mãi, thanh toán COD + VietQR vào thẳng tài khoản bạn — không cần biết code.',
    brand, contactEmail, contactPhone, extraCss: CSS, body, shell: false, nonce, js: JS,
  });
}
