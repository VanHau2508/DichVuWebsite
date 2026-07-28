# 45 — Di cư danh mục từ sàn khác

> Trạng thái: thiết kế → triển khai v1.
> Liên quan: [11-catalog](11-catalog.md) · [12-inventory-media](12-inventory-media.md) ·
> [18-security-hardening](18-security-hardening.md) · [43-self-serve-signup](43-self-serve-signup.md)

## 1. Vì sao

Nút thắt bán-ở-quy-mô không nằm ở tính năng mà ở **chi phí chuyển đổi**. Một shop đang bán
trên Shopee/Haravan có sẵn vài trăm sản phẩm, mỗi cái nhiều biến thể và nhiều ảnh. Nếu sang
nền tảng này phải gõ lại bằng tay thì họ **không sang** — mọi thứ khác ta làm đều không được
dùng tới.

Bộ nhập hiện có (`POST /shops/:id/products/import`) mới ở mức "một dòng CSV = một sản phẩm
một biến thể, không ảnh, không danh mục". Đổ danh mục thật vào đó thì:

- sản phẩm 3 màu × 4 size **bẹp thành 12 sản phẩm rời**, mất hẳn khái niệm biến thể;
- không ảnh ⇒ cửa hàng trắng trơn ⇒ người bán bỏ ngang ngay buổi đầu;
- không danh mục ⇒ menu rỗng, storefront không điều hướng được.

## 2. Phạm vi v1

**CÓ:**

1. **Gộp biến thể đa trục** — nhiều dòng cùng `handle` → **một** sản phẩm với các trục
   (`product_options` / `option_values` / `variant_option_values`, đã có từ 0041-0043).
2. **Danh mục theo tên**, tôn trọng cây 2 cấp của 0095 (`Thịt > Thịt heo`); tạo nếu chưa có.
3. **Ảnh theo URL** — tải về, làm sạch, lưu như ảnh tự tải lên.
4. **Tương thích ngược**: file CSV 1-dòng-1-SP đang dùng vẫn chạy y nguyên.

**KHÔNG (và vì sao) — đây là phần quan trọng nhất của tài liệu này:**

| Không làm | Lý do |
|---|---|
| **Nhập đơn hàng cũ** | Khách hàng trong hệ này **không phải bảng riêng** — `customers.js` suy ra từ `orders.customer_phone`. Nên "nhập khách" thực chất là ghi thẳng vào `orders`, tức **đụng đường tiền**: doanh thu, P&L (docs/37), sổ cái kho, điểm thưởng. Câu hỏi "đơn di cư có tính vào doanh thu tháng này không" là **quyết định nghiệp vụ**, không phải chi tiết kỹ thuật — phải chốt trước khi viết dòng code nào. |
| **Cập nhật sản phẩm đã có (upsert)** | Cần quy tắc khớp (theo `sku`? `handle`?) và sẽ **ghi đè giá đang bán**. Một file nhập sai cột giá có thể hạ giá cả cửa hàng trong một lần bấm. v1 chỉ **tạo mới**; dòng trùng `sku` bị từ chối kèm lý do. |
| **Nhập trực tiếp bằng API của sàn** | Cần app/khoá đối tác của từng sàn và người bán phải cấp quyền. Rào cản vận hành lớn hơn giá trị ở giai đoạn pilot. CSV là mẫu số chung: sàn nào cũng xuất được. |

## 3. Định dạng CSV chuẩn

Lấy hình dạng **Shopify** làm gốc vì Haravan và Sapo đều là dòng dõi Shopify, và đó là định
dạng phổ biến nhất người bán Việt xuất ra được.

| Cột | Bắt buộc | Ý nghĩa |
|---|---|---|
| `handle` | không | **Khoá gộp.** Các dòng cùng `handle` = một sản phẩm. **File KHÔNG có cột `handle` ⇒ mỗi dòng là một sản phẩm riêng** (nguyên hành vi cũ, kể cả khi trùng tên). Có cột nhưng ô trống ⇒ dòng đó đứng riêng. Cố ý **không** gộp theo `title`: hai sản phẩm khác nhau trùng tên là chuyện thường, gộp nhầm thì người bán mất hàng mà không biết. |
| `title` | dòng đầu của nhóm | Tên sản phẩm. |
| `description` | không | Mô tả. |
| `status` | không | `active` hoặc `draft` (mặc định `draft` — **cố ý**: nhập xong không tự bày bán, người bán soát rồi mới đăng). |
| `category` | không | Đường dẫn danh mục, phân cách bằng `>`. Tối đa **2 cấp** (0095). |
| `option1_name`…`option3_name` | không | Tên trục: `Màu`, `Size`. |
| `option1_value`…`option3_value` | không | Giá trị trục của **dòng này**. |
| `sku` | có | Mã biến thể, duy nhất trong shop. |
| `price_vnd` | có | Giá bán. |
| `compare_at_price_vnd` | không | Giá gạch ngang. |
| `cost_vnd` | không | Giá vốn (vào `variant_costs`, docs/37). |
| `stock` | không | Tồn ban đầu (mặc định 0). |
| `weight_gram` | không | Cân nặng, dùng cho phí ship theo cân. |
| `image_url` | không | Ảnh **của dòng**. Thư viện ảnh sản phẩm = hợp các ảnh của mọi dòng trong nhóm, theo thứ tự dòng. |

**Bí danh cột.** Bộ nhập nhận cả tên cột của định dạng gốc (`Handle`, `Variant SKU`,
`Variant Price`, `Option1 Name`, `Image Src`…) — không phân biệt hoa thường, bỏ qua dấu cách.

> **Giới hạn thành thật:** bí danh cho **Shopify/Haravan** dựa trên định dạng tôi nắm chắc.
> **Shopee và Sapo thì chưa** — tôi không có file xuất thật để đối chiếu, và đoán tên cột rồi
> ghi vào bảng ánh xạ là tạo ra thứ *trông như* đã hỗ trợ nhưng im lặng bỏ sót cột. Cơ chế
> bí danh viết theo kiểu **dữ liệu, thêm một dòng là xong**; khi có file xuất thật của
> Shopee/Sapo thì bổ sung, không phải sửa logic.

## 4. Quy tắc gộp

1. Duyệt dòng theo thứ tự file, gom theo `handle` đã chuẩn hoá.
2. Dòng **đầu tiên** của nhóm cấp thông tin cấp sản phẩm (`title`, `description`, `status`,
   `category`, `slug`). Các dòng sau **chỉ** đóng góp biến thể + ảnh; cột cấp-sản-phẩm ở dòng
   sau bị **bỏ qua chứ không ghi đè** — file thật hay để trống các ô đó, và nếu ghi đè thì
   một ô lạc sẽ đổi tên cả sản phẩm.
3. Trục lấy từ dòng đầu có `optionN_name`. Trong một nhóm, tên trục **phải nhất quán**; lệch
   thì cả nhóm bị từ chối kèm số dòng — nhập nửa vời một sản phẩm còn tệ hơn không nhập.
4. Giá **cấp sản phẩm** = giá nhỏ nhất trong nhóm (khớp cách storefront hiển thị "từ ...₫").
5. Trần: **100 biến thể/sản phẩm** (đúng trần ma trận đã có), **1000 dòng/lần nhập**.
6. Nhóm lỗi thì **bỏ cả nhóm**, các nhóm khác vẫn vào — nhập một phần là hành vi đúng cho
   file hàng trăm dòng; nhưng đơn vị "một phần" là **sản phẩm**, không phải dòng.

## 5. Ảnh theo URL — mặt tấn công và hàng rào

Đây là phần nguy hiểm nhất của cả tính năng, vì nó biến máy chủ thành **bộ tải hộ**.

**Mô hình đe doạ.** Từ khi có self-serve signup (docs/43), **bất kỳ ai cũng tự mở được shop**
trong vài giây. Nên URL trong CSV **là input của kẻ lạ trên Internet**, không phải của "người
bán đáng tin". Kẻ tấn công đăng ký shop rồi nhập một CSV chứa URL trỏ vào mạng nội bộ để:

- quét cổng nội bộ (`http://postgres:5432`, `http://redis:6379`, `http://platform:3030`);
- gọi API nội bộ không đi qua edge;
- đọc endpoint metadata của nhà cung cấp máy chủ (`169.254.169.254`);
- dùng máy chủ ta làm bàn đạp tấn công bên thứ ba (ta chịu trách nhiệm IP).

**Hàng rào nhiều lớp** — không lớp nào một mình đủ:

1. **Chỉ `http`/`https`.** Chặn `file:`, `gopher:`, `data:`.
2. **Phân giải DNS rồi kiểm IP**: chặn loopback, private (10/8, 172.16/12, 192.168/16),
   link-local (169.254/16 — gồm metadata), CGNAT (100.64/10), multicast, reserved; và bản
   IPv6 tương ứng gồm `::1`, `fc00::/7`, `fe80::/10`, cùng dạng **IPv4-mapped** `::ffff:10.0.0.1`.
3. **Chống DNS-rebinding**: kiểm IP xong thì **ghim đúng IP đó** để kết nối (custom `lookup`),
   không phân giải lại. Không có bước này thì "kiểm rồi mới nối" là cửa sổ TOCTOU kinh điển.
4. **Từ chối chuyển hướng** (`redirect: 'manual'`). Chuyển hướng là đường vòng qua lớp 2-3;
   theo dấu cho đúng phải kiểm lại IP mỗi chặng, mà từ chối thì rẻ hơn và đủ dùng.
5. **Trần kích thước + timeout**, cắt luồng khi vượt chứ không đọc hết rồi mới kiểm.
6. **Sniff magic byte + re-encode WebP bằng sharp** — dùng lại nguyên đường ống ảnh hiện có,
   không viết lại. Đây là bước biến "ảnh có payload nhúng" thành ảnh sạch và bỏ EXIF/GPS.
7. **Trần số ảnh mỗi lần nhập** — chống biến chức năng nhập thành công cụ DDoS bên thứ ba.
8. **Không rò chi tiết lỗi.** Người bán chỉ thấy "không tải được ảnh"; không trả mã trạng
   thái/thời gian phản hồi của đích, vì đó chính là kênh của **blind SSRF**.

**Ràng buộc ĐO ĐƯỢC đã đổi thiết kế.** BFF gọi seller với timeout mặc định **8 giây**
(`seller-admin/src/api.js`). Tải ảnh đồng bộ vượt ngay, và hậu quả tệ nhất không phải "chậm"
mà là: người bán thấy *"không nhập được"* trong khi sản phẩm **đã tạo xong** — họ bấm lại và
**nhân đôi hàng**. Nên thứ tự là: tạo sản phẩm trước (nhanh) → tải ảnh trong ngân sách còn
lại → hết giờ thì **bỏ qua ảnh và BÁO SỐ LƯỢNG bỏ qua**, không bao giờ im lặng.

Số đang dùng: timeout lời gọi nhập ở BFF **70s** · ngân sách ảnh **45s** · mỗi ảnh **4s** ·
6 luồng · tối đa **200 ảnh/lần nhập** · mỗi ảnh **≤ 8MB**. Tất cả chỉnh được bằng biến môi
trường. Chỉ cổng **80/443**.

**Vì sao chưa tách sang worker.** Worker sẽ cô lập mạng sạch hơn và bỏ hẳn trần thời gian,
nhưng nó cần: thêm `sharp` vào worker (chưa có) · migration lưu URL nguồn · cấp quyền cho vai
worker · một sweep mới kèm retry. Đó là khối việc ngang cả tính năng này. v1 chạy đồng bộ
trong trần; **khi shop thật bắt đầu nhập file vài trăm ảnh thì đây là việc tiếp theo**, và
phần SSRF không phải viết lại — `fetch-image.js` dùng nguyên.

**Lối thoát cho kiểm thử.** Cả stack dev đều là IP nội bộ, nên đường-thành-công không kiểm
được nếu hàng rào không có lối ra. `IMPORT_IMG_ALLOW_HOSTS` là **danh sách tên miền tường
minh** (không phải cờ bật/tắt: cờ lỡ bật ở prod là tắt sạch hàng rào, danh sách chỉ mở đúng
tên đã ghi) và **chỉ** miễn lớp kiểm dải IP — scheme, cổng, chuyển hướng, trần cỡ, timeout,
sniff magic byte, re-encode đều giữ nguyên. Chỉ đặt trong `compose.dev.yml`; nếu prod lỡ có,
seller **ghi cảnh báo lúc khởi động** chứ không im lặng.

## 6. Ghi nhận & kiểm toán

- Mỗi lần nhập ghi `audit` `product.imported` như cũ, kèm `handle` và số biến thể.
- Ảnh tải từ URL đi qua đúng bảng `media` với `status` pending → ready, nên **worker dọn rác
  ảnh mồ côi hiện có tự áp dụng** — không cần cơ chế dọn riêng.

## 7. Kiểm thử phải có

- Gộp: 12 dòng 2 trục → 1 sản phẩm, 12 biến thể, 2 trục, 3+4 giá trị.
- Tên trục lệch giữa các dòng → **cả nhóm** bị từ chối, nhóm khác vẫn vào.
- Danh mục 2 cấp tạo đúng cha-con; cấp 3 bị từ chối.
- Tương thích ngược: file CSV cũ (không `handle`, không trục) vẫn ra kết quả như trước.
- **SSRF**: `http://127.0.0.1`, `http://169.254.169.254`, `http://10.0.0.1`, tên miền phân
  giải về IP nội bộ, URL trả chuyển hướng, `file:///etc/passwd` — tất cả phải bị từ chối
  **mà không phát ra kết nối nào**.
- Trần: >100 biến thể/nhóm, >1000 dòng, ảnh quá lớn.
