-- 0127: app_billing được ghi subscriptions.plan_code (vá thiếu sót của 0124).
--
-- e2e bắt: "permission denied for table subscriptions". Shop trả tiền để ĐỔI GÓI thì lúc
-- áp dụng phải ghi plan_code mới, nhưng 0124 chỉ cấp UPDATE (status, current_period_end,
-- suspended_at). Hậu quả nếu không vá: tiền đã VÀO TÀI KHOẢN nhưng hạn không cộng, và lỗi
-- chỉ nằm trong log worker — người bán trả tiền xong vẫn bị khoá, còn ta không biết.
--
-- Đây là lý do quyền theo CỘT đáng giá: nó bắt lỗi ngay chứ không im lặng cho qua. Nhưng
-- cũng là lý do phải có e2e đi trọn vòng — đọc code không thấy được cột nào thiếu quyền.
GRANT SELECT (plan_code), UPDATE (plan_code) ON subscriptions TO app_billing;
