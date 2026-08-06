# 69 — Chi phí vận chuyển thực trả

**2026-08-06.** Yêu cầu ban đầu: *"phí ship đã trả cho hãng khi đơn bị bom"*. Đo trước khi
viết thì lỗ hổng rộng hơn hẳn, nên phạm vi được **mở ra một cách có chủ ý** — nói rõ ở đây vì
làm hẹp hơn sẽ cho ra một con số gây hiểu lầm.

## Đo

```
provider     vận đơn   có phí
(giao tay)     1.568        0
ghn              253      253
ghtk             198      163
```

**1.568/2.019 vận đơn không mang một đồng chi phí nào.** Shop tự giao, hoặc dùng hãng chưa nối
API (Grab, Ahamove, xe ôm quen — phần lớn shop Việt), thì **toàn bộ tiền cước biến mất khỏi
P&L**. Bom hàng chỉ là một nhánh của lỗ hổng đó — và nhánh ấy còn thiếu hẳn **cước chiều về**,
khoản không hãng nào đồng bộ về.

Nếu chỉ làm đúng phần được hỏi (cước chiều về), báo cáo sẽ trừ vài chục nghìn tiền về trong khi
vài triệu tiền đi vẫn vô hình — một con số *tệ hơn* không có gì, vì nó trông như đã đầy đủ.

## Đã làm

Một khái niệm — *"tiền cước của đơn này"* — đổ vào **đúng dòng chi phí sẵn có** của P&L, không
đẻ khái niệm mới:

| ô | ghi vào | chốt |
|---|---|---|
| phí chiều đi | `shipments.carrier_fee_vnd` của vận đơn **giao tay** | vận đơn do hãng đồng bộ thì **không cho gõ đè** — hãng là nguồn sự thật |
| phí chiều về | `orders.return_fee_vnd` (0147) | chỉ đơn đã quay lại shop |

Chốt "chỉ đơn đã quay lại" đặt **ở DB** (`CHECK`), không chỉ ở tầng ứng dụng: đây là cột tiền,
và một endpoint viết sau này quên chốt thì ghi được vào đơn đang giao.

Ngày ghi nhận cước chiều về là **`returned_at`**, không phải ngày tạo vận đơn — hai chiều có
thể rơi vào hai kỳ khác nhau, ghi nhầm kỳ là dịch khoản lỗ sang tháng không có nó.

**NULL ≠ 0.** Bỏ trống = *"chưa nhập"* (màn hình còn nhắc); điền 0 = *"hãng không thu chiều
về"*, một câu trả lời. Gộp hai thứ vào số 0 là biến **chưa biết** thành **biết chắc bằng
không** — sổ trông sạch hơn thực tế. Ô chỉ hiện khi **có chỗ để điền** (có vận đơn giao tay,
hoặc đơn đã quay về); bày một ô không ghi được vào đâu chỉ là mời người ta gõ rồi nhận 409.

## Ba lần vấp

1. **`q5b is not defined`** — tôi thêm truy vấn mới trong khối `withTenant` nhưng quên đưa nó
   qua **biên giới closure** (`return { q1..q9 }` → destructure ở `.then`). `node --check` mù
   với loại này; **toàn bộ trang Báo cáo 500** cho tới khi bộ e2e gọi thật vào nó.
2. **`preset=this_year` không tồn tại** (chỉ có `today/7d/30d/mtd/last_month`). Báo cáo trả
   khoảng rỗng → mọi số về 0. Hai khẳng định "P&L tăng đúng 30.000₫" đỏ, nhưng khẳng định
   *"P&L thôi tính khoản đã xoá"* lại **XANH vì `0 === 0`** — xanh vì lý do sai. Đã thêm chốt
   chặn đầu bộ: báo cáo phải trả về đúng cấu trúc trước khi so bất cứ con số nào.
3. **Thẻ giao diện lọt vào trong `<div>` của cụm nút** khi chèn tự động — phải đọc HTML in ra
   mới thấy.

## Bằng chứng

`apps/seller/test/ship-cost.e2e.mjs` — **18 khẳng định**, 5 phần. Khẳng định đắt nhất không
phải "lưu được số" mà **"P&L tăng đúng 30.000₫ và lãi vận hành giảm đúng 30.000₫"** — tức
khoản lỗ đi hết đường từ ô nhập tới con số cuối cùng chủ shop đọc.

Hai đột biến đỏ đúng chỗ: P&L thôi cộng phí chiều về → 1 đỏ · ô trống bị đọc thành 0 → 1 đỏ.

## Còn lại

- Đơn **tách nhiều kiện** giao tay: phí chiều đi ghi cho **mọi** vận đơn giao tay của đơn (cùng
  một số). Shop trả phí khác nhau cho từng kiện thì chưa nhập riêng được — chờ có ai cần thật.
- Chưa có nơi tổng hợp *"tháng này mất bao nhiêu vì bom hàng"* — số đã nằm trong P&L nhưng lẫn
  vào dòng phí vận chuyển chung.
