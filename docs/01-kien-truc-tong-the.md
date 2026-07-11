# Kiến trúc tổng thể

> Trạng thái: Bản thiết kế v1 — chốt trước Ngày 2 của kế hoạch 30 ngày.
> Ràng buộc đầu vào: **2 lập trình viên**, **VPS Việt Nam + Docker**, **custom domain bắt buộc cho mỗi khách**.

---

## 0. Cảnh báo phạm vi (đọc trước)

Kế hoạch 30 ngày trong `Nội dung kế hoạch.txt` giả định **4 người full-time ≈ 640 giờ**. Với 2 người, bạn có **≈ 320 giờ**. Không thể làm hết P0 + P1 trong 20 ngày làm việc.

Kiến trúc dưới đây được thiết kế để **cắt được 50% khối lượng mà không phải viết lại về sau**. Những chỗ cắt được đánh dấu `[CẮT-V1]`. Xem `04-quyet-dinh-kien-truc-adr.md` mục ADR-009 để biết cái gì bị bỏ và vì sao bỏ được an toàn.

Mục tiêu ngày 30 với 2 người: **1 shop pilot chạy thật**, không phải 3.

---

## 1. Sơ đồ hệ thống

```
                    Internet
                       │
        ┌──────────────┴───────────────┐
        │  shopA.com   shopB.vn        │  ← A record → FLOATING IP (cố định vĩnh viễn)
        │  admin.nentang.vn            │
        │  *.nentang.vn                │
        └──────────────┬───────────────┘
                       │ :80 :443
        ┌──────────────▼───────────────────────────────────┐
        │  CADDY  (reverse proxy + TLS on-demand)          │
        │   • Let's Encrypt tự động cho domain khách       │
        │   • hỏi /internal/tls/authorize trước khi cấp    │
        │   • rate limit lớp 1, security headers           │
        └──┬──────────────┬──────────────┬─────────────────┘
           │              │              │
   ┌───────▼──────┐ ┌─────▼────────┐ ┌──▼────────────────┐
   │ STOREFRONT   │ │ SELLER-ADMIN │ │ API (NestJS)      │
   │ Next.js SSR  │ │ Next.js SPA  │ │ modular monolith  │
   │ (đa domain)  │ │ (1 origin)   │ │ + PLATFORM-ADMIN  │
   └───────┬──────┘ └─────┬────────┘ └──┬────────────────┘
           │              │             │
           └──────────────┴─────────────┤
                                        │
   ┌────────────────┐  ┌────────────────▼──────┐  ┌──────────────┐
   │ WORKER         │  │ PostgreSQL 16         │  │ Redis 7      │
   │ BullMQ         │◄─┤ Row-Level Security    │  │ cache/queue  │
   │ email, ảnh,    │  │ role app_rw KHÔNG có  │  │ session      │
   │ webhook, backup│  │ BYPASSRLS             │  │ rate limit   │
   └───────┬────────┘  └───────────────────────┘  └──────────────┘
           │
   ┌───────▼────────┐         ┌────────────────────────────┐
   │ MinIO (S3 API) │────────►│ Backblaze B2 (offsite)     │
   │ ảnh sản phẩm   │  sync   │ + WAL archive của Postgres │
   └────────────────┘         └────────────────────────────┘
```

**Tất cả chạy trên 1 VPS production.** VPS thứ hai (nhỏ) chạy staging + là đích backup + Uptime Kuma. Chi tiết: `03-ha-tang-va-van-hanh.md`.

---

## 2. Bốn ứng dụng, một core

| App | Domain | Vai trò | Có state? |
|---|---|---|---|
| `storefront` | domain của khách (nhiều) | SSR trang bán hàng, giỏ, checkout | cookie cart, host-only |
| `seller-admin` | `admin.nentang.vn` (một) | Nhà bán hàng quản trị shop của mình | session cookie |
| `platform-admin` | `ops.nentang.vn` (một) | Bạn tạo/khóa shop, xem audit | session + MFA bắt buộc |
| `api` | nội bộ, không public | Toàn bộ business logic | không |
| `worker` | không public | BullMQ: email, resize ảnh, webhook | không |

**`[CẮT-V1]`**: `platform-admin` **không phải app riêng**. Nó là một route group `/ops` trong `seller-admin`, bảo vệ bằng `PlatformStaffGuard` + MFA. Tách ra sau khi có nhân sự vận hành. Tiết kiệm ~30 giờ.

### Vì sao seller-admin nằm trên MỘT origin duy nhất

Đây là quyết định bảo mật quan trọng nhất của tầng web.

Nếu để nhà bán hàng đăng nhập trên chính domain của họ (`shopA.com/admin`), bạn có:
- session cookie rải trên N domain không kiểm soát → không thu hồi tập trung được;
- nếu khách trỏ domain đi nơi khác mà quên báo, cookie phiên vẫn còn hiệu lực trên domain đó;
- CSRF surface nhân lên theo số shop.

Với một origin `admin.nentang.vn`:
- một cookie `__Host-session`, `SameSite=Lax`, `Secure`, `HttpOnly`;
- thu hồi phiên = xóa key Redis, tức thì cho mọi shop;
- storefront **không có form đăng nhập nào cả** → guest checkout, không có gì để CSRF ngoài giỏ hàng.

`shop_id` trong seller-admin **luôn lấy từ membership trong session**, không bao giờ từ hostname, không bao giờ từ body request.

---

## 3. Định tuyến theo tenant (tenant resolution)

Đây là điểm rẽ nhánh duy nhất trong toàn hệ thống. Sai ở đây là rò dữ liệu chéo shop.

```
Request → Caddy → storefront
   │
   ├─ Host: shopA.com
   │     │
   │     ▼
   │  middleware.ts
   │     │  lookup Redis: domain:shopA.com  (TTL 60s)
   │     │  miss → SELECT shop_id FROM domains
   │     │          WHERE hostname=$1 AND verified_at IS NOT NULL AND status='active'
   │     │  miss → 404 "Tên miền chưa được kết nối"
   │     ▼
   │  request.tenant = { shopId, domainId }
   │
   └─ Không bao giờ đọc shop_id từ query, body, hay header do client gửi.
```

Ba quy tắc bất di bất dịch:

1. **Chỉ domain đã `verified_at IS NOT NULL` mới được route.** Chưa verify = 404. Nếu không, ai cũng trỏ domain vào IP của bạn và mượn shop của người khác.
2. **Cache key luôn có `shop_id`.** Không có ngoại lệ. Xem mục 6.
3. **Không cache công khai `/cart`, `/checkout`, `/api/*`.** `Cache-Control: private, no-store` set ở Caddy cho các path này, không phụ thuộc app nhớ set.

### TLS on-demand — cơ chế

Caddy cấp chứng chỉ Let's Encrypt ngay khi có TLS handshake tới một domain lạ. Nếu để tự do, kẻ tấn công trỏ 10.000 domain vào IP của bạn và làm bạn bị Let's Encrypt rate-limit vĩnh viễn. Vì vậy `ask` là bắt buộc:

```caddyfile
{
  on_demand_tls {
    ask http://tls-authorize:3010/internal/tls/authorize
  }
}

https:// {
  tls { on_demand }
  reverse_proxy storefront:3000
}
```

> **Không có `interval` / `burst`.** Caddy đã gỡ bỏ hai tuỳ chọn này từ v2.8;
> để lại thì Caddy **không khởi động** (kiểm chứng trên v2.11.4). Hệ quả: Caddy
> gọi `ask` ở **mọi** handshake tới hostname chưa có chứng chỉ, và `ask` trở
> thành lá chắn duy nhất. Vì vậy `tls-authorize` tự giới hạn tần suất tra cứu
> database bằng token bucket (20/giây, burst 40) — nếu không, flood SNI ngẫu
> nhiên biến thành flood query Postgres. Cache hit không tiêu token, nên khách
> hàng thật không bao giờ bị vạ lây.

Endpoint `/internal/tls/authorize?domain=shopA.com`:
- `200` nếu có `domains` row `hostname=shopA.com`, `verified_at IS NOT NULL`, và shop chưa `terminated`;
- `403` mọi trường hợp khác (kể cả khi database chết — **fail-closed**);
- Chỉ nghe trên network nội bộ Docker, không expose ra ngoài.

Nó là **service riêng** (`apps/tls-authorize`), không nằm trong `api`. ADR-003 yêu cầu
nó không phụ thuộc phần còn lại của hệ thống: API chết thì khách vẫn có SSL.
Không framework, một phụ thuộc (`pg`), role database chỉ có `SELECT`.

> Shop `suspended` **vẫn được cấp cert** — storefront cần HTTPS để hiện trang thông báo
> tạm ngưng. Khoá shop không cắt SSL và không xoá dữ liệu.

### Quy trình khách trỏ tên miền

```
Khách nhập shopA.com vào seller-admin
  → hệ thống sinh token, tạo domains row (verified_at = NULL)
  → khách thêm TXT record: _nentang-verify.shopA.com = <token>
  → worker job kiểm tra DNS mỗi 60s, tối đa 24h
  → verified_at = now()
  → khách đổi A record @ và www → <FLOATING_IP>
  → truy cập lần đầu → Caddy hỏi /authorize → 200 → cấp cert (~5 giây)
```

> **Ràng buộc phải nói với khách ngay từ hợp đồng:** apex domain (`shopA.com`, không có `www`) phải dùng **A record trỏ thẳng IP**, vì phần lớn nhà cung cấp DNS Việt Nam không hỗ trợ CNAME flattening / ALIAS ở apex.
>
> **Hệ quả nghiêm trọng:** IP đó bạn phải giữ **vĩnh viễn**. Đổi VPS = phải liên hệ từng khách đổi DNS. Vì vậy: **mua floating IP / elastic IP ngay từ ngày đầu**, đừng dùng IP gắn cứng vào máy ảo. Nếu nhà cung cấp không có floating IP, đổi nhà cung cấp. Đây là một trong hai quyết định không sửa được về sau (cái còn lại là `shop_id` trong schema).

---

## 4. Cô lập dữ liệu — hai lớp phòng thủ

Không tin vào một lớp duy nhất. Lỗi `WHERE shop_id = ?` bị quên là điều **sẽ** xảy ra.

### Lớp 1 — Ứng dụng
Mọi truy vấn đi qua `TenantContext` (AsyncLocalStorage). Repository base class tự chèn `shop_id`. Lint rule cấm gọi Prisma/Drizzle client thô ngoài repository.

### Lớp 2 — Cơ sở dữ liệu (Row-Level Security)
Lớp này bắt được lỗi mà lớp 1 bỏ sót. Ứng dụng kết nối bằng role `app_rw`:
- **không** phải owner của bảng,
- **không** có `BYPASSRLS`,
- mọi bảng nghiệp vụ đều `ENABLE` **và** `FORCE ROW LEVEL SECURITY`.

Mỗi transaction bắt đầu bằng:
```sql
SET LOCAL app.shop_id = '<uuid từ TenantContext>';
```

`SET LOCAL` có phạm vi transaction → an toàn với PgBouncer ở chế độ `transaction` pooling. Không bao giờ dùng `SET` (session-scoped) — nó rò sang request khác khi connection được tái sử dụng.

Chi tiết SQL, composite foreign key, và bộ test cross-shop: `02-mo-hinh-du-lieu-va-bao-mat.md`.

---

## 5. Ranh giới module trong API

Modular monolith. Một process, ranh giới rõ, **không microservice**.

```
apps/api/src/modules/
  identity/        # user, session, MFA, invitation
  tenancy/         # shop, membership, domain, subscription, suspension
  catalog/         # product, variant, category, media
  inventory/       # inventory_level, ledger, reservation
  cart/            # cart, cart_item, định giá lại phía server
  checkout/        # order, order_line, snapshot, idempotency
  payment/         # payment, transaction ledger, webhook ngân hàng
  fulfillment/     # shipment, tracking
  content/         # page, menu, revision
  theming/         # theme, design token, section config
  platform/        # ops: tạo/khóa shop, audit viewer
  shared/          # tenant-context, audit, outbox, rate-limit
```

Quy tắc phụ thuộc, **kiểm tra tự động bằng ESLint `no-restricted-imports`**:
- Module chỉ import từ `shared/` và từ *contract* (interface + DTO) của module khác, không import service nội bộ.
- `catalog` **không** được import `checkout`. Chiều phụ thuộc luôn đi từ nghiệp vụ cao xuống thấp: `checkout → inventory → catalog`.
- Giao tiếp ngược chiều bằng **domain event qua bảng `outbox`**, không gọi trực tiếp.

Vì sao bận tâm chuyện này khi chỉ có 2 người: đây là thứ duy nhất giữ cho monolith không biến thành đống bùn, và nó **miễn phí** nếu áp dụng từ ngày 2. Áp dụng ở tháng thứ 6 thì tốn 3 tuần.

---

## 6. Bộ nhớ đệm

| Dữ liệu | Nơi | Key | Vô hiệu hóa |
|---|---|---|---|
| `domain → shop_id` | Redis | `dom:{hostname}` | TTL 60s + xóa khi đổi domain |
| Theme + section config | Redis | `shop:{id}:theme:v{n}` | tăng `n` khi publish |
| Trang sản phẩm (HTML) | Next.js ISR | tag `shop:{id}:product:{slug}` | `revalidateTag` khi publish |
| Danh mục | Next.js ISR | tag `shop:{id}:cat:{slug}` | như trên |
| Giỏ hàng, checkout | **không cache** | — | — |

Quy ước: **mọi cache key bắt đầu bằng `shop:{shop_id}:`**. Một helper `tenantKey(suffix)` duy nhất, cấm nối chuỗi tay. Một bài test đọc toàn bộ lời gọi Redis trong CI và fail nếu thấy key không có tiền tố tenant.

`[CẮT-V1]`: bỏ ISR, chỉ SSR + cache dữ liệu trong Redis. Ở 3–10 shop, throughput không phải vấn đề; ISR đa domain có nhiều cạm bẫy không đáng đổi lấy 20 giờ.

---

## 7. Theme engine

Khách được cảm giác "thiết kế riêng" nhưng **không có source riêng**.

```
theme (bản ghi DB, thuộc shop)
 ├── tokens: { color.primary, color.bg, font.heading, radius, spacing }
 ├── layout: [ {section: "header",   props: {...}},
 │             {section: "hero",     props: {...}},
 │             {section: "grid",     props: {...}}, ... ]
 └── version: int
```

- Section là **React component có sẵn trong source**, tra bằng registry: `SECTIONS = { hero: HeroSection, ... }`. 10–15 cái.
- `props` được validate bằng Zod schema khai báo cùng component. Props không hợp lệ → render fallback, không crash trang.
- Token đổ ra CSS custom properties trên `<html>`, không sinh CSS động, không inline style tùy ý.
- **Shop tuyệt đối không được chèn JavaScript, không được chèn HTML thô.** Tracking pixel là 3 field có kiểu (`ga_id`, `meta_pixel_id`, `tiktok_pixel_id`), validate bằng regex, render bằng component của bạn. Nếu cho phép chèn script tự do, một shop bị hack sẽ trở thành bàn đạp — và bạn ký hợp đồng chịu trách nhiệm bảo mật.

Tùy biến cho khách = sửa `tokens` + sắp xếp lại `layout`. Không fork.

`[CẮT-V1]`: bỏ draft/preview/publish của theme. Sửa trực tiếp, có `theme_revision` để rollback. Preview là thứ khách hàng pilot không dùng vì **bạn** là người cấu hình theme cho họ, không phải họ.

---

## 8. Bất biến của luồng tiền

Những điều này không được vi phạm dù có sức ép tiến độ nào.

1. **Giá luôn tính lại phía server** từ `products.price` tại thời điểm checkout. Không bao giờ đọc `total`, `price`, `discount` từ body request. Client gửi lên chỉ có `variant_id` và `quantity`.
2. **Tạo đơn là một transaction**: khóa `inventory_level` bằng `SELECT ... FOR UPDATE`, kiểm tra tồn, ghi `order` + `order_line` + `inventory_ledger`, commit. Không có bước nào nằm ngoài transaction.
3. **Idempotency**: `POST /checkout` bắt buộc header `Idempotency-Key`. Bảng `idempotency_keys(shop_id, key, request_hash, response_body, status)` với `UNIQUE(shop_id, key)`. Request lặp trả về response cũ, không tạo đơn thứ hai.
4. **Snapshot**: `order_line` lưu tên, SKU, giá, ảnh **tại thời điểm mua**. Sửa sản phẩm sau đó không được làm thay đổi đơn cũ. Đây là yêu cầu kế toán, không phải tùy chọn.
5. **Không bao giờ đánh dấu đã thanh toán từ redirect trình duyệt.** Chỉ webhook đã xác thực chữ ký, hoặc thao tác thủ công của nhà bán hàng, mới đổi `payment.status = paid`.
6. **Không lưu thông tin thẻ.** Không một byte nào. Dùng hosted checkout của cổng.
7. `order_number` sinh từ counter theo shop (`UPDATE shop_counters SET n = n + 1 RETURNING n`), không dùng sequence toàn cục — nếu không, shop A đoán được sản lượng shop B.

### Thanh toán trong bối cảnh Việt Nam

- **COD**: trạng thái đơn `pending → confirmed → shipped → delivered → paid`. Không có tích hợp.
- **Chuyển khoản QR**: sinh VietQR với nội dung `<mã đơn>`. Đối soát bằng **webhook của SePay hoặc Casso** (dịch vụ đọc biến động số dư ngân hàng). Đây là cách duy nhất tự động hóa được ở VN mà không cần hồ sơ doanh nghiệp với cổng thanh toán.
  - Webhook phải: xác thực chữ ký/API key, kiểm tra timestamp, lưu `provider_event_id` `UNIQUE` để chống replay, xử lý idempotent.
  - **Đối chiếu số tiền.** Chuyển thiếu 1.000đ không được coi là đã thanh toán đủ.
- **Cổng online (VNPay/OnePay)**: `[P1]`. Cần hồ sơ doanh nghiệp, mất 2–6 tuần thẩm định. **Bắt đầu nộp hồ sơ từ Ngày 1**, code sau. Đừng để nó chặn go-live.

---

## 9. Tác vụ nền và outbox

Worker chạy BullMQ. Bốn queue: `email`, `image`, `webhook`, `maintenance`.

**Không bao giờ enqueue trực tiếp trong request handler.** Ghi vào bảng `outbox` trong cùng transaction nghiệp vụ; một poller đọc `outbox` và đẩy vào BullMQ. Lý do: nếu transaction rollback mà job đã vào Redis, khách nhận email xác nhận cho đơn hàng không tồn tại.

```
BEGIN;
  INSERT INTO orders ...;
  INSERT INTO outbox (topic, payload) VALUES ('order.created', {...});
COMMIT;
        │
        ▼  poller mỗi 1s
   BullMQ → worker → gửi email → outbox.processed_at = now()
```

Mọi job: `attempts: 5`, backoff mũ, dead-letter queue có cảnh báo. Job xử lý ảnh phải **re-encode** (sharp) chứ không chỉ kiểm tra MIME — file `.jpg` có thể chứa payload thực thi.

---

## 10. Media

1. Client xin `presigned PUT` từ API (đã kiểm tra quyền + hạn mức shop).
2. Upload thẳng lên MinIO vào bucket **private** `staging/`.
3. API ghi `media` row trạng thái `pending`, phát `outbox: media.uploaded`.
4. Worker: kiểm tra magic bytes, giới hạn 10MB, re-encode sang WebP + 3 kích thước, ghi sang bucket `public/{shop_id}/...`, đổi trạng thái `ready`.
5. Storefront chỉ hiển thị `media` ở trạng thái `ready`.

**File chưa qua bước 4 không bao giờ public.** Đây là một trong 15 tiêu chí go-live.

---

## 11. Ma trận phân quyền

| | Owner | Admin | Catalog Mgr | Order Mgr | Platform Staff |
|---|:---:|:---:|:---:|:---:|:---:|
| Sản phẩm / tồn kho | ✓ | ✓ | ✓ | – | – |
| Đơn hàng | ✓ | ✓ | – | ✓ | – |
| Hoàn tiền | ✓ | ✓ | – | – | – |
| Theme, nội dung | ✓ | ✓ | – | – | – |
| Nhân sự, phân quyền | ✓ | – | – | – | – |
| Domain | ✓ | – | – | – | – |
| Xuất dữ liệu | ✓ | – | – | – | – |
| Tạo / khóa shop | – | – | – | – | ✓ |
| Xem dữ liệu người mua | ✓ | ✓ | – | ✓ | **✗ (mặc định)** |

Hai ghi chú quan trọng:

- **Platform Staff không mặc định đọc được dữ liệu người mua của shop.** Muốn xem, phải kích hoạt *support access*: có lý do, có thời hạn (tối đa 24h), có audit, và **nhà bán hàng được thông báo qua email**. Điều này phải viết vào hợp đồng — nó là điểm bán hàng, không phải gánh nặng.
- Các thao tác `hoàn tiền`, `đổi quyền`, `thêm domain`, `xuất dữ liệu` yêu cầu **step-up authentication** (nhập lại mật khẩu hoặc mã MFA trong 5 phút gần nhất).

---

## 12. Cấu trúc mã nguồn

```
D:\Dichvuwebsite\
├── apps/
│   ├── api/            # NestJS — toàn bộ business logic + /ops
│   ├── storefront/     # Next.js — đa domain, SSR
│   ├── seller-admin/   # Next.js — một origin
│   └── worker/         # BullMQ consumers
├── packages/
│   ├── db/             # schema, migration, seed, RLS policies
│   ├── contracts/      # DTO + Zod schema dùng chung API ⇄ web
│   ├── tenant-context/ # AsyncLocalStorage + SET LOCAL
│   ├── auth/           # Argon2id, session, MFA (TOTP)
│   ├── theme-engine/   # section registry + token → CSS vars
│   └── observability/  # logger có redaction, tracing
├── infra/
│   ├── caddy/Caddyfile
│   ├── compose.prod.yml
│   ├── compose.staging.yml
│   └── backup/
├── docs/               # tài liệu này
└── tests/e2e/          # Playwright, gồm cross-shop test
```

Công cụ: pnpm workspace + Turborepo. Không dùng Nx (nặng hơn mức cần).

---

## 13. Cái gì KHÔNG có trong kiến trúc này

Ghi ra để không ai âm thầm thêm vào:

- Microservice, Kubernetes, service mesh.
- Message broker riêng (Kafka/RabbitMQ). BullMQ + outbox là đủ tới ~500 shop.
- GraphQL. REST + Zod contract.
- Database riêng cho mỗi tenant. Một DB, RLS. (Xem ADR-002 để biết khi nào đổi.)
- Page builder kéo–thả.
- Đồng bộ sàn TMĐT, POS, CRM, app store, đa ngôn ngữ, AI.
- Sửa core riêng cho một khách. **Không bao giờ.** Nếu khách trả tiền cho tính năng riêng, nó phải trở thành một section / module bật-tắt được cho mọi shop.

---

## Tài liệu liên quan

- `02-mo-hinh-du-lieu-va-bao-mat.md` — ERD, SQL RLS, composite FK, test cross-shop
- `03-ha-tang-va-van-hanh.md` — VPS topology, Caddy, Docker, backup, CI/CD, runbook
- `04-quyet-dinh-kien-truc-adr.md` — các quyết định và đánh đổi, gồm phần cắt phạm vi cho 2 người
