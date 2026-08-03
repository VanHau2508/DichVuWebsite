# Sửa đơn và các khoản GIẢM GIÁ (mã giảm giá · điểm thưởng)

Ghi lại luật đang chạy ở `reconcileEditLines` (apps/seller/src/orders.js) và **phần cố ý
chưa làm**, để lần sau không ai phải đoán.

## Vấn đề

Checkout kẹp mã giảm giá **hai lớp** (`apps/checkout/src/server.js:313-330`):

1. từ chối mã khi `subtotal < min_subtotal_vnd`;
2. `discount = max(0, min(raw, subtotal))` — giảm giá không bao giờ vượt tiền hàng.

Đường **sửa đơn** (seller-admin → mở đơn → Sửa) vốn bê nguyên `discount_vnd` cũ sang tiền
hàng MỚI, không tra lại bảng `coupons` lần nào. Dựng lại được (`test/_audit/a14-sua-don-coupon.mjs`):

| | tiền hàng | giảm giá | ship | khách trả |
|---|---|---|---|---|
| đơn gốc | 340.000 | 85.000 | 60.000 | 315.000 |
| sửa còn 1 món | **85.000** | **85.000** ← vẫn nguyên | 60.000 | **60.000** |

Mã đó đòi "đơn từ 340.000₫". Sau khi sửa, đơn còn 85.000₫ tiền hàng mà vẫn ăn đủ 85.000₫ —
**khách ôm hàng miễn phí, chỉ trả tiền ship**. Ca nặng hơn (giảm > hàng + ship) thì rơi vào
`422 tổng đơn âm`, mà màn Sửa đơn **không có ô nào chỉnh giảm giá** → ngõ cụt, người bán chỉ
còn cách huỷ đơn.

Đây là lỗi HỢP THÀNH: cả hai luật đều đúng khi đọc riêng. Checkout đúng vì nó luôn tính
giảm giá cùng lúc với tiền hàng. Sửa đơn đúng vì "giữ nguyên các khoản đã chốt với khách".
Ghép lại thì tiền hàng đổi mà giảm giá không đổi.

## Luật hiện hành

`tranGiamGiaSauSua()` tính **trần** cho giảm giá sau khi sửa dòng hàng:

- **Mã còn trong bảng `coupons`** → tính lại y hệt `couponDiscount()` của checkout trên số
  hàng CÒN LẠI: dưới `min_subtotal_vnd` thì về 0; `percent` làm tròn xuống; cap ≤ tiền hàng.
  *Không lọc `active`/`expires_at`*: ta không CẤP LẠI mã, chỉ đọc LUẬT của nó. Mã đã tắt mà
  xoá sạch giảm giá của đơn cũ là phạt oan khách.
- **Mã đã bị xoá khỏi bảng** → không còn luật để tra → chia theo **tỷ lệ** hàng còn lại,
  đúng quy tắc phân bổ giảm giá đã dùng ở nhận-trả-hàng (`createReturn`).
- Và luôn `min(giảm cũ, trần)` — **sửa THÊM hàng không bao giờ làm giảm giá phình ra**.

Một câu cho người bán: *"Sửa đơn cho ra đúng con số như khách vừa đặt đơn mới với đúng số
hàng đó; thêm hàng cũng không làm giảm giá to lên."*

Số mới ghi vào `orders.discount_vnd` và vào nhật ký `order.edited` (`changed.discount_vnd`) —
đây là khoản tiền đổi mà người bán KHÔNG tự gõ, không ghi thì sau này không giải thích được.

## CỐ Ý CHƯA LÀM — điểm thưởng khi sửa đơn xuống

Điểm thưởng (`points_discount_vnd`) **không** bị kẹp. Cố ý:

- Điểm là tiền **khách đã tiêu**, không phải ưu đãi của shop. Kẹp xuống = ăn không của khách.
- Đường ra đúng là **hoàn lại phần điểm thừa** vào sổ điểm — cần seller ghi được
  `loyalty_ledger`/`loyalty_balances`, mà hôm nay chỉ worker (vai `app_loyalty`) ghi. Đó là
  một mảnh việc thật, không phải sửa vài dòng.
- Trong lúc chưa có: nếu điểm đẩy tổng xuống âm, API trả 422 với lời khuyên **huỷ đơn và đặt
  lại** (huỷ sẽ nhả điểm về qua `sweepLoyaltyClawback` nhánh A) thay vì câu "điều chỉnh lại"
  vô nghĩa cũ.

Ngưỡng để làm: khi có shop thật dùng điểm thưởng VÀ sửa đơn thường xuyên. Trước đó thì
đường huỷ-đặt-lại đã đúng tiền, chỉ tốn thao tác.
