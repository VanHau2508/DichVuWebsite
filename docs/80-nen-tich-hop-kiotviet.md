# Nền tích hợp KiotViet — connector core cho pilot

## Mục tiêu và ranh giới

Lát cắt này đổi hướng POS từ “xây POS đầy đủ ngay” sang **tích hợp trước**. KiotViet làm chủ
tồn vật lý và giao dịch tại quầy; nền tảng tiếp tục làm chủ website, nội dung, checkout và đơn
online. Trang quản trị phải nhìn được cả hai nguồn, nhưng mọi đơn giữ `source` và định danh
ngoài để không tính doanh thu hay trừ tồn hai lần.

Đây là **connector core**, chưa phải lời tuyên bố hỗ trợ KiotViet hoàn chỉnh:

- đã làm catalog/tồn, gửi đơn website, nhập hóa đơn POS, webhook, retry và reconciliation;
- chưa xác minh bằng credential/tài khoản KiotViet thật;
- chưa làm hoàn trả website → KiotViet và hoàn trả POS → nền tảng;
- chưa làm Sapo, POS Lite, offline, ca bán hàng hay thiết bị chuyên dụng.

Các phần chưa làm phải qua spike tài khoản thật trước khi viết adapter. Không suy API tài chính
từ tên endpoint hoặc từ tài liệu quảng cáo.

## Quyền sở hữu dữ liệu

Mỗi shop có tối đa một kết nối `external_master`:

- KiotViet sở hữu SKU/barcode gốc, chi nhánh đã chọn, tồn vật lý và giá cơ sở;
- nền tảng giữ bản chiếu tồn, reservation của checkout, nội dung/ảnh/SEO và trạng thái bán web;
- đơn website có `source='web'`, được nền tảng tạo rồi gửi ra KiotViet;
- hóa đơn tại quầy được nhập thành `source='kiotviet_pos'` để admin và báo cáo cùng nhìn thấy;
- invoice KiotViet vọng lại từ một đơn website chỉ nối định danh, không tạo đơn POS thứ hai.

Ngắt kết nối không xoá mapping và không tự đổi quyền sở hữu tồn. Nếu connector đang làm chủ
tồn, sản phẩm liên kết tiếp tục bị khoá checkout cho tới khi có thao tác chuyển authority có
kiểm soát.

## Schema 0177–0182 và least privilege

Migration `0177_kiotviet_integration_core.sql` thêm:

- `shop_integrations`: cấu hình per-tenant, credential mã hoá, chi nhánh, độ tươi và cursor;
- `integration_webhook_inbox`: inbox bền vững, chống trùng và phục hồi job bị mất;
- `integration_entity_refs`: mapping sản phẩm/biến thể/đơn/hóa đơn và trạng thái ignored;
- `integration_sync_discrepancies`: hàng đợi ca cần xử lý;
- barcode biến thể và metadata đồng bộ trên `orders`.

Migration `0178_kiotviet_connector_hardening.sql` siết các bất biến chỉ lộ sau lượt review:

- mỗi cấu hình connector có `generation`; inbox, order và mọi job đều mang đúng generation;
- credential mới nằm trong một bundle `pending_*`, probe không ghi đè kết nối đang chạy;
- độ tươi tồn nằm trên từng mapping biến thể, không suy từ đồng hồ chung của shop;
- cursor order và invoice tách riêng, chỉ tiến sau khi đã chứng minh quét hết;
- webhook hết lượt bị đưa vào `dead_letter` và xóa payload; đổi generation cũng xóa payload cũ;
- đơn POS và đơn website đã được KiotViet nhận bị khóa sửa cục bộ ở DB.

Migration `0179_checkout_external_order_guard.sql` sửa đường checkout sau khi chạy thật phát
hiện trigger đang chạy dưới vai gọi và đọc trực tiếp `shop_integrations`, làm đơn
`external_master` chết vì thiếu quyền. Trigger nay là `SECURITY DEFINER`, thuộc vai
`app_integration_guard` NOLOGIN, nhưng vẫn dùng `session_user` để giữ các nhánh actor
`app_checkout`/`app_expiry`/`app_integration` và fail-closed đúng mục đích. Đường ẩn danh cũng
không thể gán `customer_id` của shop khác.

Migration `0180_external_order_refund_guard.sql` chặn lớp còn lại của cùng bất biến: không
được ghi `refunds` cục bộ cho đơn POS ngoài, đơn đã có `external_ref`, hoặc đơn đang gắn
connector. Vì API hoàn tiền KiotViet chưa được xác minh bằng tài khoản thật, hệ thống trả
fail-closed và yêu cầu hoàn ở provider; không tạo bút toán nền tảng rồi để hai sổ lệch nhau.

Migration `0181_kiotviet_claim_and_send_intent.sql` đóng hai cửa sổ cạnh tranh còn lại:

- auto-sync catalog và map thủ công dùng cùng hàm sinh advisory key theo
  `(integration_id, entity_type, local_id)`; mapping đang có luôn thắng, còn hai claim mới
  cùng lượt đều thành conflict, không dùng thứ tự provider để phân xử;
- đơn website ghi `send-intent` trong transaction đã commit trước network I/O. Sau một lần
  thử, marker scan bằng offset chỉ được phép chứng minh có; nếu không có lookup chính xác thì
  kết quả là `inconclusive` và đơn chuyển `needs_attention`, không POST mù lần hai.

Checkout được cấp thêm đúng `SELECT(shop_id)` trên `shop_integrations` để trigger external
inventory trả mã nghiệp vụ `PIV01` thay vì lỗi quyền thô `42501`.

Cả năm bảng tenant đều `ENABLE + FORCE RLS`, FK tenant mang `shop_id`. Vai mới
`app_integration` không có `BYPASSRLS`; endpoint webhook chỉ dùng SECURITY DEFINER để đổi
`webhook_public_id` thành đúng hai UUID định tuyến, sau đó mọi dữ liệu nghiệp vụ vẫn đi qua
transaction có `set_config('app.shop_id', ..., true)`.

Credential được mã hoá AES-256-GCM bằng `INTEGRATION_ENC_KEY`; webhook dùng secret riêng cho
từng connector. Giao diện không trả ciphertext, client secret, webhook secret hay payload thô.
Các hàm cần đi xuyên `FORCE RLS` thuộc vai `app_integration_guard` NOLOGIN; vai này chỉ có
quyền đúng các bảng connector cần định tuyến và không được dùng làm tài khoản dịch vụ.

## Luồng đã dựng

### Kết nối

Owner/admin nhập retailer + client ID + client secret, qua step-up, gọi OAuth và đọc danh sách
chi nhánh. Chọn đúng một chi nhánh, đăng ký năm webhook rồi đưa initial sync vào outbox. Chỉ
khi catalog/tồn đã đối soát và không còn mapping bắt buộc bị treo thì worker chuyển connector
sang `active/external_master`.

Probe và activate là hai pha có CAS: form activate phải mang `pending_token` của đúng lần probe.
Tab cũ không thể nhận credential/chi nhánh của tab mới. Ngắt connector đóng lifecycle và tăng
generation trước khi gọi mạng, xóa credential + URL webhook trong DB; chuyển quyền tồn về
`local` là một thao tác step-up riêng, không phải tác dụng phụ của nút ngắt.

### Catalog và tồn

Worker chỉ tự nối SKU/barcode khi khớp duy nhất. Thiếu hoặc trùng tạo discrepancy thay vì
đoán. Catalog manager có thể sửa mapping hoặc đánh dấu “Không bán trên website”; quyết định
`ignored` sống qua các lần đồng bộ sau và không chặn connector hoạt động.

Checkout đọc độ tươi của bản chiếu qua quyền cột hẹp. Connector ngoài đang làm chủ mà bị
disable/degraded hoặc tồn cũ quá 5 phút thì sản phẩm liên kết dừng checkout, không rơi về tồn
local cũ.

Độ tươi được kiểm cho **từng variant trong giỏ** và phải thuộc đúng generation hiện hành. Một
SKU vừa đồng bộ không được làm SKU khác hết hạn trở thành “tươi”. Full reconciliation và
webhook catalog/tồn dùng cùng advisory lock theo connector; `ModifiedDate` cũ hơn snapshot đã
lưu không được ghi đè dữ liệu mới.

### Website → KiotViet

Đơn website ghi `sync_status='pending'` và outbox trong cùng giao dịch. Worker ghi một
`send-intent` rồi commit trước khi gọi mạng. Lần POST đầu được phép đi qua bằng chứng đó; sau
một lần thử, marker deterministic chỉ được dùng để chứng minh provider đã nhận. Offset scan
không tìm thấy không chứng minh vắng mặt: nếu không có lookup chính xác trả
`proven_absent`, đơn chuyển `needs_attention` và không POST mù lần hai.

Migration `0182_kiotviet_retry_confirmation.sql` đóng đường quay lại có thể tạo đơn trùng:

- một xác nhận của người vận hành mang đúng `discrepancy_id` làm nonce và chỉ được dùng một lần;
- chỉ discrepancy `open` mới phát hành được retry; gửi lại cùng nonce hoặc retry đồng thời bị từ chối;
- không reset `attempted` thành `prepared`. Retry thủ công chỉ tiến từ `needs_attention`, và lỗi
  provider sau lượt đã xác nhận mở ca mới thay vì để BullMQ tự POST lại;
- form admin dùng checkbox bắt buộc, không hidden field hay `window.confirm()` ký thay người vận hành.

Payload mang dòng hàng đã mapping, khách, `orderDelivery.receiver/contactNumber/address/price`,
phương thức và số tiền đã thu. Trong pilot hiện tại, đơn external-master chỉ nhận COD; QR,
coupon, đổi điểm và khuyến mại online đều fail-closed cho tới khi capability boolean
`preserve_line_price=true` được bật sau phép thử giá dòng thật. Lỗi provider hoặc mapping tạo
ca “Cần xử lý”; retry vẫn dùng cùng marker và generation nên không tạo đơn thứ hai hoặc gửi
đơn cũ sang credential/chi nhánh mới.

### KiotViet POS → nền tảng

Webhook hợp lệ được ghi inbox idempotent và trả `202` nhanh; xử lý chạy bất đồng bộ. Chỉ hóa
đơn hoàn tất và có `TotalPayment` khớp mới trở thành doanh thu POS. Hóa đơn chưa hoàn tất hoặc
đã huỷ chỉ được quan sát. Reconciliation định kỳ đọc lại sản phẩm, tồn, đơn và hóa đơn để sửa
webhook mất, trễ hoặc đảo thứ tự.

Nếu hóa đơn có `OrderId`/`OrderCode` hoặc marker nền tảng nhưng chưa nối chắc chắn được với đơn
website, nó ở trạng thái `order_identity_pending` và **chưa ghi doanh thu**. Snapshot phục hồi
chỉ giữ trường nghiệp vụ cần thiết, không giữ tên, số điện thoại, địa chỉ hay payment payload
thô. Giao dịch POS snapshot luôn `unit_cost_vnd` để báo cáo lãi lỗ không dùng giá vốn hiện tại.

## Giao diện vận hành

Trang “Kết nối POS” có trạng thái, chi nhánh, lần đồng bộ/đối soát, độ trễ, mapping lỗi, trung
tâm đồng bộ và ngắt kết nối an toàn. Owner/admin quản lý credential; catalog manager xử lý
mapping; order manager xem và retry lỗi đơn. Danh sách/chi tiết đơn có badge nguồn và trạng
thái đồng bộ. Đơn `kiotviet_pos`/`sapo_pos`, hoặc đơn website đã có `external_ref`, chỉ để quan
sát: admin không mời sửa/xác nhận/giao/hủy/thu tiền/hoàn trả; DB trả `409/PIO01` nếu route mới
quên gác. Màn hình dùng SSR/form thường, không cần JavaScript và phải giữ được ở 360px.

## Bằng chứng kiểm thử

- unit theo manifest: 313/313 (working tree hiện tại);
- adapter KiotViet: 8/8;
- checkout policy KiotViet: 7/7;
- toàn bộ 9 bộ bất biến DB trên stack PostgreSQL: 144/144;
- migration DB trắng: 180/180, 0 DRIFT, 0 pending.

E2E connector đã chạy 46/46 trên stack pilot trước lát cắt Trung tâm vận hành. Lát cắt này mới
chạy focused `ops-batch` 15/15, mutation 3/3, fresh migration 180/180 và browser probe; chưa
tuyên bố full CI 107 E2E trên working tree vì DB dev hiện tại còn drift lịch sử tại migration
0178. Lần full CI xanh gần nhất trên mốc `2061d93` là 309 unit, 107 E2E và 3 smoke.
Đây là bằng chứng của mã nguồn/stack dev; nó không thay thế spike bằng credential KiotViet thật.

E2E đã đột biến các điểm dễ xanh giả: webhook trùng, ignore mapping qua reconciliation, hai
job gửi cùng đơn, invoice vọng lại, chữ ký sai, step-up sai và ngắt connector còn authority.

## Nợ trước pilot thật

1. Chạy spike bằng tài khoản KiotViet thật: credential, quyền Public API, tên/shape webhook,
   tồn theo chi nhánh, giới hạn tốc độ và quy tắc giá dòng đơn.
2. Dựng hoàn trả hai chiều bằng API đã xác minh, dùng idempotency tiền hiện có và không suy
   hoàn tiền chỉ từ trạng thái đơn.
3. Đo mục tiêu webhook <30 giây và reconciliation 5–10 phút bằng 1–3 shop pilot.
4. Chỉ sau pilot mới quyết định Sapo và POS Lite; không sao chép adapter KiotViet bằng đổi tên.
5. Connector hiện đủ để pilot 1–3 shop. Chưa có bằng chứng tải, rate-limit và vận hành để tuyên
   bố sẵn sàng cho 9.358 shop; mở rộng chỉ sau số đo từ tài khoản thật và chaos test provider.

## Lỗi phương pháp đã bắt trong lúc làm

- Test Docker đầu tiên dùng sai đường `/work/packages/db/test/...`; schema không hỏng, lệnh
  kiểm hỏng. Lượt sau chạy đúng `/work/test/...` trên project cô lập.
- Bind-mount giúp seller nạp file dùng chung nhưng worker không nạp lại source khi sửa; worker
  phải rebuild. Restart sai service có thể tạo đỏ giả giống lỗi sản phẩm.
- Một marker tìm không thấy trong **phần đã quét** không chứng minh đơn chưa tồn tại. Phải biết
  phép quét đã bao phủ hết trước khi POST lại; nếu không, retry “an toàn” chính là nguồn nhân
  đôi đơn.
