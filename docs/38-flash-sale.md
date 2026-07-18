# 38 — Khuyến mãi tự động / Flash sale (0082)

Giảm giá **tự động theo khung giờ** (khách KHÔNG nhập mã), phạm vi toàn shop hoặc chọn
sản phẩm. Storefront tự hiện giá sale + gạch giá gốc + badge; checkout tính giá hiệu lực
server-side rồi snapshot vào `order_lines` y như giá thường (bất biến 0002).

## Nguồn giá DUY NHẤT

Hàm SQL `promo_effective(product_id, base_price, at) → (price_vnd, promotion_id, off_pct)`
là **nguồn giá duy nhất** — storefront (thẻ lưới/PDP/related), giỏ (`summarize`), checkout
(`createOrderTx`) đều gọi CHUNG qua `LEFT JOIN LATERAL … + coalesce(pe.price_vnd, base)`.
Hiển thị và tính tiền **không thể lệch**. `SECURITY INVOKER` + RLS → cô lập theo shop.

Quy tắc: `active AND starts_at <= at < ends_at` (nửa-mở, end loại trừ) `AND (scope='all'
OR product ∈ promotion_products)`. Nhiều promo phủ 1 SP → **giảm nhiều nhất** (giá thấp
nhất), hoà → `promotion_id` nhỏ nhất (deterministic, **không cộng dồn**). percent =
`floor(base*value/100)` (khớp coupon); fixed kẹp `[0, base]`. **Không worker/cron**:
live-ness đánh giá lúc đọc — hết giờ giá tự về gốc.

## Quy tắc đường tiền

- **Snapshot lúc đặt**: `order_lines.unit_price_vnd` = giá SALE (như giá thường) →
  báo cáo lãi 0081 và doanh thu TỰ đúng. `orig_unit_price_vnd` + `promotion_id` là
  thông tin thuần, **không cộng vào bất kỳ số tiền nào**.
- **Vòng trung thực no-JS**: trang checkout nhét hidden `subtotal_seen`; `createOrderTx`
  so subtotal tính lại tại `now()` — lệch (promo bật/tắt giữa chừng) → 409 trong
  transaction → dựng lại form giá mới + thông báo. So khớp **cả hai chiều**. CẤM lặng
  lẽ tính giá khác.
- **Coupon STACK trên giá sale** (promo tầng dòng → subtotal đã sale → coupon).
  `min_subtotal` + `free_ship_threshold` xét trên subtotal đã sale.
- **compare_at_vnd nhường promo**: có promo → gạch giá gốc, badge = off_pct promo;
  hết promo → compare_at trở lại (0067).
- **ĐƠN TAY + dòng-mới-khi-sửa KHÔNG áp promo** (khác storefront) — tránh lệch tiền mặt
  COD khi nhân viên báo giá gốc mà đơn ghi giá sale (quyết định red-team money-race).

## RLS / quyền

| | app_rw (seller) | app_store | app_checkout | khác |
|---|---|---|---|---|
| promotions | CRUD | SELECT active | SELECT active | — |
| promotion_products | CRUD | SELECT | SELECT | — |

`now()` đặt trong HÀM, không trong RLS (bài học 0057: active = cổng thô ở RLS, now() =
cổng chính xác ở hàm). Quản lý: perm `catalog.read` xem / `catalog.write` sửa (owner/
admin/catalog_manager). Cap **50 promo active/shop**. Giờ nhập = datetime-local giờ VN,
parse `+07:00` tường minh (KHÔNG `new Date` naive — sẽ lệch 7h).

## Cắt v1 → v2

Đơn tay ăn sale · per-variant / danh mục · qty-cap (giới hạn suất) · lịch lặp · countdown
JS · sort/filter storefront theo giá hiệu lực (v1 theo giá gốc — HIỂN THỊ đúng, chỉ thứ
tự/lọc theo gốc) · sàn giá / chặn bán dưới giá vốn · Cache-Control theo mốc promo (v1
s-maxage=60 → hiển thị trễ ≤60s+swr; TIỀN luôn đúng nhờ subtotal_seen 409) · "khoe tiết
kiệm" trong email.
