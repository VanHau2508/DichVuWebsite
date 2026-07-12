# Xuất dữ liệu (A4)

> **Kiểm chứng được:** `apps/seller/test/export.e2e.mjs` (22/22), `apps/seller-admin/test/admin-export.e2e.mjs` (13/13),
> `scripts/verify-export.sh` (mutation 6/6). Đã vào CI (e2e + mutation).

## 1. Điều gì

Chủ cửa hàng (owner) tải TOÀN BỘ dữ liệu shop dạng ZIP nhiều CSV: `products`, `variants`
(kèm tồn kho), `orders`, `order_lines`, `customers` (suy từ đơn), `media_manifest` (URL ảnh,
không kèm file), `README.txt`.

## 2. Gate (owner + step-up + audit + link hết hạn)

- **owner-only + step-up**: route seller khai báo `perm: 'export', stepUp: true`. Chỉ vai trò
  `owner` có perm `export` (RBAC), và cần xác thực lại mật khẩu <5' (step-up). Không thêm cờ
  `ownerOnly` — "owner-only" = perm chỉ owner giữ (giống members.write). BFF mirror bằng
  interstitial mật khẩu rồi resume.
- **audit**: `export.created` ghi trong cùng transaction (kèm counts + bytes).
- **link tải HẾT HẠN**: token ngẫu nhiên 256-bit, lưu **hash** (sha256) + `expires_at` (15').
  Hết hạn cưỡng chế Ở RLS (`export_read USING expires_at > now()`) → token quá hạn/khác shop
  DB tự giấu → tải về 404. Tải đi QUA seller đã xác thực (owner + token), **không** presigned
  URL (MinIO nội bộ, giữ ranh giới "bucket private không đọc ẩn danh").

## 3. Kỹ thuật

- **ZIP zero-dep** (`apps/seller/src/zip.js`): tự ghi định dạng ZIP (deflate) — CRC32 tự cài,
  nén BẤT ĐỒNG BỘ (`deflateRaw` promisified) để KHÔNG chặn event loop chung của seller.
- **Lưu**: ZIP vào bucket PRIVATE `media-private` dưới prefix `exports/<shop>/<id>.zip`. Lifecycle
  S3 tự **xoá sau 1 ngày** (không giữ PII vô hạn) — chỉ prefix `exports/`, ảnh gốc không đụng.
- **CSV cứng**: RFC 4180 (quote `",\r\n`) + **BOM UTF-8** (Excel đọc đúng tiếng Việt) + **chống
  formula injection** (chèn `'` trước ô bắt đầu `= + - @ TAB CR LF`). Thời gian **ISO-8601 UTC**.
  `shipping_address` giữ TRỌN (object → JSON đầy đủ). `customers.paid_total_vnd` chỉ tính đơn đã
  thanh toán.
- **Giới hạn**: trần `EXPORT_MAX_ROWS` (mặc định 200k tổng dòng) → vượt thì 413 (shop khổng lồ
  cần xuất bất đồng bộ — ngoài MVP). Rate-limit 3 bản xuất/phút/shop (429). KHÔNG lộ bí mật
  (`lookup_token_hash`/`token_hash`/`original_key`).

## 4. Bất biến (mutation-tested)

Gỡ bất kỳ cái nào → e2e đỏ: owner-only khi TẠO, step-up khi TẠO, owner-only khi TẢI, kiểm token
khi TẢI. Hết hạn token do RLS (kiểm ở e2e §6: token hết hạn/khác shop → 404).
