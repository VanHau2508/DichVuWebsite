# Hai lỗ MẤT TIỀN ở nhánh đổi-trả và sửa-đơn (2026-08-03)

> **Kiểm chứng được:** `apps/seller/test/returns-rma.e2e.mjs` (11/11) ·
> `apps/seller/test/edit-paid-order.e2e.mjs` (17/17). Cả hai khẳng định mới đã
> **mutation-check**: gỡ bản vá ra thì đỏ ngay với đúng con số của lỗi thật.

## Tìm ra thế nào

91/91 bộ e2e xanh, 2.225 khẳng định, và **cả hai lỗi vẫn sống**. Chúng lọt vì mỗi test chỉ
kiểm nhánh của mình: `returns-rma` luôn dựng đơn ĐÃ trả tiền; `edit-paid` không bao giờ gọi
`/refund` sau khi sửa. Không ai ghép hai luồng lại.

Quy trình: 4 agent đọc nguồn song song → săn "lỗi KẾT HỢP" (luật đúng riêng lẻ, vỡ khi luồng
khác gọi tới) → **32 nghi vấn** → tôi xác minh từng cái trong mã nguồn → **dựng lại thật** hai
cái nặng nhất → vá → mutation-check.

**Phân tích KHÔNG phải bằng chứng.** Cùng đợt đó tôi bác 6 nghi vấn giao diện vì đo lại thấy sai.

---

## LỖ 1 — nhận trả hàng cho đơn khách CHƯA TRẢ ĐỒNG NÀO

`createReturn` ([orders.js:1092](../apps/seller/src/orders.js#L1092)) chỉ có **một** guard:
`if (o.status !== 'delivered')`. Nó *đọc* `payment_status` nhưng không kiểm. Trong khi
`refundOrder` — cùng một bất biến — thì có.

**Dựng lại (đã chạy thật):**
```
đơn COD 627.000₫ · confirm → ship → deliver · KHÔNG bấm "Đã nhận tiền"
  payment_status=unpaid · amount_paid_vnd=0        ← khách chưa trả đồng nào
POST /shops/{sid}/orders/{oid}/return  {lines:[{variant_id, qty:1}], restock:true}
  → HTTP 200
  → refunds: +199.000₫
  → orders.amount_paid_vnd := 627000               ← số BỊA, neo vĩnh viễn
```
Người bán làm theo màn hình là **chuyển tiền thật** cho người chưa trả gì.

**Vá:** đòi `payment_status='paid'`, và câu lỗi chỉ đúng công cụ thay thế — hàng bị bom thì
dùng **"Đánh dấu hoàn về"** (`mark-returned`) để nhập lại kho, không phải RMA.

---

## LỖ 2 — sửa đơn đã trả rồi hoàn nốt: TRỪ ĐÚP, shop giữ tiền khách

`editPaidOrder` làm **hai** việc: ghi phiếu `kind='edit_adjustment'` **và** hạ `orders.total_vnd`
xuống tổng mới. Khoản chênh vì thế đã được trừ **một lần** ở `total_vnd`.

`refundOrder` ([orders.js:611](../apps/seller/src/orders.js#L611)) lại tính:
```
already   = Σ refunds  (KHÔNG lọc kind)   ← đếm luôn edit_adjustment
remaining = o.total_vnd (ĐÃ hạ) − already ← trừ lần thứ hai
```

**Dựng lại (đã chạy thật):**
```
khách trả                1.025.000₫
sửa xuống 3 món      →   total 627.000₫ + phiếu edit_adjustment 398.000₫   ✓ đúng
bấm "hoàn toàn bộ"   →   chỉ hoàn 229.000₫   (627.000 − 398.000)
                          đúng phải hoàn 627.000₫
SHOP GIỮ LẠI 398.000₫ của khách · đơn khoá 'refunded'
hoàn lần nữa         →   409 "chỉ hoàn được đơn đã thanh toán"   ← NGÕ CỤT
```

**Vá:** `already` loại `kind='edit_adjustment'`. Thêm `status='returned'` vào guard cuối —
thiếu nó thì nút Hoàn tiền vẫn hiện trên đơn đã trả hàng, bấm vào là ghi đè `'refunded'` và
đơn biến mất khỏi bộ lọc "Hoàn hàng".

---

## Quy tắc rút ra

> **Một cột tiền chỉ được trừ ở ĐÚNG MỘT nơi.** `edit_adjustment` vừa hạ `total_vnd` vừa nằm
> trong `refunds` — hai lần ghi cho một sự kiện, và phép trừ nào đọc cả hai là sai.

> **Bất biến giống nhau phải nằm cùng một chỗ.** `refundOrder` có guard `payment_status`,
> `createReturn` không — chép luật bằng tay thì sớm muộn cũng lệch.

## Còn nợ (workflow chỉ ra, CHƯA xác minh bằng chạy thật)

- `amount_paid_vnd` không được ghi lúc THU tiền (webhook/markPaid/markPaidQr đều không ghi) —
  "đã thu" đang bị suy đoán từ `total_vnd`.
- `reconcileEditLines` bỏ quên `points_discount_vnd` → sửa đơn có đổi điểm làm tổng nhảy lên.
- `creditOrder` guard `status !== 'pending'` nuốt luôn `confirmed/shipped/delivered` —
  xác nhận đơn trước khi tiền về thì webhook từ chối tiền.
