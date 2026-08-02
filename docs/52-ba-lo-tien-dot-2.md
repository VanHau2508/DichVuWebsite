# 52 — Ba lỗ đường tiền đợt 2 (webhook nuốt tiền · điểm thưởng bốc hơi · đã-thu suy đoán)

Tiếp theo `docs/51`. Cùng cách làm: nghi ngờ từ đọc mã → **dựng lại thật** bằng
`apps/seller/test/_audit/a6-tien-repro2.mjs` → vá → test thường trực → kiểm tra đột biến.

Cả ba đều sống sót qua **91 bộ e2e xanh**, vì mỗi bộ chỉ đi đúng nhánh của nó.

---

## C. Xác nhận đơn trước khi tiền về → webhook TỪ CHỐI tiền của khách

**Triệu chứng.** Khách quét QR chuyển khoản. Webhook SePay trả
`{"matched":true,"paid":false,"reason":"order_not_live"}`. Đơn vẫn `unpaid` vĩnh viễn.
Tiền rơi vào hàng đợi đối soát, phải xử tay.

**Nguyên nhân.** `apps/payment/src/server.js` `creditOrder`:

```js
if (order.status !== 'pending') { …order_not_live… }
```

Ý định (ghi trong chú thích) là chặn **đơn chết**: đã huỷ / hết hạn / đã hoàn — vì tồn kho
đã trả về, cho sống lại sẽ oversell. Nhưng điều kiện viết ra lại bắt **mọi đơn không còn
pending**, tức gồm cả `confirmed`, `shipped`, `delivered`.

Còn `POST /orders/:id/confirm` **không hề đòi đã thanh toán** — và UI *chủ động mời* bấm:
nút "Xác nhận đơn" trên từng đơn, cộng với "Xác nhận" hàng loạt trên danh sách. Người bán
duyệt đơn mới buổi sáng; khách chuyển khoản buổi trưa. Đó là ca **thường**, không phải ca hiếm.

**Vá.**

```js
const DEAD_STATUSES = new Set(['cancelled', 'refunded', 'returned']);
const LIVE_STATUSES = ['pending', 'confirmed', 'shipped', 'delivered'];
```

và UPDATE không được kéo lùi trạng thái:

```sql
UPDATE orders SET payment_status='paid', paid_at=now(), amount_paid_vnd = $2,
       status = CASE WHEN status='pending' THEN 'confirmed' ELSE status END
 WHERE id=$1 AND payment_status <> 'paid' AND status = ANY($3)
```

`CASE` là bắt buộc: câu cũ đặt cứng `status='confirmed'`, áp lên đơn đang `shipped` là xoá
mốc đã gửi hãng.

## D. Sửa đơn có đổi điểm thưởng → tổng nhảy lên đúng số điểm khách đã tiêu

**Triệu chứng.** Đơn 826.000đ, khách đổi 50.000đ điểm → còn 776.000đ. Chủ shop sửa **địa chỉ**
(không đụng hàng) → tổng về lại 826.000đ. `points_discount_vnd` vẫn ghi 50.000 và sổ điểm
vẫn ghi đã trừ — khách vừa mất điểm vừa bị đòi lại tiền.

**Nguyên nhân.** Checkout tính `total = subtotal − discount − points_discount + shipping`,
nhưng `reconcileEditLines` (lõi dùng chung của sửa-đơn v1 và v2) tính
`total = subtotal + shipping − discount`. `points_discount_vnd` trước đó **chỉ xuất hiện 2 lần**
trong `apps/seller/src/orders.js`, cả hai đều ở danh sách cột xuất CSV.

**Vá.** Trừ điểm vào công thức, và **đọc cột thẳng từ DB trong `reconcileEditLines`** thay vì
nhận qua tham số `o`. Hai nơi gọi có câu SELECT riêng; để cột này phụ thuộc caller nhớ chọn
là dựng lại đúng cái bẫy vừa vá — quên một bên thì `?? 0` nuốt im lặng.

## E. `amount_paid_vnd` không bao giờ được ghi lúc thu tiền

**Triệu chứng.** Không có triệu chứng — cho tới khi đơn bị sửa hoặc khách trả không vừa đủ.

**Nguyên nhân.** Cả 4 đường thu tiền (`webhook`, `markPaid`, `markPaidQr`, `bulkMarkPaid`)
chỉ đặt `payment_status='paid'`. Mọi phép tính hoàn tiền dùng suy đoán lười:

```js
const collected = Number(o.amount_paid_vnd) > 0 ? Number(o.amount_paid_vnd) : Number(o.total_vnd);
```

Đúng chừng nào khách chuyển vừa đủ **và** đơn chưa từng sửa. Sai ngay khi một trong hai hỏng.

**Vá.** Ghi số thật tại điểm thu: webhook ghi `cumulative` (tổng mọi giao dịch — khách chuyển
nhiều lần, hoặc chuyển thừa, đều đúng); ba nút bấm tay ghi `total_vnd` (bấm nút = khẳng định
"đã thu đủ"). Suy đoán lười giữ nguyên cho đơn cũ.

**Migration 0134.** `GRANT UPDATE (amount_paid_vnd) ON orders TO app_payment`. Thiếu dòng này
webhook ném `permission denied for table orders` — RLS đã mở dòng nhưng GRANT chưa mở cột.
Đây là hàng rào có chủ ý từ 0013: mỗi cột webhook được ghi phải khai báo tường minh.

---

## Test thường trực + kiểm tra đột biến

| Bộ | Thêm | Đột biến gây đỏ |
|---|---|---|
| `apps/payment/test/e2e.mjs` | 4 khẳng định: đơn confirmed nhận tiền · đơn shipped nhận tiền không đi lùi · `amount_paid_vnd` = tiền thực nhận (khách chuyển 2 lần, thừa) | thêm `'confirmed','shipped'` vào `DEAD_STATUSES` → **3 FAIL** |
| `apps/seller/test/edit-order.e2e.mjs` | 2 khẳng định: sửa địa chỉ giữ nguyên tổng · đổi số lượng vẫn trừ điểm | bỏ `- pointsDiscount` → **2 FAIL** (510.000→530.000 và 780.000 ≠ 760.000) |

## Bài học lặp lại

Cùng một dạng với `docs/51`: **một luật đúng khi đọc riêng, hỏng khi luồng khác gọi vào**.
Ở đây là ba lần liên tiếp — chú thích mô tả *ý định* ("đơn đã huỷ/hết hạn/hoàn"), còn mã
thực thi một điều **rộng hơn** ý định đó. Khi chú thích liệt kê ra được tập hợp, hãy viết
tập hợp ấy thành hằng số có tên; đừng viết phủ định của một phần tử.
