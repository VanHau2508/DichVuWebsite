# Thanh toán QR (đối soát webhook) — Ngày 14

> **Trạng thái: ĐÃ CHẠY từ cold start.**
> payment e2e: 16/16 · mutation: 3/3 · VietQR unit (vector CRC): 4/4.
> Đã qua rà soát bảo mật đối kháng — xem cuối tài liệu / `docs/16`.

Chuyển khoản QR với đối soát tự động qua webhook SePay/Casso (ADR-007). COD đã có
từ Ngày 13; đây thêm QR.

## 1. Thành phần

| Nơi | Nội dung |
|---|---|
| `0013_payment.sql` | `shop_payment_config`, `payment_transactions` (append-only), cột `orders.payment_ref/paid_at`, vai trò `app_payment` |
| `apps/checkout/src/vietqr.js` | sinh chuỗi VietQR (EMVCo TLV + CRC-16) |
| `apps/checkout/src/server.js` | checkout QR: sinh ref + QR, đơn unpaid |
| `apps/payment/src/server.js` | webhook đối soát → đặt paid |
| `apps/seller/src/payment-config.js` | owner cấu hình ngân hàng (step-up) |

## 2. Luồng

```
Checkout (payment_method=qr)
  → đọc shop_payment_config (bank_bin, account, qr_enabled)
  → sinh payment_ref duy nhất (NTG+12 hex) + chuỗi VietQR (số tiền = total)
  → đơn: unpaid, trả qr_string cho người mua quét
Người mua chuyển khoản (nội dung = payment_ref)
SePay/Casso đọc ngân hàng → POST /webhooks/sepay
  → xác thực Apikey → parse ref từ content → tìm đơn (payment_ref, xuyên shop)
  → ghi payment_transactions (UNIQUE provider_event_id) → nếu đủ tiền: paid + confirmed
```

Webhook ở **URL nền tảng cố định** (không theo domain shop) — SePay gọi một chỗ.
Tìm đơn theo `payment_ref` duy nhất toàn nền tảng (như resolve domain).

## 3. Bất biến bảo mật (ADR-007, mỗi cái có e2e + mutation)

1. **Chỉ webhook đã xác thực mới đặt paid** — `Authorization: Apikey <secret>`,
   so sánh **timing-safe**. Sai key → 401, đơn không đổi. **Không có endpoint nào
   cho trình duyệt tự đặt paid** (order lookup chỉ đọc).
2. **Đối chiếu số tiền chính xác** — `amount >= total` mới paid. Chuyển **thiếu 1000đ
   → underpaid, KHÔNG paid**. Ghi giao dịch nhưng đơn vẫn unpaid.
3. **Idempotent / chống replay** — `UNIQUE(provider, provider_event_id)`. Gửi lại
   cùng event id → `duplicate`, chỉ MỘT dòng sổ, không xử lý lại.
4. **Không lưu thông tin thẻ** — không xử lý thẻ, chỉ chuyển khoản QR.
5. **Đặt paid idempotent** — `UPDATE ... WHERE payment_status <> 'paid'`.

## 4. Vai trò `app_payment` — quyền hẹp, column-level

Webhook công khai nên role tối thiểu:
- **SELECT cột KHÔNG-PII** của orders (`id, shop_id, order_number, total_vnd,
  payment_status, payment_ref`) — column-level grant, không đọc được tên/sđt/địa chỉ.
- **UPDATE chỉ cột trạng thái** (`payment_status, paid_at, status`) — không đụng tiền.
- Tra đơn theo ref: policy `payment_read USING(true)` (xuyên shop, như resolve domain).
- Ghi/sửa: scoped theo `current_shop_id` (đặt context = shop của đơn sau khi tìm thấy).

## 5. VietQR

Chuỗi EMVCo TLV chuẩn Napas 247: payload format, dynamic (có số tiền), merchant
account (GUID napas + BIN + tài khoản + QRIBFTTA), VND (704), số tiền, VN, nội dung
= payment_ref, và **CRC-16/CCITT-FALSE**. Kiểm chứng CRC bằng vector chuẩn
(`"123456789"` → `0x29B1`).

## 6. Cấu hình thanh toán = thao tác nhạy cảm

Đặt thông tin ngân hàng nhận tiền là cấu hình tài chính → thêm perm `payment.write`
(owner-only) + **step-up** (như domain/refund/export). e2e chứng minh: chưa step-up
→ 403; sau step-up → 200.

## 7. Còn thiếu (ngoài phạm vi Ngày 14)

- Cổng online (VNPay/OnePay hosted checkout + webhook chữ ký) — cần hồ sơ doanh nghiệp.
- Seller đánh dấu paid thủ công (COD giao xong, hoặc đối soát tay).
- Release reservation khi hủy/hết hạn đơn chưa thanh toán.
- Hoàn tiền (refund) — có perm nhưng chưa có luồng.
- Trang QR trên storefront (hiển thị mã, poll trạng thái).
