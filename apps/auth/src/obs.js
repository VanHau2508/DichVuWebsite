/**
 * Observability dùng chung (BẢN SAO mỗi service — service không share packages/ vì
 * build context bó hẹp trong thư mục app). Giữ đồng bộ giữa các service.
 *
 *   - request-id (correlation): lấy từ header `x-request-id` nếu hợp lệ, else sinh mới;
 *     lưu trong AsyncLocalStorage → log() tự gắn `rid` không cần luồn tham số qua mọi hàm.
 *   - makeLog(service): JSON log thống nhất ts + service + rid + event.
 *   - health(): /livez, /healthz (tiến trình sống, KHÔNG phụ thuộc) vs /readyz (DB/Redis
 *     gọi được — 503 nếu hỏng). Giữ /healthz để healthcheck compose/Caddy không đổi.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';

const als = new AsyncLocalStorage();
const RID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Chạy handler trong ngữ cảnh có request-id; đặt header phản hồi để bên gọi lần vết. */
export function runReq(req, res, handler) {
  const h = req.headers['x-request-id'];
  const id = (typeof h === 'string' && RID_RE.test(h)) ? h : crypto.randomUUID();
  res.setHeader('x-request-id', id);
  return als.run({ id }, () => handler());
}

/** request-id hiện tại (null nếu gọi ngoài request). */
export const requestId = () => als.getStore()?.id ?? null;

/** Log JSON thống nhất: ts + service + rid (nếu có) + level + event + fields. */
export function makeLog(service) {
  return (level, event, fields = {}) => {
    const rid = requestId();
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, service, ...(rid ? { rid } : {}), event, ...fields }) + '\n');
  };
}

/**
 * Xử lý đường sức khoẻ. `checks` = { tên: async () => {... throw nếu hỏng} }.
 *   /livez, /healthz → 200 (tiến trình sống, KHÔNG chạm phụ thuộc — DB sập vẫn 200).
 *   /readyz          → 200 nếu MỌI check ok, else 503 (kèm chi tiết từng check).
 * Mỗi check có TIMEOUT (mặc định 2s): probe phải trả lời nhanh cho load balancer, không
 * treo khi phụ thuộc kẹt (vd DNS 'postgres' không phân giải → getaddrinfo retry vài giây).
 * Trả true nếu đã xử lý (là đường health), false nếu không phải.
 */
export async function health(pathname, res, checks = {}, timeoutMs = 2000) {
  if (pathname === '/livez' || pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end('{"ok":true}');
    return true;
  }
  if (pathname === '/readyz') {
    const out = {};
    let ready = true;
    for (const [name, fn] of Object.entries(checks)) {
      const p = Promise.resolve().then(fn);
      p.catch(() => {}); // nuốt rejection MUỘN (sau khi timeout thắng) → không unhandledRejection
      let timer;
      try {
        await Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), timeoutMs); timer.unref?.(); })]);
        out[name] = 'ok';
      } catch { out[name] = 'fail'; ready = false; }
      finally { clearTimeout(timer); }
    }
    res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ready, checks: out }));
    return true;
  }
  return false;
}
