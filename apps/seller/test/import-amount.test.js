/**
 * Unit test BỘ ĐỌC SỐ TIỀN của bộ nhập di cư (docs/45).
 *   node --test apps/seller/test/import-amount.test.js
 *
 * Vì sao đáng có test riêng: đây là chỗ SAI TIỀN dễ nhất của cả tính năng, và cái sai không
 * hề lộ ra — nó cho con số vẫn trông hợp lý. Bản đầu chỉ "bỏ ký tự không phải số", đúng với
 * kiểu Việt Nam và sai GẤP 100 LẦN với tệp Shopify (giá ghi kèm 2 số thập phân).
 *
 * Test chạy trong mili-giây, không cần stack — nên vào được cổng unit của MỌI commit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, parseOrderDate } from '../src/import-parse.js';

test('kiểu Việt Nam: dấu chấm/phẩy là PHÂN NHÓM', () => {
  const cases = [
    ['199000', 199000], ['199.000', 199000], ['199,000', 199000],
    ['1.250.000', 1250000], ['1,250,000', 1250000],
    ['4.990.000', 4990000], ['1.000', 1000],
  ];
  for (const [inp, want] of cases) assert.equal(parseAmount(inp), want, `${inp} → ${want}`);
});

test('kiểu Shopify: 2 chữ số thập phân — chỗ từng SAI GẤP 100 LẦN', () => {
  const cases = [
    ['199000.00', 199000],       // ← bản cũ ra 19.900.000
    ['450000.0', 450000],        // ← bản cũ ra 4.500.000
    ['1,250,000.00', 1250000],   // ← bản cũ ra 125.000.000
    ['89000.50', 89001],         // VND không có xu → làm tròn
    ['0.00', 0],
  ];
  for (const [inp, want] of cases) assert.equal(parseAmount(inp), want, `${inp} → ${want}`);
});

test('kiểu châu Âu: phẩy là thập phân, chấm là phân nhóm', () => {
  assert.equal(parseAmount('1.250.000,00'), 1250000);
  assert.equal(parseAmount('19,99'), 20);           // làm tròn
  assert.equal(parseAmount('1.234,56'), 1235);
});

test('ký hiệu tiền tệ và khoảng trắng bị bỏ qua', () => {
  for (const inp of ['199.000₫', '199.000 đ', 'VND 199.000', ' 199 000 ', '199.000 VNĐ']) {
    assert.equal(parseAmount(inp), 199000, inp);
  }
});

test('rác → giá trị mặc định, KHÔNG bịa số', () => {
  // Trả về mặc định là điều kiện để tầng trên báo "giá không hợp lệ" và BỎ dòng đó.
  // Nếu ở đây bịa ra 0 thì sản phẩm sẽ được tạo với giá 0 — bán mất hàng.
  for (const inp of ['', '   ', 'abc', 'liên hệ', null, undefined, '.', ',']) {
    assert.equal(parseAmount(inp), null, JSON.stringify(inp));
  }
  assert.equal(parseAmount('abc', 0), 0, 'mặc định truyền vào được dùng');
});

test('số âm giữ dấu', () => {
  assert.equal(parseAmount('-199.000'), -199000);
  assert.equal(parseAmount('-19,99'), -20);
});

test('QUYẾT ĐỊNH CÓ CHỦ ĐÍCH: "199.000" là 199 nghìn, không phải 199 đồng', () => {
  // Chuỗi này nhập nhằng về mặt hình thức. Chọn phân-nhóm vì tiền Việt không có phần lẻ:
  // đọc thành 199 là con số vô nghĩa, còn 199000 là giá bình thường. Nếu sau này nền tảng
  // nhận tiền tệ có phần lẻ thì đây là dòng phải xem lại ĐẦU TIÊN.
  assert.equal(parseAmount('199.000'), 199000);
  assert.equal(parseAmount('199.00'), 199);    // 2 chữ số → thập phân, KHÁC hẳn
});

// ── Ngày: chỗ sai thứ hai, và cái sai lặng lẽ hơn tiền ──────────────────────
// dd/mm vs mm/dd không có cách nào phân biệt được với "05/06/2026". Ta chọn dd/mm (kiểu Việt
// Nam) và TỪ CHỐI ngày tương lai — không phải vì tương lai là bất hợp lệ, mà vì đơn "cũ" nằm
// ở tương lai gần như luôn nghĩa là đọc nhầm định dạng, và nhập vào là hỏng hồ sơ khách.
test('ngày: nhận cả kiểu Việt Nam lẫn ISO', () => {
  assert.equal(parseOrderDate('15/06/2026')?.toISOString().slice(0, 10), '2026-06-15');
  assert.equal(parseOrderDate('2026-06-15')?.toISOString().slice(0, 10), '2026-06-15');
  assert.equal(parseOrderDate('5/6/2026')?.toISOString().slice(0, 10), '2026-06-05');
});

test('ngày: ngày 13-31 chứng minh đọc theo dd/mm chứ không phải mm/dd', () => {
  // 25/12 chỉ hợp lệ khi đọc dd/mm; đọc mm/dd sẽ là tháng 25 → vô nghĩa.
  assert.equal(parseOrderDate('25/12/2025')?.toISOString().slice(0, 10), '2025-12-25');
});

test('ngày: TỪ CHỐI tương lai và rác', () => {
  assert.equal(parseOrderDate('01/01/2099'), null);
  for (const v of ['', 'hôm qua', '99/99/2026', null, undefined, '2026-13-45']) {
    assert.equal(parseOrderDate(v), null, JSON.stringify(v));
  }
});
