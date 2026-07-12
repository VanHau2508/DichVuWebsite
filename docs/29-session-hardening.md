# Session hardening (A6)

> **Kiểm chứng được:** `apps/auth/test/e2e.mjs` (58/58, gồm §6 fixation + §10c list/revoke),
> `apps/seller-admin/test/admin-account.e2e.mjs` (31/31), `scripts/verify-auth.sh` mutation
> `rotate` + `sessscope`. Đã trong CI (auth e2e + mutation job).

## 1. Rotate token sau MFA (chống session fixation)

Trước: `mfa/verify` NÂNG phiên nửa-vời tại chỗ (giữ nguyên token). Kẻ cố định (fixation)
token nửa-vời trước MFA → sau MFA token đó thành phiên đầy đủ → cưỡi được.

Nay: `mfa/verify` và `mfa/activate` **ROTATE** — cấp phiên MỚI (`createSession`) rồi thu hồi
phiên cũ; trình duyệt nhận token mới qua Set-Cookie (BFF relay). Token cũ chết (`revoked_at`).

**Bền bỉ (rà soát đối kháng bắt):** tạo phiên mới TRƯỚC, thu hồi cũ best-effort. `mfa/activate`
đặc biệt: mã khôi phục chỉ hiện MỘT lần → nếu rotate lỗi vẫn PHẢI trả mã (hash đã lưu, mất là
mất vĩnh viễn) và KHÔNG đăng xuất người dùng (giữ phiên cũ — in-txn đã `mfa_satisfied=true`).

## 2. Liệt kê + thu hồi phiên

- `GET /auth/sessions` — phiên đang sống CỦA MÌNH (id, ip, user_agent, created/last_seen +
  cờ `current`). KHÔNG lộ token_hash.
- `POST /auth/sessions/revoke` `{session_id}` — thu hồi MỘT phiên, **scope `WHERE id=$1 AND
  user_id=$2`** → không thu hồi được phiên người khác (IDOR). `session_id` validate UUID.
- `POST /auth/sessions/revoke-others` — "đăng xuất mọi thiết bị khác" (giữ phiên hiện tại).
- Tất cả đòi phiên ĐẦY ĐỦ (isFullyAuthed). Phiên bị thu hồi → request kế tiếp của nó 401.
- BFF: thẻ **"Phiên đăng nhập"** ở trang Tài khoản (`/account`) — nút Thu hồi từng phiên +
  Đăng xuất mọi thiết bị khác. user_agent/ip đều `esc()` (chống XSS qua User-Agent).

## 3. Bất biến (mutation-tested — `verify-auth.sh`)

- `rotate`: nâng token tại chỗ thay vì rotate → auth e2e §6 "token nửa-vời cũ chết" đỏ.
- `sessscope`: bỏ `AND user_id=$2` khi revoke → thu hồi được phiên user khác → §10c đỏ.

## 4. Ảnh hưởng client

Rotate làm token đổi sau MFA → **mọi client theo dõi phiên phải lấy cookie MỚI** từ Set-Cookie
của `mfa/verify`/`activate`. BFF đã relay. (~22 e2e helper `makeStaff` đã sửa để bắt cookie mới.)
