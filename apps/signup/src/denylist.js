/**
 * Denylist self-serve (0091 signup) — áp Ở APP-LAYER (không ở DB) vì là chính-sách, đổi thường.
 *  - RESERVED: slug trùng subdomain hạ tầng → chiếm được = cướp route/mạo danh nền tảng.
 *  - BRAND: thương hiệu bảo lưu → chặn cứng (v1) tránh shop mạo danh (shopee-official…).
 *  - DISPOSABLE: domain email dùng-một-lần → nuốt im lặng (chống farm trial free-tier).
 * Danh sách TỐI THIỂU, mở rộng qua commit sau. So khớp đã unaccent/lowercase ở gọi.
 */

// Subdomain hạ tầng + trang hệ thống (khớp nhãn Caddy + service). Chiếm = cướp định tuyến.
const RESERVED = new Set([
  'www', 'admin', 'api', 'app', 'apps', 'auth', 'account', 'accounts', 'signup', 'signin', 'login',
  'hooks', 'webhook', 'webhooks', 'cdn', 'static', 'assets', 'media', 'img', 'images', 'files',
  'mail', 'email', 'smtp', 'imap', 'ns', 'ns1', 'ns2', 'dns', 'mx', 'ftp', 'ssh', 'vpn',
  'payment', 'payments', 'pay', 'checkout', 'cart', 'billing', 'invoice', 'invoices',
  'seller', 'sellers', 'platform', 'ops', 'dashboard', 'console', 'panel', 'manage', 'manager',
  'blog', 'help', 'support', 'docs', 'status', 'health', 'test', 'staging', 'dev', 'demo',
  'store', 'shop', 'shops', 'my', 'go', 'about', 'contact', 'legal', 'privacy', 'terms',
  'nentang', 'root', 'system', 'internal', 'security', 'abuse', 'noc', 'sales',
]);

// Thương hiệu bảo lưu — v1 CHẶN CỨNG nếu slug CHỨA (chống mạo danh). Mở rộng dần.
const BRANDS = [
  'shopee', 'lazada', 'tiki', 'sendo', 'grab', 'shopeefood', 'baemin', 'gojek', 'be',
  'vincom', 'vinmart', 'winmart', 'bachhoaxanh', 'thegioididong', 'dienmayxanh', 'fptshop',
  'facebook', 'google', 'apple', 'samsung', 'zalo', 'tiktok', 'instagram', 'youtube',
  'vietcombank', 'techcombank', 'momo', 'zalopay', 'vnpay', 'napas', 'mbbank', 'bidv', 'agribank',
  'haravan', 'sapo', 'kiotviet', 'nhanh', 'pancake', 'nentang',
];

// Domain email dùng-một-lần phổ biến (farm trial). Nuốt im lặng khi trùng.
const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.info', 'sharklasers.com', '10minutemail.com',
  '10minutemail.net', 'yopmail.com', 'tempmail.com', 'temp-mail.org', 'throwawaymail.com', 'getnada.com',
  'trashmail.com', 'maildrop.cc', 'dispostable.com', 'fakeinbox.com', 'mohmal.com', 'emailondeck.com',
  'mailnesia.com', 'mytemp.email', 'tempinbox.com', 'spamgourmet.com', 'burnermail.io', 'moakt.com',
]);

/** slug đã bị dành riêng / mạo danh brand → không cho tạo (áp cả /signup lẫn check-slug). */
/**
 * Chuỗi vừa là thương hiệu vừa là TỪ THÔNG DỤNG → chỉ chặn khi trùng TRỌN slug, không chặn
 * khi nằm lẫn bên trong. Danh sách này là các ca ≥6 ký tự cần miễn trừ; các chuỗi <6 ký tự
 * đã tự động chỉ-khớp-trọn theo quy tắc bên dưới.
 */
const AMBIGUOUS = new Set(['pancake']); // bánh pancake là món, không phải chỉ tên phần mềm

/**
 * Slug có bị cấm không.
 *
 * KHỚP TRỌN với mọi thương hiệu; khớp CHUỖI CON chỉ với thương hiệu dài (≥6) và không nằm
 * trong AMBIGUOUS.
 *
 * Bản đầu khớp chuỗi con với TẤT CẢ, kể cả 'be' (2 ký tự) và 'nhanh'. Hậu quả đo được:
 *   me-va-be · do-choi-cho-be · be-yeu-shop · bepgiadinh · banh-beo-co-ba   ← đều CHẶN
 *   giao-hang-nhanh · ship-nhanh-24h · an-nhanh · sapoche-vuon              ← đều CHẶN
 * Tức là chặn gần trọn ngành hàng MẸ & BÉ, mọi shop có chữ "nhanh", và cả tiệm bánh
 * pancake — bằng đúng một câu "Địa chỉ này không sử dụng được" không giải thích gì. Người
 * bán thử hai ba tên rồi bỏ đi, và ta không bao giờ biết đã mất ai.
 *
 * ĐÁNH ĐỔI CÓ CHỦ Ý: 'tiki-store' hay 'grab-food' nay lọt qua. Chấp nhận, vì hai loại sai
 * KHÔNG cân nhau — kẻ chiếm tên thì ta thấy được và có sẵn đường tạm khoá shop (một thao tác
 * tay), còn người bán thật bị chặn thì im lặng rời đi và không để lại dấu vết nào.
 *
 * Cũng chính chuỗi 'be' làm bộ e2e verify-provision đỏ ~1/24 lượt: slug ngẫu nhiên 8 ký tự
 * trúng 'be' với xác suất ~0,54%, kỳ vọng ~1 lần trong 192 nháp — đo được đúng 1.
 */
export function isSlugDenied(slug) {
  const s = String(slug ?? '').toLowerCase();
  if (RESERVED.has(s)) return true;
  return BRANDS.some((b) => s === b || (b.length >= 6 && !AMBIGUOUS.has(b) && s.includes(b)));
}

/** email domain dùng-một-lần → nuốt im lặng (không tạo nháp, trả trang trung tính). */
export function isDisposableEmail(email) {
  const at = String(email ?? '').toLowerCase().lastIndexOf('@');
  if (at < 0) return false;
  return DISPOSABLE.has(email.toLowerCase().slice(at + 1));
}
