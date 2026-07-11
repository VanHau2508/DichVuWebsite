/** Tiện ích HTTP cho checkout — không framework. */

const MAX_BODY = 32 * 1024;

export function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body quá lớn'), { statusCode: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('JSON không hợp lệ'), { statusCode: 400 })); } });
    req.on('error', reject);
  });
}

export function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
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

export const CART_COOKIE = '__Host-cart';
export function setCartCookie(res, token, maxAgeSec) {
  res.setHeader('set-cookie', `${CART_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`);
}

/**
 * Chống CSRF cho domain ĐỘNG: Origin của request đổi trạng thái phải CÙNG HOST với
 * chính domain đang truy cập. Không cần allowlist tĩnh (mỗi shop một domain riêng).
 * Kết hợp SameSite=Lax của cookie giỏ hàng.
 */
export function sameOrigin(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) { const p = xff.split(','); return p[p.length - 1].trim(); }
  return req.socket.remoteAddress ?? null;
}
