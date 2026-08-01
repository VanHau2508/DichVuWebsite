# 47 — Đơn chốt trong chat Facebook/Zalo chảy về nền tảng

**Trạng thái:** chặng 1 (0119+0120+0121) = nửa dưới · **chặng 2 XONG** (0122, bot Messenger
của chính nền tảng) → luồng đầu-cuối ĐÃ chạy: khách chat → chốt đơn trong chat → đơn về kho,
tiền, vận đơn. Chi tiết bot: [docs/48](48-bot-messenger.md). Bảng "Ba đường" bên dưới vẫn
đúng — đường B là đường đã chọn và đã làm.

## Bài toán

Cách bán phổ biến nhất của shop Việt nhỏ không đi qua website:

```
chạy quảng cáo → khách nhắn tin → nhân viên/bot trả lời → CHỐT ĐƠN NGAY TRONG CHAT
```

Đơn nằm lại trong hộp thư Messenger. Kho không trừ, doanh thu không vào sổ, không in
được vận đơn, và tới cuối tháng không ai trả lời được câu "quảng cáo Facebook tháng này
mang về bao nhiêu đơn". Đó không phải thiếu tính năng nhỏ — đó là cả một kênh bán nằm
ngoài hệ thống.

## Meta cho gì, không cho gì

> **ĐÍNH CHÍNH 2026-08-01.** Bản đầu của tài liệu này viết "Meta AI là hộp đen, không có
> API cho bên thứ ba" và để người đọc hiểu thành *bài toán không giải được, phải chờ Meta*.
> Sai — sai vì lẫn hai CHIỀU ngược nhau. Giữ nguyên đoạn sai ở đây vì nó là lý do cả
> chặng 1 được đóng gói như bên dưới.

Phân biệt hai chiều, vì chỉ một chiều bị chặn:

* **KÉO đơn RA khỏi Meta: không.** Đơn do trợ lý AI của Meta tạo nằm *bên trong* Meta;
  không có API để bên thứ ba đọc danh sách đơn đó về. Chỗ này bản đầu nói đúng.
* **ĐẨY từ Meta VÀO hệ thống mình: CÓ.** Meta Business Agent (ra toàn cầu 03/06/2026,
  chạy trên **cả Messenger** chứ không riêng WhatsApp) có **Connectors API**: khai báo một
  API bên ngoài để agent GỌI, kèm webhook. Tức là agent chốt đơn xong thì tự gọi
  `/ingest/orders` của mình. Đó đúng là luồng "chốt đơn trong chat → website nhận đơn".

Ba thứ mang tên "API sản phẩm của Meta" vẫn là ba thứ khác nhau, dễ nhầm: **CAPI** (gửi
sự kiện chuyển đổi *lên* Meta cho quảng cáo) · **Catalog/Product Feed** (đồng bộ sản
phẩm) · **Messenger Platform** (gửi/nhận tin nhắn). Không cái nào trong ba cái này là
đường nhận đơn — đường nhận đơn là **Connectors API** của Business Agent, hoặc bot của
chính mình dựng trên Messenger Platform.

Kết luận đúng: **phía mình luôn là bên TẠO đơn**; câu hỏi thật là *ai chạy cuộc hội thoại*
và ai gọi vào cổng nhận đơn.

## Ba đường, cùng đổ vào một cổng

Cả ba đều gọi `/ingest/orders` (chặng 1) — nên chặng 1 là điều kiện CẦN của mọi đường,
nhưng tự nó KHÔNG đủ: nó là nửa dưới, mắt xích "chốt đơn trong chat" nằm ở nửa trên.

| | Ai chạy cuộc chat | Cần gì ở Meta | Sẵn sàng |
|---|---|---|---|
| **A** | phần mềm chat bên thứ ba (Pancake/Botcake/n8n) | không | ngay |
| **B** | bot của chính nền tảng (Messenger Platform) | App Review `pages_messaging` (~5–10 ngày làm việc) | ~1,5 ngày code + chờ duyệt |
| **C** | **Meta Business Agent** + custom connector | bật agent + khai connector | chủ yếu cấu hình |

**Ba ẩn số của đường C — phải THỬ mới biết, đọc tài liệu không ra:**
1. Connectors API đã phủ **Messenger** chưa, hay tài liệu get-started mới chỉ có nhánh
   WhatsApp (WABA + `whatsapp_business_messaging`).
2. **Việt Nam** có trong danh sách nước/ngành được bật chưa (pilot: Ấn Độ, Mexico, Brazil).
3. Chất lượng **tiếng Việt** của agent khi bán hàng thật.

## Chặng 1 — hai mảnh, dùng được ngay

### Mảnh A: đơn biết mình đến từ đâu (migration 0119)

`orders.source` (CHECK: `web` · `manual` · `facebook` · `zalo` · `tiktok` · `other`) và
`orders.source_ref` (link/mã quay lại cuộc hội thoại).

Quyết định đáng ghi lại:

* **CHECK chứ không text tự do.** Cột này để ĐẾM. `facebook` lẫn `fb` lẫn `Facebook` làm
  hỏng báo cáo mà không ai thấy sai. Thêm kênh = thêm migration, đổi lại tập giá trị hiện
  trong diff cho người review.
* **Giá trị lạ → 400, không âm thầm về mặc định.** Lặng lẽ nghĩa là bot gửi sai tên kênh
  suốt nhiều tuần mà không ai biết.
* **KHÔNG backfill đơn cũ.** Đoán được (`client_ip_hash IS NULL` gần như chắc là đơn gõ
  tay) nhưng "gần như chắc" ghi vào cột đếm doanh thu là biến phỏng đoán thành sự thật
  vĩnh viễn. Đơn cũ để NULL, hiện "—"; đơn di cư (`is_migrated`) hiện "Nhập từ sàn cũ".

Hiện ở: ô **Nguồn đơn** trên form tạo đơn tay · cột **Nguồn** + bộ lọc `?source=` trên
danh sách · dòng nguồn + link mở hội thoại ở chi tiết đơn · hai cột trong CSV xuất.

### Mảnh B: khoá kết nối cho phần mềm ngoài (migration 0120)

Hôm nay đa số shop Việt đã chốt đơn trong chat bằng **Pancake / Botcake / Vpage**, hoặc
nối bằng **n8n / Zapier**. Thứ họ thiếu không phải chatbot — là chỗ để đơn chảy về. Nên
chặng 1 mở đúng cái cổng đó, không chờ Meta:

```
POST https://hooks.nentang.vn/ingest/orders
Authorization: Bearer ntk_…
{ lines, customer, payment_method, source, source_ref, idempotency_key }
```

Thân request **giống hệt** `POST /shops/:id/orders`, và bên trong gọi **cùng một hàm**
`createManualOrder`. Cố ý: đường tiền không được có bản sao thứ hai — hai bản sẽ trôi
lệch, và chỗ trôi lệch nằm ở giá/tồn/idempotency.

## Những chỗ dễ làm sai (và đã làm thế nào)

**Resolve token khi chưa biết shop.** RLS lọc theo `current_shop_id()`, mà request chỉ có
token. Không mở `USING (true)` cho `app_rw` — đó là vai to nhất, một endpoint tương lai
quên `WHERE shop_id` là lộ metadata khoá của mọi shop. Dùng lối GUC đã có sẵn ở 0083
(`current_claim_token_hash`): service đặt `app.api_token_hash`, policy `resolve_by_token`
chỉ mở đúng dòng khớp hash. Không token → GUC rỗng → không dòng nào hiện.

**Không cần vai DB mới.** Cầm được token nghĩa là được phép hành động thay shop đó — đúng
bằng quyền `app_rw` trong phạm vi shop đã resolve. Thêm vai chỉ để đi qua cùng một cửa là
thêm bề mặt cấu hình.

**Miễn kiểm Origin cho đúng một đường.** `originAllowed` đòi header `Origin` ở mọi POST để
chống CSRF trình duyệt; máy-gọi-máy không gửi Origin. Miễn được vì đường này xác thực bằng
**Bearer chứ không bằng cookie** — trình duyệt của nạn nhân không tự đính kèm chứng chỉ,
nên không có CSRF để chống. Đường dẫn không bắt đầu bằng `/shops/` nên không route session
nào lọt qua ngả này (có test khẳng định điều ngược lại cũng đúng: Bearer không mở được
route session).

**Xử lý lỗi.** Nhánh ingest nằm TRONG `try` của dispatcher. Để ngoài thì "hết hàng" hay
"trùng idempotency" đều thành 500 và tích hợp bên kia không hiểu gì.

**Token hiện đúng một lần.** Chỉ lưu sha256. Khoá đọc-lại-được là khoá rò theo mọi ảnh
chụp màn hình gửi cho hỗ trợ. Token đi thẳng vào HTML của lần POST đó, **không** redirect
kèm token trên URL (URL nằm lại trong lịch sử trình duyệt, log proxy và `Referer` trang kế).

**Thu hồi không đòi step-up, tạo mới thì có.** Khi nghi khoá bị lộ, mỗi bước ma sát thêm
là thêm phút cho kẻ cầm khoá. Đường an toàn phải là đường dễ đi nhất.

**Thông báo lỗi giống nhau cho "thiếu token" và "token sai"** — khác nhau là kênh dò xem
khoá nào có thật.

**Trần gọi:** đếm trong tiến trình (seller không nối Redis — build context là `apps/seller`).
Nói thẳng giới hạn: nhiều instance thì trần nhân lên theo số instance. Lớp bảo vệ thật là
token 256 bit; trần chỉ để việc dò vô vọng đó không đốt CPU.

## Chặng 2 (chưa làm) — bot Messenger của chính nền tảng

Khi Page + app đã được Meta duyệt: nhận webhook Messenger → hội thoại dẫn khách chọn hàng
→ tạo đơn bằng **chính** `/ingest/orders` với `source='facebook'`, `source_ref` = PSID.
Không có đường tạo đơn mới nào phải viết thêm — đó là lý do chặng 1 làm cổng trước, bot sau.

Điều kiện phía người dùng (không phải phía mã): Facebook Page thật, Business verification,
và App Review cho `pages_messaging`. Chuẩn bị được song song với việc viết mã.

## Ranh giới đã chốt

* Nền tảng **không** làm chatbot AI trả lời khách. Việc đó Meta và các phần mềm chat đã
  làm tốt và rẻ. Nền tảng làm chỗ đơn chảy về, kho, tiền, vận đơn.
* Scope khoá hiện chỉ `orders.ingest`. Cột `scope` có sẵn để thêm (vd `products.read` cho
  đồng bộ tồn) mà không phải sửa mọi chỗ đọc, nhưng CHECK vẫn khoá tập giá trị.

## Test

* `apps/seller/test/api-keys.e2e.mjs` — API: step-up, token một lần, ingest tạo đơn thật +
  trừ tồn + đóng dấu `api_key_id`, cô lập chéo shop, thu hồi, idempotency, `source` sai
  chính tả → 400, lọc `?source=`, Bearer không mở được route session.
* `apps/seller-admin/test/admin-api-keys.e2e.mjs` — đi trọn đường người dùng: mở trang →
  gửi form → xác nhận mật khẩu → lấy token → **dùng token đó đẩy đơn thật** → thấy đơn →
  thu hồi → đẩy lại bị chặn. (Bài học cũ: nút "có mặt" không nói gì về việc bấm vào có chạy.)
