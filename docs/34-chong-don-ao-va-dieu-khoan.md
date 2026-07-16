# 34 — Chống đơn ảo: cơ chế, điều kiện & điều khoản cho khách

Tài liệu này nêu **rõ điều kiện** của 3 lớp chống đơn ảo (griefing) để:
1. **Bạn (chủ nền tảng)** biết hệ thống chặn gì / không chặn gì.
2. **Chủ shop** hiểu vì sao thấy cảnh báo và phải làm gì.
3. Có sẵn **câu chữ điều khoản** để chủ shop dán vào trang cửa hàng / nhắc khách khi có sự cố.

> "Đơn ảo" = kẻ phá đặt hàng loạt đơn (thường COD) bằng tên/SĐT giả, không có ý mua,
> nhằm giữ tồn kho (shop hết hàng ảo), làm shop mất công gọi/giao, hoặc phá uy tín.

---

## A. Ba lớp bảo vệ — cơ chế & CON SỐ chính xác

| Lớp | Bảo vệ điều gì | Ngưỡng mặc định | Đổi ở đâu |
|-----|----------------|-----------------|-----------|
| **1. Tự huỷ đơn treo** | Đơn COD "chờ xử lý" quá lâu shop chưa xác nhận → tự huỷ, **trả lại tồn kho**. Đơn QR chưa trả quá hạn cũng tự huỷ. | COD **7 ngày** · QR **30 phút** | `COD_EXPIRY_DAYS`, `ORDER_EXPIRY_MINUTES` |
| **2. Trần đơn đồng thời** | Chặn 1 nguồn/1 SĐT dồn quá nhiều đơn **chưa xử lý** cùng lúc. Vượt trần → **HTTP 429**, không tạo đơn. | **30** đơn chờ / 1 nguồn mạng (IP) · **8** đơn chờ / 1 SĐT | `MAX_PENDING_ORDERS_PER_IP`, `MAX_PENDING_ORDERS_PER_PHONE` |
| **3. Cảnh báo cho chủ shop** | Gắn cờ ⚠ khi **một nguồn mạng có ≥4 SĐT KHÁC NHAU** đang chờ xử lý → dấu hiệu 1 kẻ giả nhiều khách. Chủ shop tự quyết huỷ/giao. | Cảnh báo khi **≥4 SĐT** cùng nguồn | Hằng `SUSPICIOUS_MIN` trong seller-admin |

**Điểm quan trọng về cơ chế (để bạn tin đường tiền/tồn kho không sai):**

- Trần ở **Lớp 2** đếm **trong cùng một giao dịch có khoá tuần tự** (`pg_advisory_xact_lock`),
  nên **không thể lách bằng cách bấm đặt hàng dồn dập cùng lúc** — các đơn cùng nguồn bị xếp
  hàng, đếm rồi mới chèn (nguyên tử). Đây là điểm hay bị hớ ở các hệ khác.
- **IP khách được băm HMAC có khoá bí mật** (`ORDER_HASH_PEPPER`), **không lưu IP thô** →
  lộ DB cũng không truy ra khách. Đổi pepper = reset toàn bộ trần theo-IP.
- **SĐT được chuẩn hoá** trước khi đếm & lưu: `0912…`, `+84912…`, `091 234…` tính là **một**
  → kẻ phá không thể lách trần bằng cách đổi định dạng SĐT.
- Cảnh báo Lớp 3 đếm **SĐT phân biệt**, không đếm số đơn thô → **không báo nhầm** khi nhiều
  khách thật dùng chung một nhà mạng/WiFi (CGNAT).
- Đơn tự huỷ (Lớp 1) chỉ áp cho đơn **thật sự chưa trả** (`payment_status = 'unpaid'`) →
  **không bao giờ huỷ nhầm đơn khách đã thanh toán**.

---

## B. ĐIỀU KIỆN khách (người mua) bị giới hạn — để nhắc khi họ gặp lỗi

Nếu một khách hàng báo **"đặt hàng báo lỗi / không đặt được"**, gần như luôn rơi vào 1 trong 2:

1. **"Số điện thoại này có quá nhiều đơn chưa xử lý"** (chạm trần 8/SĐT)
   → Khách đó (hoặc ai dùng SĐT đó) đang có **≥8 đơn shop chưa xác nhận**.
   **Cách xử lý:** chủ shop vào **Đơn hàng**, xác nhận hoặc huỷ bớt các đơn chờ của SĐT đó;
   sau đó khách đặt lại được ngay. Không cần đợi.

2. **"Quá nhiều đơn chưa xử lý từ mạng/kết nối này"** (chạm trần 30/IP)
   → Rất hiếm với khách thật. Thường là mạng công ty/quán đông người **hoặc** đúng là bị phá.
   **Cách xử lý:** xác nhận/huỷ bớt đơn chờ; nếu là mạng chung hợp lệ và cần nới, tăng
   `MAX_PENDING_ORDERS_PER_IP`.

> **Nguyên tắc vàng cho chủ shop:** trần chỉ đếm đơn **CHƯA xử lý**. Cứ **xác nhận hoặc huỷ**
> đơn kịp thời thì trần **tự giải phóng** — khách thật gần như không bao giờ chạm phải.

---

## C. Khi thấy cờ ⚠ "N SĐT cùng nguồn" — quy trình cho chủ shop

1. Mở đơn bị gắn cờ, xem **tên/SĐT/địa chỉ** có bất thường không (địa chỉ mơ hồ, SĐT không
   nghe máy, nhiều đơn nhỏ liên tiếp).
2. **Gọi xác minh trước khi giao** (đặc biệt đơn COD giá trị lớn).
3. Không liên lạc được / xác định là phá → **Huỷ đơn** ngay để **trả lại tồn kho** cho khách
   thật. (Nếu quên, đơn COD cũng **tự huỷ sau 7 ngày**.)
4. Cờ ⚠ là **gợi ý, không phải phán quyết** — nhiều khách thật chung một nhà mạng vẫn có thể
   bị gộp; luôn xác minh trước khi huỷ.

---

## D. GIỚI HẠN — hệ thống KHÔNG chặn được gì (nói thẳng với chủ shop)

- **Tấn công phân tán (botnet):** kẻ phá dùng hàng trăm IP + SĐT khác nhau, mỗi nguồn 1–2 đơn
  → **qua được** trần theo-IP/SĐT (đúng theo thiết kế). Phòng thủ thật cho trường hợp này là
  **CAPTCHA/Turnstile** ở bước đặt hàng — **chưa bật** (định hướng tương lai, xem mục E).
- **Đơn tự huỷ là im lặng:** khi đơn COD tự huỷ sau 7 ngày, hệ thống **chưa gửi email báo
  khách**. Khách thật chậm xác nhận có thể bị huỷ mà không được thông báo → nhắc chủ shop
  **xử lý đơn trong vòng 7 ngày**. (Cải tiến gửi email khi tự huỷ: xem mục E.)
- **Trần là "mềm":** nó chống spam hàng loạt, **không** thay cho việc chủ shop **gọi xác minh**
  đơn COD giá trị cao. Vẫn nên COD có chọn lọc / ưu tiên chuyển khoản QR với khách mới.

---

## E. Việc còn lại (khi có nhu cầu thực tế)

- [ ] **CAPTCHA/Turnstile** ở checkout cho khách chưa đăng nhập → chặn bot & tấn công phân tán.
- [ ] **Gửi email khi đơn tự huỷ** (nếu khách có email) → tránh huỷ im lặng đơn khách thật chậm.
- [ ] **Cho chủ shop tự chỉnh ngưỡng** trần & cờ trong trang quản trị (hiện chỉnh qua biến môi trường).

---

## F. Câu chữ ĐIỀU KHOẢN mẫu — chủ shop dán vào trang cửa hàng / nhắc khách

> **Chính sách đặt hàng & COD**
>
> - Để chống đặt hàng phá hoại, mỗi số điện thoại chỉ được có tối đa **8 đơn đang chờ xử lý**
>   cùng lúc. Vui lòng hoàn tất hoặc chờ chúng tôi xác nhận các đơn cũ trước khi đặt thêm.
> - Đơn **thanh toán khi nhận hàng (COD)** nếu quá **7 ngày** chưa được xác nhận sẽ **tự động
>   huỷ** và hoàn lại hàng vào kho. Nếu vẫn có nhu cầu mua, vui lòng đặt lại.
> - Với đơn COD giá trị lớn hoặc khách đặt lần đầu, chúng tôi có thể **gọi điện xác minh trước
>   khi giao**. Đơn không xác minh được có thể bị huỷ.
> - Đơn **chuyển khoản QR** chưa thanh toán trong **30 phút** sẽ tự huỷ; vui lòng đặt lại nếu cần.

*(Chủ shop chỉnh số ngày/số đơn cho khớp cấu hình thực tế của mình.)*

---

**Tham chiếu kỹ thuật:** trần & tự huỷ ở `apps/checkout/src/server.js` (createOrderTx),
`apps/worker/src/index.js` (sweepExpired); cờ cảnh báo ở `apps/seller/src/orders.js` +
`apps/seller-admin/src/pages.js`; biến cấu hình ở `.env.example` (mục "Chống ĐƠN ẢO").
Kiểm thử: `apps/payment/test/e2e.mjs` mục 11 (3 lớp).
