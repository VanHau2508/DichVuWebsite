-- 0086 — ĐIỂM THƯỞNG KHÁCH HÀNG v1: sổ cái điểm append-only + cache số dư + cấu hình.
--
-- MÔ HÌNH (căn theo GRAIN của repo: app-level in-tx + worker sweep + ledger append-only +
-- RLS 2 trục + idempotency UNIQUE — KHÔNG trigger, KHÔNG SECURITY DEFINER, giống
-- inventory_ledger/refunds/customer-accounts):
--   • loyalty_ledger  = JOURNAL append-only, chân lý mọi chuyển động điểm CÓ DẤU (earn +,
--     redeem −, reversal +, clawback −, adjust ±). REVOKE UPDATE,DELETE.
--   • loyalty_balances = CACHE số dư/khách. balance ÂM = NỢ điểm (clawback vượt số dư →
--     earn tương lai bù trước; hiển thị GREATEST(0,·)). Cập nhật CÙNG tx với ledger.
--   • shop_loyalty_config = cấu hình 1-dòng/shop.
-- BẤT BIẾN: balance == Σ(ledger.delta); không double-earn/redeem/reversal/clawback
--   (UNIQUE partial theo kind, per-order); redeem đòi balance ≥ điểm (không tiêu vào nợ).
--
-- ĐƯỜNG GHI (least-priv, nhiều-writer như inventory_ledger 0009):
--   • TÍCH điểm  = worker app_loyalty (cross-shop sweep, VESTING = chỉ tích đơn paid ≥ N ngày
--     → đơn hoàn trong cửa sổ KHÔNG bao giờ tích → clawback hiếm). Choke point = sweep, không
--     phụ thuộc 5-đường-paid/outbox-gate-email.
--   • ĐỔI điểm   = app_checkout in-tx tại createOrderTx (đồng bộ, khách cần giảm giá ngay).
--   • THU HỒI    = worker app_loyalty sweep (clawback đơn terminal đã tích + reversal đơn
--     terminal đã đổi — độc lập paid_at nên bắt cả đơn CHƯA-trả bị huỷ mà đã đổi điểm).
-- HẾT HẠN theo lô + FIFO = CẮT sang v2 (đó là thứ ép mô hình lô + SECURITY DEFINER phức tạp).

-- ── Role worker app_loyalty (cross-shop sweep) — mirror app_expiry 0022 ────────
CREATE ROLE app_loyalty LOGIN PASSWORD 'devpassword'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE app TO app_loyalty;
GRANT USAGE   ON SCHEMA public TO app_loyalty;
ALTER ROLE app_loyalty SET statement_timeout = '20s';
ALTER ROLE app_loyalty SET lock_timeout = '8s';
ALTER ROLE app_loyalty SET idle_in_transaction_session_timeout = '60s';

-- ── (1) Cấu hình điểm thưởng / shop ───────────────────────────────────────────
CREATE TABLE shop_loyalty_config (
  shop_id                 uuid PRIMARY KEY REFERENCES shops (id),
  enabled                 boolean NOT NULL DEFAULT false,
  earn_points_per_1000 int   NOT NULL DEFAULT 1   CHECK (earn_points_per_1000 > 0 AND earn_points_per_1000 <= 1000),
  redeem_vnd_per_point    int    NOT NULL DEFAULT 100 CHECK (redeem_vnd_per_point > 0 AND redeem_vnd_per_point <= 1000000),
  earn_vesting_days       int    NOT NULL DEFAULT 7   CHECK (earn_vesting_days >= 0 AND earn_vesting_days <= 365), -- điểm cộng SAU N ngày (cửa sổ hoàn/huỷ)
  min_redeem_points       int    NOT NULL DEFAULT 0   CHECK (min_redeem_points >= 0),
  max_redeem_pct          int    NOT NULL DEFAULT 50  CHECK (max_redeem_pct BETWEEN 1 AND 100), -- điểm giảm tối đa % tiền HÀNG/đơn
  updated_at              timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE shop_loyalty_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_loyalty_config FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shop_loyalty_config FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
GRANT SELECT, INSERT, UPDATE ON shop_loyalty_config TO app_rw;
-- checkout đọc để tính đổi-tối-đa; worker đọc để tính tích/vesting.
CREATE POLICY loyalty_cfg_checkout ON shop_loyalty_config FOR SELECT TO app_checkout USING (shop_id = current_shop_id());
GRANT SELECT ON shop_loyalty_config TO app_checkout;
CREATE POLICY loyalty_cfg_worker ON shop_loyalty_config FOR SELECT TO app_loyalty USING (true);
GRANT SELECT ON shop_loyalty_config TO app_loyalty;

-- ── (2) Cache số dư điểm / khách ──────────────────────────────────────────────
CREATE TABLE loyalty_balances (
  shop_id       uuid NOT NULL,
  customer_id   uuid NOT NULL,
  balance_points int NOT NULL DEFAULT 0,   -- CÓ THỂ ÂM = nợ (earn tương lai bù); hiển thị GREATEST(0,·)
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, customer_id),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, customer_id) REFERENCES customers (shop_id, id) ON DELETE CASCADE
);
ALTER TABLE loyalty_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_balances FORCE  ROW LEVEL SECURITY;
-- app_customer: 2 trục self-scoped (xem số dư ở /account).
CREATE POLICY loyalty_bal_customer ON loyalty_balances FOR SELECT TO app_customer
  USING (shop_id = current_shop_id() AND customer_id = current_customer_id());
GRANT SELECT ON loyalty_balances TO app_customer;
-- app_checkout: 2 trục self-scoped (createOrderTx SET app.customer_id) — đọc + ghi khi đổi.
CREATE POLICY loyalty_bal_checkout ON loyalty_balances FOR ALL TO app_checkout
  USING (shop_id = current_shop_id() AND customer_id = current_customer_id())
  WITH CHECK (shop_id = current_shop_id() AND customer_id = current_customer_id());
GRANT SELECT, INSERT, UPDATE ON loyalty_balances TO app_checkout;
-- app_loyalty: cross-shop (sweep tích/thu-hồi).
CREATE POLICY loyalty_bal_worker ON loyalty_balances FOR ALL TO app_loyalty USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON loyalty_balances TO app_loyalty;
-- app_rw: đọc báo cáo nợ shop-scoped.
CREATE POLICY loyalty_bal_seller ON loyalty_balances FOR SELECT TO app_rw USING (shop_id = current_shop_id());
GRANT SELECT ON loyalty_balances TO app_rw;

-- ── (3) Sổ cái điểm append-only ───────────────────────────────────────────────
CREATE TABLE loyalty_ledger (
  id          bigserial PRIMARY KEY,
  shop_id     uuid NOT NULL,
  customer_id uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('earn','redeem','reversal','clawback','adjust')),
  delta       int  NOT NULL CHECK (delta <> 0),   -- earn/reversal >0; redeem/clawback <0; adjust ±
  order_id    uuid,                                -- provenance (đơn tích/đổi/bị hoàn); bare uuid như chứng từ
  reason      text,
  actor_id    uuid,                                -- NULL = hệ thống (worker); có = seller (adjust)
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, customer_id) REFERENCES customers (shop_id, id) ON DELETE CASCADE
);
CREATE INDEX loyalty_ledger_cust_idx ON loyalty_ledger (shop_id, customer_id, id);
-- Idempotency tầng DB: ĐÚNG 1 bút toán/đơn cho từng loại per-order (5-đường-paid/retry/sweep-đè no-op).
CREATE UNIQUE INDEX loyalty_ledger_earn_once     ON loyalty_ledger (shop_id, order_id) WHERE kind = 'earn'     AND order_id IS NOT NULL;
CREATE UNIQUE INDEX loyalty_ledger_redeem_once   ON loyalty_ledger (shop_id, order_id) WHERE kind = 'redeem'   AND order_id IS NOT NULL;
CREATE UNIQUE INDEX loyalty_ledger_reversal_once ON loyalty_ledger (shop_id, order_id) WHERE kind = 'reversal' AND order_id IS NOT NULL;
CREATE UNIQUE INDEX loyalty_ledger_clawback_once ON loyalty_ledger (shop_id, order_id) WHERE kind = 'clawback' AND order_id IS NOT NULL;
ALTER TABLE loyalty_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_ledger FORCE  ROW LEVEL SECURITY;
CREATE POLICY loyalty_led_customer ON loyalty_ledger FOR SELECT TO app_customer
  USING (shop_id = current_shop_id() AND customer_id = current_customer_id());
GRANT SELECT ON loyalty_ledger TO app_customer;
CREATE POLICY loyalty_led_checkout ON loyalty_ledger FOR ALL TO app_checkout
  USING (shop_id = current_shop_id() AND customer_id = current_customer_id())
  WITH CHECK (shop_id = current_shop_id() AND customer_id = current_customer_id());
GRANT SELECT, INSERT ON loyalty_ledger TO app_checkout;
CREATE POLICY loyalty_led_worker ON loyalty_ledger FOR ALL TO app_loyalty USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON loyalty_ledger TO app_loyalty;
CREATE POLICY loyalty_led_seller ON loyalty_ledger FOR SELECT TO app_rw USING (shop_id = current_shop_id());
GRANT SELECT ON loyalty_ledger TO app_rw;
-- Append-only money-grade: KHÔNG role nào sửa/xoá (chứng từ điểm = nợ phải trả).
REVOKE UPDATE, DELETE ON loyalty_ledger FROM app_checkout, app_loyalty, app_rw, app_customer;
-- bigserial cần USAGE sequence để INSERT (bẫy 0084 outbox_id_seq) — cho các vai GHI thêm.
GRANT USAGE ON SEQUENCE loyalty_ledger_id_seq TO app_checkout, app_loyalty, app_rw;

-- ── (4) Ô snapshot đổi điểm trên đơn ──────────────────────────────────────────
ALTER TABLE orders ADD COLUMN points_redeemed     int    NOT NULL DEFAULT 0 CHECK (points_redeemed >= 0);
ALTER TABLE orders ADD COLUMN points_discount_vnd bigint NOT NULL DEFAULT 0 CHECK (points_discount_vnd >= 0);
-- worker đọc để tính cơ số tích (net hàng) + phát hiện đơn cần tích/thu-hồi.
GRANT SELECT (id, shop_id, customer_id, subtotal_vnd, discount_vnd, points_discount_vnd,
              shipping_vnd, status, paid_at, points_redeemed, created_at) ON orders TO app_loyalty;
CREATE POLICY loyalty_orders_worker ON orders FOR SELECT TO app_loyalty USING (true);
