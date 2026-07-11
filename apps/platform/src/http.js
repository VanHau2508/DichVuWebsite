/** Tiện ích HTTP dùng chung cho dịch vụ platform — không framework. */

const MAX_BODY = 32 * 1024;

export function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body quá lớn'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('JSON không hợp lệ'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

// Mutation phải có Origin hợp lệ (chống CSRF), y như dịch vụ auth.
export function originAllowed(req, allowedOrigins) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}

export function clientIp(req) {
  // Phần tử PHẢI nhất của X-Forwarded-For = giá trị Caddy (proxy tin cậy) đặt.
  // Lấy trái nhất là do kẻ tấn công điều khiển được (xem docs/08 #7).
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    const parts = xff.split(',');
    return parts[parts.length - 1].trim();
  }
  return req.socket.remoteAddress ?? null;
}
