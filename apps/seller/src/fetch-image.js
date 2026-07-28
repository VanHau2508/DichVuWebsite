/**
 * Tải ảnh từ URL do NGƯỜI BÁN cung cấp — docs/45 §5.
 *
 * MÔ HÌNH ĐE DOẠ. Từ khi có self-serve signup (docs/43), bất kỳ ai cũng tự mở được shop
 * trong vài giây. Nên URL trong file nhập là INPUT CỦA KẺ LẠ TRÊN INTERNET, không phải của
 * "người bán đáng tin". Tải hộ một URL tuỳ ý chính là SSRF sách giáo khoa: kẻ tấn công đăng
 * ký shop rồi nhập CSV trỏ vào mạng nội bộ để quét cổng (postgres:5432, redis:6379,
 * platform:3030), gọi API nội bộ không qua edge, đọc endpoint metadata của nhà cung cấp máy
 * chủ (169.254.169.254), hoặc mượn IP của ta làm bàn đạp đánh bên thứ ba.
 *
 * KHÔNG lớp nào một mình đủ — đây là lý do có từng lớp:
 *   1. chỉ http/https, chặn file:/gopher:/data:;
 *   2. cấm user:pass@ trong URL (http://evil@10.0.0.1 đánh lừa người đọc log);
 *   3. chỉ cổng 80/443 — cho cổng tuỳ ý là biến ta thành máy quét cổng cho IP công cộng;
 *   4. phân giải DNS rồi kiểm MỌI địa chỉ trả về; chỉ một địa chỉ nội bộ là từ chối cả URL
 *      (trả [công cộng, nội bộ] là mẹo để tầng dưới chọn nhầm);
 *   5. GHIM đúng IP đã duyệt khi kết nối (tham số `lookup`) — không có bước này thì
 *      "kiểm xong rồi mới nối" là cửa sổ TOCTOU của DNS-rebinding;
 *   6. TỪ CHỐI chuyển hướng: 30x là đường vòng qua lớp 4-5. Theo dấu cho đúng thì phải kiểm
 *      lại IP mỗi chặng — từ chối rẻ hơn và đủ dùng cho ảnh sản phẩm;
 *   7. trần kích thước kiểm CẢ Content-Length lẫn lúc chảy (khai man được), và timeout;
 *   8. lỗi trả về là MÃ CHUNG, không kèm mã trạng thái/thời gian của đích — đó chính là kênh
 *      của blind SSRF. Chi tiết chỉ đi vào log của ta.
 *
 * Sniff magic byte + re-encode nằm ở media.js (dùng chung với ảnh tự tải lên), không lặp ở đây.
 */

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';

/**
 * Host được MIỄN kiểm dải IP. CHỈ tồn tại để chạy e2e trong stack dev, nơi mọi địa chỉ đều
 * nội bộ nên đường-thành-công không thể kiểm được nếu không có lối thoát.
 *
 * Cố ý là DANH SÁCH TÊN MIỀN TƯỜNG MINH chứ không phải cờ bật/tắt kiểu ALLOW_PRIVATE=1: cờ
 * đó lỡ bật ở prod là tắt sạch hàng rào, còn danh sách chỉ mở đúng tên đã ghi. Nó KHÔNG nới
 * bất cứ lớp nào khác — scheme, cổng, chuyển hướng, trần cỡ, timeout, sniff magic byte,
 * re-encode đều giữ nguyên. Prod KHÔNG đặt biến này (server.js cảnh báo nếu thấy).
 */
const ALLOW_PRIVATE_HOSTS = new Set(
  String(process.env.IMPORT_IMG_ALLOW_HOSTS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
);
export const allowPrivateHosts = () => [...ALLOW_PRIVATE_HOSTS];

export class ImgError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/**
 * IPv4 công cộng? Chặn mọi dải đặc biệt của IANA, không chỉ "private" thường gặp.
 * Xuất ra để test đơn vị chạy được mà không cần mạng.
 */
export function isPublicIPv4(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4) return false;
  const n = p.map(Number);
  if (n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  const [a, b] = n;
  if (a === 0) return false;                          // 0.0.0.0/8 "this network"
  if (a === 10) return false;                         // private
  if (a === 127) return false;                        // loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 169 && b === 254) return false;           // link-local + METADATA 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return false;  // private
  if (a === 192 && b === 0) return false;             // 192.0.0/24 IETF + 192.0.2/24 TEST-NET-1
  if (a === 192 && b === 168) return false;           // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmark 198.18/15
  if (a === 198 && b === 51) return false;            // TEST-NET-2
  if (a === 203 && b === 0) return false;             // TEST-NET-3
  if (a >= 224) return false;                         // multicast 224/4 + reserved 240/4 + broadcast
  return true;
}

/** IPv6 công cộng? Gồm cả các dạng BỌC IPv4 — chỗ hay bị quên nhất. */
export function isPublicIPv6(ip) {
  const s = String(ip).toLowerCase().replace(/%.*$/, '');   // bỏ zone id fe80::1%eth0
  if (s === '::' || s === '::1') return false;              // unspecified, loopback
  if (s.startsWith('ff')) return false;                     // multicast
  if (/^f[cd]/.test(s)) return false;                       // ULA fc00::/7
  if (/^fe[89ab]/.test(s)) return false;                    // link-local fe80::/10
  if (/^fe[cdef]/.test(s)) return false;                    // site-local (bỏ nhưng vẫn chặn)
  // IPv4-mapped/compat dạng thập phân: ::ffff:169.254.169.254
  const dec = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dec) return isPublicIPv4(dec[1]);
  // IPv4-mapped dạng hex: ::ffff:a9fe:a9fe  ( = 169.254.169.254 )
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  if (hex) {
    const v = ((parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16)) >>> 0;
    return isPublicIPv4([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.'));
  }
  if (s.startsWith('2002:')) return false;                  // 6to4 — bọc IPv4 tuỳ ý
  if (s.startsWith('64:ff9b')) return false;                // NAT64
  return true;
}

export const isPublicAddr = (address, family) =>
  (Number(family) === 6 ? isPublicIPv6(address) : isPublicIPv4(address));

/**
 * Tải ảnh. Trả Buffer, hoặc ném ImgError với MÃ CHUNG.
 * Không bao giờ đi theo chuyển hướng, không bao giờ nối tới địa chỉ chưa duyệt.
 */
export async function fetchRemoteImage(rawUrl, { maxBytes = 8 * 1024 * 1024, timeoutMs = 5000 } = {}) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { throw new ImgError('url_invalid'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ImgError('scheme');
  if (u.username || u.password) throw new ImgError('userinfo');

  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (port !== 80 && port !== 443) throw new ImgError('port');

  // Bỏ ngoặc vuông của IPv6 literal ([::1]) trước khi phân giải.
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  try { addrs = await dns.lookup(host, { all: true, verbatim: true }); }
  catch { throw new ImgError('dns'); }
  if (!addrs?.length) throw new ImgError('dns');
  // MỌI địa chỉ phải công cộng. Một địa chỉ nội bộ lẫn vào là từ chối cả URL.
  if (!ALLOW_PRIVATE_HOSTS.has(host.toLowerCase())) {
    for (const a of addrs) if (!isPublicAddr(a.address, a.family)) throw new ImgError('blocked');
  }

  const pinned = addrs[0];
  // GHIM IP: net.connect gọi lookup này thay vì phân giải lại ⇒ đóng cửa sổ DNS-rebinding.
  const lookup = (_hostname, opts, cb) => {
    if (opts && opts.all) return cb(null, [{ address: pinned.address, family: pinned.family }]);
    return cb(null, pinned.address, pinned.family);
  };

  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (code) => { if (!settled) { settled = true; reject(new ImgError(code)); } };
    const req = mod.request({
      protocol: u.protocol, hostname: host, port, path: `${u.pathname}${u.search}`,
      method: 'GET', lookup, servername: host,   // servername: SNI + kiểm chứng chỉ theo TÊN MIỀN
      headers: { accept: 'image/*', 'user-agent': 'nentang-import/1' },
    }, (res) => {
      // 30x cũng rơi vào đây → từ chối, KHÔNG đi theo.
      if (res.statusCode !== 200) { res.resume(); return fail('status'); }
      const len = Number(res.headers['content-length']);
      if (Number.isFinite(len) && len > maxBytes) { res.destroy(); return fail('too_big'); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        if (settled) return;
        size += c.length;
        if (size > maxBytes) { res.destroy(); return fail('too_big'); }   // Content-Length khai man
        chunks.push(c);
      });
      res.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
      res.on('error', () => fail('net'));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); fail('timeout'); });
    req.on('error', () => fail('net'));
    req.end();
  });
}
