/**
 * Hợp đồng MÃ NGUỒN cho khối sản phẩm của trang chủ + ba chốt chống tràn ngang.
 *
 * Vì sao là chốt mã nguồn chứ không phải chốt dựng-layout: đo bố cục cần trình duyệt thật
 * ở bề rộng thật (headless_shell, vì `chrome --headless` bỏ qua --window-size và luôn dựng
 * 500px). Cổng CI không có sẵn thứ đó, nên bộ này neo vào những DÒNG mà nếu mất đi thì lỗi
 * đã đo được sẽ quay lại. Ba con số dưới đây đều lấy từ phép đo thật, không phải ước lượng.
 *
 * Lỗi đã đo trên bản trước (headless_shell, so scrollWidth với clientWidth):
 *   360px  sw 495/345 — .vrow là flex một dòng, bề rộng tối thiểu 391px kéo min-content của
 *                       .vis lên 429px; ô lưới mặc định min-width:auto nên cột không co được.
 *   768px  sw 771/753 — trạng thái ĐẦU của .srl/.srr dịch ngang 42px, nằm ngoài mép phải.
 *   1024px sw 1143/1009 — ba thẻ giá giữ 3 cột tới 960px; min-content mỗi thẻ 356px.
 *
 * Và hai chốt riêng của khối sản phẩm, mỗi cái ứng với một cách hỏng đã gặp:
 *   · mốc bố cục dán dính phải ≥1100px — ở 1024px cột phải chỉ rộng ~457px trong khi khung
 *     minh hoạ cần 496px, đặt mốc 961px thì tràn đúng 15px;
 *   · animation theo cuộn phải khai linear — easing mặc định là `ease`, đo được nó khiến
 *     khung kề còn mở 54% ngay lúc khung chính đã 100%, tức chồng hai hình lên nhau.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/landing.js', import.meta.url), 'utf8');
const SERVER = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
// CSS đã CẮT CHÚ THÍCH. Chú thích ở file này mô tả chính những quy tắc từng gây lỗi, nên
// khớp regex trên toàn văn bản là khớp phải lời kể chứ không phải luật đang chạy — một chốt
// đã đỏ giả vì đúng chuyện đó, và cùng lỗi ở chiều ngược lại thì XANH GIẢ.
const LUAT = SRC.replace(/\/\*[\s\S]*?\*\//g, '');

test('khối sản phẩm: nút bên trái, khe hình + nội dung bên phải', () => {
  assert.match(SRC, /const prodTab = \(x, k\) =>/, 'thiếu bộ dựng nút bên trái');
  assert.match(SRC, /const prodBong = \(x, k\) =>/, 'thiếu bộ dựng bản bóng để chạy vòng');
  assert.match(SRC, /const prodPanel = \(x, k\) =>/, 'thiếu bộ dựng khung bên phải');
  assert.equal((SRC.match(/PRODUCTS\.map\(/g) ?? []).length, 4,
    'nút, bản bóng, khung và chấm điều hướng đều dựng từ CÙNG mảng PRODUCTS');
  assert.match(SRC, /role="tab" id="spT\$\{k\}" aria-controls="spP\$\{k\}"/, 'nút phải là tab thật');
  assert.match(SRC, /role="tabpanel" aria-labelledby="spT\$\{k\}"/, 'khung phải là tabpanel thật');
  // Bản bóng chỉ để MẮT thấy băng chạy vòng: không phải nút, không id, không nhận tiêu
  // điểm. Nếu là button thì trình đọc màn hình nghe mọi mục hai lần và Tab đi vào bản sao.
  assert.match(SRC, /<div class="lp-tab bong" data-i="\$\{k\}">/, 'bản bóng phải là div trơ');
  assert.match(SRC, /<div class="lp-set" aria-hidden="true">/, 'bản bóng phải ẩn khỏi cây trợ năng');
});

test('mỗi mục sản phẩm có khe ảnh riêng', () => {
  assert.match(SRC, /const f = assetSrc\('sp-' \+ x\.key\)/, 'thiếu khe ảnh theo khoá của từng mục');
  // Đếm trong ĐÚNG mảng PRODUCTS, không đếm cả file: FLAGS cũng có khoá tra ảnh riêng,
  // đếm toàn văn bản thì con số trôi mỗi lần thêm khe ảnh ở mục khác.
  const khoiSP = SRC.slice(SRC.indexOf('const PRODUCTS = ['), SRC.indexOf('const INDUSTRIES = ['));
  assert.equal((khoiSP.match(/key: '/g) ?? []).length, 5, 'cả năm mục sản phẩm phải có khoá tra ảnh');
  // Chưa có tệp thì dùng khung minh hoạ CSS — KHÔNG để lại ô trống chờ ảnh.
  assert.match(SRC, /: `<div class="lp-pv-mock">\$\{VIS\[x\.vis\]\}<\/div>`/,
    'thiếu nhánh dự phòng khi chưa có tệp ảnh');
  // Khe hình phải có tỉ lệ cố định, nếu không đổi mục là khung nhảy chiều cao.
  assert.match(LUAT, /\.lp-pv\{[^}]*aspect-ratio:16\/10/, 'khe hình phải khoá tỉ lệ');
});

test('cột nút TRƯỢT như thang máy, hai cột cao bằng nhau', () => {
  assert.match(LUAT, /\.lp-showcase\{grid-template-columns:minmax\(0,5fr\) minmax\(0,7fr\);gap:24px;align-items:stretch\}/,
    'lưới hai cột phải kéo hai bên bằng nhau');
  // MẤU CHỐT của thang máy: ray phải RA KHỎI DÒNG CHẢY. Để nó trong dòng chảy thì chính
  // nó kéo chiều cao hàng lưới lên bằng chiều cao cả năm nút, khung cắt cao đúng bằng nội
  // dung, phần tràn bằng 0 — và thang máy đứng im. Đo được đúng như vậy trước khi vá:
  // khung 1079 = ray 1079, trượt 0px ở cả năm mục.
  assert.match(LUAT, /html\.lpjs \.lp-track\{position:absolute;inset:0 0 auto 0;/,
    'ray phải đặt tuyệt đối, nếu không nó tự kéo chiều cao hàng và thang máy đứng im');
  assert.match(LUAT, /html\.lpjs \.lp-tabs\{position:relative;overflow:hidden;/,
    'khung cắt phải là gốc toạ độ và phải cắt');
  assert.match(LUAT, /html\.lpjs \.lp-tabs\{[^}]*mask-image:linear-gradient\(180deg,transparent/,
    'hai mép phải mờ dần, cho biết danh sách còn tiếp');
  // Chiều cao khung KHÔNG đặt bằng JS: stretch đã cho đúng chiều cao cột phải, đặt tay
  // là thêm một chỗ có thể trôi lệch.
  assert.doesNotMatch(SRC, /spBox\.style\.height = Math\.round/,
    'không đặt chiều cao khung bằng JS — để align-items:stretch lo');
  // Mọi nút đều hiện gạch đầu dòng: chỉ nút đang mở mới có thì chiều cao nhảy loạn mỗi
  // lần đổi mục, và đó chính là thứ làm "tỉ lệ không khớp".
  assert.match(LUAT, /\.lp-tab \.b\{display:block;margin-top:10px\}/,
    'mọi nút phải hiện gạch đầu dòng để chiều cao đồng đều');
  // Không làm mờ nút chưa mở: chữ mờ 50% đọc mệt và trông như bị vô hiệu hoá. Phân biệt
  // bằng bóng đổ, ô biểu tượng và màu tên mục là đủ.
  assert.doesNotMatch(LUAT, /html\.lpjs \.lp-tab\{opacity:/,
    'không được làm mờ nút chưa mở');
});

test('thang máy CUỘN LIÊN TỤC, mối nối trùng khít', () => {
  // Bản nhảy-từng-nấc đo ra: ray đứng ở 0, 0, −154, −329, −295px cho năm mục — mục 1 và
  // 2 CÙNG một chỗ, mục 4 và 5 CÙNG một chỗ, tức 2/4 nhịp không nhúc nhích. Chủ dự án
  // nhìn vào đúng là "đứng im". Nay ray chạy đều không nghỉ.
  assert.match(LUAT, /html\.lpjs \.lp-track\{animation:lp-thang var\(--lp-tg,28s\) linear infinite\}/,
    'ray phải chạy animation liên tục, tuyến tính, vô hạn');
  assert.doesNotMatch(SRC, /transition:transform 520ms/, 'không còn cơ chế nhảy từng nấc');
  // Quãng đường một vòng KHÔNG dùng -50%: đo được ray cao 2291px nên nửa ray là 1146px
  // trong khi một bộ thẻ chỉ cao 1079px — lề dưới thẻ cuối bị thu ra ngoài chiều cao bộ,
  // hai số lệch 67px và mỗi vòng giật đúng ngần ấy.
  assert.match(LUAT, /@keyframes lp-thang\{from\{transform:translateY\(0\)\}to\{transform:translateY\(var\(--lp-dy,-1000px\)\)\}\}/,
    'quãng đường phải lấy từ biến đo được, không dùng -50%');
  assert.match(SRC, /var dy = spBo2\.offsetTop - spBo\.offsetTop;/,
    'chu kỳ lặp phải đo bằng KHOẢNG CÁCH THẬT giữa đỉnh hai bộ');
  assert.match(SRC, /Math\.max\(12, Math\.round\(dy \/ 38\)\)/,
    'nhịp tính theo chiều cao thật để thêm bớt mục không làm băng nhanh chậm đi');
  // Dừng khai bằng CSS: không handler, không trạng thái JS nào để trôi lệch.
  assert.match(LUAT, /html\.lpjs \.lp-tabs:hover \.lp-track,\s*\n\s*html\.lpjs \.lp-showcase:focus-within \.lp-track\{animation-play-state:paused\}/,
    'phải dừng khi trỏ vào cột nút hoặc có tiêu điểm bàn phím');
  assert.match(LUAT, /@media\(prefers-reduced-motion:no-preference\)\{\s*\n\s*html\.lpjs \.lp-track\{animation:/,
    'băng chỉ chạy khi người dùng không chọn giảm chuyển động');
});

test('thẻ trôi qua GIỮA khung thì sáng, và khung bên phải đổi theo', () => {
  assert.match(SRC, /var b = spBox\.getBoundingClientRect\(\), tam = b\.top \+ b\.height \/ 2;/,
    'phải lấy thẻ gần TÂM khung nhất');
  // Đọc vị trí thật thay vì tự tính từ tiến độ animation: animation chạy trên luồng dựng
  // hình, tự tính thì sớm muộn cũng lệch khỏi thứ mắt đang thấy.
  assert.match(SRC, /setInterval\(spQuet, 140\)/, 'thiếu vòng quét vị trí');
  assert.doesNotMatch(SRC, /requestAnimationFrame\(spQuet\)/,
    'không dùng requestAnimationFrame: đo được nó chỉ chạy 2 lần trong cả một giây ở môi trường không vẽ đều');
  // Bấm được cả trên bản bóng: chỉ bản thật ăn thì một nửa số thẻ trôi qua mắt bấm không
  // có phản ứng, và người dùng không đoán ra vì sao.
  assert.match(SRC, /spRay\.addEventListener\('click', function\(e\)\{\s*\n\s*var t = e\.target\.closest\('\.lp-tab'\);/,
    'bấm phải nhận trên cả bản bóng');
  assert.match(SRC, /spBox\.addEventListener\('mouseleave', function\(\)\{ spKhoa = -1; \}\)/,
    'phải mở khoá khi trỏ rời cột nút, nếu không băng trôi mà khung bên phải đứng yên mãi');
  assert.match(SRC, /spWrap\.classList\.toggle\('ngu'/, 'phải ngủ khi khối ra khỏi tầm mắt');
});

test('bản bóng chỉ tồn tại khi thang máy đang chạy', () => {
  // Đo được: ở khung 390px bản bóng vẫn hiện nên người dùng thấy đủ năm mục HAI LẦN.
  assert.match(LUAT, /html:not\(\.lpjs\) \.lp-set \+ \.lp-set\{display:none\}/,
    'không JS thì không có băng, phải bỏ bản bóng');
  assert.match(LUAT, /@media\(max-width:1023px\)\{\.lp-set \+ \.lp-set\{display:none\}\}/,
    'dưới 1024px thang máy tắt, phải bỏ bản bóng');
});

test('không JS thì MỌI khung sản phẩm vẫn hiện', () => {
  // Quy tắc ẩn nằm sau html.lpjs — cờ do chính JS gắn. Không JS ⇒ năm khung xếp dọc, đủ
  // chữ, không mất một dòng nào.
  assert.match(LUAT, /html\.lpjs \.lp-panel:not\(\.on\)\{display:none\}/,
    'quy tắc ẩn khung PHẢI nằm sau cờ lpjs');
  assert.match(LUAT, /html:not\(\.lpjs\) \.lp-pnav\{display:none\}/,
    'không JS thì bộ đếm/chấm vô nghĩa, phải ẩn');
});

test('ba chốt chống tràn ngang đã đo được', () => {
  assert.match(SRC, /\.lp-flag>\*\{min-width:0\}/,
    'thiếu min-width:0 — ô lưới mặc định min-width:auto nên cột không co dưới min-content');
  assert.match(SRC, /\.lp-row,\.lp-credit,\.lp-coup,\.lp-pts,\.lp-flash\{flex-wrap:wrap\}/,
    'thiếu cho khối minh hoạ xuống dòng ở màn hẹp (360px đã tràn 495/345)');
  assert.match(SRC, /\.lp-plan\{[^}]*min-width:0/,
    'thẻ giá phải co được (1024px đã tràn 1143/1009 vì min-content mỗi thẻ 356px)');
  assert.match(SRC, /\.lp-plans\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/,
    'track thẻ giá phải co được');
  assert.match(SRC, /@media\(max-width:11\d\dpx\)\{\.lp-plans\{grid-template-columns:1fr/,
    'thẻ giá phải đổi bố cục trước 1100px (1024px đã tràn 1143/1009)');
});

test('cắt ngang KHÔNG đặt lên tổ tiên của khối dán dính', () => {
  // overflow-x:clip ở tổ tiên tạo ngữ cảnh cắt và phá position:sticky. Chốt này giữ cho
  // bản vá tràn ngang không âm thầm giết bố cục dán dính.
  assert.doesNotMatch(SRC, /\.lp-prod\{[^}]*overflow-x:(clip|hidden|auto|scroll)/,
    'không được cắt ngang ở .lp-prod — sẽ phá position:sticky của cột phải');
  assert.doesNotMatch(SRC, /\.lp-grid\{[^}]*overflow-x:(clip|hidden|auto|scroll)/,
    'không được cắt ngang ở .lp-grid — sẽ phá position:sticky của cột phải');
});

test('trang DÙNG ĐƯỢC khi không có JS', () => {
  // Ba đường quay lại đã từng làm mất nội dung, mỗi đường một chốt.
  assert.match(SRC, /js: JS/, 'script phải đi qua sitePage để nó tự bỏ khi thiếu nonce');
  assert.match(SRC, /const dock = nonce \? /,
    'thanh CTA nổi chỉ được dựng khi có nonce — không JS thì nó không bao giờ hiện được');
  assert.match(SRC, /html\.lpjs \.rv\{opacity:0/,
    'trạng thái ẩn của hiệu ứng PHẢI nằm sau html.lpjs — cờ đó do chính JS gắn');
  assert.match(SRC, /root\.classList\.add\('lpjs'\)/, 'thiếu chỗ gắn cờ lpjs');
  // Slide đầu mang class "on" ngay từ server: không JS thì nó vẫn là slide đang hiện.
  assert.match(SRC, /k === 0 \? ' on' : ''/, 'slide đầu phải mở sẵn từ server');
});

test('landing có nonce CSP phải no-store', () => {
  assert.match(SERVER, /function sendHtml\([^)]*noStore/,
    'sendHtml phải nhận cờ noStore');
  assert.match(SERVER, /else if \(noStore\)\s*\{[\s\S]*?headers\['cache-control'\] = 'no-store'/,
    'noStore phải phát Cache-Control: no-store');
  assert.match(SERVER, /const nonceLanding = crypto\.randomBytes\(16\)\.toString\('base64'\);[\s\S]*?\{ noStore: true, nonce: nonceLanding \}\);/,
    'landing phải dùng noStore cùng nonce trong thân HTML');
  assert.doesNotMatch(SERVER, /\{ cache: true, nonce: nonceLanding \}/,
    'landing không được cache công khai khi nonce động');
});

test('lớp tăng cường không phụ thuộc khung hình được vẽ', () => {
  // requestAnimationFrame chỉ chạy 2 lần trong CẢ MỘT GIÂY ở môi trường không vẽ đều
  // (đo được). Bọc handler cuộn trong rAF thì thanh điều hướng kẹt trạng thái cũ.
  assert.match(SRC, /function beat\(\)\{ rvScan\(\); rvXQuet\(\); rvGuard\(\); onScroll\(\);/,
    'handler cuộn phải quét trước khi bật lưới an toàn, không bọc requestAnimationFrame');
  assert.doesNotMatch(SRC, /requestAnimationFrame\(onScroll\)/,
    'không được đưa onScroll qua requestAnimationFrame');
});

test('hiệu ứng hiện dần KHÔNG bỏ sót thứ đã cuộn qua', () => {
  // Bản trước giữ lại cả phần tử đã trôi lên trên khung nhìn, nên nhảy tới mỏ neo hoặc
  // cuộn nhanh một phát là chúng kẹt opacity:0 vĩnh viễn — đo được 4/37 phần tử hiện.
  assert.match(SRC, /if \(r\.top > h \* 0\.94\) return true;/,
    'chỉ được giữ lại thứ CHƯA tới lượt, không giữ thứ đã cuộn qua');
  assert.doesNotMatch(SRC, /r\.top > h \* 0\.94 \|\| r\.bottom < 0/,
    'điều kiện r.bottom < 0 làm phần tử đã cuộn qua không bao giờ hiện');
});

test('thanh CTA nổi đo khoảng cách tới ĐÁY, không đo khối cuối', () => {
  assert.match(SRC, /root\.scrollHeight - \(scrollY \+ innerHeight\)\) < innerHeight \* 0\.9/,
    'ở 390px chân trang cao hơn nên khối CTA cuối đã trôi khỏi khung nhìn — đo theo nó thì thanh nổi vẫn đè lên nút của chân trang');
});

test('băng banner có đủ điều khiển bắt buộc', () => {
  // WCAG 2.2.2: nội dung tự chạy phải dừng được, và phải tự dừng khi người ta đang đọc.
  assert.match(SRC, /id="lpPause"/, 'thiếu nút tạm dừng');
  assert.match(SRC, /hero\.addEventListener\('mouseenter', ngung\)/, 'thiếu dừng khi trỏ vào');
  assert.match(SRC, /hero\.addEventListener\('focusin', ngung\)/, 'thiếu dừng khi có tiêu điểm bàn phím');
  assert.match(SRC, /!RM && slides\.length > 1/, 'không được tự chạy khi chỉ có một banner hoặc khi người dùng chọn giảm chuyển động');
});

test('ngăn kéo giữ tiêu điểm và đóng được bằng Esc', () => {
  assert.match(SRC, /e\.key === 'Escape' && !dw\.hidden/, 'thiếu đóng bằng Esc');
  assert.match(SRC, /if \(e\.shiftKey && D\.activeElement === a\)/, 'thiếu bẫy tiêu điểm');
  assert.match(SRC, /if \(!D\.body\.classList\.contains\('lp-lock'\)\)/,
    'không được ẩn thanh điều hướng khi ngăn kéo đang mở — ẩn thì mất luôn nút đóng');
});

test('nội dung không bịa lời chứng thực', () => {
  // Kho chưa triển khai và chưa có khách thật (CLAUDE.md §0). Bản trước có ba lời chứng
  // thực dựng lên trong khi chính chú thích đầu file tuyên bố không bịa số khách hàng.
  assert.doesNotMatch(SRC, /TESTIMONIALS/, 'không dựng lời chứng thực khi chưa có khách thật');
  assert.match(SRC, /\['no', '<b>Chưa có\.<\/b>/,
    'bảng so sánh phải giữ dòng mình THUA — thắng cả tám ô thì người đọc trừ điểm');
});

test('không thẻ a nào để trình duyệt tự chọn màu', () => {
  // Ba lần hỏng liên tiếp vì cùng một chuyện: một quy tắc cho thẻ a có độ ưu tiên cao hơn
  // lớp của nút. Kết quả đo được: nút hero TRẮNG chữ TRẮNG (rỗng hoàn toàn), mục điều
  // hướng gần như vô hình trên nền tối, nút trong ngăn kéo chữ ĐEN trên nền xanh, và nút
  // viền trong thẻ giá nổi bật TRẮNG trên TRẮNG. Chốt: không đặt màu chung cho thẻ a.
  assert.doesNotMatch(LUAT, /\.lp a\{[^}]*color:/,
    'không được đặt color cho .lp a — nó thắng mọi lớp nút và làm chữ nút tàng hình');
  assert.doesNotMatch(LUAT, /\.lp a:not\(\[class\]\)/,
    ':not([class]) tính như bộ chọn thuộc tính nên còn thắng cả .lp-nav a');
  assert.match(SRC, /\.lp-drawer a:not\(\.lp-btn\)\{/,
    'quy tắc màu của ngăn kéo phải chừa nút ra');
  assert.match(SRC, /\.lp-plan\.hot \.lp-b-gh\{background:transparent/,
    'thẻ giá nổi bật nền tối: nút viền phải bỏ nền trắng, nếu không là trắng trên trắng');
});

test('ngăn kéo đóng thì KHÔNG nằm trong bố cục', () => {
  // Khai display cho .lp-drawer đè mất display:none của thuộc tính hidden ⇒ bấm Tab từ
  // trang đi thẳng vào một menu không nhìn thấy.
  assert.match(SRC, /\.lp-drawer\[hidden\],\.lp-scrim\[hidden\]\{display:none\}/,
    'phải trả lại display:none cho trạng thái hidden');
});

test('khối tiêu đề mục trải đúng bề rộng nội dung', () => {
  // Xếp một cột thì trên màn rộng tiêu đề chỉ chiếm nửa trái còn nửa phải bỏ trống, trong
  // khi bảng ngay dưới trải hết — đó là cảm giác lệch tỉ lệ, và nó lặp ở MỌI mục.
  assert.match(SRC, /\.lp-head\{margin-bottom:48px;display:grid;grid-template-columns:/,
    'từ 1024px khối tiêu đề phải chia hai cột');
  assert.equal((SRC.match(/<div class="lp-head[ "]/g) ?? []).length, 7,
    'mọi khối tiêu đề mục phải dùng chung lớp nhịp .lp-head (kể cả biến thể căn giữa)');
  // Biến thể căn giữa phải HUỶ lưới hai cột, nếu không tiêu đề vẫn bị ghim vào cột trái
  // trong khi text-align:center chỉ căn chữ bên trong cột đó — trông càng lệch hơn.
  assert.match(SRC, /\.lp-head-mid\{display:block\}/,
    'biến thể căn giữa phải huỷ lưới hai cột ở mốc 1024px');
});

test('tiêu đề viết hoa có đủ chiều cao dòng cho dấu tiếng Việt', () => {
  // Ở cỡ lớn, dấu của chữ hoa (Ồ, Ế, Ữ) chạm chân dòng trên. Đo được trên ảnh chụp thật.
  const h2 = /\.lp-h2\{[^}]*\}/.exec(SRC)?.[0] ?? '';
  const lh = Number(/line-height:([\d.]+)/.exec(h2)?.[1] ?? 0);
  assert.ok(lh >= 1.24, `chiều cao dòng ${lh} quá thấp cho chữ hoa có dấu`);
  assert.doesNotMatch(SRC, /\.lp-hero h1\{[^}]*text-transform:uppercase/,
    'tiêu đề hero KHÔNG viết hoa: ở cỡ đó dấu chồng lên nhau');
});

test('thanh điều hướng không gãy chữ', () => {
  // Chữ xuống dòng trong viên thuốc cao cố định thì lòi hẳn ra ngoài — đo được trên ảnh.
  for (const sel of ['.lp-brand', '.lp-btn']) {
    const rule = new RegExp(sel.replace('.', '\\.') + '\\{[^}]*white-space:nowrap');
    assert.match(SRC, rule, `${sel} phải khoá nowrap`);
  }
  assert.match(SRC, /\.lp-nav a\{[^}]*white-space:nowrap/, '.lp-nav a phải khoá nowrap');
  assert.match(SRC, /@media\(min-width:480px\)\{\.lp-hdr \.lp-btn\{display:inline-flex/,
    'dưới 480px phải bỏ nút trong thanh, nếu không nút menu bị cắt cụt');
});


test('hero gọn trong MỘT khung hình', () => {
  // Chủ dự án yêu cầu banner đầu nằm trọn một màn. Đo được bằng trình duyệt ở 8 cỡ khung
  // (1920×760 · 1600×780 · 1440×900 · 1366×700 · 1280×820 · 1024×700 · 390×844 · 360×740):
  // 0/8 còn tràn. Ba thứ dưới đây là điều kiện để giữ được kết quả đó.
  assert.match(LUAT, /\.lp-hero\{[^}]*min-height:100svh/, 'hero phải cao đúng một khung nhìn');
  assert.match(LUAT, /\.lp-hero > \.ct\{display:flex;flex-direction:column;justify-content:center/,
    'nội dung hero phải xếp dọc và canh giữa phần còn lại');
  assert.match(LUAT, /\.lp-ctl\{[^}]*margin-top:auto/,
    'cụm điều khiển băng phải bị đẩy xuống đáy, không trôi theo nội dung');
  assert.match(LUAT, /@media\(min-width:1024px\)\{\.lp-stage\{max-width:none;max-height:min\(/,
    'khung thiết bị phải có trần theo chiều cao khung nhìn để co lại thay vì đẩy mọi thứ ra ngoài');
  assert.match(LUAT, /@media\(max-height:780px\)/, 'thiếu nhánh cho khung nhìn thấp');
  assert.match(LUAT, /@media\(max-width:1023px\) and \(max-height:780px\)/,
    'thiếu nhánh cho điện thoại màn thấp (360×740)');
});

test('không còn dải cam kết 4 ô', () => {
  // Chủ dự án bỏ hẳn: "3 phút / 0đ / 100% / 24/7". Bỏ cả dữ liệu lẫn CSS, không để lại
  // mảng chết rồi vài tháng sau có người dựng lại vì thấy nó còn đó.
  assert.doesNotMatch(SRC, /const STATS =/, 'phải bỏ hẳn mảng STATS');
  assert.doesNotMatch(SRC, /lp-strip/, 'phải bỏ hẳn dải cam kết, kể cả CSS');
});

test('mục so sánh có tiêu đề căn giữa và khe chèn ảnh', () => {
  assert.match(SRC, /<div class="lp-head lp-head-mid rv">/, 'tiêu đề mục so sánh phải căn giữa');
  assert.doesNotMatch(SRC, /Ba cách bán hàng online phổ biến nhất/,
    'đoạn văn dẫn đã bỏ theo yêu cầu, thay bằng khe ảnh');
  assert.match(SRC, /const soSanhShot = assetSrc\('so-sanh'\)/, 'thiếu khe chèn ảnh của mục so sánh');
  // Chưa có tệp thì KHÔNG dựng gì — không để lại khung viền rỗng hay khoảng trống.
  assert.match(SRC, /const cmpImg = soSanhShot\s*\?/, 'khe ảnh phải là nhánh có/không, không dựng khung rỗng');
});

test('thẻ nổi trang trí ẩn ở màn hẹp, và quy tắc nằm ĐÚNG chỗ', () => {
  // Cùng độ ưu tiên thì cái viết SAU thắng. Bản trước đặt lệnh ẩn ở phía trên phần khai
  // display:flex nên nó bị đè im lặng: đọc CSS thì tưởng đã ẩn, chụp ảnh vẫn thấy.
  const iKhai = LUAT.indexOf('.lp-float{position:absolute;display:flex');
  const iAn = LUAT.indexOf('@media(max-width:1023px){.lp-float{display:none}}');
  assert.ok(iKhai >= 0 && iAn >= 0, 'thiếu một trong hai quy tắc .lp-float');
  assert.ok(iAn > iKhai, 'lệnh ẩn phải nằm SAU phần khai display:flex, nếu không bị đè');
});

test('có ảnh: ảnh THAY bảng ở màn rộng, bảng giữ cho điện thoại', () => {
  // Chủ dự án chốt: ảnh thay bảng ở màn rộng, giữ bảng HTML cho điện thoại.
  // Đo được ở trình duyệt với một tệp ảnh thật:
  //   1440px → ảnh 1128×620, bảng thu về 1×1 · 1024px → ảnh 934×526, bảng 1×1
  //   390px  → ảnh display:none, bảng hiện dạng thẻ 350×2567
  // Cả ba cỡ đều còn ĐỦ 8 dòng bảng trong DOM.
  assert.match(SRC, /class="lp-sec lp-cmp\$\{soSanhShot \? ' co-anh' : ''\}"/,
    'section phải mang cờ co-anh khi có tệp ảnh, để CSS biết đường đổi bề mặt');
  assert.match(LUAT, /\.lp-cmp\.co-anh \.lp-cmp-w\{position:absolute;width:1px;height:1px/,
    'màn rộng: bảng phải lui về dạng chỉ-đọc-màn-hình');
  assert.doesNotMatch(LUAT, /\.lp-cmp\.co-anh \.lp-cmp-w\{display:none/,
    'KHÔNG được display:none — mất khỏi cả cây trợ năng lẫn thứ Google đọc được, tức đổi bảng 8 tiêu chí lấy một tấm ảnh không chữ');
  assert.match(LUAT, /@media\(max-width:899px\)\{\.lp-cmp-img\{display:none\}\}/,
    'màn hẹp: phải ẩn ảnh — ảnh chụp bảng bốn cột thu xuống 360px thì không đọc nổi');
  // Ảnh là bản vẽ lại của bảng, không mang thông tin mới: alt rỗng + aria-hidden, nếu
  // không trình đọc màn hình nghe cùng một nội dung hai lần.
  assert.match(SRC, /<figure class="lp-cmp-img rv" aria-hidden="true"><img src="\$\{esc\(soSanhShot\)\}" alt=""/,
    'ảnh phải là trang trí thuần, dữ liệu thật nằm ở bảng');
  // Thứ tự cascade: lệnh đổi bề mặt phải nằm SAU phần khai .lp-cmp-img.
  assert.ok(LUAT.indexOf('@media(max-width:899px){.lp-cmp-img{display:none}}')
            > LUAT.indexOf('.lp-cmp-img{margin:0 0 32px}'),
    'lệnh ẩn ảnh phải nằm sau phần khai .lp-cmp-img, nếu không bị đè im lặng');
});

test('nút thừa hưởng phông của trang', () => {
  // Mặc định của trình duyệt: <button> KHÔNG thừa hưởng font-family/size của trang. Đo
  // được trên bản trước: nút thẻ sản phẩm dựng bằng Arial 13,33px cao 211px, trong khi
  // bản sao dựng bằng div thì đúng Be Vietnam Pro 16,64px cao 241px — mối nối vòng lặp
  // lộ ra, và quan trọng hơn là MỌI nút trên trang đang sai phông.
  assert.match(LUAT, /(^|\n)button\{font:inherit\}/,
    'thiếu reset phông cho nút — mọi nút sẽ dựng bằng phông mặc định của trình duyệt');
  // Phải là bộ chọn phần tử TRẦN (0,0,1). Đặt ở lớp cao hơn là lặp lại đúng cái bẫy đã
  // cắn với thẻ a: quy tắc chung thắng mọi lớp nút và nuốt mất font-size riêng của chúng.
  assert.doesNotMatch(LUAT, /\.lp button\{font:inherit\}/,
    'không được nâng độ ưu tiên của reset phông');
});

test('mục Giải pháp: tiêu đề căn giữa, nền sáng, khe ảnh cho từng khối', () => {
  assert.match(SRC, /<div class="lp-head lp-head-mid rv"><p class="lp-eb">Giải pháp tăng trưởng<\/p>/,
    'tiêu đề mục Giải pháp phải căn giữa như các mục trên');
  // Nền sáng, không còn navy. Ba mục sáng liền nhau dễ phẳng nên mục này lấy tông xanh
  // rất nhạt để tự tách khỏi mục sản phẩm và mục ngành hàng.
  assert.match(LUAT, /\.lp-grow\{background:var\(--lp-b025\)/, 'mục Giải pháp phải dùng nền sáng');
  assert.doesNotMatch(LUAT, /\.lp-grow\{background:var\(--lp-navy\)/, 'không còn nền tối');
  assert.doesNotMatch(SRC, /class="lp-sec lp-grow lp-dark"/, 'phải bỏ lớp nền tối khỏi section');
  // Khe ảnh cho từng khối, và nhánh dự phòng khi chưa có tệp.
  assert.match(SRC, /const t = assetSrc\('gp-' \+ f\.key\)/, 'thiếu khe ảnh theo khoá của từng khối');
  assert.match(SRC, /: VIS\[f\.vis\];/, 'chưa có tệp thì phải dùng khung minh hoạ CSS, không để ô trống');
  // FLAGS nằm SAU PRODUCTS trong file — cắt nhầm chiều thì lát cắt rỗng và phép đếm ra 0
  // mà vẫn trông như một khẳng định thật.
  const khoiGP = SRC.slice(SRC.indexOf('const FLAGS = ['), SRC.indexOf('const PLANS = ['));
  assert.equal((khoiGP.match(/key: '/g) ?? []).length, 4, 'cả bốn khối giải pháp phải có khoá tra ảnh');
  // Ảnh chèn vào dùng CHUNG khung với khung minh hoạ CSS, để thay được từng cái một mà
  // bốn khối vẫn đồng bộ.
  assert.match(LUAT, /\.lp-flag-img\{[^}]*border-radius:var\(--lp-r3\);[\s\S]{0,40}box-shadow:var\(--lp-sh2\)/,
    'ảnh chèn phải cùng bo góc và đổ bóng với khung minh hoạ');
  // Hiệu ứng lướt: cả hai cột đều mang cờ .rv-x (lướt ngang hai chiều, xem chốt riêng).
  assert.match(SRC, /<div class="rv-x \$\{dao \? 'rv-r' : 'rv-l'\}"><p class="lp-kick2">/,
    'cột chữ phải mang cờ lướt ngang');
  assert.match(SRC, /<div class="lp-flag-v rv-x \$\{dao \? 'rv-l' : 'rv-r'\}">\$\{gpHinh\(f\)\}<\/div>/,
    'cột hình phải mang cờ lướt ngang, ngược bên với cột chữ');
});

test('mục Giải pháp lướt NGANG và ĐI RỒI VỀ', () => {
  // Chủ dự án: trái vào từ trái, phải vào từ phải, và cuộn ngược lên thì lướt trở RA.
  // Đo bằng trình duyệt trên hàng đầu:
  //   chưa tới      trái x=-56 mờ=0   | phải x=+56 mờ=0
  //   cuộn xuống    trái x=0   mờ=1   | phải x=0   mờ=1
  //   cuộn ngược lên trái x=-56 mờ=0  | phải x=+56 mờ=0
  //   cuộn xuống lại trái x=0  mờ=1   | phải x=0   mờ=1
  assert.match(LUAT, /html\.lpjs \.rv-l\{transform:translateX\(calc\(-1 \* clamp\(/, 'cột trái phải lướt vào từ trái');
  assert.match(LUAT, /html\.lpjs \.rv-r\{transform:translateX\(clamp\(/, 'cột phải phải lướt vào từ phải');
  // Quãng lướt phải LUÔN nhỏ hơn lề khung chứa (clamp(20px,4.4vw,56px)). Đặt cứng 56px
  // thì ở khung 1024px lề chỉ 45px và trang tràn 1020/1009 — đúng một cỡ, hai cỡ hai bên
  // đều sạch nên rất dễ lọt nếu chỉ đo 360 và 1440.
  assert.match(LUAT, /clamp\(16px,3\.2vw,44px\)/, 'quãng lướt phải co theo bề rộng, nhỏ hơn lề khung chứa');
  // Màn hẹp: lướt DỌC. Hai cột xếp chồng nên "vào từ trái/phải" mất nghĩa, và trạng thái
  // ẩn đỗ ngoài mép phải làm tràn 351/345 ở khung 360px.
  assert.match(LUAT, /@media\(max-width:959px\)\{[\s\S]*?html\.lpjs \.rv-l,html\.lpjs \.rv-r\{transform:translateY\(22px\)\}/,
    'dưới 960px phải lướt dọc, không lướt ngang');
  // Transition khai ở TRẠNG THÁI GỐC, không phải ở .in: khai ở .in thì lượt đi RA biến
  // mất tức thì, tức chỉ có nửa hiệu ứng.
  assert.match(LUAT, /html\.lpjs \.rv-x\{opacity:0;transition:opacity 640ms/,
    'transition phải khai ở trạng thái gốc để lượt đi ra cũng có chuyển động');
  assert.doesNotMatch(LUAT, /html\.lpjs \.rv-x\.in\{[^}]*transition:/,
    'không được khai transition ở .in — lượt đi ra sẽ mất chuyển động');
  // ĐI RỒI VỀ: bộ quét KHÔNG được lọc phần tử ra khỏi danh sách như .rv làm.
  assert.match(SRC, /rvX\[i\]\.classList\.toggle\('in', trong\);/,
    'phải đặt lại cờ mỗi lượt quét, không phải thêm một lần rồi thôi');
  assert.doesNotMatch(SRC, /rvX = rvX\.filter/, 'không được lọc .rv-x ra khỏi danh sách');
  assert.match(SRC, /function beat\(\)\{ rvScan\(\); rvXQuet\(\); rvGuard\(\);/,
    'bộ quét ngang phải chạy sau khi quét hiệu ứng hiện dần');
  // Hướng lướt bám VỊ TRÍ THẤY ĐƯỢC: hàng lẻ đảo bên bằng order, nếu bám thứ tự HTML thì
  // cột bên trái sẽ vào từ bên phải — hai cột bay ngang qua nhau.
  assert.match(SRC, /const dao = k % 2 === 1;/, 'phải biết hàng nào đảo bên');
  // Lưới an toàn phải tính cả .rv-x, nếu không nó gỡ cờ lpjs khi trang chỉ còn .rv-x.
  assert.match(SRC, /rvDone === 0 && \(rvs\.length \|\| rvX\.length\)/,
    'lưới an toàn phải tính cả phần tử lướt ngang');
  assert.match(LUAT, /html\.lpjs \.rv,html\.lpjs \.rv-x\{opacity:1;transform:none;transition:none\}/,
    'giảm chuyển động thì cả hai loại đều hiện thẳng');
});

test('mục Lợi ích: thẻ lớn nửa xanh nửa trắng, có mũi tên, tự chạy', () => {
  assert.match(SRC, /const LOI_ICH = \[/, 'thiếu mảng dữ liệu lợi ích');
  assert.equal((SRC.match(/LOI_ICH\.map\(/g) ?? []).length, 2,
    'nút và khung xem đều dựng từ CÙNG mảng LOI_ICH');
  // Tiêu đề lấy TÊN THƯƠNG HIỆU từ tham số, không viết cứng: đổi PLATFORM_BRAND là đổi
  // được cả trang, không phải đi sửa từng chỗ.
  assert.match(SRC, /Lợi ích \$\{esc\(brand\)\} mang đến/, 'tiêu đề phải lấy tên thương hiệu từ dữ liệu');
  // Bộ tab thật, có mũi tên trước/sau.
  assert.match(SRC, /role="tab" id="liT\$\{k\}" aria-controls="liP\$\{k\}"/, 'nút phải là tab thật');
  assert.match(SRC, /id="liPrev"/, 'thiếu mũi tên trước');
  assert.match(SRC, /id="liNext"/, 'thiếu mũi tên sau');
  // Bấm chỉ đặt lại đồng hồ — cùng lý do như băng sản phẩm: dừng vĩnh viễn thì bấm thử
  // một cái là băng chết và trông y hệt một băng hỏng.
  assert.match(SRC, /t\.addEventListener\('click', function\(\)\{ liDen\(i\); liNgung\(\); liChay\(\); \}\)/,
    'bấm tay không được dừng hẳn tự chạy');
  assert.match(SRC, /!liTimer && !RM && liNuts\.length > 1/, 'không tự chạy khi người dùng chọn giảm chuyển động');
  assert.match(SRC, /function liTrongTam\(\)/, 'phải ngủ khi khối ngoài tầm mắt');
  // Khe ảnh cho từng lợi ích + nhánh dự phòng.
  assert.match(SRC, /const t = assetSrc\('li-' \+ x\.key\)/, 'thiếu khe ảnh theo khoá của từng lợi ích');
  assert.match(SRC, /: `<div class="lp-lp-mock">\$\{VIS\[x\.vis\]\}<\/div>`/, 'thiếu nhánh dự phòng khi chưa có ảnh');
  // Không JS thì mọi khung hiện đủ — quy tắc ẩn nằm sau cờ lpjs.
  assert.match(LUAT, /html\.lpjs \.lp-lp:not\(\.on\)\{display:none\}/, 'quy tắc ẩn phải nằm sau cờ lpjs');
  // brandMark chỉ là RUỘT của thẻ thương hiệu. Bọc nó trong thẻ KHÔNG mang lớp .lp-brand
  // thì ô biểu tượng biến mất và tên nhận màu thân trang — gần như vô hình trên nền xanh.
  assert.match(SRC, /<p class="lp-loi-brand lp-brand">\$\{brandMark\}<\/p>/,
    'khối thương hiệu phải mang lớp .lp-brand, nếu không ô biểu tượng biến mất');
});

test('không còn tên Evotech trong mã sản phẩm', () => {
  assert.doesNotMatch(SRC, /Evotech/, 'đã đổi sang TikFlash');
  assert.match(SRC, /const CMP_COLS = \['TikFlash'/, 'cột so sánh phải mang tên mới');
});

test('carousel banner dùng heading đúng cấp và chấm không giả làm tab', () => {
  assert.match(SRC,
    /<h\$\{k === 0 \? 1 : 2\}>\$\{esc\(b\.h\)\}<\/h\$\{k === 0 \? 1 : 2\}>/,
    'banner đầu là h1, các banner còn lại là h2');
  assert.match(LUAT, /\.lp-hero h1,\.lp-hero h2\{font-size:/,
    'h1 và h2 trong hero phải dùng cùng cỡ chữ');
  assert.equal((LUAT.match(/\.lp-hero h1,\.lp-hero h2\{font-size:/g) ?? []).length, 2,
    'cả CSS gốc và media mobile phải giữ cùng cỡ chữ cho h1/h2');
  const dots = SRC.slice(SRC.indexOf('<div class="lp-dots"'), SRC.indexOf('<div class="lp-arr"'));
  assert.match(dots, /<div class="lp-dots" role="group" aria-label="Chọn banner">/,
    'chấm banner phải có nhóm có tên nhưng không khai tablist khi không có panel');
  assert.doesNotMatch(dots, /role="tablist"|role="tab"/,
    'chấm banner không được tự nhận là tab nếu thiếu hợp đồng tab');
  assert.match(dots, /aria-current="\$\{k === 0\}"/,
    'chấm banner phải đánh dấu vị trí hiện tại bằng aria-current');
  assert.match(LUAT, /html:not\(\.lpjs\) \.lp-ctl\{display:none\}/,
    'không JS thì nhóm điều khiển carousel phải biến mất, không để nút chết');
});

test('không JS thì mũi tên mục Lợi ích phải biến mất', () => {
  // Một nút chết mời người ta bấm còn tệ hơn là không có nút.
  assert.match(LUAT, /html:not\(\.lpjs\) \.lp-loi-arr\{display:none\}/, 'thiếu ẩn mũi tên khi không JS');
  // Cùng độ ưu tiên thì cái viết SAU thắng — @media không cộng thêm gì.
  assert.ok(LUAT.indexOf('html:not(.lpjs) .lp-loi-arr{display:none}') > LUAT.indexOf('.lp-loi-arr.sau{right:-23px}'),
    'quy tắc ẩn phải nằm sau khối media, nếu không bị đè im lặng');
});
