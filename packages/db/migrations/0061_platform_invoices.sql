-- 0061 — platform_invoices: sổ THU thuê bao (concierge, thu tay) — nguồn sự thật
-- "nền tảng đã thu bao nhiêu, của shop nào, lúc nào".
--
-- Trước giờ renewSubscription chỉ audit {months, plan_code} — KHÔNG số tiền, không
-- lịch sử, không đối chiếu được doanh thu. Mỗi lần ghi nhận thu = một dòng, append-only
-- như audit_logs (chứng từ: không UPDATE/DELETE cho bất kỳ role nào). amount_vnd mặc
-- định = plans.price_vnd_month × months; ghi đè thủ công cho deal thương lượng (note ghi lý do).
--
-- Truy cập: CHỈ app_platform (SELECT + INSERT). app_rw (service seller) KHÔNG thấy ở v1.
-- Hai bẫy phải né tường minh:
--   1. 0003 ALTER DEFAULT PRIVILEGES tự cấp app_rw CRUD trên mọi bảng mới của app_owner
--      → REVOKE ALL bên dưới. Test bất biến "bảng GLOBAL" KHÔNG bắt được (bảng này có
--      shop_id nên được miễn) — e2e platform kiểm has_table_privilege bù cho lỗ này.
--   2. schema-invariants đòi bảng có shop_id phải FORCE RLS + có ≥1 policy app_rw
--      → policy tenant_isolation "ngủ": không có GRANT nên vô hiệu hoàn toàn; v2 muốn
--      cho seller xem lịch sử đóng phí của chính họ thì chỉ cần GRANT SELECT.
-- Hoá đơn VAT (NĐ123) lập ngoài hệ thống (phần mềm kế toán) — bảng này là căn cứ số liệu.

CREATE TABLE platform_invoices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id),
  plan_code   text NOT NULL REFERENCES plans(code),
  months      int  NOT NULL CHECK (months >= 1 AND months <= 24),
  amount_vnd  bigint NOT NULL CHECK (amount_vnd >= 0),
  note        text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);
CREATE INDEX platform_invoices_shop_idx ON platform_invoices (shop_id, created_at DESC);

ALTER TABLE platform_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_invoices FORCE  ROW LEVEL SECURITY;

-- Bẫy 1: thu hồi CRUD mà default privileges của 0003 vừa tự cấp lúc CREATE.
REVOKE ALL ON platform_invoices FROM app_rw;

-- Bẫy 2: policy app_rw "ngủ" — thoả bất biến "bảng shop_id phải có policy app_rw";
-- vô hiệu vì app_rw không có bất kỳ GRANT nào trên bảng này.
CREATE POLICY tenant_isolation ON platform_invoices FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- app_platform: đọc + ghi xuyên shop (mirror audit_logs ở 0006:103-104). KHÔNG UPDATE/DELETE.
GRANT SELECT, INSERT ON platform_invoices TO app_platform;
CREATE POLICY platform_invoice_read   ON platform_invoices FOR SELECT TO app_platform USING (true);
CREATE POLICY platform_invoice_insert ON platform_invoices FOR INSERT TO app_platform WITH CHECK (true);
