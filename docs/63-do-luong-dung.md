# Đo luồng dùng (feature usage) — v0

Xây **con mắt**, không xây thêm tính năng. Migration `0141` + `0142`.

## Vấn đề

Hệ có ~475 điểm vào (route × phương thức) và **không một dòng nào** đếm cái nào được dùng.
`obs.js` chỉ có request-id, log JSON và health — ta biết hệ thống **sống**, không biết nó được
**dùng** thế nào. Hệ quả: mọi quyết định "xây gì tiếp" là suy đoán, kể cả khi đã có khách. Và
một tính năng không ai dùng vẫn thu thuế bảo trì vĩnh viễn lên đúng một người.

Bảng `feature_usage` trả lời ba câu: màn nào chủ shop mở **mỗi ngày** · tính năng nào chỉ vài %
shop chạm · lần cuối ai đó dùng nó là bao giờ.

**Không phải phân tích hành vi người dùng.** Không user_id, không IP, không tham số, không thứ
tự thao tác — chỉ `(service, mẫu-route, shop, ngày, số lượt)`. Đủ để quyết định xây gì, **không**
đủ để theo dõi một con người. Ranh giới đó là cố ý.

## Đường đi

```
request → obs.js runReq (sự kiện `finish`) → Redis hash fu:<ngày VN>:<service>
        → worker gộp mỗi 5' (RENAME → HGETALL → UPSERT cộng dồn → DEL)
        → feature_usage → /ops/usage → trang /platform/usage
```

**Không service nào ghi thẳng DB** — đúng tiền lệ lượt-xem-SP (0098). Ba cái lợi: không nới
quyền ghi cho vai công khai (bất biến an ninh 0011) · đường nóng không thêm ghi DB nào · một
route bận tốn 1 UPSERT mỗi chu kỳ thay vì 1 ghi mỗi request.

Vòng gộp dùng **nguyên khuôn** `sweepProductViews`: RENAME sang `fuf:` **trước** khi đọc (HGETALL
rồi DEL sẽ nuốt phần chen giữa hai lệnh) · SCAN chứ không KEYS (Redis này còn giữ session,
rate-limit, BullMQ) · try từng khoá · TTL 3 ngày làm lưới an toàn · nuốt mọi lỗi.

### Chuẩn hoá route — chỗ sống-chết của tính năng

`route` phải là **mẫu**, không bao giờ là đường dẫn thật. Lọt một id là bảng nổ theo số shop và
mọi phép gộp thành vô nghĩa.

| Vào | Ra |
|---|---|
| `/shops/9f3c…/inventory/safety` | `/shops/:id/inventory/safety` |
| `/p/ao-thun-trang` | `/p/:slug` |
| `/orders/12345` | `/orders/:n` |
| `/tim-kiem/%C3%A1o%20thun` | `/tim-kiem/:x` |

`shop_id` rút **luôn** từ `/shops/<uuid>/…` nên seller · seller-admin · platform không phải sửa
dòng nào. Storefront và checkout phân giải shop theo **tên miền** → mỗi service một dòng
`noteShop(shopId)`. Đây là ca dễ sót nhất: bỏ nó thì số đếm vẫn "chạy", chỉ là `shop_id` NULL —
tức mất sạch ý nghĩa mà không có dấu hiệu gì.

Ba lớp chặn cardinality: đoạn > 40 ký tự → `:x` · sâu > 8 tầng → cắt · mẫu > 150 ký tự → cắt.
Thêm **trần 5.000 ô** mỗi `(ngày, service)` trong Redis; chạm trần thì dồn vào ô `:over` — con số
vẫn nói thật "có thứ tôi không phân loại được", thay vì âm thầm nuốt hoặc âm thầm phình.

**Không đếm**: health (load balancer gọi liên tục sẽ át số liệu thật), tài nguyên tĩnh, 404 (nói
về đường **không** tồn tại), 429 (nói về rate-limit). **Có** đếm 5xx: người dùng đã cố dùng.

## Trang console

`/platform/usage` — cột `Dịch vụ · Đường dẫn · Cửa hàng dùng (%) · Lượt · Lần cuối`.

Sắp xếp **NGƯỢC**: ít shop dùng nhất lên đầu. Bảng xuôi ai cũng đoán được kết quả (danh sách
đơn, danh sách SP luôn nhất) — nó không dạy gì. Thứ ở đầu bảng ngược mới là thứ đang âm thầm
thu thuế bảo trì. Cột quan trọng nhất là **số shop**, không phải số lượt: một shop bấm 500 lần
vẫn là **một** shop cần nó.

Trang in kèm **đo từ ngày nào**: không có con số đó thì "3 shop dùng" đọc thế nào cũng được —
dữ liệu bật hôm qua trông y hệt dữ liệu ba tháng không ai chạm.

Ngưỡng 10% được **tô màu**, không tự động kết luận. Một tính năng ít shop dùng vẫn có thể là
tính năng giữ chân đúng shop trả tiền nhiều nhất.

## Hai thứ v0 CỐ Ý chưa làm

1. **Danh sách "chưa ai chạm bao giờ".** Bảng chỉ biết những gì đã được dùng ít nhất một lần;
   route chưa ai gọi thì không có dòng nào. Muốn có danh sách đó cần một **bản kê toàn bộ route
   của mọi service** — việc riêng, chưa làm. Trang tự nói rõ giới hạn này, có test canh câu đó
   còn trên trang.
2. **Grain (route × shop)** nên số ô ≈ số route × số shop. Vài trăm shop thì thoải mái; tới hàng
   nghìn phải đổi phần "bao nhiêu shop dùng" sang đếm xấp xỉ (HyperLogLog).

## Hai phát hiện ngoài dự kiến

**1. `ALTER DEFAULT PRIVILEGES` cấp CRUD cho `app_rw` trên MỌI bảng mới.**

0141 viết "cố ý không cấp quyền cho app_rw". Câu đó **sai trong thực tế** — và chỉ lộ ra vì bộ
e2e đi kiểm đúng điều nó khẳng định thay vì tin lời chú thích. *"Không viết GRANT" không có
nghĩa là "không có quyền".*

Cửa **có** đóng, nhưng đóng bằng lớp khác: FORCE RLS + không policy nào cho app_rw → SELECT ra 0
dòng. Vấn đề là nó đóng nhờ một **sự vắng mặt**; ai đó thêm một policy PERMISSIVE cho app_rw là
mở toang mà không nghĩ mình vừa mở gì. `0142` REVOKE thẳng. Bộ e2e nay kiểm **cả hai lớp** —
grant *và* đọc-thật — vì kiểm mỗi "đọc ra 0 dòng" thì vẫn xanh sau khi cửa đã mở.

`feature_usage` là bảng **duy nhất** trong DB rơi vào tình trạng "có grant, không policy" (đã
quét). Các bảng tenant khác đều có policy đàng hoàng.

**2. Migration là bất biến — bộ chạy băm nội dung.** Sửa 0141 tại chỗ sau khi đã áp dụng thì
migrate từ chối: `DRIFT: migration đã áp dụng nhưng nội dung đã đổi`. Đúng — sửa tại chỗ thì máy
đã chạy và máy chưa chạy có schema khác nhau mà cùng số hiệu. Nên bản vá là `0142`, không phải
sửa `0141`.

## Việc phụ đã làm theo

`packages/redis-lite/` — client RESP tối giản tách ra dùng chung, vì `seller` và `seller-admin`
**chưa từng có Redis** (mà đó lại là hai service quan trọng nhất cho câu hỏi "màn nào chủ shop mở
mỗi ngày"). Mount vào hai service đó ở cả hai compose.

`checkout` · `storefront` · `payment` vẫn giữ **bản sao** trong `server.js` của chúng: đưa cả ba
sang dùng chung nghĩa là sửa đường nóng thanh toán để đổi một đoạn mã đang chạy đúng — đánh đổi
tồi khi làm cùng lúc với tính năng mới. Dọn dang dở **có chủ ý**, ghi rõ trong header file.

## Ba bẫy đo trong đợt này

1. **Đặt tên biến `pg`** cho biến trang trong e2e → che module `pg` đã import trong **toàn bộ**
   hàm (TDZ của `let`) → mọi `pg.Pool` phía trên ném `ReferenceError`. Cùng dạng với lỗi `B` che
   hằng ANSI ở đợt xuất-CSV.
2. **Đột biến không bị bắt vì worker chưa hề chạy mã mới.** `apps/worker/src` **không** bind-mount
   trong dev → `restart` vô nghĩa, phải `up -d --build`. Lần đầu chạy đột biến "UPSERT đè thay vì
   cộng dồn" ra 28/28 xanh — không phải test yếu, mà là *đo nhầm image*. Tệ hơn: lần rebuild sau
   đó `migrate` fail nên worker dừng ở trạng thái `Created`, và bộ test đỏ 5 chỗ vì **service
   chết**, không phải vì đột biến. Quy tắc: đột biến ra kết quả lạ thì **kiểm container trước**.
3. **Test của chính tôi bắt lỗi thật của chính tôi**: mẫu route xấu nhất (8 đoạn × 40 ký tự) dài
   328 ký tự > `CHECK` 160 → INSERT ném lỗi → mất **cả lô** số đếm của service đó trong chu kỳ.
   Vá bằng trần độ dài tại nguồn.

## Đột biến đã chạy

| Đột biến | Kết quả |
|---|---|
| Không chuẩn hoá uuid trong `routeTemplate` | 4 đỏ — kể cả "uuid thật lọt lên trang" |
| UPSERT `hits = excluded.hits` (đè thay vì cộng) | 1 đỏ — đúng khẳng định cộng dồn |
