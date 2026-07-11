/**
 * Băm mật khẩu — Argon2id.
 *
 * Dùng @node-rs/argon2 (bản Rust, binary dựng sẵn) thay vì `argon2` (cần biên
 * dịch native): trên Alpine/musl, biên dịch native hay gãy, còn @node-rs có sẵn
 * biến thể linux-x64-musl.
 *
 * Tham số theo khuyến nghị OWASP cho Argon2id: 19 MiB, t=2, p=1.
 */

import { hash, verify, Algorithm } from '@node-rs/argon2';

const OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456, // KiB = 19 MiB
  timeCost: 2,
  parallelism: 1,
};

/** @returns {Promise<string>} chuỗi PHC ($argon2id$...) — tự chứa tham số + salt */
export function hashPassword(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('mật khẩu rỗng');
  }
  return hash(plaintext, OPTIONS);
}

/**
 * @returns {Promise<boolean>} true nếu khớp.
 * Nuốt lỗi (hash hỏng, định dạng lạ) thành `false` — không rò chi tiết ra ngoài,
 * và không để một hash lỗi trong DB làm sập luồng đăng nhập.
 */
export async function verifyPassword(phcHash, plaintext) {
  if (typeof phcHash !== 'string' || typeof plaintext !== 'string') return false;
  try {
    return await verify(phcHash, plaintext);
  } catch {
    return false;
  }
}
