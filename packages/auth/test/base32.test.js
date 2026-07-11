import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Encode, base32Decode } from '../src/base32.js';

// Vector RFC 4648 §10.
const VECTORS = [
  ['', ''],
  ['f', 'MY======'],
  ['fo', 'MZXQ===='],
  ['foo', 'MZXW6==='],
  ['foob', 'MZXW6YQ='],
  ['fooba', 'MZXW6YTB'],
  ['foobar', 'MZXW6YTBOI======'],
];

test('encode khớp vector RFC 4648', () => {
  for (const [plain, b32] of VECTORS) {
    assert.equal(base32Encode(Buffer.from(plain)), b32, `encode(${JSON.stringify(plain)})`);
  }
});

test('decode khớp vector RFC 4648', () => {
  for (const [plain, b32] of VECTORS) {
    assert.equal(base32Decode(b32).toString(), plain, `decode(${b32})`);
  }
});

test('round-trip trên byte ngẫu nhiên', () => {
  for (let i = 0; i < 200; i++) {
    const buf = Buffer.from(Array.from({ length: 1 + (i % 40) }, (_, j) => (i * 31 + j * 7) & 0xff));
    assert.deepEqual(base32Decode(base32Encode(buf)), buf);
  }
});

test('decode chấp nhận chữ thường, khoảng trắng, thiếu padding', () => {
  assert.equal(base32Decode('mzxw6ytboi').toString(), 'foobar');
  assert.equal(base32Decode('MZXW 6YTB OI').toString(), 'foobar');
});

test('decode từ chối ký tự không hợp lệ', () => {
  assert.throws(() => base32Decode('MZXW0189'), /không hợp lệ/); // 0,1,8,9 không thuộc bảng chữ
});
