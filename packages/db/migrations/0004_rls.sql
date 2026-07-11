-- 0004 — Row-Level Security.
--
-- Lớp phòng thủ THỨ HAI. Lớp thứ nhất là `withTenant()` trong ứng dụng, lớp thứ
-- ba là composite foreign key ở 0002. Không tin vào một lớp nào cả: lỗi quên
-- `WHERE shop_id = ?` là điều SẼ xảy ra, không phải có thể xảy ra.

-- Đọc tenant context của transaction hiện tại.
--
--   NULLIF(..., '')  — chuỗi rỗng ép kiểu uuid sẽ ném lỗi; biến nó thành NULL.
--   missing_ok=true  — chưa set thì trả NULL, không ném lỗi.
--
-- NULL làm mọi so sánh `shop_id = NULL` cho ra NULL → không dòng nào lọt.
-- Đó là hành vi fail-closed mong muốn: truy vấn quên đặt context trả về RỖNG,
-- chứ không trả về toàn bộ dữ liệu của mọi khách hàng.
CREATE OR REPLACE FUNCTION current_shop_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.shop_id', true), '')::uuid $$;

-- ── Mọi bảng có cột shop_id ──────────────────────────────────────────────────
-- Sinh policy bằng vòng lặp, không liệt kê tay. Bảng thêm về sau mà quên policy
-- sẽ bị `schema-invariants.test.js` bắt được, nhưng tốt nhất là đừng để quên.
DO $do$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = 'public'
          AND col.table_name   = c.relname
          AND col.column_name  = 'shop_id'
      )
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    -- FORCE là bắt buộc: thiếu nó, chủ sở hữu bảng vẫn nhìn thấy tất cả.
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);

    -- USING      lọc SELECT / UPDATE / DELETE.
    -- WITH CHECK chặn INSERT / UPDATE ghi sang shop khác.
    --
    -- Với policy FOR ALL, bỏ WITH CHECK thì Postgres dùng lại biểu thức USING —
    -- nên nó KHÔNG phải lỗ hổng (đã kiểm chứng bằng mutation testing). Ta vẫn
    -- viết ra tường minh: nếu sau này ai đó tách policy này thành FOR SELECT +
    -- FOR INSERT riêng, sự tường minh là thứ cứu họ.
    --
    -- Lỗ hổng ghi chéo tenant THẬT SỰ nằm ở chỗ khác: một policy PERMISSIVE thứ
    -- hai trên cùng bảng (ví dụ `FOR INSERT WITH CHECK (true)`) được OR với
    -- policy này và vô hiệu hoá nó hoàn toàn. `schema-invariants.test.js` khẳng
    -- định mỗi bảng tenant có ĐÚNG MỘT policy cho app_rw, chính vì lý do đó.
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I FOR ALL TO app_rw '
      'USING (shop_id = current_shop_id()) '
      'WITH CHECK (shop_id = current_shop_id())', t);
  END LOOP;
END
$do$;

-- ── shops: chính nó LÀ tenant, khoá theo id chứ không phải shop_id ───────────
ALTER TABLE shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE shops FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON shops FOR ALL TO app_rw
  USING      (id = current_shop_id())
  WITH CHECK (id = current_shop_id());

-- ── app_tls: tra cứu domain để cấp chứng chỉ, không có tenant context ────────
-- Nó không thể có context: lúc handshake TLS, ta CHƯA biết shop nào.
-- Bù lại quyền của nó hẹp đến mức vô hại: SELECT trên đúng hai bảng, và hai
-- bảng đó không chứa dữ liệu người mua.
CREATE POLICY tls_lookup ON shops   FOR SELECT TO app_tls USING (true);
CREATE POLICY tls_lookup ON domains FOR SELECT TO app_tls USING (true);

-- TODO(trước khi mở /ops): platform admin cần role riêng `app_platform` với
-- policy riêng và audit bắt buộc. Hiện app_rw không tạo được shop mới — đúng ý:
-- tạo shop là thao tác cấp nền tảng, không phải thao tác của nhà bán hàng.
