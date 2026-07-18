/**
 * Bất biến của schema. Chạy trong CI ở MỌI commit.
 *
 * Bộ test kia kiểm hành vi của các bảng đang tồn tại. Bộ này kiểm rằng bảng
 * TIẾP THEO — cái mà ai đó sẽ thêm vào tháng sau — không thể trốn khỏi RLS.
 *
 * Một hệ thống multi-tenant không hỏng vì bảng `products` thiếu policy.
 * Nó hỏng vì bảng `product_reviews` thêm vào tuần thứ 9 và không ai nhớ.
 */
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { owner, closeAll } from './helpers.js';

after(closeAll);

/** Mọi bảng thường trong schema public có cột shop_id. */
const TENANT_TABLES = `
  SELECT c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND EXISTS (
      SELECT 1 FROM information_schema.columns col
      WHERE col.table_schema = 'public'
        AND col.table_name   = c.relname
        AND col.column_name  = 'shop_id')
`;

describe('vai trò database', () => {
  for (const role of ['app_rw', 'app_tls']) {
    test(`${role} không phải superuser và không có BYPASSRLS`, async () => {
      const { rows } = await owner.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
        [role],
      );
      assert.equal(rows.length, 1, `role ${role} phải tồn tại`);
      assert.equal(rows[0].rolsuper, false);
      assert.equal(rows[0].rolbypassrls, false, 'BYPASSRLS biến RLS thành đồ trang trí');
    });
  }

  test('app_rw không sở hữu bảng nào', async () => {
    // Chủ sở hữu bảng bỏ qua RLS trừ khi có FORCE. Đừng phụ thuộc vào FORCE
    // như tuyến phòng thủ duy nhất: đơn giản là đừng để app_rw sở hữu gì.
    const { rows } = await owner.query(`
      SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles r ON r.oid = c.relowner
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND r.rolname = 'app_rw'
    `);
    assert.deepEqual(rows.map((r) => r.relname), []);
  });

  for (const table of ['audit_logs', 'inventory_ledger', 'refunds', 'returns', 'return_lines', 'cod_remittances', 'shipment_lines']) {
    test(`app_rw không sửa/xoá được ${table} (append-only)`, async () => {
      const { rows } = await owner.query(`
        SELECT has_table_privilege('app_rw','${table}','UPDATE') AS upd,
               has_table_privilege('app_rw','${table}','DELETE') AS del,
               has_table_privilege('app_rw','${table}','INSERT') AS ins
      `);
      assert.equal(rows[0].upd, false, `${table}: KHÔNG được UPDATE`);
      assert.equal(rows[0].del, false, `${table}: KHÔNG được DELETE`);
      assert.equal(rows[0].ins, true, `${table}: vẫn phải ghi thêm được`);
    });
  }

  test('app_rw KHÔNG ghi được bảng GLOBAL nào (trừ shops) — chống leo thang (P0-3)', async () => {
    // Bất biến DURABLE: app_rw (service seller) chỉ được ghi bảng TENANT (có shop_id).
    // Mọi bảng GLOBAL (không shop_id) mà app_rw ghi được là rò quyền — kể cả bảng
    // thêm về sau tự nhận CRUD qua ALTER DEFAULT PRIVILEGES của 0003.
    //   • shops được miễn: nó LÀ tenant, RLS khoá theo id = current_shop_id().
    const { rows } = await owner.query(`
      SELECT DISTINCT g.table_name
      FROM information_schema.role_table_grants g
      WHERE g.grantee = 'app_rw' AND g.table_schema = 'public'
        AND g.privilege_type IN ('INSERT','UPDATE','DELETE')
        AND g.table_name <> 'shops'
        AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns c
          WHERE c.table_schema = 'public' AND c.table_name = g.table_name
            AND c.column_name = 'shop_id')
    `);
    assert.deepEqual(rows.map((r) => r.table_name), [],
      'app_rw ghi được bảng global → leo thang nền tảng; REVOKE trong migration mới');
  });

  test('app_rw KHÔNG ghi được billing/ledger (tenant nhạy cảm) (P0-3)', async () => {
    // Bảng tenant nhưng seller không được tự tác động: gói cước, sổ giao dịch.
    for (const table of ['subscriptions', 'payment_transactions']) {
      const { rows } = await owner.query(`
        SELECT has_table_privilege('app_rw','${table}','INSERT') AS ins,
               has_table_privilege('app_rw','${table}','UPDATE') AS upd,
               has_table_privilege('app_rw','${table}','DELETE') AS del
      `);
      assert.equal(rows[0].ins, false, `${table}: app_rw KHÔNG được INSERT`);
      assert.equal(rows[0].upd, false, `${table}: app_rw KHÔNG được UPDATE`);
      assert.equal(rows[0].del, false, `${table}: app_rw KHÔNG được DELETE`);
    }
  });

  test('app_tls chỉ đọc được shops và domains', async () => {
    const { rows } = await owner.query(`
      SELECT table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'app_tls' AND table_schema = 'public'
    `);
    const granted = rows.map((r) => `${r.table_name}:${r.privilege_type}`).sort();
    assert.deepEqual(granted, ['domains:SELECT', 'shops:SELECT']);
  });
});

describe('Row-Level Security', () => {
  test('mọi bảng có shop_id đều ENABLE và FORCE RLS', async () => {
    const { rows } = await owner.query(TENANT_TABLES);
    assert.ok(rows.length >= 8, `tìm thấy quá ít bảng tenant (${rows.length}) — query sai?`);

    const missing = rows.filter((r) => !r.relrowsecurity || !r.relforcerowsecurity);
    assert.deepEqual(
      missing.map((r) => r.table_name),
      [],
      'các bảng này thiếu ENABLE hoặc FORCE ROW LEVEL SECURITY',
    );
  });

  test('bảng shops cũng bật RLS (nó chính là tenant)', async () => {
    const { rows } = await owner.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'shops'`,
    );
    assert.equal(rows[0].relrowsecurity, true);
    assert.equal(rows[0].relforcerowsecurity, true);
  });

  test('không LỆNH nào của bảng tenant bị ≥2 policy PERMISSIVE app_rw phủ (OR nới quyền)', async () => {
    // Đây là bất biến bảo mật, không phải thẩm mỹ.
    //
    // Policy PERMISSIVE phủ CÙNG MỘT LỆNH thì OR với nhau. Thêm `CREATE POLICY lax
    // ON products FOR INSERT TO app_rw WITH CHECK (true)` vô hiệu hoá tenant_isolation
    // cho INSERT — dù policy gốc còn nguyên đó, trông rất vô hại.
    //
    // Kiểm theo TỪNG LỆNH (không phải TỔNG policy mỗi bảng): cho phép tách read/write
    // HỢP LỆ theo lệnh — vd export_artifacts (0026): FOR INSERT + FOR SELECT, KHÔNG
    // UPDATE/DELETE (bản ghi bất biến). Hai policy khác LỆNH KHÔNG bao giờ OR với nhau,
    // nên đó không phải lỗ hổng. Chỉ ≥2 policy permissive cùng phủ MỘT lệnh mới là nới quyền.
    //
    // Đã kiểm chứng bằng mutation testing: đúng lỗ hổng "policy permissive thứ hai" này.
    const { rows } = await owner.query(`
      WITH tenant_tables AS (${TENANT_TABLES})
      SELECT t.table_name, c.cmd,
             array_agg(p.policyname ORDER BY p.policyname) AS policies
      FROM tenant_tables t
      CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS c(cmd)
      JOIN pg_policies p
        ON p.schemaname = 'public' AND p.tablename = t.table_name
        AND 'app_rw' = ANY(p.roles) AND p.permissive = 'PERMISSIVE'
        AND (p.cmd = c.cmd OR p.cmd = 'ALL')
      GROUP BY t.table_name, c.cmd
      HAVING count(*) > 1
    `);
    assert.deepEqual(
      rows.map((r) => `${r.table_name} ${r.cmd}: ${JSON.stringify(r.policies)}`),
      [],
    );
  });

  test('không policy nào của app_rw dùng biểu thức hằng true', async () => {
    // USING (true) hoặc WITH CHECK (true) trên bảng tenant = không có RLS.
    const { rows } = await owner.query(`
      SELECT tablename, policyname, qual, with_check
      FROM pg_policies
      WHERE schemaname = 'public' AND 'app_rw' = ANY(roles)
        AND (qual = 'true' OR with_check = 'true')
    `);
    assert.deepEqual(rows.map((r) => `${r.tablename}.${r.policyname}`), []);
  });

  test('quy ước: policy FOR ALL khai báo WITH CHECK tường minh', async () => {
    // KHÔNG phải lỗ hổng: với FOR ALL, Postgres dùng lại biểu thức USING khi
    // WITH CHECK vắng mặt (đã kiểm chứng — bỏ WITH CHECK vẫn chặn ghi chéo shop).
    //
    // Vẫn cưỡng chế vì nếu ai đó tách policy này thành FOR SELECT + FOR INSERT
    // riêng, mặc định ngầm đó biến mất và không ai nhận ra.
    const { rows } = await owner.query(`
      SELECT tablename, policyname
      FROM pg_policies
      WHERE schemaname = 'public' AND 'app_rw' = ANY(roles) AND cmd = 'ALL'
        AND (qual IS NULL OR with_check IS NULL)
    `);
    assert.deepEqual(rows.map((r) => `${r.tablename}.${r.policyname}`), []);
  });

  test('mọi bảng có shop_id đều có ít nhất một policy cho app_rw', async () => {
    const { rows } = await owner.query(`
      WITH tenant_tables AS (${TENANT_TABLES})
      SELECT t.table_name FROM tenant_tables t
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = t.table_name
          AND 'app_rw' = ANY(p.roles))
    `);
    assert.deepEqual(rows.map((r) => r.table_name), []);
  });
});

describe('Composite foreign key', () => {
  test('mọi FK trỏ tới bảng có shop_id đều phải bao gồm cột shop_id', async () => {
    // Đây là bất biến thật sự, không phải "mọi bảng có UNIQUE(shop_id,id)".
    // FK thường tới một bảng có tenant = cho phép tham chiếu chéo shop.
    // FK tới `shops` được miễn: bảng shops không có cột shop_id.
    const { rows } = await owner.query(`
      SELECT con.conname,
             src.relname AS src_table,
             tgt.relname AS tgt_table,
             (SELECT array_agg(a.attname ORDER BY a.attnum)
                FROM unnest(con.conkey) k
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k) AS src_cols
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
      JOIN pg_class tgt ON tgt.oid = con.confrelid
      JOIN pg_namespace n ON n.oid = src.relnamespace
      WHERE con.contype = 'f' AND n.nspname = 'public'
        AND EXISTS (
          SELECT 1 FROM information_schema.columns col
          WHERE col.table_schema='public' AND col.table_name = tgt.relname
            AND col.column_name = 'shop_id')
    `);
    assert.ok(rows.length >= 3, `tìm thấy quá ít FK giữa các bảng tenant (${rows.length})`);

    const unsafe = rows.filter((r) => !r.src_cols.includes('shop_id'));
    assert.deepEqual(
      unsafe.map((r) => `${r.src_table}.${r.conname} → ${r.tgt_table} (${r.src_cols})`),
      [],
      'các FK này cho phép tham chiếu chéo shop',
    );
  });
});

describe('Kiểu dữ liệu tiền tệ', () => {
  test('mọi cột tiền là bigint, không phải float/numeric', async () => {
    const { rows } = await owner.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name LIKE '%_vnd'
    `);
    assert.ok(rows.length > 0);

    const wrong = rows.filter((r) => r.data_type !== 'bigint');
    assert.deepEqual(
      wrong.map((r) => `${r.table_name}.${r.column_name}: ${r.data_type}`),
      [],
      'VND không có phần lẻ; float/numeric mở đường cho sai số làm tròn',
    );
  });
});
