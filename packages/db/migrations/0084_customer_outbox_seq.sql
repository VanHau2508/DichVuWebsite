-- 0084 — VÁ: app_customer thiếu USAGE trên outbox_id_seq (bỏ sót ở 0083).
--
-- 0083 GRANT INSERT ON outbox TO app_customer để đẩy email verify/reset, nhưng outbox.id
-- mặc định nextval('outbox_id_seq') → INSERT cần USAGE trên SEQUENCE. Thiếu → INSERT báo
-- "permission denied for table outbox" (Postgres quy lỗi sequence-default về bảng). Đây là
-- điều kiện để đăng ký/quên-mật-khẩu khách gửi được email.
GRANT USAGE, SELECT ON SEQUENCE outbox_id_seq TO app_customer;
