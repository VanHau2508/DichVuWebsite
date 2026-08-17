-- 0175 — refund một phần phải idempotent. FOR UPDATE chỉ tuần tự hoá hai request;
-- nếu đơn vẫn paid sau lần hoàn đầu thì request thứ hai vẫn ghi thêm một phiếu hợp lệ về
-- mặt schema. Key nằm trên chứng từ để đối soát được, còn response replay được giữ trong
-- idempotency_keys dùng chung để cả ca hoàn đơn 0đ (không sinh refunds row) vẫn an toàn.

ALTER TABLE refunds
  ADD COLUMN idempotency_key uuid,
  ADD COLUMN request_fingerprint text,
  ADD CONSTRAINT refunds_idempotency_pair_ck CHECK (
    (idempotency_key IS NULL AND request_fingerprint IS NULL)
    OR
    (idempotency_key IS NOT NULL AND request_fingerprint ~ '^[0-9a-f]{64}$')
  );

CREATE UNIQUE INDEX refunds_idem_uq
  ON refunds (shop_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

