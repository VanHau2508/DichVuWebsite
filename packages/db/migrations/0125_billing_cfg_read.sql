-- 0125: seller đọc được TÀI KHOẢN NHẬN TIỀN của nền tảng (vá thiếu sót của 0124).
--
-- 0124 REVOKE ALL trên platform_billing_config để né default privileges của 0003 — đúng,
-- nhưng revoke luôn cả thứ seller CẦN: số tài khoản để dựng mã VietQR cho shop chuyển khoản.
-- Không có nó thì trang "Gói dịch vụ" hiện nút trả tiền mà không vẽ được QR.
--
-- Cấp THEO CỘT, cố ý bỏ sepay_token_hash: đó là bí mật để KHỚP tiền về, không phải thông
-- tin để hiện cho người bán. Ba cột còn lại vốn dĩ phải in ra màn hình cho mọi shop nhìn.
--
-- Bảng này KHÔNG có shop_id (nền tảng chỉ có một túi tiền) nên USING (true) ở đây không
-- phải lỗ hổng đa-tenant: không có dữ liệu của tenant nào để rò.
GRANT SELECT (bank_bin, account_number, account_name, enabled) ON platform_billing_config TO app_rw;
CREATE POLICY rw_billing_cfg_read ON platform_billing_config FOR SELECT TO app_rw USING (true);
