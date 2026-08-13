-- 0167 - Buộc yêu cầu trả hàng đã hoàn tất phải nối đúng một phiếu RMA của chính đơn đó.
--
-- 0158 mới chỉ buộc result_return_id cùng shop. Vì vậy app_rw vẫn có thể đóng yêu cầu trả hàng mà
-- không có chứng từ, nối phiếu trả của đơn khác trong cùng shop, hoặc dùng một phiếu trả để đóng
-- nhiều yêu cầu. Ba khóa dưới đây giữ quan hệ request -> RMA giải thích được hoàn toàn tại DB.

-- PostgreSQL cần một khóa duy nhất chứa đủ ba cột trước khi tạo composite FK ở order_requests.
-- id vốn đã là PK nên chỉ số này không thay đổi tính duy nhất của returns, chỉ mở đúng khóa tham chiếu.
CREATE UNIQUE INDEX returns_shop_order_id_unique
  ON returns (shop_id, order_id, id);

ALTER TABLE order_requests
  ADD CONSTRAINT order_requests_result_return_order_fk
  FOREIGN KEY (shop_id, order_id, result_return_id)
  REFERENCES returns (shop_id, order_id, id);

ALTER TABLE order_requests
  ADD CONSTRAINT order_requests_completed_return_has_result
  CHECK (
    request_type <> 'return'
    OR status <> 'completed'
    OR result_return_id IS NOT NULL
  );

-- Một phiếu RMA là một chứng từ terminal của đúng một yêu cầu. Phiếu trả tạo trực tiếp, không đi từ
-- order_request, vẫn hợp lệ vì chỉ số chỉ xét các request đã nối result_return_id.
CREATE UNIQUE INDEX order_requests_result_return_once
  ON order_requests (shop_id, result_return_id)
  WHERE result_return_id IS NOT NULL;

