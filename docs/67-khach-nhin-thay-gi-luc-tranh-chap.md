# 67 — Khách nhìn thấy gì lúc tranh chấp

**2026-08-06.** Mảnh còn lại của vai *chủ shop lúc có sự cố* (docs/65), nhưng nhìn từ phía bên
kia: khách vừa trả hàng, đang chờ tiền về, mở điện thoại ra xem. Hai màn hình họ đọc — trang
**tra cứu đơn** (dán số đơn + mã, không cần tài khoản) và **lịch sử đơn** của khách đã đăng
nhập.

## Đo trước khi viết

Trên shop ngày-60, mở đúng hai đơn thật bằng chính đường khách đi:

| đơn | thực tế | trang nói gì |
|---|---|---|
| #275 | khách trả hàng, shop **đã hoàn 1.405.000₫** | trạng thái in ra chữ **`refunded`** (tiếng Anh, badge xanh) · vẫn ghi "Thanh toán khi nhận hàng (COD)" · **không một chữ nào** về khoản đã hoàn |
| #267 | huỷ, khách trả 1.990.000₫, shop hoàn 1.560.000₫ | chỉ "Đã huỷ" · im lặng hoàn toàn về **430.000₫ còn lại** |

Đọc mã ra thêm hai biến thể tệ hơn, cả hai đã dựng lại bằng luồng thật trong bộ test:

- **đơn QR bị bom hàng** giữ `payment_status='paid'` → trang hiện **"Đã thanh toán ✓"** như
  chưa có chuyện gì. Đây đúng là phát hiện gốc.
- **đơn QR đã hoàn tiền** có `payment_status='refunded'` (khác `'paid'`) → rơi xuống nhánh
  cuối và trang **vẽ lại mã QR đòi khách chuyển khoản**, kèm `<meta refresh>` tự tải lại mỗi
  8 giây. Khách vừa được hoàn tiền mở link ra thấy shop đòi tiền tiếp.

## Gốc của cả bốn: một định nghĩa quá hẹp

```js
if (o.payment_method === 'qr' && o.status !== 'cancelled') { …khối thanh toán… }
```

`'cancelled'` là trạng thái chết **duy nhất** được biết tới. Nhưng đơn chết có **ba**:
`cancelled`, `returned`, `refunded`. Mọi thứ sai bên trên đều chảy ra từ chỗ hẹp đó — cùng lớp
lỗi với chốt hoàn tiền ở docs/65 (khoá theo `'returned'` trong khi có hai đường tới đó).

Bảng nhãn cũng thiếu đúng hai trạng thái ấy nên in chữ thô — **lặp lại y hệt** lỗi nhãn
`pending` lọt ra email đã vá cùng ngày hôm trước.

## Đã làm

**`daDong = ['cancelled','refunded','returned']`** cho cả trang tra cứu. Đơn đã đóng thì không
QR, không tự tải lại, không "Đã thanh toán ✓", không dòng COD — thay bằng **khối tiền**:

> Bạn đã thanh toán · Cửa hàng đã hoàn lại (kèm ngày) · **Cửa hàng còn phải hoàn**

Con số cuối dùng **chung biểu thức** với trang quản trị và trang Công nợ (docs/66): `owed.js`
chuyển từ `apps/seller/src/` sang **`packages/orders/src/`** và bind-mount vào seller ·
checkout · account. Lý do không thoả hiệp: khách và shop mà đọc hai con số khác nhau thì cuộc
gọi khiếu nại bắt đầu bằng hai bên cãi nhau về màn hình.

**Cố ý KHÔNG hứa mốc thời gian** ("trong vòng N ngày"). Nền tảng không biết shop chuyển khoản
lúc nào; hứa hộ người khác là cách nhanh nhất để mất uy tín của cả hai.

**Màn hình khách đã đăng nhập** dính cùng bệnh ở dạng lộ liễu hơn: nó in thẳng hai nhãn cạnh
nhau — `Đã trả` và `Đã thanh toán`. Nhãn thứ hai đúng về kỹ thuật (`payment_status` vẫn là
`paid`) và là **nửa sự thật** với người đọc. Nay đơn đã đóng thì bỏ nhãn đó, thay bằng cùng
khối tiền.

**Quyền DB:** `0145` cho `app_checkout`, `0146` cho `app_customer` — `GRANT SELECT` **theo
cột** `(shop_id, order_id, amount_vnd, created_at)`. Không cấp `reason` (người bán gõ tự do,
có thể là ghi chú nội bộ về chính khách đó) và `created_by` (danh tính nhân viên). Cấp cả bảng
cho tiện là cách rò dữ liệu nội bộ mà sau này không ai nhớ tại sao.

## Ba lần vấp trong lúc làm

1. **`fetch` của Node cấm đặt header `Host`.** Mọi lời gọi trang khách rơi vào 404 "tên miền
   chưa kết nối" và tôi đi tìm lỗi ở RLS, ở `domains`, ở role — mất khá lâu. Phải dùng
   `http.request`. Tệ hơn: **vấp lại lần thứ hai** ở phần test cho service `account`, ngay sau
   khi vừa viết chú thích cảnh báo về chính nó.
2. **Mount cùng một file nhưng ĐÍCH khác nhau.** `account` để mã ở `/app/apps/account/src` nên
   `'../owed.js'` trỏ `/app/apps/account/owed.js`, không phải `/app/owed.js` như seller và
   checkout. Mount sai → container chết lúc khởi động với `ERR_MODULE_NOT_FOUND`. Đã mở rộng
   `safety-mount.test.js` để canh **đích theo từng service**, và đột biến đổi đích của
   `account` làm test đỏ đúng chỗ kèm câu chỉ thẳng dòng cần thêm.
3. **Sai cổng service** (`account:3080` thay vì `3062`) — bộ test có sẵn đã ghi đúng số, tôi
   không đọc trước khi gõ.

## Bằng chứng

`apps/checkout/test/khach-luc-tranh-chap.e2e.mjs` — **19 khẳng định**, 5 phần: bom hàng · đã
hoàn tiền · hoàn một phần · đơn còn sống không bị đụng · màn hình khách đăng nhập.

Hai đột biến đỏ đúng chỗ: thu hẹp `daDong` về `['cancelled']` → 4 đỏ (QR đòi tiền quay lại,
"Đã thanh toán ✓" quay lại) · bỏ khối tiền khỏi trang → 5 đỏ.

Khẳng định đắt nhất: **số khách thấy phải bằng số shop thấy**, so trực tiếp `owed_vnd` của API
seller với chuỗi in trên trang khách và trên trang tài khoản.

## Còn lại

- Email đổi-trạng-thái chưa nói về tiền hoàn (chỉ nói trạng thái) — cùng lớp, chưa làm.
- Shop chuyển tiền thuê bao bị vào hàng đợi thì **shop** không được báo gì (xem ghi chép
  webhook nền tảng) — cùng hình dạng "một bên biết, bên kia mù", ở tầng nền tảng.
