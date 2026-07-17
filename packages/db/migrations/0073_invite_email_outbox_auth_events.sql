-- 0073 — #11 email hoá token LỜI MỜI + #12 lịch sử đăng nhập (/auth/events).
--
-- (a) LỜI MỜI qua outbox (ADR-006): platform (mời owner) và seller (mời nhân sự)
-- ghi outbox topic 'user.invited' TRONG CÙNG transaction với INSERT invitations —
-- token thô chỉ đi qua email người ĐƯỢC MỜI (token = bằng chứng sở hữu email),
-- API không trả token cho người MỜI nữa (mirror 0058 cho user.password_reset).
--
--   * app_rw (seller) đã đủ: INSERT outbox table-level (0003) + policy
--     tenant_isolation (0004) — dòng outbox mang shop_id = shop hiện tại.
--   * app_platform THIẾU CẢ HAI: 0006 không cấp outbox (trap FORCE-RLS: thiếu
--     grant là lỗi quyền; thiếu policy là "silent 0 rows"/WITH CHECK fail).
--     Cấp INSERT + policy. Platform thao tác XUYÊN shop (mirror platform_all
--     0006:99-102) nên WITH CHECK (true) — dòng mời gắn shop_id của shop được
--     mời để truy vết; worker gửi email, Telegram tự bỏ qua (tgMessageFor
--     không có nhánh user.invited).
GRANT INSERT ON outbox TO app_platform;
GRANT USAGE, SELECT ON SEQUENCE outbox_id_seq TO app_platform;
CREATE POLICY platform_outbox ON outbox FOR INSERT TO app_platform WITH CHECK (true);

-- (b) GET /auth/events — người dùng xem 50 sự kiện đăng nhập/bảo mật gần nhất
-- của CHÍNH MÌNH. app_auth mới chỉ có INSERT trên audit_logs (0005) — thiếu
-- SELECT (grant) VÀ policy đọc (FORCE RLS → 0 dòng im lặng). Policy chỉ mở
-- dòng CẤP IDENTITY (shop_id IS NULL — đúng các dòng auth tự ghi qua policy
-- auth_audit); lọc "của tôi" (actor_id = user hiện tại) nằm ở WHERE trong code
-- dịch vụ auth — policy không biết "tôi" là ai (không có session context).
GRANT SELECT ON audit_logs TO app_auth;
CREATE POLICY auth_audit_read ON audit_logs FOR SELECT TO app_auth USING (shop_id IS NULL);

-- Đọc /auth/events lọc theo actor_id trên dòng shop_id NULL — index sẵn có
-- audit_logs_shop_created_idx (shop_id, created_at DESC) không giúp lọc actor.
CREATE INDEX audit_logs_identity_actor_idx ON audit_logs (actor_id, id DESC) WHERE shop_id IS NULL;
