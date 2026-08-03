# Tiền shop trả nền tảng bị "nuốt im lặng" — và hàng đợi đối soát (0135)

## Chuyện gì đã xảy ra

Đường tiền NỀN TẢNG (shop trả thuê bao cho nentang.vn) và đường tiền KHÁCH (khách trả cho
shop) đi qua **cùng một webhook** `POST /webhooks/sepay`, nhưng rẽ nhánh rất sớm.

Nhánh tiền-khách, khi không khớp được đơn, ghi vào `unmatched_transfers` — hàng đợi đối
soát — và `sweepMoneyAlerts` đếm bảng đó rồi bắn cảnh báo. Đúng.

Nhánh tiền-nền-tảng (`apps/payment/src/server.js:254-284`) **return trước khi tới**
`persistUnmatched`. Và kể cả có gọi tới cũng không dùng được: `persistUnmatched` ghi theo
`current_shop_id()`, mà nhánh này chưa hề `set_config('app.shop_id')` — hợp lý, vì shop
chính là thứ chưa xác định được.

Kết quả: **mọi** lý do không khớp chỉ đẻ ra một dòng `log warn` rồi biến mất.

| Lý do | Xảy ra khi |
|---|---|
| `no_ref` | shop gõ thiếu/sai mã `SUB…` trong nội dung chuyển khoản |
| `charge_not_found` | mã không có trong hệ thống |
| `charge_cancelled` | shop bấm "Tạo mã thanh toán" lần nữa **sau khi** đã quét QR chuyển tiền theo mã cũ (`billing.js:128` huỷ mã cũ) |
| `amount_short` | ngân hàng trừ phí → về thiếu vài nghìn |

Hậu quả nặng nhất không phải "mất một khoản": tiền vẫn nằm trong tài khoản nền tảng. Nặng
nhất là **shop đã trả tiền rồi vẫn bị khoá bán** sau 7 ngày ân hạn
(`sweepBillingEnforce`), và không ai — kể cả người vận hành — có cách nào biết vì sao.

Ba luật, mỗi luật đúng khi đọc riêng: (1) một hoá đơn chờ trả tại một thời điểm; (2) webhook
không cho tiền khớp vào hoá đơn đã chết; (3) có hàng đợi đối soát cho giao dịch chưa khớp.
Ghép lại thì luật (3) không với tới được nhánh này.

## Đang làm gì

`platform_unmatched_transfers` (0135) — bảng RIÊNG, không dùng chung với
`unmatched_transfers`: bảng kia `shop_id NOT NULL` + RLS FORCE theo `current_shop_id()`, mà
ở đây shop là thứ ta chưa biết. Nới `shop_id` thành nullable là chọc thủng đúng cột mà RLS
của tiền-khách dựa vào.

- **Ghi**: cả 4 nhánh trượt đều `INSERT ... ON CONFLICT (provider, provider_event_id) DO
  NOTHING` — SePay gửi lại cùng sự kiện không đẻ dòng thứ hai. Ghi kèm `shop_id` khi biết
  (`charge_*`, `amount_short`), NULL khi không (`no_ref`, `charge_not_found`).
- **Kêu**: `sweepMoneyAlerts` đếm thêm `plat_unmatched_open`, **ngưỡng 1, không chờ 1 tiếng**
  như tiền-khách — mỗi dòng là một shop sắp bị khoá oan, không có "mức nhiễu chấp nhận được".
- **Xử**: console nền tảng → *Thu tiền thuê bao* hiện danh sách kèm lý do bằng câu người
  thường đọc được, và nút **Đã xử lý**. Không cho DELETE (GRANT không có) — đây là vết của
  tiền; đóng lại là ghi `resolved_at/resolved_by/note`.
- Quy trình cho người vận hành: đối chiếu → vào shop đó bấm **Ghi nhận đã thu** (đường có
  step-up, cộng hạn thật) → quay lại đánh dấu đã xử lý.

## CÒN ĐỂ LẠI (cố ý)

**Không cộng dồn tiền cho hoá đơn nền tảng.** Đường tiền-khách cộng dồn (`cumulative`), nên
khách chuyển thiếu rồi chuyển bù là đủ. Đường này thì không: mỗi lần chuyển đều bị so với
`amount_vnd` nguyên, nên **chuyển bù cũng sẽ `amount_short` tiếp**. Shop không tự sửa được,
phải qua người vận hành.

Chưa làm vì cần thêm cột `paid_vnd` trên `billing_charges` + đổi cách tính "đủ tiền" + nghĩ
lại ca chuyển dư. Sau khi có hàng đợi + cảnh báo thì khoản này KHÔNG còn mất im lặng nữa,
chỉ tốn một lần thao tác tay — chấp nhận được ở quy mô hiện tại. Ngưỡng để làm: khi
`amount_short` xuất hiện đều đặn trong hàng đợi (tức ngân hàng của shop hay trừ phí).
