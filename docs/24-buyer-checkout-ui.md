# Buyer checkout UI (giai đoạn UI — phần 1)

> **Trạng thái: ĐÃ CHẠY.** buyer-flow e2e 15/15 (sản phẩm→giỏ→checkout→COD→QR, escape XSS).
> Không hồi quy: checkout e2e 17, worker 18, storefront 16; verify-checkout 7/7 (luồng tiền
> còn nguyên sau refactor). Rà soát đối kháng 3 chiều (xss/csrf/flow): 2 lỗi LOW đã sửa —
> (1) lookup token rò qua Referer → `no-referrer` cho trang checkout; (2) thêm giỏ cộng dồn
> vượt cap 1000 → chặn trong `cartAddCore`. Không lỗi XSS/CSRF/giá.

Giao diện mua hàng cho khách — biến storefront từ "chỉ xem" thành "mua được". Đây là thứ
CHẶN nhận đơn thật (P0-2). Trước đó backend checkout đã đủ; nay có UI.

## 1. Quyết định: SSR form thuần, KHÔNG JS

Không dựng SPA (Next.js). Dùng **HTML server-render + POST form + Post-Redirect-Get**:
- Chạy trên **mọi** máy/mạng (mobile, mạng chậm, tắt JS) — đúng khách pilot VN.
- **KHÔNG nới CSP** của storefront (vẫn `default-src 'none'`, không script) — thêm giỏ chỉ là
  `<form>` (CSP `form-action 'self'` cho phép). An toàn XSS mạnh nhất.
- QR tự cập nhật bằng `<meta http-equiv="refresh">` (không JS).
- Nâng SPA sau khi cần nhiều màn admin — không phải bây giờ (đội 2 người, ethos plain-Node).

## 2. Ai render gì (Caddy route)

Caddy route `/cart*` `/checkout*` → **checkout service**; còn lại → **storefront**. Nên:
- **Storefront** (role app_store): trang sản phẩm thêm form `POST /cart/add` (cùng origin qua Caddy).
- **Checkout service** (role app_checkout): render HTML **giỏ / checkout / kết quả đơn** (nó giữ
  dữ liệu giỏ + tạo đơn). Không dùng theme của shop (app_checkout không đọc themes) → style
  sạch, mobile-first, trung tính + tên shop (đọc được `shops.name`).

## 3. Luồng

```
Trang sản phẩm  --POST /cart/add-->  303 /cart
Trang giỏ (/cart, HTML)  --POST /cart/update (qty/xoá)-->  303 /cart
                         --> /checkout
Trang checkout (/checkout, HTML: tên/đt/email?/địa chỉ + COD|QR + idem token ẩn)
   --POST /checkout/place-->  303 /checkout/success?number&token
Trang kết quả (/checkout/success): số đơn, chi tiết; COD → badge; QR → mã QR (SVG) +
   ngân hàng/số TK/số tiền/nội dung đối soát + tự làm mới tới khi 'paid'.
```

## 4. An toàn (kế thừa + mới)

- **Giá 100% server-side** giữ nguyên: form đi qua **cùng** `createOrderTx` như API JSON (không
  tin giá client, idempotency, reserve, snapshot — verify-checkout 7/7 sau refactor).
- **CSRF**: mọi thao tác đổi giỏ/đặt đơn là **POST** + `sameOrigin` (Origin host == Host). KHÔNG
  dùng link GET để sửa giỏ (sameOrigin cho GET qua) → không CSRF qua `<img>`/prefetch.
- **XSS**: mọi giá trị (tên SP, tên khách, địa chỉ, nội dung, tên shop) đều `esc()` — kể cả trong
  thuộc tính. QR là `<svg>` nội tuyến sinh từ lib (đường path số, không markup của người dùng).
- **Truy cập đơn**: `/checkout/success` + `/checkout/order` đòi **lookup token** (so hash), không
  đoán/liệt kê được. Trang HTML: `no-store` + `noindex` + `Referrer-Policy` → không rò token.
- **Content negotiation** `GET /cart`: `Accept: text/html` → trang; khác → JSON (API/e2e vẫn chạy).

## 5. Còn thiếu (fast-follow)

- Chỉ báo số lượng giỏ ở header (cần đọc giỏ — app_store không có; hoặc thêm JS nhẹ sau).
- Nâng cấp JS tuỳ chọn: ajax thêm giỏ (không rời trang), poll trạng thái QR bằng JS thay meta-refresh.
- Order lookup UI (tra cứu đơn bằng số + token) cho khách quay lại.
- Ảnh sản phẩm/biến thể trong giỏ; chọn nhiều thuộc tính (size/màu) rõ hơn.
- Theme của shop cho trang checkout (cần cấp app_checkout đọc themes, hoặc storefront render).
