-- 0185 — LÝ DO ảnh không tải được, để người bán có thứ để hành động.
--
-- VÌ SAO. `0106` dựng hàng đợi tải ảnh: dòng media 'pending' + source_url là đơn vị công
-- việc, worker tải nền và đánh 'failed' khi hỏng. Nhưng nó KHÔNG ghi lại hỏng vì cái gì.
--
-- Đo được ngày 06/09 trên stack dev, shop nhập CSV có ảnh: `/stats` không có khoá nào nhắc
-- media, `todo_items` không có mã nào, Tổng quan và danh sách sản phẩm đều im. Bề mặt DUY
-- NHẤT là ô "lỗi xử lý" trong trang sửa TỪNG sản phẩm. Shop di cư 300 SP × 3 ảnh phải mở
-- 300 trang mới biết ảnh nào chưa về — mà trang nhập thì vừa hứa "Ảnh sẽ tải 900".
--
-- Con số đếm được thì đã đủ để dựng ô "việc cần làm", nhưng KHÔNG đủ để trả lời câu thứ hai
-- mà mọi màn hình lỗi ở kho này phải trả lời: *làm gì tiếp*. "12 ảnh không tải được" và
-- "12 ảnh trỏ vào mạng nội bộ, sửa URL trong tệp rồi nhập lại" là hai màn hình khác hẳn
-- nhau về giá trị. Cột này là phần chênh lệch đó.
--
-- TỪ VỰNG ĐÓNG, canh bằng CHECK. Cùng lý do với `shipments.provider_status` ở 0184: mã lỗi
-- là hợp đồng đi qua biên giới worker → seller → trang, và một chuỗi tự do thì sẽ có ngày
-- worker ghi 'TIMEOUT' còn trang so với 'timeout'. Mười một mã đầu là toàn bộ mã mà hàng rào
-- `packages/net-guard/src/fetch-image.js` và bước sniff magic byte của worker sinh ra;
-- 'other' là lối thoát cho lỗi ngoài hàng rào (sharp, MinIO) — có lối thoát thì worker mới
-- không phải nuốt lỗi để lách CHECK. `schema-invariants` so BẰNG tập này với tập rút từ mã.
--
-- NULL nghĩa là "CHƯA BIẾT", không phải "không có lỗi" (§3 NULL ≠ 0): dòng failed từ trước
-- migration này không có lý do, và giao diện phải nói đúng như vậy thay vì đoán.

ALTER TABLE media ADD COLUMN last_error text;

ALTER TABLE media ADD CONSTRAINT media_last_error_ck CHECK (
  last_error IS NULL OR last_error IN (
    -- hàng rào SSRF từ chối URL (fetch-image.js ném ImgError trước khi mở kết nối)
    'blocked', 'dns', 'port', 'scheme', 'url_invalid', 'userinfo',
    -- hàng rào đã mở kết nối rồi mới hỏng
    'net', 'status', 'timeout', 'too_big',
    -- worker: tải về được nhưng không phải ảnh (sniff magic byte)
    'not_image',
    -- ngoài hàng rào: sharp/MinIO/lỗi chưa phân loại
    'other'
  ));

COMMENT ON COLUMN media.last_error IS
  'Mã lỗi lần tải gần nhất (từ vựng đóng, xem media_last_error_ck). NULL = chưa biết.';

-- app_expiry có GRANT THEO CỘT (0106) nên cột mới KHÔNG tự vào — khác app_rw/app_store vốn
-- có grant cấp BẢNG. Quên hai dòng này thì worker ghi 'failed' được nhưng ghi lý do thì
-- 42501, và vì sweep bắt mọi lỗi nên nó sẽ hỏng LẶNG LẼ: dòng đứng nguyên ở pending.
GRANT SELECT (last_error) ON media TO app_expiry;
GRANT UPDATE (last_error) ON media TO app_expiry;
