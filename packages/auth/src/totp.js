/**
 * TOTP (RFC 6238) trên HOTP (RFC 4226). Tự viết, kiểm chứng bằng vector RFC 6238 §B.
 *
 * Vì sao tự viết thay vì dùng thư viện: TOTP là ~25 dòng, và RFC có sẵn vector
 * kiểm thử. Tự viết + test theo vector đáng tin hơn một dependency mà ta không
 * đọc — đây là lớp phòng thủ đăng nhập, không phải chỗ để tin tưởng mù quáng.
 *
 * CHỐNG REPLAY không nằm ở đây: hàm verify là thuần. Người gọi phải lưu bước
 * thời gian đã dùng (mfa_totp.last_counter) và từ chối dùng lại — mã TOTP hợp lệ
 * trong ~30–90 giây, đủ để kẻ nghe lén dùng lại nếu không chặn.
 */

import crypto from 'node:crypto';

/**
 * HOTP: mã cho một bộ đếm cụ thể.
 * @param {Buffer} key  khoá thô (đã giải base32)
 * @param {number|bigint} counter
 * @param {number} digits
 */
export function hotp(key, counter, digits = 6) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();

  // Dynamic truncation (RFC 4226 §5.3)
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** Bước thời gian hiện tại. Tách ra để test tiêm được thời gian cố định. */
export function counterFor(tMillis, { step = 30, t0 = 0 } = {}) {
  return Math.floor((Math.floor(tMillis / 1000) - t0) / step);
}

/**
 * TOTP cho một thời điểm.
 * @param {Buffer} key
 * @param {{tMillis?:number, step?:number, digits?:number, t0?:number}} opts
 */
export function totp(key, { tMillis = Date.now(), step = 30, digits = 6, t0 = 0 } = {}) {
  return hotp(key, counterFor(tMillis, { step, t0 }), digits);
}

/**
 * Xác minh mã, cho phép lệch đồng hồ ±`window` bước.
 * Trả về bước thời gian KHỚP (để người gọi lưu chống replay), hoặc null.
 *
 * So sánh bằng timingSafeEqual để không rò thông tin qua thời gian phản hồi.
 * @returns {number|null}
 */
export function verifyTotp(key, token, { tMillis = Date.now(), step = 30, digits = 6, t0 = 0, window = 1 } = {}) {
  if (typeof token !== 'string' || token.length !== digits) return null;
  const center = counterFor(tMillis, { step, t0 });
  for (let i = -window; i <= window; i++) {
    const counter = center + i;
    if (counter < 0) continue;
    const expected = hotp(key, counter, digits);
    const a = Buffer.from(expected);
    const b = Buffer.from(token);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return counter;
  }
  return null;
}

/**
 * URI otpauth:// để app Authenticator quét (hoặc dựng QR).
 * secretBase32 là secret đã mã hoá base32.
 */
export function otpauthURL({ secretBase32, issuer, account }) {
  // Nhãn là "issuer:account"; dấu ':' phân tách phải giữ nguyên, chỉ hai vế
  // được percent-encode (theo quy ước Key URI của Google Authenticator).
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
