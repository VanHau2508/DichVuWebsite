/**
 * Token mờ (opaque) cho phiên, đặt lại mật khẩu, mã khôi phục.
 *
 * Nguyên tắc: sinh entropy cao, GỬI token thô cho người dùng đúng một lần, chỉ
 * LƯU hash. Rò database thì không mạo danh được — kẻ tấn công có hash, không có
 * token. Đây là lý do sessions.token_hash, password_reset_tokens.token_hash...
 * đều là hash chứ không phải token.
 */

import crypto from 'node:crypto';

/** Token ngẫu nhiên, an toàn URL. 32 byte = 256 bit entropy. */
export function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** sha256 hex. Dùng cho token entropy CAO — không cần Argon2 (không phải mật khẩu). */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * So sánh token (hoặc hash) an toàn theo thời gian.
 * Tra cứu session/reset nên so bằng hash trong index DB, nhưng khi cần so trong
 * bộ nhớ thì dùng hàm này để không rò độ dài khớp qua timing.
 */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Mã khôi phục MFA: nhóm chữ-số dễ đọc, ví dụ "3F9K-7Q2M-8XVR-2WQH".
 * Bỏ ký tự dễ nhầm (0/O, 1/I/L).
 *
 * BỐN nhóm (16 ký tự): 31^16 ≈ 2^79. Hai nhóm (~2^40) là quá thấp — mã lưu bằng
 * sha256 không salt, nên rò DB là bẻ được offline hàng loạt. 2^79 vượt xa tầm bẻ.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function generateRecoveryCode() {
  const pick = () => RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
  const group = () => Array.from({ length: 4 }, pick).join('');
  return `${group()}-${group()}-${group()}-${group()}`;
}
