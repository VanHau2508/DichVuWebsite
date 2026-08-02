/**
 * Bộ đồ nghề chung cho ĐỢT KIỂM TOÀN ĐÓNG VAI (tmp/ — gitignored, không thuộc bộ test).
 *
 * Khác e2e ở chỗ: e2e khẳng định bất biến, còn ở đây tôi đi như NGƯỜI DÙNG và ghi lại
 * chỗ vấp — thứ mà test xanh vẫn giấu được (thiếu hướng dẫn, ngõ cụt, phải đoán).
 */
import pg from 'pg';

export const AUTH = 'http://auth:3020';
export const PLATFORM = 'http://platform:3030';
export const SELLER = 'http://seller:3040';
export const ADMIN = 'http://seller-admin:3001';
export const STORE = 'http://storefront:3050';
export const CHECKOUT = 'http://checkout:3060';
export const ACCOUNT = 'http://account:3062';
export const SIGNUP = 'http://signup:3064';
export const PAYMENT = 'http://payment:3070';
export const WORKER = 'http://worker:3080';
export const OA = 'https://auth.localtest';
export const OADM = 'https://admin.localtest';
export const OS = 'https://seller.localtest';
export const OO = 'https://ops.localtest';

export const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });

let nOk = 0, nWarn = 0, nBad = 0;
export const findings = [];
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
export const ok = (m) => { nOk++; console.log(`  ${G}OK  ${X} ${m}`); };
export const warn = (m, d) => { nWarn++; findings.push({ sev: 'warn', m, d }); console.log(`  ${Y}VẤP ${X} ${m}`); if (d) console.log(`       ${D}${d}${X}`); };
export const bad = (m, d) => { nBad++; findings.push({ sev: 'bad', m, d }); console.log(`  ${R}HỎNG${X} ${m}`); if (d) console.log(`       ${D}${d}${X}`); };
export const sect = (m) => console.log(`\n${B}${m}${X}`);
export const summary = () => {
  console.log(`\n${B}=== ${nOk} chạy được · ${nWarn} vấp · ${nBad} hỏng ===${X}`);
  return { nOk, nWarn, nBad, findings };
};
export const uniq = () => Math.random().toString(36).slice(2, 10);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// HTTP thô bằng node:http, KHÔNG dùng fetch.
// Lý do: undici (fetch của Node) TỰ ĐẶT header Host theo URL và bỏ qua header ta truyền.
// Cả hệ này định tuyến bằng Host (storefront nhận shop, signup kiểm same-origin), nên
// fetch làm mọi request rơi vào host container → 404/403 giả. Đã mất một lượt đo vì cái này.
import http_ from 'node:http';
export function http(base, path, { method = 'GET', body, form, cookie, origin, host, headers = {} } = {}) {
  const u = new URL(base + path);
  const h = { ...headers };
  let payload;
  if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
  if (form !== undefined) { payload = new URLSearchParams(form).toString(); h['content-type'] = 'application/x-www-form-urlencoded'; }
  if (payload !== undefined) h['content-length'] = Buffer.byteLength(payload);
  if (origin) h.origin = origin;
  if (cookie) h.cookie = cookie;
  h.host = host ?? u.host; // ← điểm mấu chốt: Host do TA quyết định
  // Trình duyệt LUÔN gửi Accept. Vài endpoint (vd /cart) trả HTML hay JSON tuỳ header này —
  // thiếu nó thì ta đo JSON rồi kết luận "trang không hiện tạm tính". Đã dính một lần.
  if (!h.accept) h.accept = 'text/html,application/xhtml+xml';
  return new Promise((resolve) => {
    const req = http_.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, text, json, loc: res.headers.location, sc: res.headers['set-cookie'] ?? [], ct: res.headers['content-type'] });
      });
    });
    req.on('error', (e) => resolve({ status: 0, text: String(e.message), json: null, loc: null, sc: [], ct: null }));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export const sessionOf = (sc) => { for (const c of sc ?? []) { const m = /^__Host-session=([^;]*)/.exec(c); if (m) return `__Host-session=${m[1]}`; } return null; };
export const cookieOf = (sc, name) => { for (const c of sc ?? []) { const m = new RegExp(`^${name}=([^;]*)`).exec(c); if (m) return `${name}=${m[1]}`; } return null; };

// Lấy link trong email đã gửi (outbox) — đúng cách người dùng thật nhận được.
export async function mailLink(topic, to, field = 'accept_url') {
  const { rows } = await owner.query(
    `SELECT payload FROM outbox WHERE topic=$1 AND payload->>'to'=$2 ORDER BY id DESC LIMIT 1`, [topic, to]);
  return rows[0]?.payload?.[field] ?? null;
}
export async function lastMail(to) {
  const { rows } = await owner.query(`SELECT topic, payload FROM outbox WHERE payload->>'to'=$1 ORDER BY id DESC LIMIT 5`, [to]);
  return rows;
}
// Đếm text hiển thị (bỏ thẻ) để kiểm "khách có ĐỌC được câu này không".
export const visible = (html) => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
