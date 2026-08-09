# nentang.vn — bàn giao hệ thống

> **Đọc file này trước.** Nó viết cho một người (hoặc một AI) chưa từng thấy kho này, cần hiểu
> đủ để làm việc mà không phải khám phá lại những thứ đã trả giá để biết.
>
> Cập nhật: **2026-08-06.** Nếu bạn sửa gì lớn, sửa luôn file này.

---

## 1. Đây là gì

Nền tảng **SaaS bán hàng online cho shop nhỏ ở Việt Nam** — mỗi shop có cửa hàng riêng (tên
miền riêng), tự đăng sản phẩm, nhận đơn, thu tiền COD/chuyển khoản, in vận đơn, xem lãi lỗ.
Đối thủ tham chiếu: Haravan, Sapo, KiotViet; và về nghiệp vụ sản phẩm thì học Shopee/TikTok Shop.

- **Người dùng cuối 1 — chủ shop:** đăng nhập trang quản trị, quản lý hàng/đơn/tiền.
- **Người dùng cuối 2 — khách của shop:** vào cửa hàng, mua, tra cứu đơn (có hoặc không có tài khoản).
- **Người dùng cuối 3 — chủ nền tảng (bạn):** console riêng, quản lý shop, thu tiền thuê bao.

**Mô hình tiền:** shop trả thuê bao theo gói, chuyển khoản VietQR, đối soát tự động qua SePay.
Dùng thử 14 ngày; hết hạn có **7 ngày ân hạn** rồi khoá bán.

| gói | giá/tháng | trần sản phẩm |
|---|---:|---:|
| `platform` | 990.000₫ | 100 |
| `care` | 2.490.000₫ | 100 |
| `growth` | 5.900.000₫ | 500 |

> **Câu hỏi đóng gói còn bỏ ngỏ, chờ chủ dự án quyết:** `platform` và `care` **cùng** trần 100
> sản phẩm. Một shop thời trang bình thường ở ngày thứ 60 đã có ~200 SP, nên không ai có lý do
> trả 2,49 triệu — gói giữa hiện không bán được cho ai. Đây là quyết định kinh doanh, không
> phải lỗi kỹ thuật; đừng tự sửa số trong `0006`, hãy hỏi.

**Giai đoạn hiện tại: CHƯA TRIỂN KHAI, chưa có khách thật.** Đây là **lựa chọn có chủ ý** của
chủ dự án, không phải thiếu sót — đừng đề xuất deploy như việc ưu tiên, và đừng xếp các việc
phụ thuộc VPS lên đầu danh sách.

---

## 2. Chạy thử trong 4 lệnh

```bash
docker compose -f infra/compose.dev.yml up -d --build
```

```bash
docker compose -f infra/compose.dev.yml run --rm migrate
```

```bash
bash scripts/ci-local.sh --fast
```

```bash
docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/e2e.mjs
```

Trên Windows + Git Bash phải có `export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"`
và `export MSYS_NO_PATHCONV=1` trước mọi lệnh docker.

**Cổng kiểm chứng:** `bash scripts/ci-local.sh` (đầy đủ, ~45 phút) hoặc `--fast` (~3 phút, bỏ
e2e). Chỉ được nói "xanh" khi lệnh đầy đủ `exit 0`. Danh sách test là **nguồn chung** giữa CI
đám mây và CI máy: `scripts/test-manifest.sh` — thêm/bớt bộ test thì phải sửa con số trong đó
cùng commit, nếu không cổng đỏ.

Hôm nay: **24 bộ unit · 101 bộ e2e · 88 bất biến DB · 3 smoke.**

---

## 3. Kiến trúc

**Modular monolith, không microservice** (ADR-001): nhiều tiến trình Node thuần (không framework
web), **một** PostgreSQL, cô lập tenant bằng **RLS** (ADR-002).

| service | vai DB | việc |
|---|---|---|
| `auth` | `app_auth` | đăng nhập, phiên, MFA, mời thành viên, đặt lại mật khẩu |
| `platform` | `app_platform` | console chủ nền tảng: shop, gói, thuê bao, hỗ trợ |
| `seller` | `app_rw` | API nghiệp vụ shop: sản phẩm, đơn, kho, báo cáo, khuyến mãi |
| `seller-admin` | *(không DB)* | BFF + toàn bộ HTML trang quản trị (gọi sang `seller`/`auth`) |
| `storefront` | `app_store` | cửa hàng công khai (đọc) |
| `checkout` | `app_checkout` | giỏ, đặt hàng, trang tra cứu đơn của khách |
| `account` | `app_customer` | tài khoản khách của shop: lịch sử đơn, sổ địa chỉ |
| `payment` | `app_payment` | webhook SePay: tiền khách trả shop **và** tiền shop trả nền tảng |
| `signup` | `app_signup` | tự đăng ký shop công khai |
| `messenger` | `app_messenger` | bot Facebook Messenger chốt đơn trong chat |
| `worker` | `app_worker`, `app_expiry`, `app_loyalty`, `app_billing`, `app_affiliate` | outbox → email/Telegram, mọi sweep định kỳ |
| `tls-authorize` | `app_tls` | cấp chứng chỉ on-demand cho tên miền khách (ADR-003) |

Hạ tầng: `caddy` (TLS, nén, định tuyến theo tên miền) · `postgres` · `redis` (rate-limit, đếm
lượt dùng) · `minio` (ảnh) · `migrate` (chạy một lần).

**17 vai DB `app_*`, mỗi service một vai ít quyền nhất.** Vai nào đọc/ghi được bảng nào là một
quyết định bảo mật — đừng nới cho tiện.

---

## 4. Luật bất di bất dịch

Đây là phần đắt nhất của tài liệu này. Mỗi dòng dưới đây từng làm hỏng một thứ có thật.

### Dữ liệu

- **RLS `FORCE` trên mọi bảng có `shop_id`.** Truy vấn phải chạy trong `withTenant(shopId, …)`,
  nó `set_config('app.shop_id')` rồi mọi policy dùng `current_shop_id()`.
- **`GRANT` mở CỘT, `POLICY` mở DÒNG.** Thiếu một trong hai là hoặc lỗi quyền, hoặc rò chéo shop.
- **`ALTER DEFAULT PRIVILEGES` (0003) TỰ CẤP CRUD cho `app_rw` trên MỌI bảng mới.** Nghĩa là
  "tôi không viết GRANT" ≠ "vai đó không có quyền". Bảng mới không dành cho tenant thì phải
  `REVOKE ALL … FROM app_rw` **và** thêm policy chặn.
- **Migration là BẤT BIẾN.** Runner băm nội dung; sửa file cũ → `DRIFT` → cổng đỏ. Sửa gì cũng
  bằng file mới. Hiện có **146 tệp**, mới nhất `0147`.
- **Bất biến schema** (`scripts/`, 88 khẳng định) canh những thứ như "mọi bảng có `shop_id` phải
  có policy", "không policy nào của `app_rw` dùng biểu thức hằng `true`".

### Giao diện

- **Mặc định KHÔNG JavaScript.** Storefront và checkout chạy bằng form + Post-Redirect-Get.
  Shop **không được** chèn JS (ADR-008).
- **JS hẹp có `nonce` CHỈ cho seller-admin và vài chỗ đã duyệt** (ADR-011); đường tiền giữ khoá
  cứng. CSP nghiêm ngặt — không CDN, không font ngoài.
- **Giờ Việt Nam (`Asia/Ho_Chi_Minh`) ở MỌI chỗ hiển thị và mọi biên lọc theo ngày.** Container
  chạy UTC nên quên `timeZone` là lệch một ngày mà test không thấy (đã mất 54/395 đơn hiện sai
  ngày một lần — `apps/seller-admin/test/date-tz.test.js` sinh ra từ đó).

### Mã dùng chung giữa các service

Mỗi service build từ context riêng nên image **không chứa `packages/`**. File dùng chung tới
được bằng **bind-mount khai trong cả hai compose**:

| file | tới service | import |
|---|---|---|
| `packages/inventory/src/safety-stock.js` | seller, checkout, storefront | `'../safety-stock.js'` |
| `packages/orders/src/owed.js` | seller, checkout, account | `'../owed.js'` |
| `packages/net-guard/…` | seller, worker | hàng rào SSRF |
| `packages/auth/src/ratelimit.js` | auth, payment, … | bộ đếm rate-limit |

Đây là **phụ thuộc vô hình**: Dockerfile không nhắc tới nó, mất mount thì container **chết lúc
khởi động**. `apps/seller/test/safety-mount.test.js` canh chuyện đó. **Chú ý đích mount khác
nhau**: `account` để mã ở `/app/apps/account/src` nên đích là `/app/apps/account/owed.js`, còn
seller/checkout là `/app/owed.js`.

---

## 5. Đường tiền — vùng nhạy cảm nhất

Mọi thay đổi ở đây phải có test + **đột biến** chứng minh.

### Bất biến

- **Chỉ webhook đối soát (hoặc thao tác tay có kiểm) mới đặt `paid`.**
- **Webhook phải khớp TÀI KHOẢN NHẬN**, không chỉ mã tham chiếu — cho cả tiền khách trả shop
  (`orders.qr_account`) lẫn tiền shop trả nền tảng (`PLATFORM_BANK_ACCOUNT`). SePay bắn sự kiện
  cho *mọi* tài khoản gắn vào nó; thiếu chốt này là cộng tiền cho khoản nằm ở tài khoản khác.
- **`provider_event_id` UNIQUE** → replay không cộng hai lần.
- **Trả thiếu KHÔNG được ghi `paid`**; khoản đó vào hàng đợi đối soát và có cảnh báo.
- **Khoá tồn theo `ORDER BY variant_id`** ở mọi vòng lặp — thứ tự cố định là thứ chống deadlock.
  Bất biến `apps/seller/test/lock-order.test.js` tìm **đúng chuỗi** đó, không tiền tố.

### Ba công thức phải dùng chung, không được chép

1. **Tồn khả dụng** — `packages/inventory/src/safety-stock.js`: `on_hand − reserved − đệm`.
2. **Còn nợ khách** — `packages/orders/src/owed.js`:
   `greatest(0, đã_thu − đã_hoàn − được_phép_giữ)`, trong đó *được phép giữ* = `total_vnd` khi
   đơn còn sống, **0** khi đơn chết (`cancelled|returned|refunded`).
3. **`amount_paid_vnd` là LAZY** (0077): giá trị `0` trên đơn **đã từng thu** nghĩa là *"chưa
   khoá"* → phải dùng `total_vnd`. Đọc thô cột này từng **giấu 23,8 triệu nợ** trên DB dev.
   Dùng `OWED_PAID_SQL`, đừng tự viết lại.

Con số "còn nợ khách" hiện ở **bốn nơi + email**: trang Công nợ · ô Tổng quan · băng đỏ trên
đơn · trang tra cứu của khách · lịch sử đơn khách · email đổi trạng thái. **Tất cả đọc cùng một
biểu thức.** Hai đầu một cuộc tranh chấp mà đọc hai con số là phần mềm châm dầu vào lửa.

### Quy tắc sổ cái

- **Doanh thu = đơn ĐÃ TỪNG thanh toán** (`paid_at IS NOT NULL`), không lọc theo
  `payment_status` — hoàn tiền lật `payment_status` nhưng **giữ** `paid_at`, lọc sai thì đơn
  rớt ngược khỏi kỳ đã đóng.
- **Phiếu hoàn trừ tại NGÀY PHIẾU**, trừ `kind='edit_adjustment'` (đã phản ánh qua header đơn).
- **Phí vận chuyển** gồm cước hãng đồng bộ + cước giao tay do shop nhập + **cước chiều về** khi
  bị bom (`orders.return_fee_vnd`, ghi ở kỳ `returned_at`).

---

## 6. Đã làm được gì

**Lõi bán hàng:** sản phẩm + biến thể đa trục · danh mục 2 cấp · kho + sổ cái kho + tồn an toàn
· giỏ + checkout no-JS · COD & QR · vận đơn GHN/GHTK + giao tay + tách kiện · trạng thái đơn
đầy đủ + email mọi bước.

**Tiền:** hoàn tiền (toàn phần/một phần) · đổi-trả RMA · sửa đơn chưa-trả và đã-trả · đối soát
COD với hãng · **báo cáo lãi lỗ** có giá vốn bình quân gia quyền · **công nợ khách** · chi phí
vận chuyển thực trả.

**Bán hàng nâng cao:** khuyến mãi/flash sale · mã giảm giá · điểm thưởng · cộng tác viên (hoa
hồng) · đánh giá có ảnh · hỏi-đáp · yêu thích · tài khoản khách · nhập hàng + kiểm kê.

**Kênh:** cửa hàng riêng theo tên miền · bot Messenger chốt đơn · nhập đơn từ nguồn ngoài · di
cư từ sàn khác (CSV + ảnh theo URL).

**Vận hành SaaS:** tự đăng ký shop · onboarding có checklist · 5 preset giao diện theo ngành ·
shop tự trả tiền thuê bao + ân hạn + khoá · kênh hỗ trợ hai chiều · backup mã hoá + PITR ·
giám sát + cảnh báo đường tiền · đo luồng dùng tính năng.

**Chất lượng:** ~101 bộ e2e, hàng nghìn khẳng định; kiểm toán tấn công 0 crit/0 high; nhiều đợt
săn "lỗi hợp thành" đã vá hàng chục lỗ tiền/kho/quyền.

---

## 7. Cố ý CHƯA làm — và ngưỡng để làm

Đừng "sửa" những mục này khi chưa đạt ngưỡng; chúng đã được cân nhắc và có đường lùi an toàn.

| việc | vì sao hoãn | ngưỡng để làm |
|---|---|---|
| Hoàn **điểm thưởng thừa** khi sửa đơn xuống (docs/54) | cần nới quyền ghi sổ điểm cho vai seller — rủi ro thật cho một ca hiếm. Hiện chặn bằng `422` + "huỷ rồi đặt lại", và huỷ **có** hoàn điểm | có shop thật dùng điểm **và** sửa đơn thường xuyên |
| **Cộng dồn** thanh toán từng phần cho hoá đơn nền tảng (docs/55) | cần cột `paid_vnd` + nghĩ lại ca chuyển dư. Hiện khoản thiếu vào hàng đợi và **có cảnh báo ở ngưỡng 1** | `amount_short` xuất hiện đều đặn |
| Shop **không được báo** khi tiền thuê bao của họ vào hàng đợi | `platform_unmatched_transfers` không có `shop_id`; cho vai tenant đọc bảng cấp nền tảng là thứ 0128 cố ý gỡ | có shop thật kêu |
| Trang tạo phiếu nhập **651 KB** | chậm, không sai | shop có nhiều SP kêu |
| Cảnh báo chủ động khi **nợ khách quá hạn** | màn hình đã có, cột `since` đã sẵn | có nợ thật để nhắc |

---

## 8. Bẫy đo lường — đọc kỹ, đây là chỗ tốn thời gian nhất

Những lỗi này **không nằm ở sản phẩm mà ở cách kiểm chứng**, và đã lặp lại nhiều lần.

- **Xanh vì lý do sai.** Khẳng định đi qua một chốt *khác* rồi tưởng đã canh chốt mình muốn.
  → **Luật: một chốt chỉ được coi là có test khi có đột biến gỡ nó và test ĐỎ, và ca thử phải
  đi qua ĐÚNG chốt đó.**
- **Fixture nói dối.** Bộ dựng dữ liệu tạo ra hình dạng mà mã sản phẩm không bao giờ sinh ra
  (từng tạo 19,8 triệu "nợ ảo"). **Kiểm bất biến của chính fixture trước khi tin nó.**
- **Fixture "đẹp" che lỗi.** Shop ngày-60 luôn ghi đủ cột nên không bắt được lỗi `amount_paid`
  lazy. Dữ liệu thật có đơn cũ, có đường ghi thiếu.
- **`đ` không phải `₫`.** Worker in `đ` (chữ Latinh), web in `₫` (U+20AB).
- **`Number(null) === 0`** → phải kiểm **có mặt** trước khi kiểm kiểu số.
- **`fetch` của Node CẤM đặt header `Host`** → dùng `http.request` khi service phân giải shop
  theo tên miền, nếu không mọi lời gọi ra 404 "tên miền chưa kết nối".
- **Backtick trong chú thích nằm trong template literal** cắt đứt chuỗi; lỗi báo ở dòng rất xa.
- **`grep -E "^[0-9]+ pass"`** trượt vì mã màu ANSI đứng trước → báo đỏ giả.
- **Đo CHÊNH LỆCH, đừng đo tuyệt đối** trên bảng tích luỹ.
- **NULL ≠ 0** ở mọi cột tiền: trống = "chưa biết", 0 = "biết chắc bằng không".

---

## 9. Cách làm việc ở kho này

Quy trình đã chứng minh hiệu quả, theo đúng thứ tự:

1. **Đo trước khi viết.** Chạy truy vấn trên dữ liệu thật, tìm con số. Gần như lần nào lỗ hổng
   cũng rộng hơn mô tả ban đầu.
2. **Tự đóng vai mà đi lại từng màn hình.** Bốn vai đã đi: shop mới mở · khách mua · shop ngày
   thứ 60 (202 SP/395 đơn, `scripts/seed-day60.sh`) · shop **lúc có sự cố**. Vai thứ tư ra
   nhiều lỗi nhất.
3. **Vá, rồi viết test vĩnh viễn** — khẳng định phải nói *hậu quả*, không nói *hành vi*.
4. **Đột biến:** sửa mã cho hỏng → chạy → **phải ĐỎ** → khôi phục → **phải XANH**.
5. **Hồi quy** các bộ của service đang sửa.
6. **Cổng kiểm chứng** (xem §2) rồi commit + push.

**Luật gác cổng** (đã thống nhất sau khi chạy thừa 4 lần trong một ngày):

- gói dùng chung · migration · compose · trải nhiều service → **cổng đầy đủ**;
- một service một nhánh → `--fast` + các bộ e2e của đúng service đó;
- chỉ test/tài liệu → chạy đúng bộ đó;
- **gộp việc: gác đầy đủ MỘT LẦN mỗi phiên trước khi push**, không phải sau mỗi đợt nhỏ.

Ghi chép: mỗi đợt lớn để lại một tệp trong `docs/`, đánh số tăng dần, **kèm cả những lỗi của
chính mình** — đó là phần có giá trị nhất khi đọc lại.

---

## 10. Hướng phát triển

**Nút thắt thật không phải kỹ thuật.** Về mã, hệ thống ở mức khá vững (~85%): đường tiền, kho,
chống bán quá tồn đều ở mức chạy thật được. Nhưng **chưa có người dùng thật nào**, nên mọi
tính năng thêm vào đều là phỏng đoán.

Việc rẻ nhất để giảm rủi ro đó, **không cần deploy**: cho **một** người bán hàng thật ngồi bấm
thử qua link LAN (`bash scripts/dev-lan-host.sh` → nip.io) khoảng nửa tiếng, chỉ ngồi nhìn,
không hướng dẫn. Chỗ họ khựng lại sẽ định hướng lại toàn bộ danh sách việc.

**Ba việc kỹ thuật đáng làm tiếp** (theo thứ tự tôi đề nghị):

1. Cảnh báo chủ động khi **nợ khách quá hạn** — hạ tầng đã sẵn, biến màn hình từ *tra cứu được*
   thành *không bỏ sót được*.
2. Tổng hợp **"tháng này mất bao nhiêu vì bom hàng"** — số đã có trong P&L nhưng lẫn vào dòng
   phí vận chuyển chung.
3. Trang phiếu nhập 651 KB.

**Trước khi có khách trả tiền đầu tiên** (không thương lượng): floating IP · `.env` production
đủ secret (đặc biệt `PLATFORM_BANK_ACCOUNT` cho **cả** `platform` lẫn `payment`) · diễn tập
khôi phục backup.

---

## 11. Bản đồ tài liệu `docs/`

73 tệp. Đọc theo chủ đề, không đọc theo số.

- **Nền móng:** `01` kiến trúc · `02` mô hình dữ liệu & bảo mật · `03` hạ tầng · **`04` ADR
  (11 quyết định, đọc trước khi định làm khác)** · `06` cô lập tenant.
- **Xác thực & quyền:** `07`, `08`, `10`, `29`, `59`.
- **Bán hàng:** `11` catalog · `12` kho/ảnh · `13` storefront · `14` giỏ/checkout · `24` giao
  diện mua · `38` flash sale · `56` biến thể.
- **Tiền:** `15`,`16` QR · `37` báo cáo lãi lỗ · `41` điểm thưởng · `49` shop trả thuê bao ·
  `51`,`52`,`53` các đợt săn lỗ tiền · `54` sửa đơn & giảm giá · `55` tiền lạc · `60` báo cáo &
  bộ lọc · **`66` công nợ khách · `67` khách lúc tranh chấp · `68` email nói về tiền · `69` chi
  phí vận chuyển**.
- **Vận hành:** `22` bootstrap · `23` deploy/backup · `27` observability · `31` CI · `32` test
  local · `33` sổ tay vận hành · `35` go-live · `36` PII.
- **Tăng trưởng:** `39` tài khoản khách · `40` nhập hàng · `42` GPS/km · `43` self-serve · `45`
  di cư · `46` hỗ trợ · `47`,`48` Facebook/Messenger · `50` onboarding · `51` CTV · **`70` nhập
  từ TikTok Shop** (đo trên file xuất thật — đọc cùng `45`) · `71` brief thi công tự chứa.
- **Bài học phương pháp (đọc nếu muốn hiểu *vì sao* kho này khắt khe):** `61` "không biết ≠ chưa
  xảy ra" · `62` tồn an toàn · `63` đo luồng dùng · **`64` vai shop ngày-60 · `65` vai shop lúc
  có sự cố**.

---

## 12. Vài quy ước nhỏ nhưng hay vấp

- Toàn bộ mã, chú thích, tài liệu, thông điệp commit đều **tiếng Việt**. Giữ nguyên.
- Chú thích trong mã nói **vì sao**, kèm **số đo thật** và **hậu quả nếu làm khác** — không nói
  "hàm này làm gì".
- `apps/worker/src` **không** bind-mount ⇒ sửa xong phải `docker compose … up -d --build worker`.
  Các service khác chỉ cần `restart`.
- Bộ chạy e2e hàng loạt: xả `rl:*` trong Redis **trước từng bộ**, nếu không bộ sau ăn 429 và đỏ
  vì lý do không liên quan.
- Thiếu dòng `N pass, 0 fail` trong đầu ra e2e = **ĐỎ**, kể cả khi không thấy chữ FAIL.
