# Vận đơn CHẾT — một dòng `shipments` không còn hiệu lực vẫn nói thay cho cả đơn

Đợt 4, mục A · B · C (docs/57). Ba mục được yêu cầu, chín trên chín lăng kính phản biện xác
nhận, và lượt quét lân cận moi thêm **sáu chỗ khác cùng khuôn**. Tài liệu này ghi lại **luật**
rút ra, để chỗ thứ bảy không lặng lẽ sinh ra.

## Một dòng `shipments` chết bằng bốn đường bình thường

Không đường nào cần ai làm sai:

| Đường | Kết quả trong DB |
|---|---|
| Hãng huỷ vận đơn | `status='cancelled'` (worker sweep) |
| Claim chết sau 15' (gọi hãng timeout) | `status='cancelled'`, `provider_status='claim_expired'`, `tracking_number IS NULL` |
| Đơn đổi trạng thái giữa lúc gọi hãng | `status='cancelled'`, `provider_status='orphan'`, CÓ mã vận đơn |
| Shop ngắt / **đổi** hãng vận chuyển | `provider_status='orphan'` trên kiện đang bay |

Mã trạng thái thô do hãng trả về không còn nằm trong `provider_status`: từ migration `0184`,
worker ghi nguyên văn vào `shipments.carrier_status_raw`, còn `provider_status` chỉ giữ marker
nội bộ dùng cho phục hồi và đối soát.

## Luật 1 — dòng đã huỷ KHÔNG được làm "đại diện" cho đơn

Vận đơn huỷ nghĩa là **hãng không cầm hàng và không thu hộ đồng nào**. Mọi truy vấn chọn *một*
vận đơn để trả ra ngoài phải loại nó. Sáu chỗ đã quên, hậu quả xếp theo độ nặng:

1. **`cod.js` + `reports.js`** — sổ Đối soát COD và memo P&L đẻ ra **khoản phải thu MA**. Người
   bán đi đòi hãng một khoản không tồn tại. *(Cùng file `reports.js`, truy vấn phí hãng q5 đã
   lọc `status <> 'cancelled'` từ lâu — hàng rào có ở hầu hết nơi, thiếu ở vài nơi.)*
   Nay hai nơi **dùng chung một hằng** `LATERAL_VAN_DON_HANG`: dặn dò không giữ nổi hai bản
   chép tay đồng bộ, dùng chung thì giữ **bằng cấu trúc**.
2. **`orders.js reconcileEditLines`** — claim chết để lại `shipment_lines`, nên mọi lần Sửa đơn
   đều 409 *"đơn đã có vận đơn"* cho một đơn **chưa từng gửi món hàng nào**. Ngõ cụt vĩnh viễn,
   không đường vòng nào trong giao diện. Vá: dọn dòng `cancelled` **không có mã vận đơn** (đúng
   tiêu chí vòng quét dùng để kết luận "hãng chưa tạo gì"), cascade xoá `shipment_lines`. Vận
   đơn thật (có mã) vẫn chặn — hàng rào không bị nới.
3. **`ingest-catalog.js`** — bot Messenger trả lời *"đơn tôi tới đâu"* bằng mã đã huỷ. Khách tra
   ra trang trống rồi gọi điện: tệ hơn hẳn trả lời "chưa có mã".
4. **`checkout` + `account`** — trang tra cứu và tài khoản khách in *"Đơn đã được gửi qua đơn vị
   vận chuyển"* kèm mã đã huỷ. Cả hai câu SQL **có lấy cột `status` rồi không ai đọc**.
5. **`seller-admin` phiếu in** — `(o.shipments)[0]` là kiện **cũ nhất** (`ORDER BY created_at`),
   rất có thể là claim hỏng → shipper cầm giấy sai.
6. **`worker` digest "đơn ứ"** — `max(created_at)` trên **mọi** dòng, nên một claim chết tạo hôm
   nay kéo mốc "đã gửi hãng" về hiện tại → đơn gửi 10 ngày trước không bao giờ lọt cảnh báo.
   Chính lớp cứu đơn kẹt bị đơn kẹt nhất làm mù.

Khoá lại bằng bất biến mức **mã nguồn**: `apps/seller/test/shipment-status.test.js`. Sáu chỗ nằm
ở sáu service (mỗi service một image) và vài chỗ là HTML in ra giấy — không e2e nào nhìn thấy cả
sáu cùng lúc.

## Luật 2 — danh tính lấy từ DÒNG DỮ LIỆU thì credential cũng phải khớp DÒNG ĐÓ

`shop_shipping_config` có `PRIMARY KEY (shop_id)` — **một dòng/shop**. Đổi hãng là `ON CONFLICT
DO UPDATE` **ghi đè token**, token hãng cũ biến mất vĩnh viễn.

Vòng quét tracking lại ghép `cfg.shop_id = s.shop_id` **và chỉ thế**, rồi gọi
`carrierState(s.provider, cfg.token_enc, …)`: **hãng lấy từ dòng vận đơn, token lấy từ cấu hình
hiện tại**. Sau khi shop đổi GHTK→GHN, mọi kiện GHTK đang bay bị hỏi bằng token GHN → hãng từ
chối → `carrierState` trả `null` → `bump` → xoay xuống cuối. **Không log, không metric**, lặp
~4.320 lượt trong 30 ngày rồi im hẳn. COD của những đơn đó **không bao giờ** tự lật `paid`
(nhánh duy nhất làm việc đó nằm sau `st.state === 'delivered'`) — trong khi trang Vận chuyển vẫn
hứa *"hệ thống tự theo dõi trạng thái tới khi giao xong"*.

Hai nửa của bản vá:

- **Worker**: thêm `AND cfg.provider = s.provider`. Không hỏi hãng cũ bằng token hãng mới nữa.
- **Seller `connectShipping`**: đổi hãng → đánh dấu kiện của hãng cũ `provider_status='orphan'`
  + trả `live_shipments` và `warning`. **Soi gương `disconnectShipping`**, vốn đã xử đúng ca này
  từ lâu; đường đổi hãng gây cùng hậu quả mà không có dòng nào tương ứng.
- **seller-admin**: `warning` phải LÊN MÀN HÌNH. Trước đó BFF nuốt nó ở *cả hai* đường (ngắt
  lẫn đổi) — shop chỉ thấy "Đã kết nối GHN." và tin rằng mọi thứ vẫn tự chạy.

Lối thoát là có thật, không phải ngõ cụt: shop chốt tay bằng "Đã giao xong" **và** "Đã nhận
tiền" (`deliverOrder` chỉ đổi `status`, KHÔNG đụng `payment_status` — nên với COD phải bấm cả
hai nút, và câu cảnh báo nói đúng như vậy).

## Luật 3 — URL sinh ra phải khớp BẢNG ROUTE THẬT

Đường dẫn công khai của trang nội dung là `/pages/<slug>`. Hai nơi công bố sai `/<slug>` trần:

- **sitemap.xml** — mọi URL trang chính sách nộp cho Google đều 404. Sitemap toàn URL chết còn
  hạ uy tín cả tên miền, và không ai thấy cho tới khi mở Search Console.
- **màn "Trang nội dung" của seller-admin** — chỉ dẫn DUY NHẤT trên màn đó về chỗ trang đang
  nằm; người bán dán nó vào bài Facebook/Zalo là ra 404. Mâu thuẫn nằm **trong cùng một file**:
  bộ chọn liên kết của trang Giao diện vốn đã dựng đúng `/pages/` + slug.

**Cách kiểm đúng:** e2e lấy **chính chuỗi `<loc>`** trong sitemap rồi fetch lại, gom theo *khuôn*
URL và đòi mọi khuôn trả 200 — **không gõ tay đường dẫn vào test**. Gõ tay chính là cách lỗi này
sống sót: cả sitemap lẫn test đều "tự tin" về cùng một đường dẫn không tồn tại. Kèm một chốt
chặn *"sitemap phải có khuôn `/pages/:x`"*, nếu không ca kiểm thành rỗng nghĩa khi fixture không
có trang nội dung nào.

## Ba bẫy ĐO đã vấp trong đợt này

1. **Stub hãng không kiểm token.** Endpoint tra-cứu GHTK/GHN trong `shipping.e2e.mjs` trả "đã
   giao" cho **bất kỳ** token nào (khác hẳn endpoint tạo đơn, vốn có kiểm). Mọi phép đo về
   lệch-token đều mù. Đã thêm kiểm token — hãng thật làm vậy.
2. **Bộ đếm toàn cục bị DB dev làm nhiễm.** Vòng quét chạy **chéo shop**, mà DB dev tích luỹ
   vận đơn GHTK của những lần chạy trước (cùng trỏ vào stub) → đếm tổng lượt gọi thì chập chờn.
   Phải đếm theo **đúng mã vận đơn** đang xét.
3. **Cửa sổ dò ngược khớp phải CHÚ THÍCH.** Bất biến mã nguồn dò `i-200 → i+500` bắt trúng câu
   chú thích nhắc nguyên văn điều kiện, nên test vẫn xanh khi câu lệnh đã bị gỡ điều kiện. Chỉ
   dò **xuôi** từ mốc. Bắt được bằng đột biến, không phải bằng đọc lại.

Và một bẫy quy trình cũ tái xuất: khôi phục nguồn worker mà **quên `up -d --build worker`** →
đọc kết quả của image đột biến rồi tưởng bản vá không chạy.
