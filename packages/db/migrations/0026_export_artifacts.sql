-- 0026 — bản xuất dữ liệu (A4): link tải HẾT HẠN cho owner.
--
-- Owner (perm 'export', đã step-up) tạo bản xuất ZIP (CSV: sản phẩm/biến thể/đơn/
-- khách + manifest ảnh) → ZIP lưu vào bucket PRIVATE (media-private, prefix exports/)
-- → sinh token ngẫu nhiên 256-bit, lưu HASH + TTL ngắn. Tải về đi QUA seller đã xác
-- thực (owner + token), seller getObject stream ra. KHÔNG dùng presigned URL: MinIO là
-- host nội bộ (minio:9000) không lộ ra trình duyệt, và không được phá ranh giới
-- "bucket private không bao giờ đọc ẩn danh".
--
-- Hết hạn cưỡng chế Ở RLS (policy export_read USING expires_at > now()) → token quá
-- hạn thì DB tự giấu → tải về 404 dù code quên lọc. Cô lập tenant cũng ở RLS.

CREATE TABLE export_artifacts (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL,
  token_hash   text NOT NULL,                 -- sha256(token trong link); KHÔNG lưu token thô
  storage_key  text NOT NULL,                 -- key trong bucket private: exports/<shop>/<id>.zip
  created_by   uuid NOT NULL,                 -- user tạo (owner) — truy vết
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (shop_id, id),
  UNIQUE (token_hash),
  FOREIGN KEY (shop_id) REFERENCES shops (id)
);

-- ── RLS: app_rw (seller) ──────────────────────────────────────────────────────
-- INSERT: chỉ vào shop mình. SELECT (lúc tải): chỉ shop mình VÀ CHƯA hết hạn — hết
-- hạn cưỡng chế ở DB. KHÔNG có policy UPDATE/DELETE → bản ghi bất biến (như ledger).
ALTER TABLE export_artifacts ENABLE ROW LEVEL SECURITY; ALTER TABLE export_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY export_write ON export_artifacts FOR INSERT TO app_rw
  WITH CHECK (shop_id = current_shop_id());
CREATE POLICY export_read ON export_artifacts FOR SELECT TO app_rw
  USING (shop_id = current_shop_id() AND expires_at > now());
