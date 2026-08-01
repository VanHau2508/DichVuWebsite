-- 0123: dọn phiên hội thoại Messenger nguội (PII).
--
-- `messenger_sessions.last_customer` giữ tên/SĐT/địa chỉ lần mua trước — đó chính là thứ
-- khiến khách mua lần hai chỉ còn 2 chạm, không phải gõ lại gì. Đổi lại nó là DỮ LIỆU CÁ
-- NHÂN, và dữ liệu cá nhân không có mục đích sử dụng nữa thì phải xoá (tinh thần 0064).
-- Không có ai dọn thì bảng này lớn dần mãi và mang theo SĐT của mọi người từng nhắn tin.
--
-- Giao cho app_expiry — vai QUÉT DỌN xuyên shop vốn đã làm việc này cho đơn hết hạn. Không
-- đẻ vai mới cho một câu DELETE; và không giao cho app_messenger vì policy của nó khoá theo
-- shop (đúng như thiết kế), nên nó không quét xuyên shop được.
GRANT SELECT, DELETE ON messenger_sessions TO app_expiry;
CREATE POLICY expiry_gc ON messenger_sessions FOR ALL TO app_expiry USING (true) WITH CHECK (false);
