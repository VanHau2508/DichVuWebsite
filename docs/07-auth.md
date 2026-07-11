# Xác thực (auth) — Ngày 4

> **Trạng thái: ĐÃ CHẠY từ cold start.**
> e2e auth: 40/40 · mutation testing: 9/9 lớp phòng thủ · crypto unit (RFC vector): 20/20.
> Đã qua rà soát bảo mật đối kháng đa tác nhân — xem `docs/08`.
> Migration runner thật thay cho `docker-entrypoint-initdb.d`.

Auth chặn mọi thứ phía sau nó, nên nó được kiểm chứng bằng cách CHẠY thật, không
chỉ viết: một dịch vụ HTTP thật, chạy đủ luồng đăng nhập/MFA/reset end-to-end,
rồi gỡ từng lớp phòng thủ để xác nhận test bắt được.

---

## 1. Thành phần

| Nơi | Nội dung |
|---|---|
| `packages/auth/src/` | crypto thuần, không state: `password` (Argon2id), `totp` (RFC 6238), `base32` (RFC 4648), `secretbox` (AES-256-GCM), `tokens`, `ratelimit` |
| `apps/auth/src/` | dịch vụ HTTP: `server.js` (route + logic), `http.js` (cookie, CSRF, đọc body) |
| `packages/db/migrations/0005_identity.sql` | users, sessions, mfa_totp, mfa_recovery_codes, password_reset_tokens, memberships + role `app_auth` |
| `packages/db/migrate.js` | migration runner forward-only, có checksum + advisory lock |

## 2. Quyết định bảo mật (mỗi cái có test)

- **Mật khẩu**: Argon2id (19 MiB, t=2, p=1 — OWASP). Không bao giờ log/trả về.
- **Phiên server-side**: token mờ 256-bit trong cookie `__Host-session`
  (`Secure; HttpOnly; SameSite=Lax; Path=/`). DB chỉ lưu `sha256(token)`.
- **MFA TOTP** tự cài, kiểm chứng bằng vector RFC 6238 & RFC 4226. Secret mã hoá
  **AES-256-GCM** bằng `MFA_ENC_KEY` (ngoài DB): rò DB không bypass được MFA.
- **Chống replay TOTP**: `mfa_totp.last_counter` — mã của một bước thời gian dùng
  một lần. (Đây là lý do e2e phải chờ sang bước kế, chạy tới ~40s.)
- **Mã khôi phục**: 10 mã, lưu `sha256`, dùng một lần.
- **Không lộ tồn tại email**: register email trùng vẫn trả 201; login/forgot trả
  thông báo chung; login luôn chạy Argon2 (kể cả khi không có user) để không rò
  qua timing.
- **Rate limit** hai trục (IP + tài khoản) qua Redis.
- **CSRF**: kiểm tra `Origin` cho mọi method đổi trạng thái + `SameSite=Lax`.
- **Đổi mật khẩu thu hồi MỌI phiên** đang sống.
- **Phiên nửa vời**: đăng nhập mật khẩu xong nhưng chưa qua MFA → `/auth/me` từ chối.

## 3. Phân tách vai trò DB

`app_auth` là role riêng, tách khỏi `app_rw`:
- `app_auth` đụng users/sessions/mfa/reset; `app_rw` **bị thu hồi** quyền trên các
  bảng này (0005 revoke tường minh vì ALTER DEFAULT PRIVILEGES ở 0003 đã cấp sẵn).
- Bảng identity không có `shop_id` → không RLS; ranh giới là "role nào được cấp
  quyền", giống `app_tls` với `domains`.
- `memberships` có `shop_id` → là bảng tenant, có RLS. `app_auth` đọc xuyên shop
  tại lúc đăng nhập qua policy `auth_lookup` (chưa có shop context).
- Audit cấp identity: `app_auth` chỉ ghi được `audit_logs` với `shop_id IS NULL`
  (policy `auth_audit`) — không nguỵ tạo được audit cho một shop.

## 4. Migration runner

Thay `docker-entrypoint-initdb.d` (chỉ chạy trên volume rỗng, không tracking):

- `schema_migrations(version, checksum, applied_at)`.
- **Checksum drift**: migration đã áp dụng mà bị sửa → dừng ngay. Migration là bất biến.
- **Advisory lock**: hai runner song song không giẫm nhau.
- Mỗi migration một transaction.
- **Forward-only** (không down migration): rollback = khôi phục backup / deploy
  lại image cũ (theo `docs/03`), migration tương thích ngược một phiên bản. Down
  migration là cơ chế rollback thứ hai, mâu thuẫn cái thứ nhất và hay sai lúc cần nhất.
- **File rỗng bị từ chối** — sau khi một artifact mountpoint 0 byte suýt được ghi
  nhận âm thầm thành migration (xem §6).

## 5. Kiểm chứng

```bash
# crypto thuần (không cần Docker) — vector RFC
node --test packages/auth/test/*.test.js

# e2e đầy đủ (trong container auth)
docker compose -f infra/compose.dev.yml exec -T auth node apps/auth/test/e2e.mjs

# mutation testing — gỡ từng lớp phòng thủ, e2e phải đỏ
bash scripts/verify-auth.sh
```

`verify-auth.sh` gỡ 8 lớp: CSRF, cookie flags, rate limit, user enumeration, TOTP
replay, recovery-code single-use, session revocation, half-session gating. Mỗi lớp
gỡ ra làm e2e chuyển đỏ — nếu không, lớp đó không được test nào canh gác.

## 6. Bốn lỗi mà quá trình CHẠY lôi ra (không phải viết)

1. **`app_auth` thiếu quyền → activate MFA lỗi 500.** Handler gọi `DELETE` trên
   `mfa_recovery_codes` khi enroll lại, mà role chỉ có SELECT/INSERT/UPDATE. Sửa
   **không** phải nới quyền mà là **vô hiệu hoá** mã cũ (`used_at = now()`) —
   giữ quyền hẹp nhất và giữ dấu vết điều tra.

2. **`DEV_RESET_TOKEN_STASH` từng gate bằng `!PROD` — fail-open.** Môi trường nào
   quên set `NODE_ENV` sẽ tự bật tính năng stash token đặt lại mật khẩu vào Redis.
   Sửa: cờ phải **bật tường minh** (`=== '1'`), mặc định tắt, và service **từ chối
   khởi động** nếu cờ bật cùng `APP_ENV=production`.

3. **File migration 0 byte suýt được ghi nhận.** Một hack mount lồng nhau trước đó
   khiến Docker tạo `packages/db/migrations/900_seed_dev.sql` rỗng trên host; runner
   chạy nó như migration no-op và ghi vào `schema_migrations`. Sửa: runner **từ chối
   file rỗng**, và seed sống ngoài `migrations/`.

4. **Hai "pass" giả trong e2e.** (a) reset-token test "pass" dù reset chưa từng chạy,
   vì nó dùng phiên nửa vời mà `/auth/me` từ chối bất kể có reset hay không — sửa
   bằng cách dựng phiên ĐẦY ĐỦ trước. (b) MFA verify test dùng lại mã đã tiêu ở bước
   activate — đó là replay protection hoạt động đúng, test sai; sửa bằng cách chờ mã mới.

## 7. Còn thiếu (ngoài phạm vi Ngày 4)

- Xoay token phiên sau khi nâng quyền MFA (hiện giữ nguyên token, chỉ đổi cờ).
- Endpoint "liệt kê / thu hồi phiên khác" cho người dùng.
- Gắn membership vào luồng đăng nhập (chọn shop) — thuộc onboarding (Ngày 6-7).
- Lockout mềm sau nhiều lần thất bại (hiện chỉ rate-limit theo cửa sổ).
- Xoay token phiên sau MFA, endpoint quản lý phiên, luồng tắt/đổi MFA có step-up
  (chặn re-enroll khi đang bật là giải pháp tạm — xem `docs/08` #8).
- Rà soát bảo mật đối kháng đã chạy: 6 lỗi thật đã sửa, 4 báo động giả bị bác bỏ
  bằng thực nghiệm. Chi tiết: `docs/08-auth-security-review.md`.
