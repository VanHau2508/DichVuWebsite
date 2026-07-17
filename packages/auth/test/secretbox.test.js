import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
  const [v2, kid, iv, tag, ct] = blob.split('.');
  const tampered = Buffer.from(ct, 'base64');
  tampered[0] ^= 0x01;
  assert.throws(() => open([v2, kid, iv, tag, tampered.toString('base64')].join('.'), KEY));
});

test('khoá sai độ dài bị từ chối', () => {
  assert.throws(() => seal('x', 'abcd'), /32 byte/);
});

// ── v2 + keyring (xoay khoá, Đợt 5.6) ────────────────────────────────────────

// Blob LEGACY 'iv.tag.ct' dựng tay (như dữ liệu đã nằm trong DB từ trước).
function legacySeal(plaintext, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}
const withKeyring = (value, fn) => {
  const prev = process.env.MFA_ENC_KEYS;
  if (value == null) delete process.env.MFA_ENC_KEYS; else process.env.MFA_ENC_KEYS = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.MFA_ENC_KEYS; else process.env.MFA_ENC_KEYS = prev;
  }
};

test('blob LEGACY (iv.tag.ct — dữ liệu cũ trong DB) vẫn giải mã bằng khoá legacy', () => {
  const blob = legacySeal('JBSWY3DPEHPK3PXP', KEY);
  assert.equal(blob.split('.').length, 3);
  assert.equal(open(blob, KEY), 'JBSWY3DPEHPK3PXP');
  // Kể cả khi keyring ĐÃ được cấu hình (khoá mới active) — legacy vẫn đọc được.
  withKeyring(`k9:${KEY2}`, () => assert.equal(open(blob, KEY), 'JBSWY3DPEHPK3PXP'));
});

test('seal luôn ghi v2 + kid ACTIVE (entry đầu keyring); round-trip', () => {
  withKeyring(`k2:${KEY2},k1:${KEY}`, () => {
    const blob = seal('secret-x', KEY);
    assert.ok(blob.startsWith('v2.k2.'), blob.slice(0, 12));
    assert.equal(blob.split('.').length, 5);
    assert.equal(open(blob, KEY), 'secret-x');
  });
});

test('giải mã CHỌN KHOÁ THEO kid — blob khoá cũ vẫn đọc sau khi active đổi', () => {
  const blob = withKeyring(`k1:${KEY}`, () => seal('van-doc-duoc', 'ff'.repeat(32)));
  assert.ok(blob.startsWith('v2.k1.'));
  // Xoay: k2 (mới) lên đầu, k1 giữ lại để giải mã tồn đọng.
  withKeyring(`k2:${KEY2},k1:${KEY}`, () => assert.equal(open(blob, 'ff'.repeat(32)), 'van-doc-duoc'));
});

test('kid không có trong keyring → lỗi RÕ RÀNG, không trả rác', () => {
  const blob = withKeyring(`k7:${KEY}`, () => seal('secret', KEY));
  withKeyring(`k2:${KEY2}`, () => assert.throws(() => open(blob, KEY), /kid "k7"/));
});

test('không có keyring: seal ghi v2.k0 (khoá legacy) — zero-config vẫn round-trip', () => {
  withKeyring(null, () => {
    const blob = seal('mac-dinh', KEY);
    assert.ok(blob.startsWith('v2.k0.'));
    assert.equal(open(blob, KEY), 'mac-dinh');
  });
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
