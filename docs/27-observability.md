# Observability: readiness/liveness + request-id (A2)

> **Kiểm chứng được:** `scripts/smoke-readiness.sh` (9 service × livez/readyz/healthz = 200),
> `scripts/verify-readiness.sh` (dừng Postgres → livez 200 + readyz 503, khởi động lại → 200).
> Cả hai đã vào CI (smoke ở job e2e, verify ở job mutation nightly).

## 1. Ba đường sức khoẻ

Mỗi service (helper `src/obs.js`, bản sao đồng bộ — service không share `packages/` do
build context bó trong thư mục app):

| Đường | Ý nghĩa | Phụ thuộc | Dùng cho |
|---|---|---|---|
| `/livez` | Tiến trình còn sống | KHÔNG | healthcheck orchestration (đừng để DB chớp gây restart oan) |
| `/readyz` | Sẵn sàng nhận tải | DB `SELECT 1` (+ Redis `PING` ở auth/worker) | load balancer thêm/rút backend |
| `/healthz` | = livez (giữ tương thích) | KHÔNG | healthcheck compose/Caddy hiện có (KHÔNG đổi) |

- `/readyz` trả `{ready, checks:{db:'ok'|'fail',...}}`, mã **503** nếu bất kỳ check hỏng.
- **Mỗi check có timeout 2s**: probe phải trả lời nhanh; phụ thuộc kẹt (vd DNS `postgres`
  không phân giải → `getaddrinfo` retry vài giây) → readyz 503 ngay, không treo.
- **seller-admin** là BFF không sở hữu DB → `/readyz` không có check → luôn 200 (readiness = liveness).

**Healthcheck vẫn trỏ `/healthz` (liveness), KHÔNG phải `/readyz`.** DB chớp một nhịp không
nên khiến container bị đánh dấu unhealthy rồi restart; readiness là việc của load balancer.

## 2. Request-id (correlation)

- Mỗi request: lấy `x-request-id` từ header nếu hợp lệ (`[A-Za-z0-9._-]{1,128}`), else sinh
  UUID. Lưu trong `AsyncLocalStorage` → `makeLog()` tự gắn `rid` vào MỌI log request-scoped
  mà không phải luồn tham số qua từng hàm. Đặt lại vào header phản hồi `x-request-id`.
- Log nền (poller, startup) không có request → không có `rid` (đúng ngữ nghĩa).
- **BFF forward** `x-request-id` xuống backend (`seller-admin/src/api.js`) → một request admin
  và các lời gọi seller/auth/platform của nó dùng CHUNG một `rid` (lần vết xuyên service).

## 3. Bền bỉ khi phụ thuộc sập

Gate readiness lộ ra một lỗ hổng có sẵn: worker poller gọi `db.connect()` NGOÀI `try` →
Postgres sập → reject lọt ra `setInterval` → `unhandledRejection` → crash-loop (hỏng luôn
liveness). Đã sửa: `connect()` vào trong `try` ở cả `poll()` và `sweepExpired()` → DB sập chỉ
log lỗi + bỏ nhịp, tiến trình sống → `/livez` vẫn 200.
