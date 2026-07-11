/**
 * Token bucket cho các lần TRA CỨU DATABASE (cache-miss).
 *
 * Vì sao cần: Caddy v2.8 đã gỡ bỏ `interval`/`burst` khỏi `on_demand_tls`.
 * Trước đây Caddy tự giới hạn tần suất hỏi `ask`; bây giờ nó hỏi mọi handshake
 * tới hostname chưa có chứng chỉ. Kẻ tấn công gửi SNI ngẫu nhiên hợp lệ
 * (`a1b2c3.example.com`, ...) sẽ tạo một cache-miss → một query Postgres, cho
 * mỗi gói tin. `ask` trở thành lá chắn duy nhất, nên nó phải tự bảo vệ mình.
 *
 * Cache hit KHÔNG tiêu token: khách hàng thật đã nằm trong cache.
 * Hết token → trả 403 (fail-closed). Caddy sẽ thử lại ở handshake sau.
 *
 * Hàm thuần, không phụ thuộc gì, tiêm đồng hồ để test được.
 */
export class TokenBucket {
  /**
   * @param {object} opts
   * @param {number} opts.capacity     số token tối đa (độ lớn của burst)
   * @param {number} opts.refillPerSec token nạp lại mỗi giây (tốc độ ổn định)
   * @param {() => number} [opts.now]  nguồn thời gian, ms
   */
  constructor({ capacity, refillPerSec, now = Date.now }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
    this.tokens = capacity;
    this.last = now();
  }

  /** @returns {boolean} true nếu còn token và đã tiêu một cái */
  tryTake() {
    const t = this.now();
    const elapsedSec = (t - this.last) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
      this.last = t;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}
