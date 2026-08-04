/**
 * REDIS TỐI GIẢN (RESP qua net) — bản DÙNG CHUNG.
 *
 * Image của mỗi service là bản tối giản (chỉ src + pg), KHÔNG có ioredis. Rate-limit và các
 * bộ đếm chỉ cần EVAL + DEL, nên tự nói RESP qua `net` (built-in) — không thêm dependency,
 * không rebuild image (khớp luồng dev: bind-mount + restart).
 *
 * Ngữ nghĩa: Redis chưa sẵn sàng / lệnh quá hạn → REJECT NGAY (không treo request); nuốt lỗi
 * socket (không làm sập tiến trình). Mọi chỗ gọi đều bắt lỗi → FAIL-OPEN: bug ở client cùng
 * lắm là mất số đếm hoặc mất rate-limit, chứ không sập service.
 *
 * TỚI SERVICE BẰNG BIND-MOUNT `/app/redis-lite.js` khai trong compose.dev.yml VÀ
 * compose.prod.yml — cùng cơ chế với packages/net-guard và packages/inventory. Từ `src/` thì
 * import là `'../redis-lite.js'`.
 *
 * DỌN DANG DỞ CÓ CHỦ Ý: checkout · storefront · payment vẫn giữ BẢN SAO trong server.js của
 * chúng. Đưa ba service đó sang đây có nghĩa là sửa đường nóng thanh toán để đổi một đoạn mã
 * đang chạy đúng — đánh đổi tồi khi làm cùng lúc với một tính năng mới. Bộ
 * apps/seller/test/redis-lite.test.js canh bốn bản khớp nhau từng ký tự, nên chúng KHÔNG thể
 * âm thầm trôi lệch trong lúc chờ.
 */
import net from 'node:net';

function respParse(b, i) {
  if (i >= b.length) return { ok: false };
  const type = b[i];
  const nl = b.indexOf('\r\n', i + 1);
  if (nl < 0) return { ok: false };
  const line = b.toString('latin1', i + 1, nl);
  const after = nl + 2;
  if (type === 0x2b) return { ok: true, value: line, next: after };                 // + chuỗi đơn
  if (type === 0x2d) return { ok: true, value: new Error(line), next: after, err: true }; // - lỗi
  if (type === 0x3a) return { ok: true, value: Number(line), next: after };         // : số nguyên
  if (type === 0x24) {                                                              // $ bulk
    const len = Number(line);
    if (len < 0) return { ok: true, value: null, next: after };
    const end = after + len;
    if (end + 2 > b.length) return { ok: false };
    return { ok: true, value: b.toString('utf8', after, end), next: end + 2 };
  }
  if (type === 0x2a) {                                                              // * mảng (reply EVAL)
    const n = Number(line);
    if (n < 0) return { ok: true, value: null, next: after };
    const arr = []; let p = after;
    for (let k = 0; k < n; k++) { const el = respParse(b, p); if (!el.ok) return { ok: false }; arr.push(el.value); p = el.next; }
    return { ok: true, value: arr, next: p };
  }
  return { ok: false };
}
function makeRedis(url, { commandTimeout = 1000 } = {}) {
  const u = new URL(url);
  const host = u.hostname, port = Number(u.port || 6379);
  let sock = null, ready = false, buf = Buffer.alloc(0);
  const pending = []; // hàng đợi resolver theo ĐÚNG thứ tự Redis trả lời (1 kết nối = FIFO)
  function fail(err) {
    ready = false;
    while (pending.length) { const p = pending.shift(); clearTimeout(p.timer); p.reject(err); }
    if (sock) { sock.removeAllListeners(); sock.destroy(); sock = null; }
    setTimeout(connect, 500).unref();
  }
  function connect() {
    try {
      sock = net.connect({ host, port });
      sock.setNoDelay(true);
      sock.on('connect', () => { ready = true; });
      sock.on('error', () => {});                       // đã xử lý ở 'close' → nuốt để không throw
      sock.on('close', () => fail(new Error('redis closed')));
      sock.on('data', (chunk) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        let out;
        while (pending.length && (out = respParse(buf, 0)).ok) {
          buf = buf.subarray(out.next);
          const p = pending.shift(); clearTimeout(p.timer);
          out.err ? p.reject(out.value) : p.resolve(out.value);
        }
      });
    } catch { ready = false; setTimeout(connect, 500).unref(); }
  }
  function send(args) {
    return new Promise((resolve, reject) => {
      if (!ready || !sock) return reject(new Error('redis not ready')); // enableOfflineQueue:false
      let cmd = `*${args.length}\r\n`;
      for (const a of args) { const s = String(a); cmd += `$${Buffer.byteLength(s)}\r\n${s}\r\n`; }
      const timer = setTimeout(() => fail(new Error('redis timeout')), commandTimeout);
      pending.push({ resolve, reject, timer });
      sock.write(cmd);
    });
  }
  connect();
  return {
    eval: (script, numkeys, ...rest) => send(['EVAL', script, numkeys, ...rest]),
    del: (key) => send(['DEL', key]),
  };
}

export { makeRedis, respParse };
