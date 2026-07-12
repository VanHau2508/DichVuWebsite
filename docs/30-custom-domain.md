# Custom domain tự phục vụ (A5)

> **Kiểm chứng được:** `apps/seller/test/domains.e2e.mjs` (23/23 — add→challenge→DNS→verify→
> tls cấp cert→primary→revoke→chết + guard), `apps/seller-admin/test/admin-domains.e2e.mjs`
> (10/10 BFF), `scripts/verify-domains.sh` mutation 5/5. Đã vào CI.

## 1. Luồng

1. Owner (perm `domain.write` + step-up) thêm tên miền riêng ở admin (tab **Tên miền**).
2. Hệ trả **challenge**: thêm bản ghi `TXT _nentang-verify.<hostname> = <verification_token>`.
3. Owner tạo bản ghi DNS đó + trỏ A record về IP nền tảng (floating IP).
4. **Worker** (poller mỗi 60s, role `app_domainverify`) tra DNS TXT; KHỚP token → `verified_at=now()`.
5. `verified_at` bật → **tls-authorize** cấp cert (Caddy on-demand) + storefront/checkout phục vụ.
6. Đặt **tên miền chính** (chỉ khi verified) → host phụ **301** về chính (tránh trùng nội dung).
7. **Gỡ** (DELETE) → storefront/checkout ngừng phục vụ NGAY (đọc `verified_at` không cache).

## 2. Bảo mật

- **Sở hữu qua DNS TXT**: chỉ ai điều khiển DNS mới verify được → chống mint cert cho domain
  người khác. Worker so khớp `verification_token` CHÍNH XÁC (mutation `txtcheck` chứng minh).
- **isReserved**: chặn khách chiếm apex/subdomain nền tảng (`*.nentang.vn`) — cả ở seller (add)
  lẫn tls-authorize (defense-in-depth).
- **hostname UNIQUE toàn cục**: domain đã đăng ký (kể cả shop khác) → 409 (chỉ lộ "đã đăng ký").
- **Cô lập tenant**: `domains` có `shop_id` → RLS `tenant_isolation` (app_rw) — owner chỉ thấy/sửa
  domain shop mình.
- **Least-privilege worker**: role `app_domainverify` CHỈ đọc cột cần + GHI đúng `verified_at`,
  cross-shop (0027). Không đụng bảng/cột khác.

## 3. Endpoints (seller — mirror payment-config)

`GET /shops/:id/domains` (perm null) · `POST .../domains` (add) · `GET .../domains/:did` ·
`POST .../domains/:did/primary` · `DELETE .../domains/:did` (revoke) — mutate = `domain.write`+stepUp.

## 4. Ranh giới revoke (đã ghi nhận)

Gỡ domain → app-layer (storefront/checkout) ngừng phục vụ tức thì (đọc `verified_at` không cache).
tls-authorize positive-cache ≤5' cho việc CẤP cert mới, và **cert Caddy đã cấp còn phục vụ tới
khi hết hạn** (~90 ngày) — muốn cắt TLS tức thì phải xoá cert khỏi kho Caddy (ngoài phạm vi MVP).

## 5. Test hạ tầng

`apps/dns-stub` (CHỈ dev/e2e, KHÔNG có ở prod): UDP TXT responder + HTTP điều khiển, cho e2e
xác định (worker trỏ resolver vào stub qua `DOMAINVERIFY_RESOLVER`; prod để trống → DNS hệ thống).
Prod plumbing: role `app_domainverify` trong provision-db-roles.sh/deploy.sh/.env.example, worker
`DATABASE_URL_DOMAINVERIFY` trong compose.prod.
