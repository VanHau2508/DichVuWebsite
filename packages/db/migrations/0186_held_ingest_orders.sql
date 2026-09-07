-- 0186 — ĐƠN CHỜ TẠO: đơn do phần mềm ngoài đẩy vào trong lúc cửa hàng bị TẠM NGƯNG.
--
-- VÌ SAO. Đo được ngày 07/09 trên stack dev, đẩy đơn qua khoá kết nối ở ba trạng thái shop:
--
--     shops.status   storefront   POST /ingest/orders   tồn
--     active         200          201                   giữ chỗ +1
--     suspended      503          201                   giữ chỗ +1
--     terminated     404          201                   giữ chỗ +1
--
-- Tức cửa Bearer KHÔNG biết cửa hàng đã đóng. Chú thích của chính `terminateShop`
-- (apps/platform/src/server.js) liệt kê các chốt phải dừng phục vụ — storefront (0011),
-- checkout (0012), tls-authorize — rồi kết luận "serving DỪNG TỰ NHIÊN qua các chốt sẵn
-- có". Danh sách đó viết TRƯỚC khi có khoá kết nối (0120) nên cửa thứ tư không nằm trong
-- đó, và `apps/messenger` đẩy đơn qua đúng cửa ấy: bot Facebook của shop đã chấm dứt hợp
-- đồng vẫn chào hàng và vẫn chốt đơn.
--
-- QUYẾT ĐỊNH của chủ dự án (07/09), sau khi đo:
--   · `terminated` → từ chối MỌI đường /ingest/*. Hợp đồng đã hết, không có lựa chọn hai.
--   · `suspended`  → VẪN NHẬN, nhưng KHÔNG giữ chỗ tồn và phải hiện ra thành việc cần xử lý.
--
-- VÌ SAO LÀ MỘT BẢNG RIÊNG, KHÔNG PHẢI MỘT CỜ TRÊN `orders`. Đây là phần dễ làm sai nhất
-- của quyết định trên, nên chép lại lý lẽ đầy đủ:
--
--   Cả hệ thống dựa trên bất biến "một dòng orders đang sống thì ĐANG GIỮ CHỖ đúng số hàng
--   của nó". `consumeAndShip` (orders.js:670) trừ `reserved -= qty`, đường huỷ và đường sửa
--   đơn cũng vậy — tất cả đều `GREATEST(0, …)`. Một đơn KHÔNG giữ chỗ mà nằm trong `orders`
--   sẽ, lúc được gửi hay bị huỷ, NHẢ CHỖ CỦA ĐƠN KHÁC: reserved 3 → 2 trong khi ba đơn kia
--   vẫn đang chờ hàng. Kẹp `GREATEST(0, …)` không cứu được vì con số vẫn dương — nó chỉ
--   chặn số âm, không chặn việc trừ nhầm người. Hỏng theo kiểu im lặng và chỉ lộ ra khi
--   khách thứ ba tới lấy hàng.
--
--   Nên đơn nhận trong lúc tạm ngưng KHÔNG được là một dòng `orders`. Nó nằm ở đây tới khi
--   cửa hàng hoạt động lại, rồi đi qua ĐÚNG `createManualOrder` như mọi đơn khác — giá và
--   tồn được tính tại thời điểm tạo thật, chứ không phải thời điểm nhận. Đó cũng là thời
--   điểm ĐÚNG để tính: hứa giá của hai tuần trước là hứa một con số không còn thật.
--   Đường tiền vì thế vẫn chỉ có MỘT bản (§3), bảng này không tính tiền dòng nào.
--
-- `payload` CHỨA PII (tên, SĐT, địa chỉ khách) — bắt buộc, vì thiếu nó thì người bán không
-- tạo lại được đơn. Đổi lại nó phải có vòng đời như mọi PII khác: `app_expiry` xoá dòng
-- nguội theo TTL, cùng khuôn `messenger_sessions` (0123) vốn cũng giữ SĐT/địa chỉ tạm.
--
-- `reason` là TỪ VỰNG ĐÓNG dù hôm nay chỉ có một giá trị: cột lý do kiểu chuỗi tự do là
-- cách nhanh nhất để sáu tháng nữa có hai chính tả cho cùng một trạng thái (xem 0184/0185).

CREATE TABLE held_ingest_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  -- Composite FK theo đúng bất biến 0121: FK trỏ tới bảng có shop_id phải mang cả shop_id,
  -- không thì đơn chờ của shop A trỏ được sang khoá của shop B. Danh sách cột sau SET NULL
  -- là BẮT BUỘC — SET NULL trần sẽ xoá luôn shop_id của chính dòng này.
  api_key_id      uuid,
  idempotency_key text NOT NULL,
  payload         jsonb NOT NULL,
  reason          text NOT NULL CHECK (reason IN ('suspended')),
  received_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolution      text CHECK (resolution IN ('accepted', 'dropped')),
  order_id        uuid,
  -- Ba trạng thái, không có trạng thái thứ tư: đang chờ (cả ba NULL) · đã tạo đơn
  -- (accepted + order_id) · đã bỏ (dropped, không đơn). Viết thành CHECK để một bản vá
  -- quên ghi `resolved_at` không đẻ ra dòng nửa vời mà không ai thấy.
  CONSTRAINT held_ingest_orders_resolution_ck CHECK (
    (resolved_at IS NULL AND resolution IS NULL AND order_id IS NULL)
    OR (resolved_at IS NOT NULL AND resolution = 'accepted' AND order_id IS NOT NULL)
    OR (resolved_at IS NOT NULL AND resolution = 'dropped'  AND order_id IS NULL)
  ),
  -- Tích hợp gửi lại là chuyện bình thường (timeout, retry của BullMQ bên kia). Cùng một
  -- idempotency_key thì phải ra CÙNG một dòng chờ, không phải hai.
  UNIQUE (shop_id, idempotency_key),
  FOREIGN KEY (shop_id, api_key_id) REFERENCES shop_api_keys (shop_id, id)
    ON DELETE SET NULL (api_key_id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders (shop_id, id)
);

-- Hàng đợi "việc cần xử lý": chỉ đọc dòng CHƯA giải quyết, mới nhất trước.
CREATE INDEX held_ingest_orders_queue_idx
  ON held_ingest_orders (shop_id, received_at DESC) WHERE resolved_at IS NULL;
-- Quét TTL của app_expiry: điều kiện lọc CHÍNH LÀ điều kiện xoá (không có bẫy "đói quét").
CREATE INDEX held_ingest_orders_stale_idx ON held_ingest_orders (received_at);

ALTER TABLE held_ingest_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE held_ingest_orders FORCE ROW LEVEL SECURITY;

-- 0003 cấp CRUD mặc định cho MỌI bảng mới: thu hồi trước rồi mở đúng bề mặt cần.
-- app_rw ghi (cửa /ingest nhận), đọc và cập nhật (người bán chốt) — KHÔNG có DELETE:
-- xoá dấu vết một đơn khách đã đặt là thứ không đường nào của người bán được làm.
REVOKE ALL ON held_ingest_orders FROM PUBLIC, app_rw, app_expiry;
GRANT SELECT, INSERT, UPDATE ON held_ingest_orders TO app_rw;
-- app_expiry: DELETE, cộng SELECT THEO ĐÚNG HAI CỘT nó cần để TÌM dòng nguội. Không phải
-- SELECT cấp bảng — `payload` là PII và vai dọn dẹp không được nhìn thứ nó xoá (cùng học
-- thuyết GRANT theo cột của 0106).
--
-- Hai dòng này ĐẮT hơn vẻ ngoài, chép lại vì đã trả giá ngay trong lượt thi công: bản đầu
-- chỉ có DELETE, và câu quét `DELETE … WHERE ctid IN (SELECT ctid … WHERE received_at < …)`
-- cần SELECT trên `received_at` — Postgres đòi quyền đọc mọi cột xuất hiện trong WHERE, kể
-- cả WHERE của chính lệnh DELETE. Kết quả KHÔNG phải một lỗi hiện ra: sweep bắt exception,
-- ghi log rồi trả `deleted: 0`, nên nhìn từ ngoài nó "chạy bình thường" và PII nằm lại mãi.
-- Đúng lớp lỗi mà 0185 đã ghi cho `media.last_error` — lần này ở chiều đọc.
GRANT DELETE ON held_ingest_orders TO app_expiry;
GRANT SELECT (id, received_at) ON held_ingest_orders TO app_expiry;

CREATE POLICY tenant_isolation ON held_ingest_orders FOR ALL TO app_rw
  USING (shop_id = current_shop_id())
  WITH CHECK (shop_id = current_shop_id());
-- FOR ALL + WITH CHECK (false), đúng khuôn `expiry_gc` của messenger_sessions (0123): quét
-- phải ĐỌC được dòng để chọn lô rồi mới xoá, mà policy chỉ-DELETE thì câu SELECT con trả 0
-- dòng dưới FORCE RLS — không lỗi nào, chỉ là `deleted: 0` mãi mãi. WITH CHECK (false) chặn
-- mọi đường ghi: vai dọn dẹp xoá được, không sửa được.
CREATE POLICY expiry_gc ON held_ingest_orders FOR ALL TO app_expiry
  USING (true) WITH CHECK (false);

COMMENT ON TABLE held_ingest_orders IS
  'Đơn phần mềm ngoài đẩy vào lúc shop bị tạm ngưng: giữ nguyên payload, KHÔNG giữ chỗ tồn, '
  'không phải một dòng orders. Người bán chốt lại khi cửa hàng chạy lại (0186).';
