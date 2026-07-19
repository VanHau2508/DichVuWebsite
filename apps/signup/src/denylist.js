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
export function isSlugDenied(slug) {
  const s = String(slug ?? '').toLowerCase();
  if (RESERVED.has(s)) return true;
  return BRANDS.some((b) => s.includes(b));
}

/** email domain dùng-một-lần → nuốt im lặng (không tạo nháp, trả trang trung tính). */
export function isDisposableEmail(email) {
  const at = String(email ?? '').toLowerCase().lastIndexOf('@');
  if (at < 0) return false;
  return DISPOSABLE.has(email.toLowerCase().slice(at + 1));
}
