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
// CSS đã CẮT CHÚ THÍCH. Chú thích ở file này mô tả chính những quy tắc từng gây lỗi, nên
// khớp regex trên toàn văn bản là khớp phải lời kể chứ không phải luật đang chạy — một chốt
// đã đỏ giả vì đúng chuyện đó, và cùng lỗi ở chiều ngược lại thì XANH GIẢ.
const LUAT = SRC.replace(/\/\*[\s\S]*?\*\//g, '');

test('khối sản phẩm: nút bên trái, khe hình + nội dung bên phải', () => {
  // Bố cục cũ (cột phải dán dính đổi theo cuộn) đo ra 5/5 nhưng NHÌN thì mỗi màn hình một
  // khoảng trống lớn và hai cột không bao giờ ngang hàng. Chủ dự án bác. Nay là bộ tab.
  assert.match(SRC, /const prodTab = \(x, k\) =>/, 'thiếu bộ dựng nút bên trái');
  assert.match(SRC, /const prodPanel = \(x, k\) =>/, 'thiếu bộ dựng khung bên phải');
  assert.equal((SRC.match(/PRODUCTS\.map\(/g) ?? []).length, 3,
    'nút, khung và chấm điều hướng đều dựng từ CÙNG mảng PRODUCTS — chép tay thì sẽ trôi');
  // Bộ tab THẬT, không phải thẻ trang trí gắn onclick.
  assert.match(SRC, /role="tab" id="spT\$\{k\}" aria-controls="spP\$\{k\}"/, 'nút phải là tab thật');
  assert.match(SRC, /role="tabpanel" aria-labelledby="spT\$\{k\}"/, 'khung phải là tabpanel thật');
});

test('mỗi mục sản phẩm có khe ảnh riêng', () => {
  assert.match(SRC, /const f = assetSrc\('sp-' \+ x\.key\)/, 'thiếu khe ảnh theo khoá của từng mục');
  assert.equal((SRC.match(/key: '/g) ?? []).length, 5, 'cả năm mục phải có khoá tra ảnh');
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

test('thang máy đưa nút đang mở về GIỮA khung, kẹp ở hai đầu', () => {
  assert.match(SRC, /var giua = nut\.offsetTop \+ nut\.offsetHeight \/ 2 - cao \/ 2;/,
    'phải canh TÂM nút vào TÂM khung');
  assert.match(SRC, /var tran = Math\.max\(0, spRay\.scrollHeight - cao\);/, 'thiếu mức tràn');
  assert.match(SRC, /Math\.max\(0, Math\.min\(giua, tran\)\)/,
    'phải kẹp trong [0, tràn], nếu không lộ khoảng trống ở đầu hoặc cuối danh sách');
  // Đo lại SAU khi panel mới đã lên: chiều cao cột phải đổi theo mục, đo trước thì ray
  // trượt theo con số của mục CŨ và hai cột lệch đúng một nhịp.
  assert.match(SRC, /requestAnimationFrame\(spThang\);\s*\n\s*setTimeout\(spThang, 60\);/,
    'phải đo lại sau khi panel mới đã lên');
  assert.match(SRC, /addEventListener\('resize', spThang/, 'thiếu tính lại khi đổi cỡ cửa sổ');
  // Dưới 1024px không cắt không trượt: cột trái xếp trên cột phải, thang máy ở đó chỉ tổ
  // giấu mất các nút còn lại.
  assert.match(SRC, /if \(innerWidth < 1024\) \{ spRay\.style\.transform = ''; return; \}/,
    'màn hẹp phải tắt thang máy');
});

test('bộ tab sản phẩm tự chạy nhưng nhường quyền cho người đọc', () => {
  assert.match(SRC, /function spChay\(\)\{[\s\S]*?!spTimer && !RM && tabs\.length > 1/,
    'không được tự chạy khi chỉ có một mục hoặc khi người dùng chọn giảm chuyển động');
  // Bấm tay chỉ ĐẶT LẠI đồng hồ. Bản trước dừng VĨNH VIỄN: bấm thử một cái là băng đứng
  // im mãi — chủ dự án gặp đúng chuyện đó và báo "chưa có sự chuyển động tự động".
  assert.match(SRC, /t\.addEventListener\('click', function\(\)\{ spDen\(i\); spNgung\(\); spChay\(\); \}\)/,
    'bấm tay chỉ được đặt lại đồng hồ, không được dừng hẳn');
  assert.doesNotMatch(SRC, /spDung/, 'không còn cờ dừng-vĩnh-viễn nào được phép tồn tại');
  // Dừng khi trỏ vào CỘT NÚT, không phải cả khối: gác cả khối thì để chuột trên khung
  // bên phải mà đọc là băng đứng im suốt, nhìn y như hỏng.
  assert.match(SRC, /spBox\.addEventListener\('mouseenter', spNgung\)/, 'thiếu dừng khi trỏ vào cột nút');
  assert.match(SRC, /spBox\.addEventListener\('mouseleave', spChay\)/, 'thiếu chạy lại khi rời cột nút');
  assert.doesNotMatch(SRC, /spWrap\.addEventListener\('mouseenter'/,
    'không được gác chuột trên CẢ khối — đọc khung bên phải là băng chết');
  assert.match(SRC, /spWrap\.addEventListener\('focusin', spNgung\)/, 'thiếu dừng khi có tiêu điểm');
  // Chỉ chạy khi khối trong tầm mắt: chạy từ lúc người ta còn ở hero thì tới nơi đã nhảy
  // sang mục 4 — trông như lỗi chứ không như hiệu ứng.
  assert.match(SRC, /function spTrongTam\(\)/, 'thiếu cổng chỉ-chạy-khi-trong-tầm-mắt');
  assert.match(SRC, /function beat\(\)\{ rvGuard\(\); rvScan\(\); onScroll\(\); spTrongTam\(\); \}/,
    'cổng tầm mắt phải được gọi trong vòng cuộn');
  // Bàn phím: mũi tên đổi mục, và bộ tab chỉ chiếm MỘT nấc Tab.
  assert.match(SRC, /t\.tabIndex = on \? 0 : -1/, 'bộ tab phải chỉ chiếm một nấc Tab');
  assert.match(SRC, /e\.key === 'ArrowDown' \|\| e\.key === 'ArrowRight'/, 'thiếu điều hướng bằng mũi tên');
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

test('lớp tăng cường không phụ thuộc khung hình được vẽ', () => {
  // requestAnimationFrame chỉ chạy 2 lần trong CẢ MỘT GIÂY ở môi trường không vẽ đều
  // (đo được). Bọc handler cuộn trong rAF thì thanh điều hướng kẹt trạng thái cũ.
  assert.match(SRC, /function beat\(\)\{ rvGuard\(\); rvScan\(\); onScroll\(\);/,
    'handler cuộn phải gọi thẳng, không bọc requestAnimationFrame');
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
  assert.equal((SRC.match(/<div class="lp-head[ "]/g) ?? []).length, 6,
    'cả sáu mục phải dùng chung lớp nhịp .lp-head (kể cả biến thể căn giữa)');
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
