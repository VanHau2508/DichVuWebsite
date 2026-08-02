# 50 — Onboarding shop mới: gỡ 4 chỗ vấp trên đường ngày-đầu

**Trạng thái:** v1 xong. **Không đụng đường tiền, không migration.**

## Vì sao làm

Không phải suy đoán. Tôi tự đóng vai chủ shop mới, tạo thật `quan-ca-phe-som-mai`
trên dev và đi trọn: `/signup` → email → kích hoạt → đăng nhập → thêm sản phẩm đầu
tiên → **mở storefront ra xem**.

Luồng chạy thông, không vỡ chỗ nào. Nhưng nó kết thúc bằng một **cửa hàng không bán
được**: sản phẩm đã "Đăng bán ngay", mà trang bán hàng ghi **"Hết hàng"** — vì form
thêm sản phẩm không có ô tồn kho, tồn mặc định 0. Tệ hơn: checklist onboarding vẫn
tick ✓ mục "đã thêm sản phẩm". Chủ shop được khen là xong trong khi khách vào không
mua được gì.

Đây là "vận-hành-SaaS 40%" ở dạng cụ thể nhất. Không phải thiếu tính năng.

## Bốn thay đổi

### 1. Form thêm sản phẩm: 5 ô bắt buộc → 2

| Trước | Sau |
|---|---|
| Tên * · **slug** * · Giá * · **Mã SKU** * · **Giá biến thể** * | Tên * · Giá * · **Tồn kho ban đầu** · Trạng thái · Mô tả |

`slug` và `SKU` chuyển vào `<details>` "Tuỳ chọn nâng cao", bỏ trống thì hệ thống tự
điền. Giá gõ **một lần** — bắt gõ hai lần vào hai ô không giải thích ("Giá" và "Giá
biến thể") là chỗ vấp thật, không phải tính năng.

**Tồn kho ghi trong CÙNG transaction** với sản phẩm (`inventory_levels` +
`inventory_ledger` kind `receive`), giữ bất biến tổng delta sổ cái == `on_hand` —
cùng lối `import.js` đã dùng.

### 2. Tự sinh slug từ tên (signup + sản phẩm)

Ô địa chỉ shop là ô **khó nhất** của form đăng ký và là ô duy nhất bắt người dùng
hiểu một luật kỹ thuật. Trước đây server chỉ `.toLowerCase()`: người gõ đúng tên shop
của mình → `quán cà phê sớm mai` → vẫn dấu, vẫn khoảng trắng → **báo lỗi**, rồi họ
phải tự nghĩ ra `quan-ca-phe-som-mai`.

Nay: bỏ trống thì lấy theo tên; gõ gì cũng chuẩn hoá bỏ dấu. Chỉ báo lỗi khi chuẩn
hoá xong **vẫn** không ra được địa chỉ hợp lệ (emoji, ký hiệu).

`slugify` CỐ Ý có hai bản: `apps/seller/src/catalog.js` (slug SP, ≤58) và
`apps/signup/src/server.js` (subdomain, ≤40). Khác luật độ dài, và signup là service
cô lập least-priv mà Dockerfile chỉ COPY đúng packages nó cần — dựng package chung
cho 8 dòng thì phải sửa Dockerfile + volume của mọi service.

**Luật né trùng (áp cho cả slug và SKU):**
- Tự sinh mà trùng → **tự nối `-2`, `-3`…**. Người dùng không gõ ô đó thì báo "đã tồn
  tại" là vô nghĩa với họ.
- **Gõ tay** mà trùng → **vẫn 409**. Họ chọn địa chỉ đó có chủ đích; đổi ngầm sau lưng
  là sai.

### 3. Kích hoạt xong → điền sẵn email ở trang đăng nhập

Trước: bấm link trong email → "Cửa hàng đã sẵn sàng!" → bấm Đăng nhập → **màn hình
trống**, gõ lại email vừa đăng ký 2 phút trước. Nay `/login?email=…` điền sẵn ô email
và đặt `autofocus` vào ô mật khẩu.

**CỐ Ý KHÔNG auto-login.** Link kích hoạt nằm trong hộp thư: ai đọc được mail sẽ vào
thẳng admin mà không cần biết mật khẩu. Hộp thư và mật khẩu phải là hai lớp riêng.

### 4. Checklist thôi khen dối

`products` đếm theo `sellable_count` (**đang bán + còn hàng bán**) thay cho
`catalog_count` (có dòng trong bảng `products`). Nhãn đổi từ "Thêm sản phẩm đầu tiên"
thành **"Có sản phẩm bán được"**.

## Hai lỗi tự gây, e2e bắt (đọc code không thấy)

1. **`variants` KHÔNG có cột `deleted_at`** — chỉ `products` xoá mềm. `sellableCount`
   bản đầu lọc `v.deleted_at IS NULL` → câu lệnh ném lỗi → endpoint 500 → overview
   **nuốt** lỗi thành "mục chưa xong". Im lặng hoàn toàn: không log ra mặt người dùng,
   checklist chỉ đơn giản không tick.
2. **SKU tự sinh lấy gốc từ slug TRƯỚC khi né trùng** → hai sản phẩm cùng tên: cái thứ
   hai có slug `-2` nhưng SKU y hệt cái thứ nhất → 409 "SKU đã tồn tại". Phải sinh SKU
   **trong transaction, sau khi chốt slug**, và né tiếp nếu SKU đó đã có (SKU của SP
   xoá-mềm vẫn nằm trong bảng `variants`).

Bài học chung: **một mục checklist "không tick" có thể là endpoint đang 500.** Chỗ nào
nuốt lỗi để "không chặn trang" thì chỗ đó cần test đi đúng đường người thật đi.

## Đợt 2 — bốn việc còn nợ, làm nốt

### 5. Sidebar 28 mục → 7 mục + 4 nhóm gập

Trước: một cột phẳng 28 mục, Đối soát COD / Kiểm kê / Điểm thưởng / Nhật ký nằm ngang
hàng với Đơn hàng. Nay: nhóm **Bán hàng** (Tổng quan · Đơn hàng · Sản phẩm · Khách hàng
· Báo cáo) luôn mở; **Kho & nhập hàng**, **Khuyến mãi & khách**, **Giao diện & nội
dung**, **Thiết lập cửa hàng** nằm trong `<details>` gập sẵn; **Trợ giúp** và **Gói dịch
vụ** ghim đáy. Đo trên trình duyệt thật: **7 link hiển thị** thay vì 28.

`<details>` là HTML thuần — **không thêm một dòng JS nào**. Ba ràng buộc:
- **Nhóm chứa trang đang xem tự bung** (`open`), nếu không người dùng mất dấu mình ở đâu.
- **Mọi link vẫn nằm trong HTML** — details chỉ ẩn bằng CSS, Ctrl+F vẫn tìm ra, e2e cũ
  bám href vẫn khớp.
- Nhóm mà **cả cụm ngoài quyền** thì bỏ luôn tiêu đề, không để nhóm rỗng.

Trạng thái gập không nhớ qua các trang (không JS/cookie) — chấp nhận được, vì mở đúng
nhóm đang dùng đã là hành vi đủ đúng.

### 6. Câu mở đầu thôi trấn an sai

"Không còn việc tồn đọng — cửa hàng đang chạy êm" đúng với shop đang chạy, **sai với shop
vừa mở**: 0 việc vì 0 khách, 0 khách vì chưa có gì để bán. Khi `setup && !setup.products`
(shop còn onboarding và chưa có SP bán được), hero đổi thành *"Khách chưa mua được gì —
cần ít nhất một sản phẩm đang bán và còn hàng"*, hộp Việc-cần-làm ghi *"Chưa có đơn —
cửa hàng chưa bán được"*.

### 7. Tạo sản phẩm KÈM ẢNH trong một lượt

Form thêm SP nay `enctype="multipart/form-data"` + ô `image` (multiple). BFF bóc file
bằng `readMultipartAll`, tạo SP trước, rồi đẩy từng ảnh sang `/products/:id/media`.

- **Vẫn nhận urlencoded** (không có ô ảnh) — cùng một endpoint, chỉ thêm khả năng, nên
  script/e2e cũ không vỡ.
- **Ảnh hỏng KHÔNG huỷ sản phẩm**: mất cả công gõ vì một tệp sai là phạt quá nặng. Người
  dùng được đưa vào trang chi tiết kèm *"chỉ tải được 0/1 ảnh"*, ở đó có sẵn ô tải lại.
- e2e chốt `enctype` **và** ô file phải nằm TRONG form — thiếu `enctype` thì trình duyệt
  gửi đúng *tên tệp* dạng text, không byte nào, mà mọi thứ vẫn "thành công".

### 8. Có đúng 1 cửa hàng → vào thẳng

`GET /` với đúng một membership → 303 thẳng vào `/shops/:id/overview`. Bắt "chọn một cửa
hàng" trong danh sách một-phần-tử là bước thừa **mỗi lần đăng nhập**.

**Trừ nhân viên nền tảng**: link vào Console chỉ có ở màn hình này, chuyển hướng họ đi là
giấu mất đường vào console của chính người vận hành nền tảng.

## Bẫy đo lường gặp hai lần

`offsetParent !== null` **không** phát hiện được nội dung trong `<details>` đang đóng —
báo cả 28 link đều "hiện". Phải dùng `checkVisibility()`. Cùng lớp lỗi với việc đo "nút
Thêm vào giỏ" bằng regex thô rồi khớp trúng chữ nằm trong **chú thích CSS**: đo cái mình
tưởng đang đo, không phải cái thật sự hiển thị.

## Còn thiếu

- Trạng thái gập của sidebar không nhớ qua các trang.
- Form tạo SP vẫn chưa cho đặt biến thể đa trục ngay (phải vào trang chi tiết).

## Test

- `apps/seller/test/catalog.e2e.mjs` §12 — tự sinh slug bỏ dấu · SKU theo slug · tồn
  vào kho · né `-2` · gõ tay vẫn 409 · tồn âm 400.
- `apps/seller-admin/test/admin-onboarding.e2e.mjs` §2–3 — SP nháp/tồn-0 **không** tick ·
  tạo SP không cần gõ slug/SKU · tồn vào `inventory_levels` · in ra mục nào chưa ✓ khi hỏng.
- `apps/signup/test/signup-draft.e2e.mjs` §5 — chuẩn hoá slug có dấu · bỏ trống lấy theo
  tên · ký tự lạ vẫn 400.
- `apps/seller-admin/test/admin-onboarding.e2e.mjs` §1b–1c — sidebar gom nhóm, không nuốt
  link nào, nhóm-đang-đứng tự bung · câu mở đầu nói đúng · 1 shop vào thẳng · nhân viên
  nền tảng KHÔNG bị chuyển hướng.
- `apps/seller-admin/test/admin-media.e2e.mjs` §8 — enctype + ô file trong form · tạo SP
  kèm 2 ảnh một lượt · tồn vẫn đúng khi form là multipart · ảnh hỏng không mất SP.
- `apps/seller-admin/test/admin-flow.e2e.mjs` — đổi kỳ vọng `GET /` sau đăng nhập/MFA
  sang "vào thẳng shop của mình" (đi tiếp một bước để chắc không phải 303 vào hư không).

---

## Đợt 3 — vá theo kết quả KIỂM TOÁN ĐÓNG VAI (2026-08-02)

Không phải đọc mã rồi đoán: tôi dựng một shop mới tinh trên DB vừa reset và đi hết bốn vai
bằng HTTP như trình duyệt (chủ shop · khách mua · shop vận hành · quản trị nền tảng).
Không tìm ra lỗi logic nào — **2.218 khẳng định e2e xanh, 41/41 màn hình quản trị mở được,
0 trang 500**. Cái tìm ra là một lớp khác: **thứ có thật nhưng người dùng không tìm ra.**

### 1. Chính sách bảo vệ dữ liệu cá nhân (`/bao-mat`) — CHẶN TÍNH NĂNG

Không có trang này thì **Meta App Review không duyệt**, mà không duyệt thì bot Messenger
(0122, đã xây xong) không bao giờ chạy với Trang thật. Cộng thêm Nghị định 13/2023 — ta thu
họ tên, SĐT, địa chỉ và **toạ độ GPS** (phí ship theo km). Nội dung viết theo ĐÚNG những gì
hệ thống làm thật (băm IP, ẩn danh toạ độ sau khi đơn xong, Argon2id, AES-256-GCM, RLS
cách ly tenant) — chép mẫu chung chung rồi mô tả sai còn tệ hơn không có.

### 2. Trang "Vận chuyển" đổi tên thành "Hãng vận chuyển"

Trang đó CHỈ nối tài khoản GHN/GHTK; phí ship nội miền/liên miền/freeship nằm ở **Cài đặt**.
Người bán đi tìm phí ship bấm "Vận chuyển", không thấy gì, kết luận nền tảng không đặt được
phí. Nay tên khớp nội dung, hai trang trỏ qua lại nhau (`#phi-ship`).

### 3. Kết nối Trang Facebook ra khỏi trang nghe-như-cho-lập-trình-viên

Khối kết nối Messenger nằm trong trang "Kết nối phần mềm ngoài", **dưới** phần khoá API.
Nay: mục menu gọi thẳng **"Bán qua Facebook"**, tiêu đề trang là "Kênh bán & kết nối", và
khối Facebook nằm **trên** phần khoá API.

### 4. Trang "Giao diện" chỉ đường tới tải logo

Logo nằm ở Cài đặt. Người vào "Giao diện" để làm đẹp cửa hàng chắc chắn coi logo là việc của
trang đó — không có lối sang là họ tưởng chưa làm được.

### 5. Trang Liên hệ (`/lien-he`)

Trước đó thông tin liên hệ chỉ lọt trong mục 7 của Điều khoản.

### 6. Đặt phân loại (size/màu) NGAY Ở FORM TẠO — trả nợ "Còn thiếu" ở trên

BFF gọi lại **chính** `PUT /products/:id/options` mà trang chi tiết dùng, không nhân bản logic
sinh ma trận. Trục hỏng **không huỷ** sản phẩm vừa tạo (cùng lối xử lý như ảnh hỏng) — bắt
người bán gõ lại từ đầu là chỗ họ bỏ cuộc.

### Bẫy ĐO LƯỜNG (bộ kiểm toán tự vấp, ghi lại để đừng lặp)

- `fetch` của Node **ghi đè header Host** → mọi request rơi vào host container, sinh 404/403 giả.
  Cả hệ định tuyến bằng Host, nên phải dùng `node:http` thô.
- Thiếu header `Accept` → `/cart` trả JSON thay HTML, suýt kết luận "giỏ không hiện tạm tính".
- Lấy **form POST đầu tiên** trên trang để bấm "xác nhận" — form đầu ở layout admin là nút
  **Đăng xuất**. Phiên chết, 8 tính năng liền báo hỏng oan. Phải chọn form theo `action`.

### Test

- `apps/seller-admin/test/admin-products.e2e.mjs` §12 — form tạo có 2 trục · 3 size × 2 màu
  sinh đủ 6 phiên bản trong MỘT lần tạo · lưu đúng 2 trục · trục vượt trần **giữ** sản phẩm.
- `apps/seller-admin/test/admin-api-keys.e2e.mjs` §1 — khối Facebook nằm TRƯỚC khoá API ·
  mục menu nêu thẳng "Bán qua Facebook".
- `apps/storefront/test/e2e.mjs` — `/bao-mat`, `/lien-he` vào `companyPaths()` nên có trong
  sitemap và được quét cùng các trang công ty khác.

---

## Đợt 4 — NHÌN bằng trình duyệt thật (2026-08-02)

Ba đợt trước đọc HTML bằng chuỗi. Đợt này chạy trong engine trình duyệt thật ở **375×812**
(cỡ iPhone) và **1280×720**, đo bằng `getBoundingClientRect` + `elementFromPoint` — không
đoán, không nhìn ước lượng.

### Sạch (đã kiểm, KHÔNG phải lỗi)

- **Không tràn ngang** ở cả desktop lẫn mobile: `document.scrollWidth === innerWidth` (375 = 375).
  Đây là thứ giết giao diện điện thoại nhiều nhất và nó sạch.
- **Chữ không bị cắt** ở đâu cả: `textClip` rỗng. Cái tràn ra khỏi ô promo/hero là **ảnh nền
  blur-fill** — cố ý, bị `overflow:hidden` cắt đúng như thiết kế.
- **90/90 ảnh có thuộc tính `alt`** (44 cái `alt=""` — đúng chuẩn cho ảnh trang trí: bản nền
  mờ và ảnh-đổi-khi-rê-chuột). Không thiếu alt cái nào.
- Nhãn `.vh` ("Tìm kiếm"/"Giỏ hàng") rộng 1px là **screen-reader-only**, đúng ý đồ.
- `.tabbar` cố định cao 55px, `body{padding-bottom:56px}` → **không che footer**. Đúng cách.
- Thanh mua ở trang SP là `position:sticky` (không phải `fixed`) → không đè nội dung.

### Lỗi THẬT: vùng bấm quá nhỏ trên điện thoại

Đo được, không phải cảm tính. Ngón tay người lớn ~9mm ≈ 44px:

| Chỗ | Trước | Sau |
|---|---|---|
| Chấm carousel | **8×8** | 28×44 (vùng bấm trong suốt) |
| "Xem tất cả →" / "Xem thêm →" | 92×**22** | 92×**44** |
| Link chân trang | 159×**30** | 159×**44** |
| Nút mở menu ☰ | 40×**31** | **44×44** |
| Ô lọc "Còn hàng" | nhãn ×24, ô tick **17×17** | nhãn ×**44**, ô tick **22×22** |
| `<summary>` Viết đánh giá / Đặt câu hỏi | 335×**26** | 335×**44** |
| Tên shop (về trang chủ) | 171×**27** | 171×**44** |
| Danh mục con trong menu ngăn kéo | ×**18** | ×**40** |

Chỉ nới **vùng bấm**, không phóng to phần nhìn thấy → bố cục giữ nguyên (`headerH` vẫn 57px
trước và sau).

### Bẫy: BẢN VÁ ĐẦU TIÊN TỰ SINH LỖI NẶNG HƠN

Vùng bấm chấm carousel đặt rộng **36px** trong khi khoảng cách tâm-tới-tâm chỉ **16px**
(chấm 8 + gap 8) ⇒ vùng bấm hai chấm **đè lên nhau**, bấm chấm 2 lại nhảy sang chấm bên
cạnh. **Sai đích còn tệ hơn đích nhỏ.** Chỉ lộ ra vì kiểm bằng `elementFromPoint` chứ không
tin vào con số kích thước. Đã sửa: gap 20 → cách nhau 28, vùng bấm đúng 28 rộng.

**Quy tắc rút ra:** khi nới vùng bấm cho một nhóm phần tử sát nhau, bề rộng vùng bấm PHẢI
≤ khoảng cách tâm-tới-tâm, và phải kiểm bằng `elementFromPoint` chứ không chỉ đo kích thước.

### Kiểm chứng

`storefront/e2e` 160 · `preview` 23 · `blocks` 25 · `banner` 14 · `admin-preset` 10 — xanh.

---

## Đợt 5 — sản phẩm có size/màu TẠO XONG KHÔNG BÁN ĐƯỢC (2026-08-02)

Đợt 4 vá "form tạo SP chưa đặt được biến thể" (nợ ghi ở phần Còn thiếu). Vá xong, chạy lại
vai khách thì **vỡ**: trang sản phẩm 6 phiên bản có **0 form thêm-giỏ**. Khách không mua được.

### Nguyên nhân

| Phiên bản | Giá | Tồn |
|---|---|---|
| S / Đen (tái dùng biến thể gốc) | 199.000 ✓ | **0** (gõ 10 lúc tạo) |
| 5 tổ hợp còn lại | 199.000 ✓ | **KHÔNG CÓ DÒNG KHO** |

`saveProductOptions` **cố ý** reset tồn về 0 khi tái dùng một biến thể cho tổ hợp KHÁC — nếu
kế thừa tồn thì oversell. **Luật đó đúng** ở ngữ cảnh SỬA trục, không đụng vào.

Sai ở **luồng TẠO**: seller-admin tạo SP kèm tồn → rồi mới áp trục → tồn vừa nhập bị luật
trên xoá sạch, còn tổ hợp mới thì chưa từng có dòng kho. Chủ shop gõ "tồn 10", gõ Size/Màu,
bấm Tạo, và nhận về một sản phẩm **0 tồn ở mọi phiên bản**. Sản phẩm ĐẦU TIÊN của shop mới
mà không bán được chính là chỗ người ta bỏ nền tảng.

### Vá

Sau khi `/options` thành công, seller-admin gọi `POST /variants/:id/inventory/adjust` cho
**từng** phiên bản với đúng số tồn đã gõ. Con số ở form áp cho **mỗi** phiên bản (nhãn trên
form nói rõ) — chủ shop nghĩ "mỗi size mỗi màu tôi có 10 cái", không phải "10 cái chia 6 ô".

### Bài học đo lường

Bộ e2e cũ khẳng định "sinh đủ 6 tổ hợp" và **xanh** trong khi sản phẩm không bán được.
**Đếm số dòng không phải là kiểm chức năng.** Test mới soi tồn TỪNG phiên bản; gỡ bản vá ra
thì nó báo `0/6 có tồn` và đỏ ngay (đã kiểm bằng mutation).

Kiểm chứng: `admin-products` 63 · `catalog` 42 · `variants` 34 · `inventory` 11 ·
`admin-inventory-products` 40 — xanh.
