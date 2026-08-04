# "Không biết" và trần cứng — hai mục cuối của đợt 4

Đợt 4, mục cuối cùng (docs/57). Hai lỗ khác hẳn nhau về nội dung nhưng cùng một sai lầm nhận
thức: **hệ thống thay một sự thật nó không có bằng một giả định tiện tay.**

## Luật 1 — "KHÔNG BIẾT" không được biến thành "CHƯA XẢY RA"

Tạo vận đơn qua hãng đi theo ba pha: claim chỗ → gọi hãng (ngoài transaction) → chốt. Pha 2 có
thể **timeout**: hãng có thể đã tạo vận đơn thật, đang cài thu hộ COD, mà ta không nhận được
phản hồi nên không có mã. Kho đã dựng sẵn cờ `CarrierError.ambiguous` đúng để mô tả tình trạng
đó, và đường 502 giữ claim lại để không tạo trùng — **đúng**.

Nhưng dòng claim đó **không mang dấu vết gì**: `status='created'`, `provider_status` NULL,
`tracking_number` NULL — trông y hệt dòng của một ca hoàn toàn khác: *tiến trình chết TRƯỚC khi
kịp gọi hãng*. Vòng quét 15 phút gộp cả hai bằng một giả định viết thẳng trong chú thích:

> `tracking NULL = hãng CHƯA tạo → mở khoá (cancelled)`

Mở khoá xong, người bán tạo vận đơn **thứ hai** cho cùng một đơn: hãng thu hộ COD **hai lần**,
vận đơn đầu mồ côi — không ai theo dõi, không ai đối soát, và tiền của nó nằm ngoài mọi sổ.

Nặng hơn: câu 502 hứa *"hệ thống giữ chỗ và **tự kiểm tra lại**"* trong khi **không có dòng mã
nào kiểm tra lại** — vòng quét chỉ là một `UPDATE` trần, nó không hỏi hãng câu nào.

**Bản vá — bốn mảnh, thiếu mảnh nào cũng hỏng:**

| Mảnh | Vì sao |
|---|---|
| Ghi `provider_status='ambiguous'` ngay tại nhánh timeout | Đây là **điểm duy nhất** trong hệ còn biết rằng ta không biết. Không ghi thì thông tin mất vĩnh viễn |
| Vòng quét chỉ mở khoá khi `provider_status IS NULL` | Tức chắc chắn chưa hề gọi hãng. Ambiguous thì giữ khoá + log `tracking_claim_ambiguous` |
| Đường ra cho người bán: `carrier-reconcile` nhận cả `ambiguous` | Giữ khoá mà không có lối ra thì chỉ đổi ngõ cụt này lấy ngõ cụt khác |
| Nhập **mã vận đơn đọc trên trang hãng** | Ở ca này DB không có mã. Không cho nhập tay thì lối ra duy nhất là huỷ — tức cố ý bỏ rơi một vận đơn có thật |

Kèm hai chỗ phải sửa theo:

- **Guard tạo lại** (`shipping.js`) nay chặn cả `ambiguous`, kèm câu cảnh báo nói thẳng nguy cơ
  thu hộ hai lần — thay vì để người bán bấm lại rồi tự chuốc lấy nó.
- **`reconcileEditLines`** (bản vá của chính đợt trước, docs/58) dọn claim chết theo đúng giả
  định đang bị bác bỏ ở đây: `cancelled AND tracking_number IS NULL`. Nay loại trừ
  `ambiguous`/`finalize_failed` — xoá chúng là xoá dấu vết của một vận đơn có thể đang thu hộ
  tiền thật.
- **Migration 0139**: `app_expiry` có `UPDATE (provider_status)` nhưng **không** có
  `SELECT (provider_status)` — ghi được mà không đọc được. Thiếu nó thì truy vấn mới bị từ chối
  và rơi vào `catch`, chỉ để lại một dòng `tracking_gc_error`, còn claim nằm lại mãi mãi.

## Luật 2 — trần cứng phải có MỘT con số, và điều hướng thì không được có mép

Ba nơi nói ba chuyện khác nhau về "danh mục của shop": cây menu `LIMIT 100`, sitemap `LIMIT 200`,
seller **không có trần** khi tạo. Với shop >100 danh mục, mục thứ 101:

- biến mất khỏi menu,
- **404 khi bấm vào** (`resolveCatSlug` chỉ duyệt cây đã nạp),
- nhưng **vẫn nằm trong sitemap** nộp cho Google.

Rất dễ chạm: bộ nhập CSV từ sàn khác tự đẻ danh mục theo mỗi đường dẫn, và tạp hoá/siêu thị dùng
cây 2 cấp.

**Vá hai lớp.** Một hằng `CAT_MAX` cho cả cây lẫn sitemap để hai con số thôi cãi nhau — nhưng
nâng trần chỉ **dời mép đi**, không bỏ mép. Nên thêm `resolveCatSlugDb()`: khi slug không có
trong cây đã nạp thì tra thẳng DB. Menu vẫn chỉ liệt kê `CAT_MAX` mục (dropdown 200 dòng đã là
vô dụng), nhưng **điều hướng không còn mép**: mọi danh mục có thật đều mở được trang.

## Hai bẫy ĐO trong đợt này

1. **Bộ test cũ của tôi dựng SAI hiện trường.** Section 9 (docs/58) dùng **timeout** để đại diện
   cho ca "tiến trình chết trước khi gọi hãng". Trước bản vá hai ca không phân biệt được nên nó
   trông đúng; sau bản vá nó đỏ — và đỏ **đúng**, vì nó đang đo nhầm ca. Nay dựng đúng bằng cách
   đặt `provider_status = NULL` tường minh, kèm chú thích phân biệt hai ca.
2. **Ca đo "vượt trần" không hề vượt trần.** Tôi tạo một danh mục `position=9999` và tưởng thế là
   ngoài trần — nhưng shop test chỉ có vài danh mục nên nó vẫn lọt `LIMIT 200`. Gỡ hẳn fallback
   mà test vẫn xanh. Phải chèn **205 danh mục đệm** thì khẳng định mới có nghĩa. Bài học lặp lại:
   *một khẳng định "luôn xanh" thì hỏi xem fixture có bao giờ đi vào nhánh nó canh không.*
