/**
 * Mã hoá secret MFA khi lưu (AES-256-GCM).
 *
 * Vì sao: nếu database rò và secret TOTP nằm plaintext, kẻ tấn công sinh được mã
 * hợp lệ cho MỌI người dùng — MFA trở nên vô nghĩa. Mã hoá tại tầng ứng dụng
 * bằng khoá nằm NGOÀI database (secret manager / biến môi trường) buộc kẻ tấn
 * công phải chiếm được cả hai: dump DB và khoá ứng dụng.
 *
 * GCM cho cả bảo mật lẫn toàn vẹn: sửa một byte ciphertext → giải mã ném lỗi,
 * không trả ra rác âm thầm.
 */

import crypto from 'node:crypto';

/** @param {string} keyHex 64 ký tự hex = 32 byte */
function keyFromHex(keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('MFA_ENC_KEY phải là 64 ký tự hex (32 byte)');
  return key;
}

/** @returns {string} "iv.tag.ciphertext" mỗi phần base64 */
export function seal(plaintext, keyHex) {
  const key = keyFromHex(keyHex);
  const iv = crypto.randomBytes(12); // 96-bit nonce, chuẩn cho GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ct].map((b) => b.toString('base64')).join('.');
}

/** @returns {string} plaintext; ném lỗi nếu ciphertext bị sửa hoặc sai khoá */
export function open(blob, keyHex) {
  const key = keyFromHex(keyHex);
  const [ivB64, tagB64, ctB64] = String(blob).split('.');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('định dạng ciphertext không hợp lệ');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
