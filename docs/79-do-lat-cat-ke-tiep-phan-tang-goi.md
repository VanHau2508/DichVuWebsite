# 79 — Đợt đo chọn lát cắt kế tiếp: phân tầng gói dịch vụ là hư cấu

> Đợt đo mở, không theo danh sách lát cắt cũ. Kết luận: việc kế tiếp **không phải** Brief C,
> cũng không phải Workflow 5. Trạng thái lúc đo: `main` = `b7088ab` (A và B đã merge).

---

## 1. Kết luận

Hệ thống đang **bán ba gói nhưng chỉ cưỡng chế được một chiều khác biệt duy nhất**, và chiều
đó **không phân biệt được hai gói rẻ nhất với nhau**.

| gói | giá/tháng | `max_products` | trang bán hàng hứa thêm |
|---|---:|---:|---|
| Platform | 990.000₫ | 100 | — |
| **Care** (đánh dấu `hot`) | **2.490.000₫** | **100** | Blog & SEO nâng cao · Trình dựng giao diện sâu · Hỗ trợ ưu tiên |
| Growth | 5.900.000₫ | 500 | Tên miền riêng · Đối soát QR tự động |

**Care đắt hơn Platform 1.500.000₫/tháng cho đúng cùng một thứ mà hệ thống cưỡng chế được.**

---

## 2. Bằng chứng

**Bảng `plans` chỉ có một cột phân biệt.** `0006` tạo bảng với `code, name, price_vnd_month,
max_products, active`. **Không migration nào từng `ALTER TABLE plans`** — kiểm bằng
`grep -rn 'ALTER TABLE plans' packages/db/migrations/*.sql` → rỗng.

**Chỉ có ĐÚNG MỘT điểm cưỡng chế trong toàn bộ mã.** `apps/seller/src/catalog.js:175` chặn
thêm sản phẩm khi chạm `max_products`. Mọi chỗ khác nhắc `plan_code`/`max_products` đều là
hiển thị hoặc thu tiền:

- `billing.js` — đọc để hiện
- `pages.js:3955` — hiện "đã dùng x/y"
- `platform/server.js` — console nội bộ
- `signup/server.js`, `worker/index.js` — chọn gói lúc đăng ký, email nhắc hạn

Không service nào chặn tính năng theo gói. Cụ thể đã kiểm: `domains.js` không hề nhắc `plan`;
`apps/payment/` không hề nhắc `plan`; `blog`/`theme` không hề nhắc `plan`.

**Trang bán hàng hứa năm khác biệt, hệ thống cưỡng chế MỘT.**
`apps/storefront/src/landing.js:118-122` liệt kê cho Care: *"Blog & SEO nâng cao"*, *"Trình
dựng giao diện sâu"*, *"Hỗ trợ ưu tiên"*; cho Growth: *"Tên miền riêng của bạn"*, *"Đối soát
QR tự động"*. Trong năm mục đó, **không mục nào** có cửa chặn theo gói. Shop trả 990.000₫ dùng
được tất.

**Điểm bán hàng không hiện trần sản phẩm — trừ chỗ dành cho nhân viên nền tảng.**

| màn hình | ai xem | có hiện `max_products`? |
|---|---|---|
| `signup/views.js:120` | shop sắp trả tiền | **KHÔNG** (`loadPlans` còn không SELECT cột đó) |
| `pages.js:6687` ô nâng gói | chủ shop đang trả tiền | **KHÔNG** |
| `pages.js:1568` `planLabel` | **nhân viên nền tảng** | **CÓ** — "· 100 SP" |

Hàm `planLabel` in đúng con số cần để quyết định mua, và nó chỉ được dùng ở console nội bộ
(`pages.js:1990`, `2090`). Người bỏ tiền không thấy.

**Ngõ cụt hoàn chỉnh, tái hiện được bằng đọc mã:**

1. Shop đạt 100 sản phẩm.
2. Trang Sản phẩm hiện: *"Đã đạt giới hạn — **nâng gói để thêm**."* (`pages.js:3955`)
3. Vào Gói dịch vụ, ô chọn hiện: *"Care — 2.490.000₫/tháng"*, *"Growth — 5.900.000₫/tháng"*.
   **Không có trần nào được in ra.**
4. Chọn bậc kế tiếp = Care. Trả thêm 1.500.000₫/tháng.
5. **Trần vẫn là 100.** Việc họ nâng gói để làm không hề xảy ra.

Đây đúng lớp lỗi mà lát cắt bảng điều khiển đã đặt luật: *giao diện mời một thao tác không đạt
được thứ nó được mời để đạt.* Lần này thao tác đó tốn tiền thật.

---

## 3. Vì sao việc này đứng trước các lựa chọn còn lại

Tôi đã đo cả ba lựa chọn đang có và **bác hai trong ba**.

**Bác — "đường khách mua chưa từng đo ở mobile".** Giả thuyết của chính tôi, và nó sai. Đo bằng
Chromium ở khung nhìn 360px thật (`headless_shell`; bản `chrome --headless` bỏ qua
`--window-size` và luôn dựng 500px), đo cả lượt gỡ script của trang vì ADR-008 quy định
storefront/checkout mặc định không JS:

| trang khách mua | JS bật | JS tắt |
|---|---:|---:|
| storefront `/`, `/products`, `/p/:slug`, `/search` | 345 | 345 |
| checkout `/checkout`, `/order`, `/lookup` | 345–360 | 345–360 |
| **checkout `/cart`** | **373** | **373** |

**7/8 trang đã đạt.** Không có lát cắt mobile cho khách. Chỉ còn một chỗ tràn 13px ở dòng thành
tiền trong giỏ — việc nhỏ, gộp vào đợt sau.

**Bác — "nuốt 403 thành danh sách rỗng là một lớp lỗi hệ thống".** Đếm trong toàn bộ BFF: 6 hàm
đọc mặc-định-rỗng từ `sellerApi`, **5 hàm có kiểm `r.status`**. Đúng **một** chỗ không kiểm.
Một ca, không phải một lớp.

**Bác — "`catalog_manager` không làm nổi việc của họ".** Tôi tưởng upload ảnh cần
`content.write`. Sai: `POST media` là `catalog.write`. Vai đó làm được việc của mình.

**Giữ lại — ngõ cụt `/help` của `catalog_manager`.** Nav mời `/help`, nhưng `GET /support` và
`POST /support` đều đòi `orders.read` (`apps/seller/src/support.js:88-89`) mà vai này không có.
`helpPage` dùng `r.json?.tickets ?? []` nên 403 biến thành **"Bạn chưa gửi yêu cầu nào"**; rồi
khi họ gõ xong và bấm Gửi, `helpSubmit` trả về lỗi chung chung *"Không gửi được yêu cầu."*
Nhân viên đang bí vào đúng chỗ dành cho người đang bí, và chỗ đó hỏng — mọi lần, không phải
thỉnh thoảng. Đây là việc thật nhưng **nhỏ hơn hẳn** việc gói: nó ảnh hưởng một vai trên một
trang, còn việc gói ảnh hưởng doanh thu của chính nền tảng và lời hứa với mọi shop trả tiền.

**Vì sao gói đứng đầu.** Ba lý do, theo thứ tự:

1. **Nó là đường tiền của chính nền tảng**, không phải của một shop. Ba lát cắt vừa rồi đều đi
   sửa cách shop kiếm tiền; đây là chỗ nền tảng kiếm tiền, và nó chưa từng được đo.
2. **Nó là lời hứa hệ thống không giữ.** Chưa có khách thật nên hôm nay chưa ai bị thiệt. Sau
   pilot thì đây là khiếu nại và đòi hoàn tiền, không phải bug báo cáo.
3. **Sửa muộn đắt hơn sửa sớm.** Một khi đã có shop trả tiền theo bảng giá này, đổi phân tầng
   là đổi hợp đồng đang chạy. Bây giờ chưa ai trả tiền — đây là thời điểm rẻ nhất.

---

## 4. Phần tôi tự kết luận được, và phần cần chủ dự án quyết

### Cần chủ dự án quyết — đây là quyết định kinh doanh, không phải thi công

**Câu hỏi 1: Care tồn tại để làm gì?** Ba đường đi, cả ba đều code được, khác nhau ở hậu quả
kinh doanh:

- **(a) Cho Care một trần sản phẩm riêng** (ví dụ 250). Rẻ nhất để làm, phân tầng trở thành
  thật ngay, nhưng khi đó cả ba gói chỉ khác nhau ở một con số — khó biện minh cho chênh lệch
  2,5 lần.
- **(b) Giữ trần, cưỡng chế đúng những gì trang bán hàng đang hứa.** Đắt nhất: phải dựng cửa
  chặn cho blog/SEO, trình dựng giao diện, tên miền riêng, đối soát QR — và phải định nghĩa
  "Hỗ trợ ưu tiên" thành một thứ hệ thống làm được (SLA? cột `priority` trên phiếu hỗ trợ?).
  Mỗi cửa chặn là một chỗ shop có thể bị chặn oan.
- **(c) Bỏ Care, còn hai gói.** Trung thực nhất với thứ hệ thống thật sự làm được, và đơn giản
  nhất để bán. Mất một bậc giá.

**Câu hỏi 2: "Hỗ trợ ưu tiên" là gì?** Hôm nay không có trường nào trong `plans` hay
`support_tickets` để nó tồn tại. Nếu giữ, phải nói nó nghĩa là gì bằng thứ đo được.

**Câu hỏi 3: shop đang ở gói cũ thì sao?** Chưa có khách thật nên hôm nay là câu hỏi rỗng —
nhưng phải trả lời trước pilot, không phải sau.

### Tôi tự kết luận được — đúng dù câu 1 chọn đường nào

1. **Mọi điểm bán hàng phải in trần sản phẩm.** `signup/views.js` và ô nâng gói ở
   `pages.js:6687` phải dùng cùng một nhãn mà console nội bộ đang dùng. `loadPlans` phải SELECT
   `max_products`. Không ai được đề nghị trả tiền mà không thấy con số quyết định.
2. **Lời nhắc "nâng gói để thêm" phải nói nâng lên gói NÀO.** Gợi ý một gói có trần thật sự
   cao hơn, hoặc không gợi ý gì.
3. **Trang bán hàng không được liệt kê khác biệt mà hệ thống không cưỡng chế.** Một chốt nguồn
   so `PLANS[].feat` với danh sách cửa chặn có thật; thêm một dòng quảng cáo mà không có cửa
   chặn tương ứng là ĐỎ. Đây là thứ ngăn nó trôi lại lần nữa — đúng cách `MANIFEST_*` đang làm.
4. **Hai việc nhỏ gộp cùng đợt** vì cùng chạm các trang này: ngõ cụt `/help` của
   `catalog_manager`, và tràn 373/360 ở dòng thành tiền giỏ hàng.

---

## 5. Phạm vi đề xuất cho lát cắt kế tiếp

Sau khi câu 1–3 được chốt:

| phần | ai làm |
|---|---|
| migration nếu đổi `plans` (thêm cột phân tầng / đổi trần), test bất biến DB, cửa chặn ở seller | Codex |
| chốt nguồn "quảng cáo phải khớp cửa chặn", chốt "mọi điểm bán hiện trần" | Codex |
| `signup/views.js`, ô nâng gói, lời nhắc chạm trần, `/help` cho `catalog_manager`, giỏ hàng 360px | Claude |
| review độc lập trước khi merge | người không viết code |

**Không thuộc phạm vi:** đổi RBAC, đổi công thức tiền/tồn, đụng đường thanh toán SePay.

---

## 6. Ghi chú phương pháp

Bốn giả thuyết, **ba bị chính phép đo bác bỏ** (mobile khách, nuốt-403 thành lớp,
`catalog_manager` không upload được ảnh). Giả thuyết còn lại không phải cái tôi bắt đầu — nó
lộ ra khi đi kiểm mục *"hỏi trước khi tự quyết"* trong `CLAUDE.md §7`, thứ đã ghi sẵn ở đó từ
lâu: *"platform và care cùng trần 100 SP nên gói giữa hiện không bán được cho ai."*

Điều kho này đã biết, nhưng chưa ai đo xem nó rộng đến đâu. Đo ra thì rộng hơn mô tả: không chỉ
gói giữa không bán được, mà **cả ba lời hứa phân tầng đều không được cưỡng chế**, và **người bỏ
tiền là người duy nhất không được cho xem con số quyết định**.

---

---

## 7. Quyết định kinh doanh — ĐÃ CHỐT

Chủ dự án chốt ngày đo. Ghi lại nguyên văn để người sau không suy lại:

**Gói Care.** Tạm ngừng bán cho khách mới. **Không xoá code/data** — giữ tương thích cho thuê
bao đang có. Trước mắt chỉ bán Platform (100 SP) và Growth (500 SP). Care **chỉ bật lại khi có
khác biệt thật và được hệ thống cưỡng chế**.

**"Hỗ trợ ưu tiên".** Bỏ khỏi lời hứa bán hàng. **Không dựng SLA hay cột `priority` giả** khi
chưa có quy trình vận hành đo được.

**`/help`.** Không giấu Help khỏi `catalog_manager`. **Không cấp `orders.read`.** Làm quyền hỗ
trợ riêng theo least privilege.

**Luật chung cho lát cắt:** mọi **giá, trần và tên gói phải dẫn xuất từ dữ liệu**, không
hardcode. Không đổi tiền/tồn/SePay.

---

## 8. Bốn phép đo mới — hai trong số đó đổi hẳn hình dạng công việc

### 8.1 Vô hiệu Care: cơ chế ĐÃ CÓ SẴN và đã nối đúng

Bảng `plans` có cột `active boolean NOT NULL DEFAULT true` từ `0006`. Đếm toàn bộ 12 truy vấn
chạm `plans` trong `apps/*/src`, chúng tách làm hai nhóm **đúng như cần**:

| lọc `active`? | chỗ | ý nghĩa |
|---|---|---|
| **CÓ** (6) | `signup:87` · `billing:45` · `billing:121` · `platform:137` · `platform:291` · `platform:451` | danh sách để **CHỌN MUA** và đường **validate** lúc mua |
| **KHÔNG** (6) | `billing:32` · `billing:112` · `catalog:91` · `platform:362` · `platform:470` · `worker:1298` | đọc gói của thuê bao **ĐANG CÓ** |

Nghĩa là đặt `care.active = false`:

- Care biến khỏi form đăng ký, khỏi ô nâng gói của shop, khỏi console nhân viên nền tảng
- cả ba đường mua đều **validate** `AND active` (`billing:121`, `platform:451`) nên không thể
  lách bằng cách POST thẳng `plan_code=care`
- shop **đang** ở Care vẫn đọc được gói của mình (`billing:32`), vẫn bị cưỡng chế trần
  (`catalog:91`), vẫn nhận email nhắc hạn (`worker:1298`)

**Không có `UPDATE plans` ở bất kỳ đâu trong mã** — cột `active` chỉ đổi được bằng migration.
Nên việc này là **một migration chỉ-dữ-liệu, không đổi một dòng mã nào**. Đây là kết quả rẻ
nhất có thể có cho quyết định của chủ dự án.

### 8.2 Quyết định của chủ dự án làm vấn đề B3 nhỏ đi ba lần

Care rời bảng giá thì ba lời hứa của nó đi theo. Còn lại phải phân biệt **hai loại mục** trong
`PLANS[].feat` — bản brief trước tôi gộp làm một, và đó là sai:

| loại | ví dụ | vấn đề? |
|---|---|---|
| **Năng lực nền** — mọi gói đều có | "COD + QR chuyển khoản", "Quản lý đơn · tồn kho · danh mục", "Tên miền phụ .nentang.vn" | **Không.** Liệt kê năng lực sản phẩm là marketing bình thường, không phải lời hứa phân tầng. |
| **Khác biệt theo bậc** — ngụ ý *trả thêm mới có* | Growth: "Tên miền riêng của bạn", "Đối soát QR tự động" | **CÓ.** Không cửa chặn nào; shop Platform dùng được cả hai. |

Sau khi bỏ Care, **chỉ còn HAI mục** cần xử lý, cả hai ở gói Growth. Không phải năm.

### 8.3 `support_tickets` có đủ dữ liệu cho "nhân viên chỉ xem phiếu của mình" — với một điều kiện

`0107` tạo bảng với **`user_id uuid REFERENCES users(id)`** — ghi ai gửi. Vậy lọc theo người
gửi là làm được.

Nhưng cột **nullable**, và chú thích ngay tại đó nói rõ vì sao: *"NULL nếu user bị xoá sau
này"*. Hệ quả phải nêu trước, không phát hiện sau: **phiếu của người đã rời shop sẽ biến mất
khỏi tầm nhìn của nhân viên**. Điều đó chấp nhận được **chỉ vì** owner/admin xem toàn bộ, nên
không phiếu nào thật sự mất — nhưng phải là lựa chọn có ý thức, phải viết vào chú thích, và
phải có test.

RLS hiện tại là `tenant_isolation FOR ALL TO app_rw USING (shop_id = current_shop_id())` — mức
**shop**, không có mức người dùng. `listTickets` cũng không lọc `user_id`. Nên phần "chỉ xem
phiếu của mình" là **vị từ truy vấn + perm ở route**, không phải policy mới. Không nới RLS.

### 8.4 Gốc rễ `/help`: một lựa chọn có chủ ý dựa trên niềm tin SAI

`apps/seller/src/support.js:86-87` ghi nguyên văn:

> `perm 'orders.read' = "là thành viên shop và đọc được việc của shop" — mức thấp nhất mà mọi`
> `vai đều có. Cố ý KHÔNG đặt perm cấu hình.`

Ý định đúng, dữ kiện sai. Đo lại bằng chính `rbac.js`:

| vai | có `orders.read`? |
|---|---|
| owner | CÓ |
| admin | CÓ |
| **catalog_manager** | **KHÔNG** |
| order_manager | CÓ |

Tác giả muốn "quyền thấp nhất mọi vai đều có" và chọn phải một quyền mà **một nửa số vai không
có**. Không có perm nào trong `ALL_PERMS` thoả tính chất đó — nên tính chất ấy phải được **tạo
ra**, không phải **tìm thấy**. Đó chính là lý do cần perm `support.write` mới.

### 8.5 Landing hardcode giá — kênh trôi thứ hai

`landing.js:118-122` viết thẳng `'990.000'`, `'2.490.000'`, `'5.900.000'` và tên gói. Đổi giá
trong DB thì trang bán hàng nói sai, im lặng. Luật "dẫn xuất từ dữ liệu" của chủ dự án nhắm
đúng chỗ này — nhưng nó vướng một câu hỏi quyền, xem §10.

---

## 9. BRIEF — đề nghị khoá

Năm việc. **Mỗi việc một commit riêng**, kể cả khi cùng đợt.

### C1 — Ngừng bán Care *(Codex)*

Migration `0177`, **chỉ dữ liệu**: `UPDATE plans SET active = false WHERE code = 'care';`

Không đụng schema. Không xoá dòng. Không đổi giá.

**Test bất biến DB (`packages/db/test/`):**
- `care` vẫn tồn tại trong `plans`, `active = false`
- `platform` và `growth` `active = true`
- Thuê bao trỏ `plan_code='care'` vẫn JOIN ra được `max_products` (dựng fixture một shop Care,
  khẳng định `catalog.js` vẫn đọc được trần 100)

**Test e2e/unit:** POST `billing` với `plan_code=care` → **400** `gói dịch vụ không hợp lệ`;
`platform` renew với `plan_code=care` → **400**. Đây là chốt chống lách, không phải chốt hiển thị.

**Đột biến bắt buộc:** đặt lại `active=true` cho care → hai test 400 phải ĐỎ.

`MANIFEST_MIGRATION_COUNT` 174 → 175 trong cùng commit.

### C2 — Mọi điểm bán in trần sản phẩm *(Claude, trừ signup → Codex)*

| chỗ | việc | ai |
|---|---|---|
| `signup/server.js:87` | `loadPlans` thêm `max_products` vào SELECT | Codex |
| `signup/views.js:120` | in thêm trần, cạnh giá | Codex |
| `pages.js:6687` ô nâng gói | thay nhãn tự chế bằng chính `planLabel` (`pages.js:1568`) | Claude |

`planLabel` đã in đúng định dạng và đang phục vụ console nhân viên nền tảng. Việc ở đây là
**thôi giữ nó cho riêng người nội bộ**.

**Chốt nguồn:** `planLabel` phải được dùng ở **cả ba** nơi bán (console, ô nâng gói, signup);
đếm so BẰNG. Ai đó viết lại nhãn tay ở chỗ thứ tư là ĐỎ.

### C3 — Lời nhắc chạm trần nói sự thật *(Claude)*

`pages.js:3955` hiện in *"Đã đạt giới hạn — nâng gói để thêm."*

Thay bằng câu **dẫn xuất từ `plans`**: nêu trần hiện tại, rồi liệt kê gói **đang bán** có
`max_products > mx`. Không gói nào cao hơn → **không mời nâng gói**, nói thẳng đã ở trần cao
nhất và mời liên hệ.

Không khuyến nghị gói cụ thể — chỉ nêu gói nào có trần cao hơn. Không hardcode "Growth", không
hardcode "500".

**Chốt nguồn:** không được có chuỗi tên gói hay số trần viết thẳng trong nhánh này.

### C4 — Trang bán hàng thôi hứa thứ chưa cưỡng chế *(Codex)*

Ba phần:

1. **Bỏ thẻ Care** khỏi `PLANS` (Care không còn bán). Ba mục của nó đi theo.
2. **Bỏ "Hỗ trợ ưu tiên"** — chủ dự án đã chốt.
3. **Hai mục còn lại của Growth** — "Tên miền riêng của bạn", "Đối soát QR tự động" — **không
   được xuất hiện như tính năng đang có**. Ẩn, hoặc ghi rõ *"sắp ra mắt"*. Chủ dự án chọn ở §10.

**Chốt nguồn** (thứ ngăn nó trôi lại): mỗi mục trong `PLANS[].feat` phải khai vào **một** trong
ba danh sách, so **BẰNG**:

- `NANG_LUC_NEN` — mọi gói đều có; không phải lời hứa phân tầng
- `CO_CUONG_CHE` — có cửa chặn thật, **kèm chỉ tới nơi chặn** (hôm nay chỉ `max_products` →
  `catalog.js:175`)
- `SAP_RA_MAT` — chưa cưỡng chế, và **giao diện phải gắn nhãn tương ứng**

Thêm một dòng quảng cáo không khai là ĐỎ. Khai vào `CO_CUONG_CHE` mà không chỉ được nơi chặn
cũng là ĐỎ.

**Đột biến:** thêm một mục `feat` giả không khai → ĐỎ; chuyển một mục từ `SAP_RA_MAT` sang
`CO_CUONG_CHE` mà không có nơi chặn → ĐỎ.

### C5 — Quyền hỗ trợ riêng *(Codex — migration + RBAC + API; Claude — giao diện)*

Perm mới **`support.write`**, cấp cho **cả bốn vai**. Lý do phải tạo mới chứ không mượn:
không perm nào trong `ALL_PERMS` hôm nay được cả bốn vai giữ (§8.4).

| route | perm | ai xem gì |
|---|---|---|
| `POST /shops/:id/support` | `support.write` | mọi thành viên tạo được phiếu |
| `GET /shops/:id/support` | `support.write` | owner/admin: **toàn bộ** phiếu của shop; vai khác: **chỉ phiếu `user_id = chính mình`** |

Lọc bằng **vị từ truy vấn** trong `listTickets`, không thêm policy RLS. RLS giữ nguyên mức shop.

**Phải viết vào chú thích và phải có test:** `user_id` nullable, nên phiếu của người đã rời shop
không lọt vào tầm nhìn nhân viên. Chấp nhận được **vì** owner/admin thấy tất — không phiếu nào
mất. Nếu ai đó sau này bỏ nhánh owner/admin-thấy-tất thì phiếu mồ côi biến mất thật.

**Giao diện *(Claude)*:** `helpPage` **thôi nuốt lỗi** — `r.json?.tickets ?? []` phải kiểm
`r.status` trước; 403 nói rõ lý do thay vì hiện "Bạn chưa gửi yêu cầu nào". Với vai chỉ thấy
phiếu mình, nói rõ điều đó trên trang.

**Đột biến bắt buộc:** bỏ `support.write` khỏi `catalog_manager` → e2e ĐỎ; bỏ vị từ `user_id`
→ test "nhân viên không thấy phiếu người khác" ĐỎ.

### C6 — Giỏ hàng 373/360 *(Claude, commit RIÊNG)*

Dòng thành tiền (`STRONG`) đẩy ngang ở `checkout /cart`. CSS thuần. **Không đụng số tiền.**
Đo lại bằng `headless_shell` ở 360px, JS bật và tắt, phải ≤ 360 cả hai.

### Ngoài phạm vi

Không đổi schema `plans`. Không thêm cửa chặn tính năng theo gói. Không đổi giá. Không cấp
`orders.read` cho ai. Không đổi công thức tiền/tồn. Không đụng SePay. Không dựng SLA/priority.

---

## 10. Còn chờ chủ dự án — hai câu

**Câu A — hai mục Growth chưa cưỡng chế: ẩn hay "sắp ra mắt"?**
"Tên miền riêng của bạn" và "Đối soát QR tự động" hôm nay **shop Platform cũng dùng được**.

- **Ẩn hẳn** — trung thực tuyệt đối. Đổi lại: Growth chỉ còn "500 sản phẩm", khó bán 5.900.000₫.
- **Ghi "sắp ra mắt"** — giữ được câu chuyện sản phẩm, nhưng là một lời hứa có hạn: nếu sáu
  tháng nữa vẫn "sắp ra mắt" thì nó tệ hơn im lặng.

**Câu B — landing lấy giá từ đâu?** Luật của chủ dự án là dẫn xuất từ dữ liệu, nhưng:
`plans` **không có RLS và không có policy** (bảng tham chiếu, không có `shop_id`), còn `app_store`
— vai công khai chỉ-đọc của storefront — **không có `SELECT ON plans`** (chỉ `app_rw`,
`app_billing`, `app_signup` có).

- **Cấp `SELECT ON plans TO app_store`** — một dòng migration, không cần policy. Bảng này *là*
  bảng giá công khai nên không lộ gì. Nhưng nới quyền một vai `app_*` là thứ `CLAUDE.md §7` bắt
  hỏi trước, nên tôi hỏi.
- **Không nới quyền, bỏ giá khỏi landing** — khối bảng giá dẫn sang `/signup` (service đã đọc
  được `plans`). Giá chỉ tồn tại ở đúng một nơi, không thể trôi.

Tôi nghiêng về phương án hai: nó thoả luật "một nguồn sự thật" mà **không** phải nới quyền, và
`/signup` vốn là nơi người ta phải tới để mua.
