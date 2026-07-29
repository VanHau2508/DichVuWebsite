/**
 * Lớp ĐỌC DỮ LIỆU THUẦN của bộ nhập di cư (docs/45) — KHÔNG phụ thuộc DB, HTTP hay mạng.
 *
 * Tách khỏi import.js vì hai lý do, và lý do thứ hai mới là lý do thật:
 *  1. đây là chỗ SAI TIỀN / SAI NGÀY dễ nhất của cả tính năng;
 *  2. muốn test nó bằng unit test chạy ở MỌI commit thì nó không được kéo theo `pg` —
 *     import.js có, nên test đặt ở đó không chạy nổi ngoài container.
 */

/**
 * Số nguyên VND từ chuỗi người dùng. ĐÂY LÀ CHỖ SAI TIỀN DỄ NHẤT CỦA CẢ TÍNH NĂNG.
 *
 * Bản đầu chỉ "bỏ mọi ký tự không phải số". Đúng với kiểu Việt Nam ("199.000" → 199000) và
 * SAI THẢM HOẠ với tệp Shopify, vốn ghi giá kèm 2 chữ số thập phân: "199000.00" → 19.900.000,
 * tức MỌI GIÁ CAO GẤP 100 LẦN. Tệ hơn mọi lỗi khác vì con số ra vẫn trông hợp lý — người bán
 * không nhìn thấy gì bất thường cho tới khi khách kêu.
 *
 * Quy tắc phân định (dấu chấm/phẩy vừa là phân nhóm vừa là thập phân tuỳ vùng):
 *   - có CẢ chấm lẫn phẩy  → dấu ĐỨNG SAU là thập phân, dấu kia là phân nhóm;
 *   - chỉ một loại, xuất hiện NHIỀU LẦN → chắc chắn phân nhóm ("1.250.000");
 *   - chỉ một loại, một lần, theo sau ĐÚNG 3 CHỮ SỐ → phân nhóm.
 *     Đây là lựa chọn CÓ CHỦ ĐÍCH cho VND: "199.000" là 199 nghìn, không phải 199 đồng.
 *     Tiền Việt không có phần lẻ, nên đọc thành 199 là vô nghĩa còn 199000 là bình thường;
 *   - còn lại (1-2 chữ số theo sau) → thập phân, làm tròn (VND không có xu).
 */
export function parseAmount(v, dflt = null) {
  const raw = String(v ?? '').trim();
  if (raw === '') return dflt;
  const neg = raw.startsWith('-');
  const s = raw.replace(/[^\d.,]/g, '');          // bỏ ₫, đ, VND, khoảng trắng, dấu âm
  if (s === '') return dflt;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let dec = null;
  if (lastDot >= 0 && lastComma >= 0) {
    dec = lastDot > lastComma ? '.' : ',';
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const parts = s.split(sep);
    const tail = parts[parts.length - 1];
    dec = (parts.length > 2 || tail.length === 3) ? null : sep;
  }

  let intPart = s, frac = '';
  if (dec) {
    const i = s.lastIndexOf(dec);
    intPart = s.slice(0, i);
    frac = s.slice(i + 1);
  }
  intPart = intPart.replace(/[.,]/g, '');
  if (intPart === '' && frac === '') return dflt;
  const n = Number(`${intPart || '0'}.${frac || '0'}`);
  if (!Number.isFinite(n)) return dflt;
  return Math.round(n) * (neg ? -1 : 1);
}

/**
 * Ngày từ chuỗi người dùng. Nhận ISO (2026-07-28, kèm giờ) và kiểu Việt Nam 28/07/2026.
 * Trả Date hoặc null. TỪ CHỐI ngày TƯƠNG LAI: đơn "cũ" mà nằm ở tương lai thì hoặc tệp sai
 * hoặc đọc nhầm định dạng — cả hai đều làm hỏng hồ sơ khách nếu cứ nhập.
 */
export function parseOrderDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let d = null;
  const vn = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s);
  if (vn) d = new Date(Date.UTC(Number(vn[3]), Number(vn[2]) - 1, Number(vn[1]), 5));  // ~12h giờ VN
  else if (/^\d{4}-\d{2}-\d{2}/.test(s)) d = new Date(s.length === 10 ? `${s}T05:00:00Z` : s);
  if (!d || Number.isNaN(d.getTime())) return null;
  if (d.getTime() > Date.now() + 86400000) return null;
  return d;
}

