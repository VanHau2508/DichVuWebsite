# Rà soát P0 (đánh giá ngoài) + vá P0-4 / P0-3 / P0-5

> **P0-4 (chiếm shop): ĐÃ VÁ** — takeover e2e 9/9 (trước vá 4/9) · mutation 2/2 · migration 0020.
> **P0-3 (siết app_rw): ĐÃ VÁ** — schema-invariant đỏ→xanh (14/2→16/0) · migration 0021.
> **P0-5 (tồn kho khép kín): ĐÃ VÁ** — worker e2e 18/18 · mutation 6/6 · migration 0022 (role app_expiry).
> Không hồi quy: onboarding 28, seller 25, auth 40, checkout 17, tenant-isolation 23. Tất cả verify-first.

Một bản đánh giá ngoài chấm hệ thống và nêu 8 phát hiện P0 + nhiều P1. Ta **kiểm chứng
từng phát hiện trong code** trước khi hành động — không vá cái đã vá, ưu tiên cái thật.

## 1. Kết quả kiểm chứng các P0 (đọc code, không tin claim)

| P0 | Claim | Ground truth | Kết luận |
|---|---|---|---|
| **P0-4** chiếm lời mời | accept gắn membership vào user có sẵn theo email, không đòi sở hữu | `acceptInvitation` ([auth server.js](../apps/auth/src/server.js)) đúng như mô tả — bỏ qua mật khẩu khi user tồn tại | ✅ **THẬT, critical → đã vá (mục 2)** |
| **P0-3** `app_rw` quá rộng | app_rw ghi được users/sessions/platform_staff/plans... | 0005 **đã REVOKE ALL** users/sessions/mfa/reset khỏi app_rw; tenant tables có RLS. Còn hở: `platform_staff`, `plans` (không RLS, không revoke), `subscriptions` (RLS own-shop → seller tự sửa gói) | ⚠️ **Nửa đúng** — hở thật hẹp hơn nhiều. Việc kế tiếp |
| **P0-5** tồn kho chưa khép | ship không consume on_hand/reserved/ledger; QR chưa trả tiền không hết hạn | Đúng (đã ghi chú từ Ngày 15) | ✅ **THẬT** — việc kế tiếp |
| **P0-6** devpassword trong migration | role tạo với PASSWORD 'devpassword' | 0003:15 đúng | ✅ thật (làm cứng production) |
| **P0-7** build không tái lập | không lockfile, Dockerfile dùng npm install | đúng | ✅ thật |
| **P0-1/P0-2** edge + UI | Caddy route tới service không tồn tại; chưa có UI | đúng — chưa có frontend | ✅ thật (giai đoạn UI) |

Điểm đánh giá ngoài **nói quá**: P0-3 (identity đã khoá ở 0005). Điểm **under-credit**: "page
builder có kiểm soát" (registry + version + preview/publish/rollback) **đã dựng ở Ngày 11**.

## 2. Vá P0-4 — chiếm shop qua đăng ký trước

**Kịch bản (đã tái hiện chạy thật):** kẻ tấn công `POST /auth/register` trước bằng
`owner@brand.vn` + mật khẩu của hắn (register công khai, không verify email). Platform mời
`owner@brand.vn` làm owner. Khi lời mời được chấp nhận, code cũ tìm user theo email → gắn
membership vào **tài khoản kẻ tấn công**, **bỏ qua mật khẩu** người chấp nhận. Kẻ tấn công
đăng nhập bằng mật khẩu của hắn → **sở hữu shop**. (e2e chứng minh: mật khẩu kẻ tấn công vẫn
đăng nhập được sau khi chủ thật "accept", chủ thật không có membership nào.)

**Nguyên tắc vá:** **token lời mời = bằng chứng sở hữu email** (nó gửi tới đúng hộp thư đó).
`acceptInvitation` chia ba nhánh:

| Trạng thái tài khoản email | Xử lý |
|---|---|
| **Chưa có** | Tạo mới (cần mật khẩu), đánh dấu `email_verified_at = now()` |
| **Có, CHƯA verify** (vd kẻ đăng ký trước) | **CLAIM**: đặt lại mật khẩu theo người giữ token, **tắt MFA**, **thu hồi mọi phiên** cũ → kẻ tấn công bị đá |
| **Có, ĐÃ verify** (chủ email hợp lệ) | Không bind mù: **bắt buộc đang đăng nhập đúng tài khoản này** (403 `login_required` nếu không) |

Migration `0020` thêm `users.email_verified_at`. Register công khai vẫn còn nhưng chỉ tạo
tài khoản **chưa verify** → không dùng để chiếm được; **tắt hẳn register công khai** là bước
làm cứng P1 (chống spam), không phải điều kiện đóng P0-4.

**Vì sao claim an toàn:** người giữ token kiểm soát hộp thư `owner@brand.vn` → chính là chủ
email thật. Tài khoản chưa verify không có bằng chứng sở hữu nào, nên bị token-holder giành
lại là đúng. Nhờ đó **không có takeover mà cũng không có griefing** (kẻ đăng ký trước không
khoá được email — lời mời thật cứ claim đè).

**Kiểm chứng:** [apps/platform/test/invitation-takeover.e2e.mjs](../apps/platform/test/invitation-takeover.e2e.mjs)
(9/9; đỏ 4/9 khi chưa vá) + [scripts/verify-invitation.sh](../scripts/verify-invitation.sh)
(gỡ kiểm đăng-nhập / vô hiệu nhánh claim → e2e đỏ).

## 3. P0-3 — siết quyền app_rw (ĐÃ LÀM)

`app_rw` = **chỉ service seller** (+ dbtest). Ground truth (đọc live DB): ghi được các bảng
GLOBAL `platform_staff`/`plans`/`schema_migrations` (leo thang / sửa sổ migration) và
billing/ledger `subscriptions`/`payment_transactions` (tự nâng gói / giả giao dịch) — mà seller
KHÔNG tham chiếu bảng nào trong số đó. Identity (`users`/`sessions`/...) **đã REVOKE ở 0005**.

Vá (migration `0021`): REVOKE các bảng trên. Bất biến DURABLE (schema-invariants):
**"app_rw không ghi bảng GLOBAL nào trừ shops"** (bắt cả bảng tương lai tự nhận CRUD qua default
privileges 0003) + "app_rw không ghi subscriptions/payment_transactions". Kiểm chứng verify-first:
2 test ĐỎ trước 0021 (14/2), XANH sau (16/0); tenant-isolation 23/0; seller 25/29/34 không hồi quy.
*Ghi chú: bỏ hẳn `ALTER DEFAULT PRIVILEGES` rộng của 0003 + grant explicit từng bảng là bước
làm cứng sâu hơn (P1); bất biến ở trên đã là lưới an toàn chặn CI.*

## 4. P0-5 — vòng đời tồn kho khép kín (ĐÃ LÀM)

`reserve` (checkout) giờ LUÔN kết thúc bằng release **hoặc** consume:

| Sự kiện | Trước | Nay |
|---|---|---|
| cancel | release reserve | (giữ) |
| **ship** | chỉ đổi trạng thái | **consume**: on_hand −= qty, reserved −= qty, ghi ledger `'ship'` (giữ bất biến Σledger==on_hand). Guard `status='confirmed'` = idempotent |
| **expire** | (không có) | worker quét đơn `qr`+`unpaid`+`pending` quá `ORDER_EXPIRY_MINUTES` → **release reserve + huỷ**. `FOR UPDATE SKIP LOCKED` + guard = idempotent |

Job expire chạy CROSS-SHOP nên dùng role riêng **`app_expiry`** (migration `0022`) cực hẹp: chỉ
cột không-PII của `orders` + đổi trạng thái, đọc `order_lines`, giảm `reserved` — không đụng tiền/
PII/on_hand. Chạy trong worker (pool riêng), có endpoint nội bộ `POST /internal/expire-sweep` để
cron ngoài gọi + e2e kiểm xác định. Kiểm chứng: `apps/worker/test/e2e.mjs` 18/18 (ship-consume
+ expire), `verify-fulfillment.sh` 6/6 (thêm mutation "bỏ consume on_hand → đỏ"). Không hồi quy.

## 5. Còn lại (theo thứ tự)

P0-6 (tách bootstrap role/password khỏi migration bất biến), P0-7 (lockfile + `npm ci` +
pin image), rồi **giai đoạn UI** (P0-1 edge routing đi cùng UI; buyer checkout UI = ưu tiên).
