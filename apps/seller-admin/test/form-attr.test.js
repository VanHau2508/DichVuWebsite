/**
 * Bất biến: mọi thuộc tính form="X" phải có một <form id="X"> TRONG CÙNG hàm render.
 *
 * VÌ SAO CÓ. HTML cho phép ô nhập nằm ngoài cây DOM của form và dính vào form bằng
 * thuộc tính `form="<id>"`. Rất tiện (trang sửa sản phẩm dùng nó để một nút Lưu ghi
 * được cả trang), nhưng có một kiểu hỏng ÂM THẦM: trỏ tới id KHÔNG tồn tại thì trình
 * duyệt lặng lẽ KHÔNG gửi ô đó. Người dùng gõ, bấm Lưu, thấy báo thành công, dữ liệu
 * không đổi. Không lỗi, không cảnh báo, không dấu vết.
 *
 * Đã xảy ra thật: một lần thay chuỗi toàn cục khi làm nút "Lưu tất cả" đã dán
 * form="pall" vào 7 trang khác — trong đó có FORM TẠO SẢN PHẨM (tên/slug/giá) và
 * form viết blog. Trên các trang đó không có #pall nên các ô ấy chết lặng.
 *
 * E2E KHÔNG bắt được lớp lỗi này: bộ test POST thẳng body form-encoded, tức bỏ qua
 * hoàn toàn ngữ nghĩa gom-ô của trình duyệt. Chúng vẫn xanh trong khi trang thật hỏng.
 * Nên phép kiểm phải nằm ở mức MÃ NGUỒN.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages.js');
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.js');

test('mọi form="X" đều có <form id="X"> trong cùng hàm render', () => {
  // Bỏ dòng CHÚ THÍCH trước khi quét. Bản đầu báo nhầm renderResetDone vì một chú
  // thích có nhắc form="codf" nằm ngay TRƯỚC ranh giới hàm → bị gán sang hàm trước.
  // Giữ nguyên số dòng (thay bằng dòng trống) để thông báo lỗi còn chỉ đúng chỗ.
  const src = fs.readFileSync(SRC, 'utf8').split('\n')
    .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l)).join('\n');
  // Cắt theo ranh giới hàm export — đủ chính xác vì mỗi trang là một hàm render riêng.
  const marks = [...src.matchAll(/export function (\w+)/g)];
  const chunks = marks.map((m, i) => ({
    name: m[1],
    body: src.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : src.length),
  }));

  const orphans = [];
  let checked = 0;
  for (const c of chunks) {
    const ids = new Set([...c.body.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]));
    for (const m of c.body.matchAll(/\bform="([\w-]+)"/g)) {
      checked++;
      if (!ids.has(m[1])) orphans.push(`${c.name}: form="${m[1]}" nhưng không có id="${m[1]}"`);
    }
  }

  // Đếm > 0 để ca này không bao giờ "xanh rỗng": nếu regex hỏng và khớp 0 chỗ thì đỏ,
  // chứ không lặng lẽ báo đạt như đã từng xảy ra ở một ca khác.
  assert.ok(checked > 0, 'không tìm thấy thuộc tính form= nào — regex hỏng?');
  assert.deepEqual(orphans, [], `\n  ${orphans.join('\n  ')}\n`);
});

test('ô nhập NẰM TRONG một <form> thì không được mang form= trỏ đi nơi khác', () => {
  // Bất biến thứ hai, bắt lớp lỗi mà bất biến thứ nhất KHÔNG thấy: id có tồn tại,
  // nhưng ô lại đang nằm trong một <form> KHÁC. Khi đó nó bị CƯỚP khỏi form chứa nó
  // (form đó submit thiếu ô) và ĐỒNG THỜI chen vào form kia — mang theo cả `required`
  // nên chặn luôn nút Lưu của form kia.
  //
  // Đã xảy ra thật: ô "Giá (VND)" của form "Thêm biến thể lẻ" bị dán form="pall" nên
  // bấm "Lưu tất cả" báo "Vui lòng điền vào trường này" ở một ô người dùng không định
  // điền, còn nút "Thêm biến thể" thì gửi thiếu giá.
  const src = fs.readFileSync(SRC, 'utf8').split('\n')
    .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l));

  const bad = [];
  let depth = 0;
  for (const [i, line] of src.entries()) {
    const opens = (line.match(/<form\b/g) ?? []).length;
    const closes = (line.match(/<\/form>/g) ?? []).length;
    // Kiểm TRƯỚC khi cộng/trừ độ sâu của chính dòng này, trừ phần <form> mở trên dòng.
    const inside = depth > 0;
    if (inside) {
      for (const m of line.matchAll(/\bform="([\w-]+)"/g)) bad.push(`dòng ${i + 1}: form="${m[1]}" nằm trong <form> khác`);
    }
    depth += opens - closes;
    if (depth < 0) depth = 0;
  }
  assert.deepEqual(bad, [], `\n  ${bad.join('\n  ')}\n`);
});


function renderOrderDetailSource() {
  const src = fs.readFileSync(SRC, 'utf8');
  const start = src.indexOf('export function renderOrderDetail(');
  const end = src.indexOf('\nexport function renderOrderEdit(', start);
  assert.ok(start >= 0 && end > start, 'không cắt được hàm renderOrderDetail để kiểm tra guard SSR');
  return src.slice(start, end);
}

test('SSR khoá cả giao tay và vận đơn hãng khi ca giao nhiều kiện đang xử lý', () => {
  const src = renderOrderDetailSource();
  assert.match(src, /const activeCases\s*=\s*cases\.filter\(\(c\)\s*=>\s*\['open',\s*'waiting_return'\]\.includes\(c\.status\)\)/,
    'phải coi cả open và waiting_return là ca đang hoạt động');
  const manualStart = src.indexOf('const canShipManual =');
  const manualEnd = src.indexOf(';', manualStart);
  const manual = manualStart >= 0 && manualEnd > manualStart ? src.slice(manualStart, manualEnd) : '';
  const carrierStart = src.indexOf('const carrierCard =');
  const carrierEnd = src.indexOf('? `', carrierStart);
  const carrier = carrierStart >= 0 && carrierEnd > carrierStart ? src.slice(carrierStart, carrierEnd) : '';
  assert.match(manual, /activeCases\.length\s*===\s*0/,
    'form giao tay chưa phụ thuộc activeCases.length === 0');
  assert.match(carrier, /activeCases\.length\s*===\s*0/,
    'form tạo vận đơn hãng chưa phụ thuộc activeCases.length === 0');
  assert.match(carrier, /remLines\.length\s*>\s*0/,
    'form tạo vận đơn hãng vẫn hiện khi claim created đã giữ hết số lượng');
});

test('SSR bắt nhập rõ số tiền hoàn khi ca giao nhiều kiện đang hoạt động', () => {
  const src = renderOrderDetailSource();
  const refundStart = src.indexOf('const refundAction =');
  const refundEnd = src.indexOf('// Lịch sử hoàn tiền', refundStart);
  const refund = refundStart >= 0 && refundEnd > refundStart ? src.slice(refundStart, refundEnd) : '';
  assert.match(refund, /activeCases\.length/,
    'form hoàn tiền chưa có nhánh riêng cho active resolution case');
  assert.match(refund, /<input(?=[^>]*name="amount_vnd")(?=[^>]*required)[^>]*>/,
    'active case vẫn dùng ô amount tuỳ chọn: để trống sẽ hoàn toàn bộ và làm ca kẹt');
});

test('data-confirm chỉ dùng một submit handler và ưu tiên nút submit', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const start = src.indexOf('const ADMIN_JS =');
  const end = src.indexOf('\n})();`;', start);
  assert.ok(start >= 0 && end > start, 'không cắt được ADMIN_JS');
  const adminJs = src.slice(start, end);
  // HAI handler submit, và đó là cố ý: một để hỏi lại (capture, chặn sớm), một để khoá nút
  // data-busy (bubble, chạy sau). Ràng buộc thật KHÔNG phải "đúng một handler" mà là: chỉ
  // MỘT handler gọi window.confirm — hai handler cùng hỏi thì người dùng bị hỏi hai lần.
  const submitHandlers = (adminJs.match(/addEventListener\('submit'/g) ?? []).length;
  assert.ok(submitHandlers >= 1 && submitHandlers <= 2,
    `có ${submitHandlers} submit handler — thêm nữa là bắt đầu khó lần ra thứ tự chạy`);
  assert.equal((adminJs.match(/window\.confirm/g) ?? []).length, 1,
    'chỉ MỘT chỗ được gọi window.confirm, nếu không người dùng bị hỏi hai lần');
  // Handler khoá nút phải TÔN TRỌNG nhánh huỷ: huỷ ở hộp confirm mà vẫn khoá nút là kẹt
  // vĩnh viễn một nút lẽ ra vẫn dùng được.
  // BỎ CHÚ THÍCH TRƯỚC KHI KHỚP. Đây là lần thứ BA trong kho này một chốt mức mã nguồn đỏ
  // hoặc xanh nhầm vì chính lời giải thích nằm cạnh mã: bản đầu của dòng dưới vẫn XANH khi
  // gỡ hẳn `e.defaultPrevented` khỏi handler, vì cụm đó còn nằm trong comment ngay phía trên.
  const adminCode = adminJs.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.match(adminCode, /if \(e\.defaultPrevented \|\|/,
    'handler data-busy phải bỏ qua khi submit đã bị huỷ — khoá nút sau khi người dùng bấm Huỷ là kẹt vĩnh viễn một nút vẫn dùng được');
  // Và phải hoãn `disabled` sang tick sau: disable trước khi trình duyệt serialize form sẽ
  // làm RƠI giá trị của nút khỏi body — nút đang mang name/value thì mất luôn ngữ nghĩa.
  assert.match(adminJs, /setTimeout\(function\(\)\{ b\.disabled = true/,
    'chỉ được disable nút SAU khi form đã gửi (setTimeout), không phải ngay trong handler');
  assert.doesNotMatch(adminJs, /addEventListener\('click'[\s\S]*?window\.confirm/,
    'click handler riêng sẽ bỏ sót requestSubmit(button) hoặc hỏi hai lần');
  assert.match(adminJs, /var b = e\.submitter;[\s\S]*?b\.getAttribute\('data-confirm'\)[\s\S]*?f\.getAttribute\('data-confirm'\)/,
    'phải ưu tiên data-confirm của submitter rồi mới fallback về form');
});

test('overview chỉ bật ADMIN_JS khi nút go-live cần confirm', () => {
  const src = fs.readFileSync(SERVER, 'utf8');
  const start = src.indexOf('async function overviewPage(');
  const end = src.indexOf('\nasync function activateShop(', start);
  assert.ok(start >= 0 && end > start, 'không cắt được overviewPage');
  const overview = src.slice(start, end);
  // Điều kiện nay là `canManage` (không còn `&& ready`): nút go-live bỏ `disabled` nên nó
  // mang data-busy ở MỌI trạng thái, kể cả khi shop chưa đủ điều kiện. `disabled` từng làm
  // nút không focus được (bàn phím không tới) và `title` chỉ hiện khi hover — mobile mù hẳn.
  assert.match(overview, /if \(setup\?\.canManage\)[\s\S]*?sendHtmlJs\([\s\S]*?render\(\{ \.\.\.ctx, nonce \}\)/,
    'chủ shop phải nhận cùng nonce cho CSP và thẻ script');
  assert.match(overview, /return sendHtml\(res, 200, render\(ctx\)\)/,
    'người không quản trị được vẫn giữ đường SSR không script');
});

test('đường tiền legacy và hàng loạt đều qua owner + step-up ở BFF', () => {
  const src = fs.readFileSync(SERVER, 'utf8');
  assert.match(src, /roleFor\(me, shopId\) !== 'owner'[\s\S]*?legacyPaymentGate/,
    'mark-paid/unmark-paid legacy chưa khóa owner ở BFF');
  assert.match(src, /legacyPaymentSubmit[\s\S]*?steppedUp\(me\)[\s\S]*?legacyPaymentGate/,
    'legacy payment chưa đi qua interstitial step-up');
  assert.match(src, /ordersBulkMarkPaid[\s\S]*?roleFor\(me, shopId\) !== 'owner'[\s\S]*?bulkPaymentGate/,
    'bulk COD chưa khóa owner + step-up');
  assert.match(src, /bulk-mark-paid\/step-up/,
    'thiếu route giữ danh sách đơn qua màn xác nhận mật khẩu');
});
