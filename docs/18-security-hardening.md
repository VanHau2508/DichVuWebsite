# Security Hardening — Ngày 18

> **Trạng thái: ĐÃ CHẠY.**
> Rà soát đối kháng toàn hệ thống (5 phát hiện thô → 1 confirmed high, đã sửa).
> security-scan.sh: 0 phát hiện. Regression: mọi bộ e2e xanh từ cold start.

Ngày review + hardening: phần lớn bảo mật đã dựng ở các ngày trước, nên trọng tâm
là (a) rà soát đối kháng đa tác nhân toàn hệ thống, (b) bổ sung lớp cứng còn thiếu,
(c) sửa lỗ hổng tìm được.

## 1. Rà soát đối kháng (workflow 5 chiều → verify)

5 tác nhân review song song (authz, injection, headers/CSP, secrets/log, money/session)
→ thẩm định đối kháng từng phát hiện. **5 thô → 1 confirmed** (high confidence).

### Lỗ hổng THẬT đã sửa — shop đình chỉ vẫn thu tiền

**Phát hiện:** Dịch vụ checkout resolve shop từ `domains` nhưng **KHÔNG BAO GIỜ đọc
`shops.status`**. Policy RLS `checkout_shop` (0012, `status NOT IN suspended/terminated`)
là **code chết** vì checkout không hề SELECT từ `shops`. Storefront chặn suspended
bằng trang 503, nhưng Caddy route `/cart` `/checkout` thẳng tới dịch vụ checkout →
bỏ qua storefront.

**Khai thác:** Platform đình chỉ shop-A vì gian lận. Chủ shop-A gọi thẳng
`POST /cart/items` + `POST /checkout?payment_method=qr` trên domain của mình → đơn
'pending' được tạo, tồn kho reserve, server sinh **VietQR vào chính tài khoản ngân
hàng của shop-A**. Tiền khách vẫn chảy vào shop bị đình chỉ → vô hiệu hoá đòn bẩy
chính của việc đình chỉ (cắt doanh thu).

**Sửa** ([checkout/src/server.js](../apps/checkout/src/server.js)): thêm cổng trong
dispatcher — resolve shop → `SELECT 1 FROM shops WHERE id = current_shop_id()` dưới
`app_checkout`. Policy `checkout_shop` giờ **sống**: suspended/terminated → 0 row →
503 "cửa hàng tạm ngưng nhận đơn". e2e §11 chứng minh: đình chỉ → 503, khôi phục →
nhận đơn lại. Bài học: một policy RLS chỉ kích hoạt khi role ĐỌC bảng đó — policy
"đúng ý đồ" mà không có code đọc là vô dụng.

## 2. Dependency scan → nodemailer CVE (khai thác được)

`npm audit` phát hiện **nodemailer <=9.0.0 high severity** (nhiều CVE: CRLF injection
trong địa chỉ nhận, SMTP command injection, DoS addressparser). **Khai thác được
trong hệ thống này**: email người nhận đến từ `customer.email` lúc checkout — do
kẻ tấn công kiểm soát → CRLF trong email có thể tiêm SMTP command/header.

**Sửa kép:**
- Nâng nodemailer → `^9.0.3` (worker).
- **Validate email chặt tại checkout** (defense in depth): cấm CR/LF, đúng định
  dạng, ≤254 ký tự. Cấm CR/LF cả trong tên người nhận.

## 3. Lớp cứng bổ sung

- **CSP + X-Frame-Options trên storefront** (bề mặt HTML công khai, trước đây thiếu):
  `default-src 'none'; script-src (none); style-src 'self' 'unsafe-inline';
  img-src 'self' data' <media-origin>; frame-ancestors 'none'`. Lớp XSS thứ hai sau
  escape HTML. Storefront không dùng JS → chặn hoàn toàn script. e2e kiểm header.
- **Redact log PII**: worker không còn log địa chỉ email người nhận (chỉ topic +
  số đơn); auth không log email trong `dev_reset_token_stashed`.
- **security-scan.sh** ([scripts](../scripts/security-scan.sh)) — chạy CI mọi commit:
  1. Dependency scan (`npm audit --audit-level=high` mỗi service).
  2. Secret scan (hardcode ngoài env/dev).
  3. Log rò PII/token (soi payload log).
  4. Pattern nguy hiểm (eval/child_process/SQL nối chuỗi).
  5. File `.env`/secret lộ.

## 4. Đã rà, xác nhận SẠCH

Các lớp dựng ở ngày trước qua được rà soát đối kháng lần này (4 phát hiện thô bị
bác bỏ khi verify): RLS tenant isolation, SQL đều tham số hoá (chỉ LIMIT/OFFSET số
đã ép kiểu nội suy), XFF lấy phần tử phải, session/MFA/step-up, money flow
(giá server-side, idempotency, reserve nguyên tử), payment (chữ ký, replay, ràng
buộc tài khoản), media (magic byte, re-encode), escape/sanitize storefront, DB roles
tối thiểu (mỗi service một role, blast radius hẹp).

## 5. Còn thiếu (ngoài phạm vi Ngày 18)

- CI thật (GitHub Actions) chạy security-scan + test suite mọi commit.
- CSP báo cáo vi phạm (report-uri) + nonce cho admin (khi có Next.js).
- Xoay session token sau nâng quyền MFA (ASVS 3.3.1 — lệch chuẩn, không khai thác được).
- Rà soát định kỳ dependency (Dependabot).
