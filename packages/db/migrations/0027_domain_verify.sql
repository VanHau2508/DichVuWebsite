-- 0027 — vai trò app_domainverify: worker xác minh SỞ HỮU custom domain qua DNS TXT (A5).
--
-- Khách thêm custom domain (verified_at = NULL) → thêm bản ghi TXT
-- `_nentang-verify.<hostname>` = verification_token → worker (role NÀY) tra DNS, khớp thì
-- đặt verified_at = now() → tls-authorize mới cấp cert + storefront mới phục vụ.
--
-- Least-privilege: role CHỈ đọc (id, shop_id, hostname, verification_token, verified_at) và
-- CHỈ ghi cột verified_at, CHỈ bảng domains. Chạy CROSS-SHOP (không tenant context) nên cần
-- policy USING(true) riêng (domains đang FORCE RLS) — giống app_expiry ở 0022.

CREATE ROLE app_domainverify LOGIN PASSWORD 'devpassword';

-- Column-level: đọc cột cần để tra + so khớp + lọc giai đoạn (created_at); GHI đúng một cột
-- verified_at; DELETE để DỌN challenge chết (quá hạn chưa verify → giải phóng hostname toàn cục,
-- chống một shop "chiếm" tên miền của người khác bằng dòng chưa-verify giữ lock UNIQUE mãi mãi).
GRANT SELECT (id, shop_id, hostname, verification_token, verified_at, created_at) ON domains TO app_domainverify;
GRANT UPDATE (verified_at) ON domains TO app_domainverify;
GRANT DELETE ON domains TO app_domainverify;

-- RLS: cross-shop (worker không có shop context). Policy riêng cho role mới — KHÔNG đụng
-- tenant_isolation của app_rw (bất biến "đúng một policy app_rw mỗi bảng" chỉ soi app_rw).
CREATE POLICY domainverify_lookup ON domains FOR SELECT TO app_domainverify USING (true);
CREATE POLICY domainverify_flip   ON domains FOR UPDATE TO app_domainverify USING (true) WITH CHECK (true);
-- CHỈ được xoá dòng CHƯA verify (không bao giờ xoá nhầm domain đang chạy).
CREATE POLICY domainverify_gc     ON domains FOR DELETE TO app_domainverify USING (verified_at IS NULL);
