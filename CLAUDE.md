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
| migration | 182 tệp, mới nhất `0184` | `packages/db/migrations/` |
| bộ unit | 42 | `MANIFEST_UNIT_COUNT` |
| bộ e2e | 107 | `MANIFEST_E2E_COUNT` |
| bất biến DB | 9 bộ, 147 test TAP | `packages/db/test/*.test.js` |
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
trong cùng commit — đếm theo **FILE**, không theo số thứ tự (hôm nay 182 file / số cao nhất 0184).

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
→ `catalog + nhập từ sàn` → `cài đặt`

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

### 9.3b Lát cắt 4 và Trung tâm vận hành đã đóng; brief C đang chờ review

Đợt đo 2 của `đa kiện/ca xử lý` ra ba nhánh việc, cố ý tách để không đụng `pages.js` cùng lúc:

| brief | nội dung | trạng thái |
|---|---|---|
| **A** | bằng chứng hoàn tiền + chốt ca, `app_resolution`, hàm SECURITY DEFINER hẹp (`docs/78`) | **đã merge** `b7088ab` |
| **B** | bảng quản trị card-hoá ở server (`docs/77`) | **đã merge** `db9eeae` |
| **C** | bản đồ phục hồi vận đơn | phần nền đã merge; phần bề mặt đã thi công trên `codex/orphan-shipment-recovery`, chờ review |

Lát cắt 4 coi như đóng ở phần A+B. Chủ dự án đã chọn làm tiếp C sau khi khoá ba quyết định
bề mặt; nhánh thi công chưa vào `main`.

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

**Phần bề mặt brief C đã thi công, đang chờ review chéo.** Chủ dự án chốt `orphan` là việc mức
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
tay. Đã đo trên DB trắng: toàn manifest unit **330/330**, shipping **118/118**; đột biến gọi
`consumeAndShip` lần hai, ghi thẳng `payment_status='paid'` + `paid_at` ở cả hai đường đóng orphan, bỏ blocker/tập Tổng quan/bề mặt chi tiết, hạ quyền
`payments/manual` hoặc bỏ step-up đều đỏ đúng chỗ. Probe Chromium 360px cho cả interstitial
và chi tiết orphan `in_transit` đều 0 tràn; chi tiết xác nhận 0 ô nhập tracking.

Cổng đầy đủ trên nhánh: **107/107 E2E**, không log sót; bất biến DB **147/147**; migration
DB trắng **182**, 0 DRIFT, 0 pending; smoke **8 · 27 · 32**. `security-scan` đọc audit JSON
và báo OK kèm đúng ba instance advisory moderate `decode-uri-component` đã ghi ngay phía trên; audit JSON chạy
riêng cho checkout/seller/worker đều exit 0 với **0 high · 0 critical**.

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

### 9.4 Bắt đầu một phiên mới thế nào

Không cần dán lại bối cảnh. Đọc file này, rồi:

```bash
git log --oneline -8            # lát cắt nào vừa đóng
git branch -r | grep -E 'claude/|codex/'   # nhánh nào đang dở
```

Nhánh đặt tên theo việc (`claude/ux-…`, `codex/…-fix`), **merge vào `main` bằng fast-forward**
sau khi full CI exit 0. Không merge thẳng khi cổng chưa xanh, kể cả khi diff trông vô hại.
