/**
 * Chuẩn hoá và kiểm tra hostname. Hàm thuần, không phụ thuộc gì.
 *
 * Tách khỏi server.js để test được mà không cần database.
 * Đây là lớp lọc chạy TRƯỚC khi chạm database: máy quét cổng gõ vào IP suốt
 * ngày đêm, không có lý do gì để chúng tạo được một query Postgres.
 */

// Nhãn DNS: 1–63 ký tự, không bắt đầu/kết thúc bằng '-'
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);

/**
 * @param {unknown} raw  giá trị SNI do client điều khiển — không tin bất cứ gì
 * @returns {string|null} hostname đã chuẩn hoá, hoặc null nếu không hợp lệ
 */
export function normalizeHostname(raw) {
  if (typeof raw !== 'string') return null;

  let h = raw.trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1); // FQDN dạng "shopa.test."

  if (h.length === 0 || h.length > 253) return null;
  if (h.includes(':')) return null; // có port, hoặc là IPv6
  if (h.includes('*')) return null; // on-demand không bao giờ cấp wildcard
  if (h.includes('_')) return null; // không hợp lệ trong hostname công khai

  if (!HOSTNAME_RE.test(h)) return null; // ít nhất hai nhãn

  // "1.2.3.4" khớp regex trên vì chữ số là ký tự hợp lệ trong nhãn → loại riêng.
  if (/^\d+(\.\d+)+$/.test(h)) return null;

  // TLD toàn chữ số không tồn tại.
  if (/\.\d+$/.test(h)) return null;

  return h;
}

/**
 * Domain của chính nền tảng đã có site block tường minh trong Caddyfile nên
 * không bao giờ đi qua on-demand. Chặn ở đây là phòng thủ chiều sâu: một dòng
 * `domains` độc hại trỏ tới admin.nentang.vn không được phép sinh chứng chỉ.
 *
 * @param {string} hostname  đã chuẩn hoá
 * @param {string} platformDomain  ví dụ "nentang.vn"; chuỗi rỗng = tắt kiểm tra
 */
export function isReserved(hostname, platformDomain) {
  if (!platformDomain) return false;
  const p = platformDomain.toLowerCase();
  return hostname === p || hostname.endsWith('.' + p);
}
