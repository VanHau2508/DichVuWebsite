-- 0102 — quyền DỌN RÁC ảnh đánh giá cho worker.
--
-- 0101 cấp app_expiry SELECT + UPDATE(deleted_at) — đủ để ĐÁNH DẤU nhưng KHÔNG đủ để dọn:
-- sau khi xoá object trong MinIO, dòng DB phải biến mất, nếu không mỗi vòng quét lại thử
-- xoá lại đúng những object đã xoá (không sai, nhưng bảng phình mãi và log rác mãi).
GRANT DELETE ON review_images TO app_expiry;

-- Vì sao KHÔNG dựa vào ON DELETE CASCADE để dọn:
--   review_images CASCADE theo product_reviews (0101). Khi chủ shop XOÁ HẲN một đánh giá,
--   dòng ảnh bay theo NGAY — nhưng object trong MinIO thì không ai xoá, và từ lúc đó KHÔNG
--   CÒN BẢN GHI NÀO trỏ tới nó nữa: object thành mồ côi vĩnh viễn, chỉ có cách quét cả
--   bucket mới tìm ra. Vì vậy apps/seller PHẢI xoá object TRƯỚC khi xoá dòng đánh giá
--   (xem deleteReview). Worker chỉ lo hai loại rác CÒN dấu vết trong DB:
--     · ảnh đã xoá mềm (đánh giá bị từ chối)
--     · ảnh treo 'pending'/'failed' quá lâu (đánh giá không bao giờ được duyệt)
