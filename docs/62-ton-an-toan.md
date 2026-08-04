# Tồn an toàn (safety stock) — v0

Chừa lại một phần tồn **không bán online**, để hàng vỡ / bán tại quầy / đếm sai không làm khách
đặt trúng món đã hết. Migration `0140`.

## Vì sao làm cái này, và vì sao KHÔNG làm "chia kho theo kênh"

Câu hỏi đầu tiên mọi người bán hỏi khi nghe *"bán trên web của chính mình"* là **"lỡ hết hàng
thì sao?"** — con số tồn trong hệ luôn trôi khỏi kho thật.

Phương án đối thủ đã cân nhắc là **chia tồn theo kênh** (web được N cái, sàn được M cái). Nó tạo
ra một *hồ riêng* cho web; hồ đó cạn trong khi kho vẫn còn → web báo hết hàng **oan**, tự tay
chặn doanh thu của shop. Muốn tránh thì phải biết sàn đã bán bao nhiêu, tức phải có API sàn.

Tồn an toàn **không có hồ riêng** — nó chỉ là một mức sàn trên chính con số tồn — nên lớp lỗi
"hết hàng ảo" **không tồn tại**. Cùng một câu trả lời cho người bán, rẻ hơn nhiều, rủi ro gần
bằng không. Mô hình chia-kênh để dành cho v1, khi đã có API đồng bộ thật.

## Công thức, và vì sao nó chỉ có MỘT bản

```
đệm      = ghi đè của biến thể, KHÔNG có thì ceil(tồn thực × tỉ lệ shop / 100)
bán được = max(0, tồn thực − đang giữ chỗ − đệm)
```

Toàn hệ có **25 chỗ** tính `on_hand - reserved`. Rải tay phần trừ đệm vào từng chỗ thì chuyện
lệch là chắc chắn — kho này đã dính đúng lớp lỗi đó ba đợt liền (docs/58, 60, 61).

Nên công thức nằm ở **một file duy nhất** `packages/inventory/src/safety-stock.js`, tới ba
service (`checkout` · `storefront` · `seller`) bằng **bind-mount** khai trong cả
`compose.dev.yml` lẫn `compose.prod.yml` — đúng cơ chế đang dùng cho `packages/net-guard` và
`packages/auth/src/ratelimit.js`.

Đánh đổi: một bản dùng chung (không thể trôi lệch) đổi lấy **một phụ thuộc vô hình** với
Dockerfile. Mất mount = service chết ngay lúc khởi động — hỏng to và hỏng sớm là cố ý, nhưng
phát hiện lúc deploy vẫn muộn hơn CI, nên có `apps/seller/test/safety-mount.test.js` canh:
service nào `import '../safety-stock.js'` thì **cả hai** compose phải có dòng mount.

Hai quyết định nhỏ đáng ghi:

- **`ceil` chứ không `floor`.** Đệm là vùng chống sai số → chệch về phía *giữ nhiều hơn* mới
  đúng ý định. (Ngược hẳn với tiền: `affiliate_commission_amount` làm tròn **xuống** để không
  đẻ đồng không có thật.)
- **`max(0, …)`.** Shop đặt đệm lớn hơn tồn hiện có (chừa 20% khi kho còn 3 cái) → kết quả 0,
  không phải số âm.

## Phạm vi — đệm chặn AI, và cố ý KHÔNG chặn ai

| Đường | Có bị đệm chặn? | Vì sao |
|---|---|---|
| Khách đặt trên web (storefront + checkout) | **Có** | Đây là đường mà con số trong máy là *bằng chứng duy nhất* |
| Đơn **tay** người bán tự tạo | **Không** | Lúc đó họ đứng trước khách và **nhìn thấy** kho thật. Đệm sinh ra để bù cho việc con số không đáng tin — mà người thì đáng tin hơn con số |
| Màn hình kho của người bán (tồn kho, cảnh báo sắp hết, bot) | Không — hiện **số thật** | Shop phải thấy đúng cái đang có trong kho |

Ranh giới này **có test canh cả hai chiều**, không phải chuyện sót.

Hàng rào chống oversell thật (`reserved <= on_hand`, 0009) vẫn nguyên vẹn là **lớp cuối cùng**;
đệm là lớp nằm **trên** nó, cưỡng chế trong chính transaction đặt đơn (cùng chỗ giữ `FOR UPDATE`).

### Vì sao không phải một CHECK của DB

Tỉ lệ nằm ở bảng `shops`, mà `CHECK` chỉ nhìn được cột cùng dòng. Và `CHECK (reserved <= on_hand
- safety)` còn **sai về ngữ nghĩa**: đệm chỉ chặn giữ chỗ **mới**, nó không được cấm nhả chỗ hay
xuất hàng đã giữ từ trước — shop bật đệm lúc đang có nhiều đơn chờ sẽ khiến *mọi* UPDATE trên
dòng đó vỡ, kể cả lệnh huỷ đơn.

## Ba con số trên màn hình

Trang **Kho → Tồn an toàn** hiện cùng lúc: `Tồn thực` · `Đang giữ chỗ` · `Giữ an toàn` ·
**`Còn bán được online`**, cộng cột `Số lần bị chặn`.

Nếu chỉ hiện "còn bán được", người bán mở kho thấy 100 cái mà web nói 80 sẽ tin là hệ thống đếm
sai — rồi tắt tính năng. Bốn cột khép kín phép trừ nên nó **tự giải thích**; `Tồn thực` cũng
chính là con số mà Sổ cái kho cộng dồn ra, tức **đối chiếu được**.

Hai đơn vị khác nhau là cố ý: mức chung của shop theo **tỉ lệ** (tự co giãn khi nhập thêm hàng;
số tuyệt đối thì đứng yên và mục nát), còn ngoại lệ từng biến thể theo **số cái** (người bán
nghĩ bằng "món này luôn chừa 2"). **Ô trống ≠ số 0**: trống = bỏ ngoại lệ, quay về tỉ lệ chung;
`0` = sản phẩm này không giữ lại gì cả.

Trần **90%**, không phải 100: 100% nghĩa là không bao giờ bán được gì — một cái bẫy chân không
ai cố ý muốn. Quyền: `inventory.manage` (owner/admin) — đệm là **cần gạt doanh thu**, đặt 90% là
gần như đóng cửa hàng.

## Đo cái giá của tính năng

`inventory_levels.safety_blocked_count` đếm những lần khách bị **đệm** chặn *trong khi kho vẫn
còn hàng thật*. Không có con số này thì không ai biết đệm đang bảo vệ shop hay đang ăn doanh thu
của họ — và một tháng "nghe khách phản hồi" sẽ chỉ ra giai thoại.

Bị chặn vì **hết sạch** thì **không** đếm: ca đó tính năng đang làm đúng việc, không phải chi phí.

Hai chi tiết cài đặt:

- Đếm **sau khi** transaction rollback. Đếm trong tx thì con số cũng bị `fail()` cuốn theo. Mở
  connection thứ hai ngay lúc đó thì **treo**: tx ngoài đang giữ `FOR UPDATE` trên chính dòng đó.
- **Cố ý không `await`** — đo đạc không được giữ chân khách. Hệ quả: con số tới trễ vài ms, nên
  test phải *chờ có trần* chứ không đọc ngay (xem "bẫy đo" bên dưới).

**Giới hạn đã biết của v0:** chỉ đếm ở bước *đặt hàng*. Khách thấy trang báo "hết hàng" rồi bỏ đi
thì không đếm được (storefront không có quyền ghi, và cũng không nên có). Con số này vì vậy là
**sàn dưới** của thiệt hại thật.

## Bốn bẫy ĐO trong đợt này

Bộ e2e `apps/checkout/test/safety-stock.e2e.mjs` (57 khẳng định) lúc đầu **xanh vì lý do sai** ở
bốn chỗ khác nhau. Cả bốn đều cùng một hình dạng: *khẳng định không đo thứ nó tưởng.*

1. **Chữ "Hết hàng" có sẵn trong mọi trang SP** — nằm trong khối JS đổi nhãn khi chọn phân loại.
   Regex theo chữ luôn khớp → khẳng định xanh vĩnh viễn. Dấu hiệu thật là `class="stock out"`.
   (Đúng lớp bẫy "khớp nhầm chú thích CSS" của đợt TMĐT.)
2. **Vai `'staff'` không tồn tại** (rbac chỉ có owner/admin/catalog_manager/order_manager). Lời
   mời 400 → không có phiên → ba khẳng định phân quyền nhận **401** và *trông như đã chặn*. Nay
   dùng `order_manager` + một chốt chặn khẳng định "dựng được tài khoản thật" trước khi đo.
3. **Ca "hết sạch" chưa từng chạm hàng rào checkout.** Bước *thêm vào giỏ* có hàng rào tồn
   riêng, nó chặn trước → checkout không hề chạy. Đột biến gỡ điều kiện đếm vẫn **xanh**. Nay
   dựng đúng bằng **hai giỏ mở cùng lúc**: khách 1 mua sạch, khách 2 mới bấm đặt.
4. **Trần chống-đơn-ảo chặn trước vùng đệm.** Một máy đóng vai 12 khách với cùng một SĐT → 429
   và "quá nhiều đơn chưa xử lý". Nay mỗi đơn một SĐT + nới `max_pending_per_ip/phone` cho shop
   test.

Bốn đột biến đã chạy, mỗi cái phải ĐỎ đúng chỗ rồi khôi phục:

| Đột biến | Kết quả |
|---|---|
| `AVAIL_SQL` bỏ phần đệm (đường **hiển thị**) | 6 đỏ — storefront + trang cấu hình |
| `availOf` bỏ phần đệm (đường **cưỡng chế**) | 19 đỏ — bán quá phần, đua, ghi đè |
| Bỏ điều kiện `on_hand - reserved > 0` ở bộ đếm | 1 đỏ — chỉ sau khi vá bẫy #3 |
| BFF quy ô-trống về `0` | 1 đỏ — mất đường quay về tỉ lệ chung |

## Việc CỐ Ý chưa làm (v1 trở đi)

- **Cảnh báo chủ động** ("SKU X bị chặn 40 lần tuần này") — chờ dữ liệu thật từ shop dùng, chưa
  biết họ cần cảnh báo kiểu gì.
- **Đệm theo tốc độ bán** (chừa nhiều hơn cho hàng chạy) — cần lịch sử bán đủ dài.
- Đếm cả lần khách **bỏ đi ở trang SP**, không chỉ lúc bấm đặt.
- Chia tồn theo kênh — chỉ khi đã có API sàn.
