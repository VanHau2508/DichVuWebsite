# Sổ tay vận hành & workflow toàn hệ thống

> Dành cho CHỦ hệ thống tự vận hành + nghiệm thu. Gồm: (1) workflow từng vai trò,
> (2) cách khởi động chạy LOCAL, (3) cách triển khai PRODUCTION. Test local chi tiết
> xem thêm [docs/32](32-chay-test-local.md).

## 0. Tổng quan

Nền tảng SaaS bán hàng multi-tenant ("Haravan thu nhỏ") — mỗi shop một tên miền riêng.
~11 dịch vụ Node HTTP thuần sau **Caddy** (cổng duy nhất ra Internet) + Postgres (RLS) +
Redis + MinIO + Worker. **3 nhóm người dùng:**

| Vai trò | Làm gì | Vào ở đâu |
|---|---|---|
| **Nền tảng** (platform-staff) | Tạo/khoá shop, mời chủ shop, gói dịch vụ | API `/ops` (DEV chưa có UI → dùng script seed) |
| **Người bán** (owner + nhân sự) | Sản phẩm, đơn, nội dung, nhân sự, tên miền, xuất dữ liệu | `admin.localtest:8443` (prod: `admin.nentang.vn`) |
| **Khách mua** (ẩn danh) | Duyệt → giỏ → đặt hàng → tra cứu | `<tên-miền-shop>:8443` |
| *(Worker — nền)* | Gửi email, hết hạn đơn QR, xác minh tên miền | tự chạy |

---

## 1. Workflow NỀN TẢNG (tạo & quản shop)

> **DEV: chưa có giao diện web** cho phần này (chỉ API `/ops` trên `platform:3030`). Tạo
> shop để test bằng **script seed** (mục 4). Prod: nhân viên nền tảng gọi API `/ops` sau khi
> đăng nhập + **bắt buộc bật MFA**.

1. **Bootstrap nhân viên đầu tiên** (con-gà-quả-trứng có chủ đích): đăng ký user auth → bật MFA
   → `INSERT INTO platform_staff` bằng role DB `app_owner` (không có API — chỉ superuser DB).
2. **Tạo shop**: `POST /ops/shops {name, slug, plan_code}` → shop `status=onboarding` +
   subdomain `<slug>.nentang.vn` (verified ngay) + subscription `trial`.
3. **Mời chủ shop**: `POST /ops/shops/{id}/invitations {email, role}` → sinh **token dùng-một-lần**
   (lưu hash, hết hạn 7 ngày). **Hệ KHÔNG tự gửi email** — nhân viên copy link gửi cho owner.
4. **Owner chấp nhận**: `POST /auth/invitations/accept {token, password}` → 3 nhánh, có chống
   **chiếm shop (P0-4)**: (a) chưa có tài khoản → tạo mới; (b) có nhưng chưa xác minh email → CLAIM
   (reset mật khẩu + tắt MFA + đá phiên kẻ tấn công); (c) đã xác minh → bắt đăng nhập đúng tài khoản.
5. **Khoá/Mở**: `POST /ops/shops/{id}/suspend|restore` (không xoá dữ liệu). Suspend → storefront **503**.

**Trạng thái shop:** `onboarding → active → suspended → (terminated)`. Mọi thao tác ghi `audit_logs`.

---

## 2. Workflow NGƯỜI BÁN

### 2.1 Phân quyền (RBAC) & step-up

| Vai trò | Quyền |
|---|---|
| **owner** | TẤT CẢ |
| **admin** | sản phẩm + đơn + theme + nội dung + xem nhân sự (KHÔNG: tên miền/xuất/đổi nhân sự/thanh toán) |
| **catalog_manager** | CHỈ sản phẩm + tồn kho + ảnh |
| **order_manager** | CHỈ đơn hàng |

**Step-up (nhập lại mật khẩu, hiệu lực 5 phút)** — chỉ áp cho việc nhạy cảm: **đổi nhân sự,
tên miền, xuất dữ liệu, cấu hình thanh toán, hoàn tiền**. Sản phẩm/đơn/nội dung **KHÔNG** cần step-up.

### 2.2 Sản phẩm / biến thể / tồn kho / ảnh *(perm `catalog.write`)*
- **Sản phẩm**: tạo (mặc định `draft`) → **Đăng bán** (`active`) / **Ẩn** (`archived`) / **Xoá mềm**.
  SKU & slug **duy nhất trong shop**. Giá `bigint ≥ 0`.
- **Biến thể**: thêm/xoá, bất biến **≥1 biến thể** (không xoá biến thể cuối).
- **Tồn kho**: điều chỉnh `on_hand`, có **sổ cái append-only**; `available = on_hand − reserved`.
- **Ảnh**: upload → kiểm **magic-byte** (không tin Content-Type) → re-encode WebP → kéo sắp thứ tự /
  chọn ảnh đại diện. Ảnh gốc ở bucket **private** (không truy cập ẩn danh).

### 2.3 Đơn hàng *(perm `orders.write`: owner/admin/order_manager)*

**HAI trục trạng thái độc lập:**
- **Đơn**: `pending → confirmed → shipped → delivered` (+ `cancelled` / `refunded`)
- **Thanh toán**: `unpaid → paid` (COD có thể *delivered + unpaid*)

| Nút (admin) | Làm gì | Tồn kho | Email |
|---|---|---|---|
| **Xác nhận đơn** | pending → confirmed | (giữ reserve) | "đã xác nhận" |
| **Giao hàng** (nhập vận đơn) | confirmed → shipped | **CONSUME** (on_hand & reserved −= qty) | "đang giao" + mã vận đơn |
| Đánh dấu đã giao | shipped → delivered | — | "đã giao" |
| **Huỷ đơn** | pending/confirmed → cancelled | **RELEASE** reserve | "đã huỷ" |
| **Đã nhận tiền (COD)** | payment: unpaid → paid | — | "đã nhận thanh toán" |

Email chỉ gửi **khi khách nhập email** lúc đặt.

### 2.4 Thanh toán
- **COD**: đơn tạo `pending/unpaid`; người bán bấm **"Đã nhận tiền (COD)"** để đánh dấu đã trả (idempotent, có audit).
- **QR/VietQR**: chỉ **webhook ngân hàng** (SePay) mới đặt `paid` — **không nút thủ công** (chống gian lận).
  Webhook đối chiếu **số tiền + tài khoản nhận** → khớp → `paid` + tự chuyển đơn sang `confirmed`.
- **Cấu hình tài khoản nhận** (`payment.write`, **owner + step-up**): khai bank_bin/số TK/tên TK, bật QR.
  *(Backend có; UI admin chưa có trang này — cấu hình qua API `PUT /shops/{id}/payment-config`.)*

### 2.5 Nội dung, tên miền, xuất dữ liệu, tài khoản/nhân sự
- **Trang nội dung** (`content.write`, owner+admin): tạo nháp → sửa block (kéo–thả) → **Publish** (snapshot) →
  storefront hiện bản published; **Xem trước** bản nháp qua link token 30'; SEO theo trang; rollback.
- **Tên miền riêng** (`domain.write`, **owner + step-up**): Thêm → hệ trả **bản ghi TXT** → tạo TXT ở DNS →
  worker xác minh (~60s) → **on-demand TLS** phục vụ → đặt **primary** (301) / **gỡ**. Tên miền toàn cục duy nhất.
- **Xuất dữ liệu** (`export`, **owner + step-up**): tạo → **ZIP** nhiều CSV (SP/biến thể/đơn/khách) → **link tải hết hạn 15'**.
- **Tài khoản/bảo mật** (tự phục vụ): bật/tắt **MFA** (TOTP), đổi mật khẩu, **liệt kê + thu hồi phiên**.
- **Nhân sự** (`members.write`, **owner + step-up**): mời (link tự gửi tay), đổi vai trò, xoá; **chặn xoá owner cuối cùng**.

---

## 3. Workflow KHÁCH MUA (storefront)

1. Vào shop qua tên miền (chỉ tên miền **đã verify** mới mở; suspended → 503).
2. **Duyệt** trang chủ / sản phẩm (`/p/:slug`) / danh mục (`/c/:slug`) / trang nội dung (`/pages/:slug`).
   Chỉ hiện sản phẩm `active` + ảnh `ready`. **Không JS**, CSP nghiêm, escape mọi dữ liệu (chống XSS).
3. **Thêm giỏ** → `/cart` (sửa/xoá). **Giá tính 100% phía server** — giá client gửi bị bỏ qua.
4. **Checkout** `/checkout` → điền tên/SĐT/email/địa chỉ → chọn **COD** hoặc **QR** → đặt đơn (idempotent).
5. **Trang thành công** (số đơn + mã tra cứu) → **email xác nhận** (nếu nhập email). QR: hiện mã, tự cập nhật khi webhook báo.
6. **Tra cứu đơn** bằng *số đơn + mã* (không có tài khoản khách; sai → 404 kiểu form, chống dò).

---

## 4. KHỞI ĐỘNG & VẬN HÀNH — LOCAL (dev, để test)

```bash
# 0) Docker CLI vào PATH (nếu 'docker' báo not found)
export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"; export MSYS_NO_PATHCONV=1
cd /d/Dichvuwebsite

# 1) Dựng toàn bộ stack (lần đầu ~vài phút; migrate tự chạy)
docker compose -f infra/compose.dev.yml up -d --build

# 2) Kiểm tra sẵn sàng
docker compose -f infra/compose.dev.yml ps           # mọi service 'healthy'
bash scripts/smoke-readiness.sh                       # /livez /readyz /healthz = 200

# 3) Tạo shop demo (chủ shop + 6 SP + 6 đơn) — in ra ownerEmail + slug
docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/demo-seed.mjs
#   Mật khẩu chủ shop CỐ ĐỊNH: nha xinh chu shop 2026
```

**Một lần trên máy** (xem docs/32): thêm file **hosts** (`admin.localtest`, `<slug>.nentang.vn` → 127.0.0.1)
+ **tin CA** của Caddy (hết cảnh báo chứng chỉ).

**Mở trên trình duyệt** (luôn có `:8443`):
- Admin người bán: `https://admin.localtest:8443/` (đăng nhập bằng ownerEmail + mật khẩu trên)
- Trang bán hàng: `https://<slug>.nentang.vn:8443/`
- Email dev (Mailpit): `http://localhost:8025/`

**Giả lập thanh toán QR** (không có bank thật ở dev):
```bash
curl -k -X POST https://hooks.localtest:8443/webhooks/sepay \
  -H "Authorization: Apikey dev-sepay-secret-key-12345" -H "Content-Type: application/json" \
  -d '{"content":"<payment_ref>","transferAmount":<tiền>,"accountNumber":"<TK nhận>"}'
```

**Dừng / khởi động lại / reset:**
```bash
docker compose -f infra/compose.dev.yml stop          # dừng, GIỮ dữ liệu
docker compose -f infra/compose.dev.yml up -d          # chạy lại
docker compose -f infra/compose.dev.yml down -v && docker compose -f infra/compose.dev.yml up -d --build  # RESET sạch (xoá DB/ảnh/cert → seed lại + tin CA lại)
```

> DEV chỉ Caddy mở cổng `8080`(HTTP)/`8443`(HTTPS); mọi dịch vụ khác nội bộ. Bí danh dev-only:
> secret `devpassword` / `minioadmin123` / `dev-sepay-secret-key-12345`. **Không dùng cho khách thật.**

---

## 5. TRIỂN KHAI PRODUCTION (Tuần B — cần tài nguyên của bạn)

**Cần chuẩn bị (chỉ bạn có được):** VPS (gợi ý 4 vCPU/8GB/100GB) + **floating IP bắt buộc**
([[floating-ip-bat-buoc]] — mua TRƯỚC khách đầu tiên, đổi IP sau = gọi từng khách), **tên miền**
+ DNS (Cloudflare, token Zone:DNS:Edit), tài khoản **offsite S3/B2**, **SMTP relay** thật
(Resend/SES — VPS VN hay chặn cổng 25), tài khoản **SePay/Casso** (đặt webhook `hooks.nentang.vn`).

**Trình tự triển khai:**
```bash
cp .env.example .env        # điền SECRET THẬT (openssl rand -hex 32 cho MFA_ENC_KEY, rand -base64 24 cho mật khẩu)
bash scripts/deploy.sh      # từ chối chạy nếu .env còn giá trị mẫu
```
`deploy.sh` chạy 7 bước có kiểm: preflight (.env hợp lệ) → build → postgres → migrate (không seed) →
**provision mật khẩu 10 role** (qua STDIN, không lộ qua `ps`) → up services (--wait) → **health gate** →
**đăng nhập kiểm từng role** (chứng minh mật khẩu khớp).

**Backup + khôi phục (DR):**
```bash
# cron: WAL mỗi 5' (RPO nhỏ) + full mỗi đêm
*/5 * * * *  bash scripts/backup.sh wal
0 3 * * *    bash scripts/backup.sh              # logical + base(PITR) + media + WAL + đẩy OFFSITE (fail nếu thiếu offsite)
# khôi phục: gunzip -c logical.sql.gz | psql -U postgres   (DR đơn giản)
#            base.tar.gz + WAL + recovery_target_time       (PITR về đúng thời điểm)
bash scripts/pitr-drill.sh            # 5/5 — diễn tập PITR
bash scripts/backup-restore-drill.sh  # 11/11 — khôi phục host trắng, RLS/cô lập còn nguyên
```
**Cập nhật / rollback:** `git pull && bash scripts/deploy.sh` · rollback: `git checkout <commit> && bash scripts/deploy.sh`
(migration forward-only, tương thích lùi 1 phiên bản; hỏng dữ liệu thì restore, không revert migration).

---

## 6. Ma trận: XONG vs CẦN TÀI NGUYÊN

| Hạng mục | Trạng thái |
|---|---|
| Toàn bộ **chức năng** (bán/mua/quản/thanh toán/nội dung/tên miền/xuất) | ✅ Xong, test được 100% ở local |
| CI (unit + e2e mỗi push, mutation 19/19) | ✅ Xanh |
| `compose.prod` + `deploy.sh` + `backup.sh` + `pitr-drill` + provision role | ✅ Code sẵn (chưa chạy thật) |
| **Deploy thật** (VPS + floating IP + TLS ACME) | 🔑 Cần tài nguyên (B1) |
| **Backup offsite + PITR thật** (S3/B2) | 🔑 Cần tài nguyên (B2) |
| **Alert on-call**: cảnh báo đường tiền → Telegram/webhook (`sweepMoneyAlerts`) + heartbeat worker + soi/retry dead-letter (`/internal/dead-letters`) | ✅ Code xong — 🔑 còn cắm token/URL thật (xem docs/35 B2–B3) |
| **UAT khách thật + pentest** | 🔑 Cần người (Tuần C-D) |
| Giao diện quản trị **nền tảng** (tạo/khoá shop) trên web | ⚠️ DEV chưa có UI (dùng seed/API); prod dùng API |
| Cấu hình thanh toán QR trên **UI admin** | ⚠️ Backend có, chưa có trang UI (dùng API) |

**Kiểm tổng thể:** `bash scripts/go-no-go.sh` (chấm 15 tiêu chí → GO/NO-GO).
