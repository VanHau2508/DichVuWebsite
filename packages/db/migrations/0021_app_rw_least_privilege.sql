-- 0021 — siết quyền app_rw trên bảng GLOBAL / billing / ledger (P0-3).
--
-- 0003 cấp app_rw CRUD trên MỌI bảng + ALTER DEFAULT PRIVILEGES cho bảng tương lai.
-- Identity đã REVOKE ở 0005. Nhưng bảng GLOBAL thêm sau vẫn để app_rw ghi được:
--   • platform_staff  — role app_rw (service seller) ghi được = tự phong platform admin.
--   • plans           — dữ liệu tham chiếu, seller không được sửa.
--   • schema_migrations — sổ migration; seller sửa = che/giả lịch sử schema.
-- Và billing/ledger (tenant nhưng RLS own-shop → seller tự tác động chính mình):
--   • subscriptions        — seller tự nâng gói / gia hạn.
--   • payment_transactions — sổ giao dịch; seller giả/sửa thanh toán.
-- app_rw = CHỈ service seller (+ dbtest). Nó KHÔNG tham chiếu bất kỳ bảng nào ở trên.
--
-- Bịt bằng REVOKE. Bất biến schema-invariants.test.js "app_rw không ghi bảng GLOBAL
-- (trừ shops)" bắt MỌI rò rỉ tương lai — kể cả bảng mới nhận quyền qua default privileges.

-- Global admin / infra: app_rw không đụng gì.
REVOKE ALL ON platform_staff    FROM app_rw;
REVOKE ALL ON plans             FROM app_rw;
REVOKE ALL ON schema_migrations FROM app_rw;

-- Billing + ledger: seller KHÔNG được ghi (đọc RLS own-shop vô hại → giữ SELECT).
REVOKE INSERT, UPDATE, DELETE ON subscriptions        FROM app_rw;
REVOKE INSERT, UPDATE, DELETE ON payment_transactions FROM app_rw;
