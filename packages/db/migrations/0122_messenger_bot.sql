-- 0122: BOT MESSENGER — cấu hình Trang Facebook per-shop + trạng thái hội thoại.
--
-- Chặng 2 của docs/47. Đã kiểm tận tài khoản thật: Meta Business Agent (agent chat với
-- khách + custom connector gọi API ngoài) CHƯA mở cho Messenger — nhánh connector hiện chỉ
-- có ở WhatsApp/WABA. Nên muốn khách chốt đơn ngay trong chat thì bot phải là của mình.
--
-- ── NGUYÊN TẮC KIẾN TRÚC (đọc trước khi sửa) ────────────────────────────────
-- Service apps/messenger KHÔNG chạm thẳng vào đơn/kho/giá. Vai app_messenger dưới đây chỉ
-- có quyền trên ĐÚNG HAI bảng của riêng nó. Muốn tạo đơn thì gọi HTTP /ingest/orders (0120)
-- bằng khoá kết nối của shop — cùng validate, cùng khoá tồn, cùng idempotency.
-- Lý do: đường tiền không được có bản sao thứ hai. Bản sao sẽ trôi lệch, và chỗ trôi lệch
-- luôn là giá/tồn — thứ không ai phát hiện cho tới lúc giao nhầm hoặc bán âm kho.
CREATE TABLE shop_messenger_config (
  shop_id           uuid PRIMARY KEY REFERENCES shops (id) ON DELETE CASCADE,
  -- page_id là ĐƯỜNG VÀO: webhook của Meta chỉ mang Page ID, từ đó mới ra shop. UNIQUE vì
  -- một Trang chỉ thuộc một shop — thiếu ràng buộc này thì hai shop cùng khai một Trang và
  -- đơn chạy về nhầm nơi, âm thầm.
  page_id           text NOT NULL UNIQUE,
  page_name         text,
  page_token_enc    text NOT NULL,        -- AES-256-GCM "iv.tag.ct" (secretbox), như 0044
  -- Meta gọi GET webhook kèm hub.verify_token lúc đăng ký. Chỉ lưu sha256: nó là bí mật,
  -- và ta chỉ cần SO SÁNH chứ không cần đọc lại.
  verify_token_hash text NOT NULL,
  -- Khoá kết nối (0120) mà bot dùng để gọi /ingest/orders.
  --
  -- LƯU Ý CÓ CHỦ Ý: ở đây token được lưu dạng GIẢI MÃ ĐƯỢC, khác với quy tắc "chỉ lưu hash"
  -- của 0120. Không mâu thuẫn — quy tắc đó nói về khoá GIAO CHO NGƯỜI: khoá người cầm mà
  -- đọc lại được là khoá rò theo mọi ảnh chụp màn hình. Khoá này do nền tảng tự sinh cho
  -- cầu nối của chính nền tảng, KHÔNG BAO GIỜ hiện cho ai, và bot buộc phải có bản thô để
  -- gửi header Authorization. Cùng cách xử lý với token hãng vận chuyển (0044).
  api_key_id        uuid,
  api_token_enc     text NOT NULL,
  enabled           boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- FK composite BẮT BUỘC (bất biến schema, đã vấp ở 0120/0121): FK một cột tới bảng có
  -- tenant cho phép shop A trỏ sang khoá shop B.
  FOREIGN KEY (shop_id, api_key_id) REFERENCES shop_api_keys (shop_id, id) ON DELETE SET NULL (api_key_id)
);

-- Trạng thái hội thoại theo từng người chat (PSID). Bot là máy trạng thái, không LLM:
-- state giữ bước hiện tại + giỏ + thông tin đã hỏi.
--
-- `last_customer` là thứ làm khách MUA LẦN HAI chỉ còn 2 chạm, không gõ gì (nhớ tên/SĐT/
-- địa chỉ lần trước). Đổi lại nó là PII → worker dọn phiên nguội, xem 0064 cho tinh thần.
CREATE TABLE messenger_sessions (
  shop_id       uuid NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  psid          text NOT NULL,
  state         jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_customer jsonb,
  -- Khách bấm "Gặp nhân viên" → bot IM tới thời điểm này, tin nhắn rơi về Hộp thư như
  -- bình thường. Không có lối thoát này thì bot thành cái bẫy, và đó là cách nhanh nhất
  -- mất khách khó tính.
  handoff_until timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, psid)
);
CREATE INDEX messenger_sessions_stale_idx ON messenger_sessions (updated_at);

ALTER TABLE shop_messenger_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_messenger_config FORCE  ROW LEVEL SECURITY;
ALTER TABLE messenger_sessions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE messenger_sessions    FORCE  ROW LEVEL SECURITY;

-- ── app_rw: chủ shop tự kết nối/ngắt Trang trong seller-admin ────────────────
CREATE POLICY tenant_isolation ON shop_messenger_config FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON shop_messenger_config TO app_rw;

-- Bảng có shop_id thì PHẢI có policy cho app_rw (bất biến schema), kể cả khi seller-admin
-- v1 chưa đọc: shop xoá kết nối là phải dọn được phiên kèm theo.
CREATE POLICY tenant_isolation ON messenger_sessions FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT SELECT, DELETE ON messenger_sessions TO app_rw;

-- ── Vai app_messenger (least-priv, mirror app_payment 0035) ──────────────────
CREATE ROLE app_messenger LOGIN PASSWORD 'devpassword'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE app TO app_messenger;
GRANT USAGE   ON SCHEMA public TO app_messenger;
ALTER ROLE app_messenger SET statement_timeout = '15s';
ALTER ROLE app_messenger SET lock_timeout = '5s';
ALTER ROLE app_messenger SET idle_in_transaction_session_timeout = '60s';

-- Resolve Page → shop XUYÊN SHOP: webhook tới chỉ có Page ID, chưa biết shop nào. Đây đúng
-- bài toán app_payment đã giải với sepay_token_hash (0035) — dùng lại y cách đó thay vì đẻ
-- lối thứ ba: cột-level GRANT hẹp + policy đọc mở. Vai này KHÔNG có quyền gì trên orders,
-- order_lines, inventory hay products, nên "mở" ở đây chỉ mở đúng bảng cấu hình của nó.
GRANT SELECT (shop_id, page_id, page_token_enc, verify_token_hash, api_token_enc, enabled)
  ON shop_messenger_config TO app_messenger;
CREATE POLICY messenger_cfg_read ON shop_messenger_config FOR SELECT TO app_messenger USING (true);

-- Phiên hội thoại: đọc/ghi TRONG context shop (đặt app.shop_id sau khi resolve Page).
GRANT SELECT, INSERT, UPDATE, DELETE ON messenger_sessions TO app_messenger;
CREATE POLICY messenger_sessions_rw ON messenger_sessions FOR ALL TO app_messenger
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- Đánh dấu khoá do HỆ THỐNG sinh (cầu nối bot), phân biệt với khoá chủ shop tự tạo:
-- trang Kết nối không được mời "xem lại"/"thu hồi" nhầm khoá của bot như khoá thường.
ALTER TABLE shop_api_keys ADD COLUMN system_owned boolean NOT NULL DEFAULT false;
