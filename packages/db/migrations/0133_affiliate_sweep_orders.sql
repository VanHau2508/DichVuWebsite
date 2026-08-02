-- 0133 — Vai sweep hoa hồng phải ĐỌC ĐƯỢC `orders`.
--
-- 0132 cấp policy cho affiliate_commissions/shop_affiliate_config/affiliates nhưng QUÊN
-- `orders` — bảng đó có FORCE ROW LEVEL SECURITY, mà FORCE nghĩa là KHÔNG có policy khớp
-- thì vai thấy ĐÚNG 0 DÒNG. Không lỗi, không cảnh báo: câu lệnh chạy sạch và trả về rỗng.
-- Hệ quả: sweep chạy đều mỗi 5 phút, log "eligible: 0, voided: 0" mãi mãi, và không hoa
-- hồng nào từng được chốt. e2e bắt được; đọc code thì không, vì code ĐÚNG.
--
-- Bài học ghi lại: GRANT SELECT chỉ mở CỘT, POLICY mới mở DÒNG. Bảng FORCE RLS cần CẢ HAI.
--
-- CỘT hẹp nhất có thể (mirror loyalty_orders_worker 0086): sweep chỉ cần biết đơn đã giao
-- chưa và giao lúc nào. Không cấp tên/SĐT/địa chỉ khách — worker quét hoa hồng không có
-- việc gì với PII, và cột không cấp thì không thể lọt vào log.
GRANT SELECT (id, shop_id, status, delivered_at) ON orders TO app_affiliate;
CREATE POLICY affiliate_orders_worker ON orders FOR SELECT TO app_affiliate USING (true);
