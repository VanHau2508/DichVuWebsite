# Admin web nhà bán hàng (giai đoạn UI — phần 2): login + MFA + quản đơn + sản phẩm

> **Trạng thái: ĐÃ CHẠY.** admin-flow e2e **22/22** (đăng nhập có/không MFA, guard phiên
> nửa vời, cô lập chéo shop, CSRF, vòng đời đơn confirm→ship→deliver + cancel + chuyển sai);
> admin-products e2e **19/19** (tạo→sửa→đăng bán→điều chỉnh tồn→thêm/xoá biến thể→lưu trữ→xoá,
> chặn tồn âm, chặn xoá biến thể cuối, giữ input khi sửa lỗi, cô lập chéo shop, CSRF);
> admin-media e2e **9/9** (upload multipart→re-encode WebP, hiện/xoá ảnh, chặn file giả dạng ảnh,
> ảnh >10MB → trang lỗi thân thiện, CSRF, cô lập chéo shop); admin-content e2e **18/18** (tạo
> trang→5 loại section→sửa/↑↓/xoá→meta→đăng/khôi phục revision→xem trước→xoá, cô lập, CSRF).
> admin-account e2e **17/17** (bật MFA: enroll→activate, mã sai chặn, mã khôi phục; nhân sự:
> mời/đổi vai trò/gỡ qua **step-up** interstitial, sai mật khẩu chặn, guard owner cuối, CSRF,
> cô lập). Mutation `verify-admin` 3/3
> (bỏ kiểm Origin → e2e đỏ). Rà soát đối kháng (auth/session/csrf/xss/ss-rf/dos): CSRF/redirect/
> SSRF/header-injection đều đứng; sửa 1 MED (nội suy thô `order_number`/`qty` → `esc`) + 1 LOW
> (thiếu `orders`/`lines` → `[]` thay vì 500). Không hồi quy stack.

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

## 4b. Quản sản phẩm & tồn kho (form PRG)

- `GET /shops/:id/products` — danh sách + tìm theo tên (`q`) + lọc trạng thái + phân trang.
- `GET /shops/:id/products/new` + `POST /shops/:id/products` — tạo sản phẩm (tên/slug/giá/
  trạng thái/mô tả + 1 biến thể đầu). BFF gộp form thành body JSON `seller` mong đợi.
- `GET /shops/:id/products/:pid` — chi tiết: sửa thông tin (**POST → PATCH** `seller`),
  đăng bán/lưu trữ, bảng biến thể + **điều chỉnh tồn tại chỗ**, thêm/xoá biến thể, xoá SP.
- `POST .../variants/:vid/inventory` — điều chỉnh tồn (`delta` âm/dương + lý do) →
  `seller /inventory/adjust`. Tồn kho tách khỏi payload SP nên chi tiết fetch mức tồn từng
  biến thể **song song** rồi ghép.

Trạng thái SP `draft → active → archived` (nút Đăng bán / Ẩn / Đăng bán lại). Bất biến do
`seller` giữ: giá ≥ 0, slug/SKU duy nhất trong shop, SP luôn ≥ 1 biến thể (không xoá biến thể
cuối), tồn không âm/không dưới mức đang giữ chỗ — BFF chỉ forward + hiện lỗi.

Điều hướng: tab **Đơn hàng | Sản phẩm** trong mỗi shop, ẩn/hiện theo vai trò
(`owner`/`admin` thấy cả hai; `catalog_manager` chỉ Sản phẩm; `order_manager` chỉ Đơn hàng) —
`seller` mới là nơi cưỡng chế quyền `catalog.*`/`orders.*`.

## 4c. Ảnh sản phẩm (upload, KHÔNG JS)

Thử thách: endpoint media của `seller` nhận **byte ảnh THÔ** làm body (sniff magic byte,
re-encode WebP), còn `<form>` HTML gửi **multipart/form-data**. Không có JS để PUT presigned.
Giải: BFF tự **bóc file khỏi multipart** (`readMultipartFile` trong `http.js`, parser nhị phân
thuần bằng `Buffer.indexOf` trên boundary — không thêm dependency) rồi **forward byte thô**
tới `seller` (`sellerUpload`, timeout 30s vì sharp re-encode).

- `POST /shops/:id/products/:pid/media` — form file (JPEG/PNG/WebP/GIF ≤10MB) → 303 chi tiết.
- `POST /shops/:id/products/:pid/media/:mediaId/delete` — xoá ảnh → 303.
- Chi tiết SP fetch danh sách ảnh **song song** với tồn kho; hiện lưới thumbnail + form upload.
- Bảo mật ảnh do `seller` giữ: **sniff magic byte** (không tin Content-Type), bản gốc vào
  bucket PRIVATE, **re-encode WebP strip payload**, chỉ WebP sạch mới lên bucket PUBLIC.
- **Thứ tự + ảnh đại diện** (0023 `media.position`): ← → đổi thứ tự, ★ đặt ảnh chính (đưa lên
  đầu) — không JS, gọi `POST .../media/reorder` (backend đòi **hoán vị đúng** tập id).
  Ảnh `position` nhỏ nhất = đại diện → storefront lấy cho lưới; trang SP hiện theo thứ tự.

⚠️ **CSP img-src**: ảnh phục vụ từ `MEDIA_PUBLIC_BASE` (CDN) → thêm origin đó vào `img-src`
của app (`http.js`) **và** của edge (`Caddyfile`, `https://cdn.nentang.vn`) — phải khớp vì
trình duyệt áp GIAO. Dev dùng `http://minio:9000` (chỉ tải được trong Docker, không từ host).

## 4d. Trang nội dung (CMS có phiên bản, KHÔNG JS)

Mô hình versioned: `pages.blocks` = **DRAFT** (sửa tự do) → **publish** snapshot vào
`page_revisions` (bản #N+1) + trỏ `published_revision_id`; storefront chỉ render bản đã đăng;
**rollback** = trỏ published về revision cũ (không đụng draft). Section là **text-only, typed**
(tiêu đề / đoạn / danh sách / trích dẫn / đường kẻ) — storefront escape khi render.

- `GET /pages` danh sách · `GET /pages/new` + `POST /pages` tạo (nháp) · `GET /pages/:id`
  trình sửa · `POST /pages/:id` lưu meta (**→ PATCH** title/menu/SEO; slug bất biến).
- **Section**: `POST .../blocks` thêm · `POST .../blocks/:bid/edit` (**→ PATCH**) sửa ·
  `POST .../blocks/:bid/delete` xoá · **kéo–thả bằng ↑/↓**: `POST .../blocks/:bid/moveup|movedown`
  → BFF lấy page, hoán vị 2 id trong mảng order, gọi endpoint `reorder` (backend đòi order
  là **hoán vị đúng** của tập id hiện có → không lén thêm/bớt block).
- `POST .../publish` đăng · `POST .../rollback` {revision} khôi phục · `POST .../preview`
  tạo link xem trước (token sống ~30 phút) — **render trực tiếp** (không redirect) để hiện link
  chứa token; trang admin `no-referrer` nên token không rò qua Referer.
- `blockBody(form)`: gộp form → block theo type (list: mỗi dòng 1 mục; divider: không field).
- Chỉ `owner`/`admin` thấy tab **Trang nội dung** (`content.*`) — `seller` cưỡng chế quyền.

## 4e. Tài khoản (bảo mật) + Nhân sự (step-up)

**Tài khoản** (`/account`, theo người dùng, không theo shop):
- **Bật MFA**: `POST /account/mfa/enroll` (auth trả `{secret, otpauth_url}`) → hiện khoá cho
  người dùng thêm vào app xác thực → `POST /account/mfa/activate {code}` → hiện **mã khôi phục**
  (một lần). Sai mã: giữ nguyên bước 2 (secret round-trip qua hidden field), không enroll lại.
- **Tắt MFA** (auth `/auth/mfa/disable`): xác minh **YẾU TỐ HIỆN TẠI** — mã TOTP hoặc mã khôi
  phục (mật khẩu KHÔNG đủ để gỡ lớp 2). app_auth không DELETE được `mfa_totp` → vô hiệu bằng
  `confirmed_at=NULL` + tắt cờ + huỷ mã khôi phục còn lại.
- **Đổi mật khẩu tại chỗ** (auth `/auth/password/change`): xác minh mật khẩu hiện tại → đặt mới →
  **THU HỒI mọi phiên KHÁC** (giữ phiên đang thao tác). Vẫn giữ nút "quên mật khẩu → gửi link
  qua email" (`/account/password/forgot`, thông điệp mờ) làm dự phòng.
- Mutation `verify-auth`: +3 (bỏ kiểm mật khẩu hiện tại / bỏ thu hồi phiên / bỏ xác minh mã tắt
  MFA) → auth e2e đỏ.

**Nhân sự** (`/shops/:id/members`, tab; xem = owner/admin, **sửa = owner**):
- List, **mời** (email + vai trò ≠ owner → trả **link chấp nhận** `${ADMIN_ORIGIN}/invite/accept?token=…`
  sống 7 ngày để gửi cho người được mời), **đổi vai trò** (không có option owner — nhất quán với
  mời; owner read-only), **gỡ**. `seller` cưỡng chế `members.write=owner` + guard **không bỏ owner cuối**.
- **Trang chấp nhận lời mời** (`GET/POST /invite/accept`, CÔNG KHAI — người được mời chưa có phiên):
  đặt mật khẩu → `auth /auth/invitations/accept` tạo tài khoản + membership (nhánh (a) tạo mới,
  (b) claim tài khoản chưa xác minh, (c) email đã xác minh phải đăng nhập trước). POST vẫn qua
  sameOrigin; token single-use; `no-referrer`+`no-store` để không rò token.
- **Step-up** (bắt buộc cho mọi thao tác sửa): xác thực lại bằng **mật khẩu** (không phải MFA →
  hoạt động cả khi chưa bật MFA). Chưa step-up → **interstitial** mang hành động đang chờ trong
  hidden field → nhập mật khẩu → `POST /auth/step-up` → chạy tiếp hành động; cửa sổ 5 phút nên
  các thao tác kế tiếp không hỏi lại. Backend `seller` vẫn tự kiểm step-up (BFF chỉ là UX gate).

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
  src/http.js     esc, cookie, sendHtml (CSP + img-src CDN), redirect, readForm/readMultipartFile, sameOrigin
  src/api.js      call() → forward cookie + Origin admin; authApi/sellerApi/sellerUpload/platformApi; loadSession
  src/pages.js    layout + tabs + renderLogin/Mfa/Dashboard/Orders/OrderDetail
                  + renderProducts/ProductNew/ProductDetail/Error (esc mọi giá trị động)
  src/server.js   router + handler: auth, dashboard, đơn, sản phẩm/tồn/ảnh, trang nội dung
  test/admin-flow.e2e.mjs       22 kiểm (login/MFA/đơn)
  test/admin-products.e2e.mjs   19 kiểm (sản phẩm/tồn kho)
  test/admin-media.e2e.mjs      14 kiểm (upload/xoá ảnh + thứ tự/ảnh đại diện)
  test/admin-content.e2e.mjs    19 kiểm (trang nội dung có phiên bản)
  test/admin-account.e2e.mjs    28 kiểm (MFA on/off + đổi mật khẩu + nhân sự/step-up + chấp nhận lời mời)
  Dockerfile      node pinned digest, non-root, healthcheck /healthz
scripts/verify-admin.sh     mutation: bỏ kiểm Origin → e2e đỏ
infra/compose.dev.yml       service seller-admin (:3001) + route Caddyfile.dev admin.localtest
infra/compose.prod.yml      service seller-admin (mem 160m) + Caddyfile admin.nentang.vn
```

## 7. Chạy

```bash
docker compose -f infra/compose.dev.yml up -d --build
docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-flow.e2e.mjs
docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-products.e2e.mjs
docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-media.e2e.mjs
docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-content.e2e.mjs
docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/admin-account.e2e.mjs
bash scripts/verify-admin.sh
```

## 8. Còn lại (fast-follow)

- Đếm giỏ ở header storefront (chéo service — cần app_store đọc giỏ hoặc thêm JS nhẹ).
- Ảnh trong trang KẾT QUẢ đơn (order_lines snapshot — cần join media). *(Giỏ ĐÃ có thumbnail.)*
