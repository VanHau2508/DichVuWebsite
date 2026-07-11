# Seller-admin + RBAC — Ngày 7

> **Trạng thái: ĐÃ CHẠY từ cold start.**
> seller e2e: 25/25 · mutation: 6/6 · RBAC unit: 8/8.
> Không hồi quy: onboarding 28, auth 40, tenant 36, TLS 35.

Nhà bán hàng quản trị shop của mình: xem/mời/đổi quyền/xoá nhân sự, với quyền theo
vai trò và xác thực lại (step-up) cho thao tác nhạy cảm. Đây là dịch vụ **đầu tiên
dùng thật `app_rw` + `withTenant` + RLS** — tới nay các lớp đó chỉ sống trong test.

## 1. Thành phần

| Nơi | Nội dung |
|---|---|
| `packages/db/migrations/0007_seller_rbac.sql` | `sessions.stepped_up_at`; RLS trên `users` (app_rw chỉ thấy nhân sự shop hiện tại) |
| `apps/seller/src/rbac.js` | ma trận quyền thuần (test được không cần DB) |
| `apps/seller/src/server.js` | withTenant + RBAC + step-up, quản lý nhân sự |
| `apps/auth/src` (+) | `POST /auth/step-up`, `/auth/me` trả `stepped_up_at` |

## 2. Ba lớp phòng thủ (mỗi lớp có test + mutation)

1. **TENANT** — mọi truy vấn chạy trong `withTenant(shopId)` bằng role `app_rw`;
   RLS tự cô lập. Thành viên shop A xem shop B → **404** (không xác nhận tồn tại).
   Đây là lần đầu RLS chạy trong đường request thật, không chỉ test.
2. **RBAC** — vai trò trong shop (lấy từ introspection `/auth/me`) quyết định quyền
   theo ma trận docs/01 §11. Catalog Manager không đụng đơn hàng; **chỉ Owner** đổi
   quyền/xoá nhân sự (`members.write`).
3. **STEP-UP** — thao tác nhạy cảm (`members.write`, `domain.write`, `export`,
   `refund`) đòi `sessions.stepped_up_at` < 5 phút. Thiếu → 403 `step_up_required`;
   client gọi `/auth/step-up {password}` rồi thử lại.

## 3. Ma trận quyền (rbac.js)

| perm | Owner | Admin | Catalog | Order |
|---|:-:|:-:|:-:|:-:|
| catalog.* | ✓ | ✓ | ✓ | – |
| orders.* | ✓ | ✓ | – | ✓ |
| refund | ✓ | ✓ | – | – |
| theme.write | ✓ | ✓ | – | – |
| members.read | ✓ | ✓ | – | – |
| **members.write** (đổi quyền) | ✓ | – | – | – |
| **domain.write / export** | ✓ | – | – | – |

`members.write`, `domain.write`, `export`, `refund` = cần step-up.

## 4. Cho app_rw thấy email nhân sự mà không lộ toàn bộ users

Seller cần hiện email nhân viên, nhưng `app_rw` KHÔNG được thấy toàn bộ bảng `users`
(khách của mọi shop). Giải: bật RLS trên `users`:
- `app_auth`: policy `auth_all USING(true)` — đăng nhập/đăng ký cần tra mọi user.
- `app_rw`: policy `member_visibility` — chỉ SELECT user LÀ THÀNH VIÊN của
  `current_shop_id()`. `users` không có `shop_id` nên không thuộc bộ "bảng tenant"
  mà test bất biến kiểm; RLS ở đây là lớp thêm.

Kiểm chứng: e2e mục 7 — owner B liệt kê nhân sự chỉ thấy người của shop B, không
thấy admin của shop A.

## 5. Vòng đời quyền: introspection luôn tươi

Đổi vai trò một thành viên → lần `/auth/me` kế tiếp của họ trả vai trò mới ngay
(mỗi lần query `memberships` mới), nên `whoami` phản ánh tức thì. Không có cache
vai trò cũ. e2e mục 5 chứng minh.

## 6. Kiểm chứng

```bash
node --test apps/seller/test/rbac.test.js                    # ma trận quyền, không cần Docker
docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller/test/e2e.mjs
bash scripts/verify-seller.sh                                # mutation 6/6
```

`verify-seller.sh` gỡ 6 lớp: RBAC, step-up, kiểm thành viên, tenant context,
chặn owner-cuối-cùng, xác minh mật khẩu step-up (ở auth). Mỗi cái gỡ ra làm e2e đỏ.

## 7. Còn thiếu (ngoài phạm vi Ngày 7)

- Caddy một-origin `admin.nentang.vn` định tuyến `/auth` + `/shops` (prod). e2e
  gọi thẳng service, quản cookie tay; mô hình một-origin đúng ở tầng thiết kế.
- Chọn/đổi "shop đang thao tác" cho người dùng nhiều shop (hiện shop_id trong path).
- Step-up bằng MFA (hiện chỉ mật khẩu). Owner có MFA nên có thể mở rộng.
- Resource thật (catalog/orders) — hiện stub; nội dung Ngày 8.
