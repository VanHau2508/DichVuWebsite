-- 0044 — Tích hợp HÃNG VẬN CHUYỂN (GHN/GHTK) per-shop.
--
-- Mô hình: mỗi shop kết nối TÀI KHOẢN VẬN CHUYỂN CỦA CHÍNH HỌ (token API do shop cấp,
-- như SePay per-shop). Token phải GỌI ĐƯỢC API hãng → lưu MÃ HOÁ AES-256-GCM
-- (SHIPPING_ENC_KEY, khoá nằm ngoài DB — khác SePay chỉ cần sha256 verify).
-- Tạo vận đơn từ admin → hãng trả mã vận đơn + phí; worker poll trạng thái → delivered.

-- ── Cấu hình kết nối per-shop ─────────────────────────────────────────────────
CREATE TABLE shop_shipping_config (
  shop_id     uuid PRIMARY KEY REFERENCES shops (id),
  provider    text NOT NULL CHECK (provider IN ('ghn', 'ghtk')),
  token_enc   text NOT NULL,                  -- AES-256-GCM "iv.tag.ct" (secretbox)
  token_prefix text,                          -- 6 ký tự đầu token (nhận diện, KHÔNG bí mật)
  ghn_shop_id text,                           -- GHN cần ShopId nội bộ của họ
  pickup      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {name, phone, address, province, district, ward?}
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE shop_shipping_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_shipping_config FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shop_shipping_config FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON shop_shipping_config TO app_rw;

-- ── Mở rộng shipments: vận đơn tạo qua hãng ──────────────────────────────────
ALTER TABLE shipments ADD COLUMN provider        text;         -- 'ghn'|'ghtk' (NULL = nhập tay)
ALTER TABLE shipments ADD COLUMN carrier_fee_vnd bigint;       -- phí hãng báo khi tạo vận đơn
ALTER TABLE shipments ADD COLUMN provider_status text;         -- trạng thái thô từ hãng (hiển thị)
ALTER TABLE shipments ADD COLUMN synced_at       timestamptz;  -- lần poll trạng thái gần nhất
-- Nới CHECK status: thêm 'returned' (hoàn hàng) + 'cancelled' (huỷ trên hãng).
ALTER TABLE shipments DROP CONSTRAINT shipments_status_check;
ALTER TABLE shipments ADD CONSTRAINT shipments_status_check
  CHECK (status IN ('created', 'in_transit', 'delivered', 'returned', 'cancelled'));
-- Worker poll: tìm nhanh vận đơn hãng còn đang chạy.
CREATE INDEX shipments_tracking_idx ON shipments (status)
  WHERE provider IS NOT NULL AND status IN ('created', 'in_transit');

-- ── Quyền cho worker (app_expiry — role tự động hoá vòng đời đơn) ─────────────
-- Poll tracking: đọc vận đơn + config (giải mã token bằng khoá env), đặt delivered,
-- ghi outbox để khách nhận email. Cũng phục vụ Bước 2 (email khi đơn tự huỷ).
GRANT SELECT (id, shop_id, order_id, provider, tracking_number, status) ON shipments TO app_expiry;
GRANT UPDATE (status, provider_status, synced_at)                       ON shipments TO app_expiry;
CREATE POLICY expiry_shipments ON shipments FOR ALL TO app_expiry USING (true) WITH CHECK (true);

GRANT SELECT (shop_id, provider, token_enc, ghn_shop_id, enabled) ON shop_shipping_config TO app_expiry;
CREATE POLICY expiry_shipcfg ON shop_shipping_config FOR SELECT TO app_expiry USING (true);

-- Đơn: thêm cột email/tên/số đơn/tổng để build payload outbox; delivered_at để chốt mốc.
GRANT SELECT (order_number, total_vnd, customer_email, customer_name) ON orders TO app_expiry;
GRANT UPDATE (delivered_at) ON orders TO app_expiry;

-- Outbox: worker ghi sự kiện xuyên shop (shop_id đặt tường minh từng dòng).
GRANT INSERT ON outbox TO app_expiry;
GRANT USAGE ON SEQUENCE outbox_id_seq TO app_expiry;
CREATE POLICY expiry_outbox ON outbox FOR INSERT TO app_expiry WITH CHECK (true);
