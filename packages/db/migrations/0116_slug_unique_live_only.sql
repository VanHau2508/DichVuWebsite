-- 0116: slug chỉ cần duy nhất trong các dòng CÒN SỐNG.
--
-- LỖI ĐƯỢC BÁO TỪ NGƯỜI DÙNG THẬT: tạo danh mục "Bộ trang điểm" (slug bo-trang-diem),
-- xoá đi, rồi tạo lại y hệt → "slug danh mục đã tồn tại". Không xoá được bằng cách nào,
-- slug coi như mất vĩnh viễn.
--
-- Nguyên nhân: xoá là XOÁ MỀM (`UPDATE ... SET deleted_at = now()`, catalog.js) — cố ý,
-- để đơn hàng và ảnh cũ không gãy tham chiếu. Nhưng ràng buộc lại là UNIQUE (shop_id,
-- slug) TRÊN TOÀN BẢNG, không loại trừ dòng đã xoá. Hai quyết định đúng riêng lẻ, ghép
-- lại thành sai: dòng đã xoá vẫn chiếm chỗ của slug.
--
-- KHÔNG phải hàng rào bảo vệ. Không có bình luận hay test nào coi đây là chủ ý, và nó
-- chẳng bảo vệ được gì: slug là đường dẫn công khai, tạo lại slug cũ là chuyện bình
-- thường của người bán. Đổi sang chỉ-số duy nhất CÓ ĐIỀU KIỆN.
--
-- Cùng lỗi ở CẢ products (cũng xoá mềm, cũng UNIQUE toàn bảng) — vá luôn, vì để lại
-- một nửa thì lần sau người bán xoá sản phẩm rồi tạo lại sẽ dính đúng như vậy.
--
-- An toàn khi chạy: ràng buộc cũ NGHIÊM NGẶT HƠN cái mới, nên dữ liệu đang có chắc chắn
-- thoả. Không nơi nào dùng `ON CONFLICT (shop_id, slug)` (đã rà) — mọi chỗ bắt lỗi 23505
-- rồi trả 409, và chỉ-số riêng phần vẫn ném đúng 23505.

ALTER TABLE categories DROP CONSTRAINT categories_shop_id_slug_key;
CREATE UNIQUE INDEX categories_shop_slug_live_idx
  ON categories (shop_id, slug) WHERE deleted_at IS NULL;

ALTER TABLE products DROP CONSTRAINT products_shop_id_slug_key;
CREATE UNIQUE INDEX products_shop_slug_live_idx
  ON products (shop_id, slug) WHERE deleted_at IS NULL;
