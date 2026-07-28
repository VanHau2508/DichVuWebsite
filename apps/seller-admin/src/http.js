import crypto from 'node:crypto';
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

// Ảnh sản phẩm phục vụ từ CDN/MinIO (MEDIA_PUBLIC_BASE) → thêm origin đó vào img-src,
// nếu không CSP chặn ảnh. Origin đó PHẢI khớp CSP ở edge (Caddyfile) vì trình duyệt
// áp GIAO hai policy.
const MEDIA_ORIGIN = (() => { try { return new URL(process.env.MEDIA_PUBLIC_BASE ?? '').origin; } catch { return ''; } })();
// CSP nghiêm. no-store: trang có PII.
//
// ADR-011: seller-admin ĐƯỢC phép chạy JS nội tuyến ký nonce (storefront/checkout/account/
// signup KHÔNG đổi). Ràng buộc #4 "mặc định an toàn": `script-src` CHỈ xuất hiện khi trang
// thật sự cần JS. Không truyền nonce → không có script-src → `default-src 'none'` khoá cứng
// y như trước. 164 lời gọi sendHtml hiện có không đổi một chữ nào, và tất cả đều nằm ở
// nhánh khoá cứng — thêm JS phải là hành động CÓ Ý, không thể xảy ra do quên.
//
// VÌ SAO KHÔNG suy nonce từ chính HTML (đã cân nhắc và BỎ): quét `<script nonce="X">` trong
// body rồi bơm X vào header thì khỏi phải sửa 164 chỗ — nhưng nó phá huỷ chính thứ nonce bảo
// vệ. Nonce có giá trị vì kẻ tấn công KHÔNG ĐOÁN ĐƯỢC; nếu header lấy giá trị từ body thì một
// đoạn `<script nonce="abc">` chèn được vào sẽ tự động được header chúc phúc. Nonce phải do
// server sinh và dùng cho CẢ HAI nơi.
const CSP_BASE = `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' data:${MEDIA_ORIGIN ? ' ' + MEDIA_ORIGIN : ''}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
// script-src CHỈ chứa nonce — không 'unsafe-inline', không 'unsafe-eval', không
// 'strict-dynamic', không host ngoài (ADR-011 #2). scripts/security-scan.sh canh điều này.
export const cspFor = (nonce) => (nonce ? `${CSP_BASE}; script-src 'nonce-${nonce}'` : CSP_BASE);
export const newNonce = () => crypto.randomBytes(16).toString('base64');

// Gửi trang CÓ JS: sinh nonce MỘT LẦN rồi đưa cùng một giá trị cho cả hàm dựng HTML lẫn
// header. Không thể lệch nhau — đó là lý do tồn tại của helper này thay vì để nơi gọi tự
// sinh rồi tự nhớ truyền hai chỗ.
export function sendHtmlJs(res, status, build, setCookies = []) {
  const nonce = newNonce();
  return sendHtml(res, status, build(nonce), setCookies, nonce);
}
export function sendHtml(res, status, html, setCookies = [], nonce = '') {
  const headers = {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': cspFor(nonce), 'x-content-type-options': 'nosniff',
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

// Tải file nhị phân (ZIP export). LUÔN attachment (không bao giờ inline — hợp CSP
// default-src 'none'); no-store vì chứa PII; nosniff. filename làm sạch CR/LF/nháy để
// không chèn header. Ghi Buffer trực tiếp.
export function sendDownload(res, buf, { filename = 'download.zip', contentType } = {}) {
  const safe = String(filename).replace(/[\r\n"\\]/g, '_');
  res.writeHead(200, {
    'content-type': contentType || 'application/octet-stream',
    'content-disposition': `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'content-length': buf.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(buf);
}

export function readForm(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []; let over = false;
    // Vượt trần: NGỪNG tích luỹ (chặn RAM) nhưng KHÔNG destroy socket — nếu destroy,
    // response lỗi ghi vào socket chết = no-op im lặng (handler mất trang báo lỗi).
    req.on('data', (c) => { if (over) return; size += c.length; if (size > 32 * 1024) { over = true; reject(Object.assign(new Error('body quá lớn'), { statusCode: 413 })); return; } chunks.push(c); });
    req.on('end', () => { if (over) return; const p = new URLSearchParams(Buffer.concat(chunks).toString('utf8')); const o = {}; for (const [k, v] of p) o[k] = v; resolve(o); });
    req.on('error', reject);
  });
}

// Như readForm nhưng GIỮ mọi giá trị của key trùng (checkbox nhiều) → trả URLSearchParams
// để handler dùng .getAll('name'). readForm thường ghi đè, mất lựa chọn nhiều.
export function readFormAll(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []; let over = false;
    req.on('data', (c) => { if (over) return; size += c.length; if (size > 64 * 1024) { over = true; reject(Object.assign(new Error('body quá lớn'), { statusCode: 413 })); return; } chunks.push(c); });
    req.on('end', () => { if (over) return; resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))); });
    req.on('error', reject);
  });
}

// Đọc toàn bộ body thô thành Buffer, có trần kích thước (413 nếu vượt).
export function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []; let over = false;
    // Xem readForm: ngừng tích luỹ khi vượt, KHÔNG destroy để handler còn ghi được trang lỗi.
    req.on('data', (c) => { if (over) return; size += c.length; if (size > maxBytes) { over = true; reject(Object.assign(new Error('body quá lớn'), { statusCode: 413 })); return; } chunks.push(c); });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

// Bóc MỘT file từ multipart/form-data (không framework). Trả {filename, bytes} của
// part đầu tiên có filename, hoặc null. Xử lý nhị phân bằng Buffer.indexOf trên boundary.
export async function readMultipartFile(req, maxBytes = 10 * 1024 * 1024) {
  const ct = req.headers['content-type'] || '';
  const m = /multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (!m) return null;
  const token = (m[1] || m[2]).trim();
  const dash = Buffer.from('--' + token);        // boundary MỞ ĐẦU: có thể không có CRLF phía trước
  const delim = Buffer.from('\r\n--' + token);   // ranh giới GIỮA các part (RFC 2046: CRLF + --boundary)
  const body = await readRawBody(req, maxBytes);
  let pos = body.indexOf(dash);
  if (pos === -1) return null;
  pos += dash.length;
  while (pos < body.length) {
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;          // "--" → boundary kết thúc
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;       // bỏ CRLF sau dòng boundary
    const hEnd = body.indexOf('\r\n\r\n', pos, 'latin1');
    if (hEnd === -1) break;
    const headers = body.slice(pos, hEnd).toString('latin1');
    const cStart = hEnd + 4;
    // Tìm ĐÚNG "\r\n--boundary" → không khớp nhầm token boundary nằm giữa byte ảnh.
    const next = body.indexOf(delim, cStart);
    if (next === -1) break;
    const bytes = body.slice(cStart, next);                          // delim đã gồm CRLF, không trừ 2
    const fn = /filename="([^"]*)"/i.exec(headers);
    if (fn && fn[1]) return { filename: fn[1], bytes };
    pos = next + delim.length;
  }
  return null;
}

// Bóc NHIỀU file từ multipart/form-data (upload nhiều ảnh cùng lúc). Trả mảng {filename,
// bytes} của MỌI part có filename (bỏ part filename rỗng). maxBytes là trần TỔNG body.
export async function readMultipartFiles(req, maxBytes = 40 * 1024 * 1024) {
  const ct = req.headers['content-type'] || '';
  const m = /multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (!m) return [];
  const token = (m[1] || m[2]).trim();
  const dash = Buffer.from('--' + token);
  const delim = Buffer.from('\r\n--' + token);
  const body = await readRawBody(req, maxBytes);
  const out = [];
  let pos = body.indexOf(dash);
  if (pos === -1) return out;
  pos += dash.length;
  while (pos < body.length) {
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    const hEnd = body.indexOf('\r\n\r\n', pos, 'latin1');
    if (hEnd === -1) break;
    const headers = body.slice(pos, hEnd).toString('latin1');
    const cStart = hEnd + 4;
    const next = body.indexOf(delim, cStart);
    if (next === -1) break;
    const bytes = body.slice(cStart, next);
    const fn = /filename="([^"]*)"/i.exec(headers);
    if (fn && fn[1] && bytes.length) out.push({ filename: fn[1], bytes });
    pos = next + delim.length;
  }
  return out;
}

// Bóc CẢ field text LẪN file (kèm tên field) từ multipart/form-data — cho form vừa upload
// ảnh vừa nhập chữ (banner Phase 5). Trả { fields: {name→string}, files: [{field,filename,bytes}] }.
// Cùng cơ chế boundary như readMultipartFiles; part không có filename → field text (utf8).
export async function readMultipartAll(req, maxBytes = 40 * 1024 * 1024) {
  const ct = req.headers['content-type'] || '';
  const m = /multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (!m) return { fields: {}, files: [] };
  const token = (m[1] || m[2]).trim();
  const dash = Buffer.from('--' + token);
  const delim = Buffer.from('\r\n--' + token);
  const body = await readRawBody(req, maxBytes);
  const fields = {}, files = [];
  let pos = body.indexOf(dash);
  if (pos === -1) return { fields, files };
  pos += dash.length;
  while (pos < body.length) {
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    const hEnd = body.indexOf('\r\n\r\n', pos, 'latin1');
    if (hEnd === -1) break;
    const headers = body.slice(pos, hEnd).toString('latin1');
    const cStart = hEnd + 4;
    const next = body.indexOf(delim, cStart);
    if (next === -1) break;
    const bytes = body.slice(cStart, next);
    const nameM = /name="([^"]*)"/i.exec(headers);
    const fnM = /filename="([^"]*)"/i.exec(headers);
    const name = nameM ? nameM[1] : '';
    if (fnM) { if (fnM[1] && bytes.length) files.push({ field: name, filename: fnM[1], bytes }); }
    else if (name) fields[name] = bytes.toString('utf8');
    pos = next + delim.length;
  }
  return { fields, files };
}

// CSRF: POST đổi trạng thái phải có Origin thuộc allowlist (Origin của chính admin).
export function sameOrigin(req, allowed) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const o = req.headers.origin;
  return !!o && allowed.includes(o);
}
