-- 0065 — MỖI SHOP CHỈ MỘT THUÊ BAO (rà soát #41).
--
-- 0006 chỉ tạo index THƯỜNG trên subscriptions(shop_id) nên tầng DB vẫn cho
-- phép nhiều thuê bao cùng shop — worker quét vòng đời và renewSubscription
-- phải tự phòng thủ ("chọn dòng mới nhất") quanh lỗ hổng này, và một INSERT
-- lệch tay là shop bị tính tiền đôi. Siết tại DB bằng UNIQUE INDEX: app chỉ
-- cần bắt 23505, không cần guard bằng tay nữa.
--
-- Dọn dữ liệu TRƯỚC khi tạo index (mẫu 0046 — dedupe rồi mới unique): shop nào
-- lỡ có >1 thuê bao → GIỮ dòng "sống nhất" (active > past_due > trial >
-- cancelled; cùng hạng thì lấy started_at mới nhất), XOÁ các dòng còn lại.
-- Xoá thẳng an toàn vì không bảng nào FK tới subscriptions(id) (đã rà
-- 0001–0064). Dev hiện 0 shop trùng — khối này là lưới an toàn cho môi trường
-- khác đã lỡ phát sinh dữ liệu trùng.
DELETE FROM subscriptions
 WHERE id NOT IN (
   SELECT DISTINCT ON (shop_id) id FROM subscriptions
    ORDER BY shop_id,
             CASE status WHEN 'active' THEN 1 WHEN 'past_due' THEN 2 WHEN 'trial' THEN 3 ELSE 4 END,
             started_at DESC, created_at DESC, id DESC
 );

CREATE UNIQUE INDEX subscriptions_shop_uq ON subscriptions (shop_id);

-- Index thường ở 0006 giờ thừa (unique index trên đã phủ shop_id) → bỏ.
DROP INDEX subscriptions_shop_idx;
