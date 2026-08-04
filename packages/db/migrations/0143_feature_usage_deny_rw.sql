-- 0143 — Policy TỪ CHỐI tường minh cho app_rw trên feature_usage (vá cho 0141/0142).
--
-- Bất biến schema đòi: "mọi bảng có shop_id đều có ít nhất một policy cho app_rw". 0141 KHÔNG
-- viết policy nào cho app_rw — cố ý, vì đây là bảng XUYÊN SHOP của nền tảng — nên bất biến đỏ.
--
-- CÓ THỂ thêm ngoại lệ vào bất biến. KHÔNG làm thế: chính 0141 đã viết rằng ngoại lệ là chỗ
-- bảng thứ 40 trốn ra được. Mục đích của bất biến là ép người thêm bảng phải NGHĨ về app_rw;
-- một policy `USING (false)` chính là kết quả của việc đã nghĩ, và nó nói ý định ra thành lời
-- ngay trong schema — mạnh hơn hẳn sự im lặng mà 0141 để lại.
--
-- Ba lớp cùng chiều, không lớp nào thừa:
--   0141  FORCE RLS + không có policy nới quyền cho app_rw
--   0142  REVOKE mọi grant (vì ALTER DEFAULT PRIVILEGES tự cấp cho bảng mới)
--   0143  policy nói thẳng: app_rw KHÔNG thấy dòng nào ở đây
CREATE POLICY rw_no_access ON feature_usage FOR ALL TO app_rw
  USING (false) WITH CHECK (false);
