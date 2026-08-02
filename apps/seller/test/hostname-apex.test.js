/**
 * node --test apps/seller/test/hostname-apex.test.js
 *
 * isApex quyết định màn hình Tên miền hiện hướng dẫn NÀO: tên miền con → MỘT bản ghi
 * CNAME; tên miền GỐC → A + TXT (apex không đặt được CNAME, ADR-004).
 *
 * Vì sao cần unit riêng: e2e chỉ dựng nổi vài hostname, mà chỗ dễ sai nhất lại là đuôi
 * NHIỀU nhãn kiểu `com.vn` — `cuahang.com.vn` là tên miền GỐC chứ không phải tên miền con
 * của `com.vn`. Đoán sai ở đó là chỉ cho khách VN một cách làm mà nhà DNS của họ từ chối.
 *
 * LƯU Ý: hàm này KHÔNG dùng cho quyết định bảo mật — xác minh vẫn phải khớp DNS thật
 * (CNAME đúng slug, hoặc TXT đúng token). Sai ở đây chỉ làm hiện nhầm hướng dẫn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isApex } from '../src/hostname.js';

test('tên miền gốc — đuôi một nhãn', () => {
  assert.equal(isApex('cuahang.vn'), true);
  assert.equal(isApex('cuahang.com'), true);
  assert.equal(isApex('shop-a.store'), true);
});

test('tên miền gốc — đuôi NHIỀU nhãn kiểu VN (bẫy chính)', () => {
  assert.equal(isApex('cuahang.com.vn'), true);
  assert.equal(isApex('truong.edu.vn'), true);
  assert.equal(isApex('hoi.org.vn'), true);
  assert.equal(isApex('cty.net.vn'), true);
  assert.equal(isApex('shop.co.uk'), true);
});

test('tên miền con — dùng được CNAME', () => {
  assert.equal(isApex('shop.cuahang.vn'), false);
  assert.equal(isApex('www.cuahang.com'), false);
  assert.equal(isApex('shop.cuahang.com.vn'), false);
  assert.equal(isApex('a.b.cuahang.vn'), false);
});

test('không nổ với đầu vào cụt', () => {
  assert.equal(isApex('vn'), true);      // một nhãn — coi như gốc, hiện hướng dẫn A+TXT
  assert.equal(isApex('com.vn'), true);  // chính cái đuôi — không ai thêm được, vẫn phải trả lời
});
