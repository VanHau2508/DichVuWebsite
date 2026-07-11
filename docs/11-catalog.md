# Catalog — Ngày 8

> **Trạng thái: ĐÃ CHẠY từ cold start.**
> catalog e2e: 29/29 · mutation: 5/5 bất biến.
> Không hồi quy: seller 25, onboarding 28, auth 40, tenant 36, TLS 35, unit 28.

Sản phẩm, biến thể, danh mục — CRUD đầy đủ trong seller-admin. `products`/`variants`
đã có sẵn từ 0002 (kèm RLS + composite FK); Ngày 8 thêm `categories` +
`product_categories` và toàn bộ handler, thay hai stub `/catalog` `/orders`.

## 1. Thành phần

| Nơi | Nội dung |
|---|---|
| `packages/db/migrations/0008_catalog.sql` | `categories`, `product_categories` (composite FK), cột `description`/`variants.title/position`, index list/lọc, RLS |
| `apps/seller/src/catalog.js` | handler products/variants/categories + `CATALOG_ROUTES` |
| `apps/seller/src/db.js` | `db` + `withTenant` + `audit` tách ra dùng chung |

## 2. Endpoint (đều qua withTenant + RBAC)

- `GET /shops/:id/products` — list, phân trang (`limit`≤100, `offset`), tìm `q` (ILIKE), lọc `status` — `catalog.read`
- `POST /shops/:id/products` — tạo sản phẩm + biến thể + gắn danh mục — `catalog.write`
- `GET|PATCH|DELETE /shops/:id/products/:pid` — chi tiết / sửa / xoá mềm
- `POST .../publish` `.../archive` — chuyển trạng thái draft↔active↔archived
- `POST|DELETE .../variants[/:vid]` — thêm / xoá biến thể
- `GET|POST /shops/:id/categories` — danh mục

## 3. Bảy bất biến (mỗi cái có e2e + mutation)

- **SKU/slug duy nhất TRONG shop** nhưng **lặp được across shop** — tenant-scoped
  (`UNIQUE(shop_id, sku)`). e2e chứng minh shop B dùng lại SKU của shop A → 201.
- **Composite FK chặn gắn danh mục shop khác** — `(shop_id, category_id)` → 23503 → 400.
- **Tiền là bigint VND ≥ 0** — validate ở app + CHECK ở DB. (Lưu ý: API trả
  `price_vnd` dạng **chuỗi** — pg trả bigint as string để không mất chính xác. Đúng.)
- **Sản phẩm có ≥ 1 biến thể** — tạo với mảng rỗng → 400; không xoá được biến thể cuối → 409.
- **Trạng thái** draft → active → archived; **soft delete** (deleted_at, không xoá cứng).
- **Validation** — tiêu đề rỗng, giá âm/không nguyên, slug sai, SKU trùng trong payload → 400.
- **Cô lập tenant** — list chỉ trả sản phẩm của shop hiện tại (RLS). Mutation "đặt
  sai tenant context" làm e2e đỏ → chứng minh RLS đang gánh việc.

## 4. Kiểm chứng

```bash
docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/catalog.e2e.mjs
bash scripts/verify-catalog.sh   # mutation 5/5
```

## 5. Còn thiếu (ngoài phạm vi Ngày 8)

- Tồn kho (inventory_level, ledger) — Ngày 9. `variants` chưa gắn số lượng tồn.
- Media/ảnh sản phẩm (upload, re-encode, private→public) — Ngày 9.
- Chỉ mục trigram (pg_trgm) cho tìm kiếm — hiện ILIKE seq-scan, đủ ở quy mô pilot.
- Cập nhật biến thể (PATCH) và gán/gỡ danh mục sau khi tạo — hiện gán lúc tạo.
- Storefront đọc sản phẩm active (public, không auth) — Ngày 10.
