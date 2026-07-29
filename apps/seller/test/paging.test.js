/**
 * Unit test TRẦN PHÂN TRANG.
 *   node --test apps/seller/test/paging.test.js
 *
 * Vì sao đáng có test riêng: offset được NỘI SUY thẳng vào chuỗi SQL. Không phải lỗ tiêm
 * (giá trị luôn là số), nhưng `?offset=99999999999999999999` cho 1e20 > bigint →
 * Postgres 'bigint out of range' → 500. Đã ĐO THẬT trên Postgres của dự án: cả dạng thập
 * phân (1e20) lẫn dạng mũ ((1e20-1)*20 → "2e+21") đều ném cùng lỗi đó.
 *
 * Sai lầm gốc rất dễ lặp lại: `limit` ở CẢ 5 trang danh sách đã kẹp Math.min(...,100) ngay
 * dòng trên, chỉ offset là quên — cùng một người, cùng một lúc, nghĩ tới trần cho cái này
 * mà không cho cái kia. Gom vào một hàm + một test để lần sau không quên nữa.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOffset, MAX_OFFSET } from '../src/http.js';

const q = (v) => new URLSearchParams(v === undefined ? '' : { offset: String(v) });

test('giá trị bình thường đi qua nguyên vẹn', () => {
  for (const v of [0, 1, 20, 999, 100000]) assert.equal(parseOffset(q(v)), v);
});

test('thiếu tham số / rác → 0 (không ném, không NaN)', () => {
  for (const v of [undefined, '', 'abc', 'null', '--5', '1e5']) {
    const got = parseOffset(q(v));
    assert.ok(Number.isSafeInteger(got), `${v} → ${got} phải là số nguyên an toàn`);
    // '1e5' → parseInt dừng ở 'e' → 1. Đúng và vô hại; điều cần khẳng định là KHÔNG NaN.
    assert.ok(got >= 0 && got <= MAX_OFFSET, `${v} → ${got} phải nằm trong [0, ${MAX_OFFSET}]`);
  }
});

test('số âm → 0 (OFFSET âm là lỗi cú pháp SQL)', () => {
  for (const v of [-1, -100, -1e9]) assert.equal(parseOffset(q(v)), 0);
});

test('SỐ KHỔNG LỒ bị kẹp — đây là cái vá', () => {
  // Chính chuỗi đã làm 500 trước khi vá.
  assert.equal(parseOffset(q('99999999999999999999')), MAX_OFFSET);
  for (const v of ['9'.repeat(30), String(Number.MAX_SAFE_INTEGER), '1' + '0'.repeat(21)]) {
    assert.equal(parseOffset(q(v)), MAX_OFFSET, `${v} phải bị kẹp`);
  }
});

test('ký hiệu mũ KHÔNG lọt được số lớn (parseInt dừng ở "e")', () => {
  // Khẳng định đầu tiên của test này viết sai và bị chính nó bắt: tưởng '1e+21' cũng bị KẸP
  // về MAX_OFFSET, thực ra parseInt('1e+21', 10) = 1 — dừng ngay khi gặp 'e'. Kết quả vẫn
  // an toàn (số bé), chỉ là an toàn vì lý do KHÁC. Ghi lại đúng cơ chế, đừng ghi điều mình
  // tưởng: người sau đổi sang Number() sẽ phá đúng chỗ này mà test cũ không thấy.
  assert.equal(parseOffset(q('1e+21')), 1);
  assert.equal(parseOffset(q('9e99')), 9);
  assert.equal(parseOffset(q('0x1000')), 0); // parseInt cơ số 10 → dừng ở 'x'
});

test('trần nằm gọn trong bigint của Postgres', () => {
  // bigint tối đa 9_223_372_036_854_775_807. Trần phải nhỏ hơn NHIỀU để (offset * bất kỳ hệ
  // số trang nào) cũng không chạm mép — 1e6 × 100 = 1e8, còn cách 11 bậc độ lớn.
  assert.ok(MAX_OFFSET * 100 < 9_223_372_036_854_775_807);
  assert.ok(MAX_OFFSET >= 100_000, 'đừng kẹp thấp tới mức shop có nhiều đơn không lật hết được');
});

test('đọc được khoá khác (dùng lại cho ?page)', () => {
  assert.equal(parseOffset(new URLSearchParams({ start: '42' }), 'start'), 42);
});
