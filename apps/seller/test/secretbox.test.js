/**
 * Unit test secretbox BẢN SAO của seller (apps/seller/src/secretbox.js — keyring env
 * SHIPPING_ENC_KEYS). Chạy: node --test apps/seller/test/secretbox.test.js
 * Giữ ĐỒNG BỘ với packages/auth/test/secretbox.test.js (phần v2/keyring).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { seal, open } from '../src/secretbox.js';

const KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';
const KEY2 = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';

// Blob LEGACY 'iv.tag.ct' dựng tay (như token đã nằm trong DB từ trước).
function legacySeal(plaintext, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}
const withKeyring = (value, fn) => {
  const prev = process.env.SHIPPING_ENC_KEYS;
  if (value == null) delete process.env.SHIPPING_ENC_KEYS; else process.env.SHIPPING_ENC_KEYS = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.SHIPPING_ENC_KEYS; else process.env.SHIPPING_ENC_KEYS = prev;
  }
};

test('round-trip + IV ngẫu nhiên', () => {
  withKeyring(null, () => {
    assert.equal(open(seal('ghtk-token-abc', KEY), KEY), 'ghtk-token-abc');
    assert.notEqual(seal('same', KEY), seal('same', KEY));
  });
});

test('sai khoá → ném lỗi, không trả rác', () => {
  withKeyring(null, () => {
    const blob = seal('secret', KEY);
    assert.throws(() => open(blob, KEY2));
  });
});

test('blob LEGACY (iv.tag.ct — token cũ trong DB) vẫn giải mã bằng khoá legacy', () => {
  const blob = legacySeal('ghn-token-cu', KEY);
  assert.equal(blob.split('.').length, 3);
  assert.equal(open(blob, KEY), 'ghn-token-cu');
  withKeyring(`k9:${KEY2}`, () => assert.equal(open(blob, KEY), 'ghn-token-cu'));
});

test('seal luôn ghi v2 + kid ACTIVE (entry đầu SHIPPING_ENC_KEYS); round-trip', () => {
  withKeyring(`k2:${KEY2},k1:${KEY}`, () => {
    const blob = seal('token-x', KEY);
    assert.ok(blob.startsWith('v2.k2.'), blob.slice(0, 12));
    assert.equal(blob.split('.').length, 5);
    assert.equal(open(blob, KEY), 'token-x');
  });
});

test('giải mã CHỌN KHOÁ THEO kid — blob khoá cũ vẫn đọc sau khi active đổi', () => {
  const blob = withKeyring(`k1:${KEY}`, () => seal('van-doc-duoc', 'ff'.repeat(32)));
  assert.ok(blob.startsWith('v2.k1.'));
  withKeyring(`k2:${KEY2},k1:${KEY}`, () => assert.equal(open(blob, 'ff'.repeat(32)), 'van-doc-duoc'));
});

test('kid không có trong keyring → lỗi RÕ RÀNG', () => {
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
