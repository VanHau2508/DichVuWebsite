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

## Schema 0177 và least privilege

Migration `0177_kiotviet_integration_core.sql` thêm:

- `shop_integrations`: cấu hình per-tenant, credential mã hoá, chi nhánh, độ tươi và cursor;
- `integration_webhook_inbox`: inbox bền vững, chống trùng và phục hồi job bị mất;
- `integration_entity_refs`: mapping sản phẩm/biến thể/đơn/hóa đơn và trạng thái ignored;
- `integration_sync_discrepancies`: hàng đợi ca cần xử lý;
- barcode biến thể và metadata đồng bộ trên `orders`.

Cả bốn bảng tenant đều `ENABLE + FORCE RLS`, FK tenant mang `shop_id`. Vai mới
`app_integration` không có `BYPASSRLS`; endpoint webhook chỉ dùng SECURITY DEFINER để đổi
`webhook_public_id` thành đúng hai UUID định tuyến, sau đó mọi dữ liệu nghiệp vụ vẫn đi qua
transaction có `set_config('app.shop_id', ..., true)`.

Credential được mã hoá AES-256-GCM bằng `INTEGRATION_ENC_KEY`; webhook dùng secret riêng cho
từng connector. Giao diện không trả ciphertext, client secret, webhook secret hay payload thô.

## Luồng đã dựng

### Kết nối

Owner/admin nhập retailer + client ID + client secret, qua step-up, gọi OAuth và đọc danh sách
chi nhánh. Chọn đúng một chi nhánh, đăng ký năm webhook rồi đưa initial sync vào outbox. Chỉ
khi catalog/tồn đã đối soát và không còn mapping bắt buộc bị treo thì worker chuyển connector
sang `active/external_master`.

### Catalog và tồn

Worker chỉ tự nối SKU/barcode khi khớp duy nhất. Thiếu hoặc trùng tạo discrepancy thay vì
đoán. Catalog manager có thể sửa mapping hoặc đánh dấu “Không bán trên website”; quyết định
`ignored` sống qua các lần đồng bộ sau và không chặn connector hoạt động.

Checkout đọc độ tươi của bản chiếu qua quyền cột hẹp. Connector ngoài đang làm chủ mà bị
disable/degraded hoặc tồn cũ quá 5 phút thì sản phẩm liên kết dừng checkout, không rơi về tồn
local cũ.

### Website → KiotViet

Đơn website ghi `sync_status='pending'` và outbox trong cùng giao dịch. Worker khoá dòng đơn
`FOR UPDATE` xuyên suốt lần gửi, tìm marker deterministic trước khi POST và chỉ gửi khi đã
chứng minh chưa có đơn cũ. Phép quét tối đa 50 trang mà chưa hết kết quả phải fail-closed với
`order_lookup_incomplete`, không được hiểu thành “không có đơn”.

Payload mang dòng hàng đã mapping, khách, `orderDelivery.receiver/contactNumber/address/price`,
phương thức và số tiền đã thu. Lỗi provider hoặc mapping tạo ca “Cần xử lý”; retry vẫn dùng
cùng marker nên không tạo đơn thứ hai.

### KiotViet POS → nền tảng

Webhook hợp lệ được ghi inbox idempotent và trả `202` nhanh; xử lý chạy bất đồng bộ. Chỉ hóa
đơn hoàn tất và có `TotalPayment` khớp mới trở thành doanh thu POS. Hóa đơn chưa hoàn tất hoặc
đã huỷ chỉ được quan sát. Reconciliation định kỳ đọc lại sản phẩm, tồn, đơn và hóa đơn để sửa
webhook mất, trễ hoặc đảo thứ tự.

## Giao diện vận hành

Trang “Kết nối POS” có trạng thái, chi nhánh, lần đồng bộ/đối soát, độ trễ, mapping lỗi, trung
tâm đồng bộ và ngắt kết nối an toàn. Owner/admin quản lý credential; catalog manager xử lý
mapping; order manager xem và retry lỗi đơn. Danh sách/chi tiết đơn có badge nguồn và trạng
thái đồng bộ. Màn hình dùng SSR/form thường, không cần JavaScript và phải giữ được ở 360px.

## Bằng chứng kiểm thử trước full CI

- adapter/unit liên quan: 41/41;
- schema + least privilege: 50/50;
- cô lập tenant: 30/30;
- connector E2E Docker: 21/21;
- migration DB trắng: 175 migration, 0 DRIFT, 0 pending.

E2E đã đột biến các điểm dễ xanh giả: webhook trùng, ignore mapping qua reconciliation, hai
job gửi cùng đơn, invoice vọng lại, chữ ký sai, step-up sai và ngắt connector còn authority.

## Nợ trước pilot thật

1. Chạy spike bằng tài khoản KiotViet thật: credential, quyền Public API, tên/shape webhook,
   tồn theo chi nhánh, giới hạn tốc độ và quy tắc giá dòng đơn.
2. Dựng hoàn trả hai chiều bằng API đã xác minh, dùng idempotency tiền hiện có và không suy
   hoàn tiền chỉ từ trạng thái đơn.
3. Đo mục tiêu webhook <30 giây và reconciliation 5–10 phút bằng 1–3 shop pilot.
4. Chỉ sau pilot mới quyết định Sapo và POS Lite; không sao chép adapter KiotViet bằng đổi tên.

## Lỗi phương pháp đã bắt trong lúc làm

- Test Docker đầu tiên dùng sai đường `/work/packages/db/test/...`; schema không hỏng, lệnh
  kiểm hỏng. Lượt sau chạy đúng `/work/test/...` trên project cô lập.
- Bind-mount giúp seller nạp file dùng chung nhưng worker không nạp lại source khi sửa; worker
  phải rebuild. Restart sai service có thể tạo đỏ giả giống lỗi sản phẩm.
- Một marker tìm không thấy trong **phần đã quét** không chứng minh đơn chưa tồn tại. Phải biết
  phép quét đã bao phủ hết trước khi POST lại; nếu không, retry “an toàn” chính là nguồn nhân
  đôi đơn.
