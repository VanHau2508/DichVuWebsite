# Chi tiết đơn hàng an toàn: refund idempotent, SSR hai bước và vai nghiệp vụ

## Vì sao lát cắt này tồn tại

Trang chi tiết đơn đã có đủ dữ liệu nhưng bốn chốt quan trọng còn rời nhau:

- Hoàn tiền một phần giữ đơn ở trạng thái `paid`, nên `FOR UPDATE` chỉ xếp hàng hai request;
  nó không ngăn request thứ hai ghi thêm một phiếu hợp lệ.
- Form hoàn tiền có thể đi thẳng từ POST đầu tới seller khi phiên step-up còn hạn. Một cú
  double-click vì vậy có thể thành hai bút toán thật.
- `pages.js` tự dựng một công thức tiền fallback khi thiếu `payment_summary`. Công thức đó
  không biết `fulfillment_adjustment_vnd`, nên màn hình có thể nói một số khác sổ dùng chung.
- Vai được chép tay ở nhiều nút. `order_manager` có `orders.write` ở seller nhưng không thấy
  thao tác hoàn-về; ngược lại một Set nội dung có thể bị dùng nhầm cho quyền refund chỉ vì
  hôm nay hai Set tình cờ cùng gồm owner/admin.

## Quyết định đã khoá

### Refund dùng một key xuyên suốt

Migration `0175` thêm `refunds.idempotency_key`, `request_fingerprint` và partial unique index
`(shop_id, idempotency_key) WHERE idempotency_key IS NOT NULL`. Phiếu cũ giữ `NULL`, không
backfill và không bị đụng.

`idempotency_keys` dùng chung giữ nguyên response đầu tiên, kể cả đơn 0đ không sinh dòng
`refunds`. Key DB được namespace thành `refund:<uuid>` để không va với checkout. Fingerprint
băm `order_id + mode + amount_vnd + reason + restock`; cùng key nhưng đổi bất kỳ ý nghĩa nào
trả `409 idempotency_key_reused`.

Replay phải chạy trước guard `payment_status`. Nếu không, request đầu đã lật đơn sang
`refunded` thì chính request replay hợp lệ lại nhận lỗi “chỉ hoàn được đơn đã thanh toán”.

### Hoàn tiền luôn là hai POST SSR

1. `POST /orders/:id/refund` chỉ sinh UUID và render trang xác nhận. Không gọi seller.
2. `POST /orders/:id/refund/confirm` mới xác thực step-up nếu cần và gọi seller.

Trang xác nhận hiện lại số tiền, lý do và giữ key trong hidden input. Step-up còn hạn thì không
hỏi lại mật khẩu; hết hạn mới hiện ô mật khẩu. Seller lỗi cũng render lại đúng trang với cùng
key, vì quay về chi tiết đơn sẽ sinh key mới và vô hiệu hoá chống gửi lặp.

Một lỗi phát hiện trong lúc làm: `parseVnd('abc')` trả `null`. Nếu dùng helper đó ở BFF,
`amount_vnd=abc` bị biến thành “không nhập số tiền”, tức lệnh hoàn toàn bộ. Đường refund nay
chuyển nguyên chuỗi cho seller kiểm số nguyên dương.

### Thiếu payment summary thì fail-closed

View không còn `legacyReceived`, `fallbackRefunded` hay `fallbackNet`. Nếu contract seller
thiếu/hỏng, trang hiện mã `PAYMENT_SUMMARY_MISSING`, ghi rõ tải lại/liên hệ hỗ trợ và ẩn mọi
thao tác có thể thay tiền hoặc tổng đơn. Nhãn thanh toán là “Không tải được”, không đoán thành
“Chưa thanh toán”.

### Vai được đặt tên theo nghiệp vụ

`apps/seller-admin/src/roles.js` là nguồn chung cho SSR và BFF:

- `ORDER_ROLES`: vòng đời đơn, gồm `order_manager`.
- `REFUND_ROLES`: hoàn tiền và hậu mãi có tiền.
- `PAYMENT_ROLES`: ghi/đảo khoản thu.
- `INVENTORY_ROLES`: kiểm nhận và nhập lại tồn.

Tên Set là một phần của hợp đồng. Không dùng `CONTENT_ROLES` thay `REFUND_ROLES` dù thành viên
hiện tại giống nhau.

## Lỗi tồn kho tìm thêm khi triển khai

Sau `mark-returned`, seller đã tự restock phần hàng gửi đi nếu checkbox được chọn. Nhưng thẻ
đơn hoàn-về vẫn bảo người dùng tự điều chỉnh tồn, tạo nguy cơ cộng kho lần hai. Trang nay đọc
payload `shipment.returned`:

- `restocked=true`: nói hàng đã nhập lại, không cộng tay lần nữa;
- `false`: nói hàng không được nhập vì hỏng/thiếu;
- thiếu dữ liệu: yêu cầu đối chiếu timeline/phiếu trả trước khi điều chỉnh.

## Kiểm chứng

- Unit: `236/236`.
- DB invariant: `117/117`; kiểm thêm kiểu cột, định nghĩa partial unique index và
  cô lập idempotency key trùng giữa hai shop.
- Fresh migration: `173` migration, `0 DRIFT`, `0 pending`.
- E2E: `106/106` suite; các bộ trọng tâm gồm money `64/64`, shipping `96/96`, bom hàng
  `5/5`, sự cố SSR `46/46`, công nợ `27/27`.
- Full local CI: `113` mục, `0` đỏ; smoke edge/readiness/TLS đều qua.

Các ca quyết định: tuần tự và đồng thời cùng key chỉ một phiếu; cùng key khác amount/order bị
chặn; key khác cùng amount vẫn là hai lần hoàn hợp lệ; replay sau khi đơn đã `refunded` trả
`200 replayed`; bấm lặp hoàn-về không đổi tồn, ledger, audit, timeline hoặc outbox.
