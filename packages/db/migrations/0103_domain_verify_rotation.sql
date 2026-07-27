-- 0103 — chống ĐÓI QUÉT cho xác minh custom domain (cùng bài học b3e229b).
--
-- 0027 để sweep chạy `WHERE verified_at IS NULL … ORDER BY created_at DESC LIMIT 100`.
-- Dòng CHƯA verify KHÔNG rời khỏi tập kết quả (khách thêm domain rồi quên đặt bản ghi TXT
-- thì nó nằm đó tới 7 ngày), nên nếu >100 domain đang chờ thì đúng 100 dòng MỚI NHẤT bị tra
-- DNS lại mỗi phút, còn domain thứ 101 KHÔNG BAO GIỜ được tra — khách đặt TXT đúng rồi vẫn
-- "chưa xác minh" hàng ngày trời, không lỗi, không log.
--
-- Vì sao KHÔNG rút cạn theo lô như nhắc-hạn/đơn-ứ: ở đó một dòng = một câu UPDATE trong DB
-- nhà mình; ở đây một dòng = một truy vấn DNS RA NGOÀI (chậm, có thể timeout). Trần 100/nhịp
-- là ĐÚNG — cái sai là luôn lấy đúng 100 dòng đó. Nên vá bằng XOAY VÒNG: đóng dấu thời điểm
-- tra gần nhất và ưu tiên dòng lâu chưa tra nhất. Cùng khuôn với sweep đồng bộ vận đơn
-- (ORDER BY synced_at NULLS FIRST) — dòng hỏng xoay xuống cuối thay vì chiếm slot mãi.
--
-- NULLS FIRST cố ý: domain VỪA THÊM (chưa tra lần nào) luôn được ưu tiên → giữ nguyên trải
-- nghiệm "đặt TXT xong là verify gần như tức thì", chỉ công bằng hoá phần đuôi hàng đợi.
ALTER TABLE domains ADD COLUMN last_checked_at timestamptz;

-- Cột trong ORDER BY cũng cần quyền SELECT, không chỉ cột trả về.
GRANT SELECT (last_checked_at), UPDATE (last_checked_at) ON domains TO app_domainverify;

-- Partial index đúng hình dạng câu quét: chỉ dòng chưa verify, đúng thứ tự xoay vòng.
CREATE INDEX domains_pending_rotation_idx
  ON domains (last_checked_at NULLS FIRST, created_at DESC)
  WHERE verified_at IS NULL;
