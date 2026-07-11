#!/usr/bin/env bash
#
# Mutation testing cho bộ test cô lập tenant.
#
#   bash scripts/verify-tenant-isolation.sh
#
# Một bộ test xanh không chứng minh điều gì. Nó có thể xanh vì nó không kiểm gì
# cả. Script này gỡ bỏ từng lớp phòng thủ, một lần một lớp, và khẳng định bộ
# test CHUYỂN SANG ĐỎ. Lớp nào gỡ đi mà test vẫn xanh thì lớp đó không được bất
# kỳ test nào bảo vệ — và ta sẽ không biết khi nó bị phá vỡ thật.
#
# Script phân biệt hai loại bắt lỗi:
#
#   hành vi   — dữ liệu THẬT SỰ rò sang shop khác (tenant-isolation.test.js)
#   quy ước   — schema lệch chuẩn nhưng chưa rò (schema-invariants.test.js)
#
# Phân biệt này quan trọng. Một mutation chỉ bị "quy ước" bắt nghĩa là nó không
# phải lỗ hổng — và nếu ta tưởng nó là lỗ hổng, ta đang tự lừa mình về mức độ
# an toàn của hệ thống.
#
# Mọi mutation đều được hoàn nguyên, kể cả khi script bị ngắt giữa chừng.

set -uo pipefail
export MSYS_NO_PATHCONV=1

COMPOSE="docker compose -f infra/compose.dev.yml"
pass=0; fail=0
RED=$'\033[31m'; GREEN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'

ok()   { pass=$((pass+1)); printf '  %sPASS%s %s\n' "$GREEN" "$RST" "$1"; }
bad()  { fail=$((fail+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; return 0; }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }

psql_owner()    { $COMPOSE exec -T postgres psql -q -v ON_ERROR_STOP=1 -U app_owner -d app -c "$1"; }
run_behavior()  { $COMPOSE exec -T dbtest sh -c 'node --test test/tenant-isolation.test.js'  >/dev/null 2>&1; }
run_invariant() { $COMPOSE exec -T dbtest sh -c 'node --test test/schema-invariants.test.js' >/dev/null 2>&1; }

CURRENT_REVERT=""
restore() { [ -n "$CURRENT_REVERT" ] && psql_owner "$CURRENT_REVERT" >/dev/null 2>&1; CURRENT_REVERT=""; }
trap 'restore' EXIT INT TERM

# mutate <mô tả> <bắt-bởi mong đợi: behavior|invariant|any> <sql phá> <sql hoàn nguyên>
mutate() {
  local desc="$1" want="$2" break_sql="$3" revert_sql="$4"

  if ! psql_owner "$break_sql" >/dev/null 2>&1; then
    bad "$desc — không áp dụng được mutation (SQL sai?)"
    return
  fi
  CURRENT_REVERT="$revert_sql"

  local caught=""
  run_behavior  || caught="hành vi"
  run_invariant || caught="${caught:+$caught + }quy ước"
  restore

  if [ -z "$caught" ]; then
    bad "$desc → KHÔNG test nào bắt được. Lớp phòng thủ này không được bảo vệ."
    return
  fi

  case "$want" in
    behavior)
      case "$caught" in
        *"hành vi"*) ok "$desc → bắt bởi: $caught" ;;
        *) bad "$desc → chỉ bắt bởi [$caught]; đây là rò rỉ THẬT, test hành vi phải đỏ" ;;
      esac ;;
    invariant)
      case "$caught" in
        *"hành vi"*) printf '  %sNOTE%s %s → bắt bởi [%s]; ta xếp nhầm nhóm, nó rò thật\n' "$YEL" "$RST" "$desc" "$caught"
                     pass=$((pass+1)) ;;
        *) ok "$desc → bắt bởi: $caught" ;;
      esac ;;
    *) ok "$desc → bắt bởi: $caught" ;;
  esac
}

# ─────────────────────────────────────────────────────────────────────────────
sect "0. Trạng thái ban đầu"
run_behavior && run_invariant \
  && ok "cả hai bộ test xanh khi mọi lớp phòng thủ còn nguyên" \
  || { bad "test đã đỏ từ đầu — sửa trước khi chạy mutation"; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
sect "1. Rò rỉ THẬT — test hành vi bắt buộc phải đỏ"

mutate "tắt RLS trên products" behavior \
  "ALTER TABLE products DISABLE ROW LEVEL SECURITY" \
  "ALTER TABLE products ENABLE ROW LEVEL SECURITY"

mutate "cho app_rw quyền BYPASSRLS" behavior \
  "ALTER ROLE app_rw BYPASSRLS" \
  "ALTER ROLE app_rw NOBYPASSRLS"

mutate "nới policy products thành USING (true)" behavior \
  "DROP POLICY tenant_isolation ON products;
   CREATE POLICY tenant_isolation ON products FOR ALL TO app_rw
     USING (true) WITH CHECK (true)" \
  "DROP POLICY tenant_isolation ON products;
   CREATE POLICY tenant_isolation ON products FOR ALL TO app_rw
     USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id())"

# Policy PERMISSIVE được OR với nhau. tenant_isolation vẫn còn nguyên, trông vô
# hại — nhưng chèn thêm một policy INSERT dễ dãi là mở toang đường ghi chéo shop.
mutate "thêm policy permissive FOR INSERT WITH CHECK (true)" behavior \
  "CREATE POLICY lax_insert ON products FOR INSERT TO app_rw WITH CHECK (true)" \
  "DROP POLICY lax_insert ON products"

mutate "hạ composite FK order_lines→variants xuống FK thường" behavior \
  "ALTER TABLE order_lines DROP CONSTRAINT order_lines_shop_id_variant_id_fkey;
   ALTER TABLE order_lines ADD CONSTRAINT order_lines_shop_id_variant_id_fkey
     FOREIGN KEY (variant_id) REFERENCES variants (id)" \
  "ALTER TABLE order_lines DROP CONSTRAINT order_lines_shop_id_variant_id_fkey;
   ALTER TABLE order_lines ADD CONSTRAINT order_lines_shop_id_variant_id_fkey
     FOREIGN KEY (shop_id, variant_id) REFERENCES variants (shop_id, id)"

mutate "cho app_rw quyền sửa audit_logs" behavior \
  "GRANT UPDATE ON audit_logs TO app_rw" \
  "REVOKE UPDATE ON audit_logs FROM app_rw"

# Fail-open: thiếu context thì trả về shop đầu tiên thay vì rỗng.
mutate "current_shop_id() fail-open khi thiếu context" behavior \
  "CREATE OR REPLACE FUNCTION current_shop_id() RETURNS uuid LANGUAGE sql STABLE AS
     \$\$ SELECT COALESCE(NULLIF(current_setting('app.shop_id', true), '')::uuid,
                          (SELECT id FROM shops ORDER BY created_at LIMIT 1)) \$\$" \
  "CREATE OR REPLACE FUNCTION current_shop_id() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS
     \$\$ SELECT NULLIF(current_setting('app.shop_id', true), '')::uuid \$\$"

# ─────────────────────────────────────────────────────────────────────────────
sect "2. Chỉ test bất biến bắt được — và đó chính là lý do nó tồn tại"

# FORCE chỉ ảnh hưởng CHỦ SỞ HỮU bảng. app_rw không sở hữu bảng nào nên không rò
# qua ứng dụng. Vẫn nguy hiểm: mọi script chạy bằng app_owner âm thầm thấy tất cả.
mutate "tắt FORCE RLS (chỉ ảnh hưởng script chạy bằng app_owner)" invariant \
  "ALTER TABLE products NO FORCE ROW LEVEL SECURITY" \
  "ALTER TABLE products FORCE ROW LEVEL SECURITY"

# Với FOR ALL, Postgres dùng lại USING khi WITH CHECK vắng mặt → KHÔNG rò.
mutate "bỏ WITH CHECK khỏi FOR ALL (Postgres dùng lại USING → không rò)" invariant \
  "DROP POLICY tenant_isolation ON products;
   CREATE POLICY tenant_isolation ON products FOR ALL TO app_rw
     USING (shop_id = current_shop_id())" \
  "DROP POLICY tenant_isolation ON products;
   CREATE POLICY tenant_isolation ON products FOR ALL TO app_rw
     USING (shop_id = current_shop_id()) WITH CHECK (shop_id = current_shop_id())"

# Bảng mới quên bật RLS — kịch bản thực tế nhất của tuần thứ 9.
# Đây là RÒ RỈ THẬT. Test hành vi không bắt được vì nó không thể viết test cho
# một bảng chưa tồn tại. Bất biến schema là tuyến phòng thủ DUY NHẤT ở đây.
mutate "bảng MỚI có shop_id nhưng quên RLS (rò thật; test hành vi không thể phủ)" invariant \
  "CREATE TABLE product_reviews (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     shop_id uuid NOT NULL REFERENCES shops(id),
     rating int NOT NULL);
   GRANT SELECT, INSERT, UPDATE, DELETE ON product_reviews TO app_rw" \
  "DROP TABLE product_reviews"

# ─────────────────────────────────────────────────────────────────────────────
sect "3. Trạng thái sau khi hoàn nguyên"
run_behavior && run_invariant \
  && ok "cả hai bộ test xanh trở lại — mọi mutation đã gỡ sạch" \
  || bad "test còn đỏ — schema chưa được hoàn nguyên đúng!"

printf '\n\033[1m%d pass, %d fail\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
