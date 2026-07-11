/** Tiện ích HTTP dùng chung cho seller-admin — không framework. */

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

// Đọc thân request nhị phân (upload ảnh). Chặn kích thước để không nuốt bộ nhớ.
//
// KHÔNG req.destroy() khi quá cỡ: huỷ socket giữa chừng làm client nhận ECONNRESET
// thay vì 413. Thay vào đó: (1) từ chối nhanh theo Content-Length, (2) nếu vượt khi
// streaming (chunked/khai man) thì ngừng gom và reject — dispatcher gửi 413 kèm
// Connection: close để đóng gọn sau khi phản hồi ra.
export function readBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return reject(Object.assign(new Error('file quá lớn'), { statusCode: 413 }));
    }
    let size = 0;
    let done = false;
    const chunks = [];
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) {
        done = true;
        return reject(Object.assign(new Error('file quá lớn'), { statusCode: 413 }));
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
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

export function originAllowed(req, allowedOrigins) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}

export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    const parts = xff.split(',');
    return parts[parts.length - 1].trim();
  }
  return req.socket.remoteAddress ?? null;
}
