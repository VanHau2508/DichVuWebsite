# 68 — Email nói nốt về tiền

**2026-08-06.** Khép mạch "khách biết chuyện gì đang xảy ra với tiền của mình". Trang tra cứu
và lịch sử đơn đã nói đủ ba con số (docs/67), nhưng **email** — thứ khách đọc **trước**, và
nhiều người chỉ đọc mỗi cái đó — vẫn chỉ báo trạng thái.

## Hai chỗ sai

**1. Chỉ đơn `cancelled` mới nhắc tới tiền.** Đơn **đã trả hàng** hoặc **đã hoàn tiền** thì
email im lặng hoàn toàn. Khách vừa đóng gói gửi hàng đi, nhận thư của shop, đọc thấy đúng một
câu đổi trạng thái — không biết mình sẽ được trả bao nhiêu, hay đã được trả chưa.

**2. Số tiền lấy từ `refund_due_vnd`**, do nhánh huỷ tự tính `= total_vnd`. Đây đúng là luật
đã bị bác ở docs/66. Đơn thu 430.000₫, hoàn trước một phần 150.000₫ rồi mới huỷ → email **hứa
hoàn 430.000₫** trong khi shop chỉ còn nợ 280.000₫.

> Một lời hứa sai **bằng chữ, gửi thẳng vào hộp thư khách**, là thứ khó rút lại nhất trong cả
> hệ thống. Trang web sửa xong là hết; email thì nằm đó vĩnh viễn.

## Đã làm

`statusEvent` (seller) nay tự đính kèm `paid_vnd` / `refunded_vnd` / `owed_vnd`, tính bằng
**biểu thức dùng chung** `packages/orders/src/owed.js` ngay tại thời điểm phát sự kiện — trong
cùng giao dịch, sau khi trạng thái đã đổi, nên là số **sau** sự kiện. Cùng con số với trang
quản trị · trang Công nợ · trang tra cứu · lịch sử đơn của khách.

Nhánh huỷ **thôi tự gửi** `refund_due_vnd`. Worker giữ nó làm **đường lui** cho các dòng
`outbox` cũ đã nằm sẵn trong hàng đợi lúc triển khai.

Worker dựng đoạn tiền cho **mọi trạng thái đóng đơn**:

> Bạn đã thanh toán X. · Cửa hàng đã hoàn lại Y. · Cửa hàng còn phải hoàn Z. Nếu sau vài ngày
> làm việc bạn vẫn chưa nhận được, vui lòng liên hệ cửa hàng kèm số đơn #N.

Hoàn đủ thì nói thẳng *"Cửa hàng đã hoàn đủ khoản bạn thanh toán cho đơn này"* — và **không**
doạ thêm khoản nào. Đơn còn sống thì email giữ nguyên như cũ, không chèn chuyện tiền nong.

## Bằng chứng

`apps/worker/test/email-tien.e2e.mjs` — **17 khẳng định**, đọc **email thật** trong Mailpit,
tìm theo địa chỉ nhận (không lấy "thư mới nhất": chạy song song thì thư mới nhất có thể của
người khác).

**Phần 2 là ca quyết định**: hoàn một phần *rồi mới* huỷ. Ở mọi ca khác `total_vnd` và số
còn-nợ bằng nhau nên một công thức lấy nhầm vẫn xanh trơn. Bộ này khẳng định cả hai chiều —
email **có** con số đúng, và **không** nhắc `total_vnd` như một khoản sẽ hoàn.

Đột biến quay về luật cũ (`['cancelled']` + `refund_due_vnd`) → **7 khẳng định đỏ**.

## Bẫy đo: `đ` không phải `₫`

Worker định dạng tiền bằng **`đ`** (chữ cái Latinh), giao diện web dùng **`₫`** (ký hiệu tiền
tệ U+20AB). Mắt người gần như không phân biệt được. Bộ test lần đầu đỏ **5 khẳng định** trong
khi nội dung email hoàn toàn đúng.

Bẫy này **đã ghi trong docs/50** và tôi vẫn vấp lại. Ghi lại lần nữa ở đây, kèm chú thích ngay
trong tệp test, vì rõ ràng ghi một lần chưa đủ.

## Còn lại

Đơn chốt trong **chat Messenger** không có email (bot không hỏi email) — `statusEvent` gửi
`messenger_psid` và bot có kênh riêng, nhưng đoạn tiền hiện chỉ dựng cho email. Cùng lớp, chưa
làm.
