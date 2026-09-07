/**
 * Bất biến: BẢNG QUẢN TRỊ CARD-HOÁ Ở SERVER, KHÔNG PHỤ THUỘC JAVASCRIPT.
 *
 * VÌ SAO CÓ. Bản trước card-hoá bằng JS: ADMIN_JS đọc chữ ở <th> rồi gán data-label cho
 * từng <td>, và thêm lớp "cards" để CSS ăn. Nghĩa là toàn bộ việc này CHỈ chạy khi có JS.
 * Đo bằng Chromium ở 360px trên chi tiết đơn có ca xử lý:
 *   JS bật  385/360 (tràn 25px)   ·   JS tắt  572/360 (tràn 212px)
 * Vi phạm cùng lúc hai ràng buộc cố định của mọi lát cắt giao diện: "JS chỉ là tăng cường,
 * không phải điều kiện" và "dùng được ở 360px".
 *
 * E2E KHÔNG bắt được lớp hỏng này: mọi bộ e2e đọc HTML bằng regex chứ không dựng layout,
 * nên một bảng thiếu nhãn vẫn "có đủ chữ" và trang vẫn 200. Chỉ trình duyệt thật ở bề rộng
 * thật mới thấy. Nên phép canh thường trực phải nằm ở mức MÃ NGUỒN.
 *
 * BA ĐIỀU ĐƯỢC CANH, mỗi điều ứng với một đường quay lại trạng thái cũ:
 *   1. Không còn bảng data-cards nào viết tay — mọi bảng đi qua tblCards.
 *   2. CSS móc vào THUỘC TÍNH data-cards, không móc vào lớp do JS thêm.
 *   3. ADMIN_JS không được dựng lại việc gán nhãn (bản sao thứ hai sẽ trôi).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages.js');
const src = fs.readFileSync(SRC, 'utf8');

// Bỏ dòng CHÚ THÍCH trước khi quét. Chú thích trong file này nói VỀ markup cũ (cố ý — đó là
// phần ghi lại vì sao đổi), nên quét cả chú thích là báo đỏ giả. Giữ nguyên SỐ DÒNG bằng
// cách thay bằng dòng trống, để thông báo lỗi còn chỉ đúng chỗ.
const code = src.split('\n').map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l)).join('\n');

test('mọi bảng card-hoá đều đi qua tblCards, không còn bảng viết tay', () => {
  // Đếm CHỖ VIẾT trong mã nguồn, không đếm thứ đã render: một .map() sinh nhiều hàng vẫn
  // chỉ là một chỗ viết. Đây là bài học đã thành chốt ở lát cắt bảng điều khiển.
  const literals = [...code.matchAll(/<table\b[^>]*\bdata-cards/g)];
  assert.equal(literals.length, 1,
    `chỉ tblCards được phép phát <table data-cards>; thấy ${literals.length} chỗ viết`);

  // Chỗ duy nhất đó phải nằm TRONG thân tblCards, không phải một bảng viết tay tình cờ.
  const helper = code.slice(code.indexOf('function tblCards('), code.indexOf('\n}', code.indexOf('function tblCards(')));
  assert.match(helper, /<table\b[^>]*\bdata-cards/,
    'chỗ viết <table data-cards> duy nhất phải nằm trong tblCards');

  // So BẰNG, không phải >=. Thêm bảng mới mà quên sửa số này thì ĐỎ — đúng cách các
  // MANIFEST_* khác của kho hoạt động. Hôm nay: 53 lời gọi + 1 định nghĩa.
  const calls = (code.match(/\btblCards\(/g) ?? []).length;
  assert.equal(calls, 54, `kỳ vọng 53 lời gọi tblCards + 1 định nghĩa, thấy ${calls} lần xuất hiện`);
});

test('CSS card-hoá móc vào thuộc tính data-cards, không móc vào lớp do JS thêm', () => {
  // Lớp "cards" từng là thứ JS thêm SAU khi gán nhãn xong. Móc CSS vào nó nghĩa là tắt JS
  // thì không quy tắc nào áp — đúng cái làm bảng tràn 572/360. Bộ chọn phải là thuộc tính,
  // thứ có mặt ngay từ byte đầu tiên của HTML.
  assert.doesNotMatch(code, /table\.cards\b/,
    'không được còn quy tắc CSS nào móc vào lớp .cards — nó chỉ tồn tại khi JS đã chạy');

  const rules = (code.match(/table\[data-cards\]/g) ?? []).length;
  assert.ok(rules >= 15, `kỳ vọng bộ quy tắc thẻ-mobile đầy đủ trên [data-cards], thấy ${rules} bộ chọn`);

  // Ô không có nhãn phải bắt bằng :not([data-label]). tblCards BỎ HẲN thuộc tính khi nhãn
  // rỗng (content:attr() với chuỗi rỗng vẫn sinh một ::before chiếm chỗ), nên bộ chọn cũ
  // [data-label=""] nay KHÔNG khớp gì cả — im lặng, và cột checkbox thụt 40% vô cớ.
  assert.match(code, /table\[data-cards\] td:not\(\[data-label\]\)\{/,
    'ô không nhãn phải bắt bằng :not([data-label]) vì helper bỏ hẳn thuộc tính');
  assert.doesNotMatch(code, /td\[data-label=""\]/,
    'bộ chọn [data-label=""] không còn khớp gì — helper không phát nhãn rỗng nữa');
});

test('ADMIN_JS không dựng lại việc gán nhãn — một việc chỉ có một nơi làm', () => {
  const a = code.indexOf('const ADMIN_JS');
  assert.ok(a > 0, 'không tìm thấy ADMIN_JS — chốt này đang quét nhầm chỗ');
  const js = code.slice(a);
  // Hai dấu vết của bản JS cũ. Còn một trong hai nghĩa là nhãn đang có HAI nguồn phát, và
  // hai bản sao thì sẽ trôi — lớp lỗi đã cắn kho này ba đợt.
  assert.doesNotMatch(js, /setAttribute\(\s*'data-label'/,
    'JS không được gán data-label nữa; server đã phát trong markup');
  assert.doesNotMatch(js, /classList\.add\(\s*'cards'\s*\)/,
    'JS không được thêm lớp cards nữa; CSS móc thẳng vào thuộc tính');
});

test('khối lọc co được trong viewport 360px', () => {
  // Trang Tồn an toàn từng rộng 377px dù bảng đã card-hoá: nhãn dài làm flex item giữ
  // intrinsic min-width. max-width chỉ giới hạn hộp, còn min-width:0 mới cho phép nó co.
  assert.match(code, /\.filters>div\{flex:0 0 auto;min-width:0;max-width:100%\}/,
    'con trực tiếp của .filters phải co được và không rộng hơn viewport mobile');
});

// ── Ô GIÁ TRỊ KHÔNG ĐƯỢC CẮT CỤT Ở BỀ RỘNG HẸP ────────────────────────────────
//
// Card-hoá làm bảng đọc được ở 360px, nhưng nó KHÔNG cứu được một ô tự cắt nội dung của
// chính nó. Đo ngày 07/09 trên trang "Ảnh không tải được": ô URL nguồn khai
// `max-width:34ch` + `text-overflow:ellipsis` + `white-space:nowrap`, và trong bố cục card
// ô giá trị chỉ rộng ~140px nên URL hiện ra đúng `http://127.0.0.…` (ở 320px còn ngắn hơn).
//
// Chỗ đau không phải thẩm mỹ: URL nguồn là thứ DUY NHẤT trang đó có để trả lời *làm gì tiếp*
// — người bán phải đối chiếu nó với ô trong tệp CSV của họ. Hai ảnh của cùng một sản phẩm chỉ
// khác phần đuôi sẽ hiện y hệt nhau. Và `title=` không cứu được: điện thoại không có chuột.
//
// LỚP LỖI: mọi khẳng định e2e đọc HTML nên đều XANH — chuỗi URL vẫn nằm đủ trong markup, chỉ
// có mắt người là không thấy. Đúng §4 "ĐO KHÔNG PHẢI LÀ NHÌN".
//
// GIỚI HẠN, nói thẳng: đây là chốt MỨC MÃ NGUỒN, tức nó canh CHÍNH TẢ của khai báo CSS chứ
// không đo pixel. Phép đo thật là `scripts/probe-360.mjs` + mở ảnh ra xem; chốt này chỉ giữ
// cho bản vá khỏi bị hoàn nguyên trong im lặng.
test('ô URL nguồn xuống dòng chứ không cắt cụt (bố cục card ~140px)', () => {
  const i = code.indexOf('export function renderMediaFailures(');
  assert.ok(i > 0, 'không tìm thấy renderMediaFailures — mốc chết, sửa lại bộ test');
  const than = code.slice(i, code.indexOf('\n}', i));
  const dong = than.split('\n').find((d) => d.includes('esc(f.source_url)') && d.includes('<code'));
  assert.ok(dong, 'không còn ô <code> in URL nguồn — mốc chết');
  assert.doesNotMatch(dong, /text-overflow\s*:\s*ellipsis/,
    'URL nguồn bị cắt bằng ellipsis → ở 360px người bán chỉ đọc được ~14 ký tự đầu');
  assert.doesNotMatch(dong, /white-space\s*:\s*nowrap/,
    'URL nguồn bị ép một dòng → hoặc cắt cụt, hoặc kéo tràn ngang cả trang');
  assert.match(dong, /overflow-wrap\s*:\s*anywhere/,
    'URL dài không bẻ dòng được ⇒ ô giữ min-content rất lớn và kéo tràn cột (§4 min-width:auto)');
});

// ── Ô CHỌN TỆP PHẢI CO ĐƯỢC ────────────────────────────────────────────────────
//
// `input[type=file]` khai `width:auto` là CỐ Ý — khung nét đứt ôm sát nút thay vì kéo dài cả
// hàng. Nhưng `auto` ở control gốc nghĩa là bề rộng NỘI TẠI của nó (nút + chữ "No file
// chosen"), và bề rộng đó KHÔNG co theo khung cha.
//
// Đo ngày 07/09 bằng Chromium: MỌI trạng thái của CẢ HAI trang nhập — form rỗng, xem trước,
// bảng lỗi từng dòng, dòng trần gói, interstitial xác nhận thiếu mã đơn — ở CẢ JS bật lẫn tắt
// đều tràn **373/360**, và vì ô nằm ngoài mọi khối cuộn nên nó kéo CẢ TRANG cuộn ngang 13px.
// 16/16 phép đo đỏ, tức đây không phải lỗi của một trang mà của quy tắc dùng chung.
//
// Kho có 12 ô chọn tệp (logo, banner, ảnh danh mục, ảnh sản phẩm, nhập CSV/XLSX…) và tất cả
// đọc đúng dòng CSS này — nên chốt đặt ở quy tắc, không đặt ở trang.
test('ô chọn tệp có max-width để co được dưới bề rộng khung cha', () => {
  const dong = code.split('\n').find((d) => d.includes('input[type=file]{'));
  assert.ok(dong, 'không còn quy tắc input[type=file] — mốc chết, sửa lại bộ test');
  assert.match(dong, /width:\s*auto/, 'mất width:auto thì khung nét đứt kéo dài cả hàng (đổi chủ ý thiết kế, không phải sửa lỗi)');
  assert.match(dong, /max-width:\s*100%/,
    'ô chọn tệp không bị chặn bề rộng ⇒ bề rộng nội tại của control kéo cả trang tràn ngang ở 360px');
});
