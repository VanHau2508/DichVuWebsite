/**
 * Rate limit dựa trên Redis — cửa sổ cố định, atomic.
 *
 * Chống nhồi mật khẩu (credential stuffing) và dò email (user enumeration qua
 * forgot-password). Bóp theo HAI trục, ai chạm ngưỡng trước thì chặn:
 *   - theo IP:    một nguồn thử nhiều tài khoản
 *   - theo tài khoản: nhiều nguồn thử một tài khoản (botnet)
 *
 * INCR và EXPIRE phải NGUYÊN TỬ. Nếu tách hai lệnh và tiến trình chết giữa chừng
 * (INCR xong, EXPIRE chưa), key mất TTL VĨNH VIỄN → tài khoản/IP đó bị rate-limit
 * mãi mãi cho tới khi xoá tay. Gộp vào một Lua script chạy atomic trong Redis, và
 * tự chữa key mồ côi (ttl == -1 thì đặt lại hạn).
 */

const HIT_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
if ttl == -1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {c, ttl}
`;

/**
 * @param {import('ioredis').Redis} redis
 * @param {string} key
 * @param {{limit:number, windowSec:number}} opts
 * @returns {Promise<{allowed:boolean, count:number, remaining:number, retryAfterSec:number}>}
 */
export async function hit(redis, key, { limit, windowSec }) {
  try {
    const [count, ttl] = await redis.eval(HIT_SCRIPT, 1, key, String(windowSec));
    return {
      allowed: count <= limit,
      count,
      remaining: Math.max(0, limit - count),
      retryAfterSec: count > limit ? (ttl < 0 ? windowSec : ttl) : 0,
    };
  } catch (err) {
    // FAIL-OPEN khi Redis lỗi: rate limit là lớp BẢO VỆ, không phải tính đúng đắn.
    // Sự cố Redis (hiếm, ngắn) không được làm SẬP đăng nhập/checkout — session ở
    // Postgres, không phụ thuộc Redis. Đánh đổi: chống brute-force tạm giảm trong
    // cửa sổ sự cố (Argon2 vẫn là sàn tự nhiên). Trả degraded để nơi gọi log + alert.
    return { allowed: true, count: 0, remaining: limit, retryAfterSec: 0, degraded: true, error: err.message };
  }
}

/** Xoá bộ đếm sau khi đăng nhập thành công — không phạt lây phiên hợp lệ tiếp theo. */
export async function reset(redis, key) {
  await redis.del(key).catch(() => {}); // Redis lỗi → bỏ qua, không làm sập luồng
}
