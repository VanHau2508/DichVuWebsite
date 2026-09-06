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
