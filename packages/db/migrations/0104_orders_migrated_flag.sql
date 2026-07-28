-- 0104 — Cờ ĐƠN DI CƯ: đơn cũ mang từ sàn khác sang (docs/45).
--
-- QUYẾT ĐỊNH NGHIỆP VỤ (chủ nền tảng chốt): đơn di cư KHÔNG tính vào doanh thu, báo cáo lãi,
-- sổ cái hay điểm thưởng. Chúng vào hệ thống để TRA CỨU và để gộp thành hồ sơ khách hàng
-- (ai đã mua gì, chi bao nhiêu) — nhờ đó chuyển sang nền tảng này không mất lịch sử khách.
--
-- VÌ SAO LÀ CỜ TƯỜNG MINH, không phải mẹo để paid_at NULL:
-- mọi truy vấn tiền hiện tại đều khoá theo `paid_at IS NOT NULL`, nên để paid_at NULL sẽ loại
-- đơn di cư "miễn phí" mà không phải sửa dòng nào. NHƯNG nó tạo trạng thái MÂU THUẪN — đơn
-- payment_status='paid' mà không có ngày trả — và mọi đoạn mã sau này giả định "đã trả ⇒ có
-- paid_at" sẽ sai một cách âm thầm. Cờ tường minh thì đắt hơn (phải sửa từng truy vấn) nhưng
-- đọc là hiểu, và lưới an toàn là bộ test bất biến: nhập đơn di cư xong, doanh thu / P&L /
-- đối soát COD / điểm thưởng phải KHÔNG NHÚC NHÍCH.
--
-- Mặc định false ⇒ toàn bộ đơn đang có và mọi đường ghi hiện tại KHÔNG đổi hành vi.

ALTER TABLE orders ADD COLUMN is_migrated boolean NOT NULL DEFAULT false;

-- Chỉ mục PHẦN trên tập đơn di cư (tập nhỏ). Không đánh chỉ mục cho `= false` vì đó là gần
-- như toàn bảng — chỉ mục ở đó vô dụng, các chỉ mục sẵn có vẫn phục vụ truy vấn thường.
CREATE INDEX orders_migrated_idx ON orders (shop_id, created_at DESC) WHERE is_migrated;

COMMENT ON COLUMN orders.is_migrated IS
  'Đơn cũ nhập từ sàn khác (docs/45). KHÔNG tính doanh thu/P&L/sổ cái/điểm thưởng; chỉ để tra cứu + gộp hồ sơ khách.';

-- app_rw / app_checkout / app_owner có quyền MỨC BẢNG nên cột mới tự nằm trong phạm vi.
-- app_loyalty chỉ có quyền THEO CỘT (né PII) → phải cấp riêng, nếu không sweep tích điểm
-- thêm điều kiện lọc cờ này sẽ chết vì "permission denied for column".
GRANT SELECT (is_migrated) ON orders TO app_loyalty;
