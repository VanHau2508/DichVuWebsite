-- 0076 — Đợt 6.3 (bổ khuyết): gắn trần timeout cho app_worker.
--
-- 0075 gắn statement_timeout/lock_timeout/idle_in_transaction cho MỌI role phục vụ request
-- + app_expiry, nhưng SÓT app_worker (poller outbox, 0015) — kiểm toán mốc 4 bắt được, mâu
-- thuẫn với cam kết "mọi role app" của 0075. app_worker chạy pool nền tự-chứa (không phải
-- pool phục vụ request mà tấn công vắt-cạn nhắm tới), rủi ro thấp — nhưng để phòng thủ
-- chiều sâu ĐỦ và khớp cam kết. Cùng bậc app_expiry (worker quét theo lô lâu hơn → rộng hơn).
ALTER ROLE app_worker SET statement_timeout = '120s';
ALTER ROLE app_worker SET lock_timeout = '30s';
ALTER ROLE app_worker SET idle_in_transaction_session_timeout = '120s';
