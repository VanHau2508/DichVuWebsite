# Rà soát bảo mật auth (đối kháng, đa tác nhân)

> Workflow 6 chiều review → thẩm định đối kháng từng phát hiện. 13 phát hiện thô →
> 7 "confirmed". Sau khi **tự kiểm chứng bằng thực nghiệm**, kết quả tinh lọc lại
> như dưới. Bài học: một verdict "confirmed" của agent vẫn phải được kiểm bằng
> cách chạy thật — hai verifier đã mâu thuẫn nhau ở đúng phát hiện nghiêm trọng nhất.

## Đã sửa

| # | Vấn đề | Mức | Ghi chú |
|---|---|---|---|
| 1 | **register rò email tồn tại qua thân response** (`{id,email}` vs `{ok:true}`) | cao | Oracle liệt kê xác định, một request. **Cũng phơi bày một pass giả trong e2e của tôi** — test chỉ kiểm status 201, không kiểm body. Sửa: cả hai nhánh trả body y hệt. |
| 2 | **`/auth/register` không rate limit → DoS bằng Argon2** | cao | Argon2 19 MiB chạy trước cả INSERT, threadpool libuv (4) dùng chung với login/reset → làm đói xác thực hợp lệ. Sửa: rate limit theo IP TRƯỚC khi băm. |
| 3 | **Khoá tài khoản có chủ đích** (per-account limit chặn cả đăng nhập ĐÚNG của nạn nhân) | trung | Kẻ tấn công spam mật khẩu sai cho `victim@email` → nạn nhân nhập đúng cũng bị 429. Sửa: mật khẩu ĐÚNG không bao giờ bị chặn bởi bộ đếm theo tài khoản; chỉ đếm lần SAI. |
| 4 | **`hit()` INCR rồi EXPIRE không nguyên tử** → key mồ côi mất TTL vĩnh viễn | trung | Sửa: gộp vào một Lua script atomic, tự chữa key mồ côi. |
| 5 | **Chống-replay TOTP TOCTOU** (đọc `last_counter` rồi mới UPDATE, không nguyên tử) | thấp | Sửa: `UPDATE ... WHERE last_counter IS NULL OR last_counter < $1`, kiểm `rowCount`. |
| 6 | **Mã khôi phục entropy thấp** (~2^39.6, sha256 không salt) | thấp | Rò DB → bẻ offline hàng loạt. Sửa: 4 nhóm (~2^79). |
| 7 | **`clientIp()` lấy XFF trái nhất** | thấp (làm cứng) | Xem bên dưới — KHÔNG khai thác được ở cấu hình hiện tại, nhưng là code sai. Sửa: lấy phần tử PHẢI nhất. |
| 8 | **Re-enroll MFA làm mồ côi trạng thái → khoá cứng tài khoản** | thấp | Self-DoS: đang bật MFA, enroll lại rồi bỏ dở → `mfa_enabled=true, confirmed_at=NULL` → khoá cả mã khôi phục. Sửa: chặn enroll khi MFA đã bật (cần luồng disable có step-up — việc tương lai). |

## Điểm quan trọng: #7 và bài học kiểm chứng

Hai agent verifier **mâu thuẫn** về XFF: một nói khai thác được (mức cao), một nói an
toàn. Tôi **chạy thử thật**: gửi `X-Forwarded-For: 9.9.9.9, 8.8.8.8` qua Caddy →
upstream nhận `172.18.0.9` (IP thật của client). **Caddy THAY THẾ header giả**, không
nối vào. Vậy leftmost hiện KHÔNG do kẻ tấn công điều khiển — verdict "cao, khai thác
được" là SAI.

Nhưng `xff.split(',')[0]` vẫn là code sai: nó an toàn chỉ vì hành vi mặc định của
Caddy. Thêm một proxy phía trước (CDN, LB), hoặc đổi cấu hình, là leftmost thành do
kẻ tấn công kiểm soát. Fix đúng cho topology "một proxy tin cậy duy nhất là Caddy":
lấy phần tử PHẢI nhất (giá trị chính Caddy đặt). Sửa như làm cứng, không phải vá lỗ
hổng đang mở.

Nếu tin verdict của agent mà không chạy thử, tôi đã báo cáo một lỗ hổng "cao" không
có thật, và bỏ lỡ lý do thật (làm cứng theo topology).

## Bác bỏ (verifier kết luận real=false — đồng ý)

- **Không xoay token phiên khi qua MFA**: lệch ASVS 3.3.1 nhưng không khai thác được
  (token 256-bit server-sinh, `__Host-` cookie chặn fixation). Ghi nhận, làm sau.
- **forgot-password timing**: bất đối xứng ~2 INSERT, dưới nhiễu mạng, không phải oracle.
- **login không validate email**: `MAX_BODY` 16KB đã chặn; validate không đổi bảo mật.
- **XFF né rate limit (mức cao)**: bác bỏ bằng thực nghiệm (xem #7).
