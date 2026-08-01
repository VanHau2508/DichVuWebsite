-- 0121: vá HAI bất biến schema mà 0120 phá. Cả hai do test bất biến bắt, không phải
-- do đọc lại code — ghi ra đây để lần sau thêm bảng tenant thì nhớ từ đầu.
--
-- ① "không LỆNH nào của bảng tenant bị ≥2 policy PERMISSIVE app_rw phủ".
--    0120 đặt tenant_isolation (FOR ALL) + resolve_by_token (SELECT) + touch_by_token
--    (UPDATE). Ba cái đó OR với nhau trên SELECT và UPDATE. Repo cấm đúng hình dạng này,
--    và cấm có lý: khi quy tắc nằm rải ở nhiều policy, người đọc MỘT policy tưởng mình
--    đã hiểu cả quy tắc — trong khi cái quyết định lại là phép hợp. Gộp về MỘT policy,
--    phép OR viết tường minh ngay trong USING để nhìn là thấy đủ.
--
-- ② "mọi FK trỏ tới bảng có shop_id đều phải bao gồm cột shop_id".
--    orders.api_key_id → shop_api_keys(id) là FK một cột tới bảng có tenant, tức là về
--    lý thuyết đơn của shop A trỏ được sang khoá của shop B. Chuyển sang composite
--    (shop_id, api_key_id) → DB tự chặn, không dựa vào code nhớ kiểm.

-- ── ① gộp policy ─────────────────────────────────────────────────────────────
DROP POLICY tenant_isolation  ON shop_api_keys;
DROP POLICY resolve_by_token  ON shop_api_keys;
DROP POLICY touch_by_token    ON shop_api_keys;

-- USING có HAI ngả, và chỉ hai:
--   · shop_id = current_shop_id()          — chủ shop tự quản khoá của mình
--   · token_hash = current_api_token_hash() — tra token khi CHƯA biết shop là ai
-- WITH CHECK CHỈ có ngả tenant: ngả token dùng để ĐỌC ra shop, không phải để ghi.
-- Vì thế `resolveApiKey` đặt app.shop_id ngay sau khi tra xong rồi mới đóng dấu
-- last_used_at — lúc đó nó đã là một UPDATE tenant bình thường.
CREATE POLICY tenant_isolation ON shop_api_keys FOR ALL TO app_rw
  USING (shop_id = current_shop_id() OR token_hash = current_api_token_hash())
  WITH CHECK (shop_id = current_shop_id());

-- ── ② composite FK ───────────────────────────────────────────────────────────
ALTER TABLE shop_api_keys ADD CONSTRAINT shop_api_keys_shop_id_id_key UNIQUE (shop_id, id);

ALTER TABLE orders DROP CONSTRAINT orders_api_key_id_fkey;
-- Danh sách cột sau SET NULL là BẮT BUỘC, không phải cho gọn: SET NULL trần trên FK
-- composite gán NULL cho MỌI cột tham chiếu — tức là xoá một khoá sẽ thổi bay luôn
-- orders.shop_id. Ghi rõ (api_key_id) để chỉ cột đó bị xoá. (Postgres ≥15.)
ALTER TABLE orders ADD CONSTRAINT orders_api_key_fkey
  FOREIGN KEY (shop_id, api_key_id) REFERENCES shop_api_keys (shop_id, id)
  ON DELETE SET NULL (api_key_id);
