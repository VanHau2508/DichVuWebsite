# Báo cáo & bộ lọc — ba lỗ của cụm "xuất dữ liệu"

Đợt 4, mục G · H · I (docs/57). Chín trên chín lăng kính phản biện xác nhận. Cả ba cùng một
họ: **một khái niệm của người dùng được cài ở nhiều nơi, rồi các bản cài trôi khỏi nhau.**

## Luật 1 — ĐIỂM THƯỞNG phải trừ khỏi doanh thu

`reports.js` tính `revenue_goods = subtotal − discount`, bỏ qua `points_discount_vnd`. Checkout
thì ghi `total = subtotal − discount − points_discount + shipping`. Nên doanh thu, lãi gộp và
lãi vận hành cùng phồng lên **đúng bằng số điểm khách đổi**, tháng nào chạy chương trình điểm
mạnh thì báo cáo càng đẹp một cách giả tạo — và **không bao giờ tự triệt tiêu**, luôn lệch theo
chiều báo lãi cao hơn thật.

**Đây không phải quyết định cố ý.** Ba bằng chứng độc lập:

1. `docs/37` chốt "doanh thu hàng = subtotal − discount" và **không nhắc điểm thưởng lần nào** —
   công thức viết ra *trước* khi tính năng điểm tồn tại (0086), rồi chưa từng sửa lại.
2. `docs/41` (thiết kế điểm thưởng) **đã chốt quy tắc ngược lại**: *"chi phí điểm ghi tại REDEEM
   giảm doanh thu"*. Bản thiết kế nói phải trừ; báo cáo chỉ là chưa cài.
3. Ba nơi khác đụng tiền **đã trừ đúng**: `total` của checkout, `reconcileEditLines` khi sửa đơn,
   và sổ tích điểm của worker (`GREATEST(subtotal − discount − points_discount, 0)`).

Bằng chứng mạnh nhất nằm trong **chính bộ e2e**: nó đã chốt bất biến chéo màn

```
stats.revenue = Σ total_vnd − Σ refunds  ==  (revenue_goods + shipping) − refunds
```

Đẳng thức này **chỉ đúng khi `points_discount = 0`**, vì `total_vnd` đã trừ điểm còn vế phải thì
chưa. Lỗ sống sót được vì fixture **chưa từng có đơn đổi điểm** — thêm đúng một đơn như thế là
khẳng định cũ tự đỏ. (docs/37 quy tắc 7 đòi Tổng quan và Báo cáo dùng cùng quy tắc; nó đang bị
vi phạm trên mọi đơn có đổi điểm.)

Kèm một **dòng memo `points_discount_vnd`** trong P&L và CSV: đã trừ khỏi doanh thu rồi nên
không trừ lần nữa ở bất kỳ phép cộng nào — nó ở đó để chủ shop *thấy* chương trình điểm tốn bao
nhiêu, thay vì cái giá đó biến mất im lặng vào một con số doanh thu thấp hơn.

**ĐỪNG "đồng bộ" với hoa hồng CTV**: docs/51 quy tắc 1 chốt căn cứ hoa hồng = `subtotal −
discount`, **không** trừ điểm. Đó là đại lượng khác (tiền hàng làm căn cứ thưởng), cố ý.

## Luật 2 — bộ lọc phải sống sót MỌI đường rời trang

`buildOrderFilter` đọc 6 trường (`q, from, to, source, payment, status`). Danh sách đó bị chép
tay ở **năm** nơi khác, và `payment` thiếu ở **cả năm**:

| Nơi | Người bán làm gì | Hậu quả khi rơi |
|---|---|---|
| form "Lọc" | bấm Lọc | nhìn nhầm tập đơn |
| `keep` (tab trạng thái) | đổi tab | nhìn nhầm tập đơn |
| `nav()` (phân trang) | sang trang 2 | nhìn nhầm tập đơn |
| hidden nút "Xuất CSV" | bấm xuất | **xuất PII của MỌI đơn** |
| `ordersExportFields` (BFF) | — | BFF nuốt nốt, dù hidden có gửi |

Đường vào mặc định của `payment` là ô **"Đơn chưa thu tiền"** trên Tổng quan, nên đây là thao
tác thường ngày, không phải ca hiếm. Bản CSV chứa **tên, SĐT, địa chỉ** khách: rơi bộ lọc là
phát tán PII vượt xa phạm vi người bán định lấy, và với shop lớn còn đâm vào trần
`EXPORT_ORDERS_MAX_ROWS` → 413, tức không xuất được gì.

Khoá lại bằng `apps/seller/test/order-filter-fields.test.js`: đối chiếu **bốn nơi khai báo** với
danh sách thật của `buildOrderFilter`. Bắt được chỗ **thứ sáu** ngay khi ai đó thêm trường lọc
mới. E2E không thay được: link phân trang chỉ render khi có >20 đơn (`limit` đóng cứng 20 ở BFF).

## Luật 3 — MỘT quy tắc biên ngày cho toàn hệ

DB chạy UTC, nên `created_at >= '2026-07-15'::date` cắt tại 0h UTC = **7 giờ sáng giờ VN**. Mọi
đơn đặt trong khung 00:00–07:00 — **đúng khung săn sale 0h** — bị đẩy sang ngày hôm trước.

Ba nơi lọc theo khoảng ngày, hai học thuyết:

- `reports.js` — `AT TIME ZONE` (đúng)
- `purchasing.js` — `AT TIME ZONE` (đúng, nhưng là **bản chép tay** của reports.js)
- `orders.js` — `::date` **trần** (sai)

Nên cùng một ô "Từ 15 đến 15", trang Đơn hàng và trang Báo cáo trả về **hai tập đơn khác nhau**,
và bản xuất CSV đơn lệch với bản xuất CSV báo cáo — người bán không có cách nào biết số nào đúng.

Vá bằng `apps/seller/src/date-range.js`: `rangeSql` / `bucketSql` + bản riêng cho cột **DATE
thuần** (`cod_remittances.remitted_at` — ngày dương lịch không có múi giờ để quy đổi; áp
`AT TIME ZONE` lên nó là đẩy phiếu sang ngày khác, tiền nhảy kỳ). Ba file cùng import. Dặn dò
không giữ nổi hai bản đồng bộ; dùng chung một hằng thì giữ **bằng cấu trúc**.

## Bốn bẫy ĐO trong đợt này

1. **Chú thích HTML lọt ra trang và trúng chuỗi test đang grep.** Tôi thêm `<!-- … nút Xuất CSV
   … -->` vào form lọc; một khẳng định khác kiểm *"order_manager KHÔNG thấy nút Xuất CSV"* bằng
   `!/Xuất CSV/.test(body)` → đỏ vì lý do không liên quan. Chú thích để ở **JS**, không phải HTML.
2. **Khẳng định rỗng nghĩa vì thứ cần kiểm không được render.** Link phân trang nằm trong nhánh
   "có đơn"; xin `offset=20` chỉ ra trang rỗng. Không có link nào để khớp → đỏ, mà nếu khớp cũng
   chẳng chứng minh gì. Chuyển sang bất biến mã nguồn.
3. **Dòng tổng kết bị hỏng làm bộ chạy hàng loạt nói dối.** `export.e2e.mjs` in
   `[object Object]22 pass, 0 fail` — biến `B` (mã màu) bị che bởi `const B = await
   makeShopOwner(...)` trong cùng hàm. Bộ chạy dò `^[0-9]+ pass` không khớp → báo **ĐỎ trong khi
   nó xanh**, đúng thứ phá luật "thiếu dòng tổng kết = ĐỎ". Đã sửa.
4. **Cửa sổ dò của bất biến mã nguồn bắt nhầm phạm vi.** Kiểm `keep` đòi có `status` là sai:
   `status` do chính link tab đặt (`?status=${s}`), `keep` chỉ mang phần chung. Một cảnh báo giả
   trong bộ canh-trôi thì lần sau người ta bỏ qua cả bộ.
