/**
 * tls-authorize — endpoint `ask` của Caddy on-demand TLS.
 *
 * Caddy gọi GET /internal/tls/authorize?domain=<host> trước khi xin chứng chỉ
 * cho một hostname lạ. 2xx = cho phép, mọi thứ khác = từ chối.
 *
 * Bốn ràng buộc thiết kế (ADR-003):
 *   1. Đây là code đơn giản nhất trong hệ thống. Không framework, không ORM.
 *      Phụ thuộc duy nhất: `pg`.
 *   2. Nó KHÔNG phụ thuộc vào phần còn lại của API. API chết, khách vẫn có SSL.
 *   3. Nó phải trả lời < 200ms. Cache trong process, không gọi Redis
 *      (thêm một phụ thuộc = thêm một cách để endpoint này chết).
 *   4. Fail-closed. DB chết hoặc timeout → 403. Chứng chỉ đã cấp vẫn được
 *      Caddy phục vụ từ đĩa mà không hỏi lại, nên từ chối ở đây là an toàn:
 *      chỉ domain MỚI bị ảnh hưởng, không phải khách đang chạy.
 *
 * Nếu để Caddy tự do cấp cert cho mọi Host, kẻ tấn công trỏ 10.000 domain vào
 * IP của bạn và bạn bị Let's Encrypt rate-limit vĩnh viễn. Endpoint này là thứ
 * duy nhất đứng giữa.
 */

import http from 'node:http';
import pg from 'pg';
import { normalizeHostname, isReserved } from './hostname.js';
import { TokenBucket } from './ratelimit.js';

const PORT = Number(process.env.PORT ?? 3010);
const PLATFORM_DOMAIN = (process.env.PLATFORM_DOMAIN ?? '').toLowerCase();

// Cache dương lâu (domain đã duyệt hiếm khi bị thu hồi).
// Cache âm ngắn: khi khách vừa verify DNS xong, họ không nên phải chờ.
const TTL_ALLOW_MS = 300_000; // 5 phút
const TTL_DENY_MS = 15_000; //  15 giây
const CACHE_MAX = 10_000; // chặn flood SNI ngẫu nhiên làm phình RAM

/** @type {Map<string, {allow: boolean, exp: number}>} */
const cache = new Map();

// Chỉ giới hạn cache-miss (tức là lần thật sự chạm database).
// Caddy ≥2.8 không còn tự giới hạn tần suất gọi `ask`, nên endpoint tự lo.
// 20/giây ổn định, burst 40: thừa sức cho hàng trăm domain onboarding,
// nhưng chặn được flood SNI ngẫu nhiên biến thành flood query Postgres.
const lookupBudget = new TokenBucket({
  capacity: Number(process.env.LOOKUP_BURST ?? 40),
  refillPerSec: Number(process.env.LOOKUP_PER_SEC ?? 20),
});

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3, // endpoint này không được ăn hết connection của API
  connectionTimeoutMillis: 1_500,
  idleTimeoutMillis: 30_000,
  // Truy vấn treo = handshake treo = khách thấy trang trắng. Cắt sớm.
  options: '-c statement_timeout=2000',
});

pool.on('error', (err) => log('error', 'pool_error', { message: err.message }));

function log(level, event, fields = {}) {
  // Log có cấu trúc, không bao giờ chứa secret. `domain` là dữ liệu công khai.
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }) + '\n');
}

function cacheGet(hostname) {
  const hit = cache.get(hostname);
  if (!hit) return undefined;
  if (hit.exp < Date.now()) {
    cache.delete(hostname);
    return undefined;
  }
  return hit.allow;
}

function cacheSet(hostname, allow) {
  if (cache.size >= CACHE_MAX) {
    // Map giữ thứ tự chèn → xoá cái cũ nhất. Đủ tốt, không cần LRU thật.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(hostname, { allow, exp: Date.now() + (allow ? TTL_ALLOW_MS : TTL_DENY_MS) });
}

/**
 * Điều kiện cấp chứng chỉ:
 *   - domain tồn tại và ĐÃ xác minh quyền sở hữu qua DNS (verified_at IS NOT NULL)
 *   - shop chưa bị chấm dứt hợp đồng
 *
 * Shop `suspended` VẪN được cấp: storefront cần HTTPS để hiển thị trang thông báo
 * tạm ngưng. Khoá shop không cắt SSL.
 */
const SQL = `
  SELECT 1
  FROM domains d
  JOIN shops s ON s.id = d.shop_id
  WHERE d.hostname = $1
    AND d.verified_at IS NOT NULL
    AND s.status <> 'terminated'
    AND s.deleted_at IS NULL
  LIMIT 1
`;

async function isAuthorized(hostname) {
  const cached = cacheGet(hostname);
  if (cached !== undefined) return { allow: cached, source: 'cache' };

  // Khách hàng thật nằm trong cache và không bao giờ chạm nhánh này.
  // Chỉ hostname lạ mới tiêu token — đúng thứ ta muốn bóp.
  if (!lookupBudget.tryTake()) {
    return { allow: false, source: 'rate_limited' };
  }

  try {
    const { rowCount } = await pool.query(SQL, [hostname]);
    const allow = rowCount > 0;
    cacheSet(hostname, allow);
    return { allow, source: 'db' };
  } catch (err) {
    // Fail-closed. KHÔNG cache kết quả lỗi: DB hồi phục thì phải phục vụ ngay.
    log('error', 'db_query_failed', { hostname, message: err.message });
    return { allow: false, source: 'error' };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://internal');

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  // Chỉ một endpoint. Mọi path khác không tồn tại.
  if (req.method !== 'GET' || url.pathname !== '/internal/tls/authorize') {
    res.writeHead(404);
    return res.end();
  }

  const started = process.hrtime.bigint();
  const raw = url.searchParams.get('domain');
  const hostname = normalizeHostname(raw);

  let allow = false;
  let source = 'reject';

  if (hostname && !isReserved(hostname, PLATFORM_DOMAIN)) {
    ({ allow, source } = await isAuthorized(hostname));
  }

  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  // Caddy coi mọi non-2xx là từ chối. Body không quan trọng; giữ rỗng.
  res.writeHead(allow ? 200 : 403);
  res.end();

  log(allow ? 'info' : 'warn', allow ? 'tls_allow' : 'tls_deny', {
    domain: raw ?? null,
    normalized: hostname,
    source,
    ms: Math.round(ms * 10) / 10,
  });
});

// Caddy gọi qua network nội bộ Docker. Endpoint này KHÔNG BAO GIỜ được publish
// ra Internet — không có xác thực, và nó tiết lộ domain nào đang có trên nền tảng.
server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT }));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log('info', 'shutting_down', { signal: sig });
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
