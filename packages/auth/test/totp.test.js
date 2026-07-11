import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totp, verifyTotp, hotp, otpauthURL } from '../src/totp.js';
import { base32Encode } from '../src/base32.js';

// Vector RFC 6238 §B — seed ASCII "12345678901234567890", SHA1, 8 chữ số.
const SEED = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

test('TOTP khớp vector RFC 6238 (8 chữ số, SHA1)', () => {
  for (const [tSec, expected] of RFC_VECTORS) {
    const got = totp(SEED, { tMillis: tSec * 1000, digits: 8 });
    assert.equal(got, expected, `t=${tSec}`);
  }
});

// Vector RFC 4226 §D — HOTP với cùng seed, 6 chữ số, counter 0..9.
const HOTP_VECTORS = [
  '755224', '287082', '359152', '969429', '338314',
  '254676', '287922', '162583', '399871', '520489',
];

test('HOTP khớp vector RFC 4226', () => {
  HOTP_VECTORS.forEach((expected, counter) => {
    assert.equal(hotp(SEED, counter, 6), expected, `counter=${counter}`);
  });
});

test('verifyTotp chấp nhận mã đúng, trả về counter khớp', () => {
  const t = 1111111111 * 1000;
  const code = totp(SEED, { tMillis: t, digits: 8 });
  const counter = verifyTotp(SEED, code, { tMillis: t, digits: 8 });
  assert.equal(typeof counter, 'number');
});

test('verifyTotp từ chối mã sai', () => {
  const t = 1111111111 * 1000;
  assert.equal(verifyTotp(SEED, '00000000', { tMillis: t, digits: 8 }), null);
});

test('verifyTotp cho phép lệch đồng hồ ±1 bước, từ chối ±2', () => {
  const t = 1111111111 * 1000;
  const prev = totp(SEED, { tMillis: t - 30_000, digits: 8 }); // 1 bước trước
  const next = totp(SEED, { tMillis: t + 30_000, digits: 8 }); // 1 bước sau
  const far = totp(SEED, { tMillis: t - 90_000, digits: 8 }); // 3 bước trước

  assert.notEqual(verifyTotp(SEED, prev, { tMillis: t, digits: 8, window: 1 }), null);
  assert.notEqual(verifyTotp(SEED, next, { tMillis: t, digits: 8, window: 1 }), null);
  assert.equal(verifyTotp(SEED, far, { tMillis: t, digits: 8, window: 1 }), null);
});

test('verifyTotp từ chối độ dài sai mà không ném lỗi', () => {
  assert.equal(verifyTotp(SEED, '123', { digits: 8 }), null);
  assert.equal(verifyTotp(SEED, '', { digits: 6 }), null);
  assert.equal(verifyTotp(SEED, 123456, { digits: 6 }), null); // không phải chuỗi
});

test('otpauth URL đúng định dạng cho app Authenticator', () => {
  const url = otpauthURL({
    secretBase32: base32Encode(SEED),
    issuer: 'nentang',
    account: 'chu@shopa.vn',
  });
  assert.match(url, /^otpauth:\/\/totp\/nentang:chu%40shopa\.vn\?/);
  assert.match(url, /secret=/);
  assert.match(url, /issuer=nentang/);
  assert.match(url, /period=30/);
});
