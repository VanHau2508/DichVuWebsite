# Kiểm thử vận hành + Go/No-Go — Ngày 19-20

> **Trạng thái: VERDICT GO** (từ cold start sạch).
> 13/15 tiêu chí tự động ĐẠT; 2 tiêu chí là quyết định người (#11 alert, #14 UAT).

Cổng cuối trước khi chạy khách thật: diễn tập vận hành (backup/restore, resilience)
+ quyết định go/no-go dựa 15 tiêu chí (docs/01 §7, docs/03).

## 1. Diễn tập backup → restore (`scripts/backup-restore-drill.sh`)

Bằng chứng KHÔI PHỤC ĐƯỢC, không chỉ "có file backup" ("backup chưa restore thử
không phải là backup").

```
pg_dumpall (roles+schema+data) → postgres MỚI, TRỐNG → restore → KIỂM CHỨNG
```

Sau restore vào cluster mới, xác nhận **còn nguyên**: số shops/orders khớp, 65 RLS
policies, 9 vai trò DB, FORCE RLS trên products/orders/order_lines/memberships,
app_rw vẫn NOBYPASSRLS, và **cô lập tenant thực sự hoạt động** (app_rw đặt context
shop A chỉ thấy 1 shop). 11/11 PASS. → tiêu chí #6.

## 2. Diễn tập resilience — Redis DOWN không làm sập auth

**Phát hiện Ngày 19:** Redis down → `hit()` (rate limit) ném lỗi → login **500**
(sập). Session ở Postgres, không phụ thuộc Redis, nên sự cố Redis KHÔNG NÊN làm
sập đăng nhập.

**Sửa:** rate limit **fail-open** khi Redis lỗi (rate limit là lớp BẢO VỆ, không
phải tính đúng đắn). `hit()` bắt lỗi → trả `allowed:true, degraded:true`; client
Redis đặt `enableOfflineQueue:false` + `commandTimeout` → lệnh reject NHANH thay
vì treo. Đánh đổi: chống brute-force tạm giảm trong cửa sổ sự cố Redis (Argon2 vẫn
là sàn tự nhiên); đổi lại đăng nhập/checkout không sập vì một blip Redis.

Kiểm chứng: Redis DOWN → login **200** (trước: 500). Redis UP lại → 200. Auth e2e
vẫn 40/40 (rate limit hoạt động bình thường khi Redis lên).

## 3. Rollback + migration

- **Migration forward-only** (`migrate.js`): mỗi migration MỘT transaction → lỗi
  giữa chừng rollback sạch. Checksum chống drift, từ chối file rỗng. Rollback =
  khôi phục backup (đã diễn tập) hoặc deploy lại image cũ (đổi TAG).
- Migration tương thích ngược một phiên bản (docs/03) → rollback application an toàn.
- → tiêu chí #7 (chứng minh qua backup drill + thiết kế runner).

## 4. Cổng Go/No-Go (`scripts/go-no-go.sh`)

Chạy `scripts/ci-local.sh` đầy đủ trước, sau đó mới chạy các bộ kiểm ánh xạ tới 15 tiêu chí
và kiểm chứng SQL riêng. Script chỉ được in `GO` khi full CI của chính lượt đó đã qua; việc
dọn rate-limit chỉ xoá khóa `rl:*`, không xoá toàn bộ dữ liệu Redis.

| # | Tiêu chí | Trạng thái | Nguồn |
|---|---|---|---|
| 1 | Không lỗi cross-shop | **GO** | tenant suite (45 test) |
| 2 | RLS FORCE mọi bảng nghiệp vụ | **GO** | SQL check |
| 3 | MFA (owner + platform admin) | **GO** | auth e2e (40) |
| 4 | Checkout không tin giá client | **GO** | checkout e2e (17) |
| 5 | Idempotency đơn + payment | **GO** | checkout e2e |
| 6 | Backup khôi phục môi trường mới | **GO** | backup drill (11) |
| 7 | Rollback (forward-only + backup) | **GO** | design + drill |
| 8 | Domain chỉ chạy sau verify | **GO** | storefront + tls |
| 9 | Upload không public trước kiểm | **GO** | media e2e (9) |
| 10 | Audit thao tác nhạy cảm | **GO** | audit_logs |
| 11 | Alert lỗi prod tới người trực | **MANUAL** | Telegram bot chưa dựng |
| 12 | Trang trạng thái/bảo trì | **GO** | suspended → 503 |
| 13 | Hợp đồng + chính sách + suspend | **GO** | docs + drill |
| 14 | 3 shop pilot đã UAT | **MANUAL** | cần người thật |
| 15 | Không còn Critical/High | **GO** | security-scan + docs/18 |

**Bảng trên là kết quả lịch sử, không phải chứng nhận cho worktree hiện tại.** Mỗi release
candidate phải chạy lại cổng; chỉ output mới có dòng `VERDICT: GO` sau full CI mới là bằng
chứng cho chính mã nguồn đang chuẩn bị phát hành. Còn lại là quyết định người.

## 5. Việc người PHẢI làm trước khi mời khách (không code được)

- **#11 Alert on-call**: dựng bot Telegram/Zalo nhận cảnh báo (5xx, checkout fail,
  webhook sai chữ ký, dead-letter, WAL archive fail, uptime từ ngoài). Runbook: docs/03 §7.
- **#14 UAT khách thật**: tạo 3 shop pilot, nhập dữ liệu thật, cho người NGOÀI đội
  dev dùng, kiểm trên điện thoại thật, diễn tập khoá/mở + export.
- **Hạ tầng**: **floating IP** (ADR-004, không sửa được sau), VPS + backup offsite
  (B2), SMTP relay thật (Resend/SES), secret manager (không devpassword).
- **Pháp lý**: hợp đồng, chính sách dữ liệu (Nghị định 13/2023), quy trình suspend.

## 6. Tổng kết kỹ thuật (kế hoạch 20 ngày)

9 dịch vụ Node thuần sau Caddy, PostgreSQL RLS multi-tenant, mỗi dịch vụ một vai
trò DB tối thiểu. ~300 test e2e + ~50 mutation + hai rà soát đối kháng đa tác nhân,
qua 15 migration. Mọi tính năng kiểm chứng bằng **chạy thật + mutation testing**,
không chỉ viết. Còn thiếu (đã ghi rõ): trang nội dung/chính sách (Ngày 11), CI thật,
đẩy re-encode/email sang worker hoàn chỉnh, VNPay (cần hồ sơ DN).
