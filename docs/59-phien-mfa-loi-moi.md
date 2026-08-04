# Phiên · MFA · lời mời — ba lỗ của cụm XÁC THỰC

Đợt 4, mục D · E · F (docs/57). Chín trên chín lăng kính phản biện xác nhận. Cụm này khác hẳn
các đợt trước ở một điểm: **bản vá sai thì tốn kém hơn chính lỗi** — đá nhầm phiên là đăng xuất
người dùng thật, hoặc khoá họ ra ngoài giữa lúc màn hình đang hiện mã khôi phục dùng-một-lần.

## Luật 1 — ĐỔI YẾU TỐ XÁC THỰC thì phải THU HỒI phiên khác

Đăng nhập khi tài khoản **chưa** bật MFA tạo phiên với `mfa_satisfied = true`
(`createSession(..., { mfaSatisfied: true })`), còn cổng là:

```js
const isFullyAuthed = (ctx) => ctx && (!ctx.user.mfaEnabled || ctx.session.mfaSatisfied);
```

Nên sau khi bật 2FA, phiên mở **trước đó** vẫn thoả `mfaSatisfied` → **qua cổng, không bao giờ
bị hỏi mã**, suốt phần còn lại của `SESSION_TTL_HOURS = 168` (tới 7 ngày). Bật 2FA đúng lúc cần
nhất — vừa nghi bị lộ — mà kẻ đang cầm phiên cũ không hề bị đá ra thì lớp bảo vệ đó không bảo vệ
gì. Cổng "nhân viên nền tảng bắt buộc bật MFA" cũng chịu chung số phận.

`changePassword` đã làm đúng từ lâu; `mfaActivate` và `mfaDisable` thì không. Nay cả ba dùng
chung một câu:

```sql
UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id != $2 AND revoked_at IS NULL
```

**Ba chi tiết bắt buộc, sai một là hỏng:**

1. **`id != $2`** — bản thu-hồi-tất (`resetPassword`) sẽ đá chính người vừa bấm ra ngoài **giữa
   lúc màn hình đang hiện 10 mã khôi phục**, mà mã đó chỉ hiện MỘT lần: mất là mất vĩnh viễn.
2. **Đặt TRONG transaction, TRƯỚC bước rotate.** Đặt sau `createSession` rotate mà không loại
   trừ phiên vừa cấp thì giết luôn phiên mới.
3. **Nói ra trên màn hình.** BFF thêm *"Các thiết bị khác đã bị đăng xuất"* (mirror
   `passwordChange`) — im lặng thì người dùng chỉ phát hiện lúc điện thoại bắt đăng nhập lại và
   tưởng hệ thống hỏng.

`mfaDisable` cũng vá: ca thật là người dùng nghi máy cửa hàng bị chiếm nên **tắt rồi bật lại**
2FA để "làm mới" — nếu bước tắt không đá phiên nào thì phiên của kẻ kia sống nguyên qua cả hai
bước.

## Luật 2 — cờ `step_up_required` phải xét TRƯỚC `isDenied`

```js
const isDenied = (st) => st === 401 || st === 403;
```

Cờ step-up **luôn** đi kèm 403, nên đặt `isDenied` trước là nuốt trọn nó. `platformBillingSave`
là **chỗ duy nhất trong kho** đặt ngược — ba đường suspend/restore/renew/terminate đã đúng từ
lâu. Hậu quả: người dùng **là** admin nền tảng lại đọc *"Tài khoản của bạn không có quyền"*,
nhánh hiển thị đúng bên dưới thành **mã chết**, và trang đó không có route step-up nào.

Xảy ra **100% ở lần cấu hình đầu tiên** của cả nền tảng — đúng lúc chưa ai từng step-up. Đường
vòng duy nhất là **cố tình tạm khoá một shop khách hàng** để lấy interstitial rồi mở lại trong
5 phút. Token vừa gõ cũng mất sạch.

Vá: đảo thứ tự + thêm `POST /platform/billing/step-up` + `renderPlatformBillingStepUp`. Không
dùng lại được `renderPlatformStepUp` vì form kia đóng đinh vào `/platform/shops/:id/step-up`.

**Token SePay được mang theo trong hidden field — cân nhắc có thật.** Bỏ đi thì người dùng gõ
lại token dài sau mỗi lần xác thực, đúng kiểu "ngõ cụt mất dữ liệu" dự án đã phải vá một lần ở
QR checkout. Bí mật nằm trong POST body và trong DOM của **chính trang họ vừa gõ nó vào**, trên
phiên đã đăng nhập của họ — không vào URL, không vào lịch sử trình duyệt, không vào log. Có một
khẳng định riêng canh trang cấu hình **không** in lại token đã lưu.

## Luật 3 — cấp một năng lực có hạn dùng thì phải có đường THU HỒI

`invitations` (0006) có `accepted_at` và `expires_at`, **không có đường vô hiệu hoá sớm**. Mời
nhầm email hoặc nhầm vai trò là ngõ cụt **7 ngày**. Hai kịch bản không cần ai làm sai: gõ nhầm
tên miền mà tên miền đó có người sở hữu thật (ngoài tầm kiểm soát của shop), và bấm "Mời" lần
thứ hai vì email vào spam. "Gỡ thành viên" cũng không đụng lời mời chưa dùng.

Vá gồm **bốn mảnh**, thiếu mảnh nào cũng thành nút trang trí:

| Mảnh | Vì sao bắt buộc |
|---|---|
| `revoked_at` (0138) — cột, không xoá dòng | Lời mời là chuyện nhân sự; xoá sạch là xoá dấu vết. Cùng lối `shop_api_keys.revoked_at` |
| `AND revoked_at IS NULL` ở câu **SELECT** token | Không có thì token đã gửi vẫn dùng được |
| `AND revoked_at IS NULL` ở câu **CLAIM** | Khe hở giữa SELECT và UPDATE đúng là khoảnh khắc người bán bấm Huỷ. Thiếu → người mời **luôn thua** cuộc đua. *docs/57 bỏ sót mảnh này* |
| Khối "Lời mời đang chờ" trên màn Thành viên | Không thấy thì không thể muốn thu hồi — trước đó màn này chỉ liệt kê người ĐÃ vào |

**Route thu hồi KHÔNG đòi step-up — cố ý, ngược với gợi ý của docs/57.** Học thuyết đã viết ra
của chính kho (`apps/seller/src/api-keys.js`, thu hồi khoá kết nối): *tạo* năng lực thì step-up,
*thu hồi* thì không, vì **"đường an toàn phải là đường dễ đi nhất"**. Lúc phát hiện mời nhầm là
lúc người ta hoảng; bắt gõ lại mật khẩu chỉ kéo dài cửa sổ cho người lạ bấm link. Thu hồi cũng
không phá gì: không đụng `memberships`, không ai đang đăng nhập bị mất quyền.

Migration **không cần GRANT/POLICY mới**: `app_rw` có CRUD qua `ALTER DEFAULT PRIVILEGES` (0003),
`app_auth` có SELECT+UPDATE, `app_platform` có SELECT+INSERT+UPDATE — và GRANT là cấp-BẢNG nên
cột mới dùng được ngay. Thêm policy thứ hai sẽ vi phạm bất biến *"không lệnh nào của bảng tenant
bị ≥2 policy PERMISSIVE app_rw phủ"* (bài học 0121).

## Ràng buộc của màn Thành viên (đừng phá khi sửa tiếp)

- **Không in token/link nhận lời mời** — bất biến 0073, có test canh chuỗi `invite/accept?token=`.
- **Không dùng `<option value="owner">`** ở bất kỳ select nào trên trang — có test canh. Vai trò
  trong khối lời mời chờ vì vậy in bằng `<span class="badge">`, không phải select.

## Bẫy ĐO trong đợt này

- **Chạy bộ test sai container.** `apps/auth/test/e2e.mjs` chạy trong container **auth**, không
  phải `dbtest` (compose không mount `apps/auth` vào dbtest). Bộ chạy của tôi báo "ĐỎ" trong khi
  mã hoàn toàn lành — `ci-local.sh` có sẵn ngoại lệ này.
- **Khôi phục đột biến trượt vì chú thích còn nằm lại.** Đột biến chỉ gỡ câu lệnh, chú thích ở
  trên vẫn còn, nên chuỗi tìm-kiếm để khôi phục không khớp. Luôn ĐỌC lại vùng đó trước khi tin
  là đã khôi phục xong.
