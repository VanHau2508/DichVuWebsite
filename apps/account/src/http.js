/** Tiện ích HTTP cho service tài khoản khách — không framework (mẫu apps/checkout/src/http.js). */

const MAX_BODY = 32 * 1024;
const MEDIA_ORIGIN = (() => { try { return new URL(process.env.MEDIA_PUBLIC_BASE ?? '/media-public').origin; } catch { return ''; } })();
// CSP nghiêm no-JS: default-src 'none', KHÔNG script-src (form thuần) → chống XSS mạnh.
const HTML_CSP = `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' data:${MEDIA_ORIGIN ? ' ' + MEDIA_ORIGIN : ''}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

export function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

// noStore + no-referrer: trang tài khoản có PII; trang mang token (reset/verify) không được
// rò token qua Referer. noindex: không cho crawler lập chỉ mục trang tài khoản.
export function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, private',
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

export function parseCookies(req) {
  const header = req.headers.cookie; const out = {};
  if (!header) return out;
  for (const part of header.split(';')) { const i = part.indexOf('='); if (i === -1) continue; out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

// Cookie phiên khách — TÊN KHÁC HẲN __Host-session (seller) và __Host-cart. SameSite=Lax để
// link GET verify/reset từ email còn mang cookie; thao tác đổi trạng thái là POST đã chặn Origin.
export const CUSTOMER_COOKIE = '__Host-cust_session';
export function setCustomerCookie(res, token, maxAgeSec) {
  res.setHeader('set-cookie', `${CUSTOMER_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`);
}
export function clearCustomerCookie(res) {
  res.setHeader('set-cookie', `${CUSTOMER_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// CSRF domain ĐỘNG: Origin của POST phải CÙNG HOST với domain đang truy cập (mỗi shop domain riêng).
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

// Escape HTML — mọi dữ liệu khách (tên, email, địa chỉ) qua đây trước khi vào trang.
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
