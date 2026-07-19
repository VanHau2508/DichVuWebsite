/** Tiện ích HTTP cho service SIGNUP — không framework, no-JS SSR (mẫu apps/account/src/http.js). */

const MAX_BODY = 32 * 1024;
// CSP nghiêm no-JS: default-src 'none', KHÔNG script-src (form thuần) → chống XSS mạnh. Trang
// công khai (không PII đăng nhập) nhưng vẫn no-store (mang token verify) + noindex.
const HTML_CSP = `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

export function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

export function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': HTML_CSP, 'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow', ...headers,
  });
  res.end(html);
}

export function redirect(res, location, extraHeaders = {}) {
  res.writeHead(303, { location, 'cache-control': 'no-store', ...extraHeaders });
  res.end();
}

export function readForm(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('body quá lớn'), { statusCode: 413 })); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { const p = new URLSearchParams(Buffer.concat(chunks).toString('utf8')); const out = {}; for (const [k, v] of p) out[k] = v; resolve(out); });
    req.on('error', reject);
  });
}

// CSRF: POST phải cùng HOST với domain marketing đang truy cập (nentang.vn / www.nentang.vn).
export function sameOrigin(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) { const p = xff.split(','); return p[p.length - 1].trim(); }
  return req.socket.remoteAddress ?? null;
}

// Escape HTML — mọi dữ liệu người dùng (tên shop, slug, email) qua đây trước khi vào trang.
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
