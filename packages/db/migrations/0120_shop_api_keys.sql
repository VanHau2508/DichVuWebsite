-- 0120: KHOÁ KẾT NỐI của shop — để phần mềm ngoài đẩy đơn vào nền tảng.
--
-- Bối cảnh: shop Việt chốt đơn trong chat Facebook/Zalo, thường qua phần mềm chat
-- (Pancake, Botcake, Vpage…) hoặc n8n/Zapier. Đơn nằm ở đó, website không biết gì.
-- Khoá này là cái cầu: shop tự sinh khoá trong admin, dán vào phần mềm kia, phần
-- mềm POST đơn sang → đơn vào đúng shop, đúng kho, đúng sổ tiền, có nguồn (0119).
-- Chặng 2 (bot Messenger của chính nền tảng) dùng LẠI đúng đường này.
--
-- KHÔNG lưu token thô — chỉ sha256, giống sessions (0005) và sepay (0035). Token
-- hiện ĐÚNG MỘT LẦN lúc tạo. Mất thì thu hồi và tạo cái mới, không có đường xem lại:
-- một khoá đọc-lại-được là một khoá rò theo mọi ảnh chụp màn hình hỗ trợ khách.
--
-- token_prefix: 8 ký tự đầu, để trong danh sách phân biệt "khoá Pancake" với "khoá
-- n8n" mà không cần lộ gì. Đủ ngắn để KHÔNG rút ngắn không gian dò (token 256 bit).
--
-- revoked_at chứ không DELETE: thu hồi rồi vẫn phải trả lời được "khoá nào đã tạo
-- đơn #1234". Xoá dòng là mất dấu vết đúng lúc cần nó nhất (khi nghi khoá bị lộ).
CREATE TABLE shop_api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,     -- sha256(token) hex; KHÔNG lưu token thô
  token_prefix text NOT NULL,            -- 8 ký tự đầu, chỉ để nhận diện trong danh sách
  -- Một scope duy nhất ở v1. Có cột từ đầu để thêm quyền sau (vd 'products.read' cho
  -- đồng bộ tồn kho) mà không phải sửa mọi chỗ đọc — nhưng CHECK vẫn khoá tập giá trị.
  scope        text NOT NULL DEFAULT 'orders.ingest' CHECK (scope IN ('orders.ingest')),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX shop_api_keys_shop_idx ON shop_api_keys (shop_id, created_at DESC);

-- Đơn vào bằng khoá nào (NULL = đơn người thật gõ / khách tự đặt). Dùng để dò khi một
-- tích hợp đẩy sai, và để trả lời "khoá này còn ai dùng không" trước khi thu hồi.
ALTER TABLE orders ADD COLUMN api_key_id uuid REFERENCES shop_api_keys(id) ON DELETE SET NULL;

ALTER TABLE shop_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_api_keys FORCE  ROW LEVEL SECURITY;

-- ── Đường 1: shop tự quản khoá của mình (RLS tenant như mọi bảng khác) ────────
CREATE POLICY tenant_isolation ON shop_api_keys FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT SELECT, INSERT, UPDATE ON shop_api_keys TO app_rw;

-- ── Đường 2: resolve token → shop, TRƯỚC khi biết shop nào ───────────────────
-- Bài toán: request mang token, chưa biết thuộc shop nào, mà RLS lại lọc theo shop.
-- KHÔNG mở `USING (true)` cho app_rw — app_rw là vai to nhất, một endpoint tương lai
-- quên WHERE shop_id là lộ metadata khoá của MỌI shop.
-- Cách làm theo đúng lối 0083 (current_claim_token_hash): cổng bằng GUC. Service đặt
-- app.api_token_hash = sha256(token trình ra), policy chỉ mở ĐÚNG dòng khớp hash đó.
-- Không có token thì GUC rỗng → không dòng nào hiện (NULL = NULL không phải TRUE).
-- Cũng KHÔNG cần vai DB mới: cầm được token nghĩa là được phép hành động thay shop đó.
CREATE OR REPLACE FUNCTION current_api_token_hash() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.api_token_hash', true), '') $$;

CREATE POLICY resolve_by_token ON shop_api_keys FOR SELECT TO app_rw
  USING (token_hash = current_api_token_hash());

-- Đóng dấu "lần dùng cuối" cũng phải đi qua cùng cái cổng đó (lúc này app.shop_id
-- chưa đặt) — nếu không, ghi last_used_at sẽ bị chính RLS chặn.
CREATE POLICY touch_by_token ON shop_api_keys FOR UPDATE TO app_rw
  USING (token_hash = current_api_token_hash())
  WITH CHECK (token_hash = current_api_token_hash());
