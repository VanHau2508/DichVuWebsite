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
| dòng mã ứng dụng | ~48.900 | `apps/*/src/*.js` |
| dòng test | ~35.472 | `apps/*/test/*.{js,mjs}` |
| migration | 184 tệp, mới nhất `0186` | `packages/db/migrations/` |
| bộ unit | 43 | `MANIFEST_UNIT_COUNT` |
| bộ e2e | 113 | `MANIFEST_E2E_COUNT` |
| bất biến DB | 9 bộ, 149 test TAP | `packages/db/test/*.test.js` |
| tài liệu | 82 tệp | `docs/` |

Tỉ lệ test/mã ≈ 0,73 — cao có chủ ý, xem §4.

**Phần giải thích, chú thích, tài liệu và commit message MỚI dùng tiếng Việt có dấu.** Tên mã,
API và thuật ngữ bắt buộc giữ nguyên; không viết lại lịch sử commit cũ chỉ để đổi ngôn ngữ.

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
trong cùng commit — đếm theo **FILE**, không theo số thứ tự (hôm nay 184 file / số cao nhất 0186).

Hook `scripts/hooks/pre-push` chạy `--fast` và **chặn push khi đỏ**. Cài một lần cho mỗi bản
clone: `git config core.hooksPath scripts/hooks`.

---

## 2. Bản đồ mã — sửa gì thì vào đâu

```
apps/<service>/src/     mã service        apps/<service>/test/    test của nó
packages/               mã DÙNG CHUNG     packages/db/migrations/ toàn bộ SQL
infra/compose.*.yml     dàn dịch vụ       scripts/                cổng, seed, vận hành
docs/                   82 tệp ghi chép   .github/workflows/ci.yml cổng đám mây
```

| việc cần sửa | file |
|---|---|
| API nghiệp vụ shop (đơn, kho, báo cáo, KM) | `apps/seller/src/*.js` — 52 module, 1 module 1 miền |
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
- **24 vai DB `app_*`, mỗi service/miền nhạy cảm một vai ít quyền nhất.** Đừng nới cho tiện. Có vai KHÔNG
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
- **Đột biến sửa dòng mà test ghim nguyên văn chỉ chứng minh chính tả.** Phải gỡ cơ chế thật,
  rồi đo hậu quả ở đúng bề mặt người dùng nhìn thấy.
- **Một chốt thường có ba mảnh:** cơ chế → dây nối → điểm phát ra. Test mảnh đầu và mảnh cuối
  không có nghĩa là đã canh cả chuỗi; phải cắt thử mảnh giữa.
- **Từ vựng đi qua biên giới service là hợp đồng.** So BẰNG hai tập tên; đổi tên một phía phải
  ĐỎ, đổi tên nhất quán cả hai phía phải XANH.
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
  sau khi đăng nhập suốt một thời gian dài mà 107 bộ e2e vẫn xanh. Đụng tới quyền thì phải
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
- **So `scrollWidth` với `clientWidth`, KHÔNG với `innerWidth`.** `innerWidth` tính cả thanh
  cuộn (360 → khung thật 345), nên ngưỡng đặt theo nó bỏ lọt mọi phần tử tràn trong khoảng
  345–361px. Một lượt đo trang chủ đã báo ĐẠT trong khi trang tràn thật.
- **`html{scroll-behavior:smooth}` vô hiệu hoá `scrollTo` trong headless.** Lệnh cuộn thành
  hoạt ảnh và không kịp xong dưới `--virtual-time-budget`; `scrollY` vẫn là 0 nên mọi phép
  đo sau khi cuộn đọc đúng trạng thái ĐẦU TRANG. Dấu hiệu: mọi vị trí cuộn cho **cùng một**
  con số. Phải dùng `scrollTo({top, behavior:'instant'})`, và in kèm `scrollY` để phép đo
  tự tố giác khi nó không cuộn.
- **Mẫu của animation theo cuộn chỉ tươi ở LẦN ĐO ĐẦU sau mỗi lượt cuộn.** Headless không vẽ
  khung hình đều, nên cuộn nhiều chặng trong MỘT lượt chạy thì các chặng sau đọc lại giá trị
  cũ — và giá trị cũ đó *đúng* với chặng đầu nên trông rất thuyết phục. Mỗi vị trí một lượt
  chạy riêng.
- **`animation` mặc định easing là `ease`, không phải `linear`.** Với animation theo cuộn thì
  nó bẻ cong tiến độ: đo được khung kề còn mở 54% ngay lúc khung chính đã 100%, tức chồng hai
  hình. Mọi `animation-timeline` phải khai `linear`.
- **Ô lưới/flex mặc định `min-width:auto` — cột KHÔNG co dưới min-content của nội dung.**
  Trang chủ tràn ngang ở 3/7 bề rộng vì chuyện này: một hàng flex một dòng có bề rộng tối
  thiểu 391px kéo cả cột lên 429px. `min-width:0` là bản vá, nhưng phải vá ở ĐÚNG ô lưới,
  không phải ở tổ tiên.
- **`overflow-x:clip` ở tổ tiên PHÁ `position:sticky`.** Vá tràn ngang bằng cách cắt ở khối
  cha là cách nhanh nhất giết một bố cục dán dính mà không ai thấy — cắt ở đúng khối gây tràn.
- **ĐO KHÔNG PHẢI LÀ NHÌN.** Một trang có thể đạt 0/7 bề rộng tràn, 13/13 chốt xanh,
  14/14 đột biến đỏ — và vẫn xấu tới mức không dùng được. Lượt dựng trang chủ đi qua đủ
  các phép đo rồi mới bị chủ dự án bác: nút hero TRẮNG chữ TRẮNG (rỗng hoàn toàn), mục
  điều hướng gãy chữ lòi khỏi thanh, tiêu đề chiếm nửa trái còn nửa phải bỏ trống. **Chụp
  ảnh và NHÌN trước khi báo xong.** Playwright có sẵn (`/opt/node22/lib/node_modules`),
  ảnh đọc được bằng công cụ Read.
- **`body{overflow-x:hidden}` biến TRÀN thành CẮT CỤT — và giết luôn phép đo.** Nội dung
  vượt mép bị xén mất, trang không cuộn ngang, nên `scrollWidth === clientWidth` và mọi
  phép đo tràn báo ĐẠT. Nút menu ở 390px bị cắt mất trong khi phép đo nói 0/7. Probe phải
  bắt CẢ phần tử vượt mép mà bị cắt; chỉ bỏ qua khi khối cắt nó rộng ≤2px (kiểu chỉ-đọc-
  màn-hình), vì đó mới là cắt cố ý.
- **Một quy tắc cho `a` sẽ thắng mọi lớp nút.** `.lp a{color:inherit}` là (0,1,1), cao hơn
  `.lp-b-pri` (0,1,0) ⇒ chữ nút thừa hưởng màu khối cha. Bản vá `.lp a:not([class])` còn
  tệ hơn: `:not([class])` tính như bộ chọn thuộc tính nên thành (0,2,1), thắng cả
  `.lp-nav a`. Cùng lớp lỗi: `.lp-drawer a` (0,2,1) làm nút xanh trong ngăn kéo có chữ đen.
  **Mọi thẻ a tự khai màu ở lớp của nó**, đừng đặt màu chung.
- **Quy tắc nền `.lp ul{margin:0}` (0,1,1) NUỐT `margin-top:auto` của một lớp trần
  (0,1,0) — im lặng.** Không phải chuyện riêng của thẻ `a`: mọi reset viết dạng
  `<lớp> <phần-tử>` đều cao hơn một lớp đơn. Hậu quả đo được ở băng thẻ ngành hàng: hàng
  đồ nghề đáng lẽ dán đáy thẻ thì trôi lên giữa, gạch ngang lệch 35px so với thẻ bên cạnh
  — và không có thông báo nào, chỉ là một hàng răng cưa. Viết `.lp-nh .lp-nh-tg` là xong.
- **Phép đo tràn ngang phải BIẾT khối nào cuộn ngang được.** Băng thẻ trong
  `overflow-x:auto` cố ý cho nội dung vượt mép — probe đếm thẳng `right > vw` sẽ báo đỏ
  giả cho đúng cách xử lý nội dung rộng mà chính sổ tay này yêu cầu. Tha tổ tiên
  `auto|scroll`, **KHÔNG tha `hidden`**: `body{overflow-x:hidden}` vẫn là giấu lỗi. Sửa
  probe xong phải đột biến lại chính probe (chèn một khối rộng 3000px ngoài mọi khối cuộn
  — vẫn phải bắt được), nếu không là tự mở một điểm mù.
- **Khai `display` đè mất `display:none` của thuộc tính `hidden`.** Ngăn kéo đóng vẫn nằm
  trong bố cục, chỉ trượt ra ngoài mép bằng `transform` — bấm Tab là đi thẳng vào một menu
  không nhìn thấy. Luôn thêm `[hidden]{display:none}` cho phần tử có khai `display`.
- **Chữ HOA cỡ lớn + dấu tiếng Việt = dấu chồng lên dòng trên.** `line-height:1.16` đủ cho
  chữ thường nhưng không đủ cho `Ồ Ế Ữ`. Tiêu đề hero thì đừng viết hoa; tiêu đề mục viết
  hoa thì tối thiểu 1.26.
- **Khối tiêu đề một cột trên màn rộng = lệch tỉ lệ ở MỌI mục.** Tiêu đề bó trong ~20ch nằm
  nửa trái, nội dung bên dưới trải hết bề rộng. Cho khối tiêu đề chia hai cột (tiêu đề trái,
  câu dẫn phải) từ 1024px — sửa ở lớp nhịp chung, không sửa từng mục.
- **Cùng độ ưu tiên thì quy tắc viết SAU thắng — kể cả khi quy tắc trước nằm trong
  `@media` hẹp hơn.** Lệnh `@media(max-width:1023px){.lp-float{display:none}}` đặt phía
  TRÊN phần khai `.lp-float{display:flex}` bị đè im lặng: đọc CSS thì tưởng đã ẩn, chụp
  ảnh vẫn thấy. `@media` KHÔNG cộng thêm độ ưu tiên nào.
- **"Gọn trong một khung hình" phải đo bằng ĐÁY CỦA TỪNG PHẦN, không bằng chiều cao
  section.** Section có thể đúng `100svh` mà nội dung bên trong vẫn tràn ra ngoài đáy —
  cụm điều khiển và khung minh hoạ rơi xuống dưới mép. Đo `getBoundingClientRect().bottom`
  của từng phần rồi so với `innerHeight`, ở nhiều CHIỀU CAO khung nhìn chứ không chỉ nhiều
  bề rộng: 1366×700 và 1920×760 mới là chỗ vỡ, 1440×900 thì không.
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
→ ~~`đa kiện/ca xử lý`~~ → ~~`checkout mobile của khách`~~
→ ~~`catalog + nhập từ sàn`~~ → `cài đặt`

Thứ tự bảy workflow vẫn là bản đồ nợ UX, nhưng chủ dự án đã đổi ưu tiên sang connector POS.
Thứ tự đó chỉ là bản đồ nợ UX; lát cắt KiotViet và Trung tâm vận hành đã đóng, còn việc kế tiếp
chưa được chọn — xem §9.3b.

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

### 9.3b Lát cắt 4, Trung tâm vận hành và brief C đều đã ĐÓNG

Đợt đo 2 của `đa kiện/ca xử lý` ra ba nhánh việc, cố ý tách để không đụng `pages.js` cùng lúc:

| brief | nội dung | trạng thái |
|---|---|---|
| **A** | bằng chứng hoàn tiền + chốt ca, `app_resolution`, hàm SECURITY DEFINER hẹp (`docs/78`) | **đã merge** `b7088ab` |
| **B** | bảng quản trị card-hoá ở server (`docs/77`) | **đã merge** `db9eeae` |
| **C** | bản đồ phục hồi vận đơn | **đã merge** — nền `5461fb8`, bề mặt `88ee67d` |

Lát cắt 4 đóng trọn. Nhánh `codex/orphan-shipment-recovery` fast-forward vào `main` tại
`88ee67d` — bốn commit `8d02b6c` → `3a83d7d` → `4449e3f` → `88ee67d`, không merge commit.

Lát cắt **checkout mobile đã ĐÓNG** trên `main` tại `0788eaa`: nút GPS được gác ở SSR khi
tắt JavaScript, script chỉ mở lại khi trình duyệt có geolocation, và kiểm chứng giữ nguyên
đường checkout no-JS.

Đợt đo phân tầng gói đã khoá quyết định kinh doanh trong `docs/79`, nhưng chủ dự án đổi ưu tiên
sang chiến lược **tích hợp POS trước, POS riêng sau**. Lát cắt vừa thi công xong trên nhánh là nền connector
KiotViet ở `docs/80`: KiotViet làm chủ tồn vật lý/POS, nền tảng làm chủ website/checkout/đơn
online; admin nhìn cả hai nguồn nhưng không đếm doanh thu hai lần. Đây mới là **connector core
cho pilot**, chưa được tuyên bố hỗ trợ KiotViet hoàn chỉnh trước khi thử bằng tài khoản thật và
chưa làm xong hoàn trả hai chiều.

Migration `0178` đang siết bản `0177`: CAS/generation cho credential + job, freshness từng
variant, cursor order/invoice độc lập, webhook collision/dead-letter, advisory lock đối soát,
đơn ngoài chỉ-đọc và COD-only cho external-master. Migration `0179` đưa trigger đơn ngoài sang
vai `SECURITY DEFINER` NOLOGIN để checkout không phải đọc trực tiếp connector dưới FORCE RLS,
đồng thời giữ actor bằng `session_user` và chặn gán customer chéo shop khi ẩn danh. Migration
`0180` chặn ghi refund cục bộ cho đơn POS ngoài cho tới khi API hoàn tiền provider được xác minh.
Migration `0181` dùng một advisory-key chuẩn cho claim catalog và ghi send-intent đã commit trước
network I/O, để retry mơ hồ dừng ở `needs_attention` thay vì POST đơn lần hai.
Migration `0182` dùng nonce discrepancy một lần cho retry thủ công, không reset `attempted`,
và bắt lỗi provider sau xác nhận về `needs_attention` thay vì để BullMQ POST lại.
Invoice chưa xác định được nguồn phải nằm ở `order_identity_pending`, chưa ghi doanh thu. Phạm vi hiện tại chỉ
đủ cho pilot 1–3 shop; chưa có bằng chứng để tuyên bố tải 9.358 shop.

Brief C về bản đồ phục hồi vận đơn đã được đo trên `main`. **Phần nền đã ĐÓNG** tại `5461fb8`
(hai commit `685955a` → `5461fb8`, fast-forward): migration `0184` tách mã thô của hãng ra
`shipments.carrier_status_raw`, khoá `provider_status` bằng CHECK chín marker nội bộ, trigger
tương thích hẹp đúng `current_user = 'app_expiry'` cho cửa sổ deploy, và worker ghi đúng
namespace. Chốt từ vựng trong `schema-invariants` so **BẰNG** tập CHECK với tập rút từ mọi
đường ghi/đọc — thêm marker trong mã mà quên migration là đỏ.

**Lỗi của chính lát cắt này, chép lại vì nó đắt hơn bản vá.** Bản đầu (`685955a`) liệt
`dedup_0046` ở ba danh sách (trigger, khối fail-closed, backfill) nhưng bỏ khỏi CHECK. Đó là
marker thật do `0046_shipping_hardening.sql:10` ghi ra. Hậu quả: `ADD CONSTRAINT` xác thực dòng
cũ, nên migration **không áp được** lên DB nào từng chạy `0046` khi có vận đơn trùng — đo được
`check constraint … is violated by some row`, DB đứng nguyên ở 181.

Điều đáng ghi không phải cái sót, mà là **vì sao cổng không thấy**: cổng migration từ DB
TRẮNG xanh 182/182 ngay trên commit hỏng, và nó **phải** xanh — DB trắng thì `0046` không dòng
để đóng dấu, nên giá trị đó không bao giờ tồn tại. Cổng ấy chứng minh schema dựng được từ số
không; nó **không** chứng minh migration chạy được trên một DB đã sống. Hai bất biến DB thì bắt
được và đã đỏ đúng chỗ (`147 → 145 pass, 2 fail`, cả hai nêu đích danh `dedup_0046`), nhưng lượt
đầu chúng được chạy trên DB không có quá khứ nên con số `147/147` khi đó không chứng minh gì.
→ **Luật rút ra: migration đụng dữ liệu cũ phải được áp thử trên DB CÓ LỊCH SỬ + dòng mà chính
migration cũ sinh ra, không chỉ trên DB trắng.** Phép đo đã dùng: dựng DB tới `0183`, gieo một
vận đơn `provider_status='dedup_0046'`, rồi mới thả `0184` vào.

Còn nợ, đã ghi, chưa làm: trigger `normalize_shipment_provider_status_namespace` sống cho cửa sổ
deploy nhưng **không có ngưỡng gỡ** trong chú thích — ba tháng nữa sẽ không ai dám xoá. Và một
advisory mức **moderate** xuất hiện ngày 01/09 (`decode-uri-component` ← `query-string` ← `minio`)
chạm `checkout`/`seller`/`worker`; ngưỡng `--audit-level=high` của `security-scan.sh` không chặn,
bản vá lại đòi hạ `minio` xuống `7.0.26` — thay đổi phá vỡ, đừng vá vội.

**Phần bề mặt brief C đã ĐÓNG.** Chủ dự án chốt `orphan` là việc mức
**chặn** và chốt đổi/ngắt hãng bằng **interstitial SSR/no-JS**: lượt đầu chỉ hiện đúng số vận
đơn sẽ mất theo dõi, lượt hai gửi lại chính con số đó; seller khoá cấu hình và chỉ ghi khi số
vẫn bằng tập hiện tại. Không dùng ô xác nhận mù, không phụ thuộc JavaScript.

Hai hình dạng orphan đi hai đường khác nhau để không trừ tồn hai lần. `created` vẫn là claim
chưa chốt: chặn tạo vận đơn thứ hai, cho nhập mã **đọc từ portal hãng** nếu hãng đã tạo, rồi
đi qua `consumeAndShip` đúng một lần. `in_transit` đã trừ tồn: chi tiết đơn chỉ cho chốt kết
cục Đã giao / Hoàn về / Hãng đã huỷ, **không có ô nhập mã tay** và không gọi
`consumeAndShip`. Mọi đường đóng giữ nguyên tiền; COD chỉ được ghi qua `payments/manual` có
`payment.write` + step-up như trước.

Năm bề mặt cũ đã cùng nhặt orphan: Tổng quan, `attention=shipment`, badge từng dòng, chi tiết
đơn và chốt tạo vận đơn. Fixture E2E dựng orphan bằng PUT/DELETE shipping thật, không UPDATE
tay. Đã đo trên DB trắng: toàn manifest unit **331/331**, shipping **118/118**; đột biến gọi
`consumeAndShip` lần hai, ghi thẳng `payment_status='paid'` + `paid_at` ở cả hai đường đóng orphan, bỏ blocker/tập Tổng quan/bề mặt chi tiết, hạ quyền
`payments/manual` hoặc bỏ step-up đều đỏ đúng chỗ. Probe Chromium 360px cho cả interstitial
và chi tiết orphan `in_transit` đều 0 tràn; chi tiết xác nhận 0 ô nhập tracking.

Cổng đầy đủ trên nhánh: **107/107 E2E**, không log sót; bất biến DB **147/147**; migration
DB trắng **182**, 0 DRIFT, 0 pending; smoke **8 · 27 · 32**. `security-scan` đọc audit JSON
và báo OK kèm đúng ba instance advisory moderate `decode-uri-component` đã ghi ngay phía trên; audit JSON chạy
riêng cho checkout/seller/worker đều exit 0 với **0 high · 0 critical**.

**Lỗ đo đắt nhất của lát cắt này, chép lại vì nó đi lọt xa hơn mọi lỗ trước.** Bản `8d02b6c`
đóng orphan đúng ở mọi đường, nhưng hai khẳng định tiền chỉ đếm `count(*) FROM
payment_transactions`. Đột biến ghi thẳng `payment_status='paid'` + `paid_at=now()` vào nhánh
đóng orphan — tức hệ thống thu tiền một đơn COD chưa ai trả đồng nào — cho **117 pass, 0 fail**,
và đi lọt **cả bảy bước cổng đầy đủ**. Nguyên nhân: §3 định nghĩa **doanh thu = `paid_at IS NOT
NULL`**, không đọc sổ giao dịch; một đường ghi `paid_at` mà không sinh dòng ledger thì báo cáo
cộng đủ tiền trong khi `count(*)` trước = sau. Tên biến `paymentsAfter…` khiến người đọc tưởng
đã canh tiền, còn thứ nó canh là SỔ. Nay cả hai khẳng định đọc `payment_status` **và** `paid_at`
trên `orders` (phải có cả hai: hoàn tiền lật `payment_status` nhưng GIỮ `paid_at`), và đột biến
ở cả hai nhánh đóng orphan đều **117/1**.
→ **Luật rút ra: khẳng định về tiền phải đọc ĐÚNG cột mà định nghĩa doanh thu dùng.** Đếm bảng
lân cận là phép đo đi qua một chốt khác — xanh, và xanh vô nghĩa.

Parser cũ của `security-scan.sh` bắt văn xuôi npm (`found [0-9]+ (low|moderate) `) — mẫu viết
theo npm 6, mà npm 10/11 in `3 moderate severity vulnerabilities`. Nghĩa là mục 1 **không thể
xanh** cho bất kỳ gói nào có advisory moderate, và mỗi lát cắt lại kèm một câu "đỏ nhưng giải
thích được". Nay nó đọc `--json` rồi so **SỐ** `metadata.vulnerabilities.high/critical`; văn
xuôi npm đổi bao nhiêu lần cũng không đụng tới. Fail-closed giữ nguyên và đã đo lại: JSON hỏng,
output rỗng, npm trả `{"error":{"code":"ENETUNREACH"}}`, hay JSON hợp lệ nhưng `rc≠0` đều FLAG.

Seam `SECURITY_SCAN_DOCKER_ARGS` tồn tại để mount CA cho môi trường có proxy chặn TLS — không
có nó thì cả 16 gói ra FLAG "KHÔNG CHẠY ĐƯỢC", đỏ vì hạ tầng chứ không vì phụ thuộc. Nhưng một
lượt XANH chạy với tham số sửa đổi mà im lặng thì không phân biệt được với lượt xanh bình
thường, nên scan **tự khai một lần** ngay đầu mục 1. Cùng nguyên tắc với probe 360px phải tự
chối khi khung nhìn sai: phép đo im lặng về cấu hình của chính nó là phép đo không kiểm chứng
lại được.

Một finding review đã **tự tan khi đo**, chép lại vì cái sai nằm ở phía người đo: chốt nguồn
cho ô "Việc cần xử lý" ở chi tiết đơn bị nghi là chốt CHÍNH TẢ, chỉ ghim nguyên văn danh sách
loại trừ nên đảo thứ tự sẽ lọt. Đo thì đảo thứ tự **đỏ** (khẳng định thuận ghim cả cụm), còn
đột biến thật sự nguy hiểm — gỡ HẲN mệnh đề nhặt orphan khỏi phép đếm — đơn vị **xanh 19/0**
nhưng `shipping.e2e.mjs` **đỏ đúng chỗ** (`bề mặt orphan in_transit sai`). Chuỗi vẫn có chốt,
chỉ là chốt nằm ở bề mặt render chứ không ở mức nguồn. Bài học không phải về orphan mà về
review: **đừng báo một lỗ hổng chốt khi chưa chạy đột biến đi qua đúng nó.**

`cod_mismatch` vẫn là nợ bề mặt riêng: lượt đo trước có 0 dòng, nghĩa là chưa gặp chứ không
phải đã an toàn. Brief này không mở rộng sang nó vì đường xử lý COD lệch cần quyết định riêng.

Song song: **trang chủ nền tảng đã dựng lại toàn bộ** (`apps/storefront/src/landing.js`)
theo yêu cầu của chủ dự án. Hệ thiết kế mới (xanh cobalt, hero nền tối), bố cục mới, và
chủ dự án đã **cho phép dùng JavaScript** ở trang này. Không phải nới CSP: cơ chế nonce
đã có sẵn trong storefront (đang dùng cho badge giỏ), chỉ cần truyền nonce cho route `/`.

**JS ở đây là LỚP TĂNG CƯỜNG, không phải điều kiện.** Không nonce ⇒ `sitePage` không chèn
script ⇒ trang vẫn đủ chữ và bấm được: slide đầu mở sẵn từ server, thanh CTA nổi không
dựng, và trạng thái ẩn của hiệu ứng nằm sau `html.lpjs` — cờ do chính JS gắn. Đo cả hai
nhánh: 0/7 bề rộng tràn khi có JS, 0/5 khi không.

Hai lớp lỗi mới học được ở lượt này, cả hai đều làm MẤT NỘI DUNG chứ không chỉ mất hiệu ứng:
`requestAnimationFrame` chỉ chạy **2 lần trong cả một giây** ở môi trường không vẽ đều, nên
bọc handler cuộn trong rAF là để thanh điều hướng kẹt trạng thái cũ; và bộ quét hiện-dần giữ
lại cả phần tử đã trôi LÊN TRÊN khung nhìn thì nhảy tới mỏ neo hay cuộn nhanh một phát sẽ
làm chúng kẹt `opacity:0` vĩnh viễn (đo được 4/37 phần tử hiện, sau khi vá là 37/37).

Đã **bỏ ba lời chứng thực khách hàng dựng lên** ("Chị Hương", "Anh Tuấn", "Chị Mai"): kho
chưa triển khai và chưa có khách thật (§0), trong khi chính chú thích đầu file tuyên bố
không bịa số khách hàng. Có chốt cấm dựng lại cho tới khi có trích dẫn thật.

Nhánh connector đã vào `main` tại `2e13602` và các bản vá landing đã fast-forward tiếp tới
`2061d93`. Phần phân tầng gói vẫn còn giá trị nhưng tạm hoãn, không bị huỷ. **Trung tâm vận
hành đã ĐÓNG:** nhánh `codex/operations-center` fast-forward vào `main` tại `48d87c4` — ba
commit `f9a3f1e` → `a794df2` → `48d87c4`, không merge commit. Lát cắt mở rộng `/stats` theo
kiểu additive (`generated_at`, `partial.failed`, `sync`, `todo_items[]`) và đổi lưới việc cần
làm sang `TODO_REGISTRY`: ô số liệu vẫn render, chỉ lối đi bị gác theo vai. Cổng đầy đủ trên
DB không drift đạt 318 unit · 144 bất biến DB · 107/107 E2E · smoke 8·27·32 · migration DB
trắng 180/180, 0 DRIFT, 0 pending; audit phụ thuộc 13/13 gói không có lỗ hổng.

Ba vòng review chéo đều bắt được lỗ đo mà lượt trước không nhìn thấy: vòng 1 gỡ cơ chế ghi
`partial.failed` và tách lỗi truy vấn danh sách vận đơn; vòng 2 bắt dây nối `partial` và từ
vựng nhóm giữa hai service; vòng chốt thêm phép so tập tên hai phía, test nhánh thành công của
savepoint và câu chữ fail-closed. Các chốt đều bị đột biến thật làm đỏ trước khi lát cắt đóng.

Chi tiết hợp đồng `/stats`, registry việc cần làm và các giới hạn của lát cắt nằm ở `docs/81`.

Nhánh `codex/onboarding-readiness-connector` đã thi công phần readiness theo nguồn tồn,
retry thông báo onboarding và lớp phòng thủ DB trong migration `0183`; đã fast-forward vào
`main` tại `8d46f15`.
Shop `external_master` chỉ được coi là sẵn sàng khi connector active, có biến thể đã mapping
đúng generation và dấu đồng bộ còn tươi; email `shop.onboarding_nudge` được retry qua cùng
chuỗi outbox/PII TTL, không cần `order_id`. Migration DB trắng hiện là 182 file, 0 DRIFT,
0 pending. Harness `scripts/verify-onboarding-readiness.sh` đã canh ba chốt bằng E2E thật:
gỡ connector, nới freshness và bỏ allowlist onboarding đều phải đỏ; hoàn nguyên phải xanh.

Nguyên nhân tràn ngang của trang **Tồn an toàn** đã được vá trên nhánh connector: con trực tiếp
của `.filters` có `min-width:0;max-width:100%`, để nhãn "Tỉ lệ giữ an toàn cho toàn shop (%)"
không giữ intrinsic width 377px. Chốt nguồn nằm ở `apps/seller-admin/test/table-cards.test.js`;
phép đo Chromium 360px cả JS bật/tắt đã xác nhận 0 tràn ngang.

Mục **Ngành hàng** đã đổi từ băng chữ chạy sang **băng thẻ lướt ngang có lọc theo ngành**,
dựng đúng hình dạng một hồ sơ khách hàng (ảnh bìa · nhãn ngành · tên · mô tả · đồ nghề) để
sau này thay được bằng cửa hàng thật: mỗi thẻ có khe ảnh `nh-<khoá>` trong
`apps/storefront/src/assets/`, chưa có tệp thì dựng khung minh hoạ. Vì kho chưa có khách
thật, thẻ hôm nay là **cửa hàng MẪU** và mục tự nói rõ điều đó ngay dưới băng — chốt
`landing-nganh-hang.test.js` bắt cả hai đầu: mất dòng đó là đỏ, đặt tên nghe như một shop
có thật cũng đỏ. Đo: 0/9 bề rộng tràn ở cả nhánh JS và không-JS, 23/23 đột biến đỏ.

### Lát cắt 6 `catalog + nhập từ sàn` — đợt đo 1 và QUYẾT ĐỊNH giá vốn

Đợt đo 1 phủ **quyền + cửa vào** của catalog. Bản đồ: `CATALOG_ROUTES` 18 route
(`catalog.read`/`catalog.write`) · `IMPORT_ROUTES` 2 route · ~25 route BFF ở `server.js` ·
`CATALOG_ROLES={owner,admin,catalog_manager}` trong `roles.js` · `catalog_manager` chỉ có
`{catalog.read, catalog.write}` theo `rbac.js`.

**Quyết định mới của chủ dự án (03/09): GIÁ VỐN LÀ BÍ MẬT KINH DOANH, `catalog_manager` không
được thấy.** Đã thi công và merge tại `f76c421`.

Vì sao nó là quyết định chứ không phải lỗi hiển nhiên: ranh giới của kho vốn nhất quán — mọi
con số lộ biên lãi hoặc nguồn hàng đều nằm sau `inventory.manage` (sổ cái kho cấp shop, tồn an
toàn, phiếu nhập/NCC) hoặc `reports.read` (P&L). Giá vốn là **ngoại lệ duy nhất** nằm bên phía
catalog. Đo được bằng vai thật: `catalog_manager` ĐỌC được (`getProduct` trả `cost_vnd`), GHI
được (PATCH variant → 200), thấy ô nhập trên trang — trong khi cùng vai đó mở `/reports/pnl`
thì **404**. Một dữ liệu, hai mức bảo vệ.

Gác bằng `reports.read` chứ không phải `inventory.manage`: hôm nay cả hai đều ra `{owner,admin}`
nên hành vi giống hệt, nhưng chú thích của `reports.read` trong `rbac.js` đã kể tên "giá vốn".
Neo vào cái có tên đúng thì lần sau ai nới một trong hai vai sẽ không vô tình mở nhầm thứ kia.

**Năm chỗ phải bịt, không phải một.** Liệt kê đủ trước khi gõ, đúng bài học §9.2:
- ĐỌC · `catalog.js:getProduct` — **không JOIN** `variant_costs` khi thiếu quyền, và khoá
  `cost_vnd` **VẮNG MẶT** chứ không phải `null`: `null` nghĩa là "chưa nhập", đây là "không được
  xem" (§3 NULL ≠ 0).
- ĐỌC · ô nhập giá vốn trong bảng biến thể.
- ĐỌC · **`marginHint` in "biên ~X%"** — ẩn mỗi ô nhập là vô nghĩa: giá bán nằm cột bên, biên ⇒
  vốn bằng một phép chia. Đây là chỗ dễ sót nhất.
- GHI · `updateVariant` trả **403 tường minh**, không lặng lẽ bỏ qua: một request nói "đặt vốn
  90k" mà nhận 200 sau khi bị vứt là kiểu hỏng tệ nhất.
- GHI · bộ nhập CSV gỡ cột `cost_vnd` **trước** `buildProduct`, nên một ô viết sai không làm
  hỏng cả dòng của người vốn không được đặt nó. Tệp mẫu phát cho vai đó cũng bỏ hẳn cột — để
  nguyên là mời người ta gõ một cột sẽ bị vứt, và họ chỉ biết sau khi gõ xong cả tệp.

Bỏ qua cột chứ **không chặn cả tệp** (mẫu do chính hệ thống phát ra vẫn có cột đó), nhưng
**không im lặng**: seller đếm số dòng đã gỡ, giao diện nói thẳng ở cả xem trước lẫn nhập thật.

**Lỗi của chính lát cắt này.** Làm xong cơ chế (seller gỡ + đếm) và điểm phát ra (trang hiện câu
báo) nhưng **quên khúc giữa**: `mergeImportResults` dựng object theo danh sách khoá trắng nên
`cost_bo_qua` rơi im lặng — seller trả 2, trang hiện 0, không lỗi nào. Đúng ba mảnh của một chốt
(§4): cơ chế → **DÂY NỐI** → điểm phát ra. Nó lộ ra CHỈ VÌ khẳng định đặt trên bề mặt người dùng
nhìn thấy, không đặt trên response của seller.

Hai lần phép đo bác lại người đo, chép lại vì cả hai suýt thành finding bịa: gửi form nhập bằng
urlencoded trong khi handler dùng `readMultipartAll` ⇒ 400 là lỗi phân tích tệp, không phải lỗi
quyền; và chú thích `rbac.js` "catalog_manager: chỉ sản phẩm/tồn kho" bị nghi sai, nhưng
`inventory/adjust` gác bằng `catalog.write` nên chú thích **đúng**.

Đo: bộ mới `admin-gia-von.e2e.mjs` **20/20**; ma trận **7/7 đột biến đỏ** (gỡ JOIN · bỏ 403 ·
hiện lại ô nhập · hiện lại RIÊNG biên lãi · mẫu CSV luôn kèm cột · nhập không gỡ cột · dây nối
rơi `cost_bo_qua`). Cổng đầy đủ: unit **331** · migration DB trắng **182**, 0 DRIFT · bảo mật
sạch · bất biến DB **147** · E2E **108/108**, 0 log sót · smoke đủ.

Chốt §0 bắt đúng một lỗi thật trong lượt này: sửa `MANIFEST_E2E_COUNT` mà quên bảng số đo
(`107 !== 108`). Đã amend vào cùng commit, vì §0 đòi cùng commit.

**Còn nợ của lát cắt 6, chưa đo:** luồng nhập CSV/XLSX thật (xem trước → nhập → báo lỗi từng
dòng), ghép với connector KiotViet, giao diện 360px, đường không-JS. Một hệ quả đã biết và cố ý
không chặn: `catalog_manager` xoá/tái cấu trúc biến thể vẫn xoá dòng `variant_costs` kèm theo —
chặn thì chặn luôn việc catalog hợp lệ, nên để nguyên và ghi ra đây.

**Lát cắt này do Claude vừa đo, vừa viết, vừa tuyên bố xanh** — chủ dự án chọn bỏ vòng chéo
§9.1 luật 2 cho lượt này. Ai đọc lại nên biết lời "xanh" ở đây yếu hơn các lát cắt khác.

**Đợt đo 2 của lát cắt 6 — luồng nhập CSV.** Hai lỗi, đã vá và merge tại `50d50c3`. Cả hai
**chỉ lộ ra với tệp lớn hơn một lô** (admin chia lô 200 sản phẩm), nên mọi tệp thử nhỏ đều xanh
— đó mới là điều đáng nhớ, không phải bản vá.

- **Số dòng báo lỗi chỉ vào DÒNG VÔ TỘI.** Seller tính `line = i + 2` theo mảng NÓ nhận được,
  tức chỉ số trong LÔ. Đo được: tệp 260 SP, lỗi ở SP thứ 250, giao diện báo "dòng 51". Dòng 51
  **có thật và hoàn toàn đúng**, nên người bán sửa một sản phẩm lành lặn rồi nhập lại vẫn hỏng —
  trong khi bảng lỗi này tồn tại đúng để họ "sửa file, không sửa cơ sở dữ liệu". Nay admin gửi
  kèm `line_of` dựng bằng **bản đồ theo đối tượng**, không cộng độ lệch: `splitProductBatches`
  gom theo handle nên các dòng của một lô KHÔNG liền nhau trong tệp. Seller chỉ tin `line_of`
  khi adapter trả về đúng mảng đã nhận — adapter TikTok có thể sinh/gộp dòng, và một bản đồ
  lệch còn tệ hơn không có bản đồ.
- **Xem trước không kiểm TRẦN GÓI.** Trần đọc sau `return` của dry-run nên đường xem trước không
  bao giờ chạm tới: tệp 212 SP hứa "Sẽ tạo 212", nhập thật tạo 100 (gói `platform` trần 100 —
  §7). Vá xong lộ **tầng thứ hai**: xem trước KHÔNG ghi gì nên mỗi lô đọc `catalogCount` đều
  thấy cửa hàng như lúc đầu — lô 1 báo đúng, lô 2 tưởng còn chỗ và hứa thêm 12. Trần nay được
  **nối qua lô**, đúng cách `image_limit` đã làm sẵn ngay cạnh đó, và chỉ đọc MỘT lần cho cả hai
  đường: đọc hai lần thì hai con số lệch được, mà lệch ở đây nghĩa là xem trước hứa một đằng ghi
  một nẻo.

**Hồi quy tự gây ra rồi tự bắt, chép lại vì nó đắt hơn bản vá.** Bản vá trần đầu tiên nêu **đích
danh từng dòng** vượt trần cho "hữu ích": tệp 260 SP với trần 100 sinh **100 hàng giống hệt
nhau** và ĐẨY lỗi thật (giá sai, dòng 251) ra khỏi phần hiển thị. Bảng lỗi tồn tại để chỉ chỗ
CẦN SỬA, mà trần gói thì không sửa trong tệp được — nó là một câu về cả lượt nhập. Nay là một
dòng tổng, và chốt khẳng định **cả hai chiều**: lỗi thật phải thấy được, trần chỉ một dòng.
→ **Luật rút ra: một thông báo lỗi hữu ích cho từng dòng có thể làm hỏng cả bảng lỗi. Đếm xem
nó sinh bao nhiêu hàng trước khi cho nó nêu đích danh.**

Kèm: dòng lỗi không thuộc dòng nào từng để ô số dòng RỖNG (`esc(null)`), đọc thành "chưa biết
dòng nào" — sai nghĩa. Nay ghi "cả tệp".

Đo: bộ mới `admin-nhap-csv.e2e.mjs` **9/9**; đột biến **5/5 đỏ** — seller lờ `line_of` 6/3 ·
admin không gửi `line_of` 6/3 · xem trước bỏ kiểm trần 2/7 · **không nối trần qua lô 5/4** · ô
số dòng rỗng trở lại 5/4; hoàn nguyên 9/0. Đột biến thứ tư quan trọng riêng: nó chứng minh phần
"nối qua lô" là chốt ĐỘC LẬP, không bị chốt trần che. Cổng đầy đủ `exit 0` ngay lượt đầu: unit
**331** · migration DB trắng **182** · bảo mật sạch · bất biến DB **147** · E2E **109/109**,
0 log sót · smoke đủ.

**Đợt đo 3 của lát cắt 6 — LÔ HỎNG GIỮA CHỪNG.** Đã vá và merge tại `68056ac`. Đây là vai
**shop lúc có sự cố** (§5, vai ra nhiều lỗi nhất) đi vào đúng luồng mà hai lỗi ở đợt 2 vừa sống
trong đó.

Đo được (tệp 400 SP, hỏng ở lô 2): **200 sản phẩm ĐÃ vào cửa hàng thật**, còn người bán chỉ thấy
một câu — *"Không nhập được — kiểm tra quyền hoặc định dạng tệp"*. Câu đó **sai ba lần cùng lúc**:
đã nhập rồi, quyền không sao, tệp không sao. Và `results` của các lô đã xong bị `return` thẳng
**ném đi**, dù số liệu nằm sẵn trong tay.

Hai đường hỏng chứ không một, và cả hai đều im lặng về phần đã ghi: seller trả non-200 → **400**
kèm câu sai; `fetch` **NÉM** (container chết, timeout) → `call()` trong `api.js` không bắt nên
ngoại lệ thoát ra thành trang **"Lỗi" 500 trần trụi**.

Chủ dự án chốt hướng, và chốt sắc hơn đề xuất ban đầu: **không chỉ nêu con số, phải nêu SẢN PHẨM
NÀO chưa vào** để người bán biết mà thêm tiếp. Admin tự chia lô nên nó nắm trọn các lô chưa gửi —
thứ nó đang vứt đi chính là thứ người bán cần. Trang nay trả lời đủ ba câu §9.2 đòi:
- **chuyện gì xảy ra** — đã xong mấy phần tệp, phần đó **ĐÃ nằm trong cửa hàng**, lý do dừng;
- **làm gì tiếp** — danh sách đích danh sản phẩm chưa vào **kèm số dòng trong tệp**;
- **thử lại được không** — gửi lại chính tệp đó, phần đã vào bị bỏ qua chứ không nhân đôi.

Câu cuối là sự thật đã đo CẢ VÒNG, không phải trấn an: sự cố → 200 vào → gỡ sự cố → gửi lại →
đủ 400, cảnh báo biến mất. Xem trước đứt thì nói rõ **chưa ghi gì vào cửa hàng**, không doạ nhầm.

**Dựng sự cố bằng HÀNH VI SẢN PHẨM, không tiêm lỗi** — cách này đáng chép lại: `axis_names` được
admin gửi kèm MỌI lô, còn seller chặn thân yêu cầu ở 2MB. Cho lô 1 toàn sản phẩm nhẹ (đi lọt) và
lô 2 vài sản phẩm mô tả rất dài cộng `axis_names` ~1MB → đúng lô 2 bị từ chối SAU KHI lô 1 đã
ghi. Nhờ vậy cả ba mảnh của chốt đều đo bằng hành vi, không mảnh nào chỉ ghim chính tả.

Trước khi tìm ra cách đó, **phép đo tự bác lại người đo bốn lần**: trần gói 100 làm lô 2 xong
ngay (phải đổi gói `growth`) · canh giờ vô dụng vì 400 SP ghi trong **1,4 giây** · đếm bằng
`psql` cũng trượt vì mỗi lượt hỏi mất ~0,4s · và trong chính bộ test, id trục 9 chữ số không
khớp `\d{10,}` nên sự cố không xảy ra, cộng một khẳng định khớp nhầm câu của thẻ xem trước bình
thường — hai lỗi này làm 7 ca đỏ giả.

**MA TRẬN ĐỘT BIẾN BẮT ĐƯỢC LỖ TRONG CHÍNH BỘ TEST.** Đột biến "vứt kết quả các lô đã xong" cho
**12/0 XANH**: tôi đếm sản phẩm bằng SQL nên khẳng định vẫn đúng ngay cả khi trang không hiện gì
— mà cả điểm của bản vá là GIỮ kết quả để trang hiện ra. Thêm chốt đọc con số **trên trang** thì
đột biến đó thành 12/1 đỏ.
→ **Luật rút ra (lần thứ hai trong cùng lát cắt): khẳng định phải đặt ở BỀ MẶT NGƯỜI DÙNG NHÌN
THẤY. Đếm bằng SQL là đo cơ chế, không đo thứ người bán đọc được.**

Đo: bộ mới `admin-nhap-dut.e2e.mjs` **13/13**; đột biến **5/5 đỏ** — câu sai cũ 3/9 · vứt kết quả
lô đã xong 12/1 · không nêu đích danh 11/1 · gỡ khối cảnh báo 4/8 · bỏ câu không-nhân-đôi 11/1;
hoàn nguyên 13/0. Cổng đầy đủ `exit 0` ngay lượt đầu: unit **331** · migration DB trắng **182** ·
bảo mật sạch · bất biến DB **147** · E2E **110/110**, 0 log sót · smoke đủ.

**Còn nợ của lát cắt 6, chưa đo:** XLSX (`readXlsx`/`isXlsxMagic`), BOM và dấu tiếng Việt,
`update_only`/`upsert`, ảnh qua hàng rào SSRF, và giao diện 360px của trang nhập. Đường nhập ĐƠN
(`orders/import`) — xem đợt đo 4 ngay dưới.

Một nhánh chưa tự động hoá được: đường `fetch` **NÉM**. Nó đi qua `catch` riêng và chỉ khác ở CÂU
LÝ DO; đã đo TAY bằng cách dừng container giữa lượt nhập. Ai sửa khu đó phải chạy lại tay — đã
ghi ngay đầu tệp test.

**Đợt đo 4 của lát cắt 6 — ĐƯỜNG NHẬP ĐƠN CŨ.** Đã vá và merge tại `09764f0`.

Đo được: tệp 5 đơn **không có cột `order_code`**, nhập hai lần → **10 đơn**. `migrated_ref` (từ
cột đó) là thứ DUY NHẤT chặn trùng — UNIQUE `orders_migrated_ref_uq`. Người bán vừa di cư từ sàn
khác mở danh sách đơn ra thấy lịch sử nhân đôi, và đó chính là thứ họ dùng để đối chiếu với sàn cũ.

**PHÉP ĐO BÁC LẠI NGƯỜI ĐO, và đây là phần đáng nhớ nhất của đợt này.** Phản xạ đầu là "phồng
doanh thu", và một truy vấn SQL tự viết cho `sum = 2.000.000₫` đúng như vậy. Nhưng hỏi CHÍNH SẢN
PHẨM thì `/stats` vẫn `{today:0, d7:0, prev7:0, all:0}`: `reports.js` và `dashboard.js` lọc
`NOT o.is_migrated` ở MỌI truy vấn tiền, nên đơn nhập từ sàn cũ không chạm doanh thu, không chạm
P&L, không chạm hồ sơ khách. **Không phải lỗi đường tiền** — là lỗi chất lượng lịch sử đơn.
→ **Luật rút ra: đo hậu quả bằng ĐÚNG bề mặt sản phẩm, đừng tự viết SQL thay nó.** SQL tự viết
thiếu một mệnh đề `WHERE` mà mã thật luôn có sẽ đẩy người đo lên sai một bậc nghiêm trọng.

Cảnh báo cũ CÓ tồn tại (`pages.js`, bảng mô tả cột) nhưng hiện **y hệt nhau dù tệp có cột hay
không** — một chú thích luôn đúng với mọi tệp thì đọc thành nền, không thành cảnh báo.

Chủ dự án chốt: **cảnh báo về chính tệp vừa tải, CỘNG bắt xác nhận ở bước nhập thật**. Khuôn lấy
đúng của vận đơn mồ côi: lượt đầu chỉ HIỆN con số, lượt hai gửi lại CHÍNH con số đó; không ô tích
mù; đổi tệp giữa chừng thì số lệch và chốt bắt lại từ đầu. Chốt 409 nằm ở SELLER, admin chỉ
chuyển tiếp và dựng interstitial — frontend không phải nguồn quyết định (§9.2).

Đếm theo **DÒNG THẬT** (`ref === null`), không theo tiêu đề cột: tệp CÓ cột `order_code` nhưng bỏ
trống vài ô thì đúng những ô đó mới là chỗ hở, và nhìn tiêu đề sẽ bỏ sót chúng. Đột biến đổi sang
đếm-theo-cột chỉ làm đỏ **1** ca — đúng ca dựng riêng cho nó.

**Hai chỗ sổ tay ghi sai, đã sửa trong lượt này.** Mục "còn nợ" trước đây viết đường nhập đơn
"vẫn giữ nguyên câu sai *kiểm tra quyền hoặc định dạng tệp*". Đo bằng vai `catalog_manager`:
thông báo thật là **"không đủ quyền"** — câu sai chỉ là DỰ PHÒNG khi seller không trả JSON lỗi.
Và số dòng báo lỗi ở đây **đúng** (đơn thứ 22 → dòng 23) vì đường này không chia lô; đã đo chứ
không suy từ đợt 2.

Đo: bộ mới `admin-nhap-don-trung.e2e.mjs` **17/17**, gồm bốn ca biên — bấm thẳng "Nhập thật"
không xem trước thì chặn và chưa ghi gì · con số lệch thì chặn · chuỗi rác không lọt thành 0 ·
tệp hợp lệ không bị doạ nhầm. Đột biến **6/6 đỏ** — bỏ chốt 11/6 · đếm theo cột 16/1 · admin
không chuyển tiếp xác nhận 15/2 · admin coi 409 là lỗi thường 14/3 · trang không dựng khối 11/6 ·
nhận chuỗi rác làm xác nhận 16/1; hoàn nguyên 17/0.

**Đợt đo 5 của lát cắt 6 — ẢNH QUA HÀNG RÀO SSRF.** Bốn phát hiện, cả bốn đã vá.

Câu hỏi đầu tiên — *có đường nào bơm URL ra ngoài mà đi vòng hàng rào không* — trả lời bằng
cách LIỆT KÊ ĐỦ mọi lời gọi ra ngoài chứ không soi chỗ nghi ngờ: 7 chỗ ở `worker/index.js`,
`seller/server.js:85`, `seller/carriers.js` (GHN/GHTK), `checkout/geocode.js`,
`integrations/kiotviet.js`. **Mọi base URL đều từ biến môi trường**; không có đường nào để
shop tự đặt. `packages/banner-art` không chạm mạng — "cùng khuôn" trong chú thích nói về cách
mount, không phải bản sao hàng rào. `looksFetchable` ở `import.js` là bộ lọc rẻ lúc xếp hàng
và mọi thứ nó từ chối thì hàng rào cũng từ chối: trùng lặp nhưng fail-closed cùng chiều.

**P1 · TRẦN DUNG LƯỢNG KHÔNG CÓ CHỐT NÀO — fixture viết ra rồi không ai gọi.**
`import.e2e.mjs` dựng sẵn hai route `/big` (khai đúng Content-Length 9MB) và `/liar` (khai man
rồi đẩy tiếp), KÈM chú thích giải thích chúng chứng minh gì. **Không dòng nào từng gửi request
tới chúng.** Đo: gỡ CẢ HAI chốt `too_big` → unit `net-guard` **14/0**, `import.e2e` **42/0**,
xanh trọn vẹn.
→ **Luật rút ra: một fixture không ai gọi là chốt KHÔNG TỒN TẠI, chỉ trông như có.** Đọc test
thấy tên route và chú thích thì tin là đã canh — grep xem có ai *gửi request* tới nó thì không.

**P2 · `too_big` xếp nhầm nhóm, thử lại 4 lần cho một tệp không bao giờ nhỏ đi.** Nó là mã lỗi
DUY NHẤT của hàng rào rơi ngoài danh sách vĩnh viễn của worker. Đo được: `/liar` làm worker
tải TRỌN 8MB mỗi lượt trước khi trần cắt — 4 lượt = 32MB, rải qua 1+5+25 phút, kết cục vẫn
`failed`. Nay nằm cùng nhóm với `not_image` ngay cạnh nó.

**P3 · Bot và storefront trả HAI kết quả khác nhau cho cùng một sản phẩm.** `/ingest/catalog`
chạy dưới `app_rw`, mà policy vai đó chỉ lọc `shop_id`; storefront/checkout được
`store_media`/`checkout_media` lọc `status='ready'` ở mức DÒNG. Đọc từ `pg_policies` chứ không
suy bằng grep migration. Đo: sản phẩm có ảnh vị-trí-0 `failed` + vị-trí-1 `ready` cho storefront
một tấm ảnh, còn bot nhận `image=NULL` — `LIMIT 1` nhặt trúng dòng hỏng. Chú thích đầu
`ingest-catalog.js` đã tự khai "CHỈ trả thứ storefront vốn đã công khai"; nay câu đó được viết
thành SQL (`MEDIA_HIEN_SQL`).

*Giả thuyết của người đo bị bác một lần ở đây*: bảy truy vấn của storefront cũng thiếu
`status='ready'` nên tôi tưởng nó cũng thủng. Đo ra là không — policy DB gánh, và
`0011_storefront.sql:58` nói rõ đó là cố ý.

**P4 · Ảnh hỏng không có bề mặt tổng — chủ dự án chọn khuôn `notification_failures` đầy đủ.**
Đo trước khi vá: `/stats` không có khoá nào nhắc media · `todo_items` không có mã nào · Tổng
quan và danh sách sản phẩm đều im · bề mặt DUY NHẤT là ô "lỗi xử lý" trong trang sửa TỪNG sản
phẩm. Shop di cư 300 SP × 3 ảnh phải mở 300 trang mới biết, sau khi trang nhập vừa hứa "Ảnh sẽ
tải 900".

Migration `0185` thêm `media.last_error` với **CHECK từ vựng đóng** — mã lỗi là hợp đồng đi qua
worker → seller → trang, y như `provider_status` ở `0184`. `schema-invariants` so **BẰNG** ba
tập: CHECK ↔ mã hàng rào rút từ `fetch-image.js` ↔ `MEDIA_ERROR_CODES` của worker, cộng một
phép so BẰNG nữa với bảng câu chữ `LOI_CHU` để không mã nào thiếu câu cho người bán.
`app_expiry` có GRANT THEO CỘT (0106) nên cột mới KHÔNG tự vào — quên hai dòng GRANT thì worker
ghi lý do bị 42501 và sweep nuốt lỗi, dòng đứng im ở `pending`.

Trang trả lời đủ ba câu §9.2: **chuyện gì xảy ra** (sản phẩm nào, lý do bằng tiếng người) ·
**làm gì tiếp** (URL nguồn nguyên văn để đối chiếu tệp) · **thử lại được không** (nút cho lỗi ở
ĐẦU KIA; lỗi URL thì nói thẳng "sửa URL trong tệp rồi nhập lại" thay vì mời bấm một nút vô
ích). Chốt "tải lại được không" nằm ở SELLER — gọi thẳng API vẫn 409 kèm mã lý do, ẩn nút chỉ
là giao diện. **KHÔNG in mã HTTP của đích** ra trang: `fetch-image.js` ghi rõ con số đó là kênh
blind SSRF, người bán mất một chút chi tiết còn hàng rào giữ nguyên bất biến.

**BA LẦN MA TRẬN ĐỘT BIẾN BẮT LỖI TRONG CHÍNH BỘ TEST, cả ba cùng một lớp: khẳng định đo thứ
KHÁC với thứ tên nó nói.**
- Hai chốt `too_big` XẾP CHỒNG nhau, nên gỡ riêng chốt Content-Length thì chốt-khi-đang-chảy
  vẫn đỡ hộ và ảnh vẫn `failed`. Khẳng định "có chặn không" **không hề** canh chốt header. Nay
  máy chủ giả ĐẾM số MB đẩy được: 1MB khi chốt còn, 9MB khi gỡ.
- Cùng chuyện với `/liar`: gỡ chốt khi-đang-chảy thì hàng rào nuốt trọn 9MB rồi bước sniff
  magic byte mới từ chối — đỏ ở mã lỗi, không đỏ ở chỗ đáng đỏ. Nay `/liar` có 40MB để đẩy và
  chốt đo "hàng rào NGỪNG KÉO": 13MB khi còn chốt, 40MB khi gỡ. Ngưỡng 24 đặt GIỮA HAI CON SỐ
  ĐO ĐƯỢC, không đặt theo lý thuyết — `res.write` trả `true` là đã nhét vào đệm socket nên đầu
  kia còn đẩy thêm một quãng sau khi hàng rào đã `destroy`.
- Khẳng định mang chữ "VĨNH VIỄN" lại đo `fetch_attempts === 1` — mà ngay sau lượt đầu thì
  đường vĩnh viễn và đường thử-lại ĐỀU có `attempts = 1`, khác nhau ở `next_attempt_at`. Đột
  biến P2 vì thế đi qua khẳng định khác. Nay đo đúng `next_attempt_at IS NULL`.

Và ba khẳng định của chính bộ e2e mới sai vì lý do ngớ ngẩn hơn nhưng đáng chép: tên sản phẩm
fixture chứa chuỗi `404` nên chốt "không lộ mã HTTP" đỏ giả · `catalog_manager` KHÔNG mở được
Tổng quan (thiếu `orders.read`) nên chốt "vai này thấy link" phải chuyển sang đo ở CHÍNH trang
đích · `/ingest/catalog` trả khoá `image` chứ không phải `image_url`.

**MA TRẬN CÒN BẮT ĐƯỢC MỘT ĐIỂM MÙ CÓ SẴN TRONG CHỐT CŨ.** Đột biến đổi `see: CATALOG_ROLES`
→ `ORDER_ROLES` trên ô mới cho `dashboard-viec.test.js` **11/0 XANH**, dù e2e đỏ đúng chỗ
(order_manager được mời bấm vào trang sẽ 403). Nguyên nhân: chốt "điều kiện gác NGAY CẠNH" là
kiểm KHOẢNG CÁCH với cửa sổ 6 dòng, mà ô "Sắp hết hàng" ngay phía trên **cũng** khai
`CATALOG_ROLES` — nó ĐỠ HỘ ô vừa bị đổi. Đúng cái đánh đổi mà chú thích của chính chốt đó đã
cảnh báo bằng chữ, và cũng đúng thứ nó nói là chỉ ma trận đột biến mới bù được.

Vá: ô của `TODO_REGISTRY` nằm gọn MỘT DÒNG (`see:` và `href:` cùng dòng), nên với chúng đây là
kiểm PHẠM VI KHỐI được chứ không phải kiểm khoảng cách — nay khớp `see:` trên ĐÚNG dòng đó,
chỉ rơi về cửa sổ 6 dòng cho các lối đi không phải ô registry. Đo lại: đột biến ô mới **10/1**,
và đột biến một ô CÓ SẴN (`low_stock`) cũng **10/1** — tức chốt cũ trước nay không canh được cả
những ô đã tồn tại, không riêng ô vừa thêm.

Đo: bộ mới `admin-anh-hong.e2e.mjs` **25/25**, `import.e2e.mjs` **42 → 49**. Ma trận **11/11
đột biến đỏ** — gỡ chốt Content-Length 48/1 · gỡ chốt khi-đang-chảy 47/2 · bỏ `too_big` khỏi
nhóm vĩnh viễn 47/2 · worker luôn ghi `other` 47/2 và 20/5 · bỏ lọc `status` ở ingest-catalog ·
cắt dây nối `media_failures` ở `/stats` · xoá ô khỏi `TODO_REGISTRY` · đổi `see:` sang
`ORDER_ROLES` (e2e 24/1 và, sau khi siết chốt tĩnh, unit 10/1) · đổi `see:` của ô `low_stock`
có sẵn 10/1 · seller coi mọi ảnh đều tải lại được · worker khai thêm mã lỗi mà quên migration.

Cổng đầy đủ, một lượt duy nhất, `0 đỏ`: unit **331** · migration DB trắng **183**, 0 DRIFT,
0 pending · bảo mật **sạch** (chạy với seam `SECURITY_SCAN_DOCKER_ARGS` mount CA của proxy, và
scan tự khai tham số đó ngay đầu mục 1) · bất biến DB **148** · E2E **112/112**, 0 log sót ·
smoke edge/readiness/TLS đủ. Advisory moderate `decode-uri-component` vẫn ở đó, nay đo được
**bốn** instance ở `checkout`/`seller`/`worker`; 0 high · 0 critical.

**LỖI ĐO CỦA CHÍNH LƯỢT GÁC, chép lại vì nó làm hỏng bằng chứng chứ không hỏng sản phẩm.**
Lượt cổng đầu tiên tưởng chết ở bước 0 (service `toolbox` đã exited) nên tôi khởi động lại —
**mà không giết tiến trình cũ**. Hai `ci-local.sh` cùng chạy trên MỘT stack và cùng ghi vào
`/tmp/gate.log` bằng `>`: file bị cắt nhưng tiến trình cũ giữ nguyên offset nên hai luồng ghi
xen vào nhau. Hậu quả đọc được trong log là một mớ mâu thuẫn tự thân — một dòng tiêu đề bị
đè nát (`▶ 2. Quét bảo mật tĩnh (dependency/secr  FAIL security-scan…`), 6 bộ e2e của
seller-admin chết vì `57P01 terminating connection due to administrator command`, và cuối
cùng vẫn in `XANH: 119 mục, 0 đỏ`. Dòng tổng kết ấy KHÔNG sai: mỗi tiến trình đếm `fails` của
riêng nó, nên lượt về đích cuối thật sự có 0 đỏ — chỉ là nó kể chuyện của một lượt còn 7 dòng
FAIL kia là của lượt khác. Chạy lại 6 bộ đó riêng thì đủ xanh (19·14·14·46·12·10).
→ **Luật rút ra: một lượt gác phải là tiến trình DUY NHẤT trên stack, và phải kiểm bằng `ps`
trước khi tin bất cứ dòng nào trong log của nó.** Hai lượt song song không chỉ chậm hơn — chúng
tranh nhau đúng một PostgreSQL và sinh ra lỗi hạ tầng trông y hệt lỗi sản phẩm.

**Đợt đo 6 — 360px của trang "Ảnh không tải được".** Probe cho **0 tràn ở 8 phép đo**
(320/360/390/1280 × JS bật/tắt), `body{overflow-x}` vẫn là `visible` nên không có chuyện giấu
tràn bằng cắt cụt. Card-hoá của `tblCards` gánh trọn phần bảng, và đường không-JS ra ĐÚNG cùng
bố cục vì nhãn nằm sẵn trong HTML.

**Rồi mở ảnh ra xem thì thấy một lỗi mà cả 8 phép đo đều bỏ qua.** Ô URL nguồn khai
`max-width:34ch` + `text-overflow:ellipsis` + `white-space:nowrap`; trong bố cục card ô giá trị
chỉ rộng ~140px nên URL hiện ra đúng `http://127.0.0.…`, ở 320px còn ngắn hơn. Đó là thứ DUY
NHẤT trang này có để trả lời *làm gì tiếp* — người bán phải đối chiếu nó với ô trong tệp CSV —
và hai ảnh của cùng một sản phẩm chỉ khác phần đuôi sẽ hiện y hệt nhau. `title=` không cứu
được: điện thoại không có chuột để rê.

Cay hơn cả: chú thích của chính đoạn mã đó viết *"cắt ngắn bằng CSS chứ không cắt chuỗi — cắt
chuỗi thì hai URL chỉ khác phần đuôi sẽ hiện y hệt nhau"*. Lý lẽ đúng ở lớp HTML và sai ở thứ
người ta nhìn. Mọi khẳng định e2e đọc HTML nên đều xanh (chuỗi vẫn nằm đủ trong markup).
→ **Luật cũ, lần này trả giá ở chỗ mới: ĐO KHÔNG PHẢI LÀ NHÌN.** 0 tràn không có nghĩa là đọc
được. Vá bằng `overflow-wrap:anywhere` (URL bẻ dòng ở bất kỳ đâu nên ô co được dưới min-content,
không kéo tràn cột) kèm `text-align:left` — bố cục card canh phải mọi giá trị, mà URL là chuỗi
phải dò từng ký tự.

**Probe nay nằm trong kho: `scripts/probe-360.mjs`.** Ba lượt đo 360px trước đều dựng probe tạm
rồi bỏ, nên mỗi lượt lại giẫm lại cùng những bẫy — một lượt đã chạy TRỌN ở 500px trước khi bị
phát hiện. Nó mã hoá cả năm bẫy đã đo (headless_shell chứ không `chrome --headless` · tự chối
khi `innerWidth` sai · so `scrollWidth` với `clientWidth` · tha `auto|scroll` nhưng **không** tha
`hidden` · `PROBE_TIEM=1` chèn khối 3000px để đột biến chính probe). `PROBE_EXPECT` tách "bề
rộng mong đợi" khỏi "bề rộng đặt" — không tách thì phép thử chốt tự-chối không chứng minh gì,
đúng lỗi tôi vừa mắc ở lượt đầu (truyền 390 cho cả hai rồi tưởng đã thử).

Fixture đi kèm: `apps/seller-admin/test/probe-fixture-360.mjs` (không khớp glob `*.e2e.mjs` nên
không đụng manifest). Nó gieo một tên sản phẩm rất dài và một URL rất dài — chính URL dài đó
làm lộ ra lỗi trên.

Chốt thường trực trong `table-cards.test.js`: ô URL nguồn không được có `ellipsis`/`nowrap` và
phải có `overflow-wrap`. Nói thẳng giới hạn của nó ngay trong chú thích: đây là chốt CHÍNH TẢ ở
mức mã nguồn, phép đo thật vẫn là probe + mở ảnh ra xem. Đột biến: hoàn nguyên về bản cũ 4/1,
chỉ bỏ `overflow-wrap` cũng 4/1; hoàn nguyên 5/0.

**Đợt đo 7 — 360px của TRANG NHẬP.** Một lỗi, có ở **16/16** phép đo.

Bài học đầu tiên là về cách đo, không về bản vá: **trang nhập có nhiều TRẠNG THÁI, và trạng
thái rỗng là trạng thái ít vỡ nhất.** Phần dễ vỡ chỉ tồn tại SAU một POST — bảng lỗi từng dòng,
dòng trần gói, khối "lượt nhập dừng giữa chừng", interstitial xác nhận thiếu mã đơn. Nên probe
phải LÁI FORM THẬT (tải tệp + bấm đúng nút), và đó là lý do có
`scripts/probe-nhap-360.mjs`: 8 kịch bản × JS bật/tắt, dùng lại `doTranNgang` import từ
`probe-360.mjs` để kiến thức về bẫy chỉ có ĐÚNG MỘT bản.

Lỗi đo được: `input[type=file]` khai `width:auto` — cố ý, để khung nét đứt ôm sát nút — nhưng
`auto` ở control gốc là bề rộng NỘI TẠI của nó (nút + chữ "No file chosen"), và bề rộng đó
KHÔNG co. Mọi trạng thái của **cả hai** trang nhập, JS bật lẫn tắt, đều tràn **373/360**; ô nằm
ngoài mọi khối cuộn nên nó kéo CẢ TRANG cuộn ngang 13px. Cùng lớp lỗi `min-width:auto` ở §4,
chỉ khác là với control gốc thì phải chặn bằng `max-width`.

Vá ở **quy tắc dùng chung**, không ở trang: kho có 12 ô chọn tệp (logo, banner, ảnh danh mục,
ảnh sản phẩm, nhập CSV/XLSX…) và tất cả đọc đúng dòng CSS đó. Sau vá: 16/16 phép đo 0 tràn.

Ba chuyện đáng chép lại, cả ba là lỗi của người đo chứ không của sản phẩm:
- **Backtick trong chú thích nằm trong template literal** cắt đứt chuỗi — §4 đã ghi, vẫn dính,
  lần thứ hai trong hai ngày. `STYLE` là một template literal; chú thích CSS có backtick là
  `SyntaxError` báo ở dòng rất xa.
- **Guard "chạy thẳng hay được import" phải hỏi `argv[1]`, không hỏi "có đối số không".** Khi
  driver import `probe-360.mjs`, `process.argv` là argv CỦA DRIVER, nên guard theo đối số thấy
  đủ tham số rồi chạy khối CLI với đối số của người khác — đo được là `Invalid URL` ném trên
  chính chuỗi shopId.
- **Một "lỗi driver" hoá ra là chốt sản phẩm đang chạy đúng.** Nút "Nhập thật" mang
  `data-confirm`; Playwright mặc định TỰ HUỶ dialog nên form không gửi và driver hết giờ. Suýt
  bị đọc thành lỗi bố cục của riêng nhánh JS bật.

Chốt thường trực trong `table-cards.test.js`: quy tắc `input[type=file]` phải giữ `width:auto`
**và** có `max-width:100%`. Đột biến bỏ `max-width` → 5/1; hoàn nguyên 6/0. Đột biến chính
driver (tiêm khối 3000px) bắt được ở cả kịch bản GET lẫn kịch bản sau POST.

**QUYẾT ĐỊNH của chủ dự án (07/09): CÓ LỖI THÌ BẢNG LỖI LÊN TRƯỚC.** Câu hỏi là ở 360px bốn ô
số liệu của trang xem trước (Dòng trong tệp · Sẽ tạo · Biến thể · Ảnh sẽ tải) xếp dọc, mỗi ô một
thẻ cao ~200px — người bán phải cuộn ~800px qua phần tóm tắt mới tới BẢNG LỖI, tức thứ họ thực
sự cần. Trên bàn giấy bốn ô nằm một hàng nên không ai thấy vấn đề; đây là loại lỗi chỉ lộ ra khi
đo ở bề rộng thật. Ba phương án đều code được (thu gọn ô số liệu · đẩy bảng lỗi lên trước · chỉ
đổi ở bề rộng hẹp), khác nhau ở hậu quả sử dụng — chủ dự án chọn phương án hai.

Đã thi công cho **cả bốn nhánh**: xem trước và nhập thật, của cả trang sản phẩm lẫn trang đơn.

Hai điều làm rõ, vì chúng là phần dễ làm sai của chính quyết định này:
- **Đổi trong DOM, KHÔNG dùng CSS `order`.** `order` chỉ xoay phần NHÌN THẤY và để lại một trang
  mà người dùng bàn phím đi ngược và trình đọc màn hình đọc ngược — hỏng đúng ràng buộc cố định
  của mọi lát cắt frontend (§9.2). Nhờ đổi trong DOM mà chốt đo được bằng VỊ TRÍ TRONG HTML.
- **Chỉ đảo khi CÓ lỗi.** Tệp sạch thì số liệu chính là câu trả lời, giữ nguyên vị trí đầu. Chốt
  khẳng định **cả hai chiều**, nếu không thì "luôn đảo" cũng đi lọt: đột biến hoàn nguyên thứ tự
  10/1, đột biến luôn-đảo cũng 10/1, hoàn nguyên 11/0.

Nhánh nhập-thật thêm một câu dẫn trước bảng ("N dòng bị bỏ — sửa các dòng dưới trong tệp rồi
nhập lại; phần đã vào sẽ không bị nhân đôi"): đưa một bảng lên đầu mà không có câu dẫn thì người
đọc gặp bảng trước khi biết vì sao có nó.

**Đợt đo 8 — XLSX (`readXlsx`/`isXlsxMagic`).** Lớp phân tích đã có sẵn hai bộ test (zip bomb,
zip-slip, DOCTYPE/ENTITY, trần entry/dòng/cột) nên đợt này đi tìm chỗ CHƯA ai đi: tám hình dạng
tệp thật, đo thẳng trên hàm.

| hình dạng tệp | kết quả đo |
|---|---|
| đối chứng, `product_id` 19 chữ số | đọc đúng |
| `product_id` dạng số mũ `1.7310376453411E+18` | **mảng rỗng, không lỗi** |
| `product_id` ngắn (9 chữ số) | **mảng rỗng, không lỗi** |
| phần sheet không tên `sheet1.xml` | lỗi chìa đường dẫn nội bộ ra người bán |
| dữ liệu ở sheet 2, sheet 1 là hướng dẫn | "Không tìm thấy dòng tiêu đề trong 20 dòng đầu" |
| hai cột trùng tên | cột sau đè cột trước, im lặng |
| không có cột `product_id` (kiểu Shopify) | đọc đúng |
| ngày là số serial Excel | trả thô `45678` |

**Lỗi đáng vá là hai dòng đầu, và nó lộ ra ở BỀ MẶT NGƯỜI BÁN chứ không ở parser.** Đo qua đúng
đường tải tệp của admin: tệp **200 dòng** và tệp **chỉ có dòng tiêu đề** nhận **cùng một câu** —
*"Tệp không có dòng dữ liệu (cần hàng tiêu đề + ít nhất 1 dòng)"*. Câu đó sai với tệp 200 dòng và
chỉ người bán đi sửa đúng thứ duy nhất không hỏng: họ sẽ thêm dòng, xuất lại, rồi gặp lại y hệt.
Cùng lớp lỗi với *"kiểm tra quyền hoặc định dạng tệp"* ở đợt đo 3.

Nguyên nhân nằm ở chỗ **ném mất thông tin ngay tại nơi duy nhất còn biết sự thật**: bộ đọc đã
thấy tiêu đề, đã đếm N dòng, đã bỏ hết vì `product_id` không khớp `\d{10,}` — rồi `return []`.
Nay nó ném `XLSX_NO_PRODUCT_ID` kèm SỐ dòng đọc được và GIÁ TRỊ đầu tiên đọc được, để người bán
đối chiếu thẳng với ô trong tệp.

**KHÔNG tự sửa giá trị bị làm tròn** — đây là phần dễ làm sai nhất của bản vá. Một id mất bốn
chữ số cuối là một id KHÁC; nhận nó nghĩa là ghi `external_id` trỏ nhầm sản phẩm bên sàn. Việc
đúng là nói chính xác cái gì đọc được rồi để người bán lấy lại tệp gốc.

Và gợi ý nguyên nhân phải CÓ ĐIỀU KIỆN: chỉ nhắc chuyện bảng tính làm tròn khi giá trị thật sự
có dạng số mũ. Gợi ý một nguyên nhân không khớp cũng là chỉ người bán đi sai chỗ — đúng thứ câu
cũ đã làm, chỉ khác mức độ.

Chốt hai đầu, cả hai chiều: bộ đọc phải ném khi có dòng dữ liệu, và phải **vẫn trả mảng rỗng**
khi tệp chỉ có tiêu đề (nếu không thì một bản "luôn ném" cũng đi lọt). Đo: `xlsx-read.test` 3 → 7,
`admin-products.e2e` 74 → 79. Ma trận **6/6 đột biến đỏ** — quay lại trả mảng rỗng 5/2 · luôn ném
6/1 · bỏ giá trị mẫu khỏi câu 5/2 · gợi ý bảng tính cho mọi giá trị 6/1 · chìa lại đường dẫn nội
bộ 6/1 · **admin nuốt câu của parser 76/3** (khúc giữa — cùng lớp `mergeImportResults` ở đợt 1).

**Còn nợ RIÊNG của XLSX, đã đo và cố ý chưa làm:** dữ liệu ở sheet 2 vẫn báo "không tìm thấy dòng
tiêu đề" thay vì nói rõ bộ đọc chỉ đọc trang tính đầu · hai cột trùng tên vẫn đè nhau im lặng ·
ngày dạng serial trả thô (chưa ảnh hưởng vì đường nhập ĐƠN không nhận XLSX). Ba mục này cần mở
rộng bộ đọc chứ không chỉ sửa câu chữ, nên tách khỏi đợt này.

**Đợt đo 9 — BOM và dấu tiếng Việt.** Sáu hình dạng tệp, đo qua đúng đường tải tệp của admin.
Hai thứ vốn đã ĐÚNG (ghi lại để không ai "sửa" nhầm): **BOM UTF-8 được cắt sạch**, và **giá trị
có dấu đi trọn vẹn tới DB** — `"Áo thun cổ tròn — size XL"` ra đúng nguyên văn, kể cả gạch dài.

Ba lỗi, xếp theo mức độ:

**F3, nặng nhất, vì nó nhập THÀNH CÔNG.** Excel trên Windows tiếng Việt xuất "CSV" bằng bảng mã
ANSI, không phải UTF-8. `file.bytes.toString('utf8')` thay mọi byte hỏng bằng U+FFFD, nên tên
sản phẩm vào thẳng cửa hàng thật dưới dạng `"�o thun c� sau"` — đo được, đã ghi vào DB, HTTP 200,
không cảnh báo nào. Người bán chỉ phát hiện khi mở cửa hàng của chính mình ra xem. Hai lỗi kia
ít nhất còn hỏng ra mặt (0 sản phẩm); lỗi này hỏng lặng lẽ và để lại dữ liệu bẩn.

**TỪ CHỐI chứ không đoán bảng mã.** CP1258, CP1252 và Shift-JIS đều là chuỗi byte hợp lệ như
nhau; đoán sai nghĩa là ghi CHỮ KHÁC vào cửa hàng đang bán — mà lần đó còn im lặng hơn, vì không
còn dấu `�` nào để nhận ra. Câu từ chối nói đúng việc cần làm ("Lưu dưới dạng → CSV UTF-8"), thứ
người bán làm được trong 5 giây. Đây là chỗ có hơn một cách làm; tôi chọn từ chối và ghi ra đây
để chủ dự án bác nếu muốn đoán bảng mã.

**F1 · tiêu đề tiếng Việt CÓ DẤU không được nhận.** Bảng bí danh của seller vốn đã chứa
`tensanpham`, `giaban`, `tonkho`, `mota`, `danhmuc`, `masku`, `giavon`, `giagach` — tức nó được
viết RA để phục vụ người bán Việt. Nhưng `normKey` chỉ bỏ dấu cách/gạch/ngoặc, **không bỏ dấu
tiếng Việt**, nên chúng chỉ khớp khi người ta gõ tiêu đề KHÔNG DẤU, thứ gần như không ai làm. Đo:
tệp `Tên sản phẩm, Mã SKU, Giá bán, Tồn kho` cho "Sẽ tạo 0" và cả bốn cột rơi vào "Bỏ qua"; cùng
tệp đó viết không dấu thì nhận đủ. Nói cách khác **nửa bảng bí danh này chưa từng dùng được cho
ai**. Nay `normKey` bỏ dấu bằng NFD + cắt dấu tổ hợp, và `đ` xử riêng vì nó không phải chữ có dấu
tổ hợp. Đã kiểm: sau khi bỏ dấu không bí danh nào trong `COLS` đụng nhau. (`OCOLS` có sẵn MỘT chỗ
đụng từ trước — `name` thuộc cả `order_code` lẫn `customer_name`, do Shopify đặt tên cột đơn là
"Name"; không phải do bỏ dấu, không đụng tới ở đợt này.)

**F2 · UTF-16LE ra rác.** Excel "Unicode text" và vài bản xuất "CSV UTF-16" cho mỗi ký tự ASCII
kèm một byte `00`, nên tiêu đề đọc thành `h a n d l e` — trang hiện đúng mớ rác đó trong danh
sách "Bỏ qua", tạo 0 sản phẩm, không câu nào nói vì sao. Có BOM UTF-16 thì KHÔNG phải đoán: giải
mã thẳng (cả LE và BE).

Cả ba đi qua một hàm `decodeUpload` duy nhất, dùng cho CẢ đường nhập sản phẩm lẫn đường nhập đơn
— tên và địa chỉ khách là PII đi vào hồ sơ khách hàng, hỏng ở đó thì hỏng đúng thứ người bán dùng
để đối chiếu với sàn cũ.

Chốt đặt trên bề mặt người bán và **luôn có chiều ngược lại**, để không chốt nào thành "chặn mọi
thứ lạ": tiêu đề không dấu vẫn phải chạy · BOM UTF-8 vẫn phải được cắt · tệp UTF-8 có dấu hợp lệ
vẫn phải nhập được và giữ nguyên dấu tới DB. Đo: `admin-nhap-csv.e2e` 11 → 18. Ma trận **4/4 đột
biến đỏ** — normKey thôi bỏ dấu 17/1 · bỏ nhánh UTF-16 17/1 · quay lại `toString('utf8')` 15/3 ·
câu từ chối thành câu chung chung 17/1.

**Đợt đo 10 — `update_only` / `upsert`. Lát cắt 6 ĐÓNG.**

Đường TikTok **đúng trọn**, ghi lại vì phần lớn đợt này là xác nhận chứ không phải vá:
`update_price` mà chưa bật xác nhận giá → seller trả 400, giá **không đổi**, và người bán THẤY
lý do (khối "Lượt nhập dừng giữa chừng" của đợt 3 mang câu đó lên trang) · xem trước dựng bảng
khác biệt mà **không ghi gì** · nhập thật đổi đúng 450.000 → 999.000 và tồn 10 → 3 ·
`update_only` cho sản phẩm chưa từng nhập báo "không tìm thấy sản phẩm TikTok đã nhập để cập
nhật". Đường tiền ở đây có chốt và chốt giữ.

**Lỗi duy nhất nằm ở tệp KHÔNG phải TikTok.** Ghép để cập nhật chỉ làm được qua
`product_source_refs`; tệp thường không có khoá nào để ghép, và ghép theo TÊN là thứ kho này cố
ý từ chối (chính dòng chữ trên trang đã nói: *"Chỉ ghép theo mã nguồn TikTok, không ghép theo
tên"*). Nhưng trang vẫn hiện đủ ba ô chế độ cho MỌI tệp, và seller ép `flags` về `create_only`
**trong im lặng**.

Đo được: tệp CSV chọn `update_only`, đổi tên và giá một sản phẩm đã có → lượt nhập chạy ở
`create_only`, dòng đó hỏng với **"slug đã tồn tại trong shop"**, DB giữ nguyên, và ô chế độ trên
trang lặng lẽ nhảy về "Chỉ tạo mới". Câu ấy nói về một va chạm khi TẠO, cho một yêu cầu vốn không
phải là tạo — người bán đọc xong sẽ đi đổi slug, đúng thứ không liên quan. Đây là lần thứ **ba**
trong lát cắt 6 gặp cùng một lớp: câu sai đắt hơn không có câu nào ("kiểm tra quyền hoặc định
dạng tệp" ở đợt 3, "Tệp không có dòng dữ liệu" ở đợt 8).

Vá bằng đủ **ba mảnh**, và lần này ma trận chứng minh từng mảnh có chốt riêng: seller trả
`che_do_bi_ep` → `mergeImportResults` chuyển tiếp (khoá TRẮNG, đúng chỗ `cost_bo_qua` đã đứt ở
đợt 1) → trang dựng khối cảnh báo ĐẶT TRƯỚC ô số liệu. Khối nói ba thứ: đã chạy ở chế độ nào,
rằng "slug đã tồn tại" là HỆ QUẢ chứ không phải lỗi trong tệp, và điều kiện thật để cập nhật
hàng loạt (tệp TikTok, ghép theo `product_id`).

**KHÔNG mở ghép theo handle/slug.** Đó là tính năng chứ không phải bản vá, và nó cần một quyết
định về khoá ghép — mà ghép theo tên đúng là thứ giao diện đang tuyên bố từ chối. Nếu chủ dự án
muốn cập nhật hàng loạt cho tệp không phải TikTok thì đó là lát cắt riêng.

Chốt luôn có chiều ngược lại: lượt nhập bình thường KHÔNG được hiện cảnh báo. Đo:
`admin-nhap-csv.e2e` 18 → 23. Ma trận **4/4 đột biến đỏ** — seller thôi trả cờ 20/3 · cắt dây
nối 20/3 · trang không dựng khối 20/3 · luôn coi là bị ép 22/1.

**Một lần phép đo tự bác lại người đo, chép lại vì nó suýt thành 14 finding bịa:** lượt chạy
`admin-nhap-csv` ngay sau ma trận cho **9 pass, 14 fail** với những câu như "xem trước hứa ?".
Không lỗi nào có thật — bộ test chết ở `makeStaff` vì `rl:*` chưa xả, và mọi khẳng định sau đó
đọc trang rỗng. Xả rate-limit rồi chạy lại: 23/0. §4 đã ghi luật này; nó vẫn cắn khi chạy nhiều
bộ liên tiếp bằng tay.

**Lát cắt 6 `catalog + nhập từ sàn` ĐÓNG.** Mười đợt đo: quyền + giá vốn · luồng CSV · lô hỏng
giữa chừng · nhập đơn cũ · ảnh qua hàng rào SSRF · 360px trang ảnh hỏng · 360px trang nhập ·
XLSX · BOM và dấu tiếng Việt · `update_only`/`upsert`.

### Lát cắt 7 `cài đặt` — đợt đo 1

**Phần lớn đợt này là XÁC NHẬN, không phải vá — và hai giả thuyết của người đo đều bị bác.**
Chép lại vì đó mới là kết quả chính: vùng cài đặt được canh chặt hơn tôi đoán.

Bản đồ đo được: **29 route GHI** trong vùng cài đặt, **14 có step-up**. Đường tiền đúng như §3
đòi — `PUT /payment-config`, bật/tắt SePay đều `payment.write` (= chỉ `owner`) **và** step-up;
`PAYMENT_ROLES = {owner}`; `GET /payment-config` cố ý không trả số tài khoản (chỉ `has_bank`).
Mọi mục `sideNav` đối chiếu với quyền THẬT của route đích: **không vai nào được mời bấm vào
trang sẽ 403**. `Kết nối POS` gác bằng `true` nhưng đúng — `GET /integrations` khai `perm: null`
có chủ ý, còn mọi thao tác ghi ở đó đều `shop.write` + step-up.

*Điểm mù của chính phép đo, ghi ra để người sau khỏi tin quá:* 8 trang admin không có route GET
cùng tên ở seller (`/settings`, `/payment`, `/cod`, `/export`, `/reports`, `/purchasing`,
`/overview`, `/notify`) nên phép so lặng lẽ bỏ qua chúng. "(không có route GET cùng tên)" KHÔNG
đọc thành "không sao".

**Giả thuyết 1 bị bác.** Trang gác `privacy` và `require-mfa` bằng `role === 'owner'`, trong khi
bảng route khai `shop.write` (= owner + admin) — tôi tưởng giao diện nghiêm hơn API. Đo bằng vai
thật: `admin` PATCH cả hai đều **403**, đúng câu trang nói. Chốt owner nằm trong handler (ba chỗ:
`server.js:209`, `:418`, `:568`), không nằm ở bảng route.

**Giả thuyết 2 bị bác.** Tôi cho rằng ba chốt owner-only ấy không có test theo vai và định báo
đó là lỗ hổng. Đột biến chứng minh ngược: gỡ chốt `require-mfa` → `seller/e2e.mjs` **31/2** đỏ
đúng khẳng định *"non-owner đổi được require_mfa"*; gỡ cả hai chốt `privacy` →
`settings-sections.e2e.mjs` **19/2** đỏ. Cả hai đã có chốt.
→ **Luật cũ, trả giá ở chỗ mới (§4): đừng báo một lỗ hổng chốt khi chưa chạy đột biến đi qua
đúng nó.** Hai lần trong một đợt.

**Lỗi thật tìm được nằm ở chỗ khác: một LỜI HỨA KHÔNG CÓ THẬT.** Mọi câu lỗi cài đặt của seller
kết bằng *"Kiểm tra lại trường được đánh dấu rồi lưu lại"*, và seller ĐÃ gửi kèm `field_errors`
(`{tên_trường: câu lỗi}`) trong mọi phản hồi 400. Admin **vứt khoá đó** ở khúc giữa, nên không ô
nào được đánh dấu: ô sai không có `aria-invalid`, không lớp lỗi, không `autofocus`.

Đo được mức độ: trang cài đặt cao **5349px ở 360px**; khối lỗi nằm ở byte 62.760 còn ô sai ở byte
70.939. Người bán được bảo đi tìm một dấu hiệu **không tồn tại**, trên một trang phải cuộn rất
xa. Lần thứ tư trong hai lát cắt gặp cùng lớp lỗi — một câu sai (ở đây là một lời hứa suông) đắt
hơn không có câu nào.

Đúng ba mảnh của một chốt, và mảnh đứt lại là khúc GIỮA — y hệt `cost_bo_qua` (đợt 1 lát cắt 6)
và `che_do_bi_ep` (đợt 10). Vá: admin chuyển tiếp `field_errors` → trang gắn `aria-invalid` +
viền đỏ + **`autofocus`** cho đúng ô đó. `autofocus` là phần quan trọng nhất và cố ý dùng thuộc
tính GỐC: trình duyệt tự cuộn tới ô sai khi tải trang, **không cần JavaScript** — nên bản vá
phục vụ luôn đường không-JS. Ba lối vào cho cùng một thông tin: mắt (viền), trình đọc màn hình
(`aria-invalid`), và con trỏ (`autofocus`).

Chốt có chiều ngược lại: lưu ĐÚNG thì **không ô nào** bị đánh dấu — thiếu vế này thì một bản
"đánh dấu tất" cũng đi lọt và người bán thấy cả trang đỏ sau mỗi lần lưu thành công. Đo:
`admin-settings-sections.e2e` 19 → 23. Ma trận **3/3 đột biến đỏ** — cắt dây nối 20/3 · bỏ
`autofocus` 20/3 · luôn đánh dấu 22/1. Probe 360px: 0 tràn ở 320/360/390 × JS bật/tắt.

### Lát cắt 7 — đợt đo 2: `/members`. KHÔNG có bản vá, và đó là kết luận.

**Bốn giả thuyết, bốn lần bị bác.** Vùng quản trị thành viên được canh đủ; đợt này chỉ bổ sung
BẰNG CHỨNG cho điều đó, để người sau khỏi đo lại. Mọi dòng dưới đây là số đo bằng vai thật, không
phải đọc mã.

| đo gì | kết quả |
|---|---|
| `admin` (có `members.read`, không `members.write`) | xem 200 · mời/đổi-vai/xoá đều **403** |
| `order_manager` | xem **403**, mọi thao tác ghi **403** |
| owner CHƯA step-up mời thành viên | **403 `step_up_required`** |
| owner duy nhất tự hạ vai mình | **409** "không thể bỏ owner cuối cùng" |
| owner duy nhất tự xoá mình | **409** "không thể xoá owner cuối cùng" |
| token của lời mời ĐÃ THU HỒI | **400**, và **0** thành viên được tạo |
| dùng lại token đã nhận | **400** |
| trang `/members` với vai `admin` | không form mời, không nút đổi vai — §9.3 giữ đúng |
| `order_manager` mở `/members` | **403**, giữ nguyên thanh điều hướng (đợt 3 sửa lại câu này) |

Đường chấp nhận lời mời viết cẩn thận sẵn: điều kiện `revoked_at IS NULL` lặp lại ở **cả** SELECT
lẫn UPDATE, kèm chú thích nói rõ vì sao — khe giữa hai câu đúng là khoảnh khắc người bán bấm Huỷ
vì vừa nhận ra mời nhầm. Email lấy từ DÒNG lời mời chứ không từ request, nên không đổi hướng
được sang email khác.

**Hai đột biến chứng minh chốt có thật**, sau khi tôi định báo là "không có test":
gỡ chốt owner-cuối-cùng ở CẢ `changeRole` lẫn `removeMember` → `seller/e2e.mjs` **31/2** đỏ ·
bỏ `revoked_at IS NULL` ở cả SELECT lẫn UPDATE của accept → `admin-account.e2e.mjs` **37/3** đỏ.
Cộng hai lần ở đợt 1 (`require-mfa`, `privacy`), đó là **bốn lần trong một lát cắt** tôi suýt báo
một lỗ hổng chốt mà chốt vẫn còn đó.
→ **Luật §4 đọc thêm một lần nữa cho thấm: chưa chạy đột biến đi qua đúng chốt thì chưa được nói
nó không tồn tại.** Grep không thấy tên chốt trong test KHÔNG phải bằng chứng.

**Câu treo từ đợt 1 nay đã đóng: `POST /members/invitations/:id/revoke` KHÔNG đòi step-up, và đó
là CỐ Ý ĐÚNG.** Đo: owner chưa step-up thu hồi được (200) và token chết ngay (400). Step-up có để
gác thao tác **cấp thêm** quyền; thu hồi là thao tác **rút bớt**, và chú thích của chính đường
accept gọi đó là khoảnh khắc gấp. Bắt step-up ở nút cứu hoả trong khi nút nguy hiểm cũng chỉ tốn
đúng một step-up là làm chậm đúng cái cần nhanh. Không sửa.

**Hai lỗi của chính người đo trong đợt này**, chép lại vì cả hai đều tạo ra số đo sai:
- Chạy `apps/auth/test/e2e.mjs` trong `dbtest` → không có dòng tổng kết, và tôi suýt đọc thành
  "đột biến làm đỏ". §1 đã ghi: đó là **ngoại lệ DUY NHẤT**, phải chạy trong container `auth`.
  Chạy đúng chỗ: **74/0**.
- Probe rút "câu trang nói" bằng regex `<p class="muted">` và trúng **chú thích trong CSS nội
  tuyến** — trang 403 hoàn toàn bình thường, chỉ phép trích là sai. Cùng họ với luật "cắt đúng
  khối rồi mới khớp" (§4).

### Lát cắt 7 — đợt đo 3: `/api-keys` (khoá kết nối). Vùng quản lý khoá SẠCH; cửa `/ingest/*` thì không.

**Phần quản lý khoá không có gì để vá.** Đo bằng vai thật, cộng vào bộ `api-keys.e2e.mjs` đã có
sẵn (28 khẳng định, nhưng CHỈ đăng nhập bằng `owner` — đúng điểm mù §4 nói tới):

| đo gì | kết quả |
|---|---|
| `admin` (có `shop.write`) | xem 200 · tạo 201 · thu hồi hoạt động |
| `order_manager` / `catalog_manager` | cả ba route **403 "không đủ quyền"** |
| owner CHƯA step-up **tạo** khoá | **403 `step_up_required`** |
| owner CHƯA step-up **thu hồi** khoá | **200** — và token chết ngay (`ingest` 401) |
| trần `MAX_KEYS_PER_SHOP` | khoá thứ 11 → **400**, DB đúng 10 khoá sống |
| khoá `system_owned` (bot Messenger) | **không** hiện trong danh sách · owner thu hồi → **404** |
| khoá shop B đọc sản phẩm shop A qua `/ingest/catalog` | **404** |

Bất đối xứng step-up ở `revoke` là **cố ý đúng**, cùng học thuyết với `invitations/revoke` (đợt 2)
— và ở đây chú thích ngay trên route đã nói thẳng: *"khi nghi khoá bị lộ, ma sát thêm một bước là
thêm phút để kẻ cầm khoá tạo đơn"*. Câu treo từ đợt 1 đóng lại, không sửa gì.

**Lỗi tìm được nằm ở CỬA KIA của cùng lát cắt: `/ingest/*` không biết shop đã bị đóng.**
Đo bằng cách đẩy đơn qua khoá ở ba trạng thái shop, cùng lúc gõ cửa storefront:

| `shops.status` | storefront | `POST /ingest/orders` | tồn |
|---|---|---|---|
| `active` | 200 | 201 | giữ chỗ +1 |
| `suspended` (nợ phí) | **503** | **201** | giữ chỗ +1 |
| `terminated` (đã chấm dứt) | **404** | **201** | giữ chỗ +1 |

Điều làm nó thành LỖI chứ không phải câu hỏi mở, ít nhất ở nhánh `terminated`: chú thích của
chính `terminateShop` (`platform/src/server.js:594`) **liệt kê ra** các chốt phải dừng phục vụ —
*"storefront: policy `store_shop` (0011) … checkout: policy `checkout_shop` (0012) … tls-authorize"*
— và kết luận *"Serving DỪNG TỰ NHIÊN qua các chốt sẵn có"*. Danh sách đó viết **trước** khi có
khoá kết nối (`0120`), nên cửa Bearer không nằm trong đó và không ai để ý. Đúng bài học §9.2: vá
từng trường hợp thì trường hợp thứ tư vẫn nằm đó — ở đây là cửa thứ tư mà bản liệt kê bỏ sót.

Hậu quả đo được: shop đã chấm dứt hợp đồng (`deleted_at` đã đóng, storefront 404) **vẫn nhận đơn
và vẫn giữ chỗ tồn**. Khách vừa chat với bot nhận xác nhận đơn cho một cửa hàng không còn tồn tại.
Và vì `apps/messenger` đẩy đơn qua **đúng cửa này** (`server.js:240`, Bearer khoá `system_owned`),
bot Facebook của shop đã đóng vẫn chào hàng, vẫn chốt đơn.

Nhánh `suspended` thì là **quyết định kinh doanh**, không phải lỗi hiển nhiên — xem câu hỏi treo
phía dưới. Cả hai nhánh chung một chỗ vá (`resolveApiKey` / `handleIngest`), nên cũng chung một
quyết định.

**BỐN LẦN PHÉP ĐO BÁC LẠI NGƯỜI ĐO trong đợt này** — nhiều hơn mọi đợt trước, và cả bốn đều là
lỗi của phép đo chứ không của sản phẩm:
- Gọi `/ops/shops/:id/status` (route KHÔNG tồn tại; route thật là `/suspend`, và đòi step-up của
  nhân viên nền tảng). Shop đứng nguyên ở `onboarding` mà probe vẫn in ra một bảng trông rất
  thuyết phục. **Dấu hiệu duy nhất là dòng in kèm `shops.status`** — nếu không in trạng thái thật
  ra cạnh kết quả thì lượt đo đó đã thành một finding bịa.
- Rút thanh điều hướng bằng `<nav class="side"` trong khi markup là `<nav class="side-nav">` →
  **0 mục**, và tôi suýt báo "33/48 trang 403 là ngõ cụt". Sửa selector rồi vẫn 0 mục vì lỗi thứ
  hai: `<a …>([^<]*)<` không băng qua `<svg>` nằm ngay trong thẻ `a`. Dump HTML thô ra mới thấy
  nav **có đủ**. Cùng họ với lỗi regex trúng chú thích CSS ở đợt 2 — hai đợt liên tiếp.
- Vì thế **sửa lại một câu sổ tay đợt 2 tự ghi sai**: "trang `/members` 403 CÓ nêu màn hình họ mở
  được" là không chính xác. Đo đúng: trang 403 giữ **nguyên thanh điều hướng** với các mục vai đó
  mở được (nên không ai bị kẹt), nhưng **chỉ `/overview`** có nút nêu ĐÍCH DANH màn hình thay thế
  (`landingPath`, vá từ lát cắt 2). 47 trang còn lại dùng `renderError` không tham số `action`.
  Đó là khoảng cách so với §9.3 luật 3, nhưng là chuyện CÂU CHỮ, không phải ngõ cụt.
- Hỏi seller bằng đường `/telegram/config` bịa ra (thật là `/telegram`) → 404, suýt đọc thành
  "vai này không có route". Đúng lỗi §4 "tự viết SQL thay sản phẩm", đổi sang đường HTTP.

**Một lỗi phụ có thật, đo được, ghi lại chưa vá: `/notify` và `/shipping` trả HTTP 502 cho một
vai chỉ đơn giản là không đủ quyền.** `notifyPage` và `shippingPage` gộp MỌI non-200 về `502`
(`server.js:1076`, `:1108`), trong khi `apiKeysPage` ngay cạnh đã viết đúng
(`r.status === 403 ? 403 : 502`). Đo bằng `catalog_manager`: trang trả **502** mà chữ trong trang
là **"không đủ quyền"** — mã trạng thái nói "hệ thống hỏng, thử lại đi", câu chữ nói "vai của bạn
không mở được". Một trang tự mâu thuẫn, và mọi phép đếm 5xx coi một lần phân quyền bình thường là
một lần hạ tầng hỏng.

### Lát cắt 7 — đợt đo 4: ĐƠN CHỜ TẠO (`0186`). Bản vá cho chính lỗi đợt 3 đo được.

**QUYẾT ĐỊNH của chủ dự án (07/09), phương án (b):** shop `suspended` **vẫn nhận** đơn từ khoá
kết nối nhưng **KHÔNG giữ chỗ tồn** và phải hiện ra thành việc cần xử lý; shop `terminated` bị
từ chối hẳn.

**Phần dễ làm sai nhất của chính quyết định đó, và là lý do có một BẢNG RIÊNG chứ không phải một
cờ trên `orders`:** cả hệ thống dựa trên bất biến *"một dòng `orders` đang sống thì ĐANG GIỮ CHỖ
đúng số hàng của nó"*. `consumeAndShip` (`orders.js:670`) trừ `reserved -= qty`, đường huỷ và
đường sửa đơn cũng vậy — tất cả đều `GREATEST(0, …)`. Một đơn KHÔNG giữ chỗ mà nằm trong `orders`
sẽ, lúc được gửi hay bị huỷ, **NHẢ CHỖ CỦA ĐƠN KHÁC**: `reserved` 3 → 2 trong khi ba đơn kia vẫn
đang chờ hàng. Kẹp `GREATEST(0, …)` không cứu được vì con số vẫn dương — nó chặn số âm, không
chặn trừ nhầm người. Hỏng im lặng, và chỉ lộ ra khi khách thứ ba tới lấy hàng.

Nên đơn nhận lúc tạm ngưng nằm ở `held_ingest_orders` tới khi cửa hàng chạy lại, rồi đi qua ĐÚNG
`createOrderCore` như mọi đơn khác — **giá và tồn tính tại thời điểm tạo thật**, không phải thời
điểm nhận. Hứa lại giá của hai tuần trước là hứa một con số không còn thật. `createManualOrder`
được tách làm hai (`createManualOrder` ghi ra `res`, `createOrderCore` trả `{code, body}`) chứ
KHÔNG chép hàm: §3 — đường tiền không được có bản thứ hai.

Chốt "chỉ chốt được khi cửa hàng ĐANG HOẠT ĐỘNG" không phải trang trí — chốt lúc còn tạm ngưng
chính là giữ chỗ tồn cho một shop đang bị khoá, đúng thứ quyết định (b) nói là không.

Bot Messenger có nhánh riêng cho 202: nói *"shop đã nhận, sẽ liên hệ lại"*, KHÔNG nói "thành
công" (không có mã đơn để hứa) và KHÔNG nói "chưa tạo được đơn" (mời khách thử lại vô ích — thử
lại chỉ ra đúng dòng chờ cũ). Giỏ được dọn và `placeSeq` tăng như lần đặt thành công, vì yêu cầu
đã tới shop rồi. Lý do shop bị tạm ngưng KHÔNG nói ra: chuyện tiền giữa shop và nền tảng không
phải việc của khách, và nói ra là làm hỏng uy tín của chính shop trên kênh của họ.

**BA LỖI CỦA CHÍNH LƯỢT THI CÔNG, cả ba cùng một họ: quét PII chạy nhưng không xoá gì, và im
lặng về điều đó.** Chép lại vì đó là lớp lỗi 0185 vừa ghi cho chiều GHI, còn đây là chiều ĐỌC.
- Bản đầu chỉ `GRANT DELETE` cho `app_expiry`. Câu quét `DELETE … WHERE ctid IN (SELECT … WHERE
  received_at < …)` cần SELECT trên `received_at` — Postgres đòi quyền đọc **mọi cột xuất hiện
  trong WHERE, kể cả WHERE của chính lệnh DELETE**. Sweep bắt exception, ghi log, trả
  `deleted: 0`; nhìn từ ngoài là "chạy bình thường" còn PII nằm lại mãi.
- Thêm `GRANT SELECT (id, received_at)` vẫn `permission denied`: **`ctid` là cột HỆ THỐNG và đòi
  SELECT CẤP BẢNG** — grant theo cột không phủ nó. Mà cấp bảng nghĩa là vai dọn dẹp đọc được
  `payload`, tức nhìn thấy đúng thứ nó tồn tại để xoá. Đổi lô sang `id` (cột thường) giữ được cả
  hai.
- Vẫn `deleted: 0`: policy `FOR DELETE` không cho SELECT, nên câu con trả 0 dòng dưới FORCE RLS —
  **không lỗi nào cả**. Nay là `FOR ALL … USING (true) WITH CHECK (false)`, đúng khuôn `expiry_gc`
  của `messenger_sessions` (0123).
→ Bất biến mới trong `schema-invariants` khoá cả ba: `app_rw` KHÔNG có DELETE (mất bằng chứng
đơn khách đã đặt) · `app_expiry` đọc được `received_at` nhưng **KHÔNG** đọc được `payload` ·
từ vựng `resolution` so BẰNG với tập mà `held-orders.js` thật sự ghi.

**Chốt cũ bắt đúng HAI lỗi thật của lượt này**, cả hai là thứ tôi tự quên chứ không phải sản
phẩm sai: thêm ô `held_orders` vào `TODO_REGISTRY` mà quên khai `/held-orders` trong
`CHINH_SACH_DICH` → `dashboard-viec.test.js` **10/1** (đúng thứ MANIFEST LỐI ĐI sinh ra để
chặn); và thêm một lời gọi `tblCards` cho trang mới mà quên bảng đếm → `table-cards.test.js`
**5/1** ở bước 1 của cổng. Cả hai đều là chốt "so BẰNG, không phải ≥" — chúng đỏ theo CẢ HAI
chiều, và đó là lý do chúng bắt được.

**Một lỗi nữa tìm được khi tự đọc lại diff, không phải khi chạy test: nhật ký gán nhầm ACTOR.**
`createOrderCore` suy `actor_type` từ `ctx.apiKeyId` — đúng suốt từ 0120 vì mọi đơn có khoá đều
do máy tạo. Đường chốt đơn chờ phá giả định đó: nó **phải** truyền `apiKeyId` (để lấy đúng luật
giá flash-sale của bot, và để `orders.api_key_id` còn truy được tích hợp nào đẩy về) trong khi
người bấm nút là NGƯỜI THẬT. Kết quả là một dòng `order.created_manual` ghi
`actor_type='system'` kèm `actor_id` của một con người — tự mâu thuẫn, đúng thứ nhật ký tồn tại
để không có. Hai câu hỏi khác nhau (*ai làm* và *đơn đến từ đâu*) bị gộp vào một cờ. Nay actor và
kênh suy từ `ctx.user`; đường `/ingest` thuần không đổi vì ở đó `ctx.user` vốn rỗng.

Đo: bộ mới `held-orders.e2e.mjs` **41/41**, `bot.e2e.mjs` 56 → **62**, bất biến DB **148 → 149**.
Ma trận **15/15 đột biến đỏ** — gỡ chốt shop-đã-đóng 34/4 · gỡ nhánh tạm ngưng 9/17 · gỡ chốt
shop-phải-hoạt-động khi chốt 19/8 · bỏ `ON CONFLICT` 37/1 · cắt dây nối `/stats` 37/1 · bỏ chốt
chốt-lần-hai 36/2 · bỏ chốt bỏ-lần-hai 37/1 · trang thôi nói "chưa giữ chỗ hàng" 37/1 · shop đã
đóng chỉ chặn đơn chứ không chặn catalog 37/1 · đánh dấu đã chốt mà không tạo đơn 22/5 · bot bỏ
nhánh 202 60/2 · đổi `see:` của ô mới sang `CATALOG_ROLES` 10/1 · thu hồi GRANT theo cột của
`app_expiry` 61/1 · policy `app_expiry` quay về `FOR DELETE` 39/1 · suy actor nhật ký từ
`apiKeyId` như bản cũ 40/1.

**Còn nợ của đợt này, đã biết và cố ý chưa làm:** không có nút "chốt tất cả" (mỗi lần chốt là một
lượt kiểm tồn + giá riêng, gộp lại thì một dòng hết hàng làm hỏng cả lô mà người bán không biết
dòng nào) · đơn chờ không có bề mặt cho khách tự tra (họ chưa có mã đơn để tra) · mở lại cửa hàng
KHÔNG gửi thông báo nào cho người bán rằng có đơn đang chờ — họ phải tự mở Tổng quan mới thấy ô,
mà đúng lúc vừa trả xong phí thì đó không phải màn hình đầu tiên họ mở.

### Codex tiếp nhận đợt 4 — 08/09: đã qua cổng, CHỜ CLAUDE REVIEW

Nhánh `codex/held-ingest-verification` nối từ `f663bf9`; `main` vẫn ở `c337abd`.
Stack riêng `nentang-e2e-held0186` dựng từ worktree mới, không dùng DB của stack orphan,
không cần patch CA hay tắt xác minh TLS.

**Lỗi tranh chấp đo được trên bản bàn giao:** `acceptHeldOrder` giữ `FOR UPDATE` trong
transaction đọc rồi COMMIT trước khi gọi `createOrderCore`. Giữ khoá tồn bằng một kết nối DB
để dừng đúng giữa đường tạo đơn, sau đó gọi Bỏ: **accept=201, drop=200**, dòng chờ lại
`resolution='dropped', order_id=NULL` dù đơn thật đã giữ tồn. Bộ cũ vẫn qua 41 ca; thêm ca
đồng thời cho **41 pass / 1 fail**. Idempotency chống hai đơn nhưng không chống tạo một đơn
sau khi người bán đã bỏ yêu cầu.

Vá: `createOrderCore` nhận client của `withTenant` nếu người gọi đã mở transaction; đường
tạo đơn tay vẫn tự mở như trước. Chốt đơn chờ giữ khoá shop (`FOR SHARE`) và dòng chờ tới khi
tạo đơn, giữ tồn, ghi outbox, đánh dấu accepted và audit cùng commit hoặc rollback. Ca đo
đồng thời nay **42/42**: accept=201, drop=404, dòng chờ trỏ đúng đơn và tồn tăng đúng một.
Ca thử chờ `pg_stat_activity` xác nhận request đang bị khoá, không đoán thứ tự bằng sleep.

**Lỗi cổng trên Windows:** test lời khai scanner chỉ tìm `/bin/bash` hoặc `/usr/bin/bash`
nên unit ra **336/337**. Thêm đường Git Bash và chuyển đường stub qua `cygpath` trước khi
thêm vào PATH; kiểm dấu `AUDIT_DOCKER_STUB` để chứng minh lệnh giả thực sự được gọi. Bản
chuyển đường đầu tiên vẫn giữ `C:` trong PATH Unix khiến Docker thật chạy; dấu kiểm và
exit code đã bắt lỗi đó. Sau sửa: release-gates **9/9**, unit **337/337**; Linux giữ cách
tìm Bash cũ. Stub tạm tự dọn sau test.

**Cổng đầy đủ trên bản vá:** `bash scripts/ci-local.sh` **exit 0, 120 mục xanh, 0 đỏ** —
unit **337/337** · migration DB trắng **184**, 0 DRIFT, 0 pending · security-scan sạch ·
bất biến DB **149/149** · E2E **113/113**, gồm held-orders **42/42**, bot **62/62**,
manual-orders **25/25**, shipping **118/118** · smoke edge/readiness/TLS đều PASS.
Lượt đầu dừng sau khi tìm lỗi unit Windows; các số đầy đủ này thuộc MỘT lượt chạy lại
sau bản sửa, không ghép các lượt. Không thêm bộ nên manifest giữ **42 unit / 113 E2E**.

**Claude review trước khi merge:** ưu tiên ranh giới transaction mới của `createOrderCore`
và ca accept/drop đồng thời; quyền `app_expiry` và migration `0186` giữ nguyên. Bất biến DB
và ca worker dọn PII đã chạy thật trên stack mới. Cổng xanh chưa thay thế review chéo (§9.1).

**Bổ sung sau review F1–F3:** ca hết hàng lúc chốt dựng hai biến thể qua API, tạo đơn chờ
khi suspended rồi mở lại và dùng một đơn thật tiêu hết tồn biến thể thứ hai. Chốt hụt phải
rollback cả reserve dòng đầu, số đơn, idempotency claim và giữ dòng chờ chưa xử lý; lý do
hết hàng phải qua redirect rồi hiện trong ô lỗi admin. Giữ drop=404 có chú thích giải thích
tập tài nguyên chưa xử lý, khác accept=409; thêm phép đo UPDATE shop phải chờ khoá SHARE.

Ma trận trên bộ held-orders: ghi accepted và COMMIT sớm trước tạo đơn **42 pass / 6 fail**;
nuốt lỗi createOrderCore trong transaction **45 pass / 3 fail**; bỏ FOR SHARE **47 pass / 1 fail**;
hoàn nguyên **48/48**. Đột biến đầu cố ý phá ranh giới commit: chỉ dời UPDATE lên trước nhưng
vẫn trong cùng transaction thì lỗi tạo đơn vẫn rollback, không phải lỗi nguyên tử.
Cổng đầy đủ lượt bổ sung cũng **exit 0: 120 mục xanh, 0 đỏ**: unit **337/337**, migration DB
trắng **184** (0 DRIFT/pending), security-scan sạch, bất biến DB **149/149**, E2E **113/113**
(held-orders **48/48**), smoke edge/readiness/TLS đều PASS. Kiểm PID/PPID xác nhận một lượt
cổng duy nhất; tiến trình Bash phụ là con, không phải lượt chạy độc lập. Chưa merge, chờ Claude review.

> ### Bàn giao lịch sử của Claude tại f663bf9 — khi đó CHƯA QUA CỔNG
>
> **Trạng thái:** nhánh `claude/don-cho-tao-0186`, commit `e9873da` (19 tệp, +931/−26), đã push.
> **`main` cố ý ĐỨNG NGUYÊN ở `c337abd`** — §9.4 cấm fast-forward khi cổng chưa exit 0, và nó
> chưa exit 0 lần nào. Đừng merge cho tới khi chạy xong cổng.
>
> **Vì sao chưa xong:** container dev bị dựng lại giữa lượt gác, và container mới **không kéo
> được image Docker Hub** — `production.cloudfront.docker.com` trả **403** từ egress policy
> (`/root/.ccr/README.md` nói rõ: báo host bị chặn, đừng đi vòng). Không image ⇒ không stack ⇒
> không chạy được `ci-local.sh`.
>
> **Đã đo được, tin được** (lượt gác dang dở + chạy tay, trên đúng commit này):
>
> | bước | kết quả |
> |---|---|
> | unit + `manifest_check` | **337/337**, rc=0 — chạy thẳng ở máy, KHÔNG cần Docker |
> | migration từ DB TRẮNG | **184**, 0 DRIFT, 0 pending |
> | quét bảo mật tĩnh | sạch (chạy với seam `SECURITY_SCAN_DOCKER_ARGS` mount CA) |
> | bất biến DB | **149** |
> | E2E | **79/113 bộ, 0 FAIL** — gồm `held-orders` 41/0 và `bot` 62/0 |
> | smoke | **CHƯA CHẠY** |
>
> **34 bộ e2e cuối chưa chạy lần nào.** Đó là khoảng trống thật, không phải hình thức.
>
> **Việc còn lại, đúng thứ tự:**
> 1. Dựng stack (`up -d --build` + `run --rm migrate`). Môi trường có proxy chặn TLS thì `npm ci`
>    trong Dockerfile chết với `SELF_SIGNED_CERT_IN_CHAIN` — npm che nó thành *"Exit handler never
>    called"*, dễ đọc nhầm thành lỗi npm/OOM. Cách đã dùng: chép `ca-bundle.crt` vào build context
>    rồi `ENV NODE_EXTRA_CA_CERTS=… NPM_CONFIG_CAFILE=…` ngay trước dòng `npm ci`. **Patch đó là
>    TẠM, gỡ trước khi commit** — nó đã được gỡ sạch khỏi `e9873da`.
> 2. `bash scripts/ci-local.sh` — MỘT tiến trình duy nhất, kiểm bằng `ps` trước khi tin log
>    (§9.3b đã có bài học hai lượt gác song song). Lượt phụ thấy trong `ps` có thể là subshell
>    CON của chính cổng — phân biệt bằng PPID.
> 3. Xanh ⇒ fast-forward `main`, không merge commit.
>
> **Hai chỗ đáng soi khi review, vì chúng là phần rủi ro nhất của lát cắt:**
> - `createManualOrder` tách thành `createOrderCore` — đụng ĐƯỜNG TIỀN. Là phép tách thuần (8 câu
>   `return send(res, 400, …)` thành `return {code, body}`), nhưng đáng đọc lại từng câu.
> - Bảng `held_ingest_orders` giữ **PII** trong `payload`. Quyền của `app_expiry` đã bị đo ba lần
>   mới đúng (xem phần trên); bất biến mới khoá cả ba chiều — đừng nới nó cho tiện.
>
> Alternativ nếu máy vẫn không kéo được image: CI đám mây chạy được trên nhánh bằng
> `workflow_dispatch` (scope `e2e`) — `push` chỉ kích hoạt cho `main`, nên đẩy nhánh KHÔNG tự chạy CI.

### Lát cắt 7 — đợt đo 5: `/domains`. KHÔNG có bản vá cho vùng này; chốt mới nằm ở chỗ khác.

**Điểm mù phải nói trước, vì nó quyết định đọc phần dưới thế nào:** không dựng được stack
(`production.cloudfront.docker.com` trả **403** từ egress policy, đúng host đã ghi ở khối bàn
giao phía trên), nên lượt này chỉ đi được **bước 1 của §9.2 — bản đồ chỉ-đọc**. Mọi thứ đi qua
HTTP/DB là **chưa đo**. Riêng `hostname.js` là mã THUẦN nên đột biến chạy được, và đó là chỗ
duy nhất lượt này có số thật.

Bản đồ: `DOMAIN_ROUTES` 6 route — `GET /domains` và `GET /domains/:id` `perm: null`; ba đường
ghi (`POST`, `…/primary`, `DELETE`) đều `domain.write` + **step-up**; `POST …/check` `perm: null`
không step-up nhưng **có** `overCheckLimit(shopId)` → 429. Nav gác `DOMAIN_ROLES={owner}`;
`domainsPage` gác lại `roleFor !== 'owner'`. Worker `sweepDomainVerify` chạy dưới vai
`app_domainverify` riêng (0027), cố ý không JOIN `shops`. SQL của tls-authorize đã lọc sẵn
`s.status <> 'terminated' AND s.deleted_at IS NULL` — **cửa cấp cert không dính lỗ "shop đã
đóng" của đợt đo 3**.

**Ba giả thuyết của người đo, cả ba bị bác** (chép lại vì đó là kết quả chính của vùng này):
- Non-owner mở `/domains` sẽ thấy danh sách RỖNG, tức trang nói dối về trạng thái → bác:
  `renderDomains` có nhánh riêng, nói đúng *"Chỉ chủ cửa hàng mới quản lý tên miền"*.
- `domainsPage` sớm-return **vứt** tham số `err`, nên non-owner POST xong không thấy lý do →
  bác: trang non-owner vẫn nói đúng lý do, `err` bị vứt là vô hại.
- `checkDomain` không có rate limit → bác: có, theo shop.

**Thứ tìm được là RỦI RO CẤU TRÚC, không phải lỗ hổng đã chứng minh.**
`apps/seller/src/hostname.js` và `apps/tls-authorize/src/hostname.js` là **hai bản chép**, và
tls-authorize **không có bind-mount nào** (build context `../apps/tls-authorize` ⇒ image không
có `packages/`). Chúng **đã trôi 26 dòng**: `MULTI_LABEL_SUFFIX` + `isApex` chỉ có ở bản seller.
Trôi hôm nay **lành** — `isApex` tự khai "KHÔNG BAO GIỜ dùng cho quyết định bảo mật" và tls
không import nó; dòng 1–51 giống nhau từng byte. Nhưng **mỗi bản chỉ có chốt RIÊNG**: tls có
`apps/tls-authorize/test/hostname.test.js` (15/15), seller có `domains.e2e.mjs:183-185`. Vá bug
ở một bản thì cả hai bộ vẫn xanh. Đo: gỡ `isReserved` ở bản **seller** → unit **337/337 XANH**.

Chủ dự án chọn phương án **(a)** trong ba phương án (unit so hai bản · đưa về `packages/` +
bind-mount · để nguyên và ghi sổ). Bộ mới `apps/seller/test/hostname-hai-ban.test.js`, cùng nhà
với `shared-sql.test.js` — bộ vốn đã sinh ra cho đúng lớp lỗi "một luật viết ở hai nơi rồi trôi".

**Khẳng định là XỬ SỰ GIỐNG, không phải GIỐNG TỪNG KÝ TỰ.** So byte là chốt CHÍNH TẢ và nó
**sai ngay hôm nay** — 26 dòng lệch kia hợp lệ. Corpus gồm ca viết tay đi qua từng chốt + quét
sinh máy tất định trên bảng chữ cái thù địch, chạy qua cả hai bản, so **BẰNG** từng kết quả;
`isReserved` so trên tích của corpus với 5 giá trị `platformDomain`. (Bản đầu ghi "3.042" là
sai — `CA_TAY` có 43 ca nên lúc đó là 3.043. Số hiện tại xem phần Codex ngay dưới.)

**Chốt tự-chối, và ma trận chứng minh nó sống.** Không có nó thì một đột biến làm CẢ HAI bản
luôn trả `null` vẫn "bằng nhau" và bộ này xanh trong khi không còn chứng minh gì — cùng nguyên
tắc với probe 360px phải tự chối khi khung nhìn sai (§4). Đột biến số 8 đúng là ca đó: **2/1 đỏ**
ở chính khẳng định tự-chối.

Ma trận **7/8 đột biến đỏ** — HOSTNAME_RE nhận một nhãn 1/2 · tls gỡ chốt TLD toàn chữ số 2/1 ·
tls bỏ trần 253 ký tự 2/1 · seller thôi hạ chữ thường 2/1 · seller `isReserved` luôn false 1/2 ·
tls `isReserved` dùng `includes` 2/1 · cả hai luôn null 2/1; hoàn nguyên 3/0.

**Ca thứ tám xanh, và nó xanh ĐÚNG — đây mới là phần đáng nhớ của đợt này.** Lượt ma trận đầu
tiên có **ba** đột biến ra xanh và tôi suýt đọc thành "chốt thủng". Đo lại chính phép đo thì ra:
`HOSTNAME_RE` (`^LABEL(\.LABEL)+$`) đã từ chối `*`, `_`, `:` trước khi ba dòng gác mang đúng tên
đó được dùng tới, còn chốt IP-literal `/^\d+(\.\d+)+$/` bị chốt TLD-toàn-chữ-số ngay dưới nó
nuốt trọn (`1.2.3.4` tận cùng là `.4`). **Bốn dòng gác đầu `normalizeHostname` CHẾT VỀ HÀNH VI** —
xoá cả bốn thì không phép đo nào trong kho đổi một con số. Chúng vẫn đúng và vẫn fail-closed nên
không sửa, nhưng ba khẳng định trong `apps/tls-authorize/test/hostname.test.js` mang tên
*"từ chối wildcard"*, *"từ chối gạch dưới"*, *"có port"* thật ra **đi qua một chốt khác** — đúng
lớp "xanh vì lý do sai" ở §4, tìm ra bằng cách hỏi tại sao đột biến KHÔNG đỏ thay vì tin nó.

**Chưa đo, ghi ra để người sau khỏi tin quá:** `perm: null` trên `listDomains` nghĩa là **mọi vai
thành viên** (`order_manager`, `catalog_manager`) gọi thẳng seller API đọc được danh sách tên
miền **kèm `verification_token`** — giả thuyết, **không phải finding**, vì §4 cấm báo khi chưa đi
qua đúng nó bằng vai thật. Cũng chưa đo: `POST /domains` bằng vai non-owner có bị mời step-up cho
một thao tác không bao giờ thành công hay không.

Một lỗi của phép đo, chép lại: `node --test apps/tls-authorize/test/` (dạng THƯ MỤC) cho
**0 pass / 1 fail** và tôi suýt đọc thành "đột biến làm đỏ"; baseline đúng là **15/15** với glob
`*.test.js`. Cùng họ với bẫy "chạy `auth/e2e.mjs` sai container" ở đợt đo 2.

**Không phải finding, ghi để khỏi ai đo lại:** `apps/tls-authorize/src/ratelimit.js` **không** là
bản chép của `packages/auth/src/ratelimit.js` ở bảng §3 — token bucket cho tra cứu DB, so với cửa
sổ cố định trên Redis. Hai thứ khác nhau, trùng tên tệp thôi.

Đo: `hostname-hai-ban.test.js` **3/3**, manifest unit **42 → 43 bộ**, toàn bộ unit **340/340**,
`manifest_check` OK. Chỉ thêm unit thuần nên theo §5 phạm vi là "chỉ test" — **cổng đầy đủ chưa
chạy trên máy này** (không có Docker); đó là khoảng trống thật, không phải hình thức.

### Bàn giao cho Codex — nhánh `claude/hostname-hai-ban`, CHƯA QUA CỔNG

Nhánh nối từ `f6824fa`, một commit `86a1f45` (3 tệp: bộ unit mới, `test-manifest.sh`, sổ tay).
**`main` cố ý ĐỨNG NGUYÊN** — §9.4 cấm fast-forward khi cổng chưa exit 0, và ở máy Claude nó
chưa chạy được lần nào (`production.cloudfront.docker.com` trả **403** từ egress policy; theo
`/root/.ccr/README.md` thì báo host bị chặn chứ không đi vòng).

**Đã đo được, tin được** (chạy thẳng ở máy, KHÔNG cần Docker): `hostname-hai-ban.test.js`
**3/3** · toàn bộ unit **340/340** · `manifest_check` OK · manifest unit **42 → 43**, e2e giữ
**113** (không thêm bộ e2e nào).

**Việc 1 — gác đầy đủ.** `bash scripts/ci-local.sh`, MỘT tiến trình duy nhất, kiểm bằng `ps`
trước khi tin bất cứ dòng nào trong log (§9.3b: hai lượt song song tranh nhau một PostgreSQL và
đẻ ra lỗi hạ tầng trông y hệt lỗi sản phẩm). Lượt phụ thấy trong `ps` có thể là subshell CON của
chính cổng — phân biệt bằng PPID. Thay đổi chỉ là một bộ unit thuần nên không có lý do gì để e2e
đổi số, và **đó chính là điều cần chứng minh**: E2E phải giữ đúng **113/113**.

**Việc 2 — review, và câu hỏi sắc nhất nằm ở học thuyết chứ không ở mã.** Theo thứ tự ưu tiên:

1. **Corpus có đủ rộng không?** Chốt khẳng định hai bản XỬ SỰ giống trên 3.042 hostname. Phép
   thử đúng cho nó không phải đọc corpus mà là **tìm một đột biến đổi HÀNH VI của MỘT bản mà
   corpus KHÔNG bắt được**. Tìm được là chốt có lỗ, và lỗ đó phải vá bằng ca mới chứ không bằng
   quay về so byte. Bốn chốt-chết nói ở mục 4 là nơi dễ có lỗ nhất.
2. **Chốt tự-chối có thật sự bind không?** Ba ngưỡng `>= 10`, `>= 10`, `>= 3` là số tôi chọn,
   không phải số đo. Nới chúng thành `>= 0` rồi chạy lại đột biến "cả hai luôn null" — nếu vẫn
   đỏ thì khẳng định tự-chối đang được chốt KHÁC đỡ hộ, tức nó xếp chồng và chưa chứng minh gì.
3. **`isReserved` chỉ được so trên hostname ĐÃ chuẩn hoá** (ca nào `normalizeHostname` trả null
   thì `continue`). Đó là đúng hợp đồng của mã thật ở cả hai bản — nhưng nếu một bản sau này gọi
   `isReserved` trên chuỗi thô thì chốt này mù. Đáng xem có nên khẳng định luôn thứ tự gọi đó ở
   `tls-authorize/src/server.js:134,139` không.
4. **Kiểm lại độc lập một khẳng định về SẢN PHẨM tôi rút ra từ đột biến:** bốn dòng gác đầu
   `normalizeHostname` (`:`, `*`, `_`, và IP-literal `/^\d+(\.\d+)+$/`) **chết về hành vi** —
   ba cái đầu bị `HOSTNAME_RE` nuốt, cái thứ tư bị chốt TLD-toàn-chữ-số ngay dưới nuốt. Tôi kết
   luận không sửa (vẫn fail-closed, vẫn là early-out rẻ). Nếu Codex đo ra khác thì đó là finding
   thật, không phải chuyện câu chữ.
5. **Manifest và §0 phải khớp nhau trong CÙNG commit** — `MANIFEST_UNIT_COUNT=43` và bảng §0
   "bộ unit 43". Chốt này so BẰNG nên nó tự bắt, nhưng đã có tiền lệ quên (lát cắt 6 đợt 1).

**Không cần đụng tới:** `apps/seller/src/hostname.js` và `apps/tls-authorize/src/hostname.js`
giữ NGUYÊN — lượt này không sửa một dòng mã sản phẩm nào.

**Lượt này Claude vừa đo, vừa viết, vừa tuyên bố xanh** — yếu hơn các lát cắt có vòng chéo
(§9.1 luật 2). Xanh ⇒ fast-forward `main`, không merge commit.

**Codex review chéo hostname:** tìm được hai đột biến đổi hành vi MỘT bản mà corpus cũ
vẫn 3/3: đổi trần `>253` thành `>=253`, và nhận đầu vào không phải chuỗi. Bổ sung ca 252/253/254
ký tự với từng nhãn hợp lệ, biên nhãn 1/2/62/63/64, dấu chấm cuối kép, khoảng trắng và 10 đầu
vào sai kiểu. Corpus nay **3.068**; hai đột biến đều **2 pass / 1 fail**, hoàn nguyên **3/3**.
Đột biến chạy module nguồn trong bộ nhớ bằng data URL, giữ hai module độc lập và chạy chính
test thật; không ghi mã sản phẩm hay cần restart service. Đã gỡ harness tạm sau phép đo.

Chốt tự-chối được đo độc lập: cả hai luôn null **2/1**; cùng đột biến nhưng hạ cả ngưỡng về 0
thì **3/0**, không có chốt khác đỡ hộ. Sửa phép đếm reserved để dùng hostname đã chuẩn hoá
giống chính phép so, thay vì chuỗi thô trim/lowercase. Xoá bốn guard `:`, `*`, `_`, IP-literal
ở một bản vẫn **3/0**; đọc logic xác nhận chúng bị regex nhãn và TLD toàn số phủ, không sửa
mã sản phẩm. Hai nơi gọi hiện dùng kết quả normalize trước isReserved; thứ tự gọi ở HTTP
chưa có chốt mới trong bộ thuần này, không tuyên bố corpus canh được việc caller đổi sang chuỗi thô.
Cổng đầy đủ lượt review (kết thúc 09/09) **exit 0: 120 mục xanh, 0 đỏ** — unit **340/340**,
migration DB trắng **184** (0 DRIFT/pending), security-scan sạch, bất biến DB **149/149**,
E2E giữ đúng **113/113**, smoke edge/readiness/TLS đều PASS. PID/PPID xác nhận một lượt cổng;
không ghép log với lượt held-ingest trước. Chưa merge, `origin/main` giữ `f6824fa`.

### Claude review vòng chéo Codex — HAI FINDING, chưa merge

Đã đo lại độc lập **cả năm** con số Codex báo, khớp cả năm: hai đột biến mới (trần `>=253`,
đầu vào sai kiểu) đúng là **3/0 trên corpus cũ → 2/1 trên corpus mới**; cả-hai-luôn-null **2/1**;
cùng đột biến với ngưỡng hạ về 0 **3/0** (⇒ chốt tự-chối KHÔNG xếp chồng, đúng như họ kết luận);
xoá bốn guard dư **3/0**. Ma trận cũ 6 đột biến chạy lại trên corpus mới vẫn đỏ đúng chỗ. Phần
sổ tay Codex viết không overclaim — tự khai thẳng giới hạn về caller truyền chuỗi thô.

**F1 · corpus kiểm từng chốt RIÊNG LẺ, không kiểm THỨ TỰ giữa chúng.**
Đột biến: dời `if (h.length === 0 || h.length > 253) return null;` lên **TRƯỚC** bước
`if (h.endsWith('.')) h = h.slice(0, -1);`, chỉ ở bản seller → **3/0 XANH**.
Đã kiểm nó đổi hành vi thật, không inert: `['a'.repeat(63),'a'.repeat(63),'a'.repeat(63),'b'.repeat(61)].join('.')`
dài **253** (nhận); thêm một dấu chấm cuối thành **254** — bản gốc cắt chấm rồi nhận, bản đột
biến trả `null`, tls vẫn nhận. Bao khoảng trắng hai đầu cho **257**, cùng lớp lỗi với `trim`.
`CA_BIEN` có 252/253/254 nhưng **không ca nào vừa DÀI vừa mang dấu chấm cuối hoặc khoảng trắng**,
nên mọi hoán vị của `trim → cắt chấm → trần` đều vô hình.
→ Vá: thêm mỗi ca biên độ dài ở **ba hình dạng** — trần trụi, có dấu chấm cuối, có khoảng trắng
bao quanh. Giữ **chiều ngược lại**: ca 253 không dấu chấm vẫn phải được NHẬN, nếu không thì một
bản "từ chối mọi thứ dài" cũng đi lọt.

**F2 · bộ sinh bão hoà ở 937, và `caSinh(n)` là một nút vặn CHẾT — lỗi của Claude.**
`s * 1103515245` với `s ~ 2³¹` cho ~6,9·10¹⁷, **vượt 2⁵³**, nên mất chính xác TRƯỚC khi
`& 0x7fffffff` — nó không còn là LCG. Đo được: trạng thái lặp lại ở lượt **968**, chỉ **937**
chuỗi khác nhau trong 3000, và `caSinh(20000)` vẫn ra đúng **937**.
Hệ quả không phải chốt sai mà là **con số kể chuyện không đúng**: "3.068 hostname" phóng đại độ
phủ khoảng ba lần, và người sau nâng tham số để phủ rộng hơn sẽ không thêm được ca nào.
→ Vá một dòng: `s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff`. Đo sau vá: 3000 →
**2.845** chuỗi khác nhau, 20000 → **18.434**.
→ **Và thêm chốt tự-chối cho CHÍNH BỘ SINH** — khẳng định số chuỗi KHÁC NHAU ≈ n (chẳng hạn
`≥ 0,9n`). Không có nó thì đúng kiểu bão hoà im lặng này quay lại được mà không ai thấy; cùng
học thuyết với chốt tự-chối đã có và với probe 360px phải tự chối khi khung nhìn sai (§4).

**Sau khi vá phải chạy LẠI TOÀN BỘ ma trận** — đổi corpus là đổi tập ca thật sự chạy, nên mọi
đột biến cũ (của Claude lẫn của Codex) phải còn đỏ, và chốt tự-chối phải còn bind khi hạ ngưỡng.
Cập nhật con số corpus trong sổ tay cho khớp thực đo, đừng tính tay.

Chỉ thêm ca vào mảng, **không thêm bộ test** ⇒ manifest giữ **43 unit / 113 e2e**, §0 không đổi.
Vẫn phải **gác đầy đủ lại** vì unit nằm ở bước 1 của cổng — kết quả cổng của `315117e` không
dùng lại cho commit mới được. Vẫn không đụng một dòng mã sản phẩm nào.

**Codex xử lý F1–F2 (09/09):** mỗi biên tổng độ dài và độ dài nhãn có ba hình dạng:
trần trụi, dấu chấm cuối, khoảng trắng bao quanh; thêm ca kết hợp khoảng trắng + dấu chấm
ở biên tổng độ dài. Đột biến dời trần trước cắt chấm: corpus trước **3/0**, nay **2/1**;
dời trần trước trim và từ chối mọi hostname dài hơn 200 cũng **2/1** — giữ chiều nhận 253 hợp lệ.

Bộ sinh dùng `Math.imul`; chốt tự-chối đòi ít nhất 90% chuỗi khác nhau ở CẢ 3000 và 20000.
Đếm thực từ khai báo test: **3.097 đầu vào**, trong đó **2.930 chuỗi khác nhau** (còn có 10
đầu vào sai kiểu), không gọi số lượt sinh là số hostname khác nhau. Bộ sinh riêng cho
**2.845/3.000** và **18.434/20.000** chuỗi khác nhau.

Chạy lại toàn ma trận bằng module nguồn trong bộ nhớ và chính test thật: **13 đột biến đỏ**
(nhận nhãn đơn; bỏ TLD số; bỏ trần; bỏ lowercase; reserved=false; reserved dùng includes;
trần >=253; nhận sai kiểu; trần trước cắt chấm; trần trước trim; từ chối dài hợp lệ;
cả hai luôn null; trả bộ sinh lỗi). Tất cả **2/1**, riêng reserved=false **1/2**.
**Bốn đối chứng 3/0:** mã sạch, xoá bốn guard dư, cả hai null + hạ ngưỡng nhánh về 0,
bộ sinh lỗi + hạ riêng ngưỡng đa dạng về 0. Hai chốt tự-chối đều bind độc lập.
Harness tạm đã gỡ; không sửa mã sản phẩm, manifest vẫn **43/113**. Cổng đầy đủ lượt F1–F2
**exit 0: 120 mục xanh, 0 đỏ** — unit **340/340**, migration trắng **184** (0 DRIFT/pending),
bảo mật sạch, bất biến DB **149/149**, E2E **113/113**, smoke **8/27/32**, không log E2E sót.
Đã kiểm PID/PPID: một lượt cổng duy nhất; không dùng lại kết quả 315117e. Chưa merge.

**Còn nợ của lát cắt 7, chưa đo:** `/domains` mới có bản đồ chỉ-đọc, **chưa đi bằng vai thật** ·
`/billing` mới chỉ được đối chiếu ở mức bảng quyền, chưa đi bằng vai thật · chưa đo vai "shop lúc
có sự cố" cho các nhóm còn lại.

**Còn nợ đã ghi, chưa làm, không thuộc lát cắt nào:** nút **"tải lại tất cả"** cho ảnh hỏng — bấm từng dòng thì shop 200 ảnh hỏng sẽ bấm 200 lần, nhưng
một nút hàng loạt là 200 kết nối ra ngoài trong một lượt và cần quyết định riêng về nhịp.

**Nhánh `claude/full-system-folder-access-tc6cfk` đã CHẾT, đừng merge.** 13 commit dựng trang
chủ, rẽ khỏi `main` tại `d86176f` và đứng sau `main` **53 commit**. Đo được: 10/13 commit đã có
trên `main` dưới dạng patch tương đương (`git cherry`); ba commit còn lại không thiếu mà CŨ HƠN
— `landing.js` trên `main` 2075 dòng so với 2031 ở nhánh, không tệp nào tồn tại riêng ở nhánh,
và **mọi dòng riêng của nhánh đều là phiên bản trước khi vá**: `rvGuard` ở đó GỠ cờ `lpjs` thay
vì hiện phần tử đang kẹt (đúng bản vá 4/37 → 37/37 ghi phía trên), băng Ngành hàng dùng
`setInterval` + nhảy về đầu thay vì bản bóng liền mạch. Merge nó sẽ **XOÁ 11.213 dòng**:
migration `0180`–`0184`, connector KiotViet, bất biến schema/tenant, hai harness verify, và hoàn
nguyên bản vá `security-scan`. Đã lưu nguyên trạng ở nhánh `archive/landing-2026-08` (cùng SHA
`46193e5`); **nhánh gốc chưa xoá được** — token của phiên chỉ ký được tạo/cập nhật `refs/heads/*`,
GitHub trả 403 cho cả xoá ref lẫn `refs/tags/*`. Chủ dự án xoá bằng tay khi tiện.

Còn 31 nhánh trên remote, phần lớn đã merge từ lâu. Chưa ai dọn, và mỗi nhánh cũ là một lần
`git merge` nhầm tay đang chờ xảy ra — chuyện vừa suýt xảy ra với nhánh ngay phía trên.

### 9.4 Bắt đầu một phiên mới thế nào

Không cần dán lại bối cảnh. Đọc file này, rồi:

```bash
git log --oneline -8            # lát cắt nào vừa đóng
git branch -r | grep -E 'claude/|codex/'   # nhánh nào đang dở
```

Nhánh đặt tên theo việc (`claude/ux-…`, `codex/…-fix`), **merge vào `main` bằng fast-forward**
sau khi full CI exit 0. Không merge thẳng khi cổng chưa xanh, kể cả khi diff trông vô hại.
