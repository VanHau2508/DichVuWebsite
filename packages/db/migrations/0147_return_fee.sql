-- 0147: phí hãng thu CHIỀU VỀ khi đơn bị bom / trả hàng.
--
-- VÌ SAO. Đơn bị bom, shop mất tiền cước HAI chiều: chiều đi đã trả lúc gửi, chiều về hãng
-- thu tiếp để mang hàng ngược lại. Sổ lãi lỗ hiện chỉ biết chiều đi (shipments.carrier_fee_vnd,
-- do hãng đồng bộ về), còn chiều về KHÔNG có chỗ nào ghi — một khoản lỗ THẬT, tiền đã ra khỏi
-- túi, mà không màn hình nào chịu trách nhiệm.
--
-- NULL ≠ 0. NULL = "chưa nhập" (màn hình còn nhắc shop điền); 0 = "hãng không thu chiều về"
-- (một sự thật, đã trả lời rồi thì thôi nhắc). Gộp hai thứ đó vào một số 0 là biến "chưa biết"
-- thành "biết chắc bằng không" — đúng lớp lỗi làm sổ sách trông sạch hơn thực tế.
--
-- Đặt trên `orders` chứ không trên `shipments`: chiều về là chuyện của CẢ ĐƠN (đơn tách nhiều
-- kiện vẫn chỉ quay về một lần), và đơn giao tay bị bom thì không có dòng shipment nào để bám.
--
-- app_rw đã có SELECT/UPDATE mức bảng trên orders (0003 default privileges) nên cột mới tự
-- phủ, KHÔNG cần GRANT thêm — mirror 0077. app_checkout/app_customer KHÔNG cần đọc: đây là
-- chi phí nội bộ của shop, khách không liên quan.

ALTER TABLE orders ADD COLUMN return_fee_vnd bigint
  CHECK (return_fee_vnd IS NULL OR return_fee_vnd >= 0);

-- Chỉ đơn ĐÃ QUAY VỀ mới có phí chiều về. Ràng buộc ở DB vì đây là cột tiền: chặn ở tầng ứng
-- dụng thôi thì một endpoint mới viết sau này quên chốt là ghi được vào đơn đang giao.
ALTER TABLE orders ADD CONSTRAINT orders_return_fee_only_returned
  CHECK (return_fee_vnd IS NULL OR status IN ('returned', 'refunded', 'cancelled'));

-- Báo cáo lọc theo kỳ trên returned_at; index một phần cho dòng CÓ phí (giống
-- shipments_shop_fee_idx của phí chiều đi).
CREATE INDEX orders_return_fee_idx ON orders (shop_id, returned_at)
  WHERE return_fee_vnd IS NOT NULL;
