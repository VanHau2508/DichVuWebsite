# 49 — Shop tự trả tiền thuê bao (đường tiền của nền tảng)

Gỡ đúng nút thắt mà đợt đánh giá cũ gọi là "vận-hành-SaaS 40%": nền tảng **thu hút khách
tự động nhưng THU TIỀN thủ công**, và người không trả im lặng dùng mãi. 10 shop còn làm tay
được; 100 shop là việc toàn thời gian; 1000 shop là không thể.

## Bốn chỗ đứt (trước khi làm)

| | |
|---|---|
| Chủ shop xem gói/hạn | không có màn hình nào |
| Shop tự trả tiền | chỉ có console, nhân viên gõ tay **sau khi** đã nhận tiền |
| Nền tảng có tài khoản nhận tiền | chưa — SePay chỉ cắm per-shop |
| Hết hạn | worker lật `subscriptions.status` nhưng **không ai đọc**; storefront chỉ kiểm `shops.status` do người bấm |

## Cách thu

VietQR + SePay ở **cấp nền tảng** — đúng cơ chế shop đang dùng để nhận tiền khách. Không
cổng thẻ, không Stripe. `pay_ref` (nội dung chuyển khoản) là thứ **duy nhất** nối một lần
chuyển tiền với một cửa hàng.

**Hai bảng, không gộp.** `platform_invoices` (0061) là SỔ THU append-only — chứng từ. Nhét
hoá đơn CHƯA TRẢ vào đó là bơm dòng chưa-có-tiền vào báo cáo doanh thu, và MRR sẽ nói dối
mà không ai thấy sai. `billing_charges` là YÊU CẦU trả tiền, có vòng đời pending → paid →
applied.

**Tách vai.** `payment` (vai hẹp, ăn dữ liệu từ Internet) CHỈ đánh dấu đã trả; `worker` mới
cộng hạn + mở khoá + ghi sổ thu. Để payment làm hết thì endpoint công khai phải có quyền
sửa `subscriptions` và `shops`.

## Cưỡng chế: ân hạn 7 ngày → khoá bán

Admin **vẫn vào được** để trả tiền + xuất dữ liệu — khoá cả lối trả tiền là tự chặn tiền của
mình. Trả xong tự mở lại, và trả về **đúng trạng thái cũ** (không ép `active`: bấm hộ nút
"Mở bán" là quyết định thay chủ shop). Shop bị **nhân viên nền tảng** khoá thì trả tiền
KHÔNG mở được — nếu không, cưỡng chế thành vô nghĩa.

Email nhắc hạn (dunning 7-3-1 + past_due, đã có từ 0028) nay đặt **link tự gia hạn lên
trước** email liên hệ: bản cũ chỉ nói "liên hệ nền tảng", tức là bắt người ta chờ mình trả
lời để được trả tiền cho mình.

## Bốn lỗi e2e bắt được (đọc code không thấy)

1. Shop `'onboarding'` **vẫn bán được** → lọt lưới mọi cưỡng chế viết theo `status='active'`.
2. Thiếu `GRANT plan_code` → `permission denied`; tiền **vào tài khoản** mà hạn không cộng,
   lỗi chỉ nằm trong log worker.
3. Mở-khoá tách khỏi xoá-cờ = phụ thuộc thứ tự → có lúc khách **trả tiền rồi vẫn bị khoá**,
   kết cục tệ nhất. Gộp vào MỘT câu lệnh (CTE) thì hết khe.
4. Bất biến schema **cấm `app_rw` dùng policy hằng-true** — đã phạm để seller đọc số tài
   khoản. Không né bằng biểu thức nguỵ trang; bỏ hẳn nhu cầu: `PLATFORM_BANK_*` ra **env**.

## Cấu hình

| Nơi | Cái gì |
|---|---|
| env | `PLATFORM_BANK_BIN` · `PLATFORM_BANK_ACCOUNT` · `PLATFORM_BANK_NAME` · `BILLING_GRACE_DAYS` |
| DB | chỉ `sepay_token_hash` + `enabled` — đặt ở **Console → Thu tiền thuê bao** |

Cố ý không cho sửa số tài khoản qua web: đổi nhầm trên giao diện là tiền của shop chảy đi
chỗ khác.

## Bẫy quy trình

`apps/worker` **không mount `src/`** — sửa code phải `up -d --build worker`; `restart` giữ
nguyên bản trong image. Đã tốn một vòng chẩn đoán sai vì chuyện này (e2e đỏ, đọc code thấy
đúng). Cảnh báo đã ghi tại `infra/compose.dev.yml`.

## Test

`apps/seller/test/billing.e2e.mjs` (34) — đi trọn vòng + **bấm thật trên màn hình** (gửi
form tạo mã, khẳng định số tiền trên trang khớp DB), kèm: trả trùng không cộng đúp · trả
thiếu không ghi nhận · mã lạ không khớp · token per-shop không mở được hoá đơn nền tảng ·
giá không nhận từ client · console hiện cả hai nửa cấu hình.

## Còn thiếu

* Hoá đơn VAT (NĐ123) vẫn lập ngoài hệ thống — `platform_invoices` là căn cứ số liệu.
* Chưa có nhắc hạn qua Telegram cho chủ shop (email + trong-app đã có).
