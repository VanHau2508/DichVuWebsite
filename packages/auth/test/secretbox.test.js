import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, open } from '../src/secretbox.js';
import { generateToken, hashToken, safeEqual, generateRecoveryCode } from '../src/tokens.js';

const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const KEY2 = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';

test('seal → open round-trip', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  assert.equal(open(seal(secret, KEY), KEY), secret);
});

test('mỗi lần seal cho ciphertext khác nhau (IV ngẫu nhiên)', () => {
  const a = seal('same', KEY);
  const b = seal('same', KEY);
  assert.notEqual(a, b);
  assert.equal(open(a, KEY), open(b, KEY));
});

test('sai khoá → giải mã ném lỗi, không trả rác', () => {
  const blob = seal('secret', KEY);
  assert.throws(() => open(blob, KEY2));
});

test('sửa ciphertext → GCM phát hiện, ném lỗi', () => {
  const blob = seal('secret', KEY);
  const [iv, tag, ct] = blob.split('.');
  const tampered = Buffer.from(ct, 'base64');
  tampered[0] ^= 0x01;
  assert.throws(() => open([iv, tag, tampered.toString('base64')].join('.'), KEY));
});

test('khoá sai độ dài bị từ chối', () => {
  assert.throws(() => seal('x', 'abcd'), /32 byte/);
});

test('token: entropy cao, an toàn URL, hash ổn định', () => {
  const t = generateToken();
  assert.match(t, /^[A-Za-z0-9_-]+$/); // base64url
  assert.ok(t.length >= 43); // 32 byte base64url
  assert.equal(hashToken(t), hashToken(t)); // ổn định
  assert.notEqual(hashToken(t), hashToken(generateToken())); // khác nhau
  assert.equal(hashToken(t).length, 64); // sha256 hex
});

test('safeEqual đúng và không rò độ dài qua ngoại lệ', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('mã khôi phục dễ đọc, không ký tự dễ nhầm, đủ entropy', () => {
  for (let i = 0; i < 50; i++) {
    const code = generateRecoveryCode();
    assert.match(code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/); // 4 nhóm ≈ 2^79
    assert.ok(!/[01OIL]/.test(code)); // không 0 O 1 I L
  }
});
