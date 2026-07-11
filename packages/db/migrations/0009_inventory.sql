-- 0009 — tồn kho: mức tồn theo biến thể + sổ cái (ledger) append-only.
--
-- Hai bất biến cốt lõi:
--   1. on_hand không bao giờ âm; reserved không vượt on_hand (CHECK ở DB).
--   2. Mọi thay đổi on_hand đi kèm MỘT dòng ledger trong cùng transaction →
--      tổng delta trong ledger luôn khớp on_hand. Ledger là APPEND-ONLY.

CREATE TABLE inventory_levels (
  shop_id    uuid NOT NULL,
  variant_id uuid NOT NULL,
  on_hand    int NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved   int NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (shop_id, variant_id),
  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, variant_id) REFERENCES variants (shop_id, id) ON DELETE CASCADE,

  -- Không giữ chỗ (reserve) nhiều hơn tồn thực có. Ngày 12-13 checkout sẽ tăng
  -- reserved; ràng buộc này chặn overselling ở tầng database.
  CONSTRAINT reserved_le_on_hand CHECK (reserved <= on_hand)
);

CREATE TABLE inventory_ledger (
  id         bigserial PRIMARY KEY,
  shop_id    uuid NOT NULL,
  variant_id uuid NOT NULL,
  delta      int  NOT NULL CHECK (delta <> 0),
  kind       text NOT NULL CHECK (kind IN ('receive','ship','adjust','reserve','release')),
  reason     text,
  actor_id   uuid,
  created_at timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (shop_id) REFERENCES shops (id),
  FOREIGN KEY (shop_id, variant_id) REFERENCES variants (shop_id, id)
);
CREATE INDEX inventory_ledger_variant_idx ON inventory_ledger (shop_id, variant_id, id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE inventory_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_levels FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_levels FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

ALTER TABLE inventory_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_ledger FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_ledger FOR ALL TO app_rw
  USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id());

-- Ledger là bằng chứng chuyển động tồn kho — chỉ ghi thêm, không sửa/xoá.
REVOKE UPDATE, DELETE ON inventory_ledger FROM app_rw;
