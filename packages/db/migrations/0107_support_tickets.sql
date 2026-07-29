-- 0107 — Kênh YÊU CẦU HỖ TRỢ từ trong seller-admin.
--
-- VÌ SAO. Từ khi có self-serve signup (docs/43), một người có thể mở shop lúc 2 giờ sáng mà
-- không qua concierge nào. Nếu họ gặp trục trặc thì hiện tại KHÔNG có đường nào liên hệ từ
-- trong sản phẩm — họ chỉ có thể bỏ đi. Đó là lỗ vận hành, không phải thiếu tính năng.
--
-- Vì sao LƯU DB chứ không chỉ gửi thẳng Telegram/email: gửi-rồi-quên nghĩa là chủ nền tảng
-- không có hàng đợi, không biết cái nào đã xử, và người bán không thấy yêu cầu của mình đã
-- tới nơi. Một dòng trong DB giải quyết cả ba.

CREATE TABLE support_tickets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops (id),
  user_id     uuid REFERENCES users (id),          -- ai gửi (NULL nếu user bị xoá sau này)
  subject     text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  -- Trang người bán đang đứng lúc bấm gửi. Rất rẻ để ghi, và tiết kiệm đúng vòng hỏi-đáp
  -- "anh đang ở màn hình nào" vốn làm hỏng ấn tượng hỗ trợ đầu tiên.
  context_url text,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users (id),

  UNIQUE (shop_id, id)
);
CREATE INDEX support_tickets_open_idx ON support_tickets (created_at DESC) WHERE status = 'open';
CREATE INDEX support_tickets_shop_idx ON support_tickets (shop_id, created_at DESC);

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets FORCE ROW LEVEL SECURITY;

-- Người bán: chỉ thấy phiếu CỦA SHOP MÌNH (quy ước tenant_isolation của toàn hệ).
CREATE POLICY tenant_isolation ON support_tickets FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- Chủ nền tảng: thấy XUYÊN shop để còn xử lý — cùng khuôn platform_all của 0006.
CREATE POLICY platform_all ON support_tickets FOR ALL TO app_platform
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON support_tickets TO app_rw;
GRANT SELECT, UPDATE ON support_tickets TO app_platform;

COMMENT ON TABLE support_tickets IS
  'Yêu cầu hỗ trợ người bán gửi từ seller-admin. Người bán chỉ thấy của shop mình; chủ nền tảng thấy tất.';
