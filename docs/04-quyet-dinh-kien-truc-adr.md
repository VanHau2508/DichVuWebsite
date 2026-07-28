# Quyết định kiến trúc (ADR)

Mỗi mục ghi: quyết định, lý do, **cái giá phải trả**, và điều kiện để đổi ý.
Một quyết định không nêu được cái giá phải trả là một quyết định chưa được cân nhắc.

## Tiến độ đã kiểm chứng

| Bước | Nội dung | Trạng thái |
|---|---|---|
| (c) | TLS on-demand + endpoint `ask` | ✅ 35/35 smoke, cold start · `docs/05` |
| (b) | Cô lập tenant: RLS + composite FK + test | ✅ 36/36 + 12/12 mutation · `docs/06` |
| — | Migration runner thật (checksum, advisory lock, forward-only) | ✅ `packages/db/migrate.js` |
| Ngày 4 | Auth: Argon2id + phiên + MFA TOTP + reset + rate limit | ✅ 40/40 e2e + 9/9 mutation · `docs/07` |
| Ngày 4 | Rà soát bảo mật đối kháng auth (6 lỗi thật đã sửa) | ✅ `docs/08` |
| Ngày 6 | Onboarding shop: tạo shop + subdomain, mời owner, khoá/mở | ✅ 28/28 e2e + 5/5 mutation · `docs/09` |
| Ngày 7 | Seller-admin + RBAC + step-up (app_rw + RLS dùng thật) | ✅ 25/25 e2e + 6/6 mutation · `docs/10` |
| Ngày 8 | Catalog: sản phẩm, biến thể, danh mục (CRUD, phân trang, tìm) | ✅ 29/29 e2e + 5/5 mutation · `docs/11` |
| Ngày 9 | Tồn kho (ledger append-only, adjust nguyên tử) + media (MinIO, re-encode) | ✅ 11+9 e2e + 3+3 mutation · `docs/12` |
| Ngày 10 | Theme engine + storefront công khai (app_store RLS, domain→shop, escape/sanitize) | ✅ 14 e2e + 5 mutation + 8 isolation · `docs/13` |
| Ngày 12-13 | Giỏ hàng + checkout (server-side pricing, reserve nguyên tử, idempotency, snapshot) | ✅ 13 e2e + 5 mutation · `docs/14` |
| Ngày 14 | Thanh toán QR (VietQR + webhook đối soát: xác thực, đối chiếu tiền + tài khoản, chống replay) | ✅ 18 e2e + 4 mutation + 4 vietqr · `docs/15` |
| Ngày 14 | Rà soát bảo mật đối kháng thanh toán (1 lỗ hổng high đã sửa: ràng buộc tài khoản nhận) | ✅ `docs/16` |
| Ngày 15 | Vận chuyển + email (outbox→worker→SMTP, state machine đơn, release reserve) | ✅ 13 e2e + 3 mutation · `docs/17` |
| Ngày 18 | Security hardening: rà soát đối kháng toàn hệ thống + CSP + dep/secret scan | ✅ 1 lỗ hổng high đã sửa (shop đình chỉ vẫn thu tiền) + nodemailer CVE · `docs/18` |
| Ngày 19-20 | Backup/restore drill + resilience + Go/No-Go 15 tiêu chí | ✅ **VERDICT GO** (13/15 tự động, 2 manual) · `docs/19` |
| Ngày 11 | Trang nội dung/chính sách (page + revision, draft/publish/rollback, menu) | ✅ 34 e2e + 4 mutation + 3 append-only · `docs/20` |
| Ngày 11+ | Xem trước bản nháp trên storefront (snapshot + token, không nới RLS) + siết cột draft (0018) | ✅ 23 e2e + 5 mutation + 8 cấu trúc + rà soát đối kháng · `docs/20 §8` |
| Ngày 11+ | SEO meta theo trang (seo_title/description, versioned theo publish, OG/Twitter/canonical, escape) | ✅ 25 e2e + 2 mutation + 4 cấu trúc + rà soát đối kháng · `docs/20 §9` |
| Ngày 11+ | Kéo–thả section (id block, add/update/delete/reorder, section list/quote/divider, không migration) | ✅ 25 e2e + 2 mutation + rà soát đối kháng · `docs/20 §10` |

Kế hoạch 20 ngày HOÀN TẤT — verdict GO; Ngày 11 (nội dung/trang) đã bổ sung xong.
Còn thiếu (ngoài kế hoạch/quyết định người): CI thật, alert on-call (#11),
UAT khách thật (#14), floating IP + secret manager + SMTP relay thật (hạ tầng).

---

## ADR-001 — Modular monolith, không microservice

**Quyết định.** Một process NestJS, ranh giới module cưỡng chế bằng lint rule, giao tiếp ngược chiều bằng outbox event.

**Lý do.** 2 người. Microservice đổi độ phức tạp code lấy độ phức tạp vận hành, mà vận hành mới là thứ đang thiếu người. Ở 500 shop, một Postgres và một Node process vẫn dư sức.

**Cái giá.** Deploy toàn bộ hoặc không gì cả. Một memory leak trong module ảnh làm chết cả API. Không scale riêng từng phần.

**Đổi ý khi.** Một module cần scale hoặc cần ngôn ngữ khác (ví dụ xử lý ảnh nặng). Tách module đó ra trước, không tách hết.

---

## ADR-002 — Một database, cô lập bằng RLS (không phải schema-per-tenant, không phải DB-per-tenant)

**Quyết định.** Một `shops` table, `shop_id` ở mọi bảng, PostgreSQL RLS `FORCE`.

**Lý do.** Migration chạy một lần cho tất cả. Connection pool dùng chung. Ở 500 tenant, schema-per-tenant làm `pg_dump` và migration chậm tới mức không dùng được, và số lượng bảng nhân lên 500 lần phá vỡ `pg_class` cache.

**Cái giá.** Một lỗi RLS = rò dữ liệu **tất cả** khách hàng. Không có tường lửa vật lý. Không thể restore riêng dữ liệu một shop từ base backup (phải lọc thủ công). "Noisy neighbor": một shop query nặng làm chậm mọi shop.

**Giảm nhẹ.** Hai lớp phòng thủ (ứng dụng + RLS) + composite FK là lớp thứ ba. Bộ test cross-shop chạy mọi commit. `statement_timeout` theo shop.

**Đổi ý khi.** Có khách enterprise yêu cầu cô lập vật lý, hoặc một shop chiếm > 30% tải. Lúc đó tách shop đó sang DB riêng — schema **giống hệt**, nên chỉ là đổi connection string. Đây chính là lý do phải có `shop_id` ngay cả khi mỗi DB chỉ có một shop.

---

## ADR-003 — Caddy + TLS on-demand cho custom domain

**Quyết định.** Caddy tự cấp Let's Encrypt cert khi có handshake tới domain đã verify. Endpoint `ask` kiểm tra DB trước khi cấp.

**Lý do.** Bạn tự host và bắt buộc mỗi khách một domain riêng. Cloudflare for SaaS là giải pháp chuẩn nhưng là dịch vụ trả phí gắn với hạ tầng Cloudflare, không phù hợp khi đã chọn VPS. Caddy làm được điều tương đương, miễn phí, với ~15 dòng cấu hình.

**Cái giá.**
- Rate limit Let's Encrypt: 50 cert / domain đăng ký / tuần. Không phải vấn đề ở 10 shop; **là vấn đề nếu mất `caddy_data` và phải cấp lại 300 cert cùng lúc.** → backup `caddy_data`.
- Nếu `ask` endpoint chết, khách mới không có SSL. `ask` phải là code đơn giản nhất trong hệ thống và **không** phụ thuộc vào phần còn lại của API.
- Handshake đầu tiên tới domain mới mất ~5 giây.
- **Caddy ≥2.8 đã gỡ `interval`/`burst` khỏi `on_demand_tls`.** Không còn lớp
  giới hạn tần suất dựng sẵn. Caddy gọi `ask` ở **mọi** handshake tới hostname
  chưa có chứng chỉ, nên flood SNI ngẫu nhiên = flood cache-miss = flood query
  Postgres. Kiểm chứng thực nghiệm trên v2.11.4: để lại `interval` thì Caddy
  **không khởi động**.

**Giảm nhẹ (đã cài).**
- `tls-authorize` là service riêng, role database `app_tls` **chỉ có `SELECT`**
  trên `shops` + `domains`, không framework, một phụ thuộc (`pg`).
- Cache trong process (dương 300s / âm 15s), **không dùng Redis** — thêm một phụ
  thuộc là thêm một cách để endpoint này chết.
- **Token bucket 20/giây, burst 40** trên các lần chạm database. Cache hit không
  tiêu token → khách hàng thật không bị vạ lây khi có flood.
- **Fail-closed**: DB chết → 403. An toàn vì chứng chỉ đã cấp nằm trên đĩa và
  Caddy không hỏi lại; chỉ domain *mới* bị hoãn.

**Đổi ý khi.** Vượt ~300 domain hoặc cần chống DDoS. Chuyển sang Cloudflare for SaaS; kiến trúc `domains` table và verify flow giữ nguyên.

**Trạng thái.** Đã kiểm chứng bằng `scripts/smoke-tls.sh` — **35/35 pass**, gồm cold start từ volume rỗng. Xem `05-chay-thu-tls-on-demand.md`.

---

## ADR-004 — Domain khách trỏ A record vào floating IP, không qua Cloudflare

**Quyết định.** Khách thêm `A @ → <FLOATING_IP>` và `A www → <FLOATING_IP>`. Chỉ `nentang.vn` của bạn nằm sau Cloudflare.

**Lý do.** Apex domain không dùng được CNAME. Phần lớn nhà đăng ký tên miền Việt Nam (PA Vietnam, Mắt Bão, Nhân Hòa) không hỗ trợ ALIAS/ANAME/CNAME-flattening. Bắt khách chuyển nameserver sang Cloudflare là một rào cản bán hàng thật sự — nhiều khách có email doanh nghiệp, DNS record của bên thứ ba, và người đang giữ tài khoản DNS thường không phải người bạn nói chuyện.

**Cái giá.** Nặng, phải nhìn thẳng:
- **IP production trở thành vĩnh viễn.** Đổi VPS = liên hệ từng khách. Đây là ràng buộc kiến trúc mạnh nhất trong toàn bộ hệ thống.
- **IP lộ công khai.** Không có lớp chống DDoS.
- Không có CDN edge cho khách; ảnh phục vụ từ VPS + MinIO.

**Giảm nhẹ bắt buộc.**
- Mua **floating IP / elastic IP ngay từ ngày đầu.** Không dùng IP mặc định của máy ảo. Nếu nhà cung cấp không có floating IP → **đổi nhà cung cấp trước khi bán khách đầu tiên.** Chi phí đổi ý sau đó là vô hạn.
- Ghi vào hợp đồng: có thể yêu cầu khách cập nhật DNS với thông báo trước 30 ngày.
- Đề nghị (không ép) khách dùng Cloudflare free cho domain của họ; ai đồng ý thì được thêm một lớp bảo vệ.

**Đổi ý khi.** Cần chống DDoS thật sự, hoặc đủ lớn để dùng anycast.

---

## ADR-005 — Seller admin trên một origin duy nhất

**Quyết định.** `admin.nentang.vn` cho tất cả nhà bán hàng. Storefront không có đăng nhập.

**Lý do.** Một cookie, một CSRF surface, thu hồi phiên tập trung, không có session sống sót trên domain khách đã rời đi.

**Cái giá.** Khách không có `shopA.com/admin` — một chi tiết "chuyên nghiệp" mà một số khách hỏi. Trả lời: Shopify cũng vậy (`admin.shopify.com`).

**Đổi ý khi.** Không. Đây là quyết định bảo mật, không phải thẩm mỹ.

---

## ADR-006 — Outbox pattern cho mọi side-effect

**Quyết định.** Không `queue.add()` trong request handler. Ghi `outbox` trong transaction, poller đẩy sang BullMQ.

**Lý do.** Không có giao dịch phân tán giữa Postgres và Redis. Nếu enqueue trực tiếp rồi transaction rollback, khách nhận email cho đơn hàng không tồn tại — và bạn không có cách nào biết.

**Cái giá.** Trễ tối đa 1 giây. Một bảng và một poller phải nuôi. Job giao **ít nhất một lần**, nên consumer phải idempotent.

**Đổi ý khi.** Không.

---

## ADR-007 — Chuyển khoản QR đối soát qua SePay/Casso, không tự đọc ngân hàng

**Quyết định.** Sinh VietQR có mã đơn trong nội dung; webhook từ SePay/Casso xác nhận tiền về.

**Lý do.** Cổng thanh toán VN (VNPay, OnePay) cần hồ sơ doanh nghiệp và 2–6 tuần thẩm định — không thể là điều kiện chặn go-live ngày 30. QR + đối soát tự động phủ được phần lớn giao dịch thực tế của shop thời trang.

**Cái giá.** Phụ thuộc bên thứ ba, ~200k/tháng. Khách chuyển sai nội dung → phải xác nhận thủ công. Không có hoàn tiền tự động.

**Bắt buộc.** Đối chiếu **số tiền chính xác**. Kiểm tra chữ ký. `provider_event_id UNIQUE`. Không bao giờ `paid` từ redirect trình duyệt.

**Việc phải làm ngay Ngày 1.** Nộp hồ sơ cổng thanh toán. Code sau, hồ sơ trước — nó là đường găng dài nhất và không phụ thuộc vào dev.

---

## ADR-008 — Shop không được chèn JavaScript

**Quyết định.** Tracking pixel là ba trường có kiểu (`ga_id`, `meta_pixel_id`, `tiktok_pixel_id`), validate regex, render bằng component của bạn. Không có ô "custom code".

**Lý do.** Bạn ký hợp đồng chịu trách nhiệm bảo mật cho website của khách. Cho phép chèn script tùy ý là trao chìa khóa XSS cho người không hiểu XSS, trên chính domain mà người mua nhập số điện thoại và địa chỉ. Một shop bị hack tài khoản admin → skimmer trang checkout → **bạn là bên chịu trách nhiệm pháp lý**.

**Cái giá.** Sẽ có khách hỏi "sao Haravan cho chèn code mà bên em không?". Câu trả lời có sẵn: *"Vì bên em chịu trách nhiệm bảo mật cho website của anh/chị. Cần thêm công cụ đo lường nào, báo bên em tích hợp chuẩn."* CSP `default-src 'self'` được thực thi thật, không phải khẩu hiệu.

**Đổi ý khi.** Không. Nếu buộc phải, chỉ cho phép trong sandbox iframe của domain riêng, và loại trừ hoàn toàn trang checkout.

---

## ADR-009 — Cắt phạm vi cho đội 2 người

Kế hoạch gốc: 4 người × 20 ngày ≈ **640 giờ**. Thực tế: 2 người ≈ **320 giờ** (đã trừ họp, hỗ trợ bán hàng, sự cố).

Cắt như sau. Nguyên tắc chọn: **giữ mọi thứ liên quan tới tiền, dữ liệu và tenant; cắt mọi thứ liên quan tới tiện nghi.**

| Bỏ khỏi V1 | Giờ tiết kiệm | Vì sao an toàn |
|---|---|---|
| `platform-admin` là app riêng → route `/ops` trong seller-admin | ~30 | Chỉ 2 người dùng nó. Tách sau, không phá schema. |
| ISR / cache HTML → chỉ SSR + cache dữ liệu Redis | ~20 | 10 shop không tạo ra tải. Thêm sau, không đổi API. |
| Theme draft/preview/publish → sửa trực tiếp + `theme_revision` rollback | ~25 | **Bạn** cấu hình theme cho khách, không phải khách. |
| Import CSV sản phẩm | ~20 | Bạn nhập tay 100 sản phẩm. Hợp đồng đã ghi "tối đa 100". |
| Cổng thanh toán online | ~30 | Hồ sơ chưa duyệt kịp. COD + QR đủ. `[P1]` |
| Tích hợp API đơn vị vận chuyển | ~25 | Phí ship theo vùng (bảng cứng) + nhập tracking tay. `[P1]` |
| Mã giảm giá | ~15 | `[P1]`. Không shop pilot nào chặn vì thiếu nó. |
| Tìm kiếm full-text → `ILIKE` + index trigram | ~10 | 100 sản phẩm. |
| k6 load test → một script `autocannon` | ~10 | 10 shop. |
| Grafana/OTel stack → Sentry + Uptime Kuma + log file | ~25 | Đủ để biết khi nào cháy. |
| **Tổng** | **~210** | |

**Tuyệt đối không cắt** (đây là danh sách bất khả xâm phạm):
- RLS + `FORCE` + composite FK + **bộ test cross-shop**
- MFA cho Owner và Platform Staff
- Idempotency ở checkout và webhook
- Tính giá phía server
- Snapshot `order_line`
- Outbox
- Audit log
- Backup **và diễn tập restore**
- Rollback deploy
- Xác minh domain trước khi route
- Re-encode ảnh trước khi public
- Redaction trong log

Mỗi mục trên là một thứ **không thể thêm vào sau mà không viết lại**, hoặc là một thứ mà khi nó vắng mặt bạn sẽ không biết cho tới lúc đã mất khách.

---

## ADR-010 — Mục tiêu ngày 30 với 2 người: một shop pilot, không phải ba

**Quyết định.** Ngày 30 = 1 shop thật đang bán hàng. Shop thứ 2 và 3 vào tuần 5–6.

**Lý do.** Kế hoạch gốc đã nói thẳng: *"Nếu một người tự phát triển, một tháng chỉ đủ prototype."* Hai người nằm giữa prototype và MVP. Việc chọn 1 shop pilot cho phép giữ nguyên **toàn bộ danh sách 15 tiêu chí go-live** thay vì cắt tiêu chí bảo mật để kịp 3 shop.

**Cái giá.** Doanh thu triển khai tháng đầu là 8,9 triệu (một khách sáng lập) thay vì 26,7 triệu. Đây là cái giá đúng để trả — shop pilot đầu tiên là nơi bạn phát hiện 20 thứ chưa nghĩ tới, và bạn muốn phát hiện chúng khi chỉ có một khách đang nhìn.

**Điều kiện.** Khách pilot phải được thông báo rõ họ là khách sáng lập, đang chạy trên nền tảng mới, đổi lại nhận giá 8,9 triệu và giữ giá 990k/12 tháng. Điều này đã có trong offer.

---

## ADR-011 — JS hẹp ký nonce CHỈ cho seller-admin; đường tiền giữ khoá cứng

**Quyết định.** `apps/seller-admin` được phép chạy **JavaScript nội tuyến ký nonce**, theo đúng
mẫu đã dùng cho GPS checkout (`apps/checkout/src/http.js:35`). Phạm vi giới hạn bằng **danh sách
trắng** bên dưới, và **mọi tính năng phải hoạt động đầy đủ khi không có JS** (JS chỉ là lớp cải
thiện, không phải điều kiện để dùng được). `storefront`, `checkout`, `account`, `signup`
**không đổi** — vẫn `default-src 'none'`, trừ hai ngoại lệ nonce đã có (badge giỏ, GPS).

**Lý do.** Seller-admin không nằm trên đường tiền: người bán **đã đăng nhập**, không ai nhập thẻ
ở đây, trang không được index, và người mua không bao giờ tới. Rủi ro XSS ở đây khác chất so với
storefront — kẻ tấn công phải chiếm được phiên người bán trước, mà khi đã chiếm được phiên thì
họ làm được mọi thứ qua form rồi; JS không mở thêm cánh cửa đáng kể. Đổi lại, người bán **dùng
admin mỗi ngày**: chọn hàng loạt, lọc tức thì, xác nhận trước khi xoá — những thứ này đổi thẳng
ra thời gian thật của họ. Đối thủ (TikTok Shop, Shopee seller center) đều là ứng dụng JS; muốn
ngang hàng ở trải nghiệm quản trị thì no-JS thuần là **trần cứng không vượt được**.

**ADR-008 không bị đụng.** Đây là JS **của nền tảng**, do ta viết, ký nonce từng response. Shop
vẫn **không** có ô "custom code" — ranh giới đó giữ nguyên vĩnh viễn.

**Cái giá.**
1. **Bề mặt tấn công tăng** — từ "không thể thực thi JS" sang "thực thi được JS của ta". Nếu
   `'unsafe-inline'` lọt vào `script-src`, trình duyệt **bỏ qua nonce hoàn toàn** → mất sạch
   lớp bảo vệ mà vẫn tưởng còn.
2. **Test đắt hơn.** Hành vi JS cần trình duyệt thật, không so chuỗi HTML được nữa — trong khi
   quota CI đang cháy. Ràng buộc bù: đường lui no-JS phải test được bằng assertion HTML như cũ.
3. **CSP hai tầng.** Phải sửa **cả** `infra/caddy/Caddyfile`. Quên → chạy tốt ở dev, chết câm
   ở prod (xem ràng buộc 1).
4. **Trượt phạm vi.** "Thêm tí JS nữa thôi" là cách mọi hệ no-JS chết. Danh sách trắng là hàng rào.

**Ràng buộc thực thi — bắt buộc, không ngoại lệ.**
1. **Sửa ĐÚNG HAI NƠI:** `apps/seller-admin/src/http.js` (CSP theo nonce) **VÀ** block
   `admin.nentang.vn` trong `infra/caddy/Caddyfile:53`. Trình duyệt áp **GIAO** hai policy;
   `Caddyfile.dev` **không** set CSP ở edge → **dev không phát hiện được lỗi này**.
   Luôn kiểm bằng cấu hình prod trước khi phát hành.
2. **`script-src` chỉ chứa `'nonce-X'`.** Tuyệt đối không `'unsafe-inline'`, không `'unsafe-eval'`,
   không `'strict-dynamic'`, không host ngoài.
3. **Một khối `<script nonce>` nội tuyến duy nhất mỗi trang.** Không file `.js` rời, không
   import, không bundler, không package frontend từ npm (giữ nguyên miễn nhiễm chuỗi cung ứng).
4. **Nonce sinh mới mỗi response:** `crypto.randomBytes(16).toString('base64')`. Trang không cần
   JS truyền `nonce=''` → CSP khoá cứng như cũ (**mặc định an toàn**).
5. **Mọi ghi dữ liệu vẫn qua form POST + CSRF hiện có.** JS được phép cải thiện thao tác,
   **không** được trở thành đường ghi dữ liệu duy nhất.
6. **`connect-src 'self'`** chỉ thêm khi thật sự cần `fetch`; mặc định không thêm.

**Danh sách trắng ban đầu.** Chỉ những mục này; muốn thêm phải sửa ADR:
- Chọn hàng loạt trong bảng (chọn tất cả / bỏ chọn / đếm số đang chọn)
- Lọc & sắp xếp tức thì **trên dữ liệu đã tải sẵn** trong trang
- Hộp xác nhận trước hành động phá huỷ (xoá sản phẩm, huỷ đơn)
- Đóng/mở khối, chuyển tab, menu `⋯`
- Đếm ngược và mốc thời gian tương đối ("2 phút trước")
- Tự lưu nháp cho form dài (sản phẩm nhiều biến thể)

**Cấm dùng JS cho.**
- Bất cứ thứ gì **tính tiền** — giá, khuyến mãi, phí ship, tổng đơn: luôn tính ở server
- Bất cứ thứ gì thuộc `storefront` / `checkout` / `account` / `signup`
- Thay thế form POST làm đường ghi dữ liệu

**Đổi ý khi.** Quay lại no-JS tuyệt đối cho seller-admin nếu: (a) phát hiện XSS thật trong
seller-admin, (b) cấu hình sai làm nonce mất tác dụng lọt tới production, hoặc (c) chi phí test
hành vi JS vượt quá lợi ích thu được. **Không bao giờ** mở rộng quyết định này sang storefront
hay checkout — **đường tiền là ranh giới cứng**, đó chính là thứ đang bán được.

---

## Bảng tóm tắt: thứ tự không thể đảo

Ba quyết định phải đúng ngay lần đầu vì chi phí sửa sau là không chấp nhận được:

| # | Quyết định | Chi phí sửa sau |
|---|---|---|
| 1 | **Floating IP** cho production | Liên hệ từng khách đổi DNS. Downtime không kiểm soát. |
| 2 | **`shop_id` ở mọi bảng + composite FK** | Viết lại toàn bộ schema và migration dữ liệu thật. |
| 3 | **Snapshot giá/tên trong `order_line`** | Dữ liệu lịch sử đã mất. Không khôi phục được. |

Mọi thứ khác đều sửa được. Ba thứ này thì không.
