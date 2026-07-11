/**
 * node --test apps/tls-authorize/test/
 *
 * Không cần database, không cần Docker. Đây là lớp lọc đứng trước mọi query.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHostname, isReserved } from '../src/hostname.js';

test('chấp nhận hostname hợp lệ', () => {
  assert.equal(normalizeHostname('shopa.test'), 'shopa.test');
  assert.equal(normalizeHostname('shop-a.co.uk'), 'shop-a.co.uk');
  assert.equal(normalizeHostname('a.b'), 'a.b');
  assert.equal(normalizeHostname('xn--th-e0a.vn'), 'xn--th-e0a.vn'); // punycode
});

test('chuẩn hoá chữ hoa, khoảng trắng, dấu chấm cuối', () => {
  assert.equal(normalizeHostname('SHOPA.TEST'), 'shopa.test');
  assert.equal(normalizeHostname('  ShopA.Test  '), 'shopa.test');
  assert.equal(normalizeHostname('shopa.test.'), 'shopa.test'); // FQDN
  assert.equal(normalizeHostname('SHOPA.TEST.'), 'shopa.test');
});

test('từ chối wildcard — on-demand không bao giờ cấp cert wildcard', () => {
  assert.equal(normalizeHostname('*.shopa.test'), null);
  assert.equal(normalizeHostname('*'), null);
});

test('từ chối địa chỉ IP — máy quét cổng không được chạm database', () => {
  assert.equal(normalizeHostname('1.2.3.4'), null);
  assert.equal(normalizeHostname('127.0.0.1'), null);
  assert.equal(normalizeHostname('::1'), null);
  assert.equal(normalizeHostname('2001:db8::1'), null);
});

test('từ chối hostname có port', () => {
  assert.equal(normalizeHostname('shopa.test:8443'), null);
});

test('từ chối nhãn đơn', () => {
  assert.equal(normalizeHostname('localhost'), null);
  assert.equal(normalizeHostname('shopa'), null);
});

test('từ chối cú pháp DNS không hợp lệ', () => {
  assert.equal(normalizeHostname('-shopa.test'), null); // nhãn mở đầu bằng '-'
  assert.equal(normalizeHostname('shopa-.test'), null); // nhãn kết thúc bằng '-'
  assert.equal(normalizeHostname('shop_a.test'), null); // gạch dưới
  assert.equal(normalizeHostname('shopa..test'), null); // nhãn rỗng
  assert.equal(normalizeHostname('.shopa.test'), null);
  assert.equal(normalizeHostname('shopa.123'), null); // TLD toàn số
  assert.equal(normalizeHostname('a'.repeat(64) + '.test'), null); // nhãn > 63
  assert.equal(normalizeHostname('a.' + 'b'.repeat(300)), null); // tổng > 253
});

test('từ chối đầu vào không phải chuỗi hoặc rỗng', () => {
  assert.equal(normalizeHostname(''), null);
  assert.equal(normalizeHostname('   '), null);
  assert.equal(normalizeHostname(null), null);
  assert.equal(normalizeHostname(undefined), null);
  assert.equal(normalizeHostname(123), null);
  assert.equal(normalizeHostname(['shopa.test']), null);
});

test('domain nền tảng là reserved — không đi qua on-demand', () => {
  assert.equal(isReserved('nentang.vn', 'nentang.vn'), true);
  assert.equal(isReserved('admin.nentang.vn', 'nentang.vn'), true);
  assert.equal(isReserved('shopa.nentang.vn', 'nentang.vn'), true);
  assert.equal(isReserved('shopa.test', 'nentang.vn'), false);
});

test('reserved không khớp nhầm domain có hậu tố giống', () => {
  // "evilnentang.vn" KHÔNG phải subdomain của "nentang.vn"
  assert.equal(isReserved('evilnentang.vn', 'nentang.vn'), false);
  assert.equal(isReserved('nentang.vn.evil.com', 'nentang.vn'), false);
});

test('reserved tắt khi không cấu hình platform domain', () => {
  assert.equal(isReserved('nentang.vn', ''), false);
});
