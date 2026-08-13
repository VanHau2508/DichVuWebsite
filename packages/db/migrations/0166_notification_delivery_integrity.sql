-- 0166 - Khóa chặt chứng từ giao thông báo từ outbox tới timeline đơn hàng.
--
-- FK composite ở 0161 dùng quy tắc MATCH SIMPLE của PostgreSQL: chỉ cần shop_id NULL là toàn bộ
-- phép kiểm bị bỏ qua. Vì vậy delivery cấp nền tảng có thể trỏ tới outbox không tồn tại hoặc retry
-- một delivery của shop. Trigger null-safe bên dưới giữ nguyên composite FK chuẩn cho tenant thường,
-- đồng thời khóa + kiểm hàng cha bằng IS NOT DISTINCT FROM cho scope identity/platform.

-- Vai NOLOGIN làm chủ các trigger tham chiếu để phép kiểm không phụ thuộc RLS/quyền SELECT của
-- caller. Role không có mật khẩu và chỉ có quyền khóa/đọc đúng hai bảng liên quan.
CREATE ROLE app_notification_integrity NOLOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO app_notification_integrity;
GRANT SELECT (id, shop_id), UPDATE (id) ON outbox TO app_notification_integrity;
GRANT SELECT (id, shop_id, outbox_id, retry_of_delivery_id), UPDATE (id)
  ON notification_deliveries TO app_notification_integrity;
CREATE POLICY notification_integrity_outbox_read ON outbox
  FOR SELECT TO app_notification_integrity USING (true);
CREATE POLICY notification_integrity_delivery_read ON notification_deliveries
  FOR SELECT TO app_notification_integrity USING (true);

-- Chạy preflight bằng chính role của trigger để kết quả không phụ thuộc app_owner production có
-- BYPASSRLS hay không. Dữ liệu lịch sử sai làm migration dừng thay vì chôn một orphan có sẵn.
GRANT app_notification_integrity TO app_owner;
SET LOCAL ROLE app_notification_integrity;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM notification_deliveries nd
      LEFT JOIN outbox ob
        ON ob.id = nd.outbox_id
       AND ob.shop_id IS NOT DISTINCT FROM nd.shop_id
     WHERE ob.id IS NULL
  ) THEN
    RAISE EXCEPTION 'notification_delivery_outbox_reference_invalid'
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM notification_deliveries nd
      LEFT JOIN notification_deliveries parent
        ON parent.id = nd.retry_of_delivery_id
       AND parent.shop_id IS NOT DISTINCT FROM nd.shop_id
     WHERE nd.retry_of_delivery_id IS NOT NULL
       AND parent.id IS NULL
  ) THEN
    RAISE EXCEPTION 'notification_delivery_retry_reference_invalid'
      USING ERRCODE = '23503';
  END IF;
END;
$$;
RESET ROLE;

CREATE FUNCTION enforce_notification_delivery_references()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM 1
    FROM outbox ob
   WHERE ob.id = NEW.outbox_id
     AND ob.shop_id IS NOT DISTINCT FROM NEW.shop_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'notification_delivery_outbox_reference_invalid'
      USING ERRCODE = '23503',
            CONSTRAINT = 'notification_deliveries_outbox_nullsafe_fkey';
  END IF;

  IF NEW.retry_of_delivery_id IS NOT NULL THEN
    PERFORM 1
      FROM notification_deliveries parent
     WHERE parent.id = NEW.retry_of_delivery_id
       AND parent.shop_id IS NOT DISTINCT FROM NEW.shop_id
     FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'notification_delivery_retry_reference_invalid'
        USING ERRCODE = '23503',
              CONSTRAINT = 'notification_deliveries_retry_nullsafe_fkey';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION enforce_notification_delivery_references() FROM PUBLIC;

CREATE TRIGGER notification_delivery_reference_guard
  BEFORE INSERT OR UPDATE OF shop_id, outbox_id, retry_of_delivery_id
  ON notification_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION enforce_notification_delivery_references();

-- Khóa hàng cha ở trigger ghi phía trên chặn race insert-vs-delete. Hai trigger AFTER này xử lý
-- chiều ngược lại cho các tham chiếu NULL mà FK MATCH SIMPLE không theo dõi.
CREATE FUNCTION prevent_notification_outbox_orphan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.shop_id IS NOT DISTINCT FROM OLD.shop_id THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM notification_deliveries nd
     WHERE nd.outbox_id = OLD.id
       AND nd.shop_id IS NOT DISTINCT FROM OLD.shop_id
  ) THEN
    RAISE EXCEPTION 'notification_delivery_outbox_still_referenced'
      USING ERRCODE = '23503',
            CONSTRAINT = 'notification_deliveries_outbox_nullsafe_fkey';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION prevent_notification_outbox_orphan() FROM PUBLIC;

CREATE TRIGGER notification_outbox_delete_guard
  AFTER DELETE ON outbox
  FOR EACH ROW
  EXECUTE FUNCTION prevent_notification_outbox_orphan();

CREATE TRIGGER notification_outbox_key_update_guard
  AFTER UPDATE OF id, shop_id ON outbox
  FOR EACH ROW
  EXECUTE FUNCTION prevent_notification_outbox_orphan();

CREATE FUNCTION prevent_notification_retry_parent_orphan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.shop_id IS NOT DISTINCT FROM OLD.shop_id THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM notification_deliveries child
     WHERE child.retry_of_delivery_id = OLD.id
       AND child.shop_id IS NOT DISTINCT FROM OLD.shop_id
  ) THEN
    RAISE EXCEPTION 'notification_delivery_retry_parent_still_referenced'
      USING ERRCODE = '23503',
            CONSTRAINT = 'notification_deliveries_retry_nullsafe_fkey';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION prevent_notification_retry_parent_orphan() FROM PUBLIC;

CREATE TRIGGER notification_retry_parent_delete_guard
  AFTER DELETE ON notification_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION prevent_notification_retry_parent_orphan();

CREATE TRIGGER notification_retry_parent_key_update_guard
  AFTER UPDATE OF id, shop_id ON notification_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION prevent_notification_retry_parent_orphan();

-- app_owner chỉ mượn membership trong lúc chuyển chủ sở hữu; service không bao giờ có thể SET ROLE
-- sang vai toàn vẹn này. CREATE schema được thu hồi ngay sau khi ALTER OWNER hoàn tất.
GRANT CREATE ON SCHEMA public TO app_notification_integrity;
ALTER FUNCTION enforce_notification_delivery_references() OWNER TO app_notification_integrity;
ALTER FUNCTION prevent_notification_outbox_orphan() OWNER TO app_notification_integrity;
ALTER FUNCTION prevent_notification_retry_parent_orphan() OWNER TO app_notification_integrity;
REVOKE app_notification_integrity FROM app_owner;
REVOKE CREATE ON SCHEMA public FROM app_notification_integrity;

-- app_rw trước đây có thể tự gán bất kỳ status nào vì quyền theo cột không diễn đạt được chuyển
-- trạng thái OLD -> NEW. Seller chỉ được đóng một lần gửi failed sau khi đã tạo outbox gửi lại
-- trong cùng tenant; trigger tự đóng dấu thời gian để ứng dụng không được bịa lịch sử.
CREATE FUNCTION guard_seller_notification_delivery_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user <> 'app_rw' THEN
    RETURN NEW;
  END IF;

  IF OLD.status <> 'failed' OR NEW.status <> 'superseded' THEN
    RAISE EXCEPTION 'notification_delivery_transition_not_allowed'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM outbox ob
     WHERE ob.shop_id IS NOT DISTINCT FROM OLD.shop_id
       AND ob.topic = OLD.topic
       AND jsonb_typeof(ob.payload -> 'retry_of_delivery_id') = 'string'
       AND ob.payload ->> 'retry_of_delivery_id' = OLD.id::text
  ) THEN
    RAISE EXCEPTION 'notification_retry_outbox_required'
      USING ERRCODE = '42501';
  END IF;

  NEW.superseded_at := now();
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION guard_seller_notification_delivery_transition() FROM PUBLIC;

CREATE TRIGGER notification_delivery_seller_transition_guard
  BEFORE UPDATE OF status ON notification_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION guard_seller_notification_delivery_transition();

REVOKE UPDATE (status, superseded_at, updated_at) ON notification_deliveries FROM app_rw;
GRANT UPDATE (status) ON notification_deliveries TO app_rw;

-- Một event notification của worker chỉ hợp lệ sau khi delivery gốc đã ở đúng trạng thái terminal,
-- cùng shop và cùng order. Giữ USING(true) ở bảng delivery vì worker cần xử lý xuyên shop; chính
-- phép nối bằng chứng này mới là hàng rào, không phải tenant context vốn không tồn tại ở poller.
DROP POLICY order_events_worker ON order_events;
CREATE POLICY order_events_worker ON order_events
  FOR INSERT TO app_worker
  WITH CHECK (
    source = 'worker'
    AND actor_type = 'system'
    AND actor_id IS NULL
    AND event_type IN ('notification.sent', 'notification.failed')
    AND jsonb_typeof(payload -> 'delivery_id') = 'string'
    AND jsonb_typeof(payload -> 'channel') = 'string'
    AND jsonb_typeof(payload -> 'topic') = 'string'
    AND EXISTS (
      SELECT 1
        FROM notification_deliveries nd
       WHERE nd.id::text = order_events.payload ->> 'delivery_id'
         AND nd.shop_id IS NOT DISTINCT FROM order_events.shop_id
         AND nd.order_id = order_events.order_id
         AND nd.channel = order_events.payload ->> 'channel'
         AND nd.topic = order_events.payload ->> 'topic'
         AND (
              (order_events.event_type = 'notification.sent' AND nd.status = 'accepted')
           OR (order_events.event_type = 'notification.failed' AND nd.status = 'failed')
         )
    )
  );
