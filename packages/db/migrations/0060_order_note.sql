-- 0060 — orders.note: ghi chú nội bộ của đơn TẠO THỦ CÔNG (nhân viên chốt qua FB/Zalo).
-- Nullable; app_rw có INSERT/UPDATE table-level (0003) nên tự phủ cột mới; các role
-- column-scoped (app_expiry/app_payment/app_store) liệt kê cột tường minh → không ảnh hưởng.
-- Trần độ dài (≤500) ép ở tầng app.
ALTER TABLE orders ADD COLUMN note text;
