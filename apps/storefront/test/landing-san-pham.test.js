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
  const m = /and \(min-width:(\d+)px\)\{\s*\.prod-grid\{/.exec(SRC);
  assert.ok(m, 'không tìm thấy mốc bật bố cục dán dính của .prod-grid');
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
  assert.match(SRC, /\.prod-stick\{display:none\}/,
    'mặc định phải ẩn cột dán dính, chỉ bật bên trong @supports');
  assert.ok(SRC.indexOf('.pvis-in{display:none}') > SRC.indexOf('@supports (timeline-scope'),
    'chỉ được ẩn khung trong dòng BÊN TRONG @supports');
});

test('animation theo cuộn khai linear', () => {
  assert.match(SRC, /\.pframe\{[^}]*animation-timing-function:linear/,
    'thiếu linear: easing mặc định `ease` làm khung kề còn mở 54% lúc khung chính đã 100%');
});

test('ba chốt chống tràn ngang đã đo được', () => {
  assert.match(SRC, /\.flag>\*,\.pane>\*,\.prod-grid>\*,\.prod-list,\.plan\{min-width:0\}/,
    'thiếu min-width:0 — ô lưới mặc định min-width:auto nên cột không co dưới min-content');
  assert.match(SRC, /\.vrow,\.vcredit,\.vcoupon,\.vpts,\.vflash\{flex-wrap:wrap\}/,
    'thiếu cho khối minh hoạ xuống dòng ở màn hẹp (360px đã tràn 495/345)');
  assert.match(SRC, /\.flags\{overflow-x:clip\}/,
    'thiếu cắt ngang ở khối dùng hiệu ứng trượt ngang (.srl/.srr dịch 42px ra ngoài mép)');
  assert.match(SRC, /\.plans\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}/,
    'track thẻ giá phải co được');
  assert.match(SRC, /@media\(max-width:11\d\dpx\)\{\s*\.plans\{grid-template-columns:1fr/,
    'thẻ giá phải đổi bố cục trước 1100px (1024px đã tràn 1143/1009)');
});

test('cắt ngang KHÔNG đặt lên tổ tiên của khối dán dính', () => {
  // overflow-x:clip ở tổ tiên tạo ngữ cảnh cắt và phá position:sticky. Chốt này giữ cho
  // bản vá tràn ngang không âm thầm giết bố cục dán dính.
  assert.doesNotMatch(SRC, /\.prod\{[^}]*overflow-x:(clip|hidden|auto|scroll)/,
    'không được cắt ngang ở .prod — sẽ phá position:sticky của cột phải');
  assert.doesNotMatch(SRC, /\.prod-grid\{[^}]*overflow-x:(clip|hidden|auto|scroll)/,
    'không được cắt ngang ở .prod-grid — sẽ phá position:sticky của cột phải');
});
