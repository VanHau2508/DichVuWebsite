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

// CSP nghiêm cho trang giỏ/checkout: KHÔNG script (form thuần, không JS) → chống XSS
// mạnh; style nội tuyến cho phép (một khối <style> tĩnh của ta). no-store: trang có PII/giá.
// Ảnh giỏ phục vụ từ MEDIA_PUBLIC_BASE (CDN) → thêm origin đó vào img-src, nếu không CSP chặn.
// Default KHỚP server.js: env luôn được set ở dev/prod, nhưng nếu thiếu thì cả ảnh (server.js)
// lẫn img-src (đây) cùng trỏ minio → không lệch (ảnh hiện được thay vì bị CSP chặn im lặng).
const MEDIA_ORIGIN = (() => { try { return new URL(process.env.MEDIA_PUBLIC_BASE ?? 'http://minio:9000/media-public').origin; } catch { return ''; } })();
const HTML_CSP = `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:${MEDIA_ORIGIN ? ' ' + MEDIA_ORIGIN : ''}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
export function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': HTML_CSP, 'x-content-type-options': 'nosniff',
    // no-referrer: /checkout/success mang lookup token trong URL; strict-origin-when-cross
    // -origin sẽ gửi CẢ URL (kèm token) làm Referer khi bấm link same-origin → rò token vào
    // log tầng storefront. CSRF dùng Origin (sameOrigin), KHÔNG dùng Referer nên đổi vô hại.
    'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', ...headers,
  });
  res.end(html);
}

export function redirect(res, location) {
  // 303: sau POST (PRG) → trình duyệt GET trang kết quả, không gửi lại form khi refresh.
  res.writeHead(303, { location, 'cache-control': 'no-store' });
  res.end();
}

// Đọc body form (application/x-www-form-urlencoded) cho trang không-JS.
export function readForm(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 32 * 1024) { reject(Object.assign(new Error('body quá lớn'), { statusCode: 413 })); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => {
      const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const out = {}; for (const [k, v] of params) out[k] = v; resolve(out);
    });
    req.on('error', reject);
  });
}

/** Client CÓ muốn HTML không (điều hướng trình duyệt) hay JSON (API/e2e)? */
export function wantsHtml(req) {
  return String(req.headers.accept ?? '').includes('text/html');
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
