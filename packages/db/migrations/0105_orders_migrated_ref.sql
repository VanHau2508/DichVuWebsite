-- 0105 — Mã gốc của đơn di cư + khoá CHỐNG NHẬP TRÙNG (docs/45).
--
-- VÌ SAO CẦN. Nhập đơn cũ hai lần — một cú bấm nhầm, một lần tải lại trang — sẽ NHÂN ĐÔI
-- tổng chi của mọi khách trong tệp. Hồ sơ khách hàng là toàn bộ lý do tính năng này tồn tại,
-- nên làm hỏng nó bằng một thao tác vô ý là hỏng đúng thứ ta định đem lại.
--
-- Chống trùng bằng MÃ ĐƠN GỐC ở sàn cũ chứ không bằng (khách + ngày + tiền): một khách mua
-- hai đơn cùng ngày cùng giá là chuyện thường, khoá kiểu đó sẽ NUỐT đơn thật.
--
-- order_number của ta vẫn cấp từ shop_counters như đơn thường (không tái dùng số của sàn cũ:
-- mã sàn thường có chữ, và trộn dãy số sẽ đụng đơn tương lai). migrated_ref giữ mã gốc để
-- người bán còn đối chiếu được với sàn cũ.

ALTER TABLE orders ADD COLUMN migrated_ref text;

-- Duy nhất TRONG shop, và CHỈ áp cho đơn di cư có khai mã gốc. Đơn thường (migrated_ref
-- NULL) không bị ràng buộc; đơn di cư không khai mã gốc thì chấp nhận nhập lại được —
-- không có gì để nhận diện thì không thể chống trùng, và ta nói rõ điều đó ở UI.
CREATE UNIQUE INDEX orders_migrated_ref_uq ON orders (shop_id, migrated_ref)
  WHERE is_migrated AND migrated_ref IS NOT NULL;

COMMENT ON COLUMN orders.migrated_ref IS
  'Mã đơn GỐC ở sàn cũ (docs/45). Khoá chống nhập trùng; NULL với đơn phát sinh trên nền tảng này.';
