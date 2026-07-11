# Theme engine & Storefront công khai — Ngày 10

> **Trạng thái: ĐÃ CHẠY từ cold start.**
> storefront e2e: 14/14 · mutation: 5/5 · app_store isolation (dbtest): 8/8.
> Không hồi quy: mọi bộ khác xanh (tenant+schema giờ 45).

Bước chuyển hướng: rời API admin, sang **trang bán hàng CÔNG KHAI** (không auth,
chỉ đọc). Thay `traefik/whoami` stub bằng dịch vụ storefront thật (SSR).

## 1. Thành phần

| Nơi | Nội dung |
|---|---|
| `0011_storefront.sql` | bảng `themes`, vai trò `app_store` (chỉ đọc) + RLS active-only/ready-only |
| `apps/storefront/src/theme.js` | escape HTML, sanitize token, section render, token→CSS |
| `apps/storefront/src/server.js` | domain→shop, tenant context, render home/product/category |
| `apps/seller/src/theme.js` | quản trị theme (GET/PUT, theme.write) |

## 2. Vai trò công khai `app_store` — quyền hẹp nhất, RLS mạnh nhất

Storefront là dịch vụ Internet-facing nên có role riêng, chỉ đọc. Điểm cốt lõi:
**RLS làm app_store KHÔNG THỂ (về cấu trúc) nhìn thấy** draft/archived/pending/shop
khác — mạnh hơn lọc trong query. Chứng minh bằng 8 test dbtest
(`storefront-isolation.test.js`):
- `store_products` policy: `USING (... status='active' AND deleted_at IS NULL)` → draft vô hình.
- `store_media`: chỉ `status='ready'`.
- `store_variants`: chỉ biến thể của sản phẩm active (EXISTS subquery).
- app_store KHÔNG ghi được gì (không có INSERT/UPDATE/DELETE grant) → 42501.

Code storefront có quên `WHERE status='active'` thì DB vẫn giấu draft.

## 3. Bốn lớp phòng thủ storefront (mỗi cái có e2e + mutation)

1. **Chỉ domain đã verified mới route** — `WHERE verified_at IS NOT NULL`. seed
   `shopb.test` (chưa verify) → 404, chống chiếm domain.
2. **Tenant context → RLS cô lập** — storefront shop A không bao giờ hiện hàng shop B.
3. **Chỉ hiện active/ready** (qua app_store RLS) — draft/media pending vô hình.
4. **escape HTML + sanitize token** — tên sản phẩm chứa `<script>` bị escape;
   token theme độc (`red;}evil{...`) bị sanitize, không breakout CSS (ADR-008).

Thêm: shop `suspended` → 503 trang bảo trì (không render sản phẩm).

## 4. Theme engine

- **Token** (màu/font/radius/spacing) lưu jsonb THÔ ở seller; **sanitize khi render**
  ở storefront (đúng lớp: lưu nguyên, làm sạch khi xuất). Token khớp mẫu an toàn
  (`#rrggbb`, size `\d+px`...) mới được áp; giá trị lạ → dùng default.
- **Section registry**: header, hero, product_grid, footer (+ product detail).
  Layout là mảng `[{section, props}]` trong theme; thiếu → layout mặc định.
- Token → biến CSS trên `:root`. Không sinh CSS động, không inline style tuỳ ý.

## 5. Cache

- Trang home/product/category → `Cache-Control: public, s-maxage=60, swr=300`.
  CDN cache theo host+path; mỗi host = một shop nên không bleed chéo shop.
- Trang 404/bảo trì → KHÔNG đặt Cache-Control (để Caddy làm chủ `no-store` trên
  `/cart` `/checkout` `/api/*`, tránh nhân đôi header).

## 6. Lỗi quá trình chạy lôi ra

**Header Cache-Control nhân đôi.** Storefront ban đầu render trang chủ cho MỌI path
lạ (kể cả `/cart`) với `public` cache, đụng với `@nocache` của Caddy → hai header.
Gốc rễ là routing sai (path lạ → home). Sửa: chỉ `/`, `/p/:slug`, `/c/:slug` là
route thật; còn lại → 404 (không đặt Cache-Control, để Caddy làm chủ).

**smoke-tls đổi cách kiểm routing.** Trước dùng `whoami` echo `Host:`; giờ storefront
đặt header `X-Shop-Slug` = shop resolve được → smoke kiểm domain→shop end-to-end
(mạnh hơn: chứng minh cả Host tới nơi lẫn resolve đúng).

## 7. Ghi chú kiến trúc

Kiến trúc gốc (docs/01) nói storefront là Next.js SSR. Ở đây là Node SSR thuần —
hợp đồng render (domain→shop→theme→sản phẩm active, escape, cô lập tenant) là như
nhau, và giữ được trong khuôn khổ kiểm chứng bằng chạy thật + mutation. Chuyển sang
Next.js sau không đổi các bất biến bảo mật.

## 8. Còn thiếu (ngoài phạm vi Ngày 10)

- Giỏ hàng/checkout (Ngày 12-13) — `/cart` `/checkout` hiện 404, Caddy đã set no-store.
- Trang nội dung/chính sách (Ngày 11) — ĐÃ LÀM, xem `docs/20` (route `/pages/:slug` + menu chân trang).
- ISR/cache dữ liệu Redis (đã `[CẮT-V1]`; SSR đủ ở quy mô pilot).
- Preview/draft theme (đã `[CẮT-V1]`).
