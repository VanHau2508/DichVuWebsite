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
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { owner, expiry, closeAll, withTenant, sqlstateOf, SQLSTATE } from './helpers.js';

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

// Chuẩn hoá biểu thức policy trước khi so: PostgreSQL in lại `qual`/`with_check` với dấu
// ngoặc và khoảng trắng do NÓ tự chọn, không phải như đã viết trong migration, nên so
// nguyên văn là đỏ giả sau mỗi lần nâng cấp bản PostgreSQL.
//
// GIỚI HẠN, ghi ở đây để người sau khỏi tin quá: nó XOÁ HẲN dấu ngoặc, nên hai biểu thức
// khác nhau về THỨ TỰ ƯU TIÊN có thể bị gộp thành một —  `a AND (b OR c)` và `(a AND b) OR c`
// chuẩn hoá ra cùng một chuỗi. Hôm nay mọi policy trong kho đều thuần AND nên chỗ này an
// toàn; thêm một policy có trộn AND với OR thì phải so bằng cây cú pháp chứ không bằng
// chuỗi đã nén, nếu không chốt sẽ im lặng chấp nhận một policy rộng hơn ý định.
const compactPolicyExpr = (value) => String(value ?? '').replace(/[()\s]/g, '').toLowerCase();

// `provider_status` là một từ vựng nhỏ và có chủ ý đóng kín. Rút tập từ các đường
// ghi/đọc thật thay vì chép lại danh sách lần hai trong test: thêm marker trong mã
// phải buộc CHECK DB đổi trong cùng lát cắt. Image dbtest mount nguồn vào /work;
// các đường dự phòng giữ bộ test chạy được trực tiếp từ checkout.
function stripSourceComments(source, { sql = false } = {}) {
  let out = '';
  let state = 'code';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'line') {
      if (ch === '\n') { out += ch; state = 'code'; }
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { i += 1; state = 'code'; }
      else if (ch === '\n') out += ch;
      continue;
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      out += ch;
      if (ch === '\\') { if (next !== undefined) { out += next; i += 1; } }
      else if ((state === 'single' && ch === "'")
        || (state === 'double' && ch === '"')
        || (state === 'template' && ch === '`')) state = 'code';
      continue;
    }
    if ((ch === '/' && next === '/') || (sql && ch === '-' && next === '-')) {
      i += 1; state = 'line'; continue;
    }
    if (ch === '/' && next === '*') { i += 1; state = 'block'; continue; }
    if (ch === "'") { out += ch; state = 'single'; continue; }
    if (ch === '"') { out += ch; state = 'double'; continue; }
    if (ch === '`') { out += ch; state = 'template'; continue; }
    out += ch;
  }
  return out;
}

function sourceText(relativePath) {
  const candidates = [
    resolve(process.cwd(), relativePath),
    resolve(process.cwd(), '..', relativePath),
    resolve(process.cwd(), '..', '..', relativePath),
    resolve(process.cwd(), '..', '..', '..', relativePath),
    join('/work', relativePath),
    join('/work', relativePath.replace(/^packages[\\/]db[\\/]/, '')),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  assert.ok(path, `mốc chết: không tìm thấy nguồn ${relativePath}`);
  return stripSourceComments(readFileSync(path, 'utf8'), { sql: relativePath.endsWith('.sql') });
}

const SHIPMENT_STATUS_SOURCES = [
  sourceText('apps/seller/src/shipping.js'),
  sourceText('apps/seller/src/orders.js'),
  sourceText('apps/seller/src/dashboard.js'),
  sourceText('apps/seller-admin/src/pages.js'),
  sourceText('apps/worker/src/index.js'),
  sourceText('packages/db/migrations/0046_shipping_hardening.sql'),
];

function internalShipmentStatuses() {
  const found = new Set();
  const addQuoted = (text) => {
    for (const value of String(text ?? '').matchAll(/(['"])([^'"\\]*(?:\\.[^'"\\]*)*)\1/g)) {
      found.add(value[2]);
    }
  };
  for (const source of SHIPMENT_STATUS_SOURCES) {
    // Scan the complete comment-free source so a multiline allowlist cannot evade the
    // invariant. The parser intentionally extracts literals only from expressions tied
    // to provider_status/providerStatus; unrelated strings do not enter the vocabulary.
    for (const m of source.matchAll(/\bproviderStatus\s*:\s*([^,}\n]+)/g)) addQuoted(m[1]);
    // Một số migration dùng `coalesce(provider_status, 'marker')`: literal nằm
    // bên trong hàm chứ không đứng ngay sau dấu `=`. Rút riêng dạng này để
    // không bỏ sót marker lịch sử như `dedup_0046`.
    for (const m of source.matchAll(/\bprovider_status\s*=\s*coalesce\([^)]*?(['"])([^'"\\]*(?:\\.[^'"\\]*)*)\1/gi)) {
      found.add(m[2]);
    }
    for (const m of source.matchAll(/\bprovider_status\s*=\s*(?:coalesce\([^)]*\)\s*)?(['"])([^'"\\]*(?:\\.[^'"\\]*)*)\1/g)) {
      found.add(m[2]);
    }
    for (const m of source.matchAll(/\bprovider_status\s+(?:NOT\s+)?IN\s*\(([\s\S]*?)\)/gi)) addQuoted(m[1]);
    // `NOT IN` và mảng trong giao diện admin đặt literal trước `provider_status`,
    // nên phải rút cả danh sách nằm trong ngoặc vuông.
    for (const m of source.matchAll(/\[([^\]]*)\]\s*\.includes\([^)]*provider_status\)/gi)) addQuoted(m[1]);
    for (const m of source.matchAll(/\bprovider_status\s*(?:===?|!==?)\s*(['"])([^'"\\]*(?:\\.[^'"\\]*)*)\1/g)) {
      found.add(m[2]);
    }
  }
  return found;
}

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

  for (const table of ['audit_logs', 'inventory_ledger', 'refunds', 'returns', 'return_lines', 'cod_remittances', 'shipment_lines', 'order_events']) {
    test(`app_rw không sửa/xoá được ${table} (append-only)`, async () => {
      const { rows } = await owner.query(`
        SELECT has_table_privilege('app_rw','${table}','UPDATE') AS upd,
               has_table_privilege('app_rw','${table}','DELETE') AS del,
               has_table_privilege('app_rw','${table}','INSERT') AS ins
      `);
      assert.equal(rows[0].upd, false, `${table}: KHÔNG được UPDATE`);
      assert.equal(rows[0].del, false, `${table}: KHÔNG được DELETE`);
      assert.equal(rows[0].ins, true, `${table}: vẫn phải ghi thêm được`);
      if (table === 'refunds') {
        const { rows: [shape] } = await owner.query(`
          SELECT
            EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema='public' AND table_name='refunds' AND column_name='idempotency_key' AND data_type='uuid') AS has_key,
            EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema='public' AND table_name='refunds' AND column_name='request_fingerprint' AND data_type='text') AS has_fingerprint,
            pg_get_expr(i.indpred, i.indrelid) AS predicate,
            pg_get_indexdef(i.indexrelid) AS definition
          FROM pg_index i
          JOIN pg_class x ON x.oid = i.indexrelid
          WHERE x.relname = 'refunds_idem_uq'
        `);
        assert.equal(shape?.has_key, true, 'refunds.idempotency_key uuid phải tồn tại');
        assert.equal(shape?.has_fingerprint, true, 'refunds.request_fingerprint text phải tồn tại');
        assert.match(shape?.definition ?? '', /UNIQUE INDEX refunds_idem_uq ON public\.refunds USING btree \(shop_id, idempotency_key\)/);
        assert.match(shape?.predicate ?? '', /idempotency_key IS NOT NULL/,
          'partial index phải bỏ qua chứng từ cũ có key NULL');
      }
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

  test('app_rw không được CRUD tenant root hoặc tự đổi lifecycle go-live', async () => {
    const { rows: [p] } = await owner.query(`
      SELECT has_table_privilege('app_rw','shops','INSERT') AS ins,
             has_table_privilege('app_rw','shops','UPDATE') AS table_upd,
             has_table_privilege('app_rw','shops','DELETE') AS del,
             has_column_privilege('app_rw','shops','name','UPDATE') AS profile_upd,
             has_column_privilege('app_rw','shops','status','UPDATE') AS status_upd,
             has_column_privilege('app_rw','shops','went_live_at','UPDATE') AS live_at_upd
    `);
    assert.deepEqual(p, {
      ins: false,
      table_upd: false,
      del: false,
      profile_upd: true,
      status_upd: false,
      live_at_upd: false,
    });
  });

  test('projection wishlist là cửa hẹp NOLOGIN và không mở quyền kho cho app_customer', async () => {
    const { rows: [fn] } = await owner.query(`
      SELECT r.rolname AS owner, r.rolcanlogin, r.rolsuper, r.rolbypassrls,
             p.prosecdef, p.proconfig,
             has_function_privilege('app_customer', p.oid, 'EXECUTE') AS customer_exec,
             has_function_privilege('app_rw', p.oid, 'EXECUTE') AS rw_exec,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
        FROM pg_proc p
        JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.oid = 'current_customer_wishlist()'::regprocedure
    `);
    assert.equal(fn.owner, 'app_customer_wishlist');
    assert.equal(fn.rolcanlogin, false);
    assert.equal(fn.rolsuper, false);
    assert.equal(fn.rolbypassrls, false);
    assert.equal(fn.prosecdef, true);
    assert.ok((fn.proconfig ?? []).some((v) => v === 'search_path=public, pg_temp'));
    assert.equal(fn.customer_exec, true);
    assert.equal(fn.rw_exec, false);
    assert.equal(fn.public_exec, false);

    for (const table of ['variants', 'inventory_levels', 'product_options',
      'variant_option_values', 'promotions', 'promotion_products']) {
      const { rows: [priv] } = await owner.query(`
        SELECT has_table_privilege('app_customer',$1,'SELECT') AS customer_select,
               has_table_privilege('app_customer_wishlist',$1,'INSERT') AS projection_insert,
               has_table_privilege('app_customer_wishlist',$1,'UPDATE') AS projection_update,
               has_table_privilege('app_customer_wishlist',$1,'DELETE') AS projection_delete
      `, [table]);
      assert.deepEqual(priv, {
        customer_select: false,
        projection_insert: false,
        projection_update: false,
        projection_delete: false,
      }, `${table}: account không đọc trực tiếp; projection chỉ được đọc`);
    }

    const { rows: policies } = await owner.query(`
      SELECT tablename, cmd, qual
        FROM pg_policies
       WHERE schemaname = 'public' AND 'app_customer_wishlist' = ANY(roles)
       ORDER BY tablename, cmd
    `);
    assert.deepEqual(policies.map((r) => `${r.tablename}:${r.cmd}`), [
      'inventory_levels:SELECT',
      'media:SELECT',
      'product_options:SELECT',
      'products:SELECT',
      'promotion_products:SELECT',
      'promotions:SELECT',
      'shops:SELECT',
      'variant_option_values:SELECT',
      'variants:SELECT',
      'wishlist_items:SELECT',
    ]);
    assert.ok(policies.every((r) => String(r.qual).includes('current_shop_id()')));
    assert.ok(String(policies.find((r) => r.tablename === 'wishlist_items')?.qual)
      .includes('current_customer_id()'));
  });

  test('cửa hẹp go-live thuộc role NOLOGIN, FORCE RLS và chỉ app_rw được gọi', async () => {
    const { rows: [fn] } = await owner.query(`
      SELECT r.rolname AS owner, r.rolcanlogin, r.rolsuper, r.rolbypassrls,
             p.prosecdef, p.proconfig,
             has_function_privilege('app_rw', p.oid, 'EXECUTE') AS rw_exec,
             has_function_privilege('app_signup', p.oid, 'EXECUTE') AS signup_exec
        FROM pg_proc p
        JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.oid = 'activate_current_shop_after_readiness()'::regprocedure
    `);
    assert.equal(fn.owner, 'app_go_live');
    assert.equal(fn.rolcanlogin, false);
    assert.equal(fn.rolsuper, false);
    assert.equal(fn.rolbypassrls, false);
    assert.equal(fn.prosecdef, true);
    assert.ok((fn.proconfig ?? []).some((v) => v === 'search_path=public, pg_temp'));
    assert.equal(fn.rw_exec, true);
    assert.equal(fn.signup_exec, false);

    const { rows: [shopPriv] } = await owner.query(`
      SELECT has_table_privilege('app_go_live','shops','UPDATE') AS table_upd,
             has_column_privilege('app_go_live','shops','status','UPDATE') AS status_upd,
             has_column_privilege('app_go_live','shops','went_live_at','UPDATE') AS live_at_upd,
             has_column_privilege('app_go_live','shops','name','UPDATE') AS name_upd
    `);
    assert.deepEqual(shopPriv, {
      table_upd: false,
      status_upd: true,
      live_at_upd: true,
      name_upd: false,
    });

    const { rows: [integrationPriv] } = await owner.query(`
      SELECT has_column_privilege('app_go_live','shop_integrations','id','SELECT') AS si_id,
             has_column_privilege('app_go_live','shop_integrations','shop_id','SELECT') AS si_shop,
             has_column_privilege('app_go_live','shop_integrations','status','SELECT') AS si_status,
             has_column_privilege('app_go_live','shop_integrations','inventory_authority','SELECT') AS si_authority,
             has_column_privilege('app_go_live','shop_integrations','generation','SELECT') AS si_generation,
             has_column_privilege('app_go_live','integration_entity_refs','shop_id','SELECT') AS ref_shop,
             has_column_privilege('app_go_live','integration_entity_refs','integration_id','SELECT') AS ref_integration,
             has_column_privilege('app_go_live','integration_entity_refs','mapping_status','SELECT') AS ref_mapping,
             has_column_privilege('app_go_live','integration_entity_refs','inventory_generation','SELECT') AS ref_generation
    `);
    assert.deepEqual(integrationPriv, {
      si_id: true,
      si_shop: true,
      si_status: true,
      si_authority: true,
      si_generation: true,
      ref_shop: true,
      ref_integration: true,
      ref_mapping: true,
      ref_generation: true,
    });

    const { rows: policies } = await owner.query(`
      SELECT tablename, cmd, qual, with_check
        FROM pg_policies
       WHERE schemaname = 'public' AND 'app_go_live' = ANY(roles)
       ORDER BY tablename, cmd
    `);
    assert.deepEqual(policies.map((r) => `${r.tablename}:${r.cmd}`), [
      'domains:SELECT',
      'integration_entity_refs:SELECT',
      'inventory_levels:SELECT',
      'pages:SELECT',
      'product_options:SELECT',
      'products:SELECT',
      'shop_integrations:SELECT',
      'shops:SELECT',
      'shops:UPDATE',
      'variant_option_values:SELECT',
      'variants:SELECT',
    ]);
    assert.ok(policies.every((r) => String(r.qual).includes('current_shop_id()')));
    assert.ok(!policies.some((r) => /\btrue\b/i.test(`${r.qual} ${r.with_check}`)));
    assert.ok(String(policies.find((r) => r.tablename === 'shops' && r.cmd === 'UPDATE')?.with_check)
      .includes("status = 'active'"));

    for (const table of ['domains', 'integration_entity_refs', 'inventory_levels', 'pages',
      'product_options', 'products', 'shop_integrations', 'variant_option_values', 'variants']) {
      const { rows: [priv] } = await owner.query(`
        SELECT has_table_privilege('app_go_live',$1,'INSERT') AS ins,
               has_table_privilege('app_go_live',$1,'UPDATE') AS upd,
               has_table_privilege('app_go_live',$1,'DELETE') AS del
      `, [table]);
      assert.deepEqual(priv, { ins: false, upd: false, del: false },
        `${table}: app_go_live chỉ được đọc tín hiệu readiness`);
    }
  });

  test('mixed-shipment detector là cửa hẹp NOLOGIN và worker không được tự ghi case', async () => {
    const { rows: [fn] } = await owner.query(`
      SELECT r.rolname AS owner, r.rolcanlogin, r.rolsuper, r.rolbypassrls,
             p.prosecdef, p.proconfig,
             has_function_privilege('app_expiry', p.oid, 'EXECUTE') AS expiry_exec,
             has_function_privilege('app_rw', p.oid, 'EXECUTE') AS rw_exec,
             has_function_privilege('app_resolution', p.oid, 'EXECUTE') AS resolution_exec,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
        FROM pg_proc p
        JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.oid = 'open_mixed_shipment_resolution(uuid)'::regprocedure
    `);
    assert.equal(fn.owner, 'app_resolution_detector');
    assert.equal(fn.rolcanlogin, false);
    assert.equal(fn.rolsuper, false);
    assert.equal(fn.rolbypassrls, false);
    assert.equal(fn.prosecdef, true);
    assert.ok((fn.proconfig ?? []).some((v) => v === 'search_path=public, pg_temp'));
    assert.equal(fn.expiry_exec, true);
    assert.equal(fn.rw_exec, false);
    assert.equal(fn.resolution_exec, false);
    assert.equal(fn.public_exec, false);

    for (const table of ['order_resolution_cases', 'order_resolution_case_lines']) {
      const { rows: [priv] } = await owner.query(`
        SELECT has_table_privilege('app_expiry',$1,'INSERT') AS expiry_insert,
               has_table_privilege('app_resolution_detector',$1,'UPDATE') AS detector_update,
               has_table_privilege('app_resolution_detector',$1,'DELETE') AS detector_delete
      `, [table]);
      assert.deepEqual(priv, {
        expiry_insert: false,
        detector_update: false,
        detector_delete: false,
      }, `${table}: chỉ detector function được append bằng chứng`);
    }

    const { rows: policies } = await owner.query(`
      SELECT tablename, cmd
        FROM pg_policies
       WHERE schemaname = 'public'
         AND 'app_resolution_detector' = ANY(roles)
       ORDER BY tablename, cmd
    `);
    assert.deepEqual(policies.map((r) => `${r.tablename}:${r.cmd}`), [
      'order_lines:SELECT',
      'order_resolution_case_lines:INSERT',
      'order_resolution_cases:INSERT',
      'order_resolution_cases:SELECT',
      'orders:SELECT',
      'orders:UPDATE',
      'shipment_lines:SELECT',
      'shipments:SELECT',
    ]);

    const { rows: [lockPolicy] } = await owner.query(`
      SELECT qual, with_check
        FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'orders'
         AND policyname = 'resolution_detector_orders_lock'
         AND cmd = 'UPDATE'
         AND 'app_resolution_detector' = ANY(roles)
    `);
    assert.ok(lockPolicy, 'detector cần policy UPDATE để SELECT ... FOR UPDATE thấy dòng');
    assert.equal(lockPolicy.qual, 'true');
    assert.equal(lockPolicy.with_check, 'false');
  });

  test('required_refund_vnd không thể bị sửa sau khi snapshot case được tạo', async () => {
    for (const role of ['app_rw', 'app_expiry', 'app_resolution', 'app_resolution_detector']) {
      const { rows: [priv] } = await owner.query(`
        SELECT has_column_privilege($1,'order_resolution_cases','required_refund_vnd','UPDATE') AS upd
      `, [role]);
      assert.equal(priv.upd, false, `${role}: không được viết lại bằng chứng hoàn tiền`);
    }

    const { rows: [trigger] } = await owner.query(`
      SELECT pg_get_triggerdef(t.oid) AS definition
        FROM pg_trigger t
       WHERE t.tgrelid = 'order_resolution_cases'::regclass
         AND t.tgname = 'order_resolution_case_transition_guard'
         AND NOT t.tgisinternal
    `);
    assert.match(trigger.definition, /required_refund_vnd/i);
  });

  test('snapshot và receipt của resolution là append-only và FORCE RLS', async () => {
    for (const table of [
      'order_resolution_case_lines',
      'order_resolution_return_receipts',
      'order_resolution_return_receipt_lines',
    ]) {
      const { rows: [meta] } = await owner.query(`
        SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
               has_table_privilege('app_rw',$1,'UPDATE') AS rw_update,
               has_table_privilege('app_rw',$1,'DELETE') AS rw_delete,
               has_table_privilege('app_expiry',$1,'UPDATE') AS expiry_update,
               has_table_privilege('app_expiry',$1,'DELETE') AS expiry_delete
          FROM pg_class c
         WHERE c.oid = $1::regclass
      `, [table]);
      assert.deepEqual(meta, {
        rls: true,
        force_rls: true,
        rw_update: false,
        rw_delete: false,
        expiry_update: false,
        expiry_delete: false,
      }, `${table}: bằng chứng phải FORCE RLS + append-only`);
    }

    for (const table of ['order_resolution_return_receipts', 'order_resolution_return_receipt_lines']) {
      const { rows: [priv] } = await owner.query(`
        SELECT has_table_privilege('app_rw',$1,'INSERT') AS rw_insert,
               has_table_privilege('app_expiry',$1,'INSERT') AS expiry_insert,
               has_table_privilege('app_resolution',$1,'INSERT') AS service_insert
      `, [table]);
      assert.deepEqual(priv, { rw_insert: false, expiry_insert: false, service_insert: true },
        `${table}: chỉ resolution service được append receipt`);
    }
  });

  test('attribution refund có quyền hẹp, policy exact và cửa ghi SECURITY DEFINER', async () => {
    const { rows: [meta] } = await owner.query(`
      SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
             has_table_privilege('app_rw',c.oid,'SELECT') AS rw_select,
             has_table_privilege('app_rw',c.oid,'INSERT') AS rw_insert,
             has_table_privilege('app_rw',c.oid,'UPDATE') AS rw_update,
             has_table_privilege('app_rw',c.oid,'DELETE') AS rw_delete,
             has_table_privilege('app_resolution',c.oid,'SELECT') AS resolution_select,
             has_table_privilege('app_resolution',c.oid,'INSERT') AS resolution_insert,
             has_table_privilege('app_resolution',c.oid,'UPDATE') AS resolution_update,
             has_table_privilege('app_resolution',c.oid,'DELETE') AS resolution_delete
        FROM pg_class c
       WHERE c.oid='order_resolution_refund_attributions'::regclass
    `);
    assert.deepEqual(meta, {
      rls: true,
      force_rls: true,
      rw_select: true,
      rw_insert: false,
      rw_update: false,
      rw_delete: false,
      resolution_select: true,
      resolution_insert: true,
      resolution_update: false,
      resolution_delete: false,
    });

    const policies = (await owner.query(`
      SELECT policyname, cmd, roles, qual, with_check
        FROM pg_policies
       WHERE schemaname='public' AND tablename='order_resolution_refund_attributions'
       ORDER BY policyname
    `)).rows.map((row) => ({
      ...row,
      roles: String(row.roles).slice(1, -1).split(',').filter(Boolean).sort(),
      qual: compactPolicyExpr(row.qual),
      with_check: compactPolicyExpr(row.with_check),
    }));
    assert.deepEqual(policies, [
      { policyname: 'attrib_resolution_insert', cmd: 'INSERT', roles: ['app_resolution'], qual: '', with_check: 'shop_id=current_shop_id' },
      { policyname: 'attrib_resolution_select', cmd: 'SELECT', roles: ['app_resolution'], qual: 'shop_id=current_shop_id', with_check: '' },
      { policyname: 'attrib_rw_select', cmd: 'SELECT', roles: ['app_rw'], qual: 'shop_id=current_shop_id', with_check: '' },
    ]);

    const { rows: [fn] } = await owner.query(`
      SELECT r.rolname AS owner, r.rolcanlogin, r.rolsuper, r.rolbypassrls,
             p.prosecdef, p.proconfig,
             has_function_privilege('app_rw',p.oid,'EXECUTE') AS rw_exec,
             has_function_privilege('public',p.oid,'EXECUTE') AS public_exec,
             pg_get_functiondef(p.oid) AS definition
        FROM pg_proc p
        JOIN pg_roles r ON r.oid=p.proowner
       WHERE p.oid='attribute_resolution_refunds(uuid,uuid[],text,uuid)'::regprocedure
    `);
    assert.equal(fn.owner, 'app_resolution');
    assert.equal(fn.rolcanlogin, false);
    assert.equal(fn.rolsuper, false);
    assert.equal(fn.rolbypassrls, false);
    assert.equal(fn.prosecdef, true);
    assert.ok((fn.proconfig ?? []).includes('search_path=public, pg_temp'));
    assert.equal(fn.rw_exec, true);
    assert.equal(fn.public_exec, false);
    assert.match(fn.definition, /m\.role\s+IN\s+\('owner'(?:::text)?,\s*'admin'(?:::text)?\)/i);
    assert.match(fn.definition, /pg_advisory_xact_lock\(hashtextextended\(current_shop_id\(\)::text\s*\|\|\s*':'(?:::text)?\s*\|\|\s*x::text,\s*0(?:::bigint)?\)\)/i);
    assert.match(fn.definition, /FROM unnest\(v_refund_ids\) AS x\s+ORDER BY x/i);
    assert.doesNotMatch(fn.definition, /created_at\s*>?=/i,
      'phiếu tạo trước detected_at vẫn phải dùng được');

    const { rows: constraints } = await owner.query(`
      SELECT contype, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid='order_resolution_refund_attributions'::regclass
       ORDER BY contype, conname
    `);
    const defs = constraints.map((row) => row.definition);
    assert.ok(defs.some((d) => /UNIQUE \(shop_id, refund_id\)/i.test(d)));
    assert.ok(defs.some((d) => /FOREIGN KEY \(shop_id, order_id, case_id\).*order_resolution_cases\(shop_id, order_id, id\)/i.test(d)));
    assert.ok(defs.some((d) => /FOREIGN KEY \(shop_id, order_id, refund_id\).*refunds\(shop_id, order_id, id\)/i.test(d)));
  });

  test('UNIQUE attribution chặn hai case tranh cùng refund dưới concurrency', async () => {
    // Không mượn user fixture của bộ khác: node --test chạy các file song song, và một bộ
    // dọn user của chính nó trong khi refund ở đây còn tham chiếu sẽ làm cả cổng đỏ ngẫu nhiên.
    const { rows: [actor] } = await owner.query(`
      INSERT INTO users (email,password_hash)
      VALUES ('schema-attrib-' || substring(gen_random_uuid()::text,1,8) || '@test.invalid', 'H')
      RETURNING id
    `);
    assert.ok(actor?.id, 'không dựng được actor cho fixture attribution');
    let fixture;
    try {
      ({ rows: [fixture] } = await owner.query(`
        WITH s AS (
          INSERT INTO shops (slug,name,status)
          VALUES ('attrib-race-' || substring(gen_random_uuid()::text,1,8), 'Attribution race', 'active')
          RETURNING id
        ), o AS (
          INSERT INTO orders (shop_id,order_number,total_vnd)
          SELECT id,1,1000 FROM s RETURNING shop_id,id
        ), r AS (
          INSERT INTO refunds (shop_id,order_id,amount_vnd,reason,created_by)
          SELECT shop_id,id,1000,'race', $1 FROM o RETURNING shop_id,order_id,id
        ), resolved_case AS (
          INSERT INTO order_resolution_cases
            (shop_id,order_id,status,resolution,resolution_note,resolved_at,resolved_by)
          SELECT shop_id,order_id,'resolved','accept_partial','ca đã đóng',now(),$1 FROM r
          RETURNING id
        ), open_case AS (
          INSERT INTO order_resolution_cases (shop_id,order_id)
          SELECT shop_id,order_id FROM r RETURNING id
        )
        SELECT r.shop_id, r.order_id, r.id AS refund_id,
               resolved_case.id AS case_a, open_case.id AS case_b
          FROM r, resolved_case, open_case
      `, [actor.id]));

      const insertOne = async (caseId) => {
        const client = await owner.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `INSERT INTO order_resolution_refund_attributions
               (shop_id,order_id,case_id,refund_id,attributed_by)
             VALUES ($1,$2,$3,$4,$5)`,
            [fixture.shop_id, fixture.order_id, caseId, fixture.refund_id, actor.id],
          );
          await client.query('COMMIT');
          return 'ok';
        } catch (error) {
          await client.query('ROLLBACK');
          return error.code;
        } finally {
          client.release();
        }
      };
      const results = await Promise.all([insertOne(fixture.case_a), insertOne(fixture.case_b)]);
      assert.deepEqual(results.sort(), ['23505', 'ok']);
      const { rows: [proof] } = await owner.query(
        `SELECT count(*)::int AS n FROM order_resolution_refund_attributions
          WHERE shop_id=$1 AND refund_id=$2`, [fixture.shop_id, fixture.refund_id],
      );
      assert.equal(proof.n, 1);
    } finally {
      // Attribution và refund là chứng từ append-only, trigger cố ý từ chối DELETE. Fixture
      // dùng actor riêng nên không va bộ chạy song song; cổng DB trắng tự huỷ volume sau lượt.
    }
  });

  test('resolution evidence cast actor timeline text sang uuid rõ ràng', async () => {
    const defs = (await owner.query(`
      SELECT proname, pg_get_functiondef(oid) AS def
        FROM pg_proc
       WHERE proname IN (
         'enforce_resolution_return_receipt',
         'enforce_order_resolution_completion_evidence'
       )
       ORDER BY proname
    `)).rows;
    assert.equal(defs.length, 2);
    for (const row of defs) {
      assert.match(row.def, /e\.actor_id = NEW\.(received_by|resolved_by)::text/);
    }
  });

  test('detector giữ fallback paid_at cho đơn paid legacy có amount_paid_vnd=0', async () => {
    const { rows: [fn] } = await owner.query(`
      SELECT pg_get_functiondef('open_mixed_shipment_resolution(uuid)'::regprocedure) AS definition
    `);
    assert.match(fn.definition, /amount_paid_vnd\s*>\s*0/i);
    assert.match(fn.definition, /paid_at\s+IS\s+NOT\s+NULL\s+THEN\s+v_order\.total_vnd/i);
  });

  test('fulfillment adjustment chỉ được ghi qua cửa hẹp resolution và được payment tôn trọng', async () => {
    const { rows: [column] } = await owner.query(`
      SELECT is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'orders'
         AND column_name = 'fulfillment_adjustment_vnd'
    `);
    assert.deepEqual(column, { is_nullable: 'NO', column_default: '0' });

    const { rows: [priv] } = await owner.query(`
      SELECT has_column_privilege('app_payment','orders','fulfillment_adjustment_vnd','UPDATE') AS payment_update,
             has_column_privilege('app_resolution','orders','fulfillment_adjustment_vnd','UPDATE') AS resolution_update,
             has_column_privilege('app_checkout','orders','fulfillment_adjustment_vnd','SELECT') AS checkout_read,
             has_column_privilege('app_customer','orders','fulfillment_adjustment_vnd','SELECT') AS customer_read,
             has_column_privilege('app_payment','orders','fulfillment_adjustment_vnd','SELECT') AS payment_read
    `);
    assert.deepEqual(priv, {
      payment_update: false,
      resolution_update: true,
      checkout_read: true,
      customer_read: true,
      payment_read: true,
    });

    const { rows: [fn] } = await owner.query(`
      SELECT r.rolname AS owner, r.rolcanlogin, r.rolsuper, r.rolbypassrls,
             p.prosecdef, p.proconfig,
             has_function_privilege('app_rw', p.oid, 'EXECUTE') AS rw_exec,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
             pg_get_functiondef(p.oid) AS definition
        FROM pg_proc p
        JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.oid = 'set_order_partial_fulfillment_adjustment(uuid)'::regprocedure
    `);
    assert.equal(fn.owner, 'app_resolution');
    assert.equal(fn.rolcanlogin, false);
    assert.equal(fn.rolsuper, false);
    assert.equal(fn.rolbypassrls, false);
    assert.equal(fn.prosecdef, true);
    assert.ok((fn.proconfig ?? []).some((v) => v === 'search_path=public, pg_temp'));
    assert.equal(fn.rw_exec, true);
    assert.equal(fn.public_exec, false);
    assert.match(fn.definition, /fulfillment_adjustment_vnd IN \(0, v_adjustment\)/i);

    const { rows: [lineRead] } = await owner.query(`
      SELECT has_table_privilege('app_resolution','order_lines','SELECT') AS can_read,
             qual
        FROM pg_policies
       WHERE schemaname='public' AND tablename='order_lines'
         AND policyname='resolution_service_order_lines_read'
         AND 'app_resolution' = ANY(roles)
    `);
    assert.equal(lineRead.can_read, true);
    assert.match(lineRead.qual, /shop_id = current_shop_id\(\)/i);

    const { rows: [guard] } = await owner.query(`
      SELECT pg_get_triggerdef(t.oid) AS trigger_definition,
             pg_get_functiondef(t.tgfoid) AS function_definition,
             has_function_privilege('public', t.tgfoid, 'EXECUTE') AS public_exec
        FROM pg_trigger t
       WHERE t.tgrelid = 'orders'::regclass
         AND t.tgname = 'fulfillment_adjustment_write_guard'
         AND NOT t.tgisinternal
    `);
    assert.match(guard.trigger_definition, /BEFORE UPDATE OF fulfillment_adjustment_vnd ON public\.orders/i);
    assert.match(guard.function_definition, /current_user\s*<>\s*'app_resolution'/i);
    assert.equal(guard.public_exec, false);

    const { rows: [sample] } = await owner.query(`
      WITH created_shop AS (
        INSERT INTO shops (slug, name, status)
        VALUES ('guard-' || substring(gen_random_uuid()::text, 1, 8), 'Guard test', 'active')
        RETURNING id
      )
      INSERT INTO orders (shop_id, order_number, total_vnd)
      SELECT id, 1, 1 FROM created_shop
      RETURNING shop_id, id
    `);
    try {
      const directWriteState = await sqlstateOf(() => withTenant(sample.shop_id, (c) => c.query(
        `UPDATE orders SET fulfillment_adjustment_vnd = fulfillment_adjustment_vnd + 1 WHERE id = $1`,
        [sample.id],
      )));
      assert.equal(directWriteState, SQLSTATE.INSUFFICIENT_PRIVILEGE,
        'app_rw có table-level UPDATE legacy nhưng trigger phải chặn ghi cột adjustment trực tiếp');
    } finally {
      await owner.query(`DELETE FROM orders WHERE id=$1`, [sample.id]);
      await owner.query(`DELETE FROM shops WHERE id=$1`, [sample.shop_id]);
    }

    const { rows: paymentFns } = await owner.query(`
      SELECT p.proname, r.rolname AS owner, pg_get_functiondef(p.oid) AS definition
        FROM pg_proc p
        JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.oid IN (
         'record_manual_payment(uuid,bigint,uuid,text)'::regprocedure,
         'reverse_manual_payment(uuid,uuid,uuid,text)'::regprocedure
       )
       ORDER BY p.proname
    `);
    assert.equal(paymentFns.length, 2);
    for (const paymentFn of paymentFns) {
      assert.equal(paymentFn.owner, 'app_payment');
      assert.match(paymentFn.definition, /total_vnd\s*-\s*v_order\.fulfillment_adjustment_vnd/i);
      assert.match(paymentFn.definition, /v_after\s*>=\s*v_payable/i);
    }

    const { rows: tempPolicies } = await owner.query(`
      SELECT policyname FROM pg_policies
       WHERE schemaname = 'public' AND policyname LIKE 'adjustment_0173_owner_%'
    `);
    assert.deepEqual(tempPolicies, []);
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

  test('idempotency_keys giữ đúng RLS và toàn bộ tập policy tenant', async () => {
    const { rows: [table] } = await owner.query(`
      SELECT c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'idempotency_keys'
    `);
    assert.equal(table.relrowsecurity, true);
    assert.equal(table.relforcerowsecurity, true);

    // So toàn bộ tập, không chỉ kiểm hai tên có mặt: một policy PERMISSIVE thứ ba sẽ OR
    // với policy đúng và nới quyền dù hai policy gốc vẫn nguyên vẹn.
    const { rows } = await owner.query(`
      SELECT policyname, permissive, cmd, roles::text[] AS roles, qual, with_check
        FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'idempotency_keys'
       ORDER BY policyname
    `);
    const actual = rows.map((r) => ({
      policyname: r.policyname,
      permissive: r.permissive,
      cmd: r.cmd,
      roles: [...r.roles].sort(),
      qual: compactPolicyExpr(r.qual),
      with_check: compactPolicyExpr(r.with_check),
    }));
    const appRw = compactPolicyExpr('shop_id = current_shop_id()');
    const checkout = compactPolicyExpr('shop_id = current_shop_id() AND current_shop_is_live()');
    assert.deepEqual(actual, [
      {
        policyname: 'checkout_idem', permissive: 'PERMISSIVE', cmd: 'ALL',
        roles: ['app_checkout'], qual: checkout, with_check: checkout,
      },
      {
        policyname: 'tenant_isolation', permissive: 'PERMISSIVE', cmd: 'ALL',
        roles: ['app_rw'], qual: appRw, with_check: appRw,
      },
    ]);
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

  test('worker chỉ ghi đúng allowlist sự kiện hệ thống vào timeline', async () => {
    const { rows } = await owner.query(`
      SELECT policyname, roles, with_check
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'order_events'
        AND ('app_worker' = ANY(roles) OR 'app_expiry' = ANY(roles))
      ORDER BY policyname
    `);
    assert.equal(rows.length, 2, 'mỗi vai worker phải có đúng một policy INSERT');

    const byName = new Map(rows.map((r) => [r.policyname, String(r.with_check ?? '')]));
    const expiry = byName.get('order_events_expiry') ?? '';
    const worker = byName.get('order_events_worker') ?? '';

    for (const token of ['order.cancelled', 'resolution.opened', 'shipment.delivered',
      'shipment.returned', 'shipment.cancelled', 'system', 'carrier', 'worker']) {
      assert.ok(expiry.includes(token), `policy app_expiry thiếu chốt ${token}`);
    }
    for (const token of ['notification.sent', 'notification.failed', 'system', 'worker']) {
      assert.ok(worker.includes(token), `policy app_worker thiếu chốt ${token}`);
    }
    assert.doesNotMatch(expiry, /\btrue\b/i, 'app_expiry không được WITH CHECK(true)');
    assert.doesNotMatch(worker, /\btrue\b/i, 'app_worker không được WITH CHECK(true)');
    assert.ok(!worker.includes('payment.received'), 'app_worker không được giả sự kiện tiền');
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

describe('Namespace trạng thái vận đơn (0184)', () => {
  const MIGRATION_0184 = readFileSync(new URL('../migrations/0184_shipment_status_namespace.sql', import.meta.url), 'utf8');

  test('carrier_status_raw là cột riêng, CHECK khớp đúng tập marker thực tế và grant app_expiry hẹp', async () => {
    assert.match(MIGRATION_0184, /carrier_status_raw/);
    assert.match(MIGRATION_0184, /GRANT UPDATE \(carrier_status_raw\) ON shipments TO app_expiry/);
    assert.match(MIGRATION_0184, /CREATE POLICY shipment_0184_owner_backfill ON shipments/,
      'migration phải mở policy tạm để backfill xuyên FORCE RLS');
    assert.match(MIGRATION_0184, /DROP POLICY shipment_0184_owner_backfill ON shipments/,
      'policy backfill phải được xoá ngay trong migration');
    const policyAt = MIGRATION_0184.indexOf('CREATE POLICY shipment_0184_owner_backfill ON shipments');
    const guardAt = MIGRATION_0184.indexOf('DO $$');
    const backfillAt = MIGRATION_0184.indexOf('UPDATE shipments');
    const checkAt = MIGRATION_0184.indexOf('ADD CONSTRAINT shipments_provider_status_internal_check');
    const dropAt = MIGRATION_0184.indexOf('DROP POLICY shipment_0184_owner_backfill ON shipments');
    assert.ok(policyAt >= 0 && guardAt > policyAt && backfillAt > guardAt && checkAt > backfillAt && dropAt > checkAt,
      'thứ tự backfill phải là mở policy tạm → kiểm tra/chuyển dữ liệu → CHECK → xoá policy');
    const migrationCode = stripSourceComments(MIGRATION_0184, { sql: true });
    assert.match(migrationCode,
      /UPDATE\s+shipments\s+SET\s+carrier_status_raw\s*=\s*provider_status\s*,\s*provider_status\s*=\s*NULL\s+WHERE\s+provider\s+IS\s+NOT\s+NULL\s+AND\s+provider_status\s+IS\s+NOT\s+NULL\s+AND\s+provider_status\s+NOT\s+IN\s*\(/s,
      'backfill phải chuyển nguyên mã raw và xoá nó khỏi provider_status');
    assert.match(migrationCode,
      /WHERE\s+provider\s+IS\s+NULL\s+AND\s+provider_status\s+IS\s+NOT\s+NULL\s+AND\s+provider_status\s+NOT\s+IN\s*\(/s,
      'provider NULL chứa giá trị lạ phải làm migration fail-closed');

    const { rows: columns } = await owner.query(`
      SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'shipments'
         AND column_name IN ('provider_status', 'carrier_status_raw')
       ORDER BY column_name`);
    assert.deepEqual(columns, [
      { column_name: 'carrier_status_raw', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'provider_status', data_type: 'text', is_nullable: 'YES' },
    ]);

    const { rows: [constraint] } = await owner.query(`
      SELECT conname, contype, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'shipments'::regclass
         AND conname = 'shipments_provider_status_internal_check'`);
    assert.equal(constraint?.conname, 'shipments_provider_status_internal_check');
    assert.equal(constraint?.contype, 'c');

    const { rows: [compat] } = await owner.query(`
      SELECT p.prosecdef, r.rolname AS owner, pg_get_functiondef(p.oid) AS definition
        FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.oid = 'normalize_shipment_provider_status_namespace()'::regprocedure`);
    assert.equal(compat?.owner, 'app_owner', 'hàm tương thích phải thuộc owner DDL');
    assert.equal(compat?.prosecdef, false, 'hàm tương thích không được tự nâng quyền');
    assert.match(compat?.definition ?? '', /current_user\s*=\s*'app_expiry'/,
      'đường tương thích phải hẹp đúng vai worker cũ');
    const compatList = /NEW\.provider_status\s+NOT IN\s*\(([^)]*)\)/s.exec(compat?.definition ?? '');
    assert.ok(compatList, 'mốc chết: trigger không còn danh sách marker nội bộ');
    const compatStatuses = new Set([...compatList[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]));

    const sourceStatuses = internalShipmentStatuses();
    assert.ok(sourceStatuses.size >= 9, 'mốc chết: không rút được đủ marker provider_status từ đường ghi/đọc');
    const dbStatuses = new Set([...String(constraint.definition).matchAll(/'([^']+)'/g)].map((m) => m[1]));
    assert.deepEqual([...dbStatuses].sort(), [...sourceStatuses].sort(),
      'CHECK provider_status phải so BẰNG với vocabulary trong mã; thêm marker mà quên migration phải đỏ');
    assert.deepEqual([...compatStatuses].sort(), [...dbStatuses].sort(),
      'chốt tương thích worker cũ phải dùng đúng vocabulary của CHECK');

    const { rows: [priv] } = await owner.query(`
      SELECT has_column_privilege('app_expiry','shipments','provider_status','SELECT') AS internal_select,
             has_column_privilege('app_expiry','shipments','carrier_status_raw','SELECT') AS raw_select,
             has_column_privilege('app_expiry','shipments','provider_status','UPDATE') AS internal_update,
             has_column_privilege('app_expiry','shipments','carrier_status_raw','UPDATE') AS raw_update`);
    assert.deepEqual(priv, {
      internal_select: true,
      raw_select: false,
      internal_update: true,
      raw_update: true,
    }, 'app_expiry chỉ được ghi raw; không tự mở quyền đọc raw');

    const { rows: ownerBackfillPolicies } = await owner.query(`
      SELECT policyname
        FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'shipments'
         AND policyname = 'shipment_0184_owner_backfill'`);
    assert.deepEqual(ownerBackfillPolicies, [],
      'policy xuyên tenant chỉ được tồn tại trong lúc backfill, không được để lại ở runtime');

    const { rows: [unknown] } = await owner.query(`
      SELECT count(*)::int AS n
        FROM shipments
       WHERE provider_status IS NOT NULL
         AND provider_status NOT IN (SELECT unnest($1::text[]))`, [[...sourceStatuses]]);
    assert.equal(unknown.n, 0, 'provider_status hiện tại không được chứa marker ngoài vocabulary');
  });

  test('CHECK chặn mã hãng ở provider_status nhưng cho ghi raw và giữ marker tiền', async () => {
    const tag = `status-ns-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    let shopId;
    let orderId;
    let shipmentId;
    try {
      const { rows: [shop] } = await owner.query(
        `INSERT INTO shops (slug, name, status) VALUES ($1, $2, 'active') RETURNING id`, [tag, tag]);
      shopId = shop.id;
      const { rows: [order] } = await owner.query(
        `INSERT INTO orders (shop_id, order_number, total_vnd) VALUES ($1, 1, 1000) RETURNING id`, [shopId]);
      orderId = order.id;
      const { rows: [shipment] } = await owner.query(
        `INSERT INTO shipments (shop_id, order_id, provider, status) VALUES ($1, $2, 'ghtk', 'created') RETURNING id`, [shopId, orderId]);
      shipmentId = shipment.id;

      const sourceStatuses = internalShipmentStatuses();
      for (const marker of sourceStatuses) {
        const state = await sqlstateOf(() => owner.query(
          `UPDATE shipments SET provider_status = $2 WHERE id = $1`, [shipmentId, marker]));
        assert.equal(state, null, `marker nội bộ ${marker} phải được CHECK cho phép`);
      }

      const rejected = await sqlstateOf(() => owner.query(
        `UPDATE shipments SET provider_status = '5' WHERE id = $1`, [shipmentId]));
      assert.equal(rejected, '23514', 'mã raw của hãng không được chui vào provider_status');

      await owner.query(`UPDATE shipments SET provider_status = 'cod_mismatch' WHERE id = $1`, [shipmentId]);
      const expiryLegacyWrite = await sqlstateOf(() => expiry.query(
        `UPDATE shipments SET provider_status = '5' WHERE id = $1`, [shipmentId]));
      assert.equal(expiryLegacyWrite, null,
        'worker cũ ghi raw vào provider_status phải được trigger chuyển sang cột raw trong lúc rollout');

      const { rows: [legacyRow] } = await owner.query(
        `SELECT provider_status, carrier_status_raw FROM shipments WHERE id = $1`, [shipmentId]);
      assert.deepEqual(legacyRow, { provider_status: 'cod_mismatch', carrier_status_raw: '5' },
        'đường tương thích worker cũ phải giữ marker nội bộ đang có');

      await expiry.query(`UPDATE shipments SET carrier_status_raw = '5' WHERE id = $1`, [shipmentId]);
      const { rows: [row] } = await owner.query(
        `SELECT provider_status, carrier_status_raw FROM shipments WHERE id = $1`, [shipmentId]);
      assert.deepEqual(row, { provider_status: 'cod_mismatch', carrier_status_raw: '5' },
        'cập nhật raw không được xoá cảnh báo cod_mismatch');

      // Trong lúc rollout worker cũ vẫn có thể ghi qua provider_status. Các mã hãng
      // dạng chữ trùng marker nội bộ phải vẫn đi vào namespace raw, dựa trên trạng thái
      // vòng đời của đường poll chứ không dựa riêng vào allowlist.
      await owner.query(
        `UPDATE shipments SET status = 'in_transit', tracking_number = 'COLLIDE-A', provider_status = 'cod_mismatch' WHERE id = $1`,
        [shipmentId]);
      await expiry.query(`UPDATE shipments SET provider_status = 'ambiguous' WHERE id = $1`, [shipmentId]);
      const { rows: [collisionInTransit] } = await owner.query(
        `SELECT provider_status, carrier_status_raw FROM shipments WHERE id = $1`, [shipmentId]);
      assert.deepEqual(collisionInTransit, { provider_status: 'cod_mismatch', carrier_status_raw: 'ambiguous' },
        'mã hãng chữ trùng marker phải được tách khi kiện đang được poll');

      await owner.query(
        `UPDATE shipments SET status = 'cancelled', tracking_number = 'COLLIDE-B', provider_status = 'cod_mismatch' WHERE id = $1`,
        [shipmentId]);
      await expiry.query(`UPDATE shipments SET provider_status = 'created' WHERE id = $1`, [shipmentId]);
      const { rows: [collisionCancelled] } = await owner.query(
        `SELECT provider_status, carrier_status_raw FROM shipments WHERE id = $1`, [shipmentId]);
      assert.deepEqual(collisionCancelled, { provider_status: 'cod_mismatch', carrier_status_raw: 'created' },
        'mã hãng chữ trùng marker phải được tách khi hãng huỷ kiện có mã');
    } finally {
      if (shipmentId) await owner.query('DELETE FROM shipments WHERE id = $1', [shipmentId]);
      if (orderId) await owner.query('DELETE FROM orders WHERE id = $1', [orderId]);
      if (shopId) await owner.query('DELETE FROM shops WHERE id = $1', [shopId]);
    }
  });
});

describe('Connector POS ngoài (0177–0183) — quyền hẹp, claim và fail-closed', () => {
  const TABLES = ['shop_integrations', 'integration_webhook_inbox', 'integration_entity_refs',
    'integration_sync_discrepancies', 'integration_order_send_intents'];
  const MIGRATION_0178 = readFileSync(new URL('../migrations/0178_kiotviet_connector_hardening.sql', import.meta.url), 'utf8');
  const MIGRATION_0181 = readFileSync(new URL('../migrations/0181_kiotviet_claim_and_send_intent.sql', import.meta.url), 'utf8');
  const MIGRATION_0182 = readFileSync(new URL('../migrations/0182_kiotviet_retry_confirmation.sql', import.meta.url), 'utf8');

  test('nonce retry nằm trên send-intent và FK giữ cùng tenant với discrepancy', async () => {
    assert.match(MIGRATION_0182, /last_retry_discrepancy_id/);
    const { rows: [column] } = await owner.query(`
      SELECT is_nullable, data_type
        FROM information_schema.columns
       WHERE table_schema='public' AND table_name='integration_order_send_intents'
         AND column_name='last_retry_discrepancy_id'`);
    assert.deepEqual(column, { is_nullable: 'YES', data_type: 'uuid' });
    const { rows: [fk] } = await owner.query(`
      SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conname='integration_order_send_intents_retry_discrepancy_fk'`);
    assert.equal(fk?.conname, 'integration_order_send_intents_retry_discrepancy_fk');
    assert.match(fk.definition, /FOREIGN KEY \(shop_id, last_retry_discrepancy_id\)/);
    assert.match(fk.definition, /integration_sync_discrepancies/);
  });

  test('claim lock dùng một hàm SQL chung và checkout chỉ đọc shop_id', async () => {
    assert.match(MIGRATION_0181, /CREATE FUNCTION kiotviet_entity_claim_lock_key\(/);
    assert.match(MIGRATION_0181, /kiotviet:entity-claim:/);
    const { rows: [grant] } = await owner.query(`
      SELECT has_column_privilege('app_checkout','shop_integrations','shop_id','SELECT') AS can_read`);
    assert.equal(grant.can_read, true);
    const { rows: [fn] } = await owner.query(`
      SELECT has_function_privilege('app_integration','kiotviet_entity_claim_lock_key(uuid,text,uuid)','EXECUTE') AS can_exec`);
    assert.equal(fn.can_exec, true);
  });

  test('send-intent chỉ cho worker ghi; seller chỉ được xem hàng đợi của tenant', async () => {
    const { rows: [rw] } = await owner.query(`
      SELECT has_table_privilege('app_rw','integration_order_send_intents','SELECT') AS sel,
             has_table_privilege('app_rw','integration_order_send_intents','INSERT') AS ins,
             has_table_privilege('app_rw','integration_order_send_intents','UPDATE') AS upd,
             has_table_privilege('app_rw','integration_order_send_intents','DELETE') AS del`);
    assert.deepEqual(rw, { sel: true, ins: false, upd: false, del: false });
    const { rows: [worker] } = await owner.query(`
      SELECT has_table_privilege('app_integration','integration_order_send_intents','SELECT') AS sel,
             has_table_privilege('app_integration','integration_order_send_intents','INSERT') AS ins,
             has_table_privilege('app_integration','integration_order_send_intents','UPDATE') AS upd,
             has_table_privilege('app_integration','integration_order_send_intents','DELETE') AS del`);
    assert.deepEqual(worker, { sel: true, ins: true, upd: true, del: false });
    const { rows: policies } = await owner.query(`
      SELECT policyname, cmd, roles::text[] AS roles,
             regexp_replace(coalesce(qual, ''), '[()[:space:]]', '', 'g') AS using_expr,
             regexp_replace(coalesce(with_check, ''), '[()[:space:]]', '', 'g') AS check_expr
        FROM pg_policies
       WHERE tablename = 'integration_order_send_intents'
       ORDER BY policyname`);
    assert.deepEqual(policies.map((p) =>
      `${p.policyname}|${p.cmd}|${p.roles.join(',')}|${p.using_expr}|${p.check_expr}`), [
      'send_intent_guard|SELECT|app_integration_guard|true|',
      'send_intent_integration|ALL|app_integration|shop_id=current_shop_id|shop_id=current_shop_id',
      'send_intent_rw_select|SELECT|app_rw|shop_id=current_shop_id|',
    ]);
  });

  test('backfill 0178 mở cả SELECT nguồn dưới FORCE RLS rồi thu hồi policy tạm', () => {
    const policies = [
      ['integration_0178_owner_config_update', 'shop_integrations'],
      ['integration_0178_owner_inbox_update', 'integration_webhook_inbox'],
      ['integration_0178_owner_orders_update', 'orders'],
    ];
    const firstBackfill = MIGRATION_0178.indexOf('UPDATE integration_webhook_inbox w');
    assert.ok(firstBackfill > 0, 'phải tìm thấy backfill inbox');
    for (const [policy, table] of policies) {
      const create = `CREATE POLICY ${policy} ON ${table}\n  FOR ALL TO app_owner USING (true) WITH CHECK (true);`;
      const createdAt = MIGRATION_0178.indexOf(create);
      const droppedAt = MIGRATION_0178.indexOf(`DROP POLICY ${policy} ON ${table};`);
      assert.ok(createdAt >= 0 && createdAt < firstBackfill,
        `${policy} phải là FOR ALL trước backfill; UPDATE-only không đọc được bảng nguồn dưới FORCE RLS`);
      assert.ok(droppedAt > firstBackfill, `${policy} phải được thu hồi sau backfill`);
    }
  });

  test('năm bảng connector đều ENABLE + FORCE RLS', async () => {
    const { rows } = await owner.query(`
      SELECT relname, relrowsecurity, relforcerowsecurity
        FROM pg_class
       WHERE relname = ANY($1::text[]) ORDER BY relname`, [TABLES]);
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.map((r) => [r.relname, r.relrowsecurity, r.relforcerowsecurity]), [
      ['integration_entity_refs', true, true],
      ['integration_order_send_intents', true, true],
      ['integration_sync_discrepancies', true, true],
      ['integration_webhook_inbox', true, true],
      ['shop_integrations', true, true],
    ]);
  });

  test('tập policy connector đúng bằng manifest, thêm policy rộng cũng phải đỏ', async () => {
    const { rows } = await owner.query(`
      SELECT tablename, policyname, cmd, roles::text[] AS roles
        FROM pg_policies
       WHERE tablename = ANY($1::text[])
       ORDER BY tablename, policyname`, [TABLES]);
    assert.deepEqual(rows.map((r) => `${r.tablename}|${r.policyname}|${r.cmd}|${r.roles.join(',')}`), [
      'integration_entity_refs|checkout_integration_refs|SELECT|app_checkout',
      'integration_entity_refs|expiry_customer_ref_delete|DELETE|app_expiry',
      'integration_entity_refs|go_live_integration_ref_read|SELECT|app_go_live',
      'integration_entity_refs|integration_guard_refs|ALL|app_integration_guard',
      'integration_entity_refs|integration_refs|ALL|app_integration',
      'integration_entity_refs|tenant_isolation|ALL|app_rw',
      'integration_order_send_intents|send_intent_guard|SELECT|app_integration_guard',
      'integration_order_send_intents|send_intent_integration|ALL|app_integration',
      'integration_order_send_intents|send_intent_rw_select|SELECT|app_rw',
      'integration_sync_discrepancies|integration_discrepancies|ALL|app_integration',
      'integration_sync_discrepancies|tenant_isolation|ALL|app_rw',
      'integration_webhook_inbox|integration_guard_inbox|ALL|app_integration_guard',
      'integration_webhook_inbox|integration_inbox|ALL|app_integration',
      'integration_webhook_inbox|tenant_isolation|SELECT|app_rw',
      'shop_integrations|checkout_active_integration|SELECT|app_checkout',
      'shop_integrations|checkout_transitioning_integration|SELECT|app_checkout',
      'shop_integrations|go_live_integration_read|SELECT|app_go_live',
      'shop_integrations|integration_config|ALL|app_integration',
      'shop_integrations|integration_guard_config|ALL|app_integration_guard',
      'shop_integrations|tenant_isolation|ALL|app_rw',
    ]);
  });

  test('app_rw và app_integration chỉ có đúng thao tác vận hành cần thiết', async () => {
    const expected = {
      app_rw: {
        shop_integrations: [true, true, true, true],
        integration_webhook_inbox: [true, false, false, false],
        integration_entity_refs: [true, true, true, true],
        integration_order_send_intents: [true, false, false, false],
        integration_sync_discrepancies: [true, false, true, false],
      },
      app_integration: {
        shop_integrations: [true, false, true, false],
        integration_webhook_inbox: [true, true, true, false],
        integration_entity_refs: [true, true, true, false],
        integration_order_send_intents: [true, true, true, false],
        integration_sync_discrepancies: [true, true, true, false],
      },
      app_integration_guard: {
        shop_integrations: [true, false, true, false],
        integration_webhook_inbox: [true, false, true, false],
        integration_entity_refs: [true, false, true, false],
        integration_order_send_intents: [true, false, false, false],
        integration_sync_discrepancies: [false, false, false, false],
      },
    };
    for (const [role, tables] of Object.entries(expected)) {
      for (const [table, want] of Object.entries(tables)) {
        const { rows: [got] } = await owner.query(`
          SELECT has_table_privilege($1,$2,'SELECT') AS sel,
                 has_table_privilege($1,$2,'INSERT') AS ins,
                 has_table_privilege($1,$2,'UPDATE') AS upd,
                 has_table_privilege($1,$2,'DELETE') AS del`, [role, table]);
        assert.deepEqual(Object.values(got), want, `${role} trên ${table}`);
      }
    }
  });

  test('app_integration chỉ đọc các cột tối thiểu để chống trùng và nhận id sự kiện', async () => {
    const { rows } = await owner.query(`
      SELECT p.table_name, p.column_name
        FROM information_schema.column_privileges p
        JOIN information_schema.columns c
          ON c.table_schema = p.table_schema
         AND c.table_name = p.table_name
         AND c.column_name = p.column_name
       WHERE p.grantee = 'app_integration'
         AND p.privilege_type = 'SELECT'
         AND p.table_schema = 'public'
         AND p.table_name IN ('payment_transactions', 'order_events')
       ORDER BY p.table_name, c.ordinal_position`,
    );
    assert.deepEqual(rows.map((r) => `${r.table_name}.${r.column_name}`), [
      'order_events.id',
      'payment_transactions.shop_id',
      'payment_transactions.provider',
      'payment_transactions.provider_event_id',
    ]);
    for (const table of ['payment_transactions', 'order_events']) {
      const { rows: [got] } = await owner.query(
        `SELECT has_table_privilege('app_integration',$1,'SELECT') AS can_read_all`, [table],
      );
      assert.equal(got.can_read_all, false, `${table} không được mở SELECT toàn bảng`);
    }

    const { rows: policies } = await owner.query(`
      SELECT tablename, policyname, cmd, roles::text[] AS roles,
             regexp_replace(coalesce(qual, ''), '[()[:space:]]', '', 'g') AS using_expr
        FROM pg_policies
       WHERE tablename IN ('payment_transactions', 'order_events')
         AND 'app_integration' = ANY(roles::text[])
       ORDER BY tablename, policyname`,
    );
    assert.deepEqual(policies.map((p) => `${p.tablename}|${p.policyname}|${p.cmd}|${p.roles.join(',')}|${p.using_expr}`), [
      'order_events|integration_order_events|INSERT|app_integration|',
      'order_events|integration_order_events_read|SELECT|app_integration|shop_id=current_shop_id',
      'payment_transactions|integration_payments|INSERT|app_integration|',
      'payment_transactions|integration_payments_read|SELECT|app_integration|shop_id=current_shop_id',
    ]);
  });

  test('checkout chỉ đọc độ tươi tồn, không đọc credential hay secret webhook', async () => {
    const allowed = ['id', 'shop_id', 'provider', 'status', 'inventory_authority', 'external_branch_ref',
      'inventory_synced_at', 'generation', 'capabilities'];
    const { rows } = await owner.query(`
      SELECT column_name, has_column_privilege('app_checkout','shop_integrations',column_name,'SELECT') AS can_read
        FROM information_schema.columns
       WHERE table_schema='public' AND table_name='shop_integrations'
       ORDER BY ordinal_position`);
    assert.deepEqual(rows.filter((r) => r.can_read).map((r) => r.column_name), allowed);
    for (const secret of ['credential_ciphertext', 'webhook_refs', 'webhook_public_id']) {
      assert.equal(rows.find((r) => r.column_name === secret)?.can_read, false, `checkout không được đọc ${secret}`);
    }

    const { rows: refColumns } = await owner.query(`
      SELECT column_name,
             has_column_privilege('app_checkout','integration_entity_refs',column_name,'SELECT') AS can_read
        FROM information_schema.columns
       WHERE table_schema='public' AND table_name='integration_entity_refs'
       ORDER BY ordinal_position`);
    assert.deepEqual(refColumns.filter((r) => r.can_read).map((r) => r.column_name), [
      'integration_id', 'entity_type', 'local_id', 'mapping_status',
      'inventory_synced_at', 'inventory_generation',
    ]);
    for (const secret of ['external_id', 'raw_meta']) {
      assert.equal(refColumns.find((r) => r.column_name === secret)?.can_read, false,
        `checkout không được đọc integration_entity_refs.${secret}`);
    }
  });

  test('vai guard là NOLOGIN, không BYPASSRLS và không còn là thành viên của app_owner', async () => {
    const { rows: [role] } = await owner.query(`
      SELECT rolcanlogin, rolsuper, rolbypassrls, rolinherit
        FROM pg_roles WHERE rolname = 'app_integration_guard'`);
    assert.deepEqual(role, {
      rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolinherit: false,
    });
    const { rows: membership } = await owner.query(`
      SELECT 1
        FROM pg_auth_members m
        JOIN pg_roles member_role ON member_role.oid = m.member
        JOIN pg_roles granted_role ON granted_role.oid = m.roleid
       WHERE member_role.rolname = 'app_owner'
         AND granted_role.rolname = 'app_integration_guard'`);
    assert.equal(membership.length, 0, 'membership tạm trong migration phải được thu hồi');
  });

  test('app_integration chỉ được sửa đúng cột customer, variant và order cần cho bản chiếu', async () => {
    const readableCustomer = ['id', 'shop_id', 'full_name', 'phone', 'status'];
    const insertableCustomer = ['shop_id', 'full_name', 'phone'];
    const updateableCustomer = ['full_name', 'phone', 'updated_at'];
    const columnsFor = async (table, privilege) => (await owner.query(`
      SELECT column_name
        FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = $1
         AND grantee = 'app_integration' AND privilege_type = $2
       ORDER BY (SELECT ordinal_position FROM information_schema.columns c
                  WHERE c.table_schema = 'public' AND c.table_name = $1
                    AND c.column_name = information_schema.column_privileges.column_name)`,
    [table, privilege])).rows.map((r) => r.column_name);

    assert.deepEqual(await columnsFor('customers', 'SELECT'), readableCustomer);
    assert.deepEqual(await columnsFor('customers', 'INSERT'), insertableCustomer);
    assert.deepEqual(await columnsFor('customers', 'UPDATE'), updateableCustomer);
    assert.deepEqual(await columnsFor('variants', 'UPDATE'), ['sku', 'price_vnd', 'barcode']);
    assert.deepEqual(await columnsFor('orders', 'UPDATE'), [
      'status', 'payment_status', 'paid_at', 'amount_paid_vnd',
      'integration_id', 'external_ref', 'external_branch_ref',
      'sync_status', 'sync_error', 'sync_updated_at', 'integration_generation',
    ]);
    for (const table of ['customers', 'variants', 'orders']) {
      const { rows: [got] } = await owner.query(
        `SELECT has_table_privilege('app_integration',$1,'UPDATE') AS can_update_all`, [table],
      );
      assert.equal(got.can_update_all, false, `${table} không được mở UPDATE toàn bảng`);
    }

    const { rows: policies } = await owner.query(`
      SELECT tablename, policyname, cmd, roles::text[] AS roles
        FROM pg_policies
       WHERE tablename IN ('customers','variants','orders')
         AND (roles::text[] && ARRAY['app_integration','app_integration_guard']::text[])
       ORDER BY tablename, policyname`);
    assert.deepEqual(policies.map((p) => `${p.tablename}|${p.policyname}|${p.cmd}|${p.roles.join(',')}`), [
      'customers|integration_customers_insert|INSERT|app_integration',
      'customers|integration_customers_select|SELECT|app_integration',
      'customers|integration_customers_update|UPDATE|app_integration',
      'orders|integration_guard_orders|ALL|app_integration_guard',
      'orders|integration_orders|ALL|app_integration',
      'variants|integration_variants|SELECT|app_integration',
      'variants|integration_variants_update|UPDATE|app_integration',
    ]);
  });

  test('generation và bằng chứng tồn có constraint ghép, webhook unique theo vòng đời', async () => {
    const names = [
      'integration_ref_inventory_stamp_check',
      'integration_webhook_generation_check',
      'integration_webhook_generation_event_unique',
      'integration_webhook_inbox_status_check',
      'orders_integration_generation_check',
      'shop_integrations_active_bundle_check',
      'shop_integrations_pending_bundle_check',
    ];
    const { rows } = await owner.query(`
      SELECT conname, pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE conname = ANY($1::text[])
       ORDER BY conname`, [names]);
    assert.deepEqual(rows.map((r) => r.conname), names.sort());
    const byName = new Map(rows.map((r) => [r.conname, r.def]));
    assert.match(byName.get('integration_webhook_generation_event_unique') ?? '',
      /UNIQUE \(shop_id, integration_id, generation, event_type, provider_event_id\)/);
    assert.match(byName.get('integration_webhook_inbox_status_check') ?? '', /superseded/);
    assert.match(byName.get('integration_webhook_inbox_status_check') ?? '', /dead_letter/);
    assert.match(byName.get('orders_integration_generation_check') ?? '', /integration_id IS NULL.*integration_generation IS NULL/s);
    assert.match(byName.get('integration_ref_inventory_stamp_check') ?? '', /inventory_synced_at IS NULL.*inventory_generation IS NULL/s);
    assert.match(byName.get('shop_integrations_pending_bundle_check') ?? '', /pending_generation = \(generation \+ 1\)/);

    const { rows: generationColumns } = await owner.query(`
      SELECT table_name, column_name, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (table_name, column_name) IN (
           ('shop_integrations','generation'),
           ('integration_webhook_inbox','generation'),
           ('orders','integration_generation'))
       ORDER BY table_name, column_name`);
    assert.deepEqual(generationColumns.map((r) => [r.table_name, r.column_name, r.is_nullable]), [
      ['integration_webhook_inbox', 'generation', 'NO'],
      ['orders', 'integration_generation', 'YES'],
      ['shop_integrations', 'generation', 'NO'],
    ]);
    assert.match(generationColumns.find((r) => r.table_name === 'shop_integrations')?.column_default ?? '', /0/);
    assert.equal(generationColumns.find((r) => r.table_name === 'integration_webhook_inbox')?.column_default, null,
      'inbox không được mặc định generation=0 vì đường ghi quên đóng dấu sẽ thành hợp lệ');
  });

  test('trigger DB chặn tồn và đơn ngoài, đồng thời supersede generation cũ', async () => {
    const names = [
      'external_order_lines_local_write_guard',
      'external_order_local_update_guard',
      'integration_generation_step_guard',
      'integration_generation_supersede',
      'inventory_external_master_insert_guard',
      'inventory_external_master_update_guard',
    ];
    const { rows } = await owner.query(`
      SELECT t.tgname, p.proname, t.tgenabled
        FROM pg_trigger t
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE NOT t.tgisinternal AND t.tgname = ANY($1::text[])
       ORDER BY t.tgname`, [names]);
    assert.deepEqual(rows.map((r) => [r.tgname, r.proname, r.tgenabled]), [
      ['external_order_lines_local_write_guard', 'guard_external_order_lines_local_write', 'O'],
      ['external_order_local_update_guard', 'guard_external_order_local_update', 'O'],
      ['integration_generation_step_guard', 'enforce_integration_generation_step', 'O'],
      ['integration_generation_supersede', 'supersede_integration_generation', 'O'],
      ['inventory_external_master_insert_guard', 'guard_external_inventory_on_hand', 'O'],
      ['inventory_external_master_update_guard', 'guard_external_inventory_on_hand', 'O'],
    ]);

    const { rows: [guard] } = await owner.query(`
      SELECT pg_get_functiondef(p.oid) AS def, p.prosecdef,
             r.rolname AS owner
        FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.proname = 'guard_external_order_local_update'`);
    assert.match(guard?.def ?? '', /TG_OP = 'INSERT'.*NEW\.source IN \('kiotviet_pos',\s*'sapo_pos'\)/s,
      'app_rw không được tự chèn đơn giả danh bản chiếu POS');
    assert.match(guard?.def ?? '', /TG_OP = 'DELETE'.*OLD\.source IN \('kiotviet_pos',\s*'sapo_pos'\)/s,
      'bản chiếu POS không được xoá bằng đường local');
    assert.equal(guard?.prosecdef, true, 'trigger đơn ngoài phải đọc connector qua SECURITY DEFINER');
    assert.equal(guard?.owner, 'app_integration_guard', 'trigger đơn ngoài phải thuộc vai guard NOLOGIN');
    assert.match(guard?.def ?? '', /session_user/, 'trigger phải giữ actor gốc khi chạy dưới vai guard');
  });

  test('mỗi shop có tối đa một external_master và các hàm xuyên FORCE RLS thuộc vai guard', async () => {
    const { rows: [idx] } = await owner.query(`
      SELECT pg_get_indexdef(indexrelid) AS def, pg_get_expr(indpred, indrelid) AS pred
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = 'shop_integrations_one_external_master'`);
    assert.match(idx?.def ?? '', /UNIQUE INDEX/);
    assert.match(idx?.pred ?? '', /inventory_authority = 'external_master'/);

    const { rows } = await owner.query(`
      SELECT p.proname, p.prosecdef, r.rolname AS owner
        FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.proname IN ('resolve_integration_webhook','list_due_integrations','list_due_integration_webhooks',
                           'supersede_integration_generation','external_master_allows_online_promotions',
                           'lock_checkout_integration')
       ORDER BY p.proname`);
    assert.deepEqual(rows, [
      { proname: 'external_master_allows_online_promotions', prosecdef: true, owner: 'app_integration_guard' },
      { proname: 'list_due_integration_webhooks', prosecdef: true, owner: 'app_integration_guard' },
      { proname: 'list_due_integrations', prosecdef: true, owner: 'app_integration_guard' },
      { proname: 'lock_checkout_integration', prosecdef: true, owner: 'app_integration_guard' },
      { proname: 'resolve_integration_webhook', prosecdef: true, owner: 'app_integration_guard' },
      { proname: 'supersede_integration_generation', prosecdef: true, owner: 'app_integration_guard' },
    ]);

    for (const role of ['app_store', 'app_checkout', 'app_customer', 'app_customer_wishlist', 'app_rw']) {
      const { rows: [got] } = await owner.query(
        `SELECT has_function_privilege($1, 'external_master_allows_online_promotions()', 'EXECUTE') AS allowed`,
        [role],
      );
      assert.equal(got.allowed, true, `${role} gọi đường giá phải được dùng chốt promotion ngoài`);
    }
    for (const role of ['app_platform', 'app_worker', 'app_integration']) {
      const { rows: [got] } = await owner.query(
        `SELECT has_function_privilege($1, 'external_master_allows_online_promotions()', 'EXECUTE') AS allowed`,
        [role],
      );
      assert.equal(got.allowed, false, `${role} không được mượn helper SECURITY DEFINER ngoài nhu cầu`);
    }
    const { rows: [checkoutLock] } = await owner.query(`
      SELECT has_function_privilege('app_checkout', 'lock_checkout_integration()', 'EXECUTE') AS execute,
             has_table_privilege('app_checkout', 'shop_integrations', 'UPDATE') AS table_update`);
    assert.deepEqual(checkoutLock, { execute: true, table_update: false },
      'checkout được giữ khoá lifecycle qua hàm hẹp nhưng không được cấp quyền ghi bảng connector');
  });
});

describe('Giá vốn (0081) — bí mật kinh doanh, không rò ra vai công khai', () => {
  test('app_store KHÔNG có bất kỳ quyền nào trên variant_costs', async () => {
    // Lý do variant_costs là BẢNG RIÊNG (không ALTER variants): app_store/app_checkout có
    // SELECT table-level trên variants → cột mới tự phủ. Bảng riêng thì phải giữ ZERO grant.
    const { rows } = await owner.query(`
      SELECT has_table_privilege('app_store','variant_costs','SELECT') AS sel,
             has_table_privilege('app_store','variant_costs','INSERT') AS ins,
             has_table_privilege('app_store','variant_costs','UPDATE') AS upd,
             has_table_privilege('app_store','variant_costs','DELETE') AS del
    `);
    assert.deepEqual(rows[0], { sel: false, ins: false, upd: false, del: false },
      'storefront đọc được giá vốn = lộ bí mật kinh doanh của shop');
  });

  test('app_checkout CHỈ SELECT variant_costs (snapshot lúc đặt), không ghi', async () => {
    const { rows } = await owner.query(`
      SELECT has_table_privilege('app_checkout','variant_costs','SELECT') AS sel,
             has_table_privilege('app_checkout','variant_costs','INSERT') AS ins,
             has_table_privilege('app_checkout','variant_costs','UPDATE') AS upd,
             has_table_privilege('app_checkout','variant_costs','DELETE') AS del
    `);
    assert.deepEqual(rows[0], { sel: true, ins: false, upd: false, del: false });
  });

  test('app_expiry KHÔNG đọc được order_lines.unit_cost_vnd (column-list 0022 không phủ cột mới)', async () => {
    const { rows } = await owner.query(
      `SELECT has_column_privilege('app_expiry','order_lines','unit_cost_vnd','SELECT') AS sel`,
    );
    assert.equal(rows[0].sel, false, 'worker không có việc gì với giá vốn');
  });

  test('app_rw sửa/xoá được variant_costs (giá vốn HIỆN HÀNH, không phải chứng từ)', async () => {
    const { rows } = await owner.query(`
      SELECT has_table_privilege('app_rw','variant_costs','UPDATE') AS upd,
             has_table_privilege('app_rw','variant_costs','DELETE') AS del
    `);
    assert.equal(rows[0].upd, true);
    assert.equal(rows[0].del, true);
  });
});

describe('Nhập hàng (0085) — giá nhập + NCC là bí mật KD, CHỈ app_rw thấy', () => {
  const PURCHASING = ['suppliers', 'purchase_orders', 'purchase_order_lines', 'stocktakes', 'stocktake_lines'];

  test('MỌI vai login app_* (trừ app_rw) có ZERO quyền trên 5 bảng nhập hàng', async () => {
    // Bất biến DURABLE: giá nhập/thông tin NCC nhạy như variant_costs (0081). Không rò ra
    // BẤT KỲ vai công khai nào — kể cả vai thêm về sau. Kiểm ĐỘNG mọi vai login app_* (trừ
    // app_rw người ghi hợp lệ; app_owner là chủ DDL nên has_privilege luôn true — loại trừ).
    const roles = (await owner.query(
      `SELECT rolname FROM pg_roles WHERE rolcanlogin AND rolname LIKE 'app\\_%'
         AND rolname NOT IN ('app_rw', 'app_owner') ORDER BY rolname`)).rows.map((r) => r.rolname);
    assert.ok(roles.length >= 3, `quá ít vai login để kiểm (${roles.length}) — query sai?`);
    const leaks = [];
    for (const role of roles) {
      for (const table of PURCHASING) {
        for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          const { rows } = await owner.query(`SELECT has_table_privilege($1, $2, $3) AS ok`, [role, table, priv]);
          if (rows[0].ok) leaks.push(`${role} có ${priv} trên ${table}`);
        }
      }
    }
    assert.deepEqual(leaks, [], 'vai công khai chạm được bí mật nhập hàng → siết grant trong migration mới');
  });

  test('app_rw có đủ CRUD trên 5 bảng nhập hàng (giá vốn hiện hành + chứng từ sửa-trước-chốt)', async () => {
    for (const table of PURCHASING) {
      const { rows } = await owner.query(`
        SELECT has_table_privilege('app_rw','${table}','SELECT') AS sel,
               has_table_privilege('app_rw','${table}','INSERT') AS ins,
               has_table_privilege('app_rw','${table}','UPDATE') AS upd,
               has_table_privilege('app_rw','${table}','DELETE') AS del
      `);
      assert.deepEqual(rows[0], { sel: true, ins: true, upd: true, del: true }, `${table}: app_rw phải đủ CRUD`);
    }
  });
});

describe('Điểm thưởng (0086) — sổ cái append-only + cô lập vai', () => {
  test('loyalty_ledger APPEND-ONLY: không vai nào UPDATE/DELETE được (điểm = nợ phải trả)', async () => {
    for (const role of ['app_checkout', 'app_loyalty', 'app_rw', 'app_customer']) {
      const { rows } = await owner.query(`
        SELECT has_table_privilege($1,'loyalty_ledger','UPDATE') AS upd,
               has_table_privilege($1,'loyalty_ledger','DELETE') AS del`, [role]);
      assert.equal(rows[0].upd, false, `${role}: KHÔNG được UPDATE loyalty_ledger`);
      assert.equal(rows[0].del, false, `${role}: KHÔNG được DELETE loyalty_ledger`);
    }
  });

  test('app_store (bề mặt công khai nhất) có ZERO quyền trên 3 bảng điểm thưởng', async () => {
    for (const table of ['loyalty_ledger', 'loyalty_balances', 'shop_loyalty_config']) {
      const { rows } = await owner.query(`
        SELECT has_table_privilege('app_store',$1,'SELECT') AS sel,
               has_table_privilege('app_store',$1,'INSERT') AS ins,
               has_table_privilege('app_store',$1,'UPDATE') AS upd,
               has_table_privilege('app_store',$1,'DELETE') AS del`, [table]);
      assert.deepEqual(rows[0], { sel: false, ins: false, upd: false, del: false }, `${table}: app_store phải ZERO`);
    }
  });

  test('app_loyalty (worker) không phải superuser, không BYPASSRLS (sweep cross-shop qua policy)', async () => {
    const { rows } = await owner.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='app_loyalty'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].rolsuper, false);
    assert.equal(rows[0].rolbypassrls, false);
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
