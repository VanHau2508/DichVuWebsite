-- 0002 — catalog, đơn hàng, và các bảng hạ tầng.
--
-- Ba bất biến được cưỡng chế bằng SQL, không phải bằng lời hứa của code:
--
--   1. shop_id NOT NULL ở mọi bảng.
--   2. UNIQUE (shop_id, id) ở mọi bảng — đích cho composite foreign key.
--   3. Mọi FK giữa hai bảng có tenant đều là COMPOSITE, gồm shop_id.
--
--      FK thường KHÔNG ngăn được order_line của shop A trỏ tới variant của shop B.
--      Composite FK thì có: Postgres từ chối ghi ngay ở tầng database, kể cả khi
--      RLS bị tắt nhầm và code quên WHERE shop_id.
--
-- Tiền là bigint, đơn vị đồng. Không float, không numeric. VND không có phần lẻ.

CREATE TABLE products (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    uuid NOT NULL REFERENCES shops(id),
  slug       text NOT NULL,
  title      text NOT NULL,
  price_vnd  bigint NOT NULL CHECK (price_vnd >= 0),
  status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,

  UNIQUE (shop_id, id),
  UNIQUE (shop_id, slug)          -- slug chỉ cần duy nhất TRONG một shop
);

CREATE TABLE variants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    uuid NOT NULL,
  product_id uuid NOT NULL,
  sku        text NOT NULL,
  price_vnd  bigint NOT NULL CHECK (price_vnd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (shop_id, id),
  UNIQUE (shop_id, sku),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, product_id) REFERENCES products (shop_id, id)
);

CREATE TABLE orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL,
  order_number bigint NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','confirmed','shipped','delivered','cancelled','refunded')),
  -- Trục ĐỘC LẬP với status. Đơn COD có thể delivered + unpaid trong vài giờ.
  -- Nhét chung một cột là lỗi thiết kế rất tốn kém để gỡ về sau.
  payment_status text NOT NULL DEFAULT 'unpaid'
               CHECK (payment_status IN ('unpaid','pending','paid','refunded')),
  total_vnd    bigint NOT NULL DEFAULT 0 CHECK (total_vnd >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE (shop_id, id),
  UNIQUE (shop_id, order_number),   -- số đơn đánh theo shop, không phải toàn cục
  FOREIGN KEY (shop_id) REFERENCES shops (id)
);

CREATE TABLE order_lines (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    uuid NOT NULL,
  order_id   uuid NOT NULL,
  variant_id uuid NOT NULL,

  -- Snapshot tại thời điểm mua. Sửa sản phẩm sau đó KHÔNG được đổi đơn cũ.
  -- Đây là yêu cầu kế toán, không phải tuỳ chọn. Mất nó thì không khôi phục được.
  title_snapshot text   NOT NULL,
  sku_snapshot   text   NOT NULL,
  unit_price_vnd bigint NOT NULL CHECK (unit_price_vnd >= 0),
  qty            int    NOT NULL CHECK (qty > 0),

  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, order_id)   REFERENCES orders   (shop_id, id),
  FOREIGN KEY (shop_id, variant_id) REFERENCES variants (shop_id, id)
);

-- Số đơn theo shop: UPDATE ... RETURNING. Không dùng sequence toàn cục,
-- nếu không shop A đoán được sản lượng của shop B qua số đơn.
CREATE TABLE shop_counters (
  shop_id uuid   NOT NULL REFERENCES shops(id),
  name    text   NOT NULL,
  value   bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, name)
);

CREATE TABLE idempotency_keys (
  shop_id       uuid NOT NULL REFERENCES shops(id),
  key           text NOT NULL,
  request_hash  text NOT NULL,      -- sha256(method+path+body)
  status        text NOT NULL CHECK (status IN ('in_progress','completed')),
  response_code int,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, key)
);

-- Ghi trong CÙNG transaction nghiệp vụ. Poller đọc rồi mới đẩy sang BullMQ.
-- Nếu enqueue thẳng vào Redis mà transaction rollback, khách nhận email xác nhận
-- cho một đơn hàng không tồn tại.
CREATE TABLE outbox (
  id           bigserial PRIMARY KEY,
  shop_id      uuid NOT NULL REFERENCES shops(id),
  topic        text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts     int NOT NULL DEFAULT 0
);
CREATE INDEX outbox_unprocessed_idx ON outbox (id) WHERE processed_at IS NULL;

-- Chỉ INSERT. Quyền UPDATE/DELETE bị thu hồi ở 0003.
-- shop_id NULL = hành động cấp nền tảng; app_rw không bao giờ thấy các dòng đó.
CREATE TABLE audit_logs (
  id         bigserial PRIMARY KEY,
  shop_id    uuid REFERENCES shops(id),
  actor_type text NOT NULL CHECK (actor_type IN ('user','platform_staff','system')),
  actor_id   uuid,
  action     text NOT NULL,
  target     text,
  ip         inet,
  user_agent text,
  metadata   jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_shop_created_idx ON audit_logs (shop_id, created_at DESC);
