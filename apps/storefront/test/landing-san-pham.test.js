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

test('khối sản phẩm dựng từ MỘT nguồn cho cả hai bố cục', () => {
  // Bản trong dòng (màn hẹp / trình duyệt chưa hỗ trợ) và bản dán dính (màn rộng) phải
  // cùng đọc PRODUCTS + VIS. Chép tay ra hai chỗ thì hai bản sẽ trôi, và trôi âm thầm:
  // không có phép so nào phát hiện được vì cả hai đều "có nội dung".
  assert.match(SRC, /const PRODUCTS = \[/, 'thiếu nguồn dữ liệu PRODUCTS');
  assert.equal((SRC.match(/PRODUCTS\.map\(/g) ?? []).length, 2,
    'phải đúng hai lần dựng từ PRODUCTS: bản trong dòng và bản dán dính');
  assert.match(SRC, /\$\{VIS\[x\.vis\]\}/, 'khung minh hoạ phải lấy từ VIS theo dữ liệu, không viết cứng');
});

test('bố cục dán dính chỉ bật khi ĐỦ rộng cho CẢ HAI cột', () => {
  const m = /and \(min-width:(\d+)px\)\{\s*\.lp-grid\{/.exec(SRC);
  assert.ok(m, 'không tìm thấy mốc bật bố cục dán dính của .lp-grid');
  assert.ok(Number(m[1]) >= 1100,
    `mốc ${m[1]}px quá hẹp: ở 1024px cột phải chỉ ~457px trong khi khung minh hoạ cần 496px`);
});

test('bố cục dán dính có ĐỦ ba cổng an toàn', () => {
  const khoi = SRC.slice(SRC.indexOf('@supports (timeline-scope'));
  assert.match(khoi, /@supports \(timeline-scope:--a\) and \(animation-timeline:view\(\)\)/,
    'thiếu cổng @supports — trình duyệt cũ sẽ nhận cột phải trắng trơn');
  assert.match(khoi, /prefers-reduced-motion:no-preference/,
    'thiếu cổng giảm chuyển động');
  assert.match(khoi, /min-width:1[1-9]\d\dpx/, 'thiếu cổng bề rộng');
  // Mặc định (ngoài mọi cổng) cột phải PHẢI ẩn và khung trong dòng PHẢI hiện — nếu ngược
  // lại thì trình duyệt không qua cổng sẽ mất trắng phần minh hoạ.
  assert.match(SRC, /\.lp-stick\{display:none\}/,
    'mặc định phải ẩn cột dán dính, chỉ bật bên trong @supports');
  assert.ok(SRC.indexOf('.lp-vin{display:none}') > SRC.indexOf('@supports (timeline-scope'),
    'chỉ được ẩn khung trong dòng BÊN TRONG @supports');
});

test('animation theo cuộn khai linear', () => {
  assert.match(SRC, /\.lp-frame\{[^}]*animation-timing-function:linear/,
    'thiếu linear: easing mặc định `ease` làm khung kề còn mở 54% lúc khung chính đã 100%');
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
  assert.match(SRC, /function beat\(\)\{ rvGuard\(\); rvScan\(\); onScroll\(\); \}/,
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
  assert.equal((SRC.match(/<div class="lp-head">/g) ?? []).length, 6,
    'cả sáu mục phải dùng chung lớp nhịp .lp-head');
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
