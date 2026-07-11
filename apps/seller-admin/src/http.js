/** Tiện ích HTTP cho admin-web (BFF). Không framework. */

const AMP = /&/g, LT = /</g, GT = />/g, QUOT = /"/g, APOS = /'/g;
export const esc = (s) => String(s ?? '').replace(AMP, '&amp;').replace(LT, '&lt;').replace(GT, '&gt;').replace(QUOT, '&quot;').replace(APOS, '&#39;');

export const SESSION_COOKIE = '__Host-session';

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('='); if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// CSP nghiêm: admin-web là SSR form thuần, KHÔNG script → chống XSS mạnh. no-store: có PII.
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
export function sendHtml(res, status, html, setCookies = []) {
  const headers = {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': CSP, 'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  };
  if (setCookies.length) headers['set-cookie'] = setCookies;
  res.writeHead(status, headers); res.end(html);
}

export function redirect(res, location, setCookies = []) {
  const headers = { location, 'cache-control': 'no-store' };
  if (setCookies.length) headers['set-cookie'] = setCookies;
  res.writeHead(303, headers); res.end();
}

export function readForm(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 32 * 1024) { reject(Object.assign(new Error('body quá lớn'), { statusCode: 413 })); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { const p = new URLSearchParams(Buffer.concat(chunks).toString('utf8')); const o = {}; for (const [k, v] of p) o[k] = v; resolve(o); });
    req.on('error', reject);
  });
}

// CSRF: POST đổi trạng thái phải có Origin thuộc allowlist (Origin của chính admin).
export function sameOrigin(req, allowed) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const o = req.headers.origin;
  return !!o && allowed.includes(o);
}
