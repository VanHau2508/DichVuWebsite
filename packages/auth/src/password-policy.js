/**
 * Chính sách MẬT KHẨU dùng chung — seller (apps/auth) + khách (apps/account).
 * Hoist từ apps/auth/src/server.js để không lặp danh sách yếu + luật độ dài.
 * NIST: ưu tiên ĐỘ DÀI, không ép ký tự phức tạp rối rắm. Tối thiểu 10, blocklist phổ biến.
 */
const WEAK_PASSWORDS = new Set([
  '1234567890', '0123456789', '12345678910', '1234567891', '12345678901',
  '9876543210', '1111111111', '0000000000', 'aaaaaaaaaa', 'abcdefghij',
  'abcd1234567', 'a1b2c3d4e5', '1q2w3e4r5t', 'qwertyuiop', 'qwerty1234',
  'qwerty12345', 'password12', 'password123', 'password1234', 'passw0rd123',
  'p@ssword123', 'iloveyou12', 'iloveyou123', 'admin12345', 'adminadmin',
  'administrator', 'welcome12345',
  'matmatkhau', 'matkhau123', 'matkhau1234', 'matkhau12345', 'daylamatkhau',
  'khongbiet1', 'khongbiet123', 'khongchobiet', 'vietnam123', 'vietnam1234',
  'hanoi12345', 'saigon12345', 'anhyeuem123', 'emyeuanh123', 'bongda12345',
  'xinchao123', 'xinchao1234', 'congchua123', 'hoangtu123', 'thanhcong123',
]);

// Bỏ dấu + thường hoá để so khớp ngữ cảnh (tên shop "Cửa Hàng ABC" ~ "cua hang abc").
const deburr = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * @param {string} x mật khẩu
 * @param {{shopName?: string}} [ctx] ngữ cảnh shop (khách): chặn mật khẩu chứa tên shop —
 *   điều auth seller không làm được (không có shop context). Đoạn tên shop ≥4 ký tự.
 * @returns {string|null} chuỗi lỗi tiếng Việt hoặc null nếu hợp lệ.
 */
export function passwordError(x, ctx = {}) {
  if (typeof x !== 'string' || x.length < 10 || x.length > 1024) return 'mật khẩu tối thiểu 10 ký tự';
  if (WEAK_PASSWORDS.has(x.trim().toLowerCase())) return 'mật khẩu quá phổ biến, hãy chọn mật khẩu khác';
  const shop = deburr(ctx.shopName).replace(/[^a-z0-9]+/g, '');
  if (shop.length >= 4 && deburr(x).includes(shop)) return 'mật khẩu không nên chứa tên cửa hàng';
  return null;
}

export { WEAK_PASSWORDS };
