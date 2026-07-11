# Giỏ hàng & Checkout — Ngày 12-13

> **Trạng thái: ĐÃ CHẠY từ cold start.**
> checkout e2e: 13/13 · mutation: 5/5 bất biến luồng tiền.
> Không hồi quy: mọi bộ khác xanh.

Phần lõi thương mại và bảo mật gắt nhất. Người mua ẩn danh, guest checkout, COD.

## 1. Thành phần

| Nơi | Nội dung |
|---|---|
| `0012_cart_checkout.sql` | `carts`, `cart_items` (KHÔNG lưu giá), cột đơn hàng, vai trò `app_checkout` |
| `apps/checkout/src/server.js` | giỏ hàng + checkout (server-side pricing, reserve, idempotency) |

Caddy: `/cart* /checkout*` → `checkout:3060`; còn lại → storefront. Mỗi dịch vụ tự
đặt header cache (checkout: no-store) → không nhân đôi.

## 2. Vai trò công khai `app_checkout` — ghi đơn, quyền hẹp

Người mua ẩn danh cần GHI đơn nên có role riêng (khác `app_store` chỉ đọc):
- Đọc products/variants (active) để định giá; đọc/ghi carts, orders, order_lines,
  inventory_levels (reserve), idempotency_keys, shop_counters — đều RLS tenant-scoped.
- **KHÔNG** đụng users/memberships/audit/theme, không sửa products. Tối thiểu cho luồng mua.

## 3. Sáu bất biến luồng tiền (docs/01 §8, mỗi cái có e2e + mutation)

1. **Giá tính 100% phía server** từ `variants.price_vnd`. Client chỉ gửi
   `variant_id` + `qty`. Mọi `price`/`total`/`subtotal` client gửi bị **bỏ qua**.
   `cart_items` KHÔNG có cột giá — giá luôn tra tươi. Mutation "dùng giá client" → e2e đỏ.
2. **Tạo đơn là MỘT transaction**: khoá `inventory_levels FOR UPDATE` → kiểm tồn →
   reserve → order+lines → order_number → commit. **Đua giành đơn cuối → đúng 1 thắng,
   1 hết hàng** (chống oversell). Lỗi nghiệp vụ → throw → ROLLBACK (không reserve dở dang).
3. **Idempotency**: header `Idempotency-Key`. Giành key bằng INSERT ON CONFLICT.
   Lặp cùng key → trả đơn cũ (`idempotency-replayed: true`), không tạo đơn thứ 2.
   Key dùng lại với nội dung khác → 422.
4. **Snapshot**: `order_lines` lưu tên/sku/giá lúc mua. Đổi giá sản phẩm SAU đơn
   KHÔNG đổi giá trong đơn (test: đổi variant→999999, đơn vẫn 250000).
5. **order_number theo shop** (`shop_counters` upsert), không toàn cục. Shop B đơn
   đầu = #1 độc lập với shop A.
6. **Cart token chỉ lưu HASH** (sha256). Cookie `__Host-cart` (Secure/HttpOnly/SameSite=Lax).

Cộng: **cô lập chéo shop** (cookie giỏ shop A dùng trên domain shop B → giỏ rỗng, RLS);
**CSRF** bằng same-origin động (Origin phải cùng host với domain truy cập — không cần
allowlist tĩnh cho domain khách).

## 4. Reserve vs on_hand

- Checkout **reserve** (tăng `inventory_levels.reserved`), **không** đổi `on_hand`.
  `available = on_hand - reserved`. CHECK `reserved <= on_hand` (0009) là backstop
  chống over-reservation ở tầng DB.
- Reserve KHÔNG ghi `inventory_ledger` (ledger là chuyển động on_hand; giữ bất biến
  "tổng delta ledger == on_hand"). Khi giao hàng (sau), 'ship' giảm on_hand + reserved.

## 5. Lỗi quá trình chạy lôi ra

- **`RETURNING id` trên bảng không có cột id.** `idempotency_keys` PK là
  `(shop_id, key)`, không có `id`. Sửa: `RETURNING key`.
- **pg trả bigint dạng CHUỖI** (lại lần nữa — đã ghi từ Ngày 8). Snapshot đúng
  (`"250000"`) nhưng test so `=== 250000` (số) fail. Sửa: `Number(...)`. Đây là lý
  do chạy thật quan trọng: đọc kỹ kiểu dữ liệu, không giả định.
- **withTenant commit trên return, rollback trên throw** — lỗi nghiệp vụ (hết hàng)
  PHẢI `throw` để rollback, không `return {code:422}` (sẽ commit reserve dở dang).

## 6. Còn thiếu (ngoài phạm vi Ngày 12-13)

- **Thanh toán QR** (SePay/Casso webhook đối soát) — Ngày 14. Hiện chỉ COD.
- Trang cart/checkout HTML trên storefront (hiện API JSON; storefront có thể render form).
- Release reservation khi hủy đơn / hết hạn.
- Phí ship theo vùng (hiện flat 30k).
- Mã giảm giá (discount hiện luôn 0).
