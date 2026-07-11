import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket } from '../src/ratelimit.js';

/** Đồng hồ giả — không dùng thời gian thật để test không chớp nháy. */
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test('cho phép tới hết capacity rồi từ chối', () => {
  const c = fakeClock();
  const b = new TokenBucket({ capacity: 3, refillPerSec: 1, now: c.now });

  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), false, 'token thứ 4 phải bị từ chối');
});

test('nạp lại theo thời gian', () => {
  const c = fakeClock();
  const b = new TokenBucket({ capacity: 2, refillPerSec: 10, now: c.now });

  b.tryTake();
  b.tryTake();
  assert.equal(b.tryTake(), false);

  c.advance(100); // 0.1s × 10/s = 1 token
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), false, 'chỉ nạp đúng 1 token');
});

test('không nạp quá capacity dù chờ rất lâu', () => {
  const c = fakeClock();
  const b = new TokenBucket({ capacity: 2, refillPerSec: 100, now: c.now });

  c.advance(3_600_000); // một giờ
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), false, 'burst bị chặn ở capacity');
});

test('tốc độ ổn định khớp refillPerSec', () => {
  const c = fakeClock();
  const b = new TokenBucket({ capacity: 1, refillPerSec: 20, now: c.now });

  b.tryTake(); // dùng token khởi tạo
  let allowed = 0;
  for (let i = 0; i < 100; i++) {
    c.advance(10); // 10ms × 100 = 1 giây
    if (b.tryTake()) allowed++;
  }
  assert.equal(allowed, 20, '1 giây phải cho đúng 20 lượt');
});
