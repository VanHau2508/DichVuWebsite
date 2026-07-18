# 39 — Tài khoản khách hàng storefront (0083)

Khách ĐĂNG KÝ/ĐĂNG NHẬP trên trang shop (per-shop, kiểu Shopify customer accounts), xem
LỊCH SỬ ĐƠN, quản lý SỔ ĐỊA CHỈ (điền nhanh khi checkout). KHÁC HẲN auth seller (người bán/
nhân viên nền tảng). Thiết kế qua workflow 7 agent + 3 red-team; 4 must-fix đã áp.

## Kiến trúc (1 service = 1 role)

- **Service MỚI `apps/account`** (no-framework, no-JS SSR, port 3062) mount `/account/*` trên
  CHÍNH host shop qua Caddy → cookie `__Host-cust_session` chia sẻ với storefront + checkout.
- **Role MỚI `app_customer`** (least-priv) host mọi customer WRITE. **`app_store` GIỮ CHỈ-ĐỌC**
  (không cấp gì) — bề mặt công khai nhất không cầm credential ghi được password_hash.
  `app_checkout` chỉ thêm SELECT-theo-CỘT (KHÔNG password_hash) để prefill + stamp customer_id.
- Bảng: `customers`, `customer_sessions`, `customer_addresses`, `customer_password_reset_tokens`,
  `customer_email_verifications` + `orders.customer_id`. RLS FORCE + composite FK (shop_id,
  customer_id). Email UNIQUE THEO SHOP (cùng email 2 shop = 2 tài khoản độc lập).

## Bảo mật (4 must-fix red-team, verify trên PG16)

1. **"Nhận đơn cũ" gate bằng GUC `app.claim_token_hash`**: SELECT policy chỉ hiện đơn vãng lai
   có `lookup_token_hash` khớp mã 256-bit khách nhập → không rò PII đơn khách khác (blind UPDATE
   cũ trả 0, fix ngây thơ `OR customer_id IS NULL` rò hàng loạt — đều tránh).
2. **customers + customer_sessions SELF-scoped**: `USING (shop_id=cur AND (current_customer_id()
   IS NULL OR id=current_customer_id()))` — pre-auth login tra được email, post-auth khách A
   KHÔNG ghi đè mật khẩu khách B (chống ATO đồng tenant).
3. **Đăng ký ENUM-SAFE + KHÔNG auto-login**: email mới/đã-tồn-tại → trang trung tính Y HỆT,
   không set cookie → không rò email nào đã đăng ký.
4. **app_rw KHÔNG đọc/ghi password_hash** (siết cột mẫu 0075) — SQLi seller không thành ATO khách.

Khác: password Argon2id (packages/auth); login verifyPassword LUÔN chạy (DUMMY_HASH → timing
enum-safe); rate-limit key-CÓ-shop (login ip+acctfail, register, forgot, claim); cookie
`__Host-cust_session` TÊN KHÁC seller/cart, SameSite=Lax, host-scoped (shop-a không tới shop-b);
token reset/verify DÙNG-MỘT-LẦN atomic, reset THU HỒI MỌI phiên; CSP nghiêm + no-referrer trang
token; loadCustomer đòi status='active'; đọc PII (địa chỉ/đơn) RLS 2 trục shop+customer (chống
IDOR dù handler quên WHERE).

## Chống account-takeover đơn ẩn danh

TUYỆT ĐỐI KHÔNG auto-link đơn cũ theo email (email lúc đặt là text chưa xác minh). Lịch sử đơn
= đơn đặt-SAU-đăng-nhập (checkout stamp customer_id) HOẶC đơn khách tự "nhận" bằng lookup_token
(bí mật 256-bit = bằng chứng sở hữu). Xác minh email MỀM (login chạy khi chưa verify — an toàn
vì không auto-link); chủ email thật giành lại tài khoản bị squat qua Quên-mật-khẩu.

## PII (Luật BVDLCN 91/2025)

Seller erase-theo-SĐT (owner+step-up) ẩn danh CẢ tài khoản khớp: `status='anonymized'` +
email/full_name/phone NULL + xoá customer_addresses + revoke customer_sessions. password_hash
còn (app_rw không chạm — Argon2 salted, vô hại; status chặn login); worker app_expiry xoá nốt.

## Cắt v1 → v2

OAuth/social · passwordless-OTP · MFA khách · self-serve xoá-tài-khoản (qua seller) ·
single-identity chéo-shop (cố ý per-store) · merge-cart/wishlist/loyalty · đổi mật khẩu trong
tài khoản (đã đăng nhập) · worker sweepCustomerPii tự động (dựa erase-thủ-công + retention v2).
