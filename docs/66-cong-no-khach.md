# 66 — "Tôi còn nợ khách bao nhiêu": một màn hình, một công thức

**2026-08-05.** Phát hiện nặng nhất còn lại của vai *chủ shop lúc có sự cố* (docs/65): số tiền
shop đang giữ hộ khách **không được cộng lại ở đâu cả**. Nó nằm rải trong từng đơn, và chủ shop
chỉ biết mình nợ khi khách gọi tới đòi — lúc đó thì đã mất khách.

## Đo trước khi viết

Trên shop ngày-60 (395 đơn, `scripts/seed-day60.sh`):

| hình dạng | số đơn | tiền |
|---|---:|---:|
| `returned` + `paid`, chưa hoàn (bom hàng đã trả trước) | 10 | 5.620.000₫ |
| `cancelled` + `paid`, từng sửa giảm | 1 | 430.000₫ |
| **tổng** | **11** | **6.050.000₫** |

Phần mềm lúc đó hiện **0₫** trong số này. Băng đỏ duy nhất đang có (0117) chỉ bắt đơn
`cancelled`, và với đơn từng sửa giảm thì công thức của nó ra số âm nên tự tắt.

## Cái sai của luật cũ

Luật cũ nằm thẳng trong `pages.js`, tính ở tầng **hiển thị**:

```js
const owed = Number(o.total_vnd) - Number(o.refunded_total_vnd ?? 0);
if (o.status === 'cancelled' && o.payment_status === 'paid' && owed > 0) { …băng đỏ… }
```

Hai lỗi, cả hai đều là lỗi về **nghĩa của con số**:

1. **Chặn theo `status === 'cancelled'`.** Nhưng đơn chết có hai đường: huỷ, và hoàn về. Đơn
   **bom hàng khách đã trả trước** mang trạng thái `returned` — hàng đã về shop, tiền chưa về
   khách, và luật cũ mù hoàn toàn ở đó. 10 đơn, 5,62 triệu.
2. **Lấy `total_vnd` làm "đã thu".** Hai số này lệch nhau ở mọi đơn từng sửa. Đơn `cancelled`
   duy nhất trên shop ngày-60: đã thu 1.990.000₫, sửa giảm còn 430.000₫ (tự hoàn 1.560.000₫),
   rồi huỷ. Luật cũ tính `430.000 − 1.560.000 = −1.130.000` → không `> 0` → **không cảnh báo
   gì**, trong khi shop đang giữ 430.000₫ của khách.

> Cái shop nợ là cái shop đã **cầm**, không phải cái đơn **ghi**.

## Công thức

Một nguồn duy nhất: `apps/seller/src/owed.js`.

```
còn nợ = greatest(0, ĐÃ THU − ĐÃ HOÀN − ĐƯỢC PHÉP GIỮ)
```

- **ĐÃ THU** = `amount_paid_vnd`.
- **ĐÃ HOÀN** = tổng bảng `refunds`, **gồm cả** `kind='edit_adjustment'` — tiền trả lại vì sửa
  đơn giảm cũng là tiền đã về tay khách.
- **ĐƯỢC PHÉP GIỮ** = `total_vnd` khi đơn còn sống; **0** khi đơn đã chết (`cancelled` /
  `returned` / `refunded`). Đơn chết = khách không nhận được gì, shop không có quyền giữ đồng
  nào, kể cả phí ship.
- **`greatest(0, …)`** vì đơn giao xong mà shop hoàn thiện chí sẽ ra số âm — âm nghĩa là shop
  trả **dư**, đó là quà, không phải khoản khách nợ shop.

Kiểm ngược trên dữ liệu thật: công thức ra **0 cho mọi nhóm đơn khoẻ mạnh** (delivered, shipped,
pending, confirmed) và ra số dương đúng ở hai nhóm đơn chết-mà-đã-thu. Đó là dấu hiệu mạnh nhất
rằng công thức đúng, mạnh hơn bất kỳ ca thử nào tôi tự nghĩ ra.

Kèm **lý do** (`OWED_REASON_SQL`), vì ba lý do dẫn tới ba cách xử lý khác nhau:
`huy_da_thu` · `hoan_ve_chua_tra` · `thu_thua`.

**Nhánh `thu_thua` hôm nay chưa có đường tới** — sửa-đơn-giảm tự sinh phiếu hoàn bù đúng phần
chênh, nên không luồng nào để lại tiền thừa. Giữ nhánh để nếu có ngày tiền thừa lọt vào thì nó
**hiện ra** thay vì lặng lẽ biến mất. Đã ghi rõ điều này trong bộ test thay vì bịa một ca thử.

## Ba nơi, một con số

| nơi | dùng gì |
|---|---|
| trang **Công nợ khách** (`/orders/owed`) | `OWED_SQL` |
| ô **"Còn nợ khách"** trên Tổng quan | `OWED_SQL` |
| **băng đỏ** trên trang đơn | `owed_vnd` do API trả, cũng từ `OWED_SQL` |

Trang quản trị **không còn tự trừ tay** — đó chính là cách con số tiền sinh ra lần thứ hai rồi
lệch. Ô trên Tổng quan đứng **đầu tiên**, trước cả "Đơn chờ xác nhận": mọi ô khác là tiền của
shop về chậm, ô này là tiền của **người khác** đang nằm trong túi shop. Nhãn mang theo **số
tiền** vì số đơn không nói lên mức độ — 1 đơn nợ 20 triệu gấp hơn 11 đơn nợ 500 nghìn.

Danh sách **không phân trang**: đây là hàng đợi việc, không phải kho lưu trữ. Trần cứng 500 dòng
để dữ liệu hỏng không kéo sập trang, và **nói thẳng** khi bị cắt — còn con số tổng vẫn tính trên
**toàn bộ** đơn, vì một cái tổng tụt xuống đúng lúc nợ nhiều nhất là cái tổng vô dụng.

## Bộ dựng ngày-60 từng nói dối, đã sửa

`seed-day60.mjs` đặt `payment_status='refunded'` cho **mọi** đơn `returned` mà không tạo phiếu
hoàn nào — một hình dạng mã sản phẩm **không bao giờ** sinh ra được (`orders.js:1587` chỉ lật
`refunded` kèm phiếu hoàn đủ). Hậu quả đo được: 13 đơn "đã hoàn" với 0₫ phiếu hoàn, tức
**19,8 triệu nợ ảo** mà bất kỳ báo cáo công nợ nào cũng sẽ tin.

Đã sửa bộ dựng (55% đơn hoàn về có phiếu hoàn thật, 45% là bom hàng còn nợ) và vá 12 dòng hỏng
trong DB dev. **Đây là điều kiện tiên quyết**: xây màn hình tiền trên một fixture nói dối thì
hoặc là đi vá một lỗi không tồn tại, hoặc là mất niềm tin vào chính con số mình vừa dựng.

## Bằng chứng

`apps/seller-admin/test/admin-cong-no.e2e.mjs` — **27 khẳng định**, 7 phần.

Ba đột biến đã chứng đỏ đúng chỗ:

| gỡ gì | ai bắt |
|---|---|
| thu hẹp về `status IN ('cancelled')` | phần 2 (bom hàng) — 3 khẳng định đỏ |
| lấy `total_vnd` thay `amount_paid_vnd` | phần **2b** — 2 khẳng định đỏ |
| bỏ `greatest(0, …)` | phần 4 — 1 khẳng định đỏ |

**Phần 2b là ca duy nhất phân biệt được "đã thu" với "giá trị đơn"** — ở mọi ca khác hai số đó
bằng nhau, nên một công thức lấy nhầm `total_vnd` vẫn xanh trơn. Tôi viết bộ test xong, thấy nó
21/21 xanh, rồi mới nhận ra **không khẳng định nào canh vế đó** và phải dựng thêm ca. Đúng luật
đã ghi ở docs/65: *một chốt chỉ được coi là có test khi có đột biến gỡ nó và test đỏ.*

Phần 4 cũng phải sửa vì lý do cùng họ: khẳng định ban đầu chỉ kiểm "vắng mặt trong danh sách",
mà danh sách lọc `> 0` nên một số **âm** cũng vắng mặt y hệt số 0 — phải kiểm chính con số.

## Còn lại

- Chưa có **cảnh báo chủ động** (email/Telegram) khi nợ quá hạn N ngày — hiện phải mở trang mới
  thấy. Cột `since` đã có sẵn để làm việc đó.
- Chưa vào **P&L**: khoản nợ chưa trả không phải chi phí, nhưng cũng không nên nằm trong "tiền
  mặt đang có". Câu hỏi kế toán, chưa chạm.
- Khoản **phí ship đã trả cho hãng** với đơn bị bom vẫn chưa có chỗ nhập (docs/65).
