-- 0064 — Ẩn danh PII người mua (Luật BVDLCN 91/2025, hiệu lực 01/01/2026).
--
-- ANONYMIZE chứ KHÔNG DELETE: đơn giữ nguyên tiền/trạng thái/dòng hàng (lịch sử doanh
-- thu + kế toán còn nguyên) — chỉ danh tính người mua bị gỡ:
--   customer_name → '(đã ẩn danh)' (NOT NULL sentinel: UI esc() không null-safe)
--   customer_phone / customer_email / shipping_address / client_ip_hash → NULL
-- anonymized_at = mốc đã xử lý (idempotent, hiển thị, index quét).
ALTER TABLE orders ADD COLUMN anonymized_at timestamptz;

-- Hạn lưu trữ per-shop (tháng). NULL = giữ vĩnh viễn (MẶC ĐỊNH — không shop nào mất dữ
-- liệu bất ngờ; shop chủ động bật trong Cài đặt, chỉ owner đổi). Sàn 6 tháng: đơn còn
-- trong vòng đời khiếu nại/đổi trả/đối soát COD.
ALTER TABLE shops ADD COLUMN pii_retention_months int
  CHECK (pii_retention_months IS NULL OR pii_retention_months BETWEEN 6 AND 120);

-- Index quét hạn lưu trữ: partial trên đơn CHƯA ẩn danh → nhỏ dần theo thời gian.
CREATE INDEX orders_pii_sweep_idx ON orders (created_at) WHERE anonymized_at IS NULL;
-- Tra khách theo SĐT (erase + CRM hiện seq-scan): partial NOT NULL.
CREATE INDEX orders_phone_idx ON orders (shop_id, customer_phone) WHERE customer_phone IS NOT NULL;

-- ── Quyền worker (app_expiry — role tự động hoá vòng đời đơn, cross-shop) ─────
-- Sweep chỉ GHI-ĐÈ NULL — KHÔNG cấp SELECT phone/address/ip_hash (không mở thêm quyền
-- đọc PII nào; 0044 đã cấp đọc email+name cho payload outbox, giữ nguyên). Mệnh đề WHERE
-- chỉ đụng id/shop_id/status/created_at (đã có từ 0022) + anonymized_at (dưới đây) →
-- không dính bẫy "UPDATE ... WHERE cột cần SELECT(cột)".
GRANT SELECT (anonymized_at) ON orders TO app_expiry;
GRANT UPDATE (customer_name, customer_phone, customer_email, shipping_address,
              client_ip_hash, anonymized_at) ON orders TO app_expiry;
GRANT SELECT (pii_retention_months) ON shops TO app_expiry;
-- Policy: expiry_orders FOR ALL (0022) + expiry_shops FOR SELECT (0050) đã phủ — không tạo mới.

-- app_rw (endpoint xoá theo yêu cầu của seller): KHÔNG cấp gì thêm — đã đủ:
--   orders: UPDATE table-level (0003, tự phủ cột thêm sau) + tenant_isolation (0004);
--   product_reviews: UPDATE (0047); customer_notes: DELETE (0049);
--   outbox: UPDATE (0003) + tenant_isolation (0004; dòng shop_id NULL vô hình — vô hại).
