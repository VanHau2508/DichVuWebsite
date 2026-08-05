# Vai chủ shop ngày thứ 60

Mọi màn hình đều đẹp ở **ngày 1** vì dữ liệu trống: danh sách 3 dòng không cần tìm kiếm, báo cáo
1 tuần không cần so kỳ, 5 SKU nhìn phát thấy hết. Cái vỡ ở **ngày 60** thì ngày 1 không bao giờ
lộ ra. Đợt này dựng hiện trường thật rồi tự đi lại từng màn.

## Hiện trường

`scripts/seed-day60.sh` → **202 SP · 454 biến thể · 395 đơn trải 60 ngày · 114 khách · 26 đơn
chờ · 15 biến thể hết hàng · 800+ dòng sổ cái**.

Sản phẩm/tồn đi qua **API thật**; đơn ghi thẳng SQL (400 đơn qua checkout thật mất hàng giờ và
đụng trần chống-đơn-ảo) nhưng **giữ đúng bất biến**: tổng = Σ dòng + ship − giảm · mốc thời gian
thuận · đơn đã trả có giao dịch · đơn đã giao có dòng sổ cái xuất kho · `on_hand` = nhập − xuất.

**Tính trung thực của hiện trường là điều kiện tiên quyết.** Tự kiểm 6 bất biến và bắt được **hai
lỗi của chính bộ dựng**: 16 đơn có `delivered_at` sớm hơn `shipped_at` (sinh "gửi sau 20–60 giờ"
và "giao sau 2–6 ngày" — 2 ngày < 60 giờ), và 28 biến thể lệch sổ cái vì bước "làm vài SP hết
hàng" đổi tồn mà quên ghi dòng. Để nguyên thì agent sẽ báo *"sổ cái mâu thuẫn tồn kho"* như một
lỗi sản phẩm và cả đợt đi vá thứ không hỏng.

## Kết quả soi

6 agent đi màn → **36 phát hiện, 24 bị bác bỏ, 12 sống sót**. Lớp phản biện bác cả những cái nghe
rất thuyết phục — ví dụ *"không xếp hạng được hàng bán chạy"*, bị bác vì người báo **bỏ sót hai
màn hình chuyên trách** trả lời đúng câu đó.

### Chỗ chạy tốt (phải nói ra, nếu không báo cáo mất tin cậy)

Tìm tên **không dấu** hoàn hảo · tìm **4 số cuối** chạy · tốc độ **phẳng lì ở mọi độ sâu**
(offset 0 → 54ms, offset 394 → 50ms) · phân trang đúng 20 trang/395 dòng · chịu được đầu vào bậy
· **trang khách hàng là câu trả lời đúng cho việc trực điện thoại** (3 lần bấm ra lịch sử mua) ·
sửa giá biến thể không bị ô giá chung đè lên.

## Chín thứ đã sửa

| Vấn đề | Đo được |
|---|---|
| **Giờ hiển thị là giờ MÁY CHỦ (UTC)** | 54/395 đơn hiện SAI NGÀY; phiếu in cũng sai |
| **Ô tìm chỉ ăn SĐT viết liền** | dán từ Zalo/Facebook → "Không tìm thấy đơn nào" |
| **Không có nén** | 2,58 MB/ngày → 0,67 MB (−68…72% qua edge thật) |
| **Không có giao hàng loạt** | 50 đơn: ~25 phút tay → **1,0 giây** một lần bấm |
| **Cột Tồn cộng gộp** | giấu 14/15 biến thể đã hết |
| Trang Đơn thiếu ô chọn-tất-cả | trang SP vốn đã có |
| Bộ lọc rơi khi bấm tab | tab ghi "26", bấm vào ra 190 |
| Cứng 20 dòng/trang | 26 đơn phải làm hai lượt |
| Hàng loạt xong bị đá về "Tất cả", không báo gì | phải tự nhìn số trên tab để đoán |

### Hai cái đáng nói nhất

**Giờ UTC cãi nhau với chính trang đó.** Đợt 4-I đã vá *biên lọc* sang giờ VN — nên lọc "ngày
01/08" trả về đúng đơn, nhưng cột Thời gian in 31/07. Người bán kết luận bộ lọc hỏng. Tôi vá một
nửa và tưởng xong. Hai hàm `dt` khác **trong cùng file** đã truyền `timeZone` từ đầu: luật đúng
có sẵn, chỉ bản dùng nhiều nhất là trôi.

**Ô tìm không báo lỗi.** Dán `0910.395.950` ra đúng câu nó nói khi khách *chưa từng mua* — nên
nhân viên mới tin luôn và trả lời khách "bên em không có đơn nào của anh/chị", trong khi khách đó
có 6 đơn, đã chi 11,4 triệu. `canon_phone()` **đã có sẵn từ 0137** và `app_rw` **đã có quyền**;
chỉ là ô tìm đơn không dùng. Dạng lỗi *"đã có lời giải ở chỗ khác trong cùng repo"*.

### Quyết định trong giao hàng loạt

**Không nhận mã vận đơn** — mã là của TỪNG đơn, gõ 26 mã vào một ô là vô nghĩa; đơn qua hãng đã
có đường riêng. Nút dành cho shop **tự giao**. Ba điều kiện bỏ qua: chưa xác nhận · **đang có
claim vận đơn của hãng** (giao tay đè lên = hãng thu hộ COD hai lần, đúng lớp lỗi docs/61) · đã
gửi đủ.

## Lỗi của chính tôi trong đợt này

1. **Backtick trong chú thích NẰM TRONG template literal** cắt đứt chuỗi — **ba lần** trong một
   phiên. Đây không còn là sơ suất mà là bẫy cố hữu của kho này.
   → Luật: chú thích bên trong template literal **không được có backtick**.
2. **`q.get(k)` vắng trả `null`, mà `Number(null)` là `0`** → nhánh đầu luôn thắng, mọi thao tác
   hàng loạt báo *"Đã xác nhận 0 đơn"* kể cả khi vừa giao 50 đơn. Không test nào bắt; chỉ thấy vì
   đi **đọc dòng chữ hiện ra trên màn hình** thay vì tin vào mã vừa viết.
3. **Bất biến `lock-order.test.js` bắt truy vấn mới thiếu `ORDER BY variant_id`** — thứ tự khoá
   tồn không xác định thì hai lượt đồng thời deadlock, mà giao *hàng loạt* làm điều đó dễ xảy ra
   hơn hẳn. Bất biến của đợt trước vừa trả xong tiền vốn.
4. Khẳng định `gõ "3" ra đúng 1 đơn` là **tự bịa một luật không tồn tại** (SĐT chứa chữ số 3 cũng
   khớp — đúng) → đo **sự có mặt**, không đo **số lượng**.

## Phát hiện ngoài kỹ thuật

Gói **platform** (990k) và **care** (2,49M) có **cùng trần 100 sản phẩm**; **growth** (5,9M) mới
lên 500. Một shop thời trang ngày-60 có 200 SP là bình thường — với bảng giá này họ **không có lý
do gì trả 2,49M**, phải nhảy thẳng lên 5,9M (gấp 6 lần). Câu hỏi đóng gói sản phẩm, không phải
bug; thông báo lỗi thì viết tốt.

## Còn lại, chưa làm

Trang **tạo phiếu nhập 651 KB** (4.551 dòng chọn hàng, ~187 KB sau nén mỗi lần mở) và ô lọc trong
đó **làm mất các dòng đã điền**. Việc vừa, chưa đụng.

**Trạng thái:** CI đầy đủ **102/102 mục xanh**, 2.525 khẳng định e2e, unit 153. Đã push `19196f6`.
