# Tái dùng biến thể và các CHỨNG TỪ ĐANG CHỜ

## Luật

Khi shop sửa trục phân loại, `saveProductOptions` (apps/seller/src/catalog.js) **tái dùng**
biến thể mồ côi cho tổ hợp mới: giữ nguyên `variant_id`, ghi đè `title`, xoá giá vốn, hạ tồn.
Rẻ và gọn — nhưng nó **đổi ý nghĩa của một id**.

> **Biến thể đang bị một CHỨNG TỪ ĐANG CHỜ trỏ tới thì KHÔNG được tái dùng.**

Chứng từ đang chờ = thứ đã ghi `variant_id` xuống và sẽ hành động theo id đó ở tương lai:

| Chứng từ | Trạng thái | Hành động tương lai theo variant_id | Che bởi |
|---|---|---|---|
| Đơn hàng | còn sống | trừ/nhả tồn, giao hàng | `inventory_levels.reserved > 0` |
| **Phiếu nhập** | `draft` / `ordered` | `receive()` cộng tồn + ghi giá vốn bình quân | **NOT EXISTS purchase_order_lines** |
| **Kiểm kê** | `counting` | chốt phiên điều chỉnh tồn | **NOT EXISTS stocktake_lines** |

Hai dòng đậm là phần bổ sung 2026-08-03. Trước đó chỉ có `reserved > 0`, mà **phiếu nhập và
kiểm kê không ghi `reserved`** — nên chúng lọt qua chốt chặn.

## Vì sao KHÔNG vá ở `receive()` bằng cách so snapshot

`purchase_order_lines.title_snapshot` / `sku_snapshot` trông như một lớp bảo vệ (chú thích ở
migration 0085:74 còn viết vậy), nhưng **snapshot là tên HIỂN THỊ, không phải danh tính**.
`title_snapshot` ghép cả `products.title`, mà shop đổi tên sản phẩm ("Áo thun basic" →
"Áo thun cotton 100%") là việc hoàn toàn hợp lệ và hay xảy ra. So chuỗi rồi chặn = **chặn oan
mọi phiếu đang chờ**, tức không nhận được hàng đã về kho. Đó là ngõ cụt, đắt hơn lỗ đang vá.

Chặn ở GỐC (không tái dùng) đúng hơn: nó không cần thêm dữ liệu, không có mặt trái, và lặp
đúng lý lẽ mà chú thích cho `reserved > 0` đã viết sẵn — "tạo biến thể MỚI thay vì tái dùng
là rẻ (một dòng) và không có mặt trái nào".

## Hình dạng lỗi (để nhận ra nếu tái xuất hiện)

Cần **hai lần bấm Lưu riêng biệt** ở khối Phân loại trong lúc phiếu chưa nhận — vì `pool`
được dựng ở catalog.js trước lệnh `DELETE product_options`, nên lượt sửa đầu chỉ làm biến thể
thành mồ côi, lượt sau mới chạm tới nó. Kịch bản đời thường: hôm nay đổi tên trục "Màu" thành
"Màu sắc", mai thêm size XL, trong khi phiếu nhập đặt NCC vẫn đang chờ hàng về.

Dấu hiệu nhìn thấy được: màn "Xác nhận nhận hàng" in tên CŨ (snapshot) nhưng cột "Tồn nay"
lấy từ `inventory_levels` theo id — đã bị reset về 0 — nên trông y như "chưa nhập". Sổ cái
kho thì hiện tên MỚI. Hai màn nói hai tên cho cùng một dòng tiền.

## Quyết định KHÔNG vá: quét ẩn danh PII với đơn di cư

Chuỗi kỹ thuật có thật và đã xác minh đủ: `import.js` ghi `created_at` = ngày ở sàn cũ; đơn
nhập mặc định `delivered`; `sweepPiiRetention` lọc theo `created_at` và không loại trừ
`is_migrated` → lịch sử vừa nhập có thể bị ẩn danh ngay nhịp quét kế.

**Đây KHÔNG phải lỗi.** Hạn lưu PII đo theo **tuổi của dữ liệu**, không theo ngày nó vào hệ
thống của ta; giữ lại chỉ vì mới import chính là vi phạm chính sách shop tự đặt. Và
`shops.pii_retention_months` mặc định NULL = **tắt**, nên chỉ shop chủ động bật mới gặp.

Cái thiếu là **lời báo trước**: người bán vừa bỏ công di cư để giữ CRM, không ai nói cho họ
biết N đơn trong tệp sẽ bị ẩn danh trong 24 giờ. **ĐÃ LÀM (commit 1648dca):** cảnh báo ngay ở màn XEM TRƯỚC (và nhắc lại ở màn nhập thật) —
`demDonSeAnDanh()` trong `apps/seller/src/import.js` đếm số đơn trong lô sẽ quá hạn, mốc cắt
tính bằng SQL cho khớp đúng biểu thức quét. Shop chưa bật hạn lưu thì không cảnh báo gì.
KHÔNG miễn trừ đơn di cư khỏi quét — miễn trừ là tạo một lỗ hổng PII vĩnh viễn để chữa một
sự bất ngờ.
