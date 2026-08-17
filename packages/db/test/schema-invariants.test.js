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
import { owner, closeAll, withTenant, sqlstateOf, SQLSTATE } from './helpers.js';

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

const compactPolicyExpr = (value) => String(value ?? '').replace(/[()\s]/g, '').toLowerCase();

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

    const { rows: policies } = await owner.query(`
      SELECT tablename, cmd, qual, with_check
        FROM pg_policies
       WHERE schemaname = 'public' AND 'app_go_live' = ANY(roles)
       ORDER BY tablename, cmd
    `);
    assert.deepEqual(policies.map((r) => `${r.tablename}:${r.cmd}`), [
      'domains:SELECT',
      'inventory_levels:SELECT',
      'pages:SELECT',
      'product_options:SELECT',
      'products:SELECT',
      'shops:SELECT',
      'shops:UPDATE',
      'variant_option_values:SELECT',
      'variants:SELECT',
    ]);
    assert.ok(policies.every((r) => String(r.qual).includes('current_shop_id()')));
    assert.ok(!policies.some((r) => /\btrue\b/i.test(`${r.qual} ${r.with_check}`)));
    assert.ok(String(policies.find((r) => r.tablename === 'shops' && r.cmd === 'UPDATE')?.with_check)
      .includes("status = 'active'"));

    for (const table of ['domains', 'inventory_levels', 'pages', 'product_options',
      'products', 'variant_option_values', 'variants']) {
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
