-- 0111 — Bổ sung quyền đọc shops.deleted_at cho app_expiry.
--
-- 0110 cấp SELECT (created_at, onboarding_nudged_at) nhưng sweep nhắc-onboarding còn lọc
-- `s.deleted_at IS NULL`. Quyền theo CỘT tính cả cột nằm trong WHERE, không riêng cột trong
-- SELECT — thiếu một cột là cả câu lệnh bị từ chối: "permission denied for table shops".
--
-- Bắt được ngay ở lần chạy thật đầu tiên (log nudge_query_error), đúng như kỷ luật siết quyền
-- của 0075 mong đợi. Bỏ điều kiện deleted_at đi thì query chạy được, nhưng shop đã xoá mềm sẽ
-- bị nhắc — sửa quyền mới đúng, không phải nới điều kiện.
--
-- Migration BẤT BIẾN nên không sửa 0110 (đã áp, đổi là lệch checksum) — đi tiếp bằng file mới.

GRANT SELECT (deleted_at) ON shops TO app_expiry;
