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
