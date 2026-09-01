-- 0184 — tách trạng thái nội bộ khỏi mã thô của hãng vận chuyển.
--
-- `provider_status` trước đây chứa lẫn hai từ vựng: marker phục hồi của nền tảng
-- (ambiguous, orphan, ...) và mã hãng (5, 20, -1, ...). Giữ hai namespace riêng để
-- một mã hãng không vô tình kích hoạt các đường phục hồi nội bộ.
--
-- Migration này giữ nguyên chín marker đã từng được ghi trong lịch sử, kể cả
-- `created` và `dedup_0046`; chúng là dữ liệu hợp lệ cũ, không được tự ý diễn giải
-- thành mã hãng trong lúc deploy. Các giá trị lạ trên vận đơn có `provider` được
-- chuyển nguyên văn sang cột raw mới. Dữ liệu lạ trên vận đơn nhập tay (provider
-- NULL) làm migration DỪNG lại: không biết nguồn thì không được đoán.

ALTER TABLE shipments
  ADD COLUMN carrier_status_raw text;

-- `shipments` bật FORCE RLS (0015), còn app_owner ở production không có BYPASSRLS.
-- Mở policy tạm để đọc/di chuyển dữ liệu cũ xuyên tenant; policy phải bị xoá trước
-- khi migration kết thúc, không trở thành đường runtime.
CREATE POLICY shipment_0184_owner_backfill ON shipments
  FOR ALL TO app_owner USING (true) WITH CHECK (true);

-- app_expiry chỉ cần ghi lại mã hãng sau mỗi lượt poll; không mở quyền đọc thêm.
GRANT UPDATE (carrier_status_raw) ON shipments TO app_expiry;

-- Deploy production chạy migration trước rồi mới thay image worker. Trong khoảng giao nhau,
-- worker cũ vẫn có thể gửi `provider_status = st.raw`. Chỉ chuẩn hoá đường ghi của app_expiry
-- (vai duy nhất chạy worker) để bản cũ không làm hỏng transaction khi CHECK mới đã có; owner,
-- app_rw và mọi vai khác vẫn bị CHECK chặn nếu tự ghi mã hãng vào namespace nội bộ.
CREATE FUNCTION normalize_shipment_provider_status_namespace()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_carrier_poll boolean := NEW.status IN ('in_transit', 'delivered', 'returned')
    OR (NEW.status = 'cancelled' AND NEW.tracking_number IS NOT NULL);
BEGIN
  IF current_user = 'app_expiry'
     AND NEW.provider IS NOT NULL
     AND NEW.provider_status IS NOT NULL
     -- Old tracking code wrote the carrier value through provider_status. Use the
     -- shipment lifecycle to recognize that path even when a carrier happens to
     -- return a word that collides with an internal marker (for example "created").
     AND (v_carrier_poll OR NEW.provider_status NOT IN (
       'ambiguous', 'finalize_failed', 'orphan', 'cod_mismatch',
       'claim_expired', 'reconciled', 'reconciled_cancel',
       'created', 'dedup_0046'
     )) THEN
    NEW.carrier_status_raw := NEW.provider_status;
    -- Worker cũ ghi đè mã hãng lên provider_status. Khi chuyển tiếp, giữ marker nội bộ
    -- đã có trên dòng (cod_mismatch, created, ...) thay vì xoá mất cảnh báo nghiệp vụ.
    NEW.provider_status := CASE WHEN TG_OP = 'UPDATE' THEN OLD.provider_status ELSE NULL END;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION normalize_shipment_provider_status_namespace() OWNER TO app_owner;
REVOKE ALL ON FUNCTION normalize_shipment_provider_status_namespace() FROM PUBLIC;
CREATE TRIGGER shipments_provider_status_namespace_compat
  BEFORE INSERT OR UPDATE OF provider, provider_status ON shipments
  FOR EACH ROW EXECUTE FUNCTION normalize_shipment_provider_status_namespace();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM shipments
     WHERE provider IS NULL
       AND provider_status IS NOT NULL
       AND provider_status NOT IN (
         'ambiguous', 'finalize_failed', 'orphan', 'cod_mismatch',
         'claim_expired', 'reconciled', 'reconciled_cancel',
         'created', 'dedup_0046'
       )
  ) THEN
    RAISE EXCEPTION
      'shipment_provider_status_namespace_unknown: provider NULL có provider_status lạ';
  END IF;
END;
$$;

-- Giữ nguyên exact raw text (không trim/lowercase) để audit và đối soát hãng.
UPDATE shipments
   SET carrier_status_raw = provider_status,
       provider_status = NULL
 WHERE provider IS NOT NULL
   AND provider_status IS NOT NULL
   AND provider_status NOT IN (
     'ambiguous', 'finalize_failed', 'orphan', 'cod_mismatch',
     'claim_expired', 'reconciled', 'reconciled_cancel',
     'created', 'dedup_0046'
   );

ALTER TABLE shipments
  ADD CONSTRAINT shipments_provider_status_internal_check
  CHECK (provider_status IS NULL OR provider_status IN (
    'ambiguous', 'finalize_failed', 'orphan', 'cod_mismatch',
    'claim_expired', 'reconciled', 'reconciled_cancel',
    'created'
  ));

DROP POLICY shipment_0184_owner_backfill ON shipments;
