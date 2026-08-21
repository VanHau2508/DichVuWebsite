# CLAUDE.md — sổ tay làm việc cho AI

> **Bắt đầu ở đây.** File này tự nạp khi mở Claude Code trong kho — không cần ai bảo đọc.
> Nếu bạn đang đọc nó vì được yêu cầu (chat thường + connector GitHub chẳng hạn) thì đọc
> **§9 trước**: nó nói đang làm tới đâu, bạn đóng vai nào, và câu nào đang chờ người quyết.
> Tự nạp CHỈ file này — `README.md` và `docs/` phải tự mở.

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
| dòng mã ứng dụng | ~43.200 | `apps/*/src/*.js` |
| dòng test | ~31.400 | `apps/*/test/*.{js,mjs}` |
| migration | 174 tệp, mới nhất `0176` | `packages/db/migrations/` |
| bộ unit | 38 | `MANIFEST_UNIT_COUNT` |
| bộ e2e | 106 | `MANIFEST_E2E_COUNT` |
| bất biến DB | 9 bộ, 120 test TAP | `packages/db/test/*.test.js` |
| tài liệu | 80 tệp | `docs/` |

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

**Cổng gồm 7 bước:** tiền kiểm stack chạy đủ → unit + `manifest_check` → **migration từ DB
TRẮNG** → quét bảo mật tĩnh → cô lập tenant + bất biến schema → e2e → smoke (edge/readiness/TLS).

Bước "DB trắng" (`scripts/fresh-migration-gate.sh`) chạy **cả ở `--fast`** và là bản DÙNG CHUNG
với GitHub CI. Nó tự dựng PostgreSQL trắng trong project Compose riêng (tên duy nhất mỗi lượt),
chạy đúng runner production **không seed**, rồi so ba chiều: số file = `MANIFEST_MIGRATION_COUNT`
= số dòng thật trong `schema_migrations`, kèm 0 DRIFT / 0 pending. Tự dọn bằng `trap` ở mọi đường
thoát, kể cả Ctrl-C. **Không chạm DB dev.** Thêm migration thì sửa `MANIFEST_MIGRATION_COUNT`
trong cùng commit — đếm theo **FILE**, không theo số thứ tự (hôm nay 174 file / số cao nhất 0176).

Hook `scripts/hooks/pre-push` chạy `--fast` và **chặn push khi đỏ**. Cài một lần cho mỗi bản
clone: `git config core.hooksPath scripts/hooks`.

---

## 2. Bản đồ mã — sửa gì thì vào đâu

```
apps/<service>/src/     mã service        apps/<service>/test/    test của nó
packages/               mã DÙNG CHUNG     packages/db/migrations/ toàn bộ SQL
infra/compose.*.yml     dàn dịch vụ       scripts/                cổng, seed, vận hành
docs/                   76 tệp ghi chép   .github/workflows/ci.yml cổng đám mây
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
- **Khẳng định trên TOÀN văn bản thay vì trên bề mặt đang kiểm.** Khẳng định "vai này không
  thấy ô Sắp hết hàng" đem `/Sắp hết hàng/` quét cả trang — mà trang còn một thẻ tồn thấp
  khác ngoài lưới, nên nó đỏ dù lưới đã lọc đúng. Lần này đỏ giả; cùng lỗi ở chiều ngược lại
  là **xanh giả**. Cắt đúng khối rồi mới khớp (`<a class="todo-cell"…>` chẳng hạn).
- **`[^{}]*` KHÔNG băng qua `${…}` trong template literal.** Regex kiểu
  `/\{[^{}]*label: 'X'[^{}]*\}/` để cắt một phần tử mảng sẽ khớp RỖNG ngay khi phần tử đó
  chứa `${base}` — và `assert.match('', …)` thì báo lỗi mơ hồ, còn `assert.doesNotMatch` thì
  XANH GIẢ. Mỗi phần tử một dòng thì cắt theo DÒNG, đừng cắt theo cặp ngoặc.
- **Chốt mức mã nguồn đếm CHỖ VIẾT, không đếm thứ đã render.** Lưới năm thẻ trạng thái là
  MỘT `.map()` — chốt đòi "≥7 link" sẽ đỏ dù mã đúng.
- **Mọi bộ e2e đều đăng nhập bằng `owner`** — vai có sẵn mọi quyền. Nghĩa là NHÁNH THIẾU
  QUYỀN của giao diện gần như chưa từng được đi qua: vai `catalog_manager` gặp trang lỗi ngay
  sau khi đăng nhập suốt một thời gian dài mà 106 bộ e2e vẫn xanh. Đụng tới quyền thì phải
  `addMember(staff, shopId, '<vai>')` rồi đăng nhập lại bằng vai đó, không suy từ bảng quyền.
- **Sửa `src` xong mà quên `restart` container ⇒ ĐỎ GIẢ trông y hệt lỗi sản phẩm.** `src` của
  các service (trừ worker) có bind-mount nên tệp trên đĩa đổi ngay, **nhưng tiến trình Node đã
  nạp module vào bộ nhớ lúc khởi động** — nó vẫn chạy mã cũ. Đã đốt một lượt e2e vì chuyện này.
  `docker compose -f infra/compose.dev.yml restart seller-admin` là đủ; **không cần rebuild**
  (rebuild cũng chữa được, chỉ là chậm hơn nhiều lần và làm người ta tưởng nguyên nhân là image).
- **Chốt "khoảng cách" khác chốt "phạm vi khối".** Bất biến mã nguồn kiểu "điều kiện gác phải
  nằm trong N dòng quanh link" là kiểm KHOẢNG CÁCH: cửa sổ hẹp quá thì đỏ giả (form `/activate`
  nằm 3 dòng dưới điều kiện của nó), rộng quá thì nhận nhầm điều kiện của khối bên cạnh. Không
  có regex nào chữa được chuyện đó — thứ bù lại là **ma trận đột biến**, chạy lại mỗi khi sửa
  cửa sổ.
- **Đo bằng trình duyệt thì phải kiểm CHÍNH PHÉP ĐO trước.** `chrome --headless` (new
  headless) **bỏ qua `--window-size`** và luôn dựng khung nhìn 500px; phải dùng
  `headless_shell`. Một lượt đo 360px đã chạy trọn ở 500px trước khi bị phát hiện — dấu hiệu
  là mọi trang ra **cùng một con số**, kể cả khung ngoài cùng. Probe phải TỰ CHỐI khi
  `innerWidth` khác giá trị mong đợi, thay vì trả một con số sai.
- **`Array.isArray` trả FALSE trên Proxy bọc HÀM.** Dữ liệu thử kiểu Proxy mà đích là hàm
  (để gọi được) sẽ làm mọi khối sau `Array.isArray(...)` bị bỏ qua — `pages.js` có 31 chốt
  như vậy. Đích phải là MẢNG. Lỗi này im lặng theo chiều nguy hiểm: khối không render thì
  phép so vẫn "bằng nhau".
- **So "biến thể tốt nhất" là xanh giả.** Bộ so chạy hàm render với nhiều số-đối-số rồi giữ
  biến thể nhiều hàng nhất sẽ bỏ sót đúng thứ vừa sửa, nếu thứ đó chỉ dựng được ở biến thể
  khác. Phải so MỌI biến thể.
- **Chuẩn hoá trước khi so phải HẸP và có chủ đích.** Bỏ khoảng trắng kề thẻ cấu trúc bảng
  thì đúng (bộ phân tích HTML cũng vứt); collapse toàn cục thì `<td>a b</td>` và `<td>ab</td>`
  hoá giống nhau — giấu mất lỗi nuốt chữ. Thứ tự thuộc tính thì vô nghĩa, sắp xếp được.
- **Schema runtime phải đọc từ `pg_class` / `pg_policies`, không suy bằng grep migration.**
  `0004_rls.sql` bật RLS và tạo policy qua vòng lặp động cho mọi bảng có `shop_id`; tìm
  `ALTER TABLE <tên>` viết thẳng từng dẫn tới finding CAO sai và suýt sinh migration trùng
  policy. Không truy vấn được schema thì ghi "chưa xác minh", đừng khẳng định.

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
- **Vai nào thấy gì trên Tổng quan** — câu đang treo, chi tiết ở §9.3. Dấu hiệu chung để
  nhận ra loại này: khi có **ba phương án đều code được và khác nhau ở hậu quả kinh doanh**,
  thì đó là quyết định đội lốt thi công. Ai gõ trước là người chọn — nên đừng gõ, hãy hỏi.

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

---

## 9. Đang làm gì — đọc trước khi nhận việc

> Mục này là thứ DUY NHẤT trong file thay đổi mỗi lát cắt. **Đóng một lát cắt thì cập nhật
> mục này trong cùng commit**, y như các con số ở §0. Phần trên file là hệ thống, mục này là
> hiện trạng — đừng trộn hai thứ.

### 9.1 Ai làm gì

Ba bên, và ranh giới KHÔNG phải "thiết kế / code" mà là **đo + quyết / dựng + kiểm**:

| việc | ai |
|---|---|
| đi đo (grep xuyên hệ thống, tự đóng vai từng vai), ra bản đồ + defect **có số đo** | Claude |
| chọn giữa các phương án **cùng đúng** | chủ dự án |
| viết code, viết test, chạy Docker/CI, vá lỗi dang dở | Codex |
| review diff trước khi merge | Claude |

Hai luật giữ cho nó không hỏng:

1. **Việc có hơn một đáp án đúng thì về tay chủ dự án, không về tay người gõ trước.** Ba
   phương án đều code được nghĩa là đang có một quyết định kinh doanh đội lốt thi công.
2. **Người viết code không phải người duy nhất tuyên bố xanh.**

Lý do có luật 2, đo được ở chính kho này: test do cùng tác giả với mã thường mã hoá *hành vi*
chứ không mã hoá *hậu quả*. Vòng chéo Claude↔Codex đã bắt lỗi **theo cả hai chiều** — Codex
tìm ra bug sản phẩm của Claude (`expires_at` thiếu trong response tạo preview), Claude tìm ra
lỗi contract của Codex (`c.ok !== true` trong khi readiness dùng `status`).

### 9.2 Phương pháp một lát cắt

Bảy workflow, làm **dọc từng cái**, không redesign cả hệ thống một lượt:

~~`onboarding/go-live`~~ → ~~`bảng điều khiển "việc cần làm"`~~ → ~~`chi tiết đơn`~~
→ **`đa kiện/ca xử lý` ← đang làm** → `checkout mobile của khách`
→ `catalog + nhập từ sàn` → `cài đặt`

Mỗi lát cắt đi đủ đường: **UI → route/BFF → API seller → giao dịch nghiệp vụ → DB/outbox →
worker/provider → trạng thái quay lại UI.** Lập bản đồ đó **trước khi đụng UI** — giá trị nằm
ở bước đo, không ở bước gõ.

Bằng chứng cho câu trên, từ lát cắt "bảng điều khiển": **sáu** lỗi có thật, không lỗi nào tìm
ra bằng cách nhìn màn hình. Ba cái đầu đến từ ~20 lệnh grep chỉ-đọc — vai `catalog_manager`
đăng nhập là gặp trang lỗi · hai ô dẫn thẳng vào 403 · thẻ trạng thái đếm một tập mở ra tập
khác. **Ba cái sau chỉ lộ ra khi LIỆT KÊ ĐỦ** lối đi của trang thay vì soi từng chỗ nghi ngờ:
thẻ gợi ý "Tên miền riêng" mở cho `admin` trong khi `DOMAIN_ROLES` chỉ có `owner` · nút hero
dự phòng trỏ `/products/new` cho mọi vai (chỉ hiện khi mọi ô bằng 0 — trạng thái không fixture
nào dựng) · `readinessErrHref` không đi qua allowlist trong khi `safeHref` cùng nguồn thì có.

Bài học rút ra và đã thành chốt: **vá từng trường hợp thì trường hợp thứ tư vẫn nằm đó.**
`apps/seller-admin/test/dashboard-viec.test.js` giữ một MANIFEST LỐI ĐI — rút mọi `${base}/…`
trong `renderOverview` bất kể vị trí cú pháp, chuẩn hoá bỏ query/fragment và đổi `${…}` thành
`:id`, rồi so **BẰNG** với bảng chính sách quyền. Thêm link mới mà không khai chính sách là ĐỎ.

Ràng buộc cố định của mọi lát cắt frontend: **giữ SSR và đường không-JS** (JS chỉ là tăng
cường, không phải điều kiện) · không chuyển SPA · không viết lại trọn `pages.js`/`server.js` ·
dùng được ở 360px, bằng bàn phím, có focus, Esc, đọc màn hình · mọi thao tác GHI phải chịu
được bấm-lặp và gửi-lại · lỗi phải nói *chuyện gì xảy ra / làm gì tiếp / thử lại được không* ·
**không hiện nút khi vai không có quyền hoặc trạng thái nghiệp vụ không cho phép** · không đưa
secret, payload webhook thô hay PII nội bộ ra giao diện · **không để frontend thành nguồn
quyết định giá, tiền, tồn hay quyền**.

### 9.3 Luật giao diện rút ra từ lát cắt bảng điều khiển

> **Ẩn LỐI ĐI mà vai không mở được. Không ẩn SỐ LIỆU mà API đã trả.**

Ô/nút dẫn tới trang sẽ 403 thì phải ẩn — gác bằng **chính các Set mà `sideNav` dùng**
(`ORDER_ROLES`/`CATALOG_ROLES`/`CONTENT_ROLES`/`DOMAIN_ROLES`/`REPORT_ROLES`/`INVENTORY_ROLES`
trong `pages.js`), đừng chép Set mới, hai bản sẽ trôi và trôi về phía nguy hiểm: nav giấu mục,
lưới vẫn mời bấm. Bảng số liệu mà `/stats` đã trả thì không ẩn — ẩn ở giao diện trong khi API
vẫn trả là bày trò, không phải phân quyền.

Ba hệ quả thao tác, cả ba đã thành chốt:
- **Link động phải qua allowlist**, và phải là **CÙNG MỘT** allowlist. `safeHref` và
  `readinessErrHref` cùng đọc `action_url` của readiness mà chỉ một chỗ được gác — nay cả hai
  đi qua `noiBo()`. Hai bản chép tay thì sẽ trôi, kể cả khi hôm nay giống hệt nhau.
- **Link NGOÀI tách khỏi bảng quyền.** `preview_url` trỏ ra tên miền storefront của shop, không
  có vai nào để đối chiếu — nhưng vẫn phải KHAI, để link ngoài mới không lọt tự do.
- **Trang 403 phải nêu tên màn hình người ta MỞ ĐƯỢC**, không chỉ nói "không tải được".

### Quyết định đã KHOÁ cho phạm vi hiện tại — `/stats` và dữ liệu catalog

Chủ dự án đã chốt ở workflow 2. Đây **không còn là câu hỏi mở**; đừng mở lại trong một lát
cắt khác.

- `low_stock` và `top_products` là **thông tin vận hành chung** trên Tổng quan.
- Vai mở được Tổng quan bằng `orders.read` **tiếp tục xem được** số liệu đó.
- Chỉ ẩn **lối đi / nút** dẫn tới trang hoặc thao tác mà vai đó không có quyền.
- **Không** gác lại ở giao diện. **Không** cắt trường khỏi `GET /stats`.
- **Không** đổi seller API hay RBAC trong phạm vi hiện tại.

Lý do giữ nguyên, để người sau khỏi suy lại: Tổng quan vốn đã cho `order_manager` xem doanh
thu trong khi `/reports` là owner/admin. Gác catalog theo `catalog.read` thì cùng logic phải
gác doanh thu theo `reports.read` — tức thiết kế lại xem mỗi vai thấy gì trên bảng điều khiển,
một lát cắt riêng, không phải phần đuôi của lát cắt này.

**Nếu sau pilot** phát hiện tên sản phẩm / SKU / doanh thu cần được coi là dữ liệu catalog hay
report MẬT, thì đó là một **quyết định sản phẩm mới**: phải đo lại toàn bộ dashboard, không tự
thay trong một lát cắt khác.

### 9.3b Đang dở: lát cắt 4 tách làm ba

Đợt đo 2 của `đa kiện/ca xử lý` ra ba nhánh việc, cố ý tách để không đụng `pages.js` cùng lúc:

| brief | nội dung | trạng thái |
|---|---|---|
| **A** | bằng chứng hoàn tiền + chốt ca, `app_resolution`, hàm SECURITY DEFINER hẹp (`docs/78`) | **đã merge** `b7088ab` |
| **B** | bảng quản trị card-hoá ở server (`docs/77`) | **đã merge** `db9eeae` |
| **C** | bản đồ phục hồi vận đơn | vẫn ở mức đã-đo, CHƯA khoá brief |

Lát cắt 4 coi như đóng ở phần A+B. C chưa khoá, và **không mặc nhiên là việc kế tiếp**.

Đợt đo mở đã chạy (`docs/79`) và kết luận việc kế tiếp **không phải** C cũng không phải
workflow 5, mà là **phân tầng gói dịch vụ**: bảng `plans` chỉ có một chiều phân biệt
(`max_products`), `care` và `platform` cùng trần 100 SP dù chênh 1,5 triệu/tháng, và trang bán
hàng liệt kê năm khác biệt mà hệ thống **không cưỡng chế mục nào**. Đang chờ chủ dự án chốt ba
câu hỏi kinh doanh ở `docs/79 §4` trước khi khoá brief.

Nợ đã ghi, chưa xử lý: trang **Tồn an toàn tràn 377/360** ở cả JS bật lẫn tắt — thủ phạm là ô
nhập "Tỉ lệ giữ an toàn cho toàn shop (%)" trong form đầu trang (`pages.js:6022`), không phải
bảng, nên nằm ngoài Brief B.

### 9.4 Bắt đầu một phiên mới thế nào

Không cần dán lại bối cảnh. Đọc file này, rồi:

```bash
git log --oneline -8            # lát cắt nào vừa đóng
git branch -r | grep -E 'claude/|codex/'   # nhánh nào đang dở
```

Nhánh đặt tên theo việc (`claude/ux-…`, `codex/…-fix`), **merge vào `main` bằng fast-forward**
sau khi full CI exit 0. Không merge thẳng khi cổng chưa xanh, kể cả khi diff trông vô hại.
