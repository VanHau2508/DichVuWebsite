/** Tiện ích HTTP dùng chung cho seller-admin — không framework. */

const MAX_BODY = 32 * 1024;

/**
 * Đọc body JSON. `maxBytes` cho phép TỪNG ROUTE nới trần riêng (route.maxBody) — mặc định
 * 32KB cho mọi endpoint, vì nới toàn cục là mở rộng bề mặt nuốt-bộ-nhớ ở chỗ không cần.
 *
 * KHÔNG req.destroy() khi quá cỡ — đây là lỗi cũ ở chính hàm này: huỷ socket giữa chừng
 * làm client nhận ECONNRESET thay vì 413, tức người dùng thấy "mất kết nối" chứ không thấy
 * "tệp quá lớn". readBuffer() ngay dưới đã ghi chú đúng cách làm; nay hai hàm làm giống nhau:
 * (1) từ chối nhanh theo Content-Length, (2) vượt khi streaming thì ngừng gom rồi reject,
 * để dispatcher gửi 413 kèm Connection: close.
 */
export function readJson(req, maxBytes = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return reject(Object.assign(new Error('body quá lớn'), { statusCode: 413 }));
    }
    let size = 0;
    let done = false;
    const chunks = [];
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) {
        done = true;
        return reject(Object.assign(new Error('body quá lớn'), { statusCode: 413 }));
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('JSON không hợp lệ'), { statusCode: 400 }));
      }
    });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
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
