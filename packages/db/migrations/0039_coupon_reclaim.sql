-- 0039 — hoàn lại lượt coupon khi đơn (đã áp mã) bị HUỶ / HẾT HẠN lúc CHƯA trả tiền.
-- used_count tăng lúc TẠO đơn (để chốt max_uses ngay khi cam kết giảm giá) → phải trả lại
-- nếu đơn không thành, nếu không kẻ xấu "đốt" hết lượt bằng đơn chưa thanh toán (griefing).
-- Chỉ hoàn cho đơn CHƯA TRẢ (đơn đã trả = lượt dùng thật, không hoàn).
--
-- app_expiry (job hết hạn, cross-shop): đọc coupon_code của đơn + giảm used_count.
GRANT SELECT (coupon_code) ON orders TO app_expiry;
GRANT SELECT (shop_id, code, used_count), UPDATE (used_count) ON coupons TO app_expiry;
CREATE POLICY expiry_coupons ON coupons FOR ALL TO app_expiry USING (true) WITH CHECK (true);
-- (Seller huỷ đơn dùng app_rw đã có UPDATE trên coupons — không cần cấp thêm.)
