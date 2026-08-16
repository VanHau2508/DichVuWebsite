// UNIT: hộp "Việc cần làm" trên Tổng quan — mỗi ô phải DẪN TỚI THỨ NÓ ĐẾM, và chỉ hiện cho
// vai mở được trang đích.
//
// VÌ SAO CÓ BỘ NÀY. Hai lớp lỗi đo được trên nhánh trước, cả hai đều VÔ HÌNH với e2e hiện có
// (mọi bộ e2e đều đăng nhập bằng owner — vai có đủ mọi quyền, nên không bộ nào đi qua nhánh
// thiếu quyền):
//
//   1. QUYỀN. sideNav lọc mục theo ORDER_ROLES/CATALOG_ROLES/CONTENT_ROLES, lưới việc thì
//      KHÔNG lọc gì. Vai `order_manager` (chỉ orders.read/write) thấy "Đánh giá chờ duyệt"
//      → /reviews cần content.write → 403, và "Sắp hết hàng" → /products cần catalog.read
//      → 403. Hai ô dẫn thẳng vào tường, trong khi thanh điều hướng đã giấu đúng hai mục đó.
//
//   2. ĐẾM MỘT TẬP, MỞ RA TẬP KHÁC. dashboard.js đếm trạng thái đơn với `WHERE NOT
//      is_migrated` (đơn nhập từ sàn cũ là lịch sử, không phải việc cần làm — 0104), còn
//      danh sách đơn không lọc cờ đó. Thẻ "Đã giao 40" mở ra 40 + toàn bộ đơn vừa nhập từ
//      TikTok. Đúng lớp lỗi mà `payment=unpaid` và `stock=low` đã phải vá một lần.
//
// VÌ SAO KHÔNG PHẢI E2E: dựng ca này cần mời thêm thành viên ở HAI vai khác nhau rồi đăng
// nhập lại từng vai, cho mỗi khẳng định — đắt, chậm, và vẫn không thấy được cả mười một ô
// trong một lượt. Bất biến mức mã nguồn thấy hết trong một lần đọc.
//
// KHI ĐỎ: thêm `see:` cho ô mới, hoặc gắn `migrated=0` cho link vừa thêm. ĐỪNG nới danh sách.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { can, ROLES } from '../../seller/src/rbac.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');
const pages = rd('apps/seller-admin/src/pages.js');

// Bỏ chú thích TRƯỚC khi khớp. Chú thích ở kho này thường dài hơn mã và nhắc lại nguyên văn
// chuỗi đang canh, nên chốt mức mã nguồn khớp trúng lời giải thích rồi báo XANH trong khi mã
// thật đã hỏng. Đã dính đúng lỗi này ba lần ở các bộ khác — bỏ chú thích là bước đầu tiên.
const boChuThich = (s) => s.split('\n').filter((d) => !/^\s*(\/\/|\*|\/\*)/.test(d)).join('\n');

// Thân renderOverview: pages.js còn nhiều màn khác cũng có mảng ô và link /orders riêng.
function thanRenderOverview() {
  const i = pages.indexOf('export function renderOverview(');
  assert.ok(i > 0, 'không tìm thấy renderOverview — mốc chết, sửa lại bộ test');
  const j = pages.indexOf('\nexport function ', i + 10);
  assert.ok(j > i, 'không tìm thấy hàm kế tiếp — mốc chết');
  return boChuThich(pages.slice(i, j));
}

// Set vai trong pages.js → QUYỀN mà trang đích thật sự đòi ở seller. Đây là chỗ hai bên gặp
// nhau: gán nhầm Set cho một ô nghĩa là hứa một quyền mà vai đó không có.
const SET_QUYEN = {
  ORDER_ROLES: 'orders.read',
  CATALOG_ROLES: 'catalog.read',
  CONTENT_ROLES: 'content.write',
};

function vaiTrongSet(ten) {
  const m = new RegExp(`const ${ten} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(pages);
  assert.ok(m, `không tìm thấy ${ten} trong pages.js — mốc chết`);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

test('Set vai của sideNav khớp ma trận quyền THẬT của seller', () => {
  // Không so chuỗi với chuỗi: lấy vai từ pages.js rồi hỏi chính rbac.js xem vai đó có quyền
  // không. Ai thêm `catalog_manager` vào ORDER_ROLES cho tiện sẽ đỏ ngay tại đây, thay vì
  // phát hiện bằng một trang 403 mà người dùng gặp.
  const viPham = [];
  for (const [ten, quyen] of Object.entries(SET_QUYEN)) {
    for (const vai of vaiTrongSet(ten)) {
      if (!ROLES.includes(vai)) { viPham.push(`${ten} có vai "${vai}" KHÔNG tồn tại trong rbac.js`); continue; }
      if (!can(vai, quyen)) viPham.push(`${ten} cho "${vai}" vào, nhưng vai đó KHÔNG có ${quyen}`);
    }
  }
  assert.deepEqual(viPham, [], 'lưới việc/nav mời bấm vào trang mà vai đó bị 403');
});

test('mỗi ô "Việc cần làm" khai đúng một Set vai (see:) và một tầng (tier:)', () => {
  const than = thanRenderOverview();
  const i = than.indexOf('const TODO = [');
  assert.ok(i > 0, 'không tìm thấy mảng TODO — mốc chết');
  const mang = than.slice(i, than.indexOf('\n  ].filter(', i));
  assert.ok(mang.length > 200, 'cắt hụt mảng TODO — mốc chết');
  // Mỗi phần tử bắt đầu bằng `{ tier:`; đếm theo `label:` để không phụ thuộc thứ tự khoá.
  const soO = (mang.match(/\blabel:/g) ?? []).length;
  assert.ok(soO >= 10, `chỉ thấy ${soO} ô — mốc chết hoặc lưới bị cắt`);
  assert.equal((mang.match(/\bsee: [A-Z_]+/g) ?? []).length, soO, 'có ô KHÔNG khai see: → hiện cho mọi vai, kể cả vai bị 403 ở trang đích');
  assert.equal((mang.match(/\btier: [123]\b/g) ?? []).length, soO, 'có ô KHÔNG khai tier: → rơi ra ngoài cả ba nhóm và biến mất khỏi giao diện');
  // Mọi Set được dùng phải nằm trong bảng ánh xạ trên — nếu không, test đầu tiên không hề
  // kiểm nó và ta lại có một Set không ai đối chiếu với rbac.js.
  for (const m of mang.matchAll(/\bsee: ([A-Z_]+)/g)) {
    assert.ok(SET_QUYEN[m[1]], `ô dùng ${m[1]} — chưa khai trong SET_QUYEN nên KHÔNG được đối chiếu với rbac.js`);
  }
  // Lọc phải thật sự chạy, không chỉ khai dữ liệu rồi bỏ đó.
  assert.match(than, /\.filter\(\(x\) => x\.see\.has\(ctx\.role\)\)/);
});

test('hai ô từng dẫn vào 403 nay gắn đúng Set vai', () => {
  const than = thanRenderOverview();
  // Đánh giá → /reviews (seller đòi content.write) · Sắp hết hàng → /products (catalog.read).
  // Cắt theo DÒNG, không theo cặp ngoặc: mỗi ô nằm gọn một dòng, còn `[^{}]*` không băng qua
  // được `${base}` bên trong chính ô đó nên luôn khớp rỗng và test xanh giả.
  const dongO = (nhan) => {
    const d = than.split('\n').find((x) => x.includes(`label: '${nhan}'`));
    assert.ok(d, `không tìm thấy ô "${nhan}" — mốc chết, sửa lại bộ test`);
    return d;
  };
  const danhGia = dongO('Đánh giá chờ duyệt');
  const sapHet = dongO('Sắp hết hàng');
  assert.match(danhGia, /see: CONTENT_ROLES/, 'ô Đánh giá lại hiện cho vai không có content.write');
  assert.match(sapHet, /see: CATALOG_ROLES/, 'ô Sắp hết hàng lại hiện cho vai không có catalog.read');
  // ĐÓNG MẮT XÍCH. Hai khẳng định trên chỉ đúng nếu trang đích THẬT SỰ đòi quyền ta đang giả
  // định. Neo thẳng vào bảng route của seller: nới quyền ở đó mà quên nới `see` (hoặc ngược
  // lại) thì đỏ ngay, thay vì để hai bên trôi cho tới khi một vai gặp 403 trên màn hình.
  const rvRoute = /\^\/shops\/\$\{UUID\}\/reviews\$`\), perm: '([a-z.]+)'/.exec(rd('apps/seller/src/reviews.js'));
  assert.ok(rvRoute, 'không tìm thấy route GET /reviews ở seller — mốc chết');
  assert.equal(SET_QUYEN.CONTENT_ROLES, rvRoute[1], `GET /reviews nay đòi "${rvRoute[1]}" chứ không phải "${SET_QUYEN.CONTENT_ROLES}" — ô Đánh giá đang gắn Set vai sai`);
  const spRoute = /\^\/shops\/\$\{UUID\}\/products\$`\), perm: '([a-z.]+)'/.exec(rd('apps/seller/src/catalog.js'));
  assert.ok(spRoute, 'không tìm thấy route GET /products ở seller — mốc chết');
  assert.equal(SET_QUYEN.CATALOG_ROLES, spRoute[1], `GET /products nay đòi "${spRoute[1]}" — ô Sắp hết hàng đang gắn Set vai sai`);
  // Và link phải nêu RÕ bộ lọc, không ăn may vào giá trị mặc định của seller.
  assert.match(danhGia, /\/reviews\?status=pending/, 'link đánh giá dựa vào mặc định của seller → đổi mặc định là con số dẫn sai mà không lỗi nào hiện ra');
});

test('thẻ tồn thấp giữ dữ liệu vận hành nhưng chỉ vai cấu hình được mới thấy link settings', () => {
  const than = thanRenderOverview();
  const moc = than.indexOf('⚠ Sắp hết hàng</h2>');
  assert.ok(moc > 0, 'không tìm thấy thẻ tồn thấp — mốc chết');
  const khoi = than.slice(moc, than.indexOf("</div>` : ''}", moc));
  assert.match(khoi, /CONTENT_ROLES\.has\(ctx\.role\)/,
    'link Cài đặt tồn thấp không gác bằng cùng Set với sideNav');
  assert.match(khoi, /Ngưỡng cảnh báo do chủ shop hoặc quản trị viên cấu hình/,
    'vai thiếu quyền bị mất cả lời giải thích ai là người cấu hình ngưỡng');
  assert.match(khoi, /href="\$\{base\}\/settings"/,
    'owner/admin mất lối chỉnh ngưỡng từ thẻ tồn thấp');
});

test('mọi link đơn hàng ĐI TỪ Tổng quan mang theo migrated=0', () => {
  const than = thanRenderOverview();
  // Chỉ xét link LỌC THEO TRẠNG THÁI: đó là các link mà con số đi kèm được đếm với
  // `WHERE NOT is_migrated` ở dashboard.js. Link lọc theo thanh toán KHÔNG cần, vì
  // PAYMENT_ACTIONABLE_SQL (packages/orders/src/owed.js) đã mang sẵn điều kiện đó — đếm và
  // danh sách vốn cùng một tập.
  // Trạng thái có thể là chữ thường (`status=pending`) HOẶC một biểu thức (`status=${x.k}`
  // ở lưới thẻ trạng thái). Bản đầu của bộ này chỉ khớp `[a-z]+` nên bỏ lọt đúng lưới thẻ —
  // tức bỏ lọt chỗ lệch NHIỀU nhất, vì `delivered`/`cancelled` là hai trạng thái mà đơn nhập
  // từ sàn cũ thật sự rơi vào (O_STATUS ở import.js chỉ sinh ba trạng thái terminal).
  const links = [...than.matchAll(/\/orders\?status=[^"'`\s]*/g)].map((m) => m[0]);
  const thieu = links.filter((l) => !/migrated=0/.test(l));
  assert.deepEqual(thieu, [], 'ô/thẻ đếm KHÔNG kể đơn di cư nhưng mở ra danh sách CÓ kể → con số không dẫn tới tập nó đếm');
  // Chốt mốc: đây là chốt mức MÃ NGUỒN nên đếm CHỖ VIẾT, không đếm link đã render — lưới năm
  // thẻ trạng thái chỉ là MỘT chỗ viết (`.map`). Ba chỗ: lưới thẻ + hai ô đơn.
  assert.ok(links.length >= 3, `chỉ thấy ${links.length} chỗ viết link trạng thái — mốc chết, regex không còn khớp`);
});

test('seller đọc migrated và BFF chuẩn hoá về allowlist', () => {
  const orders = boChuThich(rd('apps/seller/src/orders.js'));
  assert.match(orders, /const migrated = \(query\.get\('migrated'\) \?\? ''\)\.trim\(\)/);
  assert.match(orders, /if \(migrated === '0'\) where\.push\('NOT o\.is_migrated'\)/);
  assert.match(orders, /else if \(migrated === '1'\) where\.push\('o\.is_migrated'\)/);
  // Mặc định KHÔNG lọc: đơn di cư vào hệ thống để TRA CỨU (0104). Lọc mặc định thì gõ SĐT
  // khách ra thiếu lịch sử và nhân viên trả lời khách "bên em không có đơn nào của anh/chị".
  assert.doesNotMatch(orders, /where\.push\('NOT o\.is_migrated'\);\s*\n\s*const countArgs/, 'lọc vô điều kiện → mất đường tra cứu lịch sử khách');
  const server = boChuThich(rd('apps/seller-admin/src/server.js'));
  assert.match(server, /\['0', '1'\]\.includes\(\(q\.get\('migrated'\) \?\? ''\)\.trim\(\)\)/, 'BFF không chuẩn hoá → ?migrated=xyz hiện chip "đang lọc" giả');
});

test('landingPath không đẩy vai thiếu orders.read vào Tổng quan', () => {
  // Lỗi thật đang vá: mọi vai đều bị redirect thẳng tới /overview sau khi đăng nhập, mà
  // /overview gọi GET /stats (perm orders.read). `catalog_manager` gặp trang lỗi MỖI LẦN
  // đăng nhập, và sideNav cũng ẩn "Tổng quan" khỏi họ nên không có mục nào để bấm lùi.
  const i = pages.indexOf('export function landingPath(');
  assert.ok(i > 0, 'không tìm thấy landingPath — mốc chết');
  const than = boChuThich(pages.slice(i, pages.indexOf('\n}', i) + 2));
  const dieuKienOverview = /if \((ORDER_ROLES|CATALOG_ROLES|CONTENT_ROLES)\.has\(role\)\) return \{ href: `\$\{base\}\/overview`/.exec(than);
  assert.ok(dieuKienOverview, 'landingPath không còn gác /overview theo Set vai nào — mốc chết');
  // Đích /overview chỉ được mở cho Set nào mà MỌI vai trong đó thật sự có orders.read.
  for (const vai of vaiTrongSet(dieuKienOverview[1])) {
    assert.ok(can(vai, 'orders.read'), `landingPath đưa "${vai}" tới /overview nhưng vai đó không có orders.read → 403 ngay sau khi đăng nhập`);
  }
  // Vai lạ không được đoán bừa một trang có thể 403.
  assert.match(than, /return \{ href: '\/', label: '[^']+' \};/, 'vai chưa khai phải về màn chọn cửa hàng, không đoán');
  const server = boChuThich(rd('apps/seller-admin/src/server.js'));
  assert.match(server, /redirect\(res, V\.landingPath\(mems\[0\]\.shop_id, mems\[0\]\.role\)\.href\)/, 'đăng nhập vẫn đẩy thẳng /overview cho mọi vai');
  assert.match(server, /if \(r\.status === 403\) \{/, 'overviewPage không còn nhánh 403 riêng → vai thiếu quyền lại thấy câu "không tải được", tưởng hệ thống hỏng');
});
