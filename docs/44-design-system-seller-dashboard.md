# Design System — Bảng điều khiển người bán (lấy cảm hứng TikTok Shop Seller Center)

> **Phạm vi:** hệ thiết kế cho **`apps/seller-admin`** (trang quản trị nhà bán hàng).
> KHÔNG áp cho storefront — storefront dùng hệ **MAISON** riêng (xem `apps/storefront/src/theme.js`).
>
> **Nguồn:** đúc kết từ 3 màn hình TikTok Shop Seller Center (Trang chủ · Quản lý đơn hàng ·
> Quản lý sản phẩm). Giá trị màu/kích thước là **ước lượng từ ảnh chụp**, không phải trích
> xuất CSS thật → sai số nhỏ có thể có; tinh chỉnh khi đối chiếu trực tiếp.

---

## 1. Chủ đề thị giác & không khí

Đây là **giao diện vận hành dày dữ liệu (operational dashboard)**, không phải trang tiếp thị.
Toàn bộ ngôn ngữ thiết kế phục vụ một mục tiêu: **người bán liếc 3 giây là biết hôm nay phải
làm gì**. Thanh lệnh đen tuyền chạy hết chiều ngang tạo điểm neo thương hiệu mạnh; toàn bộ
vùng làm việc bên dưới là nền xám rất nhạt với các thẻ trắng, khiến **con số trở thành nhân
vật chính**. Màu hành động (teal) được dùng cực kỳ tiết chế — chỉ cho nút chính và điều hướng
đang chọn — nên bất kỳ chỗ nào có teal, mắt lập tức hiểu "bấm được". Cặp màu chữ ký của
TikTok (cyan/magenta) chỉ xuất hiện dưới dạng **hình thoi trang trí** trong dải hero, tuyệt
đối không dùng cho nút hay điều khiển.

Trạng thái được truyền tải bằng **hệ màu ngữ nghĩa nhất quán**: đỏ = việc gấp, xanh lá = khoẻ
mạnh, hổ phách = cảnh báo. Bảng dữ liệu là cấu trúc chủ đạo, mỗi ô có thể nhiều dòng (tên +
mã, trạng thái + hạn chót) để nén thông tin mà vẫn đọc được.

**Đặc trưng cốt lõi**
- Thanh lệnh đen full-bleed cố định trên cùng, cao 56px
- Rail điều hướng trái nhóm theo cụm, ngăn bằng đường kẻ mảnh
- Một màu hành động duy nhất (teal) — kỷ luật tuyệt đối
- Thẻ "gợi ý/khuyến nghị" nền bạc hà nhạt, tách biệt rõ với thẻ dữ liệu trắng
- Ô số liệu dạng: nhãn nhỏ → số lớn → biến động có mũi tên màu
- Bảng dữ liệu nhiều dòng/ô, có ảnh thu nhỏ, PII khách **luôn che một phần**
- Thanh tab kèm số đếm theo trạng thái quy trình
- Chấm/nhãn trạng thái luôn đi **kèm chữ**, không bao giờ chỉ dùng màu
- Bo góc vừa phải (8–12px), bóng đổ gần như không có — dùng viền thay bóng
- Chữ Việt: line-height rộng (≥1.4) để dấu không dính

---

## 2. Bảng màu & vai trò

### Thương hiệu / Nền tảng
- **Ink** (`#000000`): nền thanh lệnh trên cùng, dải hero trang chủ. Màu neo thương hiệu.
- **Ink Text** (`#161823`): màu chữ chính — tiêu đề trang, tên sản phẩm, mã đơn, số liệu.
- **TikTok Cyan** (`#25F4EE`): **CHỈ trang trí** — hình thoi trong dải hero.
- **TikTok Magenta** (`#FE2C55`): **CHỈ trang trí** + huy hiệu số thông báo trên chuông.

### Hành động (dùng cực tiết chế)
- **Action Teal** (`#0FA3A3`): nút chính ("Thêm sản phẩm"), icon mục điều hướng đang mở,
  icon loa thông báo, link trợ giúp. Đây là **màu "bấm được" duy nhất**.
- **Teal Hover** (`#0B8585`): trạng thái di chuột của nút chính.
- **Teal Pressed** (`#087272`): trạng thái đang nhấn.
- **Teal Tint** (`#E8F6F6`): nền thẻ gợi ý / khuyến nghị / quảng bá.
- **Teal Tint Strong** (`#D6EFEF`): hover trên thẻ nền bạc hà.

### Trung tính
- **White** (`#FFFFFF`): bề mặt thẻ, bảng, form — nền chủ đạo của vùng nội dung.
- **Canvas** (`#F5F6F7`): nền ứng dụng phía sau các thẻ.
- **Surface Hover** (`#F7F8F9`): hover hàng bảng, nút phụ, mục điều hướng.
- **Nav Active** (`#F0F3F3`): nền mục điều hướng đang chọn (xám ngả teal).
- **Divider** (`#F0F1F2`): kẻ giữa hàng bảng, giữa cụm điều hướng.
- **Border** (`#E4E6E8`): viền input, nút phụ, đáy thanh tab.
- **Border Strong** (`#D0D3D6`): viền khi hover input/nút phụ.
- **Text Secondary** (`#6B6F76`): nhãn ô số liệu, tiêu đề cột bảng, mô tả phụ, timestamp.
- **Text Tertiary** (`#9EA1A8`): placeholder, mã ID, số đếm bằng 0, icon sắp xếp.
- **Field on Black** (`#2A2B32`): nền ô tìm kiếm & nút phụ **nằm trong** thanh lệnh đen.

### Ngữ nghĩa / Trạng thái
- **Danger** (`#E8302F`): việc gấp ("Gấp: 1", "Hết hàng: 1"), biến động giảm, đơn đã huỷ.
- **Danger Tint** (`#FFF1F0`): nền chip cảnh báo hạn chót trong ô bảng.
- **Success** (`#00B578`): biến động tăng, chấm "Trên kệ", xác nhận thành công.
- **Success Tint** (`#E8F8F2`): nền nhãn trạng thái tích cực.
- **Warning** (`#FF8F1F`): số vi phạm, cảnh báo cần chú ý.
- **Warning Tint** (`#FFF7E8`): nền dải cảnh báo.
- **Info Link** (`#1668DC`): link văn bản trong thẻ gợi ý ("Nhận phần thưởng…").

> **Tổng 22 token.** Không được sinh thêm màu ngoài danh sách này.

---

## 3. Quy tắc chữ

### Font
**Chính:** `"Be Vietnam Pro", "TikTok Sans", Inter, -apple-system, BlinkMacSystemFont,
"Segoe UI", Roboto, sans-serif`

> Dự án đã tự host **Be Vietnam Pro** (woff2, `font-src 'self'`) — dùng luôn, không tải font
> ngoài (CSP chặn). Be Vietnam Pro có bộ dấu tiếng Việt đầy đủ, hợp giao diện dày dữ liệu.

### Thang bậc

| Vai trò | Size | Weight | Line-height | Dùng cho |
|---|---|---|---|---|
| Page Title | 28px | 700 | 36px | "Quản lý đơn hàng", "Quản lý sản phẩm" |
| Section Title | 20px | 600 | 28px | "Xem lại hiệu suất cửa hàng của bạn", "Đề xuất cho bạn" |
| Card Title | 16px | 600 | 24px | "Tình trạng cửa hàng", tiêu đề thẻ quảng bá |
| Metric XL | 28px | 600 | 36px | GMV, doanh số lớn |
| Metric L | 24px | 600 | 32px | ô số liệu ("1", "0", "431") |
| Metric Highlight | 22px | 700 | 30px | "4 vi phạm mới" (màu cảnh báo) |
| Body Strong | 14px | 600 | 22px | tên sản phẩm, mã đơn, ô chính của bảng |
| Body | 14px | 400 | 22px | mô tả, nội dung thường |
| Nav Item | 14px | 400 | 20px | mục sidebar (600 khi đang chọn) |
| Tab | 14px | 500 | 20px | tab trạng thái (600 khi đang chọn) |
| Button | 14px | 500 | 20px | chữ trên nút |
| Table Header | 13px | 500 | 18px | tiêu đề cột (màu Text Secondary) |
| Meta | 13px | 400 | 20px | nhãn ô số liệu, "Đã hoàn thành", số kết quả |
| Caption | 12px | 400 | 18px | mã ID, timestamp, "Lượt xem: 967" |
| Badge | 11px | 600 | 16px | số trên chuông thông báo |

### Nguyên tắc
- **Số luôn `font-variant-numeric: tabular-nums`** — tiền, số lượng, mã đơn, phần trăm.
  Cột số căn phải; không bao giờ để số nhảy cột khi cập nhật.
- **Letter-spacing = 0** ở mọi cấp. Không giãn chữ trong giao diện vận hành.
- **Line-height ≥ 1.4 lần** cỡ chữ cho mọi văn bản có dấu tiếng Việt (dấu mũ/nặng cần chỗ thở).
- **Chỉ 3 mức đậm**: 400 (thường) · 500 (nhãn, nút, tab) · 600–700 (tiêu đề, số liệu).
- **Không dùng chữ < 12px.** Mã ID dài dùng 12px + màu Text Tertiary, không nhỏ hơn.
- Tiêu đề trang **không viết hoa toàn bộ** — tiếng Việt có dấu, viết hoa toàn bộ khó đọc.

---

## 4. Đặc tả thành phần

### 4.1 Thanh lệnh trên cùng (Command Bar)
- Nền `#000000`, cao `56px`, `position: sticky; top: 0; z-index: 100`, tràn hết chiều ngang
- Logo cao `28px`; tiêu đề nền tảng `18px/600`, màu `#FFFFFF`
- **Ô tìm kiếm:** nền `#2A2B32`, cao `36px`, bo `8px`, rộng `360–420px`, padding `0 12px`,
  icon kính lúp `16px` màu `#9EA1A8`, placeholder `14px #9EA1A8`,
  gợi ý phím tắt `Ctrl+K` căn phải `12px #9EA1A8`
  - Focus: viền `1px #0FA3A3`, nền `#33343C`
- **Nút icon:** `40×40px`, bo `8px`, icon `20px #FFFFFF`, hover nền `rgba(255,255,255,.08)`
- **Huy hiệu thông báo:** nền `#FE2C55`, chữ `11px/600 #FFFFFF`, min `16px`, bo `999px`,
  padding `0 5px`, đặt lệch góc trên-phải icon `-4px`
- **Đường ngăn dọc:** `1px`, cao `20px`, `rgba(255,255,255,.20)`
- **Nút chuyển cửa hàng:** nền `#FFFFFF`, cao `40px`, bo `999px`, padding `4px 16px 4px 4px`,
  avatar tròn `30px`, tên shop `14px/500 #161823`, hover nền `#F0F1F2`

### 4.2 Rail điều hướng trái (Sidebar)
- Rộng `240px`, nền `#FFFFFF`, viền phải `1px #F0F1F2`, cố định, cuộn độc lập
- **Mục cấp 1:** cao `40px`, padding `0 12px`, bo `8px`, khoảng cách icon–chữ `12px`
  - Icon `20px`; mặc định `#161823`, **đang chọn `#0FA3A3`**
  - Chữ `14px/400`; đang chọn `600`
  - Đang chọn: nền `#F0F3F3` · Hover: nền `#F7F8F9`
- **Mục cấp 2 (menu con):** padding-left `48px`, không icon, cao `36px`, chữ `14px`
  - Đang chọn: nền `#F0F3F3`, chữ `#161823/600`
- **Ngăn cụm:** đường `1px #F0F1F2`, margin `8px 12px`
- Mục cha khi có menu con đang mở: icon chuyển teal, chữ giữ `#161823`

### 4.3 Đầu trang (Page Header)
- Tiêu đề `28px/700 #161823`
- Link trợ giúp kề tiêu đề: icon bóng đèn `16px` + chữ `14px/500 #0FA3A3`, cách `12px`
- Cụm nút hành động căn phải, khoảng cách `8px`
- Khoảng cách đầu trang → nội dung: `20px`

### 4.4 Nút
**Nút chính (teal đặc)**
- Nền `#0FA3A3` · chữ `#FFFFFF` · cao `36px` · padding `0 16px` · bo `8px` · `14px/500`
- Hover `#0B8585` · Active `#087272` · Vô hiệu: nền `#E4E6E8`, chữ `#9EA1A8`, `cursor: not-allowed`
- **Biến thể nút tách (split):** phần chính + đoạn mũi tên rộng `32px`,
  ngăn bằng `1px rgba(255,255,255,.24)`

**Nút phụ (viền)**
- Nền `#FFFFFF` · chữ `#161823` · viền `1px #E4E6E8` · cao `36px` · bo `8px` · `14px/500`
- Hover: nền `#F7F8F9`, viền `#D0D3D6`

**Nút icon đơn**
- `36×36px` · bo `8px` · nền trong suốt · icon `18px #161823` · hover nền `#F7F8F9`

**Nút văn bản (link hành động)**
- Chữ `14px/500 #0FA3A3`, không nền không viền, hover gạch chân

### 4.5 Ô số liệu (Metric Tile)
Hàng ngang 5–6 ô chia đều trong một thẻ trắng, padding thẻ `20px 24px`, ngăn nhau bằng
khoảng cách `24px` (hoặc đường dọc `1px #F0F1F2`).
- **Nhãn:** `13px/400 #6B6F76` + dấu `›` cuối nhãn báo hiệu bấm được (cả ô là link)
- **Giá trị:** `24px/600 #161823`, tabular-nums
- **Dòng phụ — 2 kiểu:**
  - Trung tính: `12px #9EA1A8` ("Đã hoàn thành")
  - Cảnh báo: icon `14px` + chữ `12px/500 #E8302F` ("Gấp: 1", "Hết hàng: 1")
- Hover cả ô: nhãn chuyển `#161823`

### 4.6 Ô số liệu có biến động (Trend Metric)
- Nhãn `13px #6B6F76` + `›`
- Giá trị `28px/600 #161823`, tabular-nums
- Biến động: mũi tên `12px` + số `13px/500`
  - Giảm → `#E8302F` (▼) · Tăng → `#00B578` (▲)
- Cụm 4 ô chia đều; header thẻ có bộ chọn kỳ ("7 ngày qua ⌄") + timestamp cập nhật
  `12px #9EA1A8` căn phải + nút sửa icon `16px`

### 4.7 Bảng dữ liệu
- **Header:** cao `44px`, chữ `13px/500 #6B6F76`, viền đáy `1px #E4E6E8`,
  cột sắp xếp có icon `⇅ 12px #9EA1A8` (chuyển `#161823` khi đang sắp)
- **Hàng:** cao tối thiểu `88px` (ô nhiều dòng), viền đáy `1px #F0F1F2`, hover nền `#FAFBFB`
- **Ô:** padding `16px 12px`, `vertical-align: top`
- **Checkbox:** `16px`, bo `4px`, viền `1.5px #C4C7CC`; chọn → nền `#0FA3A3`, dấu tick trắng
- **Ô chính 2 dòng:** dòng 1 `14px/600 #161823` · dòng 2 `12px #6B6F76` (thời gian, mã ID)
- **Ảnh thu nhỏ:** đơn hàng `40px` · sản phẩm `56px`; bo `4px`, viền `1px #F0F1F2`,
  `object-fit: cover`
- **PII khách hàng:** luôn che — hiện ký tự đầu + `*` + ký tự cuối (`g*********0`)
- **Nhãn trạng thái:** chấm tròn `6px` + chữ `14px` (VD ● xanh + "Trên kệ")
- **Chip cảnh báo trong ô:** nền `#FFF1F0`, chữ `12px #E8302F`, padding `6px 10px`, bo `4px`,
  rộng tối đa `220px`, tự xuống dòng
- **Cột số/tiền:** căn phải, tabular-nums
- **Cột hành động:** nút icon `32×32px`, hiện mờ và rõ dần khi hover hàng

### 4.8 Thanh tab trạng thái
- Cao `48px`, khoảng cách `24px`, viền đáy `1px #E4E6E8`
- Mục: `14px/500 #6B6F76`, padding đáy `14px`
- **Đang chọn:** chữ `#161823/600`, gạch dưới `2px #161823` (đen, KHÔNG teal)
- **Số đếm kèm:** cách chữ `4px`; khác 0 → `#0FA3A3`, bằng 0 → `#9EA1A8`
- Hover: chữ `#161823`

### 4.9 Thanh lọc
- Mọi điều khiển cao `36px`, khoảng cách `8px`
- **Ô tìm kiếm:** rộng `240–320px`, bo `8px`, viền `1px #E4E6E8`, icon trái `16px`,
  placeholder `14px #9EA1A8`; focus viền `#0FA3A3` + quầng `0 0 0 3px rgba(15,163,163,.12)`
- **Dropdown:** bo `8px`, viền `1px #E4E6E8`, mũi tên `16px` phải; khi đã chọn có nút `×` xoá
- **Nút lọc:** icon phễu + chữ; đang áp bộ lọc → hiện `(1)` và viền `#0FA3A3`
- **Nút đặt lại:** icon xoay `32×32px`
- **Số kết quả:** `13px #6B6F76` ("Tìm thấy 431 đơn hàng")
- Cụm nút phải: "Sắp xếp theo" · "Xuất" · `⋯` — đều là nút phụ

### 4.10 Thẻ (Card)
- Nền `#FFFFFF`, bo `12px`, padding `20px 24px`, **không bóng** (hoặc `0 1px 2px rgba(0,0,0,.04)`)
- Khoảng cách giữa các thẻ: `16px`
- Tiêu đề thẻ `16px/600` + mô tả `13px #6B6F76`, cách tiêu đề `4px`

### 4.11 Thẻ gợi ý (nền bạc hà)
- Thẻ bọc trắng chứa tiêu đề "Đề xuất cho bạn" + hàng thẻ con cuộn ngang
- **Thẻ con:** nền `#E8F6F6`, bo `8px`, padding `16px 20px`, rộng tối thiểu `260px`,
  khoảng cách `16px`
  - Tiêu đề `15px/600 #161823`
  - Mô tả `13px #6B6F76`, cắt 2 dòng (`-webkit-line-clamp: 2`)
  - Link hành động `13px/500 #1668DC` (hoặc `#0FA3A3`) + `›`
  - Hover thẻ: nền `#D6EFEF`

### 4.12 Thẻ quảng bá (Promo Banner)
- Nền gradient bạc hà `linear-gradient(100deg, #E3F5F7, #EAF8F6)`, bo `12px`,
  padding `24px 28px`, `overflow: hidden`
- Icon đặc trưng: khối tròn `44px` nền `#FFFFFF`, icon `20px #161823`
- Tiêu đề `18px/600` · mô tả `14px #5C5F6B` · CTA = nút phụ
- Minh hoạ đặt tuyệt đối bên phải, bị cắt bởi mép thẻ; **ẩn dưới 1024px**

### 4.13 Thẻ tình trạng cửa hàng
- Thẻ trắng, tiêu đề có icon khiên `20px #0FA3A3` + chữ `16px/600`
- Số nổi bật `22px/700 #FF8F1F` ("4 vi phạm mới")
- Mô tả `13px #6B6F76`, cắt 2 dòng

### 4.14 Dải thông báo (Announcement)
- Hàng ngang, không nền: icon loa `16px #0FA3A3` + chữ `14px #161823`
  + link "Tìm hiểu thêm" `14px/500 #161823` gạch chân
- Margin `12px 0`; chữ dài cắt bằng `…`

### 4.15 Dải hero (chỉ Trang chủ)
- Nền `#000000`, cao `~150px`, tràn hết chiều ngang vùng nội dung
- **Hình thoi trang trí:** khối vuông xoay `45°`, cạnh `16–48px`,
  màu `#25F4EE` / `#FE2C55` / `#7DD8F5`, rải tuyệt đối 2 bên, `pointer-events: none`
- Nêm chéo sáng bên phải (`clip-path` tam giác, `#F5F6F7`)
- Nội dung: chữ trắng `15px` + nút pill nền `#2A2B32`, bo `999px`, chữ trắng `14px`
- **Thẻ nội dung đầu tiên đè lên đáy dải:** `margin-top: -60px; position: relative; z-index: 1`

---

## 5. Nguyên tắc bố cục

### Thang khoảng cách
**Đơn vị gốc:** `4px`

| Bậc | Dùng cho |
|---|---|
| `4px` | khe icon–nhãn, lệch huy hiệu |
| `8px` | khoảng cách giữa các nút, padding dọc chip |
| `12px` | padding ngang ô bảng, khe icon–chữ điều hướng |
| `16px` | khoảng cách giữa thẻ, padding thẻ con, padding dọc ô bảng |
| `20px` | padding dọc thẻ, đầu trang → nội dung |
| `24px` | padding ngang thẻ, khoảng cách cụm số liệu, khe tab |
| `32px` | padding ngang vùng nội dung, ngăn khối lớn |
| `40px` | ngăn giữa các khu vực lớn trên trang chủ |

### Khung ứng dụng
- **Kiểu shell cố định:** thanh lệnh `56px` trên + sidebar `240px` trái + vùng nội dung co giãn
- Vùng nội dung: nền `#F5F6F7`, padding `24px 32px`, **chiều rộng linh hoạt**
  (dashboard không giới hạn cứng; nếu cần đặt trần thì `1600px` căn giữa)
- Cuộn: chỉ vùng nội dung cuộn; thanh lệnh và sidebar cố định

### Lưới
- **Hàng ô số liệu:** flex chia đều 5–6 cột, khoảng cách `24px`
- **Trang chủ:** lưới 2 cột `2fr 1fr` (thẻ hiệu suất | thẻ tình trạng), khoảng cách `16px`
- **Thẻ gợi ý:** cuộn ngang, thẻ con rộng tối thiểu `260px`
- **Bảng:** rộng 100%, cột co theo nội dung; cột số cố định độ rộng

### Thang bo góc
| Giá trị | Dùng cho |
|---|---|
| `4px` | checkbox, ảnh thu nhỏ, chip cảnh báo trong ô |
| `8px` | nút, input, dropdown, thẻ con, mục điều hướng |
| `12px` | thẻ chính, thẻ quảng bá |
| `999px` | pill chuyển cửa hàng, huy hiệu số, nút trong dải đen |
| `50%` | avatar, khối tròn chứa icon |

### Triết lý khoảng trắng
Đây là giao diện **nén thông tin có kiểm soát**, ngược hẳn trang bán hàng. Khoảng trắng
không dùng để "thở cho đẹp" mà để **phân nhóm**: `16px` giữa các thẻ nói "cùng một khu vực",
`40px` nói "chuyển chủ đề". Bên trong thẻ, padding `20–24px` giữ cho số liệu không dính mép.
Hàng bảng cao `88px` vì mỗi ô mang 2 dòng — đừng nén xuống dưới `72px`, chữ có dấu sẽ dính.

---

## 6. Độ sâu & lớp

| Mức | Giá trị | Dùng cho |
|---|---|---|
| Phẳng | `none` | hàng bảng, mục điều hướng, input, nút — **mặc định** |
| Nhẹ | `0 1px 2px rgba(0,0,0,.04)` | thẻ trên nền canvas |
| Nổi | `0 4px 12px rgba(0,0,0,.08)` | dropdown, popover, tooltip, menu `⋯` |
| Cao | `0 8px 32px rgba(0,0,0,.12)` | hộp thoại, drawer bên phải |
| Dính | `0 1px 0 rgba(0,0,0,.06)` | thanh lệnh khi trang đã cuộn |

**Triết lý bóng đổ:** giao diện vận hành dùng **viền thay bóng**. Bóng chỉ xuất hiện khi có
lớp thật sự nổi lên trên mặt phẳng (menu, hộp thoại). Thẻ dữ liệu nằm phẳng trên canvas —
sự tách biệt đến từ tương phản nền trắng/xám, không từ đổ bóng. Không bao giờ đổ bóng lên
hàng bảng: hàng chục hàng cùng đổ bóng sẽ tạo nhiễu thị giác nghiêm trọng.

---

## 7. Nên & Không nên

### Nên
- **Giữ teal chỉ cho hành động.** Mỗi lần dùng teal phải trả lời được: "bấm vào đây làm gì?"
- **Luôn `tabular-nums` cho số** — tiền, số lượng, phần trăm, mã đơn. Cột số căn phải.
- **Che PII khách hàng** ở mọi bảng: `g*********0`, `n*******5`. Không bao giờ hiện đủ.
- **Ghép màu trạng thái với chữ hoặc icon** — người mù màu vẫn phải đọc được ("● Trên kệ").
- **Số đếm trên tab** giúp người bán biết chỗ nào có việc mà không cần bấm vào.
- **Việc gấp phải nổi bật**: dùng Danger + icon + câu hành động cụ thể có hạn chót
  ("Sắp xếp vận chuyển chậm nhất là 19:00"), không chỉ ghi "Trễ".
- **Ô số liệu là link** — bấm vào con số phải nhảy tới danh sách đã lọc sẵn tương ứng.
- **Dùng viền `#E4E6E8` để phân tách**, giữ giao diện phẳng và nhẹ.
- **Cắt chữ dài bằng `…` kèm `title`** để không vỡ bố cục bảng.
- **Nhóm điều hướng theo luồng công việc** (Đơn hàng → Sản phẩm → Kho vận), ngăn bằng kẻ mảnh.

### Không nên
- **Không dùng TikTok Cyan/Magenta cho nút, link hay điều khiển** — chỉ trang trí dải hero.
- **Không thêm màu ngoài 22 token.** Mọi trạng thái mới phải ánh xạ vào màu ngữ nghĩa có sẵn.
- **Không dùng teal cho văn bản dài hay nền lớn** — teal mất nghĩa "bấm được".
- **Không đổ bóng lên hàng bảng, mục điều hướng, hay thẻ phẳng.**
- **Không để chiều cao hàng bảng < 72px** khi ô có 2 dòng chữ Việt.
- **Không dùng chỉ màu để báo trạng thái** (chấm xanh trần không kèm chữ).
- **Không căn giữa dữ liệu bảng** — chữ căn trái, số căn phải, luôn luôn.
- **Không bo góc > 12px cho thẻ** — giao diện vận hành cần hình khối dứt khoát.
- **Không viết hoa toàn bộ tiêu đề tiếng Việt.**
- **Không để tương phản dưới chuẩn**: chữ thường ≥ 4.5:1, thành phần giao diện ≥ 3:1.
  `#9EA1A8` **chỉ** cho placeholder/metadata, không dùng cho nội dung quan trọng.
- **Không nhồi > 7 cột** vào bảng ở desktop — gộp thành ô nhiều dòng thay vì thêm cột.

---

## 8. Hành vi responsive

### Điểm ngắt

| Điểm ngắt | Rộng | Thay đổi chính |
|---|---|---|
| Mobile | `320–767px` | Sidebar → drawer trượt (ẩn hoàn toàn); bảng → **danh sách thẻ**; ô số liệu 2 cột; nút chính rộng 100%; padding `16px`; tiêu đề trang `22px`; ô tìm kiếm trên thanh lệnh thu thành icon |
| Tablet | `768–1023px` | Sidebar → rail chỉ icon `64px` (chữ hiện khi hover); ô số liệu 3 cột; bảng cuộn ngang; padding `20px 24px`; ẩn minh hoạ thẻ quảng bá |
| Desktop | `1024–1439px` | Sidebar đầy đủ `240px`; ô số liệu 5–6 cột; bảng hiện đủ cột; padding `24px 32px` |
| Large | `1440px+` | Như desktop, mở rộng vùng nội dung; lưới trang chủ `2fr 1fr`; cột thưa hơn |

### Vùng chạm
- **Tối thiểu `44×44px`** cho mọi thứ bấm được trên cảm ứng
- Nút cao `36px` trên desktop → **`44px` trên mobile**
- Mục điều hướng cao `40px` → `48px` trên mobile
- Nút icon trong bảng `32px` → `44px` trên mobile
- Khoảng cách tối thiểu giữa 2 vùng chạm: `8px`

### Chiến lược thu gọn
- **Bảng → thẻ (mobile):** mỗi hàng thành một thẻ; nhãn cột hiện thành nhãn trong thẻ;
  cột quan trọng nhất (mã đơn / tên SP + ảnh) lên đầu; tổng tiền + trạng thái nổi bật;
  hành động gom vào menu `⋯`
- **Sidebar:** `240px` → rail icon `64px` (tablet) → drawer overlay có nền mờ (mobile)
- **Ô số liệu:** 6 cột → 3 → 2, `flex-wrap: wrap`, mỗi ô rộng tối thiểu `140px`
- **Tab:** cuộn ngang (`overflow-x: auto`), ẩn thanh cuộn, giữ tab đang chọn trong tầm nhìn
- **Thanh lọc:** xếp dọc trên mobile, ô tìm kiếm rộng 100%
- **Thanh lệnh:** ẩn tiêu đề nền tảng < 900px; ô tìm kiếm thành nút icon < 768px;
  chỉ giữ logo + tìm kiếm + chuông + shop
- **Thẻ gợi ý:** cuộn ngang ở mọi cỡ màn hình, hiện hé thẻ kế tiếp để gợi ý cuộn

---

## 9. Hướng dẫn cho AI agent

### Tra màu nhanh
- **Nút chính / icon đang chọn / link trợ giúp** → Action Teal `#0FA3A3`
- **Nút phụ** → nền `#FFFFFF`, viền `1px #E4E6E8`, chữ `#161823`
- **Thanh lệnh trên cùng** → `#000000`; ô tìm kiếm trong đó → `#2A2B32`
- **Nền ứng dụng** → `#F5F6F7`; **bề mặt thẻ** → `#FFFFFF`
- **Chữ chính** → `#161823`; **chữ phụ** → `#6B6F76`; **placeholder/ID** → `#9EA1A8`
- **Viền** → `#E4E6E8`; **kẻ hàng bảng** → `#F0F1F2`; **nền mục đang chọn** → `#F0F3F3`
- **Việc gấp / giảm / huỷ** → `#E8302F`, nền chip `#FFF1F0`
- **Khoẻ mạnh / tăng / đang bán** → `#00B578`
- **Vi phạm / cần chú ý** → `#FF8F1F`
- **Thẻ gợi ý** → nền `#E8F6F6`, link `#1668DC`
- **Trang trí hero (CHỈ hero)** → `#25F4EE`, `#FE2C55`

### 10 quy tắc bắt buộc
1. **Teal `#0FA3A3` chỉ cho hành động** — nút chính, icon điều hướng đang chọn, link trợ
   giúp. Mọi nút khác là nút phụ nền trắng viền `#E4E6E8`. Không bao giờ dùng teal làm nền
   lớn hay màu chữ nội dung.

2. **Chữ theo thang cố định:** Page Title 28/700 · Section 20/600 · Card 16/600 ·
   Metric 24–28/600 · Body 14/400 · Meta 13/400 · Caption 12/400. Chỉ 3 mức đậm 400/500/600.
   Line-height ≥ 1.4× vì chữ Việt có dấu.

3. **Khoảng cách theo bậc `4/8/12/16/20/24/32/40`.** Padding thẻ `20px 24px`; khoảng cách
   giữa thẻ `16px`; padding vùng nội dung `24px 32px`; ô bảng `16px 12px`.

4. **Điều khiển cao `36px`, bo `8px`** (nút, input, dropdown). Thẻ bo `12px`. Checkbox và
   ảnh thu nhỏ bo `4px`. Pill và huy hiệu bo `999px`.

5. **Mọi con số dùng `tabular-nums`**, cột số căn phải. Tiền định dạng `vi-VN` kèm `đ`
   (`1.346.800đ`). Phần trăm biến động luôn kèm mũi tên ▲/▼ và màu ngữ nghĩa.

6. **Bảng:** header `44px` chữ `13px/500 #6B6F76`; hàng tối thiểu `88px`; kẻ `1px #F0F1F2`;
   hover `#FAFBFB`; ô chính 2 dòng (`14px/600` + `12px #6B6F76`); PII luôn che;
   **không đổ bóng lên hàng**.

7. **Trạng thái luôn là màu + chữ (+ icon)**, không bao giờ chỉ màu. Chấm `6px` + nhãn chữ.
   Việc gấp dùng chip nền `#FFF1F0` chữ `#E8302F` kèm hạn chót cụ thể.

8. **Tab đang chọn gạch dưới `2px #161823` (đen)**, chữ `600`; số đếm khác 0 màu teal,
   bằng 0 màu `#9EA1A8`. Tab là trạng thái quy trình, không phải điều hướng trang.

9. **Bóng đổ chỉ cho lớp nổi thật sự:** dropdown `0 4px 12px rgba(0,0,0,.08)`,
   hộp thoại `0 8px 32px rgba(0,0,0,.12)`. Thẻ phẳng hoặc `0 1px 2px rgba(0,0,0,.04)`.
   Dùng viền thay bóng ở mọi chỗ khác.

10. **Responsive:** sidebar `240px` → rail icon `64px` (<1024px) → drawer (<768px);
    **bảng chuyển thành danh sách thẻ trên mobile**, không cuộn ngang;
    ô số liệu 6→3→2 cột; vùng chạm ≥ `44px` trên cảm ứng.

### Khuôn màn hình mẫu
- **Trang tổng quan:** dải hero đen (trang trí hình thoi) → thẻ ô số liệu **đè lên** dải
  (`margin-top:-60px`) → tiêu đề khu vực → lưới `2fr 1fr` (thẻ hiệu suất có bộ chọn kỳ |
  thẻ tình trạng) → thẻ quảng bá nền bạc hà
- **Trang danh sách (đơn/sản phẩm):** tiêu đề + nút hành động → dải thông báo (nếu có) →
  thẻ ô số liệu tóm tắt → thanh tab trạng thái có số đếm → thanh lọc → bảng dữ liệu → phân trang
- **Trang danh sách có gợi ý:** chèn thẻ "Đề xuất cho bạn" (thẻ con nền bạc hà, cuộn ngang)
  giữa tab cấp trang và tab trạng thái

---

## 10. Ánh xạ sang dự án

| Khái niệm trong tài liệu | Nơi hiện thực |
|---|---|
| Thanh lệnh + sidebar + khung shell | `apps/seller-admin/src/pages.js` → hàm `layout()` |
| Token màu | biến CSS `:root` trong `pages.js` (`--pri`, `--ink`, `--bd`…) |
| Ô số liệu, thẻ, bảng | các hàm render trang trong `pages.js` |
| Font | Be Vietnam Pro đã tự host — **không** tải font ngoài (CSP `font-src 'self'`) |

**Lưu ý quan trọng khi hiện thực:**
- Seller-admin **được phép dùng JavaScript** (khác storefront) — nhưng vẫn nên ưu tiên
  no-JS cho các tương tác cơ bản (tab, lọc, phân trang bằng link/form GET) để giữ tốc độ
  và độ bền.
- Hệ này **độc lập** với hệ MAISON của storefront. Đừng dùng chung token: shop có thể đổi
  màu storefront tuỳ ý, còn bảng điều khiển phải **luôn cùng một bộ nhận diện** cho mọi shop.
- Màu trong tài liệu là **ước lượng từ ảnh chụp**. Khi có điều kiện đối chiếu trực tiếp
  (đọc CSS thật của trang tham chiếu), cập nhật lại phần §2 và giữ nguyên cấu trúc.
