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
 *
 * XOAY KHOÁ (Đợt 5.6 — rà soát #7): blob cũ "iv.tag.ct" không mang key-id nên
 * đổi khoá là "brick" mọi ciphertext hiện có. Định dạng v2 mang kid:
 *
 *   v2.<kid>.<iv>.<tag>.<ct>        (mỗi phần sau kid là base64)
 *
 * Keyring qua env MFA_ENC_KEYS='k2:<64hex|base64>,k1:<64hex|base64>':
 *   - entry ĐẦU TIÊN = active → seal() luôn ghi v2 với kid này;
 *   - giải mã chọn khoá THEO kid trong blob (mọi entry đều giải mã được);
 *   - khoá legacy (tham số keyHex — env MFA_ENC_KEY cũ) là entry NGẦM ĐỊNH
 *     kid 'k0': không đặt MFA_ENC_KEYS thì mọi thứ chạy như cũ (zero-config),
 *     và blob LEGACY 3 phần luôn giải mã bằng khoá này.
 * Quy trình xoay: thêm khoá mới lên ĐẦU keyring → deploy → chạy
 * scripts/rotate-secretbox.js re-encrypt toàn bộ → (sau đó mới được) bỏ khoá cũ.
 *
 * BẢN SAO: apps/seller/src/secretbox.js cùng logic (env SHIPPING_ENC_KEYS) —
 * sửa file này thì sửa CẢ HAI (+ sbOpen trong apps/worker/src/index.js).
 */

import crypto from 'node:crypto';

const KEYRING_ENV = 'MFA_ENC_KEYS';
const LEGACY_KID = 'k0'; // kid ngầm định của khoá legacy (env MFA_ENC_KEY)
const KID_RE = /^[A-Za-z0-9_-]{1,16}$/; // không '.', ',', ':' — chúng là dấu phân cách

/** @param {string} keyHex 64 ký tự hex = 32 byte */
function keyFromHex(keyHex) {
  const key = Buffer.from(String(keyHex ?? ''), 'hex');
  if (key.length !== 32) throw new Error('MFA_ENC_KEY phải là 64 ký tự hex (32 byte)');
  return key;
}

/** Khoá keyring: nhận 64 hex HOẶC base64 (đều 32 byte). */
function keyFromMaterial(material, label) {
  const m = String(material ?? '').trim();
  const key = /^[0-9a-fA-F]{64}$/.test(m) ? Buffer.from(m, 'hex') : Buffer.from(m, 'base64');
  if (key.length !== 32) throw new Error(`${label} phải là 32 byte (64 hex hoặc base64)`);
  return key;
}

/** 'k2:<khoá>,k1:<khoá>' → [{kid, key}] (thứ tự giữ nguyên — entry đầu = active). */
function parseKeyring(raw) {
  const entries = [];
  for (const part of String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    if (i < 1) throw new Error(`${KEYRING_ENV}: entry phải có dạng kid:khoá`);
    const kid = part.slice(0, i).trim();
    if (!KID_RE.test(kid)) throw new Error(`${KEYRING_ENV}: kid "${kid}" không hợp lệ (a-z0-9_-, ≤16)`);
    entries.push({ kid, key: keyFromMaterial(part.slice(i + 1), `${KEYRING_ENV}[${kid}]`) });
  }
  return entries;
}

// Đọc keyring MỖI LẦN gọi (cache theo giá trị thô) — test/rotation đổi env là ăn ngay.
let cachedRaw = null, cachedRing = [];
function ringFromEnv() {
  const raw = process.env[KEYRING_ENV] ?? '';
  if (raw !== cachedRaw) { cachedRing = parseKeyring(raw); cachedRaw = raw; }
  return cachedRing;
}

function gcmSeal(plaintext, key) {
  const iv = crypto.randomBytes(12); // 96-bit nonce, chuẩn cho GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64'));
}

function gcmOpen(ivB64, tagB64, ctB64, key) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

/** @returns {string} "v2.<kid>.iv.tag.ciphertext" — luôn mã hoá bằng khoá ACTIVE */
export function seal(plaintext, keyHex) {
  const ring = ringFromEnv();
  const active = ring[0] ?? { kid: LEGACY_KID, key: keyFromHex(keyHex) };
  return ['v2', active.kid, ...gcmSeal(plaintext, active.key)].join('.');
}

/** @returns {string} plaintext; ném lỗi nếu ciphertext bị sửa, sai khoá, hoặc thiếu kid */
export function open(blob, keyHex) {
  const parts = String(blob).split('.');
  if (parts[0] === 'v2' && parts.length === 5) {
    const [, kid, ivB64, tagB64, ctB64] = parts;
    let entry = ringFromEnv().find((e) => e.kid === kid);
    if (!entry && kid === LEGACY_KID) entry = { kid, key: keyFromHex(keyHex) }; // k0 ngầm định
    if (!entry) throw new Error(`không có khoá kid "${kid}" trong ${KEYRING_ENV}`);
    return gcmOpen(ivB64, tagB64, ctB64, entry.key);
  }
  // LEGACY "iv.tag.ct" (không kid) → luôn giải mã bằng khoá legacy (env cũ).
  const [ivB64, tagB64, ctB64] = parts;
  if (parts.length !== 3 || !ivB64 || !tagB64 || !ctB64) throw new Error('định dạng ciphertext không hợp lệ');
  return gcmOpen(ivB64, tagB64, ctB64, keyFromHex(keyHex));
}
