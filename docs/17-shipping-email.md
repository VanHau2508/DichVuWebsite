# Vận chuyển + Email (outbox → worker) — Ngày 15

> **Trạng thái: ĐÃ CHẠY từ cold start.**
> worker/fulfillment e2e: 13/13 · mutation: 3/3.
> Không hồi quy: mọi bộ khác xanh.

Thông báo email qua **outbox pattern** (ADR-006) + quản lý đơn hàng (vận chuyển).

## 1. Thành phần

| Nơi | Nội dung |
|---|---|
| `0015_shipping_outbox.sql` | `shipments`, cột mốc đơn, grant outbox, vai trò `app_worker` |
| `apps/worker/src/index.js` | poller outbox → BullMQ → gửi email (SMTP relay) |
| `apps/seller/src/orders.js` | quản lý đơn: list/detail/confirm/ship/deliver/cancel |
| compose | dịch vụ `worker` + `mailpit` (bắt SMTP dev) |

## 2. Outbox pattern — bất biến "không email ma"

```
Checkout (transaction): INSERT order + order_lines + INSERT outbox('order.created')  → COMMIT
Worker poller (mỗi 0.5s): SELECT outbox WHERE processed_at IS NULL FOR UPDATE SKIP LOCKED
                          → BullMQ.add(jobId=ob-<id>)  → UPDATE processed_at
BullMQ consumer: gửi email qua SMTP (Mailpit dev / Resend-SES prod). Retry + dead-letter.
```

- **Ghi outbox TRONG transaction nghiệp vụ** → transaction rollback → không có dòng
  outbox → **không email ma**. e2e chứng minh: checkout thất bại (giỏ trống) → 0 email.
- **jobId = ob-<id>** → poll lại không đẩy trùng (idempotent).
- **Payload self-contained** → `app_worker` chỉ đụng `outbox`, không đọc orders/PII.
  Bán kính ảnh hưởng cực hẹp (giống app_tls).
- **Dead-letter**: email bounce vĩnh viễn → retry (3 lần dev) → vào 'failed', không
  kẹt queue. e2e kiểm qua `worker /stats`.
- **Không tự gửi cổng 25** — dùng SMTP relay (VPS VN hay chặn 25). Dev = Mailpit.

## 3. Quản lý đơn (fulfillment)

State machine (enforce, mỗi chuyển ghi outbox 'order.status_changed'):
```
pending ──confirm──▶ confirmed ──ship(tracking)──▶ shipped ──deliver──▶ delivered
   └──────────────cancel──────────────┘  (chỉ pending/confirmed)
```
- **ship** cần `tracking_number` → tạo `shipments` + email có mã vận đơn.
- **cancel** → **RELEASE reserve** (trả lại tồn đã giữ chỗ lúc checkout). e2e chứng
  minh: reserved giảm đúng qty. Mutation "bỏ release" → e2e đỏ.
- Chuyển sai (ship đơn đã giao) → 409.
- Tất cả `orders.read`/`orders.write` (RBAC): Order Manager làm được, Catalog Manager không.

## 4. Lỗi quá trình chạy lôi ra

**Route truyền sai tham số.** `cancelOrder(res, ctx, _body, params)` nhưng route gọi
`cancelOrder(res, ctx, p)` → `params` undefined → `params[1]` ném lỗi → cancel 500.
Sửa: `(res, ctx, b, p) => cancelOrder(res, ctx, b, p)`. Chỉ lộ khi chạy thật (handler
throw), không thấy khi đọc code từng phần.

## 5. Còn thiếu (ngoài phạm vi Ngày 15)

- Consume reserved khi ship (hiện reserved chỉ release khi cancel; ship nên
  giảm on_hand + reserved). Cần bổ sung ledger 'ship' (Ngày sau).
- Email khi thanh toán QR paid (payment service ghi outbox 'order.paid').
- Retry/DLQ dashboard, requeue thủ công.
- Phí ship theo vùng (hiện flat 30k).
- Template email HTML (hiện text thuần).
