-- 0141 — ĐO LUỒNG DÙNG (feature usage). Xây CON MẮT, không xây thêm tính năng.
--
-- VẤN ĐỀ. Hệ đã có ~475 điểm vào (route × phương thức) và KHÔNG có một dòng nào đếm xem cái
-- nào được dùng. `obs.js` chỉ có request-id, log JSON và health — tức là ta biết hệ thống
-- SỐNG, nhưng không biết nó được DÙNG thế nào. Hệ quả: mọi quyết định "xây gì tiếp" đều là
-- suy đoán, kể cả khi đã có khách. Và một tính năng không ai dùng vẫn thu thuế bảo trì vĩnh
-- viễn lên đúng một người.
--
-- BẢNG NÀY TRẢ LỜI BA CÂU:
--   · màn hình nào chủ shop mở MỖI NGÀY → đó mới là sản phẩm thật, dồn sức vào đó
--   · tính năng nào chỉ vài % shop chạm → ứng viên giấu bớt cho đỡ rối
--   · lần cuối ai đó dùng nó là bao giờ → im lặng bao lâu thì gỡ
--
-- KHÔNG PHẢI PHÂN TÍCH HÀNH VI NGƯỜI DÙNG. Không user_id, không IP, không tham số, không thứ
-- tự thao tác — chỉ (service, mẫu-route, shop, ngày, số lượt). Đủ để quyết định xây gì, và
-- KHÔNG đủ để theo dõi một con người. Ranh giới đó là cố ý.

-- `route` là MẪU đã chuẩn hoá, không bao giờ là đường dẫn thật: `/shops/:id/inventory/safety`,
-- không phải `/shops/9f3c…/inventory/safety`. Nếu để id thật lọt vào thì bảng nổ theo số shop
-- và mọi phép gộp đều vô nghĩa. Chuẩn hoá làm ở obs.js, có test canh.
--
-- `shop_id` NULL = đường KHÔNG thuộc shop nào (đăng nhập, trang công ty, webhook). Không dùng
-- uuid-toàn-số-0 làm cờ: giá trị giả trong khoá ngoại là thứ ba tháng sau không ai còn nhớ.
CREATE TABLE feature_usage (
  shop_id uuid REFERENCES shops (id) ON DELETE CASCADE,
  service text NOT NULL CHECK (length(service) BETWEEN 1 AND 32),
  route   text NOT NULL CHECK (length(route)   BETWEEN 1 AND 160),
  day     date NOT NULL,
  hits    bigint NOT NULL DEFAULT 0 CHECK (hits >= 0)
);

-- NULLS NOT DISTINCT (Postgres 15+, ở đây là 16): không có nó thì mỗi lần gộp một đường
-- không-thuộc-shop lại đẻ một dòng mới, vì NULL <> NULL — bảng phình và ON CONFLICT trượt.
CREATE UNIQUE INDEX feature_usage_key
  ON feature_usage (service, route, day, shop_id) NULLS NOT DISTINCT;
-- Dọn số cũ + mọi truy vấn của console đều lọc theo khoảng ngày.
CREATE INDEX feature_usage_day_idx ON feature_usage (day);

-- Bảng có cột shop_id ⇒ bất biến schema (packages/db/test/schema-invariants.test.js) BẮT BUỘC
-- ENABLE + FORCE RLS. Đúng vậy — dù đây là bảng xuyên-shop, không bật thì bất biến kia phải
-- có ngoại lệ, mà ngoại lệ chính là chỗ bảng thứ 40 trốn ra được.
ALTER TABLE feature_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_usage FORCE  ROW LEVEL SECURITY;

-- app_expiry (worker): GỘP từ Redis + dọn dòng quá cũ. Xuyên shop nên USING(true), y hệt
-- product_view_daily (0098) và expiry_orders (0022).
GRANT SELECT, INSERT, UPDATE, DELETE ON feature_usage TO app_expiry;
CREATE POLICY expiry_usage ON feature_usage FOR ALL TO app_expiry
  USING (true) WITH CHECK (true);

-- app_platform (console nền tảng): CHỈ ĐỌC, xuyên shop. Đây là số liệu vận hành của NỀN TẢNG.
GRANT SELECT ON feature_usage TO app_platform;
CREATE POLICY platform_usage ON feature_usage FOR SELECT TO app_platform USING (true);

-- CỐ Ý KHÔNG cấp quyền cho app_rw / app_store / app_checkout / app_auth… — tức là KHÔNG service
-- nào trên đường nóng được ghi thẳng vào đây. Chúng đếm vào REDIS (fire-and-forget), worker gộp
-- theo chu kỳ. Ba cái lợi, đúng như tiền lệ 0098:
--   1. không nới quyền ghi cho vai công khai (storefront/checkout) — bất biến an ninh 0011;
--   2. đường nóng không có thêm ghi DB nào;
--   3. một route bận chỉ tốn 1 UPSERT mỗi chu kỳ thay vì 1 ghi mỗi request.
--
-- Và CỐ Ý KHÔNG cho chủ shop đọc: số liệu ở đây là của cả nền tảng (route nào bao nhiêu shop
-- dùng) — cho shop A biết shop B dùng gì là rò rỉ giữa các khách hàng.
