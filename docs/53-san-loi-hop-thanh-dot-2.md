# 53 — Săn lỗi hợp thành đợt 2: quét 5 mảng chưa chạm, và bài học về "0 bị bác bỏ"

Tiếp `docs/51` và `docs/52`. Lần này quét 5 mảng chưa từng soi theo kiểu này: kho/tồn,
giao hàng, ba lớp giảm giá chồng nhau, phân quyền, thuê bao nền tảng.

**Cách làm.** 5 agent đọc song song, mỗi agent trả tối đa 3 nghi vấn kèm `file:dòng` +
kịch bản thao tác cụ thể; mỗi nghi vấn nặng bị một agent KHÁC cố **bác bỏ** bằng chính mã
nguồn, mặc định là bác bỏ nếu không tự chứng minh được. 14 agent, ~13 phút.

## Kết quả: 9 sống sót, **0 bị bác bỏ** — và đó là một cảnh báo, không phải một điểm số

Lớp phản biện không loại được gì. Với một lớp phản biện lành mạnh, tỉ lệ đó phải khác 0.
Nên kết quả được xử lý như **danh sách nghi vấn**, không phải danh sách lỗi. Và đúng như
vậy: nghi vấn nặng nhất **sai ở phần lý giải**.

## Nghi vấn #3 — "shop trả tiền vẫn bị khoá vĩnh viễn": sai lý giải, đúng lỗi

Agent nói `sweepSubscriptions` khoá shop mà không đóng dấu `suspended_at`, còn đường mở
khoá thì đòi dấu đó → khoá vĩnh viễn.

Đọc mã thì thấy **`sweepBillingEnforce` vẫn đóng dấu hộ** ngay cả khi nó không phải kẻ khoá
(`locked.rowCount ? prev : null`, worker `index.js:636-639`). Nên lập luận trên chưa đủ.
Chạy thật (`a8-khoa-shop-repro`):

| Ca | Kết quả |
|---|---|
| Cấu hình mặc định, chạy cả hai sweep | **KHÔNG hỏng** — khoá → trả tiền → `shop=active` |
| Chỉ `sweepSubscriptions` kịp khoá | **HỎNG** — trả tiền, sub về `active` còn hạn, mà `shops.status` kẹt `suspended` |

Ca 2 **đến được ở cấu hình mặc định**: hai sweep là hai `setInterval` RIÊNG, còn
`sweepBillingApply` chạy mỗi 30 giây. Khách trả tiền trong khe giữa hai nhịp là rơi đúng
vào đó. Và một khi sub đã `active`, `sweepBillingEnforce` — nơi duy nhất đóng dấu — không
bao giờ chọn lại nó nữa (`WHERE s.status IN ('past_due','cancelled')`), nên dấu không bao
giờ được đóng bù. Khoá thật sự vĩnh viễn, chỉ là qua một con đường khác con đường agent mô tả.

**Vá.** `sweepSubscriptions` đóng dấu `suspended_at`/`suspended_from` y như
`sweepBillingEnforce`, và **chỉ khi chính nó khoá** (`locked.rowCount`) — đóng dấu hộ cho
shop đang bị nền tảng khoá vì vi phạm là mở đúng cái cửa không nên mở.
Kèm lợi ích phụ: shop được trả về **đúng trạng thái cũ** thay vì bị ép thành `active`.

## Nghi vấn #2 — RMA bỏ qua coupon/điểm: đúng, và nặng hơn mô tả

`createReturn` tính hoàn `Σ(unit_price_vnd × qty)` — giá **trước** giảm. Coupon và điểm
thưởng nằm ở header đơn (`discount_vnd`, `points_discount_vnd`); hàm này không đọc hai cột
đó. Đơn không giảm giá thì `Σ dòng = số đã thu` nên mọi test cũ đều xanh.

Chạy thật (`a9-rma-giam-gia`), đơn 2 món 170.000đ, coupon −85.000đ, ship 30.000đ,
khách trả 115.000đ:

```
A. Trả 1 trong 2 món
   HỎNG  hoàn 85.000đ (đúng phải 42.500đ) — shop mất 42.500đ, khách giữ món còn lại gần như miễn phí
B. Trả TOÀN BỘ
   HỎNG  422 "số hoàn 170.000đ vượt số còn có thể hoàn (đã thu 115.000)"
         → đơn dùng coupon KHÔNG nhận trả hàng được, không có đường vòng nào trong giao diện
```

Ca B nặng hơn ca A và agent chỉ nhắc thoáng qua: **tính năng đổi-trả hỏng hoàn toàn với mọi
đơn có khuyến mãi**.

**Vá.** Phân bổ giảm giá header về hàng trả theo tỉ trọng:
`hoàn = round(gross × (subtotal − discount − points) / subtotal)`. Lần trả **cuối** (sau
lượt đó không còn dòng nào chưa trả) đóng đúng phần còn lại, để làm tròn từng lượt không
để sót vài đồng kẹt vĩnh viễn. Phí ship không hoàn — giữ nguyên hành vi cũ.

> Một sai của chính tôi khi đo: khẳng định đầu tiên cho ca B so số hoàn với `amount_paid`
> (đã gồm ship) nên báo VẤP dù mã đã đúng. Mốc đúng là **tiền hàng** đã trả.

## Test thường trực + kiểm tra đột biến

| Bộ | Thêm | Đột biến gây đỏ |
|---|---|---|
| `apps/seller/test/returns-rma.e2e.mjs` | đơn có coupon: trả một phần hoàn phân bổ đúng · trả toàn bộ vẫn nhận được | tắt nhánh phân bổ → **2 FAIL** (hoàn 100.000 thay vì 50.000; trả cả đơn 422) |
| `apps/seller/test/billing.e2e.mjs` §7b | sweep thuê bao khoá → có dấu → trả tiền mở lại được | tắt câu đóng dấu → **2 FAIL** |

## Bài học

1. **"0 bị bác bỏ" là tín hiệu lớp phản biện yếu, không phải tín hiệu các nghi vấn đều đúng.**
   Nghi vấn nặng nhất sai lý giải; đọc mã 10 phút là thấy. Vẫn phải tự kiểm.
2. **Sai lý giải không có nghĩa không có lỗi.** Lỗi có thật, chỉ đến qua đường khác — nếu
   dừng ở "agent nói sai rồi" thì bỏ lọt một lỗi khoá shop đang trả tiền.
3. Lặp lại mô-típ của `docs/52`: **một quy tắc viết ở hai nơi**. Ở đây là "khoá shop" viết
   trong hai sweep, và "công thức tiền hàng" viết ở checkout nhưng không ở RMA.

## Nghi vấn #1 — đơn COD hoàn/trả rơi khỏi sổ đối soát: **đúng nguyên văn**

Sổ "hãng còn nợ tiền" định nghĩa bằng `o.status = 'delivered'` (`cod.js`), còn `refundOrder`
đẩy đơn sang `'refunded'` và `createReturn` sang `'returned'`. Hai bên không biết nhau.

Chạy thật (`a10-cod-mat-dau`), đơn COD 185.000đ giao qua GHTK:

```
A. Khách trả hàng   → ĐƠN RƠI KHỎI SỔ (status=returned, cod_settled_at=NULL)
                       tổng "hãng còn nợ" tụt 185.000đ
   ghi phiếu tay?   → NGÕ CỤT 422 "đơn #25 chưa giao xong"
B. Shop hoàn tiền   → ĐƠN RƠI KHỎI SỔ (status=refunded), tụt 100.000đ
```

Hãng đã thu tiền của khách xong là món nợ giữa **shop và hãng**; chuyện shop hoàn tiền hay
nhận trả hàng sau đó là giữa **shop và khách**. Lọc theo `status` trộn hai quan hệ đó.

**Vá.** Điều kiện đổi sang **"đã từng giao"** (`delivered_at IS NOT NULL`) ở cả ba chỗ:
`OUTSTANDING_SQL`, guard của `recordRemittance`, và **bản sao thứ hai** của cùng bộ lọc
trong memo "hãng còn nợ" ở `reports.js:237` — hai nơi định nghĩa cùng một con số, lệch nhau
là màn Đối soát COD và Báo cáo nói hai số khác nhau mà không ai biết cái nào đúng.

Test `cod-reconcile` +4 khẳng định; đột biến (trả lại `status='delivered'`) → **3 FAIL**.

## Còn nợ (đã tìm ra, CHƯA kiểm chứng, CHƯA vá)

Năm nghi vấn còn lại — **chưa cái nào được dựng lại**:

| Mảng | Vị trí | Nội dung |
|---|---|---|
| kho | `apps/seller/src/catalog.js:750` | tái dùng biến thể: tồn cũ "sống lại" khi đơn giữ chỗ huỷ |
| giao hàng | `apps/seller/src/orders.js:650` | hoàn tiền đơn giao một phần không nhả reserve |
| khuyến mãi | `apps/seller/src/orders.js:717` | đơn từ bot Messenger tính ship bằng công thức phẳng |
| phân quyền | `apps/seller/src/affiliates.js:234` | `affiliate.manage` khai báo cần step-up nhưng không route nào bật cờ |
| phân quyền | `apps/seller/src/cod.js:119` | ghi phiếu chuyển tiền COD là route `payment.write` duy nhất không step-up |
