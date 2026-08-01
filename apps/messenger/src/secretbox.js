/**
 * AES-256-GCM seal/open — BẢN SAO từ packages/auth/src/secretbox.js (build context
 * của seller là thư mục riêng, không import chéo package được). Nếu sửa: sửa CẢ HAI
 * (+ apps/messenger/src/secretbox.js + sbOpen trong apps/worker/src/index.js).
 * Dùng mã hoá token API hãng vận chuyển (phải đọc lại được để gọi API — khác SePay
 * chỉ cần sha256 verify). Khoá legacy từ env SHIPPING_ENC_KEY (64 hex), nằm NGOÀI database.
 *
 * XOAY KHOÁ (Đợt 5.6): định dạng v2 mang kid — 'v2.<kid>.iv.tag.ct'. Keyring env
 * SHIPPING_ENC_KEYS='k2:<64hex|base64>,k1:...' — entry ĐẦU = active (seal luôn dùng);
 * giải mã chọn khoá theo kid. Khoá legacy = entry ngầm định kid 'k0' (không đặt
 * SHIPPING_ENC_KEYS thì chạy như cũ). Xoay: khoá mới lên đầu keyring → deploy →
 * scripts/rotate-secretbox.js re-encrypt → mới được bỏ khoá cũ.
 */

import crypto from 'node:crypto';

// Tên env của keyring MẶC ĐỊNH. Mỗi service từng chỉ có MỘT loại bí mật nên khoá cứng
// tên này là đủ — cho tới khi seller phải giữ hai loại: token hãng vận chuyển VÀ token
// Trang Facebook (0122). Hai thứ đó KHÔNG được dùng chung khoá: lộ một cái là lộ cả hai,
// và xoay khoá cái này lại buộc kết nối lại cái kia. Nên seal/open nhận thêm tham số
// keyringEnv; không truyền thì y như cũ.
const DEFAULT_KEYRING_ENV = 'SHIPPING_ENC_KEYS';
const LEGACY_KID = 'k0'; // kid ngầm định của khoá legacy (env SHIPPING_ENC_KEY)
const KID_RE = /^[A-Za-z0-9_-]{1,16}$/; // không '.', ',', ':' — chúng là dấu phân cách

function keyFromHex(keyHex) {
  const key = Buffer.from(String(keyHex ?? ''), 'hex');
  if (key.length !== 32) throw new Error('khoá mã hoá phải là 64 ký tự hex (32 byte)');
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
function parseKeyring(raw, KEYRING_ENV = DEFAULT_KEYRING_ENV) {
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
const ringCache = new Map();  // theo TÊN env: seller giữ hai keyring khác nhau cùng lúc
function ringFromEnv(keyringEnv) {
  const raw = process.env[keyringEnv] ?? '';
  const hit = ringCache.get(keyringEnv);
  if (hit && hit.raw === raw) return hit.ring;
  const ring = parseKeyring(raw, keyringEnv);
  ringCache.set(keyringEnv, { raw, ring });
  return ring;
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
export function seal(plaintext, keyHex, keyringEnv = DEFAULT_KEYRING_ENV) {
  const ring = ringFromEnv(keyringEnv);
  const active = ring[0] ?? { kid: LEGACY_KID, key: keyFromHex(keyHex) };
  return ['v2', active.kid, ...gcmSeal(plaintext, active.key)].join('.');
}

/** @returns {string} plaintext; ném lỗi nếu ciphertext bị sửa, sai khoá, hoặc thiếu kid */
export function open(blob, keyHex, keyringEnv = DEFAULT_KEYRING_ENV) {
  const parts = String(blob).split('.');
  if (parts[0] === 'v2' && parts.length === 5) {
    const [, kid, ivB64, tagB64, ctB64] = parts;
    let entry = ringFromEnv(keyringEnv).find((e) => e.kid === kid);
    if (!entry && kid === LEGACY_KID) entry = { kid, key: keyFromHex(keyHex) }; // k0 ngầm định
    if (!entry) throw new Error(`không có khoá kid "${kid}" trong ${keyringEnv}`);
    return gcmOpen(ivB64, tagB64, ctB64, entry.key);
  }
  // LEGACY "iv.tag.ct" (không kid) → luôn giải mã bằng khoá legacy (env cũ).
  const [ivB64, tagB64, ctB64] = parts;
  if (parts.length !== 3 || !ivB64 || !tagB64 || !ctB64) throw new Error('định dạng ciphertext không hợp lệ');
  return gcmOpen(ivB64, tagB64, ctB64, keyFromHex(keyHex));
}
