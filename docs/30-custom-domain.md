# Custom domain tự phục vụ (A5)

> **Kiểm chứng được:** `apps/seller/test/domains.e2e.mjs` (36/36 — add→challenge→DNS→verify→
> tls cấp cert→primary→revoke→chết + guard + chẩn đoán "Kiểm tra ngay"),
> `apps/seller-admin/test/admin-domains.e2e.mjs` (16/16 BFF), `scripts/verify-domains.sh`
> mutation 5/5. Đã vào CI.

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
`POST .../domains/:did/check` (perm null, KHÔNG step-up) — chẩn đoán DNS, xem §3b.

## 3b. Làm cho khách TỰ LÀM ĐƯỢC — `PLATFORM_IP` + "Kiểm tra ngay"

Bước 3 ở §1 ("trỏ A về IP nền tảng") từng là **ngõ cụt**: màn hình chỉ hiện bản ghi TXT, nói
"trỏ về IP nền tảng" mà KHÔNG chỗ nào trong sản phẩm nói IP đó là số mấy — `PLATFORM_IP` không
tồn tại trong mã nguồn. Đặt xong rồi thì màn hình im lặng chờ; đặt sai một bản ghi là khách
ngồi đoán. Cả hai đều dẫn về một chỗ: nhắn cho shop, shop nhắn cho nền tảng.

- **`PLATFORM_IP`** (env của service `seller`) — IP CÔNG KHAI để khách trỏ bản ghi A về. Prod =
  **floating IP** (ADR-004), vì đổi IP là bắt MỌI khách sửa lại DNS. Bắt buộc ở prod
  (`${PLATFORM_IP:?}`); thiếu thì trang hạ cấp thành "chưa cấu hình — báo bộ phận hỗ trợ".
  API `GET .../domains` trả kèm `platform_ip`; màn hình hiện **cả hai** bản ghi A và TXT.
- **`POST .../domains/:did/check`** — tra DNS **CHỈ ĐỌC**, trả `{a, txt, message}` nói rõ đang
  sai chỗ nào: *"Tên miền đang trỏ về 103.1.2.3 — cần trỏ về 14.5.6.7"*, phân biệt "chưa có TXT"
  với "TXT có nhưng sai giá trị". Trần 10 lần/phút/shop (mỗi lần bấm là một truy vấn DNS ra ngoài).
- **Không tự đóng dấu `verified_at`.** Nút này chẩn đoán, worker mới lật cờ (≤60s). Cấp cho
  `app_rw` quyền ghi `verified_at` để tiết kiệm một phút chờ là mất nhiều hơn được.
- **Bẫy đã vấp:** dùng `Resolver` của `node:dns` (API callback) thì `await r.resolve4(h)` ném
  `ERR_INVALID_ARG_TYPE` chứ không tra DNS — rơi vào `catch` và MỌI lần kiểm tra đều báo "chưa
  tra được DNS". Phải là `node:dns/promises` (worker vốn đã đúng). e2e mới bắt được; `node --check`
  và mắt thường thì không.

## 4. Ranh giới revoke (đã ghi nhận)

Gỡ domain → app-layer (storefront/checkout) ngừng phục vụ tức thì (đọc `verified_at` không cache).
tls-authorize positive-cache ≤5' cho việc CẤP cert mới, và **cert Caddy đã cấp còn phục vụ tới
khi hết hạn** (~90 ngày) — muốn cắt TLS tức thì phải xoá cert khỏi kho Caddy (ngoài phạm vi MVP).

## 5. Test hạ tầng

`apps/dns-stub` (CHỈ dev/e2e, KHÔNG có ở prod): UDP responder **TXT + A** + HTTP điều khiển
(`POST /set {name, txt?, a?}`), cho e2e xác định (worker VÀ seller trỏ resolver vào stub qua
`DOMAINVERIFY_RESOLVER`; prod để trống → DNS hệ thống). Bản ghi A thêm vào stub cùng đợt
"Kiểm tra ngay": không dựng được A thì nhánh "đang trỏ sai IP" không bao giờ được kiểm.
Prod plumbing: role `app_domainverify` trong provision-db-roles.sh/deploy.sh/.env.example, worker
`DATABASE_URL_DOMAINVERIFY` trong compose.prod.
