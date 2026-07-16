/**
 * AES-256-GCM seal/open — BẢN SAO từ packages/auth/src/secretbox.js (build context
 * của seller là thư mục riêng, không import chéo package được). Nếu sửa: sửa CẢ HAI.
 * Dùng mã hoá token API hãng vận chuyển (phải đọc lại được để gọi API — khác SePay
 * chỉ cần sha256 verify). Khoá từ env SHIPPING_ENC_KEY (64 hex), nằm NGOÀI database.
 */

import crypto from 'node:crypto';

function keyFromHex(keyHex) {
  const key = Buffer.from(String(keyHex ?? ''), 'hex');
  if (key.length !== 32) throw new Error('khoá mã hoá phải là 64 ký tự hex (32 byte)');
  return key;
}

/** @returns {string} "iv.tag.ciphertext" mỗi phần base64 */
export function seal(plaintext, keyHex) {
  const key = keyFromHex(keyHex);
  const iv = crypto.randomBytes(12);
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
