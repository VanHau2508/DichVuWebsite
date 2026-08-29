# Trung tâm vận hành — lát cắt Tổng quan

Lát cắt này mở rộng màn hình Tổng quan thành nơi chủ shop biết việc cần xử lý trong ngày.
Nó không tạo endpoint thứ hai: seller-admin vẫn gọi `GET /shops/:shopId/stats`, còn các trường
mới được thêm theo kiểu additive để client cũ tiếp tục hoạt động.

## Hợp đồng `/stats`

- `generated_at`: thời điểm bắt đầu đọc snapshot trong transaction, theo ISO-8601.
- `partial.failed`: danh sách nhóm tùy chọn không đọc được; lỗi không bị biến thành số `0`.
- `sync`: `mode`, `provider`, `status`, `freshness_at`, `lag_seconds` và tổng số discrepancy
  đang mở của shop (không chỉ connector đang được chọn để hiển thị).
- `todo_items[]`: mã việc, số đếm, mức độ, nguồn và cờ `available`.
- Trường cũ `revenue`, `series`, `status`, `top_products`, `low_stock`, `shipment_attention` và
  `todo` vẫn được trả. Bốn số trạng thái đơn trong `todo` lấy từ KPI lõi ngay cả khi nhóm todo
  tùy chọn lỗi; các mục còn lại trả `null` và được đánh dấu unavailable trong `todo_items`.

Mọi truy vấn chạy trong `withTenant` với RLS hiện có. KPI lõi lỗi thì request thất bại rõ ràng;
các nhóm phụ dùng savepoint để snapshot còn lại vẫn có thể hiển thị.

## Giao diện

`renderOverview` dùng một `TODO_REGISTRY` duy nhất, tái sử dụng các Set vai đang có trong
`pages.js`. API chỉ trả dữ liệu nghiệp vụ; label, href và quyền hiển thị do seller-admin ánh xạ.
Thẻ số liệu vẫn hiện cho vai được mở Tổng quan; chỉ link/nút tới trang mà vai không có quyền
mới bị ẩn. Dashboard giữ SSR/no-JS, trạng thái dữ liệu chưa lấy được không hiển thị số `0` giả,
và có thẻ riêng cho độ tươi tồn kho.

## Kiểm chứng

- Unit manifest: 318/318; contract operations-center: 27/27; mutation gồm chốt ghi
  `partial.failed`, từ vựng liên service, dây nối response và tách danh sách vận đơn: 7/7.
- E2E `ops-batch`: 15/15 sau restart seller/seller-admin.
- Fresh migration: 180 migration, 0 drift, 0 pending; security scan: 0 phát hiện.
- DB invariant cần chạy trên DB đã áp đủ migration. DB dev hiện tại còn drift lịch sử ở `0178`,
  nên không dùng kết quả của DB đó để tuyên bố cổng đầy đủ xanh.

## Giới hạn và bước kế tiếp

Lát cắt này chưa triển khai trung tâm đơn đa kênh, checkout UX, onboarding/thông báo, website
builder hay CRM. Sau khi review độc lập và fast-forward, tiếp tục đo checkout mobile và onboarding;
builder/CRM chỉ quyết sau pilot thật 14 ngày. External-master vẫn không được bật cho shop thật
trước spike bằng credential KiotViet để xác minh webhook, rate limit và ngữ nghĩa HTTP 404.
