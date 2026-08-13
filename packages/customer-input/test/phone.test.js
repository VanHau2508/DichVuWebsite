import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonPhone } from '../src/phone.js';

test('chuẩn hoá các cách viết phổ biến về cùng một số', () => {
  for (const raw of ['0912345678', '091 234 5678', '091.234.5678', '091-234-5678', '+84912345678']) {
    assert.equal(canonPhone(raw), '0912345678', raw);
  }
});

test('từ chối đầu vào có chữ, quá ngắn hoặc quá dài', () => {
  for (const raw of [null, '', '1.2.3.4.5.6', 'abc0912345678', '091234567890123456789']) {
    assert.equal(canonPhone(raw), null, String(raw));
  }
});
