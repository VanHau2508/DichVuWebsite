/**
 * Base32 (RFC 4648) — mã hoá secret TOTP để hiển thị cho người dùng và nhét vào
 * URI otpauth:// mà app Authenticator quét.
 *
 * Tự viết (không thêm dependency) và kiểm chứng bằng vector RFC 4648 §10.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const LOOKUP = (() => {
  const m = new Map();
  for (let i = 0; i < ALPHABET.length; i++) m.set(ALPHABET[i], i);
  return m;
})();

/** @param {Buffer|Uint8Array} buf @returns {string} base32 có padding '=' */
export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  while (out.length % 8 !== 0) out += '=';
  return out;
}

/** @param {string} str base32 (chấp nhận thường/hoa, khoảng trắng, thiếu padding) @returns {Buffer} */
export function base32Decode(str) {
  const clean = str.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = LOOKUP.get(ch);
    if (idx === undefined) throw new Error(`ký tự base32 không hợp lệ: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
