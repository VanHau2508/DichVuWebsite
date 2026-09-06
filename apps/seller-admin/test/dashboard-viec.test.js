// UNIT: hộp "Việc cần làm" trên Tổng quan — mỗi ô phải HIỂN THỊ THỨ NÓ ĐẾM; chỉ link/nút
// dẫn tới trang đích mới bị gác theo vai.
//
// VÌ SAO CÓ BỘ NÀY. Hai lớp lỗi đo được trên nhánh trước, cả hai đều VÔ HÌNH với e2e hiện có
// (mọi bộ e2e đều đăng nhập bằng owner — vai có đủ mọi quyền, nên không bộ nào đi qua nhánh
// thiếu quyền):
//
//   1. QUYỀN. Vai `order_manager` (chỉ orders.read/write) vẫn phải thấy số "Đánh giá chờ
//      duyệt" và "Sắp hết hàng" như thông tin vận hành chung, nhưng không được thấy link
//      tới /reviews hoặc /products vì hai trang đó sẽ 403.
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
const roles = rd('apps/seller-admin/src/roles.js');
const roleSources = `${roles}\n${pages}`;

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
// `catalog.read` đại diện cho CATALOG_ROLES dù `/products/new` thật ra cần `catalog.write`:
// hai quyền đó do đúng cùng một bộ vai nắm ({owner, admin, catalog_manager}), nên đối chiếu
// bằng quyền nào cũng bắt được cùng một lớp lỗi. Tách ra chỉ khi hai bộ vai bắt đầu khác nhau.
const SET_QUYEN = {
  ORDER_ROLES: 'orders.read',
  CATALOG_ROLES: 'catalog.read',
  CONTENT_ROLES: 'content.write',
  DOMAIN_ROLES: 'domain.write',
  REPORT_ROLES: 'reports.read',
  INVENTORY_ROLES: 'inventory.manage',
  REFUND_ROLES: 'refund',
  PAYMENT_ROLES: 'payment.write',
};

function vaiTrongSet(ten) {
  const m = new RegExp(`const ${ten} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(roleSources);
  assert.ok(m, `không tìm thấy ${ten} trong roles.js/pages.js — mốc chết`);
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

test('registry "Việc cần làm" khai đúng một Set vai (see:) và một tầng (tier:)', () => {
  const than = thanRenderOverview();
  const i = than.indexOf('const TODO_REGISTRY = [');
  assert.ok(i > 0, 'không tìm thấy registry TODO — mốc chết');
  const mang = than.slice(i, than.indexOf('\n  ];', i));
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
  assert.match(than, /canOpen: x\.see\.has\(ctx\.role\)/);
  assert.match(than, /if \(!x\.canOpen\) return `<div class="todo-cell readonly/);
});

test('hai ô từng dẫn vào 403 nay gắn đúng Set vai', () => {
  const than = thanRenderOverview();
  // Đánh giá → /reviews (seller đòi content.write) · Sắp hết hàng → /products (catalog.read).
  // Cắt theo DÒNG, không theo cặp ngoặc: mỗi ô nằm gọn một dòng, còn `[^{}]*` không băng qua
  // được `${base}` bên trong chính ô đó nên luôn khớp rỗng và test xanh giả.
  const dongO = (nhan) => {
    const d = than.split('\n').find((x) => x.includes(`label: () => '${nhan}'`));
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

// ───────────────────────────────────────────────────────────────────────────────
// MANIFEST LỐI ĐI CỦA TỔNG QUAN
//
// VÌ SAO CẦN, dù đã có ba chốt ở trên. Ba chốt kia canh TỪNG TRƯỜNG HỢP đã biết. Chúng
// không hề biết trang có bao nhiêu lối đi, nên thêm một link mới KHÔNG gác thì cả bộ vẫn
// xanh — đã đo: chèn `<a href="${base}/members">` vào giữa renderOverview, 7/7 test qua.
// Và lớp lỗi này KHÔNG phải giả định: chính lần liệt kê đầu tiên đã lôi ra ba lỗi live —
// thẻ gợi ý "Tên miền riêng" (DOMAIN_ROLES chỉ owner, mà thẻ hiện cho cả admin), nút hero
// dự phòng "+ Thêm sản phẩm" (`/products/new` cần catalog.write, hiện cho order_manager khi
// hết việc tồn đọng), và `readinessErrHref` không đi qua allowlist như `safeHref`.
//
// CÁCH CHUẨN HOÁ ĐÍCH — cố ý THU QUÁ TAY chứ không thu thiếu:
//   1. Rút MỌI `${base}/…` trong thân hàm, bất kể vị trí cú pháp. Bắt theo `href=` là không
//      đủ: link chi tiết đơn được gán vào biến `href` rồi mới render, nên cách cũ bỏ sót nó.
//      `action=` của form cũng vào manifest — form POST cũng là một lối đi.
//   2. Bỏ query và fragment: `?status=…`, `#shipment-attention` không đổi TRANG đích.
//   3. Mọi `${…}` còn lại trong path → `:id`, để `/orders/${esc(item.order_id)}` và
//      `/orders/${x}` gộp về đúng một đích `/orders/:id`.
//   4. Đòi ít nhất một ký tự sau `${base}/` — nếu không, biểu thức allowlist
//      `s.startsWith(`${base}/`)` bị đếm nhầm thành một đích.
//
// So BẰNG, không phải ⊇ — cùng kỷ luật với MANIFEST_*_COUNT: thêm lối đi thì phải khai
// chính sách quyền của nó trong CÙNG commit, và người review thấy dòng mới trong diff.
const CHUAN_HOA = (p) => p.split('?')[0].split('#')[0].replace(/\$\{[^}]*\}/g, ':id');
function dichNoiBo(than) {
  const out = new Map();
  for (const m of than.matchAll(/\$\{base\}(\/[^`"'\s>]+)/g)) {
    const n = CHUAN_HOA(m[1]);
    out.set(n, (out.get(n) ?? 0) + 1);
  }
  return out;
}

// Chính sách của TỪNG đích. Giá trị là một trong ba dạng:
//   · tên Set vai  → phải xuất hiện trong vòng 2 dòng quanh đích, VÀ được đối chiếu với
//                    ma trận quyền thật của seller (test "Set vai … khớp ma trận quyền").
//   · 'canManage'  → gác bằng `setup.canManage` (owner/admin), phải có trong vòng 2 dòng.
//   · 'trang'      → gác ở MỨC TRANG: cả /overview đã 403 với vai ngoài ORDER_ROLES (BFF
//                    overviewPage), nên không cần gác lại từng link. KHÔNG có chốt tĩnh cho
//                    dạng này, nên số lượng bị khoá cứng ở SO_DICH_TRANG bên dưới — dán nhãn
//                    'trang' cho một đích mới là việc phải cố ý và người review thấy.
const CHINH_SACH_DICH = {
  '/orders': 'ORDER_ROLES',
  '/orders/owed': 'ORDER_ROLES',
  '/orders/:id': 'trang',
  '/order-requests': 'ORDER_ROLES',
  '/resolution-cases': 'ORDER_ROLES',
  '/notification-deliveries': 'ORDER_ROLES',
  // Ảnh không tải được: seller gác GET /media-failures bằng catalog.read, đúng bộ vai mà
  // CATALOG_ROLES giữ. Vai order_manager vẫn THẤY con số trên Tổng quan (số liệu vận hành
  // chung — §9.3) nhưng không nhận link, vì trang đích sẽ 403 với họ.
  '/media-failures': 'CATALOG_ROLES',
  '/customers': 'ORDER_ROLES',
  '/overview': 'trang',
  '/reviews': 'CONTENT_ROLES',
  '/settings': 'CONTENT_ROLES',
  '/products': 'CATALOG_ROLES',
  '/products/new': 'CATALOG_ROLES',
  '/promotions': 'CATALOG_ROLES',
  '/domains': 'DOMAIN_ROLES',
  '/reports': 'REPORT_ROLES',
  '/purchasing': 'INVENTORY_ROLES',
  '/onboarding': 'canManage',
  '/preview': 'canManage',
  '/activate': 'canManage',
};
const SO_DICH_TRANG = 2;

// Biểu thức href KHÔNG phải `${base}/…`. Mỗi cái phải khai rõ nó là gì — thêm một tầng gián
// tiếp mới (`href="${abc.href}"` chẳng hạn) là mở một lối đi mà manifest trên không thấy.
const HREF_GIAN_TIEP = {
  '${x.href}': 'render ô TODO (gác link bằng canOpen) và thẻ SUGG (lọc theo see.has(ctx.role))',
  '${href}': 'render dòng vận đơn — biến cục bộ dựng từ `${base}/orders/…`, đã có trong manifest',
  '${cta.href}': 'nút hero — lấy từ TODO đã lọc, hoặc nhánh dự phòng gác bằng CATALOG_ROLES',
  '${esc(safeHref)}': 'link readiness động — đi qua allowlist noiBo()',
  '${esc(noiBo(readinessErrHref))}': 'link lỗi go-live động — đi qua CÙNG allowlist noiBo()',
};
// Link NGOÀI: tách hẳn khỏi manifest nội bộ. Đây là URL tuyệt đối tới tên miền của chính
// shop (storefront), không phải đường trong seller-admin, nên KHÔNG có "vai" nào để đối
// chiếu — đem nó vào bảng chính sách quyền là so sai loại.
const HREF_NGOAI = { '${esc(preview.preview_url)}': 'link xem trước storefront — tuyệt đối, mở tab mới' };

test('manifest lối đi: mọi đích nội bộ của Tổng quan đều đã khai chính sách quyền', () => {
  const than = thanRenderOverview();
  const thay = [...dichNoiBo(than).keys()].sort();
  const khai = Object.keys(CHINH_SACH_DICH).sort();
  assert.deepEqual(thay, khai,
    'lối đi trên Tổng quan lệch manifest — thêm link mới thì khai chính sách của nó vào CHINH_SACH_DICH trong CÙNG commit, đừng xoá dòng cho hết đỏ');
  assert.equal(Object.values(CHINH_SACH_DICH).filter((v) => v === 'trang').length, SO_DICH_TRANG,
    "số đích dán nhãn 'trang' đổi — nhãn này KHÔNG có chốt tĩnh nào, nên nó phải hiếm và phải cố ý");
  for (const [dich, cs] of Object.entries(CHINH_SACH_DICH)) {
    if (cs === 'trang' || cs === 'canManage') continue;
    assert.ok(SET_QUYEN[cs], `đích ${dich} khai Set "${cs}" chưa có trong SET_QUYEN → không ai đối chiếu nó với rbac.js`);
  }
});

test('manifest lối đi: mỗi đích có điều kiện gác NGAY CẠNH nó trong mã', () => {
  const than = thanRenderOverview();
  const dong = than.split('\n');
  const viPham = [];
  for (const [dich, cs] of Object.entries(CHINH_SACH_DICH)) {
    if (cs === 'trang') continue;
    const canCo = cs === 'canManage' ? 'setup.canManage' : cs;
    // Cửa sổ 6 dòng TRƯỚC + chính dòng đó. Ban đầu tôi để 2 và nó đỏ ở `/activate`: form đó
    // nằm 3 dòng dưới `const controls = setup.canManage ? …`, tức gác ĐÚNG mà cửa sổ hẹp quá.
    //
    // ĐÁNH ĐỔI, nói thẳng: đây là kiểm KHOẢNG CÁCH, không phải kiểm phạm vi khối. Cửa sổ rộng
    // có thể nhận nhầm điều kiện của khối liền kề và cho qua một link thật ra không gác. Thứ
    // bù lại không phải regex khéo hơn mà là MA TRẬN ĐỘT BIẾN: gỡ gác của từng đích rồi chạy
    // lại, chốt phải đỏ. Đã chạy cho /settings, /domains, /products/new và cả ca thêm link
    // mới — kết quả ghi trong docs. Sửa cửa sổ này thì chạy lại ma trận đó.
    const dat = dong.some((d, k) => {
      if (!new RegExp(`\\$\\{base\\}${dich.replace(/[/:]/g, '\\$&')}(?![a-z-])`).test(d)) return false;
      // Ô của TODO_REGISTRY nằm GỌN MỘT DÒNG: `see:` và `href:` cùng dòng. Với chúng thì đây
      // là kiểm PHẠM VI KHỐI được, không phải kiểm khoảng cách — nên siết vào đúng dòng đó.
      //
      // VÌ SAO PHẢI SIẾT, đo được 06/09: đột biến đổi `see: CATALOG_ROLES` → `ORDER_ROLES` trên
      // ô "Ảnh không tải được" cho **11/0 XANH**. Cửa sổ 6 dòng nhìn ngược lên và trúng ô
      // "Sắp hết hàng" ngay phía trên — ô đó cũng khai CATALOG_ROLES, nên nó ĐỠ HỘ ô vừa bị
      // đổi. Đúng cái đánh đổi mà chú thích ngay trên đã cảnh báo, và nó lộ ra vì e2e đỏ
      // (order_manager được mời bấm) trong khi chốt tĩnh này im.
      const seOnLine = /\bsee: ([A-Z_]+)/.exec(d);
      if (seOnLine) return seOnLine[1] === canCo;
      return dong.slice(Math.max(0, k - 6), k + 1).some((x) => x.includes(canCo));
    });
    if (!dat) viPham.push(`${dich} → không thấy "${canCo}" gác nó (ô registry thì phải ĐÚNG DÒNG)`);
  }
  assert.deepEqual(viPham, [], 'lối đi mất điều kiện gác → vai thiếu quyền lại được mời bấm vào trang sẽ từ chối');
});

test('manifest lối đi: link gián tiếp và link NGOÀI đều đã khai, không trộn vào bảng quyền', () => {
  const than = thanRenderOverview();
  const ngoaiBase = [...than.matchAll(/href[=:]\s*["`]([^"`]*)["`]/g)]
    .map((m) => m[1]).filter((h) => !h.startsWith('${base}'));
  const chuaKhai = [...new Set(ngoaiBase)]
    .filter((h) => !HREF_GIAN_TIEP[h] && !HREF_NGOAI[h]);
  assert.deepEqual(chuaKhai, [],
    'có href không phải ${base}/… và chưa khai — đó là một lối đi manifest nội bộ KHÔNG nhìn thấy');
  // Link ngoài KHÔNG được lọt vào bảng chính sách quyền: nó trỏ ra tên miền storefront của
  // shop, không có vai nào để đối chiếu. Nhầm loại ở đây là kết luận sai "link vượt quyền".
  for (const h of Object.keys(HREF_NGOAI)) {
    assert.ok(ngoaiBase.includes(h), `không còn thấy link ngoài ${h} — mốc chết`);
    assert.ok(!Object.keys(CHINH_SACH_DICH).some((d) => h.includes(d)),
      `link ngoài ${h} bị đem vào bảng chính sách quyền nội bộ`);
  }
  assert.match(than, /href="\$\{esc\(preview\.preview_url\)\}"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/,
    'link xem trước ra ngoài phải mở tab mới kèm noopener');
});

test('manifest lối đi: MỌI link readiness động đi qua CÙNG một allowlist', () => {
  const than = thanRenderOverview();
  assert.match(than, /const noiBo = \(h\) => \{[\s\S]{0,200}?startsWith\(`\$\{base\}\/`\)/,
    'allowlist noiBo biến mất hoặc đổi hình dạng — mốc chết');
  assert.match(than, /s === '\/account' \|\| s\.startsWith\(`\$\{base\}\/`\)/,
    'allowlist nới ra ngoài "/account + đường trong shop này"');
  assert.match(than, /const safeHref = noiBo\(it\.action_url\)/,
    'nút "Đi tới" của checklist không còn đi qua allowlist chung');
  // readinessErrHref TỪNG chỉ được esc() mà không qua allowlist — hai chỗ cùng nguồn dữ liệu
  // (action_url của readiness) mà chỉ một chỗ được gác.
  for (const m of than.matchAll(/href="\$\{[^"]*readinessErrHref[^"]*\}"/g)) {
    assert.match(m[0], /noiBo\(readinessErrHref\)/,
      'readinessErrHref render thẳng, không qua allowlist noiBo — hai link cùng nguồn mà gác một nửa');
  }
});
