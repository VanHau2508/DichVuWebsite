# Chạy & test hệ thống ở LOCAL (trước khi thuê VPS)

> Toàn bộ **chức năng** đã hoàn thiện và test được 100% ở máy local. Chỉ phần **vận
> hành production** (deploy/backup-DR/alert = Tuần B) mới cần VPS. Tài liệu này hướng
> dẫn mở hệ trên trình duyệt để tự nghiệm thu chức năng.

## 0. Điều kiện

- **Docker Desktop đang chạy.** Nếu `docker` báo "command not found", xem memory
  `docker-cli-not-on-path` (phải export PATH).
- Dựng stack (lần đầu, ~vài phút):
  ```bash
  export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"; export MSYS_NO_PATHCONV=1
  cd /d/Dichvuwebsite
  docker compose -f infra/compose.dev.yml up -d --build
  ```
- **Chỉ Caddy mở cổng ra máy:** `localhost:8080` (HTTP) và `localhost:8443` (HTTPS).
  Mọi dịch vụ khác chạy nội bộ → trình duyệt PHẢI vào qua Caddy theo **tên miền**.

## 1. (Một lần) Sửa file hosts

Các tên miền test (`.localtest`, `.nentang.vn`, `.test`) không tự trỏ về máy. Mở
`C:\Windows\System32\drivers\etc\hosts` bằng Notepad chạy **Quyền quản trị** (Run as
administrator), thêm dòng:

```
127.0.0.1  admin.localtest auth.localtest hooks.localtest
127.0.0.1  nha-xinh-1nh1va.nentang.vn
```

> Dòng 2 là tên miền của shop demo. Nếu bạn chạy lại lệnh seed (mục 3) sẽ ra **slug
> mới** → thêm slug đó vào hosts.

## 2. (Một lần) Tin chứng chỉ CA nội bộ của Caddy

Dev dùng CA nội bộ của Caddy → trình duyệt sẽ **cảnh báo chứng chỉ**. Chọn 1 trong 2:

- **Cách nhanh:** cứ mở URL → gặp `NET::ERR_CERT_AUTHORITY_INVALID` → **Advanced → Proceed**.
  (Chrome/Edge nếu ẩn nút Proceed do HSTS: bấm vào trang rồi gõ `thisisunsafe`.)
- **Cách sạch (khuyên dùng):** cài CA của Caddy làm tin cậy, hết cảnh báo:
  ```powershell
  # PowerShell trong D:\Dichvuwebsite
  docker compose -f infra/compose.dev.yml exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > caddy-root.crt
  # rồi PowerShell QUYỀN QUẢN TRỊ:
  Import-Certificate -FilePath .\caddy-root.crt -CertStoreLocation Cert:\LocalMachine\Root
  ```
  Khởi động lại trình duyệt.

## 3. Tạo shop demo (đã có sẵn 1 shop, chạy lại nếu muốn shop mới)

Script tạo shop demo **"Nhà Xinh Décor"** + chủ shop + 6 sản phẩm + 6 đơn (nhiều trạng thái):

```bash
docker compose -f infra/compose.dev.yml exec -T dbtest node apps/seller-admin/test/demo-seed.mjs
```

Chạy xong in ra khối `=== DEMO SEED OK ===`, ghi lại **ownerEmail** và **slug/host**.
Mật khẩu chủ shop CỐ ĐỊNH: `nha xinh chu shop 2026`.

## 4. Tài khoản & URL (đang chạy)

| Vai trò | Mở ở trình duyệt | Đăng nhập |
|---|---|---|
| **Trang bán hàng (khách xem)** | `https://nha-xinh-1nh1va.nentang.vn:8443/` | (công khai) |
| **Admin người bán** | `https://admin.localtest:8443/` | email `chushop-4t2cq0@nhaxinh.vn` · mật khẩu `nha xinh chu shop 2026` |
| **Hộp thư email dev (Mailpit)** | `http://localhost:8025/` | (không cần) |

> ⚠️ Luôn có `:8443` trong URL (Caddy nằm ở 8443, không phải 443). Email chủ shop có
> đuôi ngẫu nhiên theo mỗi lần seed — lấy đúng từ output mục 3.

## 5. Checklist test — Người bán (admin.localtest:8443)

Đăng nhập chủ shop (một bước, chưa bật MFA), rồi thử:

- **Sản phẩm & biến thể:** xem 6 SP mẫu, thêm/sửa/xoá SP, thêm biến thể, đặt giá.
- **Ảnh sản phẩm:** tải ảnh, kéo sắp thứ tự, chọn ảnh đại diện.
- **Tồn kho:** điều chỉnh số lượng, xem sổ tồn (ledger).
- **Đơn hàng:** xem 6 đơn (pending/confirmed/shipped/delivered/cancelled), xác nhận,
  nhập vận đơn, **"Đã nhận tiền (COD)"** cho đơn COD.
- **Nội dung/Trang:** tạo trang (About/Chính sách), sửa block, publish, xem preview.
- **Tài khoản & bảo mật:** **bật MFA** (quét QR bằng app Authenticator → nhập mã) rồi
  đăng xuất/đăng nhập lại để thấy bước MFA; đổi mật khẩu; xem/thu hồi phiên đăng nhập.
- **Nhân sự:** mời nhân viên (email lời mời vào Mailpit), đổi vai trò, xoá.
- **Tên miền riêng:** thêm tên miền → hệ trả bản ghi TXT cần tạo (đây là luồng self-serve).
- **Xuất dữ liệu:** owner + step-up (nhập lại mật khẩu) → tải file ZIP (CSV sản phẩm/đơn/khách).

> Vài thao tác nhạy cảm (xuất dữ liệu, tên miền, quản nhân sự) sẽ hỏi **nhập lại mật
> khẩu** (step-up) — đúng thiết kế.

## 6. Checklist test — Khách mua hàng (storefront)

Mở `https://nha-xinh-1nh1va.nentang.vn:8443/`:

1. Xem danh sách sản phẩm → bấm vào 1 sản phẩm (`/p/...`).
2. **Thêm vào giỏ** → mở **Giỏ** (`/cart`) → chỉnh số lượng.
3. **Thanh toán** (`/checkout`) → nhập tên/điện thoại/địa chỉ → chọn:
   - **COD:** đặt đơn → trang "đặt thành công" + **email xác nhận** (xem ở Mailpit).
     Đơn hiện lên trong admin để xử lý.
   - **QR (VietQR):** hiện mã QR + đơn ở trạng thái chờ. QR chỉ chuyển "đã thanh toán"
     khi có **webhook ngân hàng** — ở local phải giả lập (xem mục 7).
4. **Tra cứu đơn:** dùng số đơn + mã tra cứu ở trang "Tra cứu đơn".

## 7. (Nâng cao) Giả lập thanh toán QR

QR "đã trả" = webhook SePay báo về. Ở local, sau khi đặt đơn QR, gọi:

```bash
curl -k -X POST https://hooks.localtest:8443/webhooks/sepay \
  -H "Authorization: Apikey dev-sepay-secret-key-12345" \
  -H "Content-Type: application/json" \
  -d '{"content":"<payment_ref của đơn>","transferAmount":<số tiền>,"accountNumber":"<tài khoản nhận của shop>"}'
```

> `payment_ref`, số tiền, và số tài khoản nhận phải KHỚP đơn (chống gian lận). Nếu cần,
> nhờ mình viết script giả lập tự lấy đúng các giá trị này.

## 8. Xem email (Mailpit)

Mọi email dev (xác nhận đơn, biên nhận đã thanh toán, lời mời nhân viên, reset mật
khẩu) rơi vào **Mailpit**: `http://localhost:8025/`. Không gửi ra ngoài thật.

## 9. Lưu ý / giới hạn của bản LOCAL

- **Cảnh báo chứng chỉ là bình thường** (CA nội bộ) — mục 2 xử lý.
- **Admin quản trị NỀN TẢNG (platform-staff)** — nơi *tạo/khoá shop* — chưa có giao diện
  web trong dev (chỉ có API). Vì vậy shop được tạo bằng **script seed** (mục 3), không
  qua trình duyệt. Nếu muốn test cả phần này bằng UI, cần thêm một site block Caddy
  cho `platform:3030` — nói mình biết nếu cần.
- Đây là môi trường **DEV** (secret dev: `devpassword`, `minioadmin123`,
  `dev-sepay-secret-key-12345`). KHÔNG dùng cho khách thật — đó là việc của Tuần B (VPS + secret thật).

## 10. Config dev đã thêm để test local được

- `infra/compose.dev.yml`: publish cổng Mailpit `8025:8025` (xem email trên trình duyệt).
- `infra/caddy/Caddyfile.dev`: thêm block `*.nentang.vn` (cert nội bộ wildcard) để
  storefront của shop tạo-mới (subdomain onboarding) mở được ở local — prod vốn dùng
  wildcard DNS-01 cho `*.nentang.vn`, đây là bản dev tương đương.
