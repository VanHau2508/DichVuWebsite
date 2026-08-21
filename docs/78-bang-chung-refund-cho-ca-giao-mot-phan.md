# Bằng chứng refund cho ca giao một phần

## Vấn đề

Luồng cũ lưu đúng một `refund_id` trong `resolution_payload`, nhưng lại quyết định “đủ tiền”
bằng tổng mọi refund tạo sau `detected_at`. Hai hậu quả:

- một phiếu không được người bán chọn vẫn có thể làm ca đủ điều kiện;
- một phiếu hợp lệ tạo trước khi worker phát hiện ca bị loại khỏi bằng chứng.

Đây là lỗi mô hình bằng chứng, không phải lỗi hiển thị. `detected_at` là lúc hệ thống nhận ra
vấn đề, không phải lúc tiền bắt đầu có giá trị.

## Mô hình 0176

`order_resolution_refund_attributions` ghi đúng tập phiếu người bán chọn:

- composite FK chứng minh case và refund cùng `shop_id` + `order_id`;
- `UNIQUE (shop_id, refund_id)` ngăn một phiếu làm bằng chứng cho hai ca;
- không có `attributed_vnd`; tổng luôn dẫn xuất từ `refunds.amount_vnd`;
- `required_refund_vnd` trên case vẫn bất biến;
- ca cũ không backfill, tiếp tục đọc `resolution_payload.refund_id` và được gắn nhãn
  “bằng chứng định dạng cũ”.

Quyền bảng cố ý hẹp: `app_rw` chỉ SELECT; `app_resolution` chỉ SELECT + INSERT; không vai nào
có UPDATE/DELETE. RLS có đúng ba policy tách theo lệnh, không `FOR ALL`.

## Cửa ghi và transaction

`attribute_resolution_refunds(case_id, refund_ids[], note, actor_id)` là SECURITY DEFINER do
`app_resolution` sở hữu. Hàm:

1. xác minh actor là owner/admin của đúng shop;
2. chuẩn hoá refund ID theo thứ tự và khoá case;
3. dùng advisory transaction lock theo `(shop_id, refund_id)` — không dùng `FOR UPDATE` trên
   refunds vì cách đó sẽ buộc mở quyền UPDATE cho role chỉ-đọc;
4. kiểm đúng đơn, loại `edit_adjustment`, cộng đúng tập đã chọn;
5. append attribution rồi đóng case.

Node vẫn ghi `audit_logs` và `order_events` bằng `app_rw` trong cùng `withTenant` transaction.
Deferred constraint trigger buộc attribution + audit + event đều tồn tại trước COMMIT; không
mở INSERT audit/event cho `app_resolution`.

## Replay và concurrency

Canonical request là `sorted(refund_ids) + resolution_note`:

- cùng case + cùng canonical đồng thời: một success, một replay;
- cùng case + khác canonical đồng thời: một success, một 409;
- hai case tranh cùng refund: unique constraint chặn một bên.

Không tạo bảng idempotency/lifecycle phụ. Trạng thái canonical đọc từ attribution rows và
`resolution_note` của case.

## SSR/no-JS

Đường COD chưa thu tiền giữ nguyên `/accept-partial` (`orders.write`, không step-up) và từ
chối mọi body mang refund. Đường tiền mới là `/accept-partial-with-refund` (`refund`, step-up,
owner/admin).

Chi tiết đơn hiển thị checklist nhiều phiếu, kể cả phiếu trước `detected_at`, cùng ba số
`required / attributed / remaining`. Phiếu đã thuộc ca khác vẫn hiện nhưng bị vô hiệu và nói
rõ lý do. POST đầu chỉ dựng interstitial mật khẩu, giữ nguyên mọi `refund_ids` + note bằng
hidden input; POST step-up mới gọi auth rồi seller; thành công dùng PRG. Toàn bộ luồng chạy
được khi tắt JavaScript.

## Chốt kiểm chứng

- migration trắng: 174 migration, 0 DRIFT, 0 pending;
- exact privilege/policy + composite FK + SECURITY DEFINER được canh trong schema invariants;
- seller E2E canh phiếu trước `detected_at`, replay, conflict, cross-shop và hai ca concurrency;
- BFF E2E đi qua form-urlencoded thật, mật khẩu sai/đúng và PRG, không POST JSON thẳng vào seller.
