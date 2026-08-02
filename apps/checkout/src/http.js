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
// Ảnh giỏ phục vụ từ MEDIA_PUBLIC_BASE. Mặc định TƯƠNG ĐỐI (/media-public) → cùng origin
// → new URL(...) ném lỗi → MEDIA_ORIGIN='' → CSP chỉ 'self' (đủ, vì ảnh same-origin). Nếu
// prod đặt base tuyệt đối (CDN) thì origin đó được thêm vào img-src. KHỚP default server.js.
const MEDIA_ORIGIN = (() => { try { return new URL(process.env.MEDIA_PUBLIC_BASE ?? '/media-public').origin; } catch { return ''; } })();
const HTML_CSP = `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' data:${MEDIA_ORIGIN ? ' ' + MEDIA_ORIGIN : ''}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
// nonce → CHỈ trang checkout (GPS): thêm script-src 'nonce-X' (KHÔNG script ngoài) + connect-src 'self'
// (để fetch('/checkout/geocode') không bị default-src 'none' chặn). 'unsafe-inline' GIỮ ở style-src,
// TUYỆT ĐỐI không lọt vào script-src (nếu lọt → trình duyệt bỏ nonce → vỡ). Trang khác nonce='' → khoá cứng như cũ.
const htmlCsp = (nonce) => nonce ? `${HTML_CSP}; script-src 'nonce-${nonce}'; connect-src 'self'` : HTML_CSP;
export function sendHtml(res, status, html, headers = {}, nonce = '') {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': htmlCsp(nonce), 'x-content-type-options': 'nosniff',
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

// Giỏ "MUA NGAY" RIÊNG (cookie khác) → thanh toán ĐÚNG 1 món, GIỮ NGUYÊN giỏ chính. TTL ngắn (1h,
// mua-ngay là ý định tức thời). checkout dùng giỏ này khi có ?bn=1 / form bn=1.
export const BUYNOW_COOKIE = '__Host-buynow';
// Mã giới thiệu CTV (docs/51): storefront đặt khi khách vào qua ?ref=MA. Last-click, TTL do
// shop chỉnh (mặc định 30 ngày như Shopee). KHÔNG HttpOnly-only cho vui — vẫn HttpOnly vì
// chỉ server cần đọc; SameSite=Lax để link CTV từ Facebook/TikTok vẫn mang cookie sang.
export const REF_COOKIE = '__Host-ref';
export function setBuynowCookie(res, token) {
  res.setHeader('set-cookie', `${BUYNOW_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`);
}
export function clearBuynowCookie(res) {
  res.setHeader('set-cookie', `${BUYNOW_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
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
