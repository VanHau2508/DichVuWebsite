# 77 — Bảng quản trị card-hoá ở server (Brief B)

> Lát cắt tách riêng khỏi workflow 4 để không đụng `pages.js` cùng lúc với Brief A.
> Nhánh: `claude/responsive-table-ssr`.

## Lỗi

Bảng quản trị đổ thành thẻ ở mobile bằng **JavaScript**: `ADMIN_JS` đọc chữ ở `<th>`, gán
`data-label` cho từng `<td>`, rồi thêm lớp `cards` để CSS ăn. CSS chỉ có `table.cards`.

Nghĩa là **tắt JS thì không bảng nào card-hoá**. Đo bằng Chromium thật ở khung nhìn 360px,
bề rộng cuộn của tài liệu (ngưỡng 360):

| trang | gốc, JS bật | gốc, JS tắt | mới, JS bật | mới, JS tắt |
|---|---:|---:|---:|---:|
| chi tiết đơn | 345 | **544** | 345 | 345 |
| danh sách đơn | 345 | **667** | 345 | 345 |
| đối soát COD | 345 | **701** | 345 | 345 |
| báo cáo | 345 | **464** | 345 | 345 |
| chi tiết phiếu nhập | 345 | **434** | 345 | 345 |
| khách hàng | 345 | **349** | 345 | 345 |

Vi phạm cùng lúc hai ràng buộc cố định của mọi lát cắt frontend (CLAUDE.md §9.2): *"JS chỉ là
tăng cường, không phải điều kiện"* và *"dùng được ở 360px"*.

**CSS không chữa được.** `content: attr()` chỉ đọc thuộc tính của **chính** phần tử đó; không
có cách nào để CSS lấy chữ từ `<th>` tương ứng. Nhãn buộc phải do server phát.

## Bản vá

`tblCards({ head, rows, foot })` ở `pages.js:548` phát nhãn ngay trong markup. **52 bảng**
chuyển sang nó; bảng thứ 53 (bảng liên hệ ở Trợ giúp) **bỏ** `data-cards` thay vì chuyển —
nó không có `<thead>`, là bảng 2 cột nhãn/giá trị vốn đã đọc được ở 360px.

Nhãn suy theo **chỉ số cột** trong `head`, nên không chép tay lệch được. Hợp đồng nở ra bốn
lần trong lúc thi công, mỗi lần do một bảng thật đòi — không lần nào do dự đoán trước:

| thêm gì | bảng nào đòi |
|---|---|
| `attrs` trên hàng | đúng **ba** hàng trong cả kho có thuộc tính riêng (NCC đã ẩn, API key đã thu hồi, dòng tổng in đậm) |
| `style` trên ô | ô `text-align:right` viết thẳng ở bảng API key, hoá đơn, mã giảm giá |
| `attrs` trên ô/tiêu đề | `<th title="…">` ở trang sản phẩm; `neg(v)` ở báo cáo trả **nguyên một chuỗi thuộc tính** ` style="…"` chứ không trả giá trị CSS |
| nhãn rỗng thì **bỏ hẳn** thuộc tính | `content: attr()` với chuỗi rỗng vẫn sinh một `::before` chiếm chỗ |

Cuối cùng CSS chuyển từ `table.cards` sang `table[data-cards]`, và khối JS card-hoá bị **gỡ
hẳn** — giữ lại là để nhãn có hai nguồn phát, đúng lớp lỗi "hai bản sao sẽ trôi".

## Phần đắt nhất: chứng minh 52 lần sửa tay không làm hỏng gì

Chuyển 52 bảng là ~2.500 dòng sửa tay, và kiểu hỏng của nó **âm thầm**: thiếu một `<td>`, đảo
hai cột, rơi một `class` thì trang vẫn render bình thường và e2e vẫn xanh — e2e khớp **chữ**,
không khớp **cấu trúc cột**.

Nên trước khi chuyển bảng thứ hai, dựng một **harness tương đương**: gọi cùng hàm render ở
bản gốc và bản mới với cùng dữ liệu, khẳng định khác biệt duy nhất được phép là `data-label`
được **thêm**. 48/48 hàm có bảng so BẰNG, 0 khác. 52 lần sửa tay thành 52 lần chứng minh.

`pages.js` **không import được** từ ngoài container (`../presets.js` tới bằng bind-mount) —
đó cũng là lý do mọi unit test hiện có của seller-admin đọc nó dạng **văn bản**. Harness lách
bằng cách sao hai bản ra ngoài kho rồi viết lại đường dẫn import.

### Harness tự nó có ba xanh giả, cả ba đều là "đi qua chốt khác rồi tưởng đã canh chốt mình muốn"

1. **Cắt theo hunk của diff.** Bản đầu so từng hunk. Nó sai với kiểu chuyển hay gặp nhất:
   nhiều bảng dựng `const rows = …` ở trên rồi mới nhúng `<tbody>${rows}</tbody>`. Chuyển
   phải sửa cả hai chỗ → hai hunk rời, hunk trên không có `<table>` nên bị bỏ qua, hunk dưới
   mất biến `rows` → **đỏ vì lý do sai**. Cắt theo **hàm** thì mọi hình dạng refactor trong
   cùng hàm nằm gọn trong một phép so.

2. **Chỉ so biến thể "tốt nhất".** Harness thử nhiều số-đối-số rồi giữ biến thể nhiều `<tr>`
   nhất. Với `renderOrderDetail`, thẻ *"Ca giao hàng cần xử lý"* — chính bảng chuyển đầu tiên
   — chỉ dựng được ở 14 đối số, mà biến thể nhiều hàng nhất lại **không có nó**. Bảng vừa
   chuyển **không hề được đi qua** và harness vẫn báo tương đương. Nay so **mọi** biến thể.

3. **`Array.isArray` trả false.** Đích của Proxy dữ liệu thử là một **hàm** (để gọi được),
   nên `Array.isArray(o.resolution_cases)` là `false` và mọi khối sau **31** chốt
   `Array.isArray` bị bỏ qua — trong đó có đúng thẻ ở mục 2. Đổi đích sang **mảng**: số hàm
   so được nhảy 45 → 48.

Và một điểm mù còn lại, đã bịt: phép so **xoá** `data-label` trước khi so (cố ý — nhãn là
khác biệt hợp lệ), nên nó **không thấy** được việc helper thôi phát nhãn. Chứng minh bằng đột
biến: bỏ hẳn `data-label` vẫn XANH. Nay có phép kiểm theo chiều **dương**, biết phân biệt
bảng *chưa chuyển* (không nhãn nào — hợp lệ lúc đang chuyển dần) với bảng *chuyển hỏng* (nhãn
nửa vời).

Ma trận đột biến của harness: 8 ca hỏng đều ĐỎ, 1 ca đối chứng XANH.

## Phép đo suýt vô nghĩa

Lượt đo 360px đầu tiên cho **485** ở mọi trang, kể cả `div.shell` của khung — một con số đều
đặn đáng ngờ. Kiểm bằng một trang tối giản in ra `innerWidth`: `chrome --headless` (new
headless) **bỏ qua `--window-size`** và luôn dựng khung nhìn **500px**. Toàn bộ lượt đo chạy ở
500px trong khi tôi tưởng là 360px.

Phải dùng `headless_shell` mới nhận đúng bề rộng. Probe nay **tự chối** nếu `innerWidth` khác
360 thay vì lặng lẽ trả một con số sai — cùng tinh thần với luật *"thiếu dòng `N pass, 0 fail`
là ĐỎ"*.

Fixture cũng suýt nói dối lần nữa: regex tên cột "văn bản dài" của tôi là `/line/`, nên
`o.lines` cũng trúng và mảng dòng đơn biến thành một chuỗi — **hai trang quan trọng nhất**
(chi tiết đơn, chi tiết phiếu nhập) im lặng rơi khỏi phép đo với lý do *"không dựng được"*.

## Còn lại, không phải hồi quy

Trang **Tồn an toàn** tràn **377/360** ở **cả** bản gốc lẫn bản mới, JS bật lẫn tắt. Thủ phạm
không phải bảng mà là ô nhập *"Tỉ lệ giữ an toàn cho toàn shop (%)"* kèm dòng giải thích trong
form ở đầu trang (`pages.js:6022`). Cơ chế khác (bố cục form, không phải bảng) nên nằm ngoài
phạm vi Brief B — ghi lại để lát cắt sau xử lý, không tự sửa.

## Chốt thường trực

`apps/seller-admin/test/table-cards.test.js` canh **ba đường quay lại**: bảng viết tay (so
BẰNG 52 lời gọi + 1 định nghĩa), CSS móc lớp `.cards`, JS dựng lại việc gán nhãn. Ma trận đột
biến 4/4 ĐỎ.

Hai khẳng định cũ viết theo markup viết tay đã sửa, **giữ nguyên hậu quả được canh**:

- `payment-error-contract`: khối cuộn của chi tiết đơn. Nhân tiện siết từ `>= 3` thành `= 4` —
  bản cũ cho phép mất một khối cuộn trong im lặng vì thực tế có 4. Đúng luật *"so BẰNG, không
  phải ≥"* mà các `MANIFEST_*` đã theo.
- `admin-products.e2e`: chốt cũ hỏi *"trang có xin JS không"*. **Tiền đề đó nay sai** — card-hoá
  không còn cần JS. Đổi thành *"bảng `data-cards` phải mang `data-label` sẵn trong HTML"*, tức
  canh đúng thứ làm nó chạy khi tắt JS.
