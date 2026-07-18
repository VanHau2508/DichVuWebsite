-- 0082 — KHUYẾN MÃI TỰ ĐỘNG / FLASH SALE v1. Giảm giá theo KHUNG GIỜ (percent/fixed),
-- phạm vi TOÀN SHOP hoặc CHỌN SẢN PHẨM. Storefront tự hiện giá sale + gạch giá gốc +
-- badge -X%; checkout tính GIÁ HIỆU LỰC server-side rồi snapshot vào order_lines
-- Y HỆT giá thường (bất biến 0002).
--
-- ĐƯỜNG TIỀN — nguyên tắc SỐNG CÒN:
--  * KHÔNG mutate variants.price_vnd / products.price_vnd. Giá hiệu lực là LỚP TÍNH:
--    hàm promo_effective() là NGUỒN DUY NHẤT — storefront (thẻ lưới, PDP, related),
--    giỏ (summarize), checkout (createOrderTx) ĐỀU gọi CHUNG hàm này qua LEFT JOIN
--    LATERAL + coalesce(pe.price_vnd, base). Hiển thị và tính tiền không thể lệch.
--  * "Đang chạy" KHÔNG phải cột trạng thái — suy ra từ active AND now() ∈ [starts_at,
--    ends_at) trong hàm. KHÔNG worker/cron: hết giờ giá tự về gốc ở lần đọc kế.
--  * Hàm KEY THEO product_id (không variant_id): phạm vi promo ở mức SẢN PHẨM (mọi biến
--    thể hưởng cùng %/số tiền) và thẻ lưới chỉ có products.price_vnd. Mỗi biến thể truyền
--    base = v.price_vnd RIÊNG nên SP đa biến thể vẫn ra giá hiệu lực đúng từng biến thể.
--  * Snapshot lúc đặt: order_lines.unit_price_vnd = giá SALE (như giá thường) → báo cáo
--    lãi 0081 (unit_price_vnd − unit_cost_vnd) và revenue (subtotal_vnd) TỰ ĐÚNG.
--    orig_unit_price_vnd (giá gốc) + promotion_id chỉ để "khoe tiết kiệm"/báo cáo,
--    KHÔNG BAO GIỜ cộng vào bất kỳ số tiền nào (giống compare_at_vnd 0067, unit_cost 0081).
-- ĐƠN TAY + SỬA ĐƠN (dòng mới) KHÔNG tự áp promo (như coupon loại trừ đơn tay) — tránh
-- lệch tiền mặt COD khi nhân viên báo giá gốc mà đơn ghi giá sale (red-team money-race).
-- Money = bigint VND (bất biến 0002).

CREATE TABLE promotions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops (id),
  title       text NOT NULL,                                  -- nhãn nội bộ (khách KHÔNG nhập mã; tự động)
  kind        text NOT NULL CHECK (kind IN ('percent','fixed')),
  value       bigint NOT NULL CHECK (value > 0),              -- percent 1..100 ; fixed VND
  scope       text NOT NULL CHECK (scope IN ('all','products')),
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  active      boolean NOT NULL DEFAULT true,                  -- công tắc TAY (tắt/kết thúc sớm); live-ness do khung giờ
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (kind <> 'percent' OR value <= 100),                  -- percent tối đa 100%
  UNIQUE (shop_id, id)                                        -- đích cho composite FK (quy ước 0002)
);
ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotions FORCE  ROW LEVEL SECURITY;

-- Phạm vi CHỌN SẢN PHẨM (chỉ dùng khi scope='products'; scope='all' → bảng này rỗng).
-- Composite FK (0002): xoá SP hoặc xoá chương trình kéo theo dòng phạm vi (CASCADE).
CREATE TABLE promotion_products (
  shop_id      uuid NOT NULL,
  promotion_id uuid NOT NULL,
  product_id   uuid NOT NULL,
  PRIMARY KEY (shop_id, promotion_id, product_id),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, promotion_id) REFERENCES promotions (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, product_id)   REFERENCES products   (shop_id, id) ON DELETE CASCADE
);
ALTER TABLE promotion_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotion_products FORCE  ROW LEVEL SECURITY;

-- Index tra promo đang chạy (đọc ở MỌI trang storefront + mỗi lần checkout). Partial WHERE
-- active khớp policy store/checkout (active) + hàm (active) → subquery per-dòng LATERAL rẻ.
CREATE INDEX promotions_active_idx         ON promotions (shop_id, starts_at, ends_at) WHERE active;
CREATE INDEX promotion_products_lookup_idx ON promotion_products (shop_id, product_id, promotion_id);

-- ── HÀM GIÁ HIỆU LỰC — NGUỒN DUY NHẤT ────────────────────────────────────────
-- Trả (giá hiệu lực, promo thắng, off_pct) cho MỘT sản phẩm tại thời điểm p_at, hoặc
-- 0 dòng khi không có promo (caller LEFT JOIN LATERAL ... ON true + coalesce về base).
-- SECURITY INVOKER (mặc định) + STABLE → RLS promotions/promotion_products áp theo VAI
-- gọi (cô lập shop). Quy tắc: active + starts_at <= p_at < ends_at (nửa mở, end loại trừ)
-- + (scope='all' HOẶC product ∈ promotion_products). Nhiều promo phủ 1 SP → GIẢM NHIỀU
-- NHẤT (giá thấp nhất); hoà → promotion_id nhỏ nhất (deterministic, không cộng dồn).
-- percent: discount = (base*value)/100 chia NGUYÊN bigint = làm tròn XUỐNG discount
--   (khớp couponDiscount Math.floor(subtotal*value/100) — cùng chiều tròn).
-- fixed: discount = LEAST(base,value) → effective = base − discount ≥ 0.
CREATE FUNCTION promo_effective(p_product_id uuid, p_base_price bigint, p_at timestamptz)
RETURNS TABLE (price_vnd bigint, promotion_id uuid, off_pct int)
LANGUAGE sql STABLE AS $func$
  SELECT p_base_price - discount, pid,
         round(discount * 100.0 / NULLIF(p_base_price, 0))::int
  FROM (
    SELECT pr.id AS pid,
           LEAST(p_base_price,
                 CASE pr.kind WHEN 'percent' THEN (p_base_price * pr.value) / 100
                              ELSE pr.value END) AS discount
      FROM promotions pr
     WHERE pr.shop_id = current_shop_id()
       AND pr.active
       AND pr.starts_at <= p_at AND p_at < pr.ends_at
       AND (pr.scope = 'all'
            OR EXISTS (SELECT 1 FROM promotion_products pp
                        WHERE pp.promotion_id = pr.id AND pp.product_id = p_product_id))
  ) cand
  WHERE discount > 0
  ORDER BY discount DESC, pid          -- max giảm; hoà → uuid nhỏ nhất
  LIMIT 1;
$func$;

-- SNAPSHOT (thông tin) — giá gốc + promo áp lúc đặt. Grants TỰ PHỦ (cột thêm vào bảng cũ):
--   app_rw 0003 table-level; app_checkout 0012:66 SELECT,INSERT table-level; app_expiry
--   0022 SELECT THEO CỘT → cột mới VÔ HÌNH với worker (tốt). promotion_id KHÔNG FK
--   (snapshot; promo xoá được — báo cáo v2 LEFT JOIN chịu NULL).
ALTER TABLE order_lines ADD COLUMN orig_unit_price_vnd bigint
  CHECK (orig_unit_price_vnd IS NULL OR orig_unit_price_vnd >= 0);
ALTER TABLE order_lines ADD COLUMN promotion_id uuid;

-- ── GRANTS + RLS (kỷ luật least-priv 0081) ───────────────────────────────────
-- app_rw (seller): CRUD chương trình + phạm vi; policy thấy MỌI promo (kể cả inactive)
-- để quản lý, hàm tự lọc active. (Default privileges 0003 vốn đã cấp CRUD; grant tường
-- minh để schema-invariants đọc được ý định.)
GRANT SELECT, INSERT, UPDATE, DELETE ON promotions         TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON promotion_products TO app_rw;
CREATE POLICY tenant_isolation ON promotions FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());
CREATE POLICY tenant_isolation ON promotion_products FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- app_store (storefront): CHỈ ĐỌC promo ACTIVE để render giá sale. QUYẾT ĐỊNH: chỉ active
-- (KHÔNG thấy inactive/đã tắt) — storefront không cần "sắp diễn ra/đã kết thúc". Cửa sổ giờ
-- (now()) đặt trong HÀM (app-side), KHÔNG trong RLS: active = cổng thô ỔN ĐỊNH ở RLS, now()
-- = cổng CHÍNH XÁC ở hàm (bài học 0057: không phụ thuộc mỗi now() trong RLS).
GRANT SELECT ON promotions, promotion_products TO app_store;
CREATE POLICY store_promotions ON promotions FOR SELECT TO app_store
  USING (shop_id = current_shop_id() AND active);
CREATE POLICY store_promotion_products ON promotion_products FOR SELECT TO app_store
  USING (shop_id = current_shop_id());

-- app_checkout: CHỈ ĐỌC promo ACTIVE để tính giá hiệu lực. Filter active → seller tắt promo
-- giữa lúc checkout thì đơn tính giá gốc → cổng subtotal_seen 409 (dựng lại form giá mới).
GRANT SELECT ON promotions, promotion_products TO app_checkout;
CREATE POLICY checkout_promotions ON promotions FOR SELECT TO app_checkout
  USING (shop_id = current_shop_id() AND active);
CREATE POLICY checkout_promotion_products ON promotion_products FOR SELECT TO app_checkout
  USING (shop_id = current_shop_id());

-- app_expiry / app_payment / app_billing / app_platform: KHÔNG grant gì (không dùng).
-- Hàm mặc định EXECUTE cho PUBLIC → REVOKE rồi cấp đúng 3 vai (least-priv defense-in-depth;
-- SECURITY INVOKER nên vai không có SELECT vẫn permission-denied, nhưng giữ kỷ luật).
REVOKE EXECUTE ON FUNCTION promo_effective(uuid, bigint, timestamptz) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION promo_effective(uuid, bigint, timestamptz) TO app_rw, app_store, app_checkout;
