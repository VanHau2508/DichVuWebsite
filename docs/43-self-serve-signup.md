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

## Danh sách cấm slug — sửa 2026-07-29

Khớp CHUỖI CON với mọi thương hiệu là quá tay. Trong danh sách có `'be'` (2 ký tự) và
`'nhanh'` — hậu quả ĐO ĐƯỢC: `me-va-be` · `do-choi-cho-be` · `be-yeu-shop` · `bepgiadinh` ·
`banh-beo-co-ba` · `giao-hang-nhanh` · `an-nhanh` · `sapoche-vuon` · `tiem-banh-pancake` đều
bị chặn. Tức là chặn gần trọn ngành hàng **mẹ & bé** cùng mọi shop có chữ "nhanh", bằng đúng
một câu *"Địa chỉ này không sử dụng được"* không giải thích gì.

Đây là chặn ĐẦU TIÊN của phễu self-serve và nó hỏng **im lặng**: không log, không phiếu hỗ
trợ, người bán thử vài tên rồi bỏ đi.

**Quy tắc mới:** khớp TRỌN với mọi thương hiệu; khớp chuỗi con chỉ với thương hiệu ≥6 ký tự
và không nằm trong `AMBIGUOUS` (hiện có `pancake`).

**Đánh đổi có chủ ý:** `tiki-store`, `grab-food` nay lọt qua. Chấp nhận — kẻ chiếm tên thì ta
thấy được và có sẵn đường tạm khoá shop (một thao tác tay), còn người bán thật bị chặn thì im
lặng rời đi, không để lại dấu vết nào. Hai loại sai không cân nhau.

Chính chuỗi `'be'` cũng là thủ phạm làm `verify-provision.e2e` đỏ ~1/24 lượt: slug ngẫu nhiên
8 ký tự trúng `'be'` với xác suất ~0,54%, kỳ vọng ~1 lần trong 192 nháp — đo được đúng 1.
Test mới: `apps/signup/test/denylist.test.js` (7 ca, cổng unit mọi commit).

## Rà các chặn IM LẶNG — 2026-07-29

Năm nhánh "nuốt im lặng" của `/signup` (honeypot · form-ts sai · gửi <2s · email dùng-một-lần
· trần Redis) cộng trần 5 nháp/IP/giờ. Đã soi từng cái bằng dữ liệu thật:

| Nhánh | Rủi ro chặn nhầm người thật | Kết luận |
|---|---|---|
| honeypot `website` | autofill điền vào ô ẩn | **Không** — đã có `autocomplete="off"` + `tabindex="-1"` + `aria-hidden` |
| `!ts.ok` (HMAC form-ts) | secret đổi khi restart ⇒ nuốt sạch form đang mở | **Không** — `SIGNUP_FORM_SECRET` là biến môi trường cố định, prod bắt buộc |
| form-ts hết hạn | để tab lâu rồi nộp | **Không có hạn trên** — cố ý, mở tab bao lâu cũng nộp được |
| gửi <2s | người gõ nhanh | Thấp — `ct` phát lúc render, người thật luôn >2s |
| email dùng-một-lần | tên miền thật chứa tên miền rác | **Không** — so khớp TRỌN tên miền, `notmailinator.com` lọt qua |
| trần 5 nháp/IP/giờ | CGNAT, văn phòng chung IP | **Có** — và im lặng. Xem dưới |

**Hai lỗ đã vá:**

1. **Trang trung tính là NGÕ CỤT.** Nó cố ý không nói được gì đã xảy ra (đúng, chống dò email),
   nên người bị nuốt nhầm kiểm spam, không thấy gì, rồi hết đường — trong khi vẫn tin đã gửi.
   Với trần 5/IP/giờ, gửi lại vài lần còn tự khoá thêm một tiếng, cũng im lặng. Nay có
   **"Thử lại" + liên hệ hỗ trợ** (`SUPPORT_ZALO/PHONE/EMAIL`, ẩn nếu không đặt). Hiện y hệt
   cho MỌI người nộp nên **không lộ thêm gì**.

2. **Chặn nhầm là vô hình tuyệt đối** — không log, không dấu vết. Nay ghi
   `signup_swallowed` kèm **lý do** (`honeypot` · `form_ts_sai` · `gui_qua_nhanh` ·
   `email_dung_mot_lan` · `tran_redis_ip` · `tran_ip_gio`) ở phía SERVER, không chứa
   email/IP thô. Đếm được, đặt cảnh báo được.

**Bất biến mới có test:** ba ngả — bị nuốt vì honeypot, bị nuốt vì email rác, đăng ký thật —
trả HTML **y hệt từng byte**, khác đúng ở địa chỉ email hiển thị lại. So byte thay vì tìm một
câu, vì rẽ nhánh có thể lẻn vào bất kỳ đâu.

### Cảnh báo khi hàng rào chặn hàng loạt

Log `signup_swallowed` không ai đọc thì cũng như không ghi. signup `INCR swallow:<lý_do>`
(khoá sống 1 giờ, **fail-open** — Redis chết không được chặn ai đăng ký); worker `SCAN` trong
`sweepMoneyAlerts` và đẩy vào **đúng kênh cảnh báo đã có** (Telegram + chống-spam
`ALERT_REPEAT_MS`). Không dựng kênh mới — thêm một kênh là thêm một chỗ để quên.

**Thông điệp TÁCH THEO LÝ DO** — đây là toàn bộ giá trị. Nuốt là hành vi ĐÚNG với bot nên
tổng số một mình vô nghĩa: `honeypot ×200` là bot đập cửa (bình thường), còn `tran_ip_gio ×25`
hay `gui_qua_nhanh ×25` là hàng rào đang chặn **người thật**. Ngưỡng
`ALERT_SIGNUP_SWALLOW_MAX` mặc định 20/giờ.

Lý do ghi nhận là **cái khớp đầu tiên** theo thứ tự kiểm (honeypot → form_ts_sai →
gui_qua_nhanh → email_dung_mot_lan → tran_redis_ip → tran_ip_gio), không phải mọi lý do khớp.

## Shop đăng ký rồi bỏ ngang — khảo sát + xử lý (2026-07-30)

**Hai nghi vấn của tôi ĐỀU SAI, nêu ra để không ai đi lại:**
* *"Shop bỏ ngang kẹt lại mãi"* — không. Sweep chạy đủ vòng đời: `trial/active` quá hạn →
  `past_due` → quá ân hạn → `cancelled` **kèm** `shops.status='suspended'`.
* *"29 shop không có thuê bao = lỗ billing"* — không. `createShop` và `doVerify` đều chèn
  subscription **vô điều kiện, cùng transaction**; API không thể đẻ ra shop thiếu thuê bao.
  Toàn bộ là seed dev + test cắm SQL thẳng.

**Chỗ thật sự hở:** không gì phân biệt shop chưa từng đăng sản phẩm với shop đang bán. Console
liệt kê `status/plan/đã thu` — shop mở 10 ngày, 0 SP, 0 đơn nhìn **y hệt** shop bán tốt. Và
người bán **không nhận được gì** từ lúc xác minh email tới lúc thuê bao sắp hết hạn.

**Đã làm:**
1. `shops.first_product_at` (0112) — worker điền `min(products.created_at)`. Console đọc CỜ,
   **không đếm bảng products**: `app_platform` cố tình không có quyền ở đó (nguyên tắc #1 của
   0006) và test bắt ngay khi tôi thử — *permission denied for table products*. Thêm cột
   "Hàng hoá" + bộ lọc "⚠ Chưa có sản phẩm".
2. Email nhắc **đúng một lần** sau 48 giờ (0110) — chiếm-quyền-trước bằng
   `UPDATE ... WHERE onboarding_nudged_at IS NULL` rồi ghi outbox **cùng transaction**.
   Một lần, không phải chuỗi: tên miền gửi thư còn mới, nhắc lặp vào hộp thư người chưa tương
   tác là cách nhanh nhất kéo cả nền tảng vào spam.
3. `contact_email` đặt lúc cấp phát = email vừa xác minh. Không phải chi tiết nhỏ: cảnh báo
   **sắp hết hàng** lọc `WHERE contact_email IS NOT NULL`, mà **455/455** shop self-serve đều
   trống ⇒ tính năng đó **chưa từng tới được ai**.

**Hai lần quyền-theo-cột bắt lỗi** (0111 `shops.deleted_at`, 0113 `products.created_at`): cột
nằm trong `WHERE`/hàm gộp cũng phải xin. Cả hai đều do e2e phát hiện, không phải do đọc code.


---

## §9 — Banner mặc định cho shop mới (0114)

**Đo được, không phải phỏng đoán:** shop vừa cấp phát xong render **3 khối**
(`hero` tự-động 1 cảnh · `features` · lưới SP), trong khi 4 shop demo đủ nội dung
render **9 khối**. Nguyên nhân tách bạch được:

| Khối thiếu | Vì sao | Nền tảng lo được? |
|---|---|---|
| `hero_side`, `promo_banners` | preset seed `slides: []`, theme.js bỏ qua khối không có slide hợp lệ | **có** |
| `hero` chỉ 1 cảnh | không có banner → rơi về hero tự-động | **có** |
| `category_bar`, `category_rows` | shop chưa tạo danh mục | không — dữ liệu của họ |
| `flash_sale` | shop chưa có khuyến mãi | không — dữ liệu của họ |

Ba khối đầu mất trắng chỉ vì chưa ai tải ảnh lên. Với phương án "một bố cục cho
mọi ngành" thì đó là lỗ hổng thẳng vào lời hứa: shop mới nhìn không giống mẫu họ
vừa chọn.

**Đường đi.** `packages/banner-art` (ESM lá, zero-dep, trả về CHUỖI SVG) → signup
ghi outbox `shop.banners_seed` **cùng transaction** với `INSERT themes` (ADR-006)
→ worker vẽ 3 hero + 2 phụ + 3 promo, `sharp` ra webp, đẩy MinIO, ghi key vào
`themes.layout`. Migration 0114 cấp cho `app_worker` đúng `SELECT (shop_id,
tokens, layout)` + `UPDATE (layout)` trên `themes` — không hơn.

**Bốn quyết định đáng ghi:**

1. **Màu lấy từ `themes.tokens`, KHÔNG lấy từ preset.** Chủ shop đổi màu trước khi
   worker kịp chạy thì banner vẫn khớp. Worker cũng khỏi phải mount `packages/presets`.
2. **Không vẽ chữ vào ảnh.** theme.js đã phủ headline/sub/CTA bằng HTML
   (`.hbanner-overlay`); vẽ thêm là chữ đúp. Và image không cài fontconfig nên
   `<text>` ra ô vuông tofu — đã dính thật một lần.
3. **Idempotent theo hướng "người thật thắng máy".** Có slide rồi thì bỏ qua, kể cả
   khi chủ shop tự tải ảnh trước lúc worker chạy.
4. **Chữ mặc định cố ý trung tính** ("Hàng mới về", "Ưu đãi đang có"). Đây là banner
   chạy trên cửa hàng THẬT của người khác — không hứa hộ họ "giao trong 2 giờ".

### Preset `general` — đóng nốt nhánh "không chọn ngành" (0115)

Lỗ còn lại sau 0114: bỏ trống ngành ⇒ **không có dòng `themes`**, storefront rơi về
`DEFAULT_LAYOUT` đúng 5 khối (header · hero · lưới SP · blog · footer) — không
`hero_side`, không `promo_banners`, không `flash_sale`, không `category_bar`. Cả một
nhóm shop nhận bố cục cũ, và banner mặc định không với tới được vì không có gì để ghi.

Thêm preset thứ 5 `general` (trung tính, xanh mực + nhấn teal, cùng 12 khối). Nó đóng
**hai vai**:

- **lựa chọn "Khác / Đa ngành"** trên form — chọn có ý thì `shops.industry='general'`
  (0115 nới CHECK ở cả `shops` lẫn `shop_signups`);
- **preset rơi-về** khi để trống hoặc gửi giá trị lạ — seed theme `general` nhưng
  **`shops.industry` vẫn NULL**.

Chỗ tách đôi đó là có chủ ý: cột `industry` ghi *họ nói gì*, không phải *ta đoán gì*.
Đoán rồi lưu là bịa dữ liệu, và sau này mọi thống kê theo ngành sẽ sai.

**Bắt được lúc làm:** `packages/presets/test/presets.test.js` (14 ca, có ca khẳng định
"đúng 4 preset") **chưa từng nằm trong `scripts/test-manifest.sh`** — không cổng nào
chạy nó. Đúng lớp lỗi manifest sinh ra để chặn, ở dạng "chưa bao giờ được thêm vào".
Đã thêm; số unit 11 → 13.

**Kết quả đo lại** trên shop do chính luồng self-serve tạo: hero `hero-n1` → `hero-split
hero-n3`, thêm 2 ô phụ + 3 ô promo + 3 nút CTA, 8 ảnh banner.
