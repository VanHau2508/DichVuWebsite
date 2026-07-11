/** Tiện ích HTTP dùng chung — không framework. */

const MAX_BODY = 16 * 1024; // 16KB: thân request auth luôn nhỏ; chặn nuốt bộ nhớ

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

export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// __Host- prefix: trình duyệt chỉ chấp nhận khi có Secure, Path=/, KHÔNG có Domain.
// Đó là cam kết mạnh nhất về phạm vi cookie — không thể bị đặt bởi subdomain.
export const SESSION_COOKIE = '__Host-session';

export function setSessionCookie(res, token, maxAgeSec) {
  res.setHeader(
    'set-cookie',
    `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`,
  );
}

export function clearSessionCookie(res) {
  res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * Chống CSRF cho phương thức đổi trạng thái: Origin phải nằm trong allowlist.
 * Kết hợp với SameSite=Lax, đây là hai lớp chặn request gửi chéo site.
 * GET/HEAD miễn (không đổi trạng thái).
 */
export function originAllowed(req, allowedOrigins) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origin = req.headers.origin;
  if (!origin) return false; // request đổi trạng thái phải có Origin
  return allowedOrigins.includes(origin);
}

export function clientIp(req) {
  // Topology: client → Caddy (proxy tin cậy DUY NHẤT) → dịch vụ này.
  // Caddy nối/đặt IP nó thấy vào X-Forwarded-For, nên giá trị ĐÁNG TIN là phần tử
  // PHẢI NHẤT (do chính Caddy ghi). Lấy phần tử TRÁI nhất là sai: nếu client tự
  // gửi sẵn XFF và có thêm một proxy phía trước, trái nhất do kẻ tấn công điều
  // khiển → giả mạo được để né rate limit theo IP và đầu độc audit log.
  //
  // (Kiểm chứng: gửi 'X-Forwarded-For: 9.9.9.9' qua Caddy hiện tại → upstream
  //  nhận đúng IP thật, vì Caddy thay thế header giả. Lấy phải nhất vẫn đúng, và
  //  giữ đúng nếu sau này Caddy chuyển sang chế độ nối thêm.)
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    const parts = xff.split(',');
    return parts[parts.length - 1].trim();
  }
  return req.socket.remoteAddress ?? null;
}
