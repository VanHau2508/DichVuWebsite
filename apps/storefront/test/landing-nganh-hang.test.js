/**
 * Hợp đồng cho mục NGÀNH HÀNG của trang chủ — băng thẻ lướt ngang kiểu hồ sơ khách hàng.
 *
 * Mục này thay cho băng chữ chạy cũ. Hình dạng thẻ (ảnh bìa · nhãn ngành · tên · mô tả ·
 * đồ nghề) cố ý dựng theo một CASE STUDY để sau này thay được bằng cửa hàng thật của khách,
 * nên bộ này canh hai nhóm khác nhau:
 *
 *   1. NỘI DUNG TRUNG THỰC — kho chưa có khách thật (CLAUDE.md §0). Mục phải nói rõ đây là
 *      cửa hàng MẪU. Ba lời chứng thực bịa ra đã từng bị gỡ khỏi trang này một lần; chốt ở
 *      đây là để lần thứ hai không lặng lẽ quay lại qua một mục khác.
 *   2. NHỮNG DÒNG MÀ MẤT ĐI THÌ LỖI ĐÃ ĐO QUAY LẠI — mỗi khẳng định dưới đây ứng với một
 *      lần hỏng có thật, ghi ngay tại chỗ.
 *
 * Bộ này neo vào MÃ NGUỒN chứ không dựng layout: đo bố cục cần headless_shell ở bề rộng
 * thật, thứ cổng CI không có (lý do đầy đủ ở landing-san-pham.test.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderLanding } from '../src/landing.js';

const SRC = readFileSync(new URL('../src/landing.js', import.meta.url), 'utf8');
// CSS đã CẮT CHÚ THÍCH — chú thích ở file nguồn mô tả chính những quy tắc từng gây lỗi,
// khớp trên toàn văn bản là khớp phải lời kể chứ không phải luật đang chạy.
const LUAT = SRC.replace(/\/\*[\s\S]*?\*\//g, '');
const KHOI = SRC.slice(SRC.indexOf('const INDUSTRIES = ['), SRC.indexOf('const STEPS = ['));
const KHOA = [...KHOI.matchAll(/key: '([a-z-]+)'/g)].map((m) => m[1]);

const trang = (assets = new Set()) => renderLanding({ assets, nonce: 'n1' });
// Cắt đúng mục đang kiểm. Khẳng định trên TOÀN trang là cách xanh giả rẻ nhất: chữ
// "cửa hàng" có ở chín mục khác.
const muc = (html) => {
  const a = html.indexOf('<section class="lp-ind"');
  const b = html.indexOf('<section', a + 10);
  assert.ok(a > 0 && b > a, 'không cắt được mục ngành hàng');
  return html.slice(a, b);
};

test('mỗi ngành hàng dựng đúng MỘT thẻ và đúng MỘT nút lọc', () => {
  const m = muc(trang());
  assert.ok(KHOA.length >= 8, `mảng INDUSTRIES chỉ đọc được ${KHOA.length} khoá`);
  const the = [...m.matchAll(/data-nh="([a-z-]+)"/g)].map((x) => x[1]);
  const loc = [...m.matchAll(/data-loc="([a-z-]*)"/g)].map((x) => x[1]);
  assert.deepEqual(the, KHOA, 'thẻ phải dựng từ chính mảng INDUSTRIES, đủ và đúng thứ tự');
  // So BẰNG, không phải ⊆: một nút lọc trỏ tới khoá không có thẻ nào thì bấm vào là băng
  // rỗng — và trông y hệt một trang hỏng, không ai đoán được là do lọc.
  assert.deepEqual(loc, ['', ...KHOA], 'hàng lọc phải là "Tất cả" + đúng bộ khoá của thẻ');
  assert.equal((m.match(/aria-pressed="true"/g) ?? []).length, 1,
    'lúc mở trang chỉ được đúng một nút lọc đang bật');
  assert.match(m, /data-loc="" aria-pressed="true"/, 'nút bật sẵn phải là "Tất cả"');
});

test('mỗi thẻ có khe ảnh riêng, chưa có tệp thì dựng khung minh hoạ', () => {
  const m = muc(trang());
  // Chưa có tệp: KHÔNG được để ô trống — mười hai thẻ mà vài ô trắng thì trông như ảnh lỗi.
  assert.equal((m.match(/class="lp-nh-mock t[123]"/g) ?? []).length, KHOA.length,
    'thiếu khung minh hoạ dự phòng ở một số thẻ');
  assert.doesNotMatch(m, /<img[^>]*\/assets\/nh-/, 'chưa có tệp mà đã dựng thẻ img');
  // Có tệp: thẻ đó phải chuyển sang ảnh thật, và CHỈ thẻ đó.
  const co = muc(trang(new Set([`nh-${KHOA[0]}.webp`])));
  assert.match(co, new RegExp(`<img src="/assets/nh-${KHOA[0]}\\.webp"`),
    'thả tệp vào assets mà thẻ không đổi sang ảnh thật');
  assert.equal((co.match(/class="lp-nh-mock t[123]"/g) ?? []).length, KHOA.length - 1,
    'thả một tệp mà số khung minh hoạ không giảm đúng một');
  // Ảnh do người ngoài thả vào nên phải có alt và phải lười tải: 12 ảnh bìa tải ngay là
  // nguyên một mục nằm dưới màn hình kéo chậm cả trang.
  assert.match(co, /<img src="\/assets\/nh-[^"]+" alt="Ảnh cửa hàng mẫu ngành [^"]*" loading="lazy"/,
    'ảnh bìa phải có alt nói rõ là hàng mẫu và phải lười tải — khớp trên CHÍNH thẻ img đó, '
    + 'không phải trên cả mục: mục còn ảnh khác thì chốt này xanh giả');
});

test('nói rõ đây là cửa hàng MẪU, không bịa khách hàng thật', () => {
  const m = muc(trang());
  assert.match(m, /chưa phải khách hàng thật/,
    'mục hồ sơ khách hàng mà không nói rõ là hàng mẫu thì đang nói dối người đọc');
  // Tên thẻ phải là tên LOẠI cửa hàng, không phải tên một shop cụ thể. Chốt này chặn đúng
  // cách mà ba lời chứng thực bịa ra đã lọt vào trang này một lần.
  const ten = [...m.matchAll(/<h3>([^<]+)<\/h3>/g)].map((x) => x[1]);
  assert.equal(ten.length, KHOA.length, 'mỗi thẻ phải có đúng một tiêu đề');
  for (const t of ten) {
    assert.match(t, /^(Cửa hàng|Nhà sách) /, `"${t}" nghe như tên một shop có thật`);
  }
});

test('băng thẻ tự nó cuộn ngang được, không kéo cả trang tràn theo', () => {
  // Cuộn ngang phải nằm TRONG băng. Để tràn ra trang thì mọi mục khác trôi ngang theo, và
  // trên điện thoại là cả trang lắc lư.
  assert.match(LUAT, /\.lp-nh-ray\{[^}]*overflow-x:auto/, 'băng thẻ phải tự cuộn ngang');
  assert.match(LUAT, /\.lp-nh-ray\{[^}]*scroll-snap-type:x mandatory/, 'thiếu điểm dừng khi vuốt');
  assert.match(LUAT, /\.lp-nh-ray\.nh-tu-chay\{[^}]*scroll-snap-type:none/,
    'tự chạy liên tục phải tắt snap để không giật từng thẻ');
  assert.match(LUAT, /\.lp-nh\{[^}]*scroll-snap-align:start/, 'thẻ phải khai điểm dừng của nó');
  // Thanh cuộn CHỈ được giấu khi có mũi tên thay thế. Giấu cả ở nhánh không JS thì người
  // dùng chuột không còn cách nào biết băng lướt được — mất 11 thẻ mà không báo gì.
  assert.match(LUAT, /html\.lpjs \.lp-nh-ray\{scrollbar-width:none\}/,
    'giấu thanh cuộn phải gác sau cờ lpjs');
  assert.doesNotMatch(LUAT, /\n\.lp-nh-ray\{[^}]*scrollbar-width:none/,
    'giấu thanh cuộn vô điều kiện thì nhánh không-JS mất lối đi');
});

test('không JS thì nút lọc và mũi tên phải biến mất, thẻ thì không', () => {
  const m = muc(renderLanding({ assets: new Set() }));   // không nonce ⇒ không script
  // Nội dung KHÔNG được phụ thuộc JS: đủ 12 thẻ, đủ chữ.
  assert.equal((m.match(/data-nh="/g) ?? []).length, KHOA.length, 'không JS mà mất thẻ');
  assert.match(m, /chưa phải khách hàng thật/, 'không JS mà mất dòng nói rõ hàng mẫu');
  // Nút bấm không làm gì thì đừng bày ra — mời bấm rồi không phản ứng là lỗi tệ hơn ẩn hẳn.
  assert.match(LUAT, /html:not\(\.lpjs\) \.lp-nh-dieu,html:not\(\.lpjs\) \.lp-nh-loc\{display:none\}/,
    'thiếu luật ẩn hàng lọc và cụm mũi tên ở nhánh không-JS');
  // Và luật đó phải nằm SAU mọi khai display của chính hai lớp ấy: cùng độ ưu tiên thì
  // quy tắc viết sau thắng, @media KHÔNG cộng thêm độ ưu tiên nào. Đã đốt một lượt vì
  // đặt display:none phía trên phần khai display:flex rồi tưởng đã ẩn.
  const an = LUAT.indexOf('html:not(.lpjs) .lp-nh-dieu');
  assert.ok(an > LUAT.lastIndexOf('.lp-nh-dieu{display:flex'), 'luật ẩn đặt TRƯỚC khai display');
  assert.ok(an > LUAT.lastIndexOf('.lp-nh-loc{flex-wrap:wrap'), 'luật ẩn đặt TRƯỚC khai display');
});

test('thẻ bị lọc ra phải biến mất thật, không chỉ mất chữ', () => {
  // .lp-nh khai display:flex, mà khai display ĐÈ MẤT display:none của thuộc tính hidden —
  // đúng cái bẫy đã cắn ngăn kéo menu: khối đóng vẫn nằm trong bố cục và Tab đi thẳng vào.
  assert.match(LUAT, /\.lp-nh\[hidden\]\{display:none\}/,
    'thiếu [hidden]{display:none} cho thẻ, lọc xong thẻ cũ vẫn chiếm chỗ');
  assert.match(SRC, /t\.hidden = !!k && t\.dataset\.nh !== k/, 'thiếu nhánh lọc theo khoá ngành');
  // Bộ đếm phải đếm thẻ ĐANG HIỆN. Đếm mảng gốc thì lọc còn 1 thẻ mà vẫn báo "3 / 12".
  assert.match(SRC, /function nhHien\(\)\{ return nhThes\.filter\(function\(e\)\{ return !e\.hidden; \}\); \}/,
    'thiếu bộ lọc thẻ đang hiện');
});

test('băng tự lướt đều sang trái và nối vòng không giật', () => {
  // Một bản bóng ẩn khỏi trợ năng cho phép chuẩn hoá scrollLeft tại cùng một hình ảnh,
  // thay vì giật ngược từ thẻ cuối về thẻ đầu.
  assert.match(SRC, /var b = t\.cloneNode\(true\);[\s\S]*?b\.setAttribute\('aria-hidden', 'true'\);/,
    'thiếu bản bóng aria-hidden để nối vòng liền mạch');
  assert.match(SRC, /return b && !b\.hidden \? b\.offsetLeft - ds\[0\]\.offsetLeft : 0;/,
    'độ dài vòng phải đo từ DOM thật sau khi lọc');
  assert.match(SRC, /nhRay\.scrollLeft \+= 1;[\s\S]*?nhRay\.scrollLeft -= dai;/,
    'mỗi nhịp phải đẩy băng sang trái rồi chuẩn hoá ở đúng một vòng');
  assert.match(SRC, /nhTimer = setInterval\(nhNhip, 24\);/,
    'tự chạy phải là nhịp ngắn liên tục, không phải nhảy một thẻ sau nhiều giây');
  // Chỉ chạy khi khối trong tầm mắt: chạy dưới đáy trang thì cuộn tới nơi đã nhảy mất mấy thẻ.
  assert.match(SRC, /function nhTrongTam\(\)\{/, 'thiếu cổng tầm mắt cho đồng hồ tự chạy');
  assert.match(SRC, /function beat\(\)\{[^}]*nhTrongTam\(\);/, 'cổng tầm mắt không được gọi mỗi nhịp cuộn');
  // Giảm chuyển động thì TẮT hẳn đồng hồ, không chỉ bỏ hiệu ứng mượt.
  assert.match(SRC, /if \(!nhTimer && !RM && nhTrong && !nhDangDung\(\) && nhRay && nhHien\(\)\.length > 1\)/,
    'đồng hồ tự chạy phải tắt khi người dùng xin giảm chuyển động');
  // Hover/focus/touch phải dừng thật, kể cả beat() tiếp tục gọi cổng tầm mắt.
  assert.match(SRC, /function nhDangDung\(\)\{ return nhTro \|\| nhNet \|\| nhCham; \}/,
    'thiếu trạng thái bảo vệ thao tác người dùng khỏi đồng hồ tự chạy');
  // Bấm chỉ tạm dừng; dừng vĩnh viễn thì bấm thử một cái là băng chết.
  assert.match(SRC, /function nhTay\(d\)\{ nhNgung\(\); nhBuoc\(d\); nhHenChay\(\); \}/,
    'bấm mũi tên phải hẹn chạy lại, không giết băng');
  // Vị trí đọc từ scrollLeft THẬT: giữ một biến chỉ số riêng thì người dùng vuốt tay xong
  // mũi tên nhảy về chỗ cũ.
  assert.match(SRC, /var x = nhRay\.scrollLeft, dai = nhDoDaiVong\(\), k = 0, gan = Infinity;/,
    'vị trí thẻ phải đọc từ scrollLeft, không từ một biến đếm riêng');
});

test('hàng đồ nghề dán đáy thẻ — chốt độ ưu tiên với .lp ul', () => {
  // .lp ul{margin:0} có độ ưu tiên (0,1,1), cao hơn một lớp trần (0,1,0). Viết .lp-nh-tg
  // không thôi thì margin-top:auto bị nuốt im lặng và thẻ nào ít đồ nghề sẽ có gạch ngang
  // trôi lên giữa thẻ — đo được lệch 35px so với thẻ bên cạnh.
  assert.match(LUAT, /\.lp-nh \.lp-nh-tg\{[^}]*margin-top:auto/,
    'hàng đồ nghề phải khai ở độ ưu tiên thắng được .lp ul');
  assert.doesNotMatch(LUAT, /\n\.lp-nh-tg\{/, 'khai bằng một lớp trần sẽ bị .lp ul đè');
  // Ảnh bìa khoá tỉ lệ: mười hai thẻ mà chỉ thay được vài ảnh thì ảnh cao thấp khác nhau
  // sẽ đẩy phần chữ lệch nhau.
  assert.match(LUAT, /\.lp-nh-anh\{[^}]*aspect-ratio:16\/10/, 'ảnh bìa phải khoá tỉ lệ');
  assert.match(LUAT, /\.lp-nh-anh img\{[^}]*object-fit:cover/, 'ảnh bìa phải cắt ảnh, không cắt bố cục');
});

test('hàng lọc ở màn hẹp là MỘT hàng cuộn ngang', () => {
  // Đo được ở 390px: 13 nút xuống dòng thành BẢY hàng, đẩy thẻ đầu tiên xuống dưới mép
  // màn hình — người cuộn tới mục này chỉ thấy một rừng nút, không thấy thứ nút đó lọc.
  assert.match(LUAT, /\.lp-nh-loc\{display:flex;flex-wrap:nowrap;overflow-x:auto/,
    'màn hẹp phải giữ hàng lọc trên MỘT hàng');
  assert.match(LUAT, /@media\(min-width:960px\)\{\s*\.lp-nh-loc\{flex-wrap:wrap;justify-content:center/,
    'từ 960px hàng lọc mới được xuống dòng và căn giữa');
});
