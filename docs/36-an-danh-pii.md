# 36 — Ẩn danh dữ liệu cá nhân khách mua (Luật BVDLCN 91/2025)

Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15 (hiệu lực 01/01/2026) cho người tiêu dùng
quyền yêu cầu **xoá** dữ liệu cá nhân. Nền tảng đáp ứng bằng **ẨN DANH** thay vì xoá
đơn: lịch sử doanh thu/kế toán của shop giữ nguyên, chỉ danh tính người mua bị gỡ.

## Ẩn danh làm gì / KHÔNG làm gì

| Bị gỡ | Giữ nguyên |
|---|---|
| Tên khách → `(đã ẩn danh)` | Tổng tiền, trạng thái, dòng hàng (snapshot) |
| SĐT, email, địa chỉ giao → NULL | inventory_ledger, payment_transactions |
| `client_ip_hash` → NULL | Trạng thái thanh toán, coupon, số đơn |
| Ghi chú CRM của khách (xoá) | Đơn của **shop khác** có cùng SĐT (RLS cô lập) |
| Tên trên đánh giá ĐÃ XÁC MINH | Đánh giá thường (tên tự do — không chứng minh được là khách nào) |
| `to`/`link`/`customer_name` trong outbox | |

`orders.anonymized_at` đánh dấu đã xử lý (idempotent).

## Hai đường ẩn danh

1. **Theo yêu cầu của khách** (khách liên hệ shop): chủ shop mở **Khách hàng → chi tiết
   → "Ẩn danh khách này"** (chỉ OWNER + xác nhận lại mật khẩu). Chặn nếu khách còn đơn
   đang xử lý (pending/confirmed/shipped) — cần địa chỉ để giao nốt; hoàn tất/huỷ trước.
2. **Hạn lưu trữ tự động** (opt-in): Cài đặt → "Ẩn danh đơn cũ hơn N tháng" (6–120,
   chỉ owner đổi; **trống = giữ vĩnh viễn — mặc định**). Worker quét hằng ngày, chỉ đơn
   trạng thái kết thúc (delivered/cancelled/refunded/returned).

## Giới hạn cần biết (nói thật với shop)

- **audit_logs cũ** có thể còn SĐT thô từ trước bản vá (append-only, app_rw không sửa
  được). Từ nay audit chỉ ghi SĐT che (`•••xyz`). Scrub triệt để dòng cũ cần script
  chạy tay bằng role owner — ngoài phạm vi tự động.
- **Backup mã hoá** chứa PII cho tới khi bản backup xoay vòng hết theo retention của
  chính nó (xem docs/35). Không sửa ngược file backup.
- Sau ẩn danh: khách không nhận email trạng thái nữa (không còn email), badge "đã mua"
  cho đánh giá mới không khớp được nữa — hệ quả đúng của việc xoá danh tính.

## Giấy tờ pháp lý (việc của CHỦ NỀN TẢNG, không phải code)

- **DPA** (hợp đồng xử lý dữ liệu) giữa nền tảng (bên xử lý) và từng shop (bên kiểm
  soát) — shop lớn sẽ đòi ngay khi ký.
- **Hồ sơ đánh giá tác động (ĐGTĐ)** nộp cơ quan quản lý theo quy định.
- Điều khoản riêng tư trên storefront của shop nêu quyền yêu cầu xoá + kênh liên hệ.

**Liên quan:** `apps/seller/src/customers.js` (erase) · `apps/worker/src/index.js`
(sweepPiiRetention) · migration 0064 · docs/34 (điều khoản mẫu) · docs/35 (backup).
