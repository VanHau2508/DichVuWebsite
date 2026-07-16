-- 0049 — CRM-lite: ghi chú khách hàng. Danh sách khách DẪN XUẤT từ orders (gộp theo
-- customer_phone đã chuẩn hoá — 0040) nên KHÔNG cần bảng customers riêng; chỉ ghi chú
-- của shop về một SĐT là dữ liệu mới.

CREATE TABLE customer_notes (
  shop_id    uuid NOT NULL REFERENCES shops (id),
  phone      text NOT NULL,
  note       text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, phone)
);
ALTER TABLE customer_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_notes FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_notes FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_notes TO app_rw;
