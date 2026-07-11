# Admin web nhà bán hàng (giai đoạn UI — phần 2): login + MFA + quản đơn

> **Trạng thái: ĐÃ CHẠY.** admin-flow e2e **22/22** (đăng nhập có/không MFA, guard phiên
> nửa vời, cô lập chéo shop, CSRF, vòng đời đơn confirm→ship→deliver + cancel + chuyển sai).
> Mutation `verify-admin` 3/3 (bỏ kiểm Origin → e2e đỏ). Rà soát đối kháng (auth/session/
> csrf/xss/ss-rf/dos): xác nhận CSRF/redirect/SSRF/header-injection đều đứng; sửa 1 MED
> (2 chỗ nội suy thô `order_number`/`qty` trong chi tiết đơn → `esc`) + 1 LOW (thủ đơn thiếu
> `orders`/`lines` → mặc định `[]` thay vì 500). Không hồi quy stack.

Giao diện quản trị cho **nhà bán hàng** (khác admin sàn `ops`). Phần này làm phần XƯƠNG SỐNG
vận hành: đăng nhập an toàn (có MFA) và **quản đơn** (xác nhận → giao → hoàn tất, huỷ). Đây là
thứ nhà bán hàng chạm hằng ngày sau khi buyer đặt được đơn (Ngày trước).

## 1. Kiến trúc: BFF (Backend-For-Frontend), SSR form thuần

`seller-admin` (cổng 3001) là **một service riêng**, KHÔNG đụng DB. Nó:
- Nhận request trình duyệt tại `admin.nentang.vn` (Caddy → `seller-admin:3001`).
- **Cầm cookie `__Host-session` của trình duyệt**, gọi NỘI BỘ `auth` / `seller` / `platform`
  (forward cookie + chèn `Origin` admin), rồi render HTML.
- Mọi RBAC / cô lập tenant (RLS) / step-up **do backend lo** — BFF chỉ là lớp trình bày.

Vì sao BFF chứ không cho trình duyệt gọi thẳng API:
- **Một origin duy nhất** (`admin.nentang.vn`) cho cả UI lẫn "API" → cookie `__Host-` +
  `SameSite` gọn, không CORS, không lộ topology service ra ngoài.
- Giữ **SSR form thuần + CSP nghiêm** (`default-src 'none'`, không script) — chống XSS mạnh
  nhất, chạy trên mọi máy/mạng. Cùng ethos plain-Node như buyer UI (docs/24).

```
Trình duyệt ──HTTPS──> Caddy(admin.nentang.vn) ──> seller-admin:3001
                                                      │  (forward __Host-session
                                                      │   + Origin: admin)
                                          ┌───────────┼───────────┐
                                        auth:3020  seller:3040  platform:3030
```

## 2. Ranh giới bảo mật: BFF gác đúng MỘT thứ — CSRF

Điểm mấu chốt: BFF **tự chèn `Origin` admin vào MỌI request nội bộ**. Nên backend luôn thấy
Origin hợp lệ — nghĩa là **thứ duy nhất chặn một POST cross-site chạm tới backend là kiểm
`sameOrigin` của chính BFF** (`src/http.js`). Đó là lằn ranh BFF sở hữu.

- **CSRF**: mọi POST đổi trạng thái phải có `Origin` thuộc allowlist (`ALLOWED_ORIGINS`).
  GET/HEAD → true (KHÔNG có GET đổi trạng thái). `verify-admin.sh` chứng minh: bỏ kiểm này →
  e2e đỏ ngay.
- **Cô lập chéo shop** (`isMember`) và **guard phiên** (anon→/login, nửa vời→/mfa): BFF có
  gác cho UX, nhưng đây là **phòng thủ theo chiều sâu** — `seller` (RLS + RBAC) và `auth`
  (`/auth/me` từ chối phiên nửa vời) mới là ranh giới thật, đã có `verify-seller`/`verify-auth`.

## 3. Luồng đăng nhập (bao gồm MFA / step-up)

```
GET /login (form email+mật khẩu)
  --POST /login--> auth /auth/login
      ├─ không MFA → 303 / (relay cookie phiên đầy đủ)
      └─ có MFA     → 303 /mfa (relay cookie phiên NỬA VỜI, sống ngắn)
GET /mfa (form mã 6 số)
  --POST /mfa--> auth /auth/mfa/verify (forward cookie nửa vời)
      └─ đúng → nâng phiên tại chỗ thành đầy đủ → 303 /
Mọi trang bảo vệ: loadSession() gọi /auth/me
  200 → ok (me + memberships) | 401 mfa_required → /mfa | còn lại → /login
POST /logout → auth /auth/logout (thu hồi phía server) + xoá cookie (Max-Age=0) → /login
```

BFF **relay `Set-Cookie` verbatim** từ auth (login/mfa) về trình duyệt — không tự phát hành
phiên, không đổi token. Phiên nửa vời KHÔNG bao giờ vào được dashboard (`/auth/me` trả 401).

## 4. Quản đơn (form PRG — Post/Redirect/Get)

- `GET /shops/:id/orders` — danh sách + lọc trạng thái (GET form) + phân trang (`limit=20`).
- `GET /shops/:id/orders/:oid` — chi tiết: dòng hàng, khách, vận đơn + **form thao tác** đúng
  theo trạng thái hiện tại.
- `POST /shops/:id/orders/:oid/{confirm|ship|cancel|deliver}` → gọi `seller`, **303 về chi tiết**
  (PRG: F5 không gửi lại). `ship` kèm `tracking_number` (+ `carrier`). Lỗi backend
  (409 sai trạng thái / 403 / 400) → render lại chi tiết kèm thông báo, KHÔNG nuốt lỗi.

State machine (do `seller` giữ, BFF chỉ hiện nút hợp lệ):
`pending → confirmed → shipped → delivered`; huỷ từ `pending|confirmed`. `ship` tiêu tồn
(on_hand−), `cancel` nhả reserve — logic đó ở `apps/seller/src/orders.js`, không lặp ở BFF.

## 5. Header / CSP

`http.js` đặt trên MỌI phản hồi: `Content-Security-Policy: default-src 'none'; style-src
'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors
'none'`, `Cache-Control: no-store` (có PII đơn hàng), `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`.

⚠️ **Caddy edge cũng đặt CSP cho `admin.nentang.vn`** → trình duyệt áp **GIAO** hai policy.
Đã chỉnh `infra/caddy/Caddyfile` khớp cái app cần (style-src `unsafe-inline`, img `data:`),
nếu không CSS nội tuyến bị chặn ở prod (trang trắng). Dev (`Caddyfile.dev`) không đặt CSP ở
edge → app là nguồn duy nhất.

## 6. File

```
apps/seller-admin/
  src/http.js     esc, cookie, sendHtml (CSP), redirect(303), readForm, sameOrigin (CSRF)
  src/api.js      call() → forward cookie + Origin admin; authApi/sellerApi/platformApi; loadSession
  src/pages.js    layout + renderLogin/Mfa/Dashboard/Orders/OrderDetail/Error (esc mọi giá trị động)
  src/server.js   router + handler: login/mfa/logout, dashboard, orders list/detail, order actions
  test/admin-flow.e2e.mjs   22 kiểm
  Dockerfile      node pinned digest, non-root, healthcheck /healthz
scripts/verify-admin.sh     mutation: bỏ kiểm Origin → e2e đỏ
infra/compose.dev.yml       service seller-admin (:3001) + route Caddyfile.dev admin.localtest
infra/compose.prod.yml      service seller-admin (mem 160m) + Caddyfile admin.nentang.vn
```

## 7. Chạy

```bash
docker compose -f infra/compose.dev.yml up -d --build
docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-flow.e2e.mjs
bash scripts/verify-admin.sh
```

## 8. Còn lại (fast-follow)

- Màn quản **sản phẩm / tồn kho / trang nội dung** trên admin (backend đã có, chỉ thiếu UI).
- Mời nhân sự shop (invitations) + đổi mật khẩu / bật MFA từ trong admin.
- Đếm giỏ / ảnh sản phẩm ở buyer UI (docs/24 §8).
