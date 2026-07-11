# Onboarding shop — Ngày 6

> **Trạng thái: ĐÃ CHẠY từ cold start.**
> onboarding e2e: 28/28 · mutation testing: 5/5 lớp phòng thủ.
> Không hồi quy: auth 40/40, cô lập tenant 36/36, TLS 35/35.

Nhân viên nền tảng tạo shop cho khách, mời owner, owner tự nhận lời mời và có
membership. Toàn bộ chuỗi chạy thật end-to-end, rồi gỡ từng lớp phòng thủ để
kiểm test có bắt được.

## 1. Thành phần

| Nơi | Nội dung |
|---|---|
| `packages/db/migrations/0006_onboarding.sql` | platform_staff, plans, subscriptions, invitations, cấu hình shop (locale/currency/tz), role `app_platform` |
| `apps/platform/src/` | dịch vụ ops: tạo shop, subdomain, mời owner, khoá/mở shop |
| `apps/auth/src` (+) | `POST /auth/invitations/accept` — nhận lời mời, tạo user + membership |

## 2. Luồng onboarding

```
Nhân viên nền tảng (đã bật MFA)
  → POST /ops/shops           tạo shop + subdomain (verified) + subscription(trial)
  → POST /ops/shops/:id/invitations   sinh token mời owner
  → (gửi link cho owner)
Owner
  → POST /auth/invitations/accept {token, password}
       → tạo user + membership(role=owner) + đánh dấu lời mời accepted (một lần)
  → đăng nhập → /auth/me thấy membership owner của đúng shop
Nhân viên nền tảng
  → POST /ops/shops/:id/suspend | /restore   (KHÔNG xoá dữ liệu)
```

## 3. Ba quyết định bảo mật (mỗi cái có test + mutation)

- **Mọi /ops đòi: phiên hợp lệ + là `platform_staff` + đã bật MFA.** MFA bắt buộc
  cho nhân viên nền tảng, không thoả hiệp.
- **`app_platform` KHÔNG có quyền trên dữ liệu nghiệp vụ** (products, orders...).
  "Platform không mặc định xem dữ liệu khách mua" (docs/03). Test chứng minh:
  `app_platform SELECT orders` → lỗi quyền 42501.
- **Lời mời dùng một lần**, hai lớp: SELECT lọc `accepted_at IS NULL` (bài tuần
  tự) + UPDATE claim atomic có kiểm `rowCount` (bài đua đồng thời).

## 4. Xác thực phiên qua introspection

Dịch vụ platform KHÔNG đọc bảng `sessions` (chỉ auth service đọc — giữ bán kính
ảnh hưởng hẹp). Nó xác thực bằng cách gọi `auth /auth/me` với cookie được chuyển
tiếp, rồi kiểm `platform_staff` + `mfa_enabled`.

Đây là mô hình cho **một origin** (ADR-005/009): auth + seller-admin + platform-admin
cùng `admin.nentang.vn` nên chia sẻ cookie `__Host-session`. Đánh đổi: một lời gọi
nội bộ mỗi request (chấp nhận ở pilot). Trong monolith đích, chỉ là một lời gọi hàm.

## 5. Cô lập role — vì sao app_platform an toàn dù có policy USING(true)

`app_platform` có policy `USING(true)` trên shops/domains/subscriptions/invitations
(thao tác xuyên shop khi tạo/khoá). Điều này an toàn KHÔNG phải nhờ RLS mà nhờ
**GRANT**: app_platform đơn giản không được cấp quyền nào trên bảng nghiệp vụ, nên
không thể chạm dữ liệu khách mua dù policy có mở. Ranh giới là "role được cấp
quyền", giống `app_tls`/`app_auth`. Bất biến schema (`app_rw` đúng một policy,
không dùng `true`) không bị ảnh hưởng vì đây là role khác.

## 6. Lỗi mà quá trình *chạy* lôi ra

**Mount sai đường dẫn → mutation vô hiệu.** Dockerfile platform chạy `/app/src/server.js`
nhưng compose mount src vào `/app/apps/platform/src` — path khác. Mutation sed sửa
file KHÔNG được nạp; 4 kết quả "đỏ" ban đầu là GIẢ (do redis rate-limit tích luỹ
qua nhiều lần chạy, không phải do mutation). Phát hiện bằng cách probe status thật
của endpoint sau khi tắt một lớp. Sửa: mount vào đúng `/app/src`, và flush redis
trước mỗi lần e2e trong harness.

Bài học lặp lại: mutation testing tự nó cũng phải được kiểm — một mutation "flip
đỏ" có thể đỏ vì lý do khác (nhiễu), và một mutation "vẫn xanh" có thể do nó không
bao giờ tác động (mount sai). Luôn xác nhận mutation thật sự chạm code đang chạy.

**Single-use lời mời chỉ được test tuần tự.** Bài tuần tự bị lớp SELECT chặn nên
không chạm lớp claim atomic — mutation claim "vẫn xanh". Sửa đúng: thêm bài đua
hai accept đồng thời, chứng minh đúng một thắng.

## 7. Còn thiếu (ngoài phạm vi Ngày 6)

- Caddy định tuyến `/ops` và `/auth` dưới cùng `admin.nentang.vn` (prod) — hiện
  e2e gọi thẳng service, quản cookie tay; mô hình một-origin đã đúng ở tầng thiết kế.
- Luồng đổi/tắt MFA có step-up (để đổi thiết bị authenticator).
- Email thật gửi lời mời (hiện trả token cho nhân viên tự gửi).
- Gia hạn/thu phí subscription tự động (MVP ghi nhận thủ công).
