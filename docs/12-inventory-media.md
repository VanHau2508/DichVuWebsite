# Tồn kho & Media — Ngày 9

> **Trạng thái: ĐÃ CHẠY từ cold start.**
> inventory e2e: 11/11 + mutation 3/3 · media e2e: 9/9 + mutation 3/3.
> Không hồi quy: catalog 29, seller 25, onboarding 28, auth 40, tenant 37, TLS 35.

Hai tính năng gắn vào catalog: tồn kho theo biến thể, và ảnh sản phẩm.

## A. Tồn kho

| Nơi | Nội dung |
|---|---|
| `0009_inventory.sql` | `inventory_levels` (on_hand/reserved), `inventory_ledger` (append-only), RLS |
| `apps/seller/src/inventory.js` | GET level, POST adjust, GET ledger |

**Bất biến (mỗi cái có test + mutation):**
- **Điều chỉnh NGUYÊN TỬ**: `SELECT ... FOR UPDATE` khoá dòng level → 20 điều chỉnh
  `+5` đồng thời cho ra **đúng +100**, không mất cập nhật. Đây là bằng chứng chống
  oversell/undersell khi nhiều request cùng chạm một biến thể.
- **on_hand không âm** (422 khi giảm quá tồn); **không dưới reserved** (CHECK DB backstop,
  quan trọng cho reserve lúc checkout Ngày 12-13).
- **Ledger khớp on_hand**: tổng delta ledger == on_hand luôn đúng.
- **Ledger append-only**: `app_rw` bị REVOKE UPDATE/DELETE → sửa ledger = 42501.

## B. Media (ảnh sản phẩm)

| Nơi | Nội dung |
|---|---|
| `0010_media.sql` | `media` (pending/ready/failed, private+public key), RLS |
| `apps/seller/src/media.js` | upload → validate → private → re-encode → public |
| compose | service `minio` (MinIO) + buckets `media-private` / `media-public` |

**Luồng:** upload → kiểm magic byte → bản gốc vào bucket **private** (pending) →
re-encode WebP (sharp) → vào bucket **public** (ready).

**Bất biến bảo mật (mỗi cái có test + mutation):**
- **Kiểm magic byte, KHÔNG tin Content-Type** — file `MZ...` khai `image/png` → 400.
- **Bản gốc ở bucket PRIVATE** — truy cập ẩn danh → 403. Chỉ WebP đã xử lý lên PUBLIC.
- **Re-encode STRIP payload nhúng** — PNG + đuôi rác `SECRET_...` → WebP đầu ra
  KHÔNG còn chuỗi rác. sharp giải mã ảnh rồi mã hoá lại, bỏ mọi byte thừa/metadata.
- **Giới hạn 10MB** — quá cỡ → 413 (từ chối theo Content-Length + cap khi streaming).

**Ghi chú kỹ thuật:**
- sharp cài được trên node:22-alpine (binary musl dựng sẵn).
- Xử lý **INLINE** trong request (MVP). Kiến trúc đích (docs/01 §10) đẩy sang worker
  + outbox; hợp đồng bất biến private→public giữ nguyên khi chuyển.
- `MEDIA_PUBLIC_BASE`: dev là MinIO nội bộ; prod là CDN (cdn.nentang.vn).
- Bản gốc private KHÔNG có bucket policy → MinIO từ chối ẩn danh. Chỉ public bucket
  có policy `s3:GetObject` cho `*`.

## C. Lỗi quá trình chạy lôi ra

**Oversize upload → ECONNRESET thay vì 413.** `readBuffer` gọi `req.destroy()` khi
vượt cỡ, huỷ socket trước khi 413 kịp gửi → client nhận reset. Sửa: (1) từ chối
nhanh theo `Content-Length`, (2) bỏ `req.destroy()`, cap khi streaming, (3) gửi 413
kèm `Connection: close` để đóng gọn.

**Redis rate-limit tích luỹ làm mutation harness đỏ giả** (lặp lại bài học Ngày 6/7):
media harness chạy e2e 6 lần, mỗi lần vài login từ cùng IP → 429 → e2e đỏ ở lần cuối
dù đã hoàn nguyên. Sửa: flush redis trước mỗi lần chạy e2e trong harness.

## D. Còn thiếu (ngoài phạm vi Ngày 9)

- Đẩy re-encode sang worker + outbox (hiện inline).
- reserve/release tồn kho khi checkout — Ngày 12-13.
- Nhiều biến thể/ảnh: gán ảnh cho biến thể cụ thể (hiện ảnh gắn ở cấp sản phẩm).
- Sinh nhiều kích thước (thumbnail) — hiện một WebP tối đa 1600px.
