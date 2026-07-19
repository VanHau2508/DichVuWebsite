# 43 — Self-serve signup + tự động cấp phát shop (0091)

Người dùng TỰ đăng ký mở cửa hàng công khai (`nentang.vn/signup`) → hệ thống **tự cấp phát shop**
(shop + user owner + domain + trial subscription) mà **không cần** `platform_staff` gọi `POST /ops/shops`.
Đây là bước gỡ **nút thắt bán-ở-quy-mô** (~40% vận-hành-SaaS): trước đây mỗi shop mới cần một nhân sự
nền tảng tạo tay → chi phí thu hút khách tăng tuyến tính. Thiết kế qua workflow (recon 5 vùng mã thật +
red-team 4 lớp / 19 vector crit-high + blueprint). 4 commit.

## Kiến trúc

- **Service MỚI `apps/signup`** (SSR no-JS, CSP nghiêm, mẫu `apps/account`) — GLOBAL (không per-shop),
  chạy trên domain marketing. Vai DB MỚI **`app_signup`** least-priv (0091): chỉ 8 bảng provision cần,
  **KHÔNG** orders/products/customers/payments; `users` column-scope (KHÔNG đọc `password_hash`);
  `sessions` column-scope (KHÔNG đọc `token_hash`).
- **VERIFY-TRƯỚC-PROVISION** (bất biến chống spam): `POST /signup` **chỉ** ghi 1 nháp `shop_signups`
  (pending) + `token_hash` + outbox `signup.verify` (shop_id NULL). Shop/user THẬT **chỉ** sinh khi
  verify email → bot POST không đẻ shop bán-được.
- **Provision NGUYÊN TỬ 1-tx** (không saga xuyên-service): khi verify, `app_signup` ghi user + shop +
  domain + subscription + membership owner + audit trong MỘT transaction → không bao giờ shop mồ côi.
  Bù trừ duy nhất = worker sweep dọn nháp treo.
- **Subdomain sống ngay:** cert `*.nentang.vn` là wildcard DNS-01 **sẵn có** → `<slug>.nentang.vn`
  có TLS liền, không cần cấp cert per-shop. Caddy `nentang.vn/signup*` → service signup.

## Luồng

```
GET  /signup            → form no-JS (chọn tên/slug/email/mật khẩu/gói) + form-ts HMAC
POST /signup            → ghi NHÁP + email verify (KHÔNG provision). Trả trang "kiểm tra email" trung tính.
GET  /signup/verify?token=  → trang XÁC NHẬN (KHÔNG side-effect — chống prefetch/quét-link email)
POST /signup/verify     → CLAIM-FIRST atomic + provision shop hoàn chỉnh. KHÔNG auto-login.
GET  /signup/check-slug?slug=  → nhị phân available/unavailable (rate-limit riêng)
```

## Chống lạm dụng + bảo mật (bịt 19 vector red-team)

- **ENUM-SAFE:** `POST /signup` LUÔN trả trang trung tính (email mới / đã tồn tại GIỐNG nhau, vẫn tạo
  nháp — không rẽ nhánh). Chỉ lỗi CLIENT-DERIVABLE (định dạng slug/email/mật khẩu/gói, slug bận-công-khai)
  mới surface. Hash Argon2 VÔ ĐIỀU KIỆN (sàn timing).
- **Nuốt im lặng** (trung tính, không nháp): honeypot (`website`) · form-ts HMAC < 2s · email
  dùng-một-lần (denylist) · vượt trần Redis.
- **Trần per-IP ĐẾM DƯỚI `pg_advisory_xact_lock`** — SÀN độc lập Redis (chống xoay-IP + Redis-fail-open).
  Reserve slug advisory-lock CÙNG KEY `signup-slug:` ở cả draft lẫn provision + UNIQUE partial index
  `shop_signups(lower(slug)) WHERE pending`. Thứ tự lock ip→slug nhất quán (không deadlock).
- **Denylist app-layer:** slug trùng subdomain hạ tầng (www/admin/api/auth/payment…) + brand bảo lưu
  (shopee/momo/haravan…) → chống cướp route + mạo danh. `ip_hash` HMAC (không lưu IP thô).
- **Verify = POST** (GET no-side-effect) + `sameOrigin` + form-ts HMAC → prefetch/quét-link email
  (SafeLinks/AV/Gmail) & CSRF không provision. **CLAIM-FIRST** (UPDATE pending→provisioned RETURNING,
  0 dòng → trung tính) → 2 verify SONG SONG chỉ 1 thắng. Token 1-LẦN. Tx fail → status hoàn nguyên.
- **OWNER = user nội sinh 3-nhánh** (mẫu `acceptInvitation` 0020): (a) email mới → tạo user verified;
  (b) user CHƯA-verify → CLAIM (đặt lại hash + thu hồi phiên); (c) user ĐÃ-verify → 403 login_required
  (self-serve KHÔNG phiên → KHÔNG bind mù → chống chiếm tài khoản). `shop_id`/`user_id` LUÔN
  server-derived (RETURNING/nội sinh), KHÔNG từ body. Membership policy CHECK(role='owner') → không tự
  cấp admin. KHÔNG auto-login sau provision (parity `resetPassword`).
- **Guard trial free vĩnh viễn** (tái lỗi 0056): CHECK `subscriptions` trial phải có `current_period_end`
  → cưỡng chế cả 2 đường tạo shop (staff + self-serve).

## Cổng bán hàng (quyết định v1)

Shop self-serve sau verify → `status='onboarding'` → **bán được NGAY** (checkout không loại onboarding).
Chọn phương án ít-ma-sát cho thị trường COD-first VN (bắt cắm bank trước sẽ chặn shop chỉ-COD, đa số),
dựa vào lớp **chống-đơn-ảo 3 tầng** đã có (docs/34) + cờ `shops.created_via='self_serve'` để giám sát.
SMS OTP / cổng-cắm-thanh-toán-bắt-buộc để v2 nếu thấy lạm dụng.

## Migration 0091

`shop_signups` (nháp: email/password_hash/slug/name/plan_code FK/token_hash UNIQUE/ip_hash/status/
expires_at) + UNIQUE partial pending + sweep index. Vai `app_signup` (grant hẹp 8 bảng + column-scope
users/sessions) + policies FORCE-RLS (membership owner / audit system / outbox shop_id NULL) +
REVOKE app_rw (chống leo thang bảng global) + CHECK trial period-end. `shops +created_via`.

## Worker (signup-4)

- Topic outbox `signup.verify` → email "Kích hoạt cửa hàng" (cấp nền tảng, shop_id NULL — mẫu
  `user.password_reset` 0058).
- `sweepSignups()` (vai `app_signup`, pool `DATABASE_URL_SIGNUP`): nháp pending quá hạn → `expired`
  (giải phóng slug qua UNIQUE partial) + xoá `expired` cũ > 24h. `/internal/signup-sweep` cho cron/e2e.

## Cấu hình prod

`APP_SIGNUP_PASSWORD` (secret), `SIGNUP_FORM_SECRET` (HMAC form-ts), `IP_PEPPER` (dùng chung
`ORDER_HASH_PEPPER`), `PLATFORM_DOMAIN`, `TRIAL_DAYS`. Caddy `nentang.vn/signup*` → `signup:3064`.
Gói: khách chọn 1 trong 3 (`plans` active) lúc đăng ký. **Lưu ý:** `compose.prod.yml` còn thiếu
service `account`/`loyalty` (chưa push) — cần cập nhật cùng đợt deploy self-serve.

## Test

- `packages/db/test/signup-rls.test.js` (11) — least-priv + column-scope + policies + reserve slug +
  guard trial + chuỗi provision dưới RLS.
- `apps/signup/test/signup-draft.e2e.mjs` (11) — form/CSP + nháp-không-provision + enum-safe + nuốt
  honeypot/timing/disposable + surface denylist/taken/format + check-slug + trần-IP.
- `apps/signup/test/verify-provision.e2e.mjs` (8) — chuỗi đầy đủ + user verified + KHÔNG cookie +
  GET no-side-effect + token 1-lần + double-verify→1 shop + nhánh b/c + CSRF.
- `apps/worker/test/signup-sweep.e2e.mjs` (5) — email verify tới Mailpit + sweep expired→giải-phóng-slug
  + giữ nháp còn hạn.
