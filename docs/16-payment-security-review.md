# Rà soát bảo mật thanh toán (đối kháng, đa tác nhân)

> Workflow 5 chiều review → thẩm định đối kháng. 4 phát hiện thô → **1 confirmed
> (high)**. Đã sửa + thêm test + mutation.

## Lỗ hổng THẬT đã sửa (high)

**Webhook đánh dấu paid mà không kiểm tiền vào đúng tài khoản của shop.**

Webhook cũ đặt `paid` chỉ dựa trên: `payment_ref` khớp (tra xuyên shop) + `amount >= total`.
Nó **bỏ qua** tài khoản nhận tiền mà SePay báo. Vì mỗi shop khai tài khoản ngân hàng
RIÊNG (QR trỏ thẳng vào tài khoản từng shop), việc tiền vào tài khoản nào là quan trọng.

**Kịch bản khai thác:**
1. Kẻ tấn công đăng ký làm seller Shop A, khai **tài khoản của chính mình**.
2. Với tư cách người mua ẩn danh ở Shop B (hàng đắt), checkout QR → nhận `ref_Y` + `total_Y`.
3. Chuyển `total_Y` vào **tài khoản của chính mình** (Shop A), nội dung = `ref_Y`.
4. SePay thấy tiền vào tài khoản Shop A → gọi webhook `{content: ref_Y, amount: total_Y}`.
5. Webhook tìm đơn Y (ref UNIQUE toàn nền tảng), đủ tiền → đặt **đơn Shop B** = paid.
6. Shop B thấy đã thanh toán → giao hàng. Kẻ tấn công rút lại tiền của mình.
7. → Nhận hàng miễn phí của Shop B; Shop B không hề nhận tiền.

**Sửa** (migration 0014 + checkout + webhook):
- Checkout QR **snapshot tài khoản nhận** (`orders.qr_account = shop_payment_config.account_number`).
- Webhook đọc tài khoản SePay báo (`subAccount`/`accountNumber`), so khớp với
  `order.qr_account`. Không khớp → **không paid** (`account_mismatch`).
- e2e mục 4b + mutation `account` cưỡng chế: gỡ ràng buộc → e2e đỏ.

## Vì sao review này quan trọng

Behavioral test + mutation của tôi phủ: sai key, thiếu tiền, replay, ref lạ, QR chưa
cấu hình. **Không cái nào nghĩ tới "tiền vào tài khoản khác"** — vì tôi coi ref +
amount là đủ. Đây đúng là loại lỗi mà rà soát đối kháng bắt được: một giả định ngầm
(ref là bằng chứng thanh toán duy nhất) sai trong mô hình mỗi-shop-một-tài-khoản.

## Bác bỏ (verifier kết luận real=false — đồng ý)

- **payment_ref entropy 48-bit / đoán được**: không khai thác — đặt paid vẫn cần
  chuyển tiền THẬT + đúng tài khoản (sau khi sửa) + đủ số tiền.
- **ref không unique / va chạm chéo shop**: `orders.payment_ref` là UNIQUE toàn cục.
- **regex first-match nhiều mã trong content**: chỉ khớp một ref hợp lệ; vẫn cần
  tiền thật vào đúng tài khoản.
