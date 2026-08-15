# 73 — Cửa vào và lần thiết lập đầu tiên

Đợt này làm ba việc nối nhau thành **một** đường: người lạ đăng ký → xác minh email → đăng nhập
→ có cửa hàng dùng được. Trước đợt này đường đó đi qua ba bảng màu, hai kiểu bố cục, và kết thúc
bằng một bảng điều khiển 12 mục menu không nói cho ai biết phải bấm gì trước.

Tài liệu này ghi **cái đo được** và **cái đã làm sai**, không ghi lại nội dung mã.

---

## 1. Vì sao đợt này tồn tại

Yêu cầu ban đầu chỉ có ba dòng: có trang đăng nhập tử tế, bắt xác thực email khi đăng ký/quên mật
khẩu, và có màn đặt tên + thông tin cửa hàng. Đi đo trước khi viết (CLAUDE.md §5.1) thì ra ba
chuyện khác với mô tả:

| tưởng | thật |
|---|---|
| "hệ thống chưa có trang đăng nhập" | Có — `/login`, `/mfa`, `/forgot`, `/reset` đủ cả, nhưng là **thẻ trắng giữa màn hình trống**, không có gì nói đây là sản phẩm gì |
| "cần bắt xác thực email khi đăng ký" | **Đã bắt sẵn** từ 0083: `signup` gửi link, chưa bấm thì shop không được provision. Việc cần làm là *cho người ta thấy* điều đó chứ không phải dựng lại |
| "quên mật khẩu chưa xác thực email" | **Đã xác thực** — `/forgot` gửi token qua email, không có đường nào đặt lại mật khẩu mà không mở hộp thư |

Nên phần "xác thực gmail" của yêu cầu **không phải việc phải làm**, mà là việc phải **hiện ra**:
luồng đã đúng, chỉ là ba trang trong luồng trông như ba sản phẩm khác nhau nên người dùng không
tin là mình vẫn đang ở cùng một nơi.

Còn OAuth Google (đăng nhập bằng tài khoản Google) thì **chưa có thật** và đã thống nhất để lại
đợt sau — nó kéo theo liên kết tài khoản, thu hồi quyền, và đường "email đã tồn tại nhưng đăng ký
bằng mật khẩu", tức là một đợt riêng chứ không phải một nút.

---

## 2. Ba việc đã làm

### 2.1 Bảy trang cửa vào của seller-admin → khung hai panel

`/login`, `/mfa`, `/forgot`, `/forgot-done`, `/reset`, `/reset-done` dùng chung một khung: panel
trái nói **đây là gì và được cái gì**, panel phải là form. Panel trái không phải trang trí — nó
là chỗ duy nhất trong toàn bộ luồng nói cho người đang đăng nhập biết họ đang đăng nhập vào cái
gì. Bốn gạch đầu dòng ở đó chỉ hứa những thứ hệ thống **làm được thật**: tên miền phụ, kho theo
biến thể, vận đơn GHN/GHTK, COD + VietQR vào thẳng tài khoản shop.

Thêm `SIGNUP_LINK` (URL **tuyệt đối**): trang đăng ký nằm ở site công khai, Caddy đưa `/signup*`
sang service `signup`, còn admin ở tên miền khác. Link tương đối ở đây ra 404 ngay trên admin.
Mặc định là tên miền thật (đúng cho prod kể cả khi quên khai biến); dev đặt lại bằng
`PUBLIC_SITE_URL` trong cả hai compose để bấm thử được qua Caddy cổng 8443.

### 2.2 Chín trang của service `signup` → cùng khung đó

Trang đăng ký và toàn bộ luồng xác minh email đang dùng bảng màu riêng (`--brand:#2563eb`) khác
hẳn seller-admin. Người đi từ trang đăng ký sang trang đăng nhập thấy như đổi sang sản phẩm khác.

CSS **cố ý chép lại** chứ không import chung. `signup` và `seller-admin` build từ context riêng,
không có bind-mount cho `packages/` ở đây; thêm một mount chỉ để chia sẻ CSS là trả giá vận hành
(một phụ thuộc vô hình nữa — xem CLAUDE.md §3) cao hơn giá trị nhận được. Đánh dấu
`MỐC-ĐỒNG-BỘ: cua-vao-hai-panel` ở **cả hai** nơi để lần sau sửa màu biết phải sửa hai chỗ.

### 2.3 Wizard thiết lập nhanh — ① Tên gian hàng → ② Giao diện

Hai bước, không hơn. Bước ① hỏi tên (bắt buộc) + SĐT + địa chỉ; bước ② chọn một trong 5 mẫu ngành.

Không dùng shell admin (side nav) — menu 12 mục bên cạnh chính là thứ wizard sinh ra để che đi.

**Không tự chuyển hướng vào wizard.** Cổng vào là một nút trong checklist Tổng quan. Ép tự động
cần một cột "đã xong wizard" trong DB; đoán bằng dấu hiệu gián tiếp ("chưa có SĐT" chẳng hạn) thì
người **cố ý** không khai SĐT bị ném lại vào wizard mỗi lần mở trang. Cái bẫy đó khó chịu hơn hẳn
việc phải bấm thêm một nút, và nó không tự khỏi.

---

## 3. Lỗ hổng đắt nhất đợt này: `PATCH /shops/:id` không phải merge

Đây là phần đáng đọc lại nhất.

`apps/seller/src/server.js` xử lý `PATCH /shops/:id` bằng **đúng một câu**:

```sql
UPDATE shops SET name = $1, contact_email = $2, …, ship_over_max_behavior = $22
 WHERE id = current_shop_id()
```

**22 cột, một lần, và ô rỗng hoá NULL.** Không có `COALESCE` giữ giá trị cũ (trừ đúng
`ship_road_factor`), không có "chỉ ghi trường nào được gửi".

Wizard hỏi 3 ô. Nếu nó POST đúng 3 ô đó thì **19 cột còn lại về NULL**:

| cột bị xoá | hậu quả với shop đang bán |
|---|---|
| `ship_fee_vnd`, `ship_fee_far_vnd`, `ship_extra_per_500g_vnd` | phí ship về 0 — shop gánh toàn bộ cước |
| `free_ship_threshold_vnd` | mất ngưỡng miễn phí ship |
| `ship_mode`, `ship_origin_lat/lng`, `ship_base_vnd`, `ship_per_km_vnd`, `ship_max_km` | ship theo km (0089) tắt sạch, về phí vùng |
| `low_stock_threshold` | mất cảnh báo sắp hết hàng |
| `max_pending_per_ip`, `max_pending_per_phone` | mất chốt chống đơn ảo (0051) |
| `pii_retention_months` | hạn ẩn danh dữ liệu khách (0064) về "giữ vĩnh viễn" |
| `contact_email` | mất email liên hệ trên chân trang + trong email gửi khách |

**HTTP trả 200. Không lỗi, không cảnh báo, không dòng log nào.** Chủ shop phát hiện ra khi khách
đặt hàng và thấy phí ship bằng 0 — tức là sau khi đã mất tiền, và tới lúc đó **không còn cách nào
biết giá trị cũ là bao nhiêu** để đặt lại.

Cần nói rõ: đây **không phải lỗi của seller**. Form Cài đặt gửi đủ 22 ô nên ghi-đè-toàn-bộ là
đúng và đơn giản. Lỗ hổng nằm ở chỗ **mọi form sửa một phần** đều phải tự biết điều đó.

### 3.1 Cách vá: đọc-trộn-ghi

`GET /shops/:id` (trả đủ 22 cột) → dựng lại **nguyên** body từ giá trị hiện tại → mới đè đúng ô
form đang sửa. Gói trong `apps/seller-admin/src/shop-patch.js`.

Ba chi tiết nhỏ mà bỏ là hỏng:

- **`null → ''`, tuyệt đối không `String(null)`.** Chuỗi `'null'` đi qua `parseMoney` thì thành
  NULL (may, vì nó lọc phi-số) — nhưng ở cột **chữ** như `ship_from_province` nó nằm nguyên thành
  chữ `"null"`, rồi `isProvince()` từ chối và cả form 400 mà không ai hiểu vì sao.
- **Gửi lại `pii_retention_months` bằng đúng giá trị cũ** khiến chốt "chỉ chủ shop được đổi hạn
  lưu dữ liệu khách" (seller so `cũ !== mới`) **không kích hoạt** → admin vẫn qua được wizard.
  Tác dụng phụ có chủ ý, không phải may mắn.
- **File riêng, không để trong `server.js`.** `server.js` gọi `server.listen()` lúc nạp module
  nên `node --test` không import được — mà chốt này thì phải test được ở mức unit.

### 3.2 Hai lớp canh, cố ý không gộp

**`apps/seller-admin/test/shop-patch.test.js` (unit, mới)** — bóc danh sách cột ra từ **chính câu
UPDATE** trong mã seller rồi so với `SHOP_PATCH_KEYS`. Thêm cột thứ 23 vào UPDATE mà quên khai ở
đây là đỏ ngay. Đây là thứ e2e không làm được một cách bền: e2e chỉ khẳng định những cột người
viết nghĩ ra hôm đó.

**`admin-onboarding.e2e.mjs` mục 1d/1e (mở rộng)** — nạp một hồ sơ shop "đã dùng thật" (ship theo
km + PII 24 tháng), chạy wizard, rồi `SELECT *` trước/sau và **so từng cột**. Đo bằng DB chứ
không bằng chữ trên màn hình; so theo danh sách viết tay thì cột thêm sau này lọt lưới.

Cần **cả hai**: unit canh *hình dạng* body, e2e canh *kết quả* sau khi đi qua validate của seller
— body đúng hình mà seller từ chối một giá trị nào đó thì wizard vẫn hỏng, và unit không thấy.

### 3.3 Đột biến đã chạy (CLAUDE.md §5.4)

| đột biến | kết quả |
|---|---|
| gốc | 5 pass, 0 fail |
| bỏ `'ship_fee_vnd'` khỏi `SHOP_PATCH_KEYS` | **2 fail** |
| `null` hoá chữ `'null'` thay vì `''` | **1 fail** |
| `onboardingSave` PATCH thẳng 3 ô | **1 fail** |
| khôi phục | 5 pass, 0 fail |

---

## 4. Lỗi của chính mình trong đợt này

Phần có giá trị nhất khi đọc lại.

### 4.1 Hai lần thiết kế lại landing page bị bác — cùng một nguyên nhân

Trước ba việc trên, đợt này bắt đầu bằng việc thiết kế lại trang chủ. **Bác hai lần**, lần hai
kèm nhận xét là còn xấu hơn bản gốc.

Tự chẩn lần một: quá khắc khổ, **cắt bớt nội dung** (2 khối tính năng so với 5 tab + 4 khối +
đánh giá của bản gốc), màu trầm, không ảnh. Khái niệm "sổ cái" là thứ **tôi** thấy hay, không
phải thứ làm chủ shop muốn mở tài khoản.

Lần hai vẫn hỏng, và điều đáng ghi hơn: trong chính bản thử thứ hai tôi đẻ ra **32 cỡ chữ khác
nhau** — **đúng khuyết tật tôi vừa chẩn ra ở bản gốc** và viết thành `docs/72`. Viết được luật
không có nghĩa là làm theo được luật; phải có phép đếm chạy trên sản phẩm chứ không phải trong
đầu.

Bài học đã áp vào ba việc sau: **không sinh màu mới** — wizard và các trang cửa vào dùng lại đúng
bộ token đã có (`--pri`, `--ink`, `--mut`, `--bd`, `--good`, `--bad`…), không thêm một hex nào.
Và dừng sau hai lần thay vì thử mù lần ba.

### 4.2 Regex bóc cột suýt tạo một bộ test xanh giả

Bản đầu của `updateShopsColumns()` viết là:

```js
/UPDATE shops SET ([\s\S]*?)WHERE id = current_shop_id\(\)/
```

Seller có **ba** câu `UPDATE shops SET` (activate, hồ sơ, require_mfa). Match không-tham vớ phải
câu `activate` rồi nuốt sang tận `WHERE` của câu sau → bóc ra **2 cột thay vì 22**.

May là ngưỡng viết cứng `=== 22` nên nó **đỏ**. Nếu lúc đó viết `>= 2` hoặc bỏ luôn phép đếm thì
đã có một bộ test **chạy, xanh, và không canh gì cả** — đúng bẫy "xanh vì lý do sai" ở CLAUDE.md
§4. Vá bằng cách neo vào `SET name = $1`.

Ghi lại vì đây là lần thứ hai trong kho này một phép kiểm suýt trôi thành đồ trang trí, và cả hai
lần đều được cứu bởi **một con số cứng** chứ không phải bởi người đọc lại.

### 4.3 Suýt làm đỏ một mục e2e không liên quan

Bản đầu của mục 1d dùng lại shop `A` của bộ test. Hồ sơ mẫu đặt `ship_fee_vnd`, mà mục "Phí vận
chuyển" của checklist đọc **đúng cột đó** → mục 2 (`vẫn 0/4`) sẽ đỏ vì một lý do chẳng liên quan
gì tới thứ nó canh. Bắt được lúc đọc lại mục 2 trước khi chạy, không phải lúc chạy.

Vá bằng shop riêng cho wizard. Ghi lại vì lớp lỗi này (**fixture của mục sau bị mục trước làm
bẩn**) không hiện ra ở người viết mục mới — nó hiện ra ở người đọc log ba tuần sau và tưởng mục 2
mới là thứ hỏng.

---

## 5. Còn nợ

- **OAuth Google.** Đã thống nhất để đợt sau. Kéo theo: liên kết tài khoản đã có mật khẩu, thu
  hồi quyền, và nhánh "email này đã đăng ký bằng mật khẩu".
- **Không có cột "đã xong wizard".** Nên wizard không tự bật cho người mới; đổi được nếu chấp
  nhận thêm một migration và một cột.
- **Nhánh `claude/landing-redesign` trên remote chưa xoá được** — `git push --delete` liên tục
  đứt kết nối. Xoá bằng tay trên GitHub.
