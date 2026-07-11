-- 0007 — seller-admin: step-up auth + cho phép app_rw thấy email nhân sự.
--
-- Đây là migration đầu tiên phục vụ app_rw (vai trò tenant có RLS) dùng thật
-- trong một dịch vụ. Cho tới nay app_rw chỉ xuất hiện trong test.

-- ── Step-up authentication ───────────────────────────────────────────────────
-- Thao tác nhạy cảm (đổi quyền, xoá thành viên, domain, export, hoàn tiền) yêu
-- cầu người dùng vừa xác thực lại gần đây. Ghi mốc thời gian trên phiên.
ALTER TABLE sessions ADD COLUMN stepped_up_at timestamptz;

-- ── users: RLS để app_rw thấy ĐÚNG nhân sự của shop hiện tại ─────────────────
-- Seller-admin cần hiện email nhân viên. Nhưng app_rw KHÔNG được thấy toàn bộ
-- bảng users (mọi khách của mọi shop). Giải: bật RLS trên users:
--   - app_auth: toàn quyền (đăng nhập tra email bất kỳ) — auth_all.
--   - app_rw: chỉ SELECT user LÀ THÀNH VIÊN của shop trong context hiện tại.
--
-- users KHÔNG có cột shop_id nên không thuộc bộ "bảng tenant" mà test bất biến
-- kiểm — RLS ở đây là lớp phòng thủ THÊM, không phá quy ước hiện có.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE  ROW LEVEL SECURITY;

-- app_auth vẫn cần toàn quyền: đăng ký (INSERT), đăng nhập (SELECT theo email),
-- đổi mật khẩu (UPDATE). Không có policy này thì FORCE RLS khoá luôn auth.
CREATE POLICY auth_all ON users FOR ALL TO app_auth USING (true) WITH CHECK (true);

GRANT SELECT ON users TO app_rw;
CREATE POLICY member_visibility ON users FOR SELECT TO app_rw
  USING (EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.user_id = users.id AND m.shop_id = current_shop_id()
  ));

-- app_rw đã có quyền trên memberships + invitations (0005/0006). Không cần thêm.
-- Seller-admin dùng chính app_rw + withTenant(shop_id) → RLS tự cô lập.
