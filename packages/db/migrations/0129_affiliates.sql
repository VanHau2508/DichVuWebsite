-- 0129 — CỘNG TÁC VIÊN (CTV/affiliate): mã giới thiệu + hoa hồng + phiếu chi (docs/51).
--
-- CHỐT LỚN: hoa hồng theo ĐƠN GIAO THÀNH CÔNG (đã giao + hết hạn đổi trả), KHÔNG theo đơn
-- đã thanh toán — đúng cách Shopee/TikTok Shop làm. Trả theo "đã thanh toán" thì đơn bị
-- hoàn trong hạn đổi trả buộc đi ĐÒI LẠI tiền đã đưa CTV.
--
-- Bốn trạng thái: pending (tạm tính) → eligible (đủ điều kiện) → paid (đã nằm trong phiếu
-- chi); huỷ/hoàn trước khi đủ điều kiện → void. Worker sweep lo pending→eligible/void.

CREATE TABLE affiliates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops (id),
  code        text NOT NULL,                       -- mã giới thiệu; so khớp KHÔNG phân biệt hoa/thường
  name        text NOT NULL,
  phone       text,                                -- dùng chặn CTV tự mua qua mã của mình
  email       text,
  -- Mức riêng của CTV này; NULL cả hai = dùng mức chung của shop.
  rate_kind   text CHECK (rate_kind IN ('percent','fixed')),
  rate_value  bigint CHECK (rate_value > 0),
  active      boolean NOT NULL DEFAULT true,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  -- percent phải 1..100; fixed là VND. Ràng ở DB vì đây là con số nhân ra tiền thật.
  CHECK (rate_kind IS NULL OR rate_value IS NOT NULL),
  CHECK (rate_kind <> 'percent' OR rate_value BETWEEN 1 AND 100)
);
CREATE UNIQUE INDEX affiliates_shop_code_idx ON affiliates (shop_id, upper(code));
ALTER TABLE affiliates ENABLE ROW LEVEL SECURITY;
ALTER TABLE affiliates FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON affiliates FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON affiliates TO app_rw;

-- Cấu hình chương trình CTV của shop (singleton per-shop, giống shop_loyalty_config).
CREATE TABLE shop_affiliate_config (
  shop_id            uuid PRIMARY KEY REFERENCES shops (id),
  enabled            boolean NOT NULL DEFAULT false,
  -- Mức chung, dùng khi CTV không có mức riêng.
  rate_kind          text NOT NULL DEFAULT 'percent' CHECK (rate_kind IN ('percent','fixed')),
  rate_value         bigint NOT NULL DEFAULT 5 CHECK (rate_value > 0),
  -- Hạn đổi trả: giao xong bao nhiêu ngày thì hoa hồng chốt. 0 = chốt ngay khi giao.
  hold_days          int NOT NULL DEFAULT 7 CHECK (hold_days BETWEEN 0 AND 90),
  -- Cookie last-click sống bao lâu (ngày) — Shopee dùng 30.
  cookie_days        int NOT NULL DEFAULT 30 CHECK (cookie_days BETWEEN 1 AND 90),
  -- Chặn CTV tự mua qua mã của mình (khớp SĐT). Tắt được vì vài shop CỐ Ý cho phép.
  block_self_referral boolean NOT NULL DEFAULT true,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (rate_kind <> 'percent' OR rate_value BETWEEN 1 AND 100)
);
ALTER TABLE shop_affiliate_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_affiliate_config FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shop_affiliate_config FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT SELECT, INSERT, UPDATE ON shop_affiliate_config TO app_rw;

-- PHIẾU CHI CTV — chứng từ tài chính, APPEND-ONLY (cùng lối refunds/cod_remittances 0079):
-- REVOKE UPDATE/DELETE. Sửa được phiếu đã chi = sổ chi nói dối.
CREATE TABLE affiliate_payouts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL REFERENCES shops (id),
  affiliate_id uuid NOT NULL,
  amount_vnd   bigint NOT NULL CHECK (amount_vnd > 0),
  item_count   int    NOT NULL CHECK (item_count > 0),
  paid_at      date   NOT NULL DEFAULT current_date,
  method       text,                                -- 'bank'|'cash'|... (shop tự ghi)
  note         text,
  created_by   uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, affiliate_id) REFERENCES affiliates (shop_id, id)
);
CREATE INDEX affiliate_payouts_shop_idx ON affiliate_payouts (shop_id, paid_at DESC);
ALTER TABLE affiliate_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE affiliate_payouts FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON affiliate_payouts FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
REVOKE UPDATE, DELETE ON affiliate_payouts FROM app_rw;
GRANT SELECT, INSERT ON affiliate_payouts TO app_rw;

-- HOA HỒNG per-đơn. KHÔNG append-only (có vòng đời trạng thái) nhưng số tiền là SNAPSHOT.
CREATE TABLE affiliate_commissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       uuid NOT NULL REFERENCES shops (id),
  affiliate_id  uuid NOT NULL,
  order_id      uuid NOT NULL,
  -- SNAPSHOT mức + căn cứ lúc đặt đơn (như order_lines.unit_cost_vnd của giá vốn 0081):
  -- shop đổi mức hoa hồng sau đó KHÔNG được làm đổi tiền của đơn cũ.
  rate_kind     text   NOT NULL CHECK (rate_kind IN ('percent','fixed')),
  rate_value    bigint NOT NULL CHECK (rate_value > 0),
  base_vnd      bigint NOT NULL CHECK (base_vnd >= 0),   -- subtotal − discount (KHÔNG gồm ship)
  amount_vnd    bigint NOT NULL CHECK (amount_vnd >= 0),
  status        text   NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','eligible','void','paid')),
  eligible_at   timestamptz,
  void_reason   text,
  payout_id     uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- MỘT đơn MỘT dòng hoa hồng: chặn cả double-credit lẫn hai CTV tranh một đơn.
  UNIQUE (shop_id, order_id),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, affiliate_id) REFERENCES affiliates (shop_id, id),
  FOREIGN KEY (shop_id, order_id)     REFERENCES orders (shop_id, id) ON DELETE CASCADE,
  -- Phiếu chi bị xoá là chuyện KHÔNG xảy ra (append-only), nhưng cột phải trỏ đúng shop.
  FOREIGN KEY (shop_id, payout_id)    REFERENCES affiliate_payouts (shop_id, id),
  -- 'paid' BẮT BUỘC có phiếu chi; các trạng thái khác thì KHÔNG được có.
  CHECK ((status = 'paid') = (payout_id IS NOT NULL))
);
-- Sweep quét theo (shop, status) — lọc còn-việc nằm TRONG index để shop ngoài lô không bị
-- đói (bài học "đói quét": LIMIT không kèm lọc còn-việc = shop cuối hàng không bao giờ tới).
CREATE INDEX affiliate_commissions_pending_idx ON affiliate_commissions (shop_id, status)
  WHERE status = 'pending';
CREATE INDEX affiliate_commissions_aff_idx ON affiliate_commissions (shop_id, affiliate_id, status);
ALTER TABLE affiliate_commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE affiliate_commissions FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON affiliate_commissions FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT SELECT, INSERT, UPDATE ON affiliate_commissions TO app_rw;

-- Vai storefront/checkout: checkout PHẢI tra được mã CTV để gắn vào đơn, và ghi hoa hồng.
-- CHỈ cấp đúng thế — không cho đọc phiếu chi (số tiền shop trả CTV không liên quan checkout).
GRANT SELECT ON affiliates, shop_affiliate_config TO app_checkout;
GRANT SELECT, INSERT ON affiliate_commissions TO app_checkout;
CREATE POLICY tenant_isolation_checkout ON affiliates FOR SELECT TO app_checkout
  USING (shop_id = current_shop_id());
CREATE POLICY tenant_isolation_checkout ON shop_affiliate_config FOR SELECT TO app_checkout
  USING (shop_id = current_shop_id());
CREATE POLICY tenant_isolation_checkout ON affiliate_commissions FOR ALL TO app_checkout
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
