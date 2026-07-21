# Ảnh thật cho trang giới thiệu nền tảng (nentang.vn)

Thả file ảnh vào **thư mục này** rồi **khởi động lại storefront** — landing sẽ tự dùng
ảnh thật thay cho hình vẽ CSS. Chưa có file → giữ mock CSS (không vỡ).

Phục vụ same-origin tại `/assets/<tên-file>` (CSP `img-src 'self'` cho phép). Đuôi nhận:
`.webp .avif .png .jpg .jpeg .svg`.

## Các "khe" ảnh hiện có
| Tên file (đặt đúng tên) | Chỗ hiển thị | Kích thước gợi ý |
|---|---|---|
| `hero.webp` | Ảnh lớn cạnh tiêu đề đầu trang (khung trình duyệt) | ~1200×860, tỉ lệ ~4:3 |

> Muốn thêm khe cho các mục khác (dải "Cửa hàng của bạn", tab tính năng…)? Báo tôi thêm.

## Nên dùng ảnh gì?
Tốt nhất cho trang bán dịch vụ = **ảnh chụp màn hình cửa hàng THẬT của bạn**
(mở storefront shop của bạn, chụp màn hình phần đẹp nhất). Trung thực + thuyết phục hơn
ảnh stock. Nén WebP giúp nhẹ (ImageOptim/Squoosh).

## Lưu ý
- File ở đây được đọc **lúc storefront khởi động** → thêm/đổi ảnh phải **restart storefront**.
- KHÔNG commit ảnh nặng lung tung — chỉ để ảnh dùng thật.
