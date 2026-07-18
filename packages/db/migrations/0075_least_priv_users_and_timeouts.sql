-- 0075 — Đợt 6 gia cố (kiểm toán tấn công): siết cột users + timeout DB cho mọi role app.

-- (A) app_rw đang có SELECT TOÀN CỘT trên users (0007:26), gồm password_hash (Argon2id).
-- Least-privilege: service seller chỉ đọc u.id + u.email (đã rà: listMembers, audit-log
-- LEFT JOIN, refunds created_by). password_hash lọt tầm với app_rw là bề mặt để lộ hash
-- nếu về sau có SQLi ở service seller — cùng-shop, KHÔNG rò chéo tenant (policy
-- member_visibility 0007 giới hạn DÒNG), nhưng đây là phòng thủ chiều sâu. Siết theo CỘT
-- (mirror app_payment 0013). Policy member_visibility chỉ tham chiếu users.id → không ảnh hưởng.
REVOKE SELECT ON users FROM app_rw;
GRANT SELECT (id, email) ON users TO app_rw;

-- (B) Không role app nào đặt statement_timeout/lock_timeout/idle_in_transaction (rolconfig
-- rỗng — chỉ tls-authorize đặt trong code). Query treo (full-scan tìm kiếm, lock chờ) giữ
-- kết nối pool vô hạn → 1 kẻ tấn công vắt cạn pool. Đặt trần THEO ROLE (ALTER ROLE SET —
-- áp mọi kết nối của role, không đụng code app; migration chạy bằng owner nên KHÔNG dính).
-- Trần rộng tay cho query hợp lệ (dashboard, import ≤ trần gói) nhưng cắt đuôi treo.
DO $$
DECLARE r text;
BEGIN
  -- Role phục vụ REQUEST người dùng (public/interactive): cắt chặt.
  FOREACH r IN ARRAY ARRAY['app_rw','app_store','app_checkout','app_payment','app_auth','app_platform','app_billing','app_domainverify'] LOOP
    EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', r, '20s');
    EXECUTE format('ALTER ROLE %I SET lock_timeout = %L', r, '8s');
    EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', r, '60s');
  END LOOP;
  -- Worker (app_expiry): sweep theo LÔ quét hợp lệ lâu hơn → trần cao hơn, vẫn có trần.
  ALTER ROLE app_expiry SET statement_timeout = '120s';
  ALTER ROLE app_expiry SET lock_timeout = '30s';
  ALTER ROLE app_expiry SET idle_in_transaction_session_timeout = '120s';
END $$;
