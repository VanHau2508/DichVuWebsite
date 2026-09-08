// UNIT: hai bản `hostname.js` (seller + tls-authorize) phải XỬ SỰ GIỐNG NHAU.
//
// VÌ SAO CÓ BỘ NÀY. `normalizeHostname` + `isReserved` tồn tại HAI BẢN chép tay:
//   · apps/seller/src/hostname.js        — gác đường THÊM tên miền vào bảng `domains`
//   · apps/tls-authorize/src/hostname.js — gác đường CẤP CHỨNG CHỈ (Caddy hỏi `ask`)
// Không gộp được: tls-authorize build từ context `../apps/tls-authorize` (infra/compose.*.yml)
// nên image của nó KHÔNG có `packages/`, và nó cố ý không có bind-mount nào — cùng lý do đã
// ghi ở đầu `shared-sql.test.js`.
//
// Đo được ở đợt đo 5 lát cắt 7 (08/09), và đó là lý do bộ này ra đời:
//   · hai bản ĐÃ trôi 26 dòng (bản seller có thêm `MULTI_LABEL_SUFFIX` + `isApex`);
//   · trôi hôm nay LÀNH — `isApex` tự khai "KHÔNG BAO GIỜ dùng cho quyết định bảo mật" và
//     tls không import nó — nhưng KHÔNG chốt nào bắt được chuyện đó;
//   · mỗi bản có chốt RIÊNG (tls: `apps/tls-authorize/test/hostname.test.js`; seller:
//     `apps/seller/test/domains.e2e.mjs:183-185`), nên vá bug ở MỘT bản thì cả hai bộ vẫn
//     xanh. Đột biến đo được: gỡ `isReserved` + chốt wildcard ở bản SELLER → unit 337/337.
//
// KHẲNG ĐỊNH LÀ "XỬ SỰ GIỐNG", KHÔNG PHẢI "GIỐNG TỪNG KÝ TỰ". So byte là chốt CHÍNH TẢ và
// nó SAI ngay hôm nay (26 dòng lệch hợp lệ). Thứ đáng giữ là hậu quả: một hostname mà seller
// nhận thì tls phải cấp được cert, và ngược lại. Lệch hai chiều đều hỏng im lặng —
//   · seller LỎNG hơn ⇒ shop thêm được tên miền mà không bao giờ có HTTPS;
//   · tls LỎNG hơn ⇒ mất lớp phòng thủ chiều sâu của `isReserved` ở cửa cấp cert.
//
// KHI ĐỎ: đừng sửa test cho khớp. Đọc CẢ HAI bản, quyết bản nào ĐÚNG, rồi sửa bản còn lại.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as bSeller from '../src/hostname.js';
import * as bTls from '../../tls-authorize/src/hostname.js';

// Ca viết tay: mỗi ca đi qua ĐÚNG một chốt trong `normalizeHostname`, cộng các hình dạng
// thật đã gặp (FQDN có dấu chấm cuối, punycode, đuôi nhiều nhãn kiểu com.vn).
const CA_TAY = [
  'shopa.test', 'shop-a.co.uk', 'a.b', 'cuahang.com.vn', 'xn--th-e0a.vn',
  'SHOPA.TEST', '  ShopA.Test  ', 'shopa.test.', 'SHOPA.TEST.',
  '*.shopa.test', '*', 'shopa.test:443', '[::1]', '1.2.3.4', '::1',
  'shop_a.test', 'a_b.c', 'shopa', 'localhost', '', '.', '..', 'a..b',
  '-shopa.test', 'shopa-.test', 'shopa.test-', 'shopa.123', 'shopa.1',
  'khong hop le!!', 'shopa.test/../x', 'shopa.test?x=1', 'shopa.tést',
  'a'.repeat(64) + '.test', 'a'.repeat(63) + '.test',
  ('b'.repeat(60) + '.').repeat(5) + 'test',
  'nentang.vn', 'NENTANG.VN', 'admin.nentang.vn', 'a.b.nentang.vn',
  'xnentang.vn', 'nentang.vn.evil.com', 'evilnentang.vn', 'nentang.vn.',
];

// Quét sinh máy: bảng chữ cái THÙ ĐỊCH có chủ ý (mọi ký tự từng là ranh giới của một chốt).
// Sinh tất định bằng LCG để lượt nào cũng đúng tập đó — một chốt chập chờn là chốt vô dụng.
function caSinh(n) {
  const ALPHA = 'ab09-_.:*!/ ÁđA';
  let s = 0x2545f491;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out = [];
  for (let i = 0; i < n; i++) {
    const len = 1 + Math.floor(rnd() * 24);
    let h = '';
    for (let j = 0; j < len; j++) h += ALPHA[Math.floor(rnd() * ALPHA.length)];
    out.push(h);
  }
  return out;
}

const CORPUS = [...CA_TAY, ...caSinh(3000)];
const PLATFORM = ['nentang.vn', 'NENTANG.VN', 'test', '', 'a.b.c'];

// ── Phép đo phải TỰ CHỐI khi nó không đo gì ─────────────────────────────────────
// Không có khối này thì một đột biến làm CẢ HAI bản luôn trả null vẫn "bằng nhau" và bộ
// này xanh trong khi nó không còn chứng minh điều gì. Cùng nguyên tắc với probe 360px phải
// tự chối khi khung nhìn sai (§4).
test('phép đo tự chối: corpus phải đi qua cả hai nhánh của cả hai hàm', () => {
  assert.notEqual(bSeller.normalizeHostname, bTls.normalizeHostname, 'hai bản phải là hai module khác nhau');

  const nhan = CORPUS.filter((h) => bSeller.normalizeHostname(h) !== null).length;
  assert.ok(nhan >= 10, `corpus chỉ có ${nhan} hostname được NHẬN — không đi qua nhánh hợp lệ`);
  assert.ok(CORPUS.length - nhan >= 10, `corpus chỉ có ${CORPUS.length - nhan} hostname bị TỪ CHỐI`);

  const giu = CA_TAY.filter((h) => bSeller.isReserved(h.toLowerCase().trim(), 'nentang.vn')).length;
  assert.ok(giu >= 3, `chỉ ${giu} ca chạm nhánh isReserved=true`);
  assert.ok(CA_TAY.length - giu >= 3, 'không đủ ca chạm nhánh isReserved=false');
});

test('normalizeHostname: hai bản trả CÙNG kết quả trên toàn corpus', () => {
  const lech = [];
  for (const h of CORPUS) {
    const a = bSeller.normalizeHostname(h);
    const b = bTls.normalizeHostname(h);
    if (a !== b) lech.push(`${JSON.stringify(h)}: seller=${JSON.stringify(a)} tls=${JSON.stringify(b)}`);
  }
  assert.deepEqual(lech, [], `hai bản hostname.js đã TRÔI LỆCH ở ${lech.length}/${CORPUS.length} ca:\n  ${lech.slice(0, 8).join('\n  ')}`);
});

test('isReserved: hai bản trả CÙNG kết quả trên mọi (hostname, platformDomain)', () => {
  const lech = [];
  for (const p of PLATFORM) {
    for (const h of CORPUS) {
      // isReserved nhận hostname ĐÃ chuẩn hoá; đưa cả chuỗi thô vào thì đang đo một hợp
      // đồng khác. Ca nào không chuẩn hoá được thì không tới được isReserved trong mã thật.
      const n = bSeller.normalizeHostname(h);
      if (n === null) continue;
      const a = bSeller.isReserved(n, p);
      const b = bTls.isReserved(n, p);
      if (a !== b) lech.push(`(${JSON.stringify(n)}, ${JSON.stringify(p)}): seller=${a} tls=${b}`);
    }
  }
  assert.deepEqual(lech, [], `isReserved đã TRÔI LỆCH ở ${lech.length} ca:\n  ${lech.slice(0, 8).join('\n  ')}`);
});
