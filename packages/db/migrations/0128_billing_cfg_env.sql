-- 0128: tài khoản nhận tiền của nền tảng chuyển sang ENV; DB chỉ giữ token khớp tiền.
--
-- Bất biến schema bắt 0125: "không policy nào của app_rw dùng biểu thức hằng true".
-- Tôi đã cấp `USING (true)` cho app_rw để seller đọc số tài khoản dựng QR — đúng thứ luật
-- đó sinh ra để cấm. Lý do luật đúng: app_rw là VAI TENANT; một policy hằng-true ở đó là
-- đúng hình dạng sẽ rò chéo shop ngay khi ai đó thêm cột shop_id hoặc tái dùng bảng này.
--
-- Không né luật bằng biểu thức nguỵ trang "luôn đúng" — đó là giữ nguyên lỗ hổng và làm
-- người review sau tưởng đã an toàn. Bỏ hẳn nhu cầu đọc: số tài khoản của NỀN TẢNG là cấu
-- hình cấp nền tảng, chỗ của nó là env như SEPAY_WEBHOOK_KEY / MESSENGER_APP_SECRET.
-- DB chỉ còn giữ thứ BẮT BUỘC phải ở DB: hash token để webhook khớp tiền về.
--
-- Một nguồn sự thật: giữ cả cột lẫn env là chắc chắn có ngày lệch, và lệch số tài khoản
-- nghĩa là in mã QR trỏ vào tài khoản sai — khách chuyển tiền đi mất.
DROP POLICY rw_billing_cfg_read ON platform_billing_config;
REVOKE ALL ON platform_billing_config FROM app_rw;

ALTER TABLE platform_billing_config DROP COLUMN bank_bin;
ALTER TABLE platform_billing_config DROP COLUMN account_number;
ALTER TABLE platform_billing_config DROP COLUMN account_name;
