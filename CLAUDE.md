# CLAUDE.md — sổ tay làm việc cho AI

> **Quan hệ với `README.md`:** README là **bàn giao** — vì sao hệ thống thế này, đã trả giá gì để
> biết, đang đi đâu. File này là **thao tác** — chạy lệnh nào, sửa file nào, luật nào không được
> phá. Hai file không chép nhau. Gặp câu hỏi "vì sao" → README hoặc `docs/`.
>
> Sửa gì làm lệch các con số dưới đây thì **sửa luôn file này trong cùng commit**.

---

## 0. Nắm nhanh trong 60 giây

`nentang.vn` — SaaS bán hàng cho shop nhỏ Việt Nam. **Modular monolith**: 12 tiến trình Node 22
thuần (**không framework web**) + 1 stub DNS chỉ dùng cho dev/e2e, **một** PostgreSQL, cô lập
tenant bằng **RLS**. Tất cả chạy bằng Docker Compose.

**Chưa triển khai, chưa có khách thật — cố ý.** Đừng đề xuất deploy như việc ưu tiên.

| số đo | hôm nay | nguồn |
|---|---:|---|
| dòng mã ứng dụng | ~42.900 | `apps/*/src/*.js` |
| dòng test | ~30.900 | `apps/*/test/*.{js,mjs}` |
| migration | 172 tệp, mới nhất `0174` | `packages/db/migrations/` |
| bộ unit | 36 | `MANIFEST_UNIT_COUNT` |
| bộ e2e | 106 | `MANIFEST_E2E_COUNT` |
| bất biến DB | 9 bộ, 116 test TAP | `packages/db/test/*.test.js` |
| tài liệu | 74 tệp | `docs/` |

Tỉ lệ test/mã ≈ 0,71 — cao có chủ ý, xem §4.

**Toàn bộ mã, chú thích, tài liệu, commit message đều TIẾNG VIỆT.** Giữ nguyên, không dịch sang
tiếng Anh, không viết chú thích tiếng Anh trong file tiếng Việt.

---

## 1. Lệnh

```bash
# dựng stack (lần đầu / sau khi đổi Dockerfile)
docker compose -f infra/compose.dev.yml up -d --build
docker compose -f infra/compose.dev.yml run --rm migrate

# CỔNG ĐẦY ĐỦ — ~45 phút. CHỈ lệnh này exit 0 mới được nói "xanh".
bash scripts/ci-local.sh

# cổng nhanh — ~3 phút, BỎ TOÀN BỘ e2e. Không phải "xanh".
bash scripts/ci-local.sh --fast

# một bộ e2e lẻ (container mặc định là dbtest)
docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/e2e.mjs
#   ngoại lệ DUY NHẤT: apps/auth/test/e2e.mjs chạy trong container `auth`

# một bộ unit lẻ (chạy thẳng ở máy, không cần stack)
node --test apps/seller/test/lock-order.test.js

# dữ liệu thử
bash scripts/seed-demo.sh      # shop mới mở
bash scripts/seed-day60.sh     # shop ngày thứ 60 — 202 SP / 395 đơn
bash scripts/dev-lan-host.sh   # mở qua LAN (nip.io) để bấm thử trên điện thoại
```

Windows + Git Bash, đặt trước mọi lệnh docker:
`export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"; export MSYS_NO_PATHCONV=1`

**Cổng gồm 6 bước:** tiền kiểm stack chạy đủ → unit + `manifest_check` → quét bảo mật tĩnh → cô
lập tenant + bất biến schema → e2e → smoke (edge/readiness/TLS).

Hook `scripts/hooks/pre-push` chạy `--fast` và **chặn push khi đỏ**. Cài một lần cho mỗi bản
clone: `git config core.hooksPath scripts/hooks`.

---

## 2. Bản đồ mã — sửa gì thì vào đâu

```
apps/<service>/src/     mã service        apps/<service>/test/    test của nó
packages/               mã DÙNG CHUNG     packages/db/migrations/ toàn bộ SQL
infra/compose.*.yml     dàn dịch vụ       scripts/                cổng, seed, vận hành
docs/                   74 tệp ghi chép   .github/workflows/ci.yml cổng đám mây
```

| việc cần sửa | file |
|---|---|
| API nghiệp vụ shop (đơn, kho, báo cáo, KM) | `apps/seller/src/*.js` — 44 module, 1 module 1 miền |
| **HTML trang quản trị** | `apps/seller-admin/src/pages.js` (~17k dòng cả app) |
| gọi từ admin sang seller/auth | `apps/seller-admin/src/api.js` |
| cửa hàng công khai | `apps/storefront/src/` |
| giỏ + đặt hàng + tra cứu đơn của khách | `apps/checkout/src/` |
| webhook tiền (SePay) | `apps/payment/src/` |
| console chủ nền tảng | `apps/platform/src/` |
| email / Telegram / sweep định kỳ | `apps/worker/src/` |
| tenant context, khoá kết nối API | `apps/seller/src/db.js` |
| bất biến schema + least-privilege | `packages/db/test/schema-invariants.test.js` |
| cô lập tenant (RLS) | `packages/db/test/tenant-isolation.test.js`, `storefront-isolation.test.js` |
| readiness/go-live, thông báo, yêu cầu hậu mãi/RMA | `packages/db/test/readiness-go-live.test.js`, `packages/db/test/notification-integrity.test.js`, `packages/db/test/order-requests.test.js` |

Thêm bộ test mới → **phải sửa `MANIFEST_UNIT_COUNT` / `MANIFEST_E2E_COUNT` trong
`scripts/test-manifest.sh` cùng commit**, nếu không cổng đỏ. Nó so **BẰNG**, không phải ≥.

---

## 3. Luật không được phá

Mỗi dòng dưới đây từng làm hỏng một thứ có thật. Chi tiết + số đo: README §4–5, `docs/04` (11 ADR).

### Dữ liệu

- Mọi truy vấn tenant chạy trong **`withTenant(shopId, fn)`** (`apps/seller/src/db.js:11`) — nó
  `set_config('app.shop_id', …, true)` trong transaction, policy đọc qua `current_shop_id()`.
- **`GRANT` mở CỘT, `POLICY` mở DÒNG.** Thiếu một trong hai = lỗi quyền hoặc rò chéo shop.
- **`ALTER DEFAULT PRIVILEGES` (0003) tự cấp CRUD cho `app_rw` trên MỌI bảng mới.** "Tôi không
  viết GRANT" ≠ "vai đó không có quyền". Bảng mới không thuộc tenant thì phải
  `REVOKE ALL … FROM app_rw` **và** thêm policy chặn.
- **Migration BẤT BIẾN.** Runner băm nội dung — sửa file cũ → `DRIFT` → cổng đỏ. Sửa gì cũng bằng
  file mới, đánh số tiếp.
- **22 vai DB `app_*`, mỗi service một vai ít quyền nhất.** Đừng nới cho tiện. Có vai KHÔNG
  đăng nhập được, chỉ tồn tại để **sở hữu** một hàm `SECURITY DEFINER` hẹp (`app_resolution`).
- **GRANT cấp BẢNG cũ vô hiệu hoá mọi tính toán cấp CỘT về sau.** `app_rw` có `UPDATE` cấp bảng
  trên `orders` từ `0021`, nên `GRANT UPDATE (cột_mới) TO vai_khác` KHÔNG hề chặn được `app_rw`
  — column grant chỉ THÊM quyền, không thu hẹp. Muốn khoá một cột thì cần **trigger**
  `BEFORE UPDATE OF <cột>` từ chối mọi `current_user` ngoài vai được phép (`0173`). Review chỉ
  đọc `GRANT` sẽ trượt lớp lỗi này — nó lộ ra khi chạy trên DB trắng.

### Giao diện

- **Mặc định KHÔNG JavaScript.** Storefront + checkout chạy bằng form + Post-Redirect-Get. Shop
  **không được** chèn JS (ADR-008).
- JS hẹp có `nonce` **chỉ** cho seller-admin và vài chỗ đã duyệt (ADR-011). **Đường tiền giữ khoá
  cứng.** CSP nghiêm ngặt — không CDN, không font ngoài.
- **`Asia/Ho_Chi_Minh` ở MỌI chỗ hiển thị và MỌI biên lọc theo ngày.** Container chạy UTC nên
  quên `timeZone` là lệch một ngày mà **test không thấy** — đã có 54/395 đơn hiện sai ngày.
  Canh bởi `apps/seller-admin/test/date-tz.test.js`.

### Đường tiền — vùng nhạy cảm nhất

- **Chỉ webhook đối soát (hoặc thao tác tay có kiểm) mới đặt `paid`.**
- **Webhook phải khớp TÀI KHOẢN NHẬN**, không chỉ mã tham chiếu — cả `orders.qr_account` lẫn
  `PLATFORM_BANK_ACCOUNT`. SePay bắn sự kiện cho *mọi* tài khoản gắn vào nó.
- **`provider_event_id` UNIQUE** → replay không cộng hai lần.
- **Trả thiếu KHÔNG được ghi `paid`** — vào hàng đợi đối soát, có cảnh báo.
- **Khoá tồn `ORDER BY variant_id`** ở mọi vòng lặp — thứ tự cố định là thứ chống deadlock.
- **Doanh thu = `paid_at IS NOT NULL`**, không lọc `payment_status`: hoàn tiền lật
  `payment_status` nhưng **giữ** `paid_at`.
- **NULL ≠ 0** ở mọi cột tiền. Trống = "chưa biết", 0 = "biết chắc bằng không".

### Mã dùng chung — TUYỆT ĐỐI không chép ra chỗ khác

| nội dung | file | tới service | import |
|---|---|---|---|
| tồn khả dụng `on_hand − reserved − đệm` | `packages/inventory/src/safety-stock.js` | seller, checkout, storefront | `'../safety-stock.js'` |
| còn nợ khách `greatest(0, đã_thu − đã_hoàn − được_phép_giữ)` | `packages/orders/src/owed.js` | seller, checkout, account | `'../owed.js'` |
| chuẩn hoá số điện thoại khách | `packages/customer-input/src/phone.js` | seller, checkout, account | `'../phone.js'` |
| hàng rào SSRF | `packages/net-guard/src/fetch-image.js` | seller, worker | `'../fetch-image.js'` |
| bộ đếm rate-limit | `packages/auth/src/ratelimit.js` | auth, payment, … | `'../ratelimit.js'` |

**`amount_paid_vnd` là LAZY** (0077): giá trị `0` trên đơn **đã từng thu** nghĩa là *"chưa khoá"*
→ phải dùng `total_vnd`. Đọc thô cột này từng **giấu 23,8 triệu nợ**. Dùng `OWED_PAID_SQL`.

Con số "còn nợ khách" hiện ở **5 màn hình + email**, tất cả đọc **cùng một biểu thức**. Hai đầu
một cuộc tranh chấp mà đọc hai con số là phần mềm châm dầu vào lửa.

### Bind-mount — phụ thuộc VÔ HÌNH

Mỗi service build từ context riêng nên **image không chứa `packages/`**. Bốn file trên tới được
service bằng bind-mount khai trong **cả `compose.dev.yml` VÀ `compose.prod.yml`**. Dockerfile
không nhắc gì tới nó; **mất mount = container chết lúc khởi động** — cố ý: hỏng to và hỏng sớm,
hơn hẳn nhiều bản sao lặng lẽ trôi khỏi nhau (lớp lỗi đã cắn kho này ba đợt liền).

⚠️ **Đích mount khác nhau:** seller/checkout/storefront → `/app/owed.js`; còn `account` để mã ở
`/app/apps/account/src` nên đích là `/app/apps/account/owed.js`.
Canh bởi `apps/seller/test/safety-mount.test.js`.

---

## 4. Bẫy đo lường — chỗ tốn thời gian nhất

Những lỗi này **không nằm ở sản phẩm mà ở cách kiểm chứng**, và đã lặp lại nhiều lần.

- **Xanh vì lý do sai.** Khẳng định đi qua một chốt *khác* rồi tưởng đã canh chốt mình muốn.
  → **Luật: một chốt chỉ được coi là có test khi có đột biến gỡ nó và test ĐỎ, và ca thử phải đi
  qua ĐÚNG chốt đó.**
- **Fixture nói dối.** Bộ dựng dữ liệu tạo hình dạng mà mã sản phẩm không bao giờ sinh ra (từng
  đẻ 19,8 triệu "nợ ảo"). Kiểm bất biến của chính fixture trước khi tin nó.
- **Fixture "đẹp" che lỗi.** Shop ngày-60 ghi đủ mọi cột nên không bắt được lỗi lazy. Dữ liệu
  thật có đơn cũ, có đường ghi thiếu.
- **Thiếu dòng `N pass, 0 fail` trong đầu ra e2e = ĐỎ**, kể cả khi không thấy chữ FAIL.
- **`grep -E "^[0-9]+ pass"` trượt** vì mã màu ANSI đứng trước → báo đỏ giả.
- **`đ` (Latinh, worker in) ≠ `₫` (U+20AB, web in).**
- **`Number(null) === 0`** → kiểm **có mặt** trước khi kiểm kiểu số.
- **`fetch` của Node CẤM đặt header `Host`** → dùng `http.request` khi service phân giải shop
  theo tên miền, không thì mọi lời gọi ra 404 "tên miền chưa kết nối".
- **Backtick trong chú thích nằm trong template literal** cắt đứt chuỗi; lỗi báo ở dòng rất xa.
- **Đo CHÊNH LỆCH, đừng đo tuyệt đối** trên bảng tích luỹ.
- Chạy e2e hàng loạt: **xả `rl:*` trong Redis trước từng bộ**, không thì bộ sau ăn 429 và đỏ vì
  lý do không liên quan (`ci-local.sh` đã làm sẵn — nhớ khi chạy tay nhiều bộ).
- Log e2e cũ nằm lại `/tmp/va-e2e-*.log` từng bị đọc nhầm thành hiện trường lần chạy này. Bất
  biến hiện tại: **còn tệp sau khi chạy xong ⇒ bộ đó đỏ TRONG chính lần này.**

---

## 5. Quy trình sửa một việc

1. **Đo trước khi viết.** Chạy truy vấn trên dữ liệu thật, tìm con số. Gần như lần nào lỗ hổng
   cũng rộng hơn mô tả ban đầu.
2. **Tự đóng vai mà đi lại từng màn hình.** Bốn vai đã đi: shop mới mở · khách mua · shop ngày
   thứ 60 · **shop lúc có sự cố** (vai thứ tư ra nhiều lỗi nhất — `docs/65`).
3. **Vá, rồi viết test vĩnh viễn** — khẳng định nói *hậu quả*, không nói *hành vi*.
4. **Đột biến:** sửa mã cho hỏng → chạy → **phải ĐỎ** → khôi phục → **phải XANH**.
5. **Hồi quy** các bộ của service đang sửa.
6. **Cổng kiểm chứng** rồi commit + push.

**Chọn cổng nào** (đã thống nhất sau khi chạy thừa 4 lần trong một ngày):

| phạm vi sửa | cổng |
|---|---|
| gói dùng chung · migration · compose · nhiều service | **đầy đủ** |
| một service một nhánh | `--fast` + các bộ e2e của đúng service đó |
| chỉ test / tài liệu | chạy đúng bộ đó |

**Gộp việc: gác đầy đủ MỘT LẦN mỗi phiên trước khi push**, không phải sau mỗi đợt nhỏ.

Đợt lớn để lại một tệp trong `docs/`, số tăng dần, **kèm cả lỗi của chính mình** — đó là phần có
giá trị nhất khi đọc lại.

---

## 6. Quy ước viết mã

- ESM (`"type": "module"`), Node ≥ 22, `node --test`. **Không có eslint/prettier** — bám theo
  phong cách file xung quanh.
- **Không framework web.** HTTP thuần (`node:http`), routing viết tay, HTML nối chuỗi bằng
  template literal.
- **Chú thích nói *vì sao*, kèm *số đo thật* và *hậu quả nếu làm khác*** — không nói "hàm này làm
  gì". Đọc `packages/orders/src/owed.js` để thấy chuẩn mực; chú thích ở kho này thường dài hơn mã
  và đó là **cố ý**.
- `apps/worker/src` **không** bind-mount ⇒ sửa xong phải
  `docker compose -f infra/compose.dev.yml up -d --build worker`. Service khác chỉ cần `restart`.

---

## 7. Hỏi trước khi tự quyết

- **Giá gói / trần sản phẩm** (`0006`) — `platform` và `care` cùng trần 100 SP nên gói giữa hiện
  không bán được cho ai. Đó là **quyết định kinh doanh**, không phải lỗi kỹ thuật.
- **Năm mục "cố ý chưa làm"** ở README §7 — mỗi mục có ngưỡng riêng để làm. Đừng "sửa" khi chưa
  đạt ngưỡng.
- **Nới quyền của một vai `app_*`** — luôn có cách khác, và cách khác thường đúng hơn.
- **Đề xuất deploy** — chưa triển khai là lựa chọn có chủ ý.

---

## 8. Tra tài liệu ở đâu

Đọc theo **chủ đề**, không theo số.

| cần gì | đọc |
|---|---|
| kiến trúc, dữ liệu, hạ tầng | `docs/01`, `02`, `03`, `06` |
| **11 quyết định kiến trúc** — đọc trước khi định làm khác | **`docs/04`** |
| xác thực & quyền | `07`, `08`, `10`, `29`, `59` · **`73` cửa vào + wizard thiết lập đầu tiên** |
| bán hàng | `11` catalog · `12` kho/ảnh · `13` storefront · `14` checkout · `38` flash sale · `56` biến thể |
| **thiết kế giao diện** | **`44` bảng điều khiển người bán · `72` cửa hàng công khai** — ngân sách token, thang chữ, nhịp 4px · `73` trang đăng nhập/đăng ký |
| di cư từ sàn khác | `45` khung chung (Shopify/Haravan) · **`70` TikTok Shop — quyết định + số đo** · `71` brief thi công (tự chứa, đưa cho người ngoài) |
| tiền | `15`,`16` QR · `37` lãi lỗ · `41` điểm · `49` thuê bao · `51`–`53` săn lỗ tiền · `54` sửa đơn · `55` tiền lạc · `66` công nợ · `67` tranh chấp · `68` email · `69` phí ship |
| vận hành | `22` bootstrap · `23` backup · `27` observability · `31` CI · `32` test local · `33` sổ tay · `35` go-live · `36` PII |
| **vì sao kho này khắt khe** | `61` "không biết ≠ chưa xảy ra" · `62` tồn an toàn · `63` đo luồng dùng · `64` vai ngày-60 · `65` vai lúc sự cố |
