-- 0088 — trang /account hiển thị điểm: app_customer đọc cấu hình điểm (bật? tỉ giá đổi) để
-- gate thẻ "Điểm thưởng" + quy điểm ra đồng. Rates là điều khoản CHƯƠNG TRÌNH công khai với
-- khách (không nhạy như giá vốn) → SELECT shop-scoped an toàn.
CREATE POLICY loyalty_cfg_customer ON shop_loyalty_config FOR SELECT TO app_customer USING (shop_id = current_shop_id());
GRANT SELECT ON shop_loyalty_config TO app_customer;
